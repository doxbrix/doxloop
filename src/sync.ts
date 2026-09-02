import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, readFile, readlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { pathExists, readJson } from './fs.js'
import { diffOpenApi, loadOpenApiSource, openApiChangedIdentifiers } from './openapi.js'
import { isSpecUrl, sourceKind } from './project.js'
import { remoteHead } from './remote-source.js'
import type { SourceBinding, SourceChange, SyncState } from './types.js'

const SPEC_BASELINE = 'openapi-spec'

export const SYNC_STATE_FILE = join('.doxloop', 'sync-state.json')

const MAX_LISTED_FILES = 40

const run = promisify(execFile)

export async function readSyncState(root: string): Promise<SyncState> {
  const path = join(root, SYNC_STATE_FILE)
  if (!(await pathExists(path))) return { schemaVersion: 1, sources: {} }
  const state = await readJson<Partial<SyncState>>(path)
  if (state.schemaVersion !== 1 || !isSourceRecords(state.sources)) {
    return { schemaVersion: 1, sources: {} }
  }
  return { schemaVersion: 1, sources: state.sources }
}

export async function recordSyncState(
  root: string,
  sources: SourceBinding[],
): Promise<SyncState> {
  const state: SyncState = { schemaVersion: 1, sources: {} }
  for (const source of sources) {
    if (sourceKind(source) === 'openapi') {
      const loaded = await loadOpenApiSource(root, source)
      state.sources[source.name] = {
        commit: SPEC_BASELINE,
        recordedAt: new Date().toISOString(),
        contentFingerprint: loaded.hash,
        connector: {
          id: 'openapi',
          version: 1,
          ...(loaded.etag ? { etag: loaded.etag } : {}),
          ...(loaded.lastModified ? { lastModified: loaded.lastModified } : {}),
          openapi: loaded.snapshot,
        },
      }
      continue
    }
    if (source.remote) {
      state.sources[source.name] = {
        commit: await remoteHead(source.remote),
        recordedAt: new Date().toISOString(),
      }
      continue
    }
    const commit = await headCommit(resolve(root, source.path))
    if (commit) {
      const sourcePath = resolve(root, source.path)
      state.sources[source.name] = {
        commit,
        recordedAt: new Date().toISOString(),
        contentFingerprint: await sourceContentFingerprint(sourcePath),
      }
    }
  }
  await writeFile(
    join(root, SYNC_STATE_FILE),
    `${JSON.stringify(state, null, 2)}\n`,
    'utf8',
  )
  return state
}

export async function collectSourceChanges(
  root: string,
  sources: SourceBinding[],
): Promise<SourceChange[]> {
  const state = await readSyncState(root)
  const changes: SourceChange[] = []
  for (const source of sources) {
    if (sourceKind(source) === 'openapi') {
      changes.push(await collectSpecChange(root, source, state))
      continue
    }
    const path = resolve(root, source.path)
    if (!(await pathExists(path))) {
      changes.push({ ...source, kind: 'missing-path' })
      continue
    }
    const head = await headCommit(path)
    if (!head) {
      changes.push({ ...source, kind: 'not-git' })
      continue
    }
    const uncommittedFiles = await uncommittedChanges(path)
    const contentFingerprint = await sourceContentFingerprint(path)
    const record = state.sources[source.name]
    if (!record) {
      changes.push({ ...source, kind: 'no-baseline', head, uncommittedFiles })
      continue
    }
    if (!(await commitExists(path, record.commit))) {
      changes.push({ ...source, kind: 'baseline-lost', head, uncommittedFiles })
      continue
    }
    const matchesRecordedContent =
      record.contentFingerprint !== undefined &&
      record.contentFingerprint === contentFingerprint
    const changedFiles = matchesRecordedContent
      ? []
      : await committedChanges(path, record.commit)
    changes.push({
      ...source,
      kind:
        matchesRecordedContent || (changedFiles.length === 0 && uncommittedFiles.length === 0)
          ? 'unchanged'
          : 'changed',
      baseline: record.commit,
      head,
      changedFiles,
      uncommittedFiles: matchesRecordedContent ? [] : uncommittedFiles,
    })
  }
  return changes
}

/** Stable content fingerprints used to invalidate an approved planning checkpoint. */
export async function sourceSnapshotFingerprints(
  root: string,
  sources: SourceBinding[],
): Promise<Record<string, string | null>> {
  const fingerprints: Record<string, string | null> = {}
  for (const source of sources) {
    if (sourceKind(source) === 'openapi') {
      try { fingerprints[source.name] = (await loadOpenApiSource(root, source)).hash }
      catch { fingerprints[source.name] = null }
      continue
    }
    try {
      fingerprints[source.name] = await sourceContentFingerprint(resolve(root, source.path))
    } catch {
      fingerprints[source.name] = null
    }
  }
  return fingerprints
}

async function collectSpecChange(
  root: string,
  source: SourceBinding,
  state: SyncState,
): Promise<SourceChange> {
  const record = state.sources[source.name]
  let loaded
  try {
    loaded = await loadOpenApiSource(root, source, record?.connector ? {
      ...(record.connector.etag ? { etag: record.connector.etag } : {}),
      ...(record.connector.lastModified ? { lastModified: record.connector.lastModified } : {}),
    } : undefined)
  } catch (error) {
    if (!isSpecUrl(source.path) && !(await pathExists(resolve(root, source.path)))) {
      return { ...source, kind: 'missing-path' }
    }
    throw error
  }
  if (record?.contentFingerprint === loaded.hash || loaded.notModified) {
    return { ...source, kind: 'spec-unchanged', head: loaded.hash, summary: loaded.summary }
  }
  const apiDiff = diffOpenApi(record?.connector?.openapi, loaded.snapshot)
  return {
    ...source,
    kind: 'spec-changed',
    ...(record?.contentFingerprint ? { baseline: record.contentFingerprint } : {}),
    head: loaded.hash,
    summary: loaded.summary,
    apiDiff,
    changedIdentifiers: openApiChangedIdentifiers(apiDiff),
  }
}

/**
 * Source-relative paths touched by a change, parsed from the same Git output
 * that produced the human-readable lists. Rename and copy entries contribute
 * both the old and the new path so either one can match documented evidence.
 */
export function changedSourcePaths(change: SourceChange): string[] {
  if (change.kind === 'spec-changed') return change.changedIdentifiers
  if (change.kind !== 'changed' && change.kind !== 'no-baseline' && change.kind !== 'baseline-lost') {
    return []
  }
  const paths = new Set<string>()
  if (change.kind === 'changed') {
    for (const line of change.changedFiles) {
      for (const path of parseNameStatus(line)) paths.add(path)
    }
  }
  for (const line of change.uncommittedFiles) {
    for (const path of parsePorcelain(line)) paths.add(path)
  }
  return [...paths]
}

/** `M<tab>src/auth.ts` or `R100<tab>old.ts<tab>new.ts` */
function parseNameStatus(line: string): string[] {
  const fields = line.split('\t')
  return fields.slice(1).map(unquotePath).filter(Boolean)
}

/** `M src/auth.ts`, `?? new.ts`, or `R  old.ts -> new.ts`, already trimmed. */
function parsePorcelain(line: string): string[] {
  const match = /^\S+\s+(.*)$/.exec(line)
  if (!match?.[1]) return []
  return match[1]
    .split(' -> ')
    .map((part) => unquotePath(part))
    .filter(Boolean)
}

function unquotePath(value: string): string {
  const path = value.trim()
  if (!path.startsWith('"') || !path.endsWith('"')) return path
  try {
    return String(JSON.parse(path))
  } catch {
    return path.slice(1, -1)
  }
}

export function formatSourceChanges(changes: SourceChange[]): string {
  if (changes.length === 0) return ''
  const sections = changes.map((change) => {
    const heading = `Source "${change.name}" (${change.path})`
    switch (change.kind) {
      case 'missing-path':
        return `${heading}: the configured path does not exist. Report this instead of guessing.`
      case 'spec-remote':
        return `${heading}: remote API specification. Fetch the current document and compare it with the documented API surface before updating.`
      case 'spec-unchanged':
        return `${heading}: the API specification is unchanged since the last documentation sync.`
      case 'spec-changed':
        return `${heading}: the API specification changed${change.baseline ? ` (${short(change.baseline)} -> ${short(change.head)})` : ' and has no recorded baseline'}.
${formatApiDelta(change.apiDiff)}
Update only documentation affected by this structural delta; the new baseline is recorded after acceptance.`
      case 'not-git':
        return `${heading}: not a Git repository, so no change baseline is available. Inspect the source directly.`
      case 'no-baseline':
        return withUncommitted(
          `${heading}: no documentation sync baseline is recorded yet. Inspect the source directly; a baseline is recorded when this task completes.`,
          change.uncommittedFiles,
        )
      case 'baseline-lost':
        return withUncommitted(
          `${heading}: the recorded baseline commit no longer exists (history rewritten?). Inspect the source directly; the baseline is re-recorded when this task completes.`,
          change.uncommittedFiles,
        )
      case 'unchanged':
        return withUncommitted(
          `${heading}: no source-content changes since the last documentation sync (${short(change.baseline)}).`,
          change.uncommittedFiles,
        )
      case 'changed':
        if (change.remote) {
          return change.changedFiles.length > 0
            ? `${heading}: the remote repository changed (${short(change.baseline)} -> ${short(change.head)}).\nChanged files reported by ${change.remote.provider}:\n${fileList(change.changedFiles)}\nThe current commit was downloaded into this isolated read-only evidence snapshot; inspect files there directly.`
            : `${heading}: the remote repository changed (${short(change.baseline)} -> ${short(change.head)}). Inspect the isolated evidence snapshot directly.`
        }
        return withUncommitted(
          change.changedFiles.length > 0
            ? `${heading}: changed since the last documentation sync (${short(change.baseline)} -> ${short(change.head)}).\nCommitted changes:\n${fileList(change.changedFiles)}\nInspect details with \`git -C ${change.path} diff ${short(change.baseline)}..HEAD -- <file>\`.`
            : `${heading}: the working tree changed since the last documentation sync (${short(change.baseline)}).`,
          change.uncommittedFiles,
        )
    }
  })
  return `Source changes since the last documentation sync:\n\n${sections.join('\n\n')}`
}

function formatApiDelta(diff: import('./types.js').ApiStructuralDiff): string {
  const lines: string[] = ['Structural API delta:']
  for (const item of diff.operations.added) lines.push(`- operation added: ${item}`)
  for (const item of diff.operations.removed) lines.push(`- operation removed: ${item}`)
  for (const item of diff.operations.changed) lines.push(`- operation changed: ${item.id} (${item.facets.join(', ')})`)
  for (const item of diff.schemas.added) lines.push(`- schema added: ${item}`)
  for (const item of diff.schemas.removed) lines.push(`- schema removed: ${item}`)
  for (const item of diff.schemas.changed) lines.push(`- schema changed: ${item.id}`)
  for (const item of diff.securitySchemes.added) lines.push(`- authentication added: ${item}`)
  for (const item of diff.securitySchemes.removed) lines.push(`- authentication removed: ${item}`)
  for (const item of diff.securitySchemes.changed) lines.push(`- authentication changed: ${item.id}`)
  return lines.length === 1 ? `${lines[0]} no public structural changes detected.` : lines.join('\n')
}

function withUncommitted(text: string, uncommittedFiles: string[]): string {
  if (uncommittedFiles.length === 0) return text
  return `${text}\nUncommitted working-tree changes:\n${fileList(uncommittedFiles)}`
}

function fileList(files: string[]): string {
  const listed = files.slice(0, MAX_LISTED_FILES).map((file) => `- ${file}`)
  if (files.length > MAX_LISTED_FILES) {
    listed.push(`- ...and ${files.length - MAX_LISTED_FILES} more files`)
  }
  return listed.join('\n')
}

function short(commit: string): string {
  return commit.slice(0, 12)
}

async function headCommit(path: string): Promise<string | undefined> {
  const output = await git(path, ['rev-parse', 'HEAD'])
  return output?.trim() || undefined
}

async function commitExists(path: string, commit: string): Promise<boolean> {
  return (await git(path, ['cat-file', '-e', `${commit}^{commit}`])) !== undefined
}

async function committedChanges(path: string, baseline: string): Promise<string[]> {
  const output = await git(path, [
    'diff',
    '--name-status',
    `${baseline}..HEAD`,
    '--',
    '.',
  ])
  return lines(output)
}

async function uncommittedChanges(path: string): Promise<string[]> {
  const output = await git(path, ['status', '--porcelain', '--', '.'])
  return lines(output).map((line) => line.trim())
}

async function sourceContentFingerprint(path: string): Promise<string> {
  const output = await git(path, [
    'ls-files',
    '-co',
    '--exclude-standard',
    '-z',
  ])
  const files = (output ?? '').split('\0').filter(Boolean).sort()
  const hash = createHash('sha256')
  for (const file of files) {
    if (isSensitiveSourcePath(file)) continue
    const absolute = resolve(path, file)
    let content: string | Buffer | undefined
    try {
      const stats = await lstat(absolute)
      if (stats.isSymbolicLink()) {
        content = `link:${await readlink(absolute)}`
      } else if (stats.isFile()) {
        content = await readFile(absolute)
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    hash.update(file)
    hash.update('\0')
    if (content !== undefined) hash.update(content)
    hash.update('\0')
  }
  return hash.digest('hex')
}

function isSensitiveSourcePath(path: string): boolean {
  const segments = path.toLowerCase().split(/[\\/]/)
  const name = segments.at(-1) ?? ''
  return (
    segments.includes('.ssh') ||
    (name === '.env' || (name.startsWith('.env.') && name !== '.env.example')) ||
    name === 'credentials' ||
    name === 'credentials.json' ||
    name === 'id_rsa' ||
    name === 'id_ed25519' ||
    name.endsWith('.key') ||
    name.endsWith('.pem') ||
    name.endsWith('.p12') ||
    name.endsWith('.pfx')
  )
}

function lines(output: string | undefined): string[] {
  return (output ?? '')
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean)
}

async function git(path: string, args: string[]): Promise<string | undefined> {
  try {
    const result = await run('git', ['-C', path, ...args], {
      maxBuffer: 16 * 1024 * 1024,
    })
    return result.stdout
  } catch {
    // Missing git, not a repository, or an unknown commit all mean the same
    // thing here: no baseline information is available for this source.
    return undefined
  }
}

function isSourceRecords(value: unknown): value is SyncState['sources'] {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.values(value).every(
      (record) =>
        record !== null &&
        typeof record === 'object' &&
        typeof (record as { commit?: unknown }).commit === 'string' &&
        typeof (record as { recordedAt?: unknown }).recordedAt === 'string' &&
        ((record as { contentFingerprint?: unknown }).contentFingerprint ===
          undefined ||
          typeof (record as { contentFingerprint?: unknown })
            .contentFingerprint === 'string'),
    )
  )
}
