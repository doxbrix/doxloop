import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { loadProject, saveProjectSettings, scaffoldProject } from './project.js'
import { monitorRemoteSources } from './remote-monitor.js'

const roots: string[] = []

afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('remote source monitoring', () => {
  test('uses GitHub APIs and an isolated snapshot without touching the source checkout', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'doxloop-remote-'))
    roots.push(parent)
    const root = await scaffoldProject({ directory: join(parent, 'docs'), sources: [] })
    const sourcePath = join(parent, 'source')
    await import('node:fs/promises').then(({ mkdir }) => mkdir(sourcePath, { recursive: true }))
    const sentinel = join(sourcePath, 'sentinel.txt')
    await writeFile(sentinel, 'must not change\n')
    const baseline = '1'.repeat(40)
    const head = '2'.repeat(40)
    const loaded = await loadProject(root)
    await saveProjectSettings(root, {
      sources: [{
        name: 'product',
        path: '../source',
        remote: {
          provider: 'github',
          repository: 'acme/product',
          branch: 'main',
        },
      }],
    })
    await writeFile(
      join(root, '.doxloop', 'sync-state.json'),
      `${JSON.stringify({
        schemaVersion: 1,
        sources: { product: { commit: baseline, recordedAt: new Date().toISOString() } },
      })}\n`,
    )
    const archive = zipSync({
      [`acme-product-${head}/src/config.ts`]: strToU8('export const limit = 120\n'),
    })
    const requests: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      const url = String(input)
      requests.push(url)
      if (url.includes('/branches/main')) {
        return new Response(JSON.stringify({ commit: { sha: head } }), { status: 200 })
      }
      if (url.includes('/compare/')) {
        return new Response(JSON.stringify({
          files: [{ filename: 'src/config.ts', status: 'modified' }],
        }), { status: 200 })
      }
      return new Response(archive, { status: 200 })
    }))

    const result = await monitorRemoteSources(root, {
      ...loaded,
      ...(await loadProject(root)),
    })

    expect(requests).toHaveLength(3)
    expect(requests.every((url) => url.startsWith('https://api.github.com/'))).toBe(true)
    expect(result.changes[0]).toMatchObject({
      kind: 'changed',
      baseline,
      head,
      changedFiles: ['M\tsrc/config.ts'],
    })
    expect(await readFile(sentinel, 'utf8')).toBe('must not change\n')
    expect(await readFile(join(result.project.sources[0]!.path, 'src', 'config.ts'), 'utf8'))
      .toBe('export const limit = 120\n')
    expect(result.nextState.sources.product?.commit).toBe(head)
  })
})
