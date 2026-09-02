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
      <aside><nav aria-label="Documentation"><ul>{{ range site.Menus.main }}<li><a href="{{ .URL }}"{{ if $.IsMenuCurrent "main" . }} aria-current="page"{{ end }}>{{ .Name }}</a></li>{{ end }}</ul></nav></aside>
      <main class="book-page">{{ block "main" . }}{{ end }}</main>
    </div>
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
    join(root, 'assets', 'css', 'site.css'),
    `:root { color-scheme: light dark; font-family: Inter, system-ui, sans-serif; --primary: #4f46e5; }
body { margin: 0; color: #1f2937; background: #fff; }
header { border-bottom: 1px solid #e5e7eb; padding: 1rem 2rem; }
.brand { color: var(--primary); font-weight: 700; text-decoration: none; }
.layout { display: grid; grid-template-columns: 16rem minmax(0, 48rem); gap: 3rem; max-width: 72rem; margin: 0 auto; padding: 2rem; }
aside ul { list-style: none; padding: 0; } aside a { display: block; padding: .5rem; }
main { line-height: 1.7; } code { font-family: ui-monospace, monospace; }
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

async function validateHugo(
  context: GeneratorValidationContext,
): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = []
  for (const file of [
    'package.json',
    'hugo.toml',
    'layouts/_default/baseof.html',
    'layouts/_default/single.html',
  ]) {
    if (!(await pathExists(join(context.root, file)))) {
      issues.push({
        severity: 'error',
        code: 'missing-generator-file',
        message: `Hugo project is missing ${file}.`,
        file,
      })
    }
  }
  const configPath = join(context.root, 'hugo.toml')
  if (!(await pathExists(configPath))) return issues
  const config = await readFile(configPath, 'utf8')
  const navigation = new Set<string>()
  for (const match of config.matchAll(/^\s*pageRef\s*=\s*["']([^"']+)["']/gm)) {
    const target = match[1]
    if (!target) continue
    navigation.add(target === '/' ? '_index' : target.replace(/^\/|\/$/g, ''))
  }
  for (const id of navigation) {
    if (!context.pageIds.includes(id)) {
      issues.push({
        severity: 'error',
        code: 'missing-page',
        message: `Hugo menu references missing page "${id}".`,
        file: 'hugo.toml',
      })
    }
  }
  for (const id of context.pageIds) {
    if (!navigation.has(id)) {
      issues.push({
        severity: 'error',
        code: 'unnavigated-page',
        message: `Page "${id}" is not in the Hugo main menu.`,
        file: `${id}.md`,
      })
    }
  }
  return issues
}
