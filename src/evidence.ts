import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DoxloopError } from './errors.js'
import { pathExists, readJson } from './fs.js'
import { matchesGlob } from './globs.js'
import type { EvidenceMap, PageEvidence, PageEvidenceSource } from './types.js'

export const EVIDENCE_MAP_FILE = join('.doxloop', 'evidence-map.json')

/**
 * The evidence map records which configured source produced each page, so
 * staleness can be attributed to individual pages without starting an agent.
 * It is committed, so a malformed file fails closed rather than being ignored.
 */
export async function readEvidenceMap(root: string): Promise<EvidenceMap | undefined> {
  const path = join(root, EVIDENCE_MAP_FILE)
  if (!(await pathExists(path))) return undefined
  const map = await readJson<unknown>(path)
  if (!isEvidenceMap(map)) {
    throw new DoxloopError(
      `${EVIDENCE_MAP_FILE} has an unsupported format. Delete it and run \`doxloop update\` to rebuild it.`,
    )
  }
  return map
}

export async function writeEvidenceMap(root: string, map: EvidenceMap): Promise<void> {
  const pages = Object.fromEntries(
    Object.entries(map.pages).sort(([left], [right]) => left.localeCompare(right)),
  )
  await writeFile(
    join(root, EVIDENCE_MAP_FILE),
    `${JSON.stringify({ schemaVersion: 1, pages }, null, 2)}\n`,
    'utf8',
  )
}

/**
 * Pages that claim behavior from a changed source path, in page order.
 * An entry naming only a source, with no paths, matches every change in it.
 */
export function pagesForChange(
  map: EvidenceMap,
  source: string,
  changedPaths: readonly string[],
): Map<string, string[]> {
  const matches = new Map<string, string[]>()
  for (const [page, evidence] of Object.entries(map.pages)) {
    const patterns = evidenceIdentifiers(evidence, source)
    if (patterns === undefined) continue
    const matched =
      patterns.length === 0
        ? [...changedPaths]
        : changedPaths.filter((path) =>
            patterns.some((pattern) => evidenceMatches(path, pattern)),
          )
    if (matched.length > 0) matches.set(page, matched)
  }
  return matches
}

/** Every source name the map attributes at least one page to. */
export function trackedSources(map: EvidenceMap): Set<string> {
  const names = new Set<string>()
  for (const evidence of Object.values(map.pages)) {
    for (const entry of evidence.sources) names.add(entry.source)
  }
  return names
}

/** Patterns recorded for one source, or undefined when the page ignores it. */
function evidenceIdentifiers(
  evidence: PageEvidence,
  source: string,
): string[] | undefined {
  const entries = evidence.sources.filter((entry) => entry.source === source)
  if (entries.length === 0) return undefined
  return entries.flatMap((entry) => [...(entry.paths ?? []), ...(entry.operations ?? [])])
}

/**
 * A recorded path may be an exact file, a directory, or a glob. A bare
 * directory is treated as everything below it so `src/routes` keeps matching
 * after a new file is added to it.
 */
function evidenceMatches(path: string, pattern: string): boolean {
  return matchesGlob(path, pattern) || matchesGlob(path, `${pattern}/**`)
}

function isEvidenceMap(value: unknown): value is EvidenceMap {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const candidate = value as Partial<EvidenceMap>
  if (candidate.schemaVersion !== 1) return false
  if (
    !candidate.pages ||
    typeof candidate.pages !== 'object' ||
    Array.isArray(candidate.pages)
  ) {
    return false
  }
  return Object.entries(candidate.pages).every(
    ([page, evidence]) => page.trim() !== '' && isPageEvidence(evidence),
  )
}

function isPageEvidence(value: unknown): value is PageEvidence {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const evidence = value as Partial<PageEvidence>
  if (!Array.isArray(evidence.sources) || !evidence.sources.every(isPageEvidenceSource)) {
    return false
  }
  if (
    evidence.confidence !== undefined &&
    !['verified', 'inferred', 'needs-human'].includes(evidence.confidence)
  ) {
    return false
  }
  if (evidence.claims !== undefined && !isTextList(evidence.claims)) return false
  if (evidence.claimVerification !== undefined && (
    !evidence.claimVerification ||
    typeof evidence.claimVerification !== 'object' ||
    Array.isArray(evidence.claimVerification) ||
    !Object.entries(evidence.claimVerification).every(([claim, state]) =>
      claim.trim() !== '' && ['verified', 'inferred', 'contradicted', 'needs-human'].includes(String(state)),
    )
  )) return false
  const revisionMapValid = evidence.verifiedAt === undefined || (
    typeof evidence.verifiedAt === 'object' &&
    !Array.isArray(evidence.verifiedAt) &&
    Object.entries(evidence.verifiedAt).every(
      ([source, revision]) =>
        source.trim() !== '' && typeof revision === 'string' && revision.trim() !== '',
    )
  )
  const dateMapValid = evidence.verifiedOn === undefined || (
    typeof evidence.verifiedOn === 'object' &&
    !Array.isArray(evidence.verifiedOn) &&
    Object.entries(evidence.verifiedOn).every(
      ([source, timestamp]) => source.trim() !== '' && typeof timestamp === 'string' && !Number.isNaN(Date.parse(timestamp)),
    )
  )
  return revisionMapValid && dateMapValid
}

function isPageEvidenceSource(value: unknown): value is PageEvidenceSource {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const entry = value as Partial<PageEvidenceSource>
  return (
    typeof entry.source === 'string' &&
    entry.source.trim() !== '' &&
    (entry.paths === undefined || isTextList(entry.paths)) &&
    (entry.operations === undefined || isTextList(entry.operations))
  )
}

function isTextList(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((item) => typeof item === 'string' && item.trim() !== '')
  )
}
