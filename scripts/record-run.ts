/**
 * Record a real extraction run to `runs/`, so it can be inspected later without
 * spending the request again.
 *
 *   npm run record -- --backend textract              # the whole corpus
 *   npm run record -- --backend textract --only clean,glare
 *
 * Three things fall out of having the artifact:
 *
 *  - The UI works with no credentials and no install, because it reads these files
 *    rather than calling a backend.
 *  - A run is diffable against the one before it, so a change that quietly costs
 *    four rows shows up in review instead of in the next benchmark.
 *  - The numbers in the README stop being a thing you have to take on trust.
 *
 * There is deliberately no offline or simulated mode. A fabricated run in a repo
 * whose argument is that measurement beats assertion would undo the argument.
 */

import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runPipeline, type ReadMode, type StageEvent } from '../src/pipeline.js'
import { AnthropicBackend } from '../src/extract/anthropic.js'
import { TextractBackend } from '../src/extract/textract.js'
import { EscalatingBackend } from '../src/extract/escalate.js'
import { buildRunRecord, type Gold } from '../ui/record.js'
import type { Backend } from '../src/extract/backend.js'
import { campgroundRosterSpec, campgroundRosterRules } from '../examples/campground-roster/spec.js'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const fixturesDir = join(root, 'fixtures', 'out')
const runsDir = join(root, 'runs')

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? undefined : process.argv[i + 1]
}

function makeBackend(which: string): Backend {
  switch (which) {
    case 'textract':
      return new TextractBackend()
    case 'escalate':
      return new EscalatingBackend(new TextractBackend(), new AnthropicBackend())
    case 'anthropic':
      return new AnthropicBackend()
    default:
      throw new Error(`Unknown backend "${which}" — expected anthropic, textract or escalate.`)
  }
}

async function main() {
  const which = arg('backend') ?? 'textract'
  const readMode = (arg('mode') as ReadMode) ?? 'auto'
  const backend = makeBackend(which)

  if (!backend.isAvailable()) {
    console.error(`No credentials found for the "${which}" backend. Nothing recorded.`)
    process.exitCode = 1
    return
  }

  if (!existsSync(join(fixturesDir, 'manifest.json'))) {
    console.error('No fixtures found. Run `npm run fixtures` first.')
    process.exitCode = 1
    return
  }

  const manifest: Array<{ id: string; image: string }> = JSON.parse(
    await readFile(join(fixturesDir, 'manifest.json'), 'utf8'),
  )
  const only = arg('only')?.split(',').map((s) => s.trim())
  const targets = only ? manifest.filter((m) => only.includes(m.id)) : manifest

  if (targets.length === 0) {
    console.error(`No fixtures matched --only ${arg('only')}.`)
    process.exitCode = 1
    return
  }

  await mkdir(runsDir, { recursive: true })
  const index: Array<Record<string, unknown>> = []

  for (const entry of targets) {
    const image = await readFile(join(fixturesDir, entry.image))
    const gold = JSON.parse(await readFile(join(fixturesDir, `${entry.id}.gold.json`), 'utf8')) as Gold

    const stages: StageEvent[] = []
    const startedAt = Date.now()
    const result = await runPipeline(image, campgroundRosterSpec, backend, {
      readMode,
      rules: campgroundRosterRules,
      sectionConcurrency: 4,
      onStage: (event) => {
        stages.push(event)
        if (event.status === 'done') process.stderr.write(`  ${entry.id}: ${event.stage} — ${event.detail ?? ''}\n`)
      },
    })
    const elapsedMs = Date.now() - startedAt

    // Scored against the generator's own labels, with the same arithmetic the
    // benchmark uses — so a number read off the UI and a number read off the
    // benchmark table mean the same thing.
    const record = buildRunRecord({
      id: entry.id,
      spec: campgroundRosterSpec,
      result,
      stages,
      elapsedMs,
      readMode,
      backendName: which,
      gold,
      image: entry.image,
    })

    await copyFile(join(fixturesDir, entry.image), join(runsDir, entry.image))
    await writeFile(join(runsDir, `${entry.id}.json`), JSON.stringify(record, null, 2))

    index.push({
      id: entry.id,
      image: entry.image,
      backend: result.meta.backend,
      readMode,
      accepted: result.rows.length,
      uncertain: result.uncertainRows.length,
      dropped: result.stats.droppedRowCount,
      goldRows: gold.rows.length,
      elapsedMs,
      recordedAt: record.recordedAt,
    })

    console.log(
      `${entry.id.padEnd(18)} ${String(result.rows.length).padStart(3)} accepted  ` +
        `${String(result.uncertainRows.length).padStart(2)} review  ` +
        `${String(result.stats.droppedRowCount).padStart(2)} dropped  ` +
        `${(elapsedMs / 1000).toFixed(1)}s`,
    )
  }

  await writeFile(join(runsDir, 'index.json'), JSON.stringify(index, null, 2))
  console.log(`\n${index.length} run(s) written to runs/`)
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
