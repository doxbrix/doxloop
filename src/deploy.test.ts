import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { buildDeploymentBundle, deploy } from './deploy.js'
import { scaffoldProject } from './project.js'

const roots: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('deployment', () => {
  test('rejects malformed Doxbrix components before making a network request', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'doxloop-deploy-'))
    roots.push(parent)
    const root = await scaffoldProject({ directory: join(parent, 'docs'), sources: [] })
    await writeFile(
      join(root, 'index.mdx'),
      `---
title: List projects
description: List accessible projects.
---

<ApiEndpoint method="GET" path="/projects"
<Response status={200} contentType="application/json" description="Projects listed">
{ "data": [] }
</Response>
</ApiEndpoint>
`,
    )
    await writeFile(
      join(root, 'quickstart.mdx'),
      '---\ntitle: Quickstart\ndescription: Complete the first workflow.\n---\n\n# Quickstart\n\nComplete the first workflow and verify its result.\n',
    )
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    await expect(deploy({ root })).rejects.toThrow(
      'Deployment stopped because documentation has',
    )
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  test('dry run validates without making a network request', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'doxloop-deploy-'))
    roots.push(parent)
    const root = await scaffoldProject({ directory: join(parent, 'docs'), sources: [] })
    await writeFile(
      join(root, 'index.mdx'),
      '---\ntitle: Overview\ndescription: Understand the product.\n---\n\n# Overview\n\nChoose a workflow.\n',
    )
    await writeFile(
      join(root, 'quickstart.mdx'),
      '---\ntitle: Quickstart\ndescription: Complete the first workflow.\n---\n\n# Quickstart\n\nComplete the first workflow and verify its result.\n',
    )
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    await deploy({ root, dryRun: true })
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(output).toHaveBeenCalledWith(
      expect.stringContaining('Product sources excluded from deployment: 0'),
    )
    expect(output).toHaveBeenCalledWith(expect.stringContaining('No data was uploaded.'))
  })

  test('bundles pages, media, and the manifest with root-relative paths', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'doxloop-deploy-'))
    roots.push(parent)
    const root = await scaffoldProject({ directory: join(parent, 'docs'), sources: [] })
    await mkdir(join(root, 'assets'), { recursive: true })
    await writeFile(join(root, 'assets', 'logo.svg'), '<svg></svg>')

    const bundle = await buildDeploymentBundle(root, '')

    expect(bundle.basePath).toBe('')
    expect(bundle.pages.map((page) => page.path).sort()).toEqual([
      'index.mdx',
      'quickstart.mdx',
    ])
    expect(bundle.pages[0]?.markdown).toContain('---')
    expect(bundle.media).toEqual([
      {
        path: 'assets/logo.svg',
        base64: Buffer.from('<svg></svg>').toString('base64'),
      },
    ])
    expect(bundle.manifest).toMatchObject({ version: 1 })
  })

  test('rejects a symlinked deployment content directory', async () => {
    if (process.platform === 'win32') return
    const parent = await mkdtemp(join(tmpdir(), 'doxloop-deploy-'))
    roots.push(parent)
    const root = await scaffoldProject({
      directory: join(parent, 'docs'),
      sources: [],
    })
    const outside = join(parent, 'outside')
    await mkdir(outside)
    const projectPath = join(root, '.doxloop', 'project.json')
    const project = JSON.parse(await readFile(projectPath, 'utf8')) as Record<string, unknown>
    await writeFile(projectPath, `${JSON.stringify({ ...project, contentDir: 'docs' }, null, 2)}\n`)
    await symlink(outside, join(root, 'docs'))

    await expect(buildDeploymentBundle(root, 'docs')).rejects.toThrow(
      'cannot contain a symbolic link',
    )
  })

  test('rejects a deployment directory different from project configuration', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'doxloop-deploy-'))
    roots.push(parent)
    const root = await scaffoldProject({
      directory: join(parent, 'docs'),
      sources: [],
    })

    await expect(buildDeploymentBundle(root, 'other')).rejects.toThrow(
      'must match .doxloop/project.json',
    )
  })

  test('creates an unseeded Doxbrix project before pushing the bundle', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'doxloop-deploy-'))
    roots.push(parent)
    const root = await scaffoldProject({ directory: join(parent, 'docs'), sources: [] })
    await writeFile(
      join(root, 'index.mdx'),
      '---\ntitle: Overview\ndescription: Understand the product.\n---\n\n# Overview\n\nChoose a workflow.\n',
    )
    await writeFile(
      join(root, 'quickstart.mdx'),
      '---\ntitle: Quickstart\ndescription: Complete the first workflow.\n---\n\n# Quickstart\n\nComplete the first workflow and verify its result.\n',
    )
    vi.stubEnv('DOXLOOP_TOKEN', 'dxb_test')
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const requests: Array<{ url: string; init?: RequestInit }> = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input)
      requests.push({ url, init })
      if (init?.method === 'GET') return new Response(null, { status: 404 })
      if (url.endsWith('/api/v1/projects')) {
        return Response.json({
          project: { id: 'project-1', name: 'Docs', slug: 'docs' },
        }, { status: 201 })
      }
      return Response.json({
        result: {
          spaces: 1,
          pagesCreated: 2,
          pagesUpdated: 0,
          navItems: 3,
          warnings: [],
          affectedPageIds: [],
        },
      })
    })

    await deploy({ root, apiUrl: 'https://doxbrix.test' })

    const create = requests.find(
      (request) =>
        request.url === 'https://doxbrix.test/api/v1/projects' &&
        request.init?.method === 'POST',
    )
    expect(JSON.parse(String(create?.init?.body))).toMatchObject({
      name: 'Docs',
      slug: 'docs',
      visibility: 'private',
      seedTemplate: false,
    })
    const push = requests.find(
      (request) => request.url.endsWith('/api/v1/projects/docs/bundle'),
    )
    expect(JSON.parse(String(push?.init?.body))).toMatchObject({
      publish: true,
      replace: true,
    })
  })

  test('reports the rendered reader site Doxbrix hosts the project at', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'doxloop-deploy-'))
    roots.push(parent)
    const root = await scaffoldProject({ directory: join(parent, 'docs'), sources: [] })
    await writeFile(
      join(root, 'index.mdx'),
      '---\ntitle: Overview\ndescription: Understand the product.\n---\n\n# Overview\n\nChoose a workflow.\n',
    )
    await writeFile(
      join(root, 'quickstart.mdx'),
      '---\ntitle: Quickstart\ndescription: Complete the first workflow.\n---\n\n# Quickstart\n\nComplete the first workflow and verify its result.\n',
    )
    vi.stubEnv('DOXLOOP_TOKEN', 'dxb_test')
    const written: string[] = []
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      written.push(String(chunk))
      return true
    })
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input)
      if (url.endsWith('/api/v1/projects/docs') && init?.method === 'GET') {
        return Response.json({
          project: { id: 'project-1', name: 'Docs', slug: 'docs', hostedUrl: 'https://docs.host.test' },
        })
      }
      if (init?.method === 'GET') return new Response(null, { status: 404 })
      return Response.json({
        result: { spaces: 1, pagesCreated: 2, pagesUpdated: 0, navItems: 3, warnings: [], affectedPageIds: [] },
      })
    })

    await deploy({ root, apiUrl: 'https://doxbrix.test' })

    const output = written.join('')
    expect(output).toContain('https://docs.host.test')
    expect(output).not.toContain('/editor?project=')
  })

  test('builds, uploads, completes, and polls a static generator deployment', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'doxloop-deploy-'))
    roots.push(parent)
    const root = await scaffoldProject({
      directory: join(parent, 'docs'),
      sources: [],
      generator: 'static',
    })
    for (const page of [join(root, 'site', 'index.html'), join(root, 'site', 'quickstart', 'index.html')]) {
      await writeFile(page, (await readFile(page, 'utf8'))
        .replace('<!-- doxloop:starter-page -->', '')
        .replace('The authoring agent will replace this starter', 'This overview provides evidence-backed product guidance'))
    }
    vi.stubEnv('DOXLOOP_TOKEN', 'dxb_test')
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const requests: Array<{ url: string; init?: RequestInit }> = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input)
      requests.push({ url, init })
      if (url.endsWith('/api/v1/projects/docs') && init?.method === 'GET') return new Response(null, { status: 404 })
      if (url.endsWith('/api/v1/projects') && init?.method === 'POST') {
        return Response.json({ project: { id: 'project-1', name: 'Docs', slug: 'docs', kind: 'connected', source: 'bundle', generator: 'static', hostedUrl: 'https://docs.host.test' } }, { status: 201 })
      }
      if (url.endsWith('/deployments') && init?.method === 'POST') {
        return Response.json({ deployment: { buildId: 'build-1', status: 'uploading', upload: { url: 'https://upload.test/raw.zip', method: 'PUT', headers: { 'x-amz-checksum-sha256': 'checksum' }, expiresAt: new Date(Date.now() + 60_000).toISOString() } } }, { status: 201 })
      }
      if (url === 'https://upload.test/raw.zip') return new Response(null, { status: 200 })
      if (url.endsWith('/complete')) return Response.json({ deployment: { buildId: 'build-1', status: 'building' } }, { status: 202 })
      if (url.endsWith('/deployments/build-1')) {
        return Response.json({ deployment: { buildId: 'build-1', status: 'ready', fileCount: 3, pagesIndexed: 2, error: null, hostedUrl: 'https://docs.host.test' } })
      }
      return new Response(null, { status: 500 })
    })

    await deploy({ root, apiUrl: 'https://doxbrix.test' })

    const create = requests.find((request) => request.url.endsWith('/api/v1/projects') && request.init?.method === 'POST')
    expect(JSON.parse(String(create?.init?.body))).toMatchObject({
      connectedArtifact: { generator: 'static' },
      visibility: 'private',
    })
    const upload = requests.find((request) => request.url === 'https://upload.test/raw.zip')
    expect(upload?.init?.headers).toMatchObject({ 'x-amz-checksum-sha256': 'checksum' })
    expect(new Headers(upload?.init?.headers).has('authorization')).toBe(false)
    expect(requests.some((request) => request.url.endsWith('/complete'))).toBe(true)
  })

  test('makes an existing project public when requested', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'doxloop-deploy-'))
    roots.push(parent)
    const root = await scaffoldProject({ directory: join(parent, 'docs'), sources: [] })
    await writeFile(
      join(root, 'index.mdx'),
      '---\ntitle: Overview\ndescription: Understand the product.\n---\n\n# Overview\n\nChoose a workflow.\n',
    )
    await writeFile(
      join(root, 'quickstart.mdx'),
      '---\ntitle: Quickstart\ndescription: Complete the first workflow.\n---\n\n# Quickstart\n\nComplete the first workflow and verify its result.\n',
    )
    vi.stubEnv('DOXLOOP_TOKEN', 'dxb_test')
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const requests: Array<{ url: string; init?: RequestInit }> = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input)
      requests.push({ url, init })
      if (url.endsWith('/api/v1/projects/docs') && init?.method === 'GET') {
        return Response.json({
          project: {
            id: 'project-1',
            name: 'Docs',
            slug: 'docs',
            visibility: 'private',
          },
        })
      }
      if (url.endsWith('/settings') && init?.method === 'PATCH') {
        return Response.json({ settings: { visibility: 'public' } })
      }
      return Response.json({
        result: {
          spaces: 1,
          pagesCreated: 0,
          pagesUpdated: 2,
          navItems: 3,
          warnings: [],
        },
      })
    })

    await deploy({ root, public: true, apiUrl: 'https://doxbrix.test' })

    const visibilityUpdate = requests.find(
      (request) => request.url.endsWith('/api/v1/projects/project-1/settings'),
    )
    expect(visibilityUpdate?.init?.method).toBe('PATCH')
    expect(JSON.parse(String(visibilityUpdate?.init?.body))).toEqual({
      visibility: 'public',
    })
  })

  test('rejects symbolic links inside generated output', async () => {
    if (process.platform === 'win32') return
    const parent = await mkdtemp(join(tmpdir(), 'doxloop-deploy-'))
    roots.push(parent)
    const root = await scaffoldProject({ directory: join(parent, 'docs'), sources: [], generator: 'static' })
    for (const page of [join(root, 'site', 'index.html'), join(root, 'site', 'quickstart', 'index.html')]) {
      await writeFile(page, (await readFile(page, 'utf8'))
        .replace('<!-- doxloop:starter-page -->', '')
        .replace('The authoring agent will replace this starter', 'This overview provides evidence-backed product guidance'))
    }
    await symlink(join(root, 'site', 'styles.css'), join(root, 'site', 'linked.css'))

    await expect(deploy({ root, dryRun: true })).rejects.toThrow(
      'Symbolic links are not allowed',
    )
  })

  test('rejects likely secret files inside generated output', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'doxloop-deploy-'))
    roots.push(parent)
    const root = await scaffoldProject({ directory: join(parent, 'docs'), sources: [], generator: 'static' })
    for (const page of [join(root, 'site', 'index.html'), join(root, 'site', 'quickstart', 'index.html')]) {
      await writeFile(page, (await readFile(page, 'utf8'))
        .replace('<!-- doxloop:starter-page -->', '')
        .replace('The authoring agent will replace this starter', 'This overview provides evidence-backed product guidance'))
    }
    await writeFile(join(root, 'site', '.env.production'), 'SECRET=oops\n')

    await expect(deploy({ root, dryRun: true })).rejects.toThrow(
      'likely secret file',
    )
  })
})
