import { describe, expect, test } from 'vitest'
import { settledPlanJobs } from './job-transitions'
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
