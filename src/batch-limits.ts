import { DoxloopError } from './errors.js'
import type { DocumentationPlan } from './types.js'

export interface BatchLimits { maxPages: number; maxScreenshots: number; maxMinutes: number }
export function batchLimits(value: unknown, defaults: BatchLimits = { maxPages: 50, maxScreenshots: 20, maxMinutes: 30 }): BatchLimits {
  const input = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const result = { ...defaults }
  for (const [key, min, max] of [['maxPages', 1, 500], ['maxScreenshots', 0, 100], ['maxMinutes', 1, 120]] as const) {
    if (input[key] === undefined) continue
    if (typeof input[key] !== 'number' || !Number.isInteger(input[key]) || input[key] < min || input[key] > max) throw new DoxloopError(`${key} must be a whole number between ${min} and ${max}.`)
    result[key] = input[key]
  }
  return result
}
function activePages(plan: DocumentationPlan): DocumentationPlan['pages'] {
  return plan.pages.filter((page) => page.priority !== 'later' && page.action !== 'preserve')
}
function plannedCaptures(plan: DocumentationPlan, active: DocumentationPlan['pages']): number {
  if (plan.execution.screenshots === 'disabled' || plan.execution.screenshots === false) return 0
  return active.reduce((sum, page) => sum + (page.visuals?.mode !== 'none' ? page.visuals?.estimatedCaptures ?? 0 : 0), 0)
}
export function assertBatchFits(plan: DocumentationPlan): void {
  const limits = batchLimits(plan.execution.limits)
  const active = activePages(plan)
  const captures = plannedCaptures(plan, active)
  if (active.length > limits.maxPages) throw new DoxloopError(`This plan writes ${active.length} pages; the batch maximum is ${limits.maxPages}. Mark pages Later or explicitly raise the limit before approving.`)
  if (captures > limits.maxScreenshots) throw new DoxloopError(`This plan requests ${captures} screenshots; the batch maximum is ${limits.maxScreenshots}. Reduce captures or explicitly raise the limit before approving.`)
}
/**
 * The batch a reviewer actually approved. Approval accepts every active page
 * and every estimated capture in the plan, so a run that stays within the
 * plan's own footprint never exceeds the batch even when the recorded limits
 * are absent or smaller than what was approved.
 */
export function approvedBatchLimits(plan: DocumentationPlan): BatchLimits {
  const limits = batchLimits(plan.execution.limits)
  const active = activePages(plan)
  return {
    ...limits,
    maxPages: Math.max(limits.maxPages, active.length),
    maxScreenshots: Math.max(limits.maxScreenshots, plannedCaptures(plan, active)),
  }
}
