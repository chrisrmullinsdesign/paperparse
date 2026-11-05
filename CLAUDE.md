# Working in paperparse

This file is the standing brief for a coding agent, and it is committed so a reader
can see the rules the agent worked under. It is not a style guide. Everything below
is either a hard rule or a fact about the repo that is expensive to rediscover.

## What the repo is for

A public portfolio artifact. The bar is **verifiable honesty, not polish**. Every
claim in the README should be recomputable from committed artifacts, and every
limitation stated there rather than left for a reader to find. When adding anything,
ask what would falsify it, and make that check run.

## Hard rules

1. **No fabricated data, ever.** No simulated, stub-backed, demo, or sample mode in
   the recorder or viewer. No invented or "illustrative" numbers in prose: where the
   README shows output shapes, it uses `<placeholders>`. To exercise the UI without
   spending, write a throwaway stub record into `runs/`, check it, and delete it. Never
   commit it.
2. **Paid commands need explicit approval, with the cost stated first.**
   `npm run record`, `npm run bench`, `npm run extract`, and the viewer's
   `/api/extract` call real APIs. Textract costs about **$0.015 per page**, so the
   9-image corpus is about **$0.14** per re-record. Vision costs about $0.11 per
   page. AWS credentials resolve from `~/.aws`, so these commands *will* run and
   bill without prompting. Validate on one fixture (`--only clean`) before
   recording all nine. Approval for one recording does not cover the next.
3. **Changing the fixtures invalidates every committed run.** That means the corpus
   definition, a seed, an augmentation, the generator, or the FormSpec geometry. CI
   fails if any `runs/*.jpg` no longer matches what `npm run fixtures` produces. That
   failure means "this needs a paid re-record". It does not mean "update the image".
4. **Numbers in the README are tested.** `test/readme.test.ts` rescores the nine runs
   and fails if a quoted Textract figure disagrees. If a number changes, change the
   prose. Do not loosen the test. The Claude-backend figures are *not* recomputable
   (no key on the maintainer's machine, older corpus), and the README says so. Keep
   it saying so.
   History is tested too: `runs/before-rotation-fix/` holds superseded recordings that
   the README's account of the old failure is recomputed from. Don't delete or
   regenerate them. When a re-record supersedes a run the prose quotes, archive the old
   one the same way.
5. **Sweep before anything goes public.** Before a push, scan every added or changed
   file for secrets, personal data, and image metadata (EXIF/GPS, local paths),
   including `runs/*.json` and images, not just source. Report what was scanned and
   what matched. When a match is a false positive, say what it actually is.
6. **Don't weaken the viewer server's checks** (`ui/server.ts`): loopback bind,
   Host/Origin validation, JSON-only POSTs, the served-path allowlist, body caps. The
   README's Security section documents why each exists.

## Workflow

- Work on a branch and open a PR. `main` is protected and requires CI to pass.
- Commit messages say what changed and **why**. When a commit corrects a claim, it
  names the claim and what falsified it. See `git log` for the house style.
- Commits an agent helped write carry a `Co-Authored-By:` trailer naming the model.
- Fill in the PR template's verification section with what was actually run.

## Commands

| Command | Notes |
| --- | --- |
| `npm test` | No network, no credentials. About 2–3 minutes on the maintainer's external drive (`maxWorkers: 4` is deliberate, see `vitest.config.ts`). |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run fixtures` | Regenerates `fixtures/out/` deterministically from seed. Free. |
| `npm run ui` | Local viewer on `127.0.0.1:5173`. |

The README quotes the test count in two places. When adding a test, update both, and add what it covers to *Honesty about what's verified*.

## Known traps

- **npm 10.9.x cannot resolve vitest's current peer set.** It fails with
  `Cannot read properties of null (reading 'edgesOut')`, even in an empty project.
  `npm ci` from the existing lockfile still works. To change dependencies, use
  `npx npm@11 install --package-lock-only …`, then `npm ci`.
- **Install scripts are approved by name in `package.json` → `allowScripts`.** npm 11
  warns about any dependency whose install script nobody reviewed. `esbuild` and
  `fsevents` (dev tooling, via tsx and vite) are approved. `sharp` ships prebuilt
  binaries and has none. When a new one appears, approve or deny it on purpose
  (`npx npm@11 install-scripts approve|deny <pkg> --no-allow-scripts-pin`). Don't
  let the warning become background noise.
- **`npm run build` emits the library only** (`tsconfig.build.json`, `src/` → `dist/`).
  `scripts/check-package-entry.mjs` fails CI if `main`/`types` stop matching it.
- **`sharp` is held at `>=0.35.5`** for two advisories (see README). A sharp bump can
  also change fixture rendering; the CI image check catches that.
- **`claude-opus-5` is the vision backend's default model** and the model the
  published Claude figures were measured with. Changing the default makes those
  figures describe a model the code no longer uses.
