import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { buildDoxbrixStaticSite } from './doxbrix-build.js'
import { pathExists } from './fs.js'
import {
  addLlmsOutputToBuild,
  buildLlmsOutput,
  llmsFullTxt,
  markdownFileForRequest,
  markdownFileForRoute,
  type DocsPage,
  type DocsSite,
} from './llms-output.js'
import { scaffoldProject } from './project.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

/** A Doxbrix project with two navigation groups, a hidden group, an orphan, and an older version. */
async function fixture(): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), 'doxloop-llms-'))
  roots.push(parent)
  const root = await scaffoldProject({ directory: join(parent, 'docs'), title: 'Acme', sources: [] })
  const config = JSON.parse(await readFile(join(root, 'docs.json'), 'utf8'))
  config.name = 'Acme Docs'
  config.description = 'Everything about Acme.'
  config.versions = [{ version: 'v1' }, { version: 'v2', isDefault: true }]
  config.spaces = [
    { name: 'Guides', version: 'v2', nav: [
      { type: 'group', label: 'Get started', items: [{ type: 'page', file: 'index' }, { type: 'page', file: 'quickstart' }] },
      { type: 'group', label: 'Guides', items: [{ type: 'page', file: 'guides/install' }] },
      { type: 'group', label: 'Internal', hidden: true, items: [{ type: 'page', file: 'internal' }] },
    ] },
    { name: 'Guides', version: 'v1', nav: [{ type: 'page', file: 'legacy' }] },
  ]
  await writeFile(join(root, 'docs.json'), JSON.stringify(config))
  await mkdir(join(root, 'guides'), { recursive: true })
  await writeFile(join(root, 'index.mdx'), '---\ntitle: Overview\ndescription: What Acme does.\n---\n\n# Overview\n\n<Note>Acme runs anywhere.</Note>\n')
  await writeFile(join(root, 'quickstart.mdx'), '---\ntitle: Quickstart\ndescription: Send the first request.\n---\n\n<Steps>\n<Step title="Install">\nRun the installer.\n</Step>\n</Steps>\n')
  await writeFile(join(root, 'guides', 'install.mdx'), '---\ntitle: Install [beta]\n---\n\nInstall with `acme setup`.\n')
  await writeFile(join(root, 'internal.mdx'), '---\ntitle: Internal notes\n---\n\nFor maintainers.\n')
  await writeFile(join(root, 'legacy.mdx'), '---\ntitle: Legacy setup\n---\n\nOnly for v1.\n')
  await writeFile(join(root, 'orphan.mdx'), '---\ntitle: Changelog\ndescription: Every release.\n---\n\nAll releases.\n')
  return root
}

describe('llms.txt', () => {
  test('lists the current version in navigation order with root-relative Markdown links', async () => {
    const root = await fixture()
    const output = await buildLlmsOutput(root)
    expect(output.llmsTxt).toBe([
      '# Acme Docs',
      '',
      '> Everything about Acme.',
      '',
      'Each link below is a clean Markdown copy of a documentation page. The complete documentation is also available as a single file: [llms-full.txt](/llms-full.txt).',
      '',
      '## Get started',
      '',
      '- [Overview](/index.md): What Acme does.',
      '- [Quickstart](/quickstart.md): Send the first request.',
      '',
      '## Guides',
      '',
      '- [Install \\[beta\\]](/guides/install.md)',
      '',
      '## Optional',
      '',
      '- [Internal notes](/internal.md)',
      '- [Changelog](/orphan.md): Every release.',
      '',
    ].join('\n'))
    // The v1-only page keeps its Markdown copy but stays out of llms.txt.
    expect(output.pages.find((page) => page.path === 'legacy.mdx')).toMatchObject({ primary: false, markdownFile: 'legacy.md' })
  })

  test('uses the base path, or absolute URLs when the public site URL is known', async () => {
    const root = await fixture()
    const mounted = await buildLlmsOutput(root, { basePath: '/repo/' })
    expect(mounted.llmsTxt).toContain('[Quickstart](/repo/quickstart.md)')
    expect(mounted.llmsTxt).toContain('[llms-full.txt](/repo/llms-full.txt)')
    const hosted = await buildLlmsOutput(root, { siteUrl: 'https://docs.acme.dev/app' })
    expect(hosted.llmsTxt).toContain('[Quickstart](https://docs.acme.dev/app/quickstart.md)')
    expect(hosted.llmsTxt).toContain('[Install \\[beta\\]](https://docs.acme.dev/app/guides/install.md)')
    expect(hosted.llmsFullTxt).toContain('# Quickstart\n\nSource: https://docs.acme.dev/app/quickstart\n\n1. **Install**')
    expect(hosted.llmsFullTxt).toContain('# Overview\n\nSource: https://docs.acme.dev/app/\n\n> **Note:** Acme runs anywhere.')
  })

  test('reads a non-Doxbrix project through its generator navigation and routes', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'doxloop-llms-mkdocs-'))
    roots.push(parent)
    const root = await scaffoldProject({ directory: join(parent, 'docs'), title: 'Mk Site', sources: [], generator: 'mkdocs' })
    const output = await buildLlmsOutput(root)
    expect(output.llmsTxt).toMatch(/^# Mk Site\n/)
    expect(output.pages.map((page) => page.markdownFile)).toEqual(['index.md', 'quickstart.md'])
    expect(output.llmsTxt).toContain('](/quickstart.md)')
    expect(output.pages.every((page) => !page.markdown.startsWith('---'))).toBe(true)
  })

  test('derives one Markdown path per public route', () => {
    expect(markdownFileForRoute('/')).toBe('index.md')
    expect(markdownFileForRoute('/guides/install')).toBe('guides/install.md')
    expect(markdownFileForRoute('/guides/')).toBe('guides.md')
    expect(markdownFileForRoute('/guides/index')).toBe('guides.md')
    expect(markdownFileForRoute('/reference/api.html')).toBe('reference/api.md')
    expect(() => markdownFileForRoute('/../secrets')).toThrow('cannot leave the site')
    expect(markdownFileForRequest('/guides/install.md')).toBe('guides/install.md')
    expect(markdownFileForRequest('/guides/install')).toBeUndefined()
  })
})

describe('llms-full.txt', () => {
  const page = (title: string, markdown: string): DocsPage => ({
    path: `${title}.mdx`, route: `/${title}`, title, section: 'Docs', markdown,
    markdownFile: `${title}.md`, markdownUrl: `/${title}.md`, pageUrl: `/${title}`, primary: true,
  })

  test('truncates an oversized page, closing an open code block, and stops at the total limit', () => {
    const long = `Intro\n\n\`\`\`text\n${'x'.repeat(200)}\n${'y'.repeat(200)}\n\`\`\`\n`
    const site: DocsSite = { title: 'Big', pages: [page('one', long), page('two', 'Short.'), page('three', 'z'.repeat(400))] }
    const full = llmsFullTxt(site, { page: 300, total: 700 })
    expect(full).toContain('# one\n\nSource: /one')
    expect(full).toContain('```\n\n[This page is truncated here. The complete page is at /one.md]')
    expect(full).toContain('# two')
    expect(full).not.toContain('# three')
    expect(full).toContain('1 more page is listed in llms.txt')
    expect(Buffer.byteLength(full)).toBeLessThan(900)
  })
})

describe('writing into a build', () => {
  test('the Doxbrix static build publishes llms.txt, llms-full.txt, and a Markdown copy per page', async () => {
    const root = await fixture()
    await buildDoxbrixStaticSite({ root, siteUrl: 'https://docs.acme.dev' })
    const build = join(root, 'build')
    expect(await readFile(join(build, 'llms.txt'), 'utf8')).toContain('[Quickstart](https://docs.acme.dev/quickstart.md)')
    expect(await readFile(join(build, 'llms-full.txt'), 'utf8')).toContain('# Install [beta]')
    expect(await readFile(join(build, 'index.md'), 'utf8')).toBe('# Overview\n\n> What Acme does.\n\n> **Note:** Acme runs anywhere.\n')
    expect(await readFile(join(build, 'guides', 'install.md'), 'utf8')).toContain('Install with `acme setup`.')
    expect(await pathExists(join(build, 'guides', 'install', 'index.html'))).toBe(true)
    // The Markdown copies in the project's own build/ never become pages.
    const again = await buildLlmsOutput(root)
    expect(again.pages.some((page) => page.path.startsWith('build/'))).toBe(false)
    expect((await buildDoxbrixStaticSite({ root })).pages).toBe(6)
  })

  test('static packaging never replaces a generator\'s own llms.txt, existing files, or the pages folder', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'doxloop-llms-package-'))
    roots.push(parent)
    const root = await scaffoldProject({ directory: join(parent, 'docs'), title: 'Mk Site', sources: [], generator: 'mkdocs' })
    const own = join(root, 'site-own')
    await mkdir(own, { recursive: true })
    await writeFile(join(own, 'llms.txt'), 'generator plugin output\n')
    expect(await addLlmsOutputToBuild(root, own)).toBe(false)
    expect(await readFile(join(own, 'llms.txt'), 'utf8')).toBe('generator plugin output\n')
    expect(await pathExists(join(own, 'quickstart.md'))).toBe(false)

    const plain = join(root, 'site')
    await mkdir(plain, { recursive: true })
    await writeFile(join(plain, 'quickstart.md'), 'native file\n')
    expect(await addLlmsOutputToBuild(root, plain, { siteUrl: 'https://docs.acme.dev' })).toBe(true)
    expect(await readFile(join(plain, 'quickstart.md'), 'utf8')).toBe('native file\n')
    expect(await readFile(join(plain, 'llms.txt'), 'utf8')).toContain('https://docs.acme.dev/quickstart.md')
    expect(await pathExists(join(plain, 'index.md'))).toBe(true)
    expect(await pathExists(join(plain, 'llms-full.txt'))).toBe(true)

    // A build inside the pages folder (VitePress's docs/.vitepress/dist) is left alone.
    const nested = join(root, 'docs', '.vitepress', 'dist')
    await mkdir(nested, { recursive: true })
    expect(await addLlmsOutputToBuild(root, nested)).toBe(false)
    expect(await pathExists(join(nested, 'llms.txt'))).toBe(false)
  })
})
