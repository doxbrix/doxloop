import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { labelBareCodeFences, applyAuthoringPostPass, removeSupersededStarterPages, insertFrontmatterFields, rewriteLink, starterReplacementId, trimAtWordBoundary, unlinkTarget } from './authoring-postpass.js'
import { EVIDENCE_MAP_FILE, readEvidenceMap } from './evidence.js'
import { loadProject, scaffoldProject } from './project.js'
import type { DocumentationPlan, DocumentationPlanPage, DoxbrixNavNode, DoxbrixSiteConfig } from './types.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function scaffold(): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), 'doxloop-postpass-'))
  roots.push(parent)
  return scaffoldProject({ directory: join(parent, 'docs'), title: 'Pulse', sources: [{ name: 'app', path: '../app', kind: 'directory' }], generator: 'doxbrix' })
}

function page(overrides: Partial<DocumentationPlanPage> & Pick<DocumentationPlanPage, 'id' | 'path' | 'title'>): DocumentationPlanPage {
  return {
    type: 'how-to',
    priority: 'must-have',
    action: 'create',
    purpose: `Explain ${overrides.title.toLowerCase()}.`,
    rationale: 'Covered by the source.',
    evidence: [],
    evidenceDetails: [{ source: 'app', path: `src/${overrides.id}.ts`, kind: 'module' }],
    ...overrides,
  }
}

function plan(pages: DocumentationPlanPage[], sections: Array<{ id: string; title: string; pageIds: string[] }>): DocumentationPlan {
  return {
    pages,
    navigation: { top: ['Documentation'], sections },
    target: { generator: 'doxbrix', contentDir: '', contentFormat: 'markdown', pageExtensions: ['.mdx', '.md'], navigationFiles: ['docs.json'] },
  } as unknown as DocumentationPlan
}

async function write(root: string, file: string, content: string): Promise<void> {
  await mkdir(dirname(join(root, file)), { recursive: true })
  await writeFile(join(root, file), content, 'utf8')
}

async function siteConfig(root: string): Promise<DoxbrixSiteConfig> {
  return JSON.parse(await readFile(join(root, 'docs.json'), 'utf8')) as DoxbrixSiteConfig
}

function group(nodes: DoxbrixNavNode[], label: string): Extract<DoxbrixNavNode, { type: 'group' }> | undefined {
  return nodes.find((node): node is Extract<DoxbrixNavNode, { type: 'group' }> => node.type === 'group' && node.label === label)
}

async function run(root: string, documentationPlan: DocumentationPlan, pages = documentationPlan.pages, options: { pruneEmptySpaces?: boolean } = {}) {
  return applyAuthoringPostPass({ workspace: root, project: await loadProject(root), plan: documentationPlan, pages, ...options })
}

describe('authoring post-pass', () => {
  test('adds missing frontmatter without touching the rest of the page', async () => {
    const root = await scaffold()
    await write(root, 'guides/setup.mdx', '# Set up the workspace\n\nBody text stays.\n')
    await write(root, 'guides/auth.mdx', '---\ntitle: Authentication\nicon: key\n---\n\n# Authentication\n\n```yaml\ntitle: not frontmatter\n```\n')
    const longPurpose = 'Explain how administrators configure single sign-on providers, map identity claims to workspace roles, and roll credentials without interrupting active sessions for anyone.'
    const documentationPlan = plan([
      page({ id: 'setup', path: 'guides/setup', title: 'Set up the workspace', purpose: 'Get a workspace ready for the first sync.' }),
      page({ id: 'auth', path: 'guides/auth', title: 'Authentication', purpose: longPurpose }),
    ], [{ id: 'guides', title: 'Guides', pageIds: ['setup', 'auth'] }])

    const report = await run(root, documentationPlan)

    expect(await readFile(join(root, 'guides/setup.mdx'), 'utf8')).toBe(
      '---\ntitle: "Set up the workspace"\ndescription: "Get a workspace ready for the first sync."\n---\n\n# Set up the workspace\n\nBody text stays.\n',
    )
    const auth = await readFile(join(root, 'guides/auth.mdx'), 'utf8')
    const description = trimAtWordBoundary(longPurpose, 160)
    expect(description.length).toBeLessThanOrEqual(160)
    expect(longPurpose.startsWith(description)).toBe(true)
    expect(longPurpose[description.length]).toBe(' ')
    expect(auth).toBe(`---\ntitle: Authentication\nicon: key\ndescription: ${JSON.stringify(description)}\n---\n\n# Authentication\n\n\`\`\`yaml\ntitle: not frontmatter\n\`\`\`\n`)
    expect(report.repairs).toEqual(expect.arrayContaining([
      'guides/setup.mdx: added frontmatter title and description.',
      'guides/auth.mdx: added frontmatter description.',
    ]))
  })

  test('replaces blank keys in place and handles empty frontmatter blocks', () => {
    expect(insertFrontmatterFields('---\ntitle:\ndescription: ""\n---\nBody\n', [['title', 'Home'], ['description', 'Start here.']]))
      .toBe('---\ntitle: "Home"\ndescription: "Start here."\n---\nBody\n')
    expect(insertFrontmatterFields('---\n---\nBody\n', [['title', 'Home']])).toBe('---\ntitle: "Home"\n---\nBody\n')
    expect(insertFrontmatterFields('---\r\ntitle: Home\r\n---\r\n\r\nBody\r\n', [['description', 'Start here.']]))
      .toBe('---\r\ntitle: Home\r\ndescription: "Start here."\r\n---\r\n\r\nBody\r\n')
  })

  test('adds pages to the planned navigation group, creating the group when it is missing, and drops removed pages', async () => {
    const root = await scaffold()
    await write(root, 'guides/setup.mdx', '---\ntitle: "Setup"\ndescription: "Set up."\n---\n\n# Setup\n')
    await write(root, 'guides/auth.mdx', '---\ntitle: "Auth"\ndescription: "Sign in."\n---\n\n# Auth\n')
    await write(root, 'reference/cli.mdx', '---\ntitle: "CLI"\ndescription: "Commands."\n---\n\n# CLI\n')
    const config = await siteConfig(root)
    group(config.spaces[0]!.nav, 'Get started')!.items.push({ type: 'page', file: 'legacy', title: 'Legacy' })
    await writeFile(join(root, 'docs.json'), `${JSON.stringify(config, null, 2)}\n`)
    const documentationPlan = plan([
      page({ id: 'setup', path: 'guides/setup', title: 'Setup' }),
      page({ id: 'auth', path: 'guides/auth', title: 'Auth' }),
      page({ id: 'cli', path: 'reference/cli', title: 'CLI' }),
      page({ id: 'legacy', path: 'legacy', title: 'Legacy', action: 'remove' }),
    ], [
      { id: 'start', title: 'Get started', pageIds: ['setup'] },
      { id: 'guides', title: 'Guides', pageIds: ['auth'] },
    ])

    const report = await run(root, documentationPlan)

    const saved = await siteConfig(root)
    const nav = saved.spaces[0]!.nav
    expect(group(nav, 'Get started')!.items).toEqual([
      { type: 'page', file: 'index', title: 'Overview', icon: 'compass' },
      { type: 'page', file: 'quickstart', title: 'Quickstart', icon: 'bolt' },
      { type: 'page', file: 'guides/setup', title: 'Setup' },
    ])
    expect(group(nav, 'Guides')).toEqual({ type: 'group', label: 'Guides', items: [{ type: 'page', file: 'guides/auth', title: 'Auth' }] })
    expect(nav.at(-1)).toEqual({ type: 'page', file: 'reference/cli', title: 'CLI' })
    expect(report.repairs).toEqual(expect.arrayContaining([
      'docs.json: added "guides/setup" to group "Get started".',
      'docs.json: created navigation group "Guides" in space "Documentation".',
      'docs.json: added "guides/auth" to group "Guides".',
      'docs.json: added "reference/cli" to space "Documentation".',
      'docs.json: removed "legacy" from navigation because the plan deletes it.',
    ]))
  })

  test('puts each page in the space its section or path names and removes spaces nothing landed in', async () => {
    const root = await scaffold()
    await write(root, 'guides/tasks.mdx', '---\ntitle: "Tasks"\ndescription: "Do tasks."\n---\n\n# Tasks\n')
    await write(root, 'self-hosting/docker.mdx', '---\ntitle: "Docker"\ndescription: "Run it."\n---\n\n# Docker\n')
    await write(root, 'api/rest.mdx', '---\ntitle: "REST"\ndescription: "Call it."\n---\n\n# REST\n')
    const config = await siteConfig(root)
    // The writer promoted four spaces, as the plan asked, and left three of them empty.
    config.spaces = [
      { name: 'Guides', slug: 'guides', nav: config.spaces[0]!.nav },
      { name: 'Self-hosting', slug: 'self-hosting', nav: [] },
      { name: 'API and automation', slug: 'api', nav: [] },
      { name: 'Contributing', slug: 'contributing', nav: [] },
    ]
    await writeFile(join(root, 'docs.json'), `${JSON.stringify(config, null, 2)}\n`)
    const documentationPlan = plan([
      page({ id: 'tasks', path: 'guides/tasks', title: 'Tasks' }),
      page({ id: 'docker', path: 'self-hosting/docker', title: 'Docker' }),
      page({ id: 'rest', path: 'api/rest', title: 'REST' }),
    ], [
      { id: 'guides', title: 'Guides', pageIds: ['tasks'] },
      { id: 'self-hosting', title: 'Self-hosting', pageIds: ['docker'] },
      // No section names the API page: its path's first segment is the space slug.
    ])
    // Between batches the empty space stays: a later batch may still fill it.
    const interim = await run(root, documentationPlan)
    expect((await siteConfig(root)).spaces.map((space) => space.name)).toEqual(['Guides', 'Self-hosting', 'API and automation', 'Contributing'])
    expect(interim.repairs.some((repair) => repair.includes('removed space'))).toBe(false)
    const report = await run(root, documentationPlan, documentationPlan.pages, { pruneEmptySpaces: true })
    const saved = await siteConfig(root)
    expect(saved.spaces.map((space) => space.name)).toEqual(['Guides', 'Self-hosting', 'API and automation'])
    // A section that is the space itself creates no group of the same name.
    expect(saved.spaces[0]!.nav.at(-1)).toEqual({ type: 'page', file: 'guides/tasks', title: 'Tasks' })
    expect(saved.spaces[1]!.nav).toEqual([{ type: 'page', file: 'self-hosting/docker', title: 'Docker' }])
    expect(saved.spaces[2]!.nav).toEqual([{ type: 'page', file: 'api/rest', title: 'REST' }])
    expect(interim.repairs).toEqual(expect.arrayContaining([
      'docs.json: added "guides/tasks" to space "Guides".',
      'docs.json: added "self-hosting/docker" to space "Self-hosting".',
      'docs.json: added "api/rest" to space "API and automation".',
    ]))
    expect(report.repairs).toContain('docs.json: removed space "Contributing" because no page was written for it.')
  })

  test('turns the plan areas into spaces when the writer laid them out as groups in the one starter space', async () => {
    const root = await scaffold()
    await write(root, 'self-hosting/docker.mdx', '---\ntitle: "Docker"\ndescription: "Run it."\n---\n\n# Docker\n')
    await write(root, 'self-hosting/backups.mdx', '---\ntitle: "Backups"\ndescription: "Keep it."\n---\n\n# Backups\n')
    await write(root, 'api/webhooks.mdx', '---\ntitle: "Webhooks"\ndescription: "Call out."\n---\n\n# Webhooks\n')
    const config = await siteConfig(root)
    const starterNav = structuredClone(config.spaces[0]!.nav)
    // The first batch laid the plan's top-level areas out as groups in one space.
    config.spaces[0]!.nav.push(
      { type: 'group', label: 'Self-hosting', items: [] },
      { type: 'group', label: 'API & integrations', items: [] },
    )
    await writeFile(join(root, 'docs.json'), `${JSON.stringify(config, null, 2)}\n`)
    const documentationPlan = plan([
      page({ id: 'docker', path: 'self-hosting/docker', title: 'Docker' }),
      page({ id: 'backups', path: 'self-hosting/backups', title: 'Backups' }),
      page({ id: 'webhooks', path: 'api/webhooks', title: 'Webhooks' }),
    ], [
      { id: 'install', title: 'Install & upgrade', pageIds: ['docker'] },
      { id: 'self-hosting', title: 'Self-hosting', pageIds: ['backups'] },
      // No section names the webhooks page: its path's first segment picks the space.
    ])
    documentationPlan.navigation.top = ['Guides', 'Self-hosting', 'API & Integrations']

    const report = await run(root, documentationPlan)
    const saved = await siteConfig(root)
    // Areas become spaces in the plan's order; the starter content opens the
    // first area, so no stray "Documentation" space is left beside them.
    expect(saved.spaces.map((space) => space.name)).toEqual(['Guides', 'Self-hosting', 'API & Integrations'])
    expect(saved.spaces[0]!.nav).toEqual(starterNav)
    expect(saved.spaces[1]!.nav).toEqual([
      { type: 'group', label: 'Install & upgrade', items: [{ type: 'page', file: 'self-hosting/docker', title: 'Docker' }] },
      { type: 'page', file: 'self-hosting/backups', title: 'Backups' },
    ])
    expect(saved.spaces[2]!.nav).toEqual([{ type: 'page', file: 'api/webhooks', title: 'Webhooks' }])
    expect(report.repairs[0]).toContain('split the navigation into 3 spaces from the plan')
    // Once there are several spaces the layout is left as it is.
    const again = await run(root, documentationPlan)
    expect(again.repairs.filter((repair) => repair.includes('split the navigation'))).toEqual([])
  })

  test('a planned page written over a starter file is found there and linked by the file that exists', async () => {
    const root = await scaffold()
    // The scaffold's starter index.mdx and quickstart.mdx stand in for the
    // planned overview and get-started pages; the writer kept the file names.
    await write(root, 'guides/tasks.mdx', '---\ntitle: "Tasks"\ndescription: "Do tasks."\n---\n\n# Tasks\n\nRead [the product model](/guides/overview) or [get started](/guides/get-started). Also [nowhere](/guides/nowhere).\n')
    const documentationPlan = plan([
      page({ id: 'overview', path: 'guides/overview', title: 'What is Pulse?', action: 'update' }),
      page({ id: 'get-started', path: 'guides/get-started', title: 'Get started', action: 'update' }),
      page({ id: 'tasks', path: 'guides/tasks', title: 'Tasks' }),
    ], [{ id: 'guides', title: 'Guides', pageIds: ['overview', 'get-started', 'tasks'] }])
    expect(starterReplacementId('guides/overview', ['index.mdx', 'quickstart.mdx'])).toBe('index')
    expect(starterReplacementId('guides/get-started', ['index.mdx', 'quickstart.mdx'])).toBeUndefined()
    expect(starterReplacementId('guides/quickstart', ['index.mdx', 'quickstart.mdx'])).toBe('quickstart')
    expect(starterReplacementId('guides/tasks', ['index.mdx', 'guides/tasks.mdx'])).toBeUndefined()

    const report = await run(root, documentationPlan)
    const tasks = await readFile(join(root, 'guides/tasks.mdx'), 'utf8')
    expect(tasks).toContain('[the product model](/)')
    expect(tasks).toContain('[nowhere](/guides/nowhere)')
    expect(report.repairs).toContain('guides/tasks.mdx: rewrote link /guides/overview -> /.')
    expect(report.problems).toEqual(expect.arrayContaining([expect.stringContaining('link "/guides/nowhere" does not resolve')]))
    // The landing page is the index: its frontmatter and navigation are left as they are.
    const saved = await siteConfig(root)
    expect(JSON.stringify(saved)).not.toContain('guides/overview')

    // The end-of-run pass turns what still resolves nowhere into plain text.
    const final = await applyAuthoringPostPass({ workspace: root, project: await loadProject(root), plan: documentationPlan, pages: documentationPlan.pages, unlinkUnresolved: true })
    const swept = await readFile(join(root, 'guides/tasks.mdx'), 'utf8')
    expect(swept).toContain('Also nowhere.')
    expect(swept).not.toContain('/guides/nowhere')
    expect(final.repairs).toContain('guides/tasks.mdx: turned the link /guides/nowhere into plain text because no page exists for it.')
    expect(unlinkTarget('See [x](/a "T") and `[x](/a)` and\n```\n[x](/a)\n```\n', '/a')).toBe('See x and `[x](/a)` and\n```\n[x](/a)\n```\n')
  })

  test('rewrites broken links with a unique canonical page and reports ambiguous ones', async () => {
    const root = await scaffold()
    await write(root, 'guides/setup.mdx', [
      '---',
      'title: "Setup"',
      'description: "Set up."',
      '---',
      '',
      'Start with the [quickstart](/getting-started/quickstart) and then',
      '<a href="/getting-started/quickstart#step-2">step two</a>.',
      'Read about [auth](/setup/auth) and see ![diagram](/assets/missing.png).',
      'A [planned page](/guides/deploy/webhooks) counts too, and [this one](./billing.md) is fine.',
      '',
      '```md',
      '[quickstart](/getting-started/quickstart)',
      '```',
      '',
    ].join('\n'))
    await write(root, 'guides/billing.md', '---\ntitle: "Billing"\ndescription: "Pay."\n---\n\n# Billing\n')
    await write(root, 'guides/auth.mdx', '---\ntitle: "Auth"\ndescription: "Sign in."\n---\n\n# Auth\n')
    await write(root, 'reference/auth.mdx', '---\ntitle: "Auth API"\ndescription: "Tokens."\n---\n\n# Auth API\n')
    const documentationPlan = plan([
      page({ id: 'setup', path: 'guides/setup', title: 'Setup' }),
      page({ id: 'webhooks', path: 'integrations/webhooks', title: 'Webhooks' }),
    ], [{ id: 'guides', title: 'Guides', pageIds: ['setup', 'webhooks'] }])

    const report = await run(root, documentationPlan, [documentationPlan.pages[0]!])

    const content = await readFile(join(root, 'guides/setup.mdx'), 'utf8')
    expect(content).toContain('[quickstart](/quickstart)')
    expect(content).toContain('<a href="/quickstart#step-2">step two</a>')
    expect(content).toContain('[auth](/setup/auth)')
    expect(content).toContain('![diagram](/assets/missing.png)')
    expect(content).toContain('[planned page](/integrations/webhooks)')
    expect(content).toContain('[this one](./billing.md)')
    expect(content).toContain('```md\n[quickstart](/getting-started/quickstart)\n```')
    expect(report.repairs).toEqual(expect.arrayContaining([
      'guides/setup.mdx: rewrote link /getting-started/quickstart -> /quickstart.',
      'guides/setup.mdx: rewrote link /getting-started/quickstart#step-2 -> /quickstart#step-2.',
      'guides/setup.mdx: rewrote link /guides/deploy/webhooks -> /integrations/webhooks.',
    ]))
    expect(report.problems).toEqual([
      'guides/setup.mdx: link "/setup/auth" does not resolve and could mean any of /guides/auth, /reference/auth.',
    ])
  })

  test('rewriteLink only touches link syntax outside protected blocks', () => {
    const input = 'See [a](/old) and [b](</old> "Title") and <img src=\'/old\'> plus /old in prose.\n\n[ref]: /old\n\n<!-- [c](/old) -->\n'
    expect(rewriteLink(input, '/old', '/new')).toBe(
      'See [a](/new) and [b](</new> "Title") and <img src=\'/new\'> plus /old in prose.\n\n[ref]: /new\n\n<!-- [c](/old) -->\n',
    )
  })

  test('seeds evidence-map entries from the plan and leaves existing entries alone', async () => {
    const root = await scaffold()
    await write(root, 'guides/setup.mdx', '---\ntitle: "Setup"\ndescription: "Set up."\n---\n\n# Setup\n')
    await write(root, EVIDENCE_MAP_FILE, `${JSON.stringify({
      schemaVersion: 1,
      pages: { 'index.mdx': { sources: [{ source: 'app', paths: ['README.md'] }], confidence: 'verified', claims: ['Pulse syncs hourly.'] } },
    }, null, 2)}\n`)
    const documentationPlan = plan([
      page({ id: 'index', path: 'index', title: 'Overview', evidenceDetails: [{ source: 'app', path: 'src/other.ts' }] }),
      page({ id: 'setup', path: 'guides/setup', title: 'Setup', evidenceDetails: [
        { source: 'app', path: 'src/setup.ts', kind: 'module' },
        { source: 'app', path: 'src/setup.ts', kind: 'symbol', label: 'createWorkspace' },
        { source: 'app', path: 'src/workspace.ts' },
        { source: 'api', path: 'openapi.json' },
      ] }),
    ], [{ id: 'guides', title: 'Guides', pageIds: ['index', 'setup'] }])

    const report = await run(root, documentationPlan)

    const map = await readEvidenceMap(root)
    expect(map?.pages['index.mdx']).toEqual({ sources: [{ source: 'app', paths: ['README.md'] }], confidence: 'verified', claims: ['Pulse syncs hourly.'] })
    expect(map?.pages['guides/setup.mdx']).toEqual({
      sources: [{ source: 'app', paths: ['src/setup.ts', 'src/workspace.ts'] }, { source: 'api', paths: ['openapi.json'] }],
      confidence: 'inferred',
    })
    expect(report.repairs).toContain(`${EVIDENCE_MAP_FILE}: seeded an inferred entry for guides/setup.mdx from the plan.`)
  })

  test('sets aside a malformed evidence map and rebuilds it from the plan', async () => {
    const root = await scaffold()
    await write(root, 'guides/setup.mdx', '---\ntitle: "Setup"\ndescription: "Set up."\n---\n\n# Setup\n')
    await write(root, EVIDENCE_MAP_FILE, '{"schemaVersion": 1, "pages": {"index.mdx": {"sources": "nope"}}}\n')
    const documentationPlan = plan([
      page({ id: 'index', path: 'index', title: 'Overview' }),
      page({ id: 'quickstart', path: 'quickstart', title: 'Quickstart' }),
      page({ id: 'setup', path: 'guides/setup', title: 'Setup' }),
      page({ id: 'later', path: 'guides/later', title: 'Not written yet' }),
    ], [{ id: 'guides', title: 'Guides', pageIds: ['index', 'quickstart', 'setup', 'later'] }])

    const report = await run(root, documentationPlan, [documentationPlan.pages[2]!])

    expect(JSON.parse(await readFile(join(root, '.doxloop', 'evidence-map.invalid.json'), 'utf8'))).toEqual({ schemaVersion: 1, pages: { 'index.mdx': { sources: 'nope' } } })
    const map = await readEvidenceMap(root)
    expect(Object.keys(map!.pages)).toEqual(['guides/setup.mdx', 'index.mdx', 'quickstart.mdx'])
    expect(map!.pages['index.mdx']).toEqual({ sources: [{ source: 'app', paths: ['src/index.ts'] }], confidence: 'inferred' })
    expect(report.problems.some((problem) => problem.includes('was malformed') && problem.includes('evidence-map.invalid.json'))).toBe(true)
  })

  test('is idempotent: a second run makes no repairs', async () => {
    const root = await scaffold()
    await write(root, 'guides/setup.mdx', '# Setup\n\nRead the [quickstart](/getting-started/quickstart).\n')
    await write(root, 'guides/auth.mdx', '---\ntitle: "Auth"\n---\n\n# Auth\n')
    const documentationPlan = plan([
      page({ id: 'setup', path: 'guides/setup', title: 'Setup' }),
      page({ id: 'auth', path: 'guides/auth', title: 'Auth' }),
    ], [{ id: 'guides', title: 'Guides', pageIds: ['setup', 'auth'] }])

    const first = await run(root, documentationPlan)
    expect(first.repairs.length).toBeGreaterThanOrEqual(5)
    expect(first.problems).toEqual([])
    const snapshot = {
      setup: await readFile(join(root, 'guides/setup.mdx'), 'utf8'),
      auth: await readFile(join(root, 'guides/auth.mdx'), 'utf8'),
      docs: await readFile(join(root, 'docs.json'), 'utf8'),
      evidence: await readFile(join(root, EVIDENCE_MAP_FILE), 'utf8'),
    }

    const second = await run(root, documentationPlan)

    expect(second).toEqual({ repairs: [], problems: [] })
    expect({
      setup: await readFile(join(root, 'guides/setup.mdx'), 'utf8'),
      auth: await readFile(join(root, 'guides/auth.mdx'), 'utf8'),
      docs: await readFile(join(root, 'docs.json'), 'utf8'),
      evidence: await readFile(join(root, EVIDENCE_MAP_FILE), 'utf8'),
    }).toEqual(snapshot)
  })

  test('a section page whose path names another space joins the section group instead of opening a one-page duplicate there', async () => {
    const root = await scaffold()
    // The memos-docs-codex shape: "Getting started" lives in the Memos space,
    // and its administration/oauth-sso page used to open a second
    // "Getting started" group in the Administration space.
    const config = await siteConfig(root)
    config.spaces = [
      { name: 'Memos', slug: 'memos', nav: [{ type: 'group', label: 'Getting started', items: [{ type: 'page', file: 'getting-started/install', title: 'Install' }] }] },
      { name: 'Administration', slug: 'administration', nav: [] },
    ]
    await writeFile(join(root, 'docs.json'), `${JSON.stringify(config, null, 2)}\n`)
    await write(root, 'getting-started/install.mdx', '---\ntitle: "Install"\ndescription: "Install it."\n---\n\n# Install\n')
    await write(root, 'administration/oauth-sso.mdx', '---\ntitle: "SSO"\ndescription: "Sign in."\n---\n\n# SSO\n')
    await write(root, 'administration/rate-limits.mdx', '---\ntitle: "Limits"\ndescription: "Limits."\n---\n\n# Limits\n')
    await write(root, 'self-hosting/configure.mdx', '---\ntitle: "Configure"\ndescription: "Configure."\n---\n\n# Configure\n')
    await write(root, 'administration/smtp.mdx', '---\ntitle: "SMTP"\ndescription: "Mail."\n---\n\n# SMTP\n')
    const documentationPlan = plan([
      page({ id: 'install', path: 'getting-started/install', title: 'Install' }),
      page({ id: 'oauth-sso', path: 'administration/oauth-sso', title: 'SSO' }),
      page({ id: 'configure', path: 'self-hosting/configure', title: 'Configure' }),
      page({ id: 'rate-limits', path: 'administration/rate-limits', title: 'Limits' }),
      page({ id: 'smtp', path: 'administration/smtp', title: 'SMTP' }),
    ], [
      { id: 'getting-started', title: 'Getting started', pageIds: ['install', 'oauth-sso'] },
      { id: 'deploy', title: 'Deploy and upgrade', pageIds: ['configure', 'rate-limits'] },
      { id: 'configure-instance', title: 'Configure the instance', pageIds: ['smtp'] },
    ])
    documentationPlan.navigation.top = ['Memos', 'Administration']

    const first = await run(root, documentationPlan, [documentationPlan.pages[1]!])
    const second = await run(root, documentationPlan, [documentationPlan.pages[2]!])
    const third = await run(root, documentationPlan, documentationPlan.pages.slice(3))
    const saved = await siteConfig(root)
    const [memos, administration] = saved.spaces
    expect(group(memos!.nav, 'Getting started')!.items.map((item) => item.type === 'page' && item.file)).toEqual(['getting-started/install', 'administration/oauth-sso'])
    expect(group(administration!.nav, 'Getting started')).toBeUndefined()
    // No group of that name yet: the first page's path picks the space; later pages join it.
    expect(group(memos!.nav, 'Deploy and upgrade')!.items.map((item) => item.type === 'page' && item.file)).toEqual(['self-hosting/configure', 'administration/rate-limits'])
    expect(group(administration!.nav, 'Deploy and upgrade')).toBeUndefined()
    // A section whose pages all live under the Administration path goes there.
    expect(group(administration!.nav, 'Configure the instance')!.items.map((item) => item.type === 'page' && item.file)).toEqual(['administration/smtp'])
    expect([...first.repairs, ...second.repairs, ...third.repairs].filter((line) => line.includes('created navigation group'))).toEqual([
      'docs.json: created navigation group "Deploy and upgrade" in space "Memos".',
      'docs.json: created navigation group "Configure the instance" in space "Administration".',
    ])
  })

  test('builds every space the plan assigns sections to, even when the writer made only the first', async () => {
    const root = await scaffold()
    const config = await siteConfig(root)
    // Batch 1 wrote a one-space docs.json; the plan wants three spaces.
    config.spaces = [{ name: 'Memos', slug: 'memos', nav: [{ type: 'group', label: 'Welcome', items: [{ type: 'page', file: 'index', title: 'Overview' }] }] }]
    await writeFile(join(root, 'docs.json'), `${JSON.stringify(config, null, 2)}\n`)
    await write(root, 'index.mdx', '---\ntitle: "Overview"\ndescription: "Start."\n---\n\n# Overview\n')
    for (const file of ['guides/create', 'administration/smtp', 'administration/storage', 'api/memos', 'integrations/webhooks']) {
      await write(root, `${file}.mdx`, `---\ntitle: "${file}"\ndescription: "Page."\n---\n\n# Page\n`)
    }
    const documentationPlan = plan([
      page({ id: 'index', path: 'index', title: 'Overview' }),
      page({ id: 'create', path: 'guides/create', title: 'Create' }),
      page({ id: 'smtp', path: 'administration/smtp', title: 'SMTP' }),
      page({ id: 'storage', path: 'administration/storage', title: 'Storage' }),
      page({ id: 'memos-api', path: 'api/memos', title: 'Memo API' }),
      page({ id: 'webhooks', path: 'integrations/webhooks', title: 'Webhooks' }),
    ], [
      { id: 'welcome', title: 'Welcome', pageIds: ['index'], space: 'Memos' },
      { id: 'create', title: 'Create and organize', pageIds: ['create'], space: 'Memos' },
      { id: 'instance', title: 'Configure the instance', pageIds: ['smtp', 'storage'], space: 'Administration' },
      { id: 'apis', title: 'APIs', pageIds: ['memos-api'], space: 'API & integrations' },
      { id: 'integrations', title: 'Integrations', pageIds: ['webhooks'], space: 'API & integrations' },
    ])
    documentationPlan.navigation.top = ['Memos', 'Administration', 'API & integrations']

    await run(root, documentationPlan, documentationPlan.pages.slice(1))
    const saved = await siteConfig(root)
    expect(saved.spaces.map((space) => space.name)).toEqual(['Memos', 'Administration', 'API & integrations'])
    const [memos, administration, api] = saved.spaces
    expect(group(memos!.nav, 'Create and organize')).toBeDefined()
    expect(group(administration!.nav, 'Configure the instance')!.items).toHaveLength(2)
    expect(group(api!.nav, 'APIs')).toBeDefined()
    expect(group(api!.nav, 'Integrations')).toBeDefined()
  })

  test('the end-of-run pass moves planned pages out of a leftover starter space into their planned spaces', async () => {
    const root = await scaffold()
    const config = await siteConfig(root)
    // The writer nested the plan's first section inside the starter space's "Get started" group.
    config.spaces = [
      { name: 'Documentation', slug: 'docs', nav: [{ type: 'group', label: 'Get started', items: [{ type: 'group', label: 'Create', items: [{ type: 'page', file: 'guides', title: 'Overview' }, { type: 'page', file: 'guides/draw', title: 'Draw' }] }] }] },
      { name: 'Guides', slug: 'guides', nav: [{ type: 'group', label: 'Share', items: [{ type: 'page', file: 'guides/export', title: 'Export' }] }] },
      { name: 'Embed', slug: 'embed', nav: [{ type: 'page', file: 'embed/react', title: 'React' }] },
    ]
    await writeFile(join(root, 'docs.json'), `${JSON.stringify(config, null, 2)}\n`)
    for (const file of ['guides', 'guides/draw', 'guides/export', 'embed/react']) await write(root, `${file}.mdx`, `---\ntitle: "${file}"\ndescription: "Page."\n---\n\n# Page\n`)
    const documentationPlan = plan([
      page({ id: 'overview', path: 'guides', title: 'Overview' }),
      page({ id: 'draw', path: 'guides/draw', title: 'Draw' }),
      page({ id: 'export', path: 'guides/export', title: 'Export' }),
      page({ id: 'react', path: 'embed/react', title: 'React' }),
    ], [
      { id: 'start', title: 'Start and create', pageIds: ['overview', 'draw'], space: 'Guides' },
      { id: 'share', title: 'Share', pageIds: ['export'], space: 'Guides' },
      { id: 'embed', title: 'Embed', pageIds: ['react'], space: 'Embed' },
    ] as Array<{ id: string; title: string; pageIds: string[] }>)
    documentationPlan.navigation.top = ['Guides', 'Embed']
    await run(root, documentationPlan, documentationPlan.pages, { pruneEmptySpaces: true })
    const saved = await siteConfig(root)
    expect(saved.spaces.map((space) => space.name)).toEqual(['Guides', 'Embed'])
    expect(group(saved.spaces[0]!.nav, 'Start and create')!.items!.map((item) => (item as { file: string }).file)).toEqual(['guides', 'guides/draw'])
    // The plan lists "Start and create" first, so it opens the space.
    expect(saved.spaces[0]!.nav.map((node) => (node as { label?: string }).label)).toEqual(['Start and create', 'Share'])
  })

  test('the end-of-run pass merges a plan section split across spaces and drops empty groups', async () => {
    const root = await scaffold()
    const config = await siteConfig(root)
    // What the earlier repair left behind: one-page copies of two sections in a second space, and an empty section group.
    config.spaces = [
      { name: 'Memos', slug: 'memos', nav: [
        { type: 'group', label: 'Getting started', items: [{ type: 'page', file: 'getting-started/install', title: 'Install' }, { type: 'page', file: 'getting-started/sign-in', title: 'Sign in' }] },
        { type: 'group', label: 'Protocol limits', items: [] },
      ] },
      { name: 'Administration', slug: 'administration', nav: [
        { type: 'group', label: 'Getting started', items: [{ type: 'page', file: 'administration/oauth-sso', title: 'SSO' }] },
        { type: 'group', label: 'Configure the instance', items: [{ type: 'page', file: 'administration/smtp', title: 'SMTP' }] },
      ] },
    ]
    await writeFile(join(root, 'docs.json'), `${JSON.stringify(config, null, 2)}\n`)
    for (const [file, title] of [['getting-started/install', 'Install'], ['getting-started/sign-in', 'Sign in'], ['administration/oauth-sso', 'SSO'], ['administration/smtp', 'SMTP']] as const) {
      await write(root, `${file}.mdx`, `---\ntitle: "${title}"\ndescription: "${title}."\n---\n\n# ${title}\n`)
    }
    await rm(join(root, 'index.mdx'), { force: true }).catch(() => undefined)
    const documentationPlan = plan([
      page({ id: 'install', path: 'getting-started/install', title: 'Install' }),
      page({ id: 'sign-in', path: 'getting-started/sign-in', title: 'Sign in' }),
      page({ id: 'oauth-sso', path: 'administration/oauth-sso', title: 'SSO' }),
      page({ id: 'smtp', path: 'administration/smtp', title: 'SMTP' }),
    ], [
      { id: 'getting-started', title: 'Getting started', pageIds: ['install', 'sign-in', 'oauth-sso'] },
      { id: 'configure-instance', title: 'Configure the instance', pageIds: ['smtp'] },
      { id: 'protocol-limits', title: 'Protocol limits', pageIds: [] },
    ])
    const report = await run(root, documentationPlan, documentationPlan.pages, { pruneEmptySpaces: true })
    const saved = await siteConfig(root)
    const labels = saved.spaces.map((space) => [space.name, space.nav.filter((node) => node.type === 'group').map((node) => node.type === 'group' && node.label)])
    expect(labels).toEqual([['Memos', ['Getting started']], ['Administration', ['Configure the instance']]])
    expect(group(saved.spaces[0]!.nav, 'Getting started')!.items).toHaveLength(3)
    expect(report.repairs).toEqual(expect.arrayContaining([
      'docs.json: merged navigation group "Getting started" (1 page) from space "Administration" into the one in space "Memos".',
      'docs.json: removed empty navigation group "Protocol limits" from space "Memos".',
      'docs.json: removed empty navigation group "Getting started" from space "Administration".',
    ]))
  })

  test('renames new pages written as .md to .mdx and keeps evidence and navigation pointing at them', async () => {
    const root = await scaffold()
    await write(root, 'guides/inbox.md', '---\ntitle: "Inbox"\ndescription: "Read it."\n---\n\n# Inbox\n')
    await write(root, 'guides/kept.md', '---\ntitle: "Kept"\ndescription: "Existing page."\n---\n\n# Kept\n')
    await write(root, 'guides/twin.md', '---\ntitle: "Twin"\ndescription: "Twin."\n---\n\n# Twin\n')
    await write(root, 'guides/twin.mdx', '---\ntitle: "Twin"\ndescription: "Twin."\n---\n\n# Twin\n')
    await write(root, 'README.md', '# Project\n')
    await write(root, EVIDENCE_MAP_FILE, JSON.stringify({ schemaVersion: 1, pages: { 'guides/inbox.md': { sources: [{ source: 'app', paths: ['src/inbox.ts'] }], confidence: 'verified' } } }))
    const config = await siteConfig(root)
    config.spaces[0]!.nav.push({ type: 'page', file: 'guides/inbox.md', title: 'Inbox' })
    await writeFile(join(root, 'docs.json'), `${JSON.stringify(config, null, 2)}\n`)
    const documentationPlan = plan([
      page({ id: 'inbox', path: 'guides/inbox', title: 'Inbox' }),
      page({ id: 'kept', path: 'guides/kept', title: 'Kept', action: 'update' }),
      page({ id: 'twin', path: 'guides/twin', title: 'Twin' }),
    ], [{ id: 'guides', title: 'Guides', pageIds: ['inbox', 'kept', 'twin'] }])
    documentationPlan.target!.pageExtensions = ['.md', '.mdx']

    const report = await run(root, documentationPlan)

    expect(report.repairs).toContain('guides/inbox.md: renamed to guides/inbox.mdx so every page uses the .mdx extension.')
    expect(report.problems).toContain('guides/twin.md: both guides/twin.md and guides/twin.mdx exist; keep one of them.')
    await expect(readFile(join(root, 'guides/inbox.mdx'), 'utf8')).resolves.toContain('# Inbox')
    await expect(readFile(join(root, 'guides/inbox.md'), 'utf8')).rejects.toThrow()
    // An existing page in an update keeps its file; README is not a page to rename.
    await expect(readFile(join(root, 'guides/kept.md'), 'utf8')).resolves.toContain('# Kept')
    await expect(readFile(join(root, 'README.md'), 'utf8')).resolves.toContain('# Project')
    const evidence = await readEvidenceMap(root)
    expect(evidence!.pages['guides/inbox.mdx']?.confidence).toBe('verified')
    expect(evidence!.pages['guides/inbox.md']).toBeUndefined()
    const nav = (await siteConfig(root)).spaces[0]!.nav
    expect(nav.filter((node) => node.type === 'page' && node.file.startsWith('guides/inbox'))).toEqual([{ type: 'page', file: 'guides/inbox', title: 'Inbox' }])
  })

  test('the end-of-run pass of a create run also renames .md pages the plan did not name', async () => {
    const root = await scaffold()
    await write(root, 'guides/extra.md', '---\ntitle: "Extra"\ndescription: "Extra."\n---\n\n# Extra\n')
    await write(root, '.agents/skills/x/SKILL.md', '# Skill\n')
    const documentationPlan = plan([], [])
    ;(documentationPlan as { mode?: string }).mode = 'create'
    const interim = await run(root, documentationPlan)
    expect(interim.repairs.some((line) => line.includes('renamed'))).toBe(false)
    const report = await run(root, documentationPlan, [], { pruneEmptySpaces: true })
    expect(report.repairs).toContain('guides/extra.md: renamed to guides/extra.mdx so every page uses the .mdx extension.')
    await expect(readFile(join(root, '.agents/skills/x/SKILL.md'), 'utf8')).resolves.toContain('# Skill')
  })

  test('skips pages whose files do not exist yet', async () => {
    const root = await scaffold()
    const documentationPlan = plan([page({ id: 'missing', path: 'guides/missing', title: 'Missing' })], [])
    expect(await run(root, documentationPlan)).toEqual({ repairs: [], problems: [] })
  })
})

describe('labelBareCodeFences', () => {
  test('labels unlabeled opening fences as text and leaves labeled, closing, and tilde fences alone', () => {
    const input = ['```', 'plain', '```', '', '```bash', 'echo hi', '```', '', '  ```', '  indented', '  ```', '', '~~~~', 'a ``` inside tildes', '~~~~', '````', 'nested ``` fence shown', '````'].join('\n')
    expect(labelBareCodeFences(input).split('\n')).toEqual(['```text', 'plain', '```', '', '```bash', 'echo hi', '```', '', '  ```text', '  indented', '  ```', '', '~~~~text', 'a ``` inside tildes', '~~~~', '````text', 'nested ``` fence shown', '````'])
    expect(labelBareCodeFences('no fences\n')).toBe('no fences\n')
  })
})


describe('removeSupersededStarterPages', () => {
  test('removes a leftover starter page reported only as starter content', async () => {
    const root = await mkdtemp(join(tmpdir(), 'doxloop-starter-'))
    try {
      await writeFile(join(root, 'quickstart.mdx'), '---\ntitle: Quickstart\n---\n\n{/* doxloop:starter-page */}\n\nThe authoring agent will replace this starter.\n')
      await writeFile(join(root, 'get-started.mdx'), '---\ntitle: Get started\n---\n\nReal page.\n')
      const removed = await removeSupersededStarterPages(root, [
        { severity: 'error', code: 'starter-content', file: 'quickstart.mdx', message: 'Replace generated starter content.' },
        { severity: 'error', code: 'starter-content', file: 'get-started.mdx', message: 'Replace generated starter content.' },
      ])
      expect(removed).toEqual(['quickstart.mdx'])
      await expect(readFile(join(root, 'get-started.mdx'), 'utf8')).resolves.toContain('Real page')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
