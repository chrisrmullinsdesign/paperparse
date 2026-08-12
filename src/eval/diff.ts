/**
 * Multiset row diff.
 *
 * Comparing extraction output to a gold set is not a set comparison: the same row
 * can legitimately appear twice, and a parser that emits a correct row three times
 * has made a different mistake than one that emits it once. Counting with
 * multiplicity captures both.
 *
 * The same diff serves two callers, which is the point of putting it here:
 *   - the eval harness, comparing parser output to a gold set;
 *   - the review UI, comparing what the parser produced to what a human approved.
 *
 * A single implementation means offline benchmark numbers and production
 * human-correction rates are measured on identical arithmetic and can be compared
 * directly.
 */

import type { ValidatedRow } from '../types.js'

/** Full-equality signature — row key plus every field value. */
export function rowSignature(row: ValidatedRow): string {
  const fields = Object.keys(row.fields)
    .sort()
    .map((k) => `${k}=${row.fields[k]}`)
    .join('|')
  return `${row.rowKey}|${fields}`
}

/** Key-only signature — "did we find this row at all", ignoring field accuracy. */
export function rowKeySignature(row: ValidatedRow): string {
  return String(row.rowKey)
}

function counts(rows: readonly ValidatedRow[], sig: (r: ValidatedRow) => string): Map<string, number> {
  const m = new Map<string, number>()
  for (const row of rows) {
    const k = sig(row)
    m.set(k, (m.get(k) ?? 0) + 1)
  }
  return m
}

export interface MultisetDiff {
  predictedCount: number
  goldCount: number
  /** Σ min(predicted, gold) over signatures — the multiset overlap. */
  matched: number
  /** Predicted rows with no gold counterpart. */
  spurious: number
  /** Gold rows the parser missed. */
  missed: number
}

export function multisetDiff(
  predicted: readonly ValidatedRow[],
  gold: readonly ValidatedRow[],
  sig: (r: ValidatedRow) => string = rowSignature,
): MultisetDiff {
  const p = counts(predicted, sig)
  const g = counts(gold, sig)
  let matched = 0
  for (const k of new Set([...p.keys(), ...g.keys()])) {
    matched += Math.min(p.get(k) ?? 0, g.get(k) ?? 0)
  }
  return {
    predictedCount: predicted.length,
    goldCount: gold.length,
    matched,
    spurious: predicted.length - matched,
    missed: gold.length - matched,
  }
}

/**
 * Per-row-key field comparison, for rows present in both sets.
 *
 * Separates "found the row but misread a field" from "missed the row". Those are
 * different problems with different fixes — the first points at crop quality or
 * prompt wording, the second at chunking or the model skipping rows.
 */
export interface FieldAccuracy {
  /** Rows present in both, keyed by row key. */
  comparedRows: number
  /** Field comparisons made across those rows. */
  comparedFields: number
  correctFields: number
  /** Per-field error counts, so you can see which column is hardest. */
  errorsByField: Record<string, number>
  /** A sample of concrete mismatches, for eyeballing. */
  examples: Array<{ rowKey: number; field: string; expected: string; got: string }>
}

export function fieldAccuracy(
  predicted: readonly ValidatedRow[],
  gold: readonly ValidatedRow[],
  maxExamples = 20,
): FieldAccuracy {
  const predByKey = new Map<number, ValidatedRow>()
  for (const row of predicted) if (!predByKey.has(row.rowKey)) predByKey.set(row.rowKey, row)

  const out: FieldAccuracy = {
    comparedRows: 0,
    comparedFields: 0,
    correctFields: 0,
    errorsByField: {},
    examples: [],
  }

  for (const goldRow of gold) {
    const predRow = predByKey.get(goldRow.rowKey)
    if (!predRow) continue
    out.comparedRows++

    for (const [field, expected] of Object.entries(goldRow.fields)) {
      out.comparedFields++
      const got = predRow.fields[field]
      if (String(got ?? '') === String(expected)) {
        out.correctFields++
      } else {
        out.errorsByField[field] = (out.errorsByField[field] ?? 0) + 1
        if (out.examples.length < maxExamples) {
          out.examples.push({
            rowKey: goldRow.rowKey,
            field,
            expected: String(expected),
            got: String(got ?? '<missing>'),
          })
        }
      }
    }
  }

  return out
}
