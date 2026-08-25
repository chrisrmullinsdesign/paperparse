/**
 * Viewer tests — no network, no server, no browser.
 *
 * Everything the viewer shows is decided before the browser sees it: the record
 * builder decides what a run looks like, `applyResolutions` decides what an answer
 * does, and `safePath` decides what the local server will hand out. Those three are
 * plain functions and are tested here.
 *
 * `ui/index.html` itself is untested — the cost of shipping it without a build step,
 * and the reason the logic above lives in TypeScript rather than in the page.
 */

import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import { buildRunRecord, rowRects } from '../ui/record.js'
import { safePath } from '../ui/server.js'
import { applyResolutions, generateAmbiguities } from '../src/eval/ambiguity.js'
import { allValidKeys } from '../src/formspec/geometry.js'
import { campgroundRosterSpec as spec } from '../examples/campground-roster/spec.js'
import type { PipelineResult, ValidatedRow, Resolution, Ambiguity } from '../src/index.js'

function row(rowKey: number, over: Partial<ValidatedRow> = {}): ValidatedRow {
  return {
    rowKey,
    fields: { permit_number: 40000 + rowKey, date_in: '2024-10-27', date_out: '2024-10-30' },
    confidence: 'high',
    ...over,
  }
}

function result(over: Partial<PipelineResult> = {}): PipelineResult {
  return {
    rows: [row(2), row(3)],
    uncertainRows: [],
    stats: { rawRowCount: 2, acceptedRowCount: 2, droppedRowCount: 0, dropsByReason: {}, drops: [] },
    meta: { recordedAt: '2026-01-01T00:00:00.000Z', strategy: 'single', backend: 'textract' },
    usage: { requests: 1, inputTokens: 1000, outputTokens: 500 },
    raw: { document_date: '2024-10-25', rows: [], notes: 'n', looks_like_expected_form: true },
    ...over,
  } as PipelineResult
}

const base = {
  spec,
  stages: [],
  elapsedMs: 1234,
  readMode: 'auto' as const,
  backendName: 'textract',
}

describe('rowRects', () => {
  it('covers every key the spec declares valid', () => {
    const rects = rowRects(spec)
    const keys = allValidKeys(spec)
    expect(Object.keys(rects).length).toBe(keys.length)
    for (const k of keys) expect(rects[k], `key ${k}`).toBeDefined()
  })

  it('puts the lettered group rows in their own block, not off the end of a column', () => {
    const rects = rowRects(spec)
    // G1-G7 map onto keys 101-107 and are printed under the *left* column. Keys
    // 51-100 are the right one. A viewer that extrapolated from the numeric key
    // would draw them past the bottom of the right column, off the page.
    expect(rects[104].x).toBeLessThan(0.5)
    expect(rects[94].x).toBeGreaterThan(0.5)
    for (const rect of Object.values(rects)) {
      expect(rect.w).toBeGreaterThan(0)
      expect(rect.h).toBeGreaterThan(0)
      expect(rect.y + rect.h).toBeLessThanOrEqual(1)
    }
  })
})

describe('buildRunRecord', () => {
  it('scores against labels when there are labels', () => {
    const record = buildRunRecord({
      ...base,
      id: 'x',
      result: result(),
      gold: { documentDate: '2024-10-25', rows: [row(2), row(3)] },
    })
    expect(record.score!.keyDiff.matched).toBe(2)
    expect(record.score!.exactDiff.matched).toBe(2)
  })

  it('reports no score at all for an image with no labels', () => {
    // The failure this guards against is silent: an unlabelled photograph scored
    // against an empty gold set renders as a perfect run rather than an unmeasured
    // one, which is the wrong default in the more flattering direction.
    const record = buildRunRecord({ ...base, id: 'upload', result: result(), gold: null })
    expect(record.score).toBeNull()
    expect(record.gold).toBeNull()
  })

  it('leaves the cost column null for a backend that does not bill by token', () => {
    const textract = buildRunRecord({ ...base, id: 'x', result: result(), gold: null })
    expect(textract.estimatedCostUsd).toBeNull()

    const vision = buildRunRecord({ ...base, id: 'x', backendName: 'anthropic', result: result(), gold: null })
    expect(vision.estimatedCostUsd).toBeGreaterThan(0)
  })

  it('counts a missed row as missed, not as a row that was merely dropped', () => {
    const record = buildRunRecord({
      ...base,
      id: 'x',
      result: result({ rows: [row(2)] }),
      gold: { documentDate: '2024-10-25', rows: [row(2), row(3), row(4)] },
    })
    expect(record.score!.keyDiff.missed).toBe(2)
    expect(record.stats.droppedRowCount).toBe(0)
  })
})

describe('applyResolutions', () => {
  const uncertain = row(67, { confidence: 'low', fields: { permit_number: 64670, date_in: '2024-10-27', date_out: '2024-10-30' } })
  const questions = generateAmbiguities(spec, [uncertain])

  const answer = (q: Ambiguity, value: string | number): Resolution => ({
    ambiguityId: q.id,
    status: 'resolved_choice',
    value,
    resolvedAt: '2026-01-01T00:00:00.000Z',
  })

  it('names the field it is asking about', () => {
    expect(questions.length).toBeGreaterThan(0)
    for (const q of questions) expect(q.field).toBeTruthy()
  })

  it('writes the answer to that field and no other', () => {
    const q = questions.find((x) => x.field === 'date_in')!
    const [out] = applyResolutions([uncertain], questions, [answer(q, '2024-10-21')])
    expect(out.fields.date_in).toBe('2024-10-21')
    expect(out.fields.date_out).toBe(uncertain.fields.date_out)
    expect(out.fields.permit_number).toBe(uncertain.fields.permit_number)
  })

  it('corrects the right field when two columns hold the same value', () => {
    // The reason `Ambiguity.field` exists. Recovering the field by matching the
    // parser's guess against the row's values picks whichever key enumerates first,
    // and silently rewrites the wrong column.
    const twin = row(70, { confidence: 'low', fields: { permit_number: 1, date_in: '2024-10-27', date_out: '2024-10-27' } })
    const qs = generateAmbiguities(spec, [twin])
    const q = qs.find((x) => x.field === 'date_out')!
    const [out] = applyResolutions([twin], qs, [answer(q, '2024-10-29')])
    expect(out.fields.date_out).toBe('2024-10-29')
    expect(out.fields.date_in).toBe('2024-10-27')
  })

  it('promotes a corrected row out of the review queue', () => {
    const q = questions.find((x) => x.field === 'date_in')!
    const [out] = applyResolutions([uncertain], questions, [answer(q, '2024-10-21')])
    expect(out.confidence).toBe('high')
  })

  it('treats a skip as no answer, not as agreement', () => {
    const q = questions[0]
    const skip: Resolution = { ambiguityId: q.id, status: 'resolved_skip', resolvedAt: '2026-01-01T00:00:00.000Z' }
    const [out] = applyResolutions([uncertain], questions, [skip])
    expect(out.fields).toEqual(uncertain.fields)
    expect(out.confidence).toBe('low')
  })

  it('leaves rows nobody asked about untouched', () => {
    const other = row(12)
    const q = questions.find((x) => x.field === 'date_in')!
    const out = applyResolutions([uncertain, other], questions, [answer(q, '2024-10-21')])
    expect(out[1]).toBe(other) // same reference: not rebuilt, not touched
  })
})

describe('safePath', () => {
  const root = process.cwd()

  it('serves a file inside the root', () => {
    expect(safePath('/package.json', root)).toBe(join(root, 'package.json'))
  })

  it('refuses to climb out of the root', () => {
    for (const attempt of [
      '/../../etc/passwd',
      '/../.ssh/id_rsa',
      '/ui/../../../etc/hosts',
      '/./../../etc/passwd',
    ]) {
      expect(safePath(attempt, root), attempt).toBeNull()
    }
  })

  it('decodes before checking, so percent-encoded traversal does not slip past', () => {
    // `%2e%2e%2f` is `../`. A guard that runs before decoding never sees it, and the
    // filesystem decodes it anyway.
    expect(safePath('/%2e%2e%2f%2e%2e%2fetc%2fpasswd', root)).toBeNull()
    expect(safePath('/..%2f..%2fetc%2fpasswd', root)).toBeNull()
  })

  it('rejects a sibling directory whose name merely starts with the root', () => {
    // `startsWith(root)` alone accepts `/repo-backup` when the root is `/repo`.
    expect(safePath('/../' + 'paperparse-backup/secret.txt', root)).toBeNull()
  })

  it('rejects malformed encoding and NUL rather than throwing', () => {
    expect(safePath('/%', root)).toBeNull()
    expect(safePath('/%zz', root)).toBeNull()
  })

  it('returns null for a path inside the root that does not exist', () => {
    expect(safePath('/definitely-not-here.txt', root)).toBeNull()
  })
})
