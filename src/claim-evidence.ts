/**
 * Claim-level evidence: for each reader-facing claim a page records, the exact
 * source lines that support it. The evidence map named files per page, so a
 * reviewer who doubted one sentence had to open every cited file and search;
 * this module finds the lines, checks the claim's concrete facts (status
 * codes, operations, flags, environment variables, versions) against them,
 * and reports a claim whose cited evidence says something else.
 *
 * Locations come first from the writer's own citations (`claimSources`), then
 * from a search of the page's cited files for the claim's facts and
 * identifiers. Nothing here starts an agent.
 */
import { readFile, stat } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import { readEvidenceMap } from './evidence.js'
import { loadOpenApiSource } from './openapi.js'
import { sourceKind } from './project.js'
import { extractFacts, semanticClaimState } from './quality-claims.js'
import type { ClaimVerificationState, DoxloopProject, PageEvidence, ValidationIssue } from './types.js'

export interface ClaimLocation {
  source: string
  /** Source-relative file, or the OpenAPI operation for a specification source. */
  path: string
  /** 1-based line the claim's facts appear on, when the evidence is a text file. */
  line?: number
  /** A few lines around it, for display. */
  excerpt?: string
  /** The writer cited this location, rather than Doxloop finding it. */
  cited: boolean
}

export interface ClaimEvidence {
  claim: string
  state: ClaimVerificationState
  locations: ClaimLocation[]
  /** Facts in the claim that the cited evidence does not contain. */
  missingFacts?: string[]
  /** Same-kind facts the evidence does contain, which the claim may have meant. */
  evidenceFacts?: string[]
}

export interface PageClaimEvidence {
  page: string
  confidence: PageEvidence['confidence']
  verifiedOn?: string
  sources: PageEvidence['sources']
  claims: ClaimEvidence[]
}

interface ParsedCitation {
  source: string
  path: string
  start?: number
  end?: number
}

const MAX_FILE_BYTES = 400_000
const MAX_FILES_PER_PAGE = 24
const EXCERPT_RADIUS = 2
const MAX_LOCATIONS = 3

/**
 * `product:src/auth.ts:42`, `product:src/auth.ts:40-58`, `product:src/auth.ts`
 * or `api:POST /oauth/token`. The source name is everything before the first
 * colon, so Windows drive letters never appear (paths are source-relative).
 */
export function parseClaimCitation(citation: string): ParsedCitation | undefined {
  const separator = citation.indexOf(':')
  if (separator <= 0) return undefined
  const source = citation.slice(0, separator).trim()
  const rest = citation.slice(separator + 1).trim()
  if (!source || !rest) return undefined
  const lines = /^(.*?):(\d+)(?:-(\d+))?$/.exec(rest)
  if (lines) {
    const start = Number(lines[2])
    const end = lines[3] ? Number(lines[3]) : start
    return { source, path: lines[1]!, start: Math.min(start, end), end: Math.max(start, end) }
  }
  return { source, path: rest }
}

/** The words a claim is about: code-like identifiers, quoted text, and its concrete facts. */
export function claimTerms(claim: string): string[] {
  const terms = new Set<string>()
  for (const fact of extractFacts(claim)) terms.add(fact.value)
  for (const match of claim.matchAll(/`([^`]{2,80})`/g)) terms.add(match[1]!)
  for (const match of claim.matchAll(/["“]([^"”]{3,60})["”]/g)) terms.add(match[1]!)
  // snake_case, kebab-case, dotted.names, camelCase, PascalCase with an inner capital, and paths.
  for (const match of claim.matchAll(/\b[A-Za-z][A-Za-z0-9]*(?:[_.\-/][A-Za-z0-9]+)+\b|\b[a-z]+[A-Z][A-Za-z0-9]*\b|\b[A-Z][a-z0-9]+[A-Z][A-Za-z0-9]*\b/g)) {
    if (match[0].length >= 4) terms.add(match[0])
  }
  // Plain numbers with a unit carry most of a claim's meaning ("expires after 900 seconds").
  for (const match of claim.matchAll(/\b(\d{2,})\s*(?:ms|milliseconds?|s|seconds?|minutes?|hours?|days?|MB|KB|GB|characters?|items?|requests?)\b/gi)) terms.add(match[1]!)
  return [...terms].filter((term) => term.trim().length >= 2)
}

function excerptAround(lines: string[], index: number): string {
  const start = Math.max(0, index - EXCERPT_RADIUS)
  const end = Math.min(lines.length, index + EXCERPT_RADIUS + 1)
  return lines.slice(start, end).map((line) => line.length > 200 ? `${line.slice(0, 199)}…` : line).join('\n')
}

/** The lines of a file that mention the most distinct terms, best first. */
export function bestLines(text: string, terms: string[], limit = MAX_LOCATIONS): Array<{ line: number; excerpt: string; score: number }> {
  if (terms.length === 0) return []
  const lowered = terms.map((term) => term.toLowerCase())
  const lines = text.split(/\r?\n/)
  const scored: Array<{ index: number; score: number }> = []
  for (const [index, line] of lines.entries()) {
    const value = line.toLowerCase()
    let score = 0
    for (const term of lowered) if (value.includes(term)) score += 1
    if (score > 0) scored.push({ index, score })
  }
  scored.sort((left, right) => right.score - left.score || left.index - right.index)
  const picked: Array<{ line: number; excerpt: string; score: number }> = []
  for (const candidate of scored) {
    if (picked.some((item) => Math.abs(item.line - 1 - candidate.index) <= EXCERPT_RADIUS * 2)) continue
    picked.push({ line: candidate.index + 1, excerpt: excerptAround(lines, candidate.index), score: candidate.score })
    if (picked.length >= limit) break
  }
  return picked
}

interface EvidenceFile {
  source: string
  path: string
  text: string
}

/** Readable files the page cites (directories and globs are too broad to search per claim). */
async function citedFiles(root: string, project: DoxloopProject, evidence: PageEvidence, cache: Map<string, string | undefined>): Promise<EvidenceFile[]> {
  const byName = new Map(project.sources.map((source) => [source.name, source]))
  const files: EvidenceFile[] = []
  const wanted: Array<{ source: string; path: string }> = []
  for (const citations of Object.values(evidence.claimSources ?? {})) {
    for (const citation of citations) {
      const parsed = parseClaimCitation(citation)
      if (parsed && !/^(?:GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\s/i.test(parsed.path)) wanted.push({ source: parsed.source, path: parsed.path })
    }
  }
  for (const entry of evidence.sources) for (const path of entry.paths ?? []) wanted.push({ source: entry.source, path })
  const seen = new Set<string>()
  for (const item of wanted) {
    if (files.length >= MAX_FILES_PER_PAGE) break
    const key = `${item.source}:${item.path}`
    if (seen.has(key) || /[*?[\]]/.test(item.path)) continue
    seen.add(key)
    const source = byName.get(item.source)
    if (!source || sourceKind(source) === 'openapi' || sourceKind(source) === 'docs-site') continue
    const text = await readSourceFile(root, source.path, item.path, cache)
    if (text !== undefined) files.push({ source: item.source, path: item.path, text })
  }
  return files
}

async function readSourceFile(root: string, sourcePath: string, path: string, cache: Map<string, string | undefined>): Promise<string | undefined> {
  const sourceRoot = resolve(root, sourcePath)
  const absolute = resolve(sourceRoot, path)
  const rel = relative(sourceRoot, absolute)
  if (rel === '..' || rel.startsWith('../') || rel.startsWith('..\\')) return undefined
  if (cache.has(absolute)) return cache.get(absolute)
  let text: string | undefined
  try {
    const info = await stat(absolute)
    if (info.isFile() && info.size <= MAX_FILE_BYTES) {
      const raw = await readFile(absolute, 'utf8')
      text = raw.includes('\u0000') ? undefined : raw
    }
  } catch {
    text = undefined
  }
  cache.set(absolute, text)
  return text
}

/** OpenAPI operations the page cites, as searchable text keyed by operation. */
async function operationTexts(root: string, project: DoxloopProject, evidence: PageEvidence): Promise<Array<{ source: string; operation: string; text: string }>> {
  const out: Array<{ source: string; operation: string; text: string }> = []
  const byName = new Map(project.sources.map((source) => [source.name, source]))
  for (const entry of evidence.sources) {
    const source = byName.get(entry.source)
    if (!source || sourceKind(source) !== 'openapi' || !entry.operations?.length) continue
    try {
      const loaded = await loadOpenApiSource(root, source)
      for (const operation of entry.operations) {
        const text = loaded.snapshot.operations[operation]?.full
        if (text) out.push({ source: entry.source, operation, text })
      }
    } catch {
      // An unavailable specification leaves the claim at its recorded state.
    }
  }
  return out
}

/** Locate and check every claim of one page. */
export async function pageClaimEvidence(root: string, project: DoxloopProject, page: string, evidence: PageEvidence, cache = new Map<string, string | undefined>()): Promise<PageClaimEvidence> {
  const files = await citedFiles(root, project, evidence, cache)
  const operations = await operationTexts(root, project, evidence)
  const allText = [...files.map((file) => file.text), ...operations.map((operation) => `${operation.operation}\n${operation.text}`)].join('\n').toLowerCase()
  const byName = new Map(project.sources.map((source) => [source.name, source]))
  const claims: ClaimEvidence[] = []
  for (const claim of evidence.claims ?? []) {
    const recorded = evidence.claimVerification?.[claim]
    const terms = claimTerms(claim)
    const locations: ClaimLocation[] = []
    // The writer's own citations, checked for existence and narrowed to their lines.
    for (const citation of evidence.claimSources?.[claim] ?? []) {
      const parsed = parseClaimCitation(citation)
      if (!parsed) continue
      const operation = operations.find((item) => item.source === parsed.source && item.operation.toLowerCase() === parsed.path.toLowerCase())
      if (operation) { locations.push({ source: parsed.source, path: operation.operation, cited: true }); continue }
      const source = byName.get(parsed.source)
      if (!source) continue
      const text = await readSourceFile(root, source.path, parsed.path, cache)
      if (text === undefined) continue
      const lines = text.split(/\r?\n/)
      if (parsed.start && parsed.start <= lines.length) {
        const end = Math.min(parsed.end ?? parsed.start, lines.length, parsed.start + 40)
        const window = lines.slice(parsed.start - 1, end).join('\n')
        const inWindow = bestLines(window, terms, 1)[0]
        const line = inWindow ? parsed.start + inWindow.line - 1 : parsed.start
        locations.push({ source: parsed.source, path: parsed.path, line, excerpt: excerptAround(lines, line - 1), cited: true })
      } else {
        const found = bestLines(text, terms, 1)[0]
        locations.push({ source: parsed.source, path: parsed.path, ...(found ? { line: found.line, excerpt: found.excerpt } : {}), cited: true })
      }
    }
    // Then the page's cited files, searched for the claim's facts and identifiers.
    if (locations.length === 0) {
      const found = files.flatMap((file) => bestLines(file.text, terms).map((hit) => ({ ...hit, file })))
        .sort((left, right) => right.score - left.score)
        .slice(0, MAX_LOCATIONS)
      for (const hit of found) locations.push({ source: hit.file.source, path: hit.file.path, line: hit.line, excerpt: hit.excerpt, cited: false })
      for (const operation of operations) {
        if (locations.length >= MAX_LOCATIONS) break
        if (terms.some((term) => operation.text.toLowerCase().includes(term.toLowerCase()) || operation.operation.toLowerCase().includes(term.toLowerCase()))) {
          locations.push({ source: operation.source, path: operation.operation, cited: false })
        }
      }
    }
    const fallback: ClaimVerificationState = evidence.confidence === 'verified' ? 'verified' : evidence.confidence === 'inferred' ? 'inferred' : 'needs-human'
    const state = semanticClaimState(claim, allText, false, recorded, fallback)
    const facts = extractFacts(claim)
    const missing = facts.filter((fact) => !allText.includes(fact.value.toLowerCase())).map((fact) => fact.value)
    const kinds = new Set(facts.filter((fact) => missing.includes(fact.value)).map((fact) => fact.kind))
    const comparable = state === 'contradicted'
      ? [...new Set(extractFacts([...files.map((file) => file.text), ...operations.map((operation) => operation.text)].join('\n')).filter((fact) => kinds.has(fact.kind)).map((fact) => fact.value))].slice(0, 6)
      : []
    claims.push({
      claim,
      state,
      locations,
      ...(missing.length > 0 && state !== 'verified' ? { missingFacts: missing } : {}),
      ...(comparable.length > 0 ? { evidenceFacts: comparable } : {}),
    })
  }
  const dates = Object.values(evidence.verifiedOn ?? {}).filter(Boolean).sort()
  return {
    page,
    confidence: evidence.confidence,
    ...(dates[0] ? { verifiedOn: dates[0] } : {}),
    sources: evidence.sources,
    claims,
  }
}

/** Claim evidence for one page of the project's evidence map, or undefined when the page has no entry. */
export async function readPageClaimEvidence(root: string, project: DoxloopProject, page: string): Promise<PageClaimEvidence | undefined> {
  const map = await readEvidenceMap(root)
  const evidence = map?.pages[page]
  if (!evidence) return undefined
  return pageClaimEvidence(root, project, page, evidence)
}

/**
 * A warning per contradicted claim on the given pages, for the end-of-run
 * fix pass: the fix session checks the named claim against the named lines
 * and either corrects the page or cites the lines that do support it.
 */
export async function contradictedClaimIssues(root: string, project: DoxloopProject, pages: string[]): Promise<ValidationIssue[]> {
  const map = await readEvidenceMap(root)
  if (!map) return []
  const cache = new Map<string, string | undefined>()
  const issues: ValidationIssue[] = []
  for (const page of pages) {
    const evidence = map.pages[page]
    if (!evidence?.claims?.length) continue
    const result = await pageClaimEvidence(root, project, page, evidence, cache)
    for (const claim of result.claims) {
      if (claim.state !== 'contradicted') continue
      const where = claim.locations.filter((location) => location.line).slice(0, 2).map((location) => `${location.path}:${location.line}`).join(', ')
      issues.push({
        severity: 'warning',
        code: 'claim-contradicted',
        file: page,
        message: `The claim "${claim.claim}" names ${claim.missingFacts?.join(', ') ?? 'a value'}, but the evidence this page cites has ${claim.evidenceFacts?.join(', ') ?? 'different values'} instead${where ? ` (see ${where})` : ''}. Read those lines: correct the page and the claim if the page is wrong, or, if the page is right, add the exact supporting lines to claimSources for this claim in the evidence map.`,
      })
    }
  }
  return issues
}
