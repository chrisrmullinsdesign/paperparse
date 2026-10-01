import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Named explicitly so a local `npm run build` does not put a second, compiled
    // copy of every test under `dist/` into the run.
    include: ['test/**/*.test.ts'],
    // One worker per core starts too many at once for a slow disk: on an external
    // drive every one of them timed out before responding. Four start reliably
    // there, and a CI runner has four cores anyway.
    maxWorkers: 4,
  },
})
