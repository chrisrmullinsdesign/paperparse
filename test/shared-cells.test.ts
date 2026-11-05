/**
 * Shared-cell routing, replayed against committed Textract runs.
 *
 * The rule was built against the recordings from before the rotation fix, kept in
 * runs/before-rotation-fix/. Those predate the rule, so their review queues are empty,
 * but it reads only what they store — each accepted row's cell boxes — so its effect
 * on them can be computed exactly, without a new recording. This does that, scores
 * the result against the labels, and fails if the README's account disagrees. It also
 * holds the current recordings, made after the fix, to flagging nothing.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { findSharedCells } from '../src/validate/rows.js'
import type { RunRecord } from '../ui/record.js'

const root = process.cwd()
const readme = readFileSync(join(root, 'README.md'), 'utf8')
const index = JSON.parse(readFileSync(join(root, 'runs', 'index.json'), 'utf8')) as Array<{ id: string }>

const BEFORE_FIX = new Set(['skew', 'worst-case'])
const load = (id: string, dir: string) =>
  JSON.parse(readFileSync(join(root, 'runs', dir, `${id}.json`), 'utf8')) as RunRecord

const replay = new Map(
  index.map(({ id }) => {
    const record = load(id, BEFORE_FIX.has(id) ? 'before-rotation-fix' : '')
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
  it('replays the pre-fix recordings, which predate the rule, so nothing was in review', () => {
    for (const id of BEFORE_FIX) expect(replay.get(id)!.record.uncertainRows, id).toEqual([])
  })

  it('flags nothing on any current recording, because nothing is misfiled', () => {
    for (const { id } of index) {
      const record = load(id, '')
      const accepted = [...record.rows, ...record.uncertainRows]
      expect(findSharedCells(accepted).size, id).toBe(0)
      expect(record.uncertainRows, id).toEqual([])
    }
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
