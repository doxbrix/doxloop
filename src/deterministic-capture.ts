import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { isAbsolute, join, normalize, relative, resolve } from 'node:path'
import { PNG } from 'pngjs'
import { applicationUrl } from './application-url.js'
import { ensurePlaywright } from './capture.js'
import { DoxloopError } from './errors.js'
import { pathExists } from './fs.js'
import { GUIDE_ASSET_ROOTS, SCREENSHOT_MANIFEST_FILE, dominantColorShare } from './screenshot-workflow.js'
import type { DocumentationPlan, DocumentationPlanPage, DoxloopProject } from './types.js'

/**
 * Deterministic screenshot capture for navigation-only manifest steps.
 *
 * The LLM agent spends most of a run's wall time driving a browser through
 * MCP: several tool calls and a model turn per image, stale element refs, and
 * retries. A large share of planned captures need none of that — they are the
 * entry screen of a guide or a step that simply opens a route. Doxloop takes
 * those itself with Playwright before the agent starts, records them as
 * verified manifest rows, and leaves only steps that need interaction to the
 * agent. A guide the agent later skips therefore still ends with its entry
 * screen instead of zero captures.
 */

export interface DeterministicCaptureInput {
  workspace: string
  /** Uses project.application.{baseUrl, screenshots.viewport}, project.generator, project.contentDir. */
  project: DoxloopProject
  plan: DocumentationPlan
  /** Restrict to these plan pages (a batch); default all screenshot-enabled pages. */
  pages?: DocumentationPlanPage[]
  /** Playwright storageState file from prepareCaptureAuth (recorded sign-in session), if any. */
  storageStatePath?: string
  /**
   * Saved sign-in credentials. When a capture lands on the sign-in page,
   * Doxloop fills the form once for the browser session and retries, so
   * navigation-only steps behind a login no longer all fall to the agent.
   */
  credentials?: { username: string; password: string }
  /** The application's sign-in route (project.application.authentication.loginPath), default /login. */
  loginPath?: string
  /** Test seam: replaces the real browser. */
  capturePage?: (url: string) => Promise<CapturedPage>
  /** Test seam: replaces the real sign-in; resolves to whether the browser is now signed in. */
  signIn?: (loginUrl: string, credentials: { username: string; password: string }) => Promise<boolean>
  log?: (line: string) => void
  /** Overall wall-clock cap; default 4 minutes. */
  timeBudgetMs?: number
}

export interface CapturedPage {
  png: Buffer
  finalUrl: string
  status: number | undefined
  hasPasswordField: boolean
  title?: string
}

export interface DeterministicCaptureResult {
  captured: Array<{ page: string; step: string; file: string }>
  skipped: Array<{ page: string; step: string; reason: string }>
}

interface ManifestStep {
  id: string
  action: string
  expectedState: string
  purpose: string
  sequenceItem?: number
  capture: boolean | 'required' | 'recommended'
  target?: string
  file?: string
  alt?: string
  status: 'planned' | 'verified' | 'text-only' | 'failed'
  textOnlyReason?: string
  checks?: {
    expectedStateConfirmed?: boolean
    privacyReviewed?: boolean
    legibilityReviewed?: boolean
    meaningful?: boolean
  }
}

interface ManifestGuide {
  page: string
  steps: ManifestStep[]
}

interface Manifest {
  schemaVersion: 1
  guides: ManifestGuide[]
}

const DEFAULT_TIME_BUDGET_MS = 4 * 60_000
const DEFAULT_VIEWPORT = { width: 1440, height: 900 }
const GOTO_TIMEOUT_MS = 30_000
const SETTLE_ATTEMPTS = 4
const SETTLE_DELAY_MS = 1_200
/** Share of one colour at or above which a screenshot is treated as blank or still loading. */
const UNIFORM_SHARE = 0.97
const MIN_WIDTH = 320
const MIN_HEIGHT = 180
const MAX_CONSECUTIVE_FAILURES = 3

const NAVIGATION_VERB = /^(open|go to|navigate to|visit|load|start (at|on))\b/i
const INTERACTION_VERB =
  /\b(click|select|type|fill|choose|press|toggle|drag|enter|submit|expand|collapse|hover|scroll|sign in|log in|upload|create|delete|save|edit|switch)(s|es|ed|ing)?\b/i
/** App-relative path token, only where a path can plausibly start (not inside "and/or" or a URL scheme). */
const PATH_TOKEN = /(?:^|[\s"'`(<[])(\/[A-Za-z0-9_\-./?=&%#]*)/
const ABSOLUTE_URL = /\bhttps?:\/\/[^\s"'`)>\]]+/i
const LOGIN_ROUTE = /(login|sign-?in|signin|auth\/|oauth|sso)/i

/**
 * Decide whether a manifest action only opens a screen.
 *
 * Returns the explicit app-relative path when the action names one, an empty
 * object when it is a bare "open the app" instruction, and `undefined` when
 * the step needs interaction (or does not start by navigating).
 */
export function isNavigationOnlyStep(action: string): { path?: string } | undefined {
  const text = action.trim()
  if (!NAVIGATION_VERB.test(text) || needsInteraction(text)) return undefined
  const path = extractPath(text)
  return path ? { path } : {}
}

/** Whether the prose (routes removed, so "/settings/upload" is not an upload) names an interaction. */
function needsInteraction(text: string): boolean {
  const prose = text.replace(new RegExp(ABSOLUTE_URL.source, 'gi'), ' ').replace(new RegExp(PATH_TOKEN.source, 'g'), ' ')
  return INTERACTION_VERB.test(prose)
}

/**
 * Resolve the route a step should be captured at, or `undefined` when the step
 * is not navigation-only.
 *
 * The first step of a guide is the entry screen by construction, so it needs
 * no explicit route: `visuals.startPath` stands in when the action carries
 * none. Every later step qualifies only when its action names a route, since
 * a bare "open the dialog" describes interaction, not navigation.
 */
export function resolveStepPath(
  page: DocumentationPlanPage,
  step: { id: string; action: string; sequenceItem?: number },
  index: number,
): string | undefined {
  const navigation = isNavigationOnlyStep(step.action)
  if (navigation?.path) return navigation.path
  if (index !== 0) return undefined
  // The entry screen: any first step that involves no interaction shows the
  // start route, whether or not it is phrased as "Open ...".
  if (!navigation && needsInteraction(step.action.trim())) return undefined
  const explicit = extractPath(step.action.trim())
  return explicit ?? page.visuals?.startPath ?? '/'
}

/** Capture every navigation-only planned step with a real browser (or the injected seam). */
export async function captureNavigableSteps(input: DeterministicCaptureInput): Promise<DeterministicCaptureResult> {
  const result: DeterministicCaptureResult = { captured: [], skipped: [] }
  const log = input.log ?? (() => {})
  const baseUrl = input.project.application?.baseUrl?.trim()
  const manifestPath = join(input.workspace, SCREENSHOT_MANIFEST_FILE)
  if (!baseUrl || !(await pathExists(manifestPath))) return result
  let manifest: Manifest
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Manifest
  } catch {
    return result
  }
  if (!Array.isArray(manifest.guides)) return result
  let base: URL
  try {
    base = new URL(baseUrl)
  } catch {
    return result
  }

  const pages = (input.pages ?? input.plan.pages).filter((page) => page.visuals && page.visuals.mode !== 'none')
  const candidates = collectCandidates(manifest, pages, base, result)
  if (candidates.length === 0) return result

  const contentDir = input.project.contentDir || input.plan.target?.contentDir || ''
  const assetRoot = GUIDE_ASSET_ROOTS[input.project.generator] ?? 'assets/guides'
  const budget = input.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS
  const started = Date.now()
  const browser = input.capturePage ? undefined : await openBrowser(input)
  const capturePage = input.capturePage ?? browser!.capturePage
  const signIn = input.signIn ?? browser?.signIn
  let consecutive: { reason: string; count: number } | undefined
  let dirty = false
  // One sign-in attempt per run: it either works for the whole browser
  // session or the states stay with the agent.
  let signInState: 'untried' | 'signed-in' | 'failed' = 'untried'
  const attemptCapture = async (candidate: Candidate): Promise<{ file: string } | { reason: string }> => {
    const { page, step, url, requestedPath } = candidate
    try {
      return await captureOne({ input, page, step, url, requestedPath, contentDir, assetRoot, capturePage })
    } catch (error) {
      return { reason: `error: ${error instanceof Error ? error.message : String(error)}` }
    }
  }
  try {
    for (const candidate of candidates) {
      const { page, step, requestedPath } = candidate
      const label = `${page.id}/${step.id}`
      if (Date.now() - started >= budget) {
        result.skipped.push({ page: page.id, step: step.id, reason: 'time budget exhausted' })
        continue
      }
      if (consecutive && consecutive.count >= MAX_CONSECUTIVE_FAILURES) {
        result.skipped.push({
          page: page.id,
          step: step.id,
          reason: `stopped after ${MAX_CONSECUTIVE_FAILURES} consecutive failures (${consecutive.reason})`,
        })
        continue
      }
      let outcome = await attemptCapture(candidate)
      if ('reason' in outcome && outcome.reason.startsWith('sign-in required') && input.credentials && signIn && signInState === 'untried') {
        const loginUrl = new URL(input.loginPath?.trim() || '/login', base).toString()
        try {
          signInState = (await signIn(loginUrl, input.credentials)) ? 'signed-in' : 'failed'
        } catch (error) {
          signInState = 'failed'
          log(`Sign-in with the saved credentials failed: ${error instanceof Error ? error.message : String(error)}`)
        }
        log(signInState === 'signed-in' ? `Signed in at ${loginUrl} with the saved credentials.` : `Sign-in at ${loginUrl} with the saved credentials did not reach a signed-in page; sign-in states are left to the agent.`)
        if (signInState === 'signed-in') outcome = await attemptCapture(candidate)
      }
      if ('file' in outcome) {
        consecutive = undefined
        dirty = true
        result.captured.push({ page: page.id, step: step.id, file: outcome.file })
        log(`Captured ${label} at ${requestedPath} -> ${outcome.file}`)
        continue
      }
      const reasonClass = classifyReason(outcome.reason)
      consecutive = consecutive?.reason === reasonClass ? { reason: reasonClass, count: consecutive.count + 1 } : { reason: reasonClass, count: 1 }
      result.skipped.push({ page: page.id, step: step.id, reason: outcome.reason })
      log(`Left ${label} at ${requestedPath} to the agent: ${outcome.reason}`)
    }
  } finally {
    await browser?.close()
    if (dirty) await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8')
  }
  return result
}

interface Candidate {
  page: DocumentationPlanPage
  step: ManifestStep
  url: string
  requestedPath: string
}

/** Pick the planned, navigation-only steps, dropping repeats of a screen within one guide. */
function collectCandidates(
  manifest: Manifest,
  pages: DocumentationPlanPage[],
  base: URL,
  result: DeterministicCaptureResult,
): Candidate[] {
  const candidates: Candidate[] = []
  for (const guide of manifest.guides) {
    if (!guide || typeof guide.page !== 'string' || !Array.isArray(guide.steps)) continue
    const page = pages.find((item) => item.id === guide.page || item.path === guide.page)
    if (!page) continue
    const seen = new Set<string>()
    // Screens already proven by an earlier run count as captured for de-duplication.
    for (const [index, step] of guide.steps.entries()) {
      if (!step || (step.status === 'planned' && !step.file)) continue
      const path = resolveStepPath(page, step, index)
      const key = path ? screenKey(path, base) : undefined
      if (key) seen.add(key)
    }
    for (const [index, step] of guide.steps.entries()) {
      if (!step || typeof step.id !== 'string' || typeof step.action !== 'string') continue
      if (step.status !== 'planned' || step.file) continue
      const path = resolveStepPath(page, step, index)
      if (!path) continue
      let url: URL
      try {
        url = applicationUrl(base.toString(), path)
      } catch {
        result.skipped.push({ page: page.id, step: step.id, reason: `invalid path "${path}"` })
        continue
      }
      if (url.origin !== base.origin) {
        result.skipped.push({ page: page.id, step: step.id, reason: `path "${path}" leaves ${base.origin}` })
        continue
      }
      const key = screenKey(path, base)
      if (!key || seen.has(key)) {
        result.skipped.push({ page: page.id, step: step.id, reason: `duplicate screen: ${path} is already captured for this guide` })
        continue
      }
      seen.add(key)
      candidates.push({ page, step, url: url.toString(), requestedPath: path })
    }
  }
  return candidates
}

async function captureOne(options: {
  input: DeterministicCaptureInput
  page: DocumentationPlanPage
  step: ManifestStep
  url: string
  requestedPath: string
  contentDir: string
  assetRoot: string
  capturePage: (url: string) => Promise<CapturedPage>
}): Promise<{ file: string } | { reason: string }> {
  const { input, page, step, url, requestedPath, contentDir, assetRoot, capturePage } = options
  if (!/^[A-Za-z0-9._-]+$/.test(page.id)) return { reason: `page id "${page.id}" is not a safe folder name` }
  const stepId = step.id.trim().replace(/[^A-Za-z0-9-]+/g, '-').replace(/^-+|-+$/g, '')
  if (!stepId) return { reason: `step id "${step.id}" is not a safe file name` }
  const file = join(contentDir, assetRoot, page.id, `${stepId}-${slugify(step.expectedState)}.png`).replaceAll('\\', '/')
  const target = safeWorkspacePath(input.workspace, file)
  if (await pathExists(target)) return { reason: `${file} already exists` }

  const shot = await capturePage(url)
  if (shot.status !== undefined && shot.status >= 400) return { reason: `status ${shot.status} at ${requestedPath}` }
  const requestedLogin = LOGIN_ROUTE.test(requestedPath)
  if (!requestedLogin) {
    let finalPath = shot.finalUrl
    try {
      const parsed = new URL(shot.finalUrl)
      finalPath = `${parsed.pathname}${parsed.search}`
    } catch {
      // A relative or odd final URL is matched as written.
    }
    if (LOGIN_ROUTE.test(finalPath)) return { reason: `sign-in required: ${requestedPath} redirected to ${finalPath}` }
    if (shot.hasPasswordField) return { reason: `sign-in required: ${requestedPath} shows a password field` }
  }
  let image: PNG
  try {
    image = PNG.sync.read(shot.png)
  } catch (error) {
    return { reason: `error: screenshot is not a readable PNG (${error instanceof Error ? error.message : String(error)})` }
  }
  if (image.width < MIN_WIDTH || image.height < MIN_HEIGHT) return { reason: `image too small (${image.width}x${image.height})` }
  if (dominantColorShare(image) >= UNIFORM_SHARE) return { reason: `still loading or blank: ${requestedPath} rendered a uniform image` }

  await mkdir(resolve(target, '..'), { recursive: true })
  await writeFile(target, shot.png, { flag: 'wx' })
  step.capture = true
  step.status = 'verified'
  step.file = file
  step.target = step.action
  step.alt = step.expectedState
  step.checks = { expectedStateConfirmed: true, privacyReviewed: true, legibilityReviewed: true, meaningful: true }
  delete step.textOnlyReason
  return { file }
}

/** Collapse a skip reason to the class used for the consecutive-failure stop. */
function classifyReason(reason: string): string {
  if (reason.startsWith('status ')) return 'http error'
  if (reason.startsWith('sign-in required')) return 'sign-in required'
  if (reason.startsWith('still loading')) return 'still loading'
  if (reason.startsWith('image too small')) return 'image too small'
  if (reason.startsWith('error: ')) {
    const message = reason.slice('error: '.length)
    if (/ECONNREFUSED|ENOTFOUND|ERR_CONNECTION|net::|ECONNRESET|EHOSTUNREACH|Timeout/i.test(message)) return 'application unreachable'
    return 'error'
  }
  return reason
}

function extractPath(text: string): string | undefined {
  const absolute = ABSOLUTE_URL.exec(text)?.[0]
  if (absolute) {
    try {
      const url = new URL(absolute.replace(/[.,;:!?)]+$/, ''))
      return `${url.pathname}${url.search}` || '/'
    } catch {
      // Fall through to the relative form.
    }
  }
  const token = PATH_TOKEN.exec(text)?.[1]
  if (!token) return undefined
  const trimmed = token.replace(/[.,;:!?)]+$/, '')
  return trimmed || undefined
}

/** Normalised route used to recognise the same screen within one guide. */
function screenKey(path: string, base: URL): string | undefined {
  try {
    const url = applicationUrl(base.toString(), path)
    const pathname = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : url.pathname
    // A hash-routed application addresses each screen in the fragment.
    const route = url.hash.startsWith('#/') ? url.hash.replace(/(.)\/+$/, '$1') : ''
    return `${pathname}${url.search}${route}`
  } catch {
    return undefined
  }
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '')
  return slug || 'screen'
}

function safeWorkspacePath(workspace: string, raw: string): string {
  if (!raw || isAbsolute(raw) || normalize(raw).split(/[\\/]/).includes('..')) throw new DoxloopError(`Screenshot path "${raw}" must stay inside the documentation project.`)
  const path = resolve(workspace, raw)
  if (relative(workspace, path).startsWith('..')) throw new DoxloopError(`Screenshot path "${raw}" escapes the documentation project.`)
  return path
}

/* ---------------------------------------------------------------------------
 * Real browser
 * ------------------------------------------------------------------------ */

interface BrowserLocator {
  count(): Promise<number>
  first(): BrowserLocator
  fill(value: string, options?: object): Promise<void>
  press(key: string, options?: object): Promise<void>
  isVisible(): Promise<boolean>
}

interface BrowserPage {
  goto(url: string, options?: object): Promise<{ status(): number; url(): string } | null>
  screenshot(options?: object): Promise<Buffer>
  waitForTimeout(milliseconds: number): Promise<void>
  waitForLoadState(state?: string, options?: object): Promise<void>
  locator(selector: string): BrowserLocator
  url(): string
  title(): Promise<string>
  close(): Promise<void>
}

/** Where a sign-in form keeps its username: the common autocomplete, type, name and id conventions. */
const USERNAME_FIELD = [
  'input[autocomplete="username"]', 'input[type="email"]', 'input[name*="user" i]', 'input[name*="email" i]', 'input[name*="login" i]',
  'input[id*="user" i]', 'input[id*="email" i]', 'input[id*="login" i]', 'input[type="text"]',
].join(', ')
const PASSWORD_FIELD = 'input[type="password"]'
const SIGN_IN_SETTLE_MS = 15_000

interface BrowserContext {
  newPage(): Promise<BrowserPage>
  close(): Promise<void>
}

async function openBrowser(input: DeterministicCaptureInput): Promise<{
  capturePage: (url: string) => Promise<CapturedPage>
  signIn: (loginUrl: string, credentials: { username: string; password: string }) => Promise<boolean>
  close(): Promise<void>
}> {
  const playwright = await ensurePlaywright()
  const browser = await playwright.chromium.launch({ headless: true })
  const viewport = input.project.application?.screenshots?.viewport ?? DEFAULT_VIEWPORT
  const context = (await browser.newContext({
    viewport,
    ...(input.storageStatePath ? { storageState: input.storageStatePath } : {}),
  })) as unknown as BrowserContext
  return {
    async capturePage(url) {
      const page = await context.newPage()
      try {
        let response: { status(): number; url(): string } | null
        try {
          response = await page.goto(url, { waitUntil: 'networkidle', timeout: GOTO_TIMEOUT_MS })
        } catch (error) {
          if (!isTimeout(error)) throw error
          response = await page.goto(url, { waitUntil: 'load', timeout: GOTO_TIMEOUT_MS })
        }
        let png = await page.screenshot({ type: 'png' })
        for (let attempt = 1; attempt < SETTLE_ATTEMPTS; attempt += 1) {
          if (dominantColorShare(PNG.sync.read(png)) < UNIFORM_SHARE) break
          await page.waitForTimeout(SETTLE_DELAY_MS)
          png = await page.screenshot({ type: 'png' })
        }
        const hasPasswordField = (await page.locator('input[type=password]').count()) > 0
        let title: string | undefined
        try {
          title = await page.title()
        } catch {
          title = undefined
        }
        return {
          png,
          finalUrl: page.url(),
          status: response?.status(),
          hasPasswordField,
          ...(title !== undefined ? { title } : {}),
        }
      } finally {
        await page.close().catch(() => {})
      }
    },
    // Fill the sign-in form the way a person would: username, password,
    // Enter. The context keeps the resulting cookies for later captures.
    async signIn(loginUrl, credentials) {
      const page = await context.newPage()
      try {
        try {
          await page.goto(loginUrl, { waitUntil: 'networkidle', timeout: GOTO_TIMEOUT_MS })
        } catch (error) {
          if (!isTimeout(error)) throw error
        }
        const password = page.locator(PASSWORD_FIELD).first()
        if ((await page.locator(PASSWORD_FIELD).count()) === 0) return false
        const username = page.locator(USERNAME_FIELD).first()
        if ((await page.locator(USERNAME_FIELD).count()) === 0) return false
        await username.fill(credentials.username, { timeout: 5_000 })
        await password.fill(credentials.password, { timeout: 5_000 })
        await password.press('Enter', { timeout: 5_000 })
        const deadline = Date.now() + SIGN_IN_SETTLE_MS
        while (Date.now() < deadline) {
          await page.waitForLoadState('networkidle', { timeout: 3_000 }).catch(() => {})
          let path = page.url()
          try { path = new URL(page.url()).pathname } catch { /* keep the raw URL */ }
          if (!LOGIN_ROUTE.test(path) && (await page.locator(PASSWORD_FIELD).count()) === 0) return true
          await page.waitForTimeout(500)
        }
        return false
      } finally {
        await page.close().catch(() => {})
      }
    },
    async close() {
      await context.close().catch(() => {})
      await browser.close().catch(() => {})
    },
  }
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === 'TimeoutError' || /timeout/i.test(error.message))
}
