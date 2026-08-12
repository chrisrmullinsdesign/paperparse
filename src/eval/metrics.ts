/**
 * Precision, recall, F1 — and the reasons each one is reported separately.
 *
 * A single accuracy number hides the tradeoff that actually matters here. A parser
 * tuned to never emit a wrong row will quietly drop the hard ones (high precision,
 * low recall); one tuned to catch everything will invent rows (the reverse). Which
 * you want depends on what happens downstream — if a human reviews every form,
 * recall is worth more, because a missed row is invisible and a spurious one gets
 * caught.
 */

import type { MultisetDiff } from './diff.js'

export interface Prf {
  truePositives: number
  falsePositives: number
  falseNegatives: number
  /** Null when undefined — no predictions, or no gold rows. Not zero. */
  precision: number | null
  recall: number | null
  f1: number | null
}

/**
 * Undefined metrics are reported as null rather than 0.
 *
 * A parser that returned nothing has undefined precision, not perfect precision and
 * not zero precision. Collapsing that to a number produces averages that quietly
 * lie about the empty cases.
 */
export function prf(diff: MultisetDiff): Prf {
  const tp = diff.matched
  const fp = diff.spurious
  const fn = diff.missed

  const precision = diff.predictedCount === 0 ? null : tp / diff.predictedCount
  const recall = diff.goldCount === 0 ? null : tp / diff.goldCount

  let f1: number | null = null
  if (precision !== null && recall !== null && precision + recall > 0) {
    f1 = (2 * precision * recall) / (precision + recall)
  }

  return { truePositives: tp, falsePositives: fp, falseNegatives: fn, precision, recall, f1 }
}

/**
 * Micro-average across images: pool all counts, then compute once.
 *
 * Micro rather than macro because forms vary in row count, and macro-averaging lets
 * a sparse 3-row form move the number as much as a full 100-row one. Micro weights
 * by rows, which is what "how many rows does this get right" means.
 */
export function microAverage(diffs: readonly MultisetDiff[]): Prf {
  const pooled = diffs.reduce<MultisetDiff>(
    (acc, d) => ({
      predictedCount: acc.predictedCount + d.predictedCount,
      goldCount: acc.goldCount + d.goldCount,
      matched: acc.matched + d.matched,
      spurious: acc.spurious + d.spurious,
      missed: acc.missed + d.missed,
    }),
    { predictedCount: 0, goldCount: 0, matched: 0, spurious: 0, missed: 0 },
  )
  return prf(pooled)
}

export function formatPct(v: number | null): string {
  return v === null ? '—' : `${(v * 100).toFixed(1)}%`
}
