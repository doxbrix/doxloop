import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { loadPages, loadSiteConfig, readPage, relativePath } from './project.js'
import { QUALITY_CODES } from './quality-contract.js'
import type { DoxbrixNavNode, DoxloopProject, QualityCheck, QualityConfig } from './types.js'

const MISSPELLINGS: Record<string, string> = {
  accomodate: 'accommodate',
  occured: 'occurred',
  recieve: 'receive',
  seperate: 'separate',
  teh: 'the',
  untill: 'until',
}

export async function lintDocumentation(root: string, project: DoxloopProject, config: QualityConfig): Promise<QualityCheck[]> {
  const checks: QualityCheck[] = []
  const paragraphs = new Map<string, string[]>()
  const maximumTitle = config.lint?.maximumTitleLength ?? 72
  for (const path of await loadPages(root, project)) {
    const file = relativePath(root, path)
    const page = await readPage(path)
    if (page.title.length > maximumTitle) checks.push(lint(file, `Title is ${page.title.length} characters; the configured maximum is ${maximumTitle}.`))
    const prose = page.body.replace(/```[\s\S]*?```/g, '').replace(/<[^>]+>/g, ' ')
    for (const [misspelling, replacement] of Object.entries(MISSPELLINGS)) {
      if (new RegExp(`\\b${misspelling}\\b`, 'i').test(prose)) checks.push(lint(file, `Possible spelling error: use "${replacement}" instead of "${misspelling}".`, true))
    }
    for (const [term, preferred] of Object.entries(project.documentation.terminology)) {
      if (term.toLowerCase() === preferred.toLowerCase() || preferred.length > 60) continue
      if (new RegExp(`\\b${escapeRegExp(term)}\\b`, 'i').test(prose) && !new RegExp(escapeRegExp(preferred), 'i').test(prose)) checks.push(lint(file, `Terminology guidance prefers "${preferred}" where "${term}" is used.`))
    }
    const sentences = prose.split(/[.!?]+(?:\s|$)/).map((item) => item.trim()).filter((item) => item.split(/\s+/).length >= 4)
    const long = sentences.filter((item) => item.split(/\s+/).length > 35)
    if (long.length > Math.max(1, sentences.length / 4)) checks.push(lint(file, `${long.length} sentences exceed 35 words; shorten them for easier scanning.`))
    for (const paragraph of prose.split(/\n\s*\n/).map(normalizeParagraph).filter((item) => item.length >= 100)) {
      const files = paragraphs.get(paragraph) ?? []
      files.push(file); paragraphs.set(paragraph, files)
    }
  }
  for (const files of paragraphs.values()) if (new Set(files).size > 1) checks.push(lint([...new Set(files)].join(', '), 'Substantial duplicate prose appears across multiple pages.'))
  if (project.generator === 'doxbrix') {
    const site = await loadSiteConfig(root, project)
    const maximum = config.lint?.maximumNavigationLabelLength ?? 42
    for (const label of navigationLabels(site.spaces.flatMap((space) => space.nav))) if (label.length > maximum) checks.push(lint(join(project.contentDir, 'docs.json'), `Navigation label "${label}" is ${label.length} characters; the configured maximum is ${maximum}.`))
  }
  return checks.length > 0 ? checks : [{ code: QUALITY_CODES.lintPassed, category: 'lint', status: 'pass', message: 'Documentation linting found no terminology, duplication, spelling, readability, title, or navigation-label issues.' }]
}

export async function fixDocumentation(root: string, project: DoxloopProject): Promise<{ changed: string[] }> {
  const changed: string[] = []
  for (const path of await loadPages(root, project)) {
    const original = await readFile(path, 'utf8')
    let next = normalizeLocalLinks(original.replace(/[ \t]+$/gm, ''))
    next = addFenceLanguages(next)
    next = repairSingleHeadingJumps(next)
    if (!next.endsWith('\n')) next += '\n'
    if (next !== original) { await writeFile(path, next, 'utf8'); changed.push(relativePath(root, path)) }
  }
  return { changed }
}

function addFenceLanguages(value: string): string {
  const lines = value.split('\n')
  let insideFence = false
  for (let index = 0; index < lines.length; index += 1) {
    const fence = /^```(.*)$/.exec(lines[index] ?? '')
    if (!fence) continue
    if (!insideFence && fence[1]?.trim() === '') {
      const sample = lines[index + 1]?.trim() ?? ''
      const language = /^\s*(?:\{|\[)/.test(sample) ? 'json' : /^(?:npm|pnpm|yarn|npx|curl|git|doxloop)\b/.test(sample) ? 'bash' : /^(?:const|let|var|import|export|function)\b/.test(sample) ? 'javascript' : ''
      if (language) lines[index] = `\`\`\`${language}`
    }
    insideFence = !insideFence
  }
  return lines.join('\n')
}

function repairSingleHeadingJumps(value: string): string {
  let previous = 0
  let insideFence = false
  return value.split('\n').map((line) => {
    if (/^```/.test(line)) { insideFence = !insideFence; return line }
    if (insideFence) return line
    const match = /^(#{1,6})(\s+\S.*)$/.exec(line)
    if (!match) return line
    let level = match[1]!.length
    if (previous > 0 && level > previous + 1) level = previous + 1
    previous = level
    return `${'#'.repeat(level)}${match[2]}`
  }).join('\n')
}

function normalizeLocalLinks(value: string): string {
  let insideFence = false
  return value.split('\n').map((line) => {
    if (/^```/.test(line)) { insideFence = !insideFence; return line }
    if (insideFence) return line
    return line.replace(/\]\(\.\/([^)]*)\)/g, ']($1)').replace(/\]\(([^)]*\\[^)]*)\)/g, (_all, target: string) => `](${target.replace(/\\/g, '/')})`)
  }).join('\n')
}

function navigationLabels(nodes: DoxbrixNavNode[]): string[] { return nodes.flatMap((node) => node.type === 'group' ? [node.label, ...navigationLabels(node.items)] : node.type === 'label' ? [node.text] : node.type === 'page' && node.title ? [node.title] : node.type === 'link' || node.type === 'api' ? [node.title] : []) }
function lint(file: string, message: string, fixable = false): QualityCheck { return { code: QUALITY_CODES.lintIssue, category: 'lint', status: 'warning', message, file, ...(fixable ? { fixable: true } : {}) } }
function normalizeParagraph(value: string): string { return value.toLowerCase().replace(/\s+/g, ' ').trim() }
function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }
