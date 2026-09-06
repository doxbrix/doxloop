import { describe, expect, test } from 'vitest'
import { settledPageEditJobs, settledPlanJobs } from './job-transitions'
import type { UiJob } from './types'

function job(id: string, type: string, status: UiJob['status']): UiJob {
  return { id, type, status, startedAt: '2026-08-25T00:00:00.000Z', lines: [], stages: [] }
}

describe('plan job transitions', () => {
  test.each(['succeeded', 'failed', 'cancelled'] as const)(
    'refreshes persisted plan state when planning %s',
    (status) => {
      const settled = job('plan-job', 'plan:propose', status)
      expect(settledPlanJobs([settled], new Set(['plan-job']), new Set())).toEqual([settled])
    },
  )

  test('does not repeat a refresh or refresh unrelated jobs', () => {
    expect(settledPlanJobs(
      [job('handled', 'plan:revise', 'succeeded'), job('author', 'author:update', 'succeeded')],
      new Set(['handled', 'author']),
      new Set(['handled']),
    )).toEqual([])
  })
})

describe('page edit job transitions', () => {
  test.each(['succeeded', 'failed', 'cancelled'] as const)(
    'refreshes an edit after it %s',
    (status) => {
      const settled = job('edit-job', 'page-edit:run-page-edit', status)
      expect(settledPageEditJobs([settled], new Set(['edit-job']), new Set())).toEqual([settled])
    },
  )

  test('ignores unrelated and already handled jobs', () => {
    expect(settledPageEditJobs(
      [job('handled', 'page-edit:run-one', 'succeeded'), job('revision', 'proposal:revise:run-two', 'succeeded')],
      new Set(['handled', 'revision']),
      new Set(['handled']),
    )).toEqual([])
  })
})
