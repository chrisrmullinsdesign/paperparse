/**
 * Row validation.
 *
 * The model returns what it read. This decides what is trustworthy enough to keep,
 * and — just as importantly — records what was thrown away and why.
 *
 * That second part is not bookkeeping. "The parser found 43 rows" is unfalsifiable;
 * "the parser found 51 rows, kept 43, and dropped 8 for these reasons" is a thing
 * you can debug, and it is the input to the eval harness.
 */

import { isValidRowKey } from '../formspec/geometry.js'
import type { FieldSpec, FormSpec } from '../formspec/types.js'
import type {
  CellProvenance,
  Confidence,
  DropReason,
  ExtractionResult,
  RawRow,
  ValidatedRow,
  ValidationOutput,
  ValidationStats,
} from '../types.js'

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/**
 * A cross-field constraint that the schema cannot express.
 *
 * Rules live in code rather than in the FormSpec so the spec stays serializable and
 * declarative. Return `true` to accept, or a short string explaining the failure —
 * that string ends up in the drop record a reviewer reads.
 */
export interface RowRule {
  id: string
  check(row: ValidatedRow): true | string
}

export interface ValidateOptions {
  rules?: RowRule[]
  /**
   * Rows at or below this confidence go to `uncertainRows` instead of `rows`.
   * They are not discarded — they are the review queue.
   */
  uncertainAtOrBelow?: Confidence
  /** Reject duplicate row keys, keeping the first. On by default. */
  dedupe?: boolean
}

const CONFIDENCE_RANK: Record<Confidence, number> = { low: 1, medium: 2, high: 3 }

function toInteger(value: unknown): number | null {
  if (typeof value === 'number') return Number.isInteger(value) ? value : null
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!/^-?\d+$/.test(trimmed)) return null
    const n = parseInt(trimmed, 10)
    return Number.isFinite(n) ? n : null
  }
  return null
}

/**
 * Coerce to an ISO date, accepting the handful of shapes a vision model actually
 * emits. Anything more permissive than this starts inventing dates — `3/4` is not
 * resolvable without knowing the form's locale, so it is rejected rather than guessed.
 */
export function toIsoDate(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const s = value.trim()
  if (!s) return null
  if (ISO_DATE_RE.test(s)) {
    const d = new Date(`${s}T00:00:00Z`)
    return Number.isNaN(d.getTime()) ? null : s
  }
  // YYYY/MM/DD and YYYY.MM.DD are common enough to be worth normalizing.
  const m = s.match(/^(\d{4})[/.](\d{1,2})[/.](\d{1,2})$/)
  if (m) {
    const iso = `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`
    return ISO_DATE_RE.test(iso) ? iso : null
  }
  return null
}

/**
 * Resolve a year-less date like `10/28` against the document's own date.
 *
 * A vision model does this implicitly — it can see the header and the row at once.
 * A geometric backend cannot: it reads a cell, and the year lives two hundred pixels
 * away in a region it has no reason to associate with this row. So the inference
 * becomes explicit here, which makes it testable, which is an improvement.
 *
 * The rollover rule matters. A sheet dated 28 December carrying an entry for `01/03`
 * means next January, not one that already passed. Anything more than a season
 * behind the document date is read as the following year.
 */
export function resolvePartialDate(value: string, documentDate: string | null): string | null {
  const m = value.trim().match(/^(\d{1,2})\s*[/.-]\s*(\d{1,2})$/)
  if (!m) return null
  if (!documentDate || !ISO_DATE_RE.test(documentDate)) return null

  const month = parseInt(m[1], 10)
  const day = parseInt(m[2], 10)
  if (month < 1 || month > 12 || day < 1 || day > 31) return null

  const docYear = parseInt(documentDate.slice(0, 4), 10)
  const build = (year: number) => `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`

  const candidate = build(docYear)
  // Reject dates the calendar doesn't have (31 Feb) rather than letting Date roll over.
  const parsed = new Date(`${candidate}T00:00:00Z`)
  if (Number.isNaN(parsed.getTime()) || parsed.getUTCDate() !== day) return null

  const docMs = new Date(`${documentDate}T00:00:00Z`).getTime()
  const gapDays = (docMs - parsed.getTime()) / 86_400_000
  if (gapDays > 120) {
    const next = build(docYear + 1)
    const nextParsed = new Date(`${next}T00:00:00Z`)
    if (!Number.isNaN(nextParsed.getTime()) && nextParsed.getUTCDate() === day) return next
  }

  return candidate
}

function parseField(spec: FieldSpec, value: unknown): { ok: true; value: string | number } | { ok: false } {
  switch (spec.type) {
    case 'integer': {
      const n = toInteger(value)
      return n === null ? { ok: false } : { ok: true, value: n }
    }
    case 'iso-date': {
      const d = toIsoDate(value)
      return d === null ? { ok: false } : { ok: true, value: d }
    }
    case 'enum': {
      const s = typeof value === 'string' ? value.trim() : ''
      return spec.values?.includes(s) ? { ok: true, value: s } : { ok: false }
    }
    case 'string':
    default: {
      const s = typeof value === 'string' ? value.trim() : String(value ?? '').trim()
      return s ? { ok: true, value: s } : { ok: false }
    }
  }
}

function isEmpty(value: unknown): boolean {
  return value === null || value === undefined || String(value).trim() === ''
}

/** Validate one raw row against the spec. */
export function validateRow(
  spec: FormSpec,
  raw: RawRow,
  rules: RowRule[] = [],
): { ok: true; row: ValidatedRow } | { ok: false; reason: DropReason; detail?: string } {
  const rowKey = toInteger(raw.row_key)
  if (rowKey === null || !isValidRowKey(spec, rowKey)) {
    return { ok: false, reason: 'invalid_row_key', detail: `row_key=${JSON.stringify(raw.row_key)}` }
  }

  const fields: Record<string, string | number> = {}
  const provenance: Record<string, CellProvenance> = {}
  const rawFields = raw.fields ?? {}

  for (const field of spec.fields) {
    if (field.pii) continue // never stored, even if a backend returned it
    const value = rawFields[field.name]

    if (isEmpty(value)) {
      if (field.required === false) continue
      return { ok: false, reason: 'missing_required_field', detail: field.name }
    }

    const parsed = parseField(field, value)
    if (!parsed.ok) {
      return {
        ok: false,
        reason: 'unparseable_field',
        detail: `${field.name}=${JSON.stringify(value)}`,
      }
    }
    fields[field.name] = parsed.value

    // Boxes follow their value. Copying only for fields that survived means a
    // reviewer can never be pointed at pixels behind a value nobody kept.
    const cell = raw.provenance?.[field.name]
    if (cell) provenance[field.name] = cell
  }

  const confidence: Confidence =
    raw.confidence === 'high' || raw.confidence === 'medium' || raw.confidence === 'low'
      ? raw.confidence
      : 'low'

  const row: ValidatedRow = { rowKey, fields, confidence }
  if (Object.keys(provenance).length > 0) row.provenance = provenance

  for (const rule of rules) {
    const verdict = rule.check(row)
    if (verdict !== true) {
      return { ok: false, reason: 'failed_row_rule', detail: `${rule.id}: ${verdict}` }
    }
  }

  return { ok: true, row }
}

/** Validate a whole extraction result, splitting confident rows from uncertain ones. */
export function validateExtraction(
  spec: FormSpec,
  result: ExtractionResult,
  opts: ValidateOptions = {},
): ValidationOutput {
  const rules = opts.rules ?? []
  const dedupe = opts.dedupe !== false
  const uncertainThreshold = CONFIDENCE_RANK[opts.uncertainAtOrBelow ?? 'low']

  const rows: ValidatedRow[] = []
  const uncertainRows: ValidatedRow[] = []
  const stats: ValidationStats = {
    rawRowCount: result.rows.length,
    acceptedRowCount: 0,
    droppedRowCount: 0,
    dropsByReason: {},
    drops: [],
  }

  const seen = new Set<number>()

  const drop = (rowKey: unknown, reason: DropReason, detail?: string) => {
    stats.droppedRowCount++
    stats.dropsByReason[reason] = (stats.dropsByReason[reason] ?? 0) + 1
    stats.drops.push({ rowKey, reason, detail })
  }

  for (const raw of result.rows) {
    const verdict = validateRow(spec, raw, rules)
    if (!verdict.ok) {
      drop(raw.row_key, verdict.reason, verdict.detail)
      continue
    }

    const { row } = verdict
    if (dedupe && seen.has(row.rowKey)) {
      drop(row.rowKey, 'duplicate_row', `row_key ${row.rowKey} already seen`)
      continue
    }
    seen.add(row.rowKey)

    stats.acceptedRowCount++
    if (CONFIDENCE_RANK[row.confidence] <= uncertainThreshold) uncertainRows.push(row)
    else rows.push(row)
  }

  return { rows, uncertainRows, stats }
}
