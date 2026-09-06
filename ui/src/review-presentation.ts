import type { ProposalChange } from './types'

/**
 * Review opens on what a reader came to see. Pages first, then navigation and
 * assets; evidence maps, configuration, and skill files are supporting detail
 * that stays out of the way until asked for.
 */
const CATEGORY_ORDER: Record<string, number> = { page: 0, navigation: 1, asset: 2 }

export function isSupportingChange(change: Pick<ProposalChange, 'category'>): boolean {
  return !(change.category in CATEGORY_ORDER)
}

export function defaultReviewChange<T extends Pick<ProposalChange, 'category' | 'changedDuringRun'>>(changes: T[]): T | undefined {
  const rank = (change: T) => CATEGORY_ORDER[change.category] ?? 3
  return [...changes].sort((left, right) => rank(left) - rank(right))[0]
}

export interface ReviewFileGroups<T> {
  /** Files that also changed in the project while the agent ran. */
  concurrent: T[]
  /** Pages, navigation, and assets. */
  documentation: T[]
  /** Evidence, configuration, and skill files. */
  supporting: T[]
}

export function reviewFileGroups<T extends Pick<ProposalChange, 'category' | 'changedDuringRun'>>(changes: T[]): ReviewFileGroups<T> {
  const groups: ReviewFileGroups<T> = { concurrent: [], documentation: [], supporting: [] }
  for (const change of changes) {
    if (change.changedDuringRun) groups.concurrent.push(change)
    else if (isSupportingChange(change)) groups.supporting.push(change)
    else groups.documentation.push(change)
  }
  return groups
}

/** A stable key for the hunk decisions of a change, so a diff reloads once a hunk is accepted or rejected. */
export function hunkStateKey(change: Pick<ProposalChange, 'hunks'>): string {
  return change.hunks.map((hunk) => `${hunk.id}:${hunk.acceptedAt ? 'a' : hunk.rejectedAt ? 'r' : 'p'}`).join(',')
}
