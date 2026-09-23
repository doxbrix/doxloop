import { mkdir, mkdtemp, readFile, rename, rm, writeFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { PNG } from 'pngjs'
import { adoptPlanningCaptures, preparePlanningCaptures, reusePlanningCaptures } from './planning-captures.js'
import { writeScreenshotManifestSkeleton } from './screenshot-workflow.js'
import type { DocumentationPlan } from './types.js'
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })
async function fixture() {
 const root = await mkdtemp(join(tmpdir(), 'doxloop-reuse-')); roots.push(root)
 const workspace = join(root, 'workspace'); await mkdir(workspace)
 const plan = { id: 'plan-test', pages: [{ id: 'guide', path: 'guide', visuals: { mode: 'required', startPath: '/tasks', captureSequence: ['Open tasks — task list is visible — orient readers', 'Open dialog — form is visible — show inputs'], captureIds: ['list', 'missing'] } }] } as unknown as DocumentationPlan
 const directory = await preparePlanningCaptures(root, plan.id)
 const png = new PNG({ width: 400, height: 240 }); for (let i = 0; i < png.data.length; i++) png.data[i] = i % 255
 await writeFile(join(directory, 'list.png'), PNG.sync.write(png))
 await mkdir(join(root, '.doxloop/plans/plan-test/research'), { recursive: true })
 const brief = { content: { screens: [{ route: '/tasks', visible: 'New task', captures: [{ id: 'list', file: 'list.png', action: 'Open tasks', state: 'Task list', alt: 'Task list with new task button', checks: { expectedStateConfirmed: true, privacyReviewed: true, legibilityReviewed: true, meaningful: true } }] }] } }
 const briefFile = join(root, '.doxloop/plans/plan-test/research/application.json')
 await writeFile(briefFile, JSON.stringify(brief)); await writeScreenshotManifestSkeleton(workspace, plan)
 return { root, workspace, plan, directory, brief, briefFile }
}
test('reuses exact approved captures, preserves unmatched states, and is idempotent on resume', async () => {
 const f = await fixture()
 expect(await reusePlanningCaptures(f.root, f.workspace, f.plan, 'doxbrix')).toBe(1)
 const manifest = JSON.parse(await readFile(join(f.workspace, '.doxloop/screenshot-manifest.json'), 'utf8'))
 expect(manifest.guides[0].steps.map((step: { status: string }) => step.status)).toEqual(['verified', 'planned'])
 expect(manifest.guides[0].steps[0].target).toBeTruthy()
 expect(await readFile(join(f.workspace, manifest.guides[0].steps[0].file))).toEqual(await readFile(join(f.directory, 'list.png')))
 expect(await reusePlanningCaptures(f.root, f.workspace, f.plan, 'doxbrix')).toBe(0)
})
test('rejects unreviewed captures, missing files and symlinks outside the plan capture directory', async () => {
 const f = await fixture(); const capture = f.brief.content.screens[0]!.captures[0]!
 capture.checks.privacyReviewed = false; await writeFile(f.briefFile, JSON.stringify(f.brief))
 expect(await reusePlanningCaptures(f.root, f.workspace, f.plan, 'doxbrix')).toBe(0)
 capture.checks.privacyReviewed = true; capture.file = 'missing.png'; await writeFile(f.briefFile, JSON.stringify(f.brief))
 expect(await reusePlanningCaptures(f.root, f.workspace, f.plan, 'doxbrix')).toBe(0)
 await writeFile(join(f.root, 'outside.png'), await readFile(join(f.directory, 'list.png')))
 await symlink(join(f.root, 'outside.png'), join(f.directory, 'link.png'))
 capture.file = 'link.png'; await writeFile(f.briefFile, JSON.stringify(f.brief))
 expect(await reusePlanningCaptures(f.root, f.workspace, f.plan, 'doxbrix')).toBe(0)
})
test('adopts an image the browser tool left at the project root and moves it into the plan capture directory', async () => {
 const f = await fixture()
 // The screenshot tool resolves a caller-supplied filename against its client workspace, not --output-dir.
 await rename(join(f.directory, 'list.png'), join(f.root, 'list.png'))
 const adopted = await adoptPlanningCaptures(f.root, f.workspace, f.plan, 'doxbrix')
 expect(adopted).toEqual({ reused: 1, missing: [] })
 expect(await readFile(join(f.directory, 'list.png'))).toBeInstanceOf(Buffer)
 await expect(readFile(join(f.root, 'list.png'))).rejects.toThrow()
 const manifest = JSON.parse(await readFile(join(f.workspace, '.doxloop/screenshot-manifest.json'), 'utf8'))
 expect(manifest.guides[0].steps[0].status).toBe('verified')
})
test('names the referenced captures whose image is nowhere to be found', async () => {
 const f = await fixture()
 await rm(join(f.directory, 'list.png'))
 expect(await adoptPlanningCaptures(f.root, f.workspace, f.plan, 'doxbrix')).toEqual({ reused: 0, missing: ['list'] })
})

