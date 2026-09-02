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
    const custom = await apiOverrides.handle?.({ method, path: url.pathname })
    if (custom !== undefined) return route.fulfill({ json: custom })
    if (url.pathname === '/api/state') return route.fulfill({ json: { ...state, ...overrides, ...(apiOverrides.state?.() ?? {}) } })
    if (url.pathname === '/api/source-intelligence') return route.fulfill({ json: apiOverrides.intelligence ?? intelligence })
    if (url.pathname.endsWith('/diff')) return route.fulfill({ json: { binary: false, added: 1, removed: 1, rows: [{ type: 'delete', oldNumber: 4, html: 'Returns 200', hunkId: 'hunk-1', hunkState: 'pending' }, { type: 'insert', newNumber: 4, html: 'Returns 202', hunkId: 'hunk-1', hunkState: 'pending' }] } })
    if (url.pathname === '/api/jobs') return route.fulfill({ json: apiOverrides.state?.().jobs ?? overrides.jobs ?? [] })
    if (url.pathname === '/api/jobs/stream') return route.abort()
    return route.fulfill({ json: {} })
  })
  return calls
}

test.describe('stable workspace routes', () => {
  for (const [route, heading] of [['overview', 'Your documentation loop'], ['sources', 'Sources'], ['authoring', 'Update documentation'], ['proposals', 'Review Changes'], ['publish', 'Deploy'], ['settings', 'Settings']]) {
    test(`${route} has a direct URL`, async ({ page }) => {
      await mockWorkspace(page)
      await page.goto(`/${route}`)
      await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible()
      await expect(page).toHaveURL(new RegExp(`/${route}$`))
    })
  }

  test('unknown routes are explicit and browser history is preserved', async ({ page }) => {
    await mockWorkspace(page)
    await page.goto('/unsupported')
    await expect(page.getByRole('heading', { name: 'Workspace page not found' })).toBeVisible()
    await page.getByRole('button', { name: 'Open documentation update' }).click()
    await expect(page).toHaveURL(/\/authoring$/)
    await page.goBack()
    await expect(page.getByRole('heading', { name: 'Workspace page not found' })).toBeVisible()
  })
})

test('workspace pages stay fluid, readable, and expose usable buttons', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 })
  await mockWorkspace(page)

  for (const route of ['overview', 'sources', 'authoring', 'proposals', 'publish', 'settings']) {
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

  await page.goto('/authoring')
  await page.getByRole('button', { name: /Planning agent:/ }).click()
  const authoringPanelHeight = await page.locator('.authoring-request').evaluate((element) => element.getBoundingClientRect().height)
  expect(authoringPanelHeight).toBeLessThan(520)
  const optionBoxes = await page.locator('.authoring-options > *').evaluateAll((elements) => elements.map((element) => {
    const box = element.getBoundingClientRect()
    return { x: box.x, y: box.y, width: box.width }
  }))
  expect(optionBoxes).toHaveLength(5)
  expect(Math.max(...optionBoxes.map((box) => box.y)) - Math.min(...optionBoxes.map((box) => box.y))).toBeLessThan(2)
  expect(Math.min(...optionBoxes.map((box) => box.width))).toBeGreaterThan(180)

  await page.goto('/sources')
  const coverageHeadings = await page.locator('.source-coverage-row-heading').evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().height))
  expect(coverageHeadings.length).toBeGreaterThan(0)
  expect(Math.min(...coverageHeadings)).toBeGreaterThanOrEqual(18)
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
  await page.goto('/proposals')
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
  await page.goto('/authoring')
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
  await page.goto('/authoring')
  await expect(page.getByRole('heading', { name: 'Create documentation' })).toBeVisible()
  await page.getByPlaceholder(/Help developers install/).fill('Create complete event API documentation.')
  await page.getByRole('button', { name: /Comprehensive/ }).click()
  await page.getByRole('button', { name: 'Create documentation plan' }).click()
  await expect(page.getByRole('heading', { name: 'Review documentation structure' })).toBeVisible()
  await expect(page.getByText('Quickstart', { exact: true })).toBeVisible()
  await expect(page.getByText('Events API', { exact: true })).toBeVisible()
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
  await page.goto('/authoring')
  await expect(page.getByRole('heading', { name: 'Documentation proposal', exact: true })).toBeVisible()
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
  await page.goto('/authoring')
  await expect(page.getByRole('heading', { name: 'Update documentation' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Plan documentation update' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Create documentation plan' })).toHaveCount(0)
})

test('an interrupted authoring job offers a durable stage retry', async ({ page }) => {
  const job = { id: 'deadbeef', type: 'plan:propose', agent: 'codex', status: 'failed', startedAt: '2026-08-26T08:00:00.000Z', finishedAt: '2026-08-26T08:01:00.000Z', lines: ['Doxloop recovered this interrupted job. Retry the stage when ready.'], stages: [{ id: 'sources', label: 'Inspect sources', status: 'failed' }], retryable: true, recovered: true }
  const calls = await mockWorkspace(page, { jobs: [job], receipt: null })
  await page.goto('/authoring')
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
  await page.goto('/publish')
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
