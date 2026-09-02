import { describe, expect, it } from 'vitest'
import { countPlanPages, formatPlanSection, groupPlanPages, planActionLabel, planApprovalControls } from './plan-review'
import type { DocumentationPlanPage } from './types'

const pages: DocumentationPlanPage[] = [
  page('intro', 'Introduction', 'getting-started', 'update'),
  page('install', 'Installation', 'getting-started', 'preserve'),
  page('react', 'React example', 'examples', 'create'),
  page('legacy', 'Legacy API', 'reference', 'remove'),
  page('cli', 'CLI reference', 'reference', 'create', 'later'),
]

describe('documentation plan review helpers', () => {
  it('counts only pages included in the current generation as active work', () => {
    expect(countPlanPages(pages)).toEqual({
      create: 1,
      update: 1,
      preserve: 1,
      remove: 1,
      pagesToWrite: 2,
      activeChanges: 3,
    })
  })

  it('groups visible pages by documentation section while preserving plan order', () => {
    expect(groupPlanPages(pages, 'all').flatMap((group) => group.pages)).toHaveLength(4)
    expect(groupPlanPages(pages, 'changes')).toEqual([
      { id: 'getting-started', title: 'Getting started', pages: [{ page: pages[0], index: 0 }] },
      { id: 'examples', title: 'Examples', pages: [{ page: pages[2], index: 2 }] },
      { id: 'reference', title: 'Reference', pages: [{ page: pages[3], index: 3 }] },
    ])
    expect(groupPlanPages(pages, 'remove')[0]?.pages[0]?.page.title).toBe('Legacy API')
  })

  it('turns internal values into reader-friendly labels', () => {
    expect(formatPlanSection('getting_started')).toBe('Getting started')
    expect(planActionLabel('preserve')).toBe('Unchanged')
    expect(planActionLabel('remove')).toBe('Delete')
    expect(planActionLabel('create')).toBe('Create')
  })

  it('keeps approval visible while required-screenshot changes wait to be saved', () => {
    expect(planApprovalControls({
      changed: true,
      busy: false,
      hasPages: true,
      hasQuestions: false,
      captureRequired: true,
      hasVisualPages: true,
      captureReady: true,
    })).toEqual({ showSave: true, showApprove: true, approveDisabled: true })
  })

  it('blocks required-screenshot approval while the application cannot be reached', () => {
    // The reviewer sees a disabled button here, so the plan review must always
    // pair this state with the reason and a way to re-check.
    expect(planApprovalControls({
      changed: false,
      busy: false,
      hasPages: true,
      hasQuestions: false,
      captureRequired: true,
      hasVisualPages: true,
      captureReady: false,
    }).approveDisabled).toBe(true)
  })

  it('enables required-screenshot approval after the saved plan is capture-ready', () => {
    expect(planApprovalControls({
      changed: false,
      busy: false,
      hasPages: true,
      hasQuestions: false,
      captureRequired: true,
      hasVisualPages: true,
      captureReady: true,
    })).toEqual({ showSave: false, showApprove: true, approveDisabled: false })
  })
})

function page(
  id: string,
  title: string,
  type: string,
  action: DocumentationPlanPage['action'],
  priority: DocumentationPlanPage['priority'] = 'must-have',
): DocumentationPlanPage {
  return { id, title, path: id, type, action, priority, purpose: `${title} purpose`, rationale: '', evidence: [], evidenceDetails: [] }
}
