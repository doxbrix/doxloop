import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { loadGeneratorAdapter } from './generators.js'
import { loadProject, scaffoldProject } from './project.js'
import type { GeneratorName, ValidationIssue } from './types.js'
import { validateProject } from './validation.js'

const roots: string[] = []
const NAVIGATION_CODES = new Set([
  'missing-page',
  'unnavigated-page',
  'missing-generator-file',
  'navigation-unverified',
])

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function scaffold(generator: Exclude<GeneratorName, 'doxbrix'>): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), `doxloop-nav-${generator}-`))
  roots.push(parent)
  return scaffoldProject({
    directory: join(parent, 'docs'),
    title: `Nested ${generator}`,
    sources: [],
    generator,
  })
}

async function write(root: string, path: string, content: string): Promise<void> {
  await mkdir(dirname(join(root, path)), { recursive: true })
  await writeFile(join(root, path), content, 'utf8')
}

async function navigationIssues(root: string): Promise<ValidationIssue[]> {
  const result = await validateProject(root)
  return result.issues.filter((issue) => NAVIGATION_CODES.has(issue.code))
}

const markdownPage = (title: string, body = 'Body text for the page.'): string =>
  `---\ntitle: "${title}"\ndescription: "Learn how ${title.toLowerCase()} works and finish the task."\n---\n\n# ${title}\n\n${body}\n`

describe('nested navigation per generator', () => {
  test('Sphinx follows nested toctrees, globs, and root-relative entries', async () => {
    const root = await scaffold('sphinx')
    await write(
      root,
      'docs/index.rst',
      'Nested sphinx\n=============\n\n.. meta::\n   :description: Overview of the product and where to start.\n\nWelcome.\n\n.. toctree::\n   :maxdepth: 2\n\n   quickstart\n   guides/index\n   /reference/index\n',
    )
    await write(
      root,
      'docs/quickstart.rst',
      'Quickstart\n==========\n\n.. meta::\n   :description: Reach a first result quickly.\n\nSteps here.\n',
    )
    await write(
      root,
      'docs/guides/index.rst',
      'Guides\n======\n\n.. meta::\n   :description: Task guides for the product.\n\n.. toctree::\n   :glob:\n\n   *\n',
    )
    await write(
      root,
      'docs/guides/install.rst',
      'Install\n=======\n\n.. meta::\n   :description: Install the product on your machine.\n\nInstall steps.\n',
    )
    await write(
      root,
      'docs/reference/index.rst',
      'Reference\n=========\n\n.. meta::\n   :description: Reference pages for the product.\n\n.. toctree::\n\n   Configuration <config>\n',
    )
    await write(
      root,
      'docs/reference/config.rst',
      'Configuration\n=============\n\n.. meta::\n   :description: Every configuration option explained.\n\nOptions.\n',
    )
    expect(await navigationIssues(root)).toEqual([])

    await write(
      root,
      'docs/orphan.rst',
      'Orphan\n======\n\n.. meta::\n   :description: A page no toctree lists.\n\nLost.\n',
    )
    expect((await navigationIssues(root)).map((issue) => [issue.code, issue.file])).toEqual([
      ['unnavigated-page', 'docs/orphan.rst'],
    ])
  })

  test('Sphinx reports a missing toctree target from the file that names it', async () => {
    const root = await scaffold('sphinx')
    await write(
      root,
      'docs/index.rst',
      'Nested sphinx\n=============\n\n.. meta::\n   :description: Overview of the product and where to start.\n\nWelcome.\n\n.. toctree::\n\n   quickstart\n   guides/missing\n',
    )
    await write(
      root,
      'docs/quickstart.rst',
      'Quickstart\n==========\n\n.. meta::\n   :description: Reach a first result quickly.\n\nSteps.\n',
    )
    expect(await navigationIssues(root)).toEqual([
      expect.objectContaining({ code: 'missing-page', file: 'docs/index.rst' }),
    ])
  })

  test('Sphinx starter pages carry the starter marker', async () => {
    const root = await scaffold('sphinx')
    const result = await validateProject(root)
    expect(
      result.issues.filter((issue) => issue.code === 'starter-content').map((issue) => issue.file).sort(),
    ).toEqual(['docs/index.rst', 'docs/quickstart.rst'])
  })

  test('Hugo accepts section pages, front matter menus, and menu pageRefs', async () => {
    const root = await scaffold('hugo')
    await write(root, 'content/_index.md', markdownPage('Nested hugo'))
    await write(root, 'content/quickstart.md', markdownPage('Quickstart'))
    await write(root, 'content/guides/_index.md', markdownPage('Guides'))
    await write(root, 'content/guides/install.md', markdownPage('Install'))
    await write(root, 'content/guides/deploy.md', markdownPage('Deploy'))
    await write(
      root,
      'content/faq.md',
      `---\ntitle: "FAQ"\ndescription: "Answers to common questions about the product."\nmenu:\n  main:\n    weight: 30\n---\n\n# FAQ\n\nAnswers.\n`,
    )
    let config = await readFile(join(root, 'hugo.toml'), 'utf8')
    config += '\n[[menus.main]]\nname = "Guides"\npageRef = "/guides"\nweight = 25\n'
    await writeFile(join(root, 'hugo.toml'), config, 'utf8')
    expect(await navigationIssues(root)).toEqual([])

    await write(root, 'content/orphan.md', markdownPage('Orphan'))
    expect((await navigationIssues(root)).map((issue) => [issue.code, issue.file])).toEqual([
      ['unnavigated-page', 'content/orphan.md'],
    ])
  })

  test('Hugo leaves theme-driven navigation to the theme', async () => {
    const root = await scaffold('hugo')
    await write(root, 'content/_index.md', markdownPage('Nested hugo'))
    await write(root, 'content/quickstart.md', markdownPage('Quickstart'))
    await write(root, 'content/orphan.md', markdownPage('Orphan'))
    await rm(join(root, 'layouts'), { recursive: true, force: true })
    const config = await readFile(join(root, 'hugo.toml'), 'utf8')
    await writeFile(join(root, 'hugo.toml'), `theme = "docsy"\n${config}`, 'utf8')
    const issues = await navigationIssues(root)
    expect(issues.map((issue) => issue.code)).toEqual(['navigation-unverified'])
    expect(issues[0]?.severity).toBe('warning')
  })

  test('Starlight covers autogenerated directories and hidden pages', async () => {
    const root = await scaffold('starlight')
    await write(
      root,
      'astro.config.mjs',
      `import { defineConfig } from 'astro/config'
import starlight from '@astrojs/starlight'

export default defineConfig({
  integrations: [
    starlight({
      title: 'Nested starlight',
      sidebar: [
        { label: 'Start', items: [{ slug: 'quickstart' }] },
        { label: 'Guides', autogenerate: { directory: 'guides' } },
        { label: 'Reference', items: [{ label: 'Config', link: '/reference/config/' }] },
      ],
    }),
  ],
})
`,
    )
    await write(root, 'src/content/docs/quickstart.md', markdownPage('Quickstart'))
    await write(root, 'src/content/docs/guides/install.md', markdownPage('Install'))
    await write(root, 'src/content/docs/guides/advanced/tuning.md', markdownPage('Tuning'))
    await write(root, 'src/content/docs/reference/config.md', markdownPage('Config'))
    await write(
      root,
      'src/content/docs/index.md',
      `---\ntitle: "Nested starlight"\ndescription: "Overview of the product and where to start."\ntemplate: splash\n---\n\nWelcome.\n`,
    )
    await write(
      root,
      'src/content/docs/changelog.md',
      `---\ntitle: "Changelog"\ndescription: "What changed in each release of the product."\nsidebar:\n  hidden: true\n---\n\nChanges.\n`,
    )
    expect(await navigationIssues(root)).toEqual([])

    await write(root, 'src/content/docs/orphan.md', markdownPage('Orphan'))
    expect((await navigationIssues(root)).map((issue) => [issue.code, issue.file])).toEqual([
      ['unnavigated-page', 'src/content/docs/orphan.md'],
    ])
  })

  test('Starlight lists every page when no sidebar is configured, and reports code-built sidebars', async () => {
    const root = await scaffold('starlight')
    await write(root, 'src/content/docs/deep/nested/page.md', markdownPage('Deep page'))
    await write(
      root,
      'astro.config.mjs',
      `import { defineConfig } from 'astro/config'\nimport starlight from '@astrojs/starlight'\nexport default defineConfig({ integrations: [starlight({ title: 'x' })] })\n`,
    )
    expect(await navigationIssues(root)).toEqual([])

    await write(
      root,
      'astro.config.mjs',
      `import { defineConfig } from 'astro/config'\nimport starlight from '@astrojs/starlight'\nimport { sidebar } from './sidebar.mjs'\nexport default defineConfig({ integrations: [starlight({ title: 'x', sidebar })] })\n`,
    )
    expect((await navigationIssues(root)).map((issue) => issue.code)).toEqual(['navigation-unverified'])
  })

  test('VitePress reads multi-sidebar objects with base prefixes and flags function sidebars', async () => {
    const root = await scaffold('vitepress')
    await write(
      root,
      'docs/.vitepress/config.mts',
      `import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'Nested vitepress',
  themeConfig: {
    nav: [{ text: 'Guide', link: '/guide/' }],
    sidebar: {
      '/guide/': [
        { text: 'Guide', base: '/guide/', items: [{ text: 'Install', link: 'install' }, { text: 'Deploy', link: 'deploy.md' }] },
      ],
      '/reference/': [{ text: 'Reference', items: [{ text: 'Config', link: '/reference/config.html' }] }],
    },
  },
})
`,
    )
    await write(root, 'docs/index.md', markdownPage('Nested vitepress'))
    await write(root, 'docs/guide/index.md', markdownPage('Guide'))
    await write(root, 'docs/guide/install.md', markdownPage('Install'))
    await write(root, 'docs/guide/deploy.md', markdownPage('Deploy'))
    await write(root, 'docs/reference/config.md', markdownPage('Config'))
    await rm(join(root, 'docs', 'quickstart.md'))
    expect((await navigationIssues(root)).map((issue) => [issue.code, issue.file])).toEqual([
      ['unnavigated-page', 'docs/index.md'],
    ])

    await write(
      root,
      'docs/.vitepress/config.mts',
      `import { defineConfig } from 'vitepress'\nimport { buildSidebar } from './sidebar'\nexport default defineConfig({ themeConfig: { sidebar: buildSidebar('docs') } })\n`,
    )
    expect((await navigationIssues(root)).map((issue) => issue.code)).toEqual(['navigation-unverified'])
  })

  test('Docusaurus checks explicit doc ids and trusts autogenerated sidebars', async () => {
    const root = await scaffold('docusaurus')
    await write(root, 'docs/guides/install.md', markdownPage('Install'))
    expect(await navigationIssues(root)).toEqual([])

    await write(
      root,
      'sidebars.js',
      `export default {\n  docs: [\n    'index',\n    { type: 'category', label: 'Guides', items: ['guides/install', { type: 'doc', id: 'guides/missing' }] },\n  ],\n}\n`,
    )
    const issues = await navigationIssues(root)
    expect(issues.map((issue) => [issue.code, issue.file]).sort()).toEqual([
      ['missing-page', 'sidebars.js'],
      ['unnavigated-page', 'docs/quickstart.md'],
    ])

    await write(root, 'sidebars.js', `import { readdirSync } from 'node:fs'\nexport default { docs: readdirSync('docs') }\n`)
    expect((await navigationIssues(root)).map((issue) => issue.code)).toEqual(['navigation-unverified'])
  })

  test('MkDocs reports plugin-built navigation instead of guessing', async () => {
    const root = await scaffold('mkdocs')
    await write(root, 'docs/guides/install.md', markdownPage('Install'))
    let config = await readFile(join(root, 'mkdocs.yml'), 'utf8')
    config = config.replace('  - Quickstart: quickstart.md\n', '  - Quickstart: quickstart.md\n  - Guides:\n      - Install: guides/install.md\n')
    await writeFile(join(root, 'mkdocs.yml'), config, 'utf8')
    expect(await navigationIssues(root)).toEqual([])

    await writeFile(join(root, 'mkdocs.yml'), `${config}\nplugins:\n  - search\n  - awesome-pages\n`, 'utf8')
    await write(root, 'docs/orphan.md', markdownPage('Orphan'))
    expect((await navigationIssues(root)).map((issue) => issue.code)).toEqual(['navigation-unverified'])
  })

  test('Nextra checks every _meta file against its own directory and never demands listing', async () => {
    const root = await scaffold('nextra')
    await write(root, 'content/guides/_meta.js', `export default {\n  install: 'Install',\n  '---': { type: 'separator' },\n  docs: { title: 'Docs', href: 'https://example.com' },\n}\n`)
    await write(root, 'content/guides/install.mdx', markdownPage('Install'))
    await write(root, 'content/guides/unlisted.mdx', markdownPage('Unlisted'))
    await write(root, 'content/_meta.js', `export default {\n  index: 'Home',\n  quickstart: 'Quickstart',\n  guides: 'Guides',\n  '*': { theme: { toc: true } },\n}\n`)
    expect(await navigationIssues(root)).toEqual([])

    await write(root, 'content/guides/_meta.js', `export default { install: 'Install', missing: 'Gone' }\n`)
    expect((await navigationIssues(root)).map((issue) => [issue.code, issue.file])).toEqual([
      ['missing-page', 'content/guides/_meta.js'],
    ])
  })

  test('Jekyll reads nested navigation from _data and reports theme-driven sites', async () => {
    const root = await scaffold('jekyll')
    await write(root, '_docs/guides/install.md', markdownPage('Install'))
    await write(
      root,
      '_data/navigation.yml',
      `- title: Guides\n  url: /guides/\n  children:\n    - title: Install\n      page: guides/install\n      url: /guides/install/\n`,
    )
    expect(await navigationIssues(root)).toEqual([])

    await writeFile(join(root, '_config.yml'), 'title: Themed\ntheme: just-the-docs\ncollections:\n  docs:\n    output: true\n', 'utf8')
    await rm(join(root, '_data'), { recursive: true, force: true })
    expect((await navigationIssues(root)).map((issue) => issue.code)).toEqual(['navigation-unverified'])
  })

  test('Markdoc navigation accepts nested files and writeNavigation keeps sections together', async () => {
    const root = await scaffold('markdoc')
    const project = await loadProject(root)
    const adapter = await loadGeneratorAdapter(root, project)
    await write(root, 'docs/guides/install.md', markdownPage('Install'))
    await write(root, 'docs/guides/deploy.md', markdownPage('Deploy'))
    await write(root, 'docs/reference.md', markdownPage('Reference'))
    const context = { root, contentRoot: join(root, 'docs'), project }
    await adapter.writeNavigation!({ ...context, action: 'add', page: { path: 'guides/install.md', title: 'Install', section: 'Guides' } })
    await adapter.writeNavigation!({ ...context, action: 'add', page: { path: 'reference.md', title: 'Reference' } })
    await adapter.writeNavigation!({ ...context, action: 'add', page: { path: 'guides/deploy.md', title: 'Deploy', section: 'Guides' } })
    const navigation = JSON.parse(await readFile(join(root, 'navigation.json'), 'utf8')) as Array<{ file: string; href: string; section?: string }>
    expect(navigation.map((entry) => [entry.file, entry.href, entry.section ?? ''])).toEqual([
      ['index.md', '/', ''],
      ['quickstart.md', '/quickstart/', ''],
      ['guides/install.md', '/guides/install/', 'Guides'],
      ['guides/deploy.md', '/guides/deploy/', 'Guides'],
      ['reference.md', '/reference/', ''],
    ])
    expect(await navigationIssues(root)).toEqual([])

    await adapter.writeNavigation!({ ...context, action: 'remove', page: { path: 'reference.md', title: 'Reference' } })
    await rm(join(root, 'docs', 'reference.md'))
    expect(await navigationIssues(root)).toEqual([])
  })

  test('MkDocs writeNavigation edits nav in place and keeps the rest of the file', async () => {
    const root = await scaffold('mkdocs')
    const project = await loadProject(root)
    const adapter = await loadGeneratorAdapter(root, project)
    await write(root, 'docs/guides/install.md', markdownPage('Install'))
    const context = { root, contentRoot: join(root, 'docs'), project }
    await adapter.writeNavigation!({ ...context, action: 'add', page: { path: 'guides/install.md', title: 'Install', section: 'Guides' } })
    const config = await readFile(join(root, 'mkdocs.yml'), 'utf8')
    expect(config).toContain('  - Guides:\n      - Install: guides/install.md\n')
    expect(config).toContain('name: material')
    expect(config).toContain('!!python/name:pymdownx.superfences.fence_code_format')
    expect(await navigationIssues(root)).toEqual([])

    await adapter.writeNavigation!({ ...context, action: 'rename', from: 'guides/install.md', page: { path: 'guides/setup.md', title: 'Setup', section: 'Guides' } })
    await rm(join(root, 'docs', 'guides', 'install.md'))
    await write(root, 'docs/guides/setup.md', markdownPage('Setup'))
    expect(await readFile(join(root, 'mkdocs.yml'), 'utf8')).toContain('      - Setup: guides/setup.md\n')
    expect(await navigationIssues(root)).toEqual([])
  })

  test('Static HTML follows links through section pages and renders the main landmark', async () => {
    const root = await scaffold('static')
    const project = await loadProject(root)
    const adapter = await loadGeneratorAdapter(root, project)
    const page = (title: string, body: string): string =>
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="description" content="${title} explained so the reader can act."><title>${title}</title></head><body><header><a href="/">Home</a></header><main><article><h1>${title}</h1>${body}</article></main><script>alert(1)</script></body></html>\n`
    await write(root, 'site/index.html', page('Nested static', '<nav><a href="/quickstart/">Quickstart</a> <a href="guides/">Guides</a></nav>'))
    await write(root, 'site/guides/index.html', page('Guides', '<ul><li><a href="install/">Install</a></li><li><a href="../reference.html">Reference</a></li></ul>'))
    await write(root, 'site/guides/install/index.html', page('Install', '<p>Steps.</p>'))
    await write(root, 'site/reference.html', page('Reference', '<p>Options.</p>'))
    expect(await navigationIssues(root)).toEqual([])

    await write(root, 'site/orphan/index.html', page('Orphan', '<p>Lost.</p>'))
    expect((await navigationIssues(root)).map((issue) => [issue.code, issue.file])).toEqual([
      ['unnavigated-page', 'site/orphan/index.html'],
    ])
    const rendered = await adapter.renderPage!({
      root,
      contentRoot: join(root, 'site'),
      path: 'reference.html',
      page: await adapter.readPage!(join(root, 'site', 'reference.html')),
    })
    expect(rendered.html).toBe('<article><h1>Reference</h1><p>Options.</p></article>')
  })
})
