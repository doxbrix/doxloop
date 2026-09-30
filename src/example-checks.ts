/**
 * Tested examples. A reader copies a page's examples before reading its
 * prose, so a request to an endpoint the API does not have, a body the API
 * rejects, or a JSON block that does not parse fails them on the first try.
 * These checks run without an agent:
 *
 * - JSON and YAML blocks must parse.
 * - curl commands and raw HTTP requests aimed at the product's API must name
 *   an operation in its OpenAPI contract, and a JSON body must satisfy the
 *   operation's request schema (required fields, known fields when the schema
 *   closes the object, types, and enums).
 * - Optionally, read-only requests (GET and HEAD) are sent to a test server
 *   and their status compared with what the page expects.
 *
 * Findings are fixable warnings, so the end-of-run fix pass corrects the
 * example from the contract.
 */
import { parse as parseYaml } from 'yaml'
import type { ProjectContract } from './api-contracts.js'
import type { ValidationIssue } from './types.js'

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const
type Method = typeof METHODS[number]

export interface CodeBlock {
  language: string
  code: string
  /** 1-based line of the opening fence in the page. */
  line: number
}

export interface HttpExample {
  method: Method
  /** As written: absolute URL or a path. */
  url: string
  /** Path without query string or fragment. */
  path: string
  host?: string
  headers: Record<string, string>
  body?: string
  /** Status the page says to expect (`# expect-status: 404`), if any. */
  expectStatus?: number
}

const FENCE = /^([ \t]*)(```+|~~~+)[ \t]*([^\s`]*)[^\n]*\n([\s\S]*?)^\1\2[ \t]*$/gm

export function codeBlocks(body: string): CodeBlock[] {
  const blocks: CodeBlock[] = []
  for (const match of body.matchAll(FENCE)) {
    blocks.push({
      language: (match[3] ?? '').toLowerCase().replace(/^\{?\.?/, '').replace(/[,}].*$/, ''),
      code: match[4] ?? '',
      line: body.slice(0, match.index).split('\n').length,
    })
  }
  return blocks
}

/** Placeholder text a writer leaves for the reader to fill in. */
export function isPlaceholder(value: string): boolean {
  return /^<[^>]+>$|^\{\{?[^}]+\}?\}$|^\$\{?[A-Z_][A-Z0-9_]*\}?$|^:[a-z_]+$|^(?:your|my)[-_]|[-_]here$|^x{3,}$|^\.\.\.$|^…$|YOUR_|REPLACE|CHANGEME/i.test(value.trim())
}

/** Split a shell command line into words, honouring quotes and line continuations. */
export function shellWords(command: string): string[] {
  const text = command.replace(/\\\r?\n/g, ' ')
  const words: string[] = []
  let current = ''
  let active = false
  let quote: '"' | "'" | undefined
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!
    if (quote) {
      if (char === quote) { quote = undefined; continue }
      if (char === '\\' && quote === '"' && index + 1 < text.length && '"\\$`'.includes(text[index + 1]!)) { current += text[index + 1]!; index += 1; continue }
      current += char
      continue
    }
    if (char === '"' || char === "'") { quote = char; active = true; continue }
    if (char === '\\' && index + 1 < text.length) { current += text[index + 1]!; index += 1; active = true; continue }
    if (/\s/.test(char)) {
      if (active) { words.push(current); current = ''; active = false }
      if (char === '\n') words.push('\n')
      continue
    }
    if ((char === '|' || char === ';' || char === '&') && !active) { words.push(char); continue }
    current += char
    active = true
  }
  if (active) words.push(current)
  return words
}

function splitUrl(raw: string): { path: string; host?: string } {
  const value = raw.trim()
  const absolute = /^[a-z][a-z0-9+.-]*:\/\//i.exec(value)
  if (absolute) {
    const withoutScheme = value.slice(absolute[0].length)
    const slash = withoutScheme.search(/[/?#]/)
    const host = slash === -1 ? withoutScheme : withoutScheme.slice(0, slash)
    const rest = slash === -1 ? '/' : withoutScheme.slice(slash)
    return { host, path: rest.replace(/[?#].*$/, '') || '/' }
  }
  // `$API_URL/users` or `{{baseUrl}}/users`: the part after the variable is the path.
  const variable = /^(?:\$\{?[A-Za-z_][A-Za-z0-9_]*\}?|\{\{[^}]+\}\}|<[^>]+>)(\/.*)?$/.exec(value)
  if (variable) return { host: '$', path: (variable[1] ?? '/').replace(/[?#].*$/, '') || '/' }
  return { path: value.replace(/[?#].*$/, '') || '/' }
}

function expectedStatus(code: string): number | undefined {
  const match = /(?:#|\/\/)\s*expect(?:ed)?[-_ ]status\s*:?\s*([1-5]\d\d)\b/i.exec(code)
  return match ? Number(match[1]) : undefined
}

/** Every curl invocation in a shell block. */
function curlExamples(code: string): HttpExample[] {
  const words = shellWords(code)
  const examples: HttpExample[] = []
  for (let index = 0; index < words.length; index += 1) {
    if (words[index] !== 'curl') continue
    let method: string | undefined
    let url: string | undefined
    let body: string | undefined
    const headers: Record<string, string> = {}
    let cursor = index + 1
    for (; cursor < words.length; cursor += 1) {
      const word = words[cursor]!
      if (word === '\n' || word === '|' || word === ';' || word === '&') break
      const next = words[cursor + 1]
      const takes = (flag: string) => word === flag || word.startsWith(`${flag}=`)
      const value = (flag: string) => word.startsWith(`${flag}=`) ? word.slice(flag.length + 1) : (cursor += 1, next ?? '')
      if (word === '-X' || takes('--request')) method = value(word === '-X' ? '-X' : '--request').toUpperCase()
      else if (/^-X[A-Z]+$/.test(word)) method = word.slice(2)
      else if (word === '-H' || takes('--header')) {
        const header = value(word === '-H' ? '-H' : '--header')
        const colon = header.indexOf(':')
        if (colon > 0) headers[header.slice(0, colon).trim().toLowerCase()] = header.slice(colon + 1).trim()
      } else if (word === '-d' || takes('--data') || takes('--data-raw') || takes('--data-binary')) {
        const flag = word === '-d' ? '-d' : word.startsWith('--data-raw') ? '--data-raw' : word.startsWith('--data-binary') ? '--data-binary' : '--data'
        body = value(flag)
      } else if (takes('--json')) {
        body = value('--json')
        headers['content-type'] ??= 'application/json'
      } else if (['-u', '--user', '-o', '--output', '-b', '--cookie', '-F', '--form', '-A', '--user-agent', '-e', '--referer', '-m', '--max-time', '--connect-timeout', '-w', '--write-out', '--cacert', '--cert', '-E', '--key', '--retry'].includes(word)) cursor += 1
      else if (!word.startsWith('-') && url === undefined) url = word
      else if (takes('--url')) url = value('--url')
    }
    index = cursor
    if (!url) continue
    const resolved = (method ?? (body !== undefined ? 'POST' : 'GET')) as Method
    if (!METHODS.includes(resolved)) continue
    const parts = splitUrl(url)
    const status = expectedStatus(code)
    examples.push({ method: resolved, url, ...parts, headers, ...(body !== undefined ? { body } : {}), ...(status ? { expectStatus: status } : {}) })
  }
  return examples
}

/** A raw HTTP request: `POST /users HTTP/1.1`, headers, a blank line, and a body. */
function rawHttpExample(code: string): HttpExample | undefined {
  const lines = code.replace(/\r\n/g, '\n').split('\n')
  const first = lines.findIndex((line) => line.trim() !== '' && !line.trim().startsWith('#'))
  if (first === -1) return undefined
  const request = new RegExp(`^(${METHODS.join('|')})\\s+(\\S+)(?:\\s+HTTP\\/[\\d.]+)?\\s*$`).exec(lines[first]!.trim())
  if (!request) return undefined
  const headers: Record<string, string> = {}
  let index = first + 1
  for (; index < lines.length; index += 1) {
    const line = lines[index]!
    if (line.trim() === '') break
    const colon = line.indexOf(':')
    if (colon > 0) headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim()
  }
  const body = lines.slice(index + 1).join('\n').trim()
  let url = request[2]!
  if (!/^[a-z]+:\/\//i.test(url) && headers.host && url.startsWith('/')) url = `https://${headers.host}${url}`
  const status = expectedStatus(code)
  return { method: request[1] as Method, url, ...splitUrl(url), headers, ...(body ? { body } : {}), ...(status ? { expectStatus: status } : {}) }
}

export function httpExamples(block: CodeBlock): HttpExample[] {
  if (['http', 'https', 'rest'].includes(block.language)) {
    const example = rawHttpExample(block.code)
    return example ? [example] : []
  }
  if (['bash', 'sh', 'shell', 'zsh', 'console', 'terminal', 'curl', ''].includes(block.language) && /\bcurl\b/.test(block.code)) {
    return curlExamples(block.code.replace(/^\s*\$\s+/gm, ''))
  }
  return []
}

// ---------------------------------------------------------------------------
// Contract matching

interface Operation {
  contract: ProjectContract
  method: Method
  template: string
  raw: Record<string, unknown>
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function serverBasePaths(contract: ProjectContract): string[] {
  const bases = contract.loaded.summary.servers.map((server) => {
    const { path } = splitUrl(server.replace(/\{[^}]+\}/g, 'x'))
    return path.replace(/\/+$/, '')
  }).filter((path) => path && path !== '/')
  return [...new Set(bases)].sort((left, right) => right.length - left.length)
}

function serverHosts(contract: ProjectContract): string[] {
  return contract.loaded.summary.servers.flatMap((server) => splitUrl(server).host ?? []).map((host) => host.toLowerCase())
}

function operations(contracts: ProjectContract[]): Operation[] {
  const out: Operation[] = []
  for (const contract of contracts) {
    for (const [template, item] of Object.entries(record(contract.loaded.document.paths))) {
      for (const method of METHODS) {
        const raw = record(item)[method.toLowerCase()]
        if (raw && typeof raw === 'object') out.push({ contract, method, template, raw: record(raw) })
      }
    }
  }
  return out
}

function segments(path: string): string[] {
  return path.replace(/\/+$/, '').split('/').filter(Boolean)
}

function segmentMatches(template: string, actual: string): boolean {
  if (/^\{[^}]+\}$/.test(template)) return actual !== ''
  if (isPlaceholder(actual) || /^\{[^}]+\}$/.test(actual)) return /\{[^}]+\}/.test(template)
  return template.toLowerCase() === decodeURIComponentSafe(actual).toLowerCase()
}

function decodeURIComponentSafe(value: string): string {
  try { return decodeURIComponent(value) } catch { return value }
}

function pathMatches(template: string, path: string): boolean {
  const expected = segments(template)
  const actual = segments(path)
  return expected.length === actual.length && expected.every((segment, index) => segmentMatches(segment, actual[index]!))
}

/** The example's path with any server base path removed, most specific base first. */
function candidatePaths(example: HttpExample, contract: ProjectContract): string[] {
  const paths = [example.path]
  for (const base of serverBasePaths(contract)) {
    if (example.path === base || example.path.startsWith(`${base}/`)) paths.push(example.path.slice(base.length) || '/')
  }
  // `/api/v1/users` against a contract whose paths omit an undeclared prefix.
  const parts = segments(example.path)
  for (let drop = 1; drop <= Math.min(2, parts.length - 1); drop += 1) paths.push(`/${parts.slice(drop).join('/')}`)
  return [...new Set(paths)]
}

/**
 * Whether an example talks to the product's API rather than a third-party
 * service (GitHub, Stripe) a page also shows: a relative path, a variable
 * base URL, a local or example host, or one of the contract's servers.
 */
function aimsAtProduct(example: HttpExample, contracts: ProjectContract[]): boolean {
  const host = example.host?.toLowerCase()
  if (!host || host === '$') return true
  if (/^(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?$/.test(host) || /(?:^|\.)example\.(?:com|org|net)(?::\d+)?$/.test(host) || isPlaceholder(host) || /[<{$]/.test(host)) return true
  return contracts.some((contract) => serverHosts(contract).some((server) => server === host || server.replace(/:\d+$/, '') === host.replace(/:\d+$/, '')))
}

export interface OperationMatch {
  operation?: Operation
  /** Methods the contract has for the matched path, when the method itself is missing. */
  otherMethods?: Method[]
  /** A similar operation to suggest when nothing matched. */
  suggestion?: string
}

export function matchOperation(example: HttpExample, contracts: ProjectContract[]): OperationMatch {
  const all = operations(contracts)
  const samePath: Operation[] = []
  for (const operation of all) {
    if (!candidatePaths(example, operation.contract).some((path) => pathMatches(operation.template, path))) continue
    if (operation.method === example.method) return { operation }
    samePath.push(operation)
  }
  if (samePath.length > 0) return { otherMethods: [...new Set(samePath.map((operation) => operation.method))] }
  const last = segments(example.path).filter((segment) => !isPlaceholder(segment)).at(-1)?.toLowerCase()
  const similar = last ? all.find((operation) => operation.method === example.method && segments(operation.template).some((segment) => segment.toLowerCase() === last)) : undefined
  return similar ? { suggestion: `${similar.method} ${similar.template}` } : {}
}

// ---------------------------------------------------------------------------
// Request body schema

interface SchemaProblem {
  path: string
  message: string
}

function resolveRef(document: Record<string, unknown>, schema: unknown, depth = 0): Record<string, unknown> {
  let current = record(schema)
  for (let hops = 0; typeof current.$ref === 'string' && hops < 10 && depth < 20; hops += 1) {
    const ref = current.$ref as string
    if (!ref.startsWith('#/')) return {}
    let target: unknown = document
    for (const part of ref.slice(2).split('/')) target = record(target)[part.replace(/~1/g, '/').replace(/~0/g, '~')]
    current = record(target)
  }
  return current
}

/** Merge `allOf` members; `oneOf`/`anyOf` are too open to judge and end the check at that node. */
function effectiveSchema(document: Record<string, unknown>, schema: unknown): Record<string, unknown> | undefined {
  const resolved = resolveRef(document, schema)
  if (Array.isArray(resolved.oneOf) || Array.isArray(resolved.anyOf) || resolved.not) return undefined
  if (!Array.isArray(resolved.allOf)) return resolved
  const merged: Record<string, unknown> = { ...resolved, properties: { ...record(resolved.properties) }, required: [...(Array.isArray(resolved.required) ? resolved.required : [])] }
  delete merged.allOf
  for (const member of resolved.allOf as unknown[]) {
    const part = effectiveSchema(document, member)
    if (!part) return undefined
    Object.assign(merged.properties as Record<string, unknown>, record(part.properties))
    if (Array.isArray(part.required)) (merged.required as unknown[]).push(...part.required)
    if (part.type && !merged.type) merged.type = part.type
    if (part.additionalProperties === false) merged.additionalProperties = false
  }
  return merged
}

function typeOf(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number'
  return typeof value
}

function typeAllowed(schema: Record<string, unknown>, actual: string): boolean {
  const types = Array.isArray(schema.type) ? schema.type as string[] : typeof schema.type === 'string' ? [schema.type] : []
  if (types.length === 0) return true
  if (actual === 'null' && (schema.nullable === true || types.includes('null'))) return true
  if (actual === 'integer' && types.includes('number')) return true
  return types.includes(actual)
}

export function schemaProblems(document: Record<string, unknown>, schema: unknown, value: unknown, path = '', depth = 0): SchemaProblem[] {
  if (depth > 6) return []
  const effective = effectiveSchema(document, schema)
  if (!effective || Object.keys(effective).length === 0) return []
  const problems: SchemaProblem[] = []
  const actual = typeOf(value)
  const label = path || 'the body'
  if (typeof value === 'string' && isPlaceholder(value)) return []
  if (!typeAllowed(effective, actual)) {
    problems.push({ path: label, message: `${label} is ${actual === 'integer' || actual === 'number' ? 'a number' : `a${/^[aeiou]/.test(actual) ? 'n' : ''} ${actual}`}; the contract expects ${Array.isArray(effective.type) ? (effective.type as string[]).join(' or ') : String(effective.type)}` })
    return problems
  }
  if (Array.isArray(effective.enum) && !effective.enum.some((item) => JSON.stringify(item) === JSON.stringify(value))) {
    problems.push({ path: label, message: `${label} is ${JSON.stringify(value)}; the contract allows ${effective.enum.slice(0, 8).map((item) => JSON.stringify(item)).join(', ')}` })
  }
  if (actual === 'object') {
    const object = value as Record<string, unknown>
    const properties = record(effective.properties)
    for (const name of Array.isArray(effective.required) ? effective.required as string[] : []) {
      if (!(name in object)) problems.push({ path: path ? `${path}.${name}` : name, message: `${path ? `${path}.` : ''}${name} is required by the contract but missing` })
    }
    for (const [name, child] of Object.entries(object)) {
      const childPath = path ? `${path}.${name}` : name
      if (name in properties) problems.push(...schemaProblems(document, properties[name], child, childPath, depth + 1))
      else if (effective.additionalProperties === false && Object.keys(properties).length > 0) problems.push({ path: childPath, message: `${childPath} is not a field the contract accepts (it has ${Object.keys(properties).slice(0, 8).join(', ')})` })
    }
  }
  if (actual === 'array' && effective.items) {
    for (const [index, item] of (value as unknown[]).slice(0, 5).entries()) problems.push(...schemaProblems(document, effective.items, item, `${path || 'body'}[${index}]`, depth + 1))
  }
  return problems
}

function jsonRequestSchema(operation: Operation): unknown {
  const content = record(record(resolveRef(operation.contract.loaded.document, operation.raw.requestBody)).content)
  const json = Object.entries(content).find(([type]) => /json/i.test(type))
  if (json) return record(json[1]).schema
  // Swagger 2.0: a body parameter.
  const parameter = (Array.isArray(operation.raw.parameters) ? operation.raw.parameters : [])
    .map((item) => resolveRef(operation.contract.loaded.document, item))
    .find((item) => item.in === 'body')
  return parameter?.schema
}

// ---------------------------------------------------------------------------
// Static checks

/** Relaxed JSON a docs page may legitimately show: comments, trailing commas, and `...` elisions. */
function relaxedJsonParses(code: string): boolean {
  const relaxed = code
    .replace(/("(?:[^"\\]|\\.)*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (_match, string: string | undefined) => string ?? '')
    .replace(/,(\s*[}\]])/g, '$1')
  try { JSON.parse(relaxed); return true } catch { return false }
}

function hasElision(code: string): boolean {
  return /(?:^|[\s,[{])(?:\.\.\.|…)(?:[\s,\]}]|$)/.test(code) || /<[^>\n]+>/.test(code) || /\{\{[^}]+\}\}/.test(code)
}

function parseJsonBody(body: string): { ok: true; value: unknown } | { ok: false } {
  try { return { ok: true, value: JSON.parse(body) } } catch { return { ok: false } }
}

function issue(code: string, file: string, line: number, message: string): ValidationIssue {
  return { severity: 'warning', code, file, message: `Line ${line}: ${message}` }
}

/**
 * The static example checks for one page. `contracts` may be empty, which
 * leaves only the JSON and YAML syntax checks.
 */
export function exampleIssues(body: string, file: string, contracts: ProjectContract[]): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  for (const block of codeBlocks(body)) {
    if ((block.language === 'json' || block.language === 'json5') && block.code.trim()) {
      if (block.language === 'json' && !hasElision(block.code) && !relaxedJsonParses(block.code)) {
        issues.push(issue('example-invalid-json', file, block.line, 'this JSON example does not parse, so a reader who copies it gets a syntax error. Fix the syntax (quotes, commas, brackets) or mark omitted parts with a comment.'))
      }
      continue
    }
    if ((block.language === 'yaml' || block.language === 'yml') && block.code.trim() && !/\{\{|\{%/.test(block.code)) {
      try { parseYaml(block.code) } catch (cause) {
        issues.push(issue('example-invalid-yaml', file, block.line, `this YAML example does not parse (${String(cause instanceof Error ? cause.message : cause).split('\n')[0]}). Fix the indentation or syntax so a reader can use it as shown.`))
      }
      continue
    }
    if (contracts.length === 0) continue
    for (const example of httpExamples(block)) {
      if (!aimsAtProduct(example, contracts)) continue
      const match = matchOperation(example, contracts)
      if (!match.operation) {
        issues.push(issue('example-unknown-endpoint', file, block.line, match.otherMethods
          ? `the example sends ${example.method} ${example.path}, but the API contract has only ${match.otherMethods.join(', ')} for that path. Use the contract's method.`
          : `the example calls ${example.method} ${example.path}, which is not in the API contract${match.suggestion ? ` (the closest operation is ${match.suggestion})` : ''}. Use the contract's path, or remove the example if the operation does not exist.`))
        continue
      }
      if (!example.body || hasElision(example.body)) continue
      const schema = jsonRequestSchema(match.operation)
      if (!schema) continue
      const parsed = parseJsonBody(example.body)
      if (!parsed.ok) {
        if (/^\s*[[{]/.test(example.body)) issues.push(issue('example-invalid-json', file, block.line, `the JSON body of ${example.method} ${example.path} does not parse, so the request fails before it reaches the API.`))
        continue
      }
      const problems = schemaProblems(match.operation.contract.loaded.document, schema, parsed.value).slice(0, 4)
      if (problems.length > 0) {
        issues.push(issue('example-schema-mismatch', file, block.line, `the body of ${example.method} ${match.operation.template} does not match the contract's request schema: ${problems.map((problem) => problem.message).join('; ')}. Correct the example from the contract.`))
      }
    }
  }
  return issues
}

// ---------------------------------------------------------------------------
// Live checks

export type ExampleOutcome = 'passed' | 'failed' | 'needs-sign-in' | 'unreachable' | 'skipped'

export interface ExampleResult {
  line: number
  method: string
  url: string
  outcome: ExampleOutcome
  status?: number
  expected?: string
  detail?: string
}

/**
 * Send a page's read-only requests to `baseUrl` and compare the status with
 * what the page expects. Requests with a body or a method that changes data
 * are never sent. Placeholder credentials are dropped, so an endpoint that
 * needs sign-in reports `needs-sign-in` rather than failing.
 */
export async function runPageExamples(body: string, baseUrl: string, contracts: ProjectContract[], options: { fetch?: typeof fetch; timeoutMs?: number } = {}): Promise<ExampleResult[]> {
  const send = options.fetch ?? fetch
  const base = new URL(baseUrl)
  const results: ExampleResult[] = []
  for (const block of codeBlocks(body)) {
    for (const example of httpExamples(block)) {
      if (!aimsAtProduct(example, contracts)) continue
      const target = liveUrl(example, base)
      if (example.method !== 'GET' && example.method !== 'HEAD') {
        results.push({ line: block.line, method: example.method, url: example.url, outcome: 'skipped', detail: 'Only read-only requests are sent; this one would change data.' })
        continue
      }
      if (!target) {
        results.push({ line: block.line, method: example.method, url: example.url, outcome: 'skipped', detail: 'The path has placeholders a test cannot fill in.' })
        continue
      }
      const headers = Object.fromEntries(Object.entries(example.headers).filter(([name, value]) => !isPlaceholder(value.replace(/^(?:Bearer|Basic|Token)\s+/i, '')) && !/^(?:host|content-length)$/i.test(name) && !/\$|<|\{\{/.test(value)))
      const expected = example.expectStatus
      try {
        const response = await send(target, { method: example.method, headers, redirect: 'manual', signal: AbortSignal.timeout(options.timeoutMs ?? 10_000) })
        const status = response.status
        await response.body?.cancel().catch(() => undefined)
        const ok = expected ? status === expected : status >= 200 && status < 400
        const outcome: ExampleOutcome = ok ? 'passed' : (status === 401 || status === 403) && !expected ? 'needs-sign-in' : 'failed'
        results.push({
          line: block.line,
          method: example.method,
          url: target,
          outcome,
          status,
          expected: expected ? String(expected) : '2xx or 3xx',
          ...(outcome === 'needs-sign-in' ? { detail: 'The API asked for credentials; the example cannot be checked without them.' } : {}),
        })
      } catch (cause) {
        results.push({ line: block.line, method: example.method, url: target, outcome: 'unreachable', detail: cause instanceof Error ? cause.message : String(cause) })
      }
    }
  }
  return results
}

/** The example's request against the test server, or undefined when a placeholder is left in the path. */
function liveUrl(example: HttpExample, base: URL): string | undefined {
  if (segments(example.path).some((segment) => isPlaceholder(segment) || /^\{[^}]+\}$/.test(segment))) return undefined
  const query = /\?[^#\s]*/.exec(example.url)?.[0] ?? ''
  if (/[<{$]/.test(query)) return undefined
  const basePath = base.pathname.replace(/\/+$/, '')
  const path = basePath && !example.path.startsWith(`${basePath}/`) ? `${basePath}${example.path}` : example.path
  return `${base.origin}${path}${query}`
}
