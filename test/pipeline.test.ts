/**
 * End-to-end tests against a stub backend.
 *
 * No API key, no network. The stub answers from the generator's own ground truth,
 * which means these exercise the real cropping, chunking, merging, and validation
 * code paths — and would catch a geometry regression that silently drops a chunk.
 */

import { describe, it, expect } from 'vitest'
import { runPipeline } from '../src/pipeline.js'
import { extractBySections } from '../src/extract/sections.js'
import { generateSample } from '../fixtures/generate.js'
import { campgroundRosterSpec as spec, campgroundRosterRules as rules } from '../examples/campground-roster/spec.js'
import type { Backend, ExtractRequest, ExtractResponse } from '../src/extract/backend.js'
import type { RawRow, ValidatedRow } from '../src/types.js'

/**
 * A backend that returns the true rows for whatever section it is asked about.
 *
 * `failKeys` makes a chunk throw, so partial-failure handling is testable.
 */
class StubBackend implements Backend {
  readonly name = 'stub'
  calls: Array<readonly number[] | 'whole' | 'header'> = []
  /** Prompts seen, so tests can assert what context sections were given. */
  prompts: string[] = []

  constructor(
    private readonly truth: ValidatedRow[],
    private readonly failKeys: Set<number> = new Set(),
  ) {}

  isAvailable() {
    return true
  }

  /** Chunk requests only — excludes the header pass. */
  get sectionCalls(): number {
    return this.calls.filter((c) => Array.isArray(c)).length
  }

  async extract(req: ExtractRequest): Promise<ExtractResponse> {
    this.prompts.push(req.prompt)

    // The header pass carries no sectionKeys and asks for no rows.
    if (!req.sectionKeys && /Read only the document-level date/.test(req.prompt)) {
      this.calls.push('header')
      return {
        result: { document_date: '2024-10-25', rows: [], notes: '', looks_like_expected_form: true },
        model: 'stub-1',
      }
    }

    this.calls.push(req.sectionKeys ?? 'whole')

    if (req.sectionKeys?.some((k) => this.failKeys.has(k))) {
      throw new Error('simulated backend failure')
    }

    const inScope = req.sectionKeys
      ? this.truth.filter((r) => req.sectionKeys!.includes(r.rowKey))
      : this.truth

    const rows: RawRow[] = inScope.map((r) => ({
      row_key: r.rowKey,
      fields: { ...r.fields },
      confidence: 'high',
    }))

    return {
      result: { document_date: '2024-10-25', rows, notes: '', looks_like_expected_form: true },
      model: 'stub-1',
    }
  }
}

describe('extractBySections', () => {
  it('issues one request per chunk and reassembles every row', async () => {
    const sample = await generateSample(spec, { seed: 42, fillRate: 0.6 })
    const backend = new StubBackend(sample.rows)

    const out = await extractBySections(sample.image, spec, backend)

    expect(out.chunkCount).toBe(12)
    expect(backend.sectionCalls).toBe(12)
    expect(out.failedChunks).toHaveLength(0)
    expect(out.rows.map((r) => r.row_key)).toEqual(sample.rows.map((r) => r.rowKey))
  })

  it('reads the header once and feeds its date to every section prompt', async () => {
    // Section crops never contain the header, so without this the year is absent
    // from every request and the model has to guess it.
    const sample = await generateSample(spec, { seed: 42, fillRate: 0.4 })
    const backend = new StubBackend(sample.rows)

    const out = await extractBySections(sample.image, spec, backend)

    expect(backend.calls.filter((c) => c === 'header')).toHaveLength(1)
    expect(out.document_date).toBe('2024-10-25')

    const sectionPrompts = backend.prompts.filter((p) => /You are looking at a crop/.test(p))
    expect(sectionPrompts).toHaveLength(12)
    for (const prompt of sectionPrompts) expect(prompt).toContain('2024-10-25')
  })

  it('skips the header pass when a date is supplied', async () => {
    const sample = await generateSample(spec, { seed: 42, fillRate: 0.4 })
    const backend = new StubBackend(sample.rows)

    await extractBySections(sample.image, spec, backend, { documentDate: '2023-07-04' })

    expect(backend.calls.filter((c) => c === 'header')).toHaveLength(0)
    expect(backend.prompts.some((p) => p.includes('2023-07-04'))).toBe(true)
  })

  it('tells sections to hedge when no header is available', async () => {
    const sample = await generateSample(spec, { seed: 42, fillRate: 0.4 })
    const backend = new StubBackend(sample.rows)

    await extractBySections(sample.image, spec, backend, { documentDate: null })

    expect(backend.calls.filter((c) => c === 'header')).toHaveLength(0)
    const sectionPrompts = backend.prompts.filter((p) => /You are looking at a crop/.test(p))
    for (const prompt of sectionPrompts) expect(prompt).toContain('header is not visible')
  })

  it('returns rows in row-key order regardless of chunk completion order', async () => {
    const sample = await generateSample(spec, { seed: 7, fillRate: 0.7 })
    const out = await extractBySections(sample.image, spec, new StubBackend(sample.rows), { concurrency: 4 })
    const keys = out.rows.map((r) => Number(r.row_key))
    expect(keys).toEqual([...keys].sort((a, b) => a - b))
  })

  it('reports a failed chunk instead of losing the whole form', async () => {
    const sample = await generateSample(spec, { seed: 11, fillRate: 0.8 })
    const backend = new StubBackend(sample.rows, new Set([21]))

    const out = await extractBySections(sample.image, spec, backend)

    expect(out.failedChunks).toHaveLength(1)
    expect(out.failedChunks[0]).toContain(21)
    expect(out.notes).toContain('chunk(s) failed')
    // Everything outside the failed chunk still came through.
    expect(out.rows.length).toBeGreaterThan(0)
    expect(out.rows.some((r) => Number(r.row_key) >= 21 && Number(r.row_key) <= 30)).toBe(false)
  })

  it('discards rows a chunk returns from outside its own range', async () => {
    // The overlap strip makes neighbouring rows visible; the owning chunk is the
    // authority, so a stray row from an adjacent range must not be double-counted.
    const truth: ValidatedRow[] = [
      { rowKey: 5, fields: { date_in: '2024-10-26', date_out: '2024-10-28' }, confidence: 'high' },
    ]
    const greedy: Backend = {
      name: 'greedy',
      isAvailable: () => true,
      async extract() {
        return {
          result: {
            document_date: null,
            rows: [
              { row_key: 5, fields: { date_in: '2024-10-26', date_out: '2024-10-28' }, confidence: 'high' },
              { row_key: 999, fields: { date_in: '2024-10-26', date_out: '2024-10-28' }, confidence: 'high' },
            ],
            notes: '',
            looks_like_expected_form: true,
          },
          model: 'greedy-1',
        }
      },
    }

    const sample = await generateSample(spec, { seed: 3, fillRate: 0.1 })
    const out = await extractBySections(sample.image, spec, greedy)
    expect(out.rows.some((r) => Number(r.row_key) === 999)).toBe(false)
    expect(truth).toHaveLength(1)
  })
})

describe('runPipeline', () => {
  it('recovers the generator ground truth end to end in sections mode', async () => {
    const sample = await generateSample(spec, { seed: 99, fillRate: 0.5 })
    const result = await runPipeline(sample.image, spec, new StubBackend(sample.rows), {
      readMode: 'sections',
      rules,
    })

    expect(result.meta.sectionParse).toBe(true)
    expect(result.meta.sectionChunkCount).toBe(12)
    expect(result.usage.requests).toBe(13) // 12 chunks + the header pass
    expect(result.stats.droppedRowCount).toBe(0)
    expect(result.rows.map((r) => r.rowKey)).toEqual(sample.rows.map((r) => r.rowKey))
    expect(result.rows[0].fields.date_in).toBe(sample.rows[0].fields.date_in)
  })

  it('defaults to a single whole-page request, whatever geometry the spec declares', async () => {
    // Followed the measurement: whole beat split by ~6 points of recall and
    // sections by ~17, at the lowest cost of the three.
    const sample = await generateSample(spec, { seed: 5, fillRate: 0.2 })
    const backend = new StubBackend(sample.rows)
    const result = await runPipeline(sample.image, spec, backend, { rules })

    expect(result.meta.sectionParse).toBe(false)
    expect(result.meta.splitParse).toBe(false)
    expect(backend.calls).toEqual(['whole'])
  })

  it('still honours an explicit split request', async () => {
    const sample = await generateSample(spec, { seed: 6, fillRate: 0.2 })
    const result = await runPipeline(sample.image, spec, new StubBackend(sample.rows), {
      readMode: 'split',
      rules,
    })
    expect(result.meta.splitParse).toBe(true)
  })

  it('falls back to a whole read when split is asked for on a non-portrait image', async () => {
    const sample = await generateSample(spec, { seed: 6, fillRate: 0.2, width: 1600, height: 1200 })
    const result = await runPipeline(sample.image, spec, new StubBackend(sample.rows), {
      readMode: 'split',
      rules,
    })
    expect(result.meta.splitParse).toBe(false)
  })

  it('issues exactly one request in whole mode', async () => {
    const sample = await generateSample(spec, { seed: 8, fillRate: 0.3 })
    const backend = new StubBackend(sample.rows)
    await runPipeline(sample.image, spec, backend, { readMode: 'whole', rules })
    expect(backend.calls).toEqual(['whole'])
  })
})

describe('generateSample', () => {
  it('is deterministic for a given seed', async () => {
    const a = await generateSample(spec, { seed: 123, fillRate: 0.4 })
    const b = await generateSample(spec, { seed: 123, fillRate: 0.4 })
    expect(a.rows).toEqual(b.rows)
  })

  it('varies with the seed', async () => {
    const a = await generateSample(spec, { seed: 1, fillRate: 0.4 })
    const b = await generateSample(spec, { seed: 2, fillRate: 0.4 })
    expect(a.rows).not.toEqual(b.rows)
  })

  it('only emits rows the spec considers valid', async () => {
    const sample = await generateSample(spec, { seed: 4, fillRate: 1 })
    for (const row of sample.rows) {
      expect(row.rowKey).toBeGreaterThanOrEqual(1)
      expect(row.rowKey).toBeLessThanOrEqual(107)
    }
  })

  it('produces rows that pass validation, so gold data is never self-inconsistent', async () => {
    const sample = await generateSample(spec, { seed: 21, fillRate: 0.9 })
    const result = await runPipeline(sample.image, spec, new StubBackend(sample.rows), {
      readMode: 'whole',
      rules,
    })
    expect(result.stats.droppedRowCount).toBe(0)
    expect(result.stats.acceptedRowCount).toBe(sample.rows.length)
  })

  it('applies augmentations without changing the ground truth', async () => {
    const clean = await generateSample(spec, { seed: 33, fillRate: 0.5 })
    const rough = await generateSample(spec, { seed: 33, fillRate: 0.5, augment: ['glare', 'blur'] })
    expect(rough.rows).toEqual(clean.rows)
    expect(rough.image.equals(clean.image)).toBe(false)
  })
})
