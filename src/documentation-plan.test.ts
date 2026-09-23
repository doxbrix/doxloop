import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
  applyPlanPatch,
  planRevisionPatchInstructions,
  withoutAnsweredQuestions,
  extractPlanOutput,
  fillExistingPageDetails,
  readPlanOutput,
  ignoreDocumentationPlanError,
  latestDocumentationPlan,
  listDocumentationPlanVersions,
  readDocumentationPlan,
  resumeDocumentationPlan,
  requiredScreenshotPlanIssue,
  shallowCaptureAdvisory,
  retryDocumentationPlan,
  updateDocumentationPlanExecution,
  researchBlockedError,
  screenshotCoverageAdvisory,
  screenshotPlanningInstructions,
  documentationPlanClarificationFeedback,
  DEFAULT_PLANNING_TIMEOUT_MINUTES,
  markDocumentationPlanInterrupted,
  repairMechanicalPlanIssues,
  gateRevisionInstructions,
  planningEffort,
  planningTimeoutForBatch,
  proposalCheckpointKey,
  readProposalCheckpoint,
  writeProposalCheckpoint,
  clearProposalCheckpoint,
  planningTimeoutMinutes,
  proposeDocumentationPlan,
  planWritingRequirements,
  existingDocumentationPlanShape,
  dropUnknownCaptureIds, assignSectionSpaces } from './documentation-plan.js'
import { readPlanPatchOutput } from './agent-reply.js'
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

  test('closes a reply that stops short of its final brackets and reports the repair', () => {
    // End on a completed object, as the real reply did (its last entry was an
    // existing-documentation disposition), with the closing `]}` missing.
    const full = { ...proposal, questions: [{ id: 'q1', question: 'Which auth flow first?', whyItMatters: 'ordering', recommendation: 'tokens' }] }
    const complete = JSON.stringify(full)
    expect(complete.endsWith('}]}')).toBe(true)
    expect(readPlanOutput(complete, 'codex').repairs).toEqual([])

    // A 60k-character Codex plan came back `]}` short twice in a row; the
    // reply is complete apart from its closers, so nothing is lost by adding them.
    const short = complete.slice(0, -2)
    const closed = readPlanOutput(`Here is the plan.\n<doxloop-plan>\n${short}\n</doxloop-plan>`, 'codex')
    expect(closed.plan).toEqual(full)
    expect(closed.repairs).toEqual([expect.stringMatching(/2 closing brackets short .* appended "\]\}"/)])

    // The first failed attempt also finished with a stray closing tag.
    const tagged = readPlanOutput(`<doxloop-plan>\n${short}</existingDocumentation>\n</doxloop-plan>`, 'codex')
    expect(tagged.plan).toEqual(full)
    expect(tagged.repairs).toHaveLength(1)

    // Codex streams the reply as an agent message; the same repair applies there.
    const stream = JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: `<doxloop-plan>${short}</doxloop-plan>` } })
    expect(readPlanOutput(stream, 'codex').plan).toEqual(full)
  })

  test('never closes a reply that was cut off inside a value', () => {
    const complete = JSON.stringify(proposal)
    // Cut inside the last string: closing it would fabricate a value.
    const insideString = complete.slice(0, complete.lastIndexOf('"') - 3)
    expect(() => extractPlanOutput(`<doxloop-plan>${insideString}</doxloop-plan>`, 'codex')).toThrow(/malformed documentation-plan .*never closed and looks cut off/)
    // Cut after a comma: the next page never arrived, so the plan is incomplete.
    const afterComma = '{"productProfile":"x","summary":"y","capabilities":[],"pages":[{"id":"a","visuals":{"mode":"none"}},'
    expect(() => extractPlanOutput(afterComma, 'codex')).toThrow(/never closed and looks cut off/)
    // Cut partway through a page object: its remaining fields are missing.
    const insidePage = '{"productProfile":"x","summary":"y","capabilities":[],"pages":[{"id":"a"},{"id":"b","title":"B"'
    expect(() => extractPlanOutput(insidePage, 'codex')).toThrow(/never closed and looks cut off/)
    // A wrong closer at the very end is a swapped tail and is rewritten with
    // a note; a wrong closer with more content after it is malformed.
    const swapped = '{"productProfile":"x","summary":"y","capabilities":[],"pages":[{"id":"a"}}'
    const rewritten = readPlanOutput(swapped, 'codex')
    expect(rewritten.plan).toEqual({ productProfile: 'x', summary: 'y', capabilities: [], pages: [{ id: 'a' }] })
    expect(rewritten.repairs).toEqual([expect.stringMatching(/planner's reply ended with the wrong closing brackets \("\}" where "\]\}" closes the JSON object\)/)])
    const mismatched = '{"productProfile":"x","summary":"y","capabilities":[],"pages":[{"id":"a"}},"questions":[]}'
    expect(() => extractPlanOutput(mismatched, 'codex')).toThrow(/malformed documentation-plan/)
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

  test('tells the planner to reveal single-page screens by interacting, within a fixed browser budget', () => {
    const instructions = screenshotPlanningInstructions()
    expect(instructions).toContain('single-page applications where every screen shares one URL')
    expect(instructions).toContain('at most 12 doxloop_capture calls in total during planning')
    expect(instructions).toContain('Do not fill forms, submit, create, delete, deploy, publish, send')
    expect(instructions).toContain('only after you attempted to reach it within the budget')
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

  test('starts a comprehensive screenshot plan without client-supplied limits', async () => {
    const { root } = await fixture()
    const created = await createDocumentationPlan(root, {
      mode: 'create',
      scope: 'comprehensive',
      execution: { screenshots: 'enabled' },
    })
    expect(created.status).toBe('planning')
    expect(created.execution.limits).toEqual({ maxPages: 500, maxScreenshots: 300, maxMinutes: 120 })
    expect((await readDocumentationPlan(root, created.id)).execution.limits).toEqual(created.execution.limits)
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

  test('requires complete capture directions but only warns about application readiness at approval', async () => {
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
    const unconfigured = await approveDocumentationPlan(root, detailed.id)
    expect(unconfigured.status).toBe('approved')
    expect(unconfigured.advisories?.join('\n')).toContain('Screenshot warning: Configure a safe local or test application')

    const server = createServer((request, response) => { response.statusCode = request.url === '/missing' || request.url === '/settings' ? 404 : 200; response.end('ready') })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    try {
      if (!address || typeof address === 'string') throw new Error('Missing test server address')
      await saveProjectSettings(root, { application: { baseUrl: `http://127.0.0.1:${address.port}` } })
      await editDocumentationPlan(root, detailed.id, {})
      const missingRoute = await approveDocumentationPlan(root, detailed.id)
      expect(missingRoute.status).toBe('approved')
      const warnings = (missingRoute.advisories ?? []).filter((item) => item.startsWith('Screenshot warning:'))
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toContain('/missing')
      expect(warnings[0]).toContain('HTTP 404')
      const corrected = await editDocumentationPlan(root, detailed.id, {
        pages: [{ ...detailed.pages[0], visuals: { ...detailed.pages[0]!.visuals, startPath: '/requests/new' } }],
      })
      const clean = await approveDocumentationPlan(root, corrected.id)
      expect(clean.status).toBe('approved')
      expect((clean.advisories ?? []).some((item) => item.startsWith('Screenshot warning:'))).toBe(false)

      // A hash-routed base URL keeps the route in the fragment, so /settings
      // is probed as the application document rather than a server path.
      await saveProjectSettings(root, { application: { baseUrl: `http://127.0.0.1:${address.port}/_/#` } })
      const hashRouted = await editDocumentationPlan(root, detailed.id, {
        pages: [{ ...detailed.pages[0], visuals: { ...detailed.pages[0]!.visuals, startPath: '/settings' } }],
      })
      const hashApproved = await approveDocumentationPlan(root, hashRouted.id)
      expect((hashApproved.advisories ?? []).some((item) => item.startsWith('Screenshot warning:'))).toBe(false)
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

  test('keeps a single requested capture and still requires its state description', async () => {
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

    expect(ready.pages[0]?.visuals?.estimatedCaptures).toBe(1)
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

  test('accepts one meaningful image without manufacturing extra capture states', () => {
    const page = (captures: number, workflow: string) => ({
      ...proposal.pages[0],
      id: 'guide', title: 'Manage sources', path: 'guides/manage-sources', type: 'how-to', action: 'create',
      visuals: { mode: 'required', rationale: 'Dense configuration.', estimatedCaptures: captures, startPath: '/sources', workflow, captureSequence: Array.from({ length: captures }, (_, index) => `Step ${index + 1} — state — why`) },
    })
    const shallow = { pages: [page(1, 'Open Sources, open Monitoring, expand Advanced, and inspect budgets.')] as never }
    expect(shallowCaptureAdvisory(shallow, { screenshots: 'enabled' })).toBeUndefined()
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

  test('reads a plan as generated once its failed proposal was continued from the proposal itself', async () => {
    const { root } = await fixture()
    const created = await createDocumentationPlan(root, { mode: 'create', scope: 'standard', execution: { screenshots: false } })
    const proposed = await applyDocumentationPlanProposal(root, created.id, proposal)
    const approved = await approveDocumentationPlan(root, proposed.id)
    // Generation failed validation; the reviewer resumed the proposal from the
    // Proposals panel (not the plan), and that resume applied the pages.
    const proposalId = 'run-20260913t044845z-ed50d5'
    await mkdir(join(root, '.doxloop', 'runs', proposalId), { recursive: true })
    await writeFile(
      join(root, '.doxloop', 'runs', proposalId, 'run.json'),
      `${JSON.stringify({
        schemaVersion: 2,
        id: proposalId,
        status: 'applied',
        mode: 'create',
        trigger: 'manual',
        createdAt: new Date().toISOString(),
        summary: 'Continuing the interrupted documentation run',
        sourceSummary: '',
        stalePages: [],
        changes: [],
        revisionRequests: [],
        humanEdits: [],
        planId: created.id,
      }, null, 2)}\n`,
    )
    await writeFile(
      join(root, '.doxloop', 'plans', created.id, 'plan.json'),
      `${JSON.stringify({
        ...approved,
        status: 'failed',
        error: 'The documentation agent exited with status 1.',
        failure: { stage: 'generate', proposalId, resumable: true, ignorable: true },
      }, null, 2)}\n`,
    )

    const plan = await readDocumentationPlan(root, created.id)
    expect(plan).toMatchObject({ status: 'generated', proposalId })
    expect(plan.error).toBeUndefined()
    expect(plan.failure).toBeUndefined()
    // Recovery controls rendered before the refresh resolve without an error.
    await expect(continueDocumentationPlanGeneration(root, created.id, 'ignore-errors')).resolves.toMatchObject({ status: 'generated', proposalId })
    await expect(continueDocumentationPlanGeneration(root, created.id, 'resume')).resolves.toMatchObject({ status: 'generated', proposalId })
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

  test('re-points a plan at another assistant and keeps a valid approval', async () => {
    const { root } = await fixture()
    const created = await createDocumentationPlan(root, { mode: 'create', scope: 'standard', execution: { agent: 'claude', model: 'claude-sonnet-5', effort: 'high', screenshots: false } })
    const proposed = await applyDocumentationPlanProposal(root, created.id, proposal)
    const approved = await approveDocumentationPlan(root, proposed.id)
    const switched = await updateDocumentationPlanExecution(root, approved.id, { agent: 'codex', model: undefined })
    expect(switched.execution).toMatchObject({ agent: 'codex', effort: 'high' })
    expect(switched.execution.model).toBeUndefined()
    expect(switched.status).toBe('approved')
    expect(switched.approvedHash).not.toBe(approved.approvedHash)
    // The re-stamped approval still passes the generation check.
    const reread = await readDocumentationPlan(root, approved.id)
    expect(reread.approvedHash).toBe(switched.approvedHash)
    await expect(updateDocumentationPlanExecution(root, approved.id, { agent: 'codex' })).resolves.toMatchObject({ updatedAt: switched.updatedAt })
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

describe('research sessions blocked by the assistant', () => {
  test('names the sign-in problem instead of asking for a retry of the missing briefs', async () => {
    const { AgentSessionError } = await import('./agent-failure.js')
    const blocker = new AgentSessionError('claude', 'research "application"', 1, 'Failed to authenticate: OAuth session expired and could not be refreshed')
    const error = researchBlockedError(new Error('2 research sessions did not finish ("application": x; "product": y). The briefs that finished are saved; retry the plan to run only the missing ones.'), blocker)
    expect(error.message).toBe('2 research sessions did not finish: Claude Code could not sign in (OAuth session expired and could not be refreshed). Run `claude auth login` or switch assistant, then retry.')
    expect(error.message).not.toContain('missing ones')
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
    // A batch's own minutes bound planning when nothing explicit is configured; explicit limits are honoured but capped by the batch.
    const bare = { sync: { mode: 'check' as const, on: [], watch: [], ignore: [] } }
    expect(planningTimeoutForBatch(bare, { maxMinutes: 120 }, {})).toBe(120)
    expect(planningTimeoutForBatch(bare, { maxMinutes: 15 }, {})).toBe(20)
    expect(planningTimeoutForBatch(bare, { maxMinutes: 120 }, { DOXLOOP_PLAN_TIMEOUT_MINUTES: '30' })).toBe(30)
    expect(planningTimeoutForBatch({ sync: { ...bare.sync, budget: { maxMinutes: 200 } } }, { maxMinutes: 120 }, {})).toBe(120)
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

describe('clarification defaults', () => {
  test('a reviewer who chose recommended defaults gets a plan from one planning pass', async () => {
    if (process.platform === 'win32') return
    const parent = await mkdtemp(join(tmpdir(), 'doxloop-plan-defaults-'))
    roots.push(parent)
    const root = await scaffoldProject({ directory: join(parent, 'docs'), sources: [] })
    const executable = join(parent, 'codex')
    const promptLog = join(parent, 'prompts.log')
    const reply = JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: `<doxloop-plan>${JSON.stringify({ ...proposal, pages: proposal.pages.map((page) => ({ ...page, evidence: [], evidenceDetails: [] })) })}</doxloop-plan>` } })
    // Records each prompt it receives, then answers with a question-free plan.
    await writeFile(executable, `#!/bin/sh\nfor last; do :; done\nprintf '%s\\n---\\n' "$last" >> "${promptLog}"\n/bin/cat <<'EOF_PLAN'\n${reply}\nEOF_PLAN\n`)
    await chmod(executable, 0o755)
    process.env.PATH = parent
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    const created = await createDocumentationPlan(root, { mode: 'update', scope: 'custom', clarificationMode: 'defaults', execution: { agent: 'codex', screenshots: false } })
    const planned = await proposeDocumentationPlan(root, created.id)
    expect(planned.status).toBe('ready-for-review')
    const prompts = (await readFile(promptLog, 'utf8')).split('\n---\n').filter((text) => text.trim())
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain('decide open questions by their safe default instead of asking')
    expect(prompts[0]).not.toContain('Use at most three questions')
    // Prompt-side JSON is compact; only files on disk are pretty-printed.
    expect(prompts[0]).toContain('Project configuration (compact JSON):\n{"')
    expect(prompts[0]).not.toContain('Project configuration:\n{\n')
    expect(prompts[0]).not.toContain('plan UI guides around the strings those catalogs display')

    // A reviewer who wants to answer in the review screen keeps the question rule.
    const asked = await createDocumentationPlan(root, { mode: 'update', scope: 'custom', clarificationMode: 'review', execution: { agent: 'codex', screenshots: false } })
    await proposeDocumentationPlan(root, asked.id)
    const second = (await readFile(promptLog, 'utf8')).split('\n---\n').filter((text) => text.trim())
    expect(second).toHaveLength(2)
    expect(second[1]).toContain('Use at most three questions')
  }, 30_000)
})

describe('staged planning', () => {
  test('research sessions run first and the plan is written from their briefs', async () => {
    if (process.platform === 'win32') return
    const { root } = await fixture(true)
    const parent = join(root, '..')
    const executable = join(parent, 'codex')
    const promptLog = join(parent, 'prompts.log')
    const brief = { productProfile: 'Plan API', audiences: ['developers'], capabilities: [{ id: 'requests', title: 'Send requests', kind: 'api', summary: 'POST /requests', evidence: [] }], unknowns: [] }
    const briefReply = JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: `<doxloop-brief>${JSON.stringify(brief)}</doxloop-brief>` } })
    const planReply = JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: `<doxloop-plan>${JSON.stringify({ ...proposal, pages: proposal.pages.map((page) => ({ ...page, evidence: [], evidenceDetails: [] })) })}</doxloop-plan>` } })
    // Answers a research prompt with a brief and anything else with the plan.
    await writeFile(executable, `#!/bin/sh\nfor last; do :; done\nprintf '%s\\n---\\n' "$last" >> "${promptLog}"\ncase "$last" in\n  *'Research task "product"'*) /bin/cat <<'EOF_BRIEF'\n${briefReply}\nEOF_BRIEF\n;;\n  *) /bin/cat <<'EOF_PLAN'\n${planReply}\nEOF_PLAN\n;;\nesac\n`)
    await chmod(executable, 0o755)
    process.env.PATH = parent
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    const created = await createDocumentationPlan(root, { mode: 'update', scope: 'custom', execution: { agent: 'codex', screenshots: 'disabled' } })
    const planned = await proposeDocumentationPlan(root, created.id)
    expect(planned.status).toBe('ready-for-review')
    const prompts = (await readFile(promptLog, 'utf8')).split('\n---\n').filter((text) => text.trim())
    expect(prompts).toHaveLength(2)
    expect(prompts[0]).toContain('Research task "product": Auditing the product surface')
    expect(prompts[0]).toContain('<doxloop-brief>')
    expect(prompts[1]).toContain('Research sessions have already read the configured sources')
    expect(prompts[1]).toContain('### Brief "product": Auditing the product surface')
    expect(prompts[1]).toContain('"title":"Send requests"')
    expect(prompts[1]).toContain('Do not read the skill files')
    expect(prompts[1]).not.toContain('Research task "product"')
    // The brief is saved under the plan for retries.
    const saved = JSON.parse(await readFile(join(root, '.doxloop', 'plans', created.id, 'research', 'product.json'), 'utf8')) as { content: unknown }
    expect(saved.content).toEqual(brief)

    // The single-session planner is one environment switch away.
    process.env.DOXLOOP_PLANNING_STAGED = '0'
    try {
      const single = await createDocumentationPlan(root, { mode: 'update', scope: 'custom', execution: { agent: 'codex', screenshots: 'disabled' } })
      await proposeDocumentationPlan(root, single.id)
    } finally {
      delete process.env.DOXLOOP_PLANNING_STAGED
    }
    const all = (await readFile(promptLog, 'utf8')).split('\n---\n').filter((text) => text.trim())
    expect(all).toHaveLength(3)
    expect(all[2]).toContain('Research the configured product evidence and existing documentation')
    expect(all[2]).not.toContain('Research briefs')
  }, 30_000)
})

describe('update request triage', () => {
  test('a navigation request plans from the current navigation with no research; an ambiguous one is triaged first', async () => {
    if (process.platform === 'win32') return
    const { root } = await fixture(true)
    const parent = join(root, '..')
    const executable = join(parent, 'codex')
    const promptLog = join(parent, 'prompts.log')
    const message = (text: string): string => JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text } })
    const preserved = proposal.pages.map((page) => ({ ...page, action: 'preserve', evidence: [], evidenceDetails: [] }))
    const navigationPlan = message(`<doxloop-plan>${JSON.stringify({ ...proposal, capabilities: [], pages: preserved, workspaceInstructions: 'Set icon "rocket" on Quickstart and "book" on the Guides group.' })}</doxloop-plan>`)
    const brief = message(`<doxloop-brief>${JSON.stringify({ productProfile: 'Plan API', capabilities: [{ id: 'requests', title: 'Send requests', kind: 'api', summary: 'POST /requests', evidence: [] }], unknowns: [] })}</doxloop-brief>`)
    const fullPlan = message(`<doxloop-plan>${JSON.stringify({ ...proposal, pages: proposal.pages.map((page) => ({ ...page, evidence: [], evidenceDetails: [] })) })}</doxloop-plan>`)
    const triage = message('<doxloop-triage>{"scope":"product","pages":[],"reason":"The request adds a page whose subject is not on the list."}</doxloop-triage>')
    await writeFile(executable, `#!/bin/sh\nfor last; do :; done\nprintf '%s\\n---\\n' "$last" >> "${promptLog}"\ncase "$last" in\n  *'triage step'*) /bin/cat <<'EOF_T'\n${triage}\nEOF_T\n;;\n  *'Research task "product"'*) /bin/cat <<'EOF_B'\n${brief}\nEOF_B\n;;\n  *'changes only navigation'*) /bin/cat <<'EOF_N'\n${navigationPlan}\nEOF_N\n;;\n  *) /bin/cat <<'EOF_P'\n${fullPlan}\nEOF_P\n;;\nesac\n`)
    await chmod(executable, 0o755)
    process.env.PATH = parent
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    // The 17 Sept 2026 request: icons for the sidebar. One session, no research.
    const icons = await createDocumentationPlan(root, { mode: 'update', scope: 'custom', request: 'for all the pages icons are missing in the left nav items... can you please add relevant icons to left nav items', execution: { agent: 'codex', screenshots: 'disabled' } })
    const planned = await proposeDocumentationPlan(root, icons.id)
    expect(planned.status).toBe('ready-for-review')
    expect(planned.research).toMatchObject({ scope: 'navigation', decidedBy: 'rules' })
    expect(planned.workspaceInstructions).toBe('Set icon "rocket" on Quickstart and "book" on the Guides group.')
    expect(planned.advisories?.[0]).toMatch(/^Research scope: no research: navigation, icons, branding, or metadata only \(decided from the request\)/)
    const prompts = (await readFile(promptLog, 'utf8')).split('\n---\n').filter((text) => text.trim())
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain('This update changes only navigation, icons, ordering, group names, branding, or page metadata')
    expect(prompts[0]).toContain('Current navigation (Doxloop read it from the workspace')
    expect(prompts[0]).toContain('Icon names it can draw: book, file, home')
    expect(prompts[0]).toContain('Propose a navigation-only plan')
    expect(prompts[0]).not.toContain('Research task')
    expect(prompts[0]).not.toContain('Research briefs')

    // An ambiguous request is triaged by one short session that reads nothing, then researched as decided.
    const ambiguous = await createDocumentationPlan(root, { mode: 'update', scope: 'custom', request: 'Document the new export feature', execution: { agent: 'codex', screenshots: 'disabled' } })
    const researched = await proposeDocumentationPlan(root, ambiguous.id)
    expect(researched.research).toEqual({ scope: 'product', pages: [], reason: 'The request adds a page whose subject is not on the list.', decidedBy: 'agent' })
    const all = (await readFile(promptLog, 'utf8')).split('\n---\n').filter((text) => text.trim())
    expect(all).toHaveLength(4)
    expect(all[1]).toContain('You are the triage step')
    expect(all[1]).toContain('Update request:\nDocument the new export feature')
    expect(all[2]).toContain('Research task "product": Auditing the product surface')
    expect(all[3]).toContain('Research sessions have already read the configured sources')

    // A second update on unchanged sources borrows that product brief instead of auditing again.
    const later = await createDocumentationPlan(root, { mode: 'update', scope: 'custom', request: 'Refresh everything', execution: { agent: 'codex', screenshots: 'disabled' } })
    await proposeDocumentationPlan(root, later.id)
    const reused = (await readFile(promptLog, 'utf8')).split('\n---\n').filter((text) => text.trim())
    expect(reused).toHaveLength(5)
    expect(reused[4]).toContain('### Brief "product"')
    const copied = JSON.parse(await readFile(join(root, '.doxloop', 'plans', later.id, 'research', 'product.json'), 'utf8')) as { task: string }
    expect(copied.task).toBe('product')
  }, 60_000)
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

describe('proposal checkpoints', () => {
  test('a saved planner reply is reused only for the same brief and source snapshot', async () => {
    const { root } = await fixture()
    const created = await createDocumentationPlan(root, { mode: 'update', scope: 'standard', execution: { screenshots: 'disabled' } })
    const key = proposalCheckpointKey(created, 'snapshot-a')
    expect(await readProposalCheckpoint(root, created.id, key)).toBeUndefined()
    await writeProposalCheckpoint(root, created.id, { key, pass: 'proposal', raw: { pages: [] } })
    expect(await readProposalCheckpoint(root, created.id, key)).toMatchObject({ key, pass: 'proposal', raw: { pages: [] } })
    expect(await readProposalCheckpoint(root, created.id, key)).not.toHaveProperty('repairs')
    // What Doxloop fixed to read the reply travels with it, so a continued
    // run still reports the repair on the review.
    await writeProposalCheckpoint(root, created.id, { key, pass: 'proposal', raw: { pages: [] }, repairs: ['closed 2 brackets'] })
    expect(await readProposalCheckpoint(root, created.id, key)).toMatchObject({ repairs: ['closed 2 brackets'] })
    // A changed source snapshot, brief, or feedback is a different question.
    expect(await readProposalCheckpoint(root, created.id, proposalCheckpointKey(created, 'snapshot-b'))).toBeUndefined()
    expect(proposalCheckpointKey(created, 'snapshot-a', 'add a glossary')).not.toBe(key)
    expect(proposalCheckpointKey({ ...created, request: 'Something else' }, 'snapshot-a')).not.toBe(key)
    await clearProposalCheckpoint(root, created.id)
    expect(await readProposalCheckpoint(root, created.id, key)).toBeUndefined()
  })
})

test('planning runs at medium effort at most; authoring keeps the run effort', () => {
  expect(planningEffort('high')).toBe('medium')
  expect(planningEffort('max')).toBe('medium')
  expect(planningEffort('medium')).toBe('medium')
  expect(planningEffort('low')).toBe('low')
})

test('a planning process that ends without a result leaves a failed plan the reviewer can retry', async () => {
  const { root } = await fixture()
  const created = await createDocumentationPlan(root, { mode: 'update', scope: 'standard', execution: { screenshots: 'disabled' } })
  expect(created.status).toBe('planning')
  const failed = await markDocumentationPlanInterrupted(root, created.id, 'propose', 'The planning run stopped before it finished.')
  expect(failed).toMatchObject({ status: 'failed', error: 'The planning run stopped before it finished.', failure: { stage: 'propose', resumable: false, ignorable: false } })
  expect((await readDocumentationPlan(root, created.id)).status).toBe('failed')
  // A plan that already reached a result is left alone.
  expect(await markDocumentationPlanInterrupted(root, created.id, 'propose', 'again')).toBeUndefined()
  expect((await readDocumentationPlan(root, created.id)).error).toBe('The planning run stopped before it finished.')
})

test('screenshot-guide slips that only cost a second planning pass are repaired locally', () => {
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  const sequence = [
    'Open Settings — the Member tab is visible — orients the reader.',
    'Click Create — the Create user dialog is open — shows the required fields.',
    'Fill the form — the fields hold safe values — shows what to enter.',
    'Save — the new member row is visible — proves the result.',
  ]
  const raw = { pages: [
    // Purpose written on the page, start path with an SPA hash, no workflow: the
    // memos runs paid 6–20 minutes of corrective planning for exactly these.
    { id: 'members', title: 'Members', type: 'how-to', rationale: 'Confirmed Member tab; CreateUserDialog shows role assignment.', purpose: 'Create and remove users.', visuals: { mode: 'required', estimatedCaptures: 4, startPath: '/setting#member', captureSequence: sequence } },
    { id: 'relative', title: 'Relative', type: 'how-to', purpose: 'Open the dashboard.', visuals: { mode: 'required', rationale: 'Shows the dashboard.', estimatedCaptures: 4, startPath: 'dashboard', workflow: 'Open the dashboard and inspect each panel.', captureSequence: sequence } },
    { id: 'text', title: 'Text', type: 'concept', purpose: 'Explain the model.', visuals: { mode: 'none', estimatedCaptures: 0 } },
  ] }
  const repaired = repairMechanicalPlanIssues(raw, { screenshots: 'enabled' }) as { pages: Array<{ visuals: Record<string, unknown> }> }
  expect(repaired.pages[0]!.visuals).toMatchObject({
    mode: 'required',
    rationale: 'Confirmed Member tab; CreateUserDialog shows role assignment.',
    startPath: '/setting#member',
    workflow: 'Open Settings; Click Create; Fill the form; Save',
  })
  expect(repaired.pages[1]!.visuals).toMatchObject({ startPath: '/dashboard', workflow: 'Open the dashboard and inspect each panel.' })
  expect(repaired.pages[2]!.visuals).toEqual({ mode: 'none', estimatedCaptures: 0 })
  const normalized = repaired.pages.map((page, index) => ({ ...raw.pages[index]!, priority: 'must-have', action: 'create', ...page }))
  expect(requiredScreenshotPlanIssue({ pages: normalized as never }, { screenshots: 'enabled' })).toBeUndefined()
  // Nothing to repair in a run without screenshots.
  expect(repairMechanicalPlanIssues(raw, { screenshots: 'disabled' })).toBe(raw)
})

test('the corrective planning pass fixes the named findings without re-exploring the application', () => {
  const first = { pages: [{ id: 'a', visuals: { mode: 'required', startPath: 'setting' } }] }
  const scoped = gateRevisionInstructions('Required screenshot guides are incomplete. "A": missing ordered workflow.', first)
  expect(scoped).toContain('do not sign in or explore it again')
  expect(scoped).toContain('Keep every page, capability, navigation entry, and field that the findings do not name unchanged')
  expect(scoped).toContain(JSON.stringify(first))
  expect(scoped).not.toContain(JSON.stringify(first, null, 2))
  // A proposal with no screenshot guide at all genuinely needs the browser.
  const exploring = gateRevisionInstructions('Required screenshot mode needs at least one complete screenshot-enabled visible UI guide; the proposal planned no application screenshots.', first)
  expect(exploring).toContain('doxloop_capture')
  expect(exploring).not.toContain('do not sign in or explore it again')
})

test('a corrective pass returns a patch that is merged into the first proposal by page id', () => {
  const first = {
    productProfile: 'x', summary: 'y', capabilities: [{ id: 'c1' }], navigation: { top: ['Guides'], sections: [] },
    pages: [{ id: 'a', title: 'A', visuals: { mode: 'required', estimatedCaptures: 1 } }, { id: 'b', title: 'B' }, { id: 'c', title: 'C' }],
  }
  // Only page a changed, page c is dropped, page d is new; capabilities are resent, navigation is not.
  const patch = { pages: [{ id: 'a', title: 'A', visuals: { mode: 'required', estimatedCaptures: 4, workflow: 'open, fill, submit' } }, { id: 'd', title: 'D' }], removePageIds: ['c'], capabilities: [{ id: 'c1' }, { id: 'c2' }] }
  const merged = applyPlanPatch(first, patch) as typeof first & { pages: Array<{ id: string }> }
  expect(merged.pages.map((page) => page.id)).toEqual(['a', 'b', 'd'])
  expect(merged.pages[0]).toEqual(patch.pages[0])
  expect(merged.pages[1]).toEqual(first.pages[1])
  expect(merged.capabilities).toEqual(patch.capabilities)
  expect(merged.navigation).toEqual(first.navigation)
  expect(merged.summary).toBe('y')
  // The instructions ask for a patch and explain the merge; the exploring case still names the browser.
  const scoped = gateRevisionInstructions('"A": missing ordered workflow.', first)
  expect(scoped).toContain('<doxloop-plan-patch>')
  expect(scoped).toContain('merges the patch into the first proposal by page id')
  const briefed = gateRevisionInstructions('the proposal planned no application screenshots.', first, { briefed: true })
  expect(briefed).toContain('application research brief')
  expect(briefed).not.toContain('doxloop_capture')

  // The patch reader accepts the agreed block and repairs a lost closer; a whole plan is not mistaken for a patch.
  const reply = readPlanPatchOutput(`Fixed.\n<doxloop-plan-patch>\n${JSON.stringify(patch).slice(0, -1)}\n</doxloop-plan-patch>`, 'codex')
  expect(reply?.value).toEqual(patch)
  expect(reply?.repairs).toEqual([expect.stringMatching(/corrective reply stopped 1 closing bracket short/)])
  expect(readPlanPatchOutput('No patch here.', 'codex')).toBeUndefined()
})

test('existing-page titles and URLs are filled from the snapshot so the planner lists paths only', () => {
  const details = new Map([['legacy', new Map([
    ['pages/install.md', { title: 'Install', url: 'https://docs.example.com/install' }],
    ['pages/faq.md', { title: 'FAQ', url: 'https://docs.example.com/faq' }],
  ])]])
  const raw = { pages: [], existingDocumentation: [{ source: 'legacy', pages: [
    { path: 'pages/install.md', disposition: 'rewrite', into: ['install'] },
    { path: '/pages/faq.md', title: 'Questions', disposition: 'drop', into: [] },
    { path: 'pages/unknown.md', disposition: 'drop', into: [] },
  ] }, { source: 'other', pages: [{ path: 'pages/install.md' }] }] }
  const filled = fillExistingPageDetails(raw, details) as { existingDocumentation: Array<{ pages: Array<Record<string, unknown>> }> }
  expect(filled.existingDocumentation[0]!.pages[0]).toMatchObject({ title: 'Install', url: 'https://docs.example.com/install' })
  // A title the planner did give is kept; the URL is still added.
  expect(filled.existingDocumentation[0]!.pages[1]).toMatchObject({ title: 'Questions', url: 'https://docs.example.com/faq' })
  expect(filled.existingDocumentation[0]!.pages[2]).toEqual({ path: 'pages/unknown.md', disposition: 'drop', into: [] })
  expect(filled.existingDocumentation[1]!.pages[0]).toEqual({ path: 'pages/install.md' })
  expect(fillExistingPageDetails('not a plan', details)).toBe('not a plan')
  expect(existingDocumentationPlanShape([{ name: 'legacy', path: '../snap', kind: 'docs-site' }])).not.toContain('"url"')
})

test('a "recommended" label in required screenshot mode is repaired without a second planning pass', () => {
  const raw = { pages: [
    { id: 'a', visuals: { mode: 'recommended', estimatedCaptures: 2 } },
    { id: 'b', visuals: { mode: 'required', estimatedCaptures: 3 } },
    { id: 'c', visuals: { mode: 'none', estimatedCaptures: 0 } },
  ] }
  const repaired = repairMechanicalPlanIssues(raw, { screenshots: 'enabled' }) as typeof raw
  expect(repaired.pages.map((page) => page.visuals.mode)).toEqual(['required', 'required', 'none'])
  // Automatic mode keeps best-effort visuals as the planner wrote them.
  expect((repairMechanicalPlanIssues(raw, { screenshots: 'auto' }) as typeof raw).pages[0]!.visuals.mode).toBe('recommended')
})

test('blanks capture references the application research never saved', () => {
  const raw = { pages: [
    { id: 'a', visuals: { captureIds: ['login', 'ghost', ''] } },
    { id: 'b', visuals: { captureIds: [42, 'home'] } },
    { id: 'c' },
  ] }
  expect(dropUnknownCaptureIds(raw, new Set(['login', 'home']))).toBe(1)
  expect(raw.pages[0]!.visuals!.captureIds).toEqual(['login', '', ''])
  expect(raw.pages[1]!.visuals!.captureIds).toEqual(['', 'home'])
  expect(dropUnknownCaptureIds('nope', new Set())).toBe(0)
})

describe('plan revisions are patches', () => {
  test('a revision is asked for a patch and the answered questions leave the plan', () => {
    expect(planRevisionPatchInstructions()).toContain('<doxloop-plan-patch>')
    const raw = { pages: [{ id: 'a' }], questions: [{ id: 'q1', question: 'A?' }, { id: 'q2', question: 'B?' }] }
    expect(withoutAnsweredQuestions(raw, { q1: 'yes' })).toEqual({ pages: [{ id: 'a' }], questions: [{ id: 'q2', question: 'B?' }] })
    expect(withoutAnsweredQuestions(raw, { q1: '  ' })).toBe(raw)
    expect(withoutAnsweredQuestions({ pages: [] }, { q1: 'yes' })).toEqual({ pages: [] })
    const merged = applyPlanPatch({ pages: [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }], questions: [{ id: 'q1' }] }, { pages: [{ id: 'b', title: 'B2' }], questions: [] })
    expect(merged).toEqual({ pages: [{ id: 'a', title: 'A' }, { id: 'b', title: 'B2' }], questions: [] })
  })
})

describe('assignSectionSpaces', () => {
  test('keeps a named space, matches a section to a space by name, and leaves the rest to path-based placement', () => {
    const top = ['Memos', 'Administration', 'API & integrations']
    const sections = assignSectionSpaces(top, [
      { id: 'a', title: 'Configure the instance', pageIds: ['x'], space: 'administration' },
      { id: 'b', title: 'APIs', pageIds: ['y'] },
      { id: 'c', title: 'Integrations', pageIds: ['z'] },
      { id: 'd', title: 'Create and organize', pageIds: ['w'] },
      { id: 'e', title: 'Deploy', pageIds: ['v'], space: 'Nowhere' },
    ])
    expect(sections.map((section) => section.space)).toEqual(['Administration', 'API & integrations', 'API & integrations', undefined, undefined])
  })
})
