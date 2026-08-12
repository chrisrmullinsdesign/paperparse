/**
 * Escalation: cheap backend first, expensive backend only where it's needed.
 *
 * The architecture this exists to express:
 *
 *   Textract reads the page for ~1c and flags the cells it isn't sure about.
 *   The vision model re-reads *only those rows*, at ~20x the per-page cost but on
 *   a fraction of the page.
 *
 * That inverts the usual "LLM with validation bolted on". Validation can only tell
 * you a row is wrong; it can't tell you what the row should have been. A second
 * reader can. And because the primary hands over calibrated per-word confidence, the
 * decision about which rows deserve a second reader is grounded in something better
 * than the model's opinion of itself.
 *
 * The win only exists if the primary's confidence is actually informative. Against a
 * primary whose confidence is self-reported and poorly calibrated, this degrades to
 * paying for both backends — measure before adopting it.
 */

import { rectForKeys, pitchForKeys, expandByRows } from '../formspec/geometry.js'
import { cropPixels, normRectToPixels } from '../image/crop.js'
import { imageSize } from '../image/prep.js'
import { buildSectionPrompt } from './prompt.js'
import { addUsage, sumUsage, ZERO_USAGE, type Backend, type ExtractRequest, type ExtractResponse, type UsageTotals } from './backend.js'
import type { Confidence, RawRow } from '../types.js'

export interface EscalateOptions {
  /** Row confidences that trigger a second read. Defaults to low and medium. */
  escalateAt?: Confidence[]
  /**
   * Also escalate rows that came back missing a required field, regardless of the
   * confidence the primary attached to what it *did* read.
   *
   * On by default, because measurement said it mattered. Escalating on confidence
   * alone re-read exactly the rows the primary had already got right and left
   * untouched the ones being lost: on a 488-row corpus, Textract returned 30
   * low-confidence rows (all correct) and 8 rows with a field missing. The validator
   * drops an incomplete row, so those 8 were pure recall loss that a
   * confidence-only trigger never saw. A half-read row is a better escalation
   * signal than a hedged one.
   */
  escalateIncomplete?: boolean
  /**
   * Cap on escalated rows. Past this, escalating stops being a saving — if the
   * primary is unsure about most of the page, read the whole page with the
   * secondary instead. Defaults to a third of the form's declared rows.
   */
  maxEscalatedRows?: number
  /** Rows of context to include above and below an escalated row's crop. */
  contextRows?: number
  onEscalate?: (rowKeys: number[]) => void
}

export class EscalatingBackend implements Backend {
  readonly name: string

  constructor(
    private readonly primary: Backend,
    private readonly secondary: Backend,
    private readonly opts: EscalateOptions = {},
  ) {
    this.name = `${primary.name}->${secondary.name}`
  }

  isAvailable(): boolean {
    return this.primary.isAvailable() && this.secondary.isAvailable()
  }

  async extract(req: ExtractRequest): Promise<ExtractResponse> {
    const first = await this.primary.extract(req)
    let usage: UsageTotals = addUsage({ ...ZERO_USAGE }, first.usage)

    const escalateAt = new Set<Confidence>(this.opts.escalateAt ?? ['low', 'medium'])
    const contextRows = this.opts.contextRows ?? 1

    const requiredFields = req.spec.fields
      .filter((f) => !f.pii && f.required !== false)
      .map((f) => f.name)

    const isIncomplete = (row: RawRow): boolean =>
      requiredFields.some((name) => {
        const v = row.fields?.[name]
        return v === null || v === undefined || String(v).trim() === ''
      })

    const escalateIncomplete = this.opts.escalateIncomplete !== false

    const uncertain = first.result.rows.filter(
      (r) => escalateAt.has(r.confidence) || (escalateIncomplete && isIncomplete(r)),
    )
    const keys = uncertain
      .map((r) => (typeof r.row_key === 'number' ? r.row_key : parseInt(String(r.row_key), 10)))
      .filter((k) => Number.isFinite(k))

    const cap =
      this.opts.maxEscalatedRows ??
      Math.ceil(req.spec.rowKey.ranges.reduce((n, r) => n + (r.to - r.from + 1), 0) / 3)

    if (keys.length === 0 || keys.length > cap) {
      const why =
        keys.length === 0
          ? 'nothing to escalate'
          : `${keys.length} uncertain rows exceeds the cap of ${cap} — not escalating`
      return {
        ...first,
        result: { ...first.result, notes: [first.result.notes, `[escalate: ${why}]`].filter(Boolean).join('; ') },
        usage,
      }
    }

    this.opts.onEscalate?.(keys)

    // One crop covering the uncertain rows, with a little context so the secondary
    // can see the neighbouring rows it is being asked to disambiguate against.
    const base = rectForKeys(req.spec, keys)
    if (!base) return { ...first, usage }

    const { width, height } = await imageSize(req.image)
    const padded = expandByRows(base, contextRows, pitchForKeys(req.spec, keys))
    const crop = await cropPixels(req.image, normRectToPixels(padded, width, height))

    let second: ExtractResponse
    try {
      second = await this.secondary.extract({
        image: crop,
        spec: req.spec,
        prompt: buildSectionPrompt(req.spec, keys, first.result.document_date),
        sectionKeys: keys,
      })
    } catch {
      // A failed second opinion leaves the primary's rows in place. They were
      // flagged uncertain, not discarded — degrading to "unsure" beats losing them.
      return {
        ...first,
        result: {
          ...first.result,
          notes: [first.result.notes, '[escalate: secondary failed; primary rows retained]']
            .filter(Boolean)
            .join('; '),
        },
        usage: sumUsage([usage, { ...ZERO_USAGE, requests: 1 }]),
      }
    }

    usage = sumUsage([usage, addUsage({ ...ZERO_USAGE }, second.usage)])

    // The secondary's reading wins for the rows it was asked about, and only those.
    const escalated = new Set(keys)
    const replacements = new Map<number, RawRow>()
    for (const row of second.result.rows) {
      const key = typeof row.row_key === 'number' ? row.row_key : parseInt(String(row.row_key), 10)
      if (Number.isFinite(key) && escalated.has(key)) replacements.set(key, row)
    }

    const merged = first.result.rows.map((row) => {
      const key = typeof row.row_key === 'number' ? row.row_key : parseInt(String(row.row_key), 10)
      return replacements.get(key) ?? row
    })

    return {
      result: {
        ...first.result,
        rows: merged,
        document_date: first.result.document_date ?? second.result.document_date,
        notes: [
          first.result.notes,
          `[escalate: ${replacements.size}/${keys.length} uncertain rows re-read by ${this.secondary.name}]`,
          second.result.notes,
        ]
          .filter(Boolean)
          .join('; '),
      },
      model: `${first.model}+${second.model}`,
      usage,
    }
  }
}
