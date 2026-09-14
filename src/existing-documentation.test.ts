import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { authorPrompt, existingDocumentationGuidance } from './author.js'
import type { DocsSiteSnapshot } from './docs-crawl.js'
import { docsSiteBinding, materializeDocsSiteSnapshot } from './docs-site.js'
import {
  applyDocumentationPlanProposal,
  approveDocumentationPlan,
  createDocumentationPlan,
  existingDocumentationAdvisory,
  existingDocumentationPlanIssue,
  existingDocumentationPlanShape,
  existingDocumentationPlanningInstructions,
  existingDocumentationWritingRequirements,
} from './documentation-plan.js'
import { saveProjectSettings, scaffoldProject } from './project.js'
import type { DocumentationPlan, SourceBinding } from './types.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })

const docsSite: SourceBinding = { name: 'legacy', path: '../.doxloop-sources/x/legacy/docs-abc', kind: 'docs-site', site: { url: 'https://docs.example.com/', crawledAt: '2026-09-14T00:00:00.000Z', pages: 2, words: 7, hash: 'abc', generator: 'docusaurus' } }
const product: SourceBinding = { name: 'product', path: '../product' }
const discovery = { sources: [{ name: 'legacy', kind: 'docs-site' as const, location: 'https://docs.example.com/', revision: 'abc', filesScanned: 2, filesAvailable: 2, truncated: false, languages: ['Markdown'], packageNames: [], evidence: [
  { source: 'legacy', path: 'index.md', kind: 'documentation' as const, label: 'Existing documentation site https://docs.example.com/ (2 pages)' },
  { source: 'legacy', path: 'pages/index.md', kind: 'documentation' as const, label: 'Home' },
  { source: 'legacy', path: 'pages/guide/install.md', kind: 'documentation' as const, label: 'Install' },
], uiLabelCatalogs: [], warnings: [] }] }

function snapshot(): DocsSiteSnapshot {
  return {
    schemaVersion: 1, url: 'https://docs.example.com/', origin: 'https://docs.example.com', scope: '/', crawledAt: '2026-09-14T00:00:00.000Z', generator: 'docusaurus', discovery: ['sitemap'], pageLimit: 150, truncated: false,
    pages: [
      { url: 'https://docs.example.com/', path: '', title: 'Home', headings: [], words: 2, internalLinks: [], externalLinks: [], images: [], markdown: '# Home', hash: 'h1', fetchedAt: '2026-09-14T00:00:00.000Z' },
      { url: 'https://docs.example.com/guide/install', path: 'guide/install', title: 'Install', headings: [], words: 2, internalLinks: [], externalLinks: [], images: [], markdown: '# Install', hash: 'h2', fetchedAt: '2026-09-14T00:00:00.000Z' },
    ],
    skipped: [], brokenLinks: [], warnings: [], totals: { pages: 2, words: 4, images: 0, discovered: 2 }, hash: 'abcdef1234567890',
  }
}

const assessment = {
  source: 'legacy',
  summary: 'Accurate but shallow; installation is split across three pages.',
  strengths: ['Clear terminology'],
  findings: [{ severity: 'major', title: 'No troubleshooting', description: 'Readers have nowhere to go when install fails.', pages: ['pages/guide/install.md'] }, { severity: 'weird', title: 'Untyped finding' }],
  coverage: { gaps: ['CLI export command'], obsolete: ['Legacy v1 API page'], preserved: ['Reverse proxy notes'], contradicted: ['Default port is 5230, not 8080'] },
  pages: [
    { path: 'pages/index.md', title: 'Home', url: 'https://docs.example.com/', disposition: 'rewrite', into: ['home'], reason: 'Landing page.' },
    { path: 'pages/guide/install.md', title: 'Install', url: 'https://docs.example.com/guide/install', disposition: 'merge', into: ['install', 'unknown-page'], reason: 'Folded into the install guide.' },
    { path: 'pages/old.md', disposition: 'drop', into: ['install'], reason: 'Obsolete.' },
    { path: 'pages/orphan.md', disposition: 'rewrite', into: ['unknown-page'], reason: '' },
    { disposition: 'rewrite', into: ['home'] },
  ],
}

const proposal = {
  productProfile: 'Note-taking service',
  summary: 'Rewrite the existing documentation from the product source.',
  audiences: ['Self-hosters'],
  outcomes: ['Install the service'],
  terminology: {},
  exclusions: ['Scope exception: the fixture exposes two pages.'],
  instructions: 'Keep the terminology readers know.',
  estimatedEffort: 'small',
  capabilities: [{ id: 'install', title: 'Install', kind: 'workflow', evidence: [{ source: 'product', path: 'README.md', kind: 'documentation', label: 'Install' }], pageIds: ['install'], disposition: 'planned' }],
  pages: [
    { id: 'home', title: 'Overview', path: 'index', type: 'getting-started', priority: 'must-have', action: 'create', purpose: 'Orient readers.', rationale: 'Landing page.', evidence: ['legacy: pages/index.md'], evidenceDetails: [{ source: 'legacy', path: 'pages/index.md', kind: 'documentation', label: 'Home' }] },
    { id: 'install', title: 'Install', path: 'getting-started/install', type: 'how-to', priority: 'must-have', action: 'create', purpose: 'Install the service.', rationale: 'Primary outcome.', evidence: ['product: README.md'], evidenceDetails: [{ source: 'product', path: 'README.md', kind: 'documentation', label: 'Install' }] },
  ],
  questions: [],
  existingDocumentation: [assessment],
}

describe('existing documentation planning', () => {
  test('adds instructions and a plan shape only when a docs-site source exists', () => {
    expect(existingDocumentationPlanningInstructions([product], discovery)).toBe('')
    expect(existingDocumentationPlanShape([product])).toBe('')
    const withProduct = existingDocumentationPlanningInstructions([product, docsSite], discovery)
    expect(withProduct).toContain('"legacy": https://docs.example.com/, crawled into the read-only Markdown snapshot at ../.doxloop-sources/x/legacy/docs-abc (2 pages, docusaurus)')
    expect(withProduct).toContain('Product sources ("product") are the truth for facts')
    expect(withProduct).toContain('Give every crawled page a disposition')
    const alone = existingDocumentationPlanningInstructions([docsSite], discovery)
    expect(alone).toContain('No product code or API specification is configured')
    expect(alone).toContain('inferred confidence')
    expect(existingDocumentationPlanShape([docsSite])).toContain('"existingDocumentation": [{')
  })

  test('gates a first create proposal that skips the audit and reports unplaced pages as an advisory', () => {
    const base = { mode: 'create' as const, status: 'planning' as const }
    expect(existingDocumentationPlanIssue({}, base, [product])).toBeUndefined()
    expect(existingDocumentationPlanIssue({}, base, [product, docsSite])).toContain('does not assess the existing documentation site "legacy"')
    expect(existingDocumentationPlanIssue({ existingDocumentation: [{ ...assessment, pages: [] } as never] }, base, [docsSite])).toContain('does not assess')
    expect(existingDocumentationPlanIssue({ existingDocumentation: [assessment as never] }, base, [docsSite])).toBeUndefined()
    expect(existingDocumentationPlanIssue({}, { mode: 'update', status: 'planning' }, [docsSite])).toBeUndefined()
    expect(existingDocumentationPlanIssue({}, { mode: 'create', status: 'revising' }, [docsSite])).toBeUndefined()

    expect(existingDocumentationAdvisory({ existingDocumentation: [assessment as never] }, [docsSite], discovery)).toBeUndefined()
    const partial = { existingDocumentation: [{ ...assessment, pages: [assessment.pages[0]] } as never] }
    expect(existingDocumentationAdvisory(partial, [docsSite], discovery)).toBe('1 of 2 crawled pages from "legacy" have no disposition in this plan (for example pages/guide/install.md). Their content is neither rewritten nor explicitly dropped; ask the agent to place them or accept that they are left behind.')
  })

  test('normalizes the audit into the plan, derives redirects on approval, and briefs the writer', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'doxloop-existing-'))
    roots.push(parent)
    const root = await scaffoldProject({ directory: join(parent, 'docs'), sources: [] })
    const materialized = await materializeDocsSiteSnapshot(root, 'legacy', snapshot())
    await saveProjectSettings(root, { sources: [docsSiteBinding(root, 'legacy', materialized)] })
    const created = await createDocumentationPlan(root, { mode: 'create', scope: 'custom', execution: { screenshots: 'disabled' } })
    const plan = await applyDocumentationPlanProposal(root, created.id, proposal, 'codex')
    expect(plan.existingDocumentation).toHaveLength(1)
    const audit = plan.existingDocumentation![0]!
    expect(audit.summary).toBe(assessment.summary)
    expect(audit.findings).toEqual([
      { severity: 'major', title: 'No troubleshooting', description: 'Readers have nowhere to go when install fails.', pages: ['pages/guide/install.md'] },
      { severity: 'major', title: 'Untyped finding', description: '', pages: [] },
    ])
    expect(audit.coverage).toEqual(assessment.coverage)
    expect(audit.pages).toEqual([
      { path: 'pages/index.md', title: 'Home', url: 'https://docs.example.com/', disposition: 'rewrite', into: ['home'], reason: 'Landing page.' },
      { path: 'pages/guide/install.md', title: 'Install', url: 'https://docs.example.com/guide/install', disposition: 'merge', into: ['install'], reason: 'Folded into the install guide.' },
      { path: 'pages/old.md', disposition: 'drop', into: [], reason: 'Obsolete.' },
      { path: 'pages/orphan.md', disposition: 'drop', into: [], reason: 'The plan named no page that absorbs this content.' },
    ])

    const approved = await approveDocumentationPlan(root, plan.id)
    expect(approved.status).toBe('approved')
    expect(JSON.parse(await readFile(join(root, '.doxloop', 'redirects.json'), 'utf8'))).toEqual({ '/guide/install': '/getting-started/install' })

    const writing = existingDocumentationWritingRequirements(approved)
    expect(writing).toContain('Follow its page dispositions exactly')
    expect(writing).toContain('  - rewrite pages/index.md → Overview')
    expect(writing).toContain('  - merge pages/guide/install.md → Install')
    expect(writing).toContain('  - drop pages/old.md (Obsolete.)')
    expect(writing).toContain('  - correct: Default port is 5230, not 8080')
    expect(writing).toContain('  - keep: Reverse proxy notes')
    expect(existingDocumentationWritingRequirements({ pages: [], existingDocumentation: [] })).toBe('')
  })
})

describe('existing documentation authoring guidance', () => {
  test('tells the writer how to weigh the crawled pages against product sources', () => {
    expect(existingDocumentationGuidance([product])).toBe('')
    const both = existingDocumentationGuidance([product, docsSite])
    expect(both).toContain('the product source is correct')
    expect(both).toContain('confidence as `inferred`')
    const alone = existingDocumentationGuidance([docsSite])
    expect(alone).toContain('No product code or API specification is configured')
    expect(alone).toContain('do not introduce factual claims')
    const prompt = authorPrompt('create', [product, docsSite])
    expect(prompt).toContain('- legacy: existing documentation site https://docs.example.com/, crawled into the read-only Markdown snapshot at ../.doxloop-sources/x/legacy/docs-abc (2 pages; index.md lists every page with its original URL)')
    expect(prompt).toContain('never copy its prose verbatim')
  })
})

test('plan JSON with an existing documentation audit round-trips through the shape', () => {
  const shape = existingDocumentationPlanShape([docsSite])
  const parsed = JSON.parse(`{"a":1${shape}}`) as { existingDocumentation: Array<Record<string, unknown>> }
  expect(parsed.existingDocumentation[0]).toHaveProperty('coverage')
  expect(parsed.existingDocumentation[0]).toHaveProperty('pages')
  void ({} as DocumentationPlan)
})
