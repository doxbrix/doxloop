import { readTaggedJson, type TaggedJsonContract } from './agent-reply.js'
import type { AgentName, DocumentationPlan, DocumentationPlanResearch, PlanResearchScope } from './types.js'

/**
 * Request triage: how much research an update request needs, decided before
 * a single research session starts. A one-line request to add icons to the
 * sidebar used to pay the same research bill as a product-wide create run
 * (a product audit, every crawled page of the existing site, an application
 * exploration: five minutes and half a million tokens before planning even
 * began), because the research tasks were chosen from the project
 * configuration alone. Deterministic rules decide the clear cases; a short
 * agent session settles an ambiguous request; and the safe default when
 * nothing is sure is the full research a product-wide update needs.
 */

const NAVIGATION_WORDS = /\b(?:nav|navigation|sidebar|side[- ]?bar|left[- ]nav|menus?|icons?|favicon|logo|brand(?:ing)?|theme|colou?rs?|fonts?|re-?order(?:ing)?|order of|rename|group(?:s|ing)?|top[- ]?nav|header|footer|tabs?|collapse|expand(?:ed)? by default)\b/gi
const CONTENT_WORDS = /\b(?:write|rewrite|explain|describe|content|wording|text|paragraph|examples?|steps?|procedure|tutorial|outdated|incorrect|wrong|inaccurate|typo|clarify|shorten|add (?:a |an |new )?(?:page|section|guide|tutorial|chapter)|new pages?|missing (?:pages?|sections?|docs|documentation|coverage)|coverage|api|endpoints?|reference|feature|screenshots?|troubleshooting|prerequisites?)\b/gi
const PRODUCT_WORDS = /\b(?:all (?:the )?(?:pages|docs|documentation)|every page|whole|entire|everything|refresh|re-?sync|new (?:release|version)|changed since|latest (?:release|version|changes)|comprehensive|audit)\b/gi

const GENERIC_PAGE_NAMES = new Set(['index', 'readme', 'overview', 'introduction', 'intro', 'home', 'docs', 'guide', 'guides', 'reference', 'api', 'page'])

function count(text: string, pattern: RegExp): number {
  return [...text.matchAll(pattern)].length
}

function words(value: string): string {
  return value.toLowerCase().replace(/\.[a-z0-9]+$/i, '').replace(/[^a-z0-9]+/g, ' ').trim()
}

/**
 * Existing pages the request names, matched by their file name ("reverse
 * proxy" names self-hosting/reverse-proxy.mdx) or by their path. Generic
 * file names (index, overview) never count: "the overview" is not a page
 * reference in a request about the overview of the product.
 */
export function citedPages(request: string, existingPages: readonly string[]): string[] {
  const text = ` ${words(request)} `
  if (!text.trim()) return []
  const cited: string[] = []
  for (const page of existingPages) {
    const segments = page.split('/')
    const name = words(segments.at(-1) ?? '')
    const parent = segments.length > 1 ? words(segments.at(-2) ?? '') : ''
    const candidates = [name, parent && name ? `${parent} ${name}` : '', words(page)].filter((candidate) => candidate.length >= 4 && !GENERIC_PAGE_NAMES.has(candidate))
    if (candidates.some((candidate) => text.includes(` ${candidate} `))) cited.push(page)
  }
  return cited
}

/**
 * The deterministic decision, or undefined when the request is ambiguous:
 * navigation vocabulary with no content change is a navigation request;
 * named pages with nothing product-wide is a page request; product-wide
 * vocabulary alone is a product request.
 */
export function triageByRules(request: string, existingPages: readonly string[]): DocumentationPlanResearch | undefined {
  const text = request.trim()
  if (!text) return { scope: 'product', reason: 'The request is empty, so the update is planned from the source changes across the whole product.', pages: [], decidedBy: 'rules' }
  const navigation = count(text, NAVIGATION_WORDS)
  const content = count(text, CONTENT_WORDS)
  const product = count(text, PRODUCT_WORDS)
  const pages = citedPages(text, existingPages)
  if (navigation > 0 && content === 0) {
    return { scope: 'navigation', reason: 'The request is about navigation, icons, branding, or page metadata and asks for no content change, so no source, page, or application research is needed.', pages, decidedBy: 'rules' }
  }
  if (pages.length > 0 && navigation === 0 && product === 0) {
    return { scope: 'pages', reason: `The request names ${pages.length === 1 ? 'one existing page' : `${pages.length} existing pages`} (${pages.slice(0, 4).join(', ')}${pages.length > 4 ? ', …' : ''}), so research covers only the product surface behind ${pages.length === 1 ? 'it' : 'them'}.`, pages, decidedBy: 'rules' }
  }
  if (product > 0 && navigation === 0 && pages.length === 0) {
    return { scope: 'product', reason: 'The request is product-wide, so every research session runs.', pages: [], decidedBy: 'rules' }
  }
  return undefined
}

/** The research a create run always does, and the fallback for an ambiguous update the agent could not settle. */
export function fullResearch(reason: string, decidedBy: DocumentationPlanResearch['decidedBy'] = 'mode'): DocumentationPlanResearch {
  return { scope: 'product', reason, pages: [], decidedBy }
}

export function triagePrompt(current: Pick<DocumentationPlan, 'request'>, existingPages: readonly string[]): string {
  const pageList = existingPages.length > 0 ? existingPages.slice(0, 400).map((page) => `- ${page}`).join('\n') : '- (no existing pages)'
  return `You are the triage step of Doxloop's planning stage. Decide how much research one documentation update request needs. Do not read any file, do not browse, do not plan pages, and do not ask questions: answer from the request and the page list below only.

Update request:
${current.request}

Existing documentation pages (project-relative paths):
${pageList}

Choose exactly one scope:
- "navigation": the request changes only navigation, icons, ordering, group names, branding, theme, or page metadata; no page content changes. Doxloop then reads nothing and works from the current navigation.
- "pages": the request changes the content of specific existing pages you can name from the list (fix, expand, correct, add a section to them). Doxloop then audits only the product surface behind those pages.
- "product": the request is product-wide, adds pages whose subject is not on the list, or depends on what changed in the product. Doxloop then runs the full research (product surface, application, existing documentation).
When in doubt between "pages" and "product", choose "product".

End your reply with exactly one machine-readable block and put nothing after it:
<doxloop-triage>
{ "scope": "navigation | pages | product", "pages": ["paths from the list, only for scope pages"], "reason": "one sentence naming what in the request decided the scope" }
</doxloop-triage>`
}

const SCOPES: PlanResearchScope[] = ['navigation', 'pages', 'product']

const TRIAGE_CONTRACT: TaggedJsonContract = {
  tag: 'doxloop-triage',
  accept: (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value) && SCOPES.includes((value as Record<string, unknown>).scope as PlanResearchScope),
  attempted: (text) => /"scope"\s*:/.test(text),
  noun: 'triage',
}

/** The agent's decision, restricted to pages that exist; undefined when the reply carries none. */
export function readTriageOutput(raw: string, agent: AgentName, existingPages: readonly string[], prompt?: string): DocumentationPlanResearch | undefined {
  let reply
  try {
    reply = readTaggedJson<Record<string, unknown>>(raw, agent, TRIAGE_CONTRACT, prompt)
  } catch {
    return undefined
  }
  if (!reply) return undefined
  const scope = reply.value.scope as PlanResearchScope
  const known = new Set(existingPages)
  const pages = Array.isArray(reply.value.pages) ? reply.value.pages.filter((page): page is string => typeof page === 'string' && known.has(page)) : []
  const reason = typeof reply.value.reason === 'string' && reply.value.reason.trim() ? reply.value.reason.trim().slice(0, 300) : `The triage session chose the ${scope} scope.`
  // A page scope that names no existing page has nothing to focus on.
  if (scope === 'pages' && pages.length === 0) return { scope: 'product', reason: `${reason} No page it named exists, so the full research runs.`, pages: [], decidedBy: 'agent' }
  return { scope, reason, pages: scope === 'pages' ? pages : [], decidedBy: 'agent' }
}

/** One line for the log and the plan review. */
export function describeResearchScope(research: DocumentationPlanResearch): string {
  const what = research.scope === 'navigation'
    ? 'no research: navigation, icons, branding, or metadata only'
    : research.scope === 'pages'
      ? `product research focused on ${research.pages.length} page${research.pages.length === 1 ? '' : 's'}`
      : 'full research'
  const who = research.decidedBy === 'agent' ? 'decided by a triage session' : research.decidedBy === 'rules' ? 'decided from the request' : 'as every create run does'
  return `Research scope: ${what} (${who}). ${research.reason}`
}
