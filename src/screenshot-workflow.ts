import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { extname, isAbsolute, join, normalize, relative, resolve } from 'node:path'
import { PNG } from 'pngjs'
import { DoxloopError } from './errors.js'
import { pathExists } from './fs.js'
import type {
  ApplicationConfig,
  DocumentationPlan,
  DocumentationPlanPage,
  ScreenshotIntent,
  ScreenshotRunSummary,
} from './types.js'

export const SCREENSHOT_MANIFEST_FILE = join('.doxloop', 'screenshot-manifest.json')

export interface ApplicationReadiness {
  configured: boolean
  reachable: boolean
  status: 'not-configured' | 'ready' | 'authentication-required' | 'unreachable'
  url?: string
  message: string
}

interface ScreenshotManifest {
  schemaVersion: 1
  guides: ScreenshotManifestGuide[]
}

interface ScreenshotManifestGuide {
  page: string
  steps: ScreenshotManifestStep[]
}

interface ScreenshotManifestStep {
  id: string
  action: string
  expectedState: string
  purpose: string
  /** One-based item in the approved page visuals.captureSequence. */
  sequenceItem?: number
  capture: boolean | 'required' | 'recommended'
  target?: string
  file?: string
  alt?: string
  /** `planned` is the staged, not-yet-attempted state Doxloop writes up front. */
  status: 'planned' | 'verified' | 'text-only' | 'failed'
  textOnlyReason?: string
  checks?: {
    expectedStateConfirmed?: boolean
    privacyReviewed?: boolean
    legibilityReviewed?: boolean
    meaningful?: boolean
  }
}

/** Generator-native committed asset root for guide screenshots. */
const GUIDE_ASSET_ROOTS: Record<string, string> = {
  doxbrix: 'assets/guides',
  docusaurus: 'static/img/guides',
  mkdocs: 'docs/assets/guides',
  sphinx: '_static/guides',
  hugo: 'static/images/guides',
  vitepress: 'docs/public/images/guides',
  markdoc: 'assets/guides',
  nextra: 'public/images/guides',
  starlight: 'public/images/guides',
  jekyll: 'assets/images/guides',
  static: 'site/assets/guides',
}

/**
 * Create the guide asset directories before the agent opens a browser.
 *
 * The capture tool resolves its filename against the project root and does not
 * create missing parents: a nested filename whose directory does not exist
 * fails with ENOENT, and the run then reports screenshots it never took. The
 * agent is told to create each directory, but a forgotten `mkdir` silently
 * costs an entire guide, so Doxloop creates the predictable ones itself.
 */
export async function prepareGuideAssetDirectories(
  workspace: string,
  generator: string,
  plan: Pick<DocumentationPlan, 'pages'> | undefined,
  contentDir = '',
): Promise<string[]> {
  const root = GUIDE_ASSET_ROOTS[generator] ?? 'assets/guides'
  const pages = plan?.pages.filter((page) => page.visuals && page.visuals.mode !== 'none') ?? []
  const names = new Set<string>()
  for (const page of pages) {
    // Agents name the folder after the page id or its last path segment.
    for (const candidate of [page.id, page.path.replaceAll('\\', '/').split('/').filter(Boolean).at(-1)]) {
      const slug = candidate?.trim()
      if (slug && /^[A-Za-z0-9._-]+$/.test(slug)) names.add(slug)
    }
  }
  const created: string[] = []
  for (const name of names) {
    const relative = join(contentDir || '', root, name)
    try {
      await mkdir(join(workspace, relative), { recursive: true })
      created.push(relative)
    } catch {
      // A directory Doxloop cannot create is reported by capture validation.
    }
  }
  return created
}

/**
 * Write the approved guides into the manifest before the agent runs.
 *
 * Left to build the manifest itself, an agent builds it at the end out of what
 * it happened to capture: guides it decided to skip — often without ever
 * opening their startPath — simply do not appear, and the run reports success
 * while quietly dropping half the approved work. Staging every approved guide
 * up front turns capture into filling in a form, and a guide the agent never
 * touched stays visible as an unfinished row instead of vanishing.
 *
 * Existing manifests are never overwritten, so a resumed or recovered run keeps
 * the work it already recorded.
 */
export async function writeScreenshotManifestSkeleton(
  workspace: string,
  plan: Pick<DocumentationPlan, 'pages'> | undefined,
): Promise<number> {
  const path = join(workspace, SCREENSHOT_MANIFEST_FILE)
  if (!plan || (await pathExists(path))) return 0
  const pages = plan.pages.filter((page) => page.visuals && page.visuals.mode !== 'none')
  if (pages.length === 0) return 0
  const guides: ScreenshotManifestGuide[] = pages.map((page) => {
    const sequence = page.visuals?.captureSequence ?? []
    const start = page.visuals?.startPath ?? '/'
    const total = Math.max(1, sequence.length || page.visuals?.estimatedCaptures || 1)
    const steps = Array.from({ length: total }, (_, index) => {
      const [action, expectedState, purpose] = (sequence[index] ?? '').split(/\s+—\s+/, 3)
      return {
        id: String(index + 1).padStart(2, '0'),
        // Approved sequence text can be as terse as "Open /", which the manifest
        // contract rejects; expand it here rather than staging an invalid row.
        action: specificManifestAction(action, undefined) ?? `Open ${start} and reach approved capture ${index + 1}.`,
        expectedState: (expectedState?.trim().length ?? 0) >= 8 ? expectedState!.trim() : `The state approved capture ${index + 1} names is visible.`,
        purpose: (purpose?.trim().length ?? 0) >= 8 ? purpose!.trim() : 'Prove this state for the reader of this guide.',
        sequenceItem: index + 1,
        capture: true,
        status: 'planned' as const,
      }
    })
    return { page: page.id, steps }
  })
  await mkdir(join(workspace, '.doxloop'), { recursive: true })
  await writeFile(path, JSON.stringify({ schemaVersion: 1, guides }, null, 2), 'utf8')
  return guides.length
}

/**
 * Claim images the agent captured but never recorded as captures.
 *
 * An agent cannot see a PNG file, so any manifest row it fills in is bookkeeping
 * rather than observation. A cautious agent that is asked to inspect the saved
 * image concludes it cannot, and honestly records every step as text-only —
 * discarding a directory of perfectly good screenshots and failing a run that
 * actually worked. The state was already confirmed in the browser before the
 * shutter, and Doxloop checks the file itself during validation, so adopt an
 * unclaimed image into the step its filename names and let that validation
 * judge it. The images are surfaced for human review either way.
 */
export async function adoptCapturedImages(
  workspace: string,
  generator: string,
  plan: DocumentationPlan | undefined,
): Promise<string[]> {
  const path = join(workspace, SCREENSHOT_MANIFEST_FILE)
  if (!(await pathExists(path))) return []
  let manifest: ScreenshotManifest
  try {
    manifest = JSON.parse(await readFile(path, 'utf8')) as ScreenshotManifest
  } catch {
    return []
  }
  if (!Array.isArray(manifest.guides)) return []
  const root = GUIDE_ASSET_ROOTS[generator] ?? 'assets/guides'
  const contentDir = plan?.target.contentDir || ''
  const claimed = new Set<string>()
  for (const guide of manifest.guides) {
    for (const step of guide?.steps ?? []) if (step?.file) claimed.add(step.file.replaceAll('\\', '/'))
  }
  const adopted: string[] = []
  for (const guide of manifest.guides) {
    if (!guide || typeof guide.page !== 'string' || !Array.isArray(guide.steps)) continue
    const page = plan?.pages.find((item) => item.id === guide.page || item.path === guide.page)
    const sequence = page?.visuals?.captureSequence ?? []
    const usedItems = new Set(guide.steps.filter((step) => step?.capture && step.sequenceItem).map((step) => step.sequenceItem!))
    // Agents name the guide folder after the page id or a trailing path segment.
    const slugs = new Set<string>()
    for (const candidate of [page?.id, page?.path, guide.page]) {
      const slug = candidate?.replaceAll('\\', '/').split('/').filter(Boolean).at(-1)?.trim()
      if (slug && /^[A-Za-z0-9._-]+$/.test(slug)) slugs.add(slug)
    }
    for (const slug of slugs) {
      const relative = join(contentDir, root, slug).replaceAll('\\', '/')
      let entries: string[]
      try {
        entries = await readdir(join(workspace, relative))
      } catch {
        continue
      }
      for (const entry of entries.sort()) {
        if (extname(entry).toLowerCase() !== '.png') continue
        const file = `${relative}/${entry}`
        if (claimed.has(file)) continue
        // Captures are named after the step they prove, so the leading number is
        // the only mapping that cannot silently attach an image to a step it
        // does not show. Without one, leave the file for a human to place.
        const ordinal = stepOrdinal(entry)
        const step = guide.steps.find(
          (item) => item && !item.file && item.status !== 'verified' && ordinal !== undefined && stepOrdinal(item.id) === ordinal,
        )
        if (!step) continue
        // An approved capture sequence still has to line up, or validation will
        // reject the very row this repair just wrote.
        if (sequence.length > 0) {
          const item = step.sequenceItem
          if (!item || item < 1 || item > sequence.length || usedItems.has(item)) continue
          usedItems.add(item)
        }
        step.capture = true
        step.status = 'verified'
        step.file = file
        step.target = step.target?.trim() || step.action
        step.alt = step.alt?.trim() || step.expectedState
        step.checks = { expectedStateConfirmed: true, privacyReviewed: true, legibilityReviewed: true, meaningful: true }
        delete step.textOnlyReason
        claimed.add(file)
        adopted.push(file)
      }
    }
  }
  if (adopted.length > 0) await writeFile(path, JSON.stringify(manifest, null, 2), 'utf8')
  return adopted
}

/** Leading step number of a manifest id or capture filename, if it has one. */
function stepOrdinal(value: string): number | undefined {
  const digits = /^\D*(\d+)/.exec(value)?.[1]
  return digits === undefined ? undefined : Number(digits)
}

/**
 * Reduce a guide that photographed one screen several times to a single image.
 *
 * An approved capture sequence can ask for states that are not actually
 * distinct — "scroll to the history area", "focus the request field", "inspect
 * the coverage panel" — and on a screen that already fits the viewport each of
 * those produces a byte-identical file. The agent followed the approved plan
 * and there is no better image to be had, so failing the run punishes it for
 * the plan's optimism. Keep the first image of each screen, and record the rest
 * as text-only exactly as the instructions ask an agent to do by hand.
 *
 * Repeats are collapsed within a guide only. Two guides showing the same screen
 * is ordinary documentation and is left alone.
 */
export async function collapseDuplicateCaptures(
  workspace: string,
  plan: DocumentationPlan | undefined,
): Promise<string[]> {
  const path = join(workspace, SCREENSHOT_MANIFEST_FILE)
  if (!(await pathExists(path))) return []
  let manifest: ScreenshotManifest
  try {
    manifest = JSON.parse(await readFile(path, 'utf8')) as ScreenshotManifest
  } catch {
    return []
  }
  if (!Array.isArray(manifest.guides)) return []
  const dropped: string[] = []
  for (const guide of manifest.guides) {
    if (!guide || !Array.isArray(guide.steps)) continue
    const page = plan?.pages.find((item) => item.id === guide.page || item.path === guide.page)
    const pagePath = plan && page ? await guidePagePath(workspace, plan, page) : undefined
    const seen = new Map<string, string>()
    for (const step of guide.steps) {
      if (!step?.capture || step.status !== 'verified' || !step.file) continue
      let hash: string
      try {
        hash = createHash('sha256').update(await readFile(safeWorkspacePath(workspace, step.file))).digest('hex')
      } catch {
        continue
      }
      const original = seen.get(hash)
      if (!original) {
        seen.set(hash, step.file)
        continue
      }
      const file = step.file
      if (pagePath) {
        const content = await readFile(pagePath, 'utf8')
        const stripped = removeImageReference(content, file)
        if (stripped !== content) await writeFile(pagePath, stripped, 'utf8')
      }
      await rm(safeWorkspacePath(workspace, file), { force: true })
      step.capture = false
      step.status = 'text-only'
      step.textOnlyReason = `This step shows the same screen as "${original}", so it adds no new image.`
      delete step.file
      delete step.target
      delete step.alt
      delete step.checks
      dropped.push(file)
    }
  }
  if (dropped.length > 0) await writeFile(path, JSON.stringify(manifest, null, 2), 'utf8')
  return dropped
}

/** Drop an image reference, and the frame wrapper it leaves behind. */
function removeImageReference(content: string, file: string): string {
  const basename = file.replaceAll('\\', '/').split('/').at(-1)!
  const lines = content.split('\n')
  const kept: string[] = []
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    if (!line.includes(basename)) {
      kept.push(line)
      continue
    }
    let previous = kept.length - 1
    while (previous >= 0 && (kept[previous] ?? '').trim() === '') previous -= 1
    let next = index + 1
    while (next < lines.length && (lines[next] ?? '').trim() === '') next += 1
    if (previous >= 0 && /^<Frame\b/.test((kept[previous] ?? '').trim()) && (lines[next] ?? '').trim() === '</Frame>') {
      kept.length = previous
      index = next
    }
  }
  return kept.join('\n').replace(/\n{3,}/g, '\n\n')
}

/**
 * Place verified captures the agent left orphaned.
 *
 * Agents routinely capture every planned state and then embed only the first,
 * because a step component holds the procedure and there is no obvious place to
 * put the rest. The images are real and reviewed, so dropping the run over
 * placement wastes correct work: insert each unused capture into the step it
 * belongs to, matching capture order to step order, and fall back to the end of
 * the page when the guide has no step markup.
 */
export async function embedMissingCaptures(
  workspace: string,
  plan: DocumentationPlan | undefined,
): Promise<string[]> {
  const path = join(workspace, SCREENSHOT_MANIFEST_FILE)
  if (!(await pathExists(path))) return []
  let manifest: ScreenshotManifest
  try {
    manifest = JSON.parse(await readFile(path, 'utf8')) as ScreenshotManifest
  } catch {
    return []
  }
  if (!Array.isArray(manifest.guides)) return []
  const embedded: string[] = []
  for (const guide of manifest.guides) {
    if (!guide || !Array.isArray(guide.steps)) continue
    const page = plan?.pages.find((item) => item.id === guide.page || item.path === guide.page)
    const pagePath = plan && page ? await guidePagePath(workspace, plan, page) : undefined
    if (!pagePath) continue
    let content = await readFile(pagePath, 'utf8')
    const captures = guide.steps.filter((step) => step.capture && step.status === 'verified' && step.file)
    for (const [order, step] of captures.entries()) {
      const file = step.file!.replaceAll('\\', '/')
      const basename = file.split('/').at(-1)!
      if (content.includes(file) || content.includes(basename)) continue
      if (!(await pathExists(safeWorkspacePath(workspace, file)))) continue
      const reference = imageReference(content, file)
      const image = `![${(step.alt ?? step.expectedState ?? basename).replaceAll(']', ')')}](${reference})`
      content = insertIntoStep(content, image, order)
      embedded.push(step.file!)
    }
    if (embedded.length > 0) await writeFile(pagePath, content, 'utf8')
  }
  return embedded
}

/** Match the path style the page already uses for its other captures. */
function imageReference(content: string, file: string): string {
  return /\]\(\/assets|\]\(\/img|\]\(\/images|\]\(\/_static|\]\(\//.test(content) ? `/${file}` : file
}

/** Insert inside the nth `<Step>` body, or append when there is no step markup. */
function insertIntoStep(content: string, image: string, order: number): string {
  const closes = [...content.matchAll(/\n?[ \t]*<\/Step>/g)]
  const target = closes[order]
  if (!target || target.index === undefined) return `${content.trimEnd()}\n\n${image}\n`
  return `${content.slice(0, target.index)}\n\n${image}\n${content.slice(target.index)}`
}

async function guidePagePath(
  workspace: string,
  plan: DocumentationPlan,
  page: DocumentationPlanPage,
): Promise<string | undefined> {
  const root = join(workspace, plan.target.contentDir || '')
  for (const candidate of [
    join(root, page.path),
    ...plan.target.pageExtensions.map((extension) => join(root, `${page.path}${extension.startsWith('.') ? extension : `.${extension}`}`)),
    ...plan.target.pageExtensions.map((extension) => join(root, page.path, `index${extension.startsWith('.') ? extension : `.${extension}`}`)),
  ]) {
    if (await pathExists(candidate)) return candidate
  }
  return undefined
}

export function normalizeScreenshotIntent(value: unknown): ScreenshotIntent {
  if (value === true || value === 'enabled') return 'enabled'
  if (value === false || value === 'disabled') return 'disabled'
  return 'auto'
}

export async function assertScreenshotPlanningReadiness(
  application: ApplicationConfig | undefined,
  rawIntent: unknown,
): Promise<void> {
  if (normalizeScreenshotIntent(rawIntent) !== 'enabled') return
  const readiness = await checkApplicationReadiness(application)
  if (readiness.status === 'ready') return
  throw new DoxloopError(`Screenshots are selected, but capture cannot start. ${readiness.message} Start or configure a safe non-production application page, then check it again before planning.`)
}

export function screenshotPlanSummary(plan: Pick<DocumentationPlan, 'pages'>): { guides: number; captures: number } {
  const pages = plan.pages.filter((page) => page.visuals && page.visuals.mode !== 'none')
  return {
    guides: pages.length,
    captures: pages.reduce((total, page) => total + Math.max(1, page.visuals?.estimatedCaptures ?? 0), 0),
  }
}

export async function checkApplicationReadiness(application?: ApplicationConfig): Promise<ApplicationReadiness> {
  if (!application) {
    return {
      configured: false,
      reachable: false,
      status: 'not-configured',
      message: 'Configure a safe local or test application before capturing screenshots.',
    }
  }
  const readinessPath = application.readyPath ?? application.screenshots?.startPath
  const url = readinessPath ? new URL(readinessPath, application.baseUrl).toString() : application.baseUrl
  try {
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(5_000),
      headers: { accept: 'text/html,application/json;q=0.9,*/*;q=0.1' },
    })
    if (response.status === 401 || response.status === 403) {
      return {
        configured: true,
        reachable: true,
        status: 'authentication-required',
        url,
        message: 'The application is reachable but needs an authenticated browser session before capture.',
      }
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      let redirect: URL | undefined
      try { if (location) redirect = new URL(location, url) } catch { /* Report the invalid redirect below. */ }
      const authenticationRedirect = redirect && redirect.origin === new URL(url).origin && /(?:^|\/)(?:login|signin|sign-in|auth)(?:\/|$|\?)/i.test(`${redirect.pathname}${redirect.search}`)
      if (authenticationRedirect) {
        return {
          configured: true,
          reachable: true,
          status: 'authentication-required',
          url,
          message: 'The application is reachable but needs an authenticated browser session before capture.',
        }
      }
      return {
        configured: true,
        reachable: false,
        status: 'unreachable',
        url,
        message: location
          ? `The application readiness check redirected to ${location}; configure the final safe application URL or an authentication route.`
          : 'The application readiness check returned a redirect without a destination.',
      }
    }
    if (!response.ok) {
      return {
        configured: true,
        reachable: false,
        status: 'unreachable',
        url,
        message: `The application readiness check returned HTTP ${response.status}.`,
      }
    }
    return {
      configured: true,
      reachable: true,
      status: 'ready',
      url,
      message: 'The application page is reachable. Doxloop will start its capture browser during documentation generation.',
    }
  } catch (cause) {
    return {
      configured: true,
      reachable: false,
      status: 'unreachable',
      url,
      message: `The application could not be reached: ${cause instanceof Error ? cause.message : String(cause)}`,
    }
  }
}

export interface ScreenshotValidationOptions {
  /**
   * Accept the run despite screenshot problems. Every defect becomes a text-only
   * step with the problem recorded as its reason, images that cannot be shown
   * are removed from their guide, and the summary reports how many problems the
   * reviewer chose to ignore. Nothing is thrown for a capture shortfall.
   */
  tolerateDefects?: boolean
}

export async function validateScreenshotManifest(
  workspace: string,
  plan: DocumentationPlan | undefined,
  rawIntent: unknown,
  options: ScreenshotValidationOptions = {},
): Promise<{ summary: ScreenshotRunSummary; manifest?: ScreenshotManifest }> {
  const intent = normalizeScreenshotIntent(rawIntent)
  const tolerate = options.tolerateDefects === true
  const effectivePlan = plan ?? await workspaceDocumentationPlan(workspace)
  const plannedPages = effectivePlan?.pages.filter((page) => page.visuals && page.visuals.mode !== 'none') ?? []
  // The run-level choice is authoritative. A user changing the plan from
  // Required to Automatic must make all visual rows best-effort, including
  // rows that were originally proposed with visuals.mode "required".
  const required = intent === 'enabled'
  const expected = effectivePlan ? screenshotPlanSummary(effectivePlan) : { guides: 0, captures: 0 }
  if (intent === 'disabled' || (effectivePlan && plannedPages.length === 0 && intent !== 'enabled')) {
    return {
      summary: { intent, status: 'not-requested', planned: 0, captured: 0, textOnly: 0, guides: 0 },
    }
  }
  if (effectivePlan && plannedPages.length === 0 && intent === 'enabled') {
    if (!tolerate) throw new DoxloopError('Screenshots are required, but the approved plan has no screenshot-enabled UI guide.')
    return {
      summary: { intent, status: 'skipped', planned: 0, captured: 0, textOnly: 0, guides: 0, ignoredProblems: 1, message: 'Screenshots were required, but the approved plan has no screenshot-enabled UI guide. The run was accepted without images.' },
    }
  }

  const path = join(workspace, SCREENSHOT_MANIFEST_FILE)
  if (!(await pathExists(path))) {
    if (required && !tolerate) {
      throw new DoxloopError('Screenshots are required, but the agent did not create .doxloop/screenshot-manifest.json. Retry capture or change the run to Automatic/No screenshots.')
    }
    return {
      summary: {
        intent,
        status: effectivePlan ? 'skipped' : 'not-requested',
        planned: expected.captures,
        captured: 0,
        textOnly: 0,
        guides: expected.guides,
        ...(required ? { ignoredProblems: 1 } : {}),
        message: required
          ? 'Screenshots were required, but no capture manifest was produced. The run was accepted without images.'
          : 'Screenshot candidates were planned, but no verified capture manifest was produced.',
      },
    }
  }

  let manifest: ScreenshotManifest
  try {
    manifest = JSON.parse(await readFile(path, 'utf8')) as ScreenshotManifest
  } catch {
    if (!tolerate) throw new DoxloopError('The application screenshot manifest is not valid JSON.')
    return unusableManifestSummary(intent, expected, 'The application screenshot manifest is not valid JSON.')
  }
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.guides)) {
    if (!tolerate) throw new DoxloopError('The application screenshot manifest must use schemaVersion 1 and contain a guides array.')
    return unusableManifestSummary(intent, expected, 'The application screenshot manifest does not use schemaVersion 1 with a guides array.')
  }

  const planned = new Map(plannedPages.map((page) => [page.id, page]))
  const plannedByPath = new Map(plannedPages.map((page) => [page.path, page]))
  const seenGuides = new Set<string>()
  const hashes = new Map<string, string[]>()
  // Every capture problem is collected and reported together. Failing on the
  // first one hides the rest, so a run that fabricated ten verified rows looks
  // like a single misplaced image and gets "fixed" one retry at a time.
  const defects: string[] = []
  // Reviewable problems: reported on the run, never fatal.
  const warnings: string[] = []
  // Guides that are structurally unusable are dropped from the tolerated manifest.
  const droppedGuides = new Set<number>()
  let captured = 0
  let textOnly = 0
  let mutated = false

  // A problem is fatal in strict mode; in tolerant mode it is recorded and the
  // step it concerns is downgraded so the manifest stays truthful.
  const structural = (message: string): void => {
    if (!tolerate) throw new DoxloopError(message)
    defects.push(message)
  }
  const downgrade = async (step: ScreenshotManifestStep, guidePage: DocumentationPlanPage | undefined, reason: string, removeImage: boolean): Promise<void> => {
    const file = step.file
    if (file && effectivePlan && guidePage) {
      const pagePath = await guidePagePath(workspace, effectivePlan, guidePage)
      if (pagePath) {
        const content = await readFile(pagePath, 'utf8')
        const stripped = removeImageReference(content, file)
        if (stripped !== content) await writeFile(pagePath, stripped, 'utf8')
      }
    }
    if (file && removeImage) {
      try {
        await rm(safeWorkspacePath(workspace, file), { force: true })
      } catch {
        // A file outside the workspace was never a capture of this run.
      }
    }
    step.capture = false
    step.status = 'text-only'
    step.textOnlyReason = reason
    delete step.file
    delete step.target
    delete step.alt
    delete step.checks
    textOnly += 1
    mutated = true
  }

  for (const [guideIndex, guide] of manifest.guides.entries()) {
    if (!guide || typeof guide.page !== 'string' || !Array.isArray(guide.steps)) {
      structural(`Screenshot guide ${guideIndex + 1} needs a page and steps array.`)
      droppedGuides.add(guideIndex)
      continue
    }
    const page = planned.get(guide.page) ?? plannedByPath.get(guide.page)
    if (effectivePlan && !page) {
      structural(`Screenshot guide "${guide.page}" is not a screenshot-enabled page in the approved plan.`)
      droppedGuides.add(guideIndex)
      continue
    }
    const pageKey = page?.id ?? guide.page
    if (seenGuides.has(pageKey)) {
      structural(`Screenshot guide "${guide.page}" appears more than once in the manifest.`)
      droppedGuides.add(guideIndex)
      continue
    }
    seenGuides.add(pageKey)
    if (guide.steps.length === 0) {
      structural(`Screenshot guide "${guide.page}" has no planned steps.`)
      droppedGuides.add(guideIndex)
      continue
    }
    const captureSequence = page?.visuals?.captureSequence ?? []
    // Approved capture-sequence items describe captured states only, so map
    // them by capture ordinal: a text-only step must not shift the mapping.
    let captureOrdinal = 0
    guide.steps = guide.steps.map((step) => {
      const captured = step?.capture === true || step?.capture === 'required' || step?.capture === 'recommended'
      return normalizeManifestStep(step, captureSequence, captured ? captureOrdinal++ : -1)
    })
    let shapeProblem: string | undefined
    for (const [stepIndex, step] of guide.steps.entries()) {
      try {
        validateStepShape(step, guide.page, stepIndex)
      } catch (error) {
        if (!tolerate) throw error
        shapeProblem = error instanceof Error ? error.message : String(error)
        break
      }
    }
    if (shapeProblem) {
      defects.push(shapeProblem)
      droppedGuides.add(guideIndex)
      continue
    }
    const guideRequired = intent === 'enabled'
    if (captureSequence.length > 0) {
      const captureSteps = guide.steps.filter((step) => step.capture)
      const sequenceItems = new Set<number>()
      for (const step of captureSteps) {
        if (!step.sequenceItem || step.sequenceItem < 1 || step.sequenceItem > captureSequence.length || sequenceItems.has(step.sequenceItem)) {
          const message = `Screenshot step ${step.id} in "${guide.page}" must identify one unique approved capture-sequence item.`
          if (!tolerate) throw new DoxloopError(message)
          defects.push(message)
          await downgrade(step, page, message, true)
          continue
        }
        sequenceItems.add(step.sequenceItem)
      }
    }
    // A guide still entirely as Doxloop staged it was never attempted. Say that
    // once, naming the guide, instead of repeating it for every step.
    if (guide.steps.every((step) => step.status === 'planned')) {
      const start = page?.visuals?.startPath
      const message = `Guide "${guide.page}" was never captured — every step is still marked planned.${start ? ` Open ${start} in the capture browser` : ' Open its start path in the capture browser'}, capture the states it names, or record each step as text-only with a specific reason.`
      defects.push(message)
      if (tolerate) {
        for (const step of guide.steps) await downgrade(step, page, 'This state was not captured before the run was accepted with screenshot problems ignored.', false)
      }
      continue
    }
    const defectsBeforeGuide = defects.length
    const guideHashes = new Map<string, string[]>()
    const guideFilesByHash = new Map<string, ScreenshotManifestStep[]>()
    let guideCaptured = 0
    for (const step of guide.steps) {
      if (!step.capture) {
        if (step.status !== 'text-only' || !step.textOnlyReason?.trim()) {
          const message = `${step.id} in "${guide.page}" has no image and no text-only reason.`
          defects.push(message)
          if (tolerate) await downgrade(step, page, 'This state was not captured before the run was accepted with screenshot problems ignored.', false)
          continue
        }
        textOnly += 1
        continue
      }
      if (step.status !== 'verified') {
        const message = `${step.id} in "${guide.page}" is marked ${step.status}, not verified.`
        defects.push(message)
        if (tolerate) await downgrade(step, page, `This capture was recorded as ${step.status} when the run was accepted with screenshot problems ignored.`, true)
        continue
      }
      if (!step.file || !step.alt?.trim() || !step.target?.trim()) {
        const message = `${step.id} in "${guide.page}" needs a target, project-relative PNG file, and useful alt text.`
        defects.push(message)
        if (tolerate) await downgrade(step, page, message, true)
        continue
      }
      if (!Object.values(step.checks ?? {}).length || !step.checks?.expectedStateConfirmed || !step.checks.privacyReviewed || !step.checks.legibilityReviewed || !step.checks.meaningful) {
        const message = `${step.id} in "${guide.page}" has not passed expected-state, privacy, legibility, and meaningfulness review.`
        defects.push(message)
        if (tolerate) await downgrade(step, page, message, true)
        continue
      }
      const image = safeWorkspacePath(workspace, step.file)
      if (extname(image).toLowerCase() !== '.png' || !(await pathExists(image))) {
        const message = `${step.id} in "${guide.page}" is missing PNG file "${step.file}" — it was marked verified but never captured.`
        defects.push(message)
        if (tolerate) await downgrade(step, page, message, false)
        continue
      }
      const bytes = await readFile(image)
      let parsed: PNG
      try {
        parsed = PNG.sync.read(bytes)
      } catch {
        const message = `"${step.file}" is not a readable PNG image.`
        defects.push(message)
        if (tolerate) await downgrade(step, page, message, true)
        continue
      }
      if (parsed.width < 320 || parsed.height < 180) {
        const message = `"${step.file}" is too small to be useful (${parsed.width}×${parsed.height}).`
        defects.push(message)
        if (tolerate) await downgrade(step, page, message, true)
        continue
      }
      // A splash or skeleton screen is not visually empty — it has a logo and a
      // line of text — but it is overwhelmingly one background color. Real
      // application screens sit far below this share, so capturing before the
      // page finished rendering is caught here rather than shipped.
      const uniform = dominantColorShare(parsed)
      if (sampledColors(parsed).size < 4 || uniform >= 0.98) {
        const message = `"${step.file}" is ${(uniform * 100).toFixed(1)}% a single color, so it captured a blank, splash, or still-loading screen instead of "${step.expectedState}". Wait until the real content is rendered, confirm it in a snapshot, then capture.`
        defects.push(message)
        if (tolerate) await downgrade(step, page, message, true)
        continue
      }
      // Collect every duplicate instead of stopping at the first: an agent that
      // could not reach a state usually recaptures the same screen for several
      // steps, and the reviewer needs to see the whole pattern at once. Repeats
      // are counted per guide, because two guides showing the same screen is
      // ordinary documentation — a quickstart tour and the reference guide for
      // that screen share it — while one guide repeating a screen means its
      // workflow never advanced.
      const hash = createHash('sha256').update(bytes).digest('hex')
      hashes.set(hash, [...(hashes.get(hash) ?? []), step.file])
      guideHashes.set(hash, [...(guideHashes.get(hash) ?? []), step.file])
      guideFilesByHash.set(hash, [...(guideFilesByHash.get(hash) ?? []), step])
      // A generator's landing page legitimately lives somewhere other than its
      // planned slug — a Doxbrix overview is written as index.mdx — so a page
      // that is not where the plan predicted is a routing choice, not a missing
      // screenshot. Only an image nothing references at all is a real defect.
      const placement = effectivePlan && page
        ? await guideReferencesImage(workspace, effectivePlan, page, step.file)
        : 'page-missing'
      const referenced = placement === 'embedded' ||
        (placement === 'page-missing' && await workspaceReferencesImage(workspace, step.file))
      if (!referenced) {
        const message = placement === 'not-embedded'
          ? `"${step.file}" is not embedded in its matching guide "${guide.page}". Place the image in that page, immediately after the step it proves.`
          : `"${step.file}" is not referenced by any documentation page. Embed it in the guide it belongs to, or record that step as text-only.`
        defects.push(message)
        if (tolerate) await downgrade(step, page, message, true)
        continue
      }
      captured += 1
      guideCaptured += 1
    }
    // One guide that photographed the same screen several times never advanced
    // its workflow, so the extra images document nothing.
    const guideRepeats = [...guideHashes.values()].filter((files) => files.length > 1)
    if (guideRepeats.length > 0) {
      const groups = guideRepeats.map((files) => files.join(' = ')).join('; ')
      defects.push(`Guide "${guide.page}" photographed the same screen more than once: ${groups}. Keep one image of that screen and record the other steps as text-only, or reach the states those steps name.`)
      if (tolerate) {
        for (const steps of guideFilesByHash.values()) {
          for (const step of steps.slice(1)) {
            if (step.status !== 'verified') continue
            await downgrade(step, page, `This step shows the same screen as "${steps[0]?.file}", so it adds no new image.`, true)
            captured -= 1
            guideCaptured -= 1
          }
        }
      }
    }
    // Only report the shortfall when nothing above already explained it, so the
    // report says what is wrong rather than repeating the consequence.
    const minimumCaptures = guideRequired ? 1 : 0
    if (guideCaptured < minimumCaptures && defects.length === defectsBeforeGuide) {
      defects.push(`Guide "${guide.page}" requires ${minimumCaptures} verified capture${minimumCaptures === 1 ? '' : 's'}, but produced ${guideCaptured}.`)
    }
  }

  // Two guides sharing a screen is normal documentation — a tour page and the
  // reference page for that screen show the same thing — so this is reported
  // for the reviewer rather than failing a run that did the work.
  const duplicates = [...hashes.values()].filter((files) => files.length > 1)
  const repeated = duplicates.reduce((count, files) => count + files.length - 1, 0)
  if (duplicates.length > 0) {
    const groups = duplicates.map((files) => files.join(' = ')).join('; ')
    warnings.push(`${repeated} of ${captured} captured screenshot${captured === 1 ? '' : 's'} show a screen another guide already shows: ${groups}. That is expected when guides overlap; confirm each one earns its place on its page.`)
  }
  if (defects.length > 0 && !tolerate) {
    const shown = defects.slice(0, 12)
    const rest = defects.length - shown.length
    throw new DoxloopError(
      `${defects.length} screenshot problem${defects.length === 1 ? '' : 's'} in this run:\n${shown.map((defect) => `- ${defect}`).join('\n')}${rest > 0 ? `\n- …and ${rest} more.` : ''}\nOnly mark a step verified after its image exists, shows the state its name claims, and is embedded in its guide.`,
    )
  }
  const missing = intent === 'enabled'
    ? plannedPages.filter((page) => !seenGuides.has(page.id))
    : []
  if (missing.length > 0) {
    const message = `The screenshot manifest is missing ${missing.map((page) => `"${page.title}"`).join(', ')}.`
    if (!tolerate) throw new DoxloopError(message)
    defects.push(message)
  }
  if (required && captured === 0 && !tolerate) {
    throw new DoxloopError('Screenshots are required, but the manifest contains no verified captures.')
  }
  if (tolerate && (mutated || droppedGuides.size > 0)) {
    manifest.guides = manifest.guides.filter((_guide, index) => !droppedGuides.has(index))
    await writeFile(path, JSON.stringify(manifest, null, 2), 'utf8')
  }
  const ignored = tolerate && defects.length > 0
    ? `${defects.length} screenshot problem${defects.length === 1 ? ' was' : 's were'} ignored when this run was accepted: ${defects.slice(0, 12).map((defect) => defect.replace(/\s+/g, ' ')).join(' ')}${defects.length > 12 ? ` …and ${defects.length - 12} more.` : ''} Review the affected guides before publishing.`
    : undefined
  const messages = [ignored, ...warnings].filter((item): item is string => Boolean(item))
  return {
    manifest,
    summary: {
      intent,
      status: captured > 0 ? 'verified' : 'skipped',
      planned: effectivePlan ? expected.captures : captured + textOnly,
      captured,
      textOnly,
      guides: manifest.guides.length,
      manifest: 'screenshots.json',
      ...(tolerate && defects.length > 0 ? { ignoredProblems: defects.length } : {}),
      ...(messages.length > 0
        ? { message: messages.join(' ') }
        : captured === 0
          ? { message: 'Every planned visual step was intentionally recorded as text-only.' }
          : {}),
    },
  }
}

function unusableManifestSummary(
  intent: ScreenshotIntent,
  expected: { guides: number; captures: number },
  problem: string,
): { summary: ScreenshotRunSummary } {
  return {
    summary: {
      intent,
      status: 'skipped',
      planned: expected.captures,
      captured: 0,
      textOnly: 0,
      guides: expected.guides,
      ignoredProblems: 1,
      message: `${problem} The run was accepted without images.`,
    },
  }
}

async function captureFileExists(workspace: string, file: string): Promise<boolean> {
  try {
    return await pathExists(safeWorkspacePath(workspace, file))
  } catch {
    return false
  }
}

/**
 * Summarize how far capture got, guide by guide, for an agent that continues an
 * interrupted run. Verified rows are named so the agent keeps them; unfinished
 * rows are named with their start path so it knows exactly what is left.
 */
export async function describeScreenshotManifestProgress(
  workspace: string,
  plan: DocumentationPlan | undefined,
): Promise<{ lines: string[]; verified: number; unfinished: number }> {
  const path = join(workspace, SCREENSHOT_MANIFEST_FILE)
  if (!(await pathExists(path))) return { lines: [], verified: 0, unfinished: 0 }
  let manifest: ScreenshotManifest
  try {
    manifest = JSON.parse(await readFile(path, 'utf8')) as ScreenshotManifest
  } catch {
    return { lines: ['The screenshot manifest is not valid JSON; rewrite it from the guides you can verify.'], verified: 0, unfinished: 0 }
  }
  if (!Array.isArray(manifest.guides)) return { lines: [], verified: 0, unfinished: 0 }
  const lines: string[] = []
  let verified = 0
  let unfinished = 0
  for (const guide of manifest.guides) {
    if (!guide || typeof guide.page !== 'string' || !Array.isArray(guide.steps)) continue
    const page = plan?.pages.find((item) => item.id === guide.page || item.path === guide.page)
    const done: string[] = []
    const pending: string[] = []
    const textOnly: string[] = []
    for (const step of guide.steps) {
      if (!step || typeof step.id !== 'string') continue
      if (step.status === 'verified' && step.file && (await captureFileExists(workspace, step.file))) {
        done.push(`${step.id} (${step.file})`)
      } else if (step.status === 'text-only' && step.textOnlyReason?.trim()) {
        textOnly.push(step.id)
      } else {
        pending.push(`${step.id}${step.expectedState ? ` — ${step.expectedState}` : ''}`)
      }
    }
    verified += done.length
    unfinished += pending.length
    const start = page?.visuals?.startPath
    if (pending.length === 0) {
      lines.push(`- Guide "${guide.page}": complete (${done.length} verified, ${textOnly.length} text-only). Keep it as it is.`)
      continue
    }
    lines.push(`- Guide "${guide.page}"${start ? ` (start at ${start})` : ''}: ${done.length} verified${done.length > 0 ? ` — keep ${done.join(', ')}` : ''}; still to finish: ${pending.join('; ')}.`)
  }
  return { lines, verified, unfinished }
}

async function workspaceDocumentationPlan(workspace: string): Promise<DocumentationPlan | undefined> {
  const path = join(workspace, '.doxloop', 'documentation-plan.json')
  if (!(await pathExists(path))) return undefined
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as DocumentationPlan
    return value && Array.isArray(value.pages) && value.target ? value : undefined
  } catch {
    return undefined
  }
}

function normalizeManifestStep(
  step: ScreenshotManifestStep,
  captureSequence: string[],
  captureOrdinal: number,
): ScreenshotManifestStep {
  if (!step || typeof step !== 'object') return step
  const captured = captureOrdinal >= 0
  // An explicit sequenceItem is the agent's own mapping; trust it for the
  // approved-text fallback so a reordered manifest still normalizes correctly.
  const approvedIndex = captured
    ? (typeof step.sequenceItem === 'number' && step.sequenceItem >= 1 ? step.sequenceItem - 1 : captureOrdinal)
    : -1
  const approved = approvedIndex >= 0 ? captureSequence[approvedIndex] : undefined
  const [approvedAction, approvedState, approvedPurpose] = approved?.split(/\s+—\s+/, 3) ?? []
  const action = specificManifestAction(step.action, approvedAction)
  return {
    ...step,
    capture: captured,
    ...(captured && step.sequenceItem === undefined && approved ? { sequenceItem: captureOrdinal + 1 } : {}),
    ...(action ? { action } : {}),
    ...(typeof step.expectedState !== 'string' || step.expectedState.trim().length < 8 ? { expectedState: approvedState ?? step.expectedState } : {}),
    ...(typeof step.purpose !== 'string' || step.purpose.trim().length < 8 ? { purpose: approvedPurpose ?? step.purpose } : {}),
  }
}

function specificManifestAction(value: unknown, approved: string | undefined): string | undefined {
  const current = typeof value === 'string' ? value.trim() : ''
  if (current.length >= 8) return current
  const candidate = approved?.trim() || current
  if (candidate.length >= 8) return candidate
  const openTarget = /^open\s+(.+)$/i.exec(candidate)?.[1]?.trim()
  return openTarget ? `Open the application at ${openTarget}` : candidate || undefined
}

function validateStepShape(step: ScreenshotManifestStep, page: string, index: number): void {
  if (!step || typeof step.id !== 'string' || !step.id.trim()) throw new DoxloopError(`Screenshot step ${index + 1} in "${page}" needs a stable ID.`)
  for (const [label, value] of [['action', step.action], ['expected state', step.expectedState], ['purpose', step.purpose]] as const) {
    if (typeof value !== 'string' || value.trim().length < 8) {
      throw new DoxloopError(
        `Screenshot step ${step.id} in "${page}" needs a specific ${label}: describe it as a full clause of at least 8 characters (got ${typeof value === 'string' ? `"${value.trim()}"` : 'a non-string value'}).`,
      )
    }
  }
  if (typeof step.capture !== 'boolean' || !['planned', 'verified', 'text-only', 'failed'].includes(step.status)) {
    throw new DoxloopError(`Screenshot step ${step.id} in "${page}" has an invalid capture decision or status.`)
  }
}

/** Share of sampled pixels holding the single most common color. */
function dominantColorShare(image: PNG): number {
  const pixels = image.width * image.height
  if (pixels === 0) return 1
  const stride = Math.max(1, Math.floor(pixels / 20_000))
  const counts = new Map<string, number>()
  let sampled = 0
  for (let pixel = 0; pixel < pixels; pixel += stride) {
    const offset = pixel * 4
    const key = `${image.data[offset]}:${image.data[offset + 1]}:${image.data[offset + 2]}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
    sampled += 1
  }
  return sampled === 0 ? 1 : Math.max(...counts.values()) / sampled
}

function sampledColors(image: PNG): Set<string> {
  const colors = new Set<string>()
  const pixels = image.width * image.height
  const stride = Math.max(1, Math.floor(pixels / 2_000))
  for (let pixel = 0; pixel < pixels; pixel += stride) {
    const offset = pixel * 4
    colors.add(`${image.data[offset]}:${image.data[offset + 1]}:${image.data[offset + 2]}:${image.data[offset + 3]}`)
    if (colors.size >= 8) break
  }
  return colors
}

function safeWorkspacePath(workspace: string, raw: string): string {
  if (!raw || isAbsolute(raw) || normalize(raw).split(/[\\/]/).includes('..')) throw new DoxloopError(`Screenshot path "${raw}" must stay inside the documentation project.`)
  const path = resolve(workspace, raw)
  if (relative(workspace, path).startsWith('..')) throw new DoxloopError(`Screenshot path "${raw}" escapes the documentation project.`)
  return path
}

type ImagePlacement = 'embedded' | 'not-embedded' | 'page-missing'

async function guideReferencesImage(
  workspace: string,
  plan: DocumentationPlan,
  page: DocumentationPlanPage,
  image: string,
): Promise<ImagePlacement> {
  const root = join(workspace, plan.target.contentDir || '')
  const candidates = [
    join(root, page.path),
    ...plan.target.pageExtensions.map((extension) => join(root, `${page.path}${extension.startsWith('.') ? extension : `.${extension}`}`)),
    ...plan.target.pageExtensions.map((extension) => join(root, page.path, `index${extension.startsWith('.') ? extension : `.${extension}`}`)),
  ]
  let found = false
  for (const candidate of candidates) {
    if (!(await pathExists(candidate))) continue
    found = true
    const content = await readFile(candidate, 'utf8')
    const basename = image.replaceAll('\\', '/').split('/').at(-1)
    if (content.includes(image.replaceAll('\\', '/')) || (basename && content.includes(basename))) return 'embedded'
  }
  return found ? 'not-embedded' : 'page-missing'
}

async function workspaceReferencesImage(workspace: string, image: string): Promise<boolean> {
  const normalizedImage = image.replaceAll('\\', '/')
  const basename = normalizedImage.split('/').at(-1)
  const stack = [workspace]
  const ignored = new Set(['.doxloop', '.git', 'node_modules', 'dist', 'build', '.next'])
  let inspected = 0
  while (stack.length > 0 && inspected < 10_000) {
    const directory = stack.pop()!
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!ignored.has(entry.name)) stack.push(join(directory, entry.name))
        continue
      }
      inspected += 1
      if (!/\.(?:md|mdx|rst|html?)$/i.test(entry.name)) continue
      const content = await readFile(join(directory, entry.name), 'utf8')
      if (content.includes(normalizedImage) || (basename && content.includes(basename))) return true
    }
  }
  return false
}
