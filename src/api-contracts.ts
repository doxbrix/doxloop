/**
 * The OpenAPI contracts a project's examples can be checked against: every
 * OpenAPI source (a local file, or a remote one as last fetched) and the
 * specification files kept inside source repositories. Loading never touches
 * the network, and parsed files are reused while their modification time is
 * unchanged, because validation runs after every authoring batch.
 */
import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { cachedRemoteOpenApi, OPENAPI_FILE_NAME, OPENAPI_HEADER, OPENAPI_NOISE_PATH, parseOpenApi, type LoadedOpenApi } from './openapi.js'
import { isSpecUrl, sourceKind } from './project.js'
import type { DoxloopProject } from './types.js'

export interface ProjectContract {
  source: string
  /** Source-relative file, or the URL of a remote specification. */
  location: string
  loaded: LoadedOpenApi
}

const MAX_DEPTH = 4
const MAX_CONTRACTS_PER_SOURCE = 5
const SKIP_DIRECTORIES = new Set(['node_modules', '.git', 'dist', 'build', 'vendor', '.next', 'target', '.venv', '__pycache__'])
const parsed = new Map<string, { mtimeMs: number; loaded: LoadedOpenApi | undefined }>()

async function parseFile(path: string, label: string): Promise<LoadedOpenApi | undefined> {
  let info
  try { info = await stat(path) } catch { return undefined }
  if (!info.isFile() || info.size > 5 * 1024 * 1024) return undefined
  const cached = parsed.get(path)
  if (cached && cached.mtimeMs === info.mtimeMs) return cached.loaded
  let loaded: LoadedOpenApi | undefined
  try {
    const content = await readFile(path, 'utf8')
    loaded = OPENAPI_HEADER.test(content.slice(0, 4096)) ? parseOpenApi(content, label) : undefined
  } catch {
    loaded = undefined
  }
  parsed.set(path, { mtimeMs: info.mtimeMs, loaded })
  return loaded
}

async function findSpecificationFiles(directory: string, base: string, depth: number, found: string[]): Promise<void> {
  if (depth > MAX_DEPTH || found.length >= MAX_CONTRACTS_PER_SOURCE) return
  let entries
  try { entries = await readdir(directory, { withFileTypes: true }) } catch { return }
  for (const entry of entries) {
    if (found.length >= MAX_CONTRACTS_PER_SOURCE) return
    const path = join(directory, entry.name)
    const rel = relative(base, path).replaceAll('\\', '/')
    if (entry.isDirectory()) {
      if (SKIP_DIRECTORIES.has(entry.name) || entry.name.startsWith('.') || OPENAPI_NOISE_PATH.test(`${rel}/`)) continue
      await findSpecificationFiles(path, base, depth + 1, found)
    } else if (entry.isFile() && OPENAPI_FILE_NAME.test(rel) && !OPENAPI_NOISE_PATH.test(rel)) {
      found.push(path)
    }
  }
}

export async function projectContracts(root: string, project: Pick<DoxloopProject, 'sources'>): Promise<ProjectContract[]> {
  const contracts: ProjectContract[] = []
  for (const source of project.sources) {
    const kind = sourceKind(source)
    if (kind === 'docs-site') continue
    if (kind === 'openapi') {
      const loaded = isSpecUrl(source.path)
        ? await cachedRemoteOpenApi(root, source.path)
        : await parseFile(resolve(root, source.path), source.path)
      if (loaded) contracts.push({ source: source.name, location: source.path, loaded })
      continue
    }
    const base = resolve(root, source.path)
    const files: string[] = []
    await findSpecificationFiles(base, base, 0, files)
    for (const file of files) {
      const location = relative(base, file).replaceAll('\\', '/')
      const loaded = await parseFile(file, location)
      if (loaded) contracts.push({ source: source.name, location, loaded })
    }
  }
  return contracts
}
