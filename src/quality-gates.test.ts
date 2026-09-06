import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { createDemoWorkspace, type DemoWorkspace } from './demo.js'
import { evaluateWorkspace } from './evaluation.js'
import { loadProject } from './project.js'
import { reverifyClaims, VERIFICATION_METADATA_FILE } from './quality-claims.js'
import { verifyExamples } from './quality-examples.js'
import { runQuality } from './quality-gates.js'
import { fixDocumentation } from './quality-lint.js'
import { checkExternalLinks } from './quality-links.js'

const demos: DemoWorkspace[] = []
afterEach(async () => { await Promise.all(demos.splice(0).map((demo) => demo.cleanup())) })

async function demo(): Promise<DemoWorkspace> { const value = await createDemoWorkspace(); demos.push(value); return value }

describe('release quality contract', () => {
  test('orchestrates every non-rendered gate and persists a versioned report', async () => {
    const workspace = await demo()
    const report = await runQuality(workspace.root, { offline: true })
    expect(report.contractVersion).toBe('1.0.0')
    expect(new Set(report.checks.map((check) => check.category))).toEqual(new Set(['validation', 'build', 'links', 'examples', 'schemas', 'accessibility', 'visual', 'lint', 'claims']))
    expect(JSON.parse(await readFile(join(workspace.root, '.doxloop', 'quality-reports', 'latest.json'), 'utf8'))).toMatchObject({ schemaVersion: 1, contractVersion: '1.0.0' })
  })

  test('distinguishes a broken external link from a temporary or offline result', async () => {
    const workspace = await demo()
    await writeFile(join(workspace.root, 'index.mdx'), `${await readFile(join(workspace.root, 'index.mdx'), 'utf8')}\n[Missing](https://example.com/missing)\n`)
    const project = await loadProject(workspace.root)
    const checks = await checkExternalLinks(workspace.root, project, { schemaVersion: 1, links: { mode: 'online', retries: 0 } }, { fetch: async () => new Response('', { status: 404 }), resolveHostname: async () => ['93.184.216.34'] })
    expect(checks).toEqual([expect.objectContaining({ code: 'quality.link.broken', status: 'fail' })])
    const offline = await checkExternalLinks(workspace.root, project, { schemaVersion: 1, links: { mode: 'offline' } })
    expect(offline[0]).toMatchObject({ code: 'quality.link.broken', status: 'fail' })
  })

  test('runs declared Node examples without inherited credentials or network permission', async () => {
    const workspace = await demo()
    await mkdir(join(workspace.root, 'examples'))
    await writeFile(join(workspace.root, 'examples', 'hello.mjs'), `console.log('verified example')\n`)
    await writeFile(join(workspace.root, '.doxloop', 'examples.json'), JSON.stringify({ schemaVersion: 1, examples: [{ id: 'hello', runtime: 'node', file: 'examples/hello.mjs', workingDirectory: '.', fixtures: [], network: 'denied', expected: { exitCode: 0, stdoutIncludes: 'verified example' } }] }))
    expect(await verifyExamples(workspace.root, true)).toEqual([expect.objectContaining({ code: 'quality.example.passed', status: 'pass' })])
  })

  test('verifies HTTP examples against the configured OpenAPI operation and response', async () => {
    const workspace = await demo()
    await mkdir(join(workspace.root, 'examples'))
    await writeFile(join(workspace.root, 'examples', 'create-event.http'), 'POST /events\n# expect-status: 202\n')
    await writeFile(join(workspace.root, '.doxloop', 'examples.json'), JSON.stringify({ schemaVersion: 1, examples: [{ id: 'create-event', runtime: 'openapi-request', file: 'examples/create-event.http', workingDirectory: '.', fixtures: [], network: 'denied', expected: { exitCode: 0 } }] }))
    expect(await verifyExamples(workspace.root, true)).toEqual([expect.objectContaining({ code: 'quality.example.passed', status: 'pass', message: expect.stringContaining('HTTP 202') })])
    await writeFile(join(workspace.root, 'examples', 'create-event.http'), 'POST /events\n# expect-status: 204\n')
    expect(await verifyExamples(workspace.root, true)).toEqual([expect.objectContaining({ code: 'quality.example.failed', status: 'fail' })])
  })

  test('applies only deterministic documentation fixes', async () => {
    const workspace = await demo()
    const path = join(workspace.root, 'quickstart.mdx')
    await writeFile(path, `${await readFile(path, 'utf8')}\n\n\`\`\`\nnpm run test\n\`\`\`   \n`)
    const result = await fixDocumentation(workspace.root, await loadProject(workspace.root))
    expect(result.changed).toContain('quickstart.mdx')
    expect(await readFile(path, 'utf8')).toContain('```bash\nnpm run test\n```')
  })

  test('publishes evidence-derived reader metadata and evaluates regressions', async () => {
    const workspace = await demo()
    const claims = await reverifyClaims(workspace.root, await loadProject(workspace.root), true)
    expect(Object.keys(claims.metadata.pages)).toHaveLength(7)
    expect(JSON.parse(await readFile(join(workspace.root, VERIFICATION_METADATA_FILE), 'utf8'))).toMatchObject({ schemaVersion: 1 })
    const evaluation = await evaluateWorkspace(workspace.root, { mode: 'generation', maximumPages: 7 })
    expect(evaluation.contractVersion).toBe('1.0.0')
    expect(evaluation.metrics.map((metric) => metric.id)).toContain('factual-precision')
    expect(evaluation.score).toBeGreaterThan(0)
  })

  test('reverifies concrete claims against current evidence and detects contradictions', async () => {
    const workspace = await demo()
    const project = await loadProject(workspace.root)
    const evidencePath = join(workspace.root, '.doxloop', 'evidence-map.json')
    const map = JSON.parse(await readFile(evidencePath, 'utf8'))
    map.pages['reference/events.mdx'].claims = ['POST /events returns HTTP 202.', 'POST /events returns HTTP 204.']
    map.pages['reference/events.mdx'].sources = [{ source: 'pulse-api', operations: ['POST /events'] }]
    await writeFile(evidencePath, `${JSON.stringify(map, null, 2)}\n`)
    const result = await reverifyClaims(workspace.root, project, false)
    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: 'verified: POST /events returns HTTP 202.' }),
      expect.objectContaining({ status: 'fail', message: 'contradicted: POST /events returns HTTP 204.' }),
    ]))
  })

  test('supports reviewed suppressions and quality ratcheting', async () => {
    const workspace = await demo()
    await writeFile(join(workspace.root, 'index.mdx'), `${await readFile(join(workspace.root, 'index.mdx'), 'utf8')}\n\nteh reviewed legacy wording.\n`)
    await writeFile(join(workspace.root, '.doxloop', 'quality.json'), `${JSON.stringify({ schemaVersion: 1, links: { mode: 'offline' }, suppressions: [{ code: 'quality.claim.needs-human', reason: 'Legacy page awaiting migration' }], ratchet: { enabled: true } }, null, 2)}\n`)
    const approved = await runQuality(workspace.root, { offline: true, approveBaseline: true })
    expect(approved.status).not.toBe('fail')
    expect(await readFile(join(workspace.root, '.doxloop', 'quality-baseline.json'), 'utf8')).toContain('schemaVersion')
    const rerun = await runQuality(workspace.root, { offline: true })
    expect(rerun.checks.some((check) => check.detail?.includes('approved quality baseline'))).toBe(true)
  })
})
