import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { DoxloopError } from './errors.js'
import { pathExists, readJson } from './fs.js'

const COVERAGE_RESOLUTIONS_FILE = join('.doxloop', 'coverage-resolutions.json')

export type CoverageResolution = {
  disposition: 'documented' | 'excluded' | 'needs-human'
  page?: string
  reason?: string
  updatedAt: string
}

export type CoverageResolutions = {
  schemaVersion: 1
  items: Record<string, CoverageResolution>
}

export function coverageSignalId(source: string, kind: string, path: string, label: string): string {
  return `signal-${createHash('sha256').update(`${source}\0${kind}\0${path}\0${label}`).digest('hex').slice(0, 16)}`
}

export function coverageJourneyId(outcome: string): string {
  return `journey-${createHash('sha256').update(normalize(outcome)).digest('hex').slice(0, 16)}`
}

export async function readCoverageResolutions(root: string): Promise<CoverageResolutions> {
  const path = join(root, COVERAGE_RESOLUTIONS_FILE)
  if (!(await pathExists(path))) return { schemaVersion: 1, items: {} }
  const raw = await readJson<unknown>(path)
  if (!isCoverageResolutions(raw)) throw new DoxloopError(`${COVERAGE_RESOLUTIONS_FILE} has an unsupported format.`)
  return raw
}

export async function writeCoverageResolution(root: string, id: string, resolution?: Omit<CoverageResolution, 'updatedAt'>): Promise<void> {
  if (!/^(signal|journey)-[a-f0-9]{16}$/.test(id)) throw new DoxloopError('The requested coverage item is invalid.')
  const current = await readCoverageResolutions(root)
  const items = { ...current.items }
  if (resolution) items[id] = { ...resolution, updatedAt: new Date().toISOString() }
  else delete items[id]
  const path = join(root, COVERAGE_RESOLUTIONS_FILE)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify({ schemaVersion: 1, items }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
}

function isCoverageResolutions(value: unknown): value is CoverageResolutions {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const candidate = value as Partial<CoverageResolutions>
  if (candidate.schemaVersion !== 1 || !candidate.items || typeof candidate.items !== 'object' || Array.isArray(candidate.items)) return false
  return Object.entries(candidate.items).every(([id, item]) => {
    if (!/^(signal|journey)-[a-f0-9]{16}$/.test(id) || !item || typeof item !== 'object' || Array.isArray(item)) return false
    const resolution = item as Partial<CoverageResolution>
    return ['documented', 'excluded', 'needs-human'].includes(String(resolution.disposition)) &&
      (resolution.page === undefined || typeof resolution.page === 'string') &&
      (resolution.reason === undefined || typeof resolution.reason === 'string') &&
      typeof resolution.updatedAt === 'string'
  })
}

function normalize(value: string): string { return value.trim().toLowerCase() }
