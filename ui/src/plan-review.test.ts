import { describe, expect, it } from 'vitest'
import { countPlanPages, formatPlanSection, groupPlanPages, isGuidePage, planActionLabel, planApprovalControls, planPrimaryAction, planScreenshotCoverage, retryAgentChoice } from './plan-review'
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

describe('planPrimaryAction', () => {
  it('retries planning, not generation, when the plan failed before proposing pages', () => {
    expect(planPrimaryAction({ status: 'failed', failure: { stage: 'propose' } })).toBe('retry-planning')
    expect(planPrimaryAction({ status: 'failed', failure: { stage: 'generate' } })).toBe('retry-generating')
    expect(planPrimaryAction({ status: 'approved' })).toBe('generate')
    expect(planPrimaryAction({ status: 'ready-for-review' })).toBe('approve')
  })
})

describe('screenshot coverage before approval', () => {
  const guide = (visual?: string) => ({ type: 'how-to', priority: 'must-have' as const, visuals: visual === undefined ? { mode: 'none' as const, rationale: '', estimatedCaptures: 0 } : { mode: 'recommended' as const, rationale: '', estimatedCaptures: 1, startPath: visual } })
  it('recognises guide page types', () => {
    expect(['how-to', 'howto', 'tutorial', 'guides', 'user-guide', 'Quickstart'].every((type) => isGuidePage({ type }))).toBe(true)
    expect(['reference', 'concept', 'api', 'troubleshooting'].some((type) => isGuidePage({ type }))).toBe(false)
  })
  it('warns when most guides are text-only and blames the sign-in wall', () => {
    const pages = [guide('/auth/signin'), guide('/auth/signup'), ...Array.from({ length: 39 }, () => guide()), { type: 'reference', priority: 'must-have' as const }]
    expect(planScreenshotCoverage(pages, 'auto')).toEqual({ guides: 41, withScreenshots: 2, reason: 'sign-in', explained: 0 })
    expect(planScreenshotCoverage(pages, 'auto', { status: 'unreachable', reachable: false })).toEqual({ guides: 41, withScreenshots: 2, reason: 'sign-in', explained: 0 })
    expect(planScreenshotCoverage([guide('/home'), guide(), guide(), guide()], 'auto', { status: 'unreachable', reachable: false })?.reason).toBe('unreachable')
    expect(planScreenshotCoverage([guide(), guide(), guide()], 'auto', { status: 'authentication-required', reachable: true })?.reason).toBe('sign-in')
  })
  it('stays quiet when screenshots are off, guides are few, or most guides have images', () => {
    expect(planScreenshotCoverage([guide(), guide(), guide()], 'disabled')).toBeUndefined()
    expect(planScreenshotCoverage([guide(), guide()], 'auto')).toBeUndefined()
    expect(planScreenshotCoverage([guide('/a'), guide('/b'), guide()], 'auto')).toBeUndefined()
  })
  it('retries with a signed-in assistant by default', () => {
    const agents = [{ name: 'claude', status: 'unauthenticated' as const }, { name: 'codex', status: 'authenticated' as const }, { name: 'gemini', status: 'unknown' as const }]
    expect(retryAgentChoice(agents, 'claude', 'claude')).toBe('codex')
    expect(retryAgentChoice(agents, 'claude', 'gemini')).toBe('codex')
    expect(retryAgentChoice(agents, 'codex', 'claude')).toBe('codex')
    expect(retryAgentChoice([{ name: 'claude', status: 'unauthenticated' }, { name: 'gemini', status: 'unknown' }], 'claude', undefined)).toBe('gemini')
    expect(retryAgentChoice([{ name: 'claude', status: 'unauthenticated' }], 'claude', undefined)).toBe('claude')
  })
})
