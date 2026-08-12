import { describe, it, expect } from 'vitest'
import { validateRow, validateExtraction, toIsoDate } from '../src/validate/rows.js'
import { normalizeYears } from '../src/validate/years.js'
import { campgroundRosterSpec as spec, campgroundRosterRules as rules } from '../examples/campground-roster/spec.js'
import type { ExtractionResult, RawRow } from '../src/types.js'

function row(overrides: Partial<RawRow> = {}): RawRow {
  return {
    row_key: 14,
    fields: { date_in: '2024-10-26', date_out: '2024-10-28' },
    confidence: 'high',
    ...overrides,
  }
}

function result(rows: RawRow[], documentDate: string | null = '2024-10-25'): ExtractionResult {
  return { document_date: documentDate, rows, notes: '', looks_like_expected_form: true }
}

describe('toIsoDate', () => {
  it('accepts ISO and common separators', () => {
    expect(toIsoDate('2024-10-26')).toBe('2024-10-26')
    expect(toIsoDate('2024/10/26')).toBe('2024-10-26')
    expect(toIsoDate('2024.1.6')).toBe('2024-01-06')
  })

  it('rejects ambiguous and impossible dates rather than guessing', () => {
    expect(toIsoDate('3/4')).toBeNull()
    expect(toIsoDate('10/26/2024')).toBeNull()
    expect(toIsoDate('2024-13-01')).toBeNull()
    expect(toIsoDate('')).toBeNull()
    expect(toIsoDate(null)).toBeNull()
  })
})

describe('validateRow', () => {
  it('accepts a well-formed row', () => {
    const v = validateRow(spec, row(), rules)
    expect(v.ok).toBe(true)
    if (v.ok) {
      expect(v.row.rowKey).toBe(14)
      expect(v.row.fields.date_in).toBe('2024-10-26')
    }
  })

  it('coerces a stringified row key', () => {
    const v = validateRow(spec, row({ row_key: '67' }), rules)
    expect(v.ok).toBe(true)
    if (v.ok) expect(v.row.rowKey).toBe(67)
  })

  it('rejects row keys outside the declared ranges', () => {
    for (const key of [0, 108, 'G3', null]) {
      const v = validateRow(spec, row({ row_key: key }), rules)
      expect(v.ok).toBe(false)
      if (!v.ok) expect(v.reason).toBe('invalid_row_key')
    }
  })

  it('rejects a missing required field', () => {
    const v = validateRow(spec, row({ fields: { date_in: '2024-10-26' } }), rules)
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.reason).toBe('missing_required_field')
  })

  it('rejects an unparseable field', () => {
    const v = validateRow(spec, row({ fields: { date_in: 'next tuesday', date_out: '2024-10-28' } }), rules)
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.reason).toBe('unparseable_field')
  })

  it('never emits a PII field even when the backend returns one', () => {
    const v = validateRow(
      spec,
      row({ fields: { date_in: '2024-10-26', date_out: '2024-10-28', last_name: 'Doyle', permit_number: '44821' } }),
      rules,
    )
    expect(v.ok).toBe(true)
    if (v.ok) {
      expect(v.row.fields).not.toHaveProperty('last_name')
      expect(v.row.fields).not.toHaveProperty('permit_number')
      expect(Object.keys(v.row.fields).sort()).toEqual(['date_in', 'date_out'])
    }
  })

  it('enforces cross-field rules', () => {
    const backwards = validateRow(spec, row({ fields: { date_in: '2024-10-28', date_out: '2024-10-26' } }), rules)
    expect(backwards.ok).toBe(false)
    if (!backwards.ok) {
      expect(backwards.reason).toBe('failed_row_rule')
      expect(backwards.detail).toContain('departure-after-arrival')
    }

    const tooLong = validateRow(spec, row({ fields: { date_in: '2024-10-01', date_out: '2024-11-30' } }), rules)
    expect(tooLong.ok).toBe(false)
    if (!tooLong.ok) expect(tooLong.detail).toContain('stay-length-plausible')
  })

  it('defaults an unrecognised confidence to low rather than trusting it', () => {
    const v = validateRow(spec, row({ confidence: 'very sure' as never }), rules)
    expect(v.ok).toBe(true)
    if (v.ok) expect(v.row.confidence).toBe('low')
  })
})

describe('validateExtraction', () => {
  it('routes low-confidence rows to review instead of discarding them', () => {
    const out = validateExtraction(
      spec,
      result([row({ row_key: 1 }), row({ row_key: 2, confidence: 'low' })]),
      { rules },
    )
    expect(out.rows.map((r) => r.rowKey)).toEqual([1])
    expect(out.uncertainRows.map((r) => r.rowKey)).toEqual([2])
    expect(out.stats.acceptedRowCount).toBe(2)
  })

  it('accounts for every dropped row with a reason', () => {
    const out = validateExtraction(
      spec,
      result([
        row({ row_key: 1 }),
        row({ row_key: 999 }),
        row({ row_key: 3, fields: { date_in: '2024-10-28', date_out: '2024-10-26' } }),
      ]),
      { rules },
    )

    expect(out.stats.rawRowCount).toBe(3)
    expect(out.stats.acceptedRowCount).toBe(1)
    expect(out.stats.droppedRowCount).toBe(2)
    expect(out.stats.dropsByReason.invalid_row_key).toBe(1)
    expect(out.stats.dropsByReason.failed_row_rule).toBe(1)
    expect(out.stats.acceptedRowCount + out.stats.droppedRowCount).toBe(out.stats.rawRowCount)
    expect(out.stats.drops).toHaveLength(2)
  })

  it('deduplicates repeated row keys, keeping the first', () => {
    const out = validateExtraction(
      spec,
      result([
        row({ row_key: 5, fields: { date_in: '2024-10-26', date_out: '2024-10-28' } }),
        row({ row_key: 5, fields: { date_in: '2024-10-27', date_out: '2024-10-29' } }),
      ]),
      { rules },
    )
    expect(out.rows).toHaveLength(1)
    expect(out.rows[0].fields.date_in).toBe('2024-10-26')
    expect(out.stats.dropsByReason.duplicate_row).toBe(1)
  })
})

describe('normalizeYears', () => {
  const now = new Date('2026-08-12T00:00:00Z')

  it('corrects a uniform past year when the header disagrees', () => {
    const out = normalizeYears(
      spec,
      result([row({ fields: { date_in: '2020-05-09', date_out: '2020-05-11' } })], '2026-05-08'),
      now,
    )
    expect(out.correctedFrom).toBe(2020)
    expect(out.correctedTo).toBe(2026)
    expect(out.result.rows[0].fields.date_in).toBe('2026-05-09')
  })

  it('leaves an archival sheet alone when the header agrees with the grid', () => {
    // The form really is old. Rewriting it would corrupt the record.
    const out = normalizeYears(
      spec,
      result([row({ fields: { date_in: '2021-06-11', date_out: '2021-06-13' } })], '2021-06-10'),
      now,
    )
    expect(out.correctedFrom).toBeUndefined()
    expect(out.result.rows[0].fields.date_in).toBe('2021-06-11')
  })

  it('does not fire when years are mixed', () => {
    const out = normalizeYears(
      spec,
      result(
        [
          row({ row_key: 1, fields: { date_in: '2020-05-09', date_out: '2020-05-11' } }),
          row({ row_key: 2, fields: { date_in: '2026-05-09', date_out: '2026-05-11' } }),
        ],
        null,
      ),
      now,
    )
    expect(out.correctedFrom).toBeUndefined()
  })

  it('does not fire beyond a plausible two-digit slip', () => {
    const out = normalizeYears(
      spec,
      result([row({ fields: { date_in: '2009-05-09', date_out: '2009-05-11' } })], null),
      now,
    )
    expect(out.correctedFrom).toBeUndefined()
  })

  it('does not fire on current-year dates', () => {
    const out = normalizeYears(
      spec,
      result([row({ fields: { date_in: '2026-05-09', date_out: '2026-05-11' } })], null),
      now,
    )
    expect(out.correctedFrom).toBeUndefined()
  })
})
