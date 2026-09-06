import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, test } from 'vitest'
import { pathExists } from './fs.js'
import { snapshotLocalSources } from './local-source-snapshot.js'

const run = promisify(execFile)
const parents: string[] = []

afterEach(async () => {
  await Promise.all(parents.splice(0).map((parent) => rm(parent, { recursive: true, force: true })))
})

describe('local source snapshots', () => {
  test('copies each external local folder once per content version and leaves the checkout alone', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'doxloop-local-snapshot-'))
    parents.push(parent)
    const root = join(parent, 'docs')
    await mkdir(join(root, 'inside'), { recursive: true })
    const product = join(parent, 'product')
    await mkdir(join(product, 'src'), { recursive: true })
    await mkdir(join(product, 'node_modules', 'dep'), { recursive: true })
    await writeFile(join(product, 'src', 'auth.ts'), 'v1\n', 'utf8')
    await writeFile(join(product, 'node_modules', 'dep', 'index.js'), 'ignored\n', 'utf8')
    await writeFile(join(product, '.env'), 'SECRET=1\n', 'utf8')
    await run('git', ['-C', product, 'init', '--initial-branch=main'])
    await writeFile(join(product, '.gitignore'), 'node_modules\n.env\n', 'utf8')
    const plain = join(parent, 'plain')
    await mkdir(plain, { recursive: true })
    await writeFile(join(plain, 'notes.md'), 'plain\n', 'utf8')

    const first = await snapshotLocalSources(root, [
      { name: 'product', path: '../product' },
      { name: 'plain', path: plain },
      { name: 'inside', path: 'inside' },
      { name: 'remote', path: '../remote', remote: { provider: 'github', repository: 'acme/remote', branch: 'main' } },
      { name: 'api', path: '../product/openapi.yaml', kind: 'openapi' },
    ])

    expect(first.copied.map((entry) => entry.name)).toEqual(['product', 'plain'])
    const snapshot = first.sources[0]!.path
    expect(dirname(dirname(dirname(snapshot)))).toBe(join(parent, '.doxloop-sources'))
    expect(await readFile(join(snapshot, 'src', 'auth.ts'), 'utf8')).toBe('v1\n')
    expect(await readFile(join(snapshot, '.gitignore'), 'utf8')).toBe('node_modules\n.env\n')
    await expect(pathExists(join(snapshot, 'node_modules'))).resolves.toBe(false)
    await expect(pathExists(join(snapshot, '.env'))).resolves.toBe(false)
    expect(first.sources.slice(2)).toEqual([
      { name: 'inside', path: 'inside' },
      { name: 'remote', path: '../remote', remote: { provider: 'github', repository: 'acme/remote', branch: 'main' } },
      { name: 'api', path: '../product/openapi.yaml', kind: 'openapi' },
    ])
    expect(await readFile(join(first.sources[1]!.path, 'notes.md'), 'utf8')).toBe('plain\n')

    // Same content reuses the snapshot; changed content gets a new one.
    const again = await snapshotLocalSources(root, [{ name: 'product', path: '../product' }])
    expect(again.sources[0]!.path).toBe(snapshot)
    await writeFile(join(product, 'src', 'auth.ts'), 'v2\n', 'utf8')
    const changed = await snapshotLocalSources(root, [{ name: 'product', path: '../product' }])
    expect(changed.sources[0]!.path).not.toBe(snapshot)
    expect(await readFile(join(changed.sources[0]!.path, 'src', 'auth.ts'), 'utf8')).toBe('v2\n')
    expect((await readdir(dirname(snapshot))).sort()).toHaveLength(2)
    // Writing into the snapshot never reaches the checkout.
    await writeFile(join(changed.sources[0]!.path, 'src', 'auth.ts'), 'tampered\n', 'utf8')
    expect(await readFile(join(product, 'src', 'auth.ts'), 'utf8')).toBe('v2\n')
  })
})
