import { loadOpenApiSource } from './openapi.js'
import { QUALITY_CODES } from './quality-contract.js'
import type { DoxloopProject, QualityCheck } from './types.js'

const METHODS = ['get', 'put', 'post', 'delete', 'patch', 'options', 'head', 'trace']

export async function lintSchemas(root: string, project: DoxloopProject): Promise<QualityCheck[]> {
  const sources = project.sources.filter((source) => source.kind === 'openapi')
  if (sources.length === 0) return [{ code: QUALITY_CODES.schemaPassed, category: 'schemas', status: 'pass', message: 'No connector-native schemas require linting.' }]
  const checks: QualityCheck[] = []
  for (const source of sources) {
    try {
      const loaded = await loadOpenApiSource(root, source)
      const document = loaded.document
      const operationIds = new Map<string, string>()
      const rootSecurity = Array.isArray(document.security) && document.security.length > 0
      for (const [path, rawItem] of Object.entries(record(document.paths))) {
        const item = record(rawItem)
        for (const method of METHODS) {
          if (!record(item[method]) || Object.keys(record(item[method])).length === 0) continue
          const operation = record(item[method])
          const location = `${method.toUpperCase()} ${path}`
          const operationId = text(operation.operationId)
          if (!operationId) checks.push(issue(source.path, `${location} should declare operationId.`, 'warning'))
          else if (operationIds.has(operationId)) checks.push(issue(source.path, `${location} duplicates operationId "${operationId}" from ${operationIds.get(operationId)}.`, 'fail'))
          else operationIds.set(operationId, location)
          if (!text(operation.summary) && !text(operation.description)) checks.push(issue(source.path, `${location} needs a summary or description for reader-facing API documentation.`, 'warning'))
          if (Object.keys(record(operation.responses)).length === 0) checks.push(issue(source.path, `${location} must declare at least one response.`, 'fail'))
          if (!rootSecurity && operation.security === undefined) checks.push(issue(source.path, `${location} does not declare an explicit security policy.`, 'warning'))
          for (const reference of references(operation)) {
            if (!reference.startsWith('#/')) checks.push(issue(source.path, `${location} uses unsupported external schema reference ${reference}.`, 'warning'))
            else if (resolvePointer(document, reference) === undefined) checks.push(issue(source.path, `${location} references missing schema ${reference}.`, 'fail'))
          }
        }
      }
      if (!checks.some((check) => check.file === source.path)) checks.push({ code: QUALITY_CODES.schemaPassed, category: 'schemas', status: 'pass', message: `${source.name} passed OpenAPI structural linting.`, file: source.path })
    } catch (error) {
      checks.push(issue(source.path, error instanceof Error ? error.message : String(error), 'fail'))
    }
  }
  return checks
}

function issue(file: string, message: string, status: 'warning' | 'fail'): QualityCheck { return { code: QUALITY_CODES.schemaIssue, category: 'schemas', status, message, file } }
function record(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {} }
function text(value: unknown): string | undefined { return typeof value === 'string' && value.trim() ? value.trim() : undefined }
function references(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(references)
  if (!value || typeof value !== 'object') return []
  return Object.entries(value as Record<string, unknown>).flatMap(([key, item]) => key === '$ref' && typeof item === 'string' ? [item] : references(item))
}
function resolvePointer(document: Record<string, unknown>, pointer: string): unknown {
  let value: unknown = document
  for (const segment of pointer.slice(2).split('/').map((item) => item.replace(/~1/g, '/').replace(/~0/g, '~'))) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
    value = (value as Record<string, unknown>)[segment]
  }
  return value
}
