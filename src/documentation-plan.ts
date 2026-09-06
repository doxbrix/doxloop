import { assertBatchFits, batchLimits } from './batch-limits.js'
import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { createAgentLogFormatter } from './agent-log.js'
import { forwardTerminationSignals, spawnAgentProcess } from './agent-process.js'
import { agentArguments, captureAuthPrompt, prepareAgentPrompt, sourceAccessDirectories } from './author.js'
import { captureAuthContext, describeCaptureAuth, prepareCaptureAuth, type CaptureAuthMode } from './capture-auth.js'
import { chooseAgent } from './agents.js'
import { emitWorkflowStage } from './job-events.js'
import { computeDrift } from './drift.js'
import { DoxloopError } from './errors.js'
import { pathExists } from './fs.js'
import { documentationPlanTarget } from './plan-generator.js'
import { loadProject } from './project.js'
import { reviewPreferenceGuidance } from './review-learning.js'
import { collectReleaseInventory, formatReleaseInventory, releaseNotesPagePath, type ReleaseTemplateInput } from './release-notes.js'
import { assertScreenshotPlanningReadiness, checkApplicationReadiness, normalizeScreenshotIntent, screenshotPlanSummary } from './screenshot-workflow.js'
import { checkScreenCaptureBrowser, screenCaptureProvider, writeGeminiCaptureSettings } from './screen-capture-provider.js'
import { discoverDocumentationSources, formatDiscoveryInventory, type DocumentationDiscoveryInventory } from './source-discovery.js'
import { collectSourceChanges, formatSourceChanges, sourceSnapshotFingerprints } from './sync.js'
import { createSyncRun, listSyncRuns, readSyncRun, recoverSyncRun, resumeSyncRun, runWorkspace, type RunAuthoringRecord } from './sync-runs.js'
import type {
  AgentName,
  DocumentationPlan,
  DocumentationPlanCapability,
  DocumentationPlanDiagram,
  DocumentationPlanTemplate,
  DoxloopProject,
  DocumentationPlanEvidence,
  DocumentationPlanExecution,
  DocumentationPlanFailure,
  DocumentationPlanMode,
  DocumentationPlanPage,
  DocumentationPlanPageAction,
  DocumentationPlanPagePriority,
  DocumentationPlanQuestion,
  DocumentationPlanScope,
  DocumentationPlanVisuals,
} from './types.js'

const PLANS_DIRECTORY = join('.doxloop', 'plans')
const CURRENT_PLAN_FILE = join('.doxloop', 'documentation-plan.json')
const SOURCES_CHANGED_ADVISORY = 'Configured sources changed after this plan was proposed. The plan was approved as proposed; generation reads the current sources when it writes each page.'
const PLAN_FILE = 'plan.json'
const VERSIONS_DIRECTORY = 'versions'

export interface CreateDocumentationPlanInput {
  mode: DocumentationPlanMode
  scope: DocumentationPlanScope
  /** Reviewer-requested minimum number of pages to write. */
  targetPages?: number
  request?: string
  clarificationMode?: 'review' | 'defaults' | 'stop'
  execution: DocumentationPlanExecution
  /** Start from a content-type template whose inputs Doxloop collects deterministically. */
  template?: ReleaseTemplateInput
}

export async function createDocumentationPlan(
  root: string,
  input: CreateDocumentationPlanInput,
): Promise<DocumentationPlan> {
  const project = await loadProject(root)
  const discovery = await discoverDocumentationSources(root)
  const target = await documentationPlanTarget(root, project)
  const now = new Date().toISOString()
  const template = input.template ? await releaseNotesTemplate(root, project, input.template) : undefined
  const plan: DocumentationPlan = {
    schemaVersion: 2,
    id: planId(),
    version: 1,
    mode: input.mode,
    status: 'planning',
    scope: input.scope,
    createdAt: now,
    updatedAt: now,
    request: input.request?.trim() || (template ? `Release notes for ${template.version}` : ''),
    sourceSnapshot: await documentationSourceSnapshot(root),
    productProfile: '',
    summary: '',
    audiences: project.documentation.audiences?.length
      ? project.documentation.audiences
      : project.documentation.primaryAudience
        ? [project.documentation.primaryAudience]
        : [],
    outcomes: project.documentation.priorityOutcomes ?? [],
    terminology: project.documentation.terminology,
    exclusions: project.documentation.exclusions,
    instructions: project.documentation.customInstructions ?? '',
    experienceLevel: project.documentation.experienceLevel ?? 'mixed',
    preferredExamples: project.documentation.preferredExamples ?? [],
    locale: project.documentation.locale,
    accessibilityTarget: project.documentation.accessibilityTarget,
    styleGuide: project.documentation.styleGuide,
    capabilities: [],
    navigation: { top: ['Documentation'], sections: [] },
    pages: [],
    questions: [],
    estimatedPages: Math.max(estimatedPagesForScope(input.scope, discovery.inventory), input.targetPages ?? 0),
    ...(input.targetPages ? { targetPages: input.targetPages } : {}),
    estimatedEffort: 'medium',
    discovery: {
      cacheKey: discovery.inventory.cacheKey,
      generatedAt: discovery.inventory.generatedAt,
      deterministic: true,
      publicSignals: discovery.inventory.totals.publicSignals,
      suggestedPages: discovery.inventory.suggestedPages,
    },
    target,
    clarification: { mode: input.clarificationMode ?? 'review', answers: {} },
    execution: { ...input.execution, limits: batchLimits(input.execution.limits, { maxPages: Math.max(input.targetPages ?? 0, input.scope === 'starter' ? 5 : input.scope === 'standard' ? 12 : 40), maxScreenshots: input.execution.screenshots === 'disabled' || input.execution.screenshots === false ? 0 : 12, maxMinutes: 15 }) },
    ...(template ? { template } : {}),
  }
  if (input.execution.limits && input.targetPages && input.targetPages > plan.execution.limits!.maxPages) throw new DoxloopError('The minimum page count exceeds the batch maximum. Raise maxPages or lower targetPages.')
  await persistPlan(root, plan, false)
  return plan
}

async function releaseNotesTemplate(root: string, project: DoxloopProject, input: ReleaseTemplateInput): Promise<DocumentationPlanTemplate> {
  const inventory = await collectReleaseInventory(root, project, input)
  return {
    kind: 'release-notes',
    version: inventory.version,
    from: inventory.from,
    to: inventory.to,
    sources: input.sources ?? [],
    inventory,
  }
}

/** Planner instructions for a content-type template, or nothing for a plain request. */
export function templateInstructions(plan: Pick<DocumentationPlan, 'template'>): string {
  const template = plan.template
  if (!template) return ''
  return `
Content-type template: release notes for ${template.version}.
- Plan exactly one page of type "release" at path "${releaseNotesPagePath(template.version)}" titled "Release notes: ${template.version}" (follow the product's existing naming when the documentation already has a release-notes convention), with action "create", or "update" when that path already exists.
- Ground every entry in the release inventory below. Classify reader-visible changes as added, changed, fixed, deprecated, removed, or security; lead with reader impact and the action a reader must take; and never turn a commit message into a product claim the diff does not evidence. Mark anything the inventory cannot support as needing verification instead of asserting it.
- When the documentation has a release index or "What's new" page, plan an "update" for it that links the new page. Do not add unrelated pages.
- Keep the plan to the release page plus the pages this release genuinely changes.

Release inventory (deterministic, collected by Doxloop from Git):
${formatReleaseInventory(template.inventory)}
`
}

/** Writer instructions derived from the plan: required diagrams and the release inventory. */
export function planWritingRequirements(plan: Pick<DocumentationPlan, 'pages' | 'template' | 'target'>): string {
  const parts: string[] = []
  const diagrams = plan.pages.filter((page) => page.diagram === 'required' && (page.action === 'create' || page.action === 'update'))
  if (diagrams.length > 0) {
    const syntax = plan.target.generator === 'doxbrix'
      ? 'a <Mermaid> component block'
      : plan.target.contentFormat === 'rst'
        ? 'a `.. mermaid::` directive'
        : 'a fenced ```mermaid block or the generator\'s documented Mermaid syntax'
    parts.push(`Pages that must contain a Mermaid diagram of the model or lifecycle they explain, using ${syntax}:\n${diagrams.map((page) => `- ${page.title} (${page.path})`).join('\n')}\nDoxloop reports a \`missing-diagram\` warning for any of these pages written without one; resolve it before finishing.`)
  }
  if (plan.template) {
    parts.push(`Release inventory the release-notes page must be grounded in. Do not restate commit messages; describe reader-visible behaviour, group changes consistently, and separate breaking changes from optional capability:\n${formatReleaseInventory(plan.template.inventory)}`)
  }
  return parts.length > 0 ? `${parts.join('\n\n')}\n\n` : ''
}

export async function listDocumentationPlans(root: string): Promise<DocumentationPlan[]> {
  const directory = join(root, PLANS_DIRECTORY)
  if (!(await pathExists(directory))) return []
  const entries = await readdir(directory, { withFileTypes: true })
  const plans: DocumentationPlan[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[a-z0-9-]+$/.test(entry.name)) continue
    try {
      plans.push(await readDocumentationPlan(root, entry.name))
    } catch {
      // Interrupted or manually damaged plan directories are ignored here and
      // remain available on disk for diagnosis.
    }
  }
  return plans.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
}

export async function latestDocumentationPlan(root: string): Promise<DocumentationPlan | undefined> {
  return (await listDocumentationPlans(root))[0]
}

export async function listDocumentationPlanVersions(root: string, id: string): Promise<DocumentationPlan[]> {
  assertPlanId(id)
  const current = await readDocumentationPlan(root, id)
  const directory = join(root, PLANS_DIRECTORY, id, VERSIONS_DIRECTORY)
  const versions = new Map<number, DocumentationPlan>([[current.version, current]])
  if (await pathExists(directory)) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !/^v\d+\.json$/.test(entry.name)) continue
      try {
        const raw = JSON.parse(await readFile(join(directory, entry.name), 'utf8')) as unknown
        const normalized = await normalizePersistedPlan(root, raw, id)
        versions.set(normalized.plan.version, normalized.plan)
      } catch {
        // A damaged archive must not prevent review of the current plan.
      }
    }
  }
  return [...versions.values()].sort((left, right) => right.version - left.version)
}

export async function readDocumentationPlan(root: string, id: string): Promise<DocumentationPlan> {
  assertPlanId(id)
  const raw = JSON.parse(await readFile(planPath(root, id), 'utf8')) as unknown
  const { plan, migrated } = await normalizePersistedPlan(root, raw, id)
  if (migrated) await persistPlan(root, plan, false)
  if (plan.status === 'failed' && !plan.failure) {
    // A plan that failed before failures were recorded still has the workspace
    // its run left behind; find it so the reviewer can continue from it.
    const failure = await inferPlanFailure(root, plan)
    const inferred = { ...plan, failure }
    await persistPlan(root, inferred, false)
    return inferred
  }
  return plan
}

async function inferPlanFailure(root: string, plan: DocumentationPlan): Promise<DocumentationPlanFailure> {
  if (!plan.approvedHash) {
    return { stage: 'propose', resumable: false, ignorable: plan.pages.length > 0 }
  }
  let runs
  try {
    runs = await listSyncRuns(root)
  } catch {
    return { stage: 'generate', resumable: false, ignorable: false }
  }
  const candidates = runs.filter((run) =>
    run.planId === plan.id &&
    !run.archivedAt &&
    (run.status === 'failed' || run.status === 'generating') &&
    (!plan.approvedAt || run.createdAt >= plan.approvedAt),
  )
  for (const candidate of candidates) {
    if (!(await pathExists(runWorkspace(root, candidate.id)))) continue
    return {
      stage: 'generate',
      proposalId: candidate.id,
      resumable: candidate.recovery?.resumable !== false && !candidate.revisionOf,
      ignorable: candidate.recovery?.ignorable !== false,
    }
  }
  return { stage: 'generate', resumable: false, ignorable: false }
}

/**
 * The authoring inputs a plan-first generation run starts with. Recorded beside
 * each run; rebuilt here for runs that predate that record so they can still
 * be resumed from their approved plan.
 */
export async function planAuthoringRecord(root: string, plan: DocumentationPlan): Promise<Omit<RunAuthoringRecord, 'schemaVersion'>> {
  const project = await loadProject(root)
  const screenshotIntent = normalizeScreenshotIntent(plan.execution.screenshots)
  const sourceChanges = await collectSourceChanges(root, project.sources)
  const changeSummary = sourceChanges.length > 0
    ? formatSourceChanges(sourceChanges.map((change) => ({ ...change, path: resolve(root, change.path) })))
    : undefined
  const historyRequest = plan.request.trim() || plan.summary.trim()
  return {
    mode: plan.mode,
    trigger: 'manual',
    screenshots: screenshotIntent,
    request: generationRequest(plan, await reviewPreferenceGuidance(root)),
    ...(historyRequest ? { historyRequest } : {}),
    ...(plan.execution.agent ?? project.defaultAgent ? { agent: (plan.execution.agent ?? project.defaultAgent)! } : {}),
    ...(plan.execution.model ? { model: plan.execution.model } : {}),
    ...(plan.execution.reasoning ? { reasoning: plan.execution.reasoning } : {}),
    ...(plan.execution.effort ? { effort: plan.execution.effort } : {}),
    timeoutMinutes: Math.min(batchLimits(plan.execution.limits).maxMinutes, project.sync.budget?.maxMinutes ?? 120),
    ...(changeSummary ? { changeSummary } : {}),
  }
}

export async function proposeDocumentationPlan(root: string, id: string): Promise<DocumentationPlan> {
  const current = await readDocumentationPlan(root, id)
  if (current.status !== 'planning') {
    throw new DoxloopError(`Plan ${id} cannot be proposed from status ${current.status}.`)
  }
  return runPlanner(root, current)
}

/** Validate and persist the structured result returned by any terminal agent. */
export async function applyDocumentationPlanProposal(
  root: string,
  id: string,
  raw: unknown,
  agent?: AgentName,
): Promise<DocumentationPlan> {
  const current = await readDocumentationPlan(root, id)
  if (current.status !== 'planning' && current.status !== 'revising') {
    throw new DoxloopError(`Plan ${id} cannot accept a proposal from status ${current.status}.`)
  }
  const proposed = normalizePlanShape(raw, current)
  const coverageIssue = initialCreatePlanCoverageIssue(proposed, current)
  if (coverageIssue) throw new DoxloopError(coverageIssue)
  const { approvedAt: _approvedAt, approvedHash: _approvedHash, proposalId: _proposalId, error: _error, failure: _failure, ...unapproved } = current
  const next: DocumentationPlan = {
    ...unapproved,
    ...proposed,
    version: current.status === 'revising' ? current.version + 1 : current.version,
    status: proposed.questions.length > 0 ? 'needs-input' : 'ready-for-review',
    sourceSnapshot: await documentationSourceSnapshot(root),
    updatedAt: new Date().toISOString(),
    execution: { ...current.execution, ...(agent ? { agent } : {}) },
  }
  // Keep the first reviewable proposal as v1 as well as every later revision,
  // so reviewers can always understand how the plan changed.
  await persistPlan(root, next, true)
  return next
}

export async function beginDocumentationPlanRevision(
  root: string,
  id: string,
  clarificationAnswers: Record<string, string> = {},
): Promise<DocumentationPlan> {
  const current = await readDocumentationPlan(root, id)
  if (!['ready-for-review', 'needs-input', 'approved', 'failed', 'stale'].includes(current.status)) {
    throw new DoxloopError(`Plan ${id} cannot be revised from status ${current.status}.`)
  }
  const { approvedAt: _approvedAt, approvedHash: _approvedHash, error: _error, failure: _failure, ...unapproved } = current
  const next: DocumentationPlan = {
    ...unapproved,
    clarification: {
      ...current.clarification,
      answers: { ...current.clarification.answers, ...clarificationAnswers },
    },
    status: 'revising',
    updatedAt: new Date().toISOString(),
  }
  await persistPlan(root, next, false)
  return next
}

export async function reviseDocumentationPlan(
  root: string,
  id: string,
  feedback: string,
): Promise<DocumentationPlan> {
  const current = await readDocumentationPlan(root, id)
  if (current.status !== 'revising') {
    throw new DoxloopError(`Plan ${id} cannot be revised from status ${current.status}.`)
  }
  if (!feedback.trim()) throw new DoxloopError('Describe how the documentation plan should change.')
  return runPlanner(root, current, feedback.trim())
}

export function documentationPlanClarificationFeedback(
  plan: DocumentationPlan,
  answers: Record<string, string>,
  useRecommendations = false,
): string {
  if (plan.questions.length === 0) throw new DoxloopError('This documentation plan has no open questions.')
  const resolved = plan.questions.map((question) => {
    const answer = answers[question.id]?.trim() || (useRecommendations ? question.recommendation?.trim() : undefined)
    if (!answer) throw new DoxloopError(`Answer "${question.question}" before continuing the plan.`)
    return { question, answer }
  })
  return `Continue the paused documentation plan using these confirmed decisions. Remove the resolved questions from the revised plan.\n\n${resolved.map(({ question, answer }) => `Question: ${question.question}\nAnswer: ${answer}`).join('\n\n')}`
}

export async function editDocumentationPlan(
  root: string,
  id: string,
  raw: unknown,
): Promise<DocumentationPlan> {
  const current = await readDocumentationPlan(root, id)
  if (['planning', 'revising', 'generating', 'generated', 'cancelled'].includes(current.status)) {
    throw new DoxloopError(`Plan ${id} cannot be edited from status ${current.status}.`)
  }
  const input = record(raw)
  const executionInput = record(input.execution)
  const shape = normalizePlanShape({
    ...current,
    ...(input.scope !== undefined ? { scope: input.scope } : {}),
    ...(input.summary !== undefined ? { summary: input.summary } : {}),
    ...(input.audiences !== undefined ? { audiences: input.audiences } : {}),
    ...(input.outcomes !== undefined ? { outcomes: input.outcomes } : {}),
    ...(input.terminology !== undefined ? { terminology: input.terminology } : {}),
    ...(input.exclusions !== undefined ? { exclusions: input.exclusions } : {}),
    ...(input.instructions !== undefined ? { instructions: input.instructions } : {}),
    ...(input.experienceLevel !== undefined ? { experienceLevel: input.experienceLevel } : {}),
    ...(input.preferredExamples !== undefined ? { preferredExamples: input.preferredExamples } : {}),
    ...(input.locale !== undefined ? { locale: input.locale } : {}),
    ...(input.accessibilityTarget !== undefined ? { accessibilityTarget: input.accessibilityTarget } : {}),
    ...(input.styleGuide !== undefined ? { styleGuide: input.styleGuide } : {}),
    ...(input.capabilities !== undefined ? { capabilities: input.capabilities } : {}),
    ...(input.navigation !== undefined ? { navigation: input.navigation } : {}),
    ...(input.estimatedPages !== undefined ? { estimatedPages: input.estimatedPages } : {}),
    ...(input.pages !== undefined ? { pages: input.pages } : {}),
    ...(input.questions !== undefined ? { questions: input.questions } : {}),
  }, current)
  const { approvedAt: _approvedAt, approvedHash: _approvedHash, proposalId: _proposalId, error: _error, failure: _failure, ...editable } = current
  const targetPages = input.targetPages === undefined ? current.targetPages : positiveInteger(input.targetPages)
  const { targetPages: _previousTarget, ...editableWithoutTarget } = editable
  const next: DocumentationPlan = {
    ...editableWithoutTarget,
    ...shape,
    ...(targetPages ? { targetPages } : {}),
    execution: {
      ...current.execution,
      limits: batchLimits(executionInput.limits ?? current.execution.limits),
      screenshots: normalizeScreenshotIntent(executionInput.screenshots ?? current.execution.screenshots),
    },
    version: current.version + 1,
    status: 'ready-for-review',
    updatedAt: new Date().toISOString(),
  }
  await persistPlan(root, next, true)
  return next
}

export async function approveDocumentationPlan(root: string, id: string): Promise<DocumentationPlan> {
  const current = await readDocumentationPlan(root, id)
  // A failed run leaves the reviewed plan intact, so approving it again is how
  // a reviewer retries generation from the plan review. Only a plan that is
  // mid-flight, already generated, or cancelled has nothing to approve.
  if (!['ready-for-review', 'needs-input', 'stale', 'failed'].includes(current.status)) {
    throw new DoxloopError(`Plan ${id} cannot be approved from status ${current.status}.`)
  }
  assertBatchFits(current)
  const executablePages = current.pages.filter((page) => page.priority !== 'later')
  if (executablePages.length === 0) throw new DoxloopError('Add at least one page for this documentation run before approving the plan.')
  if (current.questions.length > 0) {
    throw new DoxloopError('Resolve or remove the open questions before approving the plan.')
  }
  const screenshotIntent = normalizeScreenshotIntent(current.execution.screenshots)
  const visualPages = executablePages.filter((page) => page.visuals && page.visuals.mode !== 'none')
  const incompleteVisuals = visualPages.filter((page) =>
    !page.visuals?.rationale.trim() ||
    page.visuals.estimatedCaptures < 1 ||
    !validCaptureStartPath(page.visuals.startPath) ||
    !page.visuals.workflow?.trim() ||
    page.visuals.workflow.trim().length < 12 ||
    !completeCaptureSequence(page.visuals.captureSequence, page.visuals.estimatedCaptures),
  )
  if (screenshotIntent === 'enabled' && incompleteVisuals.length > 0) {
    throw new DoxloopError(`Complete the screenshot purpose, start path, workflow, and one meaningful capture-sequence item per planned image for ${incompleteVisuals.map((page) => `"${page.title}"`).join(', ')} before approval.`)
  }
  if (screenshotIntent === 'enabled' && visualPages.length === 0) {
    throw new DoxloopError('Required screenshot mode needs at least one screenshot-enabled visible UI guide.')
  }
  if (screenshotIntent === 'enabled' && visualPages.length > 0) {
    const project = await loadProject(root)
    await assertCapturePlanReady(root, project.application, visualPages)
  }
  // Sources that changed since the proposal do not block approval. The reviewer
  // approved the structure, and generation inspects the current sources when
  // it writes each page, so a code edit made while the plan waited for review
  // only earns a note rather than a fresh planning run.
  const snapshot = await documentationSourceSnapshot(root)
  const sourcesChanged = snapshot !== current.sourceSnapshot
  const advisories = sourcesChanged
    ? [...(current.advisories ?? []).filter((item) => item !== SOURCES_CHANGED_ADVISORY), SOURCES_CHANGED_ADVISORY]
    : current.advisories
  const approvedAt = new Date().toISOString()
  const { error: _error, failure: _failure, ...valid } = current
  const approvalContent: DocumentationPlan = {
    ...valid,
    pages: executablePages,
    navigation: { ...valid.navigation, sections: valid.navigation.sections.map((section) => ({ ...section, pageIds: section.pageIds.filter((id) => executablePages.some((page) => page.id === id && page.action !== 'remove')) })).filter((section) => section.pageIds.length > 0) },
    estimatedPages: executablePages.filter((page) => page.action !== 'preserve').length,
    sourceSnapshot: snapshot,
    ...(advisories && advisories.length > 0 ? { advisories } : {}),
  }
  const approved: DocumentationPlan = {
    ...approvalContent,
    status: 'approved',
    updatedAt: approvedAt,
    approvedAt,
    approvedHash: planHash(approvalContent),
  }
  await persistPlan(root, approved, true)
  await atomicWrite(join(root, CURRENT_PLAN_FILE), `${JSON.stringify(approved, null, 2)}\n`)
  return approved
}

/**
 * Keep a plan whose configured sources changed after it was proposed. The
 * reviewer has already read the structure, so re-running the planner for an
 * unrelated code edit would throw that review away. Refreshing the evidence
 * snapshot keeps every page as proposed and lets approval proceed; generation
 * still inspects the current sources when it writes each page.
 */
export async function resumeDocumentationPlan(root: string, id: string): Promise<DocumentationPlan> {
  const current = await readDocumentationPlan(root, id)
  if (!['stale', 'ready-for-review', 'needs-input'].includes(current.status)) {
    throw new DoxloopError(`Plan ${id} cannot continue from status ${current.status}.`)
  }
  const { approvedAt: _approvedAt, approvedHash: _approvedHash, error: _error, failure: _failure, ...unapproved } = current
  const next: DocumentationPlan = {
    ...unapproved,
    status: current.questions.length > 0 ? 'needs-input' : 'ready-for-review',
    sourceSnapshot: await documentationSourceSnapshot(root),
    updatedAt: new Date().toISOString(),
  }
  await persistPlan(root, next, false)
  return next
}

export async function cancelDocumentationPlan(root: string, id: string): Promise<DocumentationPlan> {
  const current = await readDocumentationPlan(root, id)
  if (!['planning', 'revising', 'generating'].includes(current.status)) return current
  const cancelled: DocumentationPlan = {
    ...current,
    status: 'cancelled',
    updatedAt: new Date().toISOString(),
    error: 'The plan workflow was cancelled before it completed.',
  }
  await persistPlan(root, cancelled, false)
  return cancelled
}

/** Restore only the durable state required to retry an interrupted UI stage. */
export async function retryDocumentationPlan(root: string, id: string, stage: 'propose' | 'revise' | 'generate'): Promise<DocumentationPlan> {
  const current = await readDocumentationPlan(root, id)
  if (stage === 'generate' && !current.approvedHash) throw new DoxloopError('The interrupted plan no longer has an approved snapshot. Review and approve it again.')
  const allowed = stage === 'generate'
    ? ['approved', 'generating', 'failed', 'cancelled']
    : ['planning', 'revising', 'failed', 'cancelled']
  if (!allowed.includes(current.status)) throw new DoxloopError(`Plan ${id} cannot retry ${stage} from status ${current.status}.`)
  const { error: _error, failure: _failure, ...restored } = current
  const next: DocumentationPlan = { ...restored, status: stage === 'generate' ? 'approved' : stage === 'revise' ? 'revising' : 'planning', updatedAt: new Date().toISOString() }
  await persistPlan(root, next, false)
  return next
}

export async function generateApprovedDocumentationPlan(root: string, id: string): Promise<DocumentationPlan> {
  let plan = await readDocumentationPlan(root, id)
  if (plan.status !== 'approved' || !plan.approvedHash) {
    throw new DoxloopError('Approve the current documentation plan before generating files.')
  }
  if (planHash(plan) !== plan.approvedHash) {
    throw new DoxloopError('The approved plan content changed. Review and approve it again.')
  }
  if (await documentationSourceSnapshot(root) !== plan.sourceSnapshot) {
    // The approved structure still stands; the authoring run inspects the
    // current sources, so a change since approval is worth a log line only.
    process.stdout.write('Configured sources changed after approval. Generating the approved plan from the current sources.\n')
  }
  const screenshotIntent = normalizeScreenshotIntent(plan.execution.screenshots)
  const screenshotPlan = screenshotPlanSummary(plan)
  if (screenshotIntent === 'enabled' && screenshotPlan.guides === 0) {
    throw new DoxloopError('Screenshots are required for this run, but the approved plan has no screenshot-enabled UI guide. Add screenshots to a relevant page or change the run to Automatic/No screenshots.')
  }
  if (screenshotIntent === 'enabled' && screenshotPlan.guides > 0) {
    const project = await loadProject(root)
    await assertCapturePlanReady(root, project.application, plan.pages.filter((page) => page.visuals && page.visuals.mode !== 'none'))
  }
  const { error: _error, failure: _failure, ...generatingPlan } = plan
  plan = { ...generatingPlan, status: 'generating', updatedAt: new Date().toISOString() }
  await persistPlan(root, plan, false)
  let failedProposal: { id: string; recovery?: { resumable: boolean; ignorable: boolean } } | undefined
  try {
    const recovered = await recoverLatestFailedProposal(root, plan)
    if (recovered) {
      for (const [stage, label] of [
        ['inspecting-sources', 'Confirming approved evidence'],
        ['authoring-pages', 'Recovered previously authored pages'],
        ['updating-navigation', 'Updating navigation and theme'],
        ['recording-evidence', 'Recording page evidence'],
        ['validating', 'Validated the recovered documentation'],
        ['preparing-proposal', 'Preparing review proposal'],
      ] as const) {
        emitWorkflowStage(stage, label, 'completed')
      }
      const { error: _recoveredError, failure: _recoveredFailure, ...recoveredPlan } = plan
      plan = {
        ...recoveredPlan,
        status: 'generated',
        proposalId: recovered.id,
        updatedAt: new Date().toISOString(),
      }
      await persistPlan(root, plan, false)
      return plan
    }
    emitWorkflowStage('inspecting-sources', 'Confirming approved evidence', 'running')
    const project = await loadProject(root)
    const [drift, sourceChanges, reviewerGuidance] = await Promise.all([
      computeDrift(root, project),
      collectSourceChanges(root, project.sources),
      reviewPreferenceGuidance(root),
    ])
    emitWorkflowStage('inspecting-sources', 'Confirming approved evidence', 'completed')
    // The authoring run announces and advances the writing, navigation,
    // evidence, screenshot, and validation stages from what the agent does.
    const proposal = await createSyncRun({
      root,
      project,
      plan,
      drift,
      sourceChanges,
      trigger: 'manual',
      authoring: {
        mode: plan.mode,
        ...(plan.request.trim() || plan.summary.trim()
          ? { historyRequest: plan.request.trim() || plan.summary.trim() }
          : {}),
        request: generationRequest(plan, reviewerGuidance),
        ...(plan.execution.agent ? { agent: plan.execution.agent } : {}),
        ...(plan.execution.model ? { model: plan.execution.model } : {}),
        ...(plan.execution.reasoning ? { reasoning: plan.execution.reasoning } : {}),
        ...(plan.execution.effort ? { effort: plan.execution.effort } : {}),
        screenshots: screenshotIntent,
      },
    })
    failedProposal = proposal
    if (proposal.status === 'failed') {
      throw new DoxloopError(proposal.error ?? 'Documentation generation failed.')
    }
    if (screenshotPlan.guides > 0 && screenshotIntent !== 'disabled') {
      emitWorkflowStage('capturing-screenshots', proposal.screenshots?.status === 'verified' ? `Verified ${proposal.screenshots.captured} application screenshot${proposal.screenshots.captured === 1 ? '' : 's'}` : 'Application screenshots were not captured', proposal.screenshots?.status === 'failed' ? 'failed' : 'completed')
    }
    emitWorkflowStage('validating', 'Validating generated documentation', 'completed')
    emitWorkflowStage('preparing-proposal', 'Preparing review proposal', 'running')
    emitWorkflowStage('preparing-proposal', 'Preparing review proposal', 'completed')
    const { error: _error, failure: _failure, ...generatedPlan } = plan
    plan = {
      ...generatedPlan,
      status: 'generated',
      proposalId: proposal.id,
      updatedAt: new Date().toISOString(),
    }
    await persistPlan(root, plan, false)
    return plan
  } catch (error) {
    const preserved = failedProposal && (await pathExists(runWorkspace(root, failedProposal.id)))
    plan = {
      ...plan,
      status: 'failed',
      updatedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
      failure: {
        stage: 'generate',
        ...(failedProposal ? { proposalId: failedProposal.id } : {}),
        resumable: Boolean(preserved) && failedProposal?.recovery?.resumable !== false,
        ignorable: Boolean(preserved) && failedProposal?.recovery?.ignorable !== false,
      },
    }
    await persistPlan(root, plan, false)
    throw error
  }
}

/**
 * A generation retry first tries to promote the newest failed proposal for
 * this plan whose preserved workspace still validates. Recovery is best-effort:
 * any failure falls back to a full agent run without surfacing an error.
 */
async function recoverLatestFailedProposal(root: string, plan: DocumentationPlan): Promise<{ id: string } | undefined> {
  let candidates
  try {
    candidates = (await listSyncRuns(root)).filter((run) =>
      run.status === 'failed' &&
      run.planId === plan.id &&
      !run.archivedAt &&
      // Only runs generated from the current approval; an edited and
      // re-approved plan must not resurrect output from its older version.
      (!plan.approvedAt || run.createdAt >= plan.approvedAt),
    )
  } catch {
    return undefined
  }
  for (const candidate of candidates) {
    if (!(await pathExists(runWorkspace(root, candidate.id)))) continue
    try {
      return await recoverSyncRun(root, candidate.id)
    } catch {
      return undefined
    }
  }
  return undefined
}

export async function documentationSourceSnapshot(root: string): Promise<string> {
  const project = await loadProject(root)
  let changes: unknown
  try {
    changes = await collectSourceChanges(root, project.sources)
  } catch (error) {
    changes = { unavailable: error instanceof Error ? error.message : String(error) }
  }
  return createHash('sha256')
    .update(JSON.stringify({
      sources: project.sources,
      changes,
      fingerprints: await sourceSnapshotFingerprints(root, project.sources),
    }))
    .digest('hex')
}

async function runPlanner(
  root: string,
  current: DocumentationPlan,
  feedback?: string,
): Promise<DocumentationPlan> {
  const stage: DocumentationPlanFailure['stage'] = current.status === 'revising' ? 'revise' : 'propose'
  let failedCandidate: DocumentationPlan | undefined
  try {
    emitWorkflowStage('inspecting-sources', 'Inspecting sources', 'running')
    const project = await loadProject(root)
    if (normalizeScreenshotIntent(current.execution.screenshots) === 'enabled') {
      await assertScreenshotPlanningReadiness(project.application, current.execution.screenshots, await captureAuthContext(root))
      const browserReadiness = await checkScreenCaptureBrowser()
      if (!browserReadiness.available) throw new DoxloopError(`Required screenshot planning cannot start. ${browserReadiness.message}`)
    }
    const discovery = await discoverDocumentationSources(root)
    const changes = await collectSourceChanges(root, project.sources)
    emitWorkflowStage('inspecting-sources', 'Inspecting sources', 'completed')
    emitWorkflowStage('building-coverage', 'Building coverage plan', 'running')
    const selected = await chooseAgent(current.execution.agent)
    const prompt = planningPrompt(project, current, discovery.inventory, formatSourceChanges(changes), feedback, await reviewPreferenceGuidance(root), describeCaptureAuth(project.application ? await captureAuthContext(root) : undefined))
    let raw = await planFromAgent(root, selected, prompt, current.execution, project)
    let recommendedAnswers: Record<string, string> | undefined
    const proposed = normalizePlanShape(raw, current)
    // Thin screenshot coverage is worth one corrective attempt, but it never
    // fails the run: the application may genuinely expose only one screen.
    const planningIssue = [
      initialCreatePlanCoverageIssue(proposed, current),
      requiredScreenshotPlanIssue(proposed, current.execution),
      screenshotCoverageAdvisory(proposed, current.execution),
      shallowCaptureAdvisory(proposed, current.execution),
    ].filter((issue): issue is string => Boolean(issue)).join('\n')
    if (planningIssue) {
      emitWorkflowStage('revising-gates', 'Revising failed planning gates', 'running')
      const repairPrompt = `${prompt}

Required planning validation failed for your first proposal:
${planningIssue}

Return a corrected complete JSON object. Re-audit the configured evidence for distinct reader jobs and use the supplied doxloop_capture MCP tools to inspect the reachable application when screenshots are required. Do not pad the plan, invent UI states, downgrade required screenshots, or return another plan without a complete screenshot-enabled UI guide.

First proposal:
${JSON.stringify(raw, null, 2)}`
      raw = await planFromAgent(root, selected, repairPrompt, current.execution, project)
      emitWorkflowStage('revising-gates', 'Revising failed planning gates', 'completed')
    }
    const clarificationCandidate = normalizePlanShape(raw, current)
    if (clarificationCandidate.questions.length > 0 && current.clarification.mode === 'defaults' && clarificationCandidate.questions.every((question) => question.recommendation?.trim())) {
      recommendedAnswers = Object.fromEntries(clarificationCandidate.questions.map((question) => [question.id, question.recommendation!.trim()]))
      emitWorkflowStage('clarifying', 'Applying recommended decisions', 'running')
      const clarificationFeedback = documentationPlanClarificationFeedback(
        { ...current, ...clarificationCandidate },
        {},
        true,
      )
      const clarificationPrompt = `${prompt}\n\n${clarificationFeedback}\n\nPlan awaiting clarification:\n${JSON.stringify(raw, null, 2)}`
      raw = await planFromAgent(root, selected, clarificationPrompt, current.execution, project)
      emitWorkflowStage('clarifying', 'Applying recommended decisions', 'completed')
    }
    const finalShape = normalizePlanShape(raw, current)
    const finalPlanningIssue = [
      initialCreatePlanCoverageIssue(finalShape, current),
      requiredScreenshotPlanIssue(finalShape, current.execution),
    ].filter((issue): issue is string => Boolean(issue)).join('\n')
    if (finalPlanningIssue) {
      // The agent's plan is not approvable as it stands, but it is real work:
      // keep it as the failed plan so the reviewer can fix it by hand or accept
      // it for review instead of paying for another planning run.
      const candidate = await persistFailedPlanCandidate(root, current, raw, selected.name)
      failedCandidate = candidate
      throw new DoxloopError(`The planning agent could not produce an approvable plan. ${finalPlanningIssue}`)
    }
    let applied = await applyDocumentationPlanProposal(root, current.id, raw, selected.name)
    const advisories = [
      screenshotCoverageAdvisory(applied, applied.execution),
      shallowCaptureAdvisory(applied, applied.execution),
    ].filter((item): item is string => Boolean(item))
    if (recommendedAnswers || advisories.length > 0) {
      applied = {
        ...applied,
        ...(advisories.length > 0 ? { advisories } : {}),
        ...(recommendedAnswers
          ? { clarification: { ...applied.clarification, answers: { ...applied.clarification.answers, ...recommendedAnswers } } }
          : {}),
      }
      await persistPlan(root, applied, true)
    }
    emitWorkflowStage('building-coverage', 'Building coverage plan', 'completed')
    emitWorkflowStage('ready-for-review', 'Preparing plan review', 'completed')
    return applied
  } catch (error) {
    const failed: DocumentationPlan = {
      ...(failedCandidate ?? current),
      status: 'failed',
      updatedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
      failure: { stage, resumable: false, ignorable: Boolean(failedCandidate) },
    }
    await persistPlan(root, failed, false)
    throw error
  }
}

/**
 * Persist an agent plan that failed its final planning gates, as the plan's
 * next reviewable version, without promoting it to review. The reviewer sees
 * the pages the agent proposed next to the gate it missed.
 */
async function persistFailedPlanCandidate(
  root: string,
  current: DocumentationPlan,
  raw: unknown,
  agent: AgentName,
): Promise<DocumentationPlan> {
  const proposed = normalizePlanShape(raw, current)
  const { approvedAt: _approvedAt, approvedHash: _approvedHash, proposalId: _proposalId, error: _error, failure: _failure, ...unapproved } = current
  const candidate: DocumentationPlan = {
    ...unapproved,
    ...proposed,
    version: current.status === 'revising' ? current.version + 1 : current.version,
    status: 'failed',
    sourceSnapshot: await documentationSourceSnapshot(root),
    updatedAt: new Date().toISOString(),
    execution: { ...current.execution, agent },
  }
  await persistPlan(root, candidate, true)
  return candidate
}

/**
 * Accept a plan the planner could not finish to its own standard. The gate it
 * missed becomes an advisory on the plan review, where the reviewer can edit
 * pages, add a screenshot guide, or approve the plan as it is.
 */
export async function ignoreDocumentationPlanError(root: string, id: string): Promise<DocumentationPlan> {
  const current = await readDocumentationPlan(root, id)
  // A browser can render the failed-plan controls just before a background
  // continuation finishes and persists `generated`. Treat that stale click as
  // an idempotent success so the client can reload the completed state.
  if (current.status === 'generated') return current
  if (current.status !== 'failed') throw new DoxloopError(`Plan ${id} is ${current.status}, so there is no failure to ignore.`)
  if (current.failure?.stage === 'generate') {
    throw new DoxloopError('Generation failures are continued with continueDocumentationPlanGeneration, which keeps the generated files.')
  }
  if (!current.failure?.ignorable || current.pages.length === 0) {
    throw new DoxloopError('The planner did not leave a plan behind to review. Retry planning instead.')
  }
  const { error, failure: _failure, ...candidate } = current
  const advisory = error ? `Accepted for review despite a planning problem: ${error}` : undefined
  const next: DocumentationPlan = {
    ...candidate,
    status: candidate.questions.length > 0 ? 'needs-input' : 'ready-for-review',
    updatedAt: new Date().toISOString(),
    ...(advisory ? { advisories: [...(candidate.advisories ?? []).filter((item) => item !== advisory), advisory] } : {}),
  }
  await persistPlan(root, next, false)
  return next
}

export type PlanContinuationStrategy = 'resume' | 'ignore-errors'

/**
 * Continue a plan whose generation failed, from the proposal workspace that
 * failure preserved. `resume` starts the agent again in that workspace with a
 * brief of what already exists, so finished pages and verified screenshots are
 * kept; `ignore-errors` accepts the existing output for review with every
 * screenshot problem recorded instead of enforced. Neither starts over.
 */
export async function continueDocumentationPlanGeneration(
  root: string,
  id: string,
  strategy: PlanContinuationStrategy,
): Promise<DocumentationPlan> {
  let plan = await readDocumentationPlan(root, id)
  // Continuation can finish between the UI rendering its recovery controls
  // and the reviewer clicking one. The requested outcome already exists.
  if (plan.status === 'generated') return plan
  const proposalId = plan.failure?.proposalId
  if (plan.status !== 'failed' && plan.status !== 'generating') {
    throw new DoxloopError(`Plan ${id} is ${plan.status}, so there is no interrupted generation to continue.`)
  }
  if (plan.failure?.stage !== 'generate' || !proposalId) {
    throw new DoxloopError('This plan has no preserved generation workspace to continue. Retry generating it instead.')
  }
  if (!plan.approvedHash || planHash(plan) !== plan.approvedHash) {
    throw new DoxloopError('The approved plan content changed. Review and approve it again.')
  }
  const run = await readSyncRun(root, proposalId)
  if (run.archivedAt || !(await pathExists(runWorkspace(root, proposalId)))) {
    throw new DoxloopError('The generation workspace for this plan is no longer preserved. Retry generating it instead.')
  }
  if (strategy === 'resume' && run.recovery?.resumable === false) {
    throw new DoxloopError('This proposal cannot be resumed. Accept its output with problems ignored, or retry generating it.')
  }
  const { error: _error, ...retained } = plan
  plan = { ...retained, status: 'generating', updatedAt: new Date().toISOString() }
  await persistPlan(root, plan, false)
  const label = strategy === 'resume' ? 'Continuing the interrupted authoring run' : 'Accepting the generated files with reported problems ignored'
  try {
    emitWorkflowStage('inspecting-sources', 'Confirming approved evidence', 'completed')
    // A resumed agent run announces and advances its own stages.
    if (strategy !== 'resume') {
      emitWorkflowStage('authoring-pages', label, 'running')
      emitWorkflowStage('validating', 'Validating generated documentation', 'running')
    }
    const proposal = strategy === 'resume'
      ? await resumeSyncRun(root, proposalId, { fallbackAuthoring: await planAuthoringRecord(root, plan) })
      : await recoverSyncRun(root, proposalId, { ignoreScreenshotProblems: true })
    if (proposal.status === 'failed') {
      throw new DoxloopError(proposal.error ?? 'Documentation generation failed.')
    }
    emitWorkflowStage('authoring-pages', label, 'completed')
    if (strategy === 'resume' || proposal.screenshots) {
      const ignored = proposal.screenshots?.ignoredProblems ?? 0
      emitWorkflowStage(
        'capturing-screenshots',
        ignored > 0
          ? `Accepted ${proposal.screenshots?.captured ?? 0} screenshot${proposal.screenshots?.captured === 1 ? '' : 's'} with ${ignored} problem${ignored === 1 ? '' : 's'} ignored`
          : proposal.screenshots?.status === 'verified'
            ? `Verified ${proposal.screenshots.captured} application screenshot${proposal.screenshots.captured === 1 ? '' : 's'}`
            : 'Application screenshots were not captured',
        'completed',
      )
    }
    emitWorkflowStage('validating', 'Validating generated documentation', 'completed')
    emitWorkflowStage('preparing-proposal', 'Preparing review proposal', 'completed')
    const { failure: _failure, ...generatedPlan } = plan
    plan = {
      ...generatedPlan,
      status: 'generated',
      proposalId: proposal.id,
      updatedAt: new Date().toISOString(),
    }
    await persistPlan(root, plan, false)
    return plan
  } catch (error) {
    plan = {
      ...plan,
      status: 'failed',
      updatedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
      failure: {
        stage: 'generate',
        proposalId,
        resumable: await pathExists(runWorkspace(root, proposalId)),
        ignorable: await pathExists(runWorkspace(root, proposalId)),
      },
    }
    await persistPlan(root, plan, false)
    throw error
  }
}

/**
 * Run the planning agent and read its plan. A malformed or missing JSON object
 * is retried once with the defect quoted back: agents lose a brace often enough
 * that failing the whole plan on the first bad reply wastes the entire run.
 * The reply is never repaired here, because silently truncating an unbalanced
 * object would drop planned pages without telling anyone.
 */
async function planFromAgent(
  root: string,
  selected: { name: AgentName; executable: string },
  prompt: string,
  execution: DocumentationPlanExecution,
  project: Awaited<ReturnType<typeof loadProject>>,
): Promise<unknown> {
  let lastError: unknown
  for (const attempt of [0, 1]) {
    const text = attempt === 0 ? prompt : `${prompt}

Your previous reply could not be read as a documentation plan: ${lastError instanceof Error ? lastError.message : String(lastError)}

Send the plan again as one complete, strictly valid JSON object inside the <doxloop-plan> block. Check that every brace and bracket is balanced and that the block contains only that object.`
    const prepared = await prepareAgentPrompt(root, text)
    let output = ''
    try {
      output = await runAgentForPlan(root, selected, prepared.argument, execution, project)
    } finally {
      if (prepared.path) {
        const { rm } = await import('node:fs/promises')
        await rm(prepared.path, { force: true })
      }
    }
    try {
      return extractPlanOutput(output, selected.name, text)
    } catch (error) {
      lastError = error
      if (attempt === 1) throw error
      emitWorkflowStage('building-coverage', 'Retrying an unreadable plan reply', 'running')
    }
  }
  throw lastError
}

export const DEFAULT_PLANNING_TIMEOUT_MINUTES = 20

/**
 * How long a planning agent may run before Doxloop stops it. The environment
 * variable wins over the project budget so a CI job can tighten or relax it
 * without editing the project.
 */
export function planningTimeoutMinutes(project: Pick<DoxloopProject, 'sync'>, env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.DOXLOOP_PLAN_TIMEOUT_MINUTES
  if (raw !== undefined && raw.trim() !== '') {
    const parsed = Number(raw)
    if (Number.isFinite(parsed) && parsed > 0) return parsed
  }
  return project.sync.budget?.maxMinutes ?? DEFAULT_PLANNING_TIMEOUT_MINUTES
}

export function planningTimeoutMessage(minutes: number, agent: string): string {
  return `Planning stopped after ${formatMinutes(minutes)} without a plan reply from ${agent}. Increase the plan time limit and, if configured, the monitoring time budget, then retry planning. DOXLOOP_PLAN_TIMEOUT_MINUTES can impose an additional planning limit.`
}

function formatMinutes(minutes: number): string {
  if (Number.isInteger(minutes)) return `${minutes} minute${minutes === 1 ? '' : 's'}`
  const seconds = Math.round(minutes * 60)
  return seconds < 60 ? `${seconds} second${seconds === 1 ? '' : 's'}` : `${Math.round(minutes * 10) / 10} minutes`
}

async function runAgentForPlan(
  root: string,
  selected: { name: AgentName; executable: string },
  prompt: string,
  execution: DocumentationPlanExecution,
  project: Awaited<ReturnType<typeof loadProject>>,
): Promise<string> {
  const screenshotIntent = normalizeScreenshotIntent(execution.screenshots)
  // Planning explores the signed-in application read-only, so it gets the
  // same session and credentials the authoring run will use.
  const captureMaterial = screenshotIntent !== 'disabled' && project.application
    ? await prepareCaptureAuth(root)
    : undefined
  const captureProvider = screenshotIntent !== 'disabled' && project.application
    ? screenCaptureProvider(root, project.application, captureMaterial)
    : undefined
  if (captureProvider && selected.name === 'gemini') await writeGeminiCaptureSettings(root, captureProvider)
  const args = agentArguments(selected.name, prompt, {
    mode: 'review',
    ...(execution.model ? { model: execution.model } : {}),
    ...(execution.reasoning ? { reasoning: execution.reasoning } : {}),
    ...(execution.effort ? { effort: execution.effort } : {}),
    ...(project.sync.budget?.maxUsd ? { maxBudgetUsd: project.sync.budget.maxUsd } : {}),
    sourceDirectories: sourceAccessDirectories(root, project.sources),
    ...(captureProvider ? { captureProvider } : {}),
    captureRequired: screenshotIntent === 'enabled',
  })
  const timeoutMinutes = Math.min(planningTimeoutMinutes(project), batchLimits(execution.limits).maxMinutes)
  return new Promise<string>((resolveOutput, reject) => {
    const agent = spawnAgentProcess(selected.executable, args, {
      cwd: root,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      isolate: true,
    })
    const { child } = agent
    // The raw stream is kept for plan extraction; the reader sees the same
    // one-line activity summaries the authoring run shows.
    const formatter = createAgentLogFormatter(selected.name)
    let stdout = ''
    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout += chunk.toString()
      for (const line of formatter.push(chunk)) process.stdout.write(`${line}\n`)
    })
    child.stdout?.once('end', () => {
      for (const line of formatter.finish()) process.stdout.write(`${line}\n`)
    })
    child.stderr?.on('data', (chunk: Buffer | string) => process.stderr.write(chunk.toString()))
    // A planner that never answers used to run until someone noticed; the
    // budget turns that into a named failure the reviewer can act on.
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      process.stderr.write(`Stopping ${selected.name} planning after ${formatMinutes(timeoutMinutes)}.\n`)
      void agent.stop()
    }, timeoutMinutes * 60_000)
    timer.unref?.()
    const stopForwarding = forwardTerminationSignals(agent, { label: `${selected.name} planning` })
    void agent.exited.then(async (exit) => {
      clearTimeout(timer)
      stopForwarding()
      await captureMaterial?.cleanup()
      if (exit.error) reject(exit.error)
      else if (timedOut) reject(new DoxloopError(planningTimeoutMessage(timeoutMinutes, selected.name)))
      else if (exit.signal) reject(new DoxloopError(`${selected.name} planning was stopped by ${exit.signal}.`))
      else if (exit.code !== 0) reject(new DoxloopError(`${selected.name} planning exited with status ${exit.code ?? 1}.`))
      else resolveOutput(stdout)
    })
  })
}

export function screenshotPlanningInstructions(): string {
  return `Doxloop supplies the purpose-built doxloop_capture MCP browser for this run. It is the capture connector required by this task and must take precedence over any generic in-app Browser plugin, Chrome extension, or node_repl browser mechanism. Call the doxloop_capture navigation and snapshot tools directly before deciding visual states; do not use failure of another browser mechanism as evidence that Doxloop capture is unavailable. Do not save PNG files during planning. Plan from states that are actually visible in the live application; do not invent fixture data, authenticated state, prepared plans, proposals, or controls merely because source code or tests mention them.
Explore the application before you decide what is visible. Many control centers are single-page applications where every screen shares one URL, so the absence of a second route is never evidence that a screen is unreachable. Use read-only interaction to reveal screens: follow in-app navigation, tabs, steps, accordions, disclosure controls, and detail panels, and snapshot each distinct screen you reach. Interaction that only reveals an existing screen is safe and expected. Do not submit, create, delete, deploy, publish, send, or otherwise change data, and back out of any control that would. Record a state as unavailable only after you actually attempted to reach it, and say which control or screen stopped you.
Screenshot readiness, authentication, fixture data, routes, and application preparation are run preconditions—not documentation-scope decisions. Never add a plan question solely about preparing, restarting, signing in to, or populating the capture application. If a desired state is not visibly available after you tried to reach it through in-app navigation, omit that state and use another evidence-supported, reachable state; do not trigger a second planning pass to ask the user to manufacture it.
Plan screenshots only for visible application workflows where an image materially reduces ambiguity or proves an important state. Never plan decorative screenshots for API, CLI, concept, or reference-only pages. For a UI guide, plan one capture for every reader step that changes what is on screen: the entry screen, each dialog, drawer, tab, expanded section, or form the step opens, the form once it is filled with safe example values, and the visible result or confirmation. Readers follow a guide screen by screen, so a guide whose steps open four screens plans four captures. A primary how-to guide therefore normally plans 4–7 captures and a tutorial 5–8; plan fewer only when the application genuinely exposes fewer distinct states and say so in the workflow. When intent is disabled, every page must use visuals.mode "none". When intent is enabled, cover the visible UI surface in proportion to it: every planned page that documents a screen or workflow you actually reached needs its own screenshot-enabled guide marked "required". One guide is enough only when the application genuinely exposes one screen; planning a single capture for an application whose screens you did not attempt to reach is a failed plan, not a conservative one. In automatic mode, use "recommended" only when the project policy and user request allow capture. Treat the user-provided route as the default boundary; specialize it per guide only when the live application, configured source routes, or UI tests provide evidence. Every screenshot-enabled page must identify an application-relative startPath, a specific ordered workflow, and an explicit captureSequence covering meaningful visible states from entry through verification. Each capture-sequence item must be a state that looks different from the one before it — a different screen, an opened dialog, an expanded section, a filled form, or a result. Scrolling, focusing a field, hovering, or merely inspecting part of a screen that is already visible is not a new state and must never be its own capture item, because it produces an identical image and Doxloop consolidates it away. When a guide's workflow only ever shows one screen, plan one capture for it rather than padding the sequence to a larger number.`
}

function planningPrompt(
  project: Awaited<ReturnType<typeof loadProject>>,
  current: DocumentationPlan,
  discovery: DocumentationDiscoveryInventory,
  changes: string,
  feedback?: string,
  reviewerGuidance = 'No prior reviewer preferences have been recorded.',
  captureAuth: CaptureAuthMode = 'none',
): string {
  const targetPagesText = current.targetPages
    ? ` The reviewer requires at least ${Math.min(current.targetPages, batchLimits(current.execution.limits).maxPages)} pages to write (create or update). Reach that count with distinct, evidence-backed reader jobs — split large workflows, reference surfaces, and concept areas into focused pages rather than padding — and record a "Scope exception:" exclusion only if the configured evidence genuinely cannot support that many distinct pages.`
    : ''
  const initialRequest = current.mode === 'create'
    ? `Propose a ${current.scope} documentation plan for this create request.${targetPagesText} HARD BATCH LIMITS: ${JSON.stringify(batchLimits(current.execution.limits))}. Defer other work with priority later. These maxima override scope size recommendations.`
    : `Propose a focused documentation plan for this update request. Let the requested change and existing documentation determine its size.${targetPagesText} HARD BATCH LIMITS: ${JSON.stringify(batchLimits(current.execution.limits))}. Defer other work with priority later.`
  const revision = feedback
    ? `Revise the existing plan below according to the user's feedback. Preserve good decisions that the feedback does not affect.\n\nUser feedback:\n${feedback}\n\nExisting plan:\n${JSON.stringify(current, null, 2)}`
    : `${initialRequest}\n\nUser request:\n${current.request || 'Use the configured evidence and documentation brief to recommend the right documentation.'}`
  const screenshotIntent = normalizeScreenshotIntent(current.execution.screenshots)
  const screenshotPolicy = project.application?.screenshots?.policy ?? 'requested'
  return `You are the planning stage of Doxloop. Research the configured product evidence and existing documentation, then return a complete documentation coverage plan. Do not edit any file, do not author reader-facing documentation, and do not ask questions in prose.

${revision}

Project configuration:
${JSON.stringify(project, null, 2)}

Application screenshot decision:
- Run intent: ${screenshotIntent}
- Project policy: ${screenshotPolicy}
- Application capture surface: ${project.application ? project.application.baseUrl : 'not configured'}
- User-provided default starting route: ${project.application?.screenshots?.startPath ?? 'not provided'}
- User-provided capture workflow: ${project.application?.screenshots?.workflow ?? 'not provided'}
- Sign-in handling: ${project.application ? captureAuthPrompt(captureAuth) : 'not applicable'}
${screenshotPlanningInstructions()}

Generator-neutral planning target (the adapter owns these navigation boundaries):
${JSON.stringify(current.target, null, 2)}

Deterministic source discovery (trusted inventory produced by Doxloop; agent inferences must remain distinguishable):
${formatDiscoveryInventory(discovery)}

Deterministic source-change summary:
${changes}
${templateInstructions(current)}
Durable reviewer preferences from prior revisions, rejections, and inline edits. Apply them only when they remain compatible with current evidence and this request:
${reviewerGuidance}

End your reply with exactly one machine-readable block and put nothing after it. Do not use Markdown fences inside the block, and never emit this block around an example, a file you read, or anything other than your final plan:
<doxloop-plan>
{ the single JSON object described below }
</doxloop-plan>

The JSON object must use this exact shape:
{
  "productProfile": "short evidence-grounded product classification",
  "summary": "what this plan accomplishes and why",
  "audiences": ["specific reader groups"],
  "outcomes": ["concrete reader outcomes"],
  "terminology": { "preferred term": "meaning or replacement guidance" },
  "exclusions": ["explicitly out-of-scope topics"],
  "instructions": "cross-page authoring and style guidance",
  "experienceLevel": "beginner | intermediate | advanced | mixed",
  "preferredExamples": ["TypeScript", "curl", "other evidence-supported preferences"],
  "locale": "BCP 47 locale",
  "accessibilityTarget": "accessibility requirement",
  "styleGuide": "style guide identifier",
  "capabilities": [{
    "id": "stable-kebab-id",
    "title": "public capability or reader workflow",
    "kind": "workflow | api | command | configuration | concept | operation",
    "evidence": [{ "source": "configured source", "path": "source-relative path", "kind": "discovery kind", "label": "symbol, route, operation, or file", "line": 1 }],
    "pageIds": ["planned-page-id"],
    "disposition": "planned | existing | excluded | needs-human"
  }],
  "navigation": {
    "top": ["Documentation", "Reference"],
    "sections": [{ "id": "getting-started", "title": "Getting started", "pageIds": ["planned-page-id"] }]
  },
  "estimatedEffort": "small | medium | large",
  "estimatedPages": 8,
  "pages": [{
    "id": "stable-kebab-id",
    "title": "Page title",
    "path": "generator-neutral/page-slug",
    "type": "getting-started | concept | how-to | tutorial | reference | troubleshooting | release | other",
    "priority": "must-have | next",
    "action": "create | update | preserve | remove",
    "purpose": "reader outcome for this page",
    "rationale": "why evidence and reader needs justify it",
    "evidence": ["configured source name plus relevant file, symbol, route, or spec operation"],
    "evidenceDetails": [{ "source": "configured source", "path": "source-relative path", "kind": "discovery kind", "label": "symbol, route, operation, or file", "line": 1 }],
    "visuals": { "mode": "none | recommended | required", "rationale": "what reader ambiguity or visible outcome the captures resolve", "estimatedCaptures": 0, "startPath": "/application-relative/start", "workflow": "ordered actions and safe fixture assumptions", "captureSequence": ["Reader action — expected stable visible state — why this image helps"] },
    "diagram": "required | none"
  }],
  "questions": [{
    "id": "stable-kebab-id",
    "question": "one material question only",
    "whyItMatters": "decision affected by the answer",
    "recommendation": "safe default"
  }]
}

Rules:
- Plan only evidence-supported public behavior. Mark unknowns; never invent them.
- Audit the complete public product surface before choosing pages: package metadata and entry points; exported APIs, commands, routes, and configuration; installation and prerequisites; authentication and permissions; primary and advanced workflows; examples, tests, and integrations; errors, limits, recovery paths, and operational concerns.
- Enumerate concrete reader outcomes first, then ensure every evidence-supported outcome maps to at least one page. Put unsupported or intentionally omitted outcomes in exclusions.
- Treat deterministic discovery entries as trusted facts about what was found, while keeping your inferred grouping, audience relevance, and recommendations clearly in rationale. Every planned capability must map to pageIds, and every page to write must cite at least one configured source when sources are available.
- Produce a coherent generator-neutral navigation outline. Use the persisted target only to identify generator-native navigation boundaries; do not put generator-specific syntax in page paths or section IDs.
- Give each page one distinct reader job or reference purpose. Do not hide several substantial workflows inside a generic overview or quickstart merely to keep the plan small.
- Preserve useful existing pages during updates and identify their action explicitly.
- Generated starter pages are scaffolding, not useful existing documentation. Any existing page containing a \`doxloop:starter-page\` marker or starter-placeholder language must appear in the current plan with action \`update\` or \`remove\`; never preserve or leave it outside the plan.
- Use at most three questions, only when the answer materially changes scope or reader outcomes.
- Scope contract for starter: at least 3 pages to write, covering orientation, first success, and essential reference or troubleshooting when supported. Keep it deliberately small, but do not merge distinct reader jobs to stay under an arbitrary number.
- Scope contract for standard: at least 8 pages to write and no fixed upper limit — the evidence sets the size. Include overview, prerequisites or installation, quickstart, every primary workflow guide, necessary concepts, public reference or configuration, and troubleshooting. Add examples, integrations, errors, or limitations when evidence supports them. Give each primary workflow, screen, and reference surface its own page rather than compressing them to hit a small count.
- Scope contract for comprehensive: at least 12 pages to write and no fixed upper limit — the evidence sets the size. This is the default scope; use the deterministic public-surface inventory as the floor for coverage, not a ceiling. Cover every distinct evidence-supported public workflow, screen, command, and interface at useful depth, plus relevant concepts, examples, integrations, operations, security, errors, limits, troubleshooting, and lifecycle guidance. A product with many screens, commands, or configuration groups legitimately needs 40–80 pages; give each screen, command group, and configuration area its own page instead of compressing them into overviews.
- Page depth contract: plan pages that can be written to professional depth. A how-to or tutorial page needs a stated outcome, prerequisites, at least three ordered steps with observable results, verification, evidence-backed troubleshooting, and a next step. A reference page covers its complete public surface (every command, option, field, default, and error in scope). A concept page explains the model, its consequences, and links to the tasks it informs. The landing page orients every audience with cards to their first task. Do not plan a page whose evidence supports only a paragraph — merge it into a page that can be complete.
- Treat the persisted documentation brief's customInstructions as reader requirements when planning visuals and depth; for example, a request for a screenshot on every step means every planned UI guide captures each screen-changing step.
${current.mode === 'create'
    ? `- A ${current.scope} plan changes depth and priority, never factual grounding. Targets guide coverage and are not permission to create filler.`
    : '- Keep an update plan tightly bounded to the requested change and evidence-backed dependencies. Do not expand it to meet a page-count target.'}
- For an initial create plan, the minimum pages to create or update are 3 for starter, 7 for standard, and 12 for comprehensive. If the evidence genuinely supports fewer distinct pages, add a specific exclusion beginning with "Scope exception:" that states why the smaller plan is complete.
- Include only pages that belong to this documentation run. Do not include a future backlog, deferred pages, or "later" items in the plan.
- Paths are relative, portable, have no leading slash, and do not escape the documentation project.
- Every must-have page explains its rationale and expected evidence.
- Every page declares a visuals decision. Use zero for non-UI pages. For each screenshot-enabled page, plan a coherent visual story rather than a token image: orientation or entry state, important input or choice states, intermediate configuration or validation when useful, successful result, and verification or next action. A tutorial normally needs 5–8 captures, getting-started and primary how-to guides 4–7, and focused troubleshooting or secondary UI guides 3–5. Automatic/recommended capture may omit states that text makes unambiguous, but it should still normally plan 2–4 images. Never inflate the count with unchanged screens, decorative images, or every mouse click.
- Every screenshot-enabled page requires a startPath beginning with one slash, a specific workflow, and a captureSequence with exactly one concrete item per estimated capture in capture order. Each item must name the reader action, expected stable visible state, and why that image helps. Set estimatedCaptures to captureSequence.length. Pages with visuals.mode "none" use zero and empty capture details.
- The pages array must not be empty.
- Every page declares "diagram". Concept and architecture pages set "required" so the writer includes a Mermaid diagram of the model or lifecycle; task, reference, and release pages set "none" unless a diagram resolves real reader ambiguity.`
}

function generationRequest(plan: DocumentationPlan, reviewerGuidance: string): string {
  const screenshotIntent = normalizeScreenshotIntent(plan.execution.screenshots)
  const captureContract = screenshotIntent === 'enabled'
    ? 'Screenshots are required. Produce at least one verified, embedded capture for every screenshot-enabled guide and attempt every distinct approved state. Consolidate sequence items that resolve to the same unchanged screen instead of creating duplicate images. If an entire required guide cannot be captured, report the concrete blocker; do not silently substitute a text-only guide.'
    : screenshotIntent === 'auto'
      ? 'Screenshots are automatic and best-effort. Attempt the approved sequence with the Doxloop capture browser and capture every state you can verify. If a particular state is unavailable, retain complete text instructions and record that manifest step as text-only with a concrete reason; a candidate image is not a reason to fail otherwise valid documentation.'
      : 'Screenshots are disabled. Do not operate the application or create a screenshot manifest.'
  return `Implement the approved Doxloop documentation plan at .doxloop/documentation-plan.json exactly as approved.

Approved plan ID: ${plan.id}
Approved version: ${plan.version}
Approved hash: ${plan.approvedHash}

Treat the approved plan as a scope boundary. Create, update, preserve, or remove only the planned pages and the navigation, theme, evidence map, and supporting assets strictly required by those pages. Do not silently expand scope. If source research reveals useful work outside the plan, report it as a recommendation instead of implementing it. Resolve factual details from configured evidence and mark unsupported behavior rather than guessing.

For every screenshot-enabled page, follow the approved visuals.startPath, visuals.workflow, and visuals.captureSequence in order. ${captureContract} In .doxloop/screenshot-manifest.json, write capture as the JSON boolean true or false—never "required" or "recommended"—and set sequenceItem to the one-based approved capture-sequence item represented by each image. Use specific action, expectedState, and purpose text rather than abbreviations such as "Open /".

Write every planned page to professional depth. Read the authoring skill's page-depth reference and apply its contract for the page type: an outcome-led introduction; prerequisites; complete ordered steps with the exact labels, values, and observable result of each step; verification; evidence-backed troubleshooting; and a next step. Reference pages cover their whole public surface with complete tables. Concept pages carry a diagram or model and link to the tasks they inform. The landing page orients each audience with cards to a first task. Use the generator's native components — steps, tabs, callouts, cards, accordions, code groups, frames — where they make the page clearer. For every screenshot-enabled guide, put one captured image inside every step that changes the screen. Doxloop reports \`thin-page\` and \`thin-procedure\` warnings from its validation command; resolve every one on a planned page before finishing.

${planWritingRequirements(plan)}The finished workspace must contain no generated starter content. Replace every planned starter page completely and remove every \`doxloop:starter-page\` marker before validation. Do not report completion while the \`starter-content\` validation code remains.

Preserve applicable reviewer preferences below unless they conflict with the approved plan or current evidence:
${reviewerGuidance}`
}

/**
 * Fields that only a documentation plan carries. An agent transcript also
 * contains the skill references it read, whose fenced examples (a
 * `.doxloop/project.json`, an evidence map) parse as perfectly valid JSON.
 */
const PLAN_SIGNAL_KEYS = [
  'productProfile',
  'summary',
  'audiences',
  'outcomes',
  'capabilities',
  'navigation',
  'questions',
  'instructions',
  'experienceLevel',
  'estimatedPages',
  'estimatedEffort',
  'preferredExamples',
  'styleGuide',
]

function looksLikeDocumentationPlan(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const candidate = value as Record<string, unknown>
  // A plan lists planned pages as an array. An evidence map keys `pages` by
  // path, and a project manifest has no planned pages at all.
  if (Array.isArray(candidate.pages)) return true
  return PLAN_SIGNAL_KEYS.filter((key) => key in candidate).length >= 3
}

/**
 * Read one balanced `{...}` starting at `start`, ignoring braces inside JSON
 * strings. Each call starts fresh, so unbalanced braces or stray quotes in
 * surrounding prose cannot desynchronize a later candidate.
 */
function objectTextAt(text: string, start: number): string | undefined {
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < text.length; index += 1) {
    const character = text[index]!
    if (inString) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') inString = false
      continue
    }
    if (character === '"') inString = true
    else if (character === '{') depth += 1
    else if (character === '}') {
      depth -= 1
      if (depth === 0) return text.slice(start, index + 1)
    }
  }
  return undefined
}

/** Compare transcript text to prompt text without depending on re-wrapping. */
function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** Offsets where a JSON object plausibly begins, in document order. */
function objectStarts(text: string): number[] {
  const starts = new Set<number>()
  for (const match of text.matchAll(/(?:^|\n|```(?:json)?|<doxloop-plan>)[ \t\r]*\{/gi)) {
    starts.add(match.index + match[0].lastIndexOf('{'))
  }
  return [...starts].sort((left, right) => left - right)
}

/**
 * The last plan-shaped object in `text`; the answer follows what was quoted.
 * Also reports why the most plan-like candidate failed, so a malformed reply is
 * distinguishable from one that never contained a plan at all.
 */
function lastPlanIn(text: string, sent?: string): { plan?: unknown; defect?: string } {
  const starts = objectStarts(text)
  let defect: string | undefined
  for (let index = starts.length - 1; index >= 0; index -= 1) {
    const objectText = objectTextAt(text, starts[index]!)
    if (!objectText) continue
    // Agents echo their instructions. The shape template we sent is a valid,
    // plan-shaped object full of placeholders, so it must never be read as an
    // answer.
    if (sent && sent.includes(collapse(objectText))) continue
    try {
      const parsed = JSON.parse(objectText) as unknown
      if (looksLikeDocumentationPlan(parsed)) return { plan: parsed }
    } catch (error) {
      // Prose and templates fail here too; only report a candidate that was
      // clearly trying to be the plan.
      if (!defect && /"(?:pages|productProfile|capabilities)"\s*:/.test(objectText)) {
        defect = error instanceof Error ? error.message : String(error)
      }
    }
  }
  return defect ? { defect } : {}
}

/**
 * The agent's own final reply, read out of its machine-readable stream:
 * Claude's `result` event, Codex's completed `agent_message` items, and
 * Gemini's assistant `message` events. Undefined when the output is not a
 * stream, in which case the whole transcript is searched instead.
 */
export function agentReplyFromStream(raw: string, agent: AgentName): string | undefined {
  const events = raw.split(/\r?\n/).flatMap((line): Record<string, unknown>[] => {
    try {
      const value = JSON.parse(line) as unknown
      return value && typeof value === 'object' && !Array.isArray(value) ? [value as Record<string, unknown>] : []
    } catch {
      return []
    }
  })
  if (agent === 'claude') {
    const results = events.flatMap((event) => event.type === 'result' && typeof event.result === 'string' ? [event.result] : [])
    return results.at(-1)
  }
  if (agent === 'codex') {
    const messages = events.flatMap((event) => {
      const item = event.type === 'item.completed' && event.item && typeof event.item === 'object' ? event.item as Record<string, unknown> : undefined
      return item?.type === 'agent_message' && typeof item.text === 'string' ? [item.text] : []
    })
    return messages.length > 0 ? messages.join('\n') : undefined
  }
  const parts = events.flatMap((event) => event.type === 'message' && event.role === 'assistant' && typeof event.content === 'string' ? [event.content] : [])
  return parts.length > 0 ? parts.join('') : undefined
}

export function extractPlanOutput(raw: string, agent: AgentName, prompt?: string): unknown {
  const sent = prompt ? collapse(prompt) : undefined
  let candidate = raw.trim()
  const reply = agentReplyFromStream(candidate, agent)
  if (reply) candidate = reply
  // The agreed contract wins outright when the agent honors it. Otherwise fall
  // back to the whole transcript, which also contains the skill references the
  // agent read and the shape template it was given.
  const blocks = [...candidate.matchAll(/<doxloop-plan>\s*([\s\S]*?)\s*<\/doxloop-plan>/gi)]
    .flatMap((match) => (match[1] ? [match[1]] : []))
  let defect: string | undefined
  for (const text of [...blocks.reverse(), candidate]) {
    const result = lastPlanIn(text, sent)
    if (result.plan !== undefined) return result.plan
    defect ??= result.defect
  }
  throw new DoxloopError(
    defect
      ? `The planning agent returned a malformed documentation-plan JSON object (${defect}). Open the full log, then retry the plan.`
      : 'The planning agent did not return a valid documentation-plan JSON object. Open the full log, then retry the plan.',
  )
}

function normalizePlanShape(raw: unknown, base: DocumentationPlan): Pick<DocumentationPlan,
  'productProfile' | 'summary' | 'audiences' | 'outcomes' | 'terminology' | 'exclusions' |
  'instructions' | 'experienceLevel' | 'preferredExamples' | 'locale' | 'accessibilityTarget' |
  'styleGuide' | 'capabilities' | 'navigation' | 'estimatedPages' | 'estimatedEffort' |
  'pages' | 'questions' | 'scope'
> {
  const value = record(raw)
  const pagesRaw = Array.isArray(value.pages) ? value.pages : base.pages
  const pages = pagesRaw.map((page, index) => normalizePage(page, index)).filter((page) => page.priority !== 'later').map((page) =>
    normalizeScreenshotIntent(base.execution.screenshots) === 'disabled'
      ? { ...page, visuals: { mode: 'none' as const, rationale: 'Application screenshots are disabled for this run.', estimatedCaptures: 0 } }
      : page,
  )
  if (pages.length === 0) throw new DoxloopError('A documentation plan must contain at least one page for the current run.')
  const questionsRaw = Array.isArray(value.questions) ? value.questions : base.questions
  const questions = questionsRaw.slice(0, 3).map((question, index) => normalizeQuestion(question, index)).filter((question) =>
    normalizeScreenshotIntent(base.execution.screenshots) === 'disabled' || !isCapturePreparationQuestion(question),
  )
  const scope = scopeValue(value.scope) ?? base.scope
  const effort = value.estimatedEffort === 'small' || value.estimatedEffort === 'large' ? value.estimatedEffort : 'medium'
  const experienceLevel = experienceLevelValue(value.experienceLevel) ?? base.experienceLevel
  const estimatedPages = positiveInteger(value.estimatedPages) ?? pages.filter((page) => page.action === 'create' || page.action === 'update').length
  const capabilitiesRaw = Array.isArray(value.capabilities) ? value.capabilities : base.capabilities
  const knownPageIds = new Set(pages.map((page) => page.id))
  const capabilities = capabilitiesRaw.map((capability, index) => {
    const normalized = normalizeCapability(capability, index)
    return { ...normalized, pageIds: normalized.pageIds.filter((id) => knownPageIds.has(id)) }
  })
  const navigation = normalizeNavigation(value.navigation ?? base.navigation, pages)
  return {
    productProfile: textValue(value.productProfile) ?? base.productProfile,
    summary: requiredText(value.summary ?? base.summary, 'Plan summary'),
    audiences: stringList(value.audiences ?? base.audiences),
    outcomes: mergeRequiredOutcomes(base.outcomes, stringList(value.outcomes ?? base.outcomes)),
    terminology: stringRecord(value.terminology ?? base.terminology),
    exclusions: stringList(value.exclusions ?? base.exclusions),
    instructions: textValue(value.instructions) ?? base.instructions,
    experienceLevel,
    preferredExamples: stringList(value.preferredExamples ?? base.preferredExamples),
    locale: textValue(value.locale) ?? base.locale,
    accessibilityTarget: textValue(value.accessibilityTarget) ?? base.accessibilityTarget,
    styleGuide: textValue(value.styleGuide) ?? base.styleGuide,
    capabilities,
    navigation,
    estimatedPages,
    estimatedEffort: effort,
    pages,
    questions,
    scope,
  }
}

function isCapturePreparationQuestion(question: DocumentationPlanQuestion): boolean {
  const text = `${question.question} ${question.whyItMatters} ${question.recommendation ?? ''}`.toLowerCase()
  const concernsCapture = /\b(?:capture|screenshot|screen shot)\b/.test(text)
  const concernsPreparation = /\b(?:application|surface|route|path|workflow|state|fixture|synthetic|restart|prepare|populate|login|sign[ -]?in|authentication|non-production)\b/.test(text)
  return concernsCapture && concernsPreparation
}

function mergeRequiredOutcomes(required: string[], proposed: string[]): string[] {
  const seen = new Set<string>()
  return [...required, ...proposed].filter((outcome) => {
    const key = outcome.trim().toLowerCase()
    if (!key || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function initialCreatePlanCoverageIssue(
  plan: Pick<DocumentationPlan, 'pages' | 'exclusions' | 'capabilities'>,
  base: DocumentationPlan,
): string | undefined {
  if (base.mode !== 'create' || base.status !== 'planning') return undefined
  if (base.scope === 'custom' && !base.targetPages) return undefined
  if (base.discovery.publicSignals > 0 && plan.capabilities.length === 0) {
    return 'The create plan does not map the deterministic public-surface inventory into capabilities. Add evidence-backed capabilities and map each one to planned pages, an existing page, an explicit exclusion, or a needs-human decision.'
  }
  const unmappedCapabilities = plan.capabilities.filter((capability) =>
    (capability.disposition === 'planned' || capability.disposition === 'existing') && capability.pageIds.length === 0,
  )
  if (unmappedCapabilities.length > 0) {
    return `The create plan leaves ${unmappedCapabilities.length} public ${unmappedCapabilities.length === 1 ? 'capability' : 'capabilities'} unmapped. Map each to a page, mark it as an explicit exclusion, or request a human decision.`
  }
  const pagesWithoutEvidence = plan.pages.filter((page) =>
    (page.action === 'create' || page.action === 'update') && page.evidence.length === 0 && page.evidenceDetails.length === 0,
  )
  if (base.discovery.publicSignals > 0 && pagesWithoutEvidence.length > 0) {
    return `The create plan has ${pagesWithoutEvidence.length} ${pagesWithoutEvidence.length === 1 ? 'page' : 'pages'} without source evidence. Map every page to write to at least one configured source.`
  }
  const scopeMinimum = base.scope === 'starter' ? 3 : base.scope === 'standard' ? 7 : base.scope === 'comprehensive' ? 12 : 1
  const minimum = Math.min(batchLimits(base.execution.limits).maxPages, Math.max(scopeMinimum, base.targetPages ?? 0))
  const pagesToWrite = plan.pages.filter((page) => page.action === 'create' || page.action === 'update').length
  if (pagesToWrite >= minimum) return undefined
  if (plan.exclusions.some((exclusion) => /^scope exception:\s+\S/i.test(exclusion))) return undefined
  const requirement = base.targetPages && base.targetPages > scopeMinimum
    ? `The reviewer asked for at least ${base.targetPages} pages to write.`
    : `It needs at least ${minimum} distinct evidence-supported pages.`
  return `The ${base.scope} create plan proposes only ${pagesToWrite} ${pagesToWrite === 1 ? 'page' : 'pages'} to write. ${requirement} Split the public surface into more focused, evidence-backed pages, or add a specific "Scope exception:" exclusion explaining why the configured product evidence cannot support that depth.`
}

export function requiredScreenshotPlanIssue(
  plan: Pick<DocumentationPlan, 'pages'>,
  execution: DocumentationPlanExecution,
): string | undefined {
  if (normalizeScreenshotIntent(execution.screenshots) !== 'enabled') return undefined
  const executablePages = plan.pages.filter((page) => page.priority !== 'later')
  const visualPages = executablePages.filter((page) => page.visuals && page.visuals.mode !== 'none')
  if (visualPages.length === 0) {
    return 'Required screenshot mode needs at least one complete screenshot-enabled visible UI guide; the proposal planned no application screenshots.'
  }
  const downgraded = visualPages.filter((page) => page.visuals?.mode !== 'required')
  if (downgraded.length > 0) {
    return `Required screenshot mode cannot use best-effort visuals. Mark ${downgraded.map((page) => `"${page.title}"`).join(', ')} as required.`
  }
  const incomplete = visualPages.filter((page) =>
    !page.visuals?.rationale.trim() ||
    page.visuals.estimatedCaptures < 1 ||
    !validCaptureStartPath(page.visuals.startPath) ||
    !page.visuals.workflow?.trim() ||
    page.visuals.workflow.trim().length < 12 ||
    !completeCaptureSequence(page.visuals.captureSequence, page.visuals.estimatedCaptures),
  )
  if (incomplete.length > 0) {
    const details = incomplete.map((page) => {
      const reasons: string[] = []
      if (!page.visuals?.rationale.trim()) reasons.push('missing purpose')
      if (!validCaptureStartPath(page.visuals?.startPath)) reasons.push(`invalid start path ${JSON.stringify(page.visuals?.startPath ?? '')}; use one leading slash, never //`)
      if (!page.visuals?.workflow?.trim() || page.visuals.workflow.trim().length < 12) reasons.push('missing ordered workflow')
      const sequenceItems = page.visuals?.captureSequence?.length ?? 0
      if (!completeCaptureSequence(page.visuals?.captureSequence, page.visuals?.estimatedCaptures ?? 0)) reasons.push(`planned ${page.visuals?.estimatedCaptures ?? 0} images but supplied ${sequenceItems} complete capture-sequence items`)
      return `"${page.title}": ${reasons.join('; ')}`
    })
    return `Required screenshot guides are incomplete. ${details.join('. ')}.`
  }
  return undefined
}

/**
 * Thin screenshot coverage, reported for human review rather than enforced. One
 * guide covering several documented workflows usually means the planner only
 * ever saw the application's entry screen — but an application parked on its
 * first-run state genuinely has nothing else to show, and failing the plan for
 * that would leave the reviewer with no way forward.
 */
/** Fewer captures than this on a procedural guide means steps were skipped. */
export const MINIMUM_GUIDE_CAPTURES = 3

function singleScreenWorkflow(workflow: string | undefined, rationale: string | undefined): boolean {
  return /\b(?:single|one|only one|a single)[ -](?:screen|state|view|page)\b|\bno (?:other|further|additional) (?:reachable )?(?:screen|state)/i.test(`${workflow ?? ''} ${rationale ?? ''}`)
}

/**
 * A procedural guide that plans one or two captures almost always skipped the
 * dialogs and forms its own steps open. The planner gets one corrective pass
 * and the reviewer sees the advisory; it never fails the plan, because an
 * application parked on a single screen has nothing more to show.
 */
export function shallowCaptureAdvisory(
  plan: Pick<DocumentationPlan, 'pages'>,
  execution: DocumentationPlanExecution,
): string | undefined {
  if (normalizeScreenshotIntent(execution.screenshots) === 'disabled') return undefined
  const shallow = plan.pages.filter((page) =>
    page.priority !== 'later' &&
    page.visuals && page.visuals.mode !== 'none' &&
    ['how-to', 'tutorial', 'getting-started'].includes(page.type) &&
    page.visuals.estimatedCaptures < MINIMUM_GUIDE_CAPTURES &&
    !singleScreenWorkflow(page.visuals.workflow, page.visuals.rationale),
  )
  if (shallow.length === 0) return undefined
  const counts = shallow.map((page) => `"${page.title}" plans ${page.visuals!.estimatedCaptures} capture${page.visuals!.estimatedCaptures === 1 ? '' : 's'}`).join('; ')
  return `Screenshot guides look too shallow: ${counts}. A UI guide captures every step that changes what is on screen — the entry state, each dialog, drawer, tab, or section a step opens, the filled form, and the result — so a guide normally plans at least ${MINIMUM_GUIDE_CAPTURES}. Add the missing states, or state in the guide's workflow that it is a single screen with no further reachable state.`
}

export function screenshotCoverageAdvisory(
  plan: Pick<DocumentationPlan, 'pages'>,
  execution: DocumentationPlanExecution,
): string | undefined {
  if (normalizeScreenshotIntent(execution.screenshots) !== 'enabled') return undefined
  const executablePages = plan.pages.filter((page) => page.priority !== 'later')
  const visualPages = executablePages.filter((page) => page.visuals && page.visuals.mode !== 'none')
  const procedural = executablePages.filter((page) =>
    ['how-to', 'tutorial', 'getting-started'].includes(page.type) &&
    (page.action === 'create' || page.action === 'update'),
  )
  if (visualPages.length === 0 || procedural.length < 2 || visualPages.length >= 2) return undefined
  return `Only ${visualPages.length} of ${procedural.length} procedural pages has application screenshots. If the application should show more, it was probably sitting on its initial or empty state while planning ran: open the screens you want documented — sign in, select a workspace, or load example data — and plan again. Otherwise approve this plan and the remaining pages stay text-first.`
}

function normalizePage(raw: unknown, index: number): DocumentationPlanPage {
  const page = record(raw)
  const title = requiredText(page.title, `Page ${index + 1} title`)
  const path = requiredText(page.path, `Page ${index + 1} path`).replaceAll('\\', '/').replace(/^\/+/, '')
  if (!path || path.split('/').includes('..')) throw new DoxloopError(`Page path "${path}" is not a safe relative path.`)
  const priority: DocumentationPlanPagePriority = page.priority === 'next' || page.priority === 'later' ? page.priority : 'must-have'
  const action: DocumentationPlanPageAction = page.action === 'update' || page.action === 'preserve' || page.action === 'remove' ? page.action : 'create'
  const evidence = stringList(page.evidence)
  const evidenceDetails = Array.isArray(page.evidenceDetails)
    ? page.evidenceDetails.map(normalizeEvidence).filter((item): item is DocumentationPlanEvidence => item !== undefined)
    : evidence.map(evidenceFromLegacyText).filter((item): item is DocumentationPlanEvidence => item !== undefined)
  const visualsRaw = record(page.visuals)
  const visualMode = visualsRaw.mode === 'required' || visualsRaw.mode === 'recommended' ? visualsRaw.mode : 'none'
  const pageType = textValue(page.type) ?? 'other'
  const captureSequence = visualMode === 'none' ? [] : stringList(visualsRaw.captureSequence)
  const minimumCaptures = minimumPlannedCaptures(pageType, visualMode)
  const requestedCaptures = positiveInteger(visualsRaw.estimatedCaptures) ?? 0
  const estimatedCaptures = visualMode === 'none'
    ? 0
    : Math.min(20, captureSequence.length > 0 ? captureSequence.length : Math.max(minimumCaptures, requestedCaptures))
  const diagram: DocumentationPlanDiagram = page.diagram === 'required' || page.diagram === 'none'
    ? page.diagram
    : pageType.trim().toLowerCase() === 'concept' ? 'required' : 'none'
  return {
    id: safeId(textValue(page.id) ?? title, `page-${index + 1}`),
    title,
    path,
    type: pageType,
    priority,
    action,
    purpose: requiredText(page.purpose, `Page ${index + 1} purpose`),
    rationale: textValue(page.rationale) ?? '',
    evidence,
    evidenceDetails,
    diagram,
    visuals: {
      mode: visualMode,
      rationale: textValue(visualsRaw.rationale) ?? (visualMode === 'none' ? 'No meaningful visible application state is needed for this page.' : ''),
      estimatedCaptures,
      ...(visualMode !== 'none' && textValue(visualsRaw.startPath) ? { startPath: textValue(visualsRaw.startPath)! } : {}),
      ...(visualMode !== 'none' && textValue(visualsRaw.workflow) ? { workflow: textValue(visualsRaw.workflow)! } : {}),
      ...(captureSequence.length > 0 ? { captureSequence: captureSequence.slice(0, 20) } : {}),
    },
  }
}

function minimumPlannedCaptures(type: string, mode: DocumentationPlanVisuals['mode']): number {
  if (mode === 'none') return 0
  const recommended = mode === 'recommended'
  switch (type.trim().toLowerCase()) {
    case 'tutorial': return recommended ? 4 : 5
    case 'getting-started': return recommended ? 3 : 4
    case 'how-to': return recommended ? 3 : 4
    case 'troubleshooting': return recommended ? 2 : 3
    default: return recommended ? 2 : 3
  }
}

function completeCaptureSequence(sequence: string[] | undefined, expected: number): boolean {
  if (!sequence || sequence.length !== expected) return false
  const normalized = sequence.map((item) => item.trim().toLowerCase())
  return sequence.every((item) => item.trim().length >= 20) && new Set(normalized).size === sequence.length
}

function validCaptureStartPath(value: string | undefined): boolean {
  if (!value?.trim() || !value.startsWith('/') || value.startsWith('//')) return false
  try {
    const parsed = new URL(value, 'https://capture.invalid')
    return parsed.origin === 'https://capture.invalid' && !parsed.username && !parsed.password && !parsed.hash
  } catch {
    return false
  }
}

async function assertCapturePlanReady(
  root: string,
  application: Awaited<ReturnType<typeof loadProject>>['application'],
  pages: DocumentationPlanPage[],
): Promise<void> {
  const auth = await captureAuthContext(root)
  const readiness = await checkApplicationReadiness(application, auth)
  if (!readiness.reachable) throw new DoxloopError(readiness.message)
  const routes = await Promise.all(pages.map(async (page) => {
    const startPath = page.visuals?.startPath
    if (!startPath || !validCaptureStartPath(startPath)) {
      throw new DoxloopError(`Screenshot starting route for "${page.title}" is missing or invalid.`)
    }
    return {
      page,
      readiness: await checkApplicationReadiness(application ? { ...application, readyPath: startPath } : undefined, auth),
    }
  }))
  const unavailable = routes.find((route) => !route.readiness.reachable)
  if (unavailable) {
    throw new DoxloopError(`Screenshot starting route for "${unavailable.page.title}" is not ready. ${unavailable.readiness.message}`)
  }
}

function normalizeCapability(raw: unknown, index: number): DocumentationPlanCapability {
  const capability = record(raw)
  const title = requiredText(capability.title, `Capability ${index + 1} title`)
  const disposition = capability.disposition === 'existing' || capability.disposition === 'excluded' || capability.disposition === 'needs-human'
    ? capability.disposition
    : 'planned'
  return {
    id: safeId(textValue(capability.id) ?? title, `capability-${index + 1}`),
    title,
    kind: textValue(capability.kind) ?? 'workflow',
    evidence: Array.isArray(capability.evidence)
      ? capability.evidence.map(normalizeEvidence).filter((item): item is DocumentationPlanEvidence => item !== undefined)
      : [],
    pageIds: stringList(capability.pageIds),
    disposition,
  }
}

function normalizeNavigation(raw: unknown, pages: DocumentationPlanPage[]): DocumentationPlan['navigation'] {
  const navigation = record(raw)
  const sectionsRaw = Array.isArray(navigation.sections) ? navigation.sections : []
  const knownPageIds = new Set(pages.map((page) => page.id))
  const sections = sectionsRaw.map((rawSection, index) => {
    const section = record(rawSection)
    const title = textValue(section.title) ?? `Section ${index + 1}`
    return {
      id: safeId(textValue(section.id) ?? title, `section-${index + 1}`),
      title,
      pageIds: stringList(section.pageIds).filter((id) => knownPageIds.has(id)),
    }
  }).filter((section) => section.pageIds.length > 0)
  if (sections.length === 0 && pages.length > 0) {
    const grouped = new Map<string, string[]>()
    for (const page of pages) grouped.set(page.type, [...(grouped.get(page.type) ?? []), page.id])
    for (const [type, pageIds] of grouped) sections.push({ id: safeId(type, 'documentation'), title: titleCase(type), pageIds })
  }
  return { top: stringList(navigation.top).length ? stringList(navigation.top) : ['Documentation'], sections }
}

function normalizeEvidence(raw: unknown): DocumentationPlanEvidence | undefined {
  const evidence = record(raw)
  const source = textValue(evidence.source)
  const path = textValue(evidence.path)
  if (!source || !path || path.split(/[\\/]/).includes('..')) return undefined
  return {
    source,
    path: path.replaceAll('\\', '/').replace(/^\/+/, ''),
    ...(textValue(evidence.kind) ? { kind: textValue(evidence.kind)! } : {}),
    ...(textValue(evidence.label) ? { label: textValue(evidence.label)! } : {}),
    ...(positiveInteger(evidence.line) ? { line: positiveInteger(evidence.line)! } : {}),
  }
}

function evidenceFromLegacyText(value: string): DocumentationPlanEvidence | undefined {
  const separator = value.indexOf(':')
  if (separator <= 0) return undefined
  const source = value.slice(0, separator).trim()
  const detail = value.slice(separator + 1).trim()
  if (!source || !detail) return undefined
  const path = detail.split(/\s+(?:plus|and|—|->)\s+/i)[0]?.trim() ?? detail
  return normalizeEvidence({ source, path, label: detail })
}

function normalizeQuestion(raw: unknown, index: number): DocumentationPlanQuestion {
  const question = record(raw)
  return {
    id: safeId(textValue(question.id) ?? `question-${index + 1}`, `question-${index + 1}`),
    question: requiredText(question.question, `Question ${index + 1}`),
    whyItMatters: textValue(question.whyItMatters) ?? '',
    ...(textValue(question.recommendation) ? { recommendation: textValue(question.recommendation)! } : {}),
  }
}

async function normalizePersistedPlan(root: string, raw: unknown, id: string): Promise<{ plan: DocumentationPlan; migrated: boolean }> {
  const plan = record(raw)
  if ((plan.schemaVersion !== 1 && plan.schemaVersion !== 2) || plan.id !== id || typeof plan.version !== 'number') {
    throw new DoxloopError(`Documentation plan ${id} is invalid.`)
  }
  if (plan.schemaVersion === 2) {
    if (!isPersistedPlanV2(plan)) throw new DoxloopError(`Documentation plan ${id} is invalid.`)
    return { plan: raw as DocumentationPlan, migrated: false }
  }
  const legacy = raw as Omit<DocumentationPlan, 'schemaVersion' | 'experienceLevel' | 'preferredExamples' | 'locale' | 'accessibilityTarget' | 'styleGuide' | 'capabilities' | 'navigation' | 'estimatedPages' | 'discovery' | 'target' | 'clarification'> & { schemaVersion: 1; pages: Array<Omit<DocumentationPlanPage, 'evidenceDetails'>> }
  const project = await loadProject(root)
  const pages = legacy.pages.map((page) => ({ ...page, evidenceDetails: page.evidence.map(evidenceFromLegacyText).filter((item): item is DocumentationPlanEvidence => item !== undefined) }))
  return {
    migrated: true,
    plan: {
      ...legacy,
      schemaVersion: 2,
      experienceLevel: project.documentation.experienceLevel ?? 'mixed',
      preferredExamples: [],
      locale: project.documentation.locale,
      accessibilityTarget: project.documentation.accessibilityTarget,
      styleGuide: project.documentation.styleGuide,
      capabilities: [],
      navigation: normalizeNavigation({}, pages),
      pages,
      estimatedPages: pages.filter((page) => page.action === 'create' || page.action === 'update').length,
      discovery: {
        cacheKey: legacy.sourceSnapshot,
        generatedAt: legacy.updatedAt,
        deterministic: true,
        publicSignals: 0,
        suggestedPages: {
          starter: Math.max(3, Math.min(5, pages.length)),
          standard: Math.max(7, pages.length),
          comprehensive: Math.max(12, pages.length),
        },
      },
      target: await documentationPlanTarget(root, project),
      clarification: { mode: 'review', answers: {} },
    },
  }
}

function isPersistedPlanV2(plan: Record<string, unknown>): boolean {
  const discovery = record(plan.discovery)
  const target = record(plan.target)
  const navigation = record(plan.navigation)
  return (
    typeof plan.id === 'string' &&
    typeof plan.version === 'number' &&
    typeof plan.status === 'string' &&
    typeof plan.scope === 'string' &&
    typeof plan.sourceSnapshot === 'string' &&
    Array.isArray(plan.audiences) &&
    Array.isArray(plan.outcomes) &&
    Array.isArray(plan.exclusions) &&
    Array.isArray(plan.preferredExamples) &&
    Array.isArray(plan.capabilities) &&
    Array.isArray(plan.pages) &&
    Array.isArray(plan.questions) &&
    typeof plan.experienceLevel === 'string' &&
    typeof plan.locale === 'string' &&
    typeof plan.accessibilityTarget === 'string' &&
    typeof plan.styleGuide === 'string' &&
    typeof plan.estimatedPages === 'number' &&
    Array.isArray(navigation.top) &&
    Array.isArray(navigation.sections) &&
    typeof discovery.cacheKey === 'string' &&
    discovery.deterministic === true &&
    typeof discovery.publicSignals === 'number' &&
    typeof target.generator === 'string' &&
    Array.isArray(target.pageExtensions) &&
    Array.isArray(target.navigationFiles) &&
    typeof record(plan.clarification).mode === 'string'
  )
}

async function persistPlan(root: string, plan: DocumentationPlan, archive: boolean): Promise<void> {
  const directory = join(root, PLANS_DIRECTORY, plan.id)
  await mkdir(join(directory, VERSIONS_DIRECTORY), { recursive: true })
  if (archive) {
    await atomicWrite(
      join(directory, VERSIONS_DIRECTORY, `v${plan.version}.json`),
      `${JSON.stringify(plan, null, 2)}\n`,
    )
  }
  await atomicWrite(join(directory, PLAN_FILE), `${JSON.stringify(plan, null, 2)}\n`)
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  await mkdir(dirname(path), { recursive: true })
  await writeFile(temporary, content, { encoding: 'utf8', mode: 0o600 })
  await rename(temporary, path)
}

function planHash(plan: DocumentationPlan): string {
  const { status: _status, updatedAt: _updatedAt, approvedAt: _approvedAt, approvedHash: _approvedHash, proposalId: _proposalId, error: _error, failure: _failure, ...content } = plan
  return createHash('sha256').update(JSON.stringify(content)).digest('hex')
}

function planPath(root: string, id: string): string {
  assertPlanId(id)
  return join(root, PLANS_DIRECTORY, id, PLAN_FILE)
}

function planId(): string {
  return `plan-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${randomBytes(3).toString('hex')}`
}

function assertPlanId(id: string): void {
  if (!/^plan-[a-z0-9-]+$/.test(id)) throw new DoxloopError('Invalid documentation plan ID.')
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}

function textValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value.trim() : undefined
}

function requiredText(value: unknown, label: string): string {
  const text = textValue(value)
  if (!text) throw new DoxloopError(`${label} is required.`)
  return text
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean))]
}

function stringRecord(value: unknown): Record<string, string> {
  const input = record(value)
  return Object.fromEntries(Object.entries(input).flatMap(([key, item]) => typeof item === 'string' && key.trim() && item.trim() ? [[key.trim(), item.trim()]] : []))
}

function scopeValue(value: unknown): DocumentationPlanScope | undefined {
  return value === 'starter' || value === 'standard' || value === 'comprehensive' || value === 'custom' ? value : undefined
}

function experienceLevelValue(value: unknown): DocumentationPlan['experienceLevel'] | undefined {
  return value === 'beginner' || value === 'intermediate' || value === 'advanced' || value === 'mixed' ? value : undefined
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined
}

function titleCase(value: string): string {
  return value.replaceAll('-', ' ').replace(/\b\w/g, (character) => character.toUpperCase())
}

function estimatedPagesForScope(scope: DocumentationPlanScope, discovery: DocumentationDiscoveryInventory): number {
  if (scope === 'starter') return discovery.suggestedPages.starter
  if (scope === 'comprehensive') return discovery.suggestedPages.comprehensive
  return discovery.suggestedPages.standard
}

function safeId(value: string, fallback: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || fallback
}
