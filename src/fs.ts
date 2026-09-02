import { lstat, readdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { DoxloopError } from './errors.js'

export function assertInside(root: string, candidate: string): string {
  const absoluteRoot = resolve(root)
  const absoluteCandidate = resolve(candidate)
  const relation = relative(absoluteRoot, absoluteCandidate)
  if (relation === '..' || relation.startsWith(`..${sep}`) || relation.startsWith(sep)) {
    throw new DoxloopError(`Path escapes the project: ${candidate}`)
  }
  return absoluteCandidate
}

export async function resolveContainedDirectory(
  root: string,
  configuredPath: string,
  label = 'Directory',
  options: { allowRoot?: boolean } = {},
): Promise<string> {
  const rootContent = configuredPath === '' && options.allowRoot === true
  if (
    (!rootContent && configuredPath.trim() === '') ||
    isAbsolute(configuredPath) ||
    configuredPath === '.' ||
    configuredPath === '..'
  ) {
    throw new DoxloopError(`${label} must be a project-relative directory.`)
  }
  const absoluteRoot = resolve(root)
  const candidate = rootContent
    ? absoluteRoot
    : assertInside(absoluteRoot, resolve(absoluteRoot, configuredPath))
  if (candidate === absoluteRoot && !rootContent) {
    throw new DoxloopError(`${label} cannot be the project root.`)
  }

  const relation = relative(absoluteRoot, candidate)
  let current = absoluteRoot
  for (const segment of relation.split(sep)) {
    current = resolve(current, segment)
    const stats = await lstat(current)
    if (stats.isSymbolicLink()) {
      throw new DoxloopError(`${label} cannot contain a symbolic link: ${current}`)
    }
  }

  const realRoot = await realpath(absoluteRoot)
  const realCandidate = await realpath(candidate)
  assertInside(realRoot, realCandidate)
  return candidate
}

export async function listFiles(
  root: string,
  extensions: ReadonlySet<string>,
  options: { ignoredDirectories?: ReadonlySet<string> } = {},
): Promise<string[]> {
  const output: string[] = []
  await walk(root, root, extensions, output, options.ignoredDirectories)
  return output.sort()
}

async function walk(
  root: string,
  directory: string,
  extensions: ReadonlySet<string>,
  output: string[],
  ignoredDirectories?: ReadonlySet<string>,
): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true })
  for (const entry of entries) {
    const path = assertInside(root, resolve(directory, entry.name))
    if (entry.isSymbolicLink()) {
      throw new DoxloopError(`Symbolic links are not allowed in documentation: ${path}`)
    }
    if (entry.isDirectory() && !ignoredDirectories?.has(entry.name)) {
      await walk(root, path, extensions, output, ignoredDirectories)
    }
    else if (entry.isFile() && extensions.has(extname(entry.name))) output.push(path)
  }
}

export async function readJson<T>(path: string): Promise<T> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new DoxloopError(`Cannot read ${path}: ${message}`)
  }
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

const gitignoreQueues = new Map<string, Promise<void>>()

/** Add machine-local artifacts to .gitignore without losing concurrent additions. */
export async function ensureGitignoreEntries(root: string, entries: string[]): Promise<void> {
  const key = resolve(root)
  const previous = gitignoreQueues.get(key) ?? Promise.resolve()
  const queued = previous.catch(() => undefined).then(async () => {
    const path = join(key, '.gitignore')
    const existing = (await pathExists(path)) ? await readFile(path, 'utf8') : ''
    const lines = existing.split(/\r?\n/).filter(Boolean)
    const seen = new Set(lines)
    for (const entry of entries) if (!seen.has(entry)) { lines.push(entry); seen.add(entry) }
    await writeFile(path, `${lines.join('\n')}\n`, 'utf8')
  })
  gitignoreQueues.set(key, queued)
  try { await queued } finally { if (gitignoreQueues.get(key) === queued) gitignoreQueues.delete(key) }
}
