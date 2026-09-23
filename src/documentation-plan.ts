import { UsageBudget, budgetContext, isAccountLimit } from './usage-budget.js'
import { preparePlanningCaptures } from './planning-captures.js'
import { assertBatchFits, batchLimits, defaultBatchLimits, hasPageLimit } from './batch-limits.js'
import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { AgentSessionError, agentFailureDetail } from './agent-failure.js'
import { codexUserMcpServers } from './agent-isolation.js'
import { AGENT_LOG_HEARTBEAT_MS, createAgentLogFormatter } from './agent-log.js'
import { readPlanOutput, readPlanPatchOutput, type PlanReply } from './agent-reply.js'
import { formatResearchBriefs, planningParallelism, researchCheckpointKey, researchCheckpointKeys, researchTasks, runResearch, savedResearchBriefs, stagedPlanningEnabled, type ResearchBrief } from './planning-research.js'
import { describeResearchScope, fullResearch, readTriageOutput, triageByRules, triagePrompt } from './planning-triage.js'
import { readNavigation } from './navigation.js'
import { readDocsSiteManifest } from './docs-site.js'
export { agentReplyFromStream, extractPlanOutput, readPlanOutput, type PlanReply } from './agent-reply.js'
import { forwardTerminationSignals, spawnAgentProcess } from './agent-process.js'
import { agentArguments, agentEnvironment, captureAuthPrompt, prepareAgentPrompt, sourceAccessDirectories, type ClaudeEffortLevel } from './author.js'
import { captureAuthContext, describeCaptureAuth, prepareCaptureAuth, type CaptureAuthMode } from './capture-auth.js'
import { chooseAgent } from './agents.js'
import { emitWorkflowStage } from './job-events.js'
import { writeExistingDocumentationRedirects } from './docs-site.js'
import { computeDrift } from './drift.js'
import { DoxloopError } from './errors.js'
import { pathExists } from './fs.js'
import { documentationPlanTarget } from './plan-generator.js'
import { loadProject } from './project.js'
import { reviewPreferenceGuidance } from './review-learning.js'
import { collectReleaseInventory, formatReleaseInventory, releaseNotesPagePath, type ReleaseTemplateInput } from './release-notes.js'
import { assertScreenshotPlanningReadiness, checkApplicationReadiness, normalizeScreenshotIntent, screenshotPlanSummary } from './screenshot-workflow.js'
import { checkScreenCaptureBrowser, screenCaptureProvider, writeGeminiCaptureSettings } from './screen-capture-provider.js'
import { discoverDocumentationSources, discoveryGuidance, formatDiscoveryInventory, type DocumentationDiscoveryInventory } from './source-discovery.js'
export { discoveryGuidance } from './source-discovery.js'
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
  ExistingDocumentationAssessment,
  ExistingDocumentationDisposition,
  ExistingDocumentationFinding,
  ExistingDocumentationPageDisposition,
  SourceBinding,
  SyncRun,
} from './types.js'
import { assignSectionSpaces } from './plan-navigation.js'

export { assignSectionSpaces }

const PLANS_DIRECTORY = join('.doxloop', 'plans')
const CURRENT_PLAN_FILE = join('.doxloop', 'documentation-plan.json')
const CAPTURE_WARNING_PREFIX = 'Screenshot warning:'
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
    execution: { ...input.execution, limits: batchLimits(input.execution.limits, defaultBatchLimits(input.scope, input.execution.screenshots !== 'disabled' && input.execution.screenshots !== false, input.targetPages)) },
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
  if (plan.status === 'failed' && plan.failure?.stage === 'generate' && plan.failure.proposalId) {
    const reconciled = await reconcileContinuedGeneration(root, plan, plan.failure.proposalId)
    if (reconciled) return reconciled
  }
  return plan
}

/**
 * A failed generation can be continued from the proposal itself: the
 * Proposals panel and `doxloop proposal resume` work on the run, not on the
 * plan that started it. When that continuation finished, the plan still said
 * failed and offered recovery for a proposal that was already awaiting review
 * or applied, and taking that offer failed with "Only a failed or interrupted
 * proposal can be recovered". Read the proposal's real state back into the
 * plan instead.
 */
async function reconcileContinuedGeneration(
  root: string,
  plan: DocumentationPlan,
  proposalId: string,
): Promise<DocumentationPlan | undefined> {
  let run: SyncRun
  try {
    run = await readSyncRun(root, proposalId)
  } catch {
    return undefined
  }
  if (run.status !== 'awaiting-review' && run.status !== 'applied') return undefined
  const { error: _error, failure: _failure, ...retained } = plan
  const generated: DocumentationPlan = { ...retained, status: 'generated', proposalId, updatedAt: new Date().toISOString() }
  await persistPlan(root, generated, false)
  return generated
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
  const captureWarnings = screenshotIntent === 'enabled' && visualPages.length > 0
    ? await capturePlanWarnings(root, (await loadProject(root)).application, visualPages)
    : []
  // Sources that changed since the proposal do not block approval. The reviewer
  // approved the structure, and generation inspects the current sources when
  // it writes each page, so a code edit made while the plan waited for review
  // only earns a note rather than a fresh planning run.
  const snapshot = await documentationSourceSnapshot(root)
  const sourcesChanged = snapshot !== current.sourceSnapshot
  // Warnings from an earlier approval attempt are replaced by this check's.
  const advisories = [
    ...(current.advisories ?? []).filter((item) => item !== SOURCES_CHANGED_ADVISORY && !item.startsWith(CAPTURE_WARNING_PREFIX)),
    ...(sourcesChanged ? [SOURCES_CHANGED_ADVISORY] : []),
    ...captureWarnings,
  ]
  const approvedAt = new Date().toISOString()
  const { error: _error, failure: _failure, advisories: _previousAdvisories, ...valid } = current
  const approvalContent: DocumentationPlan = {
    ...valid,
    pages: executablePages,
    navigation: { ...valid.navigation, sections: valid.navigation.sections.map((section) => ({ ...section, pageIds: section.pageIds.filter((id) => executablePages.some((page) => page.id === id && page.action !== 'remove')) })).filter((section) => section.pageIds.length > 0) },
    estimatedPages: executablePages.filter((page) => page.action !== 'preserve').length,
    sourceSnapshot: snapshot,
    ...(advisories.length > 0 ? { advisories } : {}),
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
  // Old routes of the existing documentation now point at the pages that
  // absorb them, so the preview and the Doxbrix build honor them once the
  // rewrite lands and the map can be exported for the old host.
  await writeExistingDocumentationRedirects(root, approved)
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

/**
 * Record that a planning or generation process ended without reporting a
 * result. A process that is killed, crashes, or is stopped from the UI never
 * reaches its own failure bookkeeping, and a plan left at "planning" offers
 * the reviewer nothing to retry. Returns the failed plan, or undefined when
 * the plan had already moved on.
 */
export async function markDocumentationPlanInterrupted(
  root: string,
  id: string,
  stage: DocumentationPlanFailure['stage'],
  message: string,
): Promise<DocumentationPlan | undefined> {
  let current: DocumentationPlan
  try {
    current = await readDocumentationPlan(root, id)
  } catch {
    return undefined
  }
  if (!['planning', 'revising', 'generating'].includes(current.status)) return undefined
  const failed: DocumentationPlan = {
    ...current,
    status: 'failed',
    updatedAt: new Date().toISOString(),
    error: message,
    failure: { stage, resumable: false, ignorable: false },
  }
  await persistPlan(root, failed, false)
  return failed
}

/** Restore only the durable state required to retry an interrupted UI stage. */
/** Run settings to change; a key present with `undefined` clears that setting. */
export interface ExecutionChange {
  agent?: DocumentationPlanExecution['agent'] | undefined
  model?: string | undefined
  reasoning?: DocumentationPlanExecution['reasoning'] | undefined
  effort?: DocumentationPlanExecution['effort'] | undefined
}

/**
 * Point a plan at another assistant, model, or effort before it runs again
 * (a retry after the pinned assistant signed out, or a switch in Settings).
 * An approved plan stays approved: the run settings are not the content the
 * reviewer approved, so the approval is re-stamped when it was still valid.
 */
export async function updateDocumentationPlanExecution(
  root: string,
  id: string,
  change: ExecutionChange,
): Promise<DocumentationPlan> {
  const current = await readDocumentationPlan(root, id)
  const execution: DocumentationPlanExecution = { ...current.execution }
  for (const key of ['agent', 'model', 'reasoning', 'effort'] as const) {
    if (!(key in change)) continue
    const value = change[key]
    if (value === undefined) delete execution[key]
    else (execution as unknown as Record<string, unknown>)[key] = value
  }
  if (JSON.stringify(execution) === JSON.stringify(current.execution)) return current
  const approvalValid = Boolean(current.approvedHash) && planHash(current) === current.approvedHash
  const next: DocumentationPlan = { ...current, execution, updatedAt: new Date().toISOString() }
  if (approvalValid) next.approvedHash = planHash(next)
  await persistPlan(root, next, false)
  return next
}

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
    // The approved plan is hashed, so warnings found now go to the run log.
    const warnings = await capturePlanWarnings(root, (await loadProject(root)).application, plan.pages.filter((page) => page.visuals && page.visuals.mode !== 'none'))
    for (const warning of warnings) process.stdout.write(`${warning}\n`)
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

const PROPOSAL_CHECKPOINT_FILE = 'proposal-checkpoint.json'

export interface ProposalCheckpoint {
  /** Fingerprint of everything the planner was asked; a different brief or source snapshot invalidates the checkpoint. */
  key: string
  /** Which planning pass produced the reply: the first proposal, or the corrective pass after failed gates. */
  pass: 'proposal' | 'revised'
  raw: unknown
  /** Deterministic fixes Doxloop applied to read the reply, surfaced on the plan review. */
  repairs?: string[]
  savedAt: string
}

/**
 * Fingerprint of a planning request. Two attempts with the same fingerprint
 * are asking the same question, so the agent's earlier reply can stand in for
 * a new one.
 */
export function proposalCheckpointKey(current: DocumentationPlan, sourceSnapshot: string, feedback?: string): string {
  return createHash('sha256')
    .update(JSON.stringify({
      id: current.id,
      version: current.version,
      mode: current.mode,
      scope: current.scope,
      request: current.request,
      targetPages: current.targetPages ?? null,
      execution: current.execution,
      clarification: current.clarification,
      sourceSnapshot,
      feedback: feedback ?? null,
    }))
    .digest('hex')
}

function proposalCheckpointPath(root: string, id: string): string {
  return join(root, PLANS_DIRECTORY, id, PROPOSAL_CHECKPOINT_FILE)
}

/**
 * Keep the agent's reply the moment it arrives. A planning run that is later
 * stopped by its time limit, a crash, or the user can then continue from
 * this reply instead of paying for the same planning pass again.
 */
export async function writeProposalCheckpoint(root: string, id: string, checkpoint: Omit<ProposalCheckpoint, 'savedAt'>): Promise<void> {
  await atomicWrite(proposalCheckpointPath(root, id), `${JSON.stringify({ ...checkpoint, savedAt: new Date().toISOString() }, null, 2)}\n`)
}

export async function readProposalCheckpoint(root: string, id: string, key: string): Promise<ProposalCheckpoint | undefined> {
  let text: string
  try {
    text = await readFile(proposalCheckpointPath(root, id), 'utf8')
  } catch {
    return undefined
  }
  try {
    const parsed = JSON.parse(text) as Partial<ProposalCheckpoint>
    if (parsed.key !== key || (parsed.pass !== 'proposal' && parsed.pass !== 'revised') || parsed.raw === undefined) return undefined
    const repairs = Array.isArray(parsed.repairs) ? parsed.repairs.filter((item): item is string => typeof item === 'string') : []
    return { key, pass: parsed.pass, raw: parsed.raw, ...(repairs.length > 0 ? { repairs } : {}), savedAt: typeof parsed.savedAt === 'string' ? parsed.savedAt : '' }
  } catch {
    return undefined
  }
}

export async function clearProposalCheckpoint(root: string, id: string): Promise<void> {
  await rm(proposalCheckpointPath(root, id), { force: true })
}

/**
 * How much research an update request needs. Deterministic rules decide the
 * clear cases; an ambiguous request gets one short session that reads
 * nothing and answers from the request and the page list; and when that
 * session fails the full research runs, which is never wrong, only slow.
 */
async function triageUpdateRequest(
  root: string,
  current: DocumentationPlan,
  selected: { name: AgentName; executable: string },
  project: Awaited<ReturnType<typeof loadProject>>,
  existingPages: readonly string[],
): Promise<NonNullable<DocumentationPlan['research']>> {
  const byRules = triageByRules(current.request, existingPages)
  if (byRules) return byRules
  emitWorkflowStage('building-coverage', 'Deciding how much research this update needs', 'running')
  const prompt = triagePrompt(current, existingPages)
  const prepared = await prepareAgentPrompt(root, prompt)
  try {
    const output = await runAgentForPlan(root, selected, prepared.argument, current.execution, project, { browser: false, label: 'triage', prefix: '[triage] ' })
    const decided = readTriageOutput(output, selected.name, existingPages, prompt)
    if (decided) return decided
    process.stdout.write('The triage session returned no usable decision; running the full research.\n')
  } catch (error) {
    process.stdout.write(`The triage session did not finish (${error instanceof Error ? error.message : String(error)}); running the full research.\n`)
  } finally {
    if (prepared.path) await rm(prepared.path, { force: true })
  }
  return fullResearch('The request could not be classified, so every research session runs.', 'agent')
}

/** The navigation as it stands, for a plan that changes only navigation. */
async function currentNavigationText(root: string): Promise<string> {
  try {
    const tree = await readNavigation(root)
    const compact = tree.spaces.map((space) => ({ name: space.name, ...(space.icon ? { icon: space.icon } : {}), nav: space.nav }))
    const support = tree.editable
      ? `The generator (${tree.generator}) keeps its navigation in ${tree.configFile}. It supports: ${Object.entries(tree.supports).filter(([, value]) => value).map(([name]) => name).join(', ') || 'pages and groups only'}.${tree.icons.length > 0 ? ` Icon names it can draw: ${tree.icons.join(', ')}.` : ' It cannot draw icons.'}`
      : `The generator (${tree.generator}) does not let Doxloop rewrite its navigation: ${tree.reason ?? ''}`
    return `${support}\n${JSON.stringify(compact)}${tree.orphans.length > 0 ? `\nPages in no navigation: ${tree.orphans.map((page) => page.path).join(', ')}` : ''}`
  } catch (error) {
    return `The navigation could not be read: ${error instanceof Error ? error.message : String(error)}`
  }
}

async function runPlanner(root: string, current: DocumentationPlan, feedback?: string): Promise<DocumentationPlan> {
  const project = await loadProject(root)
  const budget = await UsageBudget.open(root, current.id, project.sync.budget?.maxUsd)
  return budgetContext.run(budget, () => runPlannerWithBudget(root, current, feedback))
}

async function runPlannerWithBudget(
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
      try {
        await assertScreenshotPlanningReadiness(project.application, current.execution.screenshots, await captureAuthContext(root))
        const browserReadiness = await checkScreenCaptureBrowser()
        if (!browserReadiness.available) throw new DoxloopError(`Required screenshot planning cannot start. ${browserReadiness.message}`)
      } catch (error) {
        // A revision reuses the saved research briefs and never opens the
        // application, so an unreachable application is a warning for the
        // generate stage, not a reason to lose the reviewer's answers.
        if (!feedback) throw error
        process.stdout.write(`Screenshot check skipped for this revision: ${error instanceof Error ? error.message : String(error)} Screenshots are checked again before generation.\n`)
      }
    }
    const discovery = await discoverDocumentationSources(root)
    const changes = await collectSourceChanges(root, project.sources)
    emitWorkflowStage('inspecting-sources', 'Inspecting sources', 'completed')
    emitWorkflowStage('building-coverage', 'Building coverage plan', 'running')
    const selected = await chooseAgent(current.execution.agent)
    const sourceSnapshot = await documentationSourceSnapshot(root)
    const checkpointKey = proposalCheckpointKey(current, sourceSnapshot, feedback)
    const checkpoint = await readProposalCheckpoint(root, current.id, checkpointKey)
    const captureAuth = describeCaptureAuth(project.application ? await captureAuthContext(root) : undefined)
    const changesText = formatSourceChanges(changes)
    // Research runs as short sessions, several at a time, each returning a
    // brief; the plan is then written by one session that reads the briefs
    // instead of the sources, the application, and the crawled pages.
    let briefs: ResearchBrief[] = []
    let researchRepairs: string[] = []
    if (stagedPlanningEnabled()) {
      // How much research this request needs is decided once, before any
      // session starts, and kept on the plan so revisions and retries agree.
      if (!current.research) {
        const research = current.mode === 'create'
          ? fullResearch('A create run researches the whole product.')
          : await triageUpdateRequest(root, current, selected, project, discovery.inventory.existingPages)
        current = { ...current, research }
        await persistPlan(root, current, false)
        process.stdout.write(`${describeResearchScope(research)}\n`)
      }
      const tasks = await researchTasks(root, project, current)
      if (tasks.length > 0) {
        const researchKey = researchCheckpointKey(current, sourceSnapshot)
        const acceptKeys = researchCheckpointKeys(current, sourceSnapshot)
        if (checkpoint) {
          briefs = await savedResearchBriefs(root, current.id, tasks, acceptKeys)
        } else {
          const concurrency = selected.name === 'gemini' ? 1 : Math.min(planningParallelism(), tasks.length)
          emitWorkflowStage('building-coverage', `Researching in ${tasks.length} session${tasks.length === 1 ? '' : 's'}${concurrency > 1 ? ` (${concurrency} at a time)` : ''}`, 'running', { done: 0, total: tasks.length })
          // A signed-out agent fails every session the same way within a
          // second; the first such failure stops the others from starting
          // and becomes the plan's failure reason instead of "exited with status 1".
          let blocker: AgentSessionError | undefined
          const research = await runResearch(tasks, {
            root,
            planId: current.id,
            key: researchKey,
            acceptKeys,
            agent: selected.name,
            concurrency,
            context: { project, current, discovery: discovery.inventory, changes: changesText, captureAuth, captureDirectory: await preparePlanningCaptures(root, current.id) },
            runSession: async (task, text) => {
              if (blocker) throw blocker
              const prepared = await prepareAgentPrompt(root, text)
              try {
                return await runAgentForPlan(root, selected, prepared.argument, current.execution, project, { browser: task.browser, label: `research "${task.id}"`, prefix: `[${task.id}] ` })
              } catch (error) {
                if (error instanceof AgentSessionError && error.kind !== 'other') blocker ??= error
                throw error
              } finally {
                if (prepared.path) await rm(prepared.path, { force: true })
              }
            },
            onProgress: (done, total, task, outcome) => {
              emitWorkflowStage('building-coverage', `Research ${done}/${total}: ${task.label} ${outcome === 'cached' ? 'reused' : outcome}`, 'running', { done, total })
            },
            log: (line) => process.stdout.write(`${line}\n`),
          }).catch((error: unknown) => {
            throw blocker ? researchBlockedError(error, blocker) : error
          })
          briefs = research.briefs
          researchRepairs = research.repairs
          emitWorkflowStage('building-coverage', 'Writing the coverage plan from the research briefs', 'running')
        }
      }
    }
    const briefed = briefs.length > 0
    const navigationText = current.research?.scope === 'navigation' ? await currentNavigationText(root) : undefined
    const prompt = planningPrompt(project, current, discovery.inventory, changesText, feedback, await reviewPreferenceGuidance(root), captureAuth, briefed ? formatResearchBriefs(briefs) : undefined, navigationText)
    // A navigation-only or page-scoped plan never explores the application:
    // it has no screens to discover, only the briefs or the navigation.
    const browser = !briefed && (current.research?.scope ?? 'product') === 'product'
    let raw: unknown
    // What Doxloop had to fix to read the reply it is working from; reported
    // on the review so a reader can check nothing was lost.
    let repairs: string[] = []
    if (checkpoint) {
      process.stdout.write(`Continuing from the proposal ${selected.name} returned at ${checkpoint.savedAt}; the planning pass is not repeated.\n`)
      raw = checkpoint.raw
      repairs = checkpoint.repairs ?? []
    } else {
      // A revision patches the plan it revises; the reply is merged into it.
      const reply = await planFromAgent(root, selected, prompt, current.execution, project, feedback ? { browser, patchOf: normalizePlanShape(current, current) } : { browser })
      raw = feedback ? withoutAnsweredQuestions(reply.plan, current.clarification.answers) : reply.plan
      repairs = [...researchRepairs, ...reply.repairs]
      await writeProposalCheckpoint(root, current.id, { key: checkpointKey, pass: 'proposal', raw, ...(repairs.length > 0 ? { repairs } : {}) })
    }
    raw = await withExistingPageDetails(root, raw, project.sources)
    let recommendedAnswers: Record<string, string> | undefined
    raw = repairMechanicalPlanIssues(raw, current.execution)
    {
      // A capture ID the application brief never saved cannot be reused; the
      // writer would embed nothing and the run would treat the state as done.
      const known = await knownPlanningCaptureIds(root, current.id)
      const blanked = known ? dropUnknownCaptureIds(raw, known) : 0
      if (blanked > 0) repairs.push(`${blanked} capture reference${blanked === 1 ? '' : 's'} named an image the application research never saved; those states are captured during generation instead.`)
    }
    const proposed = normalizePlanShape(raw, current)
    // Only findings that would block approval are worth a corrective pass:
    // it costs as much as the first proposal, because the agent returns the
    // whole plan again. Thin or missing screenshot coverage is reported as an
    // advisory on the review instead, where the reviewer can ask for more.
    const planningIssue = checkpoint?.pass === 'revised' ? '' : [
      initialCreatePlanCoverageIssue(proposed, current),
      existingDocumentationPlanIssue(proposed, current, project.sources),
      requiredScreenshotPlanIssue(proposed, current.execution),
    ].filter((issue): issue is string => Boolean(issue)).join('\n')
    if (planningIssue) {
      emitWorkflowStage('revising-gates', 'Revising failed planning gates', 'running')
      const repairPrompt = `${prompt}

${gateRevisionInstructions(planningIssue, raw, { briefed })}`
      try {
        const reply = await planFromAgent(root, selected, repairPrompt, current.execution, project, { browser, patchOf: raw })
        raw = await withExistingPageDetails(root, reply.plan, project.sources)
        repairs = [...researchRepairs, ...reply.repairs]
        await writeProposalCheckpoint(root, current.id, { key: checkpointKey, pass: 'revised', raw, ...(repairs.length > 0 ? { repairs } : {}) })
      } catch (error) {
        // The first proposal is real work. When the corrective pass stops
        // (timeout, cut-off reply, agent error) the reviewer gets that
        // proposal with the gate findings as advisories rather than nothing.
        process.stdout.write(`Gate revision did not finish; keeping the first proposal for review. ${error instanceof Error ? error.message : String(error)}\n`)
      }
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
      const clarificationPrompt = `${prompt}\n\n${clarificationFeedback}\n\nPlan awaiting clarification:\n${JSON.stringify(raw)}`
      const reply = await planFromAgent(root, selected, clarificationPrompt, current.execution, project, { browser })
      raw = await withExistingPageDetails(root, reply.plan, project.sources)
      repairs = [...researchRepairs, ...reply.repairs]
      emitWorkflowStage('clarifying', 'Applying recommended decisions', 'completed')
    }
    const finalShape = normalizePlanShape(raw, current)
    const finalPlanningIssue = [
      initialCreatePlanCoverageIssue(finalShape, current),
      existingDocumentationPlanIssue(finalShape, current, project.sources),
      requiredScreenshotPlanIssue(finalShape, current.execution),
    ].filter((issue): issue is string => Boolean(issue)).join('\n')
    if (finalPlanningIssue) {
      // The agent's plan is not approvable as it stands, but it is real work:
      // keep it as the failed plan so the reviewer can fix it by hand or accept
      // it for review instead of paying for another planning run.
      const candidate = await persistFailedPlanCandidate(root, current, raw, selected.name)
      failedCandidate = candidate
      // Replaying this reply would fail the same gate, so the next attempt plans afresh.
      await clearProposalCheckpoint(root, current.id)
      throw new DoxloopError(`The planning agent could not produce an approvable plan. ${finalPlanningIssue}`)
    }
    let applied = await applyDocumentationPlanProposal(root, current.id, raw, selected.name)
    await clearProposalCheckpoint(root, current.id)
    const advisories = [
      ...(applied.research && applied.mode !== 'create' ? [describeResearchScope(applied.research)] : []),
      ...repairs,
      screenshotCoverageAdvisory(applied, applied.execution),
      shallowCaptureAdvisory(applied, applied.execution),
      existingDocumentationAdvisory(applied, project.sources, discovery.inventory),
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
 * The corrective pass costs as much as the first proposal because the agent
 * returns the whole plan again, and in real runs it cost more: told to
 * "re-audit the evidence" and "inspect the reachable application", the
 * planner signed in and re-explored every screen it had already seen. The
 * gate names specific pages and specific fields, so the pass is scoped to
 * them, and the browser is only for a state the first pass never reached.
 */
export function gateRevisionInstructions(planningIssue: string, firstProposal: unknown, options: { briefed?: boolean } = {}): string {
  const noVisualGuide = /planned no application screenshots/.test(planningIssue)
  const browserGuidance = options.briefed
    ? 'Plan any screen you add from the application research brief you were given; do not sign in or explore it again, and do not read the sources again. Every finding below can be resolved from the first proposal and the briefs.'
    : noVisualGuide
      ? 'Use the supplied doxloop_capture MCP tools only as far as needed to confirm the screens the guides you add will document; stay within the planning browser budget.'
      : 'You already inspected the application and the evidence for this proposal; do not sign in or explore it again. Every finding below can be resolved from the first proposal and the source you have read.'
  return `Required planning validation failed for your first proposal:
${planningIssue}

Fix exactly these findings and return only what changed, as a patch. Keep every page, capability, navigation entry, and field that the findings do not name unchanged: Doxloop merges the patch into the first proposal by page id, so anything you leave out stays exactly as it was. Send each corrected or added page complete with every field, list the ids of pages you removed, and resend the full capabilities, navigation, or existingDocumentation lists only when a finding required changing them. Do not resend unchanged pages; this pass corrects the named pages, it does not re-plan. ${browserGuidance} Do not pad the plan, invent UI states, downgrade required screenshots, or return another plan without a complete screenshot-enabled UI guide.

End your reply with exactly one machine-readable block and put nothing after it. Do not use Markdown fences inside the block; close every bracket you open, and make the object's own closing brace the last character before </doxloop-plan-patch>:
<doxloop-plan-patch>
{ "pages": [ corrected or added pages, complete ], "removePageIds": ["ids of removed pages"], "capabilities": [ only when changed ], "navigation": { only when changed }, "existingDocumentation": [ only when changed ] }
</doxloop-plan-patch>

First proposal (compact JSON):
${JSON.stringify(firstProposal)}`
}

/**
 * A revision used to return the whole plan again — for a 34-page plan that
 * was 57 KB of JSON emitted token by token, five minutes of waiting to apply
 * three answers. The reviser sends only what changed and Doxloop merges it.
 */
export function planRevisionPatchInstructions(): string {
  return `Return only what changed, as a patch: Doxloop merges it into the existing plan by page id, so every page, capability, and navigation entry you leave out stays exactly as it is. Send each changed or added page complete with every field, list the ids of removed pages in "removePageIds", and resend "capabilities", "navigation", "existingDocumentation", "summary", or "instructions" only when the feedback changes them. Always include "questions": the open questions that still need the reviewer, or [] when the feedback resolves them all. Do not resend unchanged pages, and do not re-plan, re-read the sources, or explore the application: the feedback and the existing plan below are all you need.

End your reply with exactly one machine-readable block and put nothing after it. Do not use Markdown fences inside the block; close every bracket you open, and make the object's own closing brace the last character before </doxloop-plan-patch>:
<doxloop-plan-patch>
{ "pages": [ changed or added pages, complete ], "removePageIds": ["ids of removed pages"], "questions": [ remaining open questions, or none ], "capabilities": [ only when changed ], "navigation": { only when changed }, "existingDocumentation": [ only when changed ], "summary": "only when changed", "instructions": "only when changed" }
</doxloop-plan-patch>`
}

/**
 * Drop the questions the reviewer has answered from a revised plan. The
 * reviser is told to remove them, but a patch that omits "questions" keeps
 * the base plan's list, and a plan that still carries an answered question
 * would pause for input a second time.
 */
export function withoutAnsweredQuestions(raw: unknown, answers: Record<string, string>): unknown {
  const answered = new Set(Object.keys(answers).filter((id) => answers[id]?.trim()))
  if (answered.size === 0 || !raw || typeof raw !== 'object' || Array.isArray(raw)) return raw
  const value = raw as Record<string, unknown>
  if (!Array.isArray(value.questions)) return raw
  const questions = value.questions.filter((question) => {
    const id = question && typeof question === 'object' ? (question as Record<string, unknown>).id : undefined
    return typeof id !== 'string' || !answered.has(id)
  })
  return { ...value, questions }
}

/**
 * Merge a corrective-pass patch into the proposal it corrects. Pages are
 * matched by id: a patched page replaces its original, a new id is appended,
 * and listed ids are removed. Other top-level lists are replaced only when
 * the patch carries them. A patch that turns out to be a whole plan merges
 * the same way, page by page.
 */
export function applyPlanPatch(base: unknown, patch: unknown): unknown {
  const first = record(base)
  const delta = record(patch)
  const pageId = (page: unknown): string | undefined => {
    const id = (page && typeof page === 'object' ? (page as Record<string, unknown>).id : undefined)
    return typeof id === 'string' && id.trim() ? id : undefined
  }
  const removed = new Set(stringList(delta.removePageIds))
  const basePages = Array.isArray(first.pages) ? first.pages : []
  const patchPages = (Array.isArray(delta.pages) ? delta.pages : []).filter((page) => pageId(page) !== undefined)
  const replacements = new Map(patchPages.map((page) => [pageId(page)!, page]))
  const pages = basePages
    .filter((page) => !removed.has(pageId(page) ?? ''))
    .map((page) => replacements.get(pageId(page) ?? '') ?? page)
  const known = new Set(basePages.map((page) => pageId(page)))
  for (const page of patchPages) {
    if (!known.has(pageId(page)) && !removed.has(pageId(page)!)) pages.push(page)
  }
  const next: Record<string, unknown> = { ...first, pages }
  for (const key of ['capabilities', 'navigation', 'existingDocumentation', 'questions', 'exclusions', 'outcomes', 'audiences', 'terminology', 'instructions', 'summary']) {
    if (key in delta) next[key] = delta[key]
  }
  return next
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
 * Run the planning agent and read its plan. A reply that stops short of its
 * closing brackets is closed deterministically and the fix reported on the
 * review (see `closeObjectAt`); an object that is cut off or malformed inside
 * is retried once with the exact defect quoted back, because agents lose a
 * brace often enough that failing the whole plan on the first bad reply
 * wastes the entire run. Nothing is ever truncated to make a reply parse,
 * since that would drop planned pages without telling anyone.
 */
async function planFromAgent(
  root: string,
  selected: { name: AgentName; executable: string },
  prompt: string,
  execution: DocumentationPlanExecution,
  project: Awaited<ReturnType<typeof loadProject>>,
  options: {
    /** Whether the session gets the capture browser; a briefed synthesis pass does not. */
    browser?: boolean
    /** The proposal a corrective pass patches; its reply is merged into this. */
    patchOf?: unknown
  } = {},
): Promise<PlanReply> {
  let lastError: unknown
  const tag = options.patchOf !== undefined ? 'doxloop-plan-patch' : 'doxloop-plan'
  for (const attempt of [0, 1]) {
    const text = attempt === 0 ? prompt : `${prompt}

Your previous reply could not be read as a documentation ${options.patchOf !== undefined ? 'plan patch' : 'plan'}: ${lastError instanceof Error ? lastError.message : String(lastError)}

Send it again as one complete, strictly valid JSON object inside the <${tag}> block. Check that every brace and bracket you open is closed, that the object ends with its own closing brace immediately before </${tag}>, and that the block contains only that object.`
    const prepared = await prepareAgentPrompt(root, text)
    let output = ''
    try {
      output = await runAgentForPlan(root, selected, prepared.argument, execution, project, { browser: options.browser !== false })
    } finally {
      if (prepared.path) {
        const { rm } = await import('node:fs/promises')
        await rm(prepared.path, { force: true })
      }
    }
    try {
      const patch = options.patchOf !== undefined ? readPlanPatchOutput(output, selected.name, text) : undefined
      const reply: PlanReply = patch
        ? { plan: applyPlanPatch(options.patchOf, patch.value), repairs: patch.repairs }
        : readPlanOutput(output, selected.name, text)
      for (const repair of reply.repairs) process.stdout.write(`${repair}\n`)
      return reply
    } catch (error) {
      lastError = error
      budgetContext.getStore()?.assertAvailable()
      if (attempt === 1) throw error
      process.stdout.write(`The plan reply could not be read: ${error instanceof Error ? error.message : String(error)}\n`)
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
  return explicitPlanningTimeoutMinutes(project, env) ?? DEFAULT_PLANNING_TIMEOUT_MINUTES
}

function explicitPlanningTimeoutMinutes(project: Pick<DoxloopProject, 'sync'>, env: NodeJS.ProcessEnv): number | undefined {
  const raw = env.DOXLOOP_PLAN_TIMEOUT_MINUTES
  if (raw !== undefined && raw.trim() !== '') {
    const parsed = Number(raw)
    if (Number.isFinite(parsed) && parsed > 0) return parsed
  }
  return project.sync.budget?.maxMinutes
}

/**
 * How long one planning pass may run for a batch. A limit the user set
 * (environment or monitoring budget) is honoured and capped by the batch's
 * minutes; otherwise the batch's own minutes apply, never less than the
 * default, so a comprehensive plan is not cut off at a starter's deadline.
 */
export function planningTimeoutForBatch(project: Pick<DoxloopProject, 'sync'>, limits: { maxMinutes: number }, env: NodeJS.ProcessEnv = process.env): number {
  const explicit = explicitPlanningTimeoutMinutes(project, env)
  if (explicit !== undefined) return Math.min(explicit, limits.maxMinutes)
  return Math.max(DEFAULT_PLANNING_TIMEOUT_MINUTES, limits.maxMinutes)
}

/**
 * Research sessions that all stopped on the agent's sign-in or account are
 * not "missing briefs to retry": name the cause and the next step instead.
 */
export function researchBlockedError(error: unknown, blocker: AgentSessionError): DoxloopError {
  const message = error instanceof Error ? error.message : String(error)
  const count = /^(A research session|\d+ research sessions) did not finish/.exec(message)?.[1] ?? 'Research'
  return new DoxloopError(`${count} did not finish: ${blocker.message}`)
}

export function planningTimeoutMessage(minutes: number, agent: string): string {
  return `Planning stopped after ${formatMinutes(minutes)} without a plan reply from ${agent}. Increase the plan time limit and, if configured, the monitoring time budget, then retry planning. DOXLOOP_PLAN_TIMEOUT_MINUTES can impose an additional planning limit.`
}

function formatMinutes(minutes: number): string {
  if (Number.isInteger(minutes)) return `${minutes} minute${minutes === 1 ? '' : 's'}`
  const seconds = Math.round(minutes * 60)
  return seconds < 60 ? `${seconds} second${seconds === 1 ? '' : 's'}` : `${Math.round(minutes * 10) / 10} minutes`
}

/**
 * Planning is an inventory and grouping task over evidence Doxloop has
 * already extracted; extra reasoning effort mostly buys slower turns. The
 * run's effort still applies to authoring, where depth matters.
 */
export function planningEffort(effort: ClaudeEffortLevel): ClaudeEffortLevel {
  return effort === 'high' || effort === 'max' ? 'medium' : effort
}

async function runAgentForPlan(
  root: string,
  selected: { name: AgentName; executable: string },
  prompt: string,
  execution: DocumentationPlanExecution,
  project: Awaited<ReturnType<typeof loadProject>>,
  options: {
    /** Whether this session gets the capture browser (application research and unbriefed planning do). */
    browser?: boolean
    /** How the session is named in messages: "planning" or `research "product"`. */
    label?: string
    /** Prefix for the activity lines this session writes, so parallel sessions stay distinguishable. */
    prefix?: string
  } = {},
): Promise<string> {
  const budget = budgetContext.getStore()
  budget?.assertAvailable()
  const screenshotIntent = normalizeScreenshotIntent(execution.screenshots)
  const label = options.label ?? 'planning'
  const prefix = options.prefix ?? ''
  const wantsBrowser = options.browser !== false && screenshotIntent !== 'disabled' && Boolean(project.application)
  // Planning explores the signed-in application read-only, so it gets the
  // same session and credentials the authoring run will use.
  const captureMaterial = wantsBrowser
    ? await prepareCaptureAuth(root)
    : undefined
  const captureProvider = wantsBrowser && project.application
    ? screenCaptureProvider(root, project.application, captureMaterial, budget ? join(dirname(budget.file), 'captures') : undefined)
    : undefined
  if (selected.name === 'gemini') await writeGeminiCaptureSettings(root, captureProvider)
  const args = agentArguments(selected.name, prompt, {
    mode: 'review',
    ...(execution.model ? { model: execution.model } : {}),
    ...(execution.reasoning ? { reasoning: execution.reasoning } : {}),
    ...(execution.effort ? { effort: planningEffort(execution.effort) } : {}),
    ...(budget?.remainingUsd !== undefined ? { maxBudgetUsd: budget.remainingUsd } : project.sync.budget?.maxUsd ? { maxBudgetUsd: project.sync.budget.maxUsd } : {}),
    sourceDirectories: sourceAccessDirectories(root, project.sources),
    ...(captureProvider ? { captureProvider } : {}),
    captureRequired: wantsBrowser && screenshotIntent === 'enabled',
    ...(selected.name === 'codex' ? { userMcpServers: await codexUserMcpServers(root) } : {}),
  })
  const timeoutMinutes = planningTimeoutForBatch(project, batchLimits(execution.limits))
  return new Promise<string>((resolveOutput, reject) => {
    const agent = spawnAgentProcess(selected.executable, args, {
      cwd: root,
      env: agentEnvironment(selected.name),
      stdio: ['ignore', 'pipe', 'pipe'],
      isolate: true,
    })
    const budgetSession = budget?.register(() => { void agent.stop() })
    const { child } = agent
    // The raw stream is kept for plan extraction; the reader sees the same
    // one-line activity summaries the authoring run shows.
    const formatter = createAgentLogFormatter(selected.name)
    let stdout = ''
    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout += chunk.toString()
      for (const line of formatter.push(chunk)) process.stdout.write(`${prefix}${line}\n`)
      if (budgetSession) budget?.update(budgetSession, formatter.usage, formatter.stopReason)
    })
    child.stdout?.once('end', () => {
      for (const line of formatter.finish()) process.stdout.write(`${prefix}${line}\n`)
    })
    // The tail of stderr names the cause when the agent fails before it
    // streams a result event (a Codex sign-in or configuration error).
    let stderrTail = ''
    child.stderr?.on('data', (chunk: Buffer | string) => {
      process.stderr.write(chunk.toString())
      stderrTail = `${stderrTail}${chunk.toString()}`.slice(-4_000)
      if (budgetSession && isAccountLimit(chunk.toString())) budget?.update(budgetSession, formatter.usage, chunk.toString())
    })
    // A planner thinking for minutes or streaming a long plan prints nothing
    // in between; the heartbeat names what it is doing so the quiet reads as
    // progress rather than a hang.
    const pulse = setInterval(() => {
      for (const line of formatter.heartbeat()) process.stdout.write(`${prefix}${line}\n`)
    }, AGENT_LOG_HEARTBEAT_MS / 2)
    pulse.unref?.()
    // A planner that never answers used to run until someone noticed; the
    // budget turns that into a named failure the reviewer can act on.
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      process.stderr.write(`Stopping ${selected.name} ${label} after ${formatMinutes(timeoutMinutes)}.\n`)
      void agent.stop()
    }, timeoutMinutes * 60_000)
    timer.unref?.()
    const stopForwarding = forwardTerminationSignals(agent, { label: `${selected.name} ${label}` })
    void agent.exited.then(async (exit) => {
      clearTimeout(timer)
      clearInterval(pulse)
      stopForwarding()
      await captureMaterial?.cleanup()
      if (budgetSession) await budget?.finish(budgetSession, formatter.usage, formatter.stopReason)
      if (budget?.stoppedReason) reject(new DoxloopError(budget.stoppedReason))
      else if (exit.error) reject(exit.error)
      else if (timedOut) reject(new DoxloopError(planningTimeoutMessage(timeoutMinutes, selected.name)))
      else if (exit.signal) reject(new DoxloopError(`${selected.name} ${label} was stopped by ${exit.signal}.`))
      else if (exit.code !== 0) {
        const detail = agentFailureDetail(formatter.stopReason, stderrTail)
        reject(detail
          ? new AgentSessionError(selected.name, label, exit.code ?? 1, detail)
          : new DoxloopError(`${selected.name} ${label} exited with status ${exit.code ?? 1}.`))
      }
      else resolveOutput(stdout)
    }).catch(reject)
  })
}

export function screenshotPlanningInstructions(briefed = false): string {
  const preamble = briefed
    ? `Doxloop's application research session already explored the live application for this run; its brief below lists every screen it reached, what each shows, and the states that open from it. Plan from that brief only: a state the brief does not list is not plannable, and you must not browse, sign in, or explore the application yourself. Do not invent fixture data, authenticated state, prepared plans, proposals, or controls merely because source code or tests mention them.`
    : `Doxloop supplies the purpose-built doxloop_capture MCP browser for this run. It is the capture connector required by this task and must take precedence over any generic in-app Browser plugin, Chrome extension, or node_repl browser mechanism. Call the doxloop_capture navigation and snapshot tools directly before deciding visual states; do not use failure of another browser mechanism as evidence that Doxloop capture is unavailable. Do not save PNG files during planning. Plan from states that are actually visible in the live application; do not invent fixture data, authenticated state, prepared plans, proposals, or controls merely because source code or tests mention them.
Explore the application with a fixed budget before you decide what is visible: at most 12 doxloop_capture calls in total during planning, and at most one snapshot per distinct screen. The source's route, navigation, and UI label definitions are the primary inventory of screens; the browser confirms that they exist and what they show. Open the starting route, then visit each top-level navigation destination once and snapshot it; open a dialog, tab, panel, or disclosure only when the source cannot tell you what it contains. Many control centers are single-page applications where every screen shares one URL, so the absence of a second route is never evidence that a screen is unreachable. Interaction that only reveals an existing screen is safe and expected. Do not fill forms, submit, create, delete, deploy, publish, send, or otherwise change data, and back out of any control that would. Record a state as unavailable only after you attempted to reach it within the budget, and say which control or screen stopped you.
Screenshot readiness, authentication, fixture data, routes, and application preparation are run preconditions—not documentation-scope decisions. Never add a plan question solely about preparing, restarting, signing in to, or populating the capture application. If a desired state is not visibly available after you tried to reach it through in-app navigation, omit that state and use another evidence-supported, reachable state; do not trigger a second planning pass to ask the user to manufacture it.`
  return `${preamble}
Plan screenshots only for visible application workflows where an image materially reduces ambiguity or proves an important state. Never plan decorative screenshots for API, CLI, concept, or reference-only pages. For a UI guide, plan one capture for every reader step that changes what is on screen: the entry screen, each dialog, drawer, tab, expanded section, or form the step opens, the form once it is filled with safe example values, and the visible result or confirmation. Readers follow a guide screen by screen, so a guide whose steps open four screens plans four captures. A primary how-to guide therefore normally plans 4–7 captures and a tutorial 5–8; plan fewer only when the application genuinely exposes fewer distinct states and say so in the workflow. When intent is disabled, every page must use visuals.mode "none". When intent is enabled, cover the visible UI surface in proportion to it: every planned page that documents a screen or workflow you actually reached needs its own screenshot-enabled guide marked "required". One guide is enough only when the application genuinely exposes one screen; planning a single capture for an application whose screens you did not attempt to reach is a failed plan, not a conservative one. In automatic mode, use "recommended" only when the project policy and user request allow capture. Treat the user-provided route as the default boundary; specialize it per guide only when the live application, configured source routes, or UI tests provide evidence. Each capture-sequence item must be a state that looks different from the one before it — a different screen, an opened dialog, an expanded section, a filled form, or a result. Scrolling, focusing a field, hovering, or merely inspecting part of a screen that is already visible is not a new state and must never be its own capture item, because it produces an identical image and Doxloop consolidates it away. When a guide's workflow only ever shows one screen, plan one capture for it rather than padding the sequence to a larger number.`
}

function docsSiteSources(sources: SourceBinding[]): SourceBinding[] {
  return sources.filter((source) => (source.kind ?? 'directory') === 'docs-site')
}

/**
 * When an existing documentation site is configured, the plan is also an
 * audit of it: the reviewer sees coverage, gaps, contradictions, and where
 * every old page lands before any page is rewritten. Product sources decide
 * facts; without them the plan may restructure but not invent.
 */
export function existingDocumentationPlanningInstructions(sources: SourceBinding[], discovery: DocumentationDiscoveryInventory, briefed = false): string {
  const sites = docsSiteSources(sources)
  if (sites.length === 0) return ''
  const productSources = sources.filter((source) => (source.kind ?? 'directory') !== 'docs-site')
  const siteLines = sites.map((source) => {
    const inventory = discovery.sources.find((item) => item.name === source.name)
    const pages = inventory?.filesAvailable ?? source.site?.pages ?? 0
    return `- "${source.name}": ${source.site?.url ?? source.path}, crawled into the read-only Markdown snapshot at ${source.path} (${pages} pages${source.site?.generator ? `, ${source.site.generator}` : ''}). Read its index.md first: it lists every page with its title, word count, and original URL, plus broken links and crawl warnings. Open page files under pages/ to judge their content.`
  })
  const factRule = productSources.length > 0
    ? `Product sources (${productSources.map((source) => `"${source.name}"`).join(', ')}) are the truth for facts. Where an existing page contradicts them, list the claim under coverage.contradicted and plan the corrected page; where it describes behavior no product source shows, decide whether it is obsolete (coverage.obsolete) or knowledge code cannot show that the rewrite must keep (coverage.preserved). Product surfaces in the deterministic inventory that no existing page covers belong in coverage.gaps and need a planned page.`
    : `No product code or API specification is configured, so the existing documentation is the only product evidence. Plan a restructure and rewrite of what it already says: do not plan pages whose facts the crawled pages cannot support, leave coverage.gaps and coverage.contradicted empty, and note in "instructions" that every page is written with inferred confidence until a product source is connected.`
  return `Existing documentation to rewrite (docs-site sources):
${siteLines.join('\n')}
This run rewrites that documentation as a new professional documentation set. ${briefed ? 'The existing-documentation research briefs below already audit every crawled page (summary, quality, unique knowledge, suspect claims); base your assessment and page dispositions on them, and read a crawled page only to settle a specific suspect claim. ' : 'Audit it before planning: read enough pages to judge accuracy, structure, depth, duplication, terminology, and reader journeys. '}${factRule} Give every crawled page a disposition, identified by its snapshot path only (Doxloop adds titles and URLs from the snapshot): "rewrite" when one planned page replaces it, "merge" when it is absorbed into a planned page with other pages, "preserve" when its content is carried over largely as it stands, or "drop" with the reason when its content is obsolete or duplicated. A page that is dropped must not lose knowledge the product still has. Cite docs-site pages in evidenceDetails with kind "documentation" and the snapshot-relative file path, alongside product-source evidence. Keep the assessment compact: summary in at most 400 characters, each finding description in at most 200, each disposition reason in at most 120.
`
}

export function existingDocumentationPlanShape(sources: SourceBinding[]): string {
  if (docsSiteSources(sources).length === 0) return ''
  return `,
  "existingDocumentation": [{
    "source": "docs-site source name",
    "summary": "how well the existing documentation serves readers today and what the rewrite changes",
    "strengths": ["what the existing documentation does well and the rewrite keeps"],
    "findings": [{ "severity": "blocker | major | minor", "title": "short problem title", "description": "evidence-based problem in the existing documentation", "pages": ["pages/existing-page.md"] }],
    "coverage": {
      "gaps": ["product surface found in code that the existing documentation never covers"],
      "obsolete": ["existing page or claim describing behavior the product no longer has"],
      "preserved": ["existing knowledge code cannot show that the rewrite carries over"],
      "contradicted": ["existing claim the product sources contradict; the rewrite corrects it"]
    },
    "pages": [{ "path": "pages/existing-page.md", "disposition": "rewrite | merge | preserve | drop", "into": ["planned-page-id"], "reason": "why this page lands there" }]
  }]`
}

function planningPrompt(
  project: Awaited<ReturnType<typeof loadProject>>,
  current: DocumentationPlan,
  discovery: DocumentationDiscoveryInventory,
  changes: string,
  feedback?: string,
  reviewerGuidance = 'No prior reviewer preferences have been recorded.',
  captureAuth: CaptureAuthMode = 'none',
  briefs?: string,
  navigationText?: string,
): string {
  const briefed = Boolean(briefs)
  const researchScope = current.mode === 'create' ? 'product' : (current.research?.scope ?? 'product')
  const roleIntro = researchScope === 'navigation'
    ? 'You are the planning stage of Doxloop. This update changes only navigation, icons, ordering, group names, branding, or page metadata; no page content changes. Do not read product sources, crawled documentation pages, or page files, and do not browse the application: the current navigation below is everything you need. Return a plan whose "pages" list the existing pages the change touches with action "preserve" (nothing is rewritten), and put the complete, exact change in "workspaceInstructions": for icons, name the icon for every page and group by its label; for ordering, give the full order; for renames, old and new labels. Use only icon names the generator can draw. Keep "capabilities" empty and "existingDocumentation" absent.'
    : researchScope === 'pages'
      ? `You are the planning stage of Doxloop. This update concerns only the existing pages it names${current.research?.pages.length ? ` (${current.research.pages.join(', ')})` : ''}; the research brief below audits the product surface behind them. Plan those pages with action "update" and add a page only when the request cannot be satisfied without it. Do not re-plan, re-audit, or re-list the rest of the documentation, do not browse the application, and read a source file only to settle a specific contradiction in the brief.`
      : briefed
        ? 'You are the planning stage of Doxloop. Research sessions have already read the configured sources, explored the application, and audited the existing documentation for this run; their briefs are included below. Synthesize a complete documentation coverage plan from them: do not browse the application, and read a source file only to settle a specific contradiction between briefs.'
        : 'You are the planning stage of Doxloop. Research the configured product evidence and existing documentation, then return a complete documentation coverage plan.'
  const targetPagesText = current.targetPages
    ? ` The reviewer requires at least ${Math.min(current.targetPages, batchLimits(current.execution.limits).maxPages)} pages to write (create or update). Reach that count with distinct, evidence-backed reader jobs — split large workflows, reference surfaces, and concept areas into focused pages rather than padding — and record a "Scope exception:" exclusion only if the configured evidence genuinely cannot support that many distinct pages.`
    : ''
  const limits = batchLimits(current.execution.limits)
  const limitsText = hasPageLimit(limits)
    ? `HARD BATCH LIMITS: ${JSON.stringify(limits)}. Defer other work with priority later. These maxima override scope size recommendations.`
    : `There is no page limit for this run: the evidence sets the size. Plan every page the product's public surface supports and never merge distinct reader jobs to keep the plan small; equally, never add a page the evidence does not support. Screenshot maximum for the run: ${limits.maxScreenshots}; time per attempt: ${limits.maxMinutes} minutes.`
  const initialRequest = current.mode === 'create'
    ? `Propose a ${current.scope} documentation plan for this create request.${targetPagesText} ${limitsText}`
    : researchScope === 'navigation'
      ? 'Propose a navigation-only plan for this update request: no page is written, so batch limits do not apply beyond listing the touched pages.'
      : `Propose a focused documentation plan for this update request. Let the requested change and existing documentation determine its size.${targetPagesText} ${limitsText}`
  const revision = feedback
    ? `Revise the existing plan below according to the user's feedback. Preserve good decisions that the feedback does not affect.\n\nUser feedback:\n${feedback}\n\n${planRevisionPatchInstructions()}\n\nExisting plan:\n${JSON.stringify(current)}`
    : `${initialRequest}\n\nUser request:\n${current.request || 'Use the configured evidence and documentation brief to recommend the right documentation.'}`
  const screenshotIntent = normalizeScreenshotIntent(current.execution.screenshots)
  const screenshotPolicy = project.application?.screenshots?.policy ?? 'requested'
  const questionRule = current.clarification.mode === 'defaults'
    ? '- The reviewer asked you to decide open questions by their safe default instead of asking. Return an empty "questions" array: make each such decision yourself, apply it to the plan, and record it in one sentence in "instructions" so the reviewer can see what you assumed.'
    : '- Use at most three questions, only when the answer materially changes scope or reader outcomes.'
  return `${roleIntro} Do not edit any file, do not author reader-facing documentation, and do not ask questions in prose. Do not read the skill files under .agents/skills or .claude/skills: they guide authoring, and this brief is complete for planning.

${revision}

Project configuration (compact JSON):
${JSON.stringify(project)}

Application screenshot decision:
- Run intent: ${screenshotIntent}
- Project policy: ${screenshotPolicy}
- Application capture surface: ${project.application ? project.application.baseUrl : 'not configured'}
- User-provided default starting route: ${project.application?.screenshots?.startPath ?? 'not provided'}
- User-provided capture workflow: ${project.application?.screenshots?.workflow ?? 'not provided'}
- Sign-in handling: ${project.application ? captureAuthPrompt(captureAuth) : 'not applicable'}
${screenshotPlanningInstructions(briefed)}

Generator-neutral planning target (the adapter owns these navigation boundaries):
${JSON.stringify(current.target)}

Deterministic source discovery (trusted inventory produced by Doxloop; agent inferences must remain distinguishable):
${formatDiscoveryInventory(discovery)}
${discoveryGuidance(discovery)}
Deterministic source-change summary:
${changes}
${navigationText ? `\nCurrent navigation (Doxloop read it from the workspace; this is the whole evidence for a navigation-only plan):\n${navigationText}\n\n` : ''}${briefs ? `\n${briefs}\n\n` : ''}${researchScope === 'product' ? existingDocumentationPlanningInstructions(project.sources, discovery, briefed) : ''}${templateInstructions(current)}
Durable reviewer preferences from prior revisions, rejections, and inline edits. Apply them only when they remain compatible with current evidence and this request:
${reviewerGuidance}

${feedback ? 'Reply with the <doxloop-plan-patch> block described under the user feedback above, not with a whole plan. Every page you send in it must use the page shape from this reference object:' : `End your reply with exactly one machine-readable block and put nothing after it. Do not use Markdown fences inside the block, and never emit this block around an example, a file you read, or anything other than your final plan. The block holds one complete top-level object: close every bracket you open, and make the object's own closing brace the last character before </doxloop-plan>, with no other tag or text after it:
<doxloop-plan>
{ the single JSON object described below }
</doxloop-plan>

The JSON object must use this exact shape:`}
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
    "top": ["product-derived space name", "second space only when it holds at least five substantial pages"],
    "sections": [{ "id": "getting-started", "title": "Getting started", "space": "one name from top", "pageIds": ["planned-page-id"] }]
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
    "visuals": { "mode": "none | recommended | required", "rationale": "what reader ambiguity or visible outcome the captures resolve", "estimatedCaptures": 0, "startPath": "/application-relative/start", "workflow": "ordered actions and safe fixture assumptions", "captureSequence": ["Reader action — expected stable visible state — why this image helps"], "captureIds": ["matching ID from application brief, or empty string if missing"] },
    "diagram": "required | none"
  }],
  "questions": [{
    "id": "stable-kebab-id",
    "question": "one material question only",
    "whyItMatters": "decision affected by the answer",
    "recommendation": "safe default"
  }]${existingDocumentationPlanShape(project.sources)}
}

Rules:
- Plan only evidence-supported public behavior. Mark unknowns; never invent them.
- Audit the complete public product surface before choosing pages: package metadata and entry points; exported APIs, commands, routes, and configuration; installation and prerequisites; authentication and permissions; primary and advanced workflows; examples, tests, and integrations; errors, limits, recovery paths, and operational concerns.
- Enumerate concrete reader outcomes first, then ensure every evidence-supported outcome maps to at least one page. Put unsupported or intentionally omitted outcomes in exclusions.
- Keep your inferred grouping, audience relevance, and recommendations in rationale. Every planned capability must map to pageIds, and every page to write must cite at least one configured source when sources are available.
- Produce a coherent generator-neutral navigation outline. Use the persisted target only to identify generator-native navigation boundaries; do not put generator-specific syntax in page paths or section IDs.
- Name top-level spaces after this product's reader surfaces and audiences as the evidence shows them — for example "Guides", "Tracker & API", and "Self-hosting" for an analytics product, or "Monitoring", "Status pages", and "Administration" for a monitoring tool. Those names belong to other products: never reuse an example name unless this product's own evidence uses that word, and never default to a generic "Documentation" plus "Reference" pair. Add a second or third space only when it holds at least five substantial pages of its own; otherwise keep those pages as groups inside the primary space. Give every navigation section a "space" set to exactly one name from "top", so each space you list receives its sections; a space no section names is dropped. Every navigation group needs at least two pages, and a runbook or troubleshooting page belongs with the workflows it supports, not in a reference space.
- Give each page one distinct reader job or reference purpose. Do not hide several substantial workflows inside a generic overview or quickstart merely to keep the plan small.
- Preserve useful existing pages during updates and identify their action explicitly.
- Generated starter pages are scaffolding, not useful existing documentation. Any existing page containing a \`doxloop:starter-page\` marker or starter-placeholder language must appear in the current plan with action \`update\` or \`remove\`; never preserve or leave it outside the plan.
${questionRule}
- Scope contract for starter: at least 3 pages to write, covering orientation, first success, and essential reference or troubleshooting when supported. Keep it deliberately small, but do not merge distinct reader jobs to stay under an arbitrary number.
- Scope contract for standard: at least 8 pages to write within the configured page limit. Include overview, prerequisites or installation, quickstart, every primary workflow guide, necessary concepts, public reference or configuration, and troubleshooting. Add examples, integrations, errors, or limitations when evidence supports them.
- Scope contract for comprehensive: at least 12 pages to write within the configured page limit. This is the default scope; use the deterministic public-surface inventory as the floor for coverage, not a ceiling. Cover every distinct evidence-supported public workflow, screen, command, and interface at useful depth, plus relevant concepts, examples, integrations, operations, security, errors, limits, troubleshooting, and lifecycle guidance. A product with many screens, commands, or configuration groups legitimately needs 40–80 pages.
- Page depth contract: plan pages that can be written to professional depth. A how-to or tutorial page needs a stated outcome, prerequisites, at least three ordered steps with observable results, verification, evidence-backed troubleshooting, and a next step. A reference page covers its complete public surface (every command, option, field, default, and error in scope). A concept page explains the model, its consequences, and links to the tasks it informs. The landing page orients every audience with cards to their first task. Do not plan a page whose evidence supports only a paragraph — merge it into a page that can be complete.
- Treat the persisted documentation brief's customInstructions as reader requirements when planning visuals and depth; for example, a request for a screenshot on every step means every planned UI guide captures each screen-changing step.
${current.mode === 'create'
    ? `- A ${current.scope} plan changes depth and priority, never factual grounding. Targets guide coverage and are not permission to create filler.`
    : '- Keep an update plan tightly bounded to the requested change and evidence-backed dependencies. Do not expand it to meet a page-count target.'}
- For an initial create plan, the minimum pages to create or update are 3 for starter, 7 for standard, and 12 for comprehensive. If the evidence genuinely supports fewer distinct pages, add a specific exclusion beginning with "Scope exception:" that states why the smaller plan is complete.
- Include only pages that belong to this documentation run. Do not include a future backlog, deferred pages, or "later" items in the plan.
- Paths are relative, portable, have no leading slash, and do not escape the documentation project.
- Every must-have page explains its rationale and expected evidence.
- Every page declares a visuals decision. Use zero for non-UI pages. Prefer the already captured images that resolve a reader ambiguity or prove a meaningful result. A single clear screenshot is sufficient when text explains the remaining steps. Plan additional states only when they teach something distinct, or the user explicitly requested them. Do not require an image for every screen-changing step or target an image count by page type. Never inflate the count with unchanged screens, decorative images, or every mouse click.
- The estimatedCaptures of all pages together must not exceed the batch's maxScreenshots. When the visible surface deserves more, keep complete sequences for the guides whose screens matter most to the reader outcome, give the remaining UI pages visuals.mode "none", and say in their rationale that captures are deferred to a later batch; never trim every guide to a token image.
- Reuse the application brief's saved captures: set visuals.captureIds in captureSequence order to the ID proving that exact state (empty string only for a missing state). Do not schedule another capture of a state already saved. Writers choose from these saved images. Never assign an image to a different state merely because the route matches.
- Every screenshot-enabled page requires a startPath beginning with one slash, a specific workflow, and a captureSequence with exactly one concrete item per estimated capture in capture order. Each item must name the reader action, expected stable visible state, and why that image helps. Set estimatedCaptures to captureSequence.length. Pages with visuals.mode "none" use zero and empty capture details.
- The pages array must not be empty.
- Every page declares "diagram". Concept and architecture pages set "required" so the writer includes a Mermaid diagram of the model or lifecycle; task, reference, and release pages set "none" unless a diagram resolves real reader ambiguity.
- Keep the reply compact; a long plan is emitted token by token and every extra sentence delays the reviewer. Write purpose in at most 120 characters, rationale in at most 160, each captureSequence item in at most 160, and visuals.workflow in at most 240. Give each page to write two to four evidenceDetails, copied from the briefs with their line numbers: the component, route, handler, or command file that implements the behaviour first, the label catalog entry (a dotted key such as "task.repeat.everyDay" as the label) only as a supplement. Writers start from excerpts around those citations, so a page whose only citation is a translation file starts from nothing. Give each capability one or two. Do not restate the discovery inventory, the project configuration, or these rules anywhere in the reply.`
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

For every screenshot-enabled page, follow the approved visuals.startPath, visuals.workflow, and visuals.captureSequence in order. ${captureContract} Capture efficiently: take the screenshot immediately after the navigation or click that produces an approved state — the action's result already tells you it succeeded — and call the accessibility snapshot only when the next action needs an element reference or a dialog must be confirmed, never as a separate check before every image and never after one. Steps already marked verified with a file in .doxloop/screenshot-manifest.json were captured by Doxloop: keep them and embed those images.

Write every planned page to professional depth. Read the authoring skill's page-depth reference and apply its contract for the page type: an outcome-led introduction; prerequisites; complete ordered steps with the exact labels, values, and observable result of each step; verification; evidence-backed troubleshooting; and a next step. Reference pages cover their whole public surface with complete tables. Concept pages carry a diagram or model and link to the tasks they inform. The landing page orients each audience with cards to a first task. Use the generator's native components — steps, tabs, callouts, cards, accordions, code groups, frames — where they make the page clearer. Use saved captures at the steps they clarify, preserving the approved capture requirements without adding extra images for routine actions. Doxloop validates the workspace after each batch and returns every defect to you — including \`thin-page\`, \`thin-procedure\`, \`thin-space\`, \`single-page-group\`, and \`generic-space-name\` warnings, which you resolve on every planned page before finishing; do not run validation, node, or python yourself. Name every button, tab, field, and menu with the string the product displays: when the inventory lists a UI label catalog, read it and quote the displayed English value, never the translation key, a paraphrase such as "the add control", or a label you have not found in the catalog or the component source. Write each page's prerequisites, cautions, and limitations for its own task in its own words; do not repeat one disclaimer or "before you begin" block across pages, and do not fill verification blocks with restatements of the steps.

${planWritingRequirements(plan)}${existingDocumentationWritingRequirements(plan)}The finished workspace must contain no generated starter content. Replace every planned starter page completely and remove every \`doxloop:starter-page\` marker; Doxloop reports any remaining \`starter-content\` defect back to you.

Preserve applicable reviewer preferences below unless they conflict with the approved plan or current evidence:
${reviewerGuidance}`
}

/**
 * How the writer follows the approved audit of an existing documentation
 * site: dispositions are scope, contradictions are corrections, and the old
 * prose is evidence to rewrite from rather than text to paste.
 */
export function existingDocumentationWritingRequirements(plan: Pick<DocumentationPlan, 'existingDocumentation' | 'pages'>): string {
  const assessments = plan.existingDocumentation ?? []
  if (assessments.length === 0) return ''
  const titles = new Map(plan.pages.map((page) => [page.id, page.title]))
  const lines = assessments.flatMap((assessment) => {
    const corrections = assessment.coverage.contradicted.map((claim) => `  - correct: ${claim}`)
    const preserved = assessment.coverage.preserved.map((item) => `  - keep: ${item}`)
    const dropped = assessment.pages.filter((page) => page.disposition === 'drop').map((page) => `  - drop ${page.path}${page.reason ? ` (${page.reason})` : ''}`)
    const placed = assessment.pages.filter((page) => page.disposition !== 'drop').map((page) => `  - ${page.disposition} ${page.path} → ${page.into.map((id) => titles.get(id) ?? id).join(', ')}`)
    return [`Existing documentation "${assessment.source}":`, ...placed, ...dropped, ...corrections, ...preserved]
  })
  return `The approved plan includes an audit of the existing documentation being rewritten. Follow its page dispositions exactly: every existing page marked rewrite, merge, or preserve must have its reader-valuable content carried into the named planned pages, and a page marked drop is omitted for the stated reason. Write the corrected fact for every contradicted claim and never repeat the old one. Rewrite in the project's voice from the evidence; do not paste the existing prose. Where the existing pages carry knowledge no product source shows, keep it and record the page's confidence as inferred with the docs-site source as evidence. List every correction and every dropped page in your final summary.
${lines.join('\n')}

`
}


function normalizePlanShape(raw: unknown, base: DocumentationPlan): Pick<DocumentationPlan,
  'productProfile' | 'summary' | 'audiences' | 'outcomes' | 'terminology' | 'exclusions' |
  'instructions' | 'experienceLevel' | 'preferredExamples' | 'locale' | 'accessibilityTarget' |
  'styleGuide' | 'capabilities' | 'navigation' | 'estimatedPages' | 'estimatedEffort' |
  'pages' | 'questions' | 'scope' | 'existingDocumentation' | 'workspaceInstructions'
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
  const existingDocumentation = normalizeExistingDocumentation(value.existingDocumentation ?? base.existingDocumentation, pages)
  const workspaceInstructions = (textValue(value.workspaceInstructions) ?? base.workspaceInstructions)?.slice(0, 4000) || undefined
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
    ...(existingDocumentation ? { existingDocumentation } : {}),
    ...(workspaceInstructions ? { workspaceInstructions } : {}),
  }
}

/** Titles and URLs of crawled pages, keyed by docs-site source name and snapshot path. */
export type ExistingPageDetails = Map<string, Map<string, { title: string; url: string }>>

/**
 * Add the title and URL of every existing page the plan names, from the
 * snapshot manifest. The planner lists pages by path only, which keeps its
 * reply shorter; the review still shows readers what each page was.
 */
export function fillExistingPageDetails(raw: unknown, details: ExistingPageDetails): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw
  const plan = raw as Record<string, unknown>
  if (!Array.isArray(plan.existingDocumentation)) return raw
  const existingDocumentation = plan.existingDocumentation.map((assessment) => {
    if (!assessment || typeof assessment !== 'object' || Array.isArray(assessment)) return assessment
    const item = assessment as Record<string, unknown>
    const known = typeof item.source === 'string' ? details.get(item.source) : undefined
    if (!known || !Array.isArray(item.pages)) return assessment
    return {
      ...item,
      pages: item.pages.map((page) => {
        if (!page || typeof page !== 'object' || Array.isArray(page)) return page
        const entry = page as Record<string, unknown>
        const found = typeof entry.path === 'string' ? known.get(entry.path.replace(/^\/+/, '')) : undefined
        if (!found) return page
        return {
          ...entry,
          ...(typeof entry.title === 'string' && entry.title.trim() ? {} : { title: found.title }),
          ...(typeof entry.url === 'string' && entry.url.trim() ? {} : { url: found.url }),
        }
      }),
    }
  })
  return { ...plan, existingDocumentation }
}

async function withExistingPageDetails(root: string, raw: unknown, sources: SourceBinding[]): Promise<unknown> {
  const details: ExistingPageDetails = new Map()
  for (const source of docsSiteSources(sources)) {
    try {
      const manifest = await readDocsSiteManifest(root, source)
      details.set(source.name, new Map(manifest.pages.map((page) => [page.file, { title: page.title, url: page.url }])))
    } catch {
      // A missing snapshot is reported by the planning gates, not here.
    }
  }
  return details.size > 0 ? fillExistingPageDetails(raw, details) : raw
}

function normalizeExistingDocumentation(raw: unknown, pages: DocumentationPlanPage[]): ExistingDocumentationAssessment[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const knownPageIds = new Set(pages.map((page) => page.id))
  const assessments = raw.flatMap((item): ExistingDocumentationAssessment[] => {
    const value = record(item)
    const source = textValue(value.source)
    if (!source) return []
    const coverage = record(value.coverage)
    const findings = (Array.isArray(value.findings) ? value.findings : []).flatMap((entry): ExistingDocumentationFinding[] => {
      const finding = record(entry)
      const title = textValue(finding.title)
      if (!title) return []
      const severity = finding.severity === 'blocker' || finding.severity === 'minor' ? finding.severity : 'major'
      return [{ severity, title, description: textValue(finding.description) ?? '', pages: stringList(finding.pages) }]
    })
    const dispositions = (Array.isArray(value.pages) ? value.pages : []).flatMap((entry): ExistingDocumentationPageDisposition[] => {
      const disposition = record(entry)
      const path = textValue(disposition.path)
      if (!path) return []
      const kind: ExistingDocumentationDisposition = disposition.disposition === 'merge' || disposition.disposition === 'preserve' || disposition.disposition === 'drop' ? disposition.disposition : 'rewrite'
      const into = stringList(disposition.into).filter((id) => knownPageIds.has(id))
      const title = textValue(disposition.title)
      const url = textValue(disposition.url)
      return [{
        path,
        ...(title ? { title } : {}),
        ...(url ? { url } : {}),
        disposition: kind === 'drop' ? 'drop' : into.length === 0 ? 'drop' : kind,
        into: kind === 'drop' ? [] : into,
        reason: textValue(disposition.reason)?.trim() || (kind !== 'drop' && into.length === 0 ? 'The plan named no page that absorbs this content.' : ''),
      }]
    })
    return [{
      source,
      summary: textValue(value.summary) ?? '',
      strengths: stringList(value.strengths),
      findings,
      coverage: {
        gaps: stringList(coverage.gaps),
        obsolete: stringList(coverage.obsolete),
        preserved: stringList(coverage.preserved),
        contradicted: stringList(coverage.contradicted),
      },
      pages: dispositions,
    }]
  })
  return assessments.length > 0 ? assessments : undefined
}

/**
 * The audit of an existing documentation site is what the reviewer approves
 * before a rewrite, so a first proposal that skips it is not approvable.
 */
export function existingDocumentationPlanIssue(
  plan: Pick<DocumentationPlan, 'existingDocumentation'>,
  base: Pick<DocumentationPlan, 'mode' | 'status'>,
  sources: SourceBinding[],
): string | undefined {
  // Only the first proposal of a create run is gated: an update plan scoped to
  // one change should not have to re-audit the whole existing site.
  if (base.mode !== 'create' || base.status !== 'planning') return undefined
  const missing = docsSiteSources(sources).filter((source) => !plan.existingDocumentation?.some((assessment) => assessment.source === source.name && assessment.pages.length > 0))
  if (missing.length === 0) return undefined
  return `The plan does not assess the existing documentation site${missing.length === 1 ? '' : 's'} ${missing.map((source) => `"${source.name}"`).join(', ')}. Add an "existingDocumentation" entry per docs-site source with a summary, findings, coverage (gaps, obsolete, preserved, contradicted), and a disposition for every crawled page listed in the snapshot's index.md.`
}

/** Crawled pages the plan never placed are reported for the reviewer rather than sent back to the planner. */
export function existingDocumentationAdvisory(
  plan: Pick<DocumentationPlan, 'existingDocumentation'>,
  sources: SourceBinding[],
  discovery: Pick<DocumentationDiscoveryInventory, 'sources'>,
): string | undefined {
  const notes: string[] = []
  for (const source of docsSiteSources(sources)) {
    const inventory = discovery.sources.find((item) => item.name === source.name)
    if (!inventory) continue
    const crawled = inventory.evidence.filter((item) => item.path !== 'index.md').map((item) => item.path)
    const assessment = plan.existingDocumentation?.find((item) => item.source === source.name)
    const placed = new Set((assessment?.pages ?? []).map((page) => page.path))
    const unplaced = crawled.filter((path) => !placed.has(path))
    if (unplaced.length === 0) continue
    notes.push(`${unplaced.length} of ${crawled.length} crawled pages from "${source.name}" have no disposition in this plan (for example ${unplaced.slice(0, 3).join(', ')}). Their content is neither rewritten nor explicitly dropped; ask the agent to place them or accept that they are left behind.`)
  }
  return notes.length > 0 ? notes.join(' ') : undefined
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

/**
 * Fix what a corrective planning pass would only relabel. In required
 * screenshot mode every screenshot-enabled page is required by definition,
 * so a "recommended" label is a wording slip, not a planning decision, and
 * a second full pass to change the word costs as much as the first proposal.
 *
 * The same goes for the other slips the required-screenshot gate catches: a
 * guide whose visual purpose landed in the page's own rationale, a start path
 * written without its leading slash, or a workflow the planner left out while
 * spelling the same steps out in the capture sequence. Real runs paid a second
 * planning pass — six to twenty minutes, with the browser exploration repeated
 * — for each of these, so they are repaired here and reported on the log.
 */
/** The capture IDs the application research brief recorded, or undefined when there is no brief. */
export async function knownPlanningCaptureIds(root: string, planId: string): Promise<Set<string> | undefined> {
  if (!/^[\w-]+$/.test(planId)) return undefined
  let brief: { content?: { screens?: Array<{ captures?: Array<{ id?: unknown }> }> } }
  try { brief = JSON.parse(await readFile(join(root, '.doxloop', 'plans', planId, 'research', 'application.json'), 'utf8')) } catch { return undefined }
  const ids = new Set<string>()
  for (const screen of Array.isArray(brief.content?.screens) ? brief.content.screens : []) {
    for (const capture of Array.isArray(screen?.captures) ? screen.captures : []) if (typeof capture?.id === 'string' && capture.id) ids.add(capture.id)
  }
  return ids
}

/** Blank every visuals.captureIds entry that names no saved capture; returns how many were blanked. */
export function dropUnknownCaptureIds(raw: unknown, known: ReadonlySet<string>): number {
  if (!raw || typeof raw !== 'object' || !Array.isArray((raw as { pages?: unknown }).pages)) return 0
  let blanked = 0
  for (const page of (raw as { pages: unknown[] }).pages) {
    const visuals = (page as { visuals?: { captureIds?: unknown } })?.visuals
    if (!visuals || !Array.isArray(visuals.captureIds)) continue
    visuals.captureIds = visuals.captureIds.map((id) => {
      if (typeof id !== 'string') return ''
      if (id === '' || known.has(id)) return id
      blanked += 1
      return ''
    })
  }
  return blanked
}

export function repairMechanicalPlanIssues(raw: unknown, execution: DocumentationPlanExecution): unknown {
  const intent = normalizeScreenshotIntent(execution.screenshots)
  if (intent === 'disabled') return raw
  if (!raw || typeof raw !== 'object' || !Array.isArray((raw as { pages?: unknown }).pages)) return raw
  const pages = (raw as { pages: unknown[] }).pages
  const repairs = { relabeled: 0, rationale: 0, startPath: 0, workflow: 0 }
  const next = pages.map((page) => {
    if (!page || typeof page !== 'object') return page
    const visualsRaw = (page as { visuals?: unknown }).visuals
    if (!visualsRaw || typeof visualsRaw !== 'object') return page
    const visuals = { ...(visualsRaw as Record<string, unknown>) }
    if (visuals.mode === 'recommended' && intent === 'enabled') {
      repairs.relabeled += 1
      visuals.mode = 'required'
    }
    if (visuals.mode !== 'required' && visuals.mode !== 'recommended') return { ...page, visuals }
    const text = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value.trim() : undefined)
    if (!text(visuals.rationale)) {
      const fallback = text(visuals.purpose) ?? text((page as { rationale?: unknown }).rationale) ?? text((page as { purpose?: unknown }).purpose)
      if (fallback) {
        repairs.rationale += 1
        visuals.rationale = fallback
      }
    }
    const startPath = text(visuals.startPath)
    if (startPath && !validCaptureStartPath(startPath)) {
      const candidate = `/${startPath.replace(/^(?:\.\/|\/)+/, '')}`
      if (validCaptureStartPath(candidate)) {
        repairs.startPath += 1
        visuals.startPath = candidate
      }
    }
    const sequence = Array.isArray(visuals.captureSequence) ? visuals.captureSequence.filter((item): item is string => typeof item === 'string' && item.trim().length > 0) : []
    if ((text(visuals.workflow)?.length ?? 0) < 12 && sequence.length > 0) {
      const workflow = sequence.map((item) => item.split(/\s+—\s+/, 1)[0]!.trim()).filter(Boolean).join('; ')
      if (workflow.length >= 12) {
        repairs.workflow += 1
        visuals.workflow = workflow
      }
    }
    return { ...page, visuals }
  })
  const guides = (count: number) => `${count} screenshot guide${count === 1 ? '' : 's'}`
  if (repairs.relabeled > 0) process.stdout.write(`Marked ${guides(repairs.relabeled)} required: screenshots are required for this run, so best-effort visuals are not an option.\n`)
  if (repairs.rationale > 0) process.stdout.write(`Filled the visual purpose of ${guides(repairs.rationale)} from the page rationale the planner wrote instead.\n`)
  if (repairs.startPath > 0) process.stdout.write(`Normalized the start path of ${guides(repairs.startPath)} to an application-relative path.\n`)
  if (repairs.workflow > 0) process.stdout.write(`Derived the workflow of ${guides(repairs.workflow)} from the capture sequence the planner supplied.\n`)
  return { ...(raw as object), pages: next }
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
/** A screenshot-enabled guide needs at least one useful image, without a per-type quota. */
export const MINIMUM_GUIDE_CAPTURES = 1

function singleScreenWorkflow(workflow: string | undefined, rationale: string | undefined): boolean {
  return /\b(?:single|one|only one|a single)[ -](?:screen|state|view|page)\b|\bno (?:other|further|additional) (?:reachable )?(?:screen|state)/i.test(`${workflow ?? ''} ${rationale ?? ''}`)
}

/** Flag screenshot-enabled guides without a capture; one meaningful image is enough. */
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
  return `Screenshot-enabled guides need a meaningful capture: ${counts}. Reuse a saved image that proves the reader outcome, or mark the guide text-only with a concrete reason.`
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
      ...(captureSequence.length > 0 ? { captureSequence: captureSequence.slice(0, 20), captureIds: captureSequence.slice(0, 20).map((_, index) => typeof (visualsRaw.captureIds as unknown[])?.[index] === 'string' ? (visualsRaw.captureIds as string[])[index]! : '') } : {}),
    },
  }
}

function minimumPlannedCaptures(_type: string, mode: DocumentationPlanVisuals['mode']): number {
  if (mode === 'none') return 0
  return 1
}

function completeCaptureSequence(sequence: string[] | undefined, expected: number): boolean {
  if (!sequence || sequence.length !== expected) return false
  const normalized = sequence.map((item) => item.trim().toLowerCase())
  return sequence.every((item) => item.trim().length >= 20) && new Set(normalized).size === sequence.length
}

/**
 * A guide's start path only ever tells the capture browser where to open; a
 * hash fragment is how single-page applications address a tab or panel
 * (`/setting#member`), so it is a valid destination rather than a defect.
 */
function validCaptureStartPath(value: string | undefined): boolean {
  if (!value?.trim() || !value.startsWith('/') || value.startsWith('//') || /\s/.test(value)) return false
  try {
    const parsed = new URL(value, 'https://capture.invalid')
    return parsed.origin === 'https://capture.invalid' && !parsed.username && !parsed.password
  } catch {
    return false
  }
}

/**
 * Check the application and each screenshot guide's starting route, and
 * describe every problem as a warning rather than refusing the run.
 *
 * A readiness probe is a plain HTTP request, so it can disagree with what the
 * capture browser will see (a hash-routed or client-rendered route, a route
 * only a signed-in session can open). Capture already degrades on its own: a
 * screen it cannot reach becomes text-only steps with the reason recorded. So
 * none of this blocks approval or generation; the reviewer sees the warnings.
 */
async function capturePlanWarnings(
  root: string,
  application: Awaited<ReturnType<typeof loadProject>>['application'],
  pages: DocumentationPlanPage[],
): Promise<string[]> {
  const auth = await captureAuthContext(root)
  const readiness = await checkApplicationReadiness(application, auth)
  if (!readiness.reachable) {
    return [`${CAPTURE_WARNING_PREFIX} ${readiness.message} Generation continues; guides whose screens cannot be captured are written with text-only steps.`]
  }
  const routes = await Promise.all(pages.map(async (page) => {
    const startPath = page.visuals?.startPath
    if (!startPath || !validCaptureStartPath(startPath)) return { page, startPath, message: 'The starting route is missing or invalid.' }
    const route = await checkApplicationReadiness(application ? { ...application, readyPath: startPath } : undefined, auth)
    return { page, startPath, message: route.reachable ? undefined : route.message }
  }))
  return routes
    .filter((route) => route.message)
    .map((route) => `${CAPTURE_WARNING_PREFIX} the starting route${route.startPath ? ` ${route.startPath}` : ''} for "${route.page.title}" did not respond as ready. ${route.message} Generation continues; the capture browser opens the application and navigates to the screen, and any step it cannot reach is written as text-only.`)
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
  // A page lives in one navigation section (the first that lists it, which is
  // where the post-pass puts it); a section left with no page of its own,
  // like a "Protocol limits" that only repeated pages from earlier sections,
  // is dropped rather than becoming an empty group.
  const claimed = new Set<string>()
  const sections = sectionsRaw.map((rawSection, index) => {
    const section = record(rawSection)
    const title = textValue(section.title) ?? `Section ${index + 1}`
    const pageIds = stringList(section.pageIds).filter((id) => knownPageIds.has(id) && !claimed.has(id))
    for (const id of pageIds) claimed.add(id)
    const space = textValue(section.space)
    return {
      id: safeId(textValue(section.id) ?? title, `section-${index + 1}`),
      title,
      pageIds,
      ...(space ? { space } : {}),
    }
  }).filter((section) => section.pageIds.length > 0)
  if (sections.length === 0 && pages.length > 0) {
    const grouped = new Map<string, string[]>()
    for (const page of pages) grouped.set(page.type, [...(grouped.get(page.type) ?? []), page.id])
    for (const [type, pageIds] of grouped) sections.push({ id: safeId(type, 'documentation'), title: titleCase(type), pageIds })
  }
  const top = stringList(navigation.top).length ? stringList(navigation.top) : ['Documentation']
  return { top, sections: assignSectionSpaces(top, sections) }
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
