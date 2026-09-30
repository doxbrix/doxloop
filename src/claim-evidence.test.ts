import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { bestLines, claimTerms, contradictedClaimIssues, parseClaimCitation, readPageClaimEvidence } from './claim-evidence.js'
import { writeEvidenceMap } from './evidence.js'
import { loadProject, scaffoldProject } from './project.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })

const AUTH = [
  "import { sign } from './jwt'",
  '',
  'export const ACCESS_TOKEN_TTL_SECONDS = 900',
  '',
  'export function issueToken(user) {',
  '  if (!user.active) throw new HttpError(403, "account disabled")',
  '  return sign({ sub: user.id }, { expiresIn: ACCESS_TOKEN_TTL_SECONDS })',
  '}',
  '',
  'export function refresh(request) {',
  '  if (!process.env.AUTH_REFRESH_SECRET) throw new HttpError(500, "missing secret")',
  '  return issueToken(request.user)',
  '}',
].join('\n')

async function project() {
  const parent = await mkdtemp(join(tmpdir(), 'doxloop-claims-'))
  roots.push(parent)
  await mkdir(join(parent, 'product', 'src'), { recursive: true })
  await writeFile(join(parent, 'product', 'src', 'auth.ts'), AUTH)
  const root = await scaffoldProject({ directory: join(parent, 'docs'), sources: [{ name: 'product', path: '../product' }] })
  return root
}

describe('claim citations', () => {
  test('parse a line, a range, a file, and an operation', () => {
    expect(parseClaimCitation('product:src/auth.ts:42')).toEqual({ source: 'product', path: 'src/auth.ts', start: 42, end: 42 })
    expect(parseClaimCitation('product:src/auth.ts:58-40')).toEqual({ source: 'product', path: 'src/auth.ts', start: 40, end: 58 })
    expect(parseClaimCitation('product:src/auth.ts')).toEqual({ source: 'product', path: 'src/auth.ts' })
    expect(parseClaimCitation('api:POST /oauth/token')).toEqual({ source: 'api', path: 'POST /oauth/token' })
    expect(parseClaimCitation('no-source')).toBeUndefined()
  })

  test('claim terms keep identifiers, facts, and numbers with units', () => {
    const terms = claimTerms('A disabled account gets `403` and tokens expire after 900 seconds unless AUTH_REFRESH_SECRET is unset')
    expect(terms).toEqual(expect.arrayContaining(['403', '900', 'AUTH_REFRESH_SECRET']))
  })

  test('best lines prefer the line with the most terms', () => {
    const [first] = bestLines(AUTH, ['403', 'disabled'])
    expect(first).toMatchObject({ line: 6, score: 2 })
    expect(first!.excerpt).toContain('account disabled')
  })
})

describe('page claim evidence', () => {
  test('finds the supporting line for each claim and honours the writer\'s citation', async () => {
    const root = await project()
    await writeEvidenceMap(root, {
      schemaVersion: 1,
      pages: {
        'guides/auth.mdx': {
          sources: [{ source: 'product', paths: ['src/auth.ts'] }],
          confidence: 'verified',
          verifiedOn: { product: '2026-09-30T10:00:00.000Z' },
          claims: ['Access tokens expire after 900 seconds', 'A disabled account receives HTTP 403', 'Refresh needs AUTH_REFRESH_SECRET'],
          claimSources: { 'Refresh needs AUTH_REFRESH_SECRET': ['product:src/auth.ts:10-13'] },
        },
      },
    })
    const result = await readPageClaimEvidence(root, await loadProject(root), 'guides/auth.mdx')
    expect(result?.verifiedOn).toBe('2026-09-30T10:00:00.000Z')
    const [ttl, disabled, secret] = result!.claims
    expect(ttl).toMatchObject({ state: 'verified', locations: [expect.objectContaining({ path: 'src/auth.ts', line: 3, cited: false })] })
    expect(disabled).toMatchObject({ state: 'verified', locations: [expect.objectContaining({ line: 6 })] })
    expect(secret).toMatchObject({ state: 'verified', locations: [expect.objectContaining({ path: 'src/auth.ts', line: 11, cited: true })] })
  })

  test('reports a claim whose value the cited evidence contradicts, with the values it has instead', async () => {
    const root = await project()
    await writeEvidenceMap(root, {
      schemaVersion: 1,
      pages: {
        'guides/auth.mdx': {
          sources: [{ source: 'product', paths: ['src/auth.ts'] }],
          confidence: 'verified',
          claims: ['A disabled account receives HTTP 401'],
        },
      },
    })
    const result = await readPageClaimEvidence(root, await loadProject(root), 'guides/auth.mdx')
    expect(result!.claims[0]).toMatchObject({ state: 'contradicted', missingFacts: ['401'], evidenceFacts: expect.arrayContaining(['403']) })
    const issues = await contradictedClaimIssues(root, await loadProject(root), ['guides/auth.mdx'])
    expect(issues).toEqual([expect.objectContaining({ code: 'claim-contradicted', severity: 'warning', file: 'guides/auth.mdx' })])
    expect(issues[0]!.message).toContain('"A disabled account receives HTTP 401"')
    expect(issues[0]!.message).toContain('403')
  })

  test('never reads outside a source root', async () => {
    const root = await project()
    await writeEvidenceMap(root, {
      schemaVersion: 1,
      pages: {
        'guides/auth.mdx': {
          sources: [{ source: 'product', paths: ['../../etc/passwd'] }],
          claims: ['Tokens expire'],
          claimSources: { 'Tokens expire': ['product:../outside.txt:1'] },
        },
      },
    })
    const result = await readPageClaimEvidence(root, await loadProject(root), 'guides/auth.mdx')
    expect(result!.claims[0]!.locations).toEqual([])
  })

  test('a page without an entry has no claim evidence', async () => {
    const root = await project()
    expect(await readPageClaimEvidence(root, await loadProject(root), 'missing.mdx')).toBeUndefined()
  })
})
