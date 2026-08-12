/**
 * Write the standard synthetic corpus to `fixtures/out/`.
 *
 *   npm run fixtures
 *
 * Output is seeded, so re-running overwrites with identical row data. Needs no API
 * key — this is pure rendering.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import { generateSample, STANDARD_CORPUS } from '../fixtures/generate.js'
import { campgroundRosterSpec } from '../examples/campground-roster/spec.js'

const here = dirname(fileURLToPath(import.meta.url))
const outDir = join(here, '..', 'fixtures', 'out')

async function main() {
  await mkdir(outDir, { recursive: true })

  const manifest: Array<{ id: string; image: string; rowCount: number; documentDate: string }> = []

  for (const { id, opts } of STANDARD_CORPUS) {
    const sample = await generateSample(campgroundRosterSpec, opts)
    const imageName = `${id}.jpg`

    await writeFile(join(outDir, imageName), sample.image)
    await writeFile(
      join(outDir, `${id}.gold.json`),
      JSON.stringify({ id, documentDate: sample.documentDate, rows: sample.rows }, null, 2),
    )

    manifest.push({ id, image: imageName, rowCount: sample.rows.length, documentDate: sample.documentDate })
    console.log(`${id.padEnd(18)} ${String(sample.rows.length).padStart(3)} rows  →  ${imageName}`)
  }

  await writeFile(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2))
  console.log(`\n${manifest.length} samples written to fixtures/out/`)
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
