import { execFile } from 'node:child_process'
import { readdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { DoxloopError } from './errors.js'
import { pathExists } from './fs.js'
import { loadProject, sourceKind } from './project.js'
import type { DoxloopProject, ReleaseCommit, ReleaseInventory, ReleaseSourceInventory, SourceBinding } from './types.js'

const execute = promisify(execFile)

/**
 * Deterministic inputs for a release-notes plan: the commits and changed files
 * between two Git refs of every Git-backed source, plus the section of the
 * product's own changelog that names the release. The planner and writer get
 * this inventory verbatim, so the page is grounded in the actual commit range
 * rather than in what the agent remembers about the product.
 */
export const MAX_RELEASE_COMMITS = 200
export const MAX_RELEASE_FILES = 300
const MAX_BODY_CHARS = 400
const MAX_CHANGELOG_CHARS = 6000
const CHANGELOG_NAMES = ['changelog', 'changes', 'history', 'releases', 'release-notes', 'news']
const SAFE_REF = /^(?!-)[\w./@^~{}+-]{1,120}$/

export interface SourceRefs {
  source: string
  /** Newest first. */
  tags: string[]
  branches: string[]
  head: string
  /** The refs a "latest release" request would use, when two tags exist. */
  suggested?: { from: string; to: string; version: string }
}

export interface ReleaseTemplateInput {
  version: string
  from: string
  to: string
  /** Restrict the inventory to these sources; empty means every Git-backed directory source. */
  sources?: string[]
}

/** Directory sources whose checkout is a Git repository. */
export async function gitBackedSources(root: string, project: DoxloopProject): Promise<SourceBinding[]> {
  const output: SourceBinding[] = []
  for (const source of project.sources) {
    if (sourceKind(source) !== 'directory') continue
    if (await isGitRepository(resolve(root, source.path))) output.push(source)
  }
  return output
}

export async function listSourceRefs(root: string, sourceName: string): Promise<SourceRefs> {
  const project = await loadProject(root)
  const source = project.sources.find((entry) => entry.name === sourceName)
  if (!source || sourceKind(source) !== 'directory') throw new DoxloopError(`"${sourceName}" is not a directory source.`, 2)
  const path = resolve(root, source.path)
  if (!(await isGitRepository(path))) throw new DoxloopError(`"${sourceName}" is not a Git checkout, so it has no release refs.`, 2)
  // The last sort key is primary: newest first, with version order breaking ties created in the same second.
  const tags = lines(await git(path, ['tag', '--sort=-version:refname', '--sort=-creatordate', '--merged', 'HEAD'])).slice(0, 100)
  const branches = lines(await git(path, ['branch', '--format=%(refname:short)'])).slice(0, 50)
  const head = (await git(path, ['rev-parse', '--short', 'HEAD'])).trim()
  const suggested = tags.length >= 2
    ? { from: tags[1]!, to: tags[0]!, version: tags[0]! }
    : tags.length === 1
      ? { from: tags[0]!, to: 'HEAD', version: `${tags[0]!} (unreleased changes)` }
      : undefined
  return { source: source.name, tags, branches, head, ...(suggested ? { suggested } : {}) }
}

export async function collectReleaseInventory(
  root: string,
  project: DoxloopProject,
  input: ReleaseTemplateInput,
): Promise<ReleaseInventory> {
  const version = input.version.trim()
  if (!version || version.length > 60) throw new DoxloopError('Release notes need a version label, such as v0.2.0.', 2)
  const from = validRef(input.from, 'Starting ref')
  const to = validRef(input.to, 'Ending ref')
  const candidates = await gitBackedSources(root, project)
  const selected = input.sources?.length
    ? candidates.filter((source) => input.sources!.includes(source.name))
    : candidates
  if (selected.length === 0) {
    throw new DoxloopError(input.sources?.length
      ? `None of ${input.sources.join(', ')} is a Git-backed directory source.`
      : 'Release notes need at least one directory source that is a Git checkout. Connect the product repository under Sources first.', 2)
  }
  const sources: ReleaseSourceInventory[] = []
  for (const source of selected) {
    sources.push(await inventorySource(root, source, from, to, version))
  }
  return { version, from, to, collectedAt: new Date().toISOString(), sources }
}

async function inventorySource(root: string, source: SourceBinding, from: string, to: string, version: string): Promise<ReleaseSourceInventory> {
  const path = resolve(root, source.path)
  for (const ref of [from, to]) {
    try {
      await git(path, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
    } catch {
      throw new DoxloopError(`"${ref}" is not a commit, tag, or branch in source "${source.name}".`, 2)
    }
  }
  const log = await git(path, [
    'log', '--no-merges', '--date=short', `--max-count=${MAX_RELEASE_COMMITS + 1}`,
    '--format=%H%x1f%ad%x1f%an%x1f%s%x1f%b%x1e', `${from}..${to}`,
  ])
  const commits: ReleaseCommit[] = log.split('\x1e').map((entry) => entry.trim()).filter(Boolean).map((entry) => {
    const [hash = '', date = '', author = '', subject = '', body = ''] = entry.split('\x1f')
    const trimmedBody = body.trim().replace(/\s+/g, ' ').slice(0, MAX_BODY_CHARS)
    return { hash: hash.slice(0, 12), date, author, subject: subject.trim(), ...(trimmedBody ? { body: trimmedBody } : {}) }
  })
  const truncatedCommits = commits.length > MAX_RELEASE_COMMITS
  const diff = lines(await git(path, ['diff', '--name-status', from, to]))
  const changedFiles = diff.slice(0, MAX_RELEASE_FILES).map((line) => line.replace(/\t+/g, ' '))
  const changelog = await changelogExcerpt(path, version)
  return {
    source: source.name,
    from,
    to,
    commits: commits.slice(0, MAX_RELEASE_COMMITS),
    changedFiles,
    truncated: truncatedCommits || diff.length > MAX_RELEASE_FILES,
    ...(changelog ? { changelog } : {}),
  }
}

/** The changelog section that names the version, or the top of the file when no section matches. */
export async function changelogExcerpt(sourceRoot: string, version: string): Promise<{ path: string; excerpt: string } | undefined> {
  let entries: string[]
  try { entries = await readdir(sourceRoot) } catch { return undefined }
  const file = entries.find((entry) => CHANGELOG_NAMES.includes(entry.replace(/\.(md|mdx|markdown|txt|rst)$/i, '').toLowerCase()))
  if (!file) return undefined
  const text = await readFile(join(sourceRoot, file), 'utf8')
  return { path: file, excerpt: extractVersionSection(text, version) }
}

export function extractVersionSection(text: string, version: string): string {
  const lines = text.split(/\r?\n/)
  const needle = version.replace(/^v/i, '').toLowerCase()
  const isHeading = (line: string) => /^#{1,3}\s/.test(line) || /^(?:version|release)\b/i.test(line)
  const level = (line: string) => (/^(#{1,3})\s/.exec(line)?.[1]?.length ?? 1)
  const start = lines.findIndex((line) => isHeading(line) && line.toLowerCase().includes(needle))
  if (start === -1) return text.slice(0, MAX_CHANGELOG_CHARS)
  const startLevel = level(lines[start]!)
  let end = lines.length
  for (let index = start + 1; index < lines.length; index += 1) {
    if (isHeading(lines[index]!) && level(lines[index]!) <= startLevel) { end = index; break }
  }
  return lines.slice(start, end).join('\n').trim().slice(0, MAX_CHANGELOG_CHARS)
}

/** The inventory as the planner and writer read it. */
export function formatReleaseInventory(inventory: ReleaseInventory): string {
  const parts = [`Release: ${inventory.version} (${inventory.from}..${inventory.to}, collected ${inventory.collectedAt.slice(0, 10)})`]
  for (const source of inventory.sources) {
    parts.push(`\nSource "${source.source}": ${source.commits.length} commit${source.commits.length === 1 ? '' : 's'}, ${source.changedFiles.length} changed file${source.changedFiles.length === 1 ? '' : 's'}${source.truncated ? ' (truncated)' : ''}`)
    if (source.changelog) parts.push(`Changelog (${source.changelog.path}):\n${source.changelog.excerpt}`)
    if (source.commits.length > 0) {
      parts.push('Commits, newest first:')
      for (const commit of source.commits) parts.push(`- ${commit.date} ${commit.hash} ${commit.subject}${commit.body ? ` — ${commit.body}` : ''}`)
    }
    if (source.changedFiles.length > 0) parts.push(`Changed files:\n${source.changedFiles.map((file) => `- ${file}`).join('\n')}`)
  }
  return parts.join('\n')
}

export function releaseNotesPagePath(version: string): string {
  const slug = version.trim().toLowerCase().replace(/^v(?=\d)/, '').replace(/[^a-z0-9.]+/g, '-').replace(/^-+|-+$/g, '') || 'latest'
  return `release-notes/${slug}`
}

function validRef(value: string, label: string): string {
  const ref = value.trim()
  if (!SAFE_REF.test(ref)) throw new DoxloopError(`${label} must be a Git tag, branch, or commit.`, 2)
  return ref
}

async function isGitRepository(path: string): Promise<boolean> {
  if (!(await pathExists(path))) return false
  try {
    return (await git(path, ['rev-parse', '--is-inside-work-tree'])).trim() === 'true'
  } catch {
    return false
  }
}

async function git(path: string, args: string[]): Promise<string> {
  const result = await execute('git', ['-C', path, ...args], { maxBuffer: 32 * 1024 * 1024 })
  return result.stdout
}

function lines(value: string): string[] {
  return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
}
