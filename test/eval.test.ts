import { describe, it, expect } from 'vitest'
import { multisetDiff, fieldAccuracy, rowKeySignature, rowSignature } from '../src/eval/diff.js'
import { prf, microAverage } from '../src/eval/metrics.js'
import { generateAmbiguities } from '../src/eval/ambiguity.js'
import { generateSample, STANDARD_CORPUS, augmentationRng } from '../fixtures/generate.js'
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

describe('corpus design', () => {
  /**
   * The controlled-comparison property, asserted rather than assumed.
   *
   * Every degraded fixture must carry the same rows as `clean`, or a score
   * difference cannot be attributed to the degradation. An earlier corpus gave each
   * fixture its own seed and so measured contents and treatment together — it
   * looked like a robustness test and was not one. Nothing about the code stops that
   * from happening again; this does.
   */
  // Rendering the corpus at full size takes long enough on a cold CI runner to trip
  // vitest's default timeout. The rows come from the seed, the fill rate and the
  // spec — never from the canvas — so these render small. The property under test is
  // untouched by the size, and the fixtures themselves are still generated at 1200×1600.
  const small = { width: 300, height: 400 }

  it('gives every degraded fixture the same gold set as the clean one', async () => {
    const degraded = STANDARD_CORPUS.filter((c) => c.opts.augment?.length)
    expect(degraded.length).toBeGreaterThan(4)

    const clean = STANDARD_CORPUS.find((c) => c.id === 'clean')!
    const truth = await generateSample(spec, { ...clean.opts, ...small })

    for (const entry of degraded) {
      const sample = await generateSample(spec, { ...entry.opts, ...small })
      expect(sample.rows, `${entry.id} vs clean`).toEqual(truth.rows)
      expect(sample.documentDate, entry.id).toBe(truth.documentDate)
    }
  }, 30_000)

  it('still varies the rows where the fixture is about density, not degradation', async () => {
    // `sparse` and `full` change fill rate on purpose, so their gold sets differ.
    // Asserting this keeps the rule above from being satisfied by a corpus where
    // every sample is identical and nothing is being varied at all.
    const at = (id: string) => ({ ...STANDARD_CORPUS.find((c) => c.id === id)!.opts, ...small })
    const clean = await generateSample(spec, at('clean'))
    const sparse = await generateSample(spec, at('sparse'))
    const full = await generateSample(spec, at('full'))

    expect(sparse.rows.length).toBeLessThan(clean.rows.length)
    expect(full.rows.length).toBeGreaterThan(clean.rows.length)
  }, 30_000)
})

describe('augmentation severity', () => {
  /**
   * Each degradation's severity has to be its own, or a combined fixture is not the
   * combination of its parts.
   *
   * The augmentations used to draw from one shared stream in application order, so
   * `glare` — which draws twice for its centre — shifted `skew` onto a different
   * angle. `worst-case` is glare+skew+blur+shadow and drew a near-zero rotation,
   * scoring identically to the clean sheet while `skew` alone cost nineteen points.
   */
  it('draws the same numbers for an augmentation regardless of the others applied', () => {
    for (const augmentation of ['glare', 'skew', 'blur', 'crop'] as const) {
      const a = augmentationRng(1, augmentation)
      const b = augmentationRng(1, augmentation)
      expect([a(), a(), a()], augmentation).toEqual([b(), b(), b()])
    }
  })

  it('gives different augmentations different streams', () => {
    // Otherwise every degradation would be parameterised identically, and the
    // corpus would vary the kind of damage without varying its severity.
    const seen = new Set(
      (['glare', 'shadow', 'lowlight', 'skew', 'blur', 'crop'] as const).map((a) => augmentationRng(1, a)()),
    )
    expect(seen.size).toBe(6)
  })

  it('gives the same augmentation different severity under different seeds', () => {
    expect(augmentationRng(1, 'skew')()).not.toBe(augmentationRng(2, 'skew')())
  })
})
