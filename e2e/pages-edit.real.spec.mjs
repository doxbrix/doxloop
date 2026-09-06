import { execFile, spawn } from 'node:child_process'
import { chmod, copyFile, mkdtemp, readFile, rm } from 'node:fs/promises'
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
    const port = await freePort()
    ui = spawn(process.execPath, [cli, 'ui', '--no-open', '--port', String(port), '--cwd', root], {
      cwd: root,
      env: { ...process.env, DOXLOOP_AGENT_EXECUTABLE_CODEX: fakeAgent },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    await waitForOutput(ui, `http://127.0.0.1:${port}/overview`)

    await page.goto(`http://127.0.0.1:${port}/pages`)
    await expect(page.getByRole('option', { name: /Events API/ })).toBeVisible({ timeout: 30_000 })
    await page.getByRole('checkbox', { name: /Select Pulse API overview/ }).uncheck()
    await page.getByRole('option', { name: /Events API/ }).click()
    const focusedPreview = page.frameLocator('iframe[title="Current page preview"]')
    await expect(focusedPreview.getByRole('heading', { name: 'Events API' })).toBeVisible()
    await expect(focusedPreview.getByRole('navigation', { name: 'Documentation navigation' })).toBeHidden()
    await page.getByLabel('What should change on this page?').fill('Add the smoke-test clarification.')
    await page.getByRole('button', { name: 'Ask the agent to edit' }).click()
    await expect(page.getByRole('heading', { name: 'Review this edit' })).toBeVisible({ timeout: 90_000 })
    await page.getByRole('button', { name: 'Accept', exact: true }).click()
    await expect(page.getByRole('status')).toContainText('Page updated')
    const undone = page.waitForResponse((response) => response.url().endsWith('/undo') && response.request().method() === 'POST')
    await page.getByRole('status').getByRole('button', { name: 'Undo' }).click()
    expect((await undone).ok()).toBe(true)
    await expect.poll(() => readFile(join(root, 'reference/events.mdx'), 'utf8')).toBe(originalEvents)
    await expect(focusedPreview.getByText('This page now includes the requested smoke-test clarification.')).toBeHidden()
    await page.getByText('Edit text directly', { exact: false }).first().click()
    const editor = page.locator('.text-editor').filter({ has: page.getByLabel('Page source', { exact: true }) })
    await editor.getByLabel('Page source', { exact: true }).fill(`${originalEvents}\nA direct-edit verification sentence.\n`)
    await editor.getByRole('button', { name: 'Preview draft', exact: true }).click()
    await expect(editor.frameLocator('iframe[title="Unsaved text preview"]').getByText('A direct-edit verification sentence.')).toBeVisible()
    await editor.getByRole('button', { name: 'Save page', exact: true }).click()
    await expect.poll(() => readFile(join(root, 'reference/events.mdx'), 'utf8')).toContain('A direct-edit verification sentence.')
    await editor.getByRole('button', { name: 'Undo saved edit', exact: true }).click()
    await expect.poll(() => readFile(join(root, 'reference/events.mdx'), 'utf8')).toBe(originalEvents)

    await page.getByText('Comments and agent requests', { exact: true }).click()
    await page.getByLabel('Comment', { exact: true }).fill('Explain recovery after a temporary timeout.')
    await page.getByRole('button', { name: 'Save comment', exact: true }).click()
    await expect(page.getByText('Explain recovery after a temporary timeout.', { exact: true })).toBeVisible()
    await page.reload()
    await page.getByText('Comments and agent requests', { exact: true }).click()
    await expect(page.getByText('Explain recovery after a temporary timeout.', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Resolve comment', exact: true }).click()
    await expect(page.getByText(/· Resolved/)).toBeVisible()
    await page.getByPlaceholder('Search titles, paths, or page text').fill('event')
    await expect(page.locator('.page-text-matches button').first()).toBeVisible()
    await page.locator('.page-text-matches button').first().click()
    await expect(page.getByLabel('Page source', { exact: true })).toBeVisible()
    await page.getByPlaceholder('Search titles, paths, or page text').fill('')
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
