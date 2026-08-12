import { describe, it, expect } from 'vitest'
import {
  blockForKey,
  rectForKey,
  rectForKeys,
  sectionChunks,
  expandByRows,
  rowPitch,
  isValidRowKey,
} from '../src/formspec/geometry.js'
import { campgroundRosterSpec as spec } from '../examples/campground-roster/spec.js'

describe('block resolution', () => {
  it('resolves main-grid keys to their column', () => {
    expect(blockForKey(spec, 1)?.id).toBe('main-left')
    expect(blockForKey(spec, 50)?.id).toBe('main-left')
    expect(blockForKey(spec, 51)?.id).toBe('main-right')
    expect(blockForKey(spec, 89)?.id).toBe('main-right')
  })

  it('lets a narrow band win over the wide column containing its range', () => {
    // The whole point of declaration-order precedence: 90-98 is numerically inside
    // main-right's 51-100, but visually it is a separate highlighted band.
    expect(blockForKey(spec, 90)?.id).toBe('river-bend')
    expect(blockForKey(spec, 98)?.id).toBe('river-bend')
    expect(blockForKey(spec, 99)?.id).toBe('main-right')
  })

  it('resolves the lettered group rows mapped above the main range', () => {
    expect(blockForKey(spec, 101)?.id).toBe('group-sites')
    expect(blockForKey(spec, 107)?.id).toBe('group-sites')
  })

  it('returns null outside every declared range', () => {
    expect(blockForKey(spec, 0)).toBeNull()
    expect(blockForKey(spec, 108)).toBeNull()
    expect(blockForKey(spec, NaN)).toBeNull()
  })
})

describe('rectForKey', () => {
  it('places consecutive rows in increasing vertical order', () => {
    const a = rectForKey(spec, 10)!
    const b = rectForKey(spec, 11)!
    expect(b.y).toBeGreaterThan(a.y)
  })

  it('puts the two columns on opposite sides of the page', () => {
    expect(rectForKey(spec, 5)!.x).toBeLessThan(0.5)
    expect(rectForKey(spec, 55)!.x).toBeGreaterThan(0.5)
  })

  it('keeps every rect inside the image', () => {
    for (let key = 1; key <= 107; key++) {
      const rect = rectForKey(spec, key)
      if (!rect) continue
      expect(rect.x).toBeGreaterThanOrEqual(0)
      expect(rect.y).toBeGreaterThanOrEqual(0)
      expect(rect.x + rect.w).toBeLessThanOrEqual(1.0001)
      expect(rect.y + rect.h).toBeLessThanOrEqual(1.0001)
    }
  })

  it('pads rows vertically so overflowing handwriting is not clipped', () => {
    const block = blockForKey(spec, 20)!
    const rect = rectForKey(spec, 20)!
    expect(rect.h).toBeGreaterThan(rowPitch(block))
  })

  const centre = (key: number) => {
    const r = rectForKey(spec, key)!
    return r.y + r.h / 2
  }

  it('derives pitch from declared slots, not from the keys a block resolves', () => {
    // main-right declares 50 slots but resolves only 41 — 51-89 plus the 99-100 tail,
    // because the band claims 90-98. Computing pitch from the resolved count would
    // compress the column and drift every crop below row 51 progressively upward.
    const pitch = rowPitch(blockForKey(spec, 60)!)
    expect(pitch).toBeCloseTo((0.91 - 0.11) / 50, 10)
    expect(centre(80) - centre(60)).toBeCloseTo(20 * pitch, 10)
  })

  it('tiles the band exactly onto the column slots it overlays', () => {
    // The band is a tint over rows the column already owns. If its extent is
    // eyeballed rather than derived, rows 76-89 and 90-98 resolve to overlapping
    // pixels and both sets of crops are wrong.
    const columnPitch = rowPitch(blockForKey(spec, 60)!)
    expect(rowPitch(blockForKey(spec, 94)!)).toBeCloseTo(columnPitch, 10)

    // Crossing into and out of the band stays on the same continuous row grid.
    expect(centre(90) - centre(89)).toBeCloseTo(columnPitch, 10)
    expect(centre(99) - centre(98)).toBeCloseTo(columnPitch, 10)
  })

  it('keeps the group block clear of the column above it', () => {
    const lastLeft = rectForKey(spec, 50)!
    const firstGroup = rectForKey(spec, 101)!
    expect(firstGroup.y).toBeGreaterThan(lastLeft.y + lastLeft.h)
  })

  it('never resolves two keys to overlapping row centres in the same column', () => {
    const byColumn = new Map<string, Array<{ key: number; centre: number }>>()
    for (let key = 1; key <= 107; key++) {
      const rect = rectForKey(spec, key)
      if (!rect) continue
      const column = rect.x < 0.5 ? 'left' : 'right'
      byColumn.set(column, [...(byColumn.get(column) ?? []), { key, centre: centre(key) }])
    }

    for (const [column, entries] of byColumn) {
      const sorted = [...entries].sort((a, b) => a.centre - b.centre)
      for (let i = 1; i < sorted.length; i++) {
        expect(
          sorted[i].centre - sorted[i - 1].centre,
          `${column}: rows ${sorted[i - 1].key} and ${sorted[i].key} resolve to the same place`,
        ).toBeGreaterThan(1e-6)
      }
    }
  })
})

describe('rectForKeys', () => {
  it('bounds every listed key', () => {
    const union = rectForKeys(spec, [11, 12, 13, 14, 15])!
    for (const key of [11, 12, 13, 14, 15]) {
      const rect = rectForKey(spec, key)!
      expect(rect.y).toBeGreaterThanOrEqual(union.y - 1e-9)
      expect(rect.y + rect.h).toBeLessThanOrEqual(union.y + union.h + 1e-9)
    }
  })

  it('returns null when no key resolves', () => {
    expect(rectForKeys(spec, [500, 600])).toBeNull()
  })
})

describe('sectionChunks', () => {
  const chunks = sectionChunks(spec)

  it('covers every valid key exactly once', () => {
    const flat = chunks.flat()
    expect(new Set(flat).size).toBe(flat.length)

    const expected: number[] = []
    for (let k = 1; k <= 107; k++) expected.push(k)
    expect([...flat].sort((a, b) => a - b)).toEqual(expected)
  })

  it('never crosses a block boundary', () => {
    for (const chunk of chunks) {
      const ids = new Set(chunk.map((k) => blockForKey(spec, k)?.id))
      expect(ids.size).toBe(1)
    }
  })

  it('derives the boundaries that were originally hand-tuned for this form', () => {
    // This is the argument for the abstraction: the chunk list below was written by
    // hand against the real sheet, and it now falls out of the layout declaration.
    const ranges = chunks.map((c) => [c[0], c[c.length - 1]])
    expect(ranges).toEqual([
      [1, 10], [11, 20], [21, 30], [31, 40], [41, 50],
      [90, 98],
      [51, 60], [61, 70], [71, 80], [81, 89], [99, 100],
      [101, 107],
    ])
  })

  it('splits a claimed range into separate runs rather than one straddling chunk', () => {
    // 81-89 stops at 89 because the band owns 90; 99-100 is the tail after it.
    const flat = chunks.map((c) => c.join(','))
    expect(flat).toContain('81,82,83,84,85,86,87,88,89')
    expect(flat).toContain('99,100')
    expect(flat.some((c) => c.includes('89,90'))).toBe(false)
  })

  it('respects a different chunk size', () => {
    const wide = sectionChunks({ ...spec, layout: { ...spec.layout, sectionChunkRows: 25 } })
    expect(wide.length).toBeLessThan(chunks.length)
    expect(wide.flat().length).toBe(107)
  })
})

describe('expandByRows', () => {
  it('grows vertically and leaves the column alone', () => {
    const rect = { x: 0.1, y: 0.4, w: 0.3, h: 0.1 }
    const grown = expandByRows(rect, 2, 0.02)
    expect(grown.x).toBe(rect.x)
    expect(grown.w).toBe(rect.w)
    expect(grown.y).toBeCloseTo(0.36, 10)
    expect(grown.h).toBeCloseTo(0.18, 10)
  })

  it('clamps at the image edges', () => {
    const grown = expandByRows({ x: 0, y: 0.01, w: 1, h: 0.98 }, 5, 0.02)
    expect(grown.y).toBe(0)
    expect(grown.y + grown.h).toBeLessThanOrEqual(1)
  })

  it('is a no-op for zero or invalid inputs', () => {
    const rect = { x: 0.1, y: 0.4, w: 0.3, h: 0.1 }
    expect(expandByRows(rect, 0, 0.02)).toEqual(rect)
    expect(expandByRows(rect, 2, 0)).toEqual(rect)
  })
})

describe('isValidRowKey', () => {
  it('accepts declared ranges and rejects everything else', () => {
    expect(isValidRowKey(spec, 1)).toBe(true)
    expect(isValidRowKey(spec, 107)).toBe(true)
    expect(isValidRowKey(spec, 0)).toBe(false)
    expect(isValidRowKey(spec, 108)).toBe(false)
    expect(isValidRowKey(spec, 1.5)).toBe(true) // range check only; integrality is the validator's job
  })
})
