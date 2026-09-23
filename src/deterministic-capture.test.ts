import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PNG } from 'pngjs'
import { afterEach, describe, expect, test } from 'vitest'
import {
  captureNavigableSteps,
  isNavigationOnlyStep,
  resolveStepPath,
  type CapturedPage,
} from './deterministic-capture.js'
import { SCREENSHOT_MANIFEST_FILE, writeScreenshotManifestSkeleton } from './screenshot-workflow.js'
import type { DocumentationPlan, DocumentationPlanPage, DoxloopProject } from './types.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const BASE_URL = 'http://127.0.0.1:4318'

function project(): DoxloopProject {
  return {
    schemaVersion: 1,
    title: 'Fixture',
    contentDir: '',
    generator: 'doxbrix',
    sources: [],
    designReferences: [],
    application: { baseUrl: BASE_URL, screenshots: { policy: 'requested', viewport: { width: 1280, height: 800 } } },
    documentation: {} as DoxloopProject['documentation'],
    sync: {} as DoxloopProject['sync'],
  } as DoxloopProject
}

function page(id: string, visuals: NonNullable<DocumentationPlanPage['visuals']>): DocumentationPlanPage {
  return {
    id,
    title: id,
    path: id,
    type: 'how-to',
    priority: 'must-have',
    action: 'create',
    purpose: `Explain ${id}.`,
    rationale: 'Public UI workflow.',
    evidence: [],
    evidenceDetails: [],
    visuals,
  }
}

function plan(pages: DocumentationPlanPage[]): DocumentationPlan {
  return {
    pages,
    target: { generator: 'doxbrix', contentDir: '', contentFormat: 'markdown', pageExtensions: ['.mdx'], navigationFiles: [] },
  } as DocumentationPlan
}

function colourfulPng(width = 1280, height = 800): Buffer {
  const png = new PNG({ width, height })
  for (let index = 0; index < png.data.length; index += 4) {
    png.data[index] = (index / 4) % 255
    png.data[index + 1] = Math.floor(index / (4 * width)) % 255
    png.data[index + 2] = 160
    png.data[index + 3] = 255
  }
  return PNG.sync.write(png)
}

function uniformPng(width = 1280, height = 800): Buffer {
  const png = new PNG({ width, height })
  png.data.fill(255)
  return PNG.sync.write(png)
}

function shot(url: string, overrides: Partial<CapturedPage> = {}): CapturedPage {
  return { png: colourfulPng(), finalUrl: url, status: 200, hasPasswordField: false, ...overrides }
}

async function workspace(documentationPlan: DocumentationPlan): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'doxloop-deterministic-'))
  roots.push(root)
  await mkdir(join(root, '.doxloop'), { recursive: true })
  await writeFile(join(root, '.doxloop', 'project.json'), JSON.stringify(project(), null, 2))
  await writeScreenshotManifestSkeleton(root, documentationPlan)
  return root
}

async function manifest(root: string): Promise<{ guides: Array<{ page: string; steps: Array<Record<string, unknown>> }> }> {
  return JSON.parse(await readFile(join(root, SCREENSHOT_MANIFEST_FILE), 'utf8'))
}

describe('isNavigationOnlyStep', () => {
  test('recognises navigation verbs and extracts the route', () => {
    expect(isNavigationOnlyStep('Open /settings/general.')).toEqual({ path: '/settings/general' })
    expect(isNavigationOnlyStep('Go to /projects?tab=archived')).toEqual({ path: '/projects?tab=archived' })
    expect(isNavigationOnlyStep('Navigate to the dashboard at /dashboard, then wait for the chart.')).toEqual({ path: '/dashboard' })
    expect(isNavigationOnlyStep('Visit /')).toEqual({ path: '/' })
    expect(isNavigationOnlyStep('Load http://127.0.0.1:4318/reports/weekly.')).toEqual({ path: '/reports/weekly' })
    expect(isNavigationOnlyStep('Start at the home page')).toEqual({})
    expect(isNavigationOnlyStep('open the application')).toEqual({})
  })

  test('rejects steps that interact or do not navigate', () => {
    expect(isNavigationOnlyStep('Open /settings and click Save.')).toBeUndefined()
    expect(isNavigationOnlyStep('Open /team, then select Invite member.')).toBeUndefined()
    expect(isNavigationOnlyStep('Go to /login and sign in as the fixture user.')).toBeUndefined()
    expect(isNavigationOnlyStep('Open /editor and type a title.')).toBeUndefined()
    expect(isNavigationOnlyStep('Select Invite member from Team settings.')).toBeUndefined()
    expect(isNavigationOnlyStep('Click New project.')).toBeUndefined()
    expect(isNavigationOnlyStep('Reopen the dialog')).toBeUndefined()
  })

  test('does not read a route segment as an interaction and ignores "and/or"', () => {
    expect(isNavigationOnlyStep('Open /settings/upload')).toEqual({ path: '/settings/upload' })
    expect(isNavigationOnlyStep('Open the list view and/or the grid view')).toEqual({})
  })
})

describe('resolveStepPath', () => {
  const entry = page('invite-member', { mode: 'required', rationale: 'r', estimatedCaptures: 2, startPath: '/team' })

  test('falls back to startPath for the entry step only', () => {
    expect(resolveStepPath(entry, { id: '01', action: 'Open the application' }, 0)).toBe('/team')
    expect(resolveStepPath(entry, { id: '01', action: 'Open /members' }, 0)).toBe('/members')
    expect(resolveStepPath(entry, { id: '02', action: 'Open the application' }, 1)).toBeUndefined()
    expect(resolveStepPath(entry, { id: '02', action: 'Open /members' }, 1)).toBe('/members')
    expect(resolveStepPath(entry, { id: '01', action: 'Select Invite member.' }, 0)).toBeUndefined()
    expect(resolveStepPath(entry, { id: '02', action: 'Select Invite member.' }, 1)).toBeUndefined()
  })
})

describe('captureNavigableSteps', () => {
  test('captures entry screens and routes, records verified rows, and stays idempotent', async () => {
    const pages = [
      page('invite-member', {
        mode: 'required',
        rationale: 'r',
        estimatedCaptures: 3,
        startPath: '/team',
        captureSequence: [
          'Open the application — The Team page lists current members. — Orient the reader.',
          'Select Invite member — The Invite member dialog is open. — Prove the form opened.',
          'Open /team/roles — The Roles table is visible. — Show the roles available.',
        ],
      }),
      page('settings', { mode: 'recommended', rationale: 'r', estimatedCaptures: 2, startPath: '/settings' }),
    ]
    const documentationPlan = plan(pages)
    const root = await workspace(documentationPlan)
    const urls: string[] = []
    const lines: string[] = []
    const result = await captureNavigableSteps({
      workspace: root,
      project: project(),
      plan: documentationPlan,
      log: (line) => lines.push(line),
      capturePage: async (url) => {
        urls.push(url)
        return shot(url)
      },
    })

    expect(urls).toEqual([`${BASE_URL}/team`, `${BASE_URL}/team/roles`, `${BASE_URL}/settings`])
    expect(result.captured).toEqual([
      { page: 'invite-member', step: '01', file: 'assets/guides/invite-member/01-the-team-page-lists-current-members.png' },
      { page: 'invite-member', step: '03', file: 'assets/guides/invite-member/03-the-roles-table-is-visible.png' },
      { page: 'settings', step: '01', file: 'assets/guides/settings/01-the-state-approved-capture-1-names-is-vi.png' },
    ])
    // The interaction step is left to the agent without being attempted; the
    // second settings row repeats the entry screen and is not photographed twice.
    expect(result.skipped).toEqual([
      { page: 'settings', step: '02', reason: 'duplicate screen: /settings is already captured for this guide' },
    ])
    for (const capture of result.captured) {
      expect((await stat(join(root, capture.file))).size).toBeGreaterThan(0)
    }

    const staged = await manifest(root)
    expect(staged.guides[0]!.steps[0]).toMatchObject({
      id: '01',
      sequenceItem: 1,
      capture: true,
      status: 'verified',
      file: 'assets/guides/invite-member/01-the-team-page-lists-current-members.png',
      target: 'Open the application',
      alt: 'The Team page lists current members.',
      checks: { expectedStateConfirmed: true, privacyReviewed: true, legibilityReviewed: true, meaningful: true },
    })
    expect(staged.guides[0]!.steps[1]).toMatchObject({ id: '02', status: 'planned', sequenceItem: 2 })
    expect(staged.guides[0]!.steps[1]!.file).toBeUndefined()
    expect(staged.guides[0]!.steps[2]).toMatchObject({ id: '03', status: 'verified', sequenceItem: 3 })
    expect(staged.guides[1]!.steps[0]).toMatchObject({ id: '01', status: 'verified', sequenceItem: 1 })
    expect(staged.guides[1]!.steps[1]).toMatchObject({ id: '02', status: 'planned', sequenceItem: 2 })
    expect(lines.some((line) => line.includes('Captured invite-member/01'))).toBe(true)

    const again = await captureNavigableSteps({
      workspace: root,
      project: project(),
      plan: documentationPlan,
      capturePage: async () => {
        throw new Error('the browser must not be opened on a second run')
      },
    })
    expect(again.captured).toEqual([])
    expect(again.skipped).toEqual([
      { page: 'settings', step: '02', reason: 'duplicate screen: /settings is already captured for this guide' },
    ])
    expect(await manifest(root)).toEqual(staged)
  })

  test('skips still-loading, sign-in, and error screens without touching the manifest', async () => {
    const pages = [
      page('blank', { mode: 'required', rationale: 'r', estimatedCaptures: 1, startPath: '/blank' }),
      page('gated', { mode: 'required', rationale: 'r', estimatedCaptures: 1, startPath: '/admin' }),
      page('password', { mode: 'required', rationale: 'r', estimatedCaptures: 1, startPath: '/account' }),
      page('missing', { mode: 'required', rationale: 'r', estimatedCaptures: 1, startPath: '/nowhere' }),
      page('tiny', { mode: 'required', rationale: 'r', estimatedCaptures: 1, startPath: '/tiny' }),
      page('login-page', { mode: 'required', rationale: 'r', estimatedCaptures: 1, startPath: '/login' }),
    ]
    const documentationPlan = plan(pages)
    const root = await workspace(documentationPlan)
    const before = await manifest(root)
    const result = await captureNavigableSteps({
      workspace: root,
      project: project(),
      plan: documentationPlan,
      capturePage: async (url) => {
        const path = new URL(url).pathname
        if (path === '/blank') return shot(url, { png: uniformPng() })
        if (path === '/admin') return shot(`${BASE_URL}/login?next=%2Fadmin`)
        if (path === '/account') return shot(url, { hasPasswordField: true })
        if (path === '/nowhere') return shot(url, { status: 404 })
        if (path === '/tiny') return shot(url, { png: colourfulPng(200, 120) })
        // The sign-in page itself is a legitimate screen to document.
        if (path === '/login') return shot(url, { hasPasswordField: true })
        throw new Error(`unexpected ${url}`)
      },
    })

    expect(result.captured).toEqual([{ page: 'login-page', step: '01', file: expect.stringMatching(/^assets\/guides\/login-page\/01-.+\.png$/) }])
    expect(result.skipped).toEqual([
      { page: 'blank', step: '01', reason: expect.stringMatching(/^still loading/) },
      { page: 'gated', step: '01', reason: 'sign-in required: /admin redirected to /login?next=%2Fadmin' },
      { page: 'password', step: '01', reason: 'sign-in required: /account shows a password field' },
      { page: 'missing', step: '01', reason: 'status 404 at /nowhere' },
      { page: 'tiny', step: '01', reason: 'image too small (200x120)' },
    ])
    const after = await manifest(root)
    expect(after.guides.slice(0, 5)).toEqual(before.guides.slice(0, 5))
    expect(after.guides[5]!.steps[0]).toMatchObject({ status: 'verified' })
  })

  test('signs in once with saved credentials when a route redirects to the login page, then retries', async () => {
    const pages = [
      page('projects', { mode: 'required', rationale: 'r', estimatedCaptures: 1, startPath: '/projects' }),
      page('labels', { mode: 'required', rationale: 'r', estimatedCaptures: 1, startPath: '/labels' }),
    ]
    const documentationPlan = plan(pages)
    const root = await workspace(documentationPlan)
    let signedIn = false
    const signIns: string[] = []
    const result = await captureNavigableSteps({
      workspace: root,
      project: project(),
      plan: documentationPlan,
      credentials: { username: 'demo', password: 'demo12345' },
      loginPath: '/login',
      capturePage: async (url) => (signedIn ? shot(url) : shot(`${BASE_URL}/login?next=${encodeURIComponent(new URL(url).pathname)}`)),
      signIn: async (loginUrl, credentials) => {
        signIns.push(`${loginUrl} ${credentials.username}`)
        signedIn = true
        return true
      },
    })
    expect(signIns).toEqual([`${BASE_URL}/login demo`])
    expect(result.captured.map((item) => item.page)).toEqual(['projects', 'labels'])
    expect(result.skipped).toEqual([])
  })

  test('leaves sign-in states to the agent when the saved credentials do not sign in', async () => {
    const pages = [
      page('projects', { mode: 'required', rationale: 'r', estimatedCaptures: 1, startPath: '/projects' }),
      page('labels', { mode: 'required', rationale: 'r', estimatedCaptures: 1, startPath: '/labels' }),
    ]
    const documentationPlan = plan(pages)
    const root = await workspace(documentationPlan)
    let signIns = 0
    const result = await captureNavigableSteps({
      workspace: root,
      project: project(),
      plan: documentationPlan,
      credentials: { username: 'demo', password: 'wrong' },
      capturePage: async (url) => shot(`${BASE_URL}/login?next=${encodeURIComponent(new URL(url).pathname)}`),
      signIn: async () => { signIns += 1; return false },
    })
    expect(signIns).toBe(1)
    expect(result.captured).toEqual([])
    expect(result.skipped.map((item) => item.reason)).toEqual([
      expect.stringMatching(/^sign-in required/),
      expect.stringMatching(/^sign-in required/),
    ])
  })

  test('stops after three consecutive failures of the same kind and honours the time budget', async () => {
    const pages = ['a', 'b', 'c', 'd', 'e'].map((id) => page(id, { mode: 'required', rationale: 'r', estimatedCaptures: 1, startPath: `/${id}` }))
    const documentationPlan = plan(pages)
    const root = await workspace(documentationPlan)
    let attempts = 0
    const result = await captureNavigableSteps({
      workspace: root,
      project: project(),
      plan: documentationPlan,
      capturePage: async () => {
        attempts += 1
        throw new Error('net::ERR_CONNECTION_REFUSED at http://127.0.0.1:4318')
      },
    })
    expect(attempts).toBe(3)
    expect(result.captured).toEqual([])
    expect(result.skipped.map((entry) => entry.reason)).toEqual([
      'error: net::ERR_CONNECTION_REFUSED at http://127.0.0.1:4318',
      'error: net::ERR_CONNECTION_REFUSED at http://127.0.0.1:4318',
      'error: net::ERR_CONNECTION_REFUSED at http://127.0.0.1:4318',
      'stopped after 3 consecutive failures (application unreachable)',
      'stopped after 3 consecutive failures (application unreachable)',
    ])

    const budgeted = await captureNavigableSteps({
      workspace: root,
      project: project(),
      plan: documentationPlan,
      timeBudgetMs: 0,
      capturePage: async (url) => shot(url),
    })
    expect(budgeted.captured).toEqual([])
    expect(budgeted.skipped.every((entry) => entry.reason === 'time budget exhausted')).toBe(true)
  })

  test('restricts capture to the requested batch, honours the generator asset root, and refuses hostile paths', async () => {
    const pages = [
      page('first', { mode: 'required', rationale: 'r', estimatedCaptures: 1, startPath: '/first' }),
      page('second', { mode: 'required', rationale: 'r', estimatedCaptures: 1, startPath: '/second' }),
      page('offsite', { mode: 'required', rationale: 'r', estimatedCaptures: 1, startPath: '//evil.example/steal' }),
      page('../escape', { mode: 'required', rationale: 'r', estimatedCaptures: 1, startPath: '/escape' }),
    ]
    const documentationPlan = plan(pages)
    const root = await workspace(documentationPlan)
    const docusaurus = { ...project(), generator: 'docusaurus' as const, contentDir: 'website' }
    const urls: string[] = []
    const result = await captureNavigableSteps({
      workspace: root,
      project: docusaurus,
      plan: documentationPlan,
      pages: [pages[1]!, pages[2]!, pages[3]!],
      capturePage: async (url) => {
        urls.push(url)
        return shot(url)
      },
    })
    expect(urls).toEqual([`${BASE_URL}/second`])
    expect(result.captured).toEqual([{ page: 'second', step: '01', file: expect.stringMatching(/^website\/static\/img\/guides\/second\/01-.+\.png$/) }])
    // Off-origin routes are refused while collecting candidates; unsafe folder
    // names are refused before anything is written.
    expect(result.skipped).toEqual([
      { page: 'offsite', step: '01', reason: 'path "//evil.example/steal" leaves http://127.0.0.1:4318' },
      { page: '../escape', step: '01', reason: 'page id "../escape" is not a safe folder name' },
    ])
    expect((await stat(join(root, result.captured[0]!.file))).size).toBeGreaterThan(0)
    const staged = await manifest(root)
    expect(staged.guides[0]!.steps[0]).toMatchObject({ status: 'planned' })
    expect(staged.guides[1]!.steps[0]).toMatchObject({ status: 'verified' })
  })
})
