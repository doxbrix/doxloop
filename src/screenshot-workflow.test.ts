import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PNG } from 'pngjs'
import { afterEach, describe, expect, test } from 'vitest'
import {
  describeScreenshotManifestProgress,
  SCREENSHOT_MANIFEST_FILE,
  adoptCapturedImages,
  assertScreenshotPlanningReadiness,
  checkApplicationReadiness,
  collapseDuplicateCaptures,
  embedMissingCaptures,
  normalizeScreenshotIntent,
  prepareGuideAssetDirectories,
  validateScreenshotManifest,
  writeScreenshotManifestSkeleton,
} from './screenshot-workflow.js'
import type { DocumentationPlan } from './types.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function screenshotPlan(): DocumentationPlan {
  return {
    pages: [{
      id: 'invite-member',
      title: 'Invite a member',
      path: 'invite-member',
      type: 'how-to',
      priority: 'must-have',
      action: 'create',
      purpose: 'Invite a team member.',
      rationale: 'Public UI workflow.',
      evidence: [],
      evidenceDetails: [],
      visuals: { mode: 'required', rationale: 'Show the successful invitation form state.', estimatedCaptures: 1 },
    }],
    target: { generator: 'doxbrix', contentDir: '', contentFormat: 'markdown', pageExtensions: ['.mdx'], navigationFiles: [] },
  } as DocumentationPlan
}

describe('screenshot workflow', () => {
  test('keeps untouched, required, and disabled screenshot choices distinct', () => {
    expect(normalizeScreenshotIntent(undefined)).toBe('auto')
    expect(normalizeScreenshotIntent('enabled')).toBe('enabled')
    expect(normalizeScreenshotIntent(false)).toBe('disabled')
  })

  test('gates required screenshot planning before an agent run starts', async () => {
    await expect(assertScreenshotPlanningReadiness(undefined, 'enabled')).rejects.toThrow('Screenshots are selected, but capture cannot start')
    await expect(assertScreenshotPlanningReadiness(undefined, 'auto')).resolves.toBeUndefined()

    const server = createServer((_request, response) => { response.statusCode = 200; response.end('ready') })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    try {
      if (!address || typeof address === 'string') throw new Error('Missing test server address')
      await expect(assertScreenshotPlanningReadiness({ baseUrl: `http://127.0.0.1:${address.port}` }, 'enabled')).resolves.toBeUndefined()
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    }
  })

  test('verifies meaningful, embedded screenshot output', async () => {
    const root = await mkdtemp(join(tmpdir(), 'doxloop-screenshots-'))
    roots.push(root)
    await mkdir(join(root, '.doxloop'), { recursive: true })
    await mkdir(join(root, 'assets', 'guides', 'invite-member'), { recursive: true })
    const file = 'assets/guides/invite-member/01-form.png'
    const png = new PNG({ width: 640, height: 360 })
    for (let index = 0; index < png.data.length; index += 4) {
      png.data[index] = (index / 4) % 255
      png.data[index + 1] = Math.floor(index / (4 * 640)) % 255
      png.data[index + 2] = 160
      png.data[index + 3] = 255
    }
    await writeFile(join(root, file), PNG.sync.write(png))
    await writeFile(join(root, 'invite-member.mdx'), `1. Select **Invite member**.\n\n![Invite form](/${file})\n`)
    await writeFile(join(root, SCREENSHOT_MANIFEST_FILE), JSON.stringify({
      schemaVersion: 1,
      guides: [{
        page: 'invite-member',
        steps: [{
          id: '01',
          action: 'Select Invite member from Team settings.',
          expectedState: 'The Invite member dialog is open.',
          purpose: 'Orient the reader and prove that the invitation form opened.',
          capture: true,
          target: 'Invite member dialog',
          file,
          alt: 'Invite member dialog open from Team settings',
          status: 'verified',
          checks: { expectedStateConfirmed: true, privacyReviewed: true, legibilityReviewed: true, meaningful: true },
        }],
      }],
    }))

    await expect(validateScreenshotManifest(root, screenshotPlan(), 'enabled')).resolves.toMatchObject({
      summary: { status: 'verified', captured: 1, guides: 1 },
    })
  })

  test('accepts a required run with screenshot problems ignored, recording each one as text-only', async () => {
    const root = await mkdtemp(join(tmpdir(), 'doxloop-screenshots-'))
    roots.push(root)
    const plan = screenshotPlan()
    plan.pages.push({
      ...plan.pages[0]!,
      id: 'edit-the-plan',
      title: 'Edit the plan',
      path: 'edit-the-plan',
      visuals: { mode: 'required', rationale: 'Show the plan editor.', estimatedCaptures: 1, startPath: '/plans' },
    })
    await mkdir(join(root, '.doxloop'), { recursive: true })
    await mkdir(join(root, 'assets', 'guides', 'invite-member'), { recursive: true })
    const file = 'assets/guides/invite-member/01-form.png'
    const png = new PNG({ width: 640, height: 360 })
    for (let index = 0; index < png.data.length; index += 4) {
      png.data[index] = (index / 4) % 255
      png.data[index + 1] = Math.floor(index / (4 * 640)) % 255
      png.data[index + 2] = 160
      png.data[index + 3] = 255
    }
    await writeFile(join(root, file), PNG.sync.write(png))
    await writeFile(join(root, 'invite-member.mdx'), `1. Select **Invite member**.\n\n![Invite form](/${file})\n\n2. Confirm.\n\n![Missing](/assets/guides/invite-member/02-missing.png)\n`)
    await writeFile(join(root, 'edit-the-plan.mdx'), '1. Open the plan.\n')
    const step = (id: string, extra: Record<string, unknown>) => ({
      id,
      action: 'Select Invite member from Team settings.',
      expectedState: 'The Invite member dialog is open.',
      purpose: 'Orient the reader and prove that the invitation form opened.',
      capture: true,
      ...extra,
    })
    const checks = { expectedStateConfirmed: true, privacyReviewed: true, legibilityReviewed: true, meaningful: true }
    await writeFile(join(root, SCREENSHOT_MANIFEST_FILE), JSON.stringify({
      schemaVersion: 1,
      guides: [
        {
          page: 'invite-member',
          steps: [
            step('01', { target: 'Invite member dialog', file, alt: 'Invite member dialog open', status: 'verified', checks }),
            step('02', { target: 'Confirmation', file: 'assets/guides/invite-member/02-missing.png', alt: 'Confirmation shown', status: 'verified', checks }),
          ],
        },
        { page: 'edit-the-plan', steps: [step('01', { status: 'planned', sequenceItem: 1 })] },
      ],
    }))

    await expect(validateScreenshotManifest(root, plan, 'enabled')).rejects.toThrow('2 screenshot problems')
    const tolerated = await validateScreenshotManifest(root, plan, 'enabled', { tolerateDefects: true })
    expect(tolerated.summary).toMatchObject({ status: 'verified', captured: 1, textOnly: 2, guides: 2, ignoredProblems: 2 })
    expect(tolerated.summary.message).toContain('2 screenshot problems were ignored')
    expect(tolerated.summary.message).toContain('02-missing.png')
    // The manifest on disk now tells the truth about every step.
    const manifest = JSON.parse(await readFile(join(root, SCREENSHOT_MANIFEST_FILE), 'utf8')) as { guides: Array<{ page: string; steps: Array<{ status: string; file?: string; textOnlyReason?: string }> }> }
    expect(manifest.guides[0]?.steps[1]).toMatchObject({ status: 'text-only' })
    expect(manifest.guides[0]?.steps[1]?.file).toBeUndefined()
    expect(manifest.guides[1]?.steps[0]).toMatchObject({ status: 'text-only' })
    expect(manifest.guides[1]?.steps[0]?.textOnlyReason).toContain('not captured')
    // The broken image reference is gone; the good one stays.
    const page = await readFile(join(root, 'invite-member.mdx'), 'utf8')
    expect(page).toContain('01-form.png')
    expect(page).not.toContain('02-missing.png')
    // Once repaired, strict validation of the same workspace passes in automatic mode.
    await expect(validateScreenshotManifest(root, plan, 'auto')).resolves.toMatchObject({ summary: { captured: 1, textOnly: 2 } })
  })

  test('describes capture progress so a resumed agent keeps verified images', async () => {
    const root = await mkdtemp(join(tmpdir(), 'doxloop-screenshots-'))
    roots.push(root)
    const plan = screenshotPlan()
    plan.pages[0]!.visuals = { ...plan.pages[0]!.visuals!, startPath: '/team' }
    await mkdir(join(root, '.doxloop'), { recursive: true })
    await mkdir(join(root, 'assets', 'guides', 'invite-member'), { recursive: true })
    const file = 'assets/guides/invite-member/01-form.png'
    await writeFile(join(root, file), PNG.sync.write(new PNG({ width: 640, height: 360 })))
    await writeFile(join(root, SCREENSHOT_MANIFEST_FILE), JSON.stringify({
      schemaVersion: 1,
      guides: [{
        page: 'invite-member',
        steps: [
          { id: '01', action: 'Open the team page.', expectedState: 'The team list is visible.', purpose: 'Orient the reader.', capture: true, file, status: 'verified' },
          { id: '02', action: 'Select Invite member.', expectedState: 'The invite dialog is open.', purpose: 'Prove the dialog.', capture: true, status: 'planned' },
          { id: '03', action: 'Scroll the list.', expectedState: 'The same screen.', purpose: 'None.', capture: false, status: 'text-only', textOnlyReason: 'Same screen as 01.' },
        ],
      }],
    }))
    const progress = await describeScreenshotManifestProgress(root, plan)
    expect(progress).toMatchObject({ verified: 1, unfinished: 1 })
    expect(progress.lines[0]).toContain('start at /team')
    expect(progress.lines[0]).toContain(`keep 01 (${file})`)
    expect(progress.lines[0]).toContain('still to finish: 02')
  })

  test('stages every approved guide so none can be quietly dropped', async () => {
    const root = await mkdtemp(join(tmpdir(), 'doxloop-screenshots-'))
    roots.push(root)
    const plan = screenshotPlan()
    plan.pages[0]!.visuals = { ...plan.pages[0]!.visuals!, startPath: '/team', captureSequence: ['Open / — The Invite member dialog is open. — Prove the reader reached it.'], estimatedCaptures: 1 }
    plan.pages.push({ ...plan.pages[0]!, id: 'settings', path: 'settings', title: 'Settings', visuals: { mode: 'required', rationale: 'Show the settings screen.', estimatedCaptures: 2, startPath: '/settings' } })

    expect(await writeScreenshotManifestSkeleton(root, plan)).toBe(2)
    const staged = JSON.parse(await readFile(join(root, SCREENSHOT_MANIFEST_FILE), 'utf8'))
    expect(staged.guides.map((guide: { page: string }) => guide.page)).toEqual(['invite-member', 'settings'])
    // A guide with no capture sequence still gets a row per estimated capture.
    expect(staged.guides[1].steps).toHaveLength(2)
    // "Open /" is too terse for the manifest contract, so it is expanded.
    expect(staged.guides[0].steps[0].action).toBe('Open the application at /')

    // A guide nobody touched is named, with the route to open.
    await expect(validateScreenshotManifest(root, plan, 'enabled')).rejects.toThrow(/Guide "invite-member" was never captured.*Open \/team/s)
    // An existing manifest is never rebuilt from underneath a resumed run.
    expect(await writeScreenshotManifestSkeleton(root, plan)).toBe(0)
  })

  test('keeps screenshots an agent captured but recorded as text-only', async () => {
    const root = await mkdtemp(join(tmpdir(), 'doxloop-screenshots-'))
    roots.push(root)
    await mkdir(join(root, '.doxloop'), { recursive: true })
    await mkdir(join(root, 'assets', 'guides', 'invite-member'), { recursive: true })
    const file = 'assets/guides/invite-member/01-form.png'
    const png = new PNG({ width: 640, height: 360 })
    for (let index = 0; index < png.data.length; index += 4) {
      png.data[index] = (index / 4) % 255
      png.data[index + 1] = Math.floor(index / (4 * 640)) % 255
      png.data[index + 2] = 160
      png.data[index + 3] = 255
    }
    await writeFile(join(root, file), PNG.sync.write(png))
    await writeFile(join(root, 'invite-member.mdx'), '<Steps>\n<Step title="Invite">Select **Invite member**.\n</Step>\n</Steps>\n')
    // The agent took the screenshot, then declared the step text-only because it
    // could not open the saved image to inspect it.
    await writeFile(join(root, SCREENSHOT_MANIFEST_FILE), JSON.stringify({
      schemaVersion: 1,
      guides: [{
        page: 'invite-member',
        steps: [{
          id: '01',
          action: 'Select Invite member from Team settings.',
          expectedState: 'The Invite member dialog is open.',
          purpose: 'Orient the reader and prove that the invitation form opened.',
          capture: false,
          status: 'text-only',
          textOnlyReason: 'The capture surface was not verified during authoring.',
        }],
      }],
    }))

    const plan = screenshotPlan()
    await expect(adoptCapturedImages(root, 'doxbrix', plan)).resolves.toEqual([file])
    await expect(embedMissingCaptures(root, plan)).resolves.toEqual([file])
    await expect(validateScreenshotManifest(root, plan, 'enabled')).resolves.toMatchObject({
      summary: { status: 'verified', captured: 1, guides: 1 },
    })
    const page = await readFile(join(root, 'invite-member.mdx'), 'utf8')
    expect(page).toContain(`](${file})`)
    expect(page.indexOf(file)).toBeLessThan(page.indexOf('</Step>'))
  })

  test('keeps one image when a guide photographs the same screen repeatedly', async () => {
    const root = await mkdtemp(join(tmpdir(), 'doxloop-screenshots-'))
    roots.push(root)
    await mkdir(join(root, '.doxloop'), { recursive: true })
    await mkdir(join(root, 'assets', 'guides', 'invite-member'), { recursive: true })
    const png = new PNG({ width: 640, height: 360 })
    for (let index = 0; index < png.data.length; index += 4) {
      png.data[index] = (index / 4) % 255
      png.data[index + 1] = Math.floor(index / (4 * 640)) % 255
      png.data[index + 2] = 160
      png.data[index + 3] = 255
    }
    // "Scroll to the history area" on a screen that already fits the viewport
    // produces the very same image, so the plan asked for a state that is not one.
    const first = 'assets/guides/invite-member/01-form.png'
    const second = 'assets/guides/invite-member/02-form.png'
    await writeFile(join(root, first), PNG.sync.write(png))
    await writeFile(join(root, second), PNG.sync.write(png))
    await writeFile(join(root, 'invite-member.mdx'), `1. Select **Invite member**.\n\n![Invite form](/${first})\n\n2. Scroll to the history area.\n\n![History](/${second})\n`)
    const step = (id: string, file: string, action: string) => ({
      id,
      action,
      expectedState: `The Invite member screen at step ${id}.`,
      purpose: 'Prove the invitation form state for the reader.',
      capture: true,
      target: 'Invite member dialog',
      file,
      alt: `Invite member screen at step ${id}`,
      status: 'verified',
      checks: { expectedStateConfirmed: true, privacyReviewed: true, legibilityReviewed: true, meaningful: true },
    })
    await writeFile(join(root, SCREENSHOT_MANIFEST_FILE), JSON.stringify({
      schemaVersion: 1,
      guides: [{ page: 'invite-member', steps: [step('01', first, 'Select Invite member from Team settings.'), step('02', second, 'Scroll to the invitation history area.')] }],
    }))

    await expect(collapseDuplicateCaptures(root, screenshotPlan())).resolves.toEqual([second])
    await expect(validateScreenshotManifest(root, screenshotPlan(), 'enabled')).resolves.toMatchObject({
      summary: { status: 'verified', captured: 1, guides: 1 },
    })
    const page = await readFile(join(root, 'invite-member.mdx'), 'utf8')
    expect(page).toContain(first)
    expect(page).not.toContain(second)
    await expect(stat(join(root, second))).rejects.toThrow()
  })

  test('allows two guides to show the same screen', async () => {
    const root = await mkdtemp(join(tmpdir(), 'doxloop-screenshots-'))
    roots.push(root)
    await mkdir(join(root, '.doxloop'), { recursive: true })
    const png = new PNG({ width: 640, height: 360 })
    for (let index = 0; index < png.data.length; index += 4) {
      png.data[index] = (index / 4) % 255
      png.data[index + 1] = Math.floor(index / (4 * 640)) % 255
      png.data[index + 2] = 160
      png.data[index + 3] = 255
    }
    const plan = screenshotPlan()
    plan.pages.push({ ...plan.pages[0]!, id: 'tour', path: 'tour', title: 'Product tour' })
    const guides = []
    for (const name of ['invite-member', 'tour']) {
      await mkdir(join(root, 'assets', 'guides', name), { recursive: true })
      const file = `assets/guides/${name}/01-form.png`
      await writeFile(join(root, file), PNG.sync.write(png))
      await writeFile(join(root, `${name}.mdx`), `1. Select **Invite member**.\n\n![Invite form](/${file})\n`)
      guides.push({
        page: name,
        steps: [{
          id: '01',
          action: 'Select Invite member from Team settings.',
          expectedState: 'The Invite member dialog is open.',
          purpose: 'Prove the invitation form opened for the reader.',
          capture: true,
          target: 'Invite member dialog',
          file,
          alt: 'Invite member dialog open from Team settings',
          status: 'verified',
          checks: { expectedStateConfirmed: true, privacyReviewed: true, legibilityReviewed: true, meaningful: true },
        }],
      })
    }
    await writeFile(join(root, SCREENSHOT_MANIFEST_FILE), JSON.stringify({ schemaVersion: 1, guides }))

    // The shared screen is reported for review, never as a failure.
    await expect(collapseDuplicateCaptures(root, plan)).resolves.toEqual([])
    const result = await validateScreenshotManifest(root, plan, 'enabled')
    expect(result.summary).toMatchObject({ status: 'verified', captured: 2, guides: 2 })
    expect(result.summary.message).toContain('another guide already shows')
  })

  test('leaves an unclaimed image alone when no step number matches it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'doxloop-screenshots-'))
    roots.push(root)
    await mkdir(join(root, '.doxloop'), { recursive: true })
    await mkdir(join(root, 'assets', 'guides', 'invite-member'), { recursive: true })
    await writeFile(join(root, 'assets', 'guides', 'invite-member', 'scratch.png'), PNG.sync.write(new PNG({ width: 8, height: 8 })))
    await writeFile(join(root, SCREENSHOT_MANIFEST_FILE), JSON.stringify({
      schemaVersion: 1,
      guides: [{
        page: 'invite-member',
        steps: [{
          id: '01',
          action: 'Select Invite member from Team settings.',
          expectedState: 'The Invite member dialog is open.',
          purpose: 'Orient the reader and prove that the invitation form opened.',
          capture: false,
          status: 'text-only',
          textOnlyReason: 'The dialog needs a seeded team that this environment has not got.',
        }],
      }],
    }))

    await expect(adoptCapturedImages(root, 'doxbrix', screenshotPlan())).resolves.toEqual([])
  })

  test('blocks a required run that silently omits its capture manifest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'doxloop-screenshots-'))
    roots.push(root)
    await expect(validateScreenshotManifest(root, screenshotPlan(), 'enabled')).rejects.toThrow('Screenshots are required')
    await expect(validateScreenshotManifest(root, screenshotPlan(), 'auto')).resolves.toMatchObject({
      summary: { status: 'skipped', captured: 0 },
    })
    await expect(validateScreenshotManifest(root, undefined, 'enabled')).rejects.toThrow('Screenshots are required')
  })

  test('maps every verified image to its approved capture-sequence item', async () => {
    const root = await mkdtemp(join(tmpdir(), 'doxloop-screenshots-'))
    roots.push(root)
    await mkdir(join(root, '.doxloop'), { recursive: true })
    const plan = screenshotPlan()
    plan.pages[0]!.visuals!.captureSequence = ['Select Invite member — the invitation form is visible — shows where the workflow begins.']
    await writeFile(join(root, SCREENSHOT_MANIFEST_FILE), JSON.stringify({
      schemaVersion: 1,
      guides: [{ page: 'invite-member', steps: [{
        id: '01', action: 'Open the Invite member dialog.', expectedState: 'The invitation form is visible.', purpose: 'Show where the invitation workflow begins.', capture: true, target: 'Invite member dialog', file: 'missing.png', alt: 'Invite member dialog', status: 'verified',
        checks: { expectedStateConfirmed: true, privacyReviewed: true, legibilityReviewed: true, meaningful: true },
      }] }],
    }))

    await expect(validateScreenshotManifest(root, plan, 'enabled')).rejects.toThrow('missing PNG file')
  })

  test('normalizes common agent manifest fields and accepts one meaningful capture per required guide', async () => {
    const root = await mkdtemp(join(tmpdir(), 'doxloop-screenshots-'))
    roots.push(root)
    await mkdir(join(root, '.doxloop'), { recursive: true })
    await mkdir(join(root, 'assets', 'guides', 'invite-member'), { recursive: true })
    const file = 'assets/guides/invite-member/01-form.png'
    const png = new PNG({ width: 640, height: 360 })
    for (let index = 0; index < png.data.length; index += 4) {
      png.data[index] = (index / 4) % 255
      png.data[index + 1] = Math.floor(index / (4 * 640)) % 255
      png.data[index + 2] = 160
      png.data[index + 3] = 255
    }
    await writeFile(join(root, file), PNG.sync.write(png))
    await writeFile(join(root, 'invite-member.mdx'), `![Invite form](/${file})\n`)
    await writeFile(join(root, SCREENSHOT_MANIFEST_FILE), JSON.stringify({
      schemaVersion: 1,
      guides: [{ page: 'invite-member', steps: [{
        id: '01', action: 'Open /', expectedState: 'The invitation form is visible.', purpose: 'Show where the invitation workflow begins.', capture: 'required', target: 'Invite member dialog', file, alt: 'Invite member dialog', status: 'verified',
        checks: { expectedStateConfirmed: true, privacyReviewed: true, legibilityReviewed: true, meaningful: true },
      }] }],
    }))
    const plan = screenshotPlan()
    plan.pages[0]!.visuals!.estimatedCaptures = 2
    plan.pages[0]!.visuals!.captureSequence = [
      'Open / — the member form is visible — orient readers to the workflow.',
      'Submit safe demo details — the success result is visible — prove that the invitation completed.',
    ]
    await expect(validateScreenshotManifest(root, plan, 'enabled')).resolves.toMatchObject({
      summary: { planned: 2, captured: 1, status: 'verified' },
      manifest: { guides: [{ steps: [{ action: 'Open the application at /', capture: true, sequenceItem: 1 }] }] },
    })
  })

  test('maps captures to approved sequence items past interleaved text-only steps', async () => {
    const root = await mkdtemp(join(tmpdir(), 'doxloop-screenshots-'))
    roots.push(root)
    await mkdir(join(root, '.doxloop'), { recursive: true })
    await mkdir(join(root, 'assets', 'guides', 'invite-member'), { recursive: true })
    const file = 'assets/guides/invite-member/02-form.png'
    const png = new PNG({ width: 640, height: 360 })
    for (let index = 0; index < png.data.length; index += 4) {
      png.data[index] = (index / 4) % 255
      png.data[index + 1] = Math.floor(index / (4 * 640)) % 255
      png.data[index + 2] = 160
      png.data[index + 3] = 255
    }
    await writeFile(join(root, file), PNG.sync.write(png))
    await writeFile(join(root, 'invite-member.mdx'), `![Invite form](/${file})\n`)
    await writeFile(join(root, SCREENSHOT_MANIFEST_FILE), JSON.stringify({
      schemaVersion: 1,
      guides: [{ page: 'invite-member', steps: [
        {
          id: '01', action: 'Copy the workspace ID from the settings panel.', expectedState: 'The ID is copied without a durable visual change.', purpose: 'Provide the value the invitation form requires.',
          capture: false, status: 'text-only', textOnlyReason: 'Copying produces no durable visible state worth an image.',
        },
        {
          id: '02', action: 'Open /', expectedState: 'The invitation form is visible.', purpose: 'Show where the invitation workflow begins.',
          capture: true, target: 'Invite member dialog', file, alt: 'Invite member dialog', status: 'verified',
          checks: { expectedStateConfirmed: true, privacyReviewed: true, legibilityReviewed: true, meaningful: true },
        },
      ] }],
    }))
    const plan = screenshotPlan()
    plan.pages[0]!.visuals!.captureSequence = [
      'Open the invitation form — the member form is visible — orient readers to the workflow.',
    ]

    // A text-only first step must not shift the capture onto a nonexistent
    // second sequence item or hide the approved action fallback.
    await expect(validateScreenshotManifest(root, plan, 'enabled')).resolves.toMatchObject({
      summary: { captured: 1, textOnly: 1, status: 'verified' },
      manifest: { guides: [{ steps: [
        { capture: false, status: 'text-only' },
        { action: 'Open the invitation form', capture: true, sequenceItem: 1 },
      ] }] },
    })
  })

  test('accepts a guide written at a generator-native path and rejects repeated images', async () => {
    const root = await mkdtemp(join(tmpdir(), 'doxloop-screenshots-'))
    roots.push(root)
    await mkdir(join(root, '.doxloop'), { recursive: true })
    await mkdir(join(root, 'assets', 'guides', 'invite-member'), { recursive: true })
    const image = (seed: number) => {
      const png = new PNG({ width: 640, height: 360 })
      for (let index = 0; index < png.data.length; index += 4) {
        png.data[index] = ((index / 4) + seed) % 255
        png.data[index + 1] = Math.floor(index / (4 * 640)) % 255
        png.data[index + 2] = 160
        png.data[index + 3] = 255
      }
      return PNG.sync.write(png)
    }
    const first = 'assets/guides/invite-member/01-form.png'
    const second = 'assets/guides/invite-member/02-sent.png'
    await writeFile(join(root, first), image(0))
    await writeFile(join(root, second), image(0))
    // The plan slug is "invite-member", but a Doxbrix landing page is written
    // as index.mdx. That placement must not read as a missing screenshot.
    await writeFile(join(root, 'index.mdx'), `![Form](/${first})\n\n![Sent](/${second})\n`)
    const steps = [first, second].map((file, index) => ({
      id: `0${index + 1}`,
      action: `Open the invitation step ${index + 1}.`,
      expectedState: 'The expected screen is visible.',
      purpose: 'Prove the reader reached this state.',
      capture: true,
      target: 'Invite member dialog',
      file,
      alt: `Invitation step ${index + 1}`,
      status: 'verified',
      checks: { expectedStateConfirmed: true, privacyReviewed: true, legibilityReviewed: true, meaningful: true },
    }))
    const write = async (used: typeof steps) => writeFile(
      join(root, SCREENSHOT_MANIFEST_FILE),
      JSON.stringify({ schemaVersion: 1, guides: [{ page: 'invite-member', steps: used }] }),
    )

    await write(steps)
    // Both files exist and are embedded, but one repeats the other inside the
    // same guide, so that guide's workflow never advanced.
    await expect(validateScreenshotManifest(root, screenshotPlan(), 'enabled')).rejects.toThrow(/photographed the same screen more than once/)

    await writeFile(join(root, second), image(97))
    await write(steps)
    await expect(validateScreenshotManifest(root, screenshotPlan(), 'enabled')).resolves.toMatchObject({
      summary: { status: 'verified', captured: 2 },
    })
  })

  test('creates the guide asset directories the capture tool cannot create itself', async () => {
    const root = await mkdtemp(join(tmpdir(), 'doxloop-screenshots-'))
    roots.push(root)
    const plan = screenshotPlan()
    plan.pages.push({
      ...plan.pages[0]!,
      id: 'connect-source',
      path: 'guides/connect-source',
      visuals: { mode: 'required', rationale: 'Show the source form.', estimatedCaptures: 1 },
    })
    plan.pages.push({ ...plan.pages[0]!, id: 'cli', path: 'cli', visuals: { mode: 'none', rationale: 'CLI only.', estimatedCaptures: 0 } })

    const created = await prepareGuideAssetDirectories(root, 'doxbrix', plan, '')
    // Both the page id and its last path segment are covered, because agents
    // name the folder either way; pages without visuals are skipped.
    expect(created).toContain(join('assets', 'guides', 'invite-member'))
    expect(created).toContain(join('assets', 'guides', 'connect-source'))
    expect(created.some((directory) => directory.endsWith('cli'))).toBe(false)
    await expect(stat(join(root, 'assets', 'guides', 'connect-source'))).resolves.toBeDefined()

    // Each generator writes into its own committed asset root.
    const hugo = await mkdtemp(join(tmpdir(), 'doxloop-screenshots-'))
    roots.push(hugo)
    expect(await prepareGuideAssetDirectories(hugo, 'hugo', plan, '')).toContain(join('static', 'images', 'guides', 'invite-member'))
  })

  test('places verified captures the agent left unembedded into their steps', async () => {
    const root = await mkdtemp(join(tmpdir(), 'doxloop-screenshots-'))
    roots.push(root)
    await mkdir(join(root, '.doxloop'), { recursive: true })
    await mkdir(join(root, 'assets', 'guides', 'invite-member'), { recursive: true })
    const files = ['01-open.png', '02-form.png', '03-sent.png'].map((name) => `assets/guides/invite-member/${name}`)
    for (const [index, file] of files.entries()) {
      const png = new PNG({ width: 640, height: 360 })
      for (let pixel = 0; pixel < png.data.length; pixel += 4) {
        png.data[pixel] = ((pixel / 4) + index * 40) % 255
        png.data[pixel + 1] = Math.floor(pixel / (4 * 640)) % 255
        png.data[pixel + 2] = 160
        png.data[pixel + 3] = 255
      }
      await writeFile(join(root, file), PNG.sync.write(png))
    }
    // The agent wrote a step procedure but embedded only the first image.
    await writeFile(join(root, 'invite-member.mdx'), [
      '<Steps>',
      '<Step title="Open settings">Open Team settings.</Step>',
      '<Step title="Open the form">Select Invite member.</Step>',
      '<Step title="Send">Select Send.</Step>',
      '</Steps>',
      '',
      `![Team settings](/${files[0]})`,
      '',
    ].join('\n'))
    await writeFile(join(root, SCREENSHOT_MANIFEST_FILE), JSON.stringify({
      schemaVersion: 1,
      guides: [{ page: 'invite-member', steps: files.map((file, index) => ({
        id: `0${index + 1}`,
        action: `Complete invitation step ${index + 1}.`,
        expectedState: 'The expected screen is visible.',
        purpose: 'Prove the reader reached this state.',
        capture: true, target: 'Invite member dialog', file, alt: `Invitation step ${index + 1}`, status: 'verified',
        checks: { expectedStateConfirmed: true, privacyReviewed: true, legibilityReviewed: true, meaningful: true },
      })) }],
    }))

    const placed = await embedMissingCaptures(root, screenshotPlan())
    // The already-embedded first image is left alone; the orphans are placed.
    expect(placed).toEqual([files[1], files[2]])
    const page = await readFile(join(root, 'invite-member.mdx'), 'utf8')
    const second = page.indexOf('02-form.png')
    const third = page.indexOf('03-sent.png')
    expect(second).toBeGreaterThan(page.indexOf('Select Invite member.'))
    expect(second).toBeLessThan(page.indexOf('Select Send.'))
    expect(third).toBeGreaterThan(page.indexOf('Select Send.'))
    await expect(validateScreenshotManifest(root, screenshotPlan(), 'enabled')).resolves.toMatchObject({
      summary: { status: 'verified', captured: 3 },
    })
  })

  test('reports every capture problem in one pass', async () => {
    const root = await mkdtemp(join(tmpdir(), 'doxloop-screenshots-'))
    roots.push(root)
    await mkdir(join(root, '.doxloop'), { recursive: true })
    await writeFile(join(root, 'invite-member.mdx'), 'No image here.\n')
    const step = (id: string, file: string) => ({
      id,
      action: `Open the invitation step ${id}.`,
      expectedState: 'The invitation form is visible.',
      purpose: 'Prove the reader reached this state.',
      capture: true,
      target: 'Invite member dialog',
      file,
      alt: `Invitation step ${id}`,
      status: 'verified',
      checks: { expectedStateConfirmed: true, privacyReviewed: true, legibilityReviewed: true, meaningful: true },
    })
    await writeFile(join(root, SCREENSHOT_MANIFEST_FILE), JSON.stringify({
      schemaVersion: 1,
      guides: [{
        page: 'invite-member',
        // Three steps claim verified captures that were never taken.
        steps: ['01', '02', '03'].map((id) => step(id, `assets/guides/invite-member/${id}.png`)),
      }],
    }))

    const error = await validateScreenshotManifest(root, screenshotPlan(), 'enabled').catch((cause: Error) => cause)
    expect(error).toBeInstanceOf(Error)
    const message = (error as Error).message
    // Every fabricated row is listed, not just the first one encountered.
    expect(message).toContain('3 screenshot problems')
    for (const id of ['01', '02', '03']) expect(message).toContain(`${id}.png`)
    expect(message).toContain('marked verified but never captured')
  })

  test('still fails a run whose screenshots are mostly the same picture', async () => {
    const root = await mkdtemp(join(tmpdir(), 'doxloop-screenshots-'))
    roots.push(root)
    await mkdir(join(root, '.doxloop'), { recursive: true })
    await mkdir(join(root, 'assets', 'guides', 'invite-member'), { recursive: true })
    const png = new PNG({ width: 640, height: 360 })
    for (let index = 0; index < png.data.length; index += 4) {
      png.data[index] = (index / 4) % 255
      png.data[index + 1] = Math.floor(index / (4 * 640)) % 255
      png.data[index + 2] = 160
      png.data[index + 3] = 255
    }
    const files = ['01', '02', '03'].map((id) => `assets/guides/invite-member/${id}.png`)
    for (const file of files) await writeFile(join(root, file), PNG.sync.write(png))
    await writeFile(join(root, 'invite-member.mdx'), files.map((file) => `![Step](/${file})`).join('\n\n'))
    await writeFile(join(root, SCREENSHOT_MANIFEST_FILE), JSON.stringify({
      schemaVersion: 1,
      guides: [{ page: 'invite-member', steps: files.map((file, index) => ({
        id: `0${index + 1}`,
        action: `Open the invitation step ${index + 1}.`,
        expectedState: 'The invitation form is visible.',
        purpose: 'Prove the reader reached this state.',
        capture: true, target: 'Invite member dialog', file, alt: `Step ${index + 1}`, status: 'verified',
        checks: { expectedStateConfirmed: true, privacyReviewed: true, legibilityReviewed: true, meaningful: true },
      })) }],
    }))

    // Two of three captures repeat, so the capture pass did not really happen.
    await expect(validateScreenshotManifest(root, screenshotPlan(), 'enabled')).rejects.toThrow(/photographed the same screen more than once/)
  })

  test('rejects a splash or still-loading screen captured before the page rendered', async () => {
    const root = await mkdtemp(join(tmpdir(), 'doxloop-screenshots-'))
    roots.push(root)
    await mkdir(join(root, '.doxloop'), { recursive: true })
    await mkdir(join(root, 'assets', 'guides', 'invite-member'), { recursive: true })
    const file = 'assets/guides/invite-member/01-form.png'
    // A splash screen: one background colour with a small mark on it, which the
    // old "at least four colours" check happily accepted.
    const png = new PNG({ width: 640, height: 360 })
    for (let index = 0; index < png.data.length; index += 4) {
      const pixel = index / 4
      const badge = pixel % 640 > 300 && pixel % 640 < 316 && Math.floor(pixel / 640) > 170 && Math.floor(pixel / 640) < 186
      png.data[index] = badge ? (pixel % 200) : 250
      png.data[index + 1] = badge ? 180 : 250
      png.data[index + 2] = badge ? 170 : 250
      png.data[index + 3] = 255
    }
    await writeFile(join(root, file), PNG.sync.write(png))
    await writeFile(join(root, 'invite-member.mdx'), `![Form](/${file})\n`)
    await writeFile(join(root, SCREENSHOT_MANIFEST_FILE), JSON.stringify({
      schemaVersion: 1,
      guides: [{ page: 'invite-member', steps: [{
        id: '01', action: 'Open the invitation form.', expectedState: 'The invitation form is visible.', purpose: 'Prove the form opened.',
        capture: true, target: 'Invite member dialog', file, alt: 'Invite member dialog', status: 'verified',
        checks: { expectedStateConfirmed: true, privacyReviewed: true, legibilityReviewed: true, meaningful: true },
      }] }],
    }))

    await expect(validateScreenshotManifest(root, screenshotPlan(), 'enabled')).rejects.toThrow(/single color/)
  })

  test('allows automatic screenshot candidates to become explained text-only steps', async () => {
    const root = await mkdtemp(join(tmpdir(), 'doxloop-screenshots-'))
    roots.push(root)
    await mkdir(join(root, '.doxloop'), { recursive: true })
    const plan = screenshotPlan()
    plan.pages[0]!.visuals = {
      mode: 'recommended',
      rationale: 'Useful visual context when the application state is available.',
      estimatedCaptures: 3,
      captureSequence: [
        'Open the control center — overview is visible — orient the reader.',
        'Open Sources — source coverage is visible — explain coverage.',
        'Open Deployments — deployment state is visible — confirm the result.',
      ],
    }
    await writeFile(join(root, SCREENSHOT_MANIFEST_FILE), JSON.stringify({
      schemaVersion: 1,
      guides: [{
        page: 'invite-member',
        steps: plan.pages[0]!.visuals.captureSequence!.map((item, index) => ({
          id: String(index + 1).padStart(2, '0'),
          action: item.split(' — ')[0],
          expectedState: item.split(' — ')[1],
          purpose: item.split(' — ')[2],
          capture: false,
          status: 'text-only',
          textOnlyReason: 'The configured application state was not available to the capture browser.',
        })),
      }],
    }))

    await expect(validateScreenshotManifest(root, plan, 'auto')).resolves.toMatchObject({
      summary: { status: 'skipped', captured: 0, textOnly: 3 },
    })
  })

  test('checks whether the configured application is reachable', async () => {
    const server = createServer((_request, response) => { response.statusCode = 200; response.end('ready') })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    try {
      if (!address || typeof address === 'string') throw new Error('Missing test server address')
      await expect(checkApplicationReadiness({ baseUrl: `http://127.0.0.1:${address.port}`, readyPath: '/health' })).resolves.toMatchObject({ status: 'ready', reachable: true })
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    }
  })

  test('reports how sign-in will be handled from the saved session and credentials', async () => {
    const server = createServer((request, response) => {
      if (request.headers.cookie?.includes('sid=valid')) { response.statusCode = 200; response.end('signed in'); return }
      response.statusCode = 302
      response.setHeader('location', '/login')
      response.end()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    try {
      if (!address || typeof address === 'string') throw new Error('Missing test server address')
      const application = { baseUrl: `http://127.0.0.1:${address.port}`, readyPath: '/app' }
      const session = (value: string) => ({ cookies: [{ name: 'sid', value, domain: '127.0.0.1', path: '/', expires: -1, httpOnly: true, secure: false, sameSite: 'Lax' as const }], origins: [] })

      await expect(checkApplicationReadiness(application, { credentials: false })).resolves.toMatchObject({ status: 'authentication-required', authentication: 'none' })
      await expect(checkApplicationReadiness(application, { session: session('valid'), credentials: false })).resolves.toMatchObject({ status: 'ready', authentication: 'session' })
      await expect(checkApplicationReadiness(application, { session: session('stale'), credentials: false })).resolves.toMatchObject({ status: 'authentication-required', authentication: 'expired' })
      await expect(checkApplicationReadiness(application, { session: session('stale'), credentials: true })).resolves.toMatchObject({ status: 'ready', authentication: 'credentials' })
      await expect(checkApplicationReadiness(application, { credentials: true })).resolves.toMatchObject({ status: 'ready', authentication: 'credentials' })
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    }
  })

  test('follows same-origin redirects and treats only sign-in, external, and looping redirects as blockers', async () => {
    const server = createServer((request, response) => {
      if (request.url === '/dashboard') { response.statusCode = 200; response.end('app shell'); return }
      response.statusCode = 302
      const location = request.url === '/auth-check' ? '/login'
        : request.url === '/signup' ? '/dashboard'
        : request.url === '/external' ? 'https://example.com/elsewhere'
        : '/moved'
      response.setHeader('location', location)
      response.end()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    try {
      if (!address || typeof address === 'string') throw new Error('Missing test server address')
      const baseUrl = `http://127.0.0.1:${address.port}`
      const session = { cookies: [{ name: 'sid', value: 'valid', domain: '127.0.0.1', path: '/', expires: -1, httpOnly: true, secure: false, sameSite: 'Lax' as const }], origins: [] }
      await expect(checkApplicationReadiness({ baseUrl, readyPath: '/auth-check' })).resolves.toMatchObject({ status: 'authentication-required', reachable: true })
      // A signed-in session bounced from the sign-up route to the app shell is still a reachable page.
      await expect(checkApplicationReadiness({ baseUrl, readyPath: '/signup' }, { session, credentials: false })).resolves.toMatchObject({
        status: 'ready',
        reachable: true,
        authentication: 'session',
        message: expect.stringContaining('redirects to /dashboard'),
      })
      await expect(checkApplicationReadiness({ baseUrl, readyPath: '/external' })).resolves.toMatchObject({ status: 'unreachable', reachable: false, message: expect.stringContaining('outside the configured application') })
      await expect(checkApplicationReadiness({ baseUrl, readyPath: '/redirect-check' })).resolves.toMatchObject({ status: 'unreachable', reachable: false, message: expect.stringContaining('redirects without reaching a page') })
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    }
  })
})
