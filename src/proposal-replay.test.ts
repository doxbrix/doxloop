import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PNG } from 'pngjs'
import { afterEach, expect, test } from 'vitest'
import { replayRun } from './proposal-replay.js'
import { SCREENSHOT_MANIFEST_FILE } from './screenshot-workflow.js'
import { pathExists } from './fs.js'
import { loadProject, scaffoldProject } from './project.js'
import type { DocumentationPlan } from './types.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })

function png(): Buffer {
  const image = new PNG({ width: 640, height: 400 })
  for (let index = 0; index < image.data.length; index += 4) {
    image.data[index] = index % 255; image.data[index + 1] = Math.floor(index / 2560) % 255; image.data[index + 2] = 160; image.data[index + 3] = 255
  }
  return PNG.sync.write(image)
}

/**
 * The shape of the vikunja9 run that blocked its proposal: a planning capture
 * reused without a target, an image embed whose file is gone, and a starter
 * page the plan superseded.
 */
async function recordedRun(): Promise<string> {
  const run = await mkdtemp(join(tmpdir(), 'doxloop-replay-run-')); roots.push(run)
  const workspace = await scaffoldProject({ directory: join(run, 'workspace'), title: 'Fixture', sources: [{ name: 'app', path: '../app', kind: 'directory' }], generator: 'doxbrix' })
  await mkdir(join(workspace, 'guides'), { recursive: true })
  await mkdir(join(workspace, 'assets', 'guides', 'planning'), { recursive: true })
  // The writer dropped the starter quickstart from the navigation, as vikunja9's did.
  const site = JSON.parse(await readFile(join(workspace, 'docs.json'), 'utf8'))
  for (const space of site.spaces) space.nav = space.nav.filter((node: { type: string; file?: string }) => !(node.type === 'page' && /quickstart/.test(node.file ?? '')))
  await writeFile(join(workspace, 'docs.json'), JSON.stringify(site, null, 2))
  const body = Array.from({ length: 60 }, (_, i) => `Paragraph ${i} explains one thing the reader does and what they see afterwards.`).join('\n\n')
  await writeFile(join(workspace, 'index.mdx'), `---\ntitle: "Overview"\ndescription: "Start here."\n---\n\n# Overview\n\n<Frame caption="Dashboard">\n\n![Dashboard](/assets/guides/planning/plan-x-deadbeef.png)\n\n</Frame>\n\n${body}\n`)
  await writeFile(join(workspace, 'guides', 'labels.mdx'), `---\ntitle: "Labels"\ndescription: "Manage labels."\n---\n\n# Labels\n\n![Labels page](/assets/guides/planning/plan-x-cafe.png)\n\n${body}\n`)
  await writeFile(join(workspace, 'assets', 'guides', 'planning', 'plan-x-cafe.png'), png())
  await writeFile(join(workspace, 'quickstart.mdx'), `---\ntitle: "Quickstart"\ndescription: "Starter."\n---\n\n{/* doxloop:starter-page */}\n\n# Quickstart\n\nPlaceholder.\n`)
  await writeFile(join(workspace, SCREENSHOT_MANIFEST_FILE), JSON.stringify({ schemaVersion: 1, guides: [{ page: 'labels', steps: [{ id: '01', action: 'Open /labels', expectedState: 'The Labels page lists every label.', purpose: 'Orient the reader.', capture: true, status: 'verified', file: 'assets/guides/planning/plan-x-cafe.png', alt: 'Labels page', checks: { expectedStateConfirmed: true, privacyReviewed: true, legibilityReviewed: true, meaningful: true } }] }] }, null, 2))
  const plan = {
    id: 'plan-x', version: 1, mode: 'create', status: 'generated', scope: 'standard', request: '', pages: [
      { id: 'overview', title: 'Overview', path: 'index', type: 'landing', priority: 'must-have', action: 'update', purpose: 'Start here.', rationale: '', evidence: [], evidenceDetails: [], diagram: 'none' },
      { id: 'labels', title: 'Labels', path: 'guides/labels', type: 'how-to', priority: 'must-have', action: 'create', purpose: 'Manage labels.', rationale: '', evidence: [], evidenceDetails: [], diagram: 'none', visuals: { mode: 'required', rationale: 'r', estimatedCaptures: 1, startPath: '/labels', captureSequence: ['Open /labels — the Labels page lists every label — orient the reader'], captureIds: ['labels'] } },
    ],
    navigation: { top: ['Docs'], sections: [{ id: 'guides', title: 'Guides', pageIds: ['labels'] }] },
    execution: { screenshots: 'enabled' },
    target: { generator: 'doxbrix', contentDir: '', contentFormat: 'markdown', pageExtensions: ['.mdx'], navigationFiles: ['docs.json'] },
  } as unknown as DocumentationPlan
  await writeFile(join(run, 'approved-plan.json'), JSON.stringify(plan, null, 2))
  return run
}

test('replays a recorded run and repairs what blocked its proposal without touching the run folder', async () => {
  const run = await recordedRun()
  const before = await readFile(join(run, 'workspace', 'index.mdx'), 'utf8')
  const result = await replayRun(run, { keep: true })
  roots.push(result.workspace)
  expect(result.before.errors).toBeGreaterThan(0)
  expect({ errors: result.after.issues.filter((issue) => issue.severity === 'error'), repairs: result.repairs }).toEqual({ errors: [], repairs: result.repairs })
  expect(result.repairs.some((line) => line.includes('index.mdx: removed 1 image embed'))).toBe(true)
  expect(result.repairs.some((line) => line.includes('removed quickstart.mdx') || line.includes('quickstart.mdx: removed the starter page'))).toBe(true)
  // A verified step with an image and no target is kept, not downgraded.
  const manifest = JSON.parse(await readFile(join(result.workspace, SCREENSHOT_MANIFEST_FILE), 'utf8'))
  expect(manifest.guides[0].steps[0]).toMatchObject({ status: 'verified', target: 'Open /labels' })
  expect(await pathExists(join(result.workspace, 'assets', 'guides', 'planning', 'plan-x-cafe.png'))).toBe(true)
  // The recorded run is untouched.
  expect(await readFile(join(run, 'workspace', 'index.mdx'), 'utf8')).toBe(before)
  expect(await pathExists(join(run, 'workspace', 'quickstart.mdx'))).toBe(true)
})

test('refuses a directory without a workspace or an approved plan', async () => {
  const run = await mkdtemp(join(tmpdir(), 'doxloop-replay-empty-')); roots.push(run)
  await expect(replayRun(run)).rejects.toThrow('no workspace')
  await mkdir(join(run, 'workspace'))
  await expect(replayRun(run)).rejects.toThrow('approved-plan.json')
})
