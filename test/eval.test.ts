import { describe, it, expect } from 'vitest'
import { multisetDiff, fieldAccuracy, rowKeySignature, rowSignature } from '../src/eval/diff.js'
import { prf, microAverage } from '../src/eval/metrics.js'
import { generateAmbiguities } from '../src/eval/ambiguity.js'
import { campgroundRosterSpec as spec } from '../examples/campground-roster/spec.js'
import type { ValidatedRow } from '../src/types.js'

function r(rowKey: number, dateIn: string, dateOut: string, confidence: ValidatedRow['confidence'] = 'high'): ValidatedRow {
  return { rowKey, fields: { date_in: dateIn, date_out: dateOut }, confidence }
}

describe('rowSignature', () => {
  it('is independent of field insertion order', () => {
    const a: ValidatedRow = { rowKey: 1, fields: { date_in: 'x', date_out: 'y' }, confidence: 'high' }
    const b: ValidatedRow = { rowKey: 1, fields: { date_out: 'y', date_in: 'x' }, confidence: 'low' }
    expect(rowSignature(a)).toBe(rowSignature(b))
  })
})

describe('multisetDiff', () => {
  const gold = [r(1, '2024-10-26', '2024-10-28'), r(2, '2024-10-27', '2024-10-29')]

  it('scores a perfect match', () => {
    const d = multisetDiff(gold, gold)
    expect(d).toMatchObject({ matched: 2, spurious: 0, missed: 0 })
  })

  it('counts a misread field as both spurious and missed', () => {
    // Exact-match semantics: a wrong field is a wrong row, not a partial credit.
    const predicted = [r(1, '2024-10-26', '2024-10-28'), r(2, '2024-10-21', '2024-10-29')]
    const d = multisetDiff(predicted, gold)
    expect(d).toMatchObject({ matched: 1, spurious: 1, missed: 1 })
  })

  it('separates found-the-row from read-it-right under key-only signatures', () => {
    const predicted = [r(1, '2024-10-26', '2024-10-28'), r(2, '2024-10-21', '2024-10-29')]
    const d = multisetDiff(predicted, gold, rowKeySignature)
    expect(d).toMatchObject({ matched: 2, spurious: 0, missed: 0 })
  })

  it('counts duplicates with multiplicity', () => {
    const predicted = [r(1, '2024-10-26', '2024-10-28'), r(1, '2024-10-26', '2024-10-28')]
    const d = multisetDiff(predicted, [r(1, '2024-10-26', '2024-10-28')])
    expect(d).toMatchObject({ matched: 1, spurious: 1, missed: 0 })
  })

  it('handles empty predictions', () => {
    expect(multisetDiff([], gold)).toMatchObject({ matched: 0, spurious: 0, missed: 2 })
  })
})

describe('prf', () => {
  it('computes the standard quantities', () => {
    const p = prf({ predictedCount: 10, goldCount: 8, matched: 6, spurious: 4, missed: 2 })
    expect(p.precision).toBeCloseTo(0.6)
    expect(p.recall).toBeCloseTo(0.75)
    expect(p.f1).toBeCloseTo((2 * 0.6 * 0.75) / 1.35)
  })

  it('reports undefined metrics as null, not zero', () => {
    // A parser that returned nothing has undefined precision. Collapsing that to 0
    // produces averages that quietly lie about the empty cases.
    const empty = prf({ predictedCount: 0, goldCount: 5, matched: 0, spurious: 0, missed: 5 })
    expect(empty.precision).toBeNull()
    expect(empty.recall).toBe(0)
    expect(empty.f1).toBeNull()

    const noGold = prf({ predictedCount: 3, goldCount: 0, matched: 0, spurious: 3, missed: 0 })
    expect(noGold.recall).toBeNull()
  })
})

describe('microAverage', () => {
  it('weights by rows rather than by image', () => {
    // One 100-row image at 100% and one 2-row image at 0% should not average to 50%.
    const big = { predictedCount: 100, goldCount: 100, matched: 100, spurious: 0, missed: 0 }
    const small = { predictedCount: 2, goldCount: 2, matched: 0, spurious: 2, missed: 2 }
    const avg = microAverage([big, small])
    expect(avg.recall).toBeCloseTo(100 / 102)
    expect(avg.recall!).toBeGreaterThan(0.9)
  })

  it('handles an empty set', () => {
    expect(microAverage([]).precision).toBeNull()
  })
})

describe('fieldAccuracy', () => {
  it('scores only rows present in both sets', () => {
    const gold = [r(1, '2024-10-26', '2024-10-28'), r(2, '2024-10-27', '2024-10-29')]
    const predicted = [r(1, '2024-10-26', '2024-10-21')]
    const acc = fieldAccuracy(predicted, gold)

    expect(acc.comparedRows).toBe(1)
    expect(acc.comparedFields).toBe(2)
    expect(acc.correctFields).toBe(1)
    expect(acc.errorsByField.date_out).toBe(1)
    expect(acc.examples[0]).toMatchObject({ rowKey: 1, field: 'date_out', expected: '2024-10-28', got: '2024-10-21' })
  })

  it('reports a missing field rather than skipping it', () => {
    const acc = fieldAccuracy(
      [{ rowKey: 1, fields: { date_in: '2024-10-26' }, confidence: 'high' }],
      [r(1, '2024-10-26', '2024-10-28')],
    )
    expect(acc.errorsByField.date_out).toBe(1)
    expect(acc.examples[0].got).toBe('<missing>')
  })
})

describe('generateAmbiguities', () => {
  it('offers plausible alternative readings ordered best-guess-first', () => {
    const questions = generateAmbiguities(spec, [r(67, '2024-10-27', '2024-10-30', 'low')])
    expect(questions.length).toBeGreaterThan(0)

    const first = questions[0]
    expect(first.candidates[0].value).toBe('2024-10-27')
    expect(first.candidates.length).toBeGreaterThan(1)
    expect(first.status).toBe('open')
    expect(first.rowRef.rowKey).toBe(67)
  })

  it('attaches a crop rect so a reviewer can see the pixels in question', () => {
    const [question] = generateAmbiguities(spec, [r(30, '2024-10-27', '2024-10-30', 'low')])
    expect(question.cropRect).toBeDefined()
    expect(question.cropRect!.w).toBeGreaterThan(0)
  })

  it('never proposes a date the calendar does not have', () => {
    const questions = generateAmbiguities(spec, [r(5, '2024-02-28', '2024-03-01', 'low')])
    for (const q of questions) {
      for (const c of q.candidates) {
        const d = new Date(`${c.value}T00:00:00Z`)
        expect(Number.isNaN(d.getTime())).toBe(false)
        expect(d.toISOString().slice(0, 10)).toBe(String(c.value))
      }
    }
  })

  it('caps questions per row so one bad row cannot flood the queue', () => {
    const questions = generateAmbiguities(spec, [r(5, '2024-10-27', '2024-10-30', 'low')], { maxPerRow: 1 })
    expect(questions).toHaveLength(1)
  })
})
