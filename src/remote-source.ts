import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, posix, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import { unzipSync } from 'fflate'
import { DoxloopError } from './errors.js'
import { pathExists } from './fs.js'
import type { RemoteSource, SourceBinding } from './types.js'

const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024
const MAX_EXTRACTED_BYTES = 500 * 1024 * 1024
const execFileAsync = promisify(execFile)
const gitCredentials = new Map<string, GitCredential>()
const GIT_CREDENTIALS_ENV = 'DOXLOOP_SESSION_GIT_CREDENTIALS'

export interface GitCredential {
  username?: string
  secret: string
}

interface GitHubBranch {
  name?: string
  commit?: { sha?: string }
}

interface GitHubComparison {
  files?: Array<{ filename?: string; previous_filename?: string; status?: string }>
}

interface GitHubTree {
  tree?: Array<{ path?: string; type?: string }>
}

export interface RemoteBranch {
  name: string
  head: string
}

/** Validate a provider-neutral Git clone URL without embedding credentials. */
export function parseGitRepository(value: string): string {
  const input = value.trim()
  if (!input || /[\r\n\0]/.test(input)) throw new DoxloopError('Enter a Git repository URL.')
  if (/^[^@\s]+@[^:\s]+:.+$/.test(input)) return input
  try {
    const url = new URL(input)
    if (!['https:', 'http:', 'ssh:', 'git:', 'file:'].includes(url.protocol) || url.password) throw new Error('unsupported')
    return input
  } catch {
    throw new DoxloopError('Enter a Git clone URL from GitHub, GitLab, Azure DevOps, or another Git service.')
  }
}

/** Keep private-repository credentials in memory for this Doxloop UI session. */
export function rememberRemoteCredential(repository: string, username: string | undefined, secret: string | undefined): void {
  const key = credentialKey(repository)
  if (!secret) {
    gitCredentials.delete(key)
    return
  }
  gitCredentials.set(key, { ...(username?.trim() ? { username: username.trim() } : {}), secret })
}

/**
 * Forward UI-session credentials to Doxloop child processes without writing
 * them to the project configuration or placing them on a command line.
 */
export function remoteCredentialEnvironment(): NodeJS.ProcessEnv {
  if (gitCredentials.size === 0) return {}
  return { [GIT_CREDENTIALS_ENV]: JSON.stringify(Object.fromEntries(gitCredentials)) }
}

/** Accept GitHub web/clone URLs or owner/name and return the canonical slug. */
export function parseGitHubRepository(value: string): string {
  const input = value.trim()
  const slug = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input)
    ? input
    : githubSlugFromUrl(input)
  if (!slug || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(slug)) {
    throw new DoxloopError('Enter a GitHub repository URL, for example https://github.com/acme/product.')
  }
  return slug.replace(/\.git$/i, '')
}

function githubSlugFromUrl(value: string): string | undefined {
  const ssh = /^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/.exec(value)
  if (ssh) return `${ssh[1]}/${ssh[2]}`
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'github.com' || url.username || url.password) return
    const parts = url.pathname.replace(/^\/+|\/+$/g, '').split('/')
    if (parts.length !== 2) return
    return `${parts[0]}/${parts[1]!.replace(/\.git$/i, '')}`
  } catch {
    return
  }
}

export async function listRemoteBranches(remote: RemoteSource): Promise<RemoteBranch[]> {
  if (remote.provider === 'git') return listGitBranches(remote)
  const response = await githubRequest(
    remote,
    `/repos/${repositoryPath(remote)}/branches?per_page=100`,
  )
  const branches = (await response.json()) as GitHubBranch[]
  return branches.flatMap((branch) => {
    const name = branch.name
    const head = branch.commit?.sha
    return name && head && /^[0-9a-f]{40}$/i.test(head) ? [{ name, head }] : []
  })
}

export async function remoteHead(remote: RemoteSource): Promise<string> {
  if (remote.provider === 'git') return gitRemoteHead(remote)
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

/** List repository folders without checking out file contents. */
export async function listRemoteDirectories(remote: RemoteSource): Promise<string[]> {
  if (remote.provider === 'github') return listGitHubDirectories(remote)
  const temporary = await mkdtemp(join(tmpdir(), 'doxloop-git-tree-'))
  try {
    await rm(temporary, { recursive: true, force: true })
    await runGit(remote, [
      'clone', '--depth', '1', '--single-branch', '--branch', remote.branch,
      '--filter=blob:none', '--no-checkout', '--no-tags', '--quiet', remote.repository, temporary,
    ])
    const output = await runGit(remote, ['-C', temporary, 'ls-tree', '-d', '-r', '--name-only', 'HEAD'])
    return output.split(/\r?\n/).map((directory) => directory.trim()).filter(Boolean).slice(0, 5000)
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

export async function remoteChangedFiles(
  remote: RemoteSource,
  baseline: string,
  head: string,
): Promise<string[]> {
  if (remote.provider === 'git') return gitChangedFiles(remote, baseline, head)
  const response = await githubRequest(
    remote,
    `/repos/${repositoryPath(remote)}/compare/${encodeURIComponent(baseline)}...${encodeURIComponent(head)}?per_page=100`,
  )
  const comparison = (await response.json()) as GitHubComparison
  return (comparison.files ?? []).flatMap((file) => {
    if (!file.filename) return []
    const status = file.status === 'added' ? 'A' : file.status === 'removed' ? 'D' : file.status === 'renamed' ? 'R100' : 'M'
    if (status === 'R100' && file.previous_filename) return [`${status}\t${file.previous_filename}\t${file.filename}`]
    return [`${status}\t${file.filename}`]
  })
}

/** Download a provider snapshot outside the documentation deployment boundary. */
export async function materializeRemoteSource(
  root: string,
  source: Pick<SourceBinding, 'name' | 'remote'>,
  requestedHead?: string,
): Promise<{ path: string; head: string; files: number }> {
  const remote = source.remote!
  if (remote.provider === 'git') return materializeGitSource(root, source, requestedHead)
  const head = requestedHead ?? await remoteHead(remote)
  const projectId = createHash('sha256').update(resolve(root)).digest('hex').slice(0, 12)
  const destination = join(dirname(resolve(root)), '.doxloop-sources', projectId, safeName(source.name), head)
  let files = 0
  if (!(await pathExists(destination))) {
    const parent = dirname(destination)
    await mkdir(parent, { recursive: true })
    const temporary = await mkdtemp(join(parent, '.download-'))
    try {
      const response = await githubRequest(
        remote,
        `/repos/${repositoryPath(remote)}/zipball/${encodeURIComponent(head)}`,
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
        const archiveRelative = parts.slice(1).join('/')
        if (!archiveRelative) continue
        const output = resolve(temporary, archiveRelative)
        if (!output.startsWith(`${resolve(temporary)}/`)) throw new DoxloopError('GitHub returned an unsafe archive path.')
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
        files += 1
      }
      await rename(temporary, destination)
    } catch (error) {
      await rm(temporary, { recursive: true, force: true })
      throw error
    }
  }

  const scoped = remote.subdirectory
    ? resolveRemoteSubdirectory(destination, remote.subdirectory)
    : destination
  try {
    if (!(await stat(scoped)).isDirectory()) throw new Error('not a directory')
  } catch {
    throw new DoxloopError(`The repository subdirectory does not exist on ${remote.branch}: ${remote.subdirectory}`)
  }
  return { path: scoped, head, files }
}

export function changedFilesInRemoteScope(files: string[], subdirectory?: string): string[] {
  if (!subdirectory) return files
  const prefix = `${normalizeSubdirectory(subdirectory)}/`
  return files.flatMap((entry) => {
    const columns = entry.split('\t')
    const paths = columns.slice(1)
    if (!paths.some((path) => path === prefix.slice(0, -1) || path.startsWith(prefix))) return []
    return [columns.map((column, index) => index === 0 ? column : column.startsWith(prefix) ? column.slice(prefix.length) : column).join('\t')]
  })
}

export function portableSourcePath(root: string, sourcePath: string): string {
  return relative(resolve(root), resolve(sourcePath)).split('\\').join('/')
}

function resolveRemoteSubdirectory(root: string, value: string): string {
  const normalized = normalizeSubdirectory(value)
  const destination = resolve(root, normalized)
  if (isAbsolute(normalized) || destination === resolve(root) || !destination.startsWith(`${resolve(root)}/`)) {
    throw new DoxloopError('Repository subdirectory must be a safe relative directory.')
  }
  return destination
}

function normalizeSubdirectory(value: string): string {
  return posix.normalize(value.trim().replace(/\\/g, '/')).replace(/^\.\//, '').replace(/\/$/, '')
}

async function listGitHubDirectories(remote: RemoteSource): Promise<string[]> {
  const head = await remoteHead(remote)
  const response = await githubRequest(remote, `/repos/${repositoryPath(remote)}/git/trees/${encodeURIComponent(head)}?recursive=1`)
  const tree = (await response.json()) as GitHubTree
  return (tree.tree ?? []).flatMap((entry) => entry.type === 'tree' && entry.path ? [entry.path] : []).slice(0, 5000)
}

async function listGitBranches(remote: RemoteSource): Promise<RemoteBranch[]> {
  const output = await runGit(remote, ['ls-remote', '--heads', remote.repository])
  const branches = output.split(/\r?\n/).flatMap((line) => {
    const match = /^([0-9a-f]{40,64})\s+refs\/heads\/(.+)$/i.exec(line.trim())
    return match ? [{ name: match[2]!, head: match[1]! }] : []
  })
  const defaultBranch = await gitDefaultBranch(remote)
  return branches.sort((a, b) => a.name === defaultBranch ? -1 : b.name === defaultBranch ? 1 : a.name.localeCompare(b.name))
}

async function gitDefaultBranch(remote: RemoteSource): Promise<string | undefined> {
  try {
    const output = await runGit(remote, ['ls-remote', '--symref', remote.repository, 'HEAD'])
    return /^ref:\s+refs\/heads\/(.+)\s+HEAD$/m.exec(output)?.[1]
  } catch {
    return undefined
  }
}

async function gitRemoteHead(remote: RemoteSource): Promise<string> {
  const output = await runGit(remote, ['ls-remote', remote.repository, `refs/heads/${remote.branch}`])
  const match = /^([0-9a-f]{40,64})\s+refs\/heads\/.+$/im.exec(output)
  if (!match) throw new DoxloopError(`Branch "${remote.branch}" was not found in the repository.`)
  return match[1]!
}

async function gitChangedFiles(remote: RemoteSource, baseline: string, head: string): Promise<string[]> {
  const temporary = await mkdtemp(join(tmpdir(), 'doxloop-git-diff-'))
  try {
    await runGit(remote, ['clone', '--bare', '--filter=blob:none', '--quiet', remote.repository, temporary])
    const output = await runGit(remote, ['-C', temporary, 'diff', '--name-status', baseline, head])
    return output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

async function materializeGitSource(
  root: string,
  source: Pick<SourceBinding, 'name' | 'remote'>,
  requestedHead?: string,
): Promise<{ path: string; head: string; files: number }> {
  const remote = source.remote!
  const head = requestedHead ?? await gitRemoteHead(remote)
  const projectId = createHash('sha256').update(resolve(root)).digest('hex').slice(0, 12)
  const destination = join(dirname(resolve(root)), '.doxloop-sources', projectId, safeName(source.name), head)
  let files = 0
  if (!(await pathExists(destination))) {
    const parent = dirname(destination)
    await mkdir(parent, { recursive: true })
    const temporary = await mkdtemp(join(parent, '.clone-'))
    try {
      await rm(temporary, { recursive: true, force: true })
      await runGit(remote, [
        'clone', '--depth', '1', '--single-branch', '--branch', remote.branch,
        '--no-tags', '--quiet', remote.repository, temporary,
      ])
      const actualHead = (await runGit(remote, ['-C', temporary, 'rev-parse', 'HEAD'])).trim()
      if (actualHead !== head) throw new DoxloopError('The repository changed while Doxloop was preparing it. Connect again to use the latest version.')
      await rm(join(temporary, '.git'), { recursive: true, force: true })
      const measured = await measureDirectory(temporary)
      if (measured.bytes > MAX_EXTRACTED_BYTES) {
        throw new DoxloopError(`The source exceeds the ${MAX_EXTRACTED_BYTES / 1024 / 1024} MB safety limit.`)
      }
      files = measured.files
      await rename(temporary, destination)
    } catch (error) {
      await rm(temporary, { recursive: true, force: true })
      throw error
    }
  }
  const scoped = remote.subdirectory ? resolveRemoteSubdirectory(destination, remote.subdirectory) : destination
  try {
    if (!(await stat(scoped)).isDirectory()) throw new Error('not a directory')
  } catch {
    throw new DoxloopError(`The repository subdirectory does not exist on ${remote.branch}: ${remote.subdirectory}`)
  }
  return { path: scoped, head, files }
}

async function measureDirectory(root: string): Promise<{ files: number; bytes: number }> {
  let files = 0
  let bytes = 0
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) {
      const child = await measureDirectory(path)
      files += child.files
      bytes += child.bytes
    } else if (entry.isFile()) {
      files += 1
      bytes += (await stat(path)).size
    }
  }
  return { files, bytes }
}

async function runGit(remote: RemoteSource, args: string[]): Promise<string> {
  const credential = remoteCredential(remote.repository)
  const askpassDirectory = credential ? await mkdtemp(join(tmpdir(), 'doxloop-askpass-')) : undefined
  try {
    let askpass: string | undefined
    if (askpassDirectory) {
      askpass = join(askpassDirectory, 'askpass.sh')
      await writeFile(askpass, '#!/bin/sh\ncase "$1" in *sername*) printf "%s" "$DOXLOOP_GIT_USERNAME" ;; *) printf "%s" "$DOXLOOP_GIT_SECRET" ;; esac\n', { mode: 0o700 })
    }
    // An explicitly supplied UI credential must win over stale entries in the
    // user's Git credential manager. Automatic mode still uses that manager.
    const commandArgs = credential ? ['-c', 'credential.helper=', ...args] : args
    const result = await execFileAsync('git', commandArgs, {
      maxBuffer: 20 * 1024 * 1024,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        ...(askpass && credential ? {
          GIT_ASKPASS: askpass,
          DOXLOOP_GIT_USERNAME: credential.username ?? 'oauth2',
          DOXLOOP_GIT_SECRET: credential.secret,
        } : {}),
      },
    })
    return result.stdout
  } catch (error) {
    const detail = error && typeof error === 'object' && 'stderr' in error ? String(error.stderr).trim() : ''
    throw new DoxloopError(gitErrorMessage(detail, remote.repository))
  } finally {
    if (askpassDirectory) await rm(askpassDirectory, { recursive: true, force: true })
  }
}

function remoteCredential(repository: string): GitCredential | undefined {
  const key = credentialKey(repository)
  const remembered = gitCredentials.get(key)
  if (remembered) return remembered
  const serialized = process.env[GIT_CREDENTIALS_ENV]
  if (!serialized) return undefined
  try {
    const value = JSON.parse(serialized) as unknown
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
    const candidate = (value as Record<string, unknown>)[key]
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return undefined
    const secret = (candidate as Record<string, unknown>).secret
    const username = (candidate as Record<string, unknown>).username
    if (typeof secret !== 'string' || !secret || (username !== undefined && typeof username !== 'string')) return undefined
    return { ...(typeof username === 'string' && username ? { username } : {}), secret }
  } catch {
    return undefined
  }
}

function gitErrorMessage(detail: string, repository: string): string {
  if (/write access to repository not granted|requested url returned error:\s*403|forbidden/i.test(detail)) {
    const github = /github\.com/i.test(repository)
    return github
      ? 'GitHub denied access to this repository. Make sure the access key includes this repository and has Contents set to Read-only (or use a classic token with the repo scope). If the repository belongs to an organization, the key may also need SSO approval.'
      : 'The Git service denied access to this repository. Make sure this account can read the repository and the access key has repository read permission.'
  }
  if (/authentication failed|could not read Username|terminal prompts disabled|access denied|repository not found/i.test(detail)) {
    return 'Doxloop could not sign in to this repository. Check your repository address and access details.'
  }
  if (/not found|does not appear to be a git repository/i.test(detail)) return 'Doxloop could not find a Git repository at this address.'
  return detail ? `Git connection failed: ${detail.split(/\r?\n/).slice(-2).join(' ')}` : 'Git connection failed. Check the repository address and try again.'
}

function credentialKey(repository: string): string {
  return repository.trim().replace(/\/$/, '')
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
      'User-Agent': 'doxloop-remote-source',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  })
  if (!response.ok) {
    const hint = response.status === 401 || response.status === 403
      ? ` Set ${tokenName} for a private repository or higher API limits.`
      : ''
    throw new DoxloopError(`GitHub API request failed for ${remote.repository} (${response.status} ${response.statusText}).${hint}`)
  }
  return response
}

function repositoryPath(remote: RemoteSource): string {
  return remote.repository.split('/').map(encodeURIComponent).join('/')
}

function safeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '-')
}
