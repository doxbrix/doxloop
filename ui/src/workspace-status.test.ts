import { expect, test } from 'vitest'
import { workspaceStatus } from './workspace-status'
import type { UiState } from './types'
const state = (overrides: Partial<UiState>): UiState => ({ projectFound: true, cwd: '/docs', generators: [], jobs: [], ...overrides })
test('active planning takes precedence over first-run and current-documentation messages', () => {
  expect(workspaceStatus(state({ jobs: [{ id: 'j', type: 'plan:propose', status: 'running', startedAt: '', lines: [], stages: [] }] }), false, false).headline).toBe('Researching your documentation plan')
})
test('existing pages are not evidence of freshness', () => {
  expect(workspaceStatus(state({}), true, false).eyebrow).toBe('Freshness unknown')
  expect(workspaceStatus(state({ drift: { status: 'stale', pages: [], trackedPages: 1, sources: [], evidenceMap: 'present', notes: [] } }), true, false).headline).toBe('Your documentation needs an update')
})

test('generation has a writing status and a pending plan takes precedence over existing pages', () => {
  const base = { jobs: [{ id: 'generation', type: 'plan:generate', status: 'running' }], project: { sources: [] } } as unknown as UiState
  expect(workspaceStatus(base, true, false).headline).toBe('Writing the approved documentation')
  expect(workspaceStatus({ ...base, jobs: [], documentationPlan: { status: 'ready-for-review' } } as unknown as UiState, true, false).headline).toBe('Review your documentation plan')
})
