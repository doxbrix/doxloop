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

export interface ProposalDecisionCounts {
  /** Every change in the proposal is decided and at least one part was accepted. */
  accepted: number
  /** Every part of the change was rejected. */
  rejected: number
  /** At least one part of the change still needs a decision. */
  remaining: number
}

/**
 * Review progress counted in files, the same unit as the "N file changes"
 * heading. Counting hunks made a 70-file proposal report 78 remaining. A file
 * with no reviewable hunks (a binary asset) is remaining until the proposal
 * is applied.
 */
export function proposalDecisionCounts(changes: Array<Pick<ProposalChange, 'hunks'>>, applied = false): ProposalDecisionCounts {
  const counts: ProposalDecisionCounts = { accepted: 0, rejected: 0, remaining: 0 }
  for (const change of changes) {
    if (change.hunks.length === 0) { counts[applied ? 'accepted' : 'remaining'] += 1; continue }
    if (change.hunks.some((hunk) => !hunk.acceptedAt && !hunk.rejectedAt)) counts.remaining += 1
    else if (change.hunks.some((hunk) => hunk.acceptedAt)) counts.accepted += 1
    else counts.rejected += 1
  }
  return counts
}

/**
 * Screenshot results framed as coverage of the guides, so a run that captured
 * two sign-in screens for forty guides does not read as a success.
 */
export function screenshotCoverageText(summary: { captured: number; guides: number }, totalGuides?: number): string {
  const captured = `${summary.captured} screenshot${summary.captured === 1 ? '' : 's'}`
  if (totalGuides && totalGuides >= summary.guides) return `Screenshots in ${summary.guides} of ${totalGuides} guide${totalGuides === 1 ? '' : 's'} · ${captured} verified`
  return `Screenshots in ${summary.guides} guide${summary.guides === 1 ? '' : 's'} · ${captured} verified`
}
