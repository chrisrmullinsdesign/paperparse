/**
 * Amazon Textract backend — the geometric alternative to a vision model.
 *
 * Textract returns words with bounding boxes and a calibrated confidence score for
 * each. It has no idea what any of them *mean*: it will happily tell you the string
 * "10/28" sits at (0.71, 0.34) with 99.1% confidence, and nothing about which site's
 * departure date that is.
 *
 * The FormSpec supplies the missing half. `keyAtNormPoint` turns a y-coordinate into
 * a row key and `fieldAtNormPoint` turns an x-coordinate into a field name, both from
 * the same layout declaration the vision backends use for cropping. Read forward it
 * crops; read backward it assigns meaning to OCR output.
 *
 * Why bother, when a vision model already works:
 *
 *  - **Confidence you can act on.** A vision model's `confidence` is a self-report,
 *    and a model that misreads a digit is often confident about it. Textract's score
 *    is calibrated and per-word, which makes a low-confidence cell an actual signal
 *    rather than a vibe — and it comes with the pixel location, so a review UI can
 *    highlight the cell instead of the row.
 *  - **Determinism.** Same bytes, same answer. The vision path measured 100% / 80.8%
 *    / 100% recall on three runs of one image.
 *  - **Cost.** Roughly an order of magnitude cheaper per page.
 *
 * What it gives up is inference. It cannot read "10/28" and know the year lives in a
 * header two hundred pixels north, and it cannot know G4 means key 104. Those become
 * deterministic code here — which is arguably where they belonged.
 *
 * Pair with `EscalatingBackend` to send only the cells Textract is unsure about to a
 * vision model.
 */

import {
  TextractClient,
  AnalyzeDocumentCommand,
  type Block,
} from '@aws-sdk/client-textract'
import { keyAtNormPoint, fieldAtNormPoint } from '../formspec/geometry.js'
import { resolvePartialDate } from '../validate/rows.js'
import type { Backend, ExtractRequest, ExtractResponse } from './backend.js'
import type { Confidence, ExtractionResult, RawRow } from '../types.js'

export interface TextractBackendOptions {
  region?: string
  client?: TextractClient
  /**
   * Words below this confidence are dropped rather than guessed at. Textract scores
   * are 0–100. Handwriting routinely lands in the 70s even when correct, so this is
   * deliberately permissive — the point is to filter noise, not to make the accept
   * decision. That belongs to `minRowConfidence` and the validator.
   */
  minWordConfidence?: number
  /**
   * Mean word confidence at or above which a row is reported "high". Rows below
   * `mediumRowConfidence` are reported "low" and route to review.
   */
  minRowConfidence?: number
  mediumRowConfidence?: number
}

const DEFAULT_MIN_WORD_CONFIDENCE = 45
const DEFAULT_HIGH = 90
const DEFAULT_MEDIUM = 75

interface PlacedWord {
  text: string
  confidence: number
  rowKey: number
  field: string
  /** Left edge, for ordering words within a cell. */
  x: number
}

/**
 * Pull the document date out of the header region of the same response.
 *
 * No extra API call: a full-page AnalyzeDocument already returned the header words,
 * they just weren't in any row. Costs nothing to read them.
 */
export function readHeaderDate(spec: ExtractRequest['spec'], blocks: readonly Block[]): string | null {
  const region = spec.layout.headerRegion
  if (!region) return null

  const words: Array<{ x: number; text: string }> = []
  for (const block of blocks) {
    if (block.BlockType !== 'WORD' || !block.Text) continue
    const c = centreOf(block)
    if (!c) continue
    if (c.x < region.x || c.x > region.x + region.w) continue
    if (c.y < region.y || c.y > region.y + region.h) continue
    words.push({ x: c.x, text: block.Text })
  }

  const text = words.sort((a, b) => a.x - b.x).map((w) => w.text).join(' ')

  const iso = text.match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/)
  if (iso) {
    const candidate = `${iso[1]}-${iso[2].padStart(2, '0')}-${iso[3].padStart(2, '0')}`
    const d = new Date(`${candidate}T00:00:00Z`)
    if (!Number.isNaN(d.getTime())) return candidate
  }
  return null
}

/** Centre point of a Textract block, in normalized page coordinates. */
function centreOf(block: Block): { x: number; y: number } | null {
  const box = block.Geometry?.BoundingBox
  if (!box) return null
  const { Left = 0, Top = 0, Width = 0, Height = 0 } = box
  return { x: Left + Width / 2, y: Top + Height / 2 }
}

/**
 * Assign each recognised word to a (row, field) cell using the FormSpec geometry.
 *
 * Exported so it can be tested against synthetic block lists without an AWS call —
 * this mapping, not the API call, is where the interesting failures live.
 */
export function placeWords(
  spec: ExtractRequest['spec'],
  blocks: readonly Block[],
  minWordConfidence = DEFAULT_MIN_WORD_CONFIDENCE,
): PlacedWord[] {
  const placed: PlacedWord[] = []

  for (const block of blocks) {
    if (block.BlockType !== 'WORD') continue
    const text = block.Text?.trim()
    if (!text) continue

    const confidence = block.Confidence ?? 0
    if (confidence < minWordConfidence) continue

    const centre = centreOf(block)
    if (!centre) continue

    const rowKey = keyAtNormPoint(spec, centre.x, centre.y)
    if (rowKey === null) continue

    const field = fieldAtNormPoint(spec, centre.x, centre.y)
    // No field means the row-number gutter or a gap between columns — printed
    // furniture, not data.
    if (!field) continue

    placed.push({ text, confidence, rowKey, field, x: block.Geometry?.BoundingBox?.Left ?? 0 })
  }

  return placed
}

/** Collapse placed words into rows, joining multi-word cells left to right. */
export function assembleRows(
  spec: ExtractRequest['spec'],
  placed: readonly PlacedWord[],
  opts: { high?: number; medium?: number } = {},
): RawRow[] {
  const high = opts.high ?? DEFAULT_HIGH
  const medium = opts.medium ?? DEFAULT_MEDIUM

  const byRow = new Map<number, Map<string, PlacedWord[]>>()
  for (const word of placed) {
    const row = byRow.get(word.rowKey) ?? new Map<string, PlacedWord[]>()
    row.set(word.field, [...(row.get(word.field) ?? []), word])
    byRow.set(word.rowKey, row)
  }

  const emitted = new Set(spec.fields.filter((f) => !f.pii).map((f) => f.name))
  const rows: RawRow[] = []

  for (const [rowKey, cells] of [...byRow.entries()].sort((a, b) => a[0] - b[0])) {
    const fields: Record<string, unknown> = {}
    const confidences: number[] = []

    for (const [field, words] of cells) {
      // Confidence is measured across every word Textract read on this row,
      // including the PII columns — a row where the name came back as mush is a row
      // worth a second look, even though the name itself is never stored.
      for (const w of words) confidences.push(w.confidence)
      if (!emitted.has(field)) continue
      fields[field] = [...words].sort((a, b) => a.x - b.x).map((w) => w.text).join(' ')
    }

    if (Object.keys(fields).length === 0) continue

    const mean = confidences.reduce((a, b) => a + b, 0) / (confidences.length || 1)
    const confidence: Confidence = mean >= high ? 'high' : mean >= medium ? 'medium' : 'low'

    rows.push({ row_key: rowKey, fields, confidence })
  }

  return rows
}

export class TextractBackend implements Backend {
  readonly name = 'textract'

  private readonly client: TextractClient
  private readonly minWordConfidence: number
  private readonly high: number
  private readonly medium: number

  constructor(opts: TextractBackendOptions = {}) {
    this.client =
      opts.client ?? new TextractClient({ region: opts.region ?? process.env.AWS_REGION ?? 'us-east-1' })
    this.minWordConfidence = opts.minWordConfidence ?? DEFAULT_MIN_WORD_CONFIDENCE
    this.high = opts.minRowConfidence ?? DEFAULT_HIGH
    this.medium = opts.mediumRowConfidence ?? DEFAULT_MEDIUM
  }

  isAvailable(): boolean {
    // Credentials can come from the environment, a shared profile, or an instance
    // role, so absence of env vars proves nothing. Treat a profile as plausible and
    // let the request fail loudly if it isn't.
    return Boolean(
      process.env.AWS_ACCESS_KEY_ID ||
        process.env.AWS_PROFILE ||
        process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI ||
        process.env.AWS_WEB_IDENTITY_TOKEN_FILE ||
        process.env.HOME,
    )
  }

  async extract(req: ExtractRequest): Promise<ExtractResponse> {
    const response = await this.client.send(
      new AnalyzeDocumentCommand({
        Document: { Bytes: req.image },
        // TABLES gets the printed grid segmented; the WORD blocks it returns are
        // what the geometry actually consumes.
        FeatureTypes: ['TABLES'],
      }),
    )

    const blocks = response.Blocks ?? []
    const documentDate = readHeaderDate(req.spec, blocks)
    const placed = placeWords(req.spec, blocks, this.minWordConfidence)
    const rows = assembleRows(req.spec, placed, { high: this.high, medium: this.medium })

    // Textract returns cell text verbatim — "10/28", not an ISO date. Resolving that
    // against the header is the inference a vision model performs implicitly and a
    // geometric backend has to be told to do.
    const dateFields = new Set(req.spec.fields.filter((f) => f.type === 'iso-date').map((f) => f.name))
    for (const row of rows) {
      for (const [name, value] of Object.entries(row.fields)) {
        if (!dateFields.has(name) || typeof value !== 'string') continue
        const resolved = resolvePartialDate(value, documentDate)
        if (resolved) row.fields[name] = resolved
      }
    }

    const result: ExtractionResult = {
      document_date: documentDate,
      rows,
      notes: `textract: ${blocks.filter((b) => b.BlockType === 'WORD').length} words read, ${placed.length} placed into ${rows.length} rows${documentDate ? `; header date ${documentDate}` : '; no header date found'}`,
      looks_like_expected_form: rows.length > 0,
    }

    return {
      result,
      model: 'textract:analyze-document',
      // Textract bills per page, not per token, so token counts are meaningless
      // here. Reporting one request keeps the harness's request column honest and
      // leaves the cost column reading zero rather than a fabricated number.
      usage: { inputTokens: 0, outputTokens: 0 },
    }
  }
}
