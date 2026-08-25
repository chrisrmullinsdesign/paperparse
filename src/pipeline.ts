/**
 * The end-to-end pipeline: photograph in, validated rows out.
 *
 *   prepare → extract (sections | split | whole) → normalize years → validate
 *
 * Each stage is independently usable; this is the assembled default.
 */

import { prepareForVision } from './image/prep.js'
import { splitVertically, mergeSplitResults } from './image/split.js'
import { extractBySections } from './extract/sections.js'
import { buildExtractionPrompt } from './extract/prompt.js'
import { normalizeYears } from './validate/years.js'
import { validateExtraction, type RowRule } from './validate/rows.js'
import { addUsage, ZERO_USAGE, sumUsage, type Backend, type StrategyConfig, type UsageTotals } from './extract/backend.js'
import type { FormSpec } from './formspec/types.js'
import type { ExtractionResult, PipelineMeta, ValidationOutput } from './types.js'

/**
 * How the image is presented to the model.
 *
 * - `whole`    — a single request. Cheapest, and on the benchmark corpus the best
 *   recall of the three.
 * - `split`    — one request per half of a portrait image. Best exact-match F1 and
 *   field accuracy measured; needs no geometry.
 * - `sections` — crop per FormSpec geometry, one request per chunk. Requires layout
 *   blocks that match the form. **Measured worst on the synthetic corpus** — 82%
 *   recall against 98% for `whole`, at 13 requests instead of one. See the
 *   benchmark section of the README before reaching for it.
 * - `auto`     — `whole`.
 *
 * `auto` is a single request, because that is what measured best: 99.6% row recall
 * against 93.9% for `split` and 82.4% for `sections`, at the lowest cost of the
 * three. It selected `sections` until the benchmark was run, on the theory that
 * cropping defeats grid summarization, and `split` after that. Neither survived
 * contact with the numbers.
 *
 * `split` and `sections` are still here and still supported — they encode real
 * mitigations for a real failure, and this corpus is clean synthetic renders rather
 * than the messy phone photographs that motivated them. Ask for them explicitly, and
 * measure on your own documents before adopting one.
 */
export type ReadMode = 'auto' | 'sections' | 'split' | 'whole'

/** The four stages of a run, in the order they happen. */
export type PipelineStage = 'prepare' | 'read' | 'normalize' | 'validate'

/**
 * A stage starting or finishing.
 *
 * `onProgress` reports section counts and so says nothing at all during a
 * whole-page read — which is the default, and the slowest thing here at ~30s
 * against a vision model. A caller with a progress indicator to drive needs to
 * know which stage is running, not only how many crops are done.
 */
export interface StageEvent {
  stage: PipelineStage
  status: 'start' | 'done'
  /** Sub-progress within `read`, when the read mode works in countable pieces. */
  progress?: { done: number; total: number }
  /** Short human-readable note — the read mode, the row count, the correction made. */
  detail?: string
}

export interface PipelineOptions {
  readMode?: ReadMode
  rules?: RowRule[]
  strategy?: Partial<StrategyConfig>
  /** Contrast/sharpen pass before extraction. Measure before enabling. */
  enhance?: boolean
  maxLongEdgePx?: number
  sectionConcurrency?: number
  onProgress?: (done: number, total: number) => void
  /** Stage-level progress, emitted for every read mode. */
  onStage?: (event: StageEvent) => void
  /** Injectable for deterministic tests of the year correction. */
  now?: Date
}

export interface PipelineResult extends ValidationOutput {
  meta: PipelineMeta
  /** Token spend for this run, across however many requests the read mode took. */
  usage: UsageTotals
  /** Pre-validation model output, for debugging and for the eval harness. */
  raw: ExtractionResult
  /** Set when the two-digit-year correction fired. */
  yearCorrection?: { from: number; to: number }
}

interface Read {
  result: ExtractionResult
  usage: UsageTotals
}

async function readWhole(image: Buffer, spec: FormSpec, backend: Backend): Promise<Read> {
  const response = await backend.extract({ image, spec, prompt: buildExtractionPrompt(spec) })
  return { result: response.result, usage: addUsage({ ...ZERO_USAGE }, response.usage) }
}

async function readSplit(image: Buffer, spec: FormSpec, backend: Backend): Promise<Read | null> {
  const halves = await splitVertically(image)
  if (!halves) return null
  const prompt = buildExtractionPrompt(spec)
  const [left, right] = await Promise.all([
    backend.extract({ image: halves.left, spec, prompt }),
    backend.extract({ image: halves.right, spec, prompt }),
  ])
  return {
    result: mergeSplitResults(left.result, right.result),
    usage: sumUsage([addUsage({ ...ZERO_USAGE }, left.usage), addUsage({ ...ZERO_USAGE }, right.usage)]),
  }
}

export async function runPipeline(
  imageInput: Buffer,
  spec: FormSpec,
  backend: Backend,
  opts: PipelineOptions = {},
): Promise<PipelineResult> {
  const emit = (event: StageEvent) => opts.onStage?.(event)

  emit({ stage: 'prepare', status: 'start' })
  const image = await prepareForVision(imageInput, {
    enhance: opts.enhance,
    maxLongEdgePx: opts.maxLongEdgePx,
  })
  emit({ stage: 'prepare', status: 'done', detail: 'EXIF stripped, re-encoded' })

  const requested = opts.readMode ?? 'auto'

  let raw: ExtractionResult
  let usage: UsageTotals = { ...ZERO_USAGE }
  let sectionParse = false
  let splitParse = false
  let sectionChunkCount: number | undefined

  emit({ stage: 'read', status: 'start', detail: `${backend.name} / ${requested}` })

  if (requested === 'sections') {
    const sectioned = await extractBySections(image, spec, backend, {
      concurrency: opts.sectionConcurrency,
      onProgress: (done, total) => {
        opts.onProgress?.(done, total)
        emit({ stage: 'read', status: 'start', progress: { done, total } })
      },
    })
    raw = sectioned
    usage = sectioned.usage
    sectionParse = true
    sectionChunkCount = sectioned.chunkCount
  } else if (requested === 'split') {
    const merged = await readSplit(image, spec, backend)
    if (merged) {
      raw = merged.result
      usage = merged.usage
      splitParse = true
    } else {
      const whole = await readWhole(image, spec, backend)
      raw = whole.result
      usage = whole.usage
    }
  } else {
    const whole = await readWhole(image, spec, backend)
    raw = whole.result
    usage = whole.usage
  }

  emit({ stage: 'read', status: 'done', detail: `${raw.rows.length} raw rows, ${usage.requests} request(s)` })

  emit({ stage: 'normalize', status: 'start' })
  const normalized = normalizeYears(spec, raw, opts.now)
  emit({
    stage: 'normalize',
    status: 'done',
    detail:
      normalized.correctedFrom !== undefined
        ? `year ${normalized.correctedFrom} → ${normalized.correctedTo}`
        : 'no correction needed',
  })

  emit({ stage: 'validate', status: 'start' })
  const validated = validateExtraction(spec, normalized.result, { rules: opts.rules })
  emit({
    stage: 'validate',
    status: 'done',
    detail: `${validated.rows.length} accepted, ${validated.uncertainRows.length} to review, ${validated.stats.droppedRowCount} dropped`,
  })

  return {
    ...validated,
    usage,
    raw: normalized.result,
    yearCorrection:
      normalized.correctedFrom !== undefined
        ? { from: normalized.correctedFrom, to: normalized.correctedTo! }
        : undefined,
    meta: {
      recordedAt: new Date().toISOString(),
      strategy: opts.strategy?.strategy ?? 'single',
      backend: backend.name,
      sectionParse,
      sectionChunkCount,
      splitParse,
    },
  }
}
