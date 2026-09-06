import { readFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, posix } from 'node:path'
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
  contentRelativePages,
  findExecutable,
  isRecord,
  navigationUnverifiedIssue,
  openBrowser,
  pathExists,
  readPackageJson,
  resolvePublicAsset,
  runPreviewProcess,
  shownHost,
  slugFromTitle,
  writeJsonFile,
} from '@doxbrix/doxloop/generator-runtime'

const PACKAGE_NAME = '@doxbrix/doxloop-generator-hugo'
const PACKAGE_VERSION = (
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    version: string
  }
).version

/** Configuration files Hugo reads, in the order it prefers them. */
const HUGO_CONFIG_FILES = [
  'hugo.toml',
  'hugo.yaml',
  'hugo.yml',
  'hugo.json',
  'config.toml',
  'config.yaml',
  'config.yml',
  'config.json',
  'config/_default/hugo.toml',
  'config/_default/config.toml',
  'config/_default/hugo.yaml',
  'config/_default/config.yaml',
]
const HUGO_MENU_FILES = ['config/_default/menus.toml', 'config/_default/menus.yaml', 'config/_default/menus.yml']

const adapter = defineGenerator({
  apiVersion: 1,
  id: 'hugo',
  displayName: 'Hugo',
  packageName: PACKAGE_NAME,
  packageVersion: PACKAGE_VERSION,
  authoring: {
    skillName: 'doxloop-hugo',
    skillDirectory: fileURLToPath(new URL('../skills/doxloop-hugo', import.meta.url)),
  },
  planning: { navigationFiles: ['hugo.toml', 'config.toml', 'config/_default/menus.toml'] },
  project: {
    defaultContentDir: 'content',
    pageExtensions: ['.md'],
    gitignore: ['public/', 'resources/_gen/', '.hugo_build.lock'],
    contentFormat: 'markdown' as const,
  },
  build: { command: 'hugo --minify', outputDir: 'public' },
  scaffold: scaffoldHugo,
  preview: startHugoPreview,
  resolveLocalAsset({ root, reference }) {
    return resolvePublicAsset(root, 'static', reference)
  },
  validate: validateHugo,
})

export default adapter

export function hugoPreviewInvocation(
  options: GeneratorPreviewOptions,
  command = 'hugo',
): { command: string; args: string[] } {
  return {
    command,
    args: [
      'server',
      '--bind',
      options.host,
      '--port',
      String(options.port),
      '--disableFastRender',
      '--navigateToChanged',
    ],
  }
}

async function scaffoldHugo(context: GeneratorScaffoldContext): Promise<void> {
  const { root, title, contentDir } = context
  await mkdir(join(root, contentDir), { recursive: true })
  await mkdir(join(root, 'layouts', '_default'), { recursive: true })
  await mkdir(join(root, 'layouts', 'shortcodes'), { recursive: true })
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
      'docs:build': 'hugo --minify',
      'docs:test': 'doxloop test',
    },
    devDependencies: {
      ...(isRecord(existing.devDependencies) ? existing.devDependencies : {}),
      [context.corePackage.name]: `^${context.corePackage.version}`,
      [context.generatorPackage.name]: `^${context.generatorPackage.version}`,
    },
  })
  await writeFile(
    join(root, 'hugo.toml'),
    `baseURL = "https://example.com/"
locale = "en-US"
title = ${JSON.stringify(title)}
disableKinds = ["taxonomy", "term"]
contentDir = ${JSON.stringify(contentDir)}
enableRobotsTXT = true

[params]
description = ${JSON.stringify(`Documentation for ${title}.`)}

[markup.highlight]
noClasses = false

[markup.goldmark.renderer]
unsafe = false

[[menus.main]]
name = "Overview"
pageRef = "/"
weight = 10

[[menus.main]]
name = "Quickstart"
pageRef = "/quickstart"
weight = 20
`,
    { encoding: 'utf8', flag: 'wx' },
  )
  await writeFile(
    join(root, 'layouts', '_default', 'baseof.html'),
    `<!doctype html>
<html lang="{{ site.Language.Locale }}">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="description" content="{{ .Description | default site.Params.description }}">
    <title>{{ if .IsHome }}{{ site.Title }}{{ else }}{{ .Title }} · {{ site.Title }}{{ end }}</title>
    {{ with resources.Get "css/site.css" }}<link rel="stylesheet" href="{{ .RelPermalink }}">{{ end }}
  </head>
  <body>
    <header><a class="brand" href="/">{{ site.Title }}</a></header>
    <div class="layout">
      <aside><nav aria-label="Documentation"><ul>{{ range site.Menus.main }}<li><a href="{{ .URL }}"{{ if $.IsMenuCurrent "main" . }} aria-current="page"{{ end }}>{{ .Name }}</a>{{ with .Children }}<ul>{{ range . }}<li><a href="{{ .URL }}"{{ if $.IsMenuCurrent "main" . }} aria-current="page"{{ end }}>{{ .Name }}</a></li>{{ end }}</ul>{{ end }}</li>{{ end }}</ul></nav></aside>
      <main class="book-page">{{ block "main" . }}{{ end }}</main>
    </div>
    {{ if .Store.Get "hasMermaid" }}<script type="module">import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs'; mermaid.initialize({ startOnLoad: true });</script>{{ end }}
  </body>
</html>
`,
    { encoding: 'utf8', flag: 'wx' },
  )
  await writeFile(
    join(root, 'layouts', '_default', 'single.html'),
    `{{ define "main" }}<article><h1>{{ .Title }}</h1>{{ .Content }}</article>{{ end }}
`,
    { encoding: 'utf8', flag: 'wx' },
  )
  await writeFile(
    join(root, 'layouts', '_default', 'home.html'),
    `{{ define "main" }}<article><h1>{{ .Title }}</h1>{{ .Content }}</article>{{ end }}
`,
    { encoding: 'utf8', flag: 'wx' },
  )
  await writeFile(
    join(root, 'layouts', '_default', 'list.html'),
    `{{ define "main" }}<article><h1>{{ .Title }}</h1>{{ .Content }}<ul class="section-pages">{{ range .Pages }}<li><a href="{{ .RelPermalink }}">{{ .Title }}</a>{{ with .Description }} <small>{{ . }}</small>{{ end }}</li>{{ end }}</ul></article>{{ end }}
`,
    { encoding: 'utf8', flag: 'wx' },
  )
  await mkdir(join(root, 'layouts', '_default', '_markup'), { recursive: true })
  await writeFile(
    join(root, 'layouts', '_default', '_markup', 'render-codeblock-mermaid.html'),
    `<pre class="mermaid">{{ .Inner | htmlEscape | safeHTML }}</pre>
{{ .Page.Store.Set "hasMermaid" true }}
`,
    { encoding: 'utf8', flag: 'wx' },
  )
  await writeFile(
    join(root, 'layouts', 'shortcodes', 'callout.html'),
    `{{- $type := .Get "type" | default "note" -}}
<aside class="callout callout-{{ $type }}" role="note">{{ with .Get "title" }}<strong>{{ . }}</strong>{{ end }}{{ .Inner | markdownify }}</aside>
`,
    { encoding: 'utf8', flag: 'wx' },
  )
  await writeFile(
    join(root, 'layouts', 'shortcodes', 'tabs.html'),
    `<div class="tabs">{{ .Inner }}</div>
`,
    { encoding: 'utf8', flag: 'wx' },
  )
  await writeFile(
    join(root, 'layouts', 'shortcodes', 'tab.html'),
    `<details class="tab"{{ if eq (.Get "default") "true" }} open{{ end }}><summary>{{ .Get "name" }}</summary>{{ .Inner | markdownify }}</details>
`,
    { encoding: 'utf8', flag: 'wx' },
  )
  await writeFile(
    join(root, 'assets', 'css', 'site.css'),
    `:root { color-scheme: light dark; font-family: Inter, system-ui, sans-serif; --primary: #4f46e5; }
body { margin: 0; color: #1f2937; background: #fff; }
header { border-bottom: 1px solid #e5e7eb; padding: 1rem 2rem; }
.brand { color: var(--primary); font-weight: 700; text-decoration: none; }
.layout { display: grid; grid-template-columns: 16rem minmax(0, 48rem); gap: 3rem; max-width: 72rem; margin: 0 auto; padding: 2rem; }
aside ul { list-style: none; padding: 0; } aside a { display: block; padding: .5rem; } aside ul ul { padding-left: 1rem; }
main { line-height: 1.7; } code { font-family: ui-monospace, monospace; }
.callout { border-left: 4px solid var(--primary); padding: .75rem 1rem; margin: 1rem 0; background: #eef2ff; }
.callout-warning { border-color: #d97706; background: #fffbeb; } .callout-danger { border-color: #dc2626; background: #fef2f2; }
.tabs { border: 1px solid #e5e7eb; border-radius: .5rem; margin: 1rem 0; } .tab summary { cursor: pointer; padding: .5rem 1rem; font-weight: 600; } .tab > :not(summary) { padding: 0 1rem 1rem; }
.section-pages small { display: block; color: #6b7280; }
@media (max-width: 720px) { .layout { grid-template-columns: 1fr; } }
`,
    { encoding: 'utf8', flag: 'wx' },
  )
  await writeFile(
    join(root, contentDir, '_index.md'),
    `---
title: ${JSON.stringify(title)}
description: "Understand what ${title} helps you accomplish and choose your first workflow."
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

async function startHugoPreview(options: GeneratorPreviewOptions): Promise<void> {
  const binary = await findExecutable('hugo')
  if (!binary) {
    throw new DoxloopError(
      'Hugo is not installed. Install Hugo from https://gohugo.io/installation/ and run `doxloop preview` again.',
      2,
    )
  }
  const invocation = hugoPreviewInvocation(options, binary)
  const url = `http://${shownHost(options.host)}:${options.port}`
  process.stdout.write(`Starting Hugo preview at ${url}\n`)
  if (options.open) setTimeout(() => void openBrowser(url), 800)
  await runPreviewProcess(invocation.command, invocation.args, options.root, 'Hugo')
}

/**
 * A Hugo page is reachable when a menu names it, its front matter joins a
 * menu, or it lives in a section whose `_index.md` lists it. A site that uses
 * a theme gets its navigation from that theme, which this cannot follow, so
 * only menu references are checked there.
 */
async function validateHugo(
  context: GeneratorValidationContext,
): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = []
  if (!(await pathExists(join(context.root, 'package.json')))) {
    issues.push({
      severity: 'error',
      code: 'missing-generator-file',
      message: 'Hugo project is missing package.json.',
      file: 'package.json',
    })
  }
  let configFile: string | undefined
  for (const candidate of HUGO_CONFIG_FILES) {
    if (await pathExists(join(context.root, candidate))) {
      configFile = candidate
      break
    }
  }
  if (!configFile) {
    issues.push({
      severity: 'error',
      code: 'missing-generator-file',
      message: 'Hugo project is missing hugo.toml (or another Hugo configuration file).',
      file: 'hugo.toml',
    })
    return issues
  }
  const config = await readFile(join(context.root, configFile), 'utf8')
  const usesTheme =
    /^\s*theme\s*[:=]/m.test(config) ||
    (await pathExists(join(context.root, 'themes'))) ||
    /^\s*\[module\]|^\s*module\s*:/m.test(config)
  if (!usesTheme) {
    for (const file of ['layouts/_default/baseof.html', 'layouts/_default/single.html']) {
      if (!(await pathExists(join(context.root, file)))) {
        issues.push({
          severity: 'error',
          code: 'missing-generator-file',
          message: `Hugo project is missing ${file}.`,
          file,
        })
      }
    }
  }
  if (!/\.toml$/.test(configFile)) {
    issues.push(
      navigationUnverifiedIssue('Hugo', configFile, `menus in ${configFile} are not read; only TOML configuration is.`),
    )
    return issues
  }
  const menuSources = [config]
  for (const menuFile of HUGO_MENU_FILES) {
    if (await pathExists(join(context.root, menuFile))) {
      if (!/\.toml$/.test(menuFile)) {
        issues.push(navigationUnverifiedIssue('Hugo', menuFile, `menus in ${menuFile} are not read; only TOML configuration is.`))
        return issues
      }
      menuSources.push(await readFile(join(context.root, menuFile), 'utf8'))
    }
  }
  const pageIds = new Set(context.pageIds)
  const navigation = new Set<string>()
  for (const source of menuSources) {
    for (const match of source.matchAll(/^\s*pageRef\s*=\s*["']([^"']+)["']/gm)) {
      const target = hugoRouteToPageId(match[1] ?? '', pageIds)
      if (!target.found) {
        issues.push({
          severity: 'error',
          code: 'missing-page',
          message: `Hugo menu references missing page "${target.id}".`,
          file: configFile,
        })
      }
      navigation.add(target.id)
    }
    for (const match of source.matchAll(/^\s*url\s*=\s*["']\/([^"']*)["']/gm)) {
      navigation.add(hugoRouteToPageId(`/${match[1] ?? ''}`, pageIds).id)
    }
  }
  const pages = contentRelativePages(context.contentRoot, context.pages)
  for (const page of pages) {
    const id = page.replace(/\.md$/i, '')
    if (navigation.has(id)) continue
    const raw = await readFile(join(context.contentRoot, page), 'utf8')
    if (frontMatterJoinsMenu(raw)) {
      navigation.add(id)
      continue
    }
    const base = posix.basename(id)
    if (base === '_index' || base === 'index') {
      // Home and section pages are reachable through their parent list page.
      navigation.add(id)
      continue
    }
    const directory = posix.dirname(id)
    if (directory !== '.' && pageIds.has(`${directory}/_index`)) {
      navigation.add(id)
    }
  }
  if (usesTheme) {
    issues.push(
      navigationUnverifiedIssue('Hugo', configFile, 'the theme decides which pages its sidebar lists.'),
    )
    return issues
  }
  for (const page of pages) {
    const id = page.replace(/\.md$/i, '')
    if (!navigation.has(id)) {
      issues.push({
        severity: 'error',
        code: 'unnavigated-page',
        message: `Page "${id}" is not in a Hugo menu or a section with an _index.md page.`,
        file: `${context.project.contentDir}/${page}`,
      })
    }
  }
  return issues
}

function hugoRouteToPageId(route: string, pageIds: Set<string>): { id: string; found: boolean } {
  const clean = route.replace(/^\/+|\/+$/g, '')
  if (clean === '') return { id: '_index', found: pageIds.has('_index') }
  if (pageIds.has(clean)) return { id: clean, found: true }
  if (pageIds.has(`${clean}/_index`)) return { id: `${clean}/_index`, found: true }
  if (pageIds.has(`${clean}/index`)) return { id: `${clean}/index`, found: true }
  return { id: clean, found: false }
}

function frontMatterJoinsMenu(raw: string): boolean {
  const yaml = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (yaml) return /^menus?\s*:/m.test(yaml[1] ?? '')
  const toml = raw.match(/^\+\+\+\r?\n([\s\S]*?)\r?\n\+\+\+/)
  if (toml) return /^\s*(?:\[menus?[.\]]|menus?\s*=)/m.test(toml[1] ?? '')
  return false
}
