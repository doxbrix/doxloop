import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import {
  EVIDENCE_MAP_FILE,
  pagesForChange,
  readEvidenceMap,
  trackedSources,
  writeEvidenceMap,
} from './evidence.js'
import type { EvidenceMap } from './types.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'doxloop-evidence-'))
  roots.push(root)
  await mkdir(join(root, '.doxloop'), { recursive: true })
  return root
}

const map: EvidenceMap = {
  schemaVersion: 1,
  pages: {
    'docs/guides/authentication.md': {
      sources: [{ source: 'product', paths: ['src/auth.ts', 'src/session.ts'] }],
      verifiedAt: { product: '3a1f9c' },
      confidence: 'verified',
    },
    'docs/reference/payments.md': {
      sources: [{ source: 'product', paths: ['src/routes'] }],
    },
    'docs/reference/api.md': {
      sources: [{ source: 'api', operations: ['POST /oauth/token'] }],
    },
    'docs/index.md': {
      sources: [{ source: 'product' }],
    },
  },
}

describe('evidence map storage', () => {
  test('returns undefined when no map has been written yet', async () => {
    expect(await readEvidenceMap(await makeRoot())).toBeUndefined()
  })

  test('writes and reads a map, sorting pages for a stable diff', async () => {
    const root = await makeRoot()

    await writeEvidenceMap(root, map)

    expect(await readEvidenceMap(root)).toEqual(map)
    const raw = JSON.parse(await readFile(join(root, EVIDENCE_MAP_FILE), 'utf8')) as {
      pages: Record<string, unknown>
    }
    expect(Object.keys(raw.pages)).toEqual([
      'docs/guides/authentication.md',
      'docs/index.md',
      'docs/reference/api.md',
      'docs/reference/payments.md',
    ])
  })

  test.each([
    ['an unsupported schema version', { schemaVersion: 2, pages: {} }],
    ['a missing pages object', { schemaVersion: 1 }],
    ['a page without sources', { schemaVersion: 1, pages: { 'a.md': {} } }],
    [
      'an unnamed source',
      { schemaVersion: 1, pages: { 'a.md': { sources: [{ paths: ['src'] }] } } },
    ],
    [
      'an unknown confidence',
      {
        schemaVersion: 1,
        pages: { 'a.md': { sources: [{ source: 'product' }], confidence: 'maybe' } },
      },
    ],
    [
      'a non-string verified revision',
      {
        schemaVersion: 1,
        pages: { 'a.md': { sources: [{ source: 'product' }], verifiedAt: { product: 3 } } },
      },
    ],
  ])('fails closed on %s', async (_label, content) => {
    const root = await makeRoot()
    await writeFile(join(root, EVIDENCE_MAP_FILE), `${JSON.stringify(content)}\n`, 'utf8')

    await expect(readEvidenceMap(root)).rejects.toThrow('unsupported format')
  })
})

describe('pagesForChange', () => {
  test('matches an exact recorded file path', () => {
    expect(pagesForChange(map, 'product', ['src/auth.ts'])).toEqual(
      new Map([
        ['docs/guides/authentication.md', ['src/auth.ts']],
        ['docs/index.md', ['src/auth.ts']],
      ]),
    )
  })

  test('treats a recorded directory as everything below it', () => {
    const matches = pagesForChange(map, 'product', ['src/routes/pay.ts'])

    expect(matches.get('docs/reference/payments.md')).toEqual(['src/routes/pay.ts'])
    expect(matches.has('docs/guides/authentication.md')).toBe(false)
  })

  test('matches every change for a source recorded without paths', () => {
    expect(pagesForChange(map, 'product', ['scripts/release.mjs'])).toEqual(
      new Map([['docs/index.md', ['scripts/release.mjs']]]),
    )
  })

  test('reports only the paths that matched each page', () => {
    const matches = pagesForChange(map, 'product', [
      'src/auth.ts',
      'src/routes/pay.ts',
      'src/session.ts',
    ])

    expect(matches.get('docs/guides/authentication.md')).toEqual([
      'src/auth.ts',
      'src/session.ts',
    ])
    expect(matches.get('docs/reference/payments.md')).toEqual(['src/routes/pay.ts'])
  })

  test('ignores pages bound to a different source', () => {
    expect(pagesForChange(map, 'api', ['src/auth.ts'])).toEqual(
      new Map([['docs/reference/api.md', ['src/auth.ts']]]),
    )
  })

  test('returns no matches when nothing relevant changed', () => {
    const productOnly: EvidenceMap = {
      schemaVersion: 1,
      pages: { 'docs/a.md': { sources: [{ source: 'product', paths: ['src/auth.ts'] }] } },
    }

    expect(pagesForChange(productOnly, 'product', ['README.md']).size).toBe(0)
  })
})

describe('trackedSources', () => {
  test('lists every source the map attributes pages to', () => {
    expect(trackedSources(map)).toEqual(new Set(['product', 'api']))
  })
})
