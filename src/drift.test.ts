import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, test } from 'vitest'
import { computeDrift, formatDrift } from './drift.js'
import { writeEvidenceMap } from './evidence.js'
import { loadProject, saveProjectSettings, scaffoldProject } from './project.js'
import { recordSyncState } from './sync.js'
import type { DoxloopProject, EvidenceMap, SyncConfig } from './types.js'

const run = promisify(execFile)
const parents: string[] = []

afterEach(async () => {
  await Promise.all(
    parents.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

async function git(cwd: string, ...args: string[]): Promise<void> {
  await run(
    'git',
    ['-c', 'user.name=Doxloop Test', '-c', 'user.email=test@example.com', ...args],
    { cwd },
  )
}

const evidence: EvidenceMap = {
  schemaVersion: 1,
  pages: {
    'docs/authentication.md': {
      sources: [{ source: 'product', paths: ['src/auth.ts'] }],
      verifiedAt: { product: 'abcdef1234567890' },
    },
    'docs/payments.md': {
      sources: [{ source: 'product', paths: ['src/routes'] }],
    },
  },
}

interface Fixture {
  root: string
  product: string
  project: DoxloopProject
}

/** A documentation project beside a Git product source with a recorded baseline. */
async function makeFixture(options: {
  sync?: Partial<SyncConfig>
  evidenceMap?: EvidenceMap | undefined
  baseline?: boolean
} = {}): Promise<Fixture> {
  const parent = await mkdtemp(join(tmpdir(), 'doxloop-drift-'))
  parents.push(parent)
  const product = join(parent, 'product')
  await mkdir(join(product, 'src', 'routes'), { recursive: true })
  await writeFile(join(product, 'src', 'auth.ts'), 'export const ttl = 3600\n', 'utf8')
  await writeFile(join(product, 'src', 'routes', 'pay.ts'), 'export const pay = 1\n', 'utf8')
  await writeFile(join(product, 'pnpm-lock.yaml'), 'lockfileVersion: 1\n', 'utf8')
  await git(product, 'init', '--initial-branch=main')
  await git(product, 'add', '.')
  await git(product, 'commit', '-m', 'initial')

  const root = await scaffoldProject({
    directory: join(parent, 'product-docs'),
    sources: [{ name: 'product', path: '../product' }],
  })
  if (options.sync) {
    const current = (await loadProject(root)).sync
    await saveProjectSettings(root, { sync: { ...current, ...options.sync } })
  }
  const map = 'evidenceMap' in options ? options.evidenceMap : evidence
  if (map) await writeEvidenceMap(root, map)
  const project = await loadProject(root)
  if (options.baseline !== false) await recordSyncState(root, project.sources)
  return { root, product, project }
}

describe('computeDrift', () => {
  test('reports current documentation when nothing changed', async () => {
    const { root, project } = await makeFixture()

    const result = await computeDrift(root, project)

    expect(result.status).toBe('current')
    expect(result.pages).toEqual([])
    expect(result.evidenceMap).toBe('present')
    expect(result.trackedPages).toBe(2)
    expect(result.notes).toEqual([])
  })

  test('names the page affected by a committed source change', async () => {
    const { root, product, project } = await makeFixture()
    await writeFile(join(product, 'src', 'auth.ts'), 'export const ttl = 900\n', 'utf8')
    await git(product, 'commit', '-am', 'shorten token lifetime')

    const result = await computeDrift(root, project)

    expect(result.status).toBe('stale')
    expect(result.pages).toHaveLength(1)
    expect(result.pages[0]?.page).toBe('docs/authentication.md')
    expect(result.pages[0]?.reasons[0]).toMatchObject({
      source: 'product',
      paths: ['src/auth.ts'],
    })
    expect(result.pages[0]?.verifiedAt).toBe('abcdef1234567890')
  })

  test('detects an uncommitted working-tree change', async () => {
    const { root, product, project } = await makeFixture()
    await writeFile(join(product, 'src', 'routes', 'pay.ts'), 'export const pay = 2\n', 'utf8')

    const result = await computeDrift(root, project)

    expect(result.status).toBe('stale')
    expect(result.pages.map((page) => page.page)).toEqual(['docs/payments.md'])
  })

  test('stays current when only ignored files changed', async () => {
    const { root, product, project } = await makeFixture()
    await writeFile(join(product, 'pnpm-lock.yaml'), 'lockfileVersion: 2\n', 'utf8')
    await git(product, 'commit', '-am', 'bump lockfile')

    const result = await computeDrift(root, project)

    expect(result.status).toBe('current')
    expect(result.sources[0]?.filteredPaths).toBe(1)
    expect(result.sources[0]?.changedPaths).toEqual([])
  })

  test('stays current when a change falls outside the watch list', async () => {
    const { root, product, project } = await makeFixture({ sync: { watch: ['src/**'] } })
    await mkdir(join(product, 'scripts'), { recursive: true })
    await writeFile(join(product, 'scripts', 'release.mjs'), 'export {}\n', 'utf8')
    await git(product, 'add', '.')
    await git(product, 'commit', '-m', 'add release script')

    const result = await computeDrift(root, project)

    expect(result.status).toBe('current')
    expect(result.sources[0]?.filteredPaths).toBe(1)
  })

  test('notes changed files that no page references', async () => {
    const { root, product, project } = await makeFixture()
    await writeFile(join(product, 'src', 'internal.ts'), 'export const x = 1\n', 'utf8')
    await git(product, 'add', '.')
    await git(product, 'commit', '-m', 'add internal helper')

    const result = await computeDrift(root, project)

    expect(result.status).toBe('current')
    expect(result.notes).toEqual([
      '1 changed file in "product" is not referenced by any page.',
    ])
  })

  test('cannot attribute pages without an evidence map', async () => {
    const { root, product, project } = await makeFixture({ evidenceMap: undefined })
    await writeFile(join(product, 'src', 'auth.ts'), 'export const ttl = 900\n', 'utf8')
    await git(product, 'commit', '-am', 'shorten token lifetime')

    const result = await computeDrift(root, project)

    expect(result.status).toBe('unknown')
    expect(result.evidenceMap).toBe('missing')
    expect(result.pages).toEqual([])
    expect(result.notes[0]).toContain('no evidence map exists yet')
  })

  test('reports a missing baseline as unresolved', async () => {
    const { root, project } = await makeFixture({ baseline: false })

    const result = await computeDrift(root, project)

    expect(result.status).toBe('unknown')
    expect(result.notes[0]).toContain('no sync baseline yet')
  })

  test('reports a configured source that no longer exists', async () => {
    const { root, product, project } = await makeFixture()
    await rm(product, { recursive: true, force: true })

    const result = await computeDrift(root, project)

    expect(result.status).toBe('unknown')
    expect(result.notes[0]).toContain('does not exist')
  })

  test('attributes one change to every page that documents it', async () => {
    const { root, product, project } = await makeFixture({
      evidenceMap: {
        schemaVersion: 1,
        pages: {
          'docs/authentication.md': {
            sources: [{ source: 'product', paths: ['src/auth.ts'] }],
          },
          'docs/index.md': { sources: [{ source: 'product' }] },
        },
      },
    })
    await writeFile(join(product, 'src', 'auth.ts'), 'export const ttl = 900\n', 'utf8')
    await git(product, 'commit', '-am', 'shorten token lifetime')

    const result = await computeDrift(root, project)

    expect(result.pages.map((page) => page.page)).toEqual([
      'docs/authentication.md',
      'docs/index.md',
    ])
  })
})

describe('formatDrift', () => {
  test('lists each stale page with its cause', async () => {
    const { root, product, project } = await makeFixture()
    await writeFile(join(product, 'src', 'auth.ts'), 'export const ttl = 900\n', 'utf8')
    await git(product, 'commit', '-am', 'shorten token lifetime')

    const output = formatDrift(await computeDrift(root, project))

    expect(output).toContain('Documentation drift: 1 page stale')
    expect(output).toContain('docs/authentication.md')
    expect(output).toContain('src/auth.ts changed')
    expect(output).toContain('1 other tracked page current')
    expect(output).toContain('Fix with: doxloop update')
  })

  test('confirms a current project', async () => {
    const { root, project } = await makeFixture()

    expect(formatDrift(await computeDrift(root, project))).toBe(
      'Documentation is current with the recorded source baseline.',
    )
  })
})
