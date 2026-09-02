import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'ui/**/*.test.ts'],
    // Integration cases create and inspect real Git repositories. Parallel
    // full-suite load can push those operations past Vitest's 5-second unit
    // default even though focused runs finish much sooner.
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
})
