/**
 * The benchmark harness.
 *
 * Runs a corpus of images with known-correct rows through one or more
 * (backend × read-mode) configurations and reports comparable numbers.
 *
 * This is the part that makes any accuracy claim in the README checkable. Without
 * it, "section cropping improves recall" is an anecdote; with it, it is a row in a
 * table anyone who clones the repo can regenerate.
 */

import { runPipeline, type PipelineOptions, type ReadMode } from '../pipeline.js'
import { multisetDiff, fieldAccuracy, rowKeySignature, type MultisetDiff, type FieldAccuracy } from './diff.js'
import { prf, microAverage, formatPct, type Prf } from './metrics.js'
import { sumUsage, ZERO_USAGE, type Backend, type UsageTotals } from '../extract/backend.js'
import type { FormSpec } from '../formspec/types.js'
import type { ValidatedRow } from '../types.js'

/** One labelled image: the picture, and the rows a human says are in it. */
export interface GoldSample {
  id: string
  image: Buffer
  rows: ValidatedRow[]
}

export interface BenchConfig {
  label: string
  backend: Backend
  readMode: ReadMode
  pipelineOptions?: Omit<PipelineOptions, 'readMode'>
}

/** USD per million tokens. Defaults are Claude Opus 5 list rates. */
export interface Pricing {
  inputPerMTok: number
  outputPerMTok: number
}

export const OPUS_5_PRICING: Pricing = { inputPerMTok: 5, outputPerMTok: 25 }

export function costOf(usage: UsageTotals, pricing: Pricing): number {
  return (usage.inputTokens / 1e6) * pricing.inputPerMTok + (usage.outputTokens / 1e6) * pricing.outputPerMTok
}

export interface SampleOutcome {
  sampleId: string
  /** Exact-match diff: row key and every field must agree. */
  exact: MultisetDiff
  /** Key-only diff: did we find the row at all, regardless of field accuracy. */
  keyOnly: MultisetDiff
  fields: FieldAccuracy
  /** Wall-clock for the pipeline run. */
  durationMs: number
  usage: UsageTotals
  error?: string
}

export interface ConfigOutcome {
  label: string
  backend: string
  readMode: ReadMode
  samples: SampleOutcome[]
  exact: Prf
  keyOnly: Prf
  fieldAccuracy: number | null
  totalDurationMs: number
  usage: UsageTotals
  /** Samples whose run threw. Excluded from the metrics — and reported, not hidden. */
  failedSamples: string[]
}

export async function runBenchmark(
  spec: FormSpec,
  samples: readonly GoldSample[],
  configs: readonly BenchConfig[],
  onProgress?: (msg: string) => void,
): Promise<ConfigOutcome[]> {
  const outcomes: ConfigOutcome[] = []

  for (const config of configs) {
    const sampleOutcomes: SampleOutcome[] = []
    const failedSamples: string[] = []
    let totalDurationMs = 0

    for (const sample of samples) {
      onProgress?.(`${config.label}: ${sample.id}`)
      const started = Date.now()

      try {
        const result = await runPipeline(sample.image, spec, config.backend, {
          ...config.pipelineOptions,
          readMode: config.readMode,
        })

        // Confident and uncertain rows are pooled for scoring. Uncertain rows are a
        // routing decision, not a claim of wrongness — excluding them would flatter
        // precision by hiding the parser's own hedges from the measurement.
        const predicted = [...result.rows, ...result.uncertainRows]
        const durationMs = Date.now() - started
        totalDurationMs += durationMs

        sampleOutcomes.push({
          sampleId: sample.id,
          exact: multisetDiff(predicted, sample.rows),
          keyOnly: multisetDiff(predicted, sample.rows, rowKeySignature),
          fields: fieldAccuracy(predicted, sample.rows),
          durationMs,
          usage: result.usage,
        })
      } catch (err) {
        const durationMs = Date.now() - started
        totalDurationMs += durationMs
        failedSamples.push(sample.id)
        sampleOutcomes.push({
          sampleId: sample.id,
          exact: { predictedCount: 0, goldCount: sample.rows.length, matched: 0, spurious: 0, missed: sample.rows.length },
          keyOnly: { predictedCount: 0, goldCount: sample.rows.length, matched: 0, spurious: 0, missed: sample.rows.length },
          fields: { comparedRows: 0, comparedFields: 0, correctFields: 0, errorsByField: {}, examples: [] },
          durationMs,
          usage: { ...ZERO_USAGE },
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    const scored = sampleOutcomes.filter((s) => !s.error)
    const comparedFields = scored.reduce((n, s) => n + s.fields.comparedFields, 0)
    const correctFields = scored.reduce((n, s) => n + s.fields.correctFields, 0)

    outcomes.push({
      label: config.label,
      backend: config.backend.name,
      readMode: config.readMode,
      samples: sampleOutcomes,
      exact: microAverage(scored.map((s) => s.exact)),
      keyOnly: microAverage(scored.map((s) => s.keyOnly)),
      fieldAccuracy: comparedFields === 0 ? null : correctFields / comparedFields,
      totalDurationMs,
      usage: sumUsage(sampleOutcomes.map((s) => s.usage)),
      failedSamples,
    })
  }

  return outcomes
}

/** Markdown table, ready to paste into a README. */
export function formatBenchmarkTable(
  outcomes: readonly ConfigOutcome[],
  pricing: Pricing = OPUS_5_PRICING,
): string {
  const header =
    '| Configuration | Row recall | Row precision | Exact F1 | Field accuracy | Requests | Cost / image | Avg / image |\n' +
    '| --- | --- | --- | --- | --- | --- | --- | --- |'

  const rows = outcomes.map((o) => {
    const n = o.samples.length || 1
    const avgMs = Math.round(o.totalDurationMs / n)
    const reqPerImage = (o.usage.requests / n).toFixed(0)
    const costPerImage = costOf(o.usage, pricing) / n
    return `| ${o.label} | ${formatPct(o.keyOnly.recall)} | ${formatPct(o.keyOnly.precision)} | ${formatPct(o.exact.f1)} | ${formatPct(o.fieldAccuracy)} | ${reqPerImage} | $${costPerImage.toFixed(3)} | ${(avgMs / 1000).toFixed(1)}s |`
  })

  const notes = outcomes
    .filter((o) => o.failedSamples.length > 0)
    .map((o) => `\n> ${o.label}: ${o.failedSamples.length} sample(s) failed and are excluded: ${o.failedSamples.join(', ')}`)

  return [header, ...rows].join('\n') + notes.join('')
}

export { prf, microAverage, formatPct }
