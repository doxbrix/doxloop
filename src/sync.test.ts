import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, test } from 'vitest'
import {
  LOCAL_CONTENT_BASELINE,
  SYNC_STATE_FILE,
  changedSourcePaths,
  collectSourceChanges,
  formatSourceChanges,
  manifestChanges,
  readSyncState,
  recordSyncState,
} from './sync.js'

const run = promisify(execFile)
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'doxloop-sync-'))
  roots.push(root)
  await mkdir(join(root, '.doxloop'), { recursive: true })
  return root
}

async function git(cwd: string, ...args: string[]): Promise<void> {
  await run(
    'git',
    ['-c', 'user.name=Doxloop Test', '-c', 'user.email=test@example.com', ...args],
    { cwd },
  )
}

async function makeGitSource(root: string, name: string): Promise<string> {
  const path = join(root, name)
  await mkdir(path, { recursive: true })
  await git(path, 'init', '--initial-branch=main')
  await writeFile(join(path, 'readme.md'), 'v1\n', 'utf8')
  await git(path, 'add', '.')
  await git(path, 'commit', '-m', 'initial')
  return path
}

describe('sync state', () => {
  test('records a commit baseline for git sources and a content manifest for plain folders', async () => {
    const root = await makeRoot()
    await makeGitSource(root, 'product')
    await mkdir(join(root, 'plain', 'src'), { recursive: true })
    await writeFile(join(root, 'plain', 'src', 'index.ts'), 'export const a = 1\n', 'utf8')
    await writeFile(join(root, 'plain', '.env'), 'SECRET=1\n', 'utf8')

    const state = await recordSyncState(root, [
      { name: 'product', path: 'product' },
      { name: 'plain', path: 'plain' },
      { name: 'missing', path: 'does-not-exist' },
    ])

    expect(Object.keys(state.sources)).toEqual(['product', 'plain'])
    expect(state.sources.product?.commit).toMatch(/^[0-9a-f]{40}$/)
    expect(state.sources.product?.files).toBeUndefined()
    expect(state.sources.plain).toMatchObject({ commit: LOCAL_CONTENT_BASELINE })
    expect(Object.keys(state.sources.plain?.files ?? {})).toEqual(['src/index.ts'])
    const reloaded = await readSyncState(root)
    expect(reloaded).toEqual(state)
    expect(JSON.parse(await readFile(join(root, SYNC_STATE_FILE), 'utf8'))).toEqual(state)
  })

  test('returns an empty state for a malformed state file', async () => {
    const root = await makeRoot()
    await writeFile(join(root, SYNC_STATE_FILE), '{"schemaVersion":2}\n', 'utf8')

    expect(await readSyncState(root)).toEqual({ schemaVersion: 1, sources: {} })
  })
})

describe('source change collection', () => {
  test('reports committed and uncommitted changes since the baseline', async () => {
    const root = await makeRoot()
    const source = await makeGitSource(root, 'product')
    await recordSyncState(root, [{ name: 'product', path: 'product' }])

    await writeFile(join(source, 'cli.ts'), 'export {}\n', 'utf8')
    await git(source, 'add', '.')
    await git(source, 'commit', '-m', 'add cli')
    await writeFile(join(source, 'readme.md'), 'v2 uncommitted\n', 'utf8')

    const changes = await collectSourceChanges(root, [
      { name: 'product', path: 'product' },
    ])

    expect(changes).toHaveLength(1)
    const change = changes[0]
    if (change?.kind !== 'changed') throw new Error(`unexpected kind: ${change?.kind}`)
    expect(change.changedFiles).toEqual(['A\tcli.ts'])
    expect(change.uncommittedFiles).toEqual(['M readme.md'])
    expect(change.baseline).not.toBe(change.head)
  })

  test('classifies unchanged, non-git, missing, and baseline-free sources', async () => {
    const root = await makeRoot()
    await makeGitSource(root, 'product')
    const fresh = await makeGitSource(root, 'fresh')
    await mkdir(join(root, 'plain'), { recursive: true })
    await recordSyncState(root, [{ name: 'product', path: 'product' }])

    const changes = await collectSourceChanges(root, [
      { name: 'product', path: 'product' },
      { name: 'fresh', path: fresh },
      { name: 'plain', path: 'plain' },
      { name: 'missing', path: 'does-not-exist' },
    ])

    expect(changes.map((change) => change.kind)).toEqual([
      'unchanged',
      'no-baseline',
      'no-baseline',
      'missing-path',
    ])
  }, 15_000)

  test('names added, modified, and deleted files in a plain folder by comparing content', async () => {
    const root = await makeRoot()
    const plain = join(root, 'plain')
    await mkdir(join(plain, 'src'), { recursive: true })
    await mkdir(join(plain, 'node_modules', 'dep'), { recursive: true })
    await writeFile(join(plain, 'src', 'auth.ts'), 'v1\n', 'utf8')
    await writeFile(join(plain, 'src', 'old.ts'), 'old\n', 'utf8')
    await writeFile(join(plain, 'node_modules', 'dep', 'index.js'), 'ignored\n', 'utf8')
    const source = { name: 'plain', path: 'plain' }
    await recordSyncState(root, [source])

    expect((await collectSourceChanges(root, [source]))[0]).toMatchObject({ kind: 'unchanged', baseline: LOCAL_CONTENT_BASELINE })

    await writeFile(join(plain, 'src', 'auth.ts'), 'v2\n', 'utf8')
    await writeFile(join(plain, 'src', 'new.ts'), 'new\n', 'utf8')
    await rm(join(plain, 'src', 'old.ts'))
    await writeFile(join(plain, 'node_modules', 'dep', 'index.js'), 'still ignored\n', 'utf8')
    const [change] = await collectSourceChanges(root, [source])

    expect(change).toMatchObject({ kind: 'changed', changedFiles: ['M\tsrc/auth.ts', 'A\tsrc/new.ts', 'D\tsrc/old.ts'] })
    expect(changedSourcePaths(change!)).toEqual(['src/auth.ts', 'src/new.ts', 'src/old.ts'])
    const summary = formatSourceChanges([change!])
    expect(summary).toContain('compared by content')
    expect(summary).toContain('- M\tsrc/auth.ts')
    expect(manifestChanges({ a: '1' }, { a: '1' })).toEqual([])
  })

  test('does not repeat synchronized dirty content after it is committed', async () => {
    const root = await makeRoot()
    const source = await makeGitSource(root, 'product')
    await writeFile(join(source, 'readme.md'), 'v2 synchronized but dirty\n', 'utf8')
    await recordSyncState(root, [{ name: 'product', path: 'product' }])

    await git(source, 'add', '.')
    await git(source, 'commit', '-m', 'commit synchronized content')

    const [change] = await collectSourceChanges(root, [
      { name: 'product', path: 'product' },
    ])
    expect(change?.kind).toBe('unchanged')
    if (change?.kind === 'unchanged') {
      expect(change.changedFiles).toEqual([])
      expect(change.uncommittedFiles).toEqual([])
    }
  })

  test('detects new changes after a dirty-content baseline', async () => {
    const root = await makeRoot()
    const source = await makeGitSource(root, 'product')
    await writeFile(join(source, 'readme.md'), 'v2 synchronized\n', 'utf8')
    await recordSyncState(root, [{ name: 'product', path: 'product' }])
    await writeFile(join(source, 'readme.md'), 'v3 changed again\n', 'utf8')

    const [change] = await collectSourceChanges(root, [
      { name: 'product', path: 'product' },
    ])
    expect(change?.kind).toBe('changed')
    if (change?.kind === 'changed') {
      expect(change.uncommittedFiles).toEqual(['M readme.md'])
    }
  })

  test('detects a deleted tracked file without failing fingerprinting', async () => {
    const root = await makeRoot()
    const source = await makeGitSource(root, 'product')
    await recordSyncState(root, [{ name: 'product', path: 'product' }])
    await rm(join(source, 'readme.md'))

    const [change] = await collectSourceChanges(root, [
      { name: 'product', path: 'product' },
    ])

    expect(change?.kind).toBe('changed')
    if (change?.kind === 'changed') {
      expect(change.changedFiles).toEqual([])
      expect(change.uncommittedFiles).toEqual(['D readme.md'])
    }
  })
})

describe('change summary formatting', () => {
  test('produces per-source guidance the update prompt can embed', () => {
    const summary = formatSourceChanges([
      {
        name: 'product',
        path: '../product',
        kind: 'changed',
        baseline: 'a'.repeat(40),
        head: 'b'.repeat(40),
        changedFiles: ['M\tsrc/cli.ts'],
        uncommittedFiles: ['M readme.md'],
      },
      { name: 'plain', path: '../plain', kind: 'not-git' },
    ])

    expect(summary).toContain('Source changes since the last documentation sync')
    expect(summary).toContain('changed since the last documentation sync')
    expect(summary).toContain('- M\tsrc/cli.ts')
    expect(summary).toContain('Uncommitted working-tree changes:')
    expect(summary).toContain('- M readme.md')
    expect(summary).toContain(`git -C ../product diff ${'a'.repeat(12)}..HEAD`)
    expect(summary).toContain('not a Git repository')
  })

  test('truncates long file lists', () => {
    const files = Array.from({ length: 45 }, (_, index) => `M\tsrc/file-${index}.ts`)
    const summary = formatSourceChanges([
      {
        name: 'product',
        path: '../product',
        kind: 'changed',
        baseline: 'a'.repeat(40),
        head: 'b'.repeat(40),
        changedFiles: files,
        uncommittedFiles: [],
      },
    ])

    expect(summary).toContain('...and 5 more files')
  })

  test('returns an empty summary when there are no sources', () => {
    expect(formatSourceChanges([])).toBe('')
  })
})
