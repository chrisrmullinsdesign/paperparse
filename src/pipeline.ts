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
 * - `auto`     — `split` for portrait images, otherwise `whole`.
 *
 * `auto` deliberately does *not* choose `sections`, even when the spec declares the
 * geometry for it. It did until the benchmark was run, on the theory that cropping
 * defeats grid summarization; the measurement did not support that on clean
 * captures, so the default follows the data. Ask for `sections` explicitly.
 */
export type ReadMode = 'auto' | 'sections' | 'split' | 'whole'

export interface PipelineOptions {
  readMode?: ReadMode
  rules?: RowRule[]
  strategy?: Partial<StrategyConfig>
  /** Contrast/sharpen pass before extraction. Measure before enabling. */
  enhance?: boolean
  maxLongEdgePx?: number
  sectionConcurrency?: number
  onProgress?: (done: number, total: number) => void
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
  const image = await prepareForVision(imageInput, {
    enhance: opts.enhance,
    maxLongEdgePx: opts.maxLongEdgePx,
  })

  const hasGeometry = spec.layout.blocks.length > 0
  const requested = opts.readMode ?? 'auto'

  let raw: ExtractionResult
  let usage: UsageTotals = { ...ZERO_USAGE }
  let sectionParse = false
  let splitParse = false
  let sectionChunkCount: number | undefined

  if (requested === 'sections' || (requested === 'auto' && hasGeometry)) {
    const sectioned = await extractBySections(image, spec, backend, {
      concurrency: opts.sectionConcurrency,
      onProgress: opts.onProgress,
    })
    raw = sectioned
    usage = sectioned.usage
    sectionParse = true
    sectionChunkCount = sectioned.chunkCount
  } else if (requested === 'split' || requested === 'auto') {
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

  const normalized = normalizeYears(spec, raw, opts.now)
  const validated = validateExtraction(spec, normalized.result, { rules: opts.rules })

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
