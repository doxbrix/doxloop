import { defaultBatchLimits, hasPageLimit, type BatchLimits, type BatchScope } from '../../src/batch-limits.js'

export interface SetupPlanForm {
  scope: 'starter' | 'standard' | 'comprehensive'
  readerOutcome: string
  clarificationMode: 'review' | 'defaults' | 'stop'
  agent: string
  model: string
  reasoning: string
  effort: string
  screenshots: 'auto' | 'enabled' | 'disabled'
  applicationBaseUrl?: string
  applicationStartPath?: string
  /** True when the user chose to continue although the app needs sign-in. */
  applicationSignInSkipped?: boolean
}

export const DEFAULT_READER_OUTCOME = 'Understand the product, get started, and complete the primary supported workflows.'

export type SetupBatchLimits = BatchLimits

/** Use the server's defaults when displaying limits for the selected depth. */
export function batchLimitsForScope(scope: BatchScope, screenshots: 'auto' | 'enabled' | 'disabled'): SetupBatchLimits {
  return defaultBatchLimits(scope, screenshots !== 'disabled')
}

export function describeBatchLimits(limits: SetupBatchLimits): string {
  return `${hasPageLimit(limits) ? `${limits.maxPages} pages` : 'No page limit'} · ${limits.maxScreenshots} screenshots · ${limits.maxMinutes} minutes per attempt`
}

export function screenshotIntentFromChoice(choice: 'yes' | 'no'): 'enabled' | 'disabled' {
  return choice === 'yes' ? 'enabled' : 'disabled'
}

export function setupApplicationCaptureTarget(baseUrl: string, startPath: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '')
  const path = startPath.trim() || '/'
  try {
    return new URL(path, `${base}/`).toString()
  } catch {
    return `${base}${path.startsWith('/') ? path : `/${path}`}`
  }
}

/**
 * Why the screenshot details cannot be checked yet, in words the user can act
 * on. Undefined when the URL and starting page are usable.
 */
export function setupCaptureProfileIssue(
  form: Pick<SetupPlanForm, 'applicationBaseUrl' | 'applicationStartPath'>,
): string | undefined {
  const baseUrl = form.applicationBaseUrl?.trim() ?? ''
  const startPath = form.applicationStartPath?.trim() ?? ''
  if (!baseUrl) return 'Enter the application URL, or choose No for screenshots.'
  if (!isAbsoluteHttpUrl(baseUrl)) return 'Enter the full application URL including http:// or https://, for example http://localhost:3000.'
  if (!startPath.startsWith('/') || startPath.startsWith('//')) return 'The starting page must be a route that begins with /, for example / or /settings/team.'
  return undefined
}

function isAbsoluteHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

export function setupCaptureProfileStatus(
  form: Pick<SetupPlanForm, 'screenshots' | 'applicationBaseUrl' | 'applicationStartPath'>,
): { required: boolean; started: boolean; complete: boolean; issue?: string } {
  const required = form.screenshots !== 'disabled'
  const started = required
  const issue = setupCaptureProfileIssue(form)
  return { required, started, complete: !issue, ...(issue ? { issue } : {}) }
}

export interface SetupStepInput {
  directory: string
  title: string
  sourceCount: number
  sourceDialogOpen: boolean
  agent: string
  agentInstalled: boolean
  agentLabel: string
  /** The installed agent's sign-in state, from `UiState.agents[].authentication`. */
  agentAuthentication?: { status: string; detail: string }
  /** The chosen reasoning or effort level, checked against `reasoningLevels`. */
  reasoning?: string
  reasoningLevels?: readonly string[]
  screenshots: SetupPlanForm['screenshots']
  applicationBaseUrl: string
  applicationStartPath: string
}

/**
 * What still blocks leaving a setup step, as a message for the user.
 *
 * The Continue and Create buttons stay enabled and run this on click, so a
 * missing field is explained instead of silently disabling the button. Path
 * errors that need the server are not covered here; the wizard validates
 * those after this passes. Undefined means the step is complete.
 */
export function setupStepIssue(step: number, input: SetupStepInput): string | undefined {
  if (step === 1) {
    if (!input.directory.trim()) return 'Enter a workspace name.'
    if (!input.title.trim()) return 'Enter a title for your documentation.'
    return undefined
  }
  if (step === 2) {
    if (input.sourceDialogOpen) return 'Finish adding the source, or close the Add source dialog, before continuing.'
    if (input.sourceCount === 0) return 'Add at least one source. Doxloop documents what it finds in your sources.'
    return undefined
  }
  if (step === 3) {
    if (input.agent && !input.agentInstalled) return `${input.agentLabel} is not installed. Install it, or choose a different coding assistant.`
    if (input.agent && input.agentAuthentication?.status === 'unauthenticated') return `${input.agentLabel} is signed out on this computer. ${signInInstruction(input.agent)}, or choose a different coding assistant.`
    const reasoning = input.reasoning?.trim() ?? ''
    if (reasoning && input.reasoningLevels?.length && !input.reasoningLevels.includes(reasoning)) return `"${reasoning}" is not a reasoning level for this model. Choose one of: ${input.reasoningLevels.join(', ')}.`
    if (input.screenshots !== 'disabled') return setupCaptureProfileIssue(input)
    return undefined
  }
  return undefined
}

/** The terminal step that signs an agent CLI in, in words a first-time user can follow. */
export function signInInstruction(agent: string): string {
  if (agent === 'claude') return 'Open Terminal, run `claude auth login`, then choose Check again'
  if (agent === 'codex') return 'Open Terminal, run `codex login`, then choose Check again'
  return 'Sign in to Gemini (run `gemini` once in Terminal, or set GEMINI_API_KEY), then choose Check again'
}

export interface SetupAgentOption {
  name: string
  executable?: string
  authentication?: { status: string; detail: string }
}

const AGENT_PREFERENCE = ['codex', 'claude', 'gemini']

/**
 * The assistant a new workspace starts with: an installed one that is signed
 * in, so the first plan does not fail on authentication. Falls back to any
 * installed assistant, then to Codex.
 */
export function preferredSetupAgent(agents: readonly SetupAgentOption[] | undefined): string {
  const installed = [...(agents ?? [])]
    .filter((agent) => agent.executable)
    .sort((left, right) => AGENT_PREFERENCE.indexOf(left.name) - AGENT_PREFERENCE.indexOf(right.name))
  return installed.find((agent) => agent.authentication?.status === 'authenticated')?.name
    ?? installed.find((agent) => agent.authentication?.status !== 'unauthenticated')?.name
    ?? installed[0]?.name
    ?? 'codex'
}

const SECRET_FORM_KEYS = ['applicationPassword', 'gitSecret'] as const

/**
 * What the wizard keeps as a browser draft so leaving setup, reloading, or a
 * crash does not lose the answers. Passwords and tokens are never stored.
 */
export function setupDraftSnapshot<F extends Record<string, unknown>, S extends Record<string, unknown>>(
  form: F,
  sources: readonly S[],
  step: number,
): { form: F; sources: S[]; step: number } {
  const safeForm = { ...form }
  for (const key of SECRET_FORM_KEYS) if (key in safeForm) (safeForm as Record<string, unknown>)[key] = ''
  return {
    form: safeForm,
    sources: sources.map((source) => ({ ...source, ...('gitSecret' in source ? { gitSecret: '' } : {}) })),
    step,
  }
}

export function setupDraftKey(cwd: string): string {
  return `doxloop.setup-draft:${cwd}`
}

export function setupDocumentationPlanRequest(form: SetupPlanForm) {
  const readerOutcome = form.readerOutcome.trim() || DEFAULT_READER_OUTCOME
  const captureContext = form.screenshots !== 'disabled' && form.applicationBaseUrl?.trim()
    ? `\nApplication screenshot capture: use ${setupApplicationCaptureTarget(form.applicationBaseUrl, form.applicationStartPath ?? '/')} as the initial safe capture surface. Infer only evidence-supported, non-destructive visible workflows and propose the meaningful states before capture.${form.applicationSignInSkipped ? ' The application needs sign-in and the user chose to continue without it: keep signed-in workflows text-only and do not ask for credentials or a test account.' : ''}`
    : ''
  return {
    mode: 'create' as const,
    scope: form.scope,
    request: `Primary reader outcome: ${readerOutcome}\nResearch the complete evidence-supported public product surface and propose a coherent ${form.scope} documentation set.${captureContext}`,
    clarificationMode: form.clarificationMode,
    ...(form.agent ? { agent: form.agent } : {}),
    ...(form.model ? { model: form.model } : {}),
    ...(form.agent === 'codex' && form.reasoning ? { reasoning: form.reasoning } : {}),
    ...(form.agent === 'claude' && form.effort ? { effort: form.effort } : {}),
    screenshots: form.screenshots,
    // Setup has no limit overrides. Let the running server choose its defaults
    // so a cached wizard cannot send limits that its server does not support.
  }
}
