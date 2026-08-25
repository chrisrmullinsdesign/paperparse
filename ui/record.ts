/**
 * The shape the viewer reads, and the one function that builds it.
 *
 * Both the recorder (`scripts/record-run.ts`, writing files) and the local server
 * (`ui/server.ts`, answering a live request) hand the viewer the same object, so it
 * is assembled once here. Two copies of this drifting apart would show up as the
 * static demo and the live view disagreeing about the same run, which is exactly
 * the class of bug this repo argues against elsewhere.
 *
 * Row rectangles are precomputed with the real `rectForKey`. The viewer therefore
 * carries no geometry of its own — a browser reimplementation of the layout maths
 * would be a second source of truth for the thing the FormSpec exists to be the
 * only source of truth for.
 */

import { allValidKeys, rectForKey } from '../src/formspec/geometry.js'
import { generateAmbiguities } from '../src/eval/ambiguity.js'
import { multisetDiff, fieldAccuracy, rowKeySignature } from '../src/eval/diff.js'
import { costOf, OPUS_5_PRICING } from '../src/eval/benchmark.js'
import type { FormSpec, NormRect } from '../src/formspec/types.js'
import type { PipelineResult, ReadMode, StageEvent } from '../src/pipeline.js'
import type { Ambiguity, ValidatedRow } from '../src/types.js'
import type { MultisetDiff, FieldAccuracy } from '../src/eval/diff.js'

export interface Gold {
  documentDate: string
  rows: ValidatedRow[]
}

export interface RunRecord {
  id: string
  /** Filename beside this record, or null when the image travels inline. */
  image: string | null
  /** Data URI for an uploaded photograph, which has no file in the corpus. */
  imageBase64: string | null
  recordedAt: string
  elapsedMs: number
  spec: FormSpec
  /** Row key → printed extent, from `rectForKey`. */
  rects: Record<number, NormRect>
  meta: PipelineResult['meta']
  usage: PipelineResult['usage']
  /** Null for Textract, which bills per page — see the README's footnote. */
  estimatedCostUsd: number | null
  readMode: ReadMode
  stages: StageEvent[]
  rows: ValidatedRow[]
  uncertainRows: ValidatedRow[]
  stats: PipelineResult['stats']
  yearCorrection: PipelineResult['yearCorrection'] | null
  notes: string
  looksLikeExpectedForm: boolean
  ambiguities: Ambiguity[]
  /** Null for an uploaded photograph — see `score`. */
  gold: Gold | null
  /**
   * Null whenever `gold` is. Scoring an image with no labels would render as a
   * perfect run rather than as an unmeasured one, which is the wrong default in
   * both directions.
   */
  score: { keyDiff: MultisetDiff; exactDiff: MultisetDiff; fields: FieldAccuracy } | null
}

/** Every valid row key's printed rect, so the viewer can draw the grid it read. */
export function rowRects(spec: FormSpec): Record<number, NormRect> {
  const out: Record<number, NormRect> = {}
  for (const key of allValidKeys(spec)) {
    const rect = rectForKey(spec, key)
    if (rect) out[key] = rect
  }
  return out
}

export function buildRunRecord(opts: {
  id: string
  spec: FormSpec
  result: PipelineResult
  stages: StageEvent[]
  elapsedMs: number
  readMode: ReadMode
  backendName: string
  gold: Gold | null
  image?: string | null
  imageBase64?: string | null
}): RunRecord {
  const { spec, result, gold } = opts
  const parsed = [...result.rows, ...result.uncertainRows]

  return {
    id: opts.id,
    image: opts.image ?? null,
    imageBase64: opts.imageBase64 ?? null,
    recordedAt: new Date().toISOString(),
    elapsedMs: opts.elapsedMs,
    spec,
    rects: rowRects(spec),
    meta: result.meta,
    usage: result.usage,
    // Textract bills per page, so a token-derived figure would be a fabricated
    // zero. Null says "this harness doesn't know", which is the true statement.
    estimatedCostUsd: opts.backendName === 'textract' ? null : costOf(result.usage, OPUS_5_PRICING),
    readMode: opts.readMode,
    stages: opts.stages,
    rows: result.rows,
    uncertainRows: result.uncertainRows,
    stats: result.stats,
    yearCorrection: result.yearCorrection ?? null,
    notes: result.raw.notes,
    looksLikeExpectedForm: result.raw.looks_like_expected_form ?? true,
    ambiguities: generateAmbiguities(spec, result.uncertainRows),
    gold,
    score: gold
      ? {
          keyDiff: multisetDiff(parsed, gold.rows, rowKeySignature),
          exactDiff: multisetDiff(parsed, gold.rows),
          fields: fieldAccuracy(parsed, gold.rows),
        }
      : null,
  }
}
