/**
 * Shared-cell routing, replayed against the committed Textract runs.
 *
 * The runs were recorded before this rule existed, so their review queues are empty.
 * But the rule reads only what the runs already store — each accepted row's cell
 * boxes — so its effect on them can be computed exactly, without a new recording.
 * This does that, scores the result against the labels, and fails if the README's
 * account of it disagrees.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { findSharedCells } from '../src/validate/rows.js'
import type { RunRecord } from '../ui/record.js'

const root = process.cwd()
const readme = readFileSync(join(root, 'README.md'), 'utf8')
const index = JSON.parse(readFileSync(join(root, 'runs', 'index.json'), 'utf8')) as Array<{ id: string }>

const replay = new Map(
  index.map(({ id }) => {
    const record = JSON.parse(readFileSync(join(root, 'runs', `${id}.json`), 'utf8')) as RunRecord
    const gold = new Map(record.gold!.rows.map((g) => [g.rowKey, JSON.stringify(g.fields)]))
    const accepted = [...record.rows, ...record.uncertainRows]
    const flagged = findSharedCells(accepted)
    const wrong = new Set(
      accepted.flatMap((row, i) => (gold.get(row.rowKey) === JSON.stringify(row.fields) ? [] : [i])),
    )
    const wrongFlagged = [...wrong].filter((i) => flagged.has(i)).length
    return [
      id,
      {
        record,
        accepted: accepted.length,
        wrong: wrong.size,
        flagged: flagged.size,
        wrongFlagged,
        rightFlagged: flagged.size - wrongFlagged,
        // What still reaches the output unflagged and wrong: the silent errors.
        silent: wrong.size - wrongFlagged,
      },
    ] as const
  }),
)

describe('shared-cell routing on the committed runs', () => {
  it('were recorded before the rule, with nothing in review', () => {
    for (const [id, { record }] of replay) expect(record.uncertainRows, id).toEqual([])
  })

  it('implicates nothing on a sheet the parser read correctly', () => {
    for (const id of ['clean', 'sparse', 'full', 'glare', 'blur', 'lowlight-shadow', 'cropped-edge']) {
      const run = replay.get(id)!
      expect(run.wrong, `${id} has no wrong rows to find`).toBe(0)
      expect(run.flagged, `${id} false flags`).toBe(0)
    }
  })

  it('finds most of the rows rotation misfiled', () => {
    expect(replay.get('skew')).toMatchObject({ accepted: 45, wrong: 12, flagged: 17, wrongFlagged: 11, silent: 1 })
    expect(replay.get('worst-case')).toMatchObject({ accepted: 45, wrong: 11, flagged: 13, wrongFlagged: 9, silent: 2 })
  })

  it('is described in the README by the figures it produces', () => {
    for (const id of ['skew', 'worst-case']) {
      const r = replay.get(id)!
      expect(readme).toContain(
        `| \`${id}\` | ${r.wrong} of ${r.accepted} | ${r.flagged} | ${r.wrongFlagged} of ${r.wrong} | ${r.rightFlagged} | ${r.silent} |`,
      )
    }
  })
})
