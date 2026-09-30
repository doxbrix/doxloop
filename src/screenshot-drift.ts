/**
 * Screenshot drift: re-capture every recorded screenshot at its route in the
 * running application and compare it with the image the documentation shows.
 * Product UI changes far more often than its docs; a renamed button or a
 * redesigned settings screen left guides showing screens that no longer
 * exist, and nothing noticed until a reader did.
 *
 * Nothing is replaced here. The check writes the fresh captures to the cache
 * and a report; the reviewer replaces the changed ones from the control
 * center (as an undoable direct edit).
 */
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import pixelmatch from 'pixelmatch'
import { PNG } from 'pngjs'
import { applicationUrl } from './application-url.js'
import { loadCaptureCredentials, prepareCaptureAuth } from './capture-auth.js'
import { openBrowser, type CapturedPage } from './deterministic-capture.js'
import { applyDirectEdit, safePath } from './direct-edit.js'
import { DoxloopError } from './errors.js'
import { assertInside, pathExists } from './fs.js'
import { loadProject } from './project.js'
import { imageFacts, readScreenshotLedger, writeScreenshotLedger, type ScreenshotRecord } from './screenshot-ledger.js'

export const SCREENSHOT_DRIFT_DIRECTORY = join('.doxloop', 'cache', 'screenshot-drift')
export const SCREENSHOT_DRIFT_REPORT = join(SCREENSHOT_DRIFT_DIRECTORY, 'report.json')

/** Share of pixels that must differ before a screenshot counts as changed. */
export const CHANGED_SHARE = 0.01
const LOGIN_ROUTE = /(?:^|[/#])(?:login|log-in|sign-?in|signin|auth|oauth|sso)(?:[/?#]|$)/i

export type DriftOutcome = 'unchanged' | 'changed' | 'sign-in' | 'unreachable' | 'no-route' | 'missing' | 'error'

export interface DriftResult {
  file: string
  page: string
  step: string
  expectedState: string
  route?: string
  outcome: DriftOutcome
  /** Share of differing pixels, 0–1; 1 when the size changed. */
  difference?: number
  /** Cache file with the fresh capture, for changed screenshots. */
  candidate?: string
  /** Cache file highlighting the differing pixels. */
  diff?: string
  detail?: string
}

export interface DriftReport {
  schemaVersion: 1
  checkedAt: string
  application?: string
  recorded: number
  results: DriftResult[]
}

export interface DriftOptions {
  /** Only these image files. */
  files?: string[]
  /** Test seam: replaces the real browser. */
  capturePage?: (url: string) => Promise<CapturedPage>
  signIn?: (loginUrl: string, credentials: { username: string; password: string }) => Promise<boolean>
  log?: (line: string) => void
}

/** Share of differing pixels between two PNGs (1 when their sizes differ), and a diff image. */
export function compareScreenshots(before: Buffer, after: Buffer): { share: number; diff?: Buffer } {
  const left = PNG.sync.read(before)
  const right = PNG.sync.read(after)
  if (left.width !== right.width || left.height !== right.height) return { share: 1 }
  const diff = new PNG({ width: left.width, height: left.height })
  // A small per-pixel threshold ignores anti-aliasing and font smoothing.
  const changed = pixelmatch(left.data, right.data, diff.data, left.width, left.height, { threshold: 0.1, includeAA: false, alpha: 0.3 })
  return { share: changed / (left.width * left.height), diff: PNG.sync.write(diff) }
}

function cacheName(file: string, kind: 'candidate' | 'diff'): string {
  return join(SCREENSHOT_DRIFT_DIRECTORY, `${createHash('sha256').update(file).digest('hex').slice(0, 16)}-${kind}.png`).replaceAll('\\', '/')
}

export async function readDriftReport(root: string): Promise<DriftReport | undefined> {
  try {
    const value = JSON.parse(await readFile(join(root, SCREENSHOT_DRIFT_REPORT), 'utf8')) as DriftReport
    return value.schemaVersion === 1 && Array.isArray(value.results) ? value : undefined
  } catch {
    return undefined
  }
}

async function recheck(root: string, record: ScreenshotRecord, base: string, capture: (url: string) => Promise<CapturedPage>): Promise<DriftResult> {
  const result: DriftResult = { file: record.file, page: record.page, step: record.step, expectedState: record.expectedState, ...(record.route ? { route: record.route } : {}), outcome: 'error' }
  const absolute = join(root, record.file)
  if (!(await pathExists(absolute))) return { ...result, outcome: 'missing', detail: 'The image is no longer in the project.' }
  if (!record.route) return { ...result, outcome: 'no-route', detail: 'This screenshot was captured without a recorded route; the next documentation run that captures it records one.' }
  let url: string
  try { url = applicationUrl(base, record.route).toString() } catch { return { ...result, outcome: 'error', detail: `The route ${record.route} is not a valid address.` } }
  let shot: CapturedPage
  try {
    shot = await capture(url)
  } catch (error) {
    return { ...result, outcome: 'unreachable', detail: error instanceof Error ? error.message.split('\n')[0] ?? error.message : String(error) }
  }
  if (shot.status !== undefined && shot.status >= 400) return { ...result, outcome: 'unreachable', detail: `The application answered HTTP ${shot.status}.` }
  const requestedLogin = LOGIN_ROUTE.test(record.route)
  let finalRoute = shot.finalUrl
  try { const parsed = new URL(shot.finalUrl); finalRoute = `${parsed.pathname}${parsed.hash}` } catch { /* keep the raw URL */ }
  if (!requestedLogin && (LOGIN_ROUTE.test(finalRoute) || shot.hasPasswordField)) return { ...result, outcome: 'sign-in', detail: 'The application showed its sign-in screen. Save a signed-in session or test credentials under Settings → Visual evidence.' }
  const before = await readFile(absolute)
  let comparison: { share: number; diff?: Buffer }
  try { comparison = compareScreenshots(before, shot.png) } catch (error) {
    return { ...result, outcome: 'error', detail: `The images could not be compared: ${error instanceof Error ? error.message : String(error)}` }
  }
  const difference = Math.round(comparison.share * 10_000) / 10_000
  if (comparison.share < CHANGED_SHARE) return { ...result, outcome: 'unchanged', difference }
  const candidate = cacheName(record.file, 'candidate')
  await writeFile(join(root, candidate), shot.png)
  const diff = comparison.diff ? cacheName(record.file, 'diff') : undefined
  if (diff && comparison.diff) await writeFile(join(root, diff), comparison.diff)
  return { ...result, outcome: 'changed', difference, candidate, ...(diff ? { diff } : {}) }
}

/**
 * Re-capture recorded screenshots and write the drift report. Signs in with
 * the saved session or, once, with saved credentials, exactly as capture does.
 */
export async function checkScreenshotDrift(root: string, options: DriftOptions = {}): Promise<DriftReport> {
  const project = await loadProject(root)
  const base = project.application?.baseUrl?.trim()
  if (!base) throw new DoxloopError('Set the application URL under Settings → Visual evidence before checking screenshots against the application.', 2)
  const ledger = await readScreenshotLedger(root)
  const wanted = options.files ? new Set(options.files) : undefined
  const records = ledger.screenshots.filter((record) => !wanted || wanted.has(record.file))
  const log = options.log ?? (() => {})
  // A full check starts clean; a check of chosen files keeps the other results.
  const previous = wanted ? await readDriftReport(root) : undefined
  if (!wanted) await rm(join(root, SCREENSHOT_DRIFT_DIRECTORY), { recursive: true, force: true })
  await mkdir(join(root, SCREENSHOT_DRIFT_DIRECTORY), { recursive: true })
  const material = options.capturePage ? undefined : await prepareCaptureAuth(root)
  const browser = options.capturePage ? undefined : records.some((record) => record.route) ? await openBrowser({ project, ...(material?.storageStatePath ? { storageStatePath: material.storageStatePath } : {}) }) : undefined
  const capture = options.capturePage ?? browser?.capturePage ?? (async () => { throw new Error('No browser') })
  const signIn = options.signIn ?? browser?.signIn
  const credentials = await loadCaptureCredentials(root)
  let signedIn = false
  const results: DriftResult[] = []
  try {
    for (const record of records) {
      let outcome = await recheck(root, record, base, capture)
      if (outcome.outcome === 'sign-in' && credentials && signIn && !signedIn) {
        const loginUrl = applicationUrl(base, project.application?.authentication?.loginPath?.trim() || '/login').toString()
        signedIn = await signIn(loginUrl, credentials).catch(() => false)
        log(signedIn ? `Signed in at ${loginUrl} with the saved credentials.` : `Sign-in at ${loginUrl} with the saved credentials did not work.`)
        if (signedIn) outcome = await recheck(root, record, base, capture)
      }
      results.push(outcome)
      log(`${outcome.outcome.padEnd(11)} ${record.file}${outcome.difference !== undefined ? ` (${(outcome.difference * 100).toFixed(1)}% of pixels differ)` : ''}`)
    }
  } finally {
    await browser?.close()
    await material?.cleanup()
  }
  const merged = previous ? [...previous.results.filter((result) => !wanted!.has(result.file)), ...results] : results
  const report: DriftReport = { schemaVersion: 1, checkedAt: new Date().toISOString(), application: base, recorded: ledger.screenshots.length, results: merged }
  await writeFile(join(root, SCREENSHOT_DRIFT_REPORT), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  return report
}

/**
 * Replace changed screenshots with their fresh captures, as one undoable
 * direct edit, and record the new images in the ledger.
 */
export async function refreshScreenshots(root: string, files: string[]): Promise<{ replaced: string[] }> {
  const report = await readDriftReport(root)
  if (!report) throw new DoxloopError('Check the screenshots against the application first.', 2)
  const chosen = report.results.filter((result) => result.outcome === 'changed' && result.candidate && files.includes(result.file))
  if (chosen.length === 0) throw new DoxloopError('None of the chosen screenshots has a fresh capture to use. Check them against the application again.', 2)
  for (const result of chosen) {
    await safePath(root, result.file)
    if (!(await pathExists(assertInside(root, join(root, result.candidate!))))) throw new DoxloopError(`The fresh capture for ${result.file} is gone. Check the screenshots again.`, 2)
  }
  await applyDirectEdit(root, {
    kind: 'asset',
    requestText: `Replaced ${chosen.length} screenshot${chosen.length === 1 ? '' : 's'} with fresh captures from the application`,
    files: chosen.map((result) => result.file),
    apply: async () => {
      for (const result of chosen) await copyFile(join(root, result.candidate!), join(root, result.file))
    },
  })
  const ledger = await readScreenshotLedger(root)
  const now = new Date().toISOString()
  for (const record of ledger.screenshots) {
    if (!chosen.some((result) => result.file === record.file)) continue
    const facts = await imageFacts(join(root, record.file))
    if (facts) Object.assign(record, facts, { capturedAt: now })
  }
  await writeScreenshotLedger(root, ledger)
  const replaced = new Set(chosen.map((result) => result.file))
  await writeFile(join(root, SCREENSHOT_DRIFT_REPORT), `${JSON.stringify({ ...report, results: report.results.map((result) => replaced.has(result.file) ? { ...result, outcome: 'unchanged', difference: 0, detail: 'Replaced with the fresh capture.' } : result) }, null, 2)}\n`, 'utf8')
  return { replaced: [...replaced] }
}
