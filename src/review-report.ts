import { randomBytes } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AgentName, DocumentationReviewFinding, DocumentationReviewReport, ReviewFindingSeverity } from './types.js'

const REVIEW_DIRECTORY = join('.doxloop', 'reviews')

export async function persistReviewReport(root: string, output: string, execution: { agent: AgentName; model?: string; reasoning?: string }): Promise<DocumentationReviewReport> {
  const parsed = parseReviewReport(output)
  const report: DocumentationReviewReport = {
    schemaVersion: 1,
    id: `review-${Date.now()}-${randomBytes(3).toString('hex')}`,
    createdAt: new Date().toISOString(),
    agent: execution.agent,
    ...(execution.model ? { model: execution.model } : {}),
    ...(execution.reasoning ? { reasoning: execution.reasoning } : {}),
    ...parsed,
  }
  const directory = join(root, REVIEW_DIRECTORY)
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, `${report.id}.json`), `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  return report
}

export async function listReviewReports(root: string): Promise<DocumentationReviewReport[]> {
  let entries
  try { entries = await readdir(join(root, REVIEW_DIRECTORY), { withFileTypes: true }) } catch { return [] }
  const reports: DocumentationReviewReport[] = []
  for (const entry of entries) {
    if (!entry.isFile() || !/^review-[a-z0-9-]+\.json$/.test(entry.name)) continue
    try {
      const raw = JSON.parse(await readFile(join(root, REVIEW_DIRECTORY, entry.name), 'utf8')) as unknown
      if (isReviewReport(raw)) reports.push(raw)
    } catch { /* A damaged operational report does not hide other reviews. */ }
  }
  return reports.sort((left, right) => right.createdAt.localeCompare(left.createdAt))
}

export function parseReviewReport(output: string): Pick<DocumentationReviewReport, 'score' | 'hardGates' | 'summary' | 'findings'> {
  const structured = /<doxloop-review>\s*([\s\S]*?)\s*<\/doxloop-review>/i.exec(output)?.[1]
  if (structured) {
    try {
      const raw = JSON.parse(structured) as Record<string, unknown>
      const findings = Array.isArray(raw.findings) ? raw.findings.flatMap(normalizeFinding).slice(0, 50) : []
      return { score: boundedScore(raw.score), hardGates: gate(raw.hardGates), summary: text(raw.summary) || summaryFromOutput(output), findings }
    } catch { /* Fall through to the safe Markdown parser. */ }
  }
  const scoreMatch = /(?:quality|rubric|overall)?\s*score[^\d]{0,20}(\d{1,3})(?:\s*\/\s*100|%)/i.exec(output)
  const gateMatch = /hard[- ]?gates?[^\n]*(pass|fail)/i.exec(output)?.[1]?.toLowerCase()
  const findings = output.split(/\r?\n/).flatMap((line, index) => {
    const match = /^\s*(?:[-*]|\d+\.)\s*(?:(blocker|major|minor)\s*[:—-]\s*)?(.{12,})$/i.exec(line)
    if (!match?.[2]) return []
    const severity = (match[1]?.toLowerCase() ?? inferSeverity(match[2])) as ReviewFindingSeverity
    return [{ id: `finding-${index + 1}`, severity, title: match[2].slice(0, 120), description: match[2], pages: pageReferences(match[2]), evidence: [], recommendation: match[2] } satisfies DocumentationReviewFinding]
  }).slice(0, 50)
  return { score: scoreMatch ? boundedScore(Number(scoreMatch[1])) : 0, hardGates: gateMatch === 'pass' ? 'pass' : gateMatch === 'fail' ? 'fail' : 'unknown', summary: summaryFromOutput(output), findings }
}

function normalizeFinding(value: unknown, index: number): DocumentationReviewFinding[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return []
  const raw = value as Record<string, unknown>
  const title = text(raw.title)
  if (!title) return []
  return [{ id: text(raw.id) || `finding-${index + 1}`, severity: severity(raw.severity), title, description: text(raw.description) || title, pages: textList(raw.pages), evidence: textList(raw.evidence), recommendation: text(raw.recommendation) || title }]
}

function summaryFromOutput(output: string): string {
  const line = output.split(/\r?\n/).map((item) => item.replace(/^#+\s*/, '').trim()).find((item) => item.length >= 20 && !item.startsWith('{') && !item.startsWith('<'))
  return line?.slice(0, 500) ?? 'The review completed without a structured summary.'
}
function pageReferences(value: string): string[] { return [...new Set(value.match(/[\w./-]+\.(?:md|mdx|rst|html)/gi) ?? [])] }
function inferSeverity(value: string): ReviewFindingSeverity { return /block|critical|security|broken/i.test(value) ? 'blocker' : /missing|incorrect|major|stale/i.test(value) ? 'major' : 'minor' }
function severity(value: unknown): ReviewFindingSeverity { return value === 'blocker' || value === 'major' ? value : 'minor' }
function boundedScore(value: unknown): number { const number = typeof value === 'number' ? value : Number(value); return Number.isFinite(number) ? Math.max(0, Math.min(100, Math.round(number))) : 0 }
function gate(value: unknown): DocumentationReviewReport['hardGates'] { return value === 'pass' || value === 'fail' ? value : 'unknown' }
function text(value: unknown): string { return typeof value === 'string' ? value.trim() : '' }
function textList(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim() !== '').map((item) => item.trim()) : [] }

function isReviewReport(value: unknown): value is DocumentationReviewReport {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const report = value as Partial<DocumentationReviewReport>
  return report.schemaVersion === 1 && typeof report.id === 'string' && typeof report.createdAt === 'string' && typeof report.agent === 'string' && typeof report.score === 'number' && ['pass', 'fail', 'unknown'].includes(report.hardGates ?? '') && typeof report.summary === 'string' && Array.isArray(report.findings)
}
