import { pagesForChange, readEvidenceMap } from './evidence.js'
import { isWatchedPath } from './globs.js'
import { changedSourcePaths, collectSourceChanges, readSyncState } from './sync.js'
import type {
  DoxloopProject,
  DriftResult,
  DriftSourceSummary,
  EvidenceMap,
  SourceChange,
  StalePage,
  StaleReason,
} from './types.js'

/**
 * Answer "which documentation pages no longer match the product?" without
 * starting an agent. Detection is deterministic and safe to run on a schedule
 * or in continuous integration.
 */
export async function computeDrift(
  root: string,
  project: DoxloopProject,
): Promise<DriftResult> {
  const changes = await collectSourceChanges(root, project.sources)
  return computeDriftFromChanges(root, project, changes)
}

export async function computeDriftFromChanges(
  root: string,
  project: DoxloopProject,
  changes: SourceChange[],
): Promise<DriftResult> {
  const map = await readEvidenceMap(root)
  const notes: string[] = []
  const sources: DriftSourceSummary[] = []
  const reasonsByPage = new Map<string, StaleReason[]>()
  let unresolved = false

  for (const change of changes) {
    const rawPaths = changedSourcePaths(change)
    const changedPaths = rawPaths.filter((path) =>
      isWatchedPath(path, project.sync.watch, project.sync.ignore),
    )
    sources.push({
      name: change.name,
      path: change.path,
      kind: change.kind,
      changedPaths,
      filteredPaths: rawPaths.length - changedPaths.length,
      ...('baseline' in change ? { baseline: change.baseline } : {}),
      ...('head' in change ? { head: change.head } : {}),
      ...(change.scope ? { scope: change.scope } : {}),
    })

    const note = unresolvedNote(change)
    if (note) {
      notes.push(note)
      unresolved = true
      continue
    }
    if (changedPaths.length === 0) continue
    if (!map) {
      notes.push(
        `Source "${change.name}" changed, but no evidence map exists yet, so affected pages cannot be named. Run \`doxloop update\` to build one.`,
      )
      unresolved = true
      continue
    }

    const matched = pagesForChange(map, change.name, changedPaths)
    for (const [page, paths] of matched) {
      const reasons = reasonsByPage.get(page) ?? []
      reasons.push({
        source: change.name,
        paths,
        ...('baseline' in change ? { baseline: change.baseline } : {}),
        ...('head' in change ? { head: change.head } : {}),
      })
      reasonsByPage.set(page, reasons)
    }
    const attributed = new Set([...matched.values()].flat())
    const unattributed = changedPaths.filter((path) => !attributed.has(path))
    if (unattributed.length > 0) {
      notes.push(
        `${unattributed.length} changed file${unattributed.length === 1 ? '' : 's'} in "${change.name}" ${unattributed.length === 1 ? 'is' : 'are'} not referenced by any page.`,
      )
    }
  }

  if (map && project.sync.maxVerificationAgeDays) {
    const state = await readSyncState(root)
    const threshold = project.sync.maxVerificationAgeDays
    const severity = project.sync.maxVerificationAgeSeverity ?? 'warn'
    for (const [page, evidence] of Object.entries(map.pages)) {
      for (const entry of evidence.sources) {
        const record = state.sources[entry.source]
        const explicit = evidence.verifiedOn?.[entry.source]
        const revisionMatches = record && evidence.verifiedAt?.[entry.source] && [record.commit, record.contentFingerprint].includes(evidence.verifiedAt[entry.source])
        const verifiedOn = explicit ?? (revisionMatches ? record.recordedAt : undefined)
        const ageDays = verifiedOn ? Math.floor((Date.now() - Date.parse(verifiedOn)) / 86_400_000) : Number.POSITIVE_INFINITY
        if (ageDays <= threshold) continue
        const ageLabel = Number.isFinite(ageDays) ? `${ageDays} days` : 'an unknown amount of time'
        if (severity === 'warn') {
          notes.push(`Page "${page}" was last verified against "${entry.source}" ${ageLabel} ago; policy is ${threshold} days.`)
          continue
        }
        const reasons = reasonsByPage.get(page) ?? []
        reasons.push({ source: entry.source, paths: [], kind: 'max-age', ...(Number.isFinite(ageDays) ? { ageDays } : {}) })
        reasonsByPage.set(page, reasons)
      }
    }
  }

  const pages = [...reasonsByPage.entries()]
    .map(([page, reasons]) => stalePage(page, reasons, map))
    .sort((left, right) => left.page.localeCompare(right.page))

  return {
    status: pages.length > 0 ? 'stale' : unresolved ? 'unknown' : 'current',
    pages,
    trackedPages: map ? Object.keys(map.pages).length : 0,
    sources,
    evidenceMap: map ? 'present' : 'missing',
    notes,
  }
}

function stalePage(
  page: string,
  reasons: StaleReason[],
  map: EvidenceMap | undefined,
): StalePage {
  const recorded = map?.pages[page]?.verifiedAt
  const verifiedAt = recorded
    ? recorded[reasons[0]?.source ?? '']
    : undefined
  return { page, reasons, ...(verifiedAt ? { verifiedAt } : {}) }
}

/**
 * Conditions where drift cannot be decided from local state. These are
 * reported rather than silently treated as "documentation is current".
 */
function unresolvedNote(change: SourceChange): string | undefined {
  switch (change.kind) {
    case 'missing-path':
      return `Source "${change.name}" is configured as ${change.path}, which does not exist.`
    case 'not-git':
      return `Source "${change.name}" is not a Git repository, so changes cannot be compared.`
    case 'no-baseline':
      return `Source "${change.name}" has no sync baseline yet. Accepting the next update records one.`
    case 'baseline-lost':
      return `The recorded baseline for source "${change.name}" no longer exists, so changes cannot be compared.`
    case 'spec-remote':
      return `The API specification "${change.name}" is remote and is not compared locally. The next update checks it.`
    default:
      return undefined
  }
}

export function formatDrift(result: DriftResult): string {
  const lines: string[] = []
  if (result.status === 'stale') {
    lines.push(
      `Documentation drift: ${result.pages.length} page${result.pages.length === 1 ? '' : 's'} stale`,
      '',
    )
    for (const page of result.pages) {
      lines.push(`  ${page.page}`)
      for (const reason of page.reasons) {
        if (reason.kind === 'max-age') {
          lines.push(`    stale because  verification is ${reason.ageDays === undefined ? 'undated' : `${reason.ageDays} days old`} for source "${reason.source}"`)
          continue
        }
        const because =
          reason.paths.length === 0
            ? `source "${reason.source}" changed`
            : `${reason.paths.slice(0, 5).join(', ')}${reason.paths.length > 5 ? `, and ${reason.paths.length - 5} more` : ''} changed`
        lines.push(
          `    stale because  ${because}${reason.head ? ` (${reason.head.slice(0, 12)})` : ''}`,
        )
      }
      if (page.verifiedAt) {
        lines.push(`    last verified  ${page.verifiedAt.slice(0, 12)}`)
      }
      lines.push('')
    }
    const current = Math.max(result.trackedPages - result.pages.length, 0)
    if (current > 0) lines.push(`  ${current} other tracked page${current === 1 ? '' : 's'} current`, '')
  } else if (result.status === 'current') {
    lines.push('Documentation is current with the recorded source baseline.', '')
  } else {
    lines.push('Documentation drift could not be determined.', '')
  }

  for (const note of result.notes) lines.push(`  Note: ${note}`)
  if (result.notes.length > 0) lines.push('')
  if (result.status === 'stale') lines.push('Fix with: doxloop update')

  return lines.join('\n').trimEnd()
}
