import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { DoxloopError } from './errors.js'
import { assertInside, pathExists } from './fs.js'
import { finishRequest, startRequest } from './history.js'
import type { RequestKind, ValidationIssue, ValidationResult } from './types.js'
import { validateProject } from './validation.js'
import { withProjectLock } from './project-lock.js'

/**
 * A change the control center writes straight into the project without an
 * agent: a navigation reorder, a theme colour, an uploaded image, a page's
 * metadata, or a generated glossary. Every such write goes through the same
 * contract the proposal editor uses: snapshot the files it may touch, apply,
 * revalidate, and roll back when the write would introduce a validation error
 * the project did not already have. The outcome lands in update history so
 * drift detection and the history feed stay honest.
 */
export interface DirectEditInput {
  kind: RequestKind
  requestText: string
  /** Project-relative files the edit may create, rewrite, or delete. */
  files: string[]
  apply: () => Promise<void>
  /** Pages the edit changed, recorded on the history row. */
  pagesChanged?: number
}

export interface DirectEditResult {
  validation: ValidationResult
  requestId?: string
  editId: string
}

export async function applyDirectEdit(root: string, input: DirectEditInput): Promise<DirectEditResult> {
  return withProjectLock(root, 'write', () => applyLocked(root, input))
}

interface EditRecord {
  id: string
  kind: RequestKind
  requestText: string
  createdAt: string
  status: 'writing' | 'completed' | 'rolled-back' | 'recovery-required' | 'undone'
  before: Record<string, string | null>
  after?: Record<string, string | null>
  baseline?: ValidationResult
}

async function applyLocked(root: string, input: DirectEditInput, restoredBaseline?: ValidationResult): Promise<DirectEditResult> {
  const snapshot = new Map<string, Buffer | undefined>()
  for (const file of new Set(input.files)) {
    const absolute = await safePath(root, file)
    snapshot.set(file, (await pathExists(absolute)) ? await readFile(absolute) : undefined)
  }
  const baseline = await safeValidate(root)
  const requestId = await startRequest(root, { kind: input.kind, requestText: input.requestText })
  const record: EditRecord = { id: randomUUID(), kind: input.kind, requestText: input.requestText, createdAt: new Date().toISOString(), status: 'writing', before: encode(snapshot), ...(baseline ? { baseline } : {}) }
  await saveRecord(root, record)
  try {
    await input.apply()
    const validation = await validateProject(root)
    const introduced = baseline
      ? newErrors(restoredBaseline ? { ...baseline, issues: [...baseline.issues, ...restoredBaseline.issues] } : baseline, validation)
      : validation.issues.filter((issue) => issue.severity === 'error')
    if (introduced.length > 0) {
      throw new DoxloopError(
        `The change was not saved because it would break validation: ${introduced.map(describeIssue).join('; ')}`,
        2,
      )
    }
    await finishRequest(root, requestId, {
      status: 'completed',
      validation: { pages: validation.pages.length, errors: validation.errors, warnings: validation.warnings },
      ...(input.pagesChanged !== undefined ? { pagesChanged: input.pagesChanged } : {}),
    })
    record.after = await capture(root, input.files)
    record.status = 'completed'
    await saveRecord(root, record)
    return { validation, editId: record.id, ...(requestId ? { requestId } : {}) }
  } catch (error) {
    // A callback may write several files before failing. Always attempt every restoration.
    try { await restore(root, snapshot); record.status = 'rolled-back' }
    catch (rollbackError) {
      record.status = 'recovery-required'
      await saveRecord(root, record)
      throw new AggregateError([error, rollbackError], `The write failed and rollback needs recovery. Original files are preserved in .doxloop/direct-edits/${record.id}.json.`)
    }
    await saveRecord(root, record)
    await finishRequest(root, requestId, {
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
    })
    throw error
  }
}

async function safeValidate(root: string): Promise<ValidationResult | undefined> {
  try {
    return await validateProject(root)
  } catch {
    // A project that cannot be validated yet gets the strict rule: no errors after the write.
    return undefined
  }
}

function newErrors(before: ValidationResult, after: ValidationResult): ValidationIssue[] {
  const known = new Set(before.issues.filter((issue) => issue.severity === 'error').map(issueKey))
  return after.issues.filter((issue) => issue.severity === 'error' && !known.has(issueKey(issue)))
}

function issueKey(issue: ValidationIssue): string {
  return `${issue.code} ${issue.file ?? ''} ${issue.message}`
}

function describeIssue(issue: ValidationIssue): string {
  return issue.file ? `${issue.file}: ${issue.message}` : issue.message
}

async function restore(root: string, snapshot: Map<string, Buffer | undefined>): Promise<void> {
  const results = await Promise.allSettled([...snapshot].map(async ([file, content]) => {
    const absolute = await safePath(root, file)
    if (content === undefined) {
      await rm(absolute, { force: true })
      return
    }
    await mkdir(dirname(absolute), { recursive: true })
    await atomicWrite(absolute, content)
  }))
  const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
  if (failures.length) throw new AggregateError(failures.map((result) => result.reason), 'Some files could not be restored')
}

export async function listDirectEdits(root: string): Promise<Array<Pick<EditRecord, 'id' | 'createdAt' | 'requestText' | 'status'>>> {
  const directory = join(root, '.doxloop', 'direct-edits')
  const files = await readdir(directory).catch(() => [])
  const records = await Promise.all(files.filter((file) => file.endsWith('.json')).map(async (file) => JSON.parse(await readFile(join(directory, file), 'utf8')) as EditRecord))
  return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(({ id, createdAt, requestText, status }) => ({ id, createdAt, requestText, status }))
}

export async function undoDirectEdit(root: string, id: string): Promise<DirectEditResult> {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new DoxloopError('Invalid edit id.')
  return withProjectLock(root, 'write', async () => {
    const record = JSON.parse(await readFile(join(root, '.doxloop', 'direct-edits', `${id}.json`), 'utf8')) as EditRecord
    if (record.status !== 'completed' || !record.after) throw new DoxloopError('This edit is not available to undo.')
    const current = await capture(root, Object.keys(record.before))
    for (const file of Object.keys(record.before)) if (current[file] !== record.after[file]) throw new DoxloopError(`${file} changed since this edit. Undo stopped without overwriting your work.`)
    const result = await applyLocked(root, { kind: record.kind, requestText: `Undo: ${record.requestText}`, files: Object.keys(record.before), apply: () => restore(root, decode(record.before)) }, record.baseline)
    record.status = 'undone'
    await saveRecord(root, record)
    return result
  })
}

function encode(snapshot: Map<string, Buffer | undefined>): Record<string, string | null> { return Object.fromEntries([...snapshot].map(([file, bytes]) => [file, bytes?.toString('base64') ?? null])) }
function decode(snapshot: Record<string, string | null>): Map<string, Buffer | undefined> { return new Map(Object.entries(snapshot).map(([file, bytes]) => [file, bytes === null ? undefined : Buffer.from(bytes, 'base64')])) }
async function capture(root: string, files: string[]): Promise<Record<string, string | null>> {
  return Object.fromEntries(await Promise.all([...new Set(files)].map(async (file) => {
    const absolute = await safePath(root, file)
    return [file, await pathExists(absolute) ? (await readFile(absolute)).toString('base64') : null]
  })))
}
async function saveRecord(root: string, record: EditRecord): Promise<void> {
  const directory = join(root, '.doxloop', 'direct-edits')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  // Existing projects may predate the root ignore entries; snapshots stay local there too.
  await writeFile(join(directory, '.gitignore'), '*\n', { flag: 'wx', mode: 0o600 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error })
  await atomicWrite(join(directory, `${record.id}.json`), Buffer.from(`${JSON.stringify(record)}\n`))
}
async function atomicWrite(path: string, bytes: Buffer): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`
  try { await writeFile(temporary, bytes, { mode: 0o600 }); await rename(temporary, path) }
  finally { await rm(temporary, { force: true }) }
}
export async function safePath(root: string, file: string): Promise<string> {
  root = resolve(root)
  if (isAbsolute(file)) throw new DoxloopError('Editable paths must be project-relative.')
  const absolute = assertInside(root, join(root, file))
  if (!file || file.split(/[\\/]/).some((part) => part === '..') || absolute === root) throw new DoxloopError('Invalid editable path.')
  let current = absolute
  while (current !== root && current !== dirname(current)) {
    const info = await lstat(current).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error })
    if (info?.isSymbolicLink()) throw new DoxloopError(`Editing symbolic links is not supported: ${file}`)
    current = dirname(current)
  }
  return absolute
}
