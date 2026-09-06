import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathExists } from './fs.js'
import { PROJECT_FILE } from './project.js'

/**
 * The user-level list of documentation projects the control center has
 * opened. It lives outside every project so switching between two workspaces
 * is one click, and it records only what is needed to show and reopen them.
 */
export interface RecentProject {
  path: string
  title: string
  generator: string
  lastOpenedAt: string
  /** The project file is gone. The entry stays until forgotten so the person can see where it was. */
  missing?: boolean
}

export const MAX_RECENT_PROJECTS = 20

/** `DOXLOOP_HOME` overrides the location so tests and CI never touch a real home directory. */
export function doxloopHomeDirectory(): string {
  const override = process.env.DOXLOOP_HOME?.trim()
  return override ? resolve(override) : join(homedir(), '.doxloop')
}

export function projectRegistryPath(): string {
  return join(doxloopHomeDirectory(), 'projects.json')
}

export async function listRecentProjects(): Promise<RecentProject[]> {
  const entries = await readRegistry()
  return Promise.all(entries.map(async (entry) => (
    (await pathExists(join(entry.path, PROJECT_FILE))) ? entry : { ...entry, missing: true }
  )))
}

export async function rememberProject(entry: { path: string; title: string; generator: string }): Promise<RecentProject[]> {
  const path = resolve(entry.path)
  const others = (await readRegistry()).filter((item) => item.path !== path)
  const next = [
    { path, title: entry.title, generator: entry.generator, lastOpenedAt: new Date().toISOString() },
    ...others,
  ].slice(0, MAX_RECENT_PROJECTS)
  await writeRegistry(next)
  return next
}

export async function forgetProject(path: string): Promise<RecentProject[]> {
  const target = resolve(path)
  const next = (await readRegistry()).filter((item) => item.path !== target)
  await writeRegistry(next)
  return next
}

async function readRegistry(): Promise<RecentProject[]> {
  let raw: string
  try {
    raw = await readFile(projectRegistryPath(), 'utf8')
  } catch {
    return []
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    // The registry is a convenience. A damaged file must never keep the
    // control center from opening; it is rewritten on the next open.
    return []
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return []
  const record = parsed as { schemaVersion?: unknown; projects?: unknown }
  if (record.schemaVersion !== 1 || !Array.isArray(record.projects)) return []
  return record.projects
    .filter(isRecentProject)
    .map((entry) => ({ path: resolve(entry.path), title: entry.title, generator: entry.generator, lastOpenedAt: entry.lastOpenedAt }))
    .sort((left, right) => right.lastOpenedAt.localeCompare(left.lastOpenedAt))
}

async function writeRegistry(projects: RecentProject[]): Promise<void> {
  const path = projectRegistryPath()
  await mkdir(doxloopHomeDirectory(), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${process.pid}.tmp`
  const payload = projects.map(({ missing: _missing, ...entry }) => entry)
  await writeFile(temporary, `${JSON.stringify({ schemaVersion: 1, projects: payload }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  await rename(temporary, path)
}

function isRecentProject(value: unknown): value is RecentProject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const entry = value as Partial<RecentProject>
  return (
    typeof entry.path === 'string' && entry.path.trim() !== '' &&
    typeof entry.title === 'string' &&
    typeof entry.generator === 'string' && entry.generator.trim() !== '' &&
    typeof entry.lastOpenedAt === 'string' && !Number.isNaN(Date.parse(entry.lastOpenedAt))
  )
}
