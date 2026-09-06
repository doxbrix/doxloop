import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { detectDocumentationGenerator, listDocumentationPageFiles } from './project-detect.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function site(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'doxloop-detect-'))
  roots.push(root)
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), content, 'utf8')
  }
  return root
}

describe('generator detection', () => {
  test.each([
    ['docusaurus', { 'docusaurus.config.js': "module.exports = { title: 'Acme Docs' }", 'docs/intro.md': '# Intro' }, 'docs', 'Acme Docs'],
    ['mkdocs', { 'mkdocs.yml': 'site_name: Acme Manual\ndocs_dir: manual\n', 'manual/index.md': '# Home' }, 'manual', 'Acme Manual'],
    ['starlight', { 'astro.config.mjs': "import starlight from '@astrojs/starlight'\nexport default { integrations: [starlight({ title: 'Star' })] }", 'src/content/docs/index.md': '# Hi' }, 'src/content/docs', 'Star'],
    ['vitepress', { 'docs/.vitepress/config.mts': "export default { title: 'Vite Docs' }", 'docs/index.md': '# Hi' }, 'docs', 'Vite Docs'],
    ['nextra', { 'next.config.mjs': "import nextra from 'nextra'\nexport default nextra()({})", 'content/index.mdx': '# Hi' }, 'content', undefined],
    ['markdoc', { 'markdoc.config.mjs': 'export default {}', 'docs/index.md': '# Hi' }, 'docs', undefined],
    ['hugo', { 'hugo.toml': 'baseURL = "https://example.com"\ntitle = "Hugo Site"\ncontentDir = "content"\n', 'content/_index.md': '# Hi' }, 'content', 'Hugo Site'],
    ['sphinx', { 'docs/conf.py': "project = 'Sphinx Project'\n", 'docs/index.rst': 'Hi\n==\n' }, 'docs', 'Sphinx Project'],
    ['jekyll', { '_config.yml': 'title: Jekyll Site\n', '_docs/index.md': '# Hi' }, '_docs', 'Jekyll Site'],
    ['doxbrix', { 'docs.json': JSON.stringify({ version: 1, name: 'Doxbrix Site', spaces: [{ name: 'Docs', nav: [] }] }), 'index.mdx': '# Hi' }, '', 'Doxbrix Site'],
  ])('recognizes a %s site', async (generator, files, contentDir, title) => {
    const root = await site(files as Record<string, string>)
    const detection = await detectDocumentationGenerator(root)
    expect(detection.recommended).toMatchObject({ generator, contentDir, ...(title ? { title } : {}) })
    expect(detection.recommended?.markers.length).toBeGreaterThan(0)
  })

  test('finds Doxbrix content in a subdirectory and Hugo from a generic config', async () => {
    const doxbrix = await site({ 'docs/docs.json': JSON.stringify({ title: 'Legacy', navigation: [] }), 'docs/index.md': '# Hi' })
    expect((await detectDocumentationGenerator(doxbrix)).recommended).toMatchObject({ generator: 'doxbrix', contentDir: 'docs', markers: ['docs/docs.json'] })
    const hugo = await site({ 'config.toml': 'baseURL = "https://example.com"\n' })
    expect((await detectDocumentationGenerator(hugo)).recommended?.generator).toBe('hugo')
    const random = await site({ 'config.toml': '[tool]\nname = "x"\n' })
    expect((await detectDocumentationGenerator(random)).candidates).toEqual([])
  })

  test('lists the more specific generator first when markers overlap', async () => {
    const root = await site({ 'mkdocs.yml': 'site_name: Both\n', '_config.yml': 'title: Pages\n', 'docs/index.md': '# Hi' })
    const detection = await detectDocumentationGenerator(root)
    expect(detection.candidates.map((candidate) => candidate.generator)).toEqual(['mkdocs', 'jekyll'])
  })

  test('reports nothing for an unrelated folder and never guesses from a docs.json that is not a site', async () => {
    const root = await site({ 'README.md': '# App', 'docs.json': JSON.stringify({ openapi: '3.0.0' }) })
    expect((await detectDocumentationGenerator(root)).candidates).toEqual([])
  })

  test('lists page files by generator extension and tolerates a missing content directory', async () => {
    const root = await site({ 'docs/index.md': '# Hi', 'docs/guide/setup.md': '# Setup', 'docs/notes.txt': 'skip', 'docs/api.rst': 'skip' })
    expect(await listDocumentationPageFiles(root, 'mkdocs', 'docs')).toEqual(['docs/guide/setup.md', 'docs/index.md'])
    expect(await listDocumentationPageFiles(root, 'sphinx', 'docs')).toEqual(['docs/api.rst'])
    expect(await listDocumentationPageFiles(root, 'mkdocs', 'missing')).toEqual([])
  })
})
