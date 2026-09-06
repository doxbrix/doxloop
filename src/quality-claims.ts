import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { computeDrift } from './drift.js'
import { readEvidenceMap } from './evidence.js'
import { QUALITY_CODES } from './quality-contract.js'
import { readSyncState } from './sync.js'
import { pathExists } from './fs.js'
import { loadOpenApiSource } from './openapi.js'
import { sourceKind } from './project.js'
import type { ClaimVerificationState, DoxloopProject, QualityCheck, ReaderVerificationMetadata } from './types.js'

export const VERIFICATION_METADATA_FILE = join('.doxloop', 'verification-metadata.json')

export async function readVerificationMetadata(root: string): Promise<ReaderVerificationMetadata | undefined> {
  const path = join(root, VERIFICATION_METADATA_FILE)
  if (!(await pathExists(path))) return undefined
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as ReaderVerificationMetadata
    return value.schemaVersion === 1 && value.pages && typeof value.pages === 'object' ? value : undefined
  } catch { return undefined }
}

export async function reverifyClaims(root: string, project: DoxloopProject, publishMetadata: boolean): Promise<{ checks: QualityCheck[]; metadata: ReaderVerificationMetadata }> {
  const [map, drift, sync] = await Promise.all([readEvidenceMap(root), computeDrift(root, project), readSyncState(root)])
  const checks: QualityCheck[] = []
  const metadata: ReaderVerificationMetadata = { schemaVersion: 1, generatedAt: new Date().toISOString(), pages: {} }
  if (!map) {
    checks.push({ code: QUALITY_CODES.claimNeedsHuman, category: 'claims', status: 'warning', message: 'No evidence map exists, so reader-facing claims cannot be reverified.' })
    return { checks, metadata }
  }
  const stale = new Set(drift.pages.map((page) => page.page))
  for (const [page, evidence] of Object.entries(map.pages)) {
    const pageIsStale = stale.has(page) || drift.status === 'unknown'
    const hasRevision = evidence.sources.length > 0 && evidence.sources.every((source) => !!evidence.verifiedAt?.[source.source])
    const fallback = defaultState(evidence.confidence, pageIsStale, hasRevision)
    const currentEvidence = await claimEvidenceText(root, project, evidence.sources)
    const claimStates = (evidence.claims ?? []).map((claim) => {
      const recorded = evidence.claimVerification?.[claim]
      return semanticClaimState(claim, currentEvidence, pageIsStale, recorded, fallback)
    })
    const state = worstState(claimStates.length > 0 ? claimStates : [fallback])
    const revisions = Object.fromEntries(evidence.sources.flatMap((source) => {
      const revision = evidence.verifiedAt?.[source.source]
      return revision ? [[source.source, revision] as const] : []
    }))
    const dates = Object.values(evidence.verifiedOn ?? {}).filter(Boolean).sort()
    const verifiedOn = dates.at(0)
    metadata.pages[page] = {
      state,
      confidence: evidence.confidence ?? 'needs-human',
      ...(verifiedOn ? { verifiedOn } : {}),
      revisions,
      locale: project.documentation.locale,
    }
    for (const [index, claim] of (evidence.claims ?? []).entries()) checks.push(checkForState(page, claim, claimStates[index] ?? state))
    if ((evidence.claims ?? []).length === 0) checks.push(checkForState(page, 'Page evidence has no claim-level entries.', state))
  }
  if (publishMetadata) {
    await mkdir(join(root, '.doxloop'), { recursive: true })
    await writeFile(join(root, VERIFICATION_METADATA_FILE), `${JSON.stringify(metadata, null, 2)}\n`, 'utf8')
  }
  return { checks, metadata }
}

async function claimEvidenceText(root: string, project: DoxloopProject, entries: Array<{ source: string; paths?: string[]; operations?: string[] }>): Promise<string> {
  const chunks: string[] = []
  const byName = new Map(project.sources.map((source) => [source.name, source]))
  for (const entry of entries) {
    const source = byName.get(entry.source)
    if (!source) continue
    if (sourceKind(source) === 'openapi') {
      try {
        const loaded = await loadOpenApiSource(root, source)
        for (const identifier of entry.operations ?? []) {
          const operation = loaded.snapshot.operations[identifier]
          if (operation) chunks.push(identifier, operation.full)
          const operationMatch = /^(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\s+(\/\S+)$/i.exec(identifier)
          if (operationMatch) {
            const paths = objectRecord(loaded.document.paths)
            const pathItem = objectRecord(paths[operationMatch[2]!])
            const raw = pathItem[operationMatch[1]!.toLowerCase()]
            if (raw) chunks.push(identifier, JSON.stringify(raw))
          }
          const schema = loaded.snapshot.schemas[identifier.replace(/^schema:/, '')]
          if (schema) chunks.push(identifier, schema)
        }
        if (!(entry.operations?.length)) chunks.push(JSON.stringify(loaded.document).slice(0, 250_000))
      } catch { /* Unavailable evidence remains a needs-human result. */ }
      continue
    }
    const sourceRoot = resolve(root, source.path)
    for (const candidate of entry.paths ?? []) {
      if (/[*?[\]]/.test(candidate)) continue
      const path = resolve(sourceRoot, candidate)
      const rel = relative(sourceRoot, path)
      if (rel === '..' || rel.startsWith('../') || rel.startsWith('..\\') || !(await pathExists(path))) continue
      try { chunks.push((await readFile(path, 'utf8')).slice(0, 250_000)) } catch { /* Binary or unreadable evidence is ignored. */ }
    }
  }
  return chunks.join('\n').toLowerCase()
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function semanticClaimState(claim: string, evidence: string, stale: boolean, recorded: ClaimVerificationState | undefined, fallback: ClaimVerificationState): ClaimVerificationState {
  if (recorded === 'contradicted') return 'contradicted'
  if (!evidence) return stale ? 'needs-human' : (recorded ?? fallback)
  const facts = extractFacts(claim)
  if (facts.length === 0) return stale ? 'needs-human' : (recorded ?? fallback)
  const present = facts.filter((fact) => evidence.includes(fact.value.toLowerCase()))
  if (present.length === facts.length) return 'verified'
  const missing = facts.filter((fact) => !present.includes(fact))
  const categories = new Set(missing.map((fact) => fact.kind))
  const evidenceFacts = extractFacts(evidence)
  const comparable = evidenceFacts.filter((fact) => categories.has(fact.kind))
  if (comparable.length > 0) return 'contradicted'
  return 'needs-human'
}

function extractFacts(value: string): Array<{ kind: string; value: string }> {
  const facts: Array<{ kind: string; value: string }> = []
  const patterns: Array<[string, RegExp]> = [
    ['http-status', /\b[1-5]\d\d\b/g],
    ['http-operation', /\b(?:GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\s+\/[A-Za-z0-9_{}./:-]+/gi],
    ['cli-option', /--[a-z0-9][a-z0-9-]*/gi],
    ['environment', /\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/g],
    ['version', /\bv?\d+\.\d+(?:\.\d+)?\b/gi],
  ]
  for (const [kind, pattern] of patterns) for (const match of value.matchAll(pattern)) facts.push({ kind, value: match[0] })
  return [...new Map(facts.map((fact) => [`${fact.kind}:${fact.value.toLowerCase()}`, fact])).values()]
}

function defaultState(confidence: 'verified' | 'inferred' | 'needs-human' | undefined, stale: boolean, hasRevision: boolean): ClaimVerificationState {
  if (stale || confidence === 'needs-human' || confidence === undefined) return 'needs-human'
  return confidence === 'verified' && !hasRevision ? 'inferred' : confidence
}

function worstState(states: ClaimVerificationState[]): ClaimVerificationState {
  const order: ClaimVerificationState[] = ['verified', 'inferred', 'needs-human', 'contradicted']
  return states.reduce((worst, state) => order.indexOf(state) > order.indexOf(worst) ? state : worst, 'verified')
}

function checkForState(file: string, claim: string, state: ClaimVerificationState): QualityCheck {
  const code = state === 'verified' ? QUALITY_CODES.claimVerified : state === 'inferred' ? QUALITY_CODES.claimInferred : state === 'contradicted' ? QUALITY_CODES.claimContradicted : QUALITY_CODES.claimNeedsHuman
  return { code, category: 'claims', status: state === 'verified' ? 'pass' : state === 'contradicted' ? 'fail' : 'warning', message: `${state}: ${claim}`, file }
}
