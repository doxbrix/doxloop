/**
 * "Test examples" for one page, from the control center: the static checks
 * against JSON/YAML syntax and the API contract, plus — when a test server is
 * given — the page's read-only requests sent to it.
 */
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import matter from 'gray-matter'
import { projectContracts, type ProjectContract } from './api-contracts.js'
import { DoxloopError } from './errors.js'
import { exampleIssues, runPageExamples, type ExampleResult } from './example-checks.js'
import { assertInside } from './fs.js'
import { resolveEditScope } from './pages.js'
import { loadProject } from './project.js'
import type { ValidationIssue } from './types.js'

export interface PageExampleReport {
  path: string
  checkedAt: string
  /** Contracts the requests were matched against, as `source: location`. */
  contracts: string[]
  /** A test server to suggest when none was given: the application or a local server from the contract. */
  suggestedBaseUrl?: string
  baseUrl?: string
  issues: ValidationIssue[]
  results: ExampleResult[]
}

function suggestedBaseUrl(application: string | undefined, contracts: ProjectContract[]): string | undefined {
  const local = contracts.flatMap((contract) => contract.loaded.summary.servers).find((server) => /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/|$)/i.test(server))
  return local ?? application
}

function testServer(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined
  let url: URL
  try { url = new URL(value.trim()) } catch { throw new DoxloopError('Enter the test server as a full http:// or https:// address.', 2) }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new DoxloopError('Enter the test server as a full http:// or https:// address.', 2)
  return url.toString()
}

export async function testPageExamples(root: string, rawPath: unknown, rawBaseUrl?: unknown): Promise<PageExampleReport> {
  if (typeof rawPath !== 'string' || !rawPath.trim()) throw new DoxloopError('Choose a page to test its examples.', 2)
  const path = rawPath.trim()
  const project = await loadProject(root)
  await resolveEditScope(root, project, [path], false)
  const body = matter(await readFile(assertInside(root, resolve(root, path)), 'utf8')).content
  const contracts = await projectContracts(root, project).catch(() => [])
  const baseUrl = testServer(typeof rawBaseUrl === 'string' ? rawBaseUrl : undefined)
  const suggestion = suggestedBaseUrl(project.application?.baseUrl, contracts)
  return {
    path,
    checkedAt: new Date().toISOString(),
    contracts: contracts.map((contract) => `${contract.source}: ${contract.location}`),
    ...(suggestion ? { suggestedBaseUrl: suggestion } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    issues: exampleIssues(body, path, contracts),
    results: baseUrl ? await runPageExamples(body, baseUrl, contracts) : [],
  }
}
