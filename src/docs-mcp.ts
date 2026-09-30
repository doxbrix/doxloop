/**
 * `doxloop mcp`: a local Model Context Protocol server over stdio that lets a
 * coding assistant (Claude Code, Codex, Cursor) search and read this
 * project's documentation. JSON-RPC 2.0, one message per line, hand-rolled so
 * the CLI needs no extra dependency. stdout carries protocol messages only;
 * everything else goes to stderr.
 */

import { stat } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import type { Readable, Writable } from 'node:stream'
import { readDocsSite, type DocsPage, type DocsSite } from './llms-output.js'
import { loadPages, loadProject, siteConfigPath } from './project.js'
import { VERSION } from './version.js'

export const MCP_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const
const LATEST_PROTOCOL_VERSION = MCP_PROTOCOL_VERSIONS[0]
const SEARCH_LIMIT_DEFAULT = 8
const SEARCH_LIMIT_MAX = 25

type JsonRpcId = string | number | null
interface JsonRpcRequest { jsonrpc: '2.0'; id?: JsonRpcId; method: string; params?: unknown }
export interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: JsonRpcId
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

class RpcError extends Error {
  constructor(readonly code: number, message: string) { super(message) }
}

const TOOLS = [
  {
    name: 'search_docs',
    title: 'Search documentation',
    description: 'Search the documentation by keywords. Returns the best-matching pages with their route and a snippet around the match. Use get_page with a route to read a page in full.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Words to look for, for example "rotate API key".' },
        limit: { type: 'integer', minimum: 1, maximum: SEARCH_LIMIT_MAX, description: `Maximum results (default ${SEARCH_LIMIT_DEFAULT}).` },
      },
      required: ['query'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'get_page',
    title: 'Read a documentation page',
    description: 'Read one documentation page as clean Markdown. Pass the route from list_pages or search_docs (for example "/guides/install"), or the page\'s source file path.',
    inputSchema: {
      type: 'object',
      properties: {
        route: { type: 'string', description: 'Public route of the page, for example "/guides/install".' },
        path: { type: 'string', description: 'Source file of the page relative to the project, for example "guides/install.mdx".' },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'list_pages',
    title: 'List documentation pages',
    description: 'List every documentation page in navigation order with its title, route, section, and description.',
    inputSchema: {
      type: 'object',
      properties: {
        section: { type: 'string', description: 'Only list pages in this navigation section (case-insensitive).' },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
] as const

/** Build the message handler for one project. Exported for tests; the CLI wires it to stdio. */
export function createDocsMcpHandler(root: string): (message: unknown) => Promise<JsonRpcResponse | undefined> {
  const docs = docsCache(root)
  return async (message) => {
    if (!isRecord(message) || message.jsonrpc !== '2.0') {
      return failure(isRecord(message) && isId(message.id) ? message.id : null, -32600, 'Invalid JSON-RPC 2.0 message.')
    }
    // A response from the client (we send no requests) or a notification needs no reply.
    if (typeof message.method !== 'string') return undefined
    const request = message as unknown as JsonRpcRequest
    const notification = !('id' in message) || message.id === undefined
    if (!notification && !isId(message.id)) return failure(null, -32600, 'Request id must be a string or number.')
    try {
      const result = await dispatch(request, docs)
      return notification ? undefined : { jsonrpc: '2.0', id: request.id ?? null, result }
    } catch (error) {
      if (notification) return undefined
      if (error instanceof RpcError) return failure(request.id ?? null, error.code, error.message)
      return failure(request.id ?? null, -32603, error instanceof Error ? error.message : String(error))
    }
  }
}

async function dispatch(request: JsonRpcRequest, docs: () => Promise<SearchableSite>): Promise<unknown> {
  switch (request.method) {
    case 'initialize': {
      const params = isRecord(request.params) ? request.params : {}
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : ''
      // A page that cannot be read now must not stop the client from connecting.
      const site = await docs().catch(() => undefined)
      const title = site?.title ?? 'project'
      const count = site ? ` (${site.pages.length} page${site.pages.length === 1 ? '' : 's'})` : ''
      return {
        protocolVersion: (MCP_PROTOCOL_VERSIONS as readonly string[]).includes(requested) ? requested : LATEST_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'doxloop-docs', title: `${title} documentation`, version: VERSION },
        instructions: `This server serves the "${title}" documentation${count} straight from the local Doxloop project, including edits that are not published yet. Use search_docs to find the pages that answer a question, get_page to read one in full as Markdown, and list_pages to browse the structure. Prefer these pages over guessing how the product works.`,
      }
    }
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return {}
    case 'ping':
      return {}
    case 'tools/list':
      return { tools: TOOLS }
    case 'tools/call': {
      const params = isRecord(request.params) ? request.params : undefined
      if (!params || typeof params.name !== 'string') throw new RpcError(-32602, 'tools/call needs a tool name.')
      if (params.arguments !== undefined && !isRecord(params.arguments)) throw new RpcError(-32602, 'Tool arguments must be an object.')
      return callTool(params.name, (params.arguments as Record<string, unknown> | undefined) ?? {}, await docs())
    }
    default:
      if (request.method.startsWith('notifications/')) return {}
      throw new RpcError(-32601, `Method not found: ${request.method}`)
  }
}

function callTool(name: string, args: Record<string, unknown>, site: SearchableSite): unknown {
  switch (name) {
    case 'list_pages': {
      const section = optionalString(args.section, 'section')
      const pages = site.pages.filter((page) => !section || page.section.toLowerCase() === section.toLowerCase())
      if (pages.length === 0) {
        const sections = [...new Set(site.pages.map((page) => page.section))]
        return toolText(section ? `No pages in section "${section}". Sections: ${sections.join(', ')}.` : 'This documentation has no pages yet.', Boolean(section))
      }
      const lines: string[] = [`# ${site.title}`, '']
      let current: string | undefined
      for (const page of pages) {
        if (page.section !== current) {
          current = page.section
          lines.push('', `## ${current}`, '')
        }
        lines.push(`- ${page.title} (${page.route})${page.description ? `: ${page.description}` : ''}`)
      }
      return toolText(`${lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`)
    }
    case 'search_docs': {
      const query = requiredString(args.query, 'query')
      const limit = args.limit === undefined ? SEARCH_LIMIT_DEFAULT : integer(args.limit, 'limit', 1, SEARCH_LIMIT_MAX)
      const results = searchDocs(site, query, limit)
      if (results.length === 0) return toolText(`No pages match "${query}". Try other words, or list_pages to browse.`)
      return toolText(results.map((result, index) => `${index + 1}. ${result.page.title} (${result.page.route})${result.page.section ? ` · ${result.page.section}` : ''}\n   ${result.snippet}`).join('\n\n'))
    }
    case 'get_page': {
      const route = optionalString(args.route, 'route')
      const path = optionalString(args.path, 'path')
      if (!route && !path) throw new RpcError(-32602, 'get_page needs a route or a path.')
      const page = findPage(site.pages, route, path)
      if (!page) return toolText(`No page matches ${route ? `route "${route}"` : `path "${path}"`}. Use list_pages or search_docs to find the route.`, true)
      return toolText(`# ${page.title}\n\nRoute: ${page.route}\nSource: ${page.path}${page.description ? `\n\n> ${page.description}` : ''}\n\n${stripTitle(page.markdown, page.title).trim()}\n`)
    }
    default:
      throw new RpcError(-32602, `Unknown tool: ${name}`)
  }
}

export interface SearchResult { page: DocsPage; score: number; snippet: string }

interface IndexedPage { page: DocsPage; terms: Map<string, number>; length: number }
interface SearchableSite extends DocsSite { index: IndexedPage[]; averageLength: number }

/**
 * BM25 over each page's title, headings, and body. Field weights repeat the
 * term (title ×3, headings ×2) so a page named after the query ranks above a
 * page that merely mentions it.
 */
export function searchDocs(site: DocsSite, query: string, limit = SEARCH_LIMIT_DEFAULT): SearchResult[] {
  const searchable = 'index' in site ? site as SearchableSite : indexSite(site)
  const queryTerms = [...new Set(tokenize(query))]
  if (queryTerms.length === 0) return []
  const total = searchable.index.length
  const k1 = 1.2
  const b = 0.75
  const phrase = query.trim().toLowerCase()
  const scored = searchable.index.map((entry) => {
    let score = 0
    for (const term of queryTerms) {
      const frequency = entry.terms.get(term) ?? 0
      if (!frequency) continue
      const documents = searchable.index.filter((candidate) => candidate.terms.has(term)).length
      const idf = Math.log(1 + (total - documents + 0.5) / (documents + 0.5))
      score += idf * (frequency * (k1 + 1)) / (frequency + k1 * (1 - b + b * entry.length / (searchable.averageLength || 1)))
    }
    if (score > 0 && phrase.length > 2 && entry.page.title.toLowerCase().includes(phrase)) score *= 1.5
    return { entry, score }
  })
  return scored
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.entry.page.route.localeCompare(right.entry.page.route))
    .slice(0, limit)
    .map((item) => ({ page: item.entry.page, score: Math.round(item.score * 1000) / 1000, snippet: snippet(item.entry.page, queryTerms) }))
}

function indexSite(site: DocsSite): SearchableSite {
  const pages = site.pages.filter((page) => page.primary)
  const index = pages.map((page) => {
    const terms = new Map<string, number>()
    const add = (text: string, weight: number): number => {
      const tokens = tokenize(text)
      for (const token of tokens) terms.set(token, (terms.get(token) ?? 0) + weight)
      return tokens.length
    }
    add(page.title, 3)
    add(page.description ?? '', 2)
    add(headings(page.markdown).join(' '), 2)
    const length = add(page.markdown, 1)
    return { page, terms, length }
  })
  const averageLength = index.reduce((sum, entry) => sum + entry.length, 0) / (index.length || 1)
  return { ...site, index, averageLength }
}

const STOP_WORDS = new Set(['a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'do', 'for', 'from', 'how', 'i', 'in', 'is', 'it', 'of', 'on', 'or', 'the', 'to', 'what', 'with', 'you', 'your'])

function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [])
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token))
    .map(stem)
}

/** Enough stemming that "keys" finds "key" and "deploying" finds "deploy". */
function stem(token: string): string {
  if (token.length > 5 && token.endsWith('ing')) return token.slice(0, -3)
  if (token.length > 4 && token.endsWith('ies')) return `${token.slice(0, -3)}y`
  if (token.length > 4 && token.endsWith('es') && /(?:ch|sh|ss|x|z)es$/.test(token)) return token.slice(0, -2)
  if (token.length > 3 && token.endsWith('s') && !token.endsWith('ss')) return token.slice(0, -1)
  if (token.length > 4 && token.endsWith('ed')) return token.slice(0, -2)
  if (token.length > 4 && token.endsWith('e')) return token.slice(0, -1)
  return token
}

function headings(markdown: string): string[] {
  return [...markdown.matchAll(/^#{1,6}\s+(.+)$/gm)].map((match) => match[1]!)
}

/** The paragraph that holds the most query terms, trimmed around the first match. */
function snippet(page: DocsPage, queryTerms: string[]): string {
  // Headings are already in the result's title; the snippet should show prose.
  const paragraphs = page.markdown.split(/\n\s*\n/).filter((paragraph) => !/^\s*#/.test(paragraph)).map((paragraph) => paragraph.replace(/\s+/g, ' ').trim()).filter(Boolean)
  let best = page.description ?? paragraphs[0] ?? ''
  let bestScore = 0
  for (const paragraph of paragraphs) {
    const tokens = new Set(tokenize(paragraph))
    const score = queryTerms.filter((term) => tokens.has(term)).length
    if (score > bestScore) { best = paragraph; bestScore = score }
  }
  const width = 240
  if (best.length <= width) return best
  const lower = best.toLowerCase()
  const first = queryTerms.map((term) => lower.indexOf(term)).filter((position) => position >= 0).sort((left, right) => left - right)[0] ?? 0
  const start = Math.max(0, Math.min(first - 60, best.length - width))
  return `${start > 0 ? '…' : ''}${best.slice(start, start + width).trim()}${start + width < best.length ? '…' : ''}`
}

function findPage(pages: DocsPage[], route: string | undefined, path: string | undefined): DocsPage | undefined {
  if (route) {
    let wanted = route.trim()
    try { if (/^https?:\/\//i.test(wanted)) wanted = new URL(wanted).pathname } catch { /* Treat it as a route. */ }
    wanted = normalizeRoute(wanted.replace(/\.md$/i, ''))
    const match = pages.find((page) => normalizeRoute(page.route) === wanted)
      ?? pages.find((page) => normalizeRoute(page.route.replace(/\.html?$/i, '')) === wanted)
      ?? pages.find((page) => `/${page.markdownFile.replace(/\.md$/i, '')}` === wanted || (wanted === '/' && page.markdownFile === 'index.md'))
    if (match) return match
  }
  if (path) {
    const wanted = path.trim().replace(/\\/g, '/').replace(/^\.?\/+/, '')
    return pages.find((page) => page.path === wanted)
      ?? pages.find((page) => page.path.replace(/\.[^./]+$/, '') === wanted.replace(/\.[^./]+$/, ''))
      ?? pages.find((page) => page.path.endsWith(`/${wanted}`))
  }
  return undefined
}

function normalizeRoute(route: string): string {
  return `/${route.split(/[?#]/)[0]!.replace(/^\/+|\/+$/g, '')}`.replace(/\/index$/, '') || '/'
}

function stripTitle(markdown: string, title: string): string {
  const match = /^\s*#\s+(.+)\n/.exec(markdown)
  return match && match[1]!.trim().toLowerCase() === title.trim().toLowerCase() ? markdown.slice(match[0].length) : markdown
}

/**
 * Read the documentation once, then again only when a page file or the
 * navigation changed, so an assistant always sees the latest edits.
 */
function docsCache(root: string): () => Promise<SearchableSite> {
  let cached: { signature: string; site: SearchableSite } | undefined
  return async () => {
    const signature = await docsSignature(root)
    if (cached?.signature === signature) return cached.site
    const site = indexSite(await readDocsSite(root))
    cached = { signature, site }
    return site
  }
}

async function docsSignature(root: string): Promise<string> {
  const project = await loadProject(root)
  const files = await loadPages(root, project)
  if (project.generator === 'doxbrix') files.push(await siteConfigPath(root, project))
  const stamps = await Promise.all(files.map(async (file) => {
    try { const info = await stat(file); return `${file}:${info.mtimeMs}:${info.size}` } catch { return `${file}:missing` }
  }))
  return stamps.join('\n')
}

/** Serve the MCP protocol over stdio until the client closes stdin. */
export async function startDocsMcpServer(root: string, io: { input: Readable; output: Writable } = { input: process.stdin, output: process.stdout }): Promise<void> {
  // Any stray console output would corrupt the protocol stream.
  const restore = { log: console.log, info: console.info, debug: console.debug }
  const toStderr = (...values: unknown[]): void => { process.stderr.write(`${values.map(String).join(' ')}\n`) }
  const stdio = io.output === process.stdout
  if (stdio) { console.log = toStderr; console.info = toStderr; console.debug = toStderr }
  const handle = createDocsMcpHandler(root)
  const lines = createInterface({ input: io.input, crlfDelay: Infinity })
  const write = (message: unknown): void => { io.output.write(`${JSON.stringify(message)}\n`) }
  if (stdio) process.stderr.write(`doxloop mcp: serving documentation from ${root}\n`)
  try {
    for await (const line of lines) {
      if (!line.trim()) continue
      let message: unknown
      try {
        message = JSON.parse(line)
      } catch {
        write(failure(null, -32700, 'Parse error: each message must be one line of JSON.'))
        continue
      }
      if (Array.isArray(message)) {
        const replies = (await Promise.all(message.map(handle))).filter(Boolean)
        if (replies.length) write(replies)
        continue
      }
      const reply = await handle(message)
      if (reply) write(reply)
    }
  } finally {
    Object.assign(console, restore)
  }
}

function toolText(text: string, isError = false): unknown {
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) }
}

function failure(id: JsonRpcId, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } }
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new RpcError(-32602, `"${name}" must be a non-empty string.`)
  return value.trim()
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new RpcError(-32602, `"${name}" must be a string.`)
  return value.trim() || undefined
}

function integer(value: unknown, name: string, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RpcError(-32602, `"${name}" must be an integer from ${minimum} to ${maximum}.`)
  }
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isId(value: unknown): value is string | number {
  return typeof value === 'string' || typeof value === 'number'
}
