/**
 * Anchored row resolution — no AWS, no network.
 *
 * The synthetic pages here are built to reproduce, in miniature, the three things
 * measured on a corpus of 41 real clipboard photographs that positional mapping
 * cannot survive: keystone, a pitch no constant predicts, and non-contiguous printed
 * row numbers. Each has a test that positional mode fails and anchored mode passes.
 */

import { describe, it, expect } from 'vitest'
import { findGutters, anchoredRows, anchoredLabelRows, asRowKey, type AnchorWord } from '../src/extract/anchor.js'
import { assembleAnchored, fillByOrder, toAnchorWords } from '../src/extract/textract.js'
import { keyAtNormPoint } from '../src/formspec/geometry.js'
import { campgroundRosterSpec as spec } from '../examples/campground-roster/spec.js'

/** A word with a right edge at `rx`, centred on `cy`. */
function w(text: string, rx: number, cy: number, confidence = 99): AnchorWord {
  return { text, confidence, cx: rx - 0.01, cy, rx }
}

/** A cell sitting to the right of the gutter at `gx`. */
function cell(text: string, gx: number, cy: number, offset: number, confidence = 99): AnchorWord {
  const cx = gx + offset
  return { text, confidence, cx, cy, rx: cx + 0.01 }
}

/**
 * A page of printed row numbers with a given keystone, pitch, and set of keys.
 *
 * `keystone` is the drift in x from top to bottom — the thing a fixed-x window
 * cannot follow.
 */
function page(
  keys: number[],
  opts: { top?: number; pitch?: number; gx?: number; keystone?: number; dates?: boolean } = {},
): AnchorWord[] {
  const { top = 0.12, pitch = 0.014, gx = 0.2, keystone = 0, dates = true } = opts
  const words: AnchorWord[] = []
  keys.forEach((key, i) => {
    const cy = top + i * pitch
    const x = gx + keystone * (cy - top)
    words.push(w(String(key), x, cy))
    if (dates) {
      words.push(cell('10/26', x, cy, 0.05))
      words.push(cell('10/28', x, cy, 0.11))
    }
  })
  return words
}

describe('asRowKey', () => {
  it('accepts in-range keys and rejects the rest', () => {
    expect(asRowKey(spec, '47')).toEqual({ key: 47, struck: false })
    expect(asRowKey(spec, '107')).toEqual({ key: 107, struck: false })
    expect(asRowKey(spec, '0')).toBeNull()
    expect(asRowKey(spec, '108')).toBeNull()
    expect(asRowKey(spec, 'Doyle')).toBeNull()
  })

  it('recognises a struck-through key without losing the number', () => {
    // The sheet legend strikes a number through on checkout; OCR returns "/3".
    // Rejecting it loses the row, and the strike is itself a signal worth keeping.
    expect(asRowKey(spec, '/3')).toEqual({ key: 3, struck: true })
  })
})

describe('findGutters', () => {
  it('measures the page keystone from the printed column', () => {
    const [gutter] = findGutters(spec, page([...Array(20)].map((_, i) => i + 1), { keystone: -0.04 }))
    expect(gutter).toBeDefined()
    // Slope is recovered from the paper itself, not declared anywhere.
    expect(gutter.line.b).toBeCloseTo(-0.04, 1)
    expect(gutter.rms).toBeLessThan(0.002)
  })

  it('measures pitch per photo rather than assuming one', () => {
    // Real corpus pitch ranged 0.0096-0.0197, a 2x spread. No constant serves.
    for (const pitch of [0.0096, 0.014, 0.0197]) {
      const [gutter] = findGutters(spec, page([...Array(20)].map((_, i) => i + 1), { pitch }))
      expect(gutter.pitch).toBeCloseTo(pitch, 3)
    }
  })

  it('is not fooled by a numeric data column that outnumbers the gutter', () => {
    // A "# of people" column is also a vertical stack of small integers, and on a
    // busy sheet there are more of them. Its values don't ascend down the page.
    const words = page([...Array(20)].map((_, i) => i + 1), { dates: false })
    const noise: AnchorWord[] = []
    for (let i = 0; i < 30; i++) {
      noise.push(w(String(1 + (i % 4)), 0.33, 0.12 + i * 0.009))
    }

    const gutters = findGutters(spec, [...words, ...noise])
    expect(gutters).toHaveLength(1)
    expect(gutters[0].anchors.length).toBeGreaterThanOrEqual(18)
    // The impostor column sits at rx 0.33; the real gutter at 0.2.
    expect(gutters[0].line.a).toBeCloseTo(0.2, 1)
  })

  it('bins on the right edge so 1- and 2-digit keys share a gutter', () => {
    // Right-aligned printing means "7" and "47" share a right edge but not a centre.
    // Binning on centres splits one gutter in two and neither half survives.
    const words = [...Array(20)].map((_, i) => w(String(i + 1), 0.2, 0.12 + i * 0.014))
    const [gutter] = findGutters(spec, words)
    expect(gutter.anchors).toHaveLength(20)
  })

  it('finds both columns of a two-column form', () => {
    const left = page([...Array(15)].map((_, i) => i + 1), { gx: 0.2 })
    const right = page([...Array(15)].map((_, i) => i + 51), { gx: 0.6 })
    const gutters = findGutters(spec, [...left, ...right])
    expect(gutters).toHaveLength(2)
    expect(gutters[0].line.a).toBeLessThan(gutters[1].line.a)
  })

  it('returns nothing when there is no printed column to anchor on', () => {
    expect(findGutters(spec, [w('Doyle', 0.2, 0.3), w('10/26', 0.4, 0.3)])).toHaveLength(0)
  })
})

describe('anchoredRows', () => {
  it('reads non-contiguous printed keys as printed', () => {
    // The decisive case. A real roster prints 51,52,53,55,56,64,65... Computing
    // key = first + slot is not a tuning error, it is the wrong model of the form.
    const keys = [51, 52, 53, 55, 56, 64, 65, 66, 67, 68, 69, 70]
    const rows = anchoredRows(spec, page(keys))
    expect(rows.map((r) => r.rowKey)).toEqual(keys)
  })

  it('keeps rows aligned under keystone that defeats a fixed-x window', () => {
    const keys = [...Array(20)].map((_, i) => i + 1)
    const words = page(keys, { keystone: -0.05 })
    const rows = anchoredRows(spec, words)
    expect(rows.map((r) => r.rowKey)).toEqual(keys)
    for (const row of rows) expect(row.cells.map((c) => c.text)).toEqual(['10/26', '10/28'])
  })

  it('returns blank rows so a review queue can surface what the parser missed', () => {
    // A queue seeded only with positive proposals cannot show a row that was never
    // read — and that is the failure a human reviewer is least likely to catch.
    const words = page([...Array(20)].map((_, i) => i + 1), { dates: false })
    const rows = anchoredRows(spec, words)
    expect(rows).toHaveLength(20)
    expect(rows.every((r) => r.cells.length === 0)).toBe(true)
  })

  it('rejects a margin scribble that falls outside the row band', () => {
    const keys = [...Array(20)].map((_, i) => i + 1)
    const words = page(keys)
    words.push(cell('9/9', 0.2, 0.125 + 0.007, 0.05)) // between two rows
    const row = anchoredRows(spec, words).find((r) => r.rowKey === 1)!
    expect(row.cells.map((c) => c.text)).toEqual(['10/26', '10/28'])
  })
})

describe('anchoredLabelRows', () => {
  it('maps printed letter labels onto the numeric key space', () => {
    const words: AnchorWord[] = []
    for (let i = 1; i <= 7; i++) {
      const cy = 0.78 + i * 0.015
      words.push(w(`G${i}`, 0.1, cy))
      words.push(cell('10/26', 0.1, cy, 0.05))
      words.push(cell('10/28', 0.1, cy, 0.11))
    }
    const rows = anchoredLabelRows(spec, words)
    expect(rows.map((r) => r.rowKey)).toEqual([101, 102, 103, 104, 105, 106, 107])
    expect(rows[3].cells.map((c) => c.text)).toEqual(['10/26', '10/28'])
  })
})

describe('fillByOrder', () => {
  it('assigns cells by reading order, not by x-window', () => {
    const row = {
      rowKey: 14,
      keyConfidence: 99,
      cy: 0.3,
      cells: [cell('10/26', 0.2, 0.3, 0.05), cell('10/28', 0.2, 0.3, 0.11)],
    }
    expect(fillByOrder(spec, row)).toEqual({ date_in: '10/26', date_out: '10/28' })
  })

  it('is not shifted by an unmapped column between the mapped ones', () => {
    // Type-matching is what makes ordering safe: a name is not a date-shaped token,
    // so the second date still lands in date_out.
    const row = {
      rowKey: 14,
      keyConfidence: 99,
      cy: 0.3,
      cells: [
        cell('10/26', 0.2, 0.3, 0.05),
        cell('Doyle', 0.2, 0.3, 0.08),
        cell('10/28', 0.2, 0.3, 0.11),
      ],
    }
    expect(fillByOrder(spec, row)).toEqual({ date_in: '10/26', date_out: '10/28' })
  })

  it('never emits a PII field', () => {
    const row = {
      rowKey: 14,
      keyConfidence: 99,
      cy: 0.3,
      cells: [cell('10/26', 0.2, 0.3, 0.05), cell('10/28', 0.2, 0.3, 0.11), cell('Doyle', 0.2, 0.3, 0.2)],
    }
    expect(fillByOrder(spec, row)).not.toHaveProperty('last_name')
  })

  it('tolerates a pen hook on a date', () => {
    // "5/4!" at confidence 54 was a correct read on the real sheet; rejecting it
    // loses a row that production got wrong.
    const row = { rowKey: 13, keyConfidence: 54, cy: 0.3, cells: [cell('5/4!', 0.2, 0.3, 0.05)] }
    expect(fillByOrder(spec, row)).toEqual({ date_in: '5/4!' })
  })
})

describe('anchored vs positional', () => {
  const keys = [...Array(20)].map((_, i) => i + 1)

  it('anchored survives a page that positional cannot resolve', () => {
    // The same page, read two ways. Keystone plus a pitch the spec doesn't declare.
    const words = page(keys, { keystone: -0.06, pitch: 0.0197, top: 0.14 })

    const anchored = anchoredRows(spec, words).map((r) => r.rowKey)
    expect(anchored).toEqual(keys)

    // Positional maps the same words through declared geometry. It resolves *some*
    // key for most words — that is the danger — but not the printed one.
    const positional = words
      .filter((x) => /^\d+$/.test(x.text))
      .map((x) => keyAtNormPoint(spec, x.cx, x.cy))
    const correct = positional.filter((k, i) => k === keys[i]).length
    expect(correct).toBeLessThan(keys.length)
  })
})

describe('toAnchorWords', () => {
  it('takes the right edge, which is what gutter binning depends on', () => {
    const [word] = toAnchorWords([
      {
        BlockType: 'WORD',
        Text: '47',
        Confidence: 99,
        Geometry: { BoundingBox: { Left: 0.18, Top: 0.3, Width: 0.02, Height: 0.008 } },
      },
    ])
    expect(word.rx).toBeCloseTo(0.2, 6)
    expect(word.cx).toBeCloseTo(0.19, 6)
  })

  it('drops non-words, empty text, and sub-threshold reads', () => {
    expect(
      toAnchorWords(
        [
          { BlockType: 'LINE', Text: 'x', Confidence: 99, Geometry: { BoundingBox: { Left: 0, Top: 0, Width: 1, Height: 1 } } },
          { BlockType: 'WORD', Text: '   ', Confidence: 99, Geometry: { BoundingBox: { Left: 0, Top: 0, Width: 1, Height: 1 } } },
          { BlockType: 'WORD', Text: 'y', Confidence: 10, Geometry: { BoundingBox: { Left: 0, Top: 0, Width: 1, Height: 1 } } },
        ],
        45,
      ),
    ).toHaveLength(0)
  })
})

describe('assembleAnchored', () => {
  it('emits only rows that carry content, and grades their confidence', () => {
    // One column of 15 printed rows; only the first 10 are filled in. A gutter needs
    // at least 8 anchors to form, so the blanks are part of what makes it findable —
    // they just don't become bookings.
    const filled = page([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    const blank = page([11, 12, 13, 14, 15], { top: 0.12 + 10 * 0.014, dates: false })

    const rows = assembleAnchored(spec, [...filled, ...blank])

    expect(rows.map((r) => r.row_key)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    expect(rows[0].fields).toEqual({ date_in: '10/26', date_out: '10/28' })
    expect(rows[0].confidence).toBe('high')
  })
})
