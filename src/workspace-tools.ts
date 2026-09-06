import { randomUUID } from 'node:crypto'
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { applyDirectEdit, safePath } from './direct-edit.js'
import { computeDrift } from './drift.js'
import { readEvidenceMap, EVIDENCE_MAP_FILE } from './evidence.js'
import { DoxloopError } from './errors.js'
import { listRequests } from './history.js'
import { listPages, resolveEditScope } from './pages.js'
import { loadPages, loadProject } from './project.js'
import { withProjectLock } from './project-lock.js'
import { readSyncRun } from './sync-runs.js'
import { loadQualityConfig, QUALITY_CONFIG_FILE } from './quality-config.js'
import { reverifyClaims, VERIFICATION_METADATA_FILE } from './quality-claims.js'

export interface PageComment { id: string; path: string; text: string; createdAt: string; proposalId?: string; changeId?: string; hunkId?: string; resolvedAt?: string }
const COMMENTS = '.doxloop/comments.json'
export async function pageComments(root: string): Promise<PageComment[]> {
  try { return JSON.parse(await readFile(await safePath(root, COMMENTS), 'utf8')) as PageComment[] }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
}
export async function savePageComment(root: string, input: { path: string; text: string; proposalId?: string; changeId?: string; hunkId?: string; resolveId?: string }) {
  return withProjectLock(root, 'write', async () => {
    const comments = await pageComments(root)
    if (input.resolveId) {
      const item = comments.find((comment) => comment.id === input.resolveId)
      if (!item) throw new DoxloopError('Comment was not found.')
      item.resolvedAt = new Date().toISOString()
    } else {
      if (!input.text.trim() || input.text.length > 8000) throw new DoxloopError('Write a comment of 1–8000 characters.')
      if (input.proposalId) {
        const run = await readSyncRun(root, input.proposalId)
        const change = run.changes.find((item) => item.id === input.changeId && item.path === input.path)
        if (!change || (input.hunkId && !change.hunks.some((hunk) => hunk.id === input.hunkId))) throw new DoxloopError('Select a valid proposal file or hunk.')
      } else await resolveEditScope(root, await loadProject(root), [input.path], false)
      comments.push({ id: randomUUID(), path: input.path, text: input.text.trim(), createdAt: new Date().toISOString(), ...(input.proposalId ? { proposalId: input.proposalId, changeId: input.changeId! } : {}), ...(input.hunkId ? { hunkId: input.hunkId } : {}) })
    }
    const target = await safePath(root, COMMENTS)
    await mkdir(join(root, '.doxloop'), { recursive: true })
    const temporary = `${target}.${randomUUID()}.tmp`
    await writeFile(temporary, JSON.stringify(comments, null, 2) + '\n', { mode: 0o600 }); await rename(temporary, target)
    return comments
  })
}

export async function searchPageText(root: string, query: string) {
  if (!query.trim()) return []
  const term = query.trim().toLocaleLowerCase().slice(0, 300)
  const project = await loadProject(root)
  const pages = await listPages(root)
  const results: Array<{ path: string; title: string; line: number; section: string; excerpt: string; route: string }> = []
  for (const page of pages) {
    const lines = (await readFile(await safePath(root, page.path), 'utf8')).split('\n')
    let section = page.title
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index]!
      const heading = /^#{1,6}\s+(.+)|<h[1-6][^>]*>(.*?)<\/h[1-6]>/i.exec(line)
      if (heading) section = (heading[1] ?? heading[2]!).replace(/<[^>]+>/g, '')
      if (line.toLocaleLowerCase().includes(term)) results.push({ path: page.path, title: page.title, line: index + 1, section, excerpt: line.trim().slice(0, 240), route: page.route })
      if (results.length >= 200) return results
    }
  }
  return results
}

export async function auditDocumentation(root: string) {
  const project = await loadProject(root)
  const [pages, evidence, drift] = await Promise.all([listPages(root), readEvidenceMap(root), computeDrift(root, project)])
  const nativeFiles = project.generator === 'docusaurus' ? ['versions.json', 'docusaurus.config.js', 'docusaurus.config.ts'] : project.generator === 'mkdocs' ? ['mkdocs.yml', 'mkdocs.yaml'] : []
  const configuration: Array<{ file: string; text: string }> = []
  for (const file of nativeFiles) { try { configuration.push({ file, text: (await readFile(await safePath(root, file), 'utf8')).slice(0, 10000) }) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error } }
  return { generator: project.generator, contentDir: project.contentDir, pages, unmapped: pages.filter((page) => !evidence?.pages[page.path]).map((page) => page.path), unverified: pages.filter((page) => page.evidence !== 'verified').map((page) => page.path), drift, configuration, message: 'Read-only audit. No pages, source baselines, or verification claims were changed. Backfill adds missing pages as unverified; it does not infer source associations.' }
}
export async function backfillEvidence(root: string) {
  return withProjectLock(root, 'write', async () => {
    const map = await readEvidenceMap(root) ?? { schemaVersion: 1 as const, pages: {} }
    const files = await loadPages(root, await loadProject(root))
    for (const file of files) { const path = relative(root, file).replace(/\\/g, '/'); map.pages[path] ??= { sources: [], confidence: 'needs-human' } }
    return applyDirectEdit(root, { kind: 'metadata', requestText: 'Backfilled unverified evidence entries without rewriting documentation', files: [EVIDENCE_MAP_FILE], apply: async () => { await writeFile(await safePath(root, EVIDENCE_MAP_FILE), JSON.stringify(map, null, 2) + '\n') } })
  })
}
export async function readerVerification(root: string, enabled?: boolean) {
  const config = await loadQualityConfig(root)
  if (enabled === undefined) return { enabled: config.readerVerification?.enabled ?? false }
  return applyDirectEdit(root, { kind: 'metadata', requestText: `${enabled ? 'Enabled' : 'Disabled'} reader verification labels`, files: [QUALITY_CONFIG_FILE, VERIFICATION_METADATA_FILE], apply: async () => {
    const current = await loadQualityConfig(root)
    current.readerVerification = { ...current.readerVerification, enabled }
    await writeFile(await safePath(root, QUALITY_CONFIG_FILE), JSON.stringify(current, null, 2) + '\n')
    await reverifyClaims(root, await loadProject(root), true)
  } })
}
export async function authoringEstimate(root: string, pages: number, agent?: string, model?: string) {
  const samples = (await listRequests(root, 200)).filter((run) => run.status === 'completed' && ['create', 'update'].includes(run.kind) && run.durationMs && run.pagesChanged > 0 && (!agent || run.agent === agent) && (!model || run.model === model))
  const rates = samples.map((run) => run.durationMs! / run.pagesChanged / 60000).sort((a, b) => a - b)
  const range = rates.length >= 3 ? { minimumMinutes: Math.ceil(rates[Math.floor((rates.length - 1) * .2)]! * pages), maximumMinutes: Math.ceil(rates[Math.ceil((rates.length - 1) * .8)]! * pages) } : undefined
  return { samples: rates.length, ...(range ? { range } : {}), message: range ? 'Observed 20th–80th percentile duration per changed page, scaled to this batch. Screenshots and source complexity can increase time.' : 'At least three comparable completed runs are needed for an observed time range. Your time limit is a cap, not an estimate.', cost: 'Billing is controlled by your agent provider. Doxloop has no reliable usage-price data for this run.' }
}
