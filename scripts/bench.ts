/**
 * Run the benchmark over the synthetic corpus.
 *
 *   npm run fixtures            # once, to generate the corpus
 *   npm run bench               # all read modes
 *   npm run bench -- --modes sections --effort high
 *
 * Costs real API calls: roughly (samples × chunks) requests in `sections` mode. Start
 * with `--limit 2` to see the shape before running the full corpus.
 */

import { readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runBenchmark, formatBenchmarkTable, type BenchConfig, type GoldSample } from '../src/eval/benchmark.js'
import { AnthropicBackend, type Effort } from '../src/extract/anthropic.js'
import { campgroundRosterSpec, campgroundRosterRules } from '../examples/campground-roster/spec.js'
import type { ReadMode } from '../src/pipeline.js'

const here = dirname(fileURLToPath(import.meta.url))
const fixturesDir = join(here, '..', 'fixtures', 'out')

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? undefined : process.argv[i + 1]
}

async function loadCorpus(limit?: number): Promise<GoldSample[]> {
  let manifest: Array<{ id: string; image: string }>
  try {
    manifest = JSON.parse(await readFile(join(fixturesDir, 'manifest.json'), 'utf8'))
  } catch {
    throw new Error('No fixtures found. Run `npm run fixtures` first.')
  }

  const selected = limit ? manifest.slice(0, limit) : manifest
  return Promise.all(
    selected.map(async ({ id, image }) => ({
      id,
      image: await readFile(join(fixturesDir, image)),
      rows: JSON.parse(await readFile(join(fixturesDir, `${id}.gold.json`), 'utf8')).rows,
    })),
  )
}

async function main() {
  const limit = arg('limit') ? parseInt(arg('limit')!, 10) : undefined
  const effort = (arg('effort') as Effort | undefined) ?? 'high'
  const modes = (arg('modes')?.split(',') as ReadMode[] | undefined) ?? ['whole', 'split', 'sections']

  const backend = new AnthropicBackend({ effort })
  if (!backend.isAvailable()) {
    // An `ant auth login` profile also works, so this is a warning rather than a stop.
    console.warn('Warning: no ANTHROPIC_API_KEY in the environment. Relying on an ant auth profile.\n')
  }

  const samples = await loadCorpus(limit)
  console.log(`Corpus: ${samples.length} samples, ${samples.reduce((n, s) => n + s.rows.length, 0)} gold rows`)
  console.log(`Modes:  ${modes.join(', ')}   Effort: ${effort}\n`)

  const configs: BenchConfig[] = modes.map((readMode) => ({
    label: `${backend.name} / ${readMode}`,
    backend,
    readMode,
    pipelineOptions: { rules: campgroundRosterRules, sectionConcurrency: 4 },
  }))

  const outcomes = await runBenchmark(campgroundRosterSpec, samples, configs, (msg) =>
    process.stderr.write(`  ${msg}\n`),
  )

  console.log(`\n${formatBenchmarkTable(outcomes)}\n`)

  for (const outcome of outcomes) {
    const worstFields = Object.entries(
      outcome.samples.reduce<Record<string, number>>((acc, s) => {
        for (const [f, n] of Object.entries(s.fields.errorsByField)) acc[f] = (acc[f] ?? 0) + n
        return acc
      }, {}),
    ).sort((a, b) => b[1] - a[1])

    if (worstFields.length > 0) {
      console.log(`${outcome.label} — field errors: ${worstFields.map(([f, n]) => `${f}=${n}`).join(', ')}`)
    }
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exitCode = 1
})
