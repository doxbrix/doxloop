import { expect, test } from 'vitest'
import { approvedBatchLimits, assertBatchFits, batchLimits } from './batch-limits.js'
import type { DocumentationPlan } from './types.js'
test('limits reject invalid input and oversized batches while allowing explicitly deferred work', () => {
  expect(() => batchLimits({ maxPages: -1 })).toThrow('maxPages')
  expect(() => batchLimits({ maxMinutes: Infinity })).toThrow('maxMinutes')
  expect(() => batchLimits({ maxScreenshots: 1.5 })).toThrow('maxScreenshots')
  const plan = { execution: { screenshots: 'enabled', limits: { maxPages: 1, maxScreenshots: 1, maxMinutes: 10 } }, pages: [{ path: 'a', action: 'update', priority: 'must-have', visuals: { mode: 'required', estimatedCaptures: 2 } }, { path: 'b', action: 'create', priority: 'later' }] } as DocumentationPlan
  expect(() => assertBatchFits(plan)).toThrow('screenshots')
  plan.pages[0]!.visuals!.estimatedCaptures = 1
  expect(() => assertBatchFits(plan)).not.toThrow()
  plan.pages[1]!.priority = 'next'
  expect(() => assertBatchFits(plan)).toThrow('2 pages')
  plan.pages[1]!.action = 'remove'
  expect(() => assertBatchFits(plan)).toThrow('2 pages')
})
test('the approved batch is never smaller than the plan that approval accepted', () => {
  const pages = [
    { path: 'a', action: 'update', priority: 'must-have', visuals: { mode: 'required', estimatedCaptures: 15 } },
    { path: 'b', action: 'create', priority: 'next', visuals: { mode: 'recommended', estimatedCaptures: 10 } },
    { path: 'c', action: 'create', priority: 'later', visuals: { mode: 'required', estimatedCaptures: 40 } },
    { path: 'd', action: 'preserve', priority: 'must-have' },
  ]
  // A plan approved before limits were recorded keeps the defaults but still covers its own footprint.
  expect(approvedBatchLimits({ execution: { screenshots: 'enabled' }, pages } as DocumentationPlan)).toEqual({ maxPages: 50, maxScreenshots: 25, maxMinutes: 30 })
  expect(approvedBatchLimits({ execution: { screenshots: 'enabled', limits: { maxPages: 1, maxScreenshots: 30, maxMinutes: 10 } }, pages } as DocumentationPlan)).toEqual({ maxPages: 2, maxScreenshots: 30, maxMinutes: 10 })
  expect(approvedBatchLimits({ execution: { screenshots: 'disabled', limits: { maxPages: 5, maxScreenshots: 0, maxMinutes: 10 } }, pages } as DocumentationPlan)).toEqual({ maxPages: 5, maxScreenshots: 0, maxMinutes: 10 })
})
