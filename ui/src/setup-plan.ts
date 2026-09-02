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

export function setupCaptureProfileStatus(
  form: Pick<SetupPlanForm, 'screenshots' | 'applicationBaseUrl' | 'applicationStartPath'>,
): { required: boolean; started: boolean; complete: boolean } {
  const required = form.screenshots !== 'disabled'
  const startPath = form.applicationStartPath?.trim() ?? ''
  const started = required
  const complete = Boolean(
    form.applicationBaseUrl?.trim() &&
    startPath.startsWith('/') &&
    !startPath.startsWith('//'),
  )
  return { required, started, complete }
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
  }
}
