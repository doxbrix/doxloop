/**
 * API contract coverage for Doxbrix sites.
 *
 * A RealWorld run documented 14 of the contract's 19 operations with an
 * `<ApiEndpoint>` block; login, registration, article deletion, and the two
 * favorite operations were written as curl walkthroughs on how-to pages, so
 * the published reference had no "Try it" entry for them and nothing flagged
 * the gap. The end-of-run check now names each contract operation without a
 * reference block and hands it to the page that already talks about it.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { discoverDocumentationSources } from './source-discovery.js'
import type { ValidationIssue } from './types.js'

const ENDPOINT_TAG = /<ApiEndpoint\b([^>]*)>/g

/** `METHOD /path` for every `<ApiEndpoint>` block in a page. */
export function documentedOperations(content: string): string[] {
  const found: string[] = []
  for (const match of content.matchAll(ENDPOINT_TAG)) {
    const method = /\bmethod=["']([A-Za-z]+)["']/.exec(match[1]!)?.[1]
    const path = /\bpath=["']([^"']+)["']/.exec(match[1]!)?.[1]
    if (method && path) found.push(`${method.toUpperCase()} ${normalizePath(path)}`)
  }
  return found
}

/**
 * One warning per contract operation that no page documents with an
 * `<ApiEndpoint>` block, filed against the page that mentions it (the
 * operation itself first, then its path). Operations no page mentions are
 * returned without a file so the caller can report them without a fix session.
 */
export async function contractCoverageIssues(root: string, files: string[]): Promise<ValidationIssue[]> {
  let operations: string[]
  try {
    const { inventory } = await discoverDocumentationSources(root)
    operations = [...new Set(inventory.sources.flatMap((source) => source.evidence.filter((row) => row.contract && row.kind === 'operation').map((row) => row.label)))]
  } catch {
    return []
  }
  if (operations.length === 0) return []
  const pages: Array<{ file: string; content: string }> = []
  for (const file of files) {
    try { pages.push({ file, content: await readFile(join(root, file), 'utf8') }) } catch { /* A page the run did not write. */ }
  }
  const documented = new Set(pages.flatMap((page) => documentedOperations(page.content)))
  const issues: ValidationIssue[] = []
  for (const operation of operations) {
    const [method = '', ...rest] = operation.split(' ')
    const path = normalizePath(rest.join(' '))
    if (documented.has(`${method} ${path}`)) continue
    const mentions = (page: { content: string }) => page.content.includes(`${method} ${rest.join(' ')}`) || page.content.includes(`${method} ${path}`)
    const home = pages.find(mentions) ?? pages.find((page) => page.content.includes(rest.join(' ')))
    issues.push({
      severity: 'warning',
      code: 'api-endpoint-missing',
      message: `The API contract's ${operation} has no <ApiEndpoint> reference block on any page. Add one on this page where it discusses the operation: method, path, baseUrl, a <Param> for each path, query, header, and body field, and a <Response> for the success and each documented error status, all taken from the contract.`,
      ...(home ? { file: home.file } : {}),
    })
  }
  return issues
}

/** `{slug}` and `:slug` path parameters compare equal. */
function normalizePath(path: string): string {
  return path.trim().replace(/:([A-Za-z_][\w]*)/g, '{$1}').replace(/\/+$/, '') || '/'
}
