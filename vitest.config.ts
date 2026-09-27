import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'ui/**/*.test.ts', 'vendor/doxbrix-import/src/**/*.test.ts'],
    // Integration cases create and inspect real Git repositories. Parallel
    // full-suite load can push those operations past Vitest's 5-second unit
    // default even though focused runs finish much sooner; a busy machine
    // (the release runs the whole suite) can stretch them past 15 seconds.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
