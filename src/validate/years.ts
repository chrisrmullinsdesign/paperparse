/**
 * Two-digit-year correction.
 *
 * A real, repeatable failure on handwritten forms: the paper says "5/9/26", the
 * model expands the year wrong, and every date in the extraction lands in 2020.
 * Nothing downstream can tell that apart from a genuinely old form — the dates are
 * internally consistent and individually plausible.
 *
 * The correction is narrow on purpose. It fires only when *every* date shares one
 * past year, and it stands down when the document's own printed header agrees with
 * that year — because then the form really is old, and rewriting it would silently
 * corrupt an archival record.
 */

import type { ExtractionResult } from '../types.js'
import type { FormSpec } from '../formspec/types.js'

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** Beyond this many years back, a wrong-century read is likelier than a slip. */
const MAX_PLAUSIBLE_SLIP_YEARS = 9

function dateFieldNames(spec: FormSpec): string[] {
  return spec.fields.filter((f) => f.type === 'iso-date' && !f.pii).map((f) => f.name)
}

function yearOf(value: unknown): number | null {
  if (typeof value !== 'string' || !ISO_DATE_RE.test(value)) return null
  const y = parseInt(value.slice(0, 4), 10)
  return Number.isFinite(y) ? y : null
}

function replaceYear(value: unknown, from: number, to: number): unknown {
  if (typeof value !== 'string' || !ISO_DATE_RE.test(value)) return value
  return parseInt(value.slice(0, 4), 10) === from ? `${to}${value.slice(4)}` : value
}

export interface YearNormalization {
  result: ExtractionResult
  /** Set when a correction was applied — worth logging and showing a reviewer. */
  correctedFrom?: number
  correctedTo?: number
}

export function normalizeYears(
  spec: FormSpec,
  result: ExtractionResult,
  now: Date = new Date(),
): YearNormalization {
  const currentYear = now.getFullYear()
  const dateFields = dateFieldNames(spec)
  if (dateFields.length === 0) return { result }

  const years = new Set<number>()
  for (const row of result.rows) {
    for (const name of dateFields) {
      const y = yearOf(row.fields?.[name])
      if (y !== null) years.add(y)
    }
  }

  if (years.size !== 1) return { result }

  const [only] = [...years]
  if (only >= currentYear) return { result }
  if (currentYear - only > MAX_PLAUSIBLE_SLIP_YEARS) return { result }

  // The header is the tiebreaker. If the form itself is dated to the same past year,
  // the grid is consistent with it and this is an archival document, not a misread.
  const headerYear = yearOf(result.document_date)
  if (headerYear === only) return { result }

  return {
    result: {
      ...result,
      document_date: replaceYear(result.document_date, only, currentYear) as string | null,
      rows: result.rows.map((row) => ({
        ...row,
        fields: Object.fromEntries(
          Object.entries(row.fields ?? {}).map(([k, v]) =>
            dateFields.includes(k) ? [k, replaceYear(v, only, currentYear)] : [k, v],
          ),
        ),
      })),
      notes: [result.notes, `[years: corrected ${only} → ${currentYear} across all dates]`]
        .filter(Boolean)
        .join('; '),
    },
    correctedFrom: only,
    correctedTo: currentYear,
  }
}
