import { parse as parseYaml } from 'yaml'

interface PageFile {
  path: string
  markdown: string
}

interface SourceFile {
  path: string
  content: string
}

interface OperationRef {
  source?: string
  method: string
  path: string
}

export interface MaterializedOpenApiNavigation {
  groups: Array<{
    label: string
    items: Array<{ file: string; title: string; operation: string }>
  }>
  pages: PageFile[]
}

type Obj = Record<string, unknown>

const OPENAPI_NAME_RE = /(?:^|\/)(?:openapi|swagger)(?:[-_.][^/]*)?\.(?:json|ya?ml)$/i
const SPEC_EXT_RE = /\.(?:json|ya?ml)$/i
const NON_SPEC_RE = /(?:^|\/)(?:docs|mint|package(?:-lock)?|tsconfig|manifest)\.json$/i

function record(value: unknown): Obj {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Obj : {}
}

function normalizePath(path: string): string {
  const out: string[] = []
  for (const part of path.replace(/\\/g, '/').replace(/^\/+/, '').split('/')) {
    if (!part || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return out.join('/')
}

function frontmatterScalar(markdown: string, key: string): string | undefined {
  const head = /^---\s*\r?\n([\s\S]*?)\r?\n---/.exec(markdown)?.[1]
  if (!head) return undefined
  const match = new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\s*(.*?)\\s*$`, 'm').exec(head)
  if (!match?.[1]) return undefined
  const raw = match[1].trim()
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1)
  }
  return raw
}

function parseOperationRef(value: string): OperationRef | null {
  const match = /^(?:(\S+)\s+)?(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|TRACE)\s+(\/\S*)$/i.exec(value.trim())
  if (!match) return null
  return {
    ...(match[1] ? { source: match[1] } : {}),
    method: match[2]!.toUpperCase(),
    path: match[3]!,
  }
}

function parseSpec(text: string): Obj | null {
  try {
    const parsed = JSON.parse(text) as unknown
    return record(parsed)
  } catch {
    try {
      return record(parseYaml(text))
    } catch {
      return null
    }
  }
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'api'
}

const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace'])

/** Expand one OpenAPI document into editable endpoint pages grouped by the
 * first operation tag, matching Mintlify's generated reference navigation. */
export function materializeOpenApiNavigationDocument(params: {
  text: string
  title: string
  usedFiles?: Set<string>
  fallbackBaseUrl?: string
}): MaterializedOpenApiNavigation | null {
  const spec = parseSpec(params.text)
  if (!spec || (typeof spec.openapi !== 'string' && typeof spec.swagger !== 'string')) return null

  const usedFiles = params.usedFiles ?? new Set<string>()
  const groups = new Map<string, Array<{ file: string; title: string; operation: string }>>()
  const pages: PageFile[] = []

  for (const [path, rawPathItem] of Object.entries(record(spec.paths))) {
    const pathItem = record(rawPathItem)
    for (const [rawMethod, rawOperation] of Object.entries(pathItem)) {
      const method = rawMethod.toLowerCase()
      if (!HTTP_METHODS.has(method)) continue
      const operation = record(rawOperation)
      if (!Object.keys(operation).length) continue

      const endpoint = operationMdx(spec, { method: method.toUpperCase(), path }, params.fallbackBaseUrl)
      if (!endpoint) continue
      const tag = Array.isArray(operation.tags)
        ? operation.tags.map((value) => typeof value === 'string' ? value.trim() : '').find(Boolean) ?? 'Other'
        : 'Other'
      const operationKey = typeof operation.operationId === 'string' && operation.operationId.trim()
        ? operation.operationId.trim()
        : `${method}-${path}`
      const base = `__openapi__/${slug(params.title)}/${slug(tag)}/${slug(operationKey)}`
      let file = base
      let suffix = 2
      while (usedFiles.has(file)) file = `${base}-${suffix++}`
      usedFiles.add(file)

      const item = { file, title: endpoint.title, operation: `${method.toUpperCase()} ${path}` }
      const items = groups.get(tag) ?? []
      items.push(item)
      groups.set(tag, items)
      pages.push({
        path: `${file}.mdx`,
        markdown: `${frontmatterWithDefaults('', endpoint.title, endpoint.description)}${endpoint.markdown}\n`,
      })
    }
  }

  if (!pages.length) return null
  return {
    groups: [...groups].map(([label, items]) => ({ label, items })),
    pages,
  }
}

function resolveRef(spec: Obj, value: unknown): Obj {
  const source = record(value)
  const ref = typeof source.$ref === 'string' ? source.$ref : ''
  if (!ref.startsWith('#/')) return source
  let current: unknown = spec
  for (const encoded of ref.slice(2).split('/')) {
    const part = encoded.replace(/~1/g, '/').replace(/~0/g, '~')
    current = record(current)[part]
  }
  return { ...record(current), ...Object.fromEntries(Object.entries(source).filter(([key]) => key !== '$ref')) }
}

function schemaType(spec: Obj, raw: unknown): string {
  const schema = resolveRef(spec, raw)
  const rawType = schema.type
  const types = Array.isArray(rawType) ? rawType.map(String).filter((type) => type !== 'null') : []
  const type = types[0] ?? (typeof rawType === 'string' ? rawType : schema.properties ? 'object' : 'string')
  if (type === 'array') return `${schemaType(spec, schema.items)}[]`
  return typeof schema.format === 'string' ? `${type}<${schema.format}>` : type
}

function exampleValue(spec: Obj, raw: unknown, depth = 0): unknown {
  if (depth > 4) return null
  const schema = resolveRef(spec, raw)
  if (schema.example !== undefined) return schema.example
  if (schema.default !== undefined) return schema.default
  const rawType = schema.type
  const types = Array.isArray(rawType) ? rawType.map(String).filter((type) => type !== 'null') : []
  const type = types[0] ?? (typeof rawType === 'string' ? rawType : schema.properties ? 'object' : 'string')
  if (type === 'object' || schema.properties) {
    const out: Obj = {}
    for (const [key, value] of Object.entries(record(schema.properties))) {
      out[key] = exampleValue(spec, value, depth + 1)
    }
    return out
  }
  if (type === 'array') return [exampleValue(spec, schema.items, depth + 1)]
  if (type === 'boolean') return false
  if (type === 'integer' || type === 'number') return 0
  return '<string>'
}

function attr(value: unknown): string {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function body(value: unknown): string {
  return String(value ?? '').replace(/<\/?(?:ApiEndpoint|Param|Response)\b/gi, '')
}

function proseBody(value: unknown): string {
  return body(value).replace(/\s+/g, ' ').trim()
}

function operationMdx(
  spec: Obj,
  operationRef: OperationRef,
  fallbackBaseUrl?: string,
  requestExamples: string[] = [],
): { markdown: string; title: string; description: string } | null {
  const pathItem = record(record(spec.paths)[operationRef.path])
  const operation = record(pathItem[operationRef.method.toLowerCase()])
  if (!Object.keys(operation).length) return null

  const specServer = record(Array.isArray(spec.servers) ? spec.servers[0] : undefined).url
  const baseUrl = typeof specServer === 'string' ? specServer : fallbackBaseUrl ?? ''
  const summary = typeof operation.summary === 'string' ? operation.summary : `${operationRef.method} ${operationRef.path}`
  const description = typeof operation.description === 'string' ? operation.description : ''
  const lines = [
    `<ApiEndpoint method="${attr(operationRef.method)}" path="${attr(operationRef.path)}"${baseUrl ? ` baseUrl="${attr(baseUrl)}"` : ''} summary="${attr(summary)}"${description ? ` description="${attr(description)}"` : ''}>`,
    ...requestExamples,
  ]

  const parameters = [
    ...(Array.isArray(pathItem.parameters) ? pathItem.parameters : []),
    ...(Array.isArray(operation.parameters) ? operation.parameters : []),
  ]
  for (const rawParam of parameters) {
    const param = resolveRef(spec, rawParam)
    const name = typeof param.name === 'string' ? param.name : ''
    if (!name) continue
    const schema = param.schema
    const example = param.example ?? record(schema).example
    lines.push(`<Param name="${attr(name)}" in="${attr(param.in ?? 'query')}" type="${attr(schemaType(spec, schema))}"${param.required === true ? ' required' : ''}${example !== undefined ? ` example="${attr(example)}"` : ''}>${proseBody(param.description)}</Param>`)
  }

  const requestBody = resolveRef(spec, operation.requestBody)
  const requestContent = record(requestBody.content)
  const requestType = Object.keys(requestContent)[0]
  const requestSchema = resolveRef(spec, record(requestContent[requestType ?? '']).schema)
  const required = new Set(Array.isArray(requestSchema.required) ? requestSchema.required.map(String) : [])
  for (const [name, rawProperty] of Object.entries(record(requestSchema.properties))) {
    const property = resolveRef(spec, rawProperty)
    const example = property.example ?? property.default ?? exampleValue(spec, property)
    const exampleText = typeof example === 'string' ? example : JSON.stringify(example)
    lines.push(`<Param name="${attr(name)}" in="body" type="${attr(schemaType(spec, property))}"${required.has(name) ? ' required' : ''}${exampleText !== undefined ? ` example="${attr(exampleText)}"` : ''}>${proseBody(property.description)}</Param>`)
  }

  for (const [status, rawResponse] of Object.entries(record(operation.responses))) {
    const response = resolveRef(spec, rawResponse)
    const content = record(response.content)
    const contentType = Object.keys(content)[0] ?? 'application/json'
    const media = record(content[contentType])
    const example = media.example ?? exampleValue(spec, media.schema)
    const exampleText = example === undefined ? '' : JSON.stringify(example, null, 2)
    lines.push(`<Response status="${attr(status)}" contentType="${attr(contentType)}" description="${attr(response.description ?? '')}">${body(exampleText)}</Response>`)
  }

  lines.push('</ApiEndpoint>')
  return {
    markdown: lines.join('\n'),
    title: summary,
    description: description || `${operationRef.method} ${operationRef.path}`,
  }
}

function frontmatterWithDefaults(frontmatter: string, title: string, description: string): string {
  if (!frontmatter) {
    return `---\ntitle: ${JSON.stringify(title)}\ndescription: ${JSON.stringify(description)}\n---\n`
  }
  const closing = frontmatter.lastIndexOf('---')
  if (closing < 3) return frontmatter
  let additions = ''
  if (!frontmatterScalar(frontmatter, 'title')) additions += `title: ${JSON.stringify(title)}\n`
  if (!frontmatterScalar(frontmatter, 'description')) additions += `description: ${JSON.stringify(description)}\n`
  return additions ? `${frontmatter.slice(0, closing)}${additions}${frontmatter.slice(closing)}` : frontmatter
}

/** Remove page-level Mintlify example blocks so they can travel with the
 * generated endpoint instead of rendering as unrelated full-width content. */
function pluckComponentBlocks(markdown: string, name: string): { markdown: string; blocks: string[] } {
  const blocks: string[] = []
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(
    `^[ \\t]*<${escapedName}\\b(?:[^>"']|"[^"]*"|'[^']*')*>[\\s\\S]*?^[ \\t]*<\\/${escapedName}>[ \\t]*(?:\\r?\\n|$)`,
    'gmi',
  )
  const remaining = markdown.replace(pattern, (block) => {
    blocks.push(block.trim())
    return ''
  })
  return { markdown: remaining.replace(/^\s+/, '').replace(/\n{3,}/g, '\n\n'), blocks }
}

/** Add portable native endpoint components to Mintlify pages whose frontmatter
 * selects an OpenAPI operation. The source frontmatter and custom page prose are
 * retained so the output remains editable and round-trippable. */
export function materializeMintlifyOpenApiPages(params: {
  pages: PageFile[]
  files: SourceFile[]
  configuredSources?: string[]
  fallbackBaseUrl?: string
}): PageFile[] {
  const byPath = new Map(params.files.map((file) => [normalizePath(file.path), file.content]))
  const repoPaths = [...byPath.keys()]
  const parsed = new Map<string, Obj | null>()
  const load = (rawSource: string): Obj | null => {
    if (/^https?:\/\//i.test(rawSource)) return null
    const source = normalizePath(rawSource)
    if (parsed.has(source)) return parsed.get(source) ?? null
    const document = byPath.has(source) ? parseSpec(byPath.get(source)!) : null
    parsed.set(source, document)
    return document
  }
  // Mintlify repositories frequently keep one domain spec at paths such as
  // `hris/api-reference/hris.json`. Discover by document shape instead of by
  // filename or directory depth; ordinary JSON/YAML configuration is ignored.
  const discovered = repoPaths.filter((path) => {
    if (!SPEC_EXT_RE.test(path) || NON_SPEC_RE.test(path)) return false
    const spec = load(path)
    return Boolean(spec && (typeof spec.openapi === 'string' || typeof spec.swagger === 'string') && Object.keys(record(spec.paths)).length > 0)
  })
  const conventional = repoPaths.filter((path) => OPENAPI_NAME_RE.test(path))
  const defaultSources = [...new Set([...(params.configuredSources ?? []), ...conventional, ...discovered])]

  return params.pages.map((page) => {
    const selector = frontmatterScalar(page.markdown, 'openapi')
    const operationRef = selector ? parseOperationRef(selector) : null
    if (!operationRef) return page
    for (const source of operationRef.source ? [operationRef.source] : defaultSources) {
      const spec = load(source)
      if (!spec) continue
      const frontmatter = /^---\s*\r?\n[\s\S]*?\r?\n---\s*\r?\n?/.exec(page.markdown)?.[0] ?? ''
      const pageBody = page.markdown.slice(frontmatter.length).trimStart()
      const extracted = pluckComponentBlocks(pageBody, 'RequestExample')
      const endpoint = operationMdx(spec, operationRef, params.fallbackBaseUrl, extracted.blocks)
      if (!endpoint) continue
      // The OpenAPI operation is the primary content on a Mintlify endpoint
      // page. Keep it first, with authored request examples attached to it;
      // detailed prose remains below the interactive reference.
      return {
        ...page,
        markdown: `${frontmatterWithDefaults(frontmatter, endpoint.title, endpoint.description)}${endpoint.markdown}${extracted.markdown ? `\n\n${extracted.markdown.trimEnd()}` : ''}\n`,
      }
    }
    return page
  })
}
