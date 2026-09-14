import { execFile, spawn } from 'node:child_process'
import { chmod, copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { expect, test } from '@playwright/test'

const execute = promisify(execFile)
const enabled = process.env.DOXLOOP_E2E_REAL === '1'

test.skip(!enabled, 'Set DOXLOOP_E2E_REAL=1 to run the real server and fake-agent smoke test.')

test('real Pages flow creates, accepts, and undoes a scoped edit', async ({ page }) => {
  test.setTimeout(120_000)
  page.setDefaultTimeout(15_000)
  const cli = resolve('dist/cli.js')
  const scratch = await mkdtemp(join(tmpdir(), 'doxloop-pages-real-'))
  const fakeAgent = join(scratch, 'fake-page-edit-agent.mjs')
  await copyFile(resolve('e2e/fake-page-edit-agent.mjs'), fakeAgent)
  await chmod(fakeAgent, 0o755)
  let ui
  let root = ''
  try {
    const demo = await execute(process.execPath, [cli, 'demo', '--no-preview', '--keep'], { cwd: scratch })
    root = /Workspace:\s+(.+)/.exec(demo.stdout)?.[1]?.trim() ?? ''
    expect(root).not.toBe('')
    const originalEvents = await readFile(join(root, 'reference/events.mdx'), 'utf8')
    const richFixture = '\n## Editable rich content\n\n- **Source-grounded research.** Use [evidence](/reference/events "Evidence details") and `code`.\n- **Plan before writing.** Keep _emphasis_.\n\n| Field | Meaning |\n| --- | --- |\n| name | A **rich** description. |\n\nRepeated sentence.\n\nRepeated sentence.\n'
    const originalOverview = await readFile(join(root, 'index.mdx'), 'utf8') + richFixture
    await writeFile(join(root, 'index.mdx'), originalOverview)
    const port = await freePort()
    ui = spawn(process.execPath, [cli, 'ui', '--no-open', '--port', String(port), '--cwd', root], {
      cwd: root,
      env: { ...process.env, DOXLOOP_AGENT_EXECUTABLE_CODEX: fakeAgent },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    await waitForOutput(ui, `http://127.0.0.1:${port}/overview`)

    await page.goto(`http://127.0.0.1:${port}/pages`)
    await expect(page.getByRole('treeitem').filter({ hasText: 'Events API' })).toBeVisible({ timeout: 30_000 })
    await page.frameLocator('iframe[title="Current page preview"]').getByRole('link', { name: 'Events API reference', exact: true }).click()
    await expect(page.getByRole('checkbox', { name: 'Select Events API', exact: true })).toBeChecked()
    const focusedPreview = page.frameLocator('iframe[title="Current page preview"]')
    await expect(focusedPreview.getByRole('heading', { name: 'Events API' })).toBeVisible()
    await expect(focusedPreview.getByRole('navigation', { name: 'Documentation navigation' })).toBeHidden()
    await page.getByRole('button', { name: 'Instruct agent', exact: true }).click()
    await page.getByLabel('What should change on this page?').fill('Add the smoke-test clarification.')
    await page.getByRole('button', { name: 'Generate proposal' }).click()
    await expect(page.getByRole('heading', { name: 'Review this edit' })).toBeVisible({ timeout: 90_000 })
    await page.getByRole('button', { name: 'Accept', exact: true }).click()
    await expect(page.getByRole('status').filter({ hasText: 'Page updated' })).toBeVisible()
    const undone = page.waitForResponse((response) => response.url().endsWith('/undo') && response.request().method() === 'POST')
    await page.getByRole('status').filter({ hasText: 'Page updated' }).getByRole('button', { name: 'Undo' }).click()
    expect((await undone).ok()).toBe(true)
    await expect.poll(() => readFile(join(root, 'reference/events.mdx'), 'utf8')).toBe(originalEvents)
    await expect(focusedPreview.getByText('This page now includes the requested smoke-test clarification.')).toBeHidden()
    await page.getByRole('button', { name: 'Close agent panel' }).click()
    await page.getByRole('treeitem').filter({ has: page.getByRole('checkbox', { name: 'Select Pulse API overview', exact: true }) }).click()
    await expect(page.getByTitle('Current page preview')).toBeVisible()
    await page.getByRole('treeitem').filter({ hasText: 'Get started' }).press('F2')
    await page.getByRole('textbox', { name: 'Rename Get started', exact: true }).fill('Start here')
    await page.getByRole('textbox', { name: 'Rename Get started', exact: true }).press('Enter')
    await page.getByRole('button', { name: 'Change icon for Overview', exact: true }).click()
    await page.getByRole('button', { name: 'Use rocket icon', exact: true }).click()
    const navigationSaved = page.waitForResponse(response => response.url().endsWith('/api/navigation') && response.request().method() === 'PUT')
    await page.getByRole('button', { name: 'Save navigation', exact: true }).click()
    const navigationResponse = await navigationSaved
    expect(navigationResponse.ok()).toBe(true)
    const savedNavigation = await navigationResponse.json()
    expect(await readFile(join(root, savedNavigation.configFile), 'utf8')).toContain('Start here')
    expect(savedNavigation.spaces[0].nav[0].items.find(item => item.file === 'index')).toMatchObject({ icon: 'rocket' })
    await expect(page.getByRole('button', { name: 'Save navigation', exact: true })).toBeDisabled()
    await expect(page.getByRole('treeitem').filter({ hasText: 'Start here' })).toBeVisible()
    expect(await readFile(join(root, 'index.mdx'), 'utf8')).toBe(originalOverview)
    await page.getByRole('button', { name: 'Edit content', exact: true }).click()
    const visual = page.frameLocator('iframe[title="Editable page preview"]')
    await expect(visual.locator('.dp-p[role="textbox"]').first()).toBeVisible()
    await visual.locator('.dp-p[role="textbox"]').first().fill('A visual-edit verification sentence.')
    await page.getByRole('button', { name: 'Save changes', exact: true }).click()
    await expect.poll(() => readFile(join(root, 'index.mdx'), 'utf8')).toContain('A visual-edit verification sentence.')
    await page.getByRole('button', { name: 'Undo saved edit', exact: true }).click()
    await expect.poll(() => readFile(join(root, 'index.mdx'), 'utf8')).toBe(originalOverview)
    await expect(page.getByRole('button', { name: 'Edit content', exact: true })).toBeEnabled()
    await page.getByRole('button', { name: 'Edit content', exact: true }).click()
    const item = visual.getByRole('textbox', { name: 'Edit list item', exact: true }).filter({ has: visual.locator('code').filter({ hasText: /^code$/ }) })
    await expect(item).toBeVisible()
    await visual.getByRole('textbox', { name: 'Edit list item', exact: true }).filter({ hasText: 'Plan before writing.' }).dispatchEvent('input')
    await expect(page.getByRole('button', { name: 'Save changes', exact: true })).toBeDisabled()
    // Edit inside marks with real keyboard input, preserving their DOM structure.
    await item.locator('strong').evaluate(el => { const range = document.createRange(); range.selectNodeContents(el); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range); el.parentElement.focus() })
    await page.keyboard.type('Verified research.')
    await item.locator('[data-edit-link-label]').evaluate(el => { el.focus(); const range = document.createRange(); range.selectNodeContents(el); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range) })
    await page.keyboard.type('trusted sources')
    const cell = visual.getByRole('textbox', { name: 'Edit table cell', exact: true }).filter({ hasText: 'A rich description.' })
    await cell.locator('strong').evaluate(el => { const range = document.createRange(); range.selectNodeContents(el); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range); el.parentElement.focus() })
    await page.keyboard.type('clear')
    const repeated = visual.getByRole('textbox', { name: 'Edit paragraph', exact: true }).filter({ hasText: /^Repeated sentence\.$/ })
    await expect(repeated).toHaveCount(2)
    await repeated.nth(1).fill('Only the second occurrence changed.')
    await visual.locator('.dp-page-title[role="textbox"]').fill('Pulse API overview: verified')
    await page.getByRole('button', { name: 'Save changes', exact: true }).click()
    const expectedRichEdit = originalOverview.replace(/^title:[^\r\n]+/m, 'title: "Pulse API overview: verified"').replace('**Source-grounded research.**', '**Verified research.**').replace('[evidence](/reference/events "Evidence details")', '[trusted sources](/reference/events "Evidence details")').replace('A **rich** description.', 'A **clear** description.').replace('Repeated sentence.\n\nRepeated sentence.', 'Repeated sentence.\n\nOnly the second occurrence changed.')
    await expect.poll(() => readFile(join(root, 'index.mdx'), 'utf8')).toBe(expectedRichEdit)
    await expect(page.frameLocator('iframe[title="Current page preview"]').locator('li strong').filter({ hasText: 'Verified research.' })).toBeVisible()
    await expect(page.frameLocator('iframe[title="Current page preview"]').getByRole('link', { name: 'trusted sources' })).toHaveAttribute('href', '/reference/events')
    await page.getByRole('button', { name: 'Undo saved edit', exact: true }).click()
    await expect.poll(() => readFile(join(root, 'index.mdx'), 'utf8')).toBe(originalOverview)
    await expect(page.getByRole('button', { name: 'Edit content', exact: true })).toBeEnabled()
    await page.getByRole('treeitem').filter({ hasText: 'Events API' }).click()
    await expect(page).toHaveURL(/path=reference%2Fevents\.mdx/)
    await page.getByRole('button', { name: 'Edit content', exact: true }).click()
    await page.getByRole('button', { name: 'Edit source', exact: true }).click()
    await page.getByLabel('Page source', { exact: true }).fill(`${originalEvents}\nA direct-edit verification sentence.\n`)
    await page.getByRole('button', { name: 'Save changes', exact: true }).click()
    await expect.poll(() => readFile(join(root, 'reference/events.mdx'), 'utf8')).toContain('A direct-edit verification sentence.')
    await page.getByRole('button', { name: 'Undo saved edit', exact: true }).click()
    await expect.poll(() => readFile(join(root, 'reference/events.mdx'), 'utf8')).toBe(originalEvents)
    await page.getByRole('button', { name: 'Page options', exact: true }).click()

    await page.getByText('Comments and agent requests', { exact: true }).click()
    await page.getByLabel('Comment', { exact: true }).fill('Explain recovery after a temporary timeout.')
    await page.getByRole('button', { name: 'Save comment', exact: true }).click()
    await expect(page.getByText('Explain recovery after a temporary timeout.', { exact: true })).toBeVisible()
    await page.reload()
    await page.getByRole('button', { name: 'Page options', exact: true }).click()
    await page.getByText('Comments and agent requests', { exact: true }).click()
    await expect(page.getByText('Explain recovery after a temporary timeout.', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Resolve comment', exact: true }).click()
    await expect(page.getByText(/· Resolved/)).toBeVisible()
    await page.getByPlaceholder('Search titles, paths, or page text').fill('event')
    await expect(page.locator('.page-text-matches button').first()).toBeVisible()
    await page.locator('.page-text-matches button').first().click()
    await expect(page.getByLabel('Page source', { exact: true })).toBeVisible()
    await page.getByPlaceholder('Search titles, paths, or page text').fill('')
    await expect(page.getByPlaceholder('Search titles, paths, or page text')).toHaveValue('')
    await expect(page.getByRole('button', { name: 'Save changes', exact: true })).toBeDisabled()
    await page.getByRole('button', { name: 'Workspace tools' }).click()
    await page.getByText('Audit existing documentation and reader verification', { exact: true }).click()
    await page.getByRole('button', { name: 'Run read-only audit', exact: true }).click()
    await expect(page.getByText(/Read-only audit. No pages/)).toBeVisible()
    const batch = await page.evaluate(async () => {
      const paths = ['index.mdx', 'reference/events.mdx']
      const writes = await Promise.all(paths.map(async (path) => { const current = await (await fetch(`/api/pages/metadata?path=${encodeURIComponent(path)}`)).json(); return { path, fingerprint: current.fingerprint, fields: { icon: 'book' } } }))
      const saved = await fetch('/api/pages/bulk-metadata', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ writes }) })
      const result = await saved.json()
      if (!saved.ok) throw new Error(result.error)
      const undone = await fetch(`/api/direct-edits/${result.editId}/undo`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      return undone.ok
    })
    expect(batch).toBe(true)
    await page.getByText('Versions and languages', { exact: true }).click()
    const versions = page.locator('.text-editor').filter({ has: page.getByText('Create collection', { exact: true }) })
    await versions.getByLabel('Version', { exact: true }).fill('1.0')
    await versions.getByRole('button', { name: 'Create collection', exact: true }).click()
    await expect(versions.getByText(/Collection created/)).toBeVisible()
    await expect(page.getByLabel('Version / locale', { exact: true })).toBeVisible()
    await page.screenshot({ path: join(scratch, 'editing-audit.png'), fullPage: true })

  } finally {
    if (ui) await stopChild(ui)
    if (root) await rm(root, { recursive: true, force: true })
    await rm(scratch, { recursive: true, force: true })
  }
})

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode) return
  await new Promise((resolveExit) => {
    const timeout = setTimeout(resolveExit, 5_000)
    child.once('exit', () => {
      clearTimeout(timeout)
      resolveExit()
    })
    child.kill('SIGTERM')
  })
}

async function freePort() {
  const server = createServer()
  await new Promise((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  await new Promise((resolveClose) => server.close(resolveClose))
  return port
}

async function waitForOutput(child, expected) {
  await new Promise((resolveReady, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${expected}`)), 20_000)
    const inspect = (chunk) => {
      if (!chunk.toString().includes(expected)) return
      clearTimeout(timeout)
      resolveReady()
    }
    child.stdout.on('data', inspect)
    child.stderr.on('data', inspect)
    child.once('exit', (code) => {
      clearTimeout(timeout)
      reject(new Error(`Doxloop UI exited early with code ${code}`))
    })
  })
}
