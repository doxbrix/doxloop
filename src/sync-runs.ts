import { createHash, randomBytes } from 'node:crypto'
import { execFile } from 'node:child_process'
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { isDeepStrictEqual, promisify } from 'node:util'
import {
  runAuthor,
  type ClaudeEffortLevel,
  type ReasoningLevel,
  type ScreenshotIntent,
} from './author.js'
import { DoxloopError } from './errors.js'
import { assertInside, pathExists, readJson } from './fs.js'
import {
  recordSourceSyncs,
  recordSyncRun,
  syncPageRegistry,
  type SyncRunContext,
} from './history.js'
import { pageExtensions as documentationPageExtensions, readPage } from './project.js'
import { formatSourceChanges } from './sync.js'
import { lineHunks, textLines } from './text-diff.js'
import { formatValidation, validateProject } from './validation.js'
import type {
  AgentName,
  DoxloopProject,
  DriftResult,
  SourceChange,
  SyncChangeCategory,
  SyncFileChange,
  SyncRun,
  SyncRunTrigger,
  SyncState,
} from './types.js'

export const SYNC_RUNS_DIRECTORY = join('.doxloop', 'runs')
const RUN_FILE = 'run.json'
const WORKSPACE = 'workspace'
const BEFORE = 'before'

const EXCLUDED_PREFIXES = [
  '.git',
  'node_modules',
  '.doxloop/runs',
  '.doxloop/cache',
  '.doxloop/last-run.json',
  '.doxloop/sync.log',
  '.doxloop/ui-jobs.json',
  '.doxloop/ui-job-logs',
  // History is a derived local index. Copying it into a proposal workspace would
  // offer the database back as a binary documentation change.
  '.doxloop/doxloop.db',
  '.doxloop/doxloop.db-wal',
  '.doxloop/doxloop.db-shm',
  'build',
  'dist',
  'out',
  'public',
  'site',
  '_build',
]

const INTERNAL_DIFF_PATHS = new Set([
  '.doxloop/last-run.json',
  '.doxloop/sync-state.json',
  '.doxloop/sync.log',
])
const runCommand = promisify(execFile)

const BINARY_EXTENSIONS = new Set([
  '.avif',
  '.gif',
  '.ico',
  '.jpeg',
  '.jpg',
  '.pdf',
  '.png',
  '.ttf',
  '.otf',
  '.webp',
  '.woff',
  '.woff2',
  '.zip',
])

export interface CreateSyncRunOptions {
  root: string
  project: DoxloopProject
  drift: DriftResult
  sourceChanges: SourceChange[]
  /** Isolated evidence paths used only inside the proposal workspace. */
  authoringSources?: DoxloopProject['sources']
  trigger?: SyncRunTrigger
  author?: typeof runAuthor
  /** Baseline to place in the proposal and apply only after approval. */
  nextSyncState?: SyncState
  /** User-selected authoring controls for a manual workspace update. */
  authoring?: {
    request?: string
    agent?: AgentName
    model?: string
    reasoning?: ReasoningLevel
    effort?: ClaudeEffortLevel
    screenshots?: ScreenshotIntent
  }
}

export interface AcceptSelection {
  changeId: string
  hunkIds?: string[]
}

/** Generate and validate a proposal without changing the real documentation. */
export async function createSyncRun(options: CreateSyncRunOptions): Promise<SyncRun> {
  const id = runId()
  const directory = runDirectory(options.root, id)
  await mkdir(directory, { recursive: true })
  await ensureRunsIgnored(options.root)
  const createdAt = new Date().toISOString()
  let run: SyncRun = {
    schemaVersion: 1,
    id,
    status: 'generating',
    mode: options.project.sync.mode === 'auto' ? 'auto' : 'propose',
    trigger: options.trigger ?? 'manual',
    createdAt,
    summary: `Generating a review for ${options.drift.pages.length} stale page${options.drift.pages.length === 1 ? '' : 's'}`,
    sourceSummary: sourceSummary(options.sourceChanges),
    stalePages: options.drift.pages.map((page) => page.page),
    changes: [],
  }
  await writeRun(options.root, run)
  const history: SyncRunContext = {
    requestText: options.authoring?.request,
    agent: options.authoring?.agent ?? options.project.defaultAgent,
    model: options.authoring?.model,
    reasoningEffort: options.authoring?.reasoning ?? options.authoring?.effort,
    runDir: join(SYNC_RUNS_DIRECTORY, id),
  }
  await recordSyncRun(options.root, run, history)

  try {
    const originalProjectText = await readFile(
      join(options.root, '.doxloop', 'project.json'),
      'utf8',
    )
    const workspace = await createWorkspace(
      options.root,
      directory,
      options.project,
      options.authoringSources,
    )
    const exitCode = await (options.author ?? runAuthor)({
      root: workspace,
      mode: 'update',
      nonInteractive: true,
      recordHistory: false,
      ...(options.sourceChanges.length > 0
        ? {
            changeSummary: formatSourceChanges(
              options.sourceChanges.map((change) => ({
                ...change,
                path: isAbsolute(change.path)
                  ? change.path
                  : resolve(options.root, change.path),
              })),
            ),
          }
        : {}),
      ...(options.project.defaultAgent ? { agent: options.project.defaultAgent } : {}),
      ...(options.project.sync.budget?.maxMinutes
        ? { timeoutMinutes: options.project.sync.budget.maxMinutes }
        : {}),
      ...options.authoring,
    })
    if (exitCode !== 0) {
      throw new DoxloopError(`The documentation agent exited with status ${exitCode}.`)
    }

    if (options.nextSyncState) {
      await writeFile(
        join(workspace, '.doxloop', 'sync-state.json'),
        `${JSON.stringify(options.nextSyncState, null, 2)}\n`,
        'utf8',
      )
    }

    // The staged project uses absolute sources so it can live away from the real
    // project. Restore the user's portable bindings before calculating changes.
    await restoreWorkspaceSources(workspace, options.project, originalProjectText)
    const validation = await validateProject(workspace)
    if (validation.errors > 0) {
      throw new DoxloopError(
        `The generated proposal did not pass validation:\n${formatValidation(validation)}`,
      )
    }
    const changes = await collectProposalChanges(options.root, workspace, directory, options.project)
    if (changes.length === 0) {
      throw new DoxloopError('The agent completed without proposing any documentation changes.')
    }
    run = {
      ...run,
      status: 'awaiting-review',
      completedAt: new Date().toISOString(),
      summary: proposalSummary(changes),
      changes,
      validation: {
        pages: validation.pages.length,
        errors: validation.errors,
        warnings: validation.warnings,
      },
    }
    await writeRun(options.root, run)
    await recordSyncRun(options.root, run, history)
    return run
  } catch (error) {
    run = {
      ...run,
      status: 'failed',
      completedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
      summary: 'Proposal generation failed',
    }
    await writeRun(options.root, run)
    await recordSyncRun(options.root, run, history)
    return run
  }
}

export async function listSyncRuns(root: string): Promise<SyncRun[]> {
  const directory = join(root, SYNC_RUNS_DIRECTORY)
  if (!(await pathExists(directory))) return []
  const entries = await readdir(directory, { withFileTypes: true })
  const runs: SyncRun[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    try {
      runs.push(await readSyncRun(root, entry.name))
    } catch {
      // An interrupted directory without a valid manifest is not a review run.
    }
  }
  return runs.sort((left, right) => right.createdAt.localeCompare(left.createdAt))
}

export async function readSyncRun(root: string, id: string): Promise<SyncRun> {
  assertRunId(id)
  const run = await readJson<SyncRun>(join(runDirectory(root, id), RUN_FILE))
  if (run.schemaVersion !== 1 || run.id !== id || !Array.isArray(run.changes)) {
    throw new DoxloopError(`Sync run ${id} is invalid.`)
  }
  const changes = run.changes.filter((change) => !isExcluded(change.path))
  const excludedRuntimeConflict = run.status === 'conflicted' && Boolean(
    run.error && EXCLUDED_PREFIXES.some((prefix) =>
      run.error!.startsWith(`${prefix} `) || run.error!.startsWith(`${prefix}/`),
    ),
  )
  if (changes.length === run.changes.length && !excludedRuntimeConflict) return run
  if (excludedRuntimeConflict) {
    const { error: _excludedError, ...cleanRun } = run
    return {
      ...cleanRun,
      status: 'awaiting-review',
      changes,
      summary: proposalSummary(changes),
    }
  }
  return {
    ...run,
    changes,
    summary: proposalSummary(changes),
  }
}

export async function rejectSyncRun(root: string, id: string): Promise<SyncRun> {
  const run = await readSyncRun(root, id)
  if (!['awaiting-review', 'partially-applied', 'conflicted'].includes(run.status)) {
    throw new DoxloopError(`Sync run ${id} cannot be rejected from status ${run.status}.`)
  }
  const now = new Date().toISOString()
  const next: SyncRun = {
    ...run,
    status: 'rejected',
    rejectedAt: now,
    changes: run.changes.map((change) => ({
      ...change,
      hunks: change.hunks.map((hunk) =>
        hunk.acceptedAt || hunk.rejectedAt ? hunk : { ...hunk, rejectedAt: now },
      ),
    })),
  }
  await writeRun(root, next)
  await recordSyncRun(root, next)
  return next
}

/** Apply selected hunks after proving the real files still match this proposal. */
export async function acceptSyncChanges(
  root: string,
  id: string,
  selections: AcceptSelection[],
): Promise<SyncRun> {
  const run = await readSyncRun(root, id)
  if (!['awaiting-review', 'partially-applied', 'conflicted'].includes(run.status)) {
    throw new DoxloopError(`Sync run ${id} cannot be applied from status ${run.status}.`)
  }
  const requested = new Map<string, Set<string>>()
  for (const selection of selections) {
    const change = run.changes.find((candidate) => candidate.id === selection.changeId)
    if (!change) throw new DoxloopError(`Unknown change ${selection.changeId}.`)
    const ids = new Set(
      selection.hunkIds && selection.hunkIds.length > 0
        ? selection.hunkIds
        : change.hunks.filter((hunk) => !hunk.acceptedAt && !hunk.rejectedAt).map((hunk) => hunk.id),
    )
    for (const hunkId of ids) {
      if (!change.hunks.some((hunk) => hunk.id === hunkId)) {
        throw new DoxloopError(`Unknown change hunk ${hunkId}.`)
      }
    }
    requested.set(change.id, ids)
  }
  if (requested.size === 0) throw new DoxloopError('Select at least one documentation change.')

  const originals = new Map<string, Buffer | undefined>()
  const now = new Date().toISOString()
  let nextChanges = run.changes.map((change) => ({
    ...change,
    hunks: change.hunks.map((hunk) => ({ ...hunk })),
  }))

  try {
    for (const change of nextChanges) {
      const ids = requested.get(change.id)
      if (!ids || ids.size === 0) continue
      const actualPath = safeRunPath(root, change.path)
      const before = await proposalBefore(root, run.id, change.path)
      const current = (await pathExists(actualPath)) ? await readFile(actualPath) : undefined
      const expected = await materializeChange(
        before,
        change,
        acceptedIds(change),
        runWorkspace(root, run.id),
      )
      const accepted = new Set([...acceptedIds(change), ...ids])
      let result = await materializeChange(
        before,
        change,
        accepted,
        runWorkspace(root, run.id),
      )
      if (!buffersEqual(current, expected)) {
        const merged = change.path === '.doxloop/evidence-map.json' && expected && current && result
          ? mergeConcurrentJson(expected, current, result)
          : undefined
        if (!merged) {
          throw new DoxloopError(
            `${change.path} changed after this proposal was generated. Regenerate or review the conflict; no file was overwritten.`,
          )
        }
        result = merged
      }
      originals.set(change.path, current)
      await writeAtomic(actualPath, result)
      change.hunks = change.hunks.map((hunk) =>
        ids.has(hunk.id) && !hunk.rejectedAt ? { ...hunk, acceptedAt: now } : hunk,
      )
    }

    const validation = await validateProject(root)
    if (validation.errors > 0) {
      throw new DoxloopError(
        `The selected changes were not applied because they would leave invalid documentation:\n${formatValidation(validation)}`,
      )
    }
    const complete = nextChanges.every((change) =>
      change.hunks.every((hunk) => hunk.acceptedAt !== undefined),
    )
    if (complete) await applyStagedSyncState(root, id)
    const { error: _previousError, ...cleanRun } = run
    const next: SyncRun = {
      ...cleanRun,
      status: complete ? 'applied' : 'partially-applied',
      ...(complete ? { appliedAt: now } : {}),
      changes: nextChanges,
      validation: {
        pages: validation.pages.length,
        errors: validation.errors,
        warnings: validation.warnings,
      },
    }
    await writeRun(root, next)
    await recordSyncRun(root, next)
    // Accepted hunks are now real files. Refresh the registry so page history
    // and the external-edit check both start from what is actually on disk.
    await syncPageRegistry(root, undefined, next.id)
    if (complete) {
      await recordSourceSyncs(root, await readOptionalSyncState(root), next.id)
    }
    return next
  } catch (error) {
    for (const [path, content] of originals) await writeAtomic(safeRunPath(root, path), content)
    const conflicted: SyncRun = {
      ...run,
      status: error instanceof DoxloopError && error.message.includes('changed after')
        ? 'conflicted'
        : run.status,
      error: error instanceof Error ? error.message : String(error),
    }
    await writeRun(root, conflicted)
    await recordSyncRun(root, conflicted)
    throw error
  }
}

async function readOptionalSyncState(root: string): Promise<SyncState | undefined> {
  const path = join(root, '.doxloop', 'sync-state.json')
  if (!(await pathExists(path))) return undefined
  try {
    return await readJson<SyncState>(path)
  } catch {
    return undefined
  }
}

const JSON_MISSING = Symbol('json-missing')

function mergeConcurrentJson(base: Buffer, current: Buffer, proposed: Buffer): Buffer | undefined {
  try {
    const merged = mergeJsonValue(
      JSON.parse(base.toString('utf8')) as unknown,
      JSON.parse(current.toString('utf8')) as unknown,
      JSON.parse(proposed.toString('utf8')) as unknown,
    )
    if (merged === JSON_MISSING) return undefined
    return Buffer.from(`${JSON.stringify(merged, null, 2)}\n`)
  } catch {
    return undefined
  }
}

function mergeJsonValue(
  base: unknown | typeof JSON_MISSING,
  current: unknown | typeof JSON_MISSING,
  proposed: unknown | typeof JSON_MISSING,
): unknown | typeof JSON_MISSING {
  if (isDeepStrictEqual(current, base)) return proposed
  if (isDeepStrictEqual(proposed, base) || isDeepStrictEqual(current, proposed)) return current
  if (isJsonRecord(base) && isJsonRecord(current) && isJsonRecord(proposed)) {
    const result: Record<string, unknown> = {}
    const keys = new Set([...Object.keys(base), ...Object.keys(current), ...Object.keys(proposed)])
    for (const key of keys) {
      const merged = mergeJsonValue(
        Object.hasOwn(base, key) ? base[key] : JSON_MISSING,
        Object.hasOwn(current, key) ? current[key] : JSON_MISSING,
        Object.hasOwn(proposed, key) ? proposed[key] : JSON_MISSING,
      )
      if (merged !== JSON_MISSING) result[key] = merged
    }
    return result
  }
  // Both sides changed the same scalar or array. Preserve the newer accepted value.
  return current
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function formatSyncRunHistory(runs: SyncRun[]): string {
  if (runs.length === 0) return 'No documentation sync runs yet.'
  const lines = ['Documentation sync runs', '']
  for (const run of runs) {
    const counts = changeCounts(run.changes)
    lines.push(
      `  ${statusMark(run.status)} ${run.id}  ${run.status.padEnd(18)} ${counts}  ${run.createdAt}`,
      `      ${run.summary}`,
    )
  }
  lines.push('', 'Review visually with: doxloop sync review --open')
  return lines.join('\n')
}

export function pendingRunCount(runs: SyncRun[]): number {
  return runs.filter((run) =>
    ['awaiting-review', 'partially-applied', 'conflicted'].includes(run.status),
  ).length
}

export function runWorkspace(root: string, id: string): string {
  assertRunId(id)
  return join(runDirectory(root, id), WORKSPACE)
}

export function runBeforeRoot(root: string, id: string): string {
  assertRunId(id)
  return join(runDirectory(root, id), BEFORE)
}

async function createWorkspace(
  root: string,
  runRoot: string,
  project: DoxloopProject,
  authoringSources?: DoxloopProject['sources'],
): Promise<string> {
  const temporary = await mkdtemp(join(tmpdir(), 'doxloop-sync-review-'))
  const staged = join(temporary, WORKSPACE)
  try {
    await cp(root, staged, {
      recursive: true,
      preserveTimestamps: true,
      filter: (source) => {
        const rel = portable(relative(root, source))
        return rel === '' || !isExcluded(rel)
      },
    })
    await rewriteWorkspaceSources(staged, root, {
      ...project,
      sources: authoringSources ?? project.sources,
    })
    await initializeWorkspaceGit(staged)
    const target = join(runRoot, WORKSPACE)
    await rename(staged, target)
    return target
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

async function initializeWorkspaceGit(workspace: string): Promise<void> {
  await runCommand('git', ['init', '--initial-branch=doxloop-review'], { cwd: workspace })
  await runCommand('git', ['add', '.'], { cwd: workspace })
  await runCommand(
    'git',
    [
      '-c',
      'user.name=Doxloop Review',
      '-c',
      'user.email=review@doxloop.local',
      'commit',
      '-m',
      'Doxloop proposal baseline',
    ],
    { cwd: workspace },
  )
}

async function rewriteWorkspaceSources(
  workspace: string,
  root: string,
  project: DoxloopProject,
): Promise<void> {
  const path = join(workspace, '.doxloop', 'project.json')
  const staged = JSON.parse(await readFile(path, 'utf8')) as DoxloopProject
  staged.sources = project.sources.map((source) => ({
    ...source,
    path: isAbsolute(source.path) ? source.path : resolve(root, source.path),
  }))
  await writeFile(path, `${JSON.stringify(staged, null, 2)}\n`, 'utf8')
}

async function restoreWorkspaceSources(
  workspace: string,
  project: DoxloopProject,
  originalText: string,
): Promise<void> {
  const path = join(workspace, '.doxloop', 'project.json')
  const staged = JSON.parse(await readFile(path, 'utf8')) as DoxloopProject
  staged.sources = project.sources
  const original = JSON.parse(originalText) as DoxloopProject
  await writeFile(
    path,
    JSON.stringify(staged) === JSON.stringify(original)
      ? originalText
      : `${JSON.stringify(staged, null, 2)}\n`,
    'utf8',
  )
}

async function collectProposalChanges(
  root: string,
  workspace: string,
  runRoot: string,
  project: DoxloopProject,
): Promise<SyncFileChange[]> {
  const [beforeFiles, afterFiles] = await Promise.all([
    collectFiles(root),
    collectFiles(workspace),
  ])
  const paths = [...new Set([...beforeFiles.keys(), ...afterFiles.keys()])].sort()
  const pageExtensions = await documentationPageExtensions(root, project)
  const changes: SyncFileChange[] = []
  for (const path of paths) {
    if (INTERNAL_DIFF_PATHS.has(path)) continue
    const before = beforeFiles.get(path)
    const after = afterFiles.get(path)
    if (buffersEqual(before, after)) continue
    if (before) {
      const target = join(runRoot, BEFORE, path)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, before)
    }
    const binary = isBinary(path, before, after)
    const kind = before === undefined ? 'added' : after === undefined ? 'deleted' : 'modified'
    const changeId = `change-${changes.length + 1}`
    const hunks = binary
      ? [{ id: `${changeId}-file`, oldStart: 0, oldLines: [], newStart: 0, newLines: [] }]
      : lineHunks(before?.toString('utf8') ?? '', after?.toString('utf8') ?? '', changeId)
    changes.push({
      id: changeId,
      path,
      title: await changeTitle(
        path,
        before ? join(root, path) : join(workspace, path),
        project,
        pageExtensions,
      ),
      kind,
      category: changeCategory(path, project, pageExtensions),
      binary,
      ...(before ? { beforeHash: hash(before) } : {}),
      ...(after ? { afterHash: hash(after) } : {}),
      ...(!binary && before ? { beforeEndsWithNewline: before.toString('utf8').endsWith('\n') } : {}),
      ...(!binary && after ? { afterEndsWithNewline: after.toString('utf8').endsWith('\n') } : {}),
      hunks,
    })
  }
  return changes
}

async function collectFiles(root: string): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>()
  await walkFiles(root, root, files)
  return files
}

async function walkFiles(root: string, directory: string, files: Map<string, Buffer>): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true })
  for (const entry of entries) {
    const absolute = resolve(directory, entry.name)
    const path = portable(relative(root, absolute))
    if (isExcluded(path)) continue
    if (entry.isDirectory()) await walkFiles(root, absolute, files)
    else if (entry.isFile()) files.set(path, await readFile(absolute))
  }
}

function isExcluded(path: string): boolean {
  return (
    path.startsWith('.agents/skills/doxloop-') ||
    path.startsWith('.claude/skills/doxloop-') ||
    EXCLUDED_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))
  )
}

async function materializeChange(
  before: Buffer | undefined,
  change: SyncFileChange,
  accepted: Set<string>,
  workspace: string,
): Promise<Buffer | undefined> {
  if (change.binary) {
    if (!accepted.has(change.hunks[0]!.id)) return before
    if (change.kind === 'deleted') return undefined
    return readFile(join(workspace, change.path))
  }
  if (accepted.size === 0) return before
  const beforeText = before?.toString('utf8') ?? ''
  const lines = textLines(beforeText)
  const output: string[] = []
  let cursor = 0
  for (const hunk of change.hunks) {
    output.push(...lines.slice(cursor, hunk.oldStart))
    output.push(...(accepted.has(hunk.id) ? hunk.newLines : hunk.oldLines))
    cursor = hunk.oldStart + hunk.oldLines.length
  }
  output.push(...lines.slice(cursor))
  if (change.kind === 'deleted' && change.hunks.every((hunk) => accepted.has(hunk.id))) {
    return undefined
  }
  const allAccepted = change.hunks.every((hunk) => accepted.has(hunk.id))
  const trailing = allAccepted
    ? (change.afterEndsWithNewline ?? false)
    : (change.beforeEndsWithNewline ?? false)
  const text = `${output.join('\n')}${trailing && output.length > 0 ? '\n' : ''}`
  return Buffer.from(text)
}

async function proposalBefore(root: string, id: string, path: string): Promise<Buffer | undefined> {
  const before = join(runBeforeRoot(root, id), path)
  return (await pathExists(before)) ? readFile(before) : undefined
}

async function applyStagedSyncState(root: string, id: string): Promise<void> {
  const source = join(runWorkspace(root, id), '.doxloop', 'sync-state.json')
  if (!(await pathExists(source))) return
  await writeAtomic(join(root, '.doxloop', 'sync-state.json'), await readFile(source))
}

async function writeAtomic(path: string, content: Buffer | undefined): Promise<void> {
  if (content === undefined) {
    await unlink(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
    })
    return
  }
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.doxloop-${process.pid}-${randomBytes(4).toString('hex')}`
  await writeFile(temporary, content)
  await rename(temporary, path)
}

async function writeRun(root: string, run: SyncRun): Promise<void> {
  const path = join(runDirectory(root, run.id), RUN_FILE)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(run, null, 2)}\n`, 'utf8')
}

async function ensureRunsIgnored(root: string): Promise<void> {
  const path = join(root, '.gitignore')
  const line = '.doxloop/runs/'
  const existing = (await pathExists(path)) ? await readFile(path, 'utf8') : ''
  if (existing.split(/\r?\n/).includes(line)) return
  await writeFile(path, `${existing}${existing && !existing.endsWith('\n') ? '\n' : ''}${line}\n`, 'utf8')
}

function runDirectory(root: string, id: string): string {
  assertRunId(id)
  return join(root, SYNC_RUNS_DIRECTORY, id)
}

function safeRunPath(root: string, path: string): string {
  if (path === '' || isAbsolute(path) || path.split(/[\\/]/).includes('..')) {
    throw new DoxloopError(`Unsafe proposal path: ${path}`)
  }
  return assertInside(root, resolve(root, path))
}

function assertRunId(id: string): void {
  if (!/^[a-z0-9-]+$/.test(id)) throw new DoxloopError(`Invalid sync run id: ${id}`)
}

function runId(): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
  return `run-${stamp.toLowerCase()}-${randomBytes(3).toString('hex')}`
}

function hash(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex')
}

function buffersEqual(left: Buffer | undefined, right: Buffer | undefined): boolean {
  if (left === undefined || right === undefined) return left === right
  return left.equals(right)
}


function isBinary(path: string, before: Buffer | undefined, after: Buffer | undefined): boolean {
  if (BINARY_EXTENSIONS.has(extname(path).toLowerCase())) return true
  return [before, after].some((content) => content?.subarray(0, 8_192).includes(0))
}

function acceptedIds(change: SyncFileChange): Set<string> {
  return new Set(change.hunks.filter((hunk) => hunk.acceptedAt).map((hunk) => hunk.id))
}

const NAVIGATION_PATTERN = /nav|sidebar|menu|site\.json|docs\.json|mkdocs\.yml|docusaurus\.config/i

function changeCategory(
  path: string,
  project: DoxloopProject,
  pageExtensions: ReadonlySet<string>,
): SyncChangeCategory {
  if (path === '.doxloop/evidence-map.json') return 'evidence'
  const extension = extname(path).toLowerCase()
  const content = `${portable(project.contentDir).replace(/\/+$/, '')}/`
  if (path.startsWith(content)) {
    if (pageExtensions.has(extension)) return 'page'
    if (BINARY_EXTENSIONS.has(extension)) return 'asset'
    // Data files inside the content directory — a Doxbrix `docs.json`, an
    // MkDocs navigation file — configure the site rather than being read as
    // pages, so they must not enter the page review flow.
    return NAVIGATION_PATTERN.test(path) ? 'navigation' : 'configuration'
  }
  if (NAVIGATION_PATTERN.test(path)) return 'navigation'
  return BINARY_EXTENSIONS.has(extension) ? 'asset' : 'configuration'
}

async function changeTitle(
  path: string,
  sourcePath: string,
  project: DoxloopProject,
  pageExtensions: ReadonlySet<string>,
): Promise<string> {
  if (changeCategory(path, project, pageExtensions) === 'page') {
    try {
      const page = await readPage(sourcePath)
      if (page.title) return page.title
    } catch {
      // Deleted or non-Markdown generator pages use their file name.
    }
  }
  return path.split('/').at(-1) ?? path
}

function sourceSummary(changes: SourceChange[]): string {
  const files = changes.flatMap((change) => [
    ...('changedFiles' in change ? change.changedFiles : []),
    ...('uncommittedFiles' in change ? change.uncommittedFiles : []),
  ])
  return files.length > 0
    ? `${files.length} changed source file${files.length === 1 ? '' : 's'}: ${files.slice(0, 12).join(', ')}${files.length > 12 ? ', …' : ''}`
    : `${changes.length} configured source${changes.length === 1 ? '' : 's'} inspected`
}

function proposalSummary(changes: SyncFileChange[]): string {
  const added = changes.filter((change) => change.kind === 'added').length
  const modified = changes.filter((change) => change.kind === 'modified').length
  const deleted = changes.filter((change) => change.kind === 'deleted').length
  return `${changes.length} proposed file change${changes.length === 1 ? '' : 's'} · ${added} added · ${modified} modified · ${deleted} deleted`
}

function changeCounts(changes: SyncFileChange[]): string {
  const accepted = changes.reduce(
    (count, change) => count + change.hunks.filter((hunk) => hunk.acceptedAt).length,
    0,
  )
  const total = changes.reduce((count, change) => count + change.hunks.length, 0)
  return `${changes.length} files · ${accepted}/${total} changes accepted`
}

function statusMark(status: SyncRun['status']): string {
  if (status === 'applied') return '✓'
  if (status === 'failed' || status === 'conflicted') return '✗'
  if (status === 'rejected') return '–'
  return '●'
}

function portable(path: string): string {
  return sep === '/' ? path : path.split(sep).join('/')
}
