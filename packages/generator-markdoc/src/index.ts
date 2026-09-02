import { readFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
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
  ensureNodeModule,
  isRecord,
  pathExists,
  readPackageJson,
  resolvePublicAsset,
  runCommand,
  serveStaticDirectory,
  slugFromTitle,
  writeJsonFile,
} from '@doxbrix/doxloop/generator-runtime'

const PACKAGE_NAME = '@doxbrix/doxloop-generator-markdoc'
const PACKAGE_VERSION = (
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    version: string
  }
).version

const adapter = defineGenerator({
  apiVersion: 1,
  id: 'markdoc',
  displayName: 'Markdoc',
  packageName: PACKAGE_NAME,
  packageVersion: PACKAGE_VERSION,
  authoring: {
    skillName: 'doxloop-markdoc',
    skillDirectory: fileURLToPath(
      new URL('../skills/doxloop-markdoc', import.meta.url),
    ),
  },
  planning: { navigationFiles: ['markdoc.config.mjs', 'src/navigation.ts'] },
  project: {
    defaultContentDir: 'docs',
    pageExtensions: ['.md'],
    gitignore: ['dist/', 'node_modules/'],
    contentFormat: 'markdown' as const,
  },
  build: { command: 'npm run build', outputDir: 'dist' },
  scaffold: scaffoldMarkdoc,
  preview: startMarkdocPreview,
  resolveLocalAsset({ root, reference }) {
    return reference.startsWith('/assets/')
      ? resolvePublicAsset(root, 'assets', reference.slice('/assets'.length))
      : undefined
  },
  validate: validateMarkdoc,
})

export default adapter

async function scaffoldMarkdoc(context: GeneratorScaffoldContext): Promise<void> {
  const { root, title, contentDir } = context
  await mkdir(join(root, contentDir), { recursive: true })
  await mkdir(join(root, 'scripts'), { recursive: true })
  await mkdir(join(root, 'assets'), { recursive: true })
  await mkdir(join(root, 'assets', 'guides'), { recursive: true })
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
    type: 'module',
    scripts: {
      ...(isRecord(existing.scripts) ? existing.scripts : {}),
      dev: 'doxloop preview',
      build: 'node scripts/build.mjs',
      'docs:test': 'doxloop test',
    },
    dependencies: {
      ...(isRecord(existing.dependencies) ? existing.dependencies : {}),
      '@markdoc/markdoc': '0.5.8',
      'gray-matter': '4.0.3',
    },
    devDependencies: {
      ...(isRecord(existing.devDependencies) ? existing.devDependencies : {}),
      [context.corePackage.name]: `^${context.corePackage.version}`,
      [context.generatorPackage.name]: `^${context.generatorPackage.version}`,
    },
    engines: {
      ...(isRecord(existing.engines) ? existing.engines : {}),
      node: '>=20.12.0',
    },
  })
  await writeFile(
    join(root, 'markdoc.config.mjs'),
    `export default {
  tags: {
    callout: {
      render: 'aside',
      attributes: {
        title: { type: String },
      },
    },
  },
}
`,
    { encoding: 'utf8', flag: 'wx' },
  )
  await writeJsonFile(join(root, 'navigation.json'), [
    { title: title, file: 'index.md', href: '/' },
    { title: 'Quickstart', file: 'quickstart.md', href: '/quickstart/' },
  ])
  await writeFile(
    join(root, 'assets', 'site.css'),
    `:root { font-family: Inter, system-ui, sans-serif; --brand: #4f46e5; color: #1f2937; }
body { margin: 0; } header { border-bottom: 1px solid #e5e7eb; padding: 1rem 2rem; }
.brand { color: var(--brand); font-weight: 700; text-decoration: none; }
.markdoc-layout { display: grid; grid-template-columns: 16rem minmax(0, 48rem); gap: 3rem; max-width: 72rem; margin: 0 auto; padding: 2rem; }
nav ul { list-style: none; padding: 0; } nav a { display: block; padding: .5rem; }
.markdoc-content { line-height: 1.7; min-width: 0; } aside { border-left: 4px solid var(--brand); padding: 1rem; background: #eef2ff; }
pre { overflow: auto; padding: 1rem; background: #111827; color: #f9fafb; border-radius: .5rem; }
@media (max-width: 720px) { .markdoc-layout { grid-template-columns: 1fr; } }
`,
    { encoding: 'utf8', flag: 'wx' },
  )
  await writeFile(
    join(root, 'scripts', 'build.mjs'),
    `import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import Markdoc from '@markdoc/markdoc'
import matter from 'gray-matter'
import config from '../markdoc.config.mjs'

const root = process.cwd()
const navigation = JSON.parse(await readFile(join(root, 'navigation.json'), 'utf8'))
const output = join(root, 'dist')
await rm(output, { recursive: true, force: true })
await mkdir(output, { recursive: true })

const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[character])

for (const item of navigation) {
  const sourcePath = join(root, ${JSON.stringify(contentDir)}, item.file)
  const parsed = matter(await readFile(sourcePath, 'utf8'))
  const ast = Markdoc.parse(parsed.content)
  const errors = Markdoc.validate(ast, config)
  if (errors.length > 0) {
    throw new Error(\`\${item.file}: \${errors.map((error) => error.error?.message ?? error.type).join(', ')}\`)
  }
  const rendered = Markdoc.renderers.html(Markdoc.transform(ast, config))
  const target = item.href === '/' ? join(output, 'index.html') : join(output, item.href, 'index.html')
  await mkdir(dirname(target), { recursive: true })
  const nav = navigation.map((entry) => \`<li><a href="\${entry.href}">\${escapeHtml(entry.title)}</a></li>\`).join('')
  const title = parsed.data.title ?? item.title
  const description = parsed.data.description ?? ''
  await writeFile(target, \`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="\${escapeHtml(description)}"><title>\${escapeHtml(title)}</title><link rel="stylesheet" href="/site.css"></head>
<body><header><a class="brand" href="/">${escapeForTemplate(title)}</a></header><div class="markdoc-layout">
<aside class="markdoc-sidebar"><nav aria-label="Documentation"><ul>\${nav}</ul></nav></aside>
<main class="markdoc-content"><article>\${rendered}</article></main></div></body></html>\`)
}
await cp(join(root, 'assets', 'site.css'), join(output, 'site.css'))
await cp(join(root, 'assets', 'guides'), join(output, 'assets', 'guides'), { recursive: true })
console.log(\`Built \${navigation.length} Markdoc pages in dist/\`)
`,
    { encoding: 'utf8', flag: 'wx' },
  )
  await writeFile(
    join(root, contentDir, 'index.md'),
    `---
title: ${JSON.stringify(title)}
description: "Understand what ${title} helps you accomplish and choose your first workflow."
---

# ${title}

<!-- doxloop:starter-page -->

{% callout title="Starter content" %}
The authoring agent will replace this starter with an evidence-backed product overview.
{% /callout %}

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

# Quickstart

<!-- doxloop:starter-page -->

1. Confirm prerequisites from the configured product source.
2. Complete the first supported workflow.
3. Verify the observable result.
`,
    { encoding: 'utf8', flag: 'wx' },
  )
}

async function startMarkdocPreview(options: GeneratorPreviewOptions): Promise<void> {
  await ensureNodeModule(options.root, '@markdoc/markdoc/package.json', 'Markdoc')
  const code = await runCommand(
    process.execPath,
    [join(options.root, 'scripts', 'build.mjs')],
    options.root,
  )
  if (code !== 0) throw new DoxloopError('Markdoc build failed.', 2)
  await serveStaticDirectory(options, 'dist', 'Markdoc')
}

async function validateMarkdoc(
  context: GeneratorValidationContext,
): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = []
  for (const file of [
    'package.json',
    'markdoc.config.mjs',
    'navigation.json',
    'scripts/build.mjs',
  ]) {
    if (!(await pathExists(join(context.root, file)))) {
      issues.push({
        severity: 'error',
        code: 'missing-generator-file',
        message: `Markdoc project is missing ${file}.`,
        file,
      })
    }
  }
  const navigationPath = join(context.root, 'navigation.json')
  if (!(await pathExists(navigationPath))) return issues
  let navigation: unknown
  try {
    navigation = JSON.parse(await readFile(navigationPath, 'utf8'))
  } catch (error) {
    return [
      ...issues,
      {
        severity: 'error',
        code: 'generator-config',
        message: `Cannot parse navigation.json: ${errorMessage(error)}`,
        file: 'navigation.json',
      },
    ]
  }
  if (!Array.isArray(navigation)) {
    issues.push({
      severity: 'error',
      code: 'generator-config',
      message: 'navigation.json must contain an array.',
      file: 'navigation.json',
    })
    return issues
  }
  const navigationFiles = new Set(
    navigation
      .filter(isRecord)
      .map((item) => item.file)
      .filter((file): file is string => typeof file === 'string'),
  )
  const pageFiles = new Set(
    context.pages.map((page) =>
      relative(context.contentRoot, page).split('\\').join('/'),
    ),
  )
  for (const file of navigationFiles) {
    if (!pageFiles.has(file)) {
      issues.push({
        severity: 'error',
        code: 'missing-page',
        message: `Markdoc navigation references missing page "${file}".`,
        file: 'navigation.json',
      })
    }
  }
  for (const file of pageFiles) {
    if (!navigationFiles.has(file)) {
      issues.push({
        severity: 'error',
        code: 'unnavigated-page',
        message: `Page "${file}" is not in Markdoc navigation.`,
        file,
      })
    }
  }
  return issues
}

function escapeForTemplate(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
