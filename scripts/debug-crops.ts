/**
 * Dump the section crops for an image so you can see what the model sees.
 *
 *   npm run fixtures
 *   npx tsx scripts/debug-crops.ts fixtures/out/clean.jpg
 *
 * Misaligned crops are the most likely thing to go wrong when writing a new
 * FormSpec, and they fail quietly — the model dutifully reads whatever is in the
 * frame and you get plausible rows attributed to the wrong keys. Look at the crops.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, dirname, basename, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sectionChunks, rectForKeys, pitchForKeys, expandByRows } from '../src/formspec/geometry.js'
import { cropPixels, normRectToPixels } from '../src/image/crop.js'
import { imageSize, prepareForVision } from '../src/image/prep.js'
import { campgroundRosterSpec as spec } from '../examples/campground-roster/spec.js'

const here = dirname(fileURLToPath(import.meta.url))

async function main() {
  const path = process.argv[2] ?? join(here, '..', 'fixtures', 'out', 'clean.jpg')
  const outDir = join(here, '..', 'fixtures', 'crops', basename(path, extname(path)))
  await mkdir(outDir, { recursive: true })

  const image = await prepareForVision(await readFile(path))
  const { width, height } = await imageSize(image)
  const chunks = sectionChunks(spec)

  console.log(`${basename(path)}  ${width}×${height}  →  ${chunks.length} crops`)

  for (const keys of chunks) {
    const base = rectForKeys(spec, keys)
    if (!base) continue
    const padded = expandByRows(base, 1, pitchForKeys(spec, keys))
    const px = normRectToPixels(padded, width, height)
    const name = `${String(keys[0]).padStart(3, '0')}-${String(keys[keys.length - 1]).padStart(3, '0')}.jpg`

    await writeFile(join(outDir, name), await cropPixels(image, px))
    console.log(`  ${name}  ${px.width}×${px.height} at (${px.left}, ${px.top})`)
  }

  console.log(`\nWritten to ${outDir}`)
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
