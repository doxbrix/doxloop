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
