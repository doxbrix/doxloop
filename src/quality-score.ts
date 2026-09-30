/**
 * A measured documentation quality score. The authoring skill's review
 * rubric weighs accuracy, task completion, structure, clarity, examples,
 * accessibility, and maintainability out of 100; an agent applying it grades
 * its own work. This scores the same categories from what Doxloop can check
 * without an agent — validation, the evidence map and claim checks, example
 * checks, reader walkthroughs, source drift, and screenshot checks — and
 * every point lost names the page and the finding behind it.
 *
 * A category scores the share of the pages it applies to that pass it. The
 * score does not read prose for meaning; the walkthrough is the check that
 * does, and its results count when a page has one.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { contradictedClaimIssues } from './claim-evidence.js'
import { computeDrift } from './drift.js'
import { readEvidenceMap } from './evidence.js'
import { listPages } from './pages.js'
import { loadProject } from './project.js'
import { readWalkthroughs } from './reader-walkthrough.js'
import { readDriftReport } from './screenshot-drift.js'
import type { ValidationIssue } from './types.js'
import { validateProject } from './validation.js'

export type QualityCategoryId = 'accuracy' | 'tasks' | 'structure' | 'clarity' | 'examples' | 'accessibility' | 'freshness'

export interface QualityFinding {
  file?: string
  code: string
  message: string
}

export interface QualityCategory {
  id: QualityCategoryId
  label: string
  /** What the category measures, for the reader of the score. */
  measures: string
  max: number
  score: number
  /** Pages the category applies to, and how many of them pass. */
  total: number
  passing: number
  findings: QualityFinding[]
}

export interface QualityScore {
  measuredAt: string
  pages: number
  score: number
  band: 'release-ready' | 'usable' | 'revise'
  /** Validation errors, which block publishing whatever the score. */
  blocking: number
  categories: QualityCategory[]
  /** Pages with the most findings, worst first. */
  worstPages: Array<{ file: string; findings: number; categories: QualityCategoryId[] }>
}

const ACCURACY_CODES = new Set(['hedged-wording', 'claim-contradicted', 'evidence-unverified', 'evidence-map-missing-page', 'evidence-map-unknown-source', 'evidence-verification-expired', 'unresolved-placeholder', 'starter-content', 'sensitive-content', 'private-path'])
const TASK_CODES = new Set(['thin-page', 'thin-procedure', 'missing-next-step', 'missing-diagram', 'empty-page'])
const STRUCTURE_CODES = new Set(['broken-link', 'invalid-link', 'missing-page', 'unnavigated-page', 'duplicate-navigation', 'single-page-group', 'thin-space', 'generic-space-name', 'duplicate-page-name', 'missing-title', 'missing-description', 'code-fence', 'component-tag', 'self-close'])
const CLARITY_CODES = new Set(['generic-opening', 'minimizing-language', 'heading-case', 'future-tense', 'weak-link-text'])
const EXAMPLE_CODES = new Set(['example-invalid-json', 'example-invalid-yaml', 'example-unknown-endpoint', 'example-schema-mismatch', 'shell-readonly-variable', 'code-language', 'api-endpoint-missing', 'api-endpoint-param-example', 'api-endpoint-description', 'api-endpoint-response-metadata'])
const ACCESSIBILITY_CODES = new Set(['missing-image-alt', 'empty-image-alt', 'heading-order'])

function categoryOf(code: string): QualityCategoryId | undefined {
  if (ACCURACY_CODES.has(code)) return 'accuracy'
  if (TASK_CODES.has(code)) return 'tasks'
  if (STRUCTURE_CODES.has(code) || /^navigation-/.test(code)) return 'structure'
  if (CLARITY_CODES.has(code)) return 'clarity'
  if (EXAMPLE_CODES.has(code) || code.startsWith('api-endpoint-')) return 'examples'
  if (ACCESSIBILITY_CODES.has(code)) return 'accessibility'
  return undefined
}

const PROCEDURAL = /(?:^|\/)(?:guides?|how-?to|tutorials?|getting-started|quick-?start|install|setup)(?:\/|[-.])/i

function round(value: number): number {
  return Math.round(value * 10) / 10
}

export function band(score: number): QualityScore['band'] {
  return score >= 90 ? 'release-ready' : score >= 80 ? 'usable' : 'revise'
}

/**
 * Score a set of pages from their findings. Split out so the arithmetic can
 * be tested without a project on disk.
 */
export function scoreFindings(input: {
  pages: Array<{ path: string; procedural: boolean; hasEvidence: boolean; hasExamples: boolean }>
  findings: QualityFinding[]
  /** Walkthrough scores (0–100) by page. */
  walkthroughs?: Map<string, number>
  /** Pages the source changed under since they were last verified. */
  stalePages?: Set<string>
  /** Screenshots whose screen changed, by the page that shows them. */
  changedScreenshots?: QualityFinding[]
}): Omit<QualityScore, 'measuredAt'> {
  const pages = input.pages
  const byPage = new Map<string, QualityFinding[]>()
  for (const finding of input.findings) if (finding.file) byPage.set(finding.file, [...(byPage.get(finding.file) ?? []), finding])
  const failing = (page: string, category: QualityCategoryId) => (byPage.get(page) ?? []).some((finding) => categoryOf(finding.code) === category)
  const findingsFor = (category: QualityCategoryId) => input.findings.filter((finding) => categoryOf(finding.code) === category)

  const share = (applicable: string[], passes: (page: string) => number) => {
    if (applicable.length === 0) return { total: 0, passing: 0, ratio: 1 }
    const scores = applicable.map(passes)
    return { total: applicable.length, passing: scores.filter((value) => value >= 1).length, ratio: scores.reduce((sum, value) => sum + value, 0) / applicable.length }
  }
  const all = pages.map((page) => page.path)
  const category = (id: QualityCategoryId, label: string, measures: string, max: number, result: { total: number; passing: number; ratio: number }, findings: QualityFinding[]): QualityCategory => ({
    id, label, measures, max, score: round(max * result.ratio), total: result.total, passing: result.passing, findings,
  })

  const accuracy = share(all, (page) => {
    const entry = pages.find((item) => item.path === page)!
    return entry.hasEvidence && !failing(page, 'accuracy') ? 1 : 0
  })
  const missingEvidence = pages.filter((page) => !page.hasEvidence).map((page): QualityFinding => ({ file: page.path, code: 'no-evidence', message: 'The page has no evidence record, so nothing ties it to the source.' }))
  const procedural = pages.filter((page) => page.procedural).map((page) => page.path)
  const tasks = share(procedural, (page) => {
    const walkthrough = input.walkthroughs?.get(page)
    const structural = failing(page, 'tasks') ? 0 : 1
    return walkthrough === undefined ? structural : Math.min(structural, walkthrough / 100)
  })
  const walkthroughFindings = [...(input.walkthroughs ?? new Map<string, number>())].filter(([, value]) => value < 90).map(([file, value]): QualityFinding => ({ file, code: 'walkthrough', message: `A first-time reader scored this page ${value}/100.` }))
  const withExamples = pages.filter((page) => page.hasExamples).map((page) => page.path)
  const freshness = share(all, (page) => (input.stalePages?.has(page) || (input.changedScreenshots ?? []).some((finding) => finding.file === page) ? 0 : 1))
  const staleFindings = [...(input.stalePages ?? new Set<string>())].map((file): QualityFinding => ({ file, code: 'stale', message: 'The source it cites changed since the page was last verified.' }))

  const categories: QualityCategory[] = [
    category('accuracy', 'Accuracy and evidence', 'Pages tied to their sources, with no contradicted claim, guesswork, or placeholder.', 30, accuracy, [...missingEvidence, ...findingsFor('accuracy')]),
    category('tasks', 'Task completion', 'Guides with every part of a procedure and a next step, and what a first-time reader managed in a walkthrough.', 20, tasks, [...findingsFor('tasks'), ...walkthroughFindings]),
    category('structure', 'Structure and navigation', 'Pages that are titled, described, in the navigation, and free of broken links.', 15, share(all, (page) => failing(page, 'structure') ? 0 : 1), findingsFor('structure')),
    category('clarity', 'Clarity and style', 'Pages that follow the editorial standard: outcome-first openings, sentence-case headings, present tense, no "simply".', 10, share(all, (page) => failing(page, 'clarity') ? 0 : 1), findingsFor('clarity')),
    category('examples', 'Examples and reference', 'Pages with examples whose code parses, whose requests match the API contract, and whose endpoints are complete.', 10, share(withExamples, (page) => failing(page, 'examples') ? 0 : 1), findingsFor('examples')),
    category('accessibility', 'Accessibility', 'Pages with alternative text for every image and headings in order.', 10, share(all, (page) => failing(page, 'accessibility') ? 0 : 1), findingsFor('accessibility')),
    category('freshness', 'Freshness', 'Pages whose sources and screenshots have not changed since they were last checked.', 5, freshness, [...staleFindings, ...(input.changedScreenshots ?? [])]),
  ]
  // Findings without a page (site navigation, configuration) still cost structure points.
  const siteWide = input.findings.filter((finding) => !finding.file && categoryOf(finding.code) === 'structure').length
  const structure = categories.find((item) => item.id === 'structure')!
  structure.score = round(Math.max(0, structure.score - Math.min(structure.max / 3, siteWide)))

  const score = Math.round(categories.reduce((sum, item) => sum + item.score, 0))
  const worstPages = [...byPage.entries()]
    .map(([file, findings]) => {
      const counted = findings.filter((finding) => categoryOf(finding.code))
      return { file, findings: counted.length, categories: [...new Set(counted.flatMap((finding) => categoryOf(finding.code) ?? []))] }
    })
    .filter((page) => page.categories.length > 0)
    .sort((left, right) => right.findings - left.findings || left.file.localeCompare(right.file))
    .slice(0, 8)
  return { pages: pages.length, score, band: band(score), blocking: 0, categories, worstPages }
}

export async function measureQuality(root: string): Promise<QualityScore> {
  const project = await loadProject(root)
  const [validation, pages, map, walkthroughs, drift, screenshots] = await Promise.all([
    validateProject(root),
    listPages(root),
    readEvidenceMap(root),
    readWalkthroughs(root),
    computeDrift(root, project).catch(() => undefined),
    readDriftReport(root),
  ])
  const files = pages.map((page) => page.path)
  const claims = await contradictedClaimIssues(root, project, files).catch((): ValidationIssue[] => [])
  const findings: QualityFinding[] = [...validation.issues, ...claims].map((issue) => ({ ...(issue.file ? { file: issue.file } : {}), code: issue.code, message: issue.message }))
  const summaries = await Promise.all(pages.map(async (page) => {
    const raw = await readFile(join(root, page.path), 'utf8').catch(() => '')
    return {
      path: page.path,
      procedural: PROCEDURAL.test(page.path) || /<Steps?\b/.test(raw),
      hasEvidence: Boolean(map?.pages[page.path]?.sources.length),
      hasExamples: /^(?:```|~~~)/m.test(raw) || /<ApiEndpoint\b/.test(raw),
    }
  }))
  const latest = new Map<string, number>()
  for (const report of Object.values(walkthroughs).sort((left, right) => left.checkedAt.localeCompare(right.checkedAt))) {
    for (const page of report.pages) latest.set(page, report.score)
  }
  const changedScreenshots = (screenshots?.results ?? []).filter((result) => result.outcome === 'changed').flatMap((result): QualityFinding[] => {
    // The ledger names the guide by plan page; match it to the page file that embeds it.
    const page = pages.find((item) => item.path.replace(/\.[^.]+$/, '').endsWith(result.page)) ?? undefined
    return [{ ...(page ? { file: page.path } : {}), code: 'screenshot-changed', message: `The screen in ${result.file} changed in the application.` }]
  })
  const scored = scoreFindings({
    pages: summaries,
    findings,
    walkthroughs: latest,
    stalePages: new Set((drift?.pages ?? []).map((page) => page.page)),
    changedScreenshots,
  })
  return { measuredAt: new Date().toISOString(), ...scored, blocking: validation.issues.filter((issue) => issue.severity === 'error').length }
}
