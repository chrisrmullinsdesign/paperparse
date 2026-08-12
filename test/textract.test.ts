/**
 * Textract backend tests — no AWS, no network.
 *
 * The API call is a thin wrapper; the interesting failures live in the mapping from
 * bounding boxes to (row, field) cells. That mapping is pure, so it gets tested
 * directly against synthetic block lists.
 */

import { describe, it, expect } from 'vitest'
import type { Block } from '@aws-sdk/client-textract'
import { placeWords, assembleRows, TextractBackend } from '../src/extract/textract.js'
import { EscalatingBackend } from '../src/extract/escalate.js'
import { keyAtNormPoint, fieldAtNormPoint, rectForKey } from '../src/formspec/geometry.js'
import { generateSample } from '../fixtures/generate.js'
import { campgroundRosterSpec as spec } from '../examples/campground-roster/spec.js'
import type { Backend, ExtractRequest, ExtractResponse } from '../src/extract/backend.js'

/** A WORD block centred on a given normalized point. */
function word(text: string, x: number, y: number, confidence = 99): Block {
  return {
    BlockType: 'WORD',
    Text: text,
    Confidence: confidence,
    Geometry: { BoundingBox: { Left: x - 0.02, Top: y - 0.004, Width: 0.04, Height: 0.008 } },
  }
}

/** Point at the centre of a given field's column on a given row. */
function pointFor(rowKey: number, field: string): { x: number; y: number } {
  const rect = rectForKey(spec, rowKey)!
  const f = spec.fields.find((x) => x.name === field)!
  const [c0, c1] = f.column!
  return { x: rect.x + rect.w * ((c0 + c1) / 2), y: rect.y + rect.h / 2 }
}

describe('geometry inversion', () => {
  it('round-trips a row key through its own rect', () => {
    for (const key of [1, 25, 50, 51, 75, 89, 94, 99, 100, 101, 107]) {
      const rect = rectForKey(spec, key)!
      const centre = { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 }
      expect(keyAtNormPoint(spec, centre.x, centre.y), `key ${key}`).toBe(key)
    }
  })

  it('resolves a point inside the band to the band, not the column beneath it', () => {
    const p = pointFor(94, 'date_in')
    expect(keyAtNormPoint(spec, p.x, p.y)).toBe(94)
  })

  it('returns null outside any block', () => {
    expect(keyAtNormPoint(spec, 0.5, 0.02)).toBeNull() // header strip
    expect(keyAtNormPoint(spec, 0.5, 0.5)).toBeNull() // gutter between columns
    expect(keyAtNormPoint(spec, 0.25, 0.95)).toBeNull() // below everything
  })

  it('maps x within a block to the right field column', () => {
    for (const field of ['last_name', 'permit_number', 'date_in', 'date_out']) {
      const p = pointFor(20, field)
      expect(fieldAtNormPoint(spec, p.x, p.y), field).toBe(field)
    }
  })

  it('treats the row-number gutter as belonging to no field', () => {
    const rect = rectForKey(spec, 20)!
    expect(fieldAtNormPoint(spec, rect.x + rect.w * 0.03, rect.y + rect.h / 2)).toBeNull()
  })
})

describe('placeWords', () => {
  it('places words into the cells the geometry says they occupy', () => {
    const a = pointFor(14, 'date_in')
    const b = pointFor(14, 'date_out')
    const placed = placeWords(spec, [word('10/26', a.x, a.y), word('10/28', b.x, b.y)])

    expect(placed).toHaveLength(2)
    expect(placed[0]).toMatchObject({ rowKey: 14, field: 'date_in', text: '10/26' })
    expect(placed[1]).toMatchObject({ rowKey: 14, field: 'date_out', text: '10/28' })
  })

  it('drops words below the confidence floor rather than guessing', () => {
    const p = pointFor(14, 'date_in')
    expect(placeWords(spec, [word('10/26', p.x, p.y, 20)])).toHaveLength(0)
    expect(placeWords(spec, [word('10/26', p.x, p.y, 20)], 10)).toHaveLength(1)
  })

  it('ignores non-WORD blocks and printed furniture', () => {
    const p = pointFor(14, 'date_in')
    const rect = rectForKey(spec, 14)!
    const blocks: Block[] = [
      { BlockType: 'PAGE' },
      { BlockType: 'TABLE' },
      { BlockType: 'LINE', Text: '10/26', Confidence: 99, Geometry: { BoundingBox: { Left: p.x, Top: p.y, Width: 0.04, Height: 0.008 } } },
      word('14', rect.x + rect.w * 0.03, rect.y + rect.h / 2), // the printed row number
      word('10/26', p.x, p.y),
    ]
    const placed = placeWords(spec, blocks)
    expect(placed).toHaveLength(1)
    expect(placed[0].text).toBe('10/26')
  })

  it('skips words with no geometry', () => {
    expect(placeWords(spec, [{ BlockType: 'WORD', Text: 'x', Confidence: 99 }])).toHaveLength(0)
  })
})

describe('assembleRows', () => {
  it('builds rows and never emits a PII column', () => {
    const name = pointFor(14, 'last_name')
    const dIn = pointFor(14, 'date_in')
    const dOut = pointFor(14, 'date_out')

    const rows = assembleRows(
      spec,
      placeWords(spec, [word('Doyle', name.x, name.y), word('10/26', dIn.x, dIn.y), word('10/28', dOut.x, dOut.y)]),
    )

    expect(rows).toHaveLength(1)
    expect(rows[0].row_key).toBe(14)
    expect(rows[0].fields).toEqual({ date_in: '10/26', date_out: '10/28' })
    expect(rows[0].fields).not.toHaveProperty('last_name')
  })

  it('joins a multi-word cell left to right', () => {
    const p = pointFor(14, 'last_name')
    const dIn = pointFor(14, 'date_in')
    // Declared right-to-left to prove ordering comes from geometry, not input order.
    const rows = assembleRows(
      spec,
      placeWords(spec, [word('Smith', p.x + 0.03, p.y), word('Van', p.x - 0.03, p.y), word('10/26', dIn.x, dIn.y)]),
      { high: 0, medium: 0 },
    )
    expect(rows).toHaveLength(1)
    // last_name is PII so it isn't emitted — but the row survives on its date.
    expect(rows[0].fields.date_in).toBe('10/26')
  })

  it('grades row confidence from mean word confidence', () => {
    const p = pointFor(14, 'date_in')
    const at = (c: number) => assembleRows(spec, placeWords(spec, [word('10/26', p.x, p.y, c)]))[0].confidence
    expect(at(99)).toBe('high')
    expect(at(80)).toBe('medium')
    expect(at(60)).toBe('low')
  })

  it('counts PII-column confidence toward the row even though the value is dropped', () => {
    // A row whose name came back as mush is worth a second look, even though the
    // name itself is never stored.
    const name = pointFor(14, 'last_name')
    const dIn = pointFor(14, 'date_in')
    const rows = assembleRows(
      spec,
      placeWords(spec, [word('???', name.x, name.y, 50), word('10/26', dIn.x, dIn.y, 99)]),
    )
    expect(rows[0].confidence).not.toBe('high')
  })

  it('emits rows in row-key order', () => {
    const words = [40, 12, 88].map((k) => {
      const p = pointFor(k, 'date_in')
      return word('10/26', p.x, p.y)
    })
    const rows = assembleRows(spec, placeWords(spec, words))
    expect(rows.map((r) => r.row_key)).toEqual([12, 40, 88])
  })
})

describe('TextractBackend', () => {
  it('maps a stubbed AnalyzeDocument response into rows', async () => {
    const dIn = pointFor(22, 'date_in')
    const blocks = [word('10/26', dIn.x, dIn.y)]

    const backend = new TextractBackend({
      client: { send: async () => ({ Blocks: blocks }) } as never,
    })

    const { result, model } = await backend.extract({ image: Buffer.alloc(0), spec, prompt: '' })
    expect(model).toBe('textract:analyze-document')
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0].row_key).toBe(22)
    // Textract can't see the header from a row, so it declines to guess a year.
    expect(result.document_date).toBeNull()
  })

  it('reports the form as unrecognised when nothing places', async () => {
    const backend = new TextractBackend({ client: { send: async () => ({ Blocks: [] }) } as never })
    const { result } = await backend.extract({ image: Buffer.alloc(0), spec, prompt: '' })
    expect(result.looks_like_expected_form).toBe(false)
    expect(result.rows).toHaveLength(0)
  })
})

describe('EscalatingBackend', () => {
  const rowAt = (key: number, confidence: 'high' | 'medium' | 'low', dateIn: string) => ({
    row_key: key,
    fields: { date_in: dateIn, date_out: '2024-10-28' },
    confidence,
  })

  function stub(name: string, rows: ReturnType<typeof rowAt>[], onCall?: (r: ExtractRequest) => void): Backend {
    return {
      name,
      isAvailable: () => true,
      async extract(req: ExtractRequest): Promise<ExtractResponse> {
        onCall?.(req)
        return {
          result: { document_date: '2024-10-25', rows, notes: '', looks_like_expected_form: true },
          model: name,
        }
      },
    }
  }

  it('re-reads only the uncertain rows and keeps the confident ones', async () => {
    const sample = await generateSample(spec, { seed: 5, fillRate: 0.2 })
    let escalatedKeys: readonly number[] = []

    const primary = stub('cheap', [rowAt(10, 'high', '2024-10-01'), rowAt(20, 'low', '2024-10-02')])
    const secondary = stub('dear', [rowAt(20, 'high', '2024-10-09')], (req) => {
      escalatedKeys = req.sectionKeys ?? []
    })

    const { result } = await new EscalatingBackend(primary, secondary).extract({
      image: sample.image,
      spec,
      prompt: '',
    })

    expect(escalatedKeys).toEqual([20])
    expect(result.rows.find((r) => r.row_key === 10)!.fields.date_in).toBe('2024-10-01') // untouched
    expect(result.rows.find((r) => r.row_key === 20)!.fields.date_in).toBe('2024-10-09') // re-read
    expect(result.notes).toContain('1/1 uncertain rows re-read')
  })

  it('reports both requests, so the harness does not undercount escalation', async () => {
    const sample = await generateSample(spec, { seed: 5, fillRate: 0.2 })
    const { usage } = await new EscalatingBackend(
      stub('cheap', [rowAt(20, 'low', '2024-10-02')]),
      stub('dear', [rowAt(20, 'high', '2024-10-09')]),
    ).extract({ image: sample.image, spec, prompt: '' })

    expect(usage?.requests).toBe(2)
  })

  it('escalates a row missing a required field, however confident the primary is', async () => {
    // Measured: escalating on confidence alone re-read the rows the primary had
    // already got right and ignored the half-read ones the validator then drops.
    const sample = await generateSample(spec, { seed: 5, fillRate: 0.2 })
    let escalatedKeys: readonly number[] = []

    const primary = stub('cheap', [
      { row_key: 30, fields: { date_in: '2024-10-02' }, confidence: 'high' } as never,
      rowAt(31, 'high', '2024-10-03'),
    ])
    const secondary = stub('dear', [rowAt(30, 'high', '2024-10-02')], (req) => {
      escalatedKeys = req.sectionKeys ?? []
    })

    const { result } = await new EscalatingBackend(primary, secondary).extract({
      image: sample.image,
      spec,
      prompt: '',
    })

    expect(escalatedKeys).toEqual([30])
    expect(result.rows.find((r) => r.row_key === 30)!.fields.date_out).toBe('2024-10-28')
  })

  it('can be told to ignore incomplete rows', async () => {
    const sample = await generateSample(spec, { seed: 5, fillRate: 0.2 })
    let called = false
    const primary = stub('cheap', [
      { row_key: 30, fields: { date_in: '2024-10-02' }, confidence: 'high' } as never,
    ])

    await new EscalatingBackend(
      primary,
      stub('dear', [], () => {
        called = true
      }),
      { escalateIncomplete: false },
    ).extract({ image: sample.image, spec, prompt: '' })

    expect(called).toBe(false)
  })

  it('does not call the secondary when everything is confident', async () => {
    const sample = await generateSample(spec, { seed: 5, fillRate: 0.2 })
    let called = false
    const secondary = stub('dear', [], () => {
      called = true
    })

    const { result, usage } = await new EscalatingBackend(
      stub('cheap', [rowAt(10, 'high', '2024-10-01')]),
      secondary,
    ).extract({ image: sample.image, spec, prompt: '' })

    expect(called).toBe(false)
    expect(usage?.requests).toBe(1)
    expect(result.notes).toContain('nothing to escalate')
  })

  it('declines to escalate when most of the page is uncertain', async () => {
    // Past a point, escalating stops being a saving — read the whole page with the
    // secondary instead.
    const sample = await generateSample(spec, { seed: 5, fillRate: 0.2 })
    let called = false
    const many = Array.from({ length: 12 }, (_, i) => rowAt(i + 1, 'low', '2024-10-01'))

    const { result } = await new EscalatingBackend(
      stub('cheap', many),
      stub('dear', [], () => {
        called = true
      }),
      { maxEscalatedRows: 5 },
    ).extract({ image: sample.image, spec, prompt: '' })

    expect(called).toBe(false)
    expect(result.notes).toContain('exceeds the cap')
  })

  it('retains the primary rows when the secondary fails', async () => {
    const sample = await generateSample(spec, { seed: 5, fillRate: 0.2 })
    const failing: Backend = {
      name: 'dear',
      isAvailable: () => true,
      async extract() {
        throw new Error('boom')
      },
    }

    const { result } = await new EscalatingBackend(
      stub('cheap', [rowAt(20, 'low', '2024-10-02')]),
      failing,
    ).extract({ image: sample.image, spec, prompt: '' })

    expect(result.rows).toHaveLength(1)
    expect(result.rows[0].fields.date_in).toBe('2024-10-02')
    expect(result.notes).toContain('secondary failed')
  })
})
