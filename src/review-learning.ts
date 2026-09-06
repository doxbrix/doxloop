import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ensureGitignoreEntries, pathExists } from './fs.js'

export const REVIEW_PREFERENCES_FILE = join('.doxloop', 'review-preferences.json')

export interface ReviewPreference {
  id: string
  at: string
  kind: 'revision' | 'rejection' | 'inline-edit' | 'edit'
  paths: string[]
  instruction: string
}

const preferenceQueues = new Map<string, Promise<void>>()

export async function recordReviewPreference(root: string, preference: Omit<ReviewPreference, 'id' | 'at'>): Promise<void> {
  const previous = preferenceQueues.get(root) ?? Promise.resolve()
  const queued = previous.catch(() => undefined).then(() => persistReviewPreference(root, preference))
  preferenceQueues.set(root, queued)
  try { await queued } finally { if (preferenceQueues.get(root) === queued) preferenceQueues.delete(root) }
}

async function persistReviewPreference(root: string, preference: Omit<ReviewPreference, 'id' | 'at'>): Promise<void> {
  const current = await readPreferences(root)
  const entry: ReviewPreference = {
    ...preference,
    paths: [...new Set(preference.paths.filter((path) => typeof path === 'string').map((path) => path.slice(0, 500)))].slice(0, 100),
    instruction: redactPreference(preference.instruction).trim().slice(0, 2_000),
    id: `feedback-${Date.now().toString(36)}`,
    at: new Date().toISOString(),
  }
  if (!entry.instruction) return
  const entries = [...current, entry].slice(-100)
  await ensureGitignoreEntries(root, [REVIEW_PREFERENCES_FILE])
  await mkdir(join(root, '.doxloop'), { recursive: true, mode: 0o700 })
  await writeFile(join(root, REVIEW_PREFERENCES_FILE), `${JSON.stringify({ schemaVersion: 1, entries }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
}

export async function reviewPreferenceGuidance(root: string): Promise<string> {
  const entries = (await readPreferences(root)).slice(-20)
  if (entries.length === 0) return 'No prior reviewer preferences have been recorded.'
  return entries.map((entry) => `- ${entry.kind} on ${entry.paths.join(', ') || 'the proposal'}: ${entry.instruction}`).join('\n')
}

async function readPreferences(root: string): Promise<ReviewPreference[]> {
  const path = join(root, REVIEW_PREFERENCES_FILE)
  if (!(await pathExists(path))) return []
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as { schemaVersion?: number; entries?: ReviewPreference[] }
    return value.schemaVersion === 1 && Array.isArray(value.entries) ? value.entries.filter(validPreference) : []
  } catch { return [] }
}

function validPreference(value: ReviewPreference): boolean {
  return !!value && ['revision', 'rejection', 'inline-edit', 'edit'].includes(value.kind) && Array.isArray(value.paths) && value.paths.every((item) => typeof item === 'string') && typeof value.instruction === 'string' && value.instruction.trim() !== ''
}

function redactPreference(value: string): string {
  return value
    .replace(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g, '[REDACTED PRIVATE KEY]')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16})\b/g, '[REDACTED CREDENTIAL]')
}
