import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { createDemoWorkspace, type DemoWorkspace } from './demo.js'
import { approveEvaluationBaseline, evaluateWorkspace } from './evaluation.js'

const demos: DemoWorkspace[] = []
const temporary: string[] = []
afterEach(async () => { await Promise.all([...demos.splice(0).map((demo) => demo.cleanup()), ...temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))]) })

describe('documentation evaluations', () => {
  test('scores update locality and blocks a regression beyond the approved threshold', async () => {
    const demo = await createDemoWorkspace(); demos.push(demo)
    const parent = await mkdtemp(join(tmpdir(), 'doxloop-evaluation-before-')); temporary.push(parent)
    const before = join(parent, 'project'); await cp(demo.root, before, { recursive: true })
    const baseline = await evaluateWorkspace(demo.root, { mode: 'generation', maximumPages: 7 })
    await approveEvaluationBaseline(demo.root, baseline)
    const page = join(demo.root, 'index.mdx')
    await writeFile(page, `${await readFile(page, 'utf8')}\n\nTODO: invent an unsupported workflow.\n`)
    const regressed = await evaluateWorkspace(demo.root, { mode: 'generation', maximumPages: 7, regressionThreshold: 1 })
    expect(regressed.regression).toMatchObject({ baselineScore: baseline.score, blocked: true })
    const update = await evaluateWorkspace(demo.root, { mode: 'update', before, expectedChangedPages: ['index.mdx'] })
    expect(update.metrics.find((metric) => metric.id === 'update-locality-preservation')?.score).toBe(100)
  })
})
