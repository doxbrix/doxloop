import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, posix, resolve } from 'node:path'
import { unzipSync } from 'fflate'
import { DoxloopError } from './errors.js'
import { pathExists } from './fs.js'
import { sourceKind } from './project.js'
import { collectSourceChanges, readSyncState } from './sync.js'
import type {
  DoxloopProject,
  RemoteSource,
  SourceBinding,
  SourceChange,
  SyncState,
} from './types.js'

const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024
const MAX_EXTRACTED_BYTES = 500 * 1024 * 1024

interface GitHubBranch {
  commit?: { sha?: string }
}

interface GitHubComparison {
  files?: Array<{
    filename?: string
    previous_filename?: string
    status?: string
  }>
}

export interface RemoteMonitorResult {
  project: DoxloopProject
  changes: SourceChange[]
  nextState: SyncState
}

/** Verify read access to a configured GitHub branch without downloading source. */
export async function testRemoteSource(remote: RemoteSource): Promise<{ head: string }> {
  return { head: await githubHead(remote) }
}

/**
 * Observe configured product repositories through provider read APIs. This
 * function never opens, invokes Git in, or writes to the user's source checkout.
 */
export async function monitorRemoteSources(
  root: string,
  project: DoxloopProject,
): Promise<RemoteMonitorResult> {
  const previous = await readSyncState(root)
  const nextState: SyncState = {
    schemaVersion: 1,
    sources: { ...previous.sources },
  }
  const changes: SourceChange[] = []
  const sources: SourceBinding[] = []

  for (const source of project.sources) {
    if (sourceKind(source) === 'openapi') {
      changes.push(...await collectSourceChanges(root, [source]))
      sources.push(source)
      continue
    }
    if (!source.remote) {
      throw new DoxloopError(
        `Source "${source.name}" has no read-only remote configured. Add sources[].remote before enabling scheduled sync.`,
      )
    }
    const head = await githubHead(source.remote)
    const record = previous.sources[source.name]
    if (!record) {
      const snapshot = await githubSnapshot(root, source, head)
      changes.push({ ...source, path: snapshot, kind: 'no-baseline', head, uncommittedFiles: [] })
      sources.push({ ...source, path: snapshot })
      nextState.sources[source.name] = {
        commit: head,
        recordedAt: new Date().toISOString(),
      }
      continue
    }
    if (record.commit === head) {
      changes.push({
        ...source,
        kind: 'unchanged',
        baseline: record.commit,
        head,
        changedFiles: [],
        uncommittedFiles: [],
      })
      sources.push(source)
      continue
    }

    const changedFiles = await githubChangedFiles(source.remote, record.commit, head)
    const snapshot = await githubSnapshot(root, source, head)
    changes.push({
      ...source,
      path: snapshot,
      kind: 'changed',
      baseline: record.commit,
      head,
      changedFiles,
      uncommittedFiles: [],
    })
    sources.push({ ...source, path: snapshot })
    nextState.sources[source.name] = {
      commit: head,
      recordedAt: new Date().toISOString(),
    }
  }

  return { project: { ...project, sources }, changes, nextState }
}

async function githubHead(remote: RemoteSource): Promise<string> {
  const response = await githubRequest(
    remote,
    `/repos/${repositoryPath(remote)}/branches/${encodeURIComponent(remote.branch)}`,
  )
  const branch = (await response.json()) as GitHubBranch
  const sha = branch.commit?.sha
  if (!sha || !/^[0-9a-f]{40}$/i.test(sha)) {
    throw new DoxloopError(`GitHub returned an invalid head for ${remote.repository}@${remote.branch}.`)
  }
  return sha
}

async function githubChangedFiles(
  remote: RemoteSource,
  baseline: string,
  head: string,
): Promise<string[]> {
  const response = await githubRequest(
    remote,
    `/repos/${repositoryPath(remote)}/compare/${encodeURIComponent(baseline)}...${encodeURIComponent(head)}?per_page=100`,
  )
  const comparison = (await response.json()) as GitHubComparison
  const files = comparison.files ?? []
  return files.flatMap((file) => {
    if (!file.filename) return []
    const status = file.status === 'added' ? 'A' : file.status === 'removed' ? 'D' : file.status === 'renamed' ? 'R100' : 'M'
    if (status === 'R100' && file.previous_filename) {
      return [`${status}\t${file.previous_filename}\t${file.filename}`]
    }
    return [`${status}\t${file.filename}`]
  })
}

async function githubSnapshot(
  root: string,
  source: SourceBinding,
  head: string,
): Promise<string> {
  const destination = join(root, '.doxloop', 'cache', 'sources', safeName(source.name), head)
  if (await pathExists(destination)) return destination
  const parent = dirname(destination)
  await mkdir(parent, { recursive: true })
  const temporary = await mkdtemp(join(parent, '.download-'))
  try {
    const response = await githubRequest(
      source.remote!,
      `/repos/${repositoryPath(source.remote!)}/zipball/${encodeURIComponent(head)}`,
      'application/vnd.github+json',
    )
    const archive = new Uint8Array(await response.arrayBuffer())
    if (archive.byteLength > MAX_ARCHIVE_BYTES) {
      throw new DoxloopError(`The source archive exceeds the ${MAX_ARCHIVE_BYTES / 1024 / 1024} MB safety limit.`)
    }
    const entries = unzipSync(archive)
    let extracted = 0
    for (const [rawName, content] of Object.entries(entries)) {
      const normalized = posix.normalize(rawName.replace(/\\/g, '/'))
      const parts = normalized.split('/').filter(Boolean)
      if (parts.length < 2 || normalized.startsWith('/') || parts.includes('..')) continue
      const relative = parts.slice(1).join('/')
      if (!relative) continue
      const output = resolve(temporary, relative)
      if (!output.startsWith(`${resolve(temporary)}/`)) {
        throw new DoxloopError('GitHub returned an unsafe archive path.')
      }
      if (normalized.endsWith('/')) {
        await mkdir(output, { recursive: true })
        continue
      }
      extracted += content.byteLength
      if (extracted > MAX_EXTRACTED_BYTES) {
        throw new DoxloopError(`The expanded source exceeds the ${MAX_EXTRACTED_BYTES / 1024 / 1024} MB safety limit.`)
      }
      await mkdir(dirname(output), { recursive: true })
      await writeFile(output, content)
    }
    await rename(temporary, destination)
    return destination
  } catch (error) {
    await rm(temporary, { recursive: true, force: true })
    throw error
  }
}

async function githubRequest(
  remote: RemoteSource,
  path: string,
  accept = 'application/vnd.github+json',
): Promise<Response> {
  const base = (remote.apiBaseUrl ?? 'https://api.github.com').replace(/\/$/, '')
  const tokenName = remote.tokenEnv ?? 'GITHUB_TOKEN'
  const token = process.env[tokenName]
  const response = await fetch(`${base}${path}`, {
    redirect: 'follow',
    headers: {
      Accept: accept,
      'User-Agent': 'doxloop-remote-monitor',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  })
  if (!response.ok) {
    const hint = response.status === 401 || response.status === 403
      ? ` Set ${tokenName} for a private repository or higher API limits.`
      : ''
    throw new DoxloopError(
      `GitHub API request failed for ${remote.repository} (${response.status} ${response.statusText}).${hint}`,
    )
  }
  return response
}

function repositoryPath(remote: RemoteSource): string {
  return remote.repository.split('/').map(encodeURIComponent).join('/')
}

function safeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '-')
}
