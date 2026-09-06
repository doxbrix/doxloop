import { expect, test } from '@playwright/test'

const project = {
  title: 'Pulse documentation', contentDir: '', generator: 'doxbrix', defaultAgent: 'codex',
  sources: [{ name: 'pulse-api', path: '../openapi.json', kind: 'openapi', scope: { routePrefix: 'reference' } }],
  designReferences: [],
  documentation: { locale: 'en-US', tone: ['clear'], standardsProfile: 'default', styleGuide: 'doxloop', terminology: {}, exclusions: [], accessibilityTarget: 'WCAG 2.2 AA' },
  sync: { mode: 'auto', on: ['daily@09:00'], watch: ['**'], ignore: [], budget: { maxRunsPerDay: 4, maxMinutes: 20 }, maxVerificationAgeDays: 30, maxVerificationAgeSeverity: 'warn' },
}

const state = {
  projectFound: true, cwd: '/tmp', root: '/tmp/pulse-docs', project,
  effectiveDeployment: { name: 'Pulse documentation', slug: 'pulse-documentation', visibility: 'private', apiUrl: 'https://app.doxbrix.com' },
  validation: { pages: ['index.mdx'], errors: 0, warnings: 0, issues: [] },
  doctor: { ready: true, checks: [] }, runs: [], syncStatus: 'ready', drift: { status: 'current', pages: [] },
  agents: [{ name: 'codex', executable: '/usr/bin/codex', preferred: true, authentication: { status: 'authenticated', detail: 'Signed in' }, skills: [] }],
  account: { signedIn: false, apiUrl: 'https://app.doxbrix.com' }, receipt: { mode: 'create', completedAt: '2026-08-26T08:00:00.000Z' },
  generators: [{ id: 'doxbrix', displayName: 'Doxbrix', installed: true }], jobs: [], preview: { running: false, url: 'http://127.0.0.1:4321' },
}

const intelligence = {
  generatedAt: '2026-08-26T08:00:00.000Z',
  health: [{ name: 'pulse-api', connector: 'openapi', status: 'healthy', checkedAt: '2026-08-26T08:00:00.000Z', lastSuccessfulAt: '2026-08-25T08:00:00.000Z', location: 'openapi.json', provider: 'file', monitored: false, revision: '1234567890abcdef', summary: 'Pulse API 1.0 · 3 operations', details: ['OpenAPI 3.1.0'], openapi: { title: 'Pulse API', version: '1.0', specificationVersion: '3.1.0', servers: [], securitySchemes: ['bearerAuth'], schemas: ['Event'], operationCount: 3 } }],
  coverage: { metrics: [{ id: 'http-operations', label: 'API operations', documented: 3, total: 3, excluded: 0, percent: 100, denominator: 'OpenAPI operations', items: [] }], groups: [], pages: [], disclaimer: 'Traceability coverage, not correctness.' }, evidenceDiagnostics: [],
}

const proposal = {
  id: 'proposal-1', status: 'awaiting-review', mode: 'propose', trigger: 'manual', createdAt: '2026-08-26T08:00:00.000Z',
  summary: 'Document event ingestion', sourceSummary: 'pulse-api changed', stalePages: ['reference/events.mdx'], sourceSnapshot: 'snapshot-1', revisionRequests: [], humanEdits: [],
  changes: [{ id: 'change-1', title: 'Events API', path: 'reference/events.mdx', category: 'page', kind: 'modified', hunks: [{ id: 'hunk-1' }], rationale: { reason: 'The accepted response changed.', evidence: [{ source: 'pulse-api', operation: 'POST /events', revision: '1234567890', available: true }], affectedInterfaces: ['POST /events'], claims: { added: [], changed: ['The accepted response is 202.'], removed: [] }, validation: { errors: 0, warnings: 0 }, confidence: 'verified', assumptions: [], authorship: 'agent' } }],
}

const documentationPages = [
  { path: 'index.mdx', title: 'Overview', description: 'Start here.', section: 'Getting started', route: '/', wordCount: 126, updatedAt: '2026-08-26T08:00:00.000Z', evidence: 'verified', inNavigation: true },
  { path: 'reference/events.mdx', title: 'Events API', description: 'Send events.', section: 'Reference', route: '/reference/events', wordCount: 284, evidence: 'needs-review', inNavigation: true },
]

const editProposal = {
  ...proposal,
  id: 'run-page-edit',
  trigger: 'edit',
  summary: 'Clarified the Events API example.',
  editRequest: { instruction: 'Add a clearer curl example.', paths: ['reference/events.mdx'], allowRelated: false, followUps: [] },
}

const readyPlan = {
  schemaVersion: 2, id: 'plan-test', version: 1, mode: 'create', status: 'ready-for-review', scope: 'comprehensive',
  createdAt: '2026-08-26T08:00:00.000Z', updatedAt: '2026-08-26T08:01:00.000Z', request: 'Create complete API documentation', sourceSnapshot: 'source-snapshot',
  productProfile: 'Event ingestion API', summary: 'Guide readers from authentication to their first accepted event.', audiences: ['Application developers'], outcomes: ['Send an event'], terminology: {}, exclusions: [], instructions: 'Use verified HTTP examples.', experienceLevel: 'beginner', preferredExamples: ['HTTP'], locale: 'en-US', accessibilityTarget: 'WCAG 2.2 AA', styleGuide: 'doxloop',
  capabilities: [{ id: 'events', title: 'Event ingestion', kind: 'operation', evidence: [{ source: 'pulse-api', path: 'openapi.json', label: 'POST /events' }], pageIds: ['quickstart', 'events'], disposition: 'planned' }],
  navigation: { top: ['Documentation'], sections: [{ id: 'getting-started', title: 'Getting started', pageIds: ['quickstart'] }, { id: 'reference', title: 'Reference', pageIds: ['events'] }] },
  pages: [
    { id: 'quickstart', title: 'Quickstart', path: 'quickstart', type: 'getting-started', priority: 'must-have', action: 'create', purpose: 'Send a first event.', rationale: 'A first-success path is required.', evidence: ['POST /events'], evidenceDetails: [{ source: 'pulse-api', path: 'openapi.json', label: 'POST /events' }] },
    { id: 'events', title: 'Events API', path: 'reference/events', type: 'reference', priority: 'must-have', action: 'create', purpose: 'Look up the request and responses.', rationale: 'The operation is public.', evidence: ['POST /events'], evidenceDetails: [{ source: 'pulse-api', path: 'openapi.json', label: 'POST /events' }] },
  ],
  questions: [], estimatedPages: 2, estimatedEffort: 'medium', discovery: { cacheKey: 'cache', generatedAt: '2026-08-26T08:00:00.000Z', deterministic: true, publicSignals: 4, suggestedPages: { starter: 3, standard: 7, comprehensive: 12 } }, target: { generator: 'doxbrix', contentDir: '', contentFormat: 'markdown', pageExtensions: ['.mdx'], navigationFiles: ['docs.json'] }, clarification: { mode: 'defaults', answers: {} }, execution: { agent: 'codex', model: 'gpt-test', reasoning: 'low', screenshots: false },
}

async function mockWorkspace(page, overrides = {}, apiOverrides = {}) {
  const calls = []
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url())
    const method = route.request().method()
    calls.push(`${method} ${url.pathname}`)
    const custom = await apiOverrides.handle?.({ method, path: url.pathname, request: route.request(), url })
    if (custom !== undefined) return route.fulfill({ json: custom })
    if (url.pathname === '/api/state') return route.fulfill({ json: { ...state, ...overrides, ...(apiOverrides.state?.() ?? {}) } })
    if (url.pathname === '/api/source-intelligence') return route.fulfill({ json: apiOverrides.intelligence ?? intelligence })
    if (['/api/comments', '/api/pages/search', '/api/direct-edits'].includes(url.pathname)) return route.fulfill({ json: [] })
    if (url.pathname === '/api/collections') return route.fulfill({ json: [{ directory: '', version: 'current', locale: 'default', native: true }] })
    if (url.pathname === '/api/authoring-estimate') return route.fulfill({ json: { samples: 0, message: 'No comparable completed runs yet.', cost: 'Provider billing applies.' } })
    if (url.pathname === '/api/pages') return route.fulfill({ json: documentationPages })
    if (url.pathname === '/api/preview/start') return route.fulfill({ json: { job: { id: 'preview-job', status: 'running' }, url: 'http://127.0.0.1:45991' } })
    if (/^\/api\/proposals\/[a-z0-9-]+\/preview\/start$/.test(url.pathname)) return route.fulfill({ json: { job: { id: 'proposal-preview-job', status: 'running' }, url: 'http://127.0.0.1:45992' } })
    if (url.pathname.endsWith('/diff')) return route.fulfill({ json: { binary: false, added: 1, removed: 1, rows: [{ type: 'delete', oldNumber: 4, html: 'Returns 200', hunkId: 'hunk-1', hunkState: 'pending' }, { type: 'insert', newNumber: 4, html: 'Returns 202', hunkId: 'hunk-1', hunkState: 'pending' }] } })
    if (url.pathname === '/api/jobs') return route.fulfill({ json: apiOverrides.state?.().jobs ?? overrides.jobs ?? [] })
    if (url.pathname === '/api/jobs/stream') return route.abort()
    return route.fulfill({ json: {} })
  })
  return calls
}

test.describe('stable workspace routes', () => {
  for (const [route, heading] of [['overview', 'Your documentation loop'], ['sources', 'Sources'], ['update', 'Update documentation'], ['pages', 'Pages'], ['review', 'Review'], ['deploy', 'Deploy'], ['settings', 'Settings']]) {
    test(`${route} has a direct URL`, async ({ page }) => {
      await mockWorkspace(page)
      await page.goto(`/${route}`)
      await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible()
      await expect(page).toHaveURL(new RegExp(`/${route}$`))
    })
  }

  for (const [legacy, route] of [['authoring', 'update'], ['proposals', 'review'], ['publish', 'deploy']]) {
    test(`/${legacy} redirects to /${route}`, async ({ page }) => {
      await mockWorkspace(page)
      await page.goto(`/${legacy}`)
      await expect(page).toHaveURL(new RegExp(`/${route}$`))
    })
  }

  test('unknown routes are explicit and browser history is preserved', async ({ page }) => {
    await mockWorkspace(page)
    await page.goto('/unsupported')
    await expect(page.getByRole('heading', { name: 'Workspace page not found' })).toBeVisible()
    await page.getByRole('button', { name: 'Open documentation update' }).click()
    await expect(page).toHaveURL(/\/update$/)
    await page.goBack()
    await expect(page.getByRole('heading', { name: 'Workspace page not found' })).toBeVisible()
  })

  test('the selected proposal, file, and settings section survive a refresh', async ({ page }) => {
    await mockWorkspace(page, { runs: [proposal] })
    await page.goto('/review')
    await page.getByText('Document event ingestion').click()
    await expect(page).toHaveURL(/\/review\?proposal=proposal-1$/)
    await page.reload()
    await expect(page.getByRole('heading', { name: 'Review proposal' })).toBeVisible()
    await page.goBack()
    await expect(page.getByRole('heading', { name: 'Review', exact: true })).toBeVisible()

    await page.goto('/settings?section=capture')
    await expect(page.getByRole('heading', { name: 'Application screenshots' })).toBeVisible()
    await page.getByRole('button', { name: /Audience and voice/ }).click()
    await expect(page).toHaveURL(/\/settings\?section=experience$/)
    await page.reload()
    await expect(page.getByRole('heading', { name: 'Audience and voice', exact: true })).toBeVisible()
  })
})

test('review opens on the first documentation page with supporting files folded', async ({ page }) => {
  const mixed = {
    ...proposal,
    changes: [
      { ...proposal.changes[0], id: 'change-1', title: 'evidence-map.json', path: '.doxloop/evidence-map.json', category: 'evidence' },
      { ...proposal.changes[0], id: 'change-2', title: 'SKILL.md', path: '.claude/skills/doxloop-authoring/SKILL.md', category: 'configuration' },
      { ...proposal.changes[0], id: 'change-3', title: 'docs.json', path: 'docs.json', category: 'navigation' },
      { ...proposal.changes[0], id: 'change-4' },
    ],
  }
  await mockWorkspace(page, { runs: [mixed] })
  await page.goto('/review?proposal=proposal-1')
  await expect(page.getByRole('heading', { name: 'Review proposal' })).toBeVisible()
  await expect(page.getByTitle('Review Events API')).toBeVisible()
  await expect(page).toHaveURL(/\/review\?proposal=proposal-1$/)
  await page.getByRole('button', { name: /events\.mdx/ }).click()
  const menu = page.getByRole('dialog', { name: 'Changed files' })
  await expect(menu.getByText('Documentation', { exact: true })).toBeVisible()
  await expect(menu.getByText('docs.json')).toBeVisible()
  await expect(menu.getByText('evidence-map.json')).toHaveCount(0)
  await menu.getByRole('button', { name: 'Show 2 supporting files' }).click()
  await expect(menu.getByText('evidence-map.json')).toBeVisible()
  await menu.getByRole('button', { name: 'docs.json' }).click()
  await expect(page).toHaveURL(/\/review\?proposal=proposal-1&file=change-3$/)
})

test('a file edited while the agent ran is grouped and needs confirmation before Accept all', async ({ page }) => {
  let acceptBody
  const concurrent = { ...proposal, changes: [{ ...proposal.changes[0], changedDuringRun: true }] }
  await mockWorkspace(page, { runs: [concurrent] }, {
    handle: async ({ method, path, request }) => {
      if (method === 'POST' && path === '/api/proposals/proposal-1/accept') { acceptBody = request.postDataJSON(); return { ...concurrent, status: 'applied' } }
    },
  })
  await page.goto('/review?proposal=proposal-1')
  await expect(page.getByText('This file was edited in the project while the agent ran.')).toBeVisible()
  await page.getByRole('button', { name: /events\.mdx/ }).click()
  await expect(page.getByRole('dialog', { name: 'Changed files' }).getByText('Changed while the agent ran')).toBeVisible()
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Accept all' }).click()
  const dialog = page.getByRole('dialog', { name: 'Apply these documentation changes?' })
  await expect(dialog.getByRole('button', { name: 'Apply changes' })).toBeDisabled()
  await dialog.getByText('Replace my edits to these files').click()
  await dialog.getByRole('button', { name: 'Apply changes' }).click()
  await expect.poll(() => acceptBody).toMatchObject({ scope: 'all', confirmChangedDuringRun: true })
})

test('the ready dialog opens the finished proposal', async ({ page }) => {
  const running = { id: 'update-job', type: 'author:update', status: 'running', startedAt: '2026-08-26T08:00:00.000Z', lines: [], stages: [] }
  let jobs = [running]
  let runs = []
  await mockWorkspace(page, {}, {
    state: () => ({ jobs, runs }),
    handle: async ({ method, path }) => {
      if (method === 'GET' && path === '/api/proposals') return runs
    },
  })
  await page.goto('/update')
  jobs = [{ ...running, status: 'succeeded', finishedAt: '2026-08-26T08:05:00.000Z' }]
  runs = [proposal]
  const dialog = page.getByRole('dialog', { name: 'Documentation changes are ready' })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: 'Review changes', exact: true }).click()
  await expect(page).toHaveURL(/\/review\?proposal=proposal-1$/)
  await expect(page.getByRole('heading', { name: 'Review proposal' })).toBeVisible()
})

test('a validation failure degrades to a notice instead of a blank workspace', async ({ page }) => {
  await mockWorkspace(page, { validation: { error: 'docs.json is not valid JSON' } })
  await page.goto('/overview')
  await expect(page.getByRole('heading', { name: 'Your documentation loop' })).toBeVisible()
  await expect(page.getByText('Validation unavailable')).toBeVisible()
  await expect(page.getByText(/docs\.json is not valid JSON/)).toBeVisible()
  await expect(page.getByText(/is signed in/)).toBeVisible()
})

test('Sources shows stale pages from drift', async ({ page }) => {
  await mockWorkspace(page, { drift: { status: 'stale', trackedPages: 2, pages: [{ page: 'reference/events.mdx', reasons: [{ source: 'pulse-api', paths: ['openapi.json'] }] }], sources: [{ name: 'pulse-api', changedPaths: ['openapi.json'], filteredPaths: 0 }] } })
  await page.goto('/sources')
  await expect(page.getByText('1 page behind the sources')).toBeVisible()
  await expect(page.getByText('pulse-api: 1 changed path')).toBeVisible()
  await page.getByRole('button', { name: 'Plan an update' }).click()
  await expect(page).toHaveURL(/\/update$/)
})

test('workspace pages stay fluid, readable, and expose usable buttons', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 })
  await mockWorkspace(page)

  for (const route of ['overview', 'sources', 'update', 'pages', 'review', 'deploy', 'settings']) {
    await page.goto(`/${route}`)

    const workspaceWidth = await page.locator('.workspace-main').evaluate((element) => element.getBoundingClientRect().width)
    const pageWidth = await page.locator('.workspace-main .page').evaluate((element) => element.getBoundingClientRect().width)
    expect(pageWidth / workspaceWidth).toBeGreaterThan(0.89)
    expect(pageWidth / workspaceWidth).toBeLessThan(0.95)
    await expect(page.getByText('Local', { exact: true })).toHaveCount(0)

    const invalidButtons = await page.locator('button:visible').evaluateAll((buttons) => buttons.flatMap((button) => {
      const box = button.getBoundingClientRect()
      const style = getComputedStyle(button)
      return box.width < 24 || box.height < 24 || style.color === 'rgb(0, 0, 0)'
        ? [{ label: button.getAttribute('aria-label') || button.textContent?.trim(), width: box.width, height: box.height, color: style.color }]
        : []
    }))
    expect(invalidButtons, `${route} contains an undersized or black-text button`).toEqual([])

    const blackText = await page.locator('h1:visible, h2:visible, h3:visible, h4:visible, p:visible, label:visible, legend:visible, strong:visible, small:visible, td:visible, th:visible').evaluateAll((elements) => elements.flatMap((element) => getComputedStyle(element).color === 'rgb(0, 0, 0)'
      ? [element.textContent?.trim().slice(0, 80)]
      : []))
    expect(blackText, `${route} contains black body copy`).toEqual([])
  }

  await page.goto('/update')
  await page.getByRole('button', { name: /Agent:/ }).click()
  const authoringPanelHeight = await page.locator('.authoring-request').evaluate((element) => element.getBoundingClientRect().height)
  expect(authoringPanelHeight).toBeLessThan(720)
  const optionBoxes = await page.locator('.authoring-options > *').evaluateAll((elements) => elements.map((element) => {
    const box = element.getBoundingClientRect()
    return { x: box.x, y: box.y, width: box.width }
  }))
  expect(optionBoxes).toHaveLength(4)
  expect(Math.max(...optionBoxes.map((box) => box.y)) - Math.min(...optionBoxes.map((box) => box.y))).toBeLessThan(2)
  expect(Math.min(...optionBoxes.map((box) => box.width))).toBeGreaterThan(180)

  await page.goto('/sources')
  await expect(page.locator('.source-coverage-row-heading').first()).toBeVisible()
  const coverageHeadings = await page.locator('.source-coverage-row-heading').evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().height))
  expect(coverageHeadings.length).toBeGreaterThan(0)
  expect(Math.min(...coverageHeadings)).toBeGreaterThanOrEqual(18)
})

test('Pages selects multiple pages and submits one scoped edit request', async ({ page }) => {
  let editBody
  const calls = await mockWorkspace(page, {}, {
    handle: async ({ method, path, request }) => {
      if (method === 'POST' && path === '/api/pages/edit') {
        editBody = request.postDataJSON()
        return { job: { id: 'edit-job', type: 'page-edit:run-page-edit', status: 'running', startedAt: '2026-08-26T08:00:00.000Z', lines: [], stages: [] } }
      }
    },
  })
  await page.goto('/pages')
  await expect(page.getByRole('checkbox', { name: 'Select Overview' })).toBeChecked()
  await page.getByRole('checkbox', { name: 'Select Events API' }).check()
  await expect(page.getByLabel('What should change on these 2 pages?')).toBeVisible()
  await expect(page.getByLabel('Pages selected for this update')).toContainText('2 pages in this edit')
  await expect(page.getByTitle('Current page preview')).toHaveAttribute('src', 'http://127.0.0.1:45991/reference/events?embed=page')
  await page.getByLabel('What should change on these 2 pages?').fill('Add a clearer curl example.')
  await page.getByText('Also allow related changes', { exact: true }).click()
  await page.getByRole('button', { name: 'Ask the agent to edit' }).click()

  await expect.poll(() => calls.includes('POST /api/pages/edit')).toBe(true)
  expect(editBody).toMatchObject({
    paths: ['reference/events.mdx', 'index.mdx'],
    instruction: 'Add a clearer curl example.',
    allowRelated: true,
    screenshots: 'disabled',
  })
})

test('Pages selects a single page on click and previews it', async ({ page }) => {
  await mockWorkspace(page)
  await page.goto('/pages')
  await expect(page.getByRole('checkbox', { name: 'Select Overview' })).toBeChecked()
  await page.getByRole('option', { name: /Events API/ }).click()
  await expect(page.getByRole('checkbox', { name: 'Select Overview' })).not.toBeChecked()
  await expect(page.getByRole('checkbox', { name: 'Select Events API' })).toBeChecked()
  await expect(page.getByLabel('What should change on this page?')).toBeVisible()
  await expect(page.getByTitle('Current page preview')).toHaveAttribute('src', 'http://127.0.0.1:45991/reference/events?embed=page')
  await expect(page).toHaveURL(/\/pages\?path=reference%2Fevents\.mdx$/)
})

test('Pages shows a running edit with live output and Stop', async ({ page }) => {
  const running = {
    ...editProposal,
    status: 'generating',
    changes: [],
  }
  const job = { id: 'edit-job', type: 'page-edit:run-page-edit', agent: 'codex', status: 'running', startedAt: '2026-08-26T08:00:00.000Z', lines: ['Reading reference/events.mdx'], stages: [] }
  const calls = await mockWorkspace(page, { runs: [running], jobs: [job] })
  await page.goto('/pages?run=run-page-edit')

  await expect(page.getByRole('heading', { name: 'Editing Events API' })).toBeVisible()
  await expect(page.getByText('Reading reference/events.mdx')).toBeVisible()
  await page.getByRole('button', { name: 'Stop', exact: true }).click()
  await expect.poll(() => calls.includes('POST /api/jobs/edit-job/cancel')).toBe(true)
})

test('Pages reviews, accepts, and undoes an agent edit', async ({ page }) => {
  const calls = await mockWorkspace(page, { runs: [editProposal] }, {
    handle: async ({ method, path }) => {
      if (method === 'GET' && path === '/api/proposals') return [editProposal]
      if (method === 'POST' && path === '/api/proposals/run-page-edit/accept') return { ...editProposal, status: 'applied', undo: { status: 'available' } }
      if (method === 'POST' && path === '/api/proposals/run-page-edit/undo') return { ...editProposal, status: 'undone', undo: { status: 'undone' } }
    },
  })
  await page.goto('/pages?run=run-page-edit')

  await expect(page.getByRole('heading', { name: 'Review this edit' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Accept', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Reject', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Refine', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Accept', exact: true }).click()
  await expect(page.getByRole('status')).toContainText('Page updated')
  await page.getByRole('status').getByRole('button', { name: 'Undo' }).click()

  await expect.poll(() => calls.includes('POST /api/proposals/run-page-edit/accept')).toBe(true)
  await expect.poll(() => calls.includes('POST /api/proposals/run-page-edit/undo')).toBe(true)
})

test('source health refresh and project-wide monitoring expose both budgets', async ({ page }) => {
  const calls = await mockWorkspace(page)
  await page.goto('/sources')
  const sourcesTable = page.getByRole('table', { name: 'Connected sources' })
  await expect(sourcesTable).toBeVisible()
  await expect(sourcesTable.getByRole('columnheader')).toHaveText(['Source', 'Type', 'Details', 'Status', 'Actions'])
  await expect(sourcesTable.getByRole('row')).toHaveCount(2)
  await expect(page.getByText(/3 operations/).first()).toBeVisible()
  await expect(page.getByRole('progressbar', { name: 'API operations coverage' })).toHaveAttribute('aria-valuenow', '100')
  await expect(page.getByText('3 of 3 discovered items are documented')).toBeVisible()
  await page.getByRole('button', { name: 'Test pulse-api' }).click()
  await expect.poll(() => calls.includes('POST /api/sources/pulse-api/test')).toBe(true)
  await page.getByRole('button', { name: 'Monitoring' }).click()
  const dialog = page.getByRole('dialog', { name: 'Configure project monitoring' })
  await expect(dialog).toContainText('all 1 connected sources')
  await dialog.getByRole('button', { name: /Advanced watch scope and budgets/ }).click()
  await expect(dialog.getByText('Maximum agent minutes')).toBeVisible()
  await expect(dialog.getByText('Maximum runs per day')).toBeVisible()
})

test('proposal review switches rendered/source views and accepts hunk, file, or complete scope', async ({ page }) => {
  const calls = await mockWorkspace(page, { runs: [proposal] })
  await page.goto('/review')
  await page.getByText('Document event ingestion').click()
  await expect(page.getByRole('heading', { name: 'Review proposal' })).toBeVisible()
  await expect(page.getByTitle('Review Events API')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Desktop', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Light', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'Source', exact: true }).click()
  await expect(page.getByText('Returns 202')).toBeVisible()
  await page.getByRole('button', { name: 'Accept change' }).click()
  await expect.poll(() => calls.filter((entry) => entry === 'POST /api/proposals/proposal-1/accept').length).toBe(1)
  await page.getByRole('button', { name: 'Accept file' }).click()
  await expect.poll(() => calls.filter((entry) => entry === 'POST /api/proposals/proposal-1/accept').length).toBe(2)
  await page.getByRole('button', { name: 'Accept all' }).click()
  await page.getByRole('dialog', { name: 'Apply these documentation changes?' }).getByRole('button', { name: 'Apply changes' }).click()
  await expect.poll(() => calls.filter((entry) => entry === 'POST /api/proposals/proposal-1/accept').length).toBe(3)
})

test('running work exposes structured stages and a cancel action', async ({ page }) => {
  const job = { id: 'job-1', type: 'plan:propose', agent: 'codex', status: 'running', startedAt: '2026-08-26T08:00:00.000Z', lines: ['Inspecting OpenAPI source'], stages: [{ id: 'sources', label: 'Inspect sources', status: 'running' }] }
  const calls = await mockWorkspace(page, { jobs: [job], receipt: null })
  await page.goto('/update')
  await expect(page.getByRole('list', { name: 'Documentation workflow stages' })).toContainText('Inspect sources')
  await page.getByRole('button', { name: 'Stop update' }).click()
  await expect.poll(() => calls.includes('POST /api/jobs/job-1/cancel')).toBe(true)
})

test('create uses the complete plan-review-approval-generation workflow', async ({ page }) => {
  let documentationPlan
  const calls = await mockWorkspace(page, { receipt: null }, {
    state: () => ({ documentationPlan }),
    handle: ({ method, path }) => {
      if (method === 'POST' && path === '/api/plans') { documentationPlan = readyPlan; return { plan: readyPlan, job: { id: 'planning', type: 'plan:propose', status: 'succeeded', startedAt: readyPlan.createdAt, lines: [], stages: [] } } }
      if (method === 'POST' && path === '/api/plans/plan-test/approve') { documentationPlan = { ...readyPlan, status: 'approved', approvedHash: 'hash' }; return documentationPlan }
      if (method === 'POST' && path === '/api/plans/plan-test/generate') { documentationPlan = { ...readyPlan, status: 'generated', proposalId: 'proposal-1' }; return { id: 'generation', type: 'plan:generate', status: 'running', startedAt: readyPlan.updatedAt, lines: [], stages: [] } }
      if (method === 'GET' && path === '/api/plans/plan-test/versions') return []
    },
  })
  await page.goto('/update')
  await expect(page.getByRole('heading', { name: 'Create documentation' })).toBeVisible()
  await page.getByPlaceholder(/Help developers install/).fill('Create complete event API documentation.')
  await page.getByRole('button', { name: /Comprehensive/ }).click()
  await page.getByRole('button', { name: 'Create documentation plan' }).click()
  await expect(page.getByRole('heading', { name: 'Review documentation structure' })).toBeVisible()
  // The navigation panel lists the same pages, so scope to the structure list.
  await expect(page.locator('.plan-tree-page').getByText('Quickstart', { exact: true })).toBeVisible()
  await expect(page.locator('.plan-tree-page').getByText('Events API', { exact: true })).toBeVisible()
  await expect(page.getByRole('tree', { name: 'Navigation' }).getByRole('treeitem')).toHaveCount(4)
  await page.getByRole('button', { name: 'Approve & generate 2 pages' }).click()
  await expect.poll(() => calls.includes('POST /api/plans/plan-test/approve')).toBe(true)
  await expect.poll(() => calls.includes('POST /api/plans/plan-test/generate')).toBe(true)
})

test('generated creation points to review instead of reopening the create form', async ({ page }) => {
  await mockWorkspace(page, {
    receipt: null,
    documentationPlan: { ...readyPlan, status: 'generated', proposalId: proposal.id },
    runs: [proposal],
  })
  await page.goto('/update')
  await expect(page.getByRole('heading', { name: 'Documentation plan', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Documentation proposal is ready' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Review generated files' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Create documentation plan' })).toHaveCount(0)
  await expect(page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Update' })).toBeVisible()
})

test('accepted plan-first creation becomes an update workflow without a legacy receipt', async ({ page }) => {
  await mockWorkspace(page, {
    receipt: null,
    documentationPlan: { ...readyPlan, status: 'generated', proposalId: proposal.id },
    runs: [{ ...proposal, status: 'applied' }],
  })
  await page.goto('/update')
  await expect(page.getByRole('heading', { name: 'Update documentation' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Plan documentation update' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Create documentation plan' })).toHaveCount(0)
})

test('an interrupted authoring job offers a durable stage retry', async ({ page }) => {
  const job = { id: 'deadbeef', type: 'plan:propose', agent: 'codex', status: 'failed', startedAt: '2026-08-26T08:00:00.000Z', finishedAt: '2026-08-26T08:01:00.000Z', lines: ['Doxloop recovered this interrupted job. Retry the stage when ready.'], stages: [{ id: 'sources', label: 'Inspect sources', status: 'failed' }], retryable: true, recovered: true }
  const calls = await mockWorkspace(page, { jobs: [job], receipt: null })
  await page.goto('/update')
  await page.getByRole('button', { name: /Live activity/ }).click()
  await expect(page.getByRole('button', { name: 'Retry stage' })).toBeVisible()
  await page.getByRole('button', { name: 'Retry stage' }).click()
  await expect.poll(() => calls.includes('POST /api/jobs/deadbeef/retry')).toBe(true)
})

test('coverage with no discovered items is shown as awaiting discovery', async ({ page }) => {
  const unknown = { ...intelligence, coverage: { ...intelligence.coverage, metrics: [{ ...intelligence.coverage.metrics[0], documented: 0, total: 0, percent: 0, status: 'unknown' }] } }
  await mockWorkspace(page, {}, { intelligence: unknown })
  await page.goto('/sources')
  await expect(page.getByText('Awaiting discovery', { exact: true })).toBeVisible()
  await expect(page.getByText('No items discovered', { exact: true })).toBeVisible()
})

test('coverage gaps expose recovery options and link existing pages', async ({ page }) => {
  const gap = {
    ...intelligence,
    coverage: {
      ...intelligence.coverage,
      pages: ['reference/events.mdx'],
      metrics: [{
        id: 'exports', label: 'Exports & schemas', documented: 1, total: 2, excluded: 0, percent: 50,
        denominator: 'Public exports', status: 'measured',
        items: [
          { id: 'signal-1111111111111111', surface: 'exports', label: 'PublicEvent', state: 'documented', source: 'pulse-api', path: 'openapi.json', kind: 'export' },
          { id: 'signal-2222222222222222', surface: 'exports', label: 'InternalEvent', state: 'uncovered', source: 'pulse-api', path: 'openapi.json', kind: 'export' },
        ],
      }],
    },
  }
  const calls = await mockWorkspace(page, {}, { intelligence: gap, handle: ({ method, path }) => method === 'POST' && path === '/api/coverage/resolve' ? gap : undefined })
  await page.goto('/sources')
  await page.getByRole('button', { name: 'Review 1 gap' }).click()
  const dialog = page.getByRole('dialog', { name: 'Exports & schemas' })
  await expect(dialog.getByText('InternalEvent')).toBeVisible()
  await dialog.getByRole('button', { name: 'Link existing page' }).click()
  await dialog.getByRole('button', { name: 'Link page' }).click()
  await expect.poll(() => calls.includes('POST /api/coverage/resolve')).toBe(true)
})

test('coverage gaps are selected before one batch update plan starts', async ({ page }) => {
  const gap = {
    ...intelligence,
    coverage: {
      ...intelligence.coverage,
      metrics: [{
        id: 'exports', label: 'Exports & schemas', documented: 0, total: 2, excluded: 0, percent: 0,
        denominator: 'Public exports', status: 'measured',
        items: [
          { id: 'signal-1111111111111111', surface: 'exports', label: 'PublicEvent', state: 'uncovered', source: 'pulse-api', path: 'openapi.json', kind: 'export' },
          { id: 'signal-2222222222222222', surface: 'exports', label: 'EventPayload', state: 'uncovered', source: 'pulse-api', path: 'openapi.json', kind: 'export' },
        ],
      }],
    },
  }
  const calls = await mockWorkspace(page, {}, { intelligence: gap })
  await page.goto('/sources')
  await page.getByRole('button', { name: 'Review 2 gaps' }).click()
  const dialog = page.getByRole('dialog', { name: 'Exports & schemas' })
  const createPlan = dialog.getByRole('button', { name: 'Create update plan' })
  await expect(createPlan).toBeDisabled()
  await dialog.getByRole('checkbox', { name: 'Add to update' }).first().check()
  await expect(dialog.getByText('1 gap ready to plan')).toBeVisible()
  await expect(calls.filter((call) => call === 'POST /api/plans')).toHaveLength(0)
  await dialog.getByRole('checkbox', { name: 'Select all 2 gaps' }).check()
  await expect(dialog.getByRole('button', { name: 'Create update plan (2)' })).toBeEnabled()
  await dialog.getByRole('button', { name: 'Create update plan (2)' }).click()
  await expect.poll(() => calls.filter((call) => call === 'POST /api/plans').length).toBe(1)
})

test('preview starts explicitly and first deployment requires a visibility decision', async ({ page }) => {
  const calls = await mockWorkspace(page, { account: { signedIn: true, apiUrl: 'https://app.doxbrix.com', user: { email: 'dev@example.com', name: 'Developer' } } })
  await page.goto('/deploy')
  await page.getByRole('button', { name: 'Preview docs' }).click()
  await expect.poll(() => calls.includes('POST /api/preview/start')).toBe(true)
  await page.getByRole('button', { name: 'Deploy to Doxbrix' }).click()
  const dialog = page.getByRole('dialog', { name: 'Who can see this documentation?' })
  await expect(dialog.getByRole('radio', { name: /Private/ })).toHaveAttribute('aria-checked', 'true')
  await expect(dialog.getByRole('radio', { name: /Public/ })).toContainText('Anyone with the published URL')
})

test('new-project setup presents the complete guided workflow', async ({ page }) => {
  await mockWorkspace(page, { projectFound: false, project: undefined, validation: undefined, receipt: null })
  await page.goto('/')
  await expect(page.getByRole('heading', { name: "Let's name your workspace" })).toBeVisible()
  await expect(page.getByRole('navigation', { name: 'Setup navigation' }).getByRole('button')).toHaveCount(5)
  await expect(page.getByRole('button', { name: /Sources/ })).toBeDisabled()
})

test('the activity feed names every job type and can stop a running one', async ({ page }) => {
  const jobs = [
    { id: 'login-1', type: 'login', status: 'running', startedAt: '2026-08-26T08:05:00.000Z', lines: ['Open the browser to finish signing in.'], stages: [] },
    { id: 'sync-1', type: 'sync', status: 'failed', startedAt: '2026-08-26T08:03:00.000Z', finishedAt: '2026-08-26T08:04:00.000Z', lines: ['doxloop: The configured source is unreachable.'], stages: [] },
    { id: 'install-1', type: 'agent:install', agent: 'codex', status: 'succeeded', startedAt: '2026-08-26T08:00:00.000Z', finishedAt: '2026-08-26T08:01:00.000Z', lines: [], stages: [] },
  ]
  const calls = await mockWorkspace(page, { jobs })
  await page.goto('/overview')
  const feed = page.locator('.overview-activity-card')
  await expect(feed).toContainText('Signing in to Doxbrix is running')
  await expect(feed).toContainText('Checking sources for changes needs attention: The configured source is unreachable.')
  await expect(feed).toContainText('Installing the agent completed successfully')
  await feed.getByRole('button', { name: 'Stop' }).click()
  await expect.poll(() => calls.includes('POST /api/jobs/login-1/cancel')).toBe(true)
})

test('running work shows pending stages and a pages-written counter', async ({ page }) => {
  const job = { id: 'job-2', type: 'plan:generate', agent: 'claude', status: 'running', startedAt: '2026-08-26T08:00:00.000Z', lines: ['→ Writing guides/setup.mdx'], stages: [
    { id: 'inspecting-sources', label: 'Confirming approved evidence', status: 'completed' },
    { id: 'authoring-pages', label: 'Authoring approved pages', status: 'running', progress: { done: 3, total: 12 } },
    { id: 'updating-navigation', label: 'Updating navigation and theme', status: 'pending' },
    { id: 'validating', label: 'Validating generated documentation', status: 'pending' },
  ] }
  await mockWorkspace(page, { jobs: [job], receipt: null })
  await page.goto('/update')
  const stages = page.getByRole('list', { name: 'Documentation workflow stages' })
  await expect(stages).toContainText('Authoring approved pages')
  await expect(stages).toContainText('3 of 12')
  await expect(stages.locator('li.pending')).toHaveCount(2)
})

test('a proposal revision shows its live run and a failure banner on Review', async ({ page }) => {
  const running = { id: 'rev-1', type: 'proposal:revise:proposal-1', agent: 'codex', status: 'running', startedAt: '2026-08-26T08:10:00.000Z', lines: ['Revising reference/events.mdx'], stages: [] }
  const calls = await mockWorkspace(page, { runs: [proposal], jobs: [running] })
  await page.goto('/review')
  await page.getByText('Document event ingestion').click()
  await expect(page.getByText('Revising reference/events.mdx')).toBeVisible()
  await page.getByRole('button', { name: 'Stop', exact: true }).click()
  await expect.poll(() => calls.includes('POST /api/jobs/rev-1/cancel')).toBe(true)

  const failed = { ...running, status: 'failed', finishedAt: '2026-08-26T08:12:00.000Z', lines: ['Revising reference/events.mdx', 'doxloop: The revision changed files outside the selected scope.'] }
  await mockWorkspace(page, { runs: [proposal], jobs: [failed] })
  await page.goto('/review')
  await page.getByText('Document event ingestion').click()
  const banner = page.getByRole('alert').filter({ hasText: 'The agent could not complete this revision.' })
  await expect(banner).toContainText('The revision changed files outside the selected scope.')
  await banner.getByRole('button', { name: 'Dismiss' }).click()
  await expect(banner).toHaveCount(0)
})

test('a failed deployment keeps its progress panel and the sign-in wait state is explained', async ({ page }) => {
  const finished = new Date(Date.now() - 60_000).toISOString()
  const deploy = { id: 'deploy-1', type: 'deploy', status: 'failed', startedAt: finished, finishedAt: finished, lines: ['Uploading snapshot', 'doxloop: The Doxbrix API rejected the upload (401).'], stages: [] }
  const login = { id: 'login-2', type: 'login', status: 'running', startedAt: finished, lines: ['Waiting for browser approval'], stages: [] }
  const calls = await mockWorkspace(page, { jobs: [login, deploy] })
  await page.goto('/deploy')
  await expect(page.getByText('Deployment failed')).toBeVisible()
  await expect(page.getByText('The Doxbrix API rejected the upload (401).')).toBeVisible()
  await expect(page.getByText('Finish signing in in your browser.')).toBeVisible()
  await page.getByRole('button', { name: 'Cancel sign-in' }).click()
  await expect.poll(() => calls.includes('POST /api/jobs/login-2/cancel')).toBe(true)
  await page.getByRole('button', { name: 'Dismiss' }).click()
  await expect(page.getByText('Deployment failed')).toHaveCount(0)
})

const recentProjects = [
  { path: '/tmp/pulse-docs', title: 'Pulse documentation', generator: 'doxbrix', lastOpenedAt: '2026-09-04T08:00:00.000Z' },
  { path: '/tmp/widget-manual', title: 'Widget manual', generator: 'mkdocs', lastOpenedAt: '2026-09-03T08:00:00.000Z' },
  { path: '/tmp/gone-docs', title: 'Gone docs', generator: 'doxbrix', lastOpenedAt: '2026-09-01T08:00:00.000Z', missing: true },
]

const mkdocsInspection = {
  root: '/tmp/widget-site', alreadyProject: false,
  detection: { candidates: [{ generator: 'mkdocs', contentDir: 'docs', markers: ['mkdocs.yml'], title: 'Widget site' }], recommended: { generator: 'mkdocs', contentDir: 'docs', markers: ['mkdocs.yml'], title: 'Widget site' } },
  generator: 'mkdocs', contentDir: 'docs', title: 'Widget site', markers: ['mkdocs.yml'], pageCount: 12,
  pages: ['docs/index.md', 'docs/guide/setup.md'], generatorInstalled: true, generatorPackage: '@doxbrix/doxloop-generator-mkdocs',
}

test('the sidebar project switcher lists recent projects and opens one', async ({ page }) => {
  const calls = await mockWorkspace(page, { recentProjects }, { handle: ({ method, path }) => {
    if (method === 'POST' && path === '/api/projects/open') return { ...state, recentProjects }
    return undefined
  } })
  await page.goto('/overview')
  await page.getByRole('button', { name: /Current workspace: Pulse documentation/ }).click()
  const menu = page.getByRole('menu', { name: 'Projects' })
  await expect(menu.getByText('Widget manual')).toBeVisible()
  await expect(menu.getByText('Gone docs')).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: /Gone docs/ })).toBeDisabled()
  await expect(menu.getByRole('menuitem', { name: /Open folder/ })).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: /Import existing documentation/ })).toBeVisible()
  await menu.getByRole('menuitem', { name: /Widget manual/ }).click()
  await expect.poll(() => calls.filter((call) => call === 'POST /api/projects/open').length).toBe(1)
  await expect(page).toHaveURL(/\/overview$/)
})

test('importing an existing folder inspects it before adopting it', async ({ page }) => {
  let importBody
  const calls = await mockWorkspace(page, { recentProjects }, { handle: ({ method, path, request }) => {
    if (method === 'GET' && path === '/api/projects') return { current: '/tmp/pulse-docs', recent: recentProjects, generators: [{ id: 'doxbrix', displayName: 'Doxbrix', installed: true }, { id: 'mkdocs', displayName: 'MkDocs Material', installed: true }] }
    if (method === 'POST' && path === '/api/projects/inspect') return mkdocsInspection
    if (method === 'POST' && path === '/api/projects/import') { importBody = request.postDataJSON(); return { ...state, imported: { root: '/tmp/widget-site' } } }
    return undefined
  } })
  await page.goto('/overview')
  await page.getByRole('button', { name: /Current workspace/ }).click()
  await page.getByRole('menuitem', { name: /Import existing documentation/ }).click()
  const dialog = page.getByRole('dialog', { name: 'Import existing documentation' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Import and open' })).toBeDisabled()
  await dialog.getByPlaceholder('/path/to/your/docs-site').fill('/tmp/widget-site')
  await dialog.getByRole('button', { name: 'Check' }).click()
  await expect(dialog.getByText('MkDocs Material site · 12 pages')).toBeVisible()
  await expect(dialog.getByText('docs/guide/setup.md')).toBeVisible()
  await expect(dialog.getByLabel('Documentation title')).toHaveValue('Widget site')
  await dialog.getByLabel('Documentation title').fill('Widget manual v2')
  await dialog.getByRole('button', { name: 'Import and open' }).click()
  await expect.poll(() => calls.filter((call) => call === 'POST /api/projects/import').length).toBe(1)
  expect(importBody).toMatchObject({ path: '/tmp/widget-site', generator: 'mkdocs', contentDir: 'docs', title: 'Widget manual v2', installGenerator: false })
})

test('new-project setup can adopt an existing documentation folder instead of scaffolding', async ({ page }) => {
  await mockWorkspace(page, { projectFound: false, project: undefined, validation: undefined, receipt: null }, { handle: ({ method, path }) => {
    if (method === 'GET' && path === '/api/projects') return { current: null, recent: [], generators: [{ id: 'doxbrix', displayName: 'Doxbrix', installed: true }] }
    if (method === 'POST' && path === '/api/projects/inspect') return { ...mkdocsInspection, generator: 'doxbrix', contentDir: 'docs', markers: ['docs/docs.json'], pageCount: 1, pages: ['docs/index.md'] }
    return undefined
  } })
  await page.goto('/')
  await expect(page.getByRole('heading', { name: "Let's name your workspace" })).toBeVisible()
  await page.getByRole('radio', { name: /Use existing documentation folder/ }).click()
  await expect(page.getByRole('heading', { name: 'Use existing documentation' })).toBeVisible()
  await expect(page.getByRole('button', { name: /Continue/ })).toHaveCount(0)
  await expect(page.getByText("Import above to open the folder's pages.")).toBeVisible()
  await page.getByPlaceholder('/path/to/your/docs-site').fill('/tmp/widget-site')
  await page.getByRole('button', { name: 'Check' }).click()
  await expect(page.getByText('Doxbrix site · 1 page')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Import and open' })).toBeEnabled()
  await page.getByRole('radio', { name: /Start new/ }).click()
  await expect(page.getByRole('heading', { name: "Let's name your workspace" })).toBeVisible()
})

const navigationTree = {
  generator: 'doxbrix', editable: true, configFile: 'docs.json', fingerprint: 'nav-1', requiresEveryPage: true,
  supports: { icons: true, hidden: true, labels: true, links: true, dividers: true, spaces: true },
  spaces: [{ name: 'Documentation', nav: [
    { type: 'group', label: 'Get started', icon: 'rocket', items: [
      { type: 'page', file: 'index', path: 'index.mdx', title: 'Overview', pageTitle: 'Overview' },
      { type: 'page', file: 'quickstart', path: 'quickstart.mdx', pageTitle: 'Quickstart' },
    ] },
    { type: 'page', file: 'reference/events', path: 'reference/events.mdx', pageTitle: 'Events API' },
  ] }],
  orphans: [{ file: 'faq', path: 'faq.mdx', title: 'FAQ' }],
  icons: ['book', 'rocket'],
}

test('Pages → Navigation reorders a page and saves the tree with its fingerprint', async ({ page }) => {
  let saved
  const calls = await mockWorkspace(page, {}, {
    handle: async ({ method, path, request }) => {
      if (method === 'GET' && path === '/api/navigation') return navigationTree
      if (method === 'PUT' && path === '/api/navigation') { saved = request.postDataJSON(); return { ...navigationTree, fingerprint: 'nav-2', spaces: saved.spaces } }
    },
  })
  await page.goto('/pages?view=navigation')
  await expect(page.getByRole('heading', { name: 'Sidebar navigation' })).toBeVisible()
  const tree = page.getByRole('tree', { name: 'Navigation' })
  await expect(tree.getByRole('treeitem')).toHaveCount(4)
  await expect(page.getByRole('button', { name: 'Save navigation' })).toBeDisabled()
  await page.getByRole('button', { name: 'Move Overview down' }).click()
  await page.getByRole('button', { name: 'Add page' }).click()
  await page.getByRole('button', { name: /FAQ/ }).click()
  await expect(tree.getByRole('treeitem')).toHaveCount(5)
  await page.getByRole('button', { name: 'Save navigation' }).click()
  await expect.poll(() => calls.includes('PUT /api/navigation')).toBe(true)
  expect(saved.fingerprint).toBe('nav-1')
  expect(saved.spaces[0].nav[0].items.map((node) => node.file)).toEqual(['quickstart', 'index'])
  expect(saved.spaces[0].nav.at(-1)).toMatchObject({ type: 'page', file: 'faq' })
  expect(JSON.stringify(saved)).not.toContain('pageTitle')
  await expect(page.getByRole('button', { name: 'Save navigation' })).toBeDisabled()
})

test('Settings → Branding edits the Doxbrix theme and only sends the changed fields', async ({ page }) => {
  let saved
  const branding = {
    generator: 'doxbrix', editable: true, configFile: 'docs.json', fingerprint: 'brand-1',
    site: { name: 'Pulse documentation', description: 'Docs for Pulse.' },
    theme: { primaryColor: '#6366f1', mode: 'system', font: 'Inter' },
    assets: [{ path: 'assets/logo.png', name: 'logo.png', publicPath: '/assets/logo.png' }],
  }
  const calls = await mockWorkspace(page, {}, {
    handle: async ({ method, path, request }) => {
      if (method === 'GET' && path === '/api/branding') return branding
      if (method === 'PUT' && path === '/api/branding') { saved = request.postDataJSON(); return { ...branding, fingerprint: 'brand-2', theme: { ...branding.theme, ...saved.theme } } }
    },
  })
  await page.goto('/settings?section=branding')
  await expect(page.getByRole('heading', { name: 'Branding' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Save branding' })).toBeDisabled()
  const primary = page.getByLabel('Primary colour', { exact: true })
  await primary.fill('#112233')
  await page.getByLabel('Heading font').fill('Manrope')
  await page.getByRole('button', { name: 'Save branding' }).click()
  await expect.poll(() => calls.includes('PUT /api/branding')).toBe(true)
  expect(saved).toEqual({ fingerprint: 'brand-1', theme: { primaryColor: '#112233', headingFont: 'Manrope' } })
})

test('Pages → Images & files lists assets with their uses and saves alt text', async ({ page }) => {
  let altBody
  const asset = { path: 'assets/team.png', name: 'team.png', publicPath: '/assets/team.png', kind: 'image', bytes: 2048, modifiedAt: '2026-08-26T08:00:00.000Z', references: [{ page: 'reference/events.mdx', alt: 'Team settings' }] }
  const calls = await mockWorkspace(page, {}, {
    handle: async ({ method, path, request }) => {
      if (method === 'GET' && path === '/api/assets') return { directory: 'assets', publicPrefix: '/assets', maxBytes: 10485760, assets: [asset] }
      if (method === 'POST' && path === '/api/assets/alt') { altBody = request.postDataJSON(); return { ...asset, references: [{ page: 'reference/events.mdx', alt: altBody.alt }] } }
    },
  })
  await page.goto('/pages?view=assets')
  await expect(page.getByRole('heading', { name: 'Images and files' })).toBeVisible()
  await page.getByRole('listitem').filter({ hasText: 'team.png' }).click()
  await expect(page.getByText('/assets/team.png').first()).toBeVisible()
  await page.getByLabel('Alt text').fill('The team settings page with the invite form open')
  await page.getByRole('button', { name: 'Save alt text' }).click()
  await expect.poll(() => calls.includes('POST /api/assets/alt')).toBe(true)
  expect(altBody).toEqual({ path: 'assets/team.png', alt: 'The team settings page with the invite form open' })
})
