import type { UiState } from './types'

export function workspaceStatus(state: UiState, hasDocs: boolean, hasProposal: boolean) {
  const active = state.jobs.find((job) => job.status === 'running' && /^(plan:|author:|proposal:|page-edit:|sync$)/.test(job.type))
  if (active) return { mood: 'attention', eyebrow: 'Work in progress', headline: active.type === 'plan:generate' ? 'Writing the approved documentation' : active.type.startsWith('plan:') ? 'Researching your documentation plan' : 'Preparing documentation changes', detail: 'Follow the current run. Your accepted documentation stays available while the proposal is prepared.', label: 'View current run' }
  if (hasProposal) return { mood: 'attention', eyebrow: 'Needs your review', headline: 'Documentation changes are ready', detail: 'Review the proposed changes before accepting them.', label: 'Review changes' }
  if (state.documentationPlan?.status === 'failed' || state.documentationPlan?.status === 'cancelled') return { mood: 'attention', eyebrow: 'Run needs attention', headline: 'Continue from the last saved stage', detail: state.documentationPlan.error ?? 'Open the update to inspect the failure and the available recovery actions.', label: 'Review recovery options' }
  if (state.documentationPlan && ['ready-for-review', 'needs-input', 'approved', 'stale'].includes(state.documentationPlan.status)) return { mood: 'attention', eyebrow: 'Plan ready', headline: 'Review your documentation plan', detail: 'Review the scope, answer open questions, and approve generation when the plan is ready.', label: 'Review plan' }
  if (!hasDocs) return { mood: 'start', eyebrow: 'Start the loop', headline: 'Create your first documentation plan', detail: state.project?.sources.length ? 'Your sources are connected. Plan a small first batch to reach a useful result.' : 'Connect a source to begin planning your documentation.', label: state.project?.sources.length ? 'Create documentation' : 'Connect a source' }
  if (state.drift && 'status' in state.drift && state.drift.status === 'stale') return { mood: 'attention', eyebrow: 'Sources changed', headline: 'Your documentation needs an update', detail: `${state.drift.pages.length} pages need verification against the current sources.`, label: 'Plan an update' }
  if (!state.drift || !('status' in state.drift) || state.drift.status === 'unknown') return { mood: 'attention', eyebrow: 'Freshness unknown', headline: 'Check the evidence behind your documentation', detail: 'Existing pages do not by themselves establish that documentation is current.', label: 'Check sources' }
  return { mood: 'current', eyebrow: 'Source check is current', headline: 'No source changes are waiting', detail: 'The tracked evidence has no detected drift. Preview the documentation or plan an update.', label: 'Plan an update' }
}

export function coverageRefreshKey(state: UiState): string {
  return JSON.stringify([state.root, state.project?.sources, state.documentationPlan?.updatedAt, state.jobs.map((job) => [job.id, job.status]), Array.isArray(state.runs) ? state.runs.map((run) => [run.id, run.status, run.changes.map((change) => change.hunks.map((hunk) => [hunk.acceptedAt, hunk.rejectedAt]))]) : [], state.validation])
}
