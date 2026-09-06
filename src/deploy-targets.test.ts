import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { netlifyTarget } from './deploy-targets/netlify.js'
import { githubPagesTarget } from './deploy-targets/github-pages.js'
import type { DeployBundle } from './deploy-targets/types.js'
import { vercelTarget } from './deploy-targets/vercel.js'

const roots: string[] = []
const execute = promisify(execFile)

afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function bundle(): Promise<DeployBundle> {
  const root = await mkdtemp(join(tmpdir(), 'doxloop-target-'))
  roots.push(root)
  await mkdir(join(root, 'guide'))
  await writeFile(join(root, 'index.html'), '<h1>Docs</h1>')
  await writeFile(join(root, 'guide', 'index.html'), '<h1>Guide</h1>')
  return { outputDir: root, archive: new Uint8Array([1, 2, 3]), files: 2, bytes: 3, sha256: 'abc' }
}

describe('static deploy targets', () => {
  test('uploads a zip to the Netlify deploy endpoint', async () => {
    vi.stubEnv('DOXLOOP_NETLIFY_TOKEN', 'netlify-secret')
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ id: 'deploy-1', deploy_ssl_url: 'https://docs.netlify.app', state: 'ready' }))
    const result = await netlifyTarget.publish(await bundle(), { root: '.', name: 'Docs', slug: 'docs', siteId: 'site-1', apiUrl: 'https://api.netlify.test' })
    expect(result.url).toBe('https://docs.netlify.app')
    expect(fetchSpy).toHaveBeenCalledWith('https://api.netlify.test/api/v1/sites/site-1/deploys', expect.objectContaining({ method: 'POST', headers: expect.objectContaining({ Authorization: 'Bearer netlify-secret', 'Content-Type': 'application/zip' }) }))
  })

  test('uploads Vercel files by digest before creating the deployment', async () => {
    vi.stubEnv('DOXLOOP_VERCEL_TOKEN', 'vercel-secret')
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => String(input).includes('/v2/files') ? Response.json({}) : Response.json({ id: 'deploy-2', url: 'docs.vercel.app', readyState: 'READY' }))
    const result = await vercelTarget.publish(await bundle(), { root: '.', name: 'Docs', slug: 'docs', projectId: 'docs-project', teamId: 'team-1', apiUrl: 'https://api.vercel.test' })
    expect(result.url).toBe('https://docs.vercel.app')
    const uploadCalls = fetchSpy.mock.calls.filter(([input]) => String(input).includes('/v2/files'))
    expect(uploadCalls).toHaveLength(2)
    expect(new Headers(uploadCalls[0]?.[1]?.headers).get('x-vercel-digest')).toMatch(/^[a-f0-9]{40}$/)
    const [, init] = fetchSpy.mock.calls.find(([input]) => String(input).includes('/v13/deployments'))!
    const body = JSON.parse(String(init?.body)) as { files: Array<{ file: string; sha: string; size: number }> }
    expect(body.files.map((file) => file.file)).toEqual(['guide/index.html', 'index.html'])
    expect(body.files.every((file) => 'sha' in file && 'size' in file)).toBe(true)
  })

  test('publishes static output to a gh-pages branch', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'doxloop-github-pages-'))
    roots.push(parent)
    const project = join(parent, 'project')
    const remote = join(parent, 'remote.git')
    await mkdir(project)
    await execute('git', ['init', '-b', 'main'], { cwd: project })
    await writeFile(join(project, 'README.md'), '# Project\n')
    await execute('git', ['add', '.'], { cwd: project })
    await execute('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'initial'], { cwd: project })
    await execute('git', ['init', '--bare', remote])
    await execute('git', ['remote', 'add', 'origin', remote], { cwd: project })
    await execute('git', ['push', '-u', 'origin', 'main'], { cwd: project })

    const result = await githubPagesTarget.publish(await bundle(), { root: project, name: 'Docs', slug: 'docs' })
    expect(result.id).toMatch(/^[a-f0-9]{40}$/)
    const published = await execute('git', [`--git-dir=${remote}`, 'show', 'gh-pages:index.html'])
    expect(published.stdout).toContain('<h1>Docs</h1>')
    const second = await githubPagesTarget.publish(await bundle(), { root: project, name: 'Docs', slug: 'docs' })
    const previous = await execute('git', [`--git-dir=${remote}`, 'rev-parse', `${second.id}^`])
    expect(previous.stdout.trim()).toBe(result.id)
    await expect(githubPagesTarget.configure({ root: project, name: 'Docs', slug: 'docs', branch: 'main' })).rejects.toThrow('Source branches')
    await execute('git', ['push', 'origin', 'main:refs/heads/doxloop-pages/existing'], { cwd: project })
    const before = (await execute('git', [`--git-dir=${remote}`, 'rev-parse', 'doxloop-pages/existing'])).stdout
    await expect(githubPagesTarget.publish(await bundle(), { root: project, name: 'Docs', slug: 'docs', branch: 'doxloop-pages/existing' })).rejects.toThrow('not owned')
    expect((await execute('git', [`--git-dir=${remote}`, 'rev-parse', 'doxloop-pages/existing'])).stdout).toBe(before)
  })
})
