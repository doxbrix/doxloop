import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PNG } from 'pngjs'
import { afterEach, describe, expect, test } from 'vitest'
import { checkScreenshotDrift, compareScreenshots, readDriftReport, refreshScreenshots } from './screenshot-drift.js'
import { readScreenshotLedger, recordScreenshots } from './screenshot-ledger.js'
import { SCREENSHOT_MANIFEST_FILE } from './screenshot-workflow.js'
import { loadProject, saveProjectSettings, scaffoldProject } from './project.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })

/** A 400x240 image, white with a coloured block whose position varies. */
function image(blockX = 20, color: [number, number, number] = [30, 120, 200]): Buffer {
  const png = new PNG({ width: 400, height: 240 })
  for (let y = 0; y < 240; y += 1) {
    for (let x = 0; x < 400; x += 1) {
      const index = (y * 400 + x) * 4
      const inBlock = x >= blockX && x < blockX + 120 && y >= 40 && y < 140
      png.data[index] = inBlock ? color[0] : 255
      png.data[index + 1] = inBlock ? color[1] : 255
      png.data[index + 2] = inBlock ? color[2] : 255
      png.data[index + 3] = 255
    }
  }
  return PNG.sync.write(png)
}

async function project() {
  const parent = await mkdtemp(join(tmpdir(), 'doxloop-drift-'))
  roots.push(parent)
  await mkdir(join(parent, 'product'), { recursive: true })
  const root = await scaffoldProject({ directory: join(parent, 'docs'), sources: [{ name: 'product', path: '../product' }] })
  await saveProjectSettings(root, { application: { baseUrl: 'http://localhost:4999', screenshots: { policy: 'requested', viewport: { width: 1280, height: 800 } } } })
  await mkdir(join(root, 'images', 'guides', 'projects'), { recursive: true })
  await writeFile(join(root, 'images', 'guides', 'projects', 'list.png'), image())
  await writeFile(join(root, 'images', 'guides', 'projects', 'settings.png'), image(200))
  await writeFile(join(root, 'images', 'guides', 'projects', 'old.png'), image())
  await writeFile(join(root, 'images', 'guides', 'projects', 'dialog.png'), image(120))
  await mkdir(join(root, '.doxloop'), { recursive: true })
  await writeFile(join(root, SCREENSHOT_MANIFEST_FILE), JSON.stringify({ schemaVersion: 1, guides: [{ page: 'projects', steps: [
    { id: 'list', action: 'Open the project list', expectedState: 'The project list shows two projects', status: 'verified', file: 'images/guides/projects/list.png', route: '/projects' },
    { id: 'settings', action: 'Open project settings', expectedState: 'The settings form is open', status: 'verified', file: 'images/guides/projects/settings.png', route: '/#/settings' },
    { id: 'modal', action: 'Click Delete', expectedState: 'The delete dialog asks to confirm', status: 'verified', file: 'images/guides/projects/old.png' },
    { id: 'dialog', action: 'Click New project', expectedState: 'The new project dialog is open', status: 'verified', file: 'images/guides/projects/dialog.png', route: '/projects' },
    { id: 'skipped', action: 'Open billing', expectedState: 'Billing is shown', status: 'text-only' },
  ] }] }))
  return root
}

describe('screenshot ledger', () => {
  test('records verified captures with route, size, and hash, and keeps capture time for unchanged bytes', async () => {
    const root = await project()
    const project_ = await loadProject(root)
    // The dialog has a route, but only a click reaches it.
    expect(await recordScreenshots(root, project_)).toEqual({ recorded: 4, recapturable: 2 })
    const first = await readScreenshotLedger(root)
    expect(first.screenshots.map((record) => [record.file, record.route, record.width, record.height])).toEqual([
      ['images/guides/projects/dialog.png', '/projects', 400, 240],
      ['images/guides/projects/list.png', '/projects', 400, 240],
      ['images/guides/projects/old.png', undefined, 400, 240],
      ['images/guides/projects/settings.png', '/#/settings', 400, 240],
    ])
    expect(first.screenshots[0]!.viewport).toEqual({ width: 1280, height: 800 })
    // The same bytes keep their capture time; a deleted image drops out.
    await rm(join(root, 'images', 'guides', 'projects', 'old.png'))
    await recordScreenshots(root, project_)
    const second = await readScreenshotLedger(root)
    expect(second.screenshots.map((record) => record.file)).toEqual(['images/guides/projects/dialog.png', 'images/guides/projects/list.png', 'images/guides/projects/settings.png'])
    expect(second.screenshots[1]!.capturedAt).toBe(first.screenshots[1]!.capturedAt)
    expect(first.screenshots[0]!.interactive).toBe(true)
  })
})

describe('screenshot drift', () => {
  test('compares images by the share of differing pixels', () => {
    expect(compareScreenshots(image(), image()).share).toBe(0)
    expect(compareScreenshots(image(20), image(200)).share).toBeGreaterThan(0.1)
    const smaller = new PNG({ width: 10, height: 10 })
    expect(compareScreenshots(image(), PNG.sync.write(smaller)).share).toBe(1)
  })

  test('re-captures recorded routes, reports changed and sign-in screens, and replaces a changed one as an undoable edit', async () => {
    const root = await project()
    await recordScreenshots(root, await loadProject(root))
    const visited: string[] = []
    const report = await checkScreenshotDrift(root, {
      capturePage: async (url) => {
        visited.push(url)
        if (url.endsWith('/projects')) return { png: image(20), finalUrl: url, status: 200, hasPasswordField: false }
        return { png: image(20, [200, 40, 40]), finalUrl: 'http://localhost:4999/#/login', status: 200, hasPasswordField: true }
      },
    })
    // The dialog screenshot is never re-captured by opening its route: that
    // shows the page behind the dialog and would offer to replace it.
    expect(visited).toEqual(['http://localhost:4999/projects', 'http://localhost:4999/#/settings'])
    expect(report.results.map((result) => [result.file, result.outcome])).toEqual([
      ['images/guides/projects/dialog.png', 'needs-run'],
      ['images/guides/projects/list.png', 'unchanged'],
      ['images/guides/projects/old.png', 'no-route'],
      ['images/guides/projects/settings.png', 'sign-in'],
    ])

    // The settings screen now renders differently.
    const again = await checkScreenshotDrift(root, {
      files: ['images/guides/projects/settings.png'],
      capturePage: async (url) => ({ png: image(20), finalUrl: url, status: 200, hasPasswordField: false }),
    })
    const settings = again.results.find((result) => result.file === 'images/guides/projects/settings.png')!
    expect(settings).toMatchObject({ outcome: 'changed', candidate: expect.stringContaining('screenshot-drift'), diff: expect.stringContaining('-diff.png') })
    // A partial check keeps the other results.
    expect(again.results.find((result) => result.file === 'images/guides/projects/list.png')?.outcome).toBe('unchanged')

    const before = (await readScreenshotLedger(root)).screenshots.find((record) => record.file === settings.file)!
    expect(await refreshScreenshots(root, [settings.file])).toEqual({ replaced: [settings.file] })
    expect(compareScreenshots(await readFile(join(root, settings.file)), image(20)).share).toBe(0)
    const after = (await readScreenshotLedger(root)).screenshots.find((record) => record.file === settings.file)!
    expect(after.sha256).not.toBe(before.sha256)
    expect((await readDriftReport(root))!.results.find((result) => result.file === settings.file)?.outcome).toBe('unchanged')
    await expect(refreshScreenshots(root, [settings.file])).rejects.toThrow(/fresh capture/)
  })

  test('needs the application URL', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'doxloop-drift-bare-'))
    roots.push(parent)
    const root = await scaffoldProject({ directory: join(parent, 'docs'), sources: [] })
    await expect(checkScreenshotDrift(root, { capturePage: async () => { throw new Error('unused') } })).rejects.toThrow(/application URL/)
  })
})

describe('screens reached by interaction', () => {
  test('are recognised from the recorded action and state', async () => {
    const { reachedByInteraction } = await import('./screenshot-ledger.js')
    const cases: Array<[string, string, boolean]> = [
      ['Open Explore', 'Protected and Public memos', false],
      ['Open Inbox', 'All, Unread, Archived tabs', false],
      ["Search 'checklist'", 'three results under a chip', true],
      ['Click Create Access Token and fill Description', 'dialog with Expiration', true],
      ['Choose Focus Mode', 'expanded editor', true],
      ['Click Documents', 'Documents tab', true],
      ['Open the expiry dropdown in the share dialog', 'expiry options listed', true],
    ]
    for (const [action, expectedState, expected] of cases) expect([action, reachedByInteraction({ action, expectedState })]).toEqual([action, expected])
  })
})
