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
import type { Backend, StrategyConfig } from './extract/backend.js'
import type { FormSpec } from './formspec/types.js'
import type { ExtractionResult, PipelineMeta, ValidationOutput } from './types.js'

/**
 * How the image is presented to the model.
 *
 * - `sections` — crop per FormSpec geometry, one request per chunk. Most accurate,
 *   most requests. Requires layout blocks that match the actual form.
 * - `split`    — one request per half of a portrait image. Cheap mitigation for
 *   grid summarization; needs no geometry.
 * - `whole`    — a single request. The baseline the other two are measured against.
 * - `auto`     — `sections` when the spec declares blocks, otherwise `split` for
 *   portrait images, otherwise `whole`.
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
  /** Pre-validation model output, for debugging and for the eval harness. */
  raw: ExtractionResult
  /** Set when the two-digit-year correction fired. */
  yearCorrection?: { from: number; to: number }
}

async function readWhole(image: Buffer, spec: FormSpec, backend: Backend): Promise<ExtractionResult> {
  const { result } = await backend.extract({ image, spec, prompt: buildExtractionPrompt(spec) })
  return result
}

async function readSplit(image: Buffer, spec: FormSpec, backend: Backend): Promise<ExtractionResult | null> {
  const halves = await splitVertically(image)
  if (!halves) return null
  const prompt = buildExtractionPrompt(spec)
  const [left, right] = await Promise.all([
    backend.extract({ image: halves.left, spec, prompt }),
    backend.extract({ image: halves.right, spec, prompt }),
  ])
  return mergeSplitResults(left.result, right.result)
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
  let sectionParse = false
  let splitParse = false
  let sectionChunkCount: number | undefined

  if (requested === 'sections' || (requested === 'auto' && hasGeometry)) {
    const sectioned = await extractBySections(image, spec, backend, {
      concurrency: opts.sectionConcurrency,
      onProgress: opts.onProgress,
    })
    raw = sectioned
    sectionParse = true
    sectionChunkCount = sectioned.chunkCount
  } else if (requested === 'split' || requested === 'auto') {
    const merged = await readSplit(image, spec, backend)
    if (merged) {
      raw = merged
      splitParse = true
    } else {
      raw = await readWhole(image, spec, backend)
    }
  } else {
    raw = await readWhole(image, spec, backend)
  }

  const normalized = normalizeYears(spec, raw, opts.now)
  const validated = validateExtraction(spec, normalized.result, { rules: opts.rules })

  return {
    ...validated,
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
