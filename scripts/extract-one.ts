/**
 * Extract one image and print the result.
 *
 *   npm run extract -- path/to/photo.jpg
 *   npm run extract -- photo.jpg --mode sections --json
 */

import { readFile } from 'node:fs/promises'
import { runPipeline, type ReadMode } from '../src/pipeline.js'
import { AnthropicBackend } from '../src/extract/anthropic.js'
import { TextractBackend } from '../src/extract/textract.js'
import { EscalatingBackend } from '../src/extract/escalate.js'
import type { Backend } from '../src/extract/backend.js'
import { generateAmbiguities } from '../src/eval/ambiguity.js'
import { campgroundRosterSpec, campgroundRosterRules } from '../examples/campground-roster/spec.js'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? undefined : process.argv[i + 1]
}

async function main() {
  const path = process.argv[2]
  if (!path || path.startsWith('--')) {
    console.error(
      'Usage: npm run extract -- <image> [--backend anthropic|textract|escalate] [--mode auto|whole|split|sections] [--json]',
    )
    process.exitCode = 1
    return
  }

  const which = arg('backend') ?? 'anthropic'
  const backend: Backend =
    which === 'textract'
      ? new TextractBackend()
      : which === 'escalate'
        ? new EscalatingBackend(new TextractBackend(), new AnthropicBackend())
        : new AnthropicBackend()

  if (!backend.isAvailable()) {
    console.error(`No credentials found for the "${which}" backend.`)
    process.exitCode = 1
    return
  }

  const image = await readFile(path)
  const result = await runPipeline(image, campgroundRosterSpec, backend, {
    readMode: (arg('mode') as ReadMode) ?? 'auto',
    rules: campgroundRosterRules,
    sectionConcurrency: 4,
    onProgress: (done, total) => process.stderr.write(`\r  section ${done}/${total}`),
  })
  process.stderr.write('\n')

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(result, null, 2))
    return
  }

  const { stats } = result
  console.log(`\nBackend:   ${result.meta.backend}  (${result.usage.requests} request${result.usage.requests === 1 ? '' : 's'})`)
  console.log(
    `Read mode: ${result.meta.sectionParse ? `sections (${result.meta.sectionChunkCount} chunks)` : result.meta.splitParse ? 'split' : 'whole'}`,
  )
  if (result.yearCorrection) {
    console.log(`Year correction: ${result.yearCorrection.from} → ${result.yearCorrection.to}`)
  }
  console.log(`Rows: ${stats.rawRowCount} returned, ${stats.acceptedRowCount} accepted, ${stats.droppedRowCount} dropped`)

  if (stats.droppedRowCount > 0) {
    console.log('\nDropped:')
    for (const d of stats.drops) console.log(`  row ${d.rowKey}: ${d.reason}${d.detail ? ` (${d.detail})` : ''}`)
  }

  console.log(`\nConfident (${result.rows.length}):`)
  for (const row of result.rows) {
    console.log(`  ${String(row.rowKey).padStart(3)}  ${Object.entries(row.fields).map(([k, v]) => `${k}=${v}`).join('  ')}`)
  }

  if (result.uncertainRows.length > 0) {
    console.log(`\nNeeds review (${result.uncertainRows.length}):`)
    for (const row of result.uncertainRows) {
      console.log(`  ${String(row.rowKey).padStart(3)}  ${Object.entries(row.fields).map(([k, v]) => `${k}=${v}`).join('  ')}`)
    }

    const questions = generateAmbiguities(campgroundRosterSpec, result.uncertainRows)
    if (questions.length > 0) {
      console.log(`\nReview queue (${questions.length} questions):`)
      for (const q of questions.slice(0, 10)) {
        console.log(`  ${q.reason} — ${q.candidates.map((c) => c.label).join(' | ')}`)
      }
    }
  }

  if (result.raw.notes) console.log(`\nModel notes: ${result.raw.notes}`)
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exitCode = 1
})
