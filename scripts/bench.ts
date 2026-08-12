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
import { runBenchmark, formatBenchmarkTable, costOf, OPUS_5_PRICING, type BenchConfig, type GoldSample } from '../src/eval/benchmark.js'
import { AnthropicBackend, type Effort } from '../src/extract/anthropic.js'
import { TextractBackend } from '../src/extract/textract.js'
import { EscalatingBackend } from '../src/extract/escalate.js'
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
  console.log(`Modes:  ${modes.join(', ')}   Effort: ${effort}`)
  if (!new TextractBackend().isAvailable()) {
    console.log('Textract: no AWS credentials found — skipping the geometric backend.')
  }
  console.log()

  const configs: BenchConfig[] = modes.map((readMode) => ({
    label: `${backend.name} / ${readMode}`,
    backend,
    readMode,
    pipelineOptions: { rules: campgroundRosterRules, sectionConcurrency: 4 },
  }))

  // The geometric backend and the escalation pairing are included whenever AWS
  // credentials look present — they are first-class here, not an add-on. Both read
  // the page whole; sectioning is a vision-model workaround and means nothing to
  // Textract. Pass --no-textract to skip them.
  const textractCandidate = new TextractBackend()
  if (!process.argv.includes('--no-textract') && textractCandidate.isAvailable()) {
    const textract = textractCandidate
    configs.push({
      label: 'textract / whole',
      backend: textract,
      readMode: 'whole',
      pipelineOptions: { rules: campgroundRosterRules },
    })
    configs.push({
      label: 'textract->anthropic / escalate',
      backend: new EscalatingBackend(textract, backend),
      readMode: 'whole',
      pipelineOptions: { rules: campgroundRosterRules },
    })
  }

  const outcomes = await runBenchmark(campgroundRosterSpec, samples, configs, (msg) =>
    process.stderr.write(`  ${msg}\n`),
  )

  console.log(`\n${formatBenchmarkTable(outcomes)}\n`)

  const grandTotal = outcomes.reduce((sum, o) => sum + costOf(o.usage, OPUS_5_PRICING), 0)
  const totalRequests = outcomes.reduce((sum, o) => sum + o.usage.requests, 0)
  console.log(`Run total: ${totalRequests} requests, $${grandTotal.toFixed(2)} at Opus 5 list rates.\n`)

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
