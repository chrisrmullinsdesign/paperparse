/**
 * Turning uncertain rows into answerable questions.
 *
 * A review queue that says "here is the photo and here is the table, please check
 * it" gets skimmed. A queue that says "row 67: is this 2024-10-27 or 2024-10-21?"
 * with the relevant 200×40 pixels attached gets answered — and the answers are
 * structured enough to feed back as training data.
 *
 * This generates those questions from low-confidence rows and the FormSpec geometry.
 */

import { randomUUID } from 'node:crypto'
import { rectForKey } from '../formspec/geometry.js'
import type { FormSpec } from '../formspec/types.js'
import type { Ambiguity, AmbiguityCandidate, ValidatedRow } from '../types.js'

/** Digit pairs that dominate handwriting misreads. */
const CONFUSABLE_DIGITS: Record<string, string[]> = {
  '0': ['6', '8'],
  '1': ['7', '4'],
  '3': ['8', '5'],
  '4': ['9', '1'],
  '5': ['6', '3'],
  '6': ['0', '5'],
  '7': ['1', '9'],
  '8': ['3', '0'],
  '9': ['4', '7'],
}

/** Plausible alternative readings of an ISO date, by perturbing the day-of-month. */
function dateCandidates(iso: string, limit = 3): AmbiguityCandidate[] {
  const out: AmbiguityCandidate[] = [{ value: iso, label: iso }]
  const day = iso.slice(8, 10)

  for (const [i, digit] of [...day].entries()) {
    for (const alt of CONFUSABLE_DIGITS[digit] ?? []) {
      const altDay = day.slice(0, i) + alt + day.slice(i + 1)
      const candidate = `${iso.slice(0, 8)}${altDay}`
      const dayNum = parseInt(altDay, 10)
      if (dayNum < 1 || dayNum > 31) continue
      // Reject dates the calendar doesn't have (31 Feb, 31 Apr).
      const parsed = new Date(`${candidate}T00:00:00Z`)
      if (Number.isNaN(parsed.getTime()) || parsed.getUTCDate() !== dayNum) continue
      if (out.some((c) => c.value === candidate)) continue
      out.push({ value: candidate, label: candidate })
      if (out.length >= limit) return out
    }
  }
  return out
}

function integerCandidates(value: number, limit = 3): AmbiguityCandidate[] {
  const s = String(value)
  const out: AmbiguityCandidate[] = [{ value, label: s }]
  for (const [i, digit] of [...s].entries()) {
    for (const alt of CONFUSABLE_DIGITS[digit] ?? []) {
      const candidate = parseInt(s.slice(0, i) + alt + s.slice(i + 1), 10)
      if (!Number.isFinite(candidate)) continue
      if (out.some((c) => c.value === candidate)) continue
      out.push({ value: candidate, label: String(candidate) })
      if (out.length >= limit) return out
    }
  }
  return out
}

export interface AmbiguityOptions {
  /** Fields to raise questions about. Defaults to every non-PII field in the spec. */
  fields?: string[]
  /** Cap per row, so one bad row can't flood the queue. */
  maxPerRow?: number
}

/**
 * Generate review questions for one uncertain row.
 *
 * Candidates are ordered best-guess-first, so a reviewer who agrees with the parser
 * answers by accepting the default — which is the common case and should be the
 * cheapest action.
 */
export function ambiguitiesForRow(
  spec: FormSpec,
  row: ValidatedRow,
  opts: AmbiguityOptions = {},
): Ambiguity[] {
  const maxPerRow = opts.maxPerRow ?? 2
  const wanted = new Set(opts.fields ?? spec.fields.filter((f) => !f.pii).map((f) => f.name))
  const cropRect = rectForKey(spec, row.rowKey) ?? undefined
  const out: Ambiguity[] = []

  for (const field of spec.fields) {
    if (out.length >= maxPerRow) break
    if (field.pii || !wanted.has(field.name)) continue

    const value = row.fields[field.name]
    if (value === undefined) continue

    let candidates: AmbiguityCandidate[] = []
    if (field.type === 'iso-date' && typeof value === 'string') candidates = dateCandidates(value)
    else if (field.type === 'integer' && typeof value === 'number') candidates = integerCandidates(value)

    // One candidate means there is no alternative reading worth asking about.
    if (candidates.length < 2) continue

    out.push({
      id: randomUUID(),
      kind: 'field_read',
      reason: `Low-confidence read of "${field.name}" on row ${row.rowKey}`,
      rowRef: { rowKey: row.rowKey, fields: row.fields },
      candidates,
      cropRect,
      status: 'open',
    })
  }

  return out
}

/** Generate the full review queue for a set of uncertain rows. */
export function generateAmbiguities(
  spec: FormSpec,
  uncertainRows: readonly ValidatedRow[],
  opts: AmbiguityOptions = {},
): Ambiguity[] {
  return uncertainRows.flatMap((row) => ambiguitiesForRow(spec, row, opts))
}
