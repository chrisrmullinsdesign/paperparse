/**
 * Apply a reviewer's answers to a recorded run, and report what they bought.
 *
 *   npm run review -- clean
 *
 * This is the end of the loop. `npm run record` produces a run, the viewer turns its
 * uncertain rows into questions, a human answers them, and this folds the answers
 * back into the rows and rescores.
 *
 * The rescoring is the point. "A human reviewed it" is unfalsifiable; "review moved
 * row recall from 93.4% to 95.1% and cleared six rows out of the queue" is a number,
 * computed with the same `multisetDiff` the benchmark uses, and it can be wrong.
 */

import { readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { applyResolutions } from '../src/eval/ambiguity.js'
import { multisetDiff, fieldAccuracy, rowKeySignature } from '../src/eval/diff.js'
import type { RunRecord } from '../ui/record.js'
import type { Resolution, ValidatedRow } from '../src/types.js'

const here = dirname(fileURLToPath(import.meta.url))
const runsDir = join(here, '..', 'runs')

function pct(x: number): string {
  return Number.isFinite(x) ? `${(x * 100).toFixed(1)}%` : '—'
}

function arrow(before: number, after: number): string {
  const a = pct(before)
  const b = pct(after)
  if (a === b) return `${a} (unchanged)`
  return `${a} → ${b}`
}

async function main() {
  const id = process.argv[2]
  if (!id || id.startsWith('--')) {
    console.error('Usage: npm run review -- <run-id>')
    process.exitCode = 1
    return
  }

  const runPath = join(runsDir, `${id}.json`)
  const reviewPath = join(runsDir, `${id}.review.json`)

  if (!existsSync(runPath)) {
    console.error(`No run "${id}". Record one with \`npm run record\`.`)
    process.exitCode = 1
    return
  }
  if (!existsSync(reviewPath)) {
    console.error(`No answers for "${id}" yet. Work the queue in \`npm run ui\` first.`)
    process.exitCode = 1
    return
  }

  const run: RunRecord = JSON.parse(await readFile(runPath, 'utf8'))
  const { resolutions }: { resolutions: Resolution[] } = JSON.parse(await readFile(reviewPath, 'utf8'))

  const before: ValidatedRow[] = [...run.rows, ...run.uncertainRows]
  const after = applyResolutions(before, run.ambiguities, resolutions)

  const changed = after.filter((row, i) => row !== before[i])
  const answered = resolutions.filter((r) => r.status === 'resolved_choice').length
  const skipped = resolutions.filter((r) => r.status === 'resolved_skip').length

  console.log(`\n${id} — ${resolutions.length} of ${run.ambiguities.length} questions answered`)
  console.log(`  ${answered} corrected, ${skipped} skipped, ${changed.length} rows changed`)
  console.log(`  review queue: ${run.uncertainRows.length} → ${after.filter((r) => r.confidence === 'low').length}`)

  if (!run.gold) {
    console.log('\nNo labels for this image, so the effect on accuracy is unmeasured.')
  } else {
    const gold = run.gold.rows
    const b = {
      key: multisetDiff(before, gold, rowKeySignature),
      exact: multisetDiff(before, gold),
      fields: fieldAccuracy(before, gold),
    }
    const a = {
      key: multisetDiff(after, gold, rowKeySignature),
      exact: multisetDiff(after, gold),
      fields: fieldAccuracy(after, gold),
    }
    console.log('\nScored against the generator\'s labels:')
    console.log(`  row recall      ${arrow(b.key.matched / b.key.goldCount, a.key.matched / a.key.goldCount)}`)
    console.log(`  exact match     ${arrow(b.exact.matched / b.exact.goldCount, a.exact.matched / a.exact.goldCount)}`)
    console.log(
      `  field accuracy  ${arrow(b.fields.correctFields / b.fields.comparedFields, a.fields.correctFields / a.fields.comparedFields)}`,
    )

    // Review can make things worse. A reviewer reading a blurred cell is a better
    // source than the model, not an infallible one, and a run that only ever
    // reports improvement is not measuring anything.
    if (a.fields.correctFields < b.fields.correctFields) {
      console.log('\n  Field accuracy fell. The answers disagreed with the labels:')
      for (const e of a.fields.examples.slice(0, 5)) {
        console.log(`    row ${e.rowKey} ${e.field}: answered ${e.got}, labelled ${e.expected}`)
      }
    }
  }

  const outPath = join(runsDir, `${id}.corrected.json`)
  await writeFile(outPath, JSON.stringify({ id, rows: after, appliedAt: new Date().toISOString() }, null, 2))
  console.log(`\nCorrected rows → runs/${id}.corrected.json\n`)
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
