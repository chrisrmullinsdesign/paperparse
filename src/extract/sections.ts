/**
 * Section-by-section extraction: crop the form into its printed bands using FormSpec
 * geometry and read ten rows at a time, instead of one request against the whole grid.
 *
 * The theory: a full-page grid gives the model a summarization affordance — it can
 * return a representative subset and a confident note, and nothing in the request
 * distinguishes that from success. A ten-row crop removes the affordance, because
 * there is no plausible summary of ten rows that isn't just the ten rows.
 *
 * **The benchmark did not bear this out**, and it is worth reading before reaching
 * for this. On the synthetic corpus sectioning placed last of the three read modes:
 * 82% row recall against 98% for a single whole-page request, at thirteen requests
 * instead of one. High precision alongside that low recall (97.8% / 82.4%) suggests
 * a model reading ten rows in isolation hedges — dropping rows it can't corroborate
 * against the rest of the page rather than misreading them.
 *
 * It is kept, and kept working, for two reasons. The corpus is clean synthetic
 * renders, and the failure this was built to fix came from real phone photographs of
 * a real clipboard; the corpus may simply not reproduce it. And on a form dense
 * enough that a whole-page read genuinely does summarize, the argument still holds.
 * But it is no longer what `auto` selects, and it should not be adopted without
 * measuring it on your own documents.
 */

import { pitchForKeys, rectForKeys, sectionChunks, expandByRows } from '../formspec/geometry.js'
import { buildSectionPrompt, buildHeaderPrompt } from './prompt.js'
import { cropPixels, normRectToPixels } from '../image/crop.js'
import { imageSize } from '../image/prep.js'
import { addUsage, sumUsage, ZERO_USAGE, type Backend, type UsageTotals } from './backend.js'
import type { FormSpec } from '../formspec/types.js'
import type { ExtractionResult, RawRow } from '../types.js'

export interface SectionOptions {
  /**
   * Rows of vertical overlap added to each crop.
   *
   * One row is usually right. It costs a little redundancy and guarantees that a
   * row sitting on a chunk boundary is fully visible to at least one pass rather
   * than half-visible to two.
   */
  overlapRows?: number
  /** Max concurrent requests. Sequential by default — raise if your limits allow. */
  concurrency?: number
  /** Called after each chunk completes, for progress reporting. */
  onProgress?: (done: number, total: number) => void
  /**
   * Skip the header pass and use this date as context instead. Pass `null` to skip
   * the pass and supply no context at all.
   */
  documentDate?: string | null
}

export interface SectionExtractionResult extends ExtractionResult {
  chunkCount: number
  /** Chunks whose request failed. Non-empty means the result is partial. */
  failedChunks: number[][]
  /** Token spend summed across every chunk request, including failed ones. */
  usage: UsageTotals
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (limit <= 1) {
    const out: R[] = []
    for (let i = 0; i < items.length; i++) out.push(await fn(items[i], i))
    return out
  }
  const results = new Array<R>(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++
      results[i] = await fn(items[i], i)
    }
  })
  await Promise.all(workers)
  return results
}

/**
 * Run one extraction pass per section chunk and merge the rows.
 *
 * A chunk whose request fails is recorded in `failedChunks` rather than aborting the
 * run — losing ten rows out of a hundred and knowing exactly which ten is a far
 * better outcome than losing the whole form.
 */
export async function extractBySections(
  image: Buffer,
  spec: FormSpec,
  backend: Backend,
  opts: SectionOptions = {},
): Promise<SectionExtractionResult> {
  const chunks = sectionChunks(spec)
  const overlapRows = opts.overlapRows ?? 1
  const { width, height } = await imageSize(image)

  // Header pass. One small request buys the year for every subsequent crop; without
  // it each section has to guess, and the guesses are individually plausible and
  // collectively wrong in ways nothing downstream can detect.
  let headerUsage: UsageTotals = { ...ZERO_USAGE }
  let documentDate: string | null = opts.documentDate ?? null

  if (opts.documentDate === undefined && spec.layout.headerRegion) {
    try {
      const headerCrop = await cropPixels(
        image,
        normRectToPixels(spec.layout.headerRegion, width, height),
      )
      const response = await backend.extract({ image: headerCrop, spec, prompt: buildHeaderPrompt(spec) })
      documentDate = response.result.document_date
      headerUsage = addUsage(headerUsage, response.usage)
    } catch {
      // Non-fatal: fall through with no date context. Sections will hedge instead.
      headerUsage = { ...ZERO_USAGE, requests: 1 }
    }
  }

  let completed = 0

  const perChunk = await mapWithConcurrency(chunks, opts.concurrency ?? 1, async (keys) => {
    try {
      const base = rectForKeys(spec, keys)
      if (!base) return { keys, result: null as ExtractionResult | null, usage: { ...ZERO_USAGE } }

      const padded = expandByRows(base, overlapRows, pitchForKeys(spec, keys))
      const crop = await cropPixels(image, normRectToPixels(padded, width, height))

      const response = await backend.extract({
        image: crop,
        spec,
        prompt: buildSectionPrompt(spec, keys, documentDate),
        sectionKeys: keys,
      })
      return { keys, result: response.result, usage: addUsage({ ...ZERO_USAGE }, response.usage) }
    } catch {
      // A failed request may still have been billed, but we have no usage to read
      // off a thrown error — count the attempt so request totals stay honest.
      return { keys, result: null as ExtractionResult | null, usage: { ...ZERO_USAGE, requests: 1 } }
    } finally {
      opts.onProgress?.(++completed, chunks.length)
    }
  })

  const byKey = new Map<number, RawRow>()
  const notes: string[] = []
  const failedChunks: number[][] = []
  let looksRight = false

  const usage = sumUsage([headerUsage, ...perChunk.map((c) => c.usage)])

  for (const { keys, result } of perChunk) {
    if (!result) {
      failedChunks.push([...keys])
      continue
    }
    if (!documentDate && result.document_date) documentDate = result.document_date
    if (result.looks_like_expected_form !== false) looksRight = true
    if (result.notes?.trim()) notes.push(`rows ${keys[0]}–${keys[keys.length - 1]}: ${result.notes.trim()}`)

    const allowed = new Set(keys)
    for (const row of result.rows) {
      const key = typeof row.row_key === 'number' ? row.row_key : parseInt(String(row.row_key), 10)
      if (!Number.isFinite(key)) continue
      // Drop rows outside the requested range — the overlap strip makes neighbouring
      // rows visible, and the owning chunk is the authority for those.
      if (!allowed.has(key)) continue
      if (!byKey.has(key)) byKey.set(key, row)
    }
  }

  if (failedChunks.length > 0) {
    const ranges = failedChunks.map((c) => `${c[0]}–${c[c.length - 1]}`).join(', ')
    notes.push(`[sections: ${failedChunks.length} chunk(s) failed and were not read: ${ranges}]`)
  }

  return {
    document_date: documentDate,
    rows: [...byKey.entries()].sort((a, b) => a[0] - b[0]).map(([, row]) => row),
    notes: notes.join('; '),
    looks_like_expected_form: looksRight,
    chunkCount: chunks.length,
    failedChunks,
    usage,
  }
}
