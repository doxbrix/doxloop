import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { buildDoxbrixStaticSite } from './doxbrix-build.js'
import { pathExists } from './fs.js'
import { scaffoldProject } from './project.js'
import { exportStaticSite } from './site-export.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('Doxbrix static build', () => {
  test('uses the visible navigation homepage instead of an alphabetically earlier imported page', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'doxloop-build-'))
    roots.push(parent)
    const root = await scaffoldProject({ directory: join(parent, 'docs'), sources: [] })
    const config = JSON.parse(await readFile(join(root, 'docs.json'), 'utf8'))
    config.spaces = [{ name: 'Guides', version: 'v2', nav: [
      { type: 'group', label: 'Imported pages', hidden: true, items: [{ type: 'page', file: 'AAA-audit' }] },
      { type: 'page', file: 'quickstart' }, { type: 'page', file: 'index' },
    ] }]
    config.spaces.push({ name: 'Guides', version: 'v1', nav: [{ type: 'page', file: 'index' }] })
    config.versions = [{ version: 'v1' }, { version: 'v2', isDefault: true }]
    config.spaces.reverse()
    await writeFile(join(root, 'docs.json'), JSON.stringify(config))
    await writeFile(join(root, 'AAA-audit.md'), '---\ntitle: Internal audit\n---\nNot the homepage.')
    await writeFile(join(root, 'quickstart.mdx'), '---\ntitle: Start here\ndescription: Begin using the product.\n---\nWelcome.')
    await buildDoxbrixStaticSite({ root })
    const html = await readFile(join(root, 'build', 'index.html'), 'utf8')
    expect(html).toContain('<title>Start here')
    expect(html).toContain('aria-label="Documentation version: v2"')
  })

  test('writes redirect stubs only for served pages and never over the homepage', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'doxloop-build-'))
    roots.push(parent)
    const root = await scaffoldProject({ directory: join(parent, 'docs'), sources: [] })
    await writeFile(join(root, '.doxloop', 'redirects.json'), JSON.stringify({
      '/': '/getting-started/product-overview',
      '/old-quickstart': '/quickstart',
      '/old-overview': '/getting-started/product-overview',
      '/legacy-home': '/',
    }))
    await buildDoxbrixStaticSite({ root })
    expect(await readFile(join(root, 'build', 'index.html'), 'utf8')).not.toContain('http-equiv="refresh"')
    expect(await readFile(join(root, 'build', 'old-quickstart', 'index.html'), 'utf8')).toContain('url=/quickstart"')
    expect(await readFile(join(root, 'build', 'legacy-home', 'index.html'), 'utf8')).toContain('url=/"')
    expect(await pathExists(join(root, 'build', 'old-overview'))).toBe(false)
  })

  test('writes pages, assets, search, sitemap, robots, and project-site URLs', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'doxloop-build-'))
    roots.push(parent)
    const root = await scaffoldProject({ directory: join(parent, 'docs'), sources: [] })
    await writeFile(join(root, 'logo.svg'), '<svg><title>Logo</title></svg>')
    await writeFile(join(root, 'index.mdx'), `---
title: Home
description: Product overview.
socialImage: /logo.svg
---

# Home

Read the [quickstart](/quickstart).

![Logo](/logo.svg)
`)
    const result = await buildDoxbrixStaticSite({
      root,
      basePath: '/example-docs',
      siteUrl: 'https://docs.example.test/example-docs/',
    })

    expect(result.pages).toBe(2)
    expect(await pathExists(join(root, 'build', 'index.html'))).toBe(true)
    expect(await pathExists(join(root, 'build', 'quickstart', 'index.html'))).toBe(true)
    expect(await pathExists(join(root, 'build', 'logo.svg'))).toBe(true)
    const html = await readFile(join(root, 'build', 'index.html'), 'utf8')
    expect(html).toContain('href="/example-docs/quickstart"')
    expect(html).toContain('src="/example-docs/logo.svg"')
    expect(html).toContain("fetch('/example-docs/__doxloop/search-index')")
    expect(html).not.toContain('new EventSource(')
    expect(html).toContain('<meta name="description" content="Product overview.">')
    expect(await readFile(join(root, 'build', 'sitemap.xml'), 'utf8')).toContain('https://docs.example.test/example-docs/quickstart/')
    expect(await readFile(join(root, 'build', 'robots.txt'), 'utf8')).toContain('Sitemap: https://docs.example.test/example-docs/sitemap.xml')
    const search = JSON.parse(await readFile(join(root, 'build', '__doxloop', 'search-index'), 'utf8')) as Array<{ href: string }>
    expect(search.map((entry) => entry.href)).toContain('/example-docs/quickstart')
  })

  test('exports a portable folder and zip archive', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'doxloop-export-test-'))
    roots.push(parent)
    const root = await scaffoldProject({ directory: join(parent, 'docs'), sources: [] })
    await writeFile(join(root, 'index.mdx'), '---\ntitle: Overview\ndescription: Understand the product.\n---\n\n# Overview\n\nChoose a complete workflow.\n')
    await writeFile(join(root, 'quickstart.mdx'), '---\ntitle: Quickstart\ndescription: Complete the first workflow.\n---\n\n# Quickstart\n\nComplete the first workflow and verify its result.\n')
    const out = join(parent, 'exported-site')
    const result = await exportStaticSite({ root, out, zip: true })
    expect(result.outputDir).toBe(out)
    expect(result.files).toBeGreaterThan(4)
    expect(await pathExists(join(out, 'index.html'))).toBe(true)
    expect(await pathExists(`${out}.zip`)).toBe(true)
  })
})
