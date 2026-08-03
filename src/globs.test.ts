import { describe, expect, test } from 'vitest'
import { isWatchedPath, matchesAnyGlob, matchesGlob } from './globs.js'

describe('matchesGlob', () => {
  test('matches a single segment wildcard without crossing directories', () => {
    expect(matchesGlob('src/auth.ts', 'src/*.ts')).toBe(true)
    expect(matchesGlob('src/nested/auth.ts', 'src/*.ts')).toBe(false)
  })

  test('matches everything below a directory with a trailing globstar', () => {
    expect(matchesGlob('src/auth.ts', 'src/**')).toBe(true)
    expect(matchesGlob('src/routes/pay.ts', 'src/**')).toBe(true)
    expect(matchesGlob('tests/auth.ts', 'src/**')).toBe(false)
  })

  test('treats an interior globstar as zero or more directories', () => {
    expect(matchesGlob('src/auth.ts', 'src/**/*.ts')).toBe(true)
    expect(matchesGlob('src/routes/api/pay.ts', 'src/**/*.ts')).toBe(true)
    expect(matchesGlob('src/auth.js', 'src/**/*.ts')).toBe(false)
  })

  test('matches a slashless pattern at any depth like gitignore', () => {
    expect(matchesGlob('pnpm-lock.yaml', 'pnpm-lock.yaml')).toBe(true)
    expect(matchesGlob('packages/api/pnpm-lock.yaml', 'pnpm-lock.yaml')).toBe(true)
    expect(matchesGlob('src/auth.test.ts', '*.test.ts')).toBe(true)
    expect(matchesGlob('src/auth.ts', '*.test.ts')).toBe(false)
  })

  test('anchors a pattern that contains a slash', () => {
    expect(matchesGlob('docs/index.md', 'docs/*.md')).toBe(true)
    expect(matchesGlob('site/docs/index.md', 'docs/*.md')).toBe(false)
  })

  test('escapes regular expression characters in literal segments', () => {
    expect(matchesGlob('src/a+b.ts', 'src/a+b.ts')).toBe(true)
    expect(matchesGlob('src/axb.ts', 'src/a+b.ts')).toBe(false)
    expect(matchesGlob('src/file.ts', 'src/file?ts')).toBe(true)
  })

  test('normalizes windows separators and leading dot slash', () => {
    expect(matchesGlob('src\\auth.ts', 'src/**')).toBe(true)
    expect(matchesGlob('./src/auth.ts', 'src/**')).toBe(true)
  })

  test('never matches an empty pattern', () => {
    expect(matchesGlob('src/auth.ts', '')).toBe(false)
    expect(matchesGlob('src/auth.ts', '   ')).toBe(false)
  })
})

describe('matchesAnyGlob', () => {
  test('is true when at least one pattern matches', () => {
    expect(matchesAnyGlob('src/auth.ts', ['docs/**', 'src/**'])).toBe(true)
    expect(matchesAnyGlob('src/auth.ts', ['docs/**', '*.md'])).toBe(false)
    expect(matchesAnyGlob('src/auth.ts', [])).toBe(false)
  })
})

describe('isWatchedPath', () => {
  const watch = ['src/**', 'openapi.yaml']
  const ignore = ['**/*.test.ts', 'pnpm-lock.yaml']

  test('accepts a watched path', () => {
    expect(isWatchedPath('src/auth.ts', watch, ignore)).toBe(true)
    expect(isWatchedPath('openapi.yaml', watch, ignore)).toBe(true)
  })

  test('rejects a path outside the watch list', () => {
    expect(isWatchedPath('scripts/release.mjs', watch, ignore)).toBe(false)
  })

  test('lets ignore override a watched path', () => {
    expect(isWatchedPath('src/auth.test.ts', watch, ignore)).toBe(false)
  })

  test('watches everything when no watch pattern is configured', () => {
    expect(isWatchedPath('scripts/release.mjs', [], ignore)).toBe(true)
    expect(isWatchedPath('pnpm-lock.yaml', [], ignore)).toBe(false)
  })
})
