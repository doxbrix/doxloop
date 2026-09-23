import type { DocumentationPlanPage } from './types'

export type PlanPageFilter = 'all' | 'changes' | 'create' | 'update' | 'preserve' | 'remove'

export interface PlanPageCounts {
  create: number
  update: number
  preserve: number
  remove: number
  pagesToWrite: number
  activeChanges: number
}

export interface PlanPageGroup {
  id: string
  title: string
  pages: Array<{ page: DocumentationPlanPage; index: number }>
}

export interface PlanApprovalControlsInput {
  changed: boolean
  busy: boolean
  hasPages: boolean
  hasQuestions: boolean
  captureRequired: boolean
  hasVisualPages: boolean
  captureReady: boolean
}

export interface PlanApprovalControls {
  showSave: boolean
  showApprove: true
  approveDisabled: boolean
}

export function planApprovalControls(input: PlanApprovalControlsInput): PlanApprovalControls {
  return {
    showSave: input.changed,
    showApprove: true,
    approveDisabled:
      input.changed ||
      input.busy ||
      !input.hasPages ||
      input.hasQuestions ||
      (input.captureRequired && !input.hasVisualPages) ||
      !input.captureReady,
  }
}

export function countPlanPages(pages: DocumentationPlanPage[]): PlanPageCounts {
  const counts: PlanPageCounts = { create: 0, update: 0, preserve: 0, remove: 0, pagesToWrite: 0, activeChanges: 0 }
  for (const page of pages) {
    if (page.priority === 'later') continue
    counts[page.action] += 1
    if (page.action === 'create' || page.action === 'update') counts.pagesToWrite += 1
    if (page.action !== 'preserve') counts.activeChanges += 1
  }
  return counts
}

export function groupPlanPages(pages: DocumentationPlanPage[], filter: PlanPageFilter): PlanPageGroup[] {
  const groups = new Map<string, PlanPageGroup>()
  pages.forEach((page, index) => {
    if (!pageMatchesFilter(page, filter)) return
    const id = page.type.trim() || 'documentation'
    const existing = groups.get(id)
    if (existing) {
      existing.pages.push({ page, index })
      return
    }
    groups.set(id, { id, title: formatPlanSection(id), pages: [{ page, index }] })
  })
  return [...groups.values()]
}

export function formatPlanSection(value: string): string {
  const words = value.trim().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ') || 'Documentation'
  return words.charAt(0).toUpperCase() + words.slice(1)
}

export function planActionLabel(action: DocumentationPlanPage['action']): string {
  if (action === 'preserve') return 'Unchanged'
  if (action === 'remove') return 'Delete'
  return action.charAt(0).toUpperCase() + action.slice(1)
}

function pageMatchesFilter(page: DocumentationPlanPage, filter: PlanPageFilter): boolean {
  if (page.priority === 'later') return false
  if (filter === 'all') return true
  if (filter === 'changes') return page.action !== 'preserve'
  return page.action === filter
}

export type PlanPrimaryAction = 'approve' | 'generate' | 'retry-generating' | 'retry-planning'

/**
 * What the plan review's primary button does. A plan that failed before it
 * proposed any pages cannot be approved, so its button retries planning and
 * ignores the approval rules that assume pages exist.
 */
export function planPrimaryAction(plan: { status: string; failure?: { stage: string } }): PlanPrimaryAction {
  if (plan.status === 'approved') return 'generate'
  if (plan.status === 'failed') return plan.failure?.stage === 'propose' ? 'retry-planning' : 'retry-generating'
  return 'approve'
}

/** Task pages a reader follows on screen: the pages screenshots are for. */
export function isGuidePage(page: Pick<DocumentationPlanPage, 'type'>): boolean {
  const type = page.type.trim().toLowerCase().replace(/[\s_]+/g, '-')
  return /(^|-)(how-?to|tutorials?|guides?|quickstart|walkthrough)s?($|-)/.test(type)
}

export interface PlanScreenshotCoverage {
  guides: number
  withScreenshots: number
  /** Why coverage is thin, when the evidence says so. */
  reason: 'sign-in' | 'unreachable' | 'unknown'
}

const SIGN_IN_ROUTE = /(sign-?in|sign-?up|log-?in|register|auth|password)/i

/**
 * Warn before approval when most guides will be text-only although the
 * project asked for screenshots. A plan whose only screenshots are of the
 * sign-in screens means the planner never got past the login page.
 */
export function planScreenshotCoverage(
  pages: Array<Pick<DocumentationPlanPage, 'type' | 'priority' | 'visuals'>>,
  intent: 'auto' | 'enabled' | 'disabled',
  readiness?: { status?: string; reachable?: boolean; signInPath?: string },
): PlanScreenshotCoverage | undefined {
  if (intent === 'disabled') return undefined
  const guides = pages.filter((page) => page.priority !== 'later' && isGuidePage(page))
  if (guides.length < 3) return undefined
  const visual = guides.filter((page) => page.visuals && page.visuals.mode !== 'none')
  if (visual.length * 2 >= guides.length) return undefined
  const onlySignInScreens = visual.length > 0 && visual.every((page) => SIGN_IN_ROUTE.test(page.visuals?.startPath ?? ''))
  const reason = readiness?.status === 'authentication-required' || readiness?.signInPath || onlySignInScreens
    ? 'sign-in'
    : readiness && readiness.reachable === false ? 'unreachable' : 'unknown'
  return { guides: guides.length, withScreenshots: visual.length, reason }
}

export interface RetryAgentOption {
  name: string
  status: 'authenticated' | 'unauthenticated' | 'unknown'
}

/**
 * The assistant a failed plan should retry with by default: the one it used
 * if it is still signed in, otherwise the project default, otherwise any
 * signed-in assistant. Retrying with a signed-out assistant fails the same way.
 */
export function retryAgentChoice(agents: RetryAgentOption[], planAgent: string | undefined, defaultAgent: string | undefined): string {
  const signedIn = (name: string | undefined) => Boolean(name) && agents.some((agent) => agent.name === name && agent.status === 'authenticated')
  if (signedIn(planAgent)) return planAgent!
  if (signedIn(defaultAgent)) return defaultAgent!
  const any = agents.find((agent) => agent.status === 'authenticated') ?? agents.find((agent) => agent.status === 'unknown')
  return any?.name ?? planAgent ?? defaultAgent ?? agents[0]?.name ?? ''
}
