import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { authorPrompt } from './author.js'
import { describeSpec, replayInitCommand } from './interactive.js'
import {
  parseSource,
  parseSpec,
  validateProjectSourceBoundaries,
} from './project.js'
import {
  collectSourceChanges,
  formatSourceChanges,
  recordSyncState,
} from './sync.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'doxloop-spec-'))
  roots.push(root)
  await mkdir(join(root, '.doxloop'), { recursive: true })
  return root
}

const OPENAPI_DOCUMENT = JSON.stringify({
  openapi: '3.0.4',
  info: { title: 'Petstore', version: '1.0.0' },
  paths: {
    '/pets': { get: {}, post: {} },
    '/pets/{id}': { get: {} },
  },
})

describe('specification source parsing', () => {
  test('classifies spec files and URLs from --source values', () => {
    expect(parseSource('api=./openapi.json')).toEqual({
      name: 'api',
      path: './openapi.json',
      kind: 'openapi',
    })
    expect(parseSource('api=https://example.com/openapi.yaml').kind).toBe('openapi')
    expect(parseSource('product=../my-app').kind).toBeUndefined()
  })

  test('parses --spec values with and without a name', () => {
    expect(parseSpec('https://example.com/openapi.json')).toEqual({
      name: 'api',
      path: 'https://example.com/openapi.json',
      kind: 'openapi',
    })
    expect(parseSpec('billing=./specs/billing.yaml')).toEqual({
      name: 'billing',
      path: './specs/billing.yaml',
      kind: 'openapi',
    })
    expect(() => parseSpec('Bad Name=./x.json')).toThrow(/Invalid source name/)
    expect(() => parseSpec('api=https://user:pw@example.com/openapi.json')).toThrow(
      /credentials/,
    )
  })

  test('boundary validation accepts URLs and existing spec files only', async () => {
    const root = await makeRoot()
    await writeFile(join(root, 'openapi.json'), OPENAPI_DOCUMENT, 'utf8')
    await expect(
      validateProjectSourceBoundaries(root, [
        { name: 'api', path: 'https://example.com/openapi.json', kind: 'openapi' },
        { name: 'local', path: './openapi.json', kind: 'openapi' },
      ]),
    ).resolves.toBeUndefined()
    await expect(
      validateProjectSourceBoundaries(root, [
        { name: 'gone', path: './missing.yaml', kind: 'openapi' },
      ]),
    ).rejects.toThrow(/does not exist/)
  })
})

describe('specification synchronization', () => {
  test('tracks spec file baselines by content hash', async () => {
    const root = await makeRoot()
    const specPath = join(root, 'openapi.json')
    await writeFile(specPath, OPENAPI_DOCUMENT, 'utf8')
    const sources = [{ name: 'api', path: './openapi.json', kind: 'openapi' as const }]

    const before = await collectSourceChanges(root, sources)
    expect(before[0]?.kind).toBe('spec-changed')

    await recordSyncState(root, sources)
    const after = await collectSourceChanges(root, sources)
    expect(after[0]?.kind).toBe('spec-unchanged')

    await writeFile(specPath, `${OPENAPI_DOCUMENT}\n`, 'utf8')
    const changed = await collectSourceChanges(root, sources)
    expect(changed[0]?.kind).toBe('spec-changed')
    expect(formatSourceChanges(changed)).toContain('API specification changed')
  })

  test('reports remote specifications for agent comparison', async () => {
    const root = await makeRoot()
    const sources = [
      {
        name: 'api',
        path: 'https://example.com/openapi.json',
        kind: 'openapi' as const,
      },
    ]
    const changes = await collectSourceChanges(root, sources)
    expect(changes[0]?.kind).toBe('spec-remote')
    expect(formatSourceChanges(changes)).toContain('remote API specification')
    const state = await recordSyncState(root, sources)
    expect(Object.keys(state.sources)).toHaveLength(0)
  })
})

describe('specification evidence in the author prompt', () => {
  test('renders OpenAPI sources as authoritative API evidence', () => {
    const prompt = authorPrompt('create', [
      { name: 'product', path: '../my-app' },
      { name: 'api', path: './openapi.json', kind: 'openapi' },
    ])
    expect(prompt).toContain('- product: ../my-app')
    expect(prompt).toContain('OpenAPI specification at ./openapi.json')
    expect(prompt).toContain('authoritative API evidence')
  })
})

describe('specification summary', () => {
  test('summarizes a local OpenAPI document', async () => {
    const root = await makeRoot()
    await writeFile(join(root, 'openapi.json'), OPENAPI_DOCUMENT, 'utf8')
    expect(await describeSpec(root, './openapi.json')).toBe(
      'OpenAPI 3.0.4 — "Petstore" — 3 operations',
    )
  })

  test('returns nothing for URLs and unreadable files', async () => {
    const root = await makeRoot()
    expect(await describeSpec(root, 'https://example.com/openapi.json')).toBeUndefined()
    expect(await describeSpec(root, './missing.json')).toBeUndefined()
  })
})

describe('interactive setup replay', () => {
  test('shell-quotes every unsafe setup value', () => {
    expect(
      replayInitCommand({
        directory: 'payments docs',
        title: 'Payments $HOME',
        sources: [
          {
            name: 'api',
            path: "https://example.com/openapi.json?audience=dev&label=it's-ready",
            kind: 'openapi',
          },
        ],
        generator: 'doxbrix',
      }),
    ).toBe(
      `doxloop init 'payments docs' --title 'Payments $HOME' --spec 'api=https://example.com/openapi.json?audience=dev&label=it'"'"'s-ready'`,
    )
  })
})
