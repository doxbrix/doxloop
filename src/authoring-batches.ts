/**
 * Batched authoring.
 *
 * One agent session that writes forty pages runs for 800 turns, and every
 * turn re-reads a context that has grown to 600k tokens: real runs spent
 * 99% of their tokens on cache reads and 45 minutes before a single defect
 * failed the whole run. Splitting the approved plan into short batches keeps
 * each session's context small, bounds the blast radius of a failure to one
 * batch, and lets Doxloop validate and repair between batches instead of
 * once at the end.
 */
import { preferredPageExtension } from './page-extension.js'
import type { DocumentationPlan, DocumentationPlanPage, ValidationIssue } from './types.js'

export interface AuthoringBatch {
  /** One-based position in the run. */
  index: number
  total: number
  pages: DocumentationPlanPage[]
  /** Planned screenshot captures across the batch's pages. */
  captures: number
}

export interface BatchOptions {
  /** Pages per batch; the last batch may be smaller. */
  maxPages?: number
  /** Planned captures per batch; a page never splits, so one page may exceed it. */
  maxCaptures?: number
}

export const DEFAULT_BATCH_PAGES = 4
export const DEFAULT_BATCH_CAPTURES = 18

/** Pages the run writes: approved, not deferred, created or updated. */
export function writablePlanPages(plan: Pick<DocumentationPlan, 'pages'>): DocumentationPlanPage[] {
  return plan.pages.filter((page) => page.priority !== 'later' && (page.action === 'create' || page.action === 'update'))
}

export function plannedCaptures(page: DocumentationPlanPage): number {
  if (!page.visuals || page.visuals.mode === 'none') return 0
  return Math.max(page.visuals.captureSequence?.length ?? 0, page.visuals.estimatedCaptures ?? 0, 1)
}

/** Batch size from the environment, for operators tuning a slow application. */
export function batchOptionsFromEnvironment(env: NodeJS.ProcessEnv = process.env): BatchOptions {
  const pages = Number(env.DOXLOOP_AUTHORING_BATCH_PAGES)
  const captures = Number(env.DOXLOOP_AUTHORING_BATCH_CAPTURES)
  return {
    maxPages: Number.isInteger(pages) && pages > 0 ? pages : DEFAULT_BATCH_PAGES,
    maxCaptures: Number.isInteger(captures) && captures > 0 ? captures : DEFAULT_BATCH_CAPTURES,
  }
}

/**
 * Split pages into batches in plan order, keeping navigation sections together
 * where the size allows: pages that share a section read each other's
 * terminology, so writing them in one session keeps them consistent.
 */
export function planAuthoringBatches(
  plan: Pick<DocumentationPlan, 'pages' | 'navigation'>,
  pages: DocumentationPlanPage[],
  options: BatchOptions = {},
): AuthoringBatch[] {
  const maxPages = Math.max(1, options.maxPages ?? DEFAULT_BATCH_PAGES)
  const maxCaptures = Math.max(1, options.maxCaptures ?? DEFAULT_BATCH_CAPTURES)
  if (pages.length === 0) return []
  // Order by navigation section first so a batch boundary falls between
  // sections rather than through one; pages in no section keep plan order.
  const sectionOrder = new Map<string, number>()
  for (const [index, section] of (plan.navigation?.sections ?? []).entries()) {
    for (const id of section.pageIds) if (!sectionOrder.has(id)) sectionOrder.set(id, index)
  }
  const planIndex = new Map(plan.pages.map((page, index) => [page.id, index]))
  const landing = (page: DocumentationPlanPage): boolean => /^(?:index|overview|home|start-here)$/i.test(page.path.split('/').pop() ?? '')
  const ordered = [...pages].sort((left, right) => {
    // The landing page goes first: it links to everything else and sets the tone.
    const landingDelta = Number(landing(right)) - Number(landing(left))
    if (landingDelta !== 0) return landingDelta
    const sectionDelta = (sectionOrder.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (sectionOrder.get(right.id) ?? Number.MAX_SAFE_INTEGER)
    if (sectionDelta !== 0) return sectionDelta
    return (planIndex.get(left.id) ?? 0) - (planIndex.get(right.id) ?? 0)
  })
  const groups: DocumentationPlanPage[][] = []
  let current: DocumentationPlanPage[] = []
  let currentCaptures = 0
  for (const page of ordered) {
    const captures = plannedCaptures(page)
    const overflow = current.length >= maxPages || (current.length > 0 && currentCaptures + captures > maxCaptures)
    if (overflow) {
      groups.push(current)
      current = []
      currentCaptures = 0
    }
    current.push(page)
    currentCaptures += captures
  }
  if (current.length > 0) groups.push(current)
  // A trailing batch of one page is a whole session for a single file; fold
  // it into the previous batch when that stays within the page limit + 1.
  if (groups.length > 1 && groups.at(-1)!.length === 1 && groups.at(-2)!.length <= maxPages) {
    const last = groups.pop()!
    groups.at(-1)!.push(...last)
  }
  return groups.map((group, index) => ({
    index: index + 1,
    total: groups.length,
    pages: group,
    captures: group.reduce((sum, page) => sum + plannedCaptures(page), 0),
  }))
}

/** Claude turn cap for one batch session. */
export function batchTurnBudget(batch: Pick<AuthoringBatch, 'pages' | 'captures'>, env: NodeJS.ProcessEnv = process.env): number {
  const override = Number(env.DOXLOOP_AGENT_MAX_TURNS)
  if (Number.isInteger(override) && override > 0) return override
  return Math.max(60, batch.pages.length * 30 + batch.captures * 12)
}

/** Turn cap for a targeted fix session over a few pages. */
export function fixTurnBudget(files: number, issues: number): number {
  return Math.max(30, 20 + files * 15 + issues * 4)
}

/** Wall-clock cap for one batch, so a stuck session cannot eat the run's budget. */
export function batchMinutes(batch: Pick<AuthoringBatch, 'pages' | 'captures'>): number {
  return Math.min(45, Math.max(10, batch.pages.length * 4 + batch.captures * 1.5))
}

export function describeBatchPage(page: DocumentationPlanPage): string {
  const parts = [`- ${page.path} — "${page.title}" (${page.type}, ${page.action})`]
  if (page.purpose) parts.push(`  purpose: ${page.purpose}`)
  const evidence = page.evidenceDetails?.length
    ? page.evidenceDetails.slice(0, 6).map((item) => {
        const detail = item as unknown as Record<string, unknown>
        const source = typeof detail.source === 'string' ? detail.source : ''
        const path = typeof detail.path === 'string' ? detail.path : ''
        const label = typeof detail.label === 'string' ? detail.label : ''
        return [source, path].filter(Boolean).join(': ') + (label ? ` (${label})` : '')
      }).filter(Boolean)
    : page.evidence?.slice(0, 6) ?? []
  if (evidence.length > 0) parts.push(`  evidence: ${evidence.join('; ')}`)
  const visuals = page.visuals
  if (visuals && visuals.mode !== 'none') {
    parts.push(`  screenshots: ${visuals.mode}, start at ${visuals.startPath ?? '/'}, ${plannedCaptures(page)} planned capture${plannedCaptures(page) === 1 ? '' : 's'}`)
  }
  if (page.diagram === 'required') parts.push('  diagram: required (Mermaid)')
  return parts.join('\n')
}

export const BATCH_SLICE_FILE = '.doxloop/cache/authoring-batch.json'

/**
 * The part of the plan one batch needs, written to a small file so the agent
 * reads six pages' worth of plan instead of the whole 90 KB document (which a
 * real run re-read, truncated, in every session).
 */
export function batchPlanSlice(plan: DocumentationPlan, batch: AuthoringBatch): Record<string, unknown> {
  const ids = new Set(batch.pages.map((page) => page.id))
  return {
    batch: batch.index,
    of: batch.total,
    planId: plan.id,
    productProfile: plan.productProfile,
    audiences: plan.audiences,
    terminology: plan.terminology,
    exclusions: plan.exclusions,
    styleGuide: plan.styleGuide,
    locale: plan.locale,
    accessibilityTarget: plan.accessibilityTarget,
    experienceLevel: plan.experienceLevel,
    preferredExamples: plan.preferredExamples,
    instructions: plan.instructions,
    navigation: {
      top: plan.navigation.top,
      sections: plan.navigation.sections
        .filter((section) => section.pageIds.some((id) => ids.has(id)))
        .map((section) => ({ ...section, pageIds: section.pageIds.filter((id) => ids.has(id)) })),
    },
    target: plan.target,
    // One extension for every new page: a writer that followed the first
    // entry of target.pageExtensions (".md" for Doxbrix) wrote 12 of 62
    // pages as .md while the rest were .mdx.
    pageExtension: preferredPageExtension(plan.target),
    pages: batch.pages,
    ...(plan.existingDocumentation
      ? {
          existingDocumentation: plan.existingDocumentation.map((assessment) => ({
            ...assessment,
            pages: (assessment as unknown as { pages?: Array<{ into?: string[] }> }).pages?.filter((entry) => (entry.into ?? []).some((id) => ids.has(id))) ?? [],
          })),
        }
      : {}),
  }
}

/**
 * The contract appended to the run's prompt for one batch: which pages to
 * write now, which already exist, which come later, and what Doxloop itself
 * takes care of so the agent does not spend turns on it.
 */
export interface BatchContractInput {
  batch: AuthoringBatch
  completed: DocumentationPlanPage[]
  upcoming: DocumentationPlanPage[]
  screenshots: boolean
  mode: 'create' | 'update'
  precaptured?: number
  /** Project-relative files Doxloop wrote for this batch. */
  artifacts?: { slice?: string; manifest?: string; evidence?: string; pack?: string }
  /** Other batch sessions run at the same time in this workspace. */
  concurrent?: boolean
  /** This session runs alone and may set up the site (theme, spaces) for the others. */
  exclusive?: boolean
  /** Skill references already included in the prompt, by name, so the writer does not read them again. */
  references?: string[]
  /** Frontmatter of the pages earlier batches wrote, for consistent titles and icons. */
  written?: Array<{ path: string; title?: string; icon?: string }>
  /** The extension every new page is saved with (`preferredPageExtension(plan.target)`). */
  pageExtension?: string
}

export function batchContract(input: BatchContractInput): string {
  const { batch } = input
  const artifacts = input.artifacts ?? {}
  const lines: string[] = []
  lines.push(`BATCH ${batch.index} OF ${batch.total}. This session writes only the pages listed under "Pages in this batch". Doxloop runs the other batches in separate sessions${input.concurrent ? ' (several at the same time in this workspace)' : ''}, validates the workspace after each one, and sends any defect back to a short follow-up session, so do not spend turns on anything outside this list.`)
  if (artifacts.pack) {
    lines.push('')
    lines.push(`Start from the evidence pack at ${artifacts.pack}: it holds the excerpts of every source file and existing-documentation page the plan cites for these pages. Write from the pack; open a full source file only for a claim the pack does not settle, and then read the specific lines you need.`)
  }
  if (artifacts.slice) {
    lines.push('')
    lines.push(`Read ${artifacts.slice} for this batch's full page entries (evidence, visuals, navigation section, terminology, style). Do not read .doxloop/documentation-plan.json, .doxloop/project.json, or the whole screenshot manifest: everything this batch needs from them is in the slice and in this prompt, and reading the full files costs more than writing a page.`)
  }
  lines.push('')
  lines.push('Read evidence economically: locate what you need with grep -n first, then read at most 120 lines at a time with sed -n; a larger read is truncated by the tool and the rest is lost, so it costs tokens and shows you nothing. Read each skill reference once per session, not once per page.')
  if (input.references && input.references.length > 0) {
    lines.push(`The skill references this batch needs are already in this prompt, above the task (${input.references.join(', ')}): do not open them or the skill files again. The only reference left to read is the type playbook for a page type in this batch (references/type-*.md), once.`)
  }
  lines.push(sourceSearchGuidance(batch.pages))
  lines.push('')
  lines.push('Pages in this batch (write each one completely, to the depth contract for its type):')
  lines.push(...batch.pages.map(describeBatchPage))
  lines.push(input.pageExtension
    ? `Save every new page as its path plus ${input.pageExtension} (for example ${batch.pages[0]?.path ?? 'guides/page'}${input.pageExtension}), whatever extension another file or evidence key shows; a page that already exists keeps its file name.`
    : `Save every new page as its path plus the extension named by pageExtension in the batch slice, whatever extension another file or evidence key shows; a page that already exists keeps its file name.`)
  lines.push('Write a new page as one whole-file add (a single operation that creates the file with its full content), and replace an existing page by rewriting the whole file rather than editing lines inside it: line-level hunks against long prose fail verification and cost a retry. Save each page with its own edit the moment it is complete, then move to the next one. Do not hold the pages back for one final edit at the end: a session that is stopped early keeps only the pages already saved, and Doxloop retries just the missing ones.')
  if (input.completed.length > 0) {
    lines.push('')
    lines.push(`Pages already written in earlier batches (link to them by their path; do not rewrite, reformat, or re-read them unless a link target needs checking): ${input.completed.map((page) => `/${page.path}`).join(', ')}`)
  }
  if (input.written && input.written.length > 0) {
    lines.push(`Their frontmatter, so yours matches without opening them: ${input.written.map((page) => `${page.path} (title "${page.title ?? ''}"${page.icon ? `, icon ${page.icon}` : ''})`).join('; ')}. Do not list or grep the workspace to check conventions.`)
  }
  if (input.upcoming.length > 0) {
    lines.push('')
    lines.push(`Pages that other batches write${input.concurrent ? ', some of them right now' : ' later'} (link to these planned paths where a reader needs them; do not create or edit them): ${input.upcoming.map((page) => `/${page.path} ("${page.title}")`).join(', ')}`)
  }
  lines.push('')
  const evidenceTarget = artifacts.evidence ?? '.doxloop/evidence-map.json'
  if (artifacts.evidence) lines.push(`${artifacts.evidence} already holds an entry per page of this batch, keyed by the page file and seeded from the plan's citations: add the claims worth re-checking and any further source paths you actually read, keep the schema, and do not read the main evidence map or other batches' evidence files.`)
  lines.push(`Doxloop does the bookkeeping for you after this session: it adds missing frontmatter title/description from the plan, adds pages to the navigation, repairs local links whose target it can identify, seeds the evidence map for each page, and validates everything. So: do not run \`doxloop test\`, node, or python; do not count files, list directories to check your work, validate JSON, or grep for unclosed tags; do not write a completion report longer than three sentences. Record each page's evidence sources and claims in ${evidenceTarget} (same schema as the evidence map: a pages object keyed by project-relative page file)${artifacts.evidence ? '; Doxloop merges it into .doxloop/evidence-map.json, which you must not edit yourself in this session' : ''}.`)
  if (input.exclusive) {
    lines.push('Put each page in the navigation group the plan names when you can; Doxloop fills any gap.')
  } else {
    lines.push('Do not edit the navigation or site configuration (docs.json or its equivalent) in this session: other sessions may be saving it at the same time, and Doxloop adds every page of this batch to the navigation group the plan names as soon as the session ends.')
  }
  if (input.screenshots) {
    const captured = input.precaptured ?? 0
    const manifest = artifacts.manifest
    lines.push('')
    lines.push(`Screenshots for this batch: ${manifest ? `${manifest} lists this batch's approved guides and steps (a slice of the main manifest). Read its saved image paths, observed labels and state descriptions; do not edit it or the main manifest.` : 'the manifest .doxloop/screenshot-manifest.json already lists every approved guide and step.'}${captured > 0 ? ` Doxloop has already captured ${captured} entry-screen step${captured === 1 ? '' : 's'} for these pages (status verified with a file): keep those rows and embed those images.` : ''} Choose and embed the saved images that illustrate these pages, using their recorded state and alt text. Browser capture is a separate stage: never navigate, capture, or change capture status while writing. Leave missing states for Doxloop to report.`)
  }
  if (input.mode === 'create' && batch.index === 1 && input.exclusive) {
    lines.push('')
    lines.push('This is the first batch of a new documentation set and it runs alone: also configure the generator theme and site identity from public brand evidence in the sources (name, logo, colors, fonts) and make sure the navigation spaces and groups the plan names exist in the generator configuration so the other batches can slot pages into them.')
  }
  return lines.join('\n')
}

/**
 * Concurrent batch sessions, from the environment; 1 runs batches one after
 * another. A run's wall time is almost entirely model time (a measured run:
 * 43 min model, 1 min tools), so concurrency is the only lever on it, and it
 * spends no extra tokens: each batch costs the same whether or not another
 * is running.
 */
export function parallelismFromEnvironment(env: NodeJS.ProcessEnv = process.env): number {
  const value = Number(env.DOXLOOP_AUTHORING_PARALLEL)
  if (Number.isInteger(value) && value >= 1) return Math.min(value, 6)
  return DEFAULT_PARALLEL_BATCHES
}
/**
 * Two, not three: with three Codex sessions in flight a real run saw all
 * three model streams hang at the same second and lose their whole batch.
 */
export const DEFAULT_PARALLEL_BATCHES = 2

/** How often the inactivity watchdog checks a session's output. */
export const AGENT_IDLE_CHECK_MS = 15_000
/**
 * Default quiet time before a session is stopped and retried. Long enough for
 * a writer to think and then emit four pages in one edit (measured under five
 * minutes), short enough that a hung model stream costs minutes, not a cap.
 */
export const DEFAULT_AGENT_IDLE_MINUTES = 6

/**
 * Quiet time after which a session is stopped, in milliseconds; 0 disables
 * the watchdog. `DOXLOOP_AGENT_IDLE_MINUTES` overrides the default.
 */
export function agentIdleLimitMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.DOXLOOP_AGENT_IDLE_MINUTES
  if (raw !== undefined && raw.trim() !== '') {
    const value = Number(raw)
    if (Number.isFinite(value) && value >= 0) return Math.round(value * 60_000)
  }
  return DEFAULT_AGENT_IDLE_MINUTES * 60_000
}

export function formatIdleMinutes(ms: number): string {
  const minutes = Math.round(ms / 6_000) / 10
  return `${minutes} minute${minutes === 1 ? '' : 's'}`
}

/**
 * Whether a batch has to run before the others start: the landing page links
 * to every section, and a new site's theme and spaces must exist before
 * concurrent sessions try to use them.
 */
export function batchNeedsExclusiveStart(batch: AuthoringBatch, mode: 'create' | 'update'): boolean {
  if (mode === 'create' && batch.index === 1) return true
  return batch.pages.some((page) => /^(?:index|overview|home|start-here)$/i.test(page.path.split('/').pop() ?? ''))
}

/** Split issues into fix-session chunks of at most `maxFiles` files each. */
export function chunkIssuesByFile(issues: ValidationIssue[], maxFiles: number): ValidationIssue[][] {
  const byFile = new Map<string, ValidationIssue[]>()
  for (const issue of issues) {
    const key = issue.file ?? '(project)'
    byFile.set(key, [...(byFile.get(key) ?? []), issue])
  }
  const chunks: ValidationIssue[][] = []
  let current: ValidationIssue[] = []
  let files = 0
  for (const group of byFile.values()) {
    if (files >= Math.max(1, maxFiles)) {
      chunks.push(current)
      current = []
      files = 0
    }
    current.push(...group)
    files += 1
  }
  if (current.length > 0) chunks.push(current)
  return chunks
}

/**
 * The follow-up prompt for defects Doxloop found in a batch. Each issue names
 * its file, so the agent can go straight to the fix.
 */
export function fixContract(input: {
  issues: ValidationIssue[]
  files: string[]
  round: number
  maxRounds: number
}): string {
  const byFile = new Map<string, ValidationIssue[]>()
  for (const issue of input.issues) {
    const key = issue.file ?? '(project)'
    byFile.set(key, [...(byFile.get(key) ?? []), issue])
  }
  const sections = [...byFile.entries()].map(([file, issues]) => `${file}:\n${issues.map((issue) => `  - ${issue.severity} ${issue.code}: ${issue.message}`).join('\n')}`)
  const depth = input.issues.some((issue) => issue.code === 'thin-page' || issue.code === 'thin-procedure')
  return `FIX ROUND ${input.round} OF ${input.maxRounds}. Doxloop validated the pages this run wrote and found the problems below. Fix exactly these problems in exactly these files and nothing else; do not rewrite passages that are not named, do not touch other pages, and do not run validation yourself — Doxloop re-validates the moment you finish. Do not re-read the skill, the plan, or the project configuration for this: ${depth ? 'read only the authoring skill\'s references/page-depth.md for the depth contract, then the named pages and the evidence they cite' : 'read only the named pages and the evidence they cite'}. A thin-page or thin-procedure warning means the page is missing parts of the depth contract (outcome-led opening, prerequisites, every step with its observable result, verification, evidence-backed troubleshooting, next step): add only the missing parts, written for this page's own task from the evidence it cites. If every part is already present and the evidence offers nothing more, leave the page unchanged and say so in your reply: never pad with generic advice, testing tips, restated steps, repeated cautions, or fixture details from the capture application, because a short accurate page beats a long padded one and the warning is then accepted as is. A broken-link error names a target that does not exist: point the link at the real page path or remove it. When you finish, reply with one sentence per file saying what changed.

Files: ${input.files.join(', ')}

${sections.join('\n\n')}`
}

/** Validation issues that belong to the given page files, errors first. */
export function issuesForFiles(issues: ValidationIssue[], files: Set<string>, options: { includeWarnings?: boolean } = {}): ValidationIssue[] {
  // The post-pass may rename a page from .md to .mdx after the batch's file
  // list was taken; the page is the same one.
  const stem = (file: string): string => file.replace(/\.mdx?$/i, '')
  const stems = new Set([...files].map(stem))
  const relevant = issues.filter((issue) => {
    if (!issue.file || !(files.has(issue.file) || stems.has(stem(issue.file)))) return false
    if (issue.severity === 'error') return true
    return options.includeWarnings === true && FIXABLE_WARNINGS.has(issue.code)
  })
  return relevant.sort((left, right) => Number(right.severity === 'error') - Number(left.severity === 'error'))
}

/** Warnings worth a fix session: they are the depth contract the writer owes, not taste. */
export const FIXABLE_WARNINGS = new Set(['thin-page', 'thin-procedure', 'missing-diagram', 'api-endpoint-param-example'])

const SUGGESTION_LABELS: Record<string, string> = {
  'thin-page': 'thin pages',
  'thin-procedure': 'procedures missing parts',
  'missing-diagram': 'missing diagrams',
  'api-endpoint-param-example': 'missing parameter examples',
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

/**
 * How a set of validation issues reads in the run log. Errors block the
 * proposal; the fixable warnings are suggestions, and calling 204 missing
 * parameter examples "204 issues" right after every batch "passed" read as
 * a run that had gone wrong.
 */
export function describeIssues(issues: ValidationIssue[]): string {
  const errors = issues.filter((issue) => issue.severity === 'error').length
  const suggestions = issues.length - errors
  const pages = new Set(issues.map((issue) => issue.file ?? '(project)')).size
  const kinds = [...new Set(issues.filter((issue) => issue.severity !== 'error').map((issue) => SUGGESTION_LABELS[issue.code] ?? issue.code))]
  const parts = [
    ...(errors > 0 ? [plural(errors, 'error')] : []),
    ...(suggestions > 0 ? [`${plural(suggestions, errors > 0 ? 'suggestion' : 'minor suggestion')}${kinds.length > 0 ? ` (${kinds.join(', ')})` : ''}`] : []),
  ]
  return `${parts.join(' and ')} in ${plural(pages, 'page')}`
}

/** The line that opens the end-of-run pass: "Final polish" when nothing blocks the proposal. */
export function finalCheckAnnouncement(issues: ValidationIssue[], sessions: number, parallel: number): string {
  const blocking = issues.some((issue) => issue.severity === 'error')
  const concurrency = sessions > 1 && parallel > 1 ? `, up to ${Math.min(parallel, sessions)} at a time` : ''
  return `${blocking ? 'Final check' : 'Final polish'}: ${describeIssues(issues)}; fixing in ${plural(sessions, 'session')}${concurrency}.`
}

/**
 * What a batch's fix round works on. The batch and the end-of-run pass
 * validate with the same rules: errors always go to a fix session, and the
 * fixable warnings ride along with them, because the session is already open
 * on those pages. A batch with warnings alone passes and leaves them for the
 * one consolidated polish at the end, where they used to arrive unannounced
 * (204 of them after sixteen batches that had all "passed").
 */
export function splitBatchIssues(issues: ValidationIssue[]): { fix: ValidationIssue[]; deferred: ValidationIssue[] } {
  const hasErrors = issues.some((issue) => issue.severity === 'error')
  return hasErrors ? { fix: issues, deferred: [] } : { fix: [], deferred: issues }
}

/**
 * A batch's result line. A batch passes on errors alone; its fixable
 * warnings are counted here so the end-of-run polish is no surprise.
 */
export function batchPassLine(label: string, pageCount: number, deferred: ValidationIssue[]): string {
  const suggestions = deferred.filter((issue) => issue.severity !== 'error')
  const tail = suggestions.length > 0 ? ` (${plural(suggestions.length, 'minor suggestion')} left for the final polish)` : ''
  return `${label}: ${plural(pageCount, 'page')} pass${pageCount === 1 ? 'es' : ''} validation${tail}.`
}

/** Codes Doxloop repairs itself between batches; a fix session never needs them. */
export const REPAIRED_BY_POSTPASS = new Set(['missing-title', 'missing-description', 'unnavigated-page', 'code-language'])

/**
 * A "broken link" whose target is a planned page another batch has not
 * written yet is not a defect: the contract tells the writer to link to
 * those paths, and the end-of-run check sees them once every batch is done.
 * A per-batch fix session given such an issue removes the cross-link, which
 * costs a session and loses the link for good.
 */
export function isForwardLinkIssue(issue: ValidationIssue, pendingPaths: Iterable<string>): boolean {
  if (issue.code !== 'broken-link') return false
  const target = /:\s*(\S+)\s*$/.exec(issue.message)?.[1]
  if (!target) return false
  const normalized = normalizeLinkPath(target)
  if (!normalized) return false
  for (const path of pendingPaths) {
    const planned = normalizeLinkPath(path)
    if (planned && (normalized === planned || normalized.endsWith(`/${planned}`))) return true
  }
  return false
}

function normalizeLinkPath(value: string): string {
  return value
    .split(/[?#]/)[0]!
    .replace(/^\.?\//, '')
    .replace(/\/+$/, '')
    .replace(/\.(mdx?|rst|html?)$/i, '')
    .replace(/\/index$/, '')
    .replace(/^\/+/, '')
}

/**
 * Where the writer should look, and where it should not. Search results from
 * tests, fixtures, generated bundles, migrations and lockfiles are the bulk
 * of what a broad grep over a product repository returns, and every hit the
 * agent reads is paid for in context. The batch's own citations name the
 * directories that matter.
 */
export const SOURCE_NOISE_DIRECTORIES = ['node_modules', 'dist', 'build', 'out', 'vendor', 'coverage', 'target', '.git', '__snapshots__', 'testdata', 'fixtures', 'migrations', 'migration', 'swagger', 'openapi', 'locales', 'i18n/lang', 'e2e', 'cypress', '__tests__', 'test', 'tests', 'mocks', '__mocks__', 'generated', 'gen', 'proto-gen', 'public/emojis']
export const SOURCE_NOISE_FILES = ['*_test.go', '*.test.*', '*.spec.*', '*.min.js', '*.standalone.js', '*.map', '*.lock', '*-lock.*', '*.snap', '*.pb.go', '*.generated.*', 'CHANGELOG*']

export function sourceSearchGuidance(pages: DocumentationPlanPage[]): string {
  const directories = new Set<string>()
  for (const page of pages) {
    for (const detail of page.evidenceDetails ?? []) {
      if (!detail?.path) continue
      const parts = detail.path.split('/').filter(Boolean)
      if (parts.length > 1) directories.add(`${detail.source}: ${parts.slice(0, Math.min(2, parts.length - 1)).join('/')}`)
    }
  }
  const excludeDirs = SOURCE_NOISE_DIRECTORIES.filter((entry) => !entry.includes('/')).map((entry) => `--exclude-dir=${entry}`).join(' ')
  const excludeFiles = SOURCE_NOISE_FILES.map((entry) => `--exclude='${entry}'`).join(' ')
  const lines = [
    `When the pack does not settle a claim, search the source narrowly. Grep only the directory the citation points at${directories.size > 0 ? ` (this batch's evidence lives under ${[...directories].slice(0, 6).join(', ')})` : ''}, never a whole repository, and exclude what is not product behaviour: ${excludeDirs} ${excludeFiles}. Tests, fixtures, migrations, generated API bundles, translation files for other languages, minified vendor scripts and changelogs are not evidence for a how-to page; open a test only for a concrete example the pack lacks.`,
    'Read the label catalog (the English UI strings file) through the values quoted in the pack or with grep -n for one key; never cat it.',
  ]
  return lines.join(' ')
}

/** Guides per capture session; the browser signs in once per session. */
export const DEFAULT_CAPTURE_GUIDES_PER_SESSION = 3
export const DEFAULT_CAPTURE_STEPS_PER_SESSION = 8

/**
 * Group guides that still need captures into sessions: a few guides each,
 * bounded by their planned steps so one session never drives a long tour,
 * in plan order so a session's guides are neighbours in the product.
 */
export function captureSessionGroups<T extends { guide: { steps: Array<{ status: string }> } }>(
  pending: readonly T[],
  env: NodeJS.ProcessEnv = process.env,
): T[][] {
  const guides = Number(env.DOXLOOP_CAPTURE_GUIDES_PER_SESSION)
  const maxGuides = Number.isInteger(guides) && guides > 0 ? guides : DEFAULT_CAPTURE_GUIDES_PER_SESSION
  const groups: T[][] = []
  let current: T[] = []
  let steps = 0
  for (const item of pending) {
    const own = item.guide.steps.filter((step) => step.status !== 'verified').length
    if (current.length > 0 && (current.length >= maxGuides || steps + own > DEFAULT_CAPTURE_STEPS_PER_SESSION)) {
      groups.push(current)
      current = []
      steps = 0
    }
    current.push(item)
    steps += own
  }
  if (current.length > 0) groups.push(current)
  return groups
}

