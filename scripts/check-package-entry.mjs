// Checks that the entry points package.json declares exist after `npm run build`
// and export what the README's "In code" examples import.
//
// It exists because they didn't: `main` said dist/index.js while the build wrote
// dist/src/index.js, so `import { runPipeline } from 'paperparse'` could never have
// resolved, and typecheck and tests both passed, because neither reads `main`.
import { existsSync, readFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync('package.json', 'utf8'))

for (const field of ['main', 'types']) {
  if (!existsSync(pkg[field])) {
    console.error(`package.json "${field}" points at ${pkg[field]}, which the build did not produce.`)
    process.exit(1)
  }
}

const mod = await import(`./../${pkg.main}`)
const expected = ['runPipeline', 'AnthropicBackend', 'TextractBackend', 'EscalatingBackend']
const missing = expected.filter((name) => !(name in mod))
if (missing.length > 0) {
  console.error(`${pkg.main} does not export: ${missing.join(', ')}`)
  process.exit(1)
}

console.log(`${pkg.main} exports ${expected.join(', ')}; ${pkg.types} exists.`)
