import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  changedFilesInRemoteScope,
  listRemoteBranches,
  listRemoteDirectories,
  materializeRemoteSource,
  parseGitRepository,
  parseGitHubRepository,
  rememberRemoteCredential,
  remoteCredentialEnvironment,
} from './remote-source.js'
import { recordSyncState } from './sync.js'
import type { RemoteSource } from './types.js'

const roots: string[] = []

afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('managed GitHub sources', () => {
  test('normalizes supported repository inputs and rejects unrelated URLs', () => {
    expect(parseGitHubRepository('https://github.com/acme/product.git')).toBe('acme/product')
    expect(parseGitHubRepository('git@github.com:acme/product.git')).toBe('acme/product')
    expect(parseGitHubRepository('acme/product')).toBe('acme/product')
    expect(() => parseGitHubRepository('https://gitlab.com/acme/product')).toThrow(/GitHub repository URL/)
  })

  test('lists branches and materializes a monorepo subdirectory outside the docs project', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'doxloop-git-source-'))
    roots.push(parent)
    const root = join(parent, 'docs')
    await mkdir(join(root, '.doxloop'), { recursive: true })
    const head = 'a'.repeat(40)
    const remote: RemoteSource = {
      provider: 'github', repository: 'acme/product', branch: 'main', subdirectory: 'packages/api',
    }
    const archive = zipSync({
      [`acme-product-${head}/README.md`]: strToU8('# Product\n'),
      [`acme-product-${head}/packages/api/src/index.ts`]: strToU8('export const api = true\n'),
    })
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      const url = String(input)
      if (url.includes('/branches?')) {
        return new Response(JSON.stringify([
          { name: 'main', commit: { sha: head } },
          { name: 'release', commit: { sha: 'b'.repeat(40) } },
        ]), { status: 200 })
      }
      if (url.includes('/branches/main')) {
        return new Response(JSON.stringify({ name: 'main', commit: { sha: head } }), { status: 200 })
      }
      return new Response(archive, { status: 200 })
    }))

    expect(await listRemoteBranches(remote)).toEqual([
      { name: 'main', head },
      { name: 'release', head: 'b'.repeat(40) },
    ])
    const prepared = await materializeRemoteSource(root, { name: 'product', remote })
    expect(prepared.path).not.toContain(`${join(parent, 'docs')}/`)
    expect(prepared.path).toContain(`${join(parent, '.doxloop-sources')}/`)
    expect(await readFile(join(prepared.path, 'src', 'index.ts'), 'utf8')).toContain('api = true')

    const state = await recordSyncState(root, [{ name: 'product', path: prepared.path, remote }])
    expect(state.sources.product?.commit).toBe(head)
  })

  test('filters provider changes to the configured subdirectory', () => {
    expect(changedFilesInRemoteScope([
      'M\tREADME.md',
      'M\tpackages/api/src/index.ts',
      'A\tpackages/web/src/index.ts',
    ], 'packages/api')).toEqual(['M\tsrc/index.ts'])
  })
})

describe('provider-neutral Git sources', () => {
  test('forwards private credentials to child processes for the current UI session', () => {
    const repository = 'https://github.com/acme/private-product/'
    rememberRemoteCredential(repository, 'acme-user', 'read-only-token')

    const serialized = remoteCredentialEnvironment().DOXLOOP_SESSION_GIT_CREDENTIALS
    expect(serialized).toBeTypeOf('string')
    expect(JSON.parse(serialized!)).toEqual({
      'https://github.com/acme/private-product': {
        username: 'acme-user',
        secret: 'read-only-token',
      },
    })

    rememberRemoteCredential(repository, undefined, undefined)
    expect(remoteCredentialEnvironment()).toEqual({})
  })

  test('loads every branch and materializes repositories through standard Git', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'doxloop-generic-git-'))
    roots.push(parent)
    const repository = join(parent, 'repository')
    const root = join(parent, 'docs')
    await mkdir(repository, { recursive: true })
    await mkdir(join(root, '.doxloop'), { recursive: true })
    execFileSync('git', ['init', '-b', 'main'], { cwd: repository })
    execFileSync('git', ['config', 'user.email', 'test@doxloop.local'], { cwd: repository })
    execFileSync('git', ['config', 'user.name', 'Doxloop Test'], { cwd: repository })
    await writeFile(join(repository, 'README.md'), '# Generic Git\n')
    await mkdir(join(repository, 'packages', 'api'), { recursive: true })
    await writeFile(join(repository, 'packages', 'api', 'index.ts'), 'export const api = true\n')
    execFileSync('git', ['add', 'README.md'], { cwd: repository })
    execFileSync('git', ['add', 'packages/api/index.ts'], { cwd: repository })
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: repository })
    execFileSync('git', ['branch', 'release'], { cwd: repository })

    const repositoryUrl = parseGitRepository(`file://${repository}`)
    const remote: RemoteSource = { provider: 'git', repository: repositoryUrl, branch: 'main' }
    expect((await listRemoteBranches(remote)).map((branch) => branch.name)).toEqual(['main', 'release'])
    expect(await listRemoteDirectories(remote)).toEqual(['packages', 'packages/api'])
    const prepared = await materializeRemoteSource(root, { name: 'product', remote })
    expect(await readFile(join(prepared.path, 'README.md'), 'utf8')).toContain('Generic Git')
    expect(prepared.files).toBe(2)
  })

  test('accepts common hosted Git URLs and rejects embedded passwords', () => {
    expect(parseGitRepository('https://gitlab.com/acme/product.git')).toContain('gitlab.com')
    expect(parseGitRepository('git@ssh.dev.azure.com:v3/acme/project/repository')).toContain('azure.com')
    expect(() => parseGitRepository('https://user:secret@git.example.com/product.git')).toThrow(/clone URL/)
  })
})
