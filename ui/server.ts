/**
 * The local half of the viewer.
 *
 *   npm run ui        →  http://localhost:5173
 *
 * `ui/index.html` is a static page: given a `runs/` directory it works from the
 * filesystem or from any static host, with no server at all. This adds the two
 * things a static host cannot do — list the backends whose credentials are actually
 * present, and run one live.
 *
 * `node:http` and nothing else. A viewer that pulled in a web framework to serve
 * four routes would cost more to install than the library it demonstrates.
 */

import { createServer } from 'node:http'
import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { extname, join, normalize, dirname, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { runPipeline, type ReadMode, type StageEvent } from '../src/pipeline.js'
import { AnthropicBackend } from '../src/extract/anthropic.js'
import { TextractBackend } from '../src/extract/textract.js'
import { EscalatingBackend } from '../src/extract/escalate.js'
import { buildRunRecord, type Gold } from './record.js'
import type { Backend } from '../src/extract/backend.js'
import type { Resolution } from '../src/types.js'
import { campgroundRosterSpec, campgroundRosterRules } from '../examples/campground-roster/spec.js'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const port = Number(process.env.PORT ?? 5173)
// Loopback only. This serves the repository directory with no authentication, and
// the default bind would put that on every interface the machine has.
const host = process.env.HOST ?? '127.0.0.1'

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
}

const BACKENDS: Record<string, () => Backend> = {
  textract: () => new TextractBackend(),
  anthropic: () => new AnthropicBackend(),
  escalate: () => new EscalatingBackend(new TextractBackend(), new AnthropicBackend()),
}

/**
 * Resolve a URL path to a file inside `root`, or null.
 *
 * This serves the repository directory, so `GET /../../.ssh/id_rsa` has to be a 404
 * rather than a file. Two details carry the weight:
 *
 *  - **Decode before normalizing.** `%2e%2e%2f` is `../` and a check that runs
 *    before decoding never sees it.
 *  - **Compare against `root + sep`, not `root`.** A plain `startsWith(root)` also
 *    accepts a sibling directory whose name merely starts with the root's —
 *    `/repo` would admit `/repo-backup/secrets`.
 *
 * Exported so the claim can be tested rather than asserted.
 */
export function safePath(urlPath: string, base = root): string | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(urlPath.split('?')[0])
  } catch {
    return null // malformed percent-encoding is not a path
  }
  if (decoded.includes('\0')) return null
  const resolved = normalize(join(base, decoded))
  if (resolved !== base && !resolved.startsWith(base + sep)) return null
  return existsSync(resolved) ? resolved : null
}

function json(res: import('node:http').ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': MIME['.json'], 'content-length': Buffer.byteLength(payload) })
  res.end(payload)
}

async function readBody(req: import('node:http').IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

/** Fixtures available to extract from, if `npm run fixtures` has been run. */
async function listFixtures(): Promise<string[]> {
  const dir = join(root, 'fixtures', 'out')
  if (!existsSync(dir)) return []
  const files = await readdir(dir)
  return files.filter((f) => f.endsWith('.jpg')).map((f) => f.replace(/\.jpg$/, '')).sort()
}

async function extract(body: {
  fixtureId?: string
  imageBase64?: string
  backend?: string
  readMode?: ReadMode
}) {
  const which = body.backend ?? 'textract'
  const make = BACKENDS[which]
  if (!make) throw new Error(`Unknown backend "${which}".`)
  const backend = make()
  if (!backend.isAvailable()) throw new Error(`No credentials found for the "${which}" backend.`)

  let image: Buffer
  let id: string
  if (body.imageBase64) {
    image = Buffer.from(body.imageBase64.replace(/^data:[^,]+,/, ''), 'base64')
    id = 'upload'
  } else if (body.fixtureId) {
    const path = join(root, 'fixtures', 'out', `${body.fixtureId}.jpg`)
    if (!existsSync(path)) throw new Error(`No fixture "${body.fixtureId}". Run \`npm run fixtures\`.`)
    image = await readFile(path)
    id = body.fixtureId
  } else {
    throw new Error('Provide either fixtureId or imageBase64.')
  }

  const stages: StageEvent[] = []
  const startedAt = Date.now()
  const result = await runPipeline(image, campgroundRosterSpec, backend, {
    readMode: body.readMode ?? 'auto',
    rules: campgroundRosterRules,
    sectionConcurrency: 4,
    onStage: (event) => stages.push(event),
  })
  const elapsedMs = Date.now() - startedAt

  // Gold labels exist only for the generated corpus. An uploaded photograph has no
  // ground truth, and the UI has to be able to tell the difference — a comparison
  // against nothing would otherwise render as a perfect score.
  const goldPath = join(root, 'fixtures', 'out', `${id}.gold.json`)
  const gold = existsSync(goldPath) ? ((JSON.parse(await readFile(goldPath, 'utf8'))) as Gold) : null

  return buildRunRecord({
    id,
    spec: campgroundRosterSpec,
    result,
    stages,
    elapsedMs,
    readMode: body.readMode ?? 'auto',
    backendName: which,
    gold,
    // A corpus image is already on disk and served by path; an upload only exists
    // in this response, so it rides along inline.
    image: gold ? `/fixtures/out/${id}.jpg` : null,
    imageBase64: gold ? null : (body.imageBase64 ?? null),
  })
}

const server = createServer(async (req, res) => {
  const url = req.url ?? '/'

  try {
    if (url === '/api/health') {
      return json(res, 200, {
        live: true,
        backends: Object.fromEntries(
          Object.entries(BACKENDS).map(([name, make]) => [name, make().isAvailable()]),
        ),
        fixtures: await listFixtures(),
      })
    }

    if (url === '/api/extract' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}')
      return json(res, 200, await extract(body))
    }

    if (url === '/api/resolve' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}') as {
        runId?: string
        resolutions?: Resolution[]
      }
      if (!body.runId || !/^[\w.-]+$/.test(body.runId)) {
        return json(res, 400, { error: 'runId must be a simple identifier.' })
      }
      await mkdir(join(root, 'runs'), { recursive: true })
      const path = join(root, 'runs', `${body.runId}.review.json`)
      await writeFile(path, JSON.stringify({ resolutions: body.resolutions ?? [] }, null, 2))
      return json(res, 200, { saved: (body.resolutions ?? []).length, path: `runs/${body.runId}.review.json` })
    }

    const path = safePath(url === '/' ? '/ui/index.html' : url)
    if (!path) return json(res, 404, { error: `Not found: ${url}` })

    const body = await readFile(path)
    res.writeHead(200, {
      'content-type': MIME[extname(path)] ?? 'application/octet-stream',
      'content-length': body.length,
      'cache-control': 'no-cache',
    })
    res.end(body)
  } catch (err) {
    json(res, 500, { error: err instanceof Error ? err.message : String(err) })
  }
})

/**
 * Only listen when this file is the entry point.
 *
 * The tests import `safePath` from here to check the traversal guard, and a module
 * that binds a socket on import would make that test open a port as a side effect.
 */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  server.listen(port, host, () => {
    console.log(`paperparse viewer  →  http://${host}:${port}`)
    listFixtures().then((f) => {
      if (f.length === 0) console.log('No fixtures yet. Run `npm run fixtures` to generate the corpus.')
    })
    if (!existsSync(join(root, 'runs', 'index.json'))) {
      console.log('No recorded runs yet. Run `npm run record -- --backend textract` to make the demo work offline.')
    }
  })
}

export { server }
