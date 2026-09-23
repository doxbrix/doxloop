import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import type { DocsSiteSnapshot } from './docs-crawl.js'
import { docsSiteBinding, docsSitePageFile, existingDocumentationRedirects, materializeDocsSiteSnapshot, readDocsSiteManifest } from './docs-site.js'
import { loadProject, saveProjectSettings, scaffoldProject, validateProjectSourceBoundaries } from './project.js'
import { discoverDocumentationSources } from './source-discovery.js'
import { connectorForSource, sourceHealth } from './source-connectors.js'
import { collectSourceChanges, formatSourceChanges, recordSyncState } from './sync.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })

function snapshot(overrides: Partial<DocsSiteSnapshot> = {}): DocsSiteSnapshot {
  const pages = [
    { url: 'https://docs.example.com/', path: '', title: 'Home', headings: [{ level: 1, text: 'Home' }], words: 4, internalLinks: ['https://docs.example.com/guide/install'], externalLinks: [], images: [], markdown: '# Home\n\nWelcome to the docs.', hash: 'h1', fetchedAt: '2026-09-14T00:00:00.000Z' },
    { url: 'https://docs.example.com/guide/install', path: 'guide/install', title: 'Install', description: 'Install it', headings: [{ level: 1, text: 'Install' }], words: 3, internalLinks: [], externalLinks: [], images: [], markdown: '# Install\n\nRun `make`.', hash: 'h2', fetchedAt: '2026-09-14T00:00:00.000Z' },
  ]
  return {
    schemaVersion: 1, url: 'https://docs.example.com/', origin: 'https://docs.example.com', scope: '/', crawledAt: '2026-09-14T00:00:00.000Z', generator: 'docusaurus',
    discovery: ['sitemap', 'links'], pageLimit: 150, truncated: false, pages, skipped: [], brokenLinks: [{ url: 'https://docs.example.com/gone', from: 'https://docs.example.com/', status: 404 }], warnings: [],
    totals: { pages: 2, words: 7, images: 0, discovered: 3 }, hash: 'abcdef1234567890', ...overrides,
  }
}

async function project(): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), 'doxloop-docs-site-'))
  roots.push(parent)
  const root = join(parent, 'docs')
  await scaffoldProject({ directory: root, sources: [], generator: 'doxbrix' })
  return root
}

describe('docs-site snapshots', () => {
  test('page files keep the site structure and sanitize segments', () => {
    expect(docsSitePageFile('')).toBe('pages/index.md')
    expect(docsSitePageFile('guide/install')).toBe('pages/guide/install.md')
    expect(docsSitePageFile('guide/../weird name.html')).toBe('pages/guide/weird-name.md')
  })

  test('materializes a snapshot outside the project and binds it as a docs-site source', async () => {
    const root = await project()
    const materialized = await materializeDocsSiteSnapshot(root, 'legacy', snapshot())
    expect(materialized.path).toContain('.doxloop-sources')
    expect(materialized.path.startsWith(root)).toBe(false)
    expect(await readdir(materialized.path)).toEqual(expect.arrayContaining(['index.md', 'pages', 'snapshot.json']))
    const install = await readFile(join(materialized.path, 'pages', 'guide', 'install.md'), 'utf8')
    expect(install).toContain('title: "Install"')
    expect(install).toContain('url: "https://docs.example.com/guide/install"')
    expect(install).toContain('# Install\n\nRun `make`.')
    const index = await readFile(join(materialized.path, 'index.md'), 'utf8')
    expect(index).toContain('| pages/guide/install.md | Install | 3 | https://docs.example.com/guide/install |')
    expect(index).toContain('## Broken internal links (1)')

    const binding = docsSiteBinding(root, 'legacy', materialized)
    expect(binding).toMatchObject({ name: 'legacy', kind: 'docs-site', site: { url: 'https://docs.example.com/', pages: 2, words: 7, generator: 'docusaurus', hash: 'abcdef1234567890' } })
    await validateProjectSourceBoundaries(root, [binding])
    await saveProjectSettings(root, { sources: [binding] })
    const loaded = await loadProject(root)
    expect(loaded.sources[0]!.site?.url).toBe('https://docs.example.com/')
    const manifest = await readDocsSiteManifest(root, binding)
    expect(manifest.pages.map((page) => page.file)).toEqual(['pages/index.md', 'pages/guide/install.md'])
    expect(manifest.pages[0]).not.toHaveProperty('markdown')
  })

  test('reports health, inventories pages for discovery, and detects a re-crawl through the sync baseline', async () => {
    const root = await project()
    const materialized = await materializeDocsSiteSnapshot(root, 'legacy', snapshot())
    const binding = docsSiteBinding(root, 'legacy', materialized)
    await saveProjectSettings(root, { sources: [binding] })

    const [health] = await sourceHealth(root, [binding])
    expect(health).toMatchObject({ connector: 'docs-site', status: 'healthy', provider: 'https', monitored: false, location: 'https://docs.example.com/', docsSite: { pages: 2, brokenLinks: 1 } })
    expect(health!.summary).toBe('2 pages · crawled 2026-09-14 · docusaurus')
    expect((await connectorForSource(binding).inventory(root, binding)).identifiers).toEqual(['pages/guide/install.md', 'pages/index.md'])

    const { inventory } = await discoverDocumentationSources(root)
    const source = inventory.sources.find((item) => item.name === 'legacy')!
    expect(source.kind).toBe('docs-site')
    expect(source.location).toBe('https://docs.example.com/')
    expect(source.evidence.map((item) => [item.kind, item.path, item.label])).toEqual([
      ['documentation', 'index.md', 'Existing documentation site https://docs.example.com/ (2 pages)'],
      ['documentation', 'pages/index.md', 'Home'],
      ['documentation', 'pages/guide/install.md', 'Install'],
    ])
    expect(inventory.totals.publicSignals).toBe(0)

    expect(formatSourceChanges(await collectSourceChanges(root, [binding]))).toContain('existing documentation site, crawled into the read-only snapshot')
    await recordSyncState(root, [binding])
    expect((await collectSourceChanges(root, [binding]))[0]).toMatchObject({ kind: 'unchanged', baseline: 'docs-site' })

    const recrawled = await materializeDocsSiteSnapshot(root, 'legacy', snapshot({ hash: 'fedcba0987654321', pages: [snapshot().pages[0]!, { ...snapshot().pages[1]!, markdown: '# Install\n\nRun `make install`.', hash: 'h3' }] }))
    const next = docsSiteBinding(root, 'legacy', recrawled)
    expect(next.path).not.toBe(binding.path)
    const [change] = await collectSourceChanges(root, [next])
    expect(change).toMatchObject({ kind: 'changed', baseline: 'docs-site', changedFiles: ['M\tpages/guide/install.md', 'M\tsnapshot.json'] })
    expect(formatSourceChanges([change!])).toContain('re-crawled and these snapshot pages changed')
  })

  test('rejects an uncrawled docs-site binding and a missing snapshot', async () => {
    const root = await project()
    await expect(validateProjectSourceBoundaries(root, [{ name: 'legacy', path: 'https://docs.example.com/', kind: 'docs-site' }])).rejects.toThrow('has not been crawled yet')
    await expect(validateProjectSourceBoundaries(root, [{ name: 'legacy', path: '../nowhere', kind: 'docs-site' }])).rejects.toThrow('snapshot for source "legacy" is missing')
  })

  test('derives redirects from page dispositions, skipping drops, identical routes, the site root, and routes that are new pages', () => {
    const redirects = existingDocumentationRedirects({
      pages: [
        { id: 'install', title: 'Install', path: 'getting-started/install', type: 'how-to', priority: 'must-have', action: 'create', purpose: '', rationale: '', evidence: [], evidenceDetails: [] },
        { id: 'home', title: 'Home', path: 'index', type: 'getting-started', priority: 'must-have', action: 'create', purpose: '', rationale: '', evidence: [], evidenceDetails: [] },
        { id: 'faq', title: 'FAQ', path: 'faq', type: 'other', priority: 'must-have', action: 'create', purpose: '', rationale: '', evidence: [], evidenceDetails: [] },
        { id: 'gone', title: 'Gone', path: 'gone', type: 'other', priority: 'must-have', action: 'remove', purpose: '', rationale: '', evidence: [], evidenceDetails: [] },
      ],
      existingDocumentation: [{
        source: 'legacy', summary: '', strengths: [], findings: [], coverage: { gaps: [], obsolete: [], preserved: [], contradicted: [] },
        pages: [
          { path: 'pages/guide/install.md', url: 'https://docs.example.com/guide/install', disposition: 'rewrite', into: ['install'], reason: '' },
          { path: 'pages/faq.md', url: 'https://docs.example.com/faq/', disposition: 'preserve', into: ['faq'], reason: '' },
          { path: 'pages/old.md', url: 'https://docs.example.com/old', disposition: 'drop', into: [], reason: 'obsolete' },
          { path: 'pages/legacy.md', disposition: 'merge', into: ['gone', 'home'], reason: '' },
          { path: 'pages/orphan.md', disposition: 'merge', into: ['unknown-id'], reason: '' },
          { path: 'pages/index.md', url: 'https://docs.example.com/', disposition: 'merge', into: ['install'], reason: 'the root always serves the new homepage' },
        ],
      }],
    })
    expect(redirects).toEqual({ '/guide/install': '/getting-started/install', '/legacy': '/' })
  })
})
