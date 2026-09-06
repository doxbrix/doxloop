import { readFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DoxloopError,
  defineGenerator,
  type GeneratorPreviewOptions,
  type GeneratorScaffoldContext,
  type GeneratorValidationContext,
  type ValidationIssue,
} from '@doxbrix/doxloop/generator-api'
import {
  findExecutable,
  isRecord,
  navigationUnverifiedIssue,
  openBrowser,
  pathExists,
  readPackageJson,
  resolvePublicAsset,
  runCommand,
  runPreviewProcess,
  shownHost,
  slugFromTitle,
  writeJsonFile,
} from '@doxbrix/doxloop/generator-runtime'

const PACKAGE_NAME = '@doxbrix/doxloop-generator-jekyll'
const PACKAGE_VERSION = (
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    version: string
  }
).version

const adapter = defineGenerator({
  apiVersion: 1,
  id: 'jekyll',
  displayName: 'Jekyll',
  packageName: PACKAGE_NAME,
  packageVersion: PACKAGE_VERSION,
  authoring: {
    skillName: 'doxloop-jekyll',
    skillDirectory: fileURLToPath(new URL('../skills/doxloop-jekyll', import.meta.url)),
  },
  planning: { navigationFiles: ['_config.yml', '_data/navigation.yml'] },
  project: {
    defaultContentDir: '_docs',
    pageExtensions: ['.md'],
    gitignore: ['_site/', '.jekyll-cache/', '.sass-cache/', '.doxloop/bundle/', '.bundle/'],
    contentFormat: 'markdown' as const,
  },
  build: {
    command: 'bundle exec jekyll build --strict_front_matter',
    outputDir: '_site',
  },
  scaffold: scaffoldJekyll,
  preview: startJekyllPreview,
  resolveLocalAsset({ root, reference }) {
    return reference.startsWith('/assets/')
      ? resolvePublicAsset(root, 'assets', reference.slice('/assets'.length))
      : undefined
  },
  validate: validateJekyll,
})

export default adapter

export function jekyllPreviewInvocation(
  options: GeneratorPreviewOptions,
  command = 'bundle',
): { command: string; args: string[] } {
  return {
    command,
    args: [
      'exec',
      'jekyll',
      'serve',
      '--host',
      options.host,
      '--port',
      String(options.port),
      '--livereload',
      '--strict_front_matter',
    ],
  }
}

async function scaffoldJekyll(context: GeneratorScaffoldContext): Promise<void> {
  const { root, title, contentDir } = context
  await mkdir(join(root, contentDir), { recursive: true })
  await mkdir(join(root, '_layouts'), { recursive: true })
  await mkdir(join(root, '_includes'), { recursive: true })
  await mkdir(join(root, 'assets', 'css'), { recursive: true })
  const existing = await readPackageJson(root)
  await writeJsonFile(join(root, 'package.json'), {
    ...existing,
    name:
      typeof existing.name === 'string' && existing.name
        ? existing.name
        : slugFromTitle(title),
    private: true,
    version:
      typeof existing.version === 'string' && existing.version
        ? existing.version
        : '0.0.0',
    scripts: {
      ...(isRecord(existing.scripts) ? existing.scripts : {}),
      'docs:dev': 'doxloop preview',
      'docs:build': 'bundle exec jekyll build --strict_front_matter',
      'docs:test': 'doxloop test',
    },
    devDependencies: {
      ...(isRecord(existing.devDependencies) ? existing.devDependencies : {}),
      [context.corePackage.name]: `^${context.corePackage.version}`,
      [context.generatorPackage.name]: `^${context.generatorPackage.version}`,
    },
  })
  await writeFile(
    join(root, 'Gemfile'),
    `source "https://rubygems.org"

gem "jekyll", "4.4.1"
gem "webrick", "~> 1.9"
`,
    { encoding: 'utf8', flag: 'wx' },
  )
  await writeFile(
    join(root, '_config.yml'),
    `title: ${JSON.stringify(title)}
description: ${JSON.stringify(`Documentation for ${title}.`)}
url: "https://example.com"
baseurl: ""
markdown: kramdown
strict_front_matter: true

collections:
  docs:
    output: true
    permalink: /:name/

defaults:
  - scope:
      path: ""
      type: docs
    values:
      layout: default

navigation:
  - title: Overview
    page: index
    url: /
  - title: Quickstart
    page: quickstart
    url: /quickstart/

exclude:
  - node_modules
  - packages
  - .doxloop
`,
    { encoding: 'utf8', flag: 'wx' },
  )
  await writeFile(
    join(root, '_layouts', 'default.html'),
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="description" content="{{ page.description | default: site.description }}">
    <title>{{ page.title }} · {{ site.title }}</title>
    <link rel="stylesheet" href="{{ '/assets/css/site.css' | relative_url }}">
  </head>
  <body>
    <header><a class="brand" href="{{ '/' | relative_url }}">{{ site.title }}</a></header>
    <div class="layout">
      <aside>{% include nav.html %}</aside>
      <main class="page-content"><article class="post-content"><h1>{{ page.title }}</h1>{{ content }}</article></main>
    </div>
    {% if content contains 'class="language-mermaid"' %}<script type="module">import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs'; document.querySelectorAll('.language-mermaid').forEach((block) => { const pre = block.closest('pre') || block; const target = document.createElement('pre'); target.className = 'mermaid'; target.textContent = block.textContent; pre.replaceWith(target) }); mermaid.initialize({ startOnLoad: true });</script>{% endif %}
  </body>
</html>
`,
    { encoding: 'utf8', flag: 'wx' },
  )
  await writeFile(
    join(root, '_includes', 'nav.html'),
    `<nav aria-label="Documentation"><ul>{% for item in site.navigation %}<li><a href="{{ item.url | relative_url }}"{% if page.url == item.url %} aria-current="page"{% endif %}>{{ item.title }}</a>{% if item.children %}<ul>{% for child in item.children %}<li><a href="{{ child.url | relative_url }}"{% if page.url == child.url %} aria-current="page"{% endif %}>{{ child.title }}</a></li>{% endfor %}</ul>{% endif %}</li>{% endfor %}</ul></nav>
`,
    { encoding: 'utf8', flag: 'wx' },
  )
  await writeFile(
    join(root, '_includes', 'callout.html'),
    `<aside class="callout callout-{{ include.type | default: 'note' }}" role="note">{% if include.title %}<strong>{{ include.title }}</strong>{% endif %}{{ include.content | markdownify }}</aside>
`,
    { encoding: 'utf8', flag: 'wx' },
  )
  await writeFile(
    join(root, 'assets', 'css', 'site.css'),
    `:root { font-family: Inter, system-ui, sans-serif; --primary: #4f46e5; }
body { margin: 0; color: #1f2937; } header { border-bottom: 1px solid #e5e7eb; padding: 1rem 2rem; }
.brand { color: var(--primary); font-weight: 700; text-decoration: none; }
.layout { display: grid; grid-template-columns: 16rem minmax(0, 48rem); gap: 3rem; max-width: 72rem; margin: 0 auto; padding: 2rem; }
nav ul { list-style: none; padding: 0; } nav a { display: block; padding: .5rem; } nav ul ul { padding-left: 1rem; }
.page-content { line-height: 1.7; min-width: 0; }
.callout { border-left: 4px solid var(--primary); padding: .75rem 1rem; margin: 1rem 0; background: #eef2ff; }
.callout-warning { border-color: #d97706; background: #fffbeb; } .callout-danger { border-color: #dc2626; background: #fef2f2; }
details.tab { border: 1px solid #e5e7eb; border-radius: .5rem; margin: .5rem 0; } details.tab summary { cursor: pointer; padding: .5rem 1rem; font-weight: 600; } details.tab > :not(summary) { padding: 0 1rem 1rem; }
@media (max-width: 720px) { .layout { grid-template-columns: 1fr; } }
`,
    { encoding: 'utf8', flag: 'wx' },
  )
  await writeFile(
    join(root, contentDir, 'index.md'),
    `---
title: ${JSON.stringify(title)}
description: "Understand what ${title} helps you accomplish and choose your first workflow."
permalink: /
---

<!-- doxloop:starter-page -->

The authoring agent will replace this starter with an evidence-backed product overview.

[Follow the quickstart](/quickstart/) to reach your first successful result.
`,
    { encoding: 'utf8', flag: 'wx' },
  )
  await writeFile(
    join(root, contentDir, 'quickstart.md'),
    `---
title: "Quickstart"
description: "Reach your first successful result with verified product instructions."
---

<!-- doxloop:starter-page -->

1. Confirm prerequisites from the configured product source.
2. Complete the first supported workflow.
3. Verify the observable result.
`,
    { encoding: 'utf8', flag: 'wx' },
  )
}

async function startJekyllPreview(options: GeneratorPreviewOptions): Promise<void> {
  const bundle = await findExecutable('bundle')
  if (!bundle) {
    throw new DoxloopError(
      'Bundler is not installed. Install Ruby and run `gem install bundler`.',
      2,
    )
  }
  let code = await runCommand(bundle, ['check'], options.root)
  if (code !== 0) {
    process.stdout.write('Installing Jekyll gems (first preview only)...\n')
    code = await runCommand(
      bundle,
      ['config', 'set', '--local', 'path', '.doxloop/bundle'],
      options.root,
    )
    if (code === 0) code = await runCommand(bundle, ['install'], options.root)
  }
  if (code !== 0) {
    throw new DoxloopError(
      'Jekyll dependency installation did not complete. Run `bundle install`.',
      2,
    )
  }
  const invocation = jekyllPreviewInvocation(options, bundle)
  const url = `http://${shownHost(options.host)}:${options.port}`
  process.stdout.write(`Starting Jekyll preview at ${url}\n`)
  if (options.open) setTimeout(() => void openBrowser(url), 800)
  await runPreviewProcess(invocation.command, invocation.args, options.root, 'Jekyll')
}

/**
 * Navigation comes from the `navigation` list in `_config.yml` or from
 * `_data/navigation.yml`, nested to any depth. A site whose theme derives
 * navigation from front matter has neither, and is reported as unverified.
 */
async function validateJekyll(
  context: GeneratorValidationContext,
): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = []
  for (const file of ['package.json', 'Gemfile', '_config.yml']) {
    if (!(await pathExists(join(context.root, file)))) {
      issues.push({
        severity: 'error',
        code: 'missing-generator-file',
        message: `Jekyll project is missing ${file}.`,
        file,
      })
    }
  }
  const configPath = join(context.root, '_config.yml')
  if (!(await pathExists(configPath))) return issues
  const config = await readFile(configPath, 'utf8')
  const usesTheme = /^\s*(?:theme|remote_theme)\s*:/m.test(config)
  if (!usesTheme) {
    for (const file of ['_layouts/default.html', '_includes/nav.html']) {
      if (!(await pathExists(join(context.root, file)))) {
        issues.push({
          severity: 'error',
          code: 'missing-generator-file',
          message: `Jekyll project is missing ${file}.`,
          file,
        })
      }
    }
  }
  const sources: Array<{ file: string; text: string }> = []
  if (/^navigation\s*:/m.test(config)) {
    sources.push({ file: '_config.yml', text: config.slice(config.search(/^navigation\s*:/m)).split(/\n(?=\S)/)[0] ?? '' })
  }
  const dataFile = join(context.root, '_data', 'navigation.yml')
  if (await pathExists(dataFile)) {
    sources.push({ file: '_data/navigation.yml', text: await readFile(dataFile, 'utf8') })
  }
  if (sources.length === 0) {
    issues.push(
      navigationUnverifiedIssue(
        'Jekyll',
        '_config.yml',
        usesTheme
          ? 'the theme derives navigation from front matter.'
          : 'no navigation list exists in _config.yml or _data/navigation.yml.',
      ),
    )
    return issues
  }
  const pageIds = new Set(context.pageIds)
  const navigation = new Set<string>()
  for (const { file, text } of sources) {
    for (const match of text.matchAll(/^\s+(?:-\s+)?page\s*:\s*["']?([A-Za-z0-9_./-]+?)["']?\s*$/gm)) {
      const id = (match[1] ?? '').replace(/\.md$/i, '')
      navigation.add(id)
      if (!pageIds.has(id)) {
        issues.push({
          severity: 'error',
          code: 'missing-page',
          message: `Jekyll navigation references missing page "${id}".`,
          file,
        })
      }
    }
    for (const match of text.matchAll(/^\s+(?:-\s+)?url\s*:\s*["']?\/([^"'\s]*?)\/?["']?\s*$/gm)) {
      const route = match[1] ?? ''
      navigation.add(route === '' ? 'index' : route.replace(/\.html$/i, ''))
    }
  }
  for (const id of context.pageIds) {
    if (!navigation.has(id)) {
      issues.push({
        severity: 'error',
        code: 'unnavigated-page',
        message: `Page "${id}" is not in Jekyll navigation.`,
        file: `${context.project.contentDir}/${id}.md`,
      })
    }
  }
  return issues
}
