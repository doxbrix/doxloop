import { describe, expect, test } from 'vitest'
import {
  agentIdleLimitMs,
  batchContract,
  batchPassLine,
  batchPlanSlice,
  describeIssues,
  finalCheckAnnouncement,
  splitBatchIssues,
  batchNeedsExclusiveStart,
  batchTurnBudget,
  captureSessionGroups,
  chunkIssuesByFile,
  fixContract,
  isForwardLinkIssue,
  issuesForFiles,
  parallelismFromEnvironment,
  planAuthoringBatches,
  plannedCaptures,
  sourceSearchGuidance,
  writablePlanPages,
} from './authoring-batches.js'
import type { DocumentationPlan, DocumentationPlanPage } from './types.js'

function page(id: string, overrides: Partial<DocumentationPlanPage> = {}): DocumentationPlanPage {
  return {
    id,
    title: id,
    path: id,
    type: 'guide',
    priority: 'now',
    action: 'create',
    purpose: `Explain ${id}.`,
    rationale: '',
    evidence: [],
    evidenceDetails: [],
    ...overrides,
  } as DocumentationPlanPage
}

function plan(pages: DocumentationPlanPage[], sections: Array<{ id: string; title: string; pageIds: string[] }> = []): Pick<DocumentationPlan, 'pages' | 'navigation'> {
  return { pages, navigation: { top: ['Docs'], sections } }
}

describe('authoring batches', () => {
  test('writes only approved create/update pages that are not deferred', () => {
    const pages = [
      page('a'),
      page('b', { action: 'update' }),
      page('c', { action: 'preserve' }),
      page('d', { action: 'remove' }),
      page('e', { priority: 'later' }),
    ]
    expect(writablePlanPages({ pages }).map((item) => item.id)).toEqual(['a', 'b'])
  })

  test('splits pages into batches by size, keeping sections together and the landing page first', () => {
    const pages = [
      page('guides/one'), page('guides/two'), page('guides/three'),
      page('admin/one'), page('admin/two'),
      page('index'),
      page('ref/one'), page('ref/two'),
    ]
    const batches = planAuthoringBatches(plan(pages, [
      { id: 'guides', title: 'Guides', pageIds: ['guides/one', 'guides/two', 'guides/three'] },
      { id: 'admin', title: 'Admin', pageIds: ['admin/one', 'admin/two'] },
      { id: 'ref', title: 'Reference', pageIds: ['ref/one', 'ref/two'] },
    ]), pages, { maxPages: 3 })
    expect(batches.map((batch) => batch.pages.map((item) => item.id))).toEqual([
      ['index', 'guides/one', 'guides/two'],
      ['guides/three', 'admin/one', 'admin/two'],
      ['ref/one', 'ref/two'],
    ])
    expect(batches.map((batch) => [batch.index, batch.total])).toEqual([[1, 3], [2, 3], [3, 3]])
  })

  test('starts a new batch when planned captures would exceed the limit and folds a trailing singleton', () => {
    const heavy = (id: string) => page(id, { visuals: { mode: 'recommended', rationale: '', estimatedCaptures: 5, startPath: '/', captureSequence: ['a — b — c', 'a — b — c', 'a — b — c', 'a — b — c', 'a — b — c'] } })
    const pages = [heavy('one'), heavy('two'), heavy('three'), page('four'), page('five')]
    const batches = planAuthoringBatches(plan(pages), pages, { maxPages: 6, maxCaptures: 10 })
    expect(batches.map((batch) => batch.pages.map((item) => item.id))).toEqual([['one', 'two'], ['three', 'four', 'five']])
    expect(batches[0]!.captures).toBe(10)
    expect(plannedCaptures(pages[3]!)).toBe(0)
  })

  test('returns no batches when nothing is left to write', () => {
    expect(planAuthoringBatches(plan([]), [])).toEqual([])
  })

  test('budgets turns from pages and captures with a floor', () => {
    expect(batchTurnBudget({ pages: [page('a')], captures: 0 }, {})).toBe(60)
    expect(batchTurnBudget({ pages: [page('a'), page('b'), page('c')], captures: 6 }, {})).toBe(3 * 30 + 6 * 12)
    expect(batchTurnBudget({ pages: [page('a')], captures: 0 }, { DOXLOOP_AGENT_MAX_TURNS: '25' })).toBe(25)
  })

  test('describes the batch, the finished pages, and the upcoming ones in the contract', () => {
    const batch = { index: 2, total: 3, pages: [page('guides/two', { visuals: { mode: 'required', rationale: '', estimatedCaptures: 2, startPath: '/two', captureSequence: ['Open /two — The two screen — Orient', 'Click Save — Saved banner — Prove'] } })], captures: 2 }
    const text = batchContract({ batch, completed: [page('index')], upcoming: [page('guides/three')], screenshots: true, mode: 'create', precaptured: 1 })
    expect(text).toContain('BATCH 2 OF 3')
    expect(text).toContain('- guides/two — "guides/two" (guide, create)')
    expect(text).toContain('screenshots: required, start at /two, 2 planned captures')
    expect(text).toContain('already written in earlier batches')
    expect(text).toContain('/index')
    expect(text).toContain('other batches write later')
    expect(text).toContain('/guides/three')
    expect(text).toContain('already captured 1 entry-screen step')
    expect(text).toContain('do not run `doxloop test`')
    expect(text).not.toContain('first batch of a new documentation set')
    expect(batchContract({ batch: { ...batch, index: 1 }, completed: [], upcoming: [], screenshots: false, mode: 'create', exclusive: true })).toContain('first batch of a new documentation set')
  })

  test('selects errors and depth warnings for the batch files and formats a fix contract', () => {
    const issues = [
      { severity: 'error' as const, code: 'broken-link', message: 'Local link target does not exist: /guides/quickstart', file: 'guides/one.mdx' },
      { severity: 'warning' as const, code: 'thin-page', message: 'Too thin.', file: 'guides/one.mdx' },
      { severity: 'warning' as const, code: 'evidence-unverified', message: 'Needs a human.', file: 'guides/one.mdx' },
      { severity: 'error' as const, code: 'broken-link', message: 'Elsewhere.', file: 'other.mdx' },
      { severity: 'error' as const, code: 'unnavigated-page', message: 'Not in navigation.' },
    ]
    const selected = issuesForFiles(issues, new Set(['guides/one.mdx']), { includeWarnings: true })
    expect(selected.map((issue) => issue.code)).toEqual(['broken-link', 'thin-page'])
    expect(issuesForFiles(issues, new Set(['guides/one.mdx'])).map((issue) => issue.code)).toEqual(['broken-link'])
    const text = fixContract({ issues: selected, files: ['guides/one.mdx'], round: 1, maxRounds: 2 })
    expect(text).toContain('FIX ROUND 1 OF 2')
    expect(text).toContain('guides/one.mdx:')
    expect(text).toContain('error broken-link: Local link target does not exist')
    expect(text).toContain('warning thin-page')
    expect(text).toContain('do not run validation yourself')
  })
})

describe('parallel batch helpers', () => {
  test('reads the parallelism from the environment with a bounded default', () => {
    expect(parallelismFromEnvironment({})).toBe(2)
    expect(parallelismFromEnvironment({ DOXLOOP_AUTHORING_PARALLEL: '1' })).toBe(1)
    expect(parallelismFromEnvironment({ DOXLOOP_AUTHORING_PARALLEL: '12' })).toBe(6)
    expect(parallelismFromEnvironment({ DOXLOOP_AUTHORING_PARALLEL: 'nope' })).toBe(2)
  })

  test('runs the landing page and a new site\'s first batch alone', () => {
    const landing = { index: 1, total: 3, pages: [page('index'), page('a')], captures: 0 }
    const plain = { index: 1, total: 3, pages: [page('a'), page('b')], captures: 0 }
    expect(batchNeedsExclusiveStart(landing, 'update')).toBe(true)
    expect(batchNeedsExclusiveStart(plain, 'update')).toBe(false)
    expect(batchNeedsExclusiveStart(plain, 'create')).toBe(true)
    expect(batchNeedsExclusiveStart({ ...plain, index: 2 }, 'create')).toBe(false)
  })

  test('chunks issues by file for consolidated fix sessions', () => {
    const issue = (file: string, code = 'thin-page') => ({ severity: 'warning' as const, code, message: 'm', file })
    const chunks = chunkIssuesByFile([issue('a'), issue('a', 'broken-link'), issue('b'), issue('c'), issue('d'), issue('e')], 2)
    expect(chunks.map((chunk) => chunk.map((item) => item.file))).toEqual([['a', 'a', 'b'], ['c', 'd'], ['e']])
  })

  test('tells concurrent sessions to use their slices and leave shared files alone', () => {
    const batch = { index: 2, total: 4, pages: [page('guides/two')], captures: 0 }
    const text = batchContract({
      batch,
      completed: [],
      upcoming: [page('guides/three')],
      screenshots: true,
      mode: 'update',
      concurrent: true,
      artifacts: { slice: '.doxloop/cache/authoring-batch-2.json', manifest: '.doxloop/cache/screenshot-manifest-batch-2.json', evidence: '.doxloop/cache/evidence-batch-2.json', pack: '.doxloop/cache/evidence-pack-batch-2.md' },
    })
    expect(text).toContain('several at the same time')
    expect(text).toContain('Start from the evidence pack at .doxloop/cache/evidence-pack-batch-2.md')
    expect(text).toContain('Read .doxloop/cache/authoring-batch-2.json')
    expect(text).toContain('do not edit it or the main manifest')
    expect(text).toContain('.doxloop/cache/evidence-batch-2.json')
    expect(text).toContain('Do not edit the navigation or site configuration')
    expect(text).toContain('some of them right now')
    const exclusive = batchContract({ batch: { ...batch, index: 1 }, completed: [], upcoming: [], screenshots: false, mode: 'create', exclusive: true })
    expect(exclusive).toContain('runs alone')
    expect(exclusive).not.toContain('Do not edit the navigation')
  })
})

describe('forward links and capture sessions', () => {
  test('recognises a broken link whose target another batch still writes', () => {
    const pending = ['guides/labels', 'guides/recurring-tasks-and-reminders']
    const issue = (target: string) => ({ severity: 'error' as const, code: 'broken-link', message: `Local link target does not exist: ${target}`, file: 'guides/managing-tasks.mdx' })
    expect(isForwardLinkIssue(issue('/guides/labels'), pending)).toBe(true)
    expect(isForwardLinkIssue(issue('/guides/recurring-tasks-and-reminders#daily'), pending)).toBe(true)
    expect(isForwardLinkIssue(issue('../guides/labels.mdx'), pending)).toBe(true)
    expect(isForwardLinkIssue(issue('/guides/teams'), pending)).toBe(false)
    expect(isForwardLinkIssue({ ...issue('/guides/labels'), code: 'invalid-link' }, pending)).toBe(false)
    expect(isForwardLinkIssue(issue('/guides/labels'), [])).toBe(false)
  })

  test('groups guides needing captures into a few sessions bounded by planned steps', () => {
    const guide = (id: string, steps: number, verified = 0) => ({ id, guide: { steps: Array.from({ length: steps }, (_, index) => ({ status: index < verified ? 'verified' : 'planned' })) } })
    const groups = captureSessionGroups([guide('a', 2), guide('b', 3), guide('c', 2), guide('d', 5), guide('e', 1), guide('f', 1, 1)])
    expect(groups.map((group) => group.map((item) => item.id))).toEqual([['a', 'b', 'c'], ['d', 'e', 'f']])
    expect(captureSessionGroups([guide('a', 2), guide('b', 3)], { DOXLOOP_CAPTURE_GUIDES_PER_SESSION: '1' }).length).toBe(2)
    expect(captureSessionGroups([])).toEqual([])
  })

  test('points the writer at the cited directories and excludes noise from source searches', () => {
    const text = sourceSearchGuidance([page('tasks', { evidenceDetails: [{ source: 'vikunja', path: 'frontend/src/components/tasks/AddTask.vue', kind: 'integration', label: 'AddTask.vue' }] })])
    expect(text).toContain('vikunja: frontend/src')
    expect(text).toContain('--exclude-dir=node_modules')
    expect(text).toContain("--exclude='*_test.go'")
    expect(batchContract({ batch: { index: 2, total: 3, pages: [page('tasks')], captures: 0 }, completed: [], upcoming: [], screenshots: false, mode: 'create' })).toContain('--exclude-dir=migrations')
  })
})

describe('inactivity watchdog', () => {
  test('reads the idle limit from the environment with a bounded default', () => {
    expect(agentIdleLimitMs({})).toBe(6 * 60_000)
    expect(agentIdleLimitMs({ DOXLOOP_AGENT_IDLE_MINUTES: '2.5' })).toBe(150_000)
    expect(agentIdleLimitMs({ DOXLOOP_AGENT_IDLE_MINUTES: '0' })).toBe(0)
    expect(agentIdleLimitMs({ DOXLOOP_AGENT_IDLE_MINUTES: 'soon' })).toBe(6 * 60_000)
  })

  test('tells the writer to save each page as it is finished', () => {
    const page = { id: 'a', path: 'guides/a', title: 'A', type: 'how-to', action: 'create', priority: 'must-have', evidence: [] } as never
    const text = batchContract({ batch: { index: 2, total: 3, pages: [page], captures: 0 }, completed: [], upcoming: [], screenshots: false, mode: 'create' })
    expect(text).toContain('Save each page with its own edit the moment it is complete')
  })
})

describe('issue wording', () => {
  const warning = (file: string, code = 'api-endpoint-param-example') => ({ severity: 'warning' as const, code, message: 'm', file })
  const error = (file: string) => ({ severity: 'error' as const, code: 'broken-link', message: 'm', file })

  test('calls warning-only end-of-run work a final polish and names the kinds of suggestion', () => {
    const issues = [...Array.from({ length: 150 }, () => warning('api/memos.mdx')), ...Array.from({ length: 54 }, (_, index) => warning(`api/p${index % 8}.mdx`))]
    expect(finalCheckAnnouncement(issues, 2, 2)).toBe('Final polish: 204 minor suggestions (missing parameter examples) in 9 pages; fixing in 2 sessions, up to 2 at a time.')
    expect(finalCheckAnnouncement([error('a.mdx'), warning('b.mdx', 'thin-page')], 1, 2)).toBe('Final check: 1 error and 1 suggestion (thin pages) in 2 pages; fixing in 1 session.')
    expect(describeIssues([error('a.mdx')])).toBe('1 error in 1 page')
  })

  test('issues on a page the post-pass renamed from .md to .mdx still belong to the batch', () => {
    expect(issuesForFiles([error('guides/inbox.mdx'), error('guides/other.mdx')], new Set(['guides/inbox.md']))).toEqual([error('guides/inbox.mdx')])
  })

  test('a batch fixes suggestions only alongside errors, in the same session', () => {
    expect(splitBatchIssues([warning('a.mdx')])).toEqual({ fix: [], deferred: [warning('a.mdx')] })
    expect(splitBatchIssues([error('a.mdx'), warning('a.mdx')])).toEqual({ fix: [error('a.mdx'), warning('a.mdx')], deferred: [] })
  })

  test('a passing batch says how many suggestions wait for the final polish', () => {
    expect(batchPassLine('Batch 14', 4, [])).toBe('Batch 14: 4 pages pass validation.')
    expect(batchPassLine('Batch 14', 4, [warning('a.mdx'), warning('a.mdx', 'thin-page')])).toBe('Batch 14: 4 pages pass validation (2 minor suggestions left for the final polish).')
  })

  test('the batch slice and contract name one page extension', () => {
    const pages = [page('guides/inbox')]
    const documentationPlan = { ...plan(pages), target: { generator: 'doxbrix', contentDir: '', contentFormat: 'markdown', pageExtensions: ['.md', '.mdx'], navigationFiles: ['docs.json'] } } as unknown as DocumentationPlan
    const batch = { index: 1, total: 1, pages, captures: 0 }
    expect(batchPlanSlice(documentationPlan, batch).pageExtension).toBe('.mdx')
    const contract = batchContract({ batch, completed: [], upcoming: [], screenshots: false, mode: 'create', pageExtension: '.mdx' })
    expect(contract).toContain('Save every new page as its path plus .mdx (for example guides/inbox.mdx)')
  })
})
