/**
 * Per-batch artifacts for concurrent authoring sessions.
 *
 * Sessions that run at the same time in one workspace must not edit the same
 * JSON files: two agents saving `.doxloop/screenshot-manifest.json` or the
 * evidence map at once lose each other's rows. Each batch therefore gets its
 * own slice of the plan, of the manifest, and of the evidence map under
 * `.doxloop/cache`, and Doxloop merges the slices back under a lock after the
 * session ends. The cache directory is never part of a proposal.
 */
import { readFileSync } from 'node:fs'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, join, normalize, relative, resolve } from 'node:path'
import { PNG } from 'pngjs'
import { pathExists } from './fs.js'
import { readEvidenceMap, writeEvidenceMap } from './evidence.js'
import { seedEvidence } from './authoring-postpass.js'
import { parseOpenApi } from './openapi.js'
import { preferredPageExtension } from './page-extension.js'
import { SCREENSHOT_MANIFEST_FILE, dominantColorShare } from './screenshot-workflow.js'
import type { AuthoringBatch } from './authoring-batches.js'
import type { DocumentationPlan, EvidenceMap, PageEvidence } from './types.js'

export interface BatchArtifacts {
  /** Project-relative plan slice for the batch. */
  slice: string
  /** Project-relative manifest slice, when the batch has screenshot guides. */
  manifest?: string
  /** Project-relative evidence-map slice. */
  evidence: string
}

interface ManifestLike { schemaVersion: number; guides: Array<{ page: string; steps: unknown[] }> }

export function batchArtifactPaths(index: number): BatchArtifacts {
  return {
    slice: `.doxloop/cache/authoring-batch-${index}.json`,
    manifest: `.doxloop/cache/screenshot-manifest-batch-${index}.json`,
    evidence: `.doxloop/cache/evidence-batch-${index}.json`,
  }
}

/** Write the slices a batch session reads and fills in. */
export async function writeBatchArtifacts(
  workspace: string,
  plan: DocumentationPlan,
  batch: AuthoringBatch,
  slice: Record<string, unknown>,
  /** Project-relative page files of the batch, for the evidence slice's keys. */
  pageFiles: string[] = [],
): Promise<BatchArtifacts> {
  const paths = batchArtifactPaths(batch.index)
  await mkdir(join(workspace, '.doxloop', 'cache'), { recursive: true })
  await writeFile(join(workspace, paths.slice), `${JSON.stringify(slice, null, 1)}\n`, 'utf8')

  const manifest = await readManifest(workspace)
  const ids = new Set(batch.pages.map((page) => page.id))
  const pathsById = new Map(batch.pages.map((page) => [page.path, page.id]))
  const guides = manifest?.guides.filter((guide) => guide && (ids.has(guide.page) || pathsById.has(guide.page))) ?? []
  let manifestPath: string | undefined
  if (guides.length > 0) {
    await writeFile(join(workspace, paths.manifest!), `${JSON.stringify({ schemaVersion: 1, guides }, null, 2)}\n`, 'utf8')
    manifestPath = paths.manifest
  }

  let existing: EvidenceMap | undefined
  try {
    existing = await readEvidenceMap(workspace)
  } catch {
    existing = undefined
  }
  const pages: Record<string, PageEvidence> = {}
  for (const file of pageFiles) {
    const entry = existing?.pages[file]
    if (entry) pages[file] = entry
  }
  // A page not written yet gets its entry at the file the plan puts it in,
  // seeded from the plan's citations, so the writer adds claims and paths to
  // an entry instead of reading other batches' files to learn the schema.
  const contentDir = plan.target?.contentDir || ''
  const extension = preferredPageExtension(plan.target)
  for (const page of batch.pages) {
    const expected = join(contentDir, `${page.path}${extension}`).replaceAll('\\', '/')
    if (Object.keys(pages).some((file) => file === expected || file.replace(/\.[^.]+$/, '') === expected.replace(/\.[^.]+$/, ''))) continue
    pages[expected] = seedEvidence(page)
  }
  await writeFile(join(workspace, paths.evidence), `${JSON.stringify({ schemaVersion: 1, pages }, null, 2)}\n`, 'utf8')
  return { slice: paths.slice, ...(manifestPath ? { manifest: manifestPath } : {}), evidence: paths.evidence }
}

export interface BatchMergeReport {
  guides: number
  evidencePages: number
  problems: string[]
}

const PAGE_EXTENSIONS_BY_PREFERENCE = ['.mdx', '.md', '.rst', '.ipynb', '.txt']

/** The file a page evidence key names, or the sibling with another page extension when only that one exists. */
async function writtenPageFile(workspace: string, file: string): Promise<string> {
  if (await pathExists(join(workspace, file))) return file
  const match = file.match(/^(.*)(\.[A-Za-z0-9]+)$/)
  if (!match) return file
  for (const extension of PAGE_EXTENSIONS_BY_PREFERENCE) {
    if (extension === match[2]) continue
    const candidate = `${match[1]}${extension}`
    if (await pathExists(join(workspace, candidate))) return candidate
  }
  return file
}

/** Fold a finished batch's manifest and evidence slices back into the workspace files. */
export async function mergeBatchArtifacts(workspace: string, artifacts: BatchArtifacts): Promise<BatchMergeReport> {
  const report: BatchMergeReport = { guides: 0, evidencePages: 0, problems: [] }
  if (artifacts.manifest && (await pathExists(join(workspace, artifacts.manifest)))) {
    try {
      const slice = JSON.parse(await readFile(join(workspace, artifacts.manifest), 'utf8')) as ManifestLike
      const main = (await readManifest(workspace)) ?? { schemaVersion: 1, guides: [] }
      if (Array.isArray(slice?.guides)) {
        for (const guide of slice.guides) {
          if (!guide || typeof guide.page !== 'string' || !Array.isArray(guide.steps)) continue
          const index = main.guides.findIndex((item) => item?.page === guide.page)
          if (index >= 0) main.guides[index] = guide
          else main.guides.push(guide)
          report.guides += 1
        }
        await writeFile(join(workspace, SCREENSHOT_MANIFEST_FILE), `${JSON.stringify(main, null, 2)}\n`, 'utf8')
      }
    } catch (error) {
      report.problems.push(`screenshot manifest slice ${artifacts.manifest} could not be merged: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (await pathExists(join(workspace, artifacts.evidence))) {
    try {
      const slice = JSON.parse(await readFile(join(workspace, artifacts.evidence), 'utf8')) as { pages?: Record<string, unknown> }
      const entries = Object.entries(slice?.pages ?? {}).filter(([file, value]) => typeof file === 'string' && isPageEvidence(value)) as Array<[string, PageEvidence]>
      if (entries.length > 0) {
        let main: EvidenceMap | undefined
        try {
          main = await readEvidenceMap(workspace)
        } catch (error) {
          report.problems.push(`evidence map could not be read before merging batch evidence: ${error instanceof Error ? error.message : String(error)}`)
        }
        const merged: EvidenceMap = main ?? { schemaVersion: 1, pages: {} }
        for (const [file, entry] of entries) {
          // The slice is seeded before the page exists, so its key guesses
          // the extension; a page written as .mdx under a .md key left an
          // orphan entry (validation warned on four pages of a real run).
          const actual = await writtenPageFile(workspace, file)
          if (actual !== file) delete merged.pages[file]
          merged.pages[actual] = entry
          report.evidencePages += 1
        }
        await writeEvidenceMap(workspace, merged)
      }
    } catch (error) {
      report.problems.push(`evidence slice ${artifacts.evidence} could not be merged: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return report
}

async function readManifest(workspace: string): Promise<ManifestLike | undefined> {
  const path = join(workspace, SCREENSHOT_MANIFEST_FILE)
  if (!(await pathExists(path))) return undefined
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as ManifestLike
    return value && Array.isArray(value.guides) ? value : undefined
  } catch {
    return undefined
  }
}

function isPageEvidence(value: unknown): value is PageEvidence {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const sources = (value as { sources?: unknown }).sources
  return Array.isArray(sources) && sources.every((source) => source && typeof source === 'object' && typeof (source as { source?: unknown }).source === 'string')
}

/** Run `worker` over `items` with at most `concurrency` in flight, preserving nothing about order. */
export async function runPool<T>(items: readonly T[], concurrency: number, worker: (item: T) => Promise<void>, shouldStop?: () => boolean): Promise<void> {
  const queue = [...items]
  const width = Math.max(1, Math.min(concurrency, queue.length))
  const lanes = Array.from({ length: width }, async () => {
    for (;;) {
      if (shouldStop?.()) return
      const item = queue.shift()
      if (item === undefined) return
      await worker(item)
    }
  })
  await Promise.all(lanes)
}

/** A promise-chained mutex for the workspace files several sessions share. */
export function createLock(): <T>(task: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve()
  return <T>(task: () => Promise<T>): Promise<T> => {
    const run = tail.then(task, task)
    tail = run.catch(() => undefined)
    return run
  }
}

// ---------------------------------------------------------------------------
// Capture status

const STEP_STATUSES = new Set(['planned', 'verified', 'text-only', 'failed'])
const CHECK_KEYS = ['expectedStateConfirmed', 'privacyReviewed', 'legibilityReviewed', 'meaningful'] as const
const MIN_IMAGE = { width: 320, height: 180 }
const BLANK_SHARE = 0.995

export interface CaptureNormalization {
  /** Steps whose saved image exists and passed the image checks. */
  verified: string[]
  /** Steps reset to planned, with the reason. */
  reset: Array<{ step: string; reason: string }>
}

/**
 * Decide each step's status from what is on disk, not from the word the agent
 * wrote. Capture sessions have recorded `captured`, `done`, and `ok`; every
 * such row failed the manifest check, and a real run retook thirteen images
 * it already had. A step with a readable, non-blank PNG of usable size at its
 * recorded path is verified; a step that claims a file it does not have goes
 * back to planned so the retake knows about it.
 */
export function normalizeCaptureSteps(
  guides: Array<{ page: string; steps: unknown[] }>,
  imageAt: (file: string) => { width: number; height: number; blank: boolean } | undefined,
): CaptureNormalization {
  const result: CaptureNormalization = { verified: [], reset: [] }
  for (const guide of guides) {
    if (!guide || !Array.isArray(guide.steps)) continue
    for (const raw of guide.steps) {
      const step = raw as Record<string, unknown>
      if (!step || typeof step.id !== 'string') continue
      const label = `${guide.page}/${step.id}`
      const status = typeof step.status === 'string' ? step.status : ''
      if (status === 'text-only' && typeof step.textOnlyReason === 'string' && step.textOnlyReason.trim()) continue
      if (status === 'failed') continue
      const file = typeof step.file === 'string' ? step.file.trim() : ''
      if (file) {
        const image = imageAt(file)
        const reason = !image
          ? `recorded image ${file} is missing or unreadable`
          : image.width < MIN_IMAGE.width || image.height < MIN_IMAGE.height
            ? `recorded image ${file} is too small (${image.width}x${image.height})`
            : image.blank ? `recorded image ${file} is blank` : undefined
        if (!reason) {
          const checks = (step.checks && typeof step.checks === 'object' ? step.checks : {}) as Record<string, unknown>
          step.status = 'verified'
          step.capture = true
          step.checks = Object.fromEntries(CHECK_KEYS.map((key) => [key, checks[key] !== false]))
          if (typeof step.alt !== 'string' || !step.alt.trim()) step.alt = typeof step.expectedState === 'string' ? step.expectedState : file
          if (typeof step.target !== 'string' || !step.target.trim()) step.target = typeof step.action === 'string' ? step.action : file
          delete step.textOnlyReason
          result.verified.push(label)
          continue
        }
        delete step.file
        step.status = 'planned'
        if (typeof step.capture !== 'boolean') step.capture = true
        result.reset.push({ step: label, reason })
        continue
      }
      if (!STEP_STATUSES.has(status) || status === 'verified') {
        step.status = 'planned'
        if (typeof step.capture !== 'boolean') step.capture = true
        result.reset.push({ step: label, reason: status === 'verified' ? 'marked verified without a saved image' : `status "${status || '(none)'}" is not planned, verified, text-only, or failed` })
      } else if (typeof step.capture !== 'boolean') {
        step.capture = true
      }
    }
  }
  return result
}

/** Normalize the steps of a manifest file (a capture slice or the main manifest) against the images in the workspace. */
export async function normalizeCaptureManifest(workspace: string, manifestFile: string): Promise<CaptureNormalization> {
  const path = join(workspace, manifestFile)
  if (!(await pathExists(path))) return { verified: [], reset: [] }
  const manifest = JSON.parse(await readFile(path, 'utf8')) as ManifestLike
  if (!Array.isArray(manifest?.guides)) return { verified: [], reset: [] }
  const root = resolve(workspace)
  const result = normalizeCaptureSteps(manifest.guides, (file) => {
    // Agents save by absolute path as instructed; the manifest keeps it project-relative.
    const absolute = isAbsolute(file) ? file : resolve(root, file)
    if (relative(root, absolute).startsWith('..') || normalize(file).split(/[\\/]/).includes('..')) return undefined
    try {
      const png = PNG.sync.read(readFileSync(absolute))
      return { width: png.width, height: png.height, blank: dominantColorShare(png) > BLANK_SHARE }
    } catch {
      return undefined
    }
  })
  for (const guide of manifest.guides) {
    for (const raw of guide.steps) {
      const step = raw as Record<string, unknown>
      if (typeof step?.file === 'string' && isAbsolute(step.file) && !relative(root, step.file).startsWith('..')) step.file = relative(root, step.file).replaceAll('\\', '/')
    }
  }
  if (result.verified.length > 0 || result.reset.length > 0) await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  return result
}

// ---------------------------------------------------------------------------
// Evidence ownership

/** Files a session read, grouped by configured source name, source-relative. */
export type SessionSourceReads = Map<string, Set<string>>

/**
 * Map the absolute paths a session opened to the configured sources they
 * live in. Only files under a source count; a page the agent re-read or a
 * cache file is not evidence.
 */
export function attributeReadsToSources(paths: Iterable<string>, sources: ReadonlyArray<{ name: string; path: string }>, workspace: string): SessionSourceReads {
  const roots = sources.map((source) => ({ name: source.name, root: resolve(isAbsolute(source.path) ? source.path : join(workspace, source.path)) }))
  const reads: SessionSourceReads = new Map()
  for (const raw of paths) {
    const absolute = resolve(raw)
    for (const source of roots) {
      const inside = relative(source.root, absolute)
      if (!inside || inside.startsWith('..') || isAbsolute(inside)) continue
      const set = reads.get(source.name) ?? new Set<string>()
      set.add(inside.replaceAll('\\', '/'))
      reads.set(source.name, set)
    }
  }
  return reads
}

/** Paths named in a tool call: Read/Grep targets and the file arguments of a shell command. */
export function pathsInToolCall(tool: string, input: Record<string, unknown>): string[] {
  const out: string[] = []
  for (const key of ['file_path', 'path', 'notebook_path']) if (typeof input[key] === 'string') out.push(input[key] as string)
  if (tool === 'Bash' && typeof input.command === 'string') {
    for (const match of (input.command as string).matchAll(/(?:^|[\s"'=(])((?:\/|\$\w+\/|\.\.?\/)[^\s"'`;|&<>)]+)/g)) {
      const token = match[1]!
      if (token.startsWith('$')) continue
      out.push(token)
    }
  }
  return out
}

/**
 * Doxloop owns the evidence map. An agent-written slice is input, not truth:
 * its claims are kept, its source paths are kept only where the file exists,
 * and the plan's citations plus the files this session actually read are
 * always present. A page whose entry names no path it can be checked
 * against is `inferred`, whatever the agent wrote.
 */
export async function reconcileEvidenceSlice(
  workspace: string,
  sliceFile: string,
  plan: Pick<DocumentationPlan, 'target'>,
  pages: DocumentationPlan['pages'],
  sources: ReadonlyArray<{ name: string; path: string }>,
  reads: SessionSourceReads,
): Promise<{ pages: number; droppedPaths: number }> {
  const path = join(workspace, sliceFile)
  let slice: { schemaVersion?: number; pages?: Record<string, unknown> } = {}
  try { slice = JSON.parse(await readFile(path, 'utf8')) } catch { slice = {} }
  const written = (slice.pages && typeof slice.pages === 'object' ? slice.pages : {}) as Record<string, Partial<PageEvidence>>
  const roots = new Map(sources.map((source) => [source.name, resolve(isAbsolute(source.path) ? source.path : join(workspace, source.path))]))
  const contentDir = plan.target?.contentDir || ''
  const extension = preferredPageExtension(plan.target)
  const specifications = await specificationSurfaces(roots)
  const result = { pages: 0, droppedPaths: 0 }
  const next: Record<string, PageEvidence> = {}
  for (const page of pages) {
    const planned = join(contentDir, `${page.path}${extension}`).replaceAll('\\', '/')
    const expected = await plannedPageFile(workspace, contentDir, page.path, extension, planned)
    const stems = new Set([planned, expected].map((file) => file.replace(/\.[^.]+$/, '')))
    const key = Object.keys(written).find((file) => file === expected || stems.has(file.replace(/\.[^.]+$/, ''))) ?? expected
    const agent = written[key] ?? {}
    const merged = new Map<string, Set<string>>()
    const add = (source: string, paths: Iterable<string>): void => {
      const set = merged.get(source) ?? new Set<string>()
      for (const item of paths) set.add(item)
      merged.set(source, set)
    }
    for (const detail of page.evidenceDetails ?? []) if (detail?.source && roots.has(detail.source)) add(detail.source, detail.path ? [detail.path] : [])
    let agentNamedPath = false
    for (const entry of Array.isArray(agent.sources) ? agent.sources : []) {
      if (!entry || typeof entry.source !== 'string' || !roots.has(entry.source)) continue
      const kept: string[] = []
      const specification = specifications.get(entry.source)
      for (const candidate of entry.paths ?? []) {
        if (typeof candidate !== 'string') continue
        // A source that is one specification file has no paths below it; the
        // agent naming that file means it read the contract, and the page is
        // tied to the operations it documents instead (see below).
        if (specification && (candidate === specification.file || candidate === '.' || candidate === '')) { agentNamedPath = true; continue }
        const absolute = resolve(roots.get(entry.source)!, candidate)
        if (relative(roots.get(entry.source)!, absolute).startsWith('..')) { result.droppedPaths += 1; continue }
        if (/[*?[]/.test(candidate) || await pathExists(absolute)) kept.push(candidate.replaceAll('\\', '/'))
        else result.droppedPaths += 1
      }
      if (kept.length > 0) agentNamedPath = true
      add(entry.source, kept)
    }
    // Reads are attributed only when neither the plan nor the agent named a
    // path for the page: a batch session reads for several pages at once, and
    // a path on every page makes every change look relevant.
    if ([...merged.values()].every((set) => set.size === 0)) for (const [source, set] of reads) if (!specifications.has(source)) add(source, set)
    // Drift reports an OpenAPI change as operation and schema identifiers, so
    // a page is tied to exactly the ones it documents: those the agent or the
    // plan named, and those its text mentions. Without them a page matched
    // every change to the specification.
    const operations = new Map<string, string[]>()
    if (specifications.size > 0) {
      const body = await readFile(join(workspace, expected), 'utf8').catch(() => '')
      const agentOperations = (Array.isArray(agent.sources) ? agent.sources : []).flatMap((entry) => Array.isArray(entry?.operations) ? entry.operations.filter((item): item is string => typeof item === 'string') : [])
      const claims = Array.isArray(agent.claims) ? agent.claims.filter((claim): claim is string => typeof claim === 'string') : []
      const text = [body, ...claims, ...agentOperations, ...(page.evidence ?? []), ...(page.evidenceDetails ?? []).map((detail) => `${detail?.label ?? ''} ${detail?.path ?? ''}`)].join('\n')
      for (const [source, specification] of specifications) {
        const mentioned = mentionedSurface(text, specification)
        if (mentioned.length === 0) continue
        operations.set(source, mentioned)
        if (!merged.has(source)) merged.set(source, new Set())
      }
    }
    const entry: PageEvidence = {
      sources: [...merged].map(([source, set]) => ({
        source,
        ...(set.size > 0 ? { paths: [...set].sort() } : {}),
        ...(operations.get(source)?.length ? { operations: operations.get(source)! } : {}),
      })),
      // The agent's confidence stands only when it named a real file it read; a
      // "verified" over no path is the word, not the check.
      confidence: agentNamedPath && (agent.confidence === 'verified' || agent.confidence === 'inferred' || agent.confidence === 'needs-human') ? agent.confidence : 'inferred',
    }
    const claims = Array.isArray(agent.claims) ? agent.claims.filter((claim): claim is string => typeof claim === 'string' && claim.trim().length > 0).slice(0, 40) : []
    if (claims.length > 0) entry.claims = claims
    if (agent.claimVerification && typeof agent.claimVerification === 'object') {
      const verification = Object.fromEntries(Object.entries(agent.claimVerification).filter(([claim, state]) => claims.includes(claim) && ['verified', 'inferred', 'contradicted', 'needs-human'].includes(String(state))))
      if (Object.keys(verification).length > 0) entry.claimVerification = verification as NonNullable<PageEvidence['claimVerification']>
    }
    // Claim citations are kept only for a kept claim and a configured source;
    // the lines themselves are checked when the claim evidence is read.
    if (agent.claimSources && typeof agent.claimSources === 'object' && !Array.isArray(agent.claimSources)) {
      const cited: Record<string, string[]> = {}
      for (const [claim, citations] of Object.entries(agent.claimSources as Record<string, unknown>)) {
        if (!claims.includes(claim) || !Array.isArray(citations)) continue
        const kept = citations.filter((citation): citation is string => typeof citation === 'string' && roots.has(citation.split(':')[0]!.trim())).slice(0, 6)
        if (kept.length > 0) cited[claim] = kept
      }
      if (Object.keys(cited).length > 0) entry.claimSources = cited
    }
    next[expected] = entry
    result.pages += 1
  }
  await writeFile(path, `${JSON.stringify({ schemaVersion: 1, pages: next }, null, 2)}\n`, 'utf8')
  return result
}

/**
 * The file a planned page was written to. A planned landing page
 * (`guides/index`, `overview`) is written where the site keeps its index, as
 * `planPageFiles` resolves it, so its evidence must be recorded there too.
 */
async function plannedPageFile(workspace: string, contentDir: string, path: string, extension: string, planned: string): Promise<string> {
  if (await pathExists(join(workspace, planned))) return planned
  const candidates = [join(contentDir, path, `index${extension}`)]
  if (/^(?:index|overview|home|start-here)$/i.test(path.split('/').pop() ?? '')) candidates.push(join(contentDir, `index${extension}`))
  for (const candidate of candidates) {
    if (await pathExists(join(workspace, candidate))) return candidate.replaceAll('\\', '/')
  }
  return planned
}

interface SpecificationSurface {
  /** The specification's file name, which is how an agent cites it. */
  file: string
  operations: string[]
  schemas: string[]
}

/** Operations and schemas of every source that is a single OpenAPI file. */
async function specificationSurfaces(roots: ReadonlyMap<string, string>): Promise<Map<string, SpecificationSurface>> {
  const surfaces = new Map<string, SpecificationSurface>()
  for (const [source, root] of roots) {
    try {
      if (!(await stat(root)).isFile()) continue
      const { snapshot } = parseOpenApi(await readFile(root, 'utf8'))
      surfaces.set(source, { file: basename(root), operations: Object.keys(snapshot.operations), schemas: Object.keys(snapshot.schemas) })
    } catch { /* not a readable specification file */ }
  }
  return surfaces
}

/**
 * The operations (`GET /pet/{petId}`) and schemas (`schema:Order`) a text
 * mentions. An operation must not continue into a longer path, so
 * `POST /pet` does not match inside `POST /pet/{petId}`. A schema counts
 * only in code or as a named object or schema, because schema names such as
 * `Pet` are also ordinary words.
 */
export function mentionedSurface(text: string, surface: Pick<SpecificationSurface, 'operations' | 'schemas'>): string[] {
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const operations = surface.operations.filter((operation) => {
    const [method, path] = operation.split(' ')
    return new RegExp(`(^|[^A-Za-z])${escape(method!)}\\s+\`?${escape(path!)}(?![\\w/{-])`, 'i').test(text)
  })
  const schemas = surface.schemas.filter((schema) => new RegExp(`\`${escape(schema)}\`|\\b${escape(schema)}\\s+(object|schema|model)s?\\b|#/components/schemas/${escape(schema)}\\b`).test(text))
  return [...operations.sort(), ...schemas.sort().map((schema) => `schema:${schema}`)]
}

