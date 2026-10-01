/**
 * README tests — the Textract figures the README quotes, recomputed from `runs/`.
 *
 * The README has gone stale three times, each time by quoting a number that was true
 * when it was written and stopped being true when the corpus or the default changed.
 * Nothing about prose stops that. This rescoring does: it reads the committed run
 * records, scores their rows against their labels with the same functions the
 * benchmark uses, and fails when a figure in the README disagrees.
 *
 * Only the Textract figures are covered, because only Textract runs are committed.
 * The Claude rows in the README are not checkable from this repository, and the
 * README says so.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { multisetDiff, fieldAccuracy, rowKeySignature } from '../src/eval/diff.js'
import { prf, microAverage, formatPct } from '../src/eval/metrics.js'
import type { RunRecord } from '../ui/record.js'

const root = process.cwd()
const readme = readFileSync(join(root, 'README.md'), 'utf8')
const index = JSON.parse(readFileSync(join(root, 'runs', 'index.json'), 'utf8')) as Array<{ id: string }>

const runs = index.map(({ id }) => {
  const record = JSON.parse(readFileSync(join(root, 'runs', `${id}.json`), 'utf8')) as RunRecord
  const gold = record.gold!.rows
  const parsed = [...record.rows, ...record.uncertainRows]
  return {
    id,
    record,
    key: multisetDiff(parsed, gold, rowKeySignature),
    exact: multisetDiff(parsed, gold),
    fields: fieldAccuracy(parsed, gold),
  }
})

const byId = new Map(runs.map((r) => [r.id, r]))

/** The cells of the one table row whose first cell starts with `label`. */
function tableRow(label: string): string[] {
  const rows = readme.split('\n').filter((line) => line.startsWith(`| ${label}`))
  expect(rows, `README table row "${label}"`).toHaveLength(1)
  return rows[0].split('|').slice(1, -1).map((cell) => cell.trim().replace(/\*\*/g, ''))
}

describe('recorded runs', () => {
  it('are all Textract runs, which is why only Textract figures are checked here', () => {
    expect(runs).toHaveLength(9)
    for (const run of runs) expect(run.record.meta.backend, run.id).toBe('textract')
  })

  it('carry the scores their own rows and labels produce', () => {
    for (const run of runs) {
      expect(run.record.score!.keyDiff, run.id).toEqual(run.key)
      expect(run.record.score!.exactDiff, run.id).toEqual(run.exact)
      expect(run.record.score!.fields.correctFields, run.id).toBe(run.fields.correctFields)
      expect(run.record.score!.fields.comparedFields, run.id).toBe(run.fields.comparedFields)
    }
  })
})

describe('README figures, against runs/', () => {
  const key = microAverage(runs.map((r) => r.key))
  const exact = microAverage(runs.map((r) => r.exact))
  const compared = runs.reduce((sum, r) => sum + r.fields.comparedFields, 0)
  const correct = runs.reduce((sum, r) => sum + r.fields.correctFields, 0)
  const fieldPct = formatPct(correct / compared)
  const goldRows = runs.reduce((sum, r) => sum + r.key.goldCount, 0)
  const avgSeconds = `${(Math.round(runs.reduce((sum, r) => sum + r.record.elapsedMs, 0) / runs.length) / 1000).toFixed(1)}s`

  it('states the size of the corpus the runs were recorded on', () => {
    expect(readme).toContain(`${goldRows} gold rows`)
    expect(tableRow('textract / whole')[0]).toContain(`${goldRows} rows`)
  })

  it('quotes the pooled Textract row of the benchmark table', () => {
    const cells = tableRow('textract / whole')
    expect(cells.slice(1, 5)).toEqual([formatPct(key.recall), formatPct(key.precision), formatPct(exact.f1), fieldPct])
    expect(cells[7]).toBe(avgSeconds)
  })

  it('quotes the same figures in the summary table at the top', () => {
    const summary = tableRow('**Textract** |')[2]
    expect(summary).toContain(`${formatPct(key.recall)} row recall`)
    expect(summary).toContain(`${fieldPct} field accuracy`)
    expect(summary).toContain(avgSeconds)
  })

  it('quotes each fixture of the degradation table', () => {
    const clean = prf(byId.get('clean')!.key).recall!
    for (const id of ['clean', 'glare', 'blur', 'lowlight-shadow', 'skew', 'worst-case', 'cropped-edge']) {
      const run = byId.get(id)!
      const cells = tableRow(`${id} |`)
      const recall = prf(run.key).recall!
      expect(cells[2], `${id} recall`).toBe(formatPct(recall))
      if (id !== 'clean') {
        const delta = (recall - clean) * 100
        expect(cells[3].replace('−', '-'), `${id} vs. clean`).toBe(`${delta < 0 ? '-' : '+'}${Math.abs(delta).toFixed(1)}`)
      }
      expect(cells[4], `${id} precision`).toBe(formatPct(prf(run.key).precision))
      expect(cells[5], `${id} exact`).toBe(`${run.exact.matched} of ${run.exact.predictedCount}`)
    }
  })

  it('describes the skew run the way the viewer shows it', () => {
    const { record, key: diff, fields } = byId.get('skew')!
    const returned = new Set([...record.rows, ...record.uncertainRows].map((r) => r.rowKey))
    const dropped = new Set(record.stats.drops.map((d) => Number(d.rowKey)))
    const never = record.gold!.rows.filter((g) => !returned.has(g.rowKey) && !dropped.has(g.rowKey)).length

    expect(readme).toContain(
      `${record.rows.length} accepted, ${record.uncertainRows.length} review, ${record.stats.droppedRowCount} dropped, ` +
        `${never} never returned, ${formatPct(prf(diff).recall)} row recall and ` +
        `${formatPct(fields.correctFields / fields.comparedFields)} field accuracy`,
    )
    expect(readme).toContain(
      `Rows: ${record.stats.rawRowCount} returned, ${record.stats.acceptedRowCount} accepted, ${record.stats.droppedRowCount} dropped`,
    )
  })

  it('names the one row the undamaged sheets never return', () => {
    for (const id of ['clean', 'glare', 'blur', 'lowlight-shadow', 'full']) {
      const { record } = byId.get(id)!
      const returned = new Set([...record.rows, ...record.uncertainRows].map((r) => r.rowKey))
      expect(record.gold!.rows.map((g) => g.rowKey).filter((k) => !returned.has(k)), id).toEqual([100])
    }
    expect(readme).toContain('always row 100')
  })
})
