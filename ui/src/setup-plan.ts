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
}

export const DEFAULT_READER_OUTCOME = 'Understand the product, get started, and complete the primary supported workflows.'

export interface SetupBatchLimits { maxPages: number; maxScreenshots: number; maxMinutes: number }

/**
 * The run limits a plan gets for a documentation depth. Mirrors the server's
 * `defaultBatchLimits` so the wizard's Review step shows the batch the plan
 * will actually be held to.
 */
export function batchLimitsForScope(scope: 'starter' | 'standard' | 'comprehensive' | 'custom', screenshots: 'auto' | 'enabled' | 'disabled'): SetupBatchLimits {
  const base = scope === 'starter'
    ? { maxPages: 5, maxMinutes: 15 }
    : scope === 'comprehensive'
      ? { maxPages: 40, maxMinutes: 120 }
      : { maxPages: 12, maxMinutes: 45 }
  // Three captures per page, as the server's defaultBatchLimits allows.
  return { ...base, maxScreenshots: screenshots === 'disabled' ? 0 : base.maxPages * 3 }
}

export function describeBatchLimits(limits: SetupBatchLimits): string {
  return `${limits.maxPages} pages · ${limits.maxScreenshots} screenshots · ${limits.maxMinutes} minutes per attempt`
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
    if (input.screenshots !== 'disabled') return setupCaptureProfileIssue(input)
    return undefined
  }
  return undefined
}

export function setupDocumentationPlanRequest(form: SetupPlanForm) {
  const readerOutcome = form.readerOutcome.trim() || DEFAULT_READER_OUTCOME
  const captureContext = form.screenshots !== 'disabled' && form.applicationBaseUrl?.trim()
    ? `\nApplication screenshot capture: use ${setupApplicationCaptureTarget(form.applicationBaseUrl, form.applicationStartPath ?? '/')} as the initial safe capture surface. Infer only evidence-supported, non-destructive visible workflows and propose the meaningful states before capture.`
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
    limits: batchLimitsForScope(form.scope, form.screenshots),
  }
}
