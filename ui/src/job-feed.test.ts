import { describe, expect, it } from 'vitest'
import { jobFailureReason, recentSettledJob, syncOutcomeNotice, workflowActivityLabel } from './WorkspaceApplication'
import type { UiJob } from './types'

function job(overrides: Partial<UiJob>): UiJob {
  return { id: 'job', type: 'deploy', status: 'succeeded', startedAt: '2026-09-04T09:00:00.000Z', finishedAt: '2026-09-04T09:05:00.000Z', lines: [], stages: [], ...overrides }
}

describe('activity feed labels', () => {
  it('names every job type the control center starts', () => {
    for (const type of ['sync', 'login', 'agent:install', 'capture', 'generator', 'deploy', 'deploy:dry-run', 'preview', 'proposal:revise:run-1', 'proposal:resume:run-1', 'author:update', 'page-edit:run-2', 'plan:propose']) {
      expect(workflowActivityLabel(type), type).not.toBe('Documentation workflow in progress')
    }
  })
})

describe('jobFailureReason', () => {
  it('prefers the CLI error line and drops event lines', () => {
    expect(jobFailureReason(job({ status: 'failed', lines: ['Starting codex', 'DOXLOOP_EVENT {"schemaVersion":1}', 'doxloop: The revision stayed out of scope.'] }))).toBe('The revision stayed out of scope.')
    expect(jobFailureReason(job({ status: 'failed', lines: ['codex exited with status 1', 'DOXLOOP_EVENT {"schemaVersion":1}'] }))).toBe('codex exited with status 1')
    expect(jobFailureReason(job({ status: 'failed', lines: [] }))).toBeUndefined()
    expect(jobFailureReason(job({ status: 'succeeded', lines: ['doxloop: ignored'] }))).toBeUndefined()
  })
})

describe('recentSettledJob', () => {
  const now = Date.parse('2026-09-04T09:10:00.000Z')

  it('keeps a finished job visible until it is dismissed or grows stale', () => {
    const failed = job({ id: 'd1', status: 'failed' })
    const jobs = [failed, job({ id: 'd0', startedAt: '2026-09-04T08:00:00.000Z', finishedAt: '2026-09-04T08:01:00.000Z' })]
    expect(recentSettledJob(jobs, (candidate) => candidate.type === 'deploy', undefined, now)?.id).toBe('d1')
    expect(recentSettledJob(jobs, (candidate) => candidate.type === 'deploy', 'd1', now)).toBeUndefined()
    expect(recentSettledJob(jobs, (candidate) => candidate.type === 'deploy', undefined, now + 60 * 60_000)).toBeUndefined()
  })

  it('never returns a running job or one of another type', () => {
    expect(recentSettledJob([job({ id: 'r', status: 'running' })], (candidate) => candidate.type === 'deploy', undefined, now)).toBeUndefined()
    expect(recentSettledJob([job({ id: 'l', type: 'login' })], (candidate) => candidate.type === 'deploy', undefined, now)).toBeUndefined()
  })
})

describe('syncOutcomeNotice', () => {
  it('answers the source check from its reported outcome', () => {
    const sync = (overrides: Partial<UiJob>) => job({ type: 'sync', ...overrides })
    expect(syncOutcomeNotice(sync({ outcome: { kind: 'sync', status: 'current', message: 'No reader-visible source changes since the last check.', pages: 0 } }))).toEqual({ tone: 'good', title: 'No change', detail: 'No reader-visible source changes since the last check.' })
    expect(syncOutcomeNotice(sync({ status: 'failed', exitCode: 1, outcome: { kind: 'sync', status: 'stale', message: '2 stale pages · monitoring is in check mode, so no proposal was drafted.', pages: 2 } }))).toMatchObject({ tone: 'warn', title: '2 pages stale' })
    expect(syncOutcomeNotice(sync({ outcome: { kind: 'sync', status: 'proposal', message: '1 stale page · proposal run-1 is ready for review with 3 changed files.', pages: 1, proposalId: 'run-1' } }))).toMatchObject({ tone: 'good', title: 'Proposal ready for review', proposalId: 'run-1' })
    expect(syncOutcomeNotice(sync({ status: 'failed', outcome: { kind: 'sync', status: 'skipped', message: '1 stale page · the update was skipped because the budget is spent.', pages: 1 } }))).toMatchObject({ tone: 'warn', title: '1 page stale · update skipped' })
    expect(syncOutcomeNotice(sync({ status: 'failed', outcome: { kind: 'sync', status: 'failed', message: 'The documentation proposal failed: agent exited.', proposalId: 'run-2' } }))).toMatchObject({ tone: 'bad', title: 'Proposal failed', proposalId: 'run-2' })
    expect(syncOutcomeNotice(sync({ status: 'failed', outcome: { kind: 'sync', status: 'unknown', message: 'No evidence map yet.' } }))).toMatchObject({ tone: 'info', title: 'Freshness unknown' })
  })

  it('falls back to the job status and failure line when no outcome was reported', () => {
    expect(syncOutcomeNotice(job({ type: 'sync', status: 'failed', lines: ['doxloop: The configured path does not exist.'] }))).toEqual({ tone: 'bad', title: 'Source check failed', detail: 'The configured path does not exist.' })
    expect(syncOutcomeNotice(job({ type: 'sync', status: 'cancelled' }))).toMatchObject({ tone: 'info', title: 'Source check stopped' })
    expect(syncOutcomeNotice(job({ type: 'sync' }))).toMatchObject({ tone: 'good', title: 'Source check finished' })
  })
})
