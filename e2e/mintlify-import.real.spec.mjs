import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, test } from '@playwright/test'

test('converts a local Mintlify folder through setup and opens editable Doxbrix pages', async ({ page }) => {
  test.setTimeout(90_000)
  const scratch = await mkdtemp(join(tmpdir(), 'doxloop-mintlify-ui-'))
  const source = join(scratch, 'mintlify')
  const destination = join(scratch, 'converted')
  let ui
  try {
    await mkdir(source)
    await writeFile(join(source, 'docs.json'), JSON.stringify({
      name: 'Acme docs',
      colors: { primary: '#123456' },
      navigation: { groups: [{ group: 'Start', pages: ['intro'] }] },
    }))
    const original = '---\ntitle: Introduction\ndescription: Learn to use Acme.\n---\n\nWelcome to Acme.\n\n<Info>A preserved callout.</Info>\n'
    await writeFile(join(source, 'intro.mdx'), original)
    const port = await freePort()
    ui = spawn(process.execPath, [resolve('dist/cli.js'), 'ui', '--no-open', '--port', String(port), '--cwd', scratch], {
      env: { ...process.env, DOXLOOP_HOME: join(scratch, 'home') },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    await waitForOutput(ui, 'Doxloop UI:')
    await page.goto('http://127.0.0.1:' + port + '/overview')
    await page.getByRole('radio', { name: /existing documentation folder/ }).click()
    await page.getByRole('tab', { name: 'Mintlify to Doxbrix', exact: true }).click()
    // Exercise the GitHub form and warning gate without relying on the network in browser CI.
    let githubInput
    await page.route('**/api/projects/mintlify/inspect', async route => {
      githubInput = route.request().postDataJSON()
      await route.fulfill({ json: {
        id: 'github-preview', title: 'GitHub docs', source: { repository: 'https://github.com/team/docs.git', branch: 'release', subdirectory: 'website' },
        pageCount: 1, assetCount: 0, spaces: ['Docs'], pages: ['intro.mdx'], redirects: [],
        unmapped: ['<CustomWidget>'], warnings: [], suggestedDestination: destination,
      } })
    })
    await page.getByRole('tab', { name: 'GitHub repository', exact: true }).click()
    await page.getByRole('textbox', { name: 'GitHub repository', exact: true }).fill('team/docs')
    await page.getByRole('textbox', { name: 'Branch (optional)', exact: true }).fill('release')
    await page.getByRole('textbox', { name: 'Documentation subfolder (optional)', exact: true }).fill('website')
    await page.getByRole('button', { name: 'Review conversion', exact: true }).click()
    await expect(page.getByText('GitHub docs → Doxbrix', { exact: true })).toBeVisible()
    expect(githubInput).toMatchObject({ repository: 'team/docs', branch: 'release', subdirectory: 'website', authMethod: 'automatic' })
    await expect(page.getByRole('button', { name: 'Convert and open Doxbrix project', exact: true })).toBeDisabled()
    await page.getByRole('checkbox', { name: /I understand these limitations/ }).check()
    await expect(page.getByRole('button', { name: 'Convert and open Doxbrix project', exact: true })).toBeEnabled()
    await page.screenshot({ path: join('test-results', 'mintlify-github-review.png') })
    await page.getByRole('button', { name: 'Change source', exact: true }).click()
    await page.unroute('**/api/projects/mintlify/inspect')
    await page.getByRole('tab', { name: 'Local folder', exact: true }).click()
    await page.getByRole('textbox', { name: 'Documentation subfolder (optional)', exact: true }).fill('')
    await page.getByRole('textbox', { name: 'Mintlify project folder', exact: true }).fill(source)
    await page.getByRole('button', { name: 'Review conversion', exact: true }).click()
    await expect(page.getByText('Acme docs → Doxbrix', { exact: true })).toBeVisible()
    await expect(page.getByText(/1 page · 0 assets/)).toBeVisible()
    await page.getByRole('textbox', { name: 'New Doxbrix project folder', exact: true }).fill(destination)
    await page.getByRole('button', { name: 'Convert and open Doxbrix project', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Open documentation', exact: true })).toBeVisible({ timeout: 30_000 })
    await page.screenshot({ path: join('test-results', 'mintlify-converted.png') })
    await page.getByRole('button', { name: 'Open documentation', exact: true }).click()
    await expect(page.getByRole('treeitem').filter({ hasText: 'Introduction' })).toBeVisible({ timeout: 30_000 })
    await expect(page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Update', exact: true })).toBeVisible()
    const preview = page.frameLocator('iframe[title="Current page preview"]')
    await expect(preview.getByText('A preserved callout.')).toBeVisible()
    await page.getByRole('button', { name: 'Edit content', exact: true }).click()
    await page.getByRole('button', { name: 'Edit source', exact: true }).click()
    await page.getByLabel('Page source', { exact: true }).fill(original + '\nUpdated through Doxloop.\n')
    await page.getByRole('button', { name: 'Save changes', exact: true }).click()
    await expect.poll(() => readFile(join(destination, 'intro.mdx'), 'utf8')).toContain('Updated through Doxloop.')
    expect(await readFile(join(source, 'intro.mdx'), 'utf8')).toBe(original)
    expect(JSON.parse(await readFile(join(destination, '.doxloop/project.json'), 'utf8')).generator).toBe('doxbrix')
    await page.screenshot({ path: join('test-results', 'mintlify-pages.png') })
  } finally {
    if (ui && ui.exitCode === null) {
      const closed = new Promise(resolve => ui.once('exit', resolve))
      ui.kill('SIGTERM')
      let timer
      await Promise.race([closed, new Promise(resolve => { timer = setTimeout(resolve, 3000) })])
      clearTimeout(timer)
      if (ui.exitCode === null) { ui.kill('SIGKILL'); await closed }
    }
    await rm(scratch, { recursive: true, force: true })
  }
})

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => resolve(address.port))
    })
  })
}

function waitForOutput(child, expected) {
  return new Promise((resolve, reject) => {
    let output = ''
    const timer = setTimeout(() => reject(new Error('Server did not start: ' + output)), 30_000)
    const read = chunk => {
      output += chunk.toString()
      if (output.includes(expected)) { clearTimeout(timer); resolve() }
    }
    child.stdout.on('data', read)
    child.stderr.on('data', read)
    child.once('exit', code => { clearTimeout(timer); reject(new Error('Server exited ' + code + ': ' + output)) })
  })
}
