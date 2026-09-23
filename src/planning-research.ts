import { budgetContext, isAccountLimit } from './usage-budget.js'
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { readTaggedJson, type TaggedJsonContract } from './agent-reply.js'
import { captureAuthPrompt } from './author.js'
import { runPool } from './batch-artifacts.js'
import type { CaptureAuthMode } from './capture-auth.js'
import { readDocsSiteManifest } from './docs-site.js'
import { DoxloopError } from './errors.js'
import { normalizeScreenshotIntent } from './screenshot-workflow.js'
import { discoveryGuidance, formatDiscoveryInventory, type DocumentationDiscoveryInventory } from './source-discovery.js'
import type { AgentName, DocumentationPlan, DocumentationPlanResearch, DoxloopProject, SourceBinding } from './types.js'

/**
 * Planning research: the reading, browsing, and auditing that used to happen
 * inside one long planning session now runs as short sessions, several at a
 * time, each returning a compact brief. A separate synthesis session writes
 * the plan from the briefs. Every brief is checkpointed under the plan, so a
 * failed or retried plan repeats only the work that is missing.
 */

export const DEFAULT_PLANNING_PARALLEL = 2
/** Crawled pages one existing-documentation research session reads. */
export const EXISTING_DOCS_SHARD_PAGES = 20
const RESEARCH_DIRECTORY = 'research'

export type ResearchKind = 'product' | 'application' | 'existing-docs'

export interface ResearchShard {
  source: string
  /** Snapshot directory, relative to the project root as configured. */
  snapshotPath: string
  pages: Array<{ file: string; title: string; words: number }>
  index: number
  total: number
}

export interface ResearchTask {
  id: string
  kind: ResearchKind
  label: string
  /** Whether the session needs the capture browser. */
  browser: boolean
  shard?: ResearchShard
  /** Existing pages a page-scoped update names; the product audit reads only the surface behind them. */
  focus?: string[]
}

export interface ResearchBrief {
  task: string
  kind: ResearchKind
  label: string
  content: unknown
}

export interface ResearchCheckpoint extends ResearchBrief {
  key: string
  repairs?: string[]
  savedAt: string
}

/** Staged planning is on unless `DOXLOOP_PLANNING_STAGED` turns it off. */
export function stagedPlanningEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.DOXLOOP_PLANNING_STAGED?.trim().toLowerCase()
  return !(raw === '0' || raw === 'false' || raw === 'off' || raw === 'no')
}

/** How many research sessions run at once (`DOXLOOP_PLANNING_PARALLEL`, default 3). */
export function planningParallelism(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.DOXLOOP_PLANNING_PARALLEL?.trim()
  if (raw) {
    const parsed = Number(raw)
    if (Number.isFinite(parsed) && parsed >= 1) return Math.floor(parsed)
  }
  return DEFAULT_PLANNING_PARALLEL
}

function docsSiteSources(sources: SourceBinding[]): SourceBinding[] {
  return sources.filter((source) => (source.kind ?? 'directory') === 'docs-site')
}

/**
 * Which research sessions this plan needs: one product-surface audit when
 * code or specification sources are configured, one application exploration
 * when screenshots are wanted and an application is configured, and one
 * existing-documentation audit per shard of crawled pages. The plan's
 * research scope (see planning-triage) narrows that: a navigation-only
 * update researches nothing, and a page-scoped update audits only the
 * product surface behind the named pages, exploring the application only
 * when screenshots are required.
 */
export async function researchTasks(
  root: string,
  project: Pick<DoxloopProject, 'sources' | 'application'>,
  current: Pick<DocumentationPlan, 'execution' | 'research'>,
): Promise<ResearchTask[]> {
  const tasks: ResearchTask[] = []
  const scope = current.research?.scope ?? 'product'
  if (scope === 'navigation') return tasks
  const productSources = project.sources.filter((source) => (source.kind ?? 'directory') !== 'docs-site')
  if (productSources.length > 0) {
    const focus = scope === 'pages' ? [...(current.research?.pages ?? [])].sort() : undefined
    tasks.push({
      id: 'product',
      kind: 'product',
      label: focus ? `Auditing the product surface behind ${focus.length} page${focus.length === 1 ? '' : 's'}` : 'Auditing the product surface',
      browser: false,
      ...(focus ? { focus } : {}),
    })
  }
  const screenshots = normalizeScreenshotIntent(current.execution.screenshots)
  if (project.application && (scope === 'pages' ? screenshots === 'enabled' : screenshots !== 'disabled')) {
    tasks.push({ id: 'application', kind: 'application', label: 'Exploring the live application', browser: true })
  }
  if (scope === 'pages') return tasks
  for (const source of docsSiteSources(project.sources)) {
    const manifest = await readDocsSiteManifest(root, source)
    const pages = manifest.pages.map((page) => ({ file: page.file, title: page.title, words: page.words }))
    const total = Math.max(1, Math.ceil(pages.length / EXISTING_DOCS_SHARD_PAGES))
    for (let index = 0; index < total; index += 1) {
      const slice = pages.slice(index * EXISTING_DOCS_SHARD_PAGES, (index + 1) * EXISTING_DOCS_SHARD_PAGES)
      if (slice.length === 0) continue
      const suffix = total === 1 ? '' : ` (${index + 1} of ${total})`
      tasks.push({
        id: total === 1 ? `existing-docs-${slug(source.name)}` : `existing-docs-${slug(source.name)}-${index + 1}`,
        kind: 'existing-docs',
        label: `Auditing the existing documentation "${source.name}"${suffix}`,
        browser: false,
        shard: { source: source.name, snapshotPath: source.path, pages: slice, index: index + 1, total },
      })
    }
  }
  return tasks
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'source'
}

export interface ResearchPromptContext {
  captureDirectory?: string
  project: DoxloopProject
  current: Pick<DocumentationPlan, 'request' | 'mode' | 'scope' | 'execution'>
  discovery: DocumentationDiscoveryInventory
  /** Deterministic source-change summary. */
  changes: string
  captureAuth: CaptureAuthMode
}

/** Browser calls one application research session may spend; a session without a budget made a hundred. */
export const APPLICATION_BROWSER_CALLS = 30

const EVIDENCE_SHAPE = '{ "source": "configured source name", "path": "source-relative path", "kind": "discovery kind", "label": "symbol, route, operation, or file", "line": 1 }'

function preamble(task: ResearchTask, context: ResearchPromptContext): string {
  return `You are one research session of Doxloop's planning stage. Doxloop runs several research sessions at once, and a separate session writes the documentation plan from their briefs; you do not write the plan, decide pages, or author documentation. Do not edit source or documentation files; the application task may save screenshot assets. Do not read the skill files under .agents/skills or .claude/skills: they guide authoring, and this brief is complete for your task.

Research task "${task.id}": ${task.label}.

Project configuration (compact JSON):
${JSON.stringify(context.project)}

Planning request this research serves (${context.current.mode}, ${context.current.scope} scope):
${context.current.request || 'Use the configured evidence and documentation brief to recommend the right documentation.'}
`
}

function ending(task: ResearchTask): string {
  return `
End your reply with exactly one machine-readable block and put nothing after it. Do not use Markdown fences inside the block, and never emit this block around an example or a file you read:
<doxloop-brief>
{ the single JSON object described above }
</doxloop-brief>
The block holds one complete top-level object for research task "${task.id}": close every bracket you open, and make the object's own closing brace the last character before </doxloop-brief>. Keep string values short and factual; the brief is read by another session, not by readers.`
}

export function researchPrompt(task: ResearchTask, context: ResearchPromptContext): string {
  if (task.kind === 'product') return productPrompt(task, context)
  if (task.kind === 'application') return applicationPrompt(task, context)
  return existingDocsPrompt(task, context)
}

function productPrompt(task: ResearchTask, context: ResearchPromptContext): string {
  if (task.focus && task.focus.length > 0) return focusedProductPrompt(task, task.focus, context)
  return `${preamble(task, context)}
Audit the complete public product surface from the configured sources: package metadata and entry points; exported APIs, commands, routes, and configuration; installation and prerequisites; authentication and permissions; primary and advanced workflows; examples, tests, and integrations; errors, limits, recovery paths, and operational concerns. Use the deterministic inventory below as your map and read the files it points to; read a file once and grep before reading. Quote displayed UI strings from the label catalogs, never translation keys. Report only evidence-supported behavior and list everything you could not confirm under "unknowns". Every capability that deserves its own page must appear; a mid-sized product usually yields 15–60 capabilities.
Evidence is what the writers start from, so make it precise: cite two to four entries per capability, each with the "line" of the symbol, route, handler, or option you read (grep -n gives it), and lead with the file that implements the behaviour (component, view, route, handler, command, config schema). Cite the UI label catalog only as a supplement, with the dotted key path as the label (for example "task.repeat.everyDay"), never a quoted fragment of the file. Put the concrete behaviour you confirmed — steps, options, defaults, limits, error texts — in "summary" and "notes"; a writer who never opens the source should be able to write the page from them.

Deterministic source discovery (trusted inventory produced by Doxloop):
${formatDiscoveryInventory(context.discovery)}
${discoveryGuidance(context.discovery)}
Deterministic source-change summary:
${context.changes}

The JSON object must use this shape:
{
  "productProfile": "short evidence-grounded product classification",
  "audiences": ["specific reader groups the evidence supports"],
  "entryPoints": [{ "how": "how readers install, run, or access the product", "evidence": [${EVIDENCE_SHAPE}] }],
  "capabilities": [{
    "id": "stable-kebab-id",
    "title": "public capability or reader workflow",
    "kind": "workflow | api | command | configuration | concept | operation",
    "summary": "one or two sentences: what a reader does with it and what happens",
    "audience": "who needs it",
    "evidence": [${EVIDENCE_SHAPE}],
    "notes": "prerequisites, limits, errors, and related capabilities worth documenting"
  }],
  "configuration": [{ "name": "setting, flag, or variable", "purpose": "what it controls", "evidence": [${EVIDENCE_SHAPE}] }],
  "authentication": { "summary": "how users and API clients authenticate and what permissions exist", "evidence": [${EVIDENCE_SHAPE}] },
  "integrations": [{ "name": "external system or protocol", "summary": "what it does", "evidence": [${EVIDENCE_SHAPE}] }],
  "operations": ["deployment, backup, upgrade, monitoring, or maintenance facts with evidence paths"],
  "errors": ["user-facing error conditions and recovery paths with evidence paths"],
  "terminology": { "product term": "meaning or preferred usage" },
  "unknowns": ["what the sources do not show or you could not confirm"]
}
${ending(task)}`
}

function applicationPrompt(task: ResearchTask, context: ResearchPromptContext): string {
  const application = context.project.application!
  return `${preamble(task, context)}
Explore the live application read-only so the plan can promise only screenshots of states that actually exist. Doxloop supplies the purpose-built doxloop_capture MCP browser for this session. It is the capture connector required by this task and must take precedence over any generic in-app Browser plugin, Chrome extension, or node_repl browser mechanism. Call the doxloop_capture navigation and snapshot tools directly; do not use failure of another browser mechanism as evidence that Doxloop capture is unavailable. Save a PNG immediately for every distinct useful state you actually reach, using the screenshot tool, before leaving it. Save every image with the screenshot tool's filename parameter set to the absolute path ${context.captureDirectory ?? '.doxloop/capture-output/planning'}/<stable-kebab-id>.png (a bare filename is written somewhere else and is lost to the plan); record that same <stable-kebab-id>.png as the capture's "file". Reuse a capture if the screen is unchanged. Review privacy, legibility, and the expected state before marking its checks true; never claim an unvisited state was captured. Never create, change, or delete data; open dialogs, tabs, drawers, and forms, fill forms only with safe example values, and cancel instead of submitting anything that would persist.

- Application capture surface: ${application.baseUrl}
- User-provided default starting route: ${application.screenshots?.startPath ?? 'not provided'}
- User-provided capture workflow: ${application.screenshots?.workflow ?? 'not provided'}
- Sign-in handling: ${captureAuthPrompt(context.captureAuth)}

Explore with a fixed budget: at most ${APPLICATION_BROWSER_CALLS} navigation/interaction/snapshot calls and ${APPLICATION_BROWSER_CALLS} screenshot calls in total, at most one snapshot per distinct screen, and never a second snapshot of a screen you already recorded. Starting from the default route, visit each top-level navigation destination once, then open only the dialogs, tabs, drawers, and forms a reader would use on the most important screens; a snapshot's accessibility tree already lists the controls a screen offers, so record those as states instead of opening each one. For each screen, record its route, what is visible (quote the displayed labels), the states a reader can open from it without changing data, safe example values for its forms, and the reader workflows it would illustrate. Record routes you tried that were unreachable and why. Stop when the budget is spent or every navigation entry is recorded, whichever comes first.

The JSON object must use this shape:
{
  "baseUrl": "${application.baseUrl}",
  "signIn": { "required": true, "reached": true, "route": "/login", "notes": "how the signed-in state was obtained, or why it was not" },
  "fixtures": "what sample data exists and is safe to show",
  "screens": [{
    "route": "/application-relative/route",
    "name": "screen name as displayed",
    "reachedFrom": "navigation label or action that opens it",
    "visible": "what is on screen, with displayed labels quoted",
    "captures": [{ "id": "stable-kebab-id", "file": "filename.png", "action": "action that reached this screen", "state": "exact visible state", "alt": "reader-facing image description", "checks": { "expectedStateConfirmed": true, "privacyReviewed": true, "legibilityReviewed": true, "meaningful": true } }],
    "states": ["dialogs, drawers, tabs, expanded sections, and forms reachable here without changing data, one per entry"],
    "safeValues": ["safe example values for forms on this screen"],
    "workflows": ["reader workflows this screen illustrates"]
  }],
  "unreachable": [{ "route": "/route", "why": "what happened" }],
  "notes": "anything the plan must know to capture reliably (timing, permissions, layout quirks)"
}
${ending(task)}`
}

/**
 * The product audit for a page-scoped update: only the capabilities behind
 * the pages the request names, with the same evidence contract, so the
 * writers still start from line-numbered citations.
 */
function focusedProductPrompt(task: ResearchTask, focus: readonly string[], context: ResearchPromptContext): string {
  return `${preamble(task, context)}
This update concerns only these existing documentation pages:
${focus.map((page) => `- ${page}`).join('\n')}
Read those pages first to learn what they cover, then audit only the product surface behind them in the configured sources: the commands, routes, options, screens, permissions, errors, and limits those pages describe or should describe. Do not audit the rest of the product; a capability that no listed page covers belongs in the brief only when the request cannot be satisfied without it, and then say so under "notes". Use the deterministic inventory below as your map and read the files it points to; read a file once and grep before reading. Quote displayed UI strings from the label catalogs, never translation keys. Report only evidence-supported behavior and list everything you could not confirm under "unknowns". Expect one to eight capabilities.
Evidence is what the writers start from, so make it precise: cite two to four entries per capability, each with the "line" of the symbol, route, handler, or option you read (grep -n gives it), and lead with the file that implements the behaviour; a label catalog entry only supplements it.

Deterministic source discovery (trusted inventory produced by Doxloop):
${formatDiscoveryInventory(context.discovery)}
${discoveryGuidance(context.discovery)}
Deterministic source-change summary:
${context.changes}

The JSON object must use this shape:
{
  "productProfile": "one sentence",
  "capabilities": [{
    "id": "kebab-case id",
    "title": "capability title",
    "kind": "workflow | reference | concept | setup | integration | operations",
    "audience": ["who needs it"],
    "summary": "what it does and why a reader would use it",
    "pages": ["the listed pages it concerns"],
    "evidence": [${EVIDENCE_SHAPE}],
    "labels": ["exact UI strings from the label catalog, when a screen is involved"],
    "limits": ["limits, defaults, and irreversible actions"]
  }],
  "errors": [{ "message": "exact error text", "cause": "why it happens", "recovery": "what the reader does", "evidence": [${EVIDENCE_SHAPE}] }],
  "terminology": { "term": "definition" },
  "notes": "what the listed pages need that the sources do not show, or a capability outside them the request requires",
  "unknowns": ["what the sources do not show or you could not confirm"]
}
${ending(task)}`
}

function existingDocsPrompt(task: ResearchTask, context: ResearchPromptContext): string {
  const shard = task.shard!
  const productSources = context.project.sources.filter((source) => (source.kind ?? 'directory') !== 'docs-site')
  const pageLines = shard.pages.map((page) => `- ${page.file} — "${page.title}" (${page.words} words)`).join('\n')
  const shardNote = shard.total > 1 ? ` This is shard ${shard.index} of ${shard.total}; other sessions audit the other pages, so judge only the pages listed here and name duplicates outside the list only when you notice them.` : ''
  const factRule = productSources.length > 0
    ? `Product sources (${productSources.map((source) => `"${source.name}"`).join(', ')}) are the truth for facts, but this session does not read them: list every claim that must be verified against them under "suspectClaims", and every piece of knowledge the code is unlikely to show under "uniqueKnowledge".`
    : 'No product code or API specification is configured, so these pages are the only product evidence: record what each teaches so the plan can restructure and rewrite it.'
  return `${preamble(task, context)}
Audit the existing documentation being rewritten. Read every page listed below fully; the read-only Markdown snapshot lives at ${shard.snapshotPath} (page files under its pages/ directory, each with its original URL in frontmatter).${shardNote} Judge accuracy, structure, depth, duplication, terminology, and reader journeys. ${factRule}

Pages to audit (source "${shard.source}"):
${pageLines}

The JSON object must use this shape:
{
  "source": "${shard.source}",
  "pages": [{
    "path": "pages/existing-page.md",
    "title": "page title",
    "topic": "what the page is about, in a few words",
    "summary": "one or two sentences: what the page teaches and who it serves",
    "quality": "keep | rewrite | thin | obsolete | duplicate",
    "duplicateOf": "pages/other-page.md or omit",
    "issues": ["specific problems: outdated claims, gaps, confusing structure"],
    "uniqueKnowledge": ["facts, procedures, or rationale the product sources are unlikely to show; worth carrying over"],
    "suspectClaims": ["claims to verify against the product sources before reuse"]
  }],
  "strengths": ["what these pages do well and the rewrite should keep"],
  "findings": [{ "severity": "blocker | major | minor", "title": "short problem title", "description": "evidence-based problem across these pages", "pages": ["pages/existing-page.md"] }]
}
${ending(task)}`
}

const BRIEF_KEYS: Record<ResearchKind, string> = { product: 'capabilities', application: 'screens', 'existing-docs': 'pages' }

function briefContract(task: ResearchTask): TaggedJsonContract {
  const key = BRIEF_KEYS[task.kind]
  return {
    tag: 'doxloop-brief',
    accept: (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value) && Array.isArray((value as Record<string, unknown>)[key]),
    attempted: (text) => new RegExp(`"${key}"\\s*:`).test(text),
    noun: `research brief`,
  }
}

/** The brief a research session returned, or the reason it could not be read. */
export function readBriefOutput(raw: string, agent: AgentName, task: ResearchTask, prompt?: string): { content: unknown; repairs: string[] } {
  let reply
  try {
    reply = readTaggedJson(raw, agent, briefContract(task), prompt)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new DoxloopError(`Research session "${task.id}" returned an unreadable brief: ${message}`)
  }
  if (!reply) throw new DoxloopError(`Research session "${task.id}" did not return a research-brief JSON object inside <doxloop-brief>. Open the full log, then retry the plan.`)
  return { content: reply.value, repairs: reply.repairs.map((note) => note.replace(/^The research brief reply/, `The "${task.id}" research reply`)) }
}

/** What the synthesis session reads instead of the sources, application, and pages. */
export function formatResearchBriefs(briefs: readonly ResearchBrief[]): string {
  const sections = briefs.map((brief) => `### Brief "${brief.task}": ${brief.label}\n${JSON.stringify(brief.content)}`)
  return `Research briefs (produced for this run by Doxloop's research sessions from the same sources, application, and crawled pages; treat them as your own findings and plan from them):\n\n${sections.join('\n\n')}`
}

/**
 * Briefs depend on the sources, the capture intent, the agent, and the
 * research focus, not on the plan's wording or identity: a revision reuses
 * them, and so does a later plan on unchanged sources (see
 * `readResearchCheckpoint`). A page-scoped audit is keyed by its pages.
 */
export function researchCheckpointKey(current: Pick<DocumentationPlan, 'execution' | 'research'>, sourceSnapshot: string, focus?: readonly string[] | null): string {
  const pages = focus === undefined ? (current.research?.scope === 'pages' ? [...current.research.pages].sort() : null) : focus
  return createHash('sha256')
    .update(JSON.stringify({
      captureSchema: 2,
      sourceSnapshot,
      screenshots: normalizeScreenshotIntent(current.execution.screenshots),
      agent: current.execution.agent ?? null,
      model: current.execution.model ?? null,
      focus: pages && pages.length > 0 ? pages : null,
    }))
    .digest('hex')
}

/**
 * Keys a saved brief may carry to serve this plan: its own key first, then
 * the key of a full product audit on the same sources, which covers
 * anything a page-scoped audit would find.
 */
export function researchCheckpointKeys(current: Pick<DocumentationPlan, 'execution' | 'research'>, sourceSnapshot: string): string[] {
  const own = researchCheckpointKey(current, sourceSnapshot)
  const full = researchCheckpointKey(current, sourceSnapshot, null)
  return own === full ? [own] : [own, full]
}

function researchCheckpointPath(root: string, planId: string, taskId: string): string {
  return join(root, '.doxloop', 'plans', planId, RESEARCH_DIRECTORY, `${taskId}.json`)
}

async function readResearchCheckpointFile(path: string, task: ResearchTask, keys: readonly string[]): Promise<ResearchCheckpoint | undefined> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return undefined
  }
  try {
    const parsed = JSON.parse(text) as Partial<ResearchCheckpoint>
    if (typeof parsed.key !== 'string' || !keys.includes(parsed.key) || parsed.task !== task.id || parsed.content === undefined) return undefined
    return {
      key: parsed.key,
      task: task.id,
      kind: task.kind,
      label: task.label,
      content: parsed.content,
      ...(Array.isArray(parsed.repairs) ? { repairs: parsed.repairs.filter((item): item is string => typeof item === 'string') } : {}),
      savedAt: typeof parsed.savedAt === 'string' ? parsed.savedAt : '',
    }
  } catch {
    return undefined
  }
}

/**
 * The brief saved for this task under one of `keys`: this plan's own first,
 * then the newest other plan's. Sources that have not changed since another
 * plan audited them do not need auditing again, and a second update on the
 * same snapshot used to redo every session. The application brief is the
 * exception: it names captures saved under its own plan, which this plan
 * cannot embed, so it is only ever reused from this plan.
 */
export async function readResearchCheckpoint(root: string, planId: string, task: ResearchTask, keys: string | readonly string[]): Promise<(ResearchCheckpoint & { planId: string }) | undefined> {
  const accepted = typeof keys === 'string' ? [keys] : keys
  const own = await readResearchCheckpointFile(researchCheckpointPath(root, planId, task.id), task, accepted)
  if (own) return { ...own, planId }
  if (task.kind === 'application') return undefined
  let plans: string[]
  try {
    plans = (await readdir(join(root, '.doxloop', 'plans'), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && /^[a-z0-9-]+$/.test(entry.name) && entry.name !== planId)
      .map((entry) => entry.name)
      .sort()
      .reverse()
  } catch {
    return undefined
  }
  for (const other of plans) {
    const saved = await readResearchCheckpointFile(researchCheckpointPath(root, other, task.id), task, accepted)
    if (saved) return { ...saved, planId: other }
  }
  return undefined
}

/** Briefs saved for these tasks under one of the keys; empty unless every task has one. */
export async function savedResearchBriefs(root: string, planId: string, tasks: readonly ResearchTask[], keys: string | readonly string[]): Promise<ResearchBrief[]> {
  const briefs: ResearchBrief[] = []
  for (const task of tasks) {
    const saved = await readResearchCheckpoint(root, planId, task, keys)
    if (!saved) return []
    briefs.push({ task: task.id, kind: task.kind, label: task.label, content: saved.content })
  }
  return briefs
}

export async function writeResearchCheckpoint(root: string, planId: string, checkpoint: Omit<ResearchCheckpoint, 'savedAt'>): Promise<void> {
  const path = researchCheckpointPath(root, planId, checkpoint.task)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify({ ...checkpoint, savedAt: new Date().toISOString() }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
}

export interface RunResearchOptions {
  root: string
  planId: string
  /** Key the briefs this run saves carry. */
  key: string
  /** Keys a saved brief may carry to be reused; defaults to `key` alone. */
  acceptKeys?: readonly string[]
  agent: AgentName
  concurrency: number
  context: ResearchPromptContext
  /** Run one session and return its raw output. */
  runSession: (task: ResearchTask, prompt: string) => Promise<string>
  /** Called as tasks finish, for stage progress. */
  onProgress?: (done: number, total: number, task: ResearchTask, outcome: 'cached' | 'completed' | 'failed') => void
  log?: (line: string) => void
}

/**
 * Run every research task that has no valid checkpoint, at most
 * `concurrency` at a time. A session that fails or returns an unreadable
 * brief is tried once more in a fresh session; the pool keeps going so the
 * other briefs are saved, then the first failure is reported.
 */
export async function runResearch(tasks: readonly ResearchTask[], options: RunResearchOptions): Promise<{ briefs: ResearchBrief[]; repairs: string[] }> {
  const results = new Map<string, { brief: ResearchBrief; repairs: string[] }>()
  const failures: Array<{ task: ResearchTask; error: unknown }> = []
  const pending: ResearchTask[] = []
  let done = 0
  for (const task of tasks) {
    const cached = await readResearchCheckpoint(options.root, options.planId, task, options.acceptKeys ?? [options.key])
    if (cached) {
      if (cached.planId !== options.planId) {
        // Keep a copy under this plan so a retry, a revision, and the plan
        // review all find it where the plan's own briefs live.
        await writeResearchCheckpoint(options.root, options.planId, { key: cached.key, task: task.id, kind: task.kind, label: task.label, content: cached.content, ...(cached.repairs?.length ? { repairs: cached.repairs } : {}) })
      }
      results.set(task.id, { brief: { task: task.id, kind: task.kind, label: task.label, content: cached.content }, repairs: cached.repairs ?? [] })
      done += 1
      options.onProgress?.(done, tasks.length, task, 'cached')
      options.log?.(cached.planId === options.planId
        ? `Reusing the "${task.id}" research brief saved at ${cached.savedAt}.`
        : `Reusing the "${task.id}" research brief plan ${cached.planId} saved at ${cached.savedAt}: the sources have not changed since.`)
    } else {
      pending.push(task)
    }
  }
  await runPool(pending, options.concurrency, async (task) => {
    const prompt = researchPrompt(task, options.context)
    let lastError: unknown
    for (const attempt of [0, 1]) {
      try {
        const text = attempt === 0 ? prompt : `${prompt}

Your previous reply could not be used: ${lastError instanceof Error ? lastError.message : String(lastError)}

Send the brief again as one complete, strictly valid JSON object inside the <doxloop-brief> block.`
        const output = await options.runSession(task, text)
        const read = readBriefOutput(output, options.agent, task, text)
        await writeResearchCheckpoint(options.root, options.planId, { key: options.key, task: task.id, kind: task.kind, label: task.label, content: read.content, ...(read.repairs.length > 0 ? { repairs: read.repairs } : {}) })
        results.set(task.id, { brief: { task: task.id, kind: task.kind, label: task.label, content: read.content }, repairs: read.repairs })
        done += 1
        options.onProgress?.(done, tasks.length, task, 'completed')
        return
      } catch (error) {
        lastError = error
        if (budgetContext.getStore()?.stoppedReason || isAccountLimit(String(error))) break
        options.log?.(`Research session "${task.id}" ${attempt === 0 ? 'failed; starting a fresh session' : 'failed again'}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    failures.push({ task, error: lastError })
    done += 1
    options.onProgress?.(done, tasks.length, task, 'failed')
  }, () => Boolean(budgetContext.getStore()?.stoppedReason))
  budgetContext.getStore()?.assertAvailable()
  if (failures.length > 0) {
    const detail = failures.map(({ task, error }) => `"${task.id}": ${error instanceof Error ? error.message : String(error)}`).join('; ')
    throw new DoxloopError(`${failures.length === 1 ? 'A research session' : `${failures.length} research sessions`} did not finish (${detail}). The briefs that finished are saved; retry the plan to run only the missing ${failures.length === 1 ? 'one' : 'ones'}.`)
  }
  return {
    briefs: tasks.flatMap((task) => (results.has(task.id) ? [results.get(task.id)!.brief] : [])),
    repairs: tasks.flatMap((task) => results.get(task.id)?.repairs ?? []),
  }
}
