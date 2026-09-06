import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  applyDocumentationPlanProposal,
  approveDocumentationPlan,
  beginDocumentationPlanRevision,
  continueDocumentationPlanGeneration,
  createDocumentationPlan,
  editDocumentationPlan,
  agentReplyFromStream,
  extractPlanOutput,
  ignoreDocumentationPlanError,
  latestDocumentationPlan,
  listDocumentationPlanVersions,
  readDocumentationPlan,
  resumeDocumentationPlan,
  requiredScreenshotPlanIssue,
  shallowCaptureAdvisory,
  retryDocumentationPlan,
  screenshotCoverageAdvisory,
  screenshotPlanningInstructions,
  documentationPlanClarificationFeedback,
  DEFAULT_PLANNING_TIMEOUT_MINUTES,
  planningTimeoutMinutes,
  proposeDocumentationPlan,
  planWritingRequirements,
} from './documentation-plan.js'
import { loadProject, saveProjectSettings, scaffoldProject } from './project.js'

const roots: string[] = []
const originalPath = process.env.PATH
const originalTimeout = process.env.DOXLOOP_PLAN_TIMEOUT_MINUTES

afterEach(async () => {
  if (originalPath === undefined) delete process.env.PATH
  else process.env.PATH = originalPath
  if (originalTimeout === undefined) delete process.env.DOXLOOP_PLAN_TIMEOUT_MINUTES
  else process.env.DOXLOOP_PLAN_TIMEOUT_MINUTES = originalTimeout
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture(withSpec = false): Promise<{ root: string; spec?: string }> {
  const parent = await mkdtemp(join(tmpdir(), 'doxloop-plan-'))
  roots.push(parent)
  const spec = join(parent, 'openapi.json')
  if (withSpec) await writeFile(spec, '{"openapi":"3.1.0","info":{"title":"Plan API","version":"1"},"paths":{}}\n')
  const root = await scaffoldProject({
    directory: join(parent, 'docs'),
    sources: withSpec ? [{ name: 'api', path: '../openapi.json', kind: 'openapi' }] : [],
  })
  return { root, ...(withSpec ? { spec } : {}) }
}

const proposal = {
  productProfile: 'Developer API',
  summary: 'Help developers reach a first successful request.',
  audiences: ['API developers'],
  outcomes: ['Authenticate and make a request'],
  terminology: { token: 'API access token' },
  exclusions: ['Internal operations', 'Scope exception: the fixture exposes only one reader-facing operation.'],
  instructions: 'Prefer TypeScript examples.',
  estimatedEffort: 'small',
  capabilities: [{
    id: 'make-request',
    title: 'Make an API request',
    kind: 'workflow',
    evidence: [{ source: 'api', path: 'openapi.json', kind: 'openapi', label: 'POST /requests' }],
    pageIds: ['quickstart'],
    disposition: 'planned',
  }],
  pages: [{
    id: 'quickstart',
    title: 'Quickstart',
    path: 'quickstart',
    type: 'getting-started',
    priority: 'must-have',
    action: 'update',
    purpose: 'Complete the first successful request.',
    rationale: 'This is the primary reader outcome.',
    evidence: ['api: POST /requests'],
    evidenceDetails: [{ source: 'api', path: 'openapi.json', kind: 'openapi', label: 'POST /requests' }],
  }],
  questions: [],
}

describe('documentation plan workflow', () => {
  test('reads the agent plan past quoted reference examples and echoed instructions', () => {
    const template = '{\n  "productProfile": "short evidence-grounded product classification",\n  "summary": "what this plan accomplishes",\n  "audiences": ["reader groups"],\n  "pages": [{ "id": "stable-kebab-id" }]\n}'
    const prompt = `Return the plan.\n\nThe JSON object must use this exact shape:\n${template}`
    const transcript = [
      `I will follow the instructions:\n${prompt}`,
      // The skill references the agent reads carry their own fenced JSON.
      '# Doxloop project format\n\n```json\n{"schemaVersion":1,"title":"Example documentation","contentDir":"","generator":"doxbrix"}\n```',
      '```json\n{"schemaVersion":1,"pages":{"guides/authentication.md":{"sources":[]}}}\n```',
      JSON.stringify({ ...proposal, productProfile: 'Real answer' }),
    ].join('\n')

    const plan = extractPlanOutput(transcript, 'codex', prompt) as { productProfile: string }
    expect(plan.productProfile).toBe('Real answer')
  })

  test('prefers a delimited plan block and reports a malformed plan specifically', () => {
    const delimited = `chatter\n<doxloop-plan>\n${JSON.stringify(proposal)}\n</doxloop-plan>`
    expect((extractPlanOutput(delimited, 'codex') as { productProfile: string }).productProfile).toBe('Developer API')

    // Claude streams its answer as JSON lines with the reply in `result`.
    const streamed = `{"type":"system"}\n${JSON.stringify({ type: 'result', result: JSON.stringify(proposal) })}`
    expect((extractPlanOutput(streamed, 'claude') as { productProfile: string }).productProfile).toBe('Developer API')
    const codexStream = [
      JSON.stringify({ type: 'item.completed', item: { type: 'reasoning', text: '{"productProfile":"wrong"}' } }),
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: `Here is the plan.\n<doxloop-plan>${JSON.stringify(proposal)}</doxloop-plan>` } }),
    ].join('\n')
    expect((extractPlanOutput(codexStream, 'codex') as { productProfile: string }).productProfile).toBe('Developer API')
    const geminiStream = [
      JSON.stringify({ type: 'init', model: 'gemini-3.5-flash' }),
      JSON.stringify({ type: 'message', role: 'assistant', content: '<doxloop-plan>', delta: true }),
      JSON.stringify({ type: 'message', role: 'assistant', content: `${JSON.stringify(proposal)}</doxloop-plan>`, delta: true }),
      JSON.stringify({ type: 'result', status: 'success' }),
    ].join('\n')
    expect((extractPlanOutput(geminiStream, 'gemini') as { productProfile: string }).productProfile).toBe('Developer API')
    expect(agentReplyFromStream('prose only', 'codex')).toBeUndefined()

    // A stray brace that closes the plan early must be reported, never
    // silently truncated into a plan that has lost its remaining pages.
    const malformed = '{"productProfile":"x","summary":"y","pages":[{"id":"a","visuals":{"mode":"none"}}},{"id":"b"}],"questions":[]}'
    expect(() => extractPlanOutput(malformed, 'codex')).toThrow(/malformed documentation-plan/)
    expect(() => extractPlanOutput('The application looks fine to me.', 'codex')).toThrow(/did not return a valid/)
  })

  test('reports thin screenshot coverage for review without failing the plan', () => {
    const guide = {
      mode: 'required',
      rationale: 'Show the visible workspace state readers start from.',
      estimatedCaptures: 1,
      startPath: '/',
      workflow: 'Open the control center and inspect the visible state without changing data.',
      captureSequence: ['Open the control center — the workspace screen is visible — orients the reader.'],
    }
    const procedural = (id: string, visuals?: unknown) => ({
      ...proposal.pages[0], id, title: id, path: id, type: 'how-to', action: 'create', ...(visuals ? { visuals } : {}),
    })
    // The single-page control center hides its screens behind clicks, so a
    // planner that only opened "/" reports one guide for the whole product.
    const thin = { pages: [procedural('a', guide), procedural('b'), procedural('c')] as never }
    expect(screenshotCoverageAdvisory(thin, { screenshots: 'enabled' })).toContain('1 of 3 procedural pages')
    // Thin coverage is reviewable, never a blocking gate: an application parked
    // on its first-run screen has nothing else to show.
    expect(requiredScreenshotPlanIssue(thin, { screenshots: 'enabled' })).toBeUndefined()

    const covered = { pages: [procedural('a', guide), procedural('b', guide), procedural('c')] as never }
    expect(screenshotCoverageAdvisory(covered, { screenshots: 'enabled' })).toBeUndefined()
    // The advisory only applies when screenshots were actually required.
    expect(screenshotCoverageAdvisory(thin, { screenshots: 'auto' })).toBeUndefined()
  })

  test('tells the planner to reveal single-page screens by interacting, not by guessing routes', () => {
    const instructions = screenshotPlanningInstructions()
    expect(instructions).toContain('single-page applications where every screen shares one URL')
    expect(instructions).toContain('Do not submit, create, delete, deploy, publish, send')
    expect(instructions).toContain('only after you actually attempted to reach it')
    expect(instructions).not.toContain('include at least one complete screenshot-enabled UI guide')
  })

  test('keeps capture preparation out of plan clarification questions', () => {
    const instructions = screenshotPlanningInstructions()
    expect(instructions).toContain('must take precedence over any generic in-app Browser plugin')
    expect(instructions).toContain('Never add a plan question solely about preparing')
    expect(instructions).toContain('do not trigger a second planning pass')
    expect(instructions).not.toContain('add one clear question')
  })

  test('rejects a required screenshot proposal before review when it has no complete visual guide', () => {
    expect(requiredScreenshotPlanIssue({ pages: proposal.pages as never }, { screenshots: 'enabled' })).toContain('planned no application screenshots')
    expect(requiredScreenshotPlanIssue({ pages: [{
      ...proposal.pages[0],
      visuals: {
        mode: 'required',
        rationale: 'Show the complete request workflow and its saved result.',
        estimatedCaptures: 4,
        startPath: '/requests/new',
        workflow: 'Open the form, enter safe demo data, submit it, and verify the saved request.',
        captureSequence: [
          'Open the request form — the empty form is visible — orients the reader before entering data.',
          'Enter demo request data — completed fields are visible — confirms the expected safe input.',
          'Submit the request — the success confirmation is visible — proves the operation completed.',
          'Open request details — the saved request is visible — shows how to verify the final result.',
        ],
      },
    }] as never }, { screenshots: 'enabled' })).toBeUndefined()
  })

  test('drops an agent-generated capture setup question instead of starting another planning pass', async () => {
    const { root } = await fixture()
    const created = await createDocumentationPlan(root, { mode: 'update', scope: 'custom', execution: { screenshots: 'enabled' } })
    const ready = await applyDocumentationPlanProposal(root, created.id, {
      ...proposal,
      questions: [{
        id: 'prepare-capture-surface',
        question: 'Can you restart the capture surface with synthetic fixture data?',
        whyItMatters: 'The screenshot workflow needs a prepared application state.',
        recommendation: 'Prepare a non-production application before capture.',
      }],
    })

    expect(ready.questions).toEqual([])
    expect(ready.status).toBe('ready-for-review')
  })

  test('persists a planning checkpoint and accepts a structured agent proposal', async () => {
    const { root } = await fixture()
    const created = await createDocumentationPlan(root, {
      mode: 'create',
      scope: 'starter',
      request: 'Create API onboarding docs',
      execution: { agent: 'codex', screenshots: false },
    })

    expect(created.status).toBe('planning')
    const ready = await applyDocumentationPlanProposal(root, created.id, proposal, 'codex')
    expect(ready).toMatchObject({ status: 'ready-for-review', version: 1, scope: 'starter' })
    expect((await latestDocumentationPlan(root))?.id).toBe(created.id)
    expect((await readDocumentationPlan(root, created.id)).pages[0]?.title).toBe('Quickstart')
  })

  test('preserves configured priority outcomes when the planner rewords them', async () => {
    const { root } = await fixture()
    const project = await loadProject(root)
    await saveProjectSettings(root, { documentation: { ...project.documentation, priorityOutcomes: ['Reach a first successful result'] } })
    const created = await createDocumentationPlan(root, { mode: 'create', scope: 'starter', execution: { screenshots: false } })
    const ready = await applyDocumentationPlanProposal(root, created.id, proposal)

    expect(ready.outcomes).toEqual(['Reach a first successful result', 'Authenticate and make a request'])
  })

  test('keeps disabled capture deterministic and requires a visual page for required mode', async () => {
    const { root } = await fixture()
    const disabled = await createDocumentationPlan(root, { mode: 'update', scope: 'custom', execution: { screenshots: 'disabled' } })
    const ready = await applyDocumentationPlanProposal(root, disabled.id, {
      ...proposal,
      pages: [{ ...proposal.pages[0], visuals: { mode: 'recommended', rationale: 'Show the completed request state.', estimatedCaptures: 1 } }],
    })
    expect(ready.pages[0]?.visuals).toMatchObject({ mode: 'none', estimatedCaptures: 0 })

    const required = await createDocumentationPlan(root, { mode: 'update', scope: 'custom', execution: { screenshots: 'enabled' } })
    await applyDocumentationPlanProposal(root, required.id, proposal)
    await expect(approveDocumentationPlan(root, required.id)).rejects.toThrow('screenshot-enabled visible UI guide')
  })

  test('requires a reachable application and complete capture directions before approval', async () => {
    const { root } = await fixture()
    const created = await createDocumentationPlan(root, { mode: 'update', scope: 'custom', execution: { screenshots: 'enabled' } })
    const ready = await applyDocumentationPlanProposal(root, created.id, {
      ...proposal,
      pages: [{ ...proposal.pages[0], visuals: { mode: 'required', rationale: 'Show the completed request state.', estimatedCaptures: 1 } }],
    })
    await expect(approveDocumentationPlan(root, ready.id)).rejects.toThrow('start path, workflow')

    const detailed = await editDocumentationPlan(root, ready.id, {
      pages: [{ ...ready.pages[0], visuals: {
        ...ready.pages[0]!.visuals,
        startPath: '/missing',
        workflow: 'Use demo data, submit the request, and capture the visible success confirmation.',
        captureSequence: [
          'Open the request form — the empty form is visible — orients the reader.',
          'Enter demo request data — completed fields are visible — confirms the expected input.',
          'Submit the request — the success confirmation is visible — proves the operation completed.',
          'Open request details — the saved request state is visible — shows how to verify the result.',
        ],
      } }],
    })
    await expect(approveDocumentationPlan(root, detailed.id)).rejects.toThrow('Configure a safe local or test application')

    const server = createServer((request, response) => { response.statusCode = request.url === '/missing' ? 404 : 200; response.end('ready') })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    try {
      if (!address || typeof address === 'string') throw new Error('Missing test server address')
      await saveProjectSettings(root, { application: { baseUrl: `http://127.0.0.1:${address.port}` } })
      await expect(approveDocumentationPlan(root, detailed.id)).rejects.toThrow('starting route')
      const corrected = await editDocumentationPlan(root, detailed.id, {
        pages: [{ ...detailed.pages[0], visuals: { ...detailed.pages[0]!.visuals, startPath: '/requests/new' } }],
      })
      await expect(approveDocumentationPlan(root, corrected.id)).resolves.toMatchObject({ status: 'approved' })
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    }
  })

  test('does not block approval for incomplete automatic screenshot candidates', async () => {
    const { root } = await fixture()
    const created = await createDocumentationPlan(root, { mode: 'update', scope: 'custom', execution: { screenshots: 'auto' } })
    const ready = await applyDocumentationPlanProposal(root, created.id, {
      ...proposal,
      pages: [{
        ...proposal.pages[0],
        title: 'Use the control center',
        visuals: {
          mode: 'recommended',
          rationale: '',
          estimatedCaptures: 3,
        },
      }],
    })

    await expect(approveDocumentationPlan(root, ready.id)).resolves.toMatchObject({
      status: 'approved',
      execution: { screenshots: 'auto' },
    })
  })

  test('expands token screenshot estimates into a complete visual story', async () => {
    const { root } = await fixture()
    const created = await createDocumentationPlan(root, { mode: 'update', scope: 'custom', execution: { screenshots: 'enabled' } })
    const ready = await applyDocumentationPlanProposal(root, created.id, {
      ...proposal,
      pages: [{ ...proposal.pages[0], visuals: {
        mode: 'required',
        rationale: 'Show the complete first request workflow.',
        estimatedCaptures: 1,
        startPath: '/requests/new',
        workflow: 'Use demo data, create a request, and verify the saved result.',
      } }],
    })

    expect(ready.pages[0]?.visuals?.estimatedCaptures).toBe(4)
    await expect(approveDocumentationPlan(root, ready.id)).rejects.toThrow('capture-sequence item per planned image')
  })

  test('keeps the capture estimate aligned with an explicit meaningful sequence', async () => {
    const { root } = await fixture()
    const created = await createDocumentationPlan(root, { mode: 'update', scope: 'custom', execution: { screenshots: 'enabled' } })
    const ready = await applyDocumentationPlanProposal(root, created.id, {
      ...proposal,
      pages: [{ ...proposal.pages[0], type: 'how-to', visuals: {
        mode: 'required',
        rationale: 'Show the only safe application state verified during planning.',
        estimatedCaptures: 1,
        startPath: '/',
        workflow: 'Open the safe initial page and inspect the verified state without changing data.',
        captureSequence: [
          'Open the initial page — the verified setup state is visible — orient readers without inventing later states.',
        ],
      } }],
    })

    expect(ready.pages[0]?.visuals).toMatchObject({ estimatedCaptures: 1 })
    expect(ready.pages[0]?.visuals?.captureSequence).toHaveLength(1)
    expect(requiredScreenshotPlanIssue(ready, ready.execution)).toBeUndefined()
  })

  test('migrates a persisted schema version 1 plan to the complete version 2 contract', async () => {
    const { root } = await fixture()
    const created = await createDocumentationPlan(root, {
      mode: 'create',
      scope: 'starter',
      execution: { screenshots: false },
    })
    const legacy = JSON.parse(JSON.stringify(created)) as Record<string, unknown>
    legacy.schemaVersion = 1
    for (const key of ['experienceLevel', 'preferredExamples', 'locale', 'accessibilityTarget', 'styleGuide', 'capabilities', 'navigation', 'estimatedPages', 'discovery', 'target', 'clarification']) delete legacy[key]
    legacy.pages = (legacy.pages as Array<Record<string, unknown>>).map(({ evidenceDetails: _evidenceDetails, ...page }) => page)
    const path = join(root, '.doxloop', 'plans', created.id, 'plan.json')
    await writeFile(path, `${JSON.stringify(legacy, null, 2)}\n`)

    const migrated = await readDocumentationPlan(root, created.id)
    expect(migrated).toMatchObject({ schemaVersion: 2, experienceLevel: 'mixed', locale: 'en-US' })
    expect(migrated.target).toMatchObject({ generator: 'doxbrix', navigationFiles: ['docs.json'] })
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ schemaVersion: 2 })
  })

  test('versions direct edits, clears questions, and locks an approved snapshot', async () => {
    const { root } = await fixture()
    const created = await createDocumentationPlan(root, {
      mode: 'update',
      scope: 'standard',
      execution: { screenshots: 'auto' },
    })
    const needsInput = await applyDocumentationPlanProposal(root, created.id, {
      ...proposal,
      questions: [{ id: 'language', question: 'Which example language?', whyItMatters: 'Changes every example.', recommendation: 'TypeScript' }],
    })
    expect(needsInput.status).toBe('needs-input')

    const edited = await editDocumentationPlan(root, created.id, {
      pages: [{ ...needsInput.pages[0], title: 'API quickstart' }],
      questions: [],
      scope: 'custom',
    })
    expect(edited).toMatchObject({ status: 'ready-for-review', version: 2, scope: 'custom' })
    expect((await listDocumentationPlanVersions(root, created.id)).map((item) => item.version)).toEqual([2, 1])
    const approved = await approveDocumentationPlan(root, created.id)
    expect(approved.status).toBe('approved')
    expect(approved.approvedHash).toMatch(/^[a-f0-9]{64}$/)
    expect(JSON.parse(await readFile(join(root, '.doxloop', 'documentation-plan.json'), 'utf8'))).toMatchObject({ id: created.id, version: 2, status: 'approved' })

    await expect(editDocumentationPlan(root, created.id, { pages: approved.pages.map((page) => ({ ...page, priority: 'later' })) })).rejects.toThrow('current run')
    const changed = await editDocumentationPlan(root, created.id, { pages: approved.pages.map((page) => ({ ...page, title: 'Updated API quickstart' })) })
    expect(changed).toMatchObject({ status: 'ready-for-review', version: 3 })
    expect(changed.approvedHash).toBeUndefined()
  })

  test('turns one consolidated clarification set into revision feedback and persists the answers', async () => {
    const { root } = await fixture()
    const created = await createDocumentationPlan(root, {
      mode: 'create',
      scope: 'starter',
      clarificationMode: 'stop',
      execution: { screenshots: false },
    })
    const paused = await applyDocumentationPlanProposal(root, created.id, {
      ...proposal,
      questions: [{ id: 'language', question: 'Which example language?', whyItMatters: 'Changes the examples.', recommendation: 'TypeScript' }],
    })
    expect(documentationPlanClarificationFeedback(paused, {}, true)).toContain('Answer: TypeScript')
    await expect(async () => documentationPlanClarificationFeedback(paused, {}, false)).rejects.toThrow('Answer')
    const revising = await beginDocumentationPlanRevision(root, created.id, { language: 'Python' })
    expect(revising.clarification).toMatchObject({ mode: 'stop', answers: { language: 'Python' } })
  })

  test('omits deferred backlog pages from the proposed generation scope', async () => {
    const { root } = await fixture()
    const created = await createDocumentationPlan(root, {
      mode: 'create',
      scope: 'standard',
      execution: { screenshots: false },
    })
    const ready = await applyDocumentationPlanProposal(root, created.id, {
      ...proposal,
      pages: [
        ...proposal.pages,
        { ...proposal.pages[0], id: 'future-reference', title: 'Future reference', path: 'future-reference', priority: 'later' },
      ],
    })

    expect(ready.pages.map((page) => page.title)).toEqual(['Quickstart'])
  })

  test('rejects an undersized initial create plan without an evidence-based scope exception', async () => {
    const { root } = await fixture()
    const created = await createDocumentationPlan(root, {
      mode: 'create',
      scope: 'standard',
      execution: { screenshots: false },
    })

    await expect(applyDocumentationPlanProposal(root, created.id, {
      ...proposal,
      exclusions: ['Internal operations'],
    })).rejects.toThrow('needs at least 7 distinct evidence-supported pages')
  })

  test('enforces the reviewer page target on a create plan', async () => {
    const { root } = await fixture()
    const created = await createDocumentationPlan(root, {
      mode: 'create',
      scope: 'standard',
      targetPages: 9,
      execution: { screenshots: false },
    })
    expect(created.targetPages).toBe(9)
    expect(created.estimatedPages).toBeGreaterThanOrEqual(9)

    await expect(applyDocumentationPlanProposal(root, created.id, {
      ...proposal,
      exclusions: ['Internal operations'],
    })).rejects.toThrow('The reviewer asked for at least 9 pages to write.')
  })

  test('flags procedural guides that plan fewer captures than their steps open', () => {
    const page = (captures: number, workflow: string) => ({
      ...proposal.pages[0],
      id: 'guide', title: 'Manage sources', path: 'guides/manage-sources', type: 'how-to', action: 'create',
      visuals: { mode: 'required', rationale: 'Dense configuration.', estimatedCaptures: captures, startPath: '/sources', workflow, captureSequence: Array.from({ length: captures }, (_, index) => `Step ${index + 1} — state — why`) },
    })
    const shallow = { pages: [page(1, 'Open Sources, open Monitoring, expand Advanced, and inspect budgets.')] as never }
    expect(shallowCaptureAdvisory(shallow, { screenshots: 'enabled' })).toContain('"Manage sources" plans 1 capture')
    expect(shallowCaptureAdvisory(shallow, { screenshots: 'disabled' })).toBeUndefined()
    const single = { pages: [page(1, 'Open Sources; the guide is a single screen with no further reachable state.')] as never }
    expect(shallowCaptureAdvisory(single, { screenshots: 'enabled' })).toBeUndefined()
    const deep = { pages: [page(4, 'Open Sources, open Monitoring, expand Advanced, and inspect budgets.')] as never }
    expect(shallowCaptureAdvisory(deep, { screenshots: 'enabled' })).toBeUndefined()
  })

  test('approves a plan whose source evidence changed and notes it instead of demanding a revision', async () => {
    const { root, spec } = await fixture(true)
    const created = await createDocumentationPlan(root, {
      mode: 'create',
      scope: 'standard',
      execution: { screenshots: false },
    })
    const proposed = await applyDocumentationPlanProposal(root, created.id, proposal)
    await writeFile(spec!, '{"openapi":"3.1.0","info":{"title":"Plan API","version":"2"},"paths":{}}\n')

    const approved = await approveDocumentationPlan(root, created.id)
    expect(approved.status).toBe('approved')
    expect(approved.error).toBeUndefined()
    expect(approved.sourceSnapshot).not.toBe(proposed.sourceSnapshot)
    expect(approved.pages.map((page) => page.id)).toEqual(proposed.pages.map((page) => page.id))
    expect(approved.advisories).toEqual([expect.stringContaining('Configured sources changed after this plan was proposed')])
    expect((await readDocumentationPlan(root, created.id)).status).toBe('approved')
  })

  test('re-approves a plan whose generation failed so the reviewer can retry', async () => {
    const { root } = await fixture(true)
    const created = await createDocumentationPlan(root, {
      mode: 'create',
      scope: 'standard',
      execution: { screenshots: false },
    })
    const proposed = await applyDocumentationPlanProposal(root, created.id, proposal)
    const approved = await approveDocumentationPlan(root, created.id)
    // Generation failed after approval: the reviewed plan is intact.
    await writeFile(
      join(root, '.doxloop', 'plans', created.id, 'plan.json'),
      `${JSON.stringify({ ...approved, status: 'failed', error: 'The documentation agent exited with status 1.' }, null, 2)}\n`,
    )

    const retried = await approveDocumentationPlan(root, created.id)
    expect(retried.status).toBe('approved')
    expect(retried.error).toBeUndefined()
    expect(retried.pages.map((page) => page.id)).toEqual(proposed.pages.map((page) => page.id))
    expect(retried.approvedHash).toBe(approved.approvedHash)
  })

  test('keeps a plan marked stale by an earlier version approvable or resumable', async () => {
    const { root } = await fixture(true)
    const created = await createDocumentationPlan(root, {
      mode: 'create',
      scope: 'standard',
      execution: { screenshots: false },
    })
    const proposed = await applyDocumentationPlanProposal(root, created.id, proposal)
    await writeFile(
      join(root, '.doxloop', 'plans', created.id, 'plan.json'),
      `${JSON.stringify({ ...proposed, status: 'stale', sourceSnapshot: 'outdated', error: 'Configured source evidence changed after this plan was proposed. Revise the plan before approval.' }, null, 2)}\n`,
    )

    const resumed = await resumeDocumentationPlan(root, created.id)
    expect(resumed.status).toBe('ready-for-review')
    expect(resumed.error).toBeUndefined()
    expect(resumed.sourceSnapshot).not.toBe('outdated')
    expect(resumed.version).toBe(proposed.version)
    expect((await beginDocumentationPlanRevision(root, created.id)).status).toBe('revising')

    await writeFile(
      join(root, '.doxloop', 'plans', created.id, 'plan.json'),
      `${JSON.stringify({ ...proposed, status: 'stale', sourceSnapshot: 'outdated', error: 'stale' }, null, 2)}\n`,
    )
    const approved = await approveDocumentationPlan(root, created.id)
    expect(approved.status).toBe('approved')
    expect(approved.error).toBeUndefined()
    await expect(resumeDocumentationPlan(root, created.id)).rejects.toThrow('cannot continue from status approved')
  })

  test('lets a reviewer continue with a plan the planner could not finish', async () => {
    const { root } = await fixture()
    const created = await createDocumentationPlan(root, { mode: 'create', scope: 'standard', execution: { screenshots: false } })
    const proposed = await applyDocumentationPlanProposal(root, created.id, proposal)
    // A planning gate failed after the agent proposed real pages.
    await writeFile(
      join(root, '.doxloop', 'plans', created.id, 'plan.json'),
      `${JSON.stringify({ ...proposed, status: 'failed', error: 'The planning agent could not produce an approvable plan. Too few pages.', failure: { stage: 'propose', resumable: false, ignorable: true } }, null, 2)}\n`,
    )
    await expect(continueDocumentationPlanGeneration(root, created.id, 'resume')).rejects.toThrow('no preserved generation workspace')
    // A plan that failed before failures were recorded is classified on read.
    await writeFile(
      join(root, '.doxloop', 'plans', created.id, 'plan.json'),
      `${JSON.stringify({ ...proposed, status: 'failed', error: 'The planning agent could not produce an approvable plan. Too few pages.' }, null, 2)}\n`,
    )
    expect((await readDocumentationPlan(root, created.id)).failure).toEqual({ stage: 'propose', resumable: false, ignorable: true })
    const continued = await ignoreDocumentationPlanError(root, created.id)
    expect(continued.status).toBe('ready-for-review')
    expect(continued.error).toBeUndefined()
    expect(continued.failure).toBeUndefined()
    expect(continued.pages.map((page) => page.id)).toEqual(['quickstart'])
    expect(continued.advisories?.[0]).toContain('Accepted for review despite a planning problem')
    // The advisory does not count as plan content, so approval still works.
    const approved = await approveDocumentationPlan(root, created.id)
    expect(approved.status).toBe('approved')
    await expect(ignoreDocumentationPlanError(root, created.id)).rejects.toThrow('no failure to ignore')

    // A planner that left nothing behind cannot be continued.
    await writeFile(
      join(root, '.doxloop', 'plans', created.id, 'plan.json'),
      `${JSON.stringify({ ...proposed, pages: [], status: 'failed', error: 'The agent exited.', failure: { stage: 'propose', resumable: false, ignorable: false } }, null, 2)}\n`,
    )
    await expect(ignoreDocumentationPlanError(root, created.id)).rejects.toThrow('Retry planning')
  })

  test('treats stale recovery actions as successful after generation already completed', async () => {
    const { root } = await fixture()
    const created = await createDocumentationPlan(root, { mode: 'create', scope: 'standard', execution: { screenshots: false } })
    const proposed = await applyDocumentationPlanProposal(root, created.id, proposal)
    const approved = await approveDocumentationPlan(root, proposed.id)
    const generated = { ...approved, status: 'generated' as const, proposalId: 'run-completed', updatedAt: new Date().toISOString() }
    await writeFile(
      join(root, '.doxloop', 'plans', created.id, 'plan.json'),
      `${JSON.stringify(generated, null, 2)}\n`,
    )

    await expect(ignoreDocumentationPlanError(root, created.id)).resolves.toMatchObject({ status: 'generated', proposalId: 'run-completed' })
    await expect(continueDocumentationPlanGeneration(root, created.id, 'ignore-errors')).resolves.toMatchObject({ status: 'generated', proposalId: 'run-completed' })
    await expect(continueDocumentationPlanGeneration(root, created.id, 'resume')).resolves.toMatchObject({ status: 'generated', proposalId: 'run-completed' })
  })

  test('rejects unsafe page paths from an agent proposal', async () => {
    const { root } = await fixture()
    const created = await createDocumentationPlan(root, {
      mode: 'create',
      scope: 'standard',
      execution: { screenshots: false },
    })
    await expect(applyDocumentationPlanProposal(root, created.id, {
      ...proposal,
      pages: [{ ...proposal.pages[0], path: '../outside' }],
    })).rejects.toThrow('safe relative path')
  })

  test('restores an interrupted plan only to its last safe durable stage', async () => {
    const { root } = await fixture()
    const created = await createDocumentationPlan(root, { mode: 'create', scope: 'starter', execution: { screenshots: false } })
    const cancelled = await import('./documentation-plan.js').then(({ cancelDocumentationPlan }) => cancelDocumentationPlan(root, created.id))
    expect(cancelled.status).toBe('cancelled')
    const restored = await retryDocumentationPlan(root, created.id, 'propose')
    expect(restored.status).toBe('planning')
    expect(restored.error).toBeUndefined()
    await expect(retryDocumentationPlan(root, created.id, 'generate')).rejects.toThrow('approved snapshot')
  })
})

describe('planning time budget', () => {
  test('defaults to twenty minutes, follows the project budget, and lets the environment override both', () => {
    expect(planningTimeoutMinutes({ sync: { mode: 'check', on: [], watch: [], ignore: [] } }, {})).toBe(DEFAULT_PLANNING_TIMEOUT_MINUTES)
    expect(DEFAULT_PLANNING_TIMEOUT_MINUTES).toBe(20)
    expect(planningTimeoutMinutes({ sync: { mode: 'check', on: [], watch: [], ignore: [], budget: { maxMinutes: 45 } } }, {})).toBe(45)
    expect(planningTimeoutMinutes({ sync: { mode: 'check', on: [], watch: [], ignore: [], budget: { maxMinutes: 45 } } }, { DOXLOOP_PLAN_TIMEOUT_MINUTES: '5' })).toBe(5)
    expect(planningTimeoutMinutes({ sync: { mode: 'check', on: [], watch: [], ignore: [] } }, { DOXLOOP_PLAN_TIMEOUT_MINUTES: 'soon' })).toBe(20)
    expect(planningTimeoutMinutes({ sync: { mode: 'check', on: [], watch: [], ignore: [] } }, { DOXLOOP_PLAN_TIMEOUT_MINUTES: '0' })).toBe(20)
  })

  test('stops a planner that never answers and records a named failure', async () => {
    if (process.platform === 'win32') return
    const parent = await mkdtemp(join(tmpdir(), 'doxloop-plan-timeout-'))
    roots.push(parent)
    const root = await scaffoldProject({ directory: join(parent, 'docs'), sources: [] })
    const executable = join(parent, 'codex')
    // Ignores SIGTERM so the escalation to SIGKILL is exercised too.
    await writeFile(executable, '#!/bin/sh\ntrap "" TERM\n/bin/sleep 30\n')
    await chmod(executable, 0o755)
    process.env.PATH = parent
    process.env.DOXLOOP_PLAN_TIMEOUT_MINUTES = '0.01'
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    const created = await createDocumentationPlan(root, { mode: 'create', scope: 'starter', execution: { agent: 'codex', screenshots: false } })
    const started = Date.now()
    await expect(proposeDocumentationPlan(root, created.id)).rejects.toThrow('Planning stopped after 1 second without a plan reply from codex')
    expect(Date.now() - started).toBeLessThan(20_000)
    const failed = await readDocumentationPlan(root, created.id)
    expect(failed.status).toBe('failed')
    expect(failed.error).toContain('DOXLOOP_PLAN_TIMEOUT_MINUTES')
    expect(failed.failure).toMatchObject({ stage: 'propose' })
  }, 30_000)
})

describe('diagram requirements', () => {
  test('defaults concept pages to a required diagram and keeps reviewer overrides', async () => {
    const { root } = await fixture()
    const created = await createDocumentationPlan(root, { mode: 'update', scope: 'custom', execution: { screenshots: 'disabled' } })
    const base = proposal.pages[0]!
    const ready = await applyDocumentationPlanProposal(root, created.id, {
      ...proposal,
      pages: [
        { ...base, id: 'model', title: 'Event model', path: 'concepts/event-model', type: 'concept' },
        { ...base, id: 'send', title: 'Send an event', path: 'guides/send', type: 'how-to' },
        { ...base, id: 'plain', title: 'Plain concept', path: 'concepts/plain', type: 'concept', diagram: 'none' },
        { ...base, id: 'ref', title: 'Reference', path: 'reference/events', type: 'reference', diagram: 'required' },
      ],
    })
    expect(ready.pages.map((page) => [page.id, page.diagram])).toEqual([['model', 'required'], ['send', 'none'], ['plain', 'none'], ['ref', 'required']])
    expect(planWritingRequirements(ready)).toContain('- Event model (concepts/event-model)')
    expect(planWritingRequirements(ready)).toContain('- Reference (reference/events)')
    expect(planWritingRequirements(ready)).not.toContain('Plain concept')
  })
})
