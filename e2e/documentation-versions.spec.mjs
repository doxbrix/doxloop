import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { scaffoldProject } from '../dist/project.js'
import { buildDoxbrixStaticSite } from '../dist/doxbrix-build.js'

test('static reader switches versions and keeps shared pages in the selected version', async ({ page }) => {
  const scratch = await mkdtemp(join(tmpdir(), 'doxloop-version-reader-'))
  try {
    const root = await scaffoldProject({ directory: join(scratch, 'docs'), sources: [] })
    const site = { version: 1, name: 'Versioned docs', versions: [
      { version: 'v1', label: '1.0', tag: 'Legacy' }, { version: 'v2', label: '2.0', tag: 'Latest', isDefault: true },
    ], spaces: ['v1', 'v2'].flatMap(version => [
      { name: 'Guides', version, nav: [{ type: 'page', file: version + '-intro' }, { type: 'page', file: 'shared' }] },
      { name: 'API', version, nav: [{ type: 'page', file: version + '-api' }] },
    ]) }
    await writeFile(join(root, 'docs.json'), JSON.stringify(site))
    for (const id of ['v1-intro', 'v2-intro', 'v1-api', 'v2-api', 'shared']) {
      await writeFile(join(root, id + '.mdx'), '---\ntitle: ' + id + '\ndescription: Test documentation.\n---\nVersioned content.')
    }
    await buildDoxbrixStaticSite({ root, basePath: '/docs' })
    await page.route('http://versions.test/docs/**', async route => {
      const pathname = new URL(route.request().url()).pathname.slice('/docs/'.length)
      try {
        const file = pathname === '__doxloop/doxbrix.css' ? pathname : (pathname ? pathname.replace(/\/$/, '') + '/' : '') + 'index.html'
        await route.fulfill({ body: await readFile(join(root, 'build', file)), contentType: file.endsWith('.css') ? 'text/css' : 'text/html' })
      } catch { await route.fulfill({ status: 404, body: 'Not found' }) }
    })
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto('http://versions.test/docs/')
    await expect(page.getByRole('heading', { name: 'v2-intro', exact: true })).toBeVisible()
    await expect(page.locator('.dxb-atlas-tab:visible')).toHaveText(['Guides', 'API'])
    await page.getByLabel('Documentation version: 2.0', { exact: true }).click()
    await page.getByRole('navigation', { name: 'Documentation versions', exact: true }).getByRole('link', { name: '1.0 Legacy' }).click()
    await expect(page.getByRole('heading', { name: 'v1-intro', exact: true })).toBeVisible()
    await expect(page.locator('.dxb-atlas-tab:visible')).toHaveText(['Guides', 'API'])
    await page.locator('.dp-nav-item:visible').filter({ hasText: 'Shared' }).click()
    await expect(page).toHaveURL('http://versions.test/docs/shared?version=v1')
    await expect(page.getByLabel('Documentation version: 1.0', { exact: true })).toBeVisible()
    await page.reload()
    await expect(page.getByLabel('Documentation version: 1.0', { exact: true })).toBeVisible()
    await page.locator('.dxb-atlas-tab:visible').filter({ hasText: 'API' }).click()
    await expect(page.getByRole('heading', { name: 'v1-api', exact: true })).toBeVisible()
    await page.getByLabel('Documentation version: 1.0', { exact: true }).click()
    await page.getByRole('navigation', { name: 'Documentation versions', exact: true }).getByRole('link', { name: '2.0 Latest' }).click()
    await expect(page.getByRole('heading', { name: 'v2-intro', exact: true })).toBeVisible()
    expect(errors).toEqual([])
  } finally { await rm(scratch, { recursive: true, force: true }) }
})
