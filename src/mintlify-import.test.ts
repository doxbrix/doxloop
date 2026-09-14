import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { MintlifyImports } from './mintlify-import.js'
import { inspectExistingDocumentation, importExistingDocumentation } from './project-import.js'
import { loadProject, loadSiteConfig } from './project.js'
import { listPages } from './pages.js'
import { buildDeploymentBundle, deploy } from './deploy.js'
import { readPageContent, savePageContent } from './page-operations.js'
import { convertSourceTree } from '../vendor/doxbrix-import/dist/importer.js'
import { collectSourceFiles } from '../vendor/doxbrix-import/dist/docs/import.js'
import { listRemoteBranches, materializeRemoteSource } from './remote-source.js'

vi.mock('./remote-source.js', async (original) => ({
  ...await original<typeof import('./remote-source.js')>(),
  listRemoteBranches: vi.fn(),
  materializeRemoteSource: vi.fn(),
}))

let scratch: string
let imports: MintlifyImports
beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'doxloop-conversion-test-'))
  imports = new MintlifyImports()
  vi.stubEnv('DOXLOOP_HOME', join(scratch, 'home'))
})
afterEach(async () => {
  await imports.close()
  await rm(scratch, { recursive: true, force: true })
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

async function fixture(relative = 'original', extra = '') {
  const root = join(scratch, relative)
  await mkdir(join(root, 'images'), { recursive: true })
  await writeFile(join(root, 'docs.json'), JSON.stringify({
    name: 'Acme documentation',
    colors: { primary: '#123456' },
    logo: { light: '/images/logo.svg', dark: '/images/logo.svg' },
    navigation: { groups: [{ group: 'Start here', pages: ['intro'] }] },
    redirects: [{ source: '/old', destination: '/intro' }],
  }))
  await writeFile(join(root, 'intro.mdx'), '---\ntitle: Introduction\ndescription: Learn how to start using Acme.\n---\n\n# Introduction\n\nWelcome to Acme.\n\n<Info>Keep this information.</Info>\n\n<Tabs><Tab title="Node">Use Node.</Tab><Tab title="Python">Use Python.</Tab></Tabs>\n\n![Logo](/images/logo.svg)\n' + extra)
  await writeFile(join(root, 'images/logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="blue"/></svg>')
  return root
}

describe('Mintlify conversion into a Doxloop project', () => {
  test('uses the original converter output, freezes the preview, and supports editing and Doxbrix deployment', async () => {
    const source = await fixture()
    const original = await readFile(join(source, 'intro.mdx'), 'utf8')
    const expected = convertSourceTree(collectSourceFiles(source))
    const report = await imports.inspect({ path: source }, scratch)
    expect(report).toMatchObject({ pageCount: 1, assetCount: 1, unmapped: [], warnings: [] })
    expect(await readdir(source)).toEqual(expect.arrayContaining(['docs.json', 'intro.mdx', 'images']))
    expect(await readdir(source)).not.toContain('.doxloop')
    // A concurrent source edit cannot silently change the conversion the user reviewed.
    await writeFile(join(source, 'intro.mdx'), original + '\nA later original edit.\n')
    const root = join(scratch, 'converted')
    await imports.convert(report.id, root)
    expect(await readFile(join(root, 'intro.mdx'), 'utf8')).toBe(expected.pages[0]!.markdown)
    expect(await readFile(join(source, 'intro.mdx'), 'utf8')).toBe(original + '\nA later original edit.\n')
    expect(await loadProject(root)).toMatchObject({ generator: 'doxbrix', contentDir: '', sources: [], title: 'Acme documentation' })
    const pages = await listPages(root)
    expect(pages).toHaveLength(1)
    expect(pages[0]).toMatchObject({ path: 'intro.mdx', evidence: 'needs-review' })
    expect(await loadSiteConfig(root, await loadProject(root))).toMatchObject({ ...expected.manifest, redirects: [{ from: '/old', to: '/intro' }] })
    const content = await readPageContent(root, 'intro.mdx')
    await savePageContent(root, { ...content, content: content.content + '\nAn updated instruction.\n' })
    const bundle = await buildDeploymentBundle(root, '')
    expect(bundle.pages[0]!.markdown).toContain('An updated instruction.')
    expect(bundle.media.map((asset) => asset.path)).toEqual(['images/logo.svg'])
    expect(JSON.stringify(bundle)).not.toContain('mintlify-import.json')
    const fetch = vi.spyOn(globalThis, 'fetch')
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    await deploy({ root, dryRun: true })
    expect(fetch).not.toHaveBeenCalled()
  })

  test('detects Mintlify and prevents adopting it as a native Doxbrix project', async () => {
    const source = await fixture()
    expect(await inspectExistingDocumentation(source)).toMatchObject({ conversion: 'mintlify' })
    await expect(importExistingDocumentation({ directory: source, generator: 'doxbrix', contentDir: '' })).rejects.toThrow('must be converted')
    expect(await readdir(source)).not.toContain('.doxloop')
    await writeFile(join(source, 'docs.json'), JSON.stringify({ title: 'Legacy Doxbrix', navigation: ['intro'] }))
    const legacy = await inspectExistingDocumentation(source)
    expect(legacy.conversion).toBeUndefined()
    expect(legacy.generator).toBe('doxbrix')
  })

  test('preserves the Mintlify version catalog and space stamps through adoption and deployment', async () => {
    const source = await fixture()
    const config = JSON.parse(await readFile(join(source, 'docs.json'), 'utf8'))
    config.navigation = { versions: [
      { version: 'v2', default: true, tabs: [{ tab: 'Guides', pages: ['intro'] }] },
      { version: 'v1', tabs: [{ tab: 'Guides', pages: ['old'] }] },
    ] }
    await writeFile(join(source, 'docs.json'), JSON.stringify(config))
    await writeFile(join(source, 'old.mdx'), '---\ntitle: Old docs\ndescription: Use version one.\n---\nVersion one content.')
    const report = await imports.inspect({ path: source }, scratch)
    const root = join(scratch, 'versioned')
    await imports.convert(report.id, root)
    const site = await loadSiteConfig(root, await loadProject(root))
    expect(site.versions).toEqual([{ version: 'v2', label: 'v2', isDefault: true }, { version: 'v1', label: 'v1' }])
    expect(site.spaces.map((space) => space.version)).toEqual(['v2', 'v1'])
    expect((await buildDeploymentBundle(root, '')).manifest).toMatchObject({ versions: site.versions, spaces: site.spaces })
  })

  test('reports navigated repository files excluded by the upstream converter before import', async () => {
    const source = await fixture()
    const config = JSON.parse(await readFile(join(source, 'docs.json'), 'utf8'))
    config.navigation.groups[0].pages.push('AGENTS')
    await writeFile(join(source, 'docs.json'), JSON.stringify(config))
    await writeFile(join(source, 'AGENTS.md'), '# Agent documentation\nExisting content.')
    const report = await imports.inspect({ path: source }, scratch)
    expect(report.warnings).toEqual([expect.stringContaining('absent from the converted output: AGENTS')])
    await expect(imports.convert(report.id, join(scratch, 'converted'))).rejects.toThrow('acknowledge')
  })

  test('materializes navigation-generated OpenAPI pages through the CLI pipeline', async () => {
    const source = await fixture()
    await writeFile(join(source, 'docs.json'), JSON.stringify({ name: 'Acme API', navigation: { groups: [{ group: 'API', openapi: 'openapi.json' }] } }))
    await writeFile(join(source, 'openapi.json'), JSON.stringify({
      openapi: '3.1.0', info: { title: 'Acme API', version: '1' },
      servers: [{ url: 'https://api.example.com' }],
      paths: { '/widgets': { get: { summary: 'List widgets', description: 'Retrieve the widgets.', responses: { '200': { description: 'The widgets.' } } } } },
    }))
    const report = await imports.inspect({ path: source }, scratch)
    expect(report.warnings).toEqual([])
    expect(report.pageCount).toBeGreaterThan(1)
    const output = join(scratch, 'converted')
    await imports.convert(report.id, output)
    const bundle = await buildDeploymentBundle(output, '')
    expect(bundle.pages.some((page) => /<ApiEndpoint\b/.test(page.markdown) && page.markdown.includes('/widgets'))).toBe(true)
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    await deploy({ root: output, dryRun: true })
  })

  test('reports unavailable remote API definitions without fetching private-network URLs', async () => {
    const source = await fixture()
    await writeFile(join(source, 'docs.json'), JSON.stringify({ name: 'Acme API', navigation: { groups: [{ group: 'Overview', pages: ['intro'] }, { group: 'API', openapi: 'http://127.0.0.1/private.json' }] } }))
    const fetch = vi.spyOn(globalThis, 'fetch')
    const report = await imports.inspect({ path: source }, scratch)
    expect(report.warnings.length).toBeGreaterThan(0)
    expect(fetch).not.toHaveBeenCalled()
    await expect(imports.convert(report.id, join(scratch, 'converted'))).rejects.toThrow('acknowledge')
  })

  test('requires acknowledgement for unsupported constructs and preserves the report', async () => {
    const source = await fixture('original', '\n<UnknownWidget />\n')
    const report = await imports.inspect({ path: source }, scratch)
    expect(report.unmapped).toContain('<UnknownWidget>')
    const output = join(scratch, 'converted')
    await expect(imports.convert(report.id, output)).rejects.toThrow('acknowledge')
    await expect(readdir(output)).rejects.toThrow()
    await imports.convert(report.id, output, true)
    expect(JSON.parse(await readFile(join(output, '.doxloop/mintlify-import.json'), 'utf8')).unmapped).toContain('<UnknownWidget>')
  })

  test('refuses existing destinations, the source tree, and symlink aliases', async () => {
    const source = await fixture()
    const report = await imports.inspect({ path: source }, scratch)
    await expect(imports.convert(report.id, source)).rejects.toThrow('outside')
    await expect(imports.convert(report.id, join(source, 'converted'))).rejects.toThrow('outside')
    await expect(imports.convert(report.id, join(source, '..converted'))).rejects.toThrow('outside')
    const alias = join(scratch, 'alias')
    await symlink(source, alias, 'dir')
    await expect(imports.convert(report.id, join(alias, 'converted'))).rejects.toThrow('outside')
    const occupied = join(scratch, 'occupied')
    await mkdir(occupied)
    await writeFile(join(occupied, 'keep.txt'), 'User content')
    await expect(imports.convert(report.id, occupied)).rejects.toThrow('already exists')
    expect(await readFile(join(occupied, 'keep.txt'), 'utf8')).toBe('User content')
    await imports.discard(report.id)
    await expect(imports.convert(report.id, join(scratch, 'converted'))).rejects.toThrow('expired')
  })

  test('automatically finds a nested site and asks for a subfolder when ambiguous', async () => {
    await fixture('repo/website/docs')
    const root = join(scratch, 'repo')
    const report = await imports.inspect({ path: root }, scratch)
    expect(report.source.subdirectory).toBe('website/docs')
    expect(report.suggestedDestination).toBe(join(await realpath(scratch), 'docs-doxbrix'))
    await imports.discard(report.id)
    await fixture('repo/other')
    await expect(imports.inspect({ path: root }, scratch)).rejects.toThrow('Several Mintlify sites')
    expect((await imports.inspect({ path: root, subdirectory: 'other' }, scratch)).pageCount).toBe(1)
    await expect(imports.inspect({ path: root, subdirectory: '../' }, scratch)).rejects.toThrow()
  })

  test('uses a GitHub default branch snapshot and records its commit without credentials', async () => {
    const source = await fixture()
    vi.mocked(listRemoteBranches).mockResolvedValue([{ name: 'release', head: 'a'.repeat(40) }])
    vi.mocked(materializeRemoteSource).mockResolvedValue({ path: source, head: 'a'.repeat(40), files: 3 })
    const report = await imports.inspect({ repository: 'team/docs' }, scratch)
    expect(report.source).toEqual({ repository: 'https://github.com/team/docs.git', branch: 'release', head: 'a'.repeat(40) })
    expect(materializeRemoteSource).toHaveBeenCalledWith(expect.any(String), { name: 'mintlify', remote: { provider: 'git', repository: 'https://github.com/team/docs.git', branch: 'release' } })
    await imports.convert(report.id, join(scratch, 'converted'))
    expect(JSON.stringify(report)).not.toMatch(/secret|token/)
    await expect(imports.inspect({ repository: 'https://user:secret@github.com/team/docs' }, scratch)).rejects.toThrow('GitHub repository')
  })

  test('keeps the imported upstream modules byte-for-byte identical to their recorded snapshot', async () => {
    const vendor = resolve('vendor/doxbrix-import')
    const manifest = JSON.parse(await readFile(join(vendor, 'UPSTREAM.json'), 'utf8')) as { files: Array<{ file: string; sha256: string }> }
    for (const file of manifest.files) {
      expect(createHash('sha256').update(await readFile(join(vendor, 'src', file.file))).digest('hex'), file.file).toBe(file.sha256)
    }
  })
})
