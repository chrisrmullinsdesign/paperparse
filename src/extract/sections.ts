/**
 * Section-by-section extraction.
 *
 * The core accuracy technique in this pipeline. Rather than one request against a
 * dense 100-row grid, crop the form into its printed bands using FormSpec geometry
 * and read ten rows at a time.
 *
 * Why it works: a full-page grid gives the model a summarization affordance — it can
 * return a representative subset and a confident note, and nothing in the request
 * distinguishes that from success. A ten-row crop removes the affordance. There is
 * no plausible summary of ten rows that isn't just the ten rows.
 *
 * The cost is one request per chunk. See `benchmark` in the eval harness for what
 * that buys on a given form.
 */

import { pitchForKeys, rectForKeys, sectionChunks, expandByRows } from '../formspec/geometry.js'
import { buildSectionPrompt } from './prompt.js'
import { cropPixels, normRectToPixels } from '../image/crop.js'
import { imageSize } from '../image/prep.js'
import type { Backend } from './backend.js'
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
}

export interface SectionExtractionResult extends ExtractionResult {
  chunkCount: number
  /** Chunks whose request failed. Non-empty means the result is partial. */
  failedChunks: number[][]
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

  let completed = 0

  const perChunk = await mapWithConcurrency(chunks, opts.concurrency ?? 1, async (keys) => {
    try {
      const base = rectForKeys(spec, keys)
      if (!base) return { keys, result: null as ExtractionResult | null }

      const padded = expandByRows(base, overlapRows, pitchForKeys(spec, keys))
      const crop = await cropPixels(image, normRectToPixels(padded, width, height))

      const { result } = await backend.extract({
        image: crop,
        spec,
        prompt: buildSectionPrompt(spec, keys),
        sectionKeys: keys,
      })
      return { keys, result }
    } catch {
      return { keys, result: null as ExtractionResult | null }
    } finally {
      opts.onProgress?.(++completed, chunks.length)
    }
  })

  const byKey = new Map<number, RawRow>()
  const notes: string[] = []
  const failedChunks: number[][] = []
  let documentDate: string | null = null
  let looksRight = false

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
  }
}
