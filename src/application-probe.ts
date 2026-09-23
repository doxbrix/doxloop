/**
 * A single-page application answers every route with HTTP 200 and decides in
 * the browser whether the visitor may stay, so a plain fetch reports a sign-in
 * wall as a reachable page. This probe loads the page in the managed headless
 * browser, lets client routing settle, and reports where the visitor landed.
 * It never throws: a missing browser or a slow page means "no evidence".
 */
import { loadInstalledPlaywright } from './capture.js'

/** Paths (or hash routes) a product uses for its sign-in screen. */
export const SIGN_IN_ROUTE = /(?:^|[/#])(?:login|log-in|signin|sign-in|sign_in|auth|authenticate|sso|oauth)(?:[/?#]|$)/i

export interface SignInProbeObservation {
  /** Where the page ended up once client routing settled. */
  finalUrl: string
  /** Whether a visible password field is on the page. */
  hasPasswordField: boolean
}

export interface SignInWall {
  /** The sign-in route the visitor was sent to, such as `/auth` or `/_/#/login`. */
  signInPath: string
}

/**
 * Decide from what the browser saw whether the page is a sign-in wall: the
 * final route looks like a sign-in route, or a password field is visible.
 */
export function signInWallFromObservation(observation: SignInProbeObservation): SignInWall | undefined {
  let url: URL
  try {
    url = new URL(observation.finalUrl)
  } catch {
    return observation.hasPasswordField ? { signInPath: observation.finalUrl } : undefined
  }
  const hash = url.hash && url.hash !== '#' ? url.hash.replace(/\?.*$/, '') : ''
  if (SIGN_IN_ROUTE.test(url.pathname)) return { signInPath: url.pathname }
  // Hash-routed applications (PocketBase `/_/#/login`) keep the route after `#`.
  if (hash && SIGN_IN_ROUTE.test(hash)) return { signInPath: `${url.pathname}${hash}` }
  if (observation.hasPasswordField) return { signInPath: `${url.pathname}${hash}` }
  return undefined
}

interface ProbeLocator {
  first(): ProbeLocator
  count(): Promise<number>
  isVisible(): Promise<boolean>
}

interface ProbePage {
  goto(url: string, options?: object): Promise<unknown>
  waitForLoadState(state?: string, options?: object): Promise<void>
  waitForTimeout(milliseconds: number): Promise<void>
  locator(selector: string): ProbeLocator
  url(): string
}

interface ProbeBrowser {
  newContext(options: object): Promise<{ newPage(): Promise<unknown>; close(): Promise<void> }>
  close(): Promise<void>
}

export type SignInProbe = (url: string, options?: { timeoutMs?: number }) => Promise<SignInWall | undefined>

const DEFAULT_PROBE_TIMEOUT_MS = 8_000
/** Client-side guards often redirect just after the first idle moment. */
const SETTLE_AFTER_IDLE_MS = 400

/**
 * Load `url` headless and report a sign-in wall, or undefined when the page
 * is not one or nothing could be learned (no browser, timeout, crash).
 */
export async function probeSignInWall(url: string, options: { timeoutMs?: number } = {}): Promise<SignInWall | undefined> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS
  let browser: ProbeBrowser | undefined
  let timer: NodeJS.Timeout | undefined
  let abandoned = false
  const run = async (): Promise<SignInWall | undefined> => {
    const playwright = await loadInstalledPlaywright()
    if (!playwright || abandoned) return undefined
    const launched = (await playwright.chromium.launch({ headless: true })) as unknown as ProbeBrowser
    // The overall deadline may have passed while the browser started.
    if (abandoned) {
      await launched.close().catch(() => {})
      return undefined
    }
    browser = launched
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
    const page = (await context.newPage()) as ProbePage
    const deadline = Date.now() + timeoutMs
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs })
    await page.waitForLoadState('networkidle', { timeout: Math.max(500, deadline - Date.now()) }).catch(() => {})
    await page.waitForTimeout(Math.min(SETTLE_AFTER_IDLE_MS, Math.max(0, deadline - Date.now())))
    let hasPasswordField = false
    try {
      const field = page.locator('input[type="password"]')
      hasPasswordField = (await field.count()) > 0 && (await field.first().isVisible())
    } catch {
      hasPasswordField = false
    }
    return signInWallFromObservation({ finalUrl: page.url(), hasPasswordField })
  }
  try {
    return await Promise.race([
      run().catch(() => undefined),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), timeoutMs + 4_000)
        timer.unref?.()
      }),
    ])
  } catch {
    return undefined
  } finally {
    abandoned = true
    if (timer) clearTimeout(timer)
    const opened = browser as ProbeBrowser | undefined
    if (opened) await opened.close().catch(() => {})
  }
}
