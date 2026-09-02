import type { UiJob } from './types'

/**
 * Full workspace state is not carried by the job event stream. Once any plan
 * stage settles, the UI must fetch the persisted plan again so transitional
 * screens cannot remain stuck on planning, revising, or generating.
 */
export function settledPlanJobs(
  jobs: UiJob[],
  previouslyRunning: ReadonlySet<string>,
  alreadyHandled: ReadonlySet<string>,
): UiJob[] {
  return jobs.filter((job) =>
    job.type.startsWith('plan:') &&
    job.status !== 'running' &&
    previouslyRunning.has(job.id) &&
    !alreadyHandled.has(job.id),
  )
}
