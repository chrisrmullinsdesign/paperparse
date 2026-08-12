import { describe, it, expect } from 'vitest'
import { extractJsonObject, parseJsonObject } from '../src/extract/json.js'
import { buildExtractionPrompt, buildSectionPrompt, buildOutputSchema, extractableFields } from '../src/extract/prompt.js'
import { mergeSplitResults } from '../src/image/split.js'
import { normRectToPixels } from '../src/image/crop.js'
import { campgroundRosterSpec as spec } from '../examples/campground-roster/spec.js'
import type { ExtractionResult, RawRow } from '../src/types.js'

describe('extractJsonObject', () => {
  it('passes through clean JSON', () => {
    expect(extractJsonObject('{"a":1}')).toBe('{"a":1}')
  })

  it('strips markdown fences', () => {
    expect(extractJsonObject('```json\n{"a":1}\n```')).toBe('{"a":1}')
    expect(extractJsonObject('```\n{"a":1}\n```')).toBe('{"a":1}')
  })

  it('finds an object embedded in prose', () => {
    expect(extractJsonObject('Here you go:\n{"a":1}\nHope that helps.')).toBe('{"a":1}')
  })

  it('is not fooled by braces inside string values', () => {
    const input = 'text {"note":"a } brace","a":1} trailing'
    expect(parseJsonObject<{ a: number }>(input)?.a).toBe(1)
  })

  it('handles escaped quotes inside strings', () => {
    const input = '{"note":"she said \\"hi\\"","a":2}'
    expect(parseJsonObject<{ a: number }>(input)?.a).toBe(2)
  })

  it('returns null when there is no parseable object', () => {
    expect(extractJsonObject('no json here')).toBeNull()
    expect(extractJsonObject('{"unterminated": ')).toBeNull()
    expect(extractJsonObject('')).toBeNull()
  })
})

describe('buildExtractionPrompt', () => {
  const prompt = buildExtractionPrompt(spec)

  it('names every extractable field', () => {
    for (const field of extractableFields(spec)) {
      expect(prompt).toContain(field.name)
    }
  })

  it('instructs the model not to transcribe PII columns', () => {
    expect(prompt.toLowerCase()).toContain('do not transcribe')
    expect(prompt).toContain('personal information')
  })

  it('states the valid row key range', () => {
    expect(prompt).toContain('1–100')
    expect(prompt).toContain('101–107')
  })

  it('includes the form-specific appendix and example', () => {
    expect(prompt).toContain('RIVER BEND')
    expect(prompt).toContain('Illustrative output')
  })

  it('avoids the emphasis-stacking that over-applies on current models', () => {
    expect(prompt).not.toMatch(/\bCRITICAL\b/)
    expect(prompt).not.toMatch(/\bYOU MUST\b/i)
  })
})

describe('buildSectionPrompt', () => {
  it('scopes the request to the crop and tells the model to ignore the overlap', () => {
    const prompt = buildSectionPrompt(spec, [51, 52, 53, 54, 55])
    expect(prompt).toContain('rows 51–55')
    expect(prompt).toContain('another pass covers them')
  })

  it('handles a single-row chunk', () => {
    expect(buildSectionPrompt(spec, [99])).toContain('rows 99 only')
  })
})

describe('buildOutputSchema', () => {
  const schema = buildOutputSchema(spec) as any

  it('closes every object so the model cannot invent fields', () => {
    expect(schema.additionalProperties).toBe(false)
    expect(schema.properties.rows.items.additionalProperties).toBe(false)
    expect(schema.properties.rows.items.properties.fields.additionalProperties).toBe(false)
  })

  it('excludes PII fields from the permitted shape', () => {
    const fieldProps = schema.properties.rows.items.properties.fields.properties
    expect(fieldProps).toHaveProperty('date_in')
    expect(fieldProps).not.toHaveProperty('last_name')
    expect(fieldProps).not.toHaveProperty('permit_number')
  })

  it('stays inside the supported JSON Schema subset', () => {
    // Numeric bounds and string-length constraints are not supported by structured
    // outputs; range checks belong to the validator, which drops one row instead of
    // failing the whole response.
    const json = JSON.stringify(schema)
    for (const unsupported of ['minimum', 'maximum', 'minLength', 'maxLength', 'multipleOf', 'pattern']) {
      expect(json).not.toContain(`"${unsupported}"`)
    }
  })

  it('requires the top-level result fields', () => {
    expect(schema.required).toEqual(['document_date', 'rows', 'notes', 'looks_like_expected_form'])
  })
})

describe('mergeSplitResults', () => {
  const row = (key: number, dateIn: string, confidence: RawRow['confidence'] = 'high'): RawRow => ({
    row_key: key,
    fields: { date_in: dateIn, date_out: '2024-10-30' },
    confidence,
  })

  const res = (rows: RawRow[], notes = '', date: string | null = '2024-10-25'): ExtractionResult => ({
    document_date: date,
    rows,
    notes,
    looks_like_expected_form: true,
  })

  it('unions rows from both halves in key order', () => {
    const merged = mergeSplitResults(res([row(2, '2024-10-26'), row(1, '2024-10-26')]), res([row(60, '2024-10-27')]))
    expect(merged.rows.map((r) => r.row_key)).toEqual([1, 2, 60])
  })

  it('prefers the higher-confidence reading of an overlapping row', () => {
    const merged = mergeSplitResults(res([row(50, '2024-10-26', 'low')]), res([row(50, '2024-10-27', 'high')]))
    expect(merged.rows).toHaveLength(1)
    expect(merged.rows[0].fields.date_in).toBe('2024-10-27')
  })

  it('surfaces disagreement in notes instead of silently picking a winner', () => {
    // A row the halves read differently is exactly the row a human should look at.
    const merged = mergeSplitResults(res([row(50, '2024-10-26')]), res([row(50, '2024-10-27')]))
    expect(merged.notes).toContain('split-merge')
    expect(merged.notes).toContain('50')
  })

  it('stays quiet when the halves agree', () => {
    const merged = mergeSplitResults(res([row(50, '2024-10-26')]), res([row(50, '2024-10-26')]))
    expect(merged.notes).not.toContain('split-merge')
  })

  it('takes the document date from whichever half found one', () => {
    expect(mergeSplitResults(res([], '', null), res([], '', '2024-10-25')).document_date).toBe('2024-10-25')
  })

  it('drops rows with an unusable key', () => {
    const merged = mergeSplitResults(res([{ row_key: 'abc', fields: {}, confidence: 'low' }]), res([row(1, '2024-10-26')]))
    expect(merged.rows.map((r) => r.row_key)).toEqual([1])
  })
})

describe('normRectToPixels', () => {
  it('maps a rect into pixel space', () => {
    expect(normRectToPixels({ x: 0.5, y: 0.25, w: 0.5, h: 0.5 }, 1000, 800)).toEqual({
      left: 500,
      top: 200,
      width: 500,
      height: 400,
    })
  })

  it('clamps an oversized rect inside the image', () => {
    const px = normRectToPixels({ x: 0.9, y: 0.9, w: 0.5, h: 0.5 }, 1000, 800)
    expect(px.left + px.width).toBeLessThanOrEqual(1000)
    expect(px.top + px.height).toBeLessThanOrEqual(800)
  })

  it('never produces a zero-size region', () => {
    const px = normRectToPixels({ x: 0, y: 0, w: 0.0001, h: 0.0001 }, 100, 100)
    expect(px.width).toBeGreaterThanOrEqual(1)
    expect(px.height).toBeGreaterThanOrEqual(1)
  })
})
