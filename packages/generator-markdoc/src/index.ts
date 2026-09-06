import { readFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DoxloopError,
  defineGenerator,
  type GeneratorNavigationContext,
  type GeneratorPreviewOptions,
  type GeneratorScaffoldContext,
  type GeneratorValidationContext,
  type ValidationIssue,
} from '@doxbrix/doxloop/generator-api'
import {
  contentRelativePages,
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
  planning: { navigationFiles: ['navigation.json', 'markdoc.config.mjs'] },
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
  writeNavigation: writeMarkdocNavigation,
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
    `import Markdoc from '@markdoc/markdoc'

const { Tag } = Markdoc

export default {
  nodes: {
    // Fenced code keeps its language; a \`mermaid\` fence becomes a diagram container.
    fence: {
      ...Markdoc.nodes.fence,
      transform(node, config) {
        const attributes = node.transformAttributes(config)
        const content = String(node.attributes.content ?? '')
        if (attributes.language === 'mermaid') return new Tag('pre', { class: 'mermaid' }, [content])
        const code = new Tag('code', attributes.language ? { class: \`language-\${attributes.language}\` } : {}, [content])
        return new Tag('pre', attributes.language ? { 'data-language': attributes.language } : {}, [code])
      },
    },
  },
  tags: {
    callout: {
      render: 'aside',
      attributes: {
        title: { type: String },
        type: { type: String, default: 'note', matches: ['note', 'tip', 'warning', 'danger'] },
      },
      transform(node, config) {
        const attributes = node.transformAttributes(config)
        const children = node.transformChildren(config)
        return new Tag('aside', { class: \`callout callout-\${attributes.type}\`, role: 'note' }, [
          ...(attributes.title ? [new Tag('strong', {}, [attributes.title])] : []),
          ...children,
        ])
      },
    },
    tabs: {
      render: 'div',
      transform(node, config) {
        return new Tag('div', { class: 'tabs' }, node.transformChildren(config))
      },
    },
    tab: {
      render: 'details',
      attributes: {
        name: { type: String, required: true },
        default: { type: Boolean, default: false },
      },
      transform(node, config) {
        const attributes = node.transformAttributes(config)
        return new Tag('details', attributes.default ? { class: 'tab', open: true } : { class: 'tab' }, [
          new Tag('summary', {}, [attributes.name]),
          ...node.transformChildren(config),
        ])
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
nav ul { list-style: none; padding: 0; } nav a { display: block; padding: .5rem; } nav ul ul { padding-left: 1rem; }
.markdoc-content { line-height: 1.7; min-width: 0; } .callout { border-left: 4px solid var(--brand); padding: 1rem; margin: 1rem 0; background: #eef2ff; } .callout strong { display: block; margin-bottom: .25rem; }
.callout-warning { border-color: #d97706; background: #fffbeb; } .callout-danger { border-color: #dc2626; background: #fef2f2; }
.tabs { border: 1px solid #e5e7eb; border-radius: .5rem; margin: 1rem 0; } .tabs details { border-bottom: 1px solid #e5e7eb; } .tabs summary { cursor: pointer; padding: .5rem 1rem; font-weight: 600; } .tabs details > :not(summary) { padding: 0 1rem 1rem; }
pre { overflow: auto; padding: 1rem; background: #111827; color: #f9fafb; border-radius: .5rem; } pre.mermaid { background: transparent; color: inherit; }
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

// Entries carrying a section are grouped under it in the sidebar, in file order.
const sections = new Map()
for (const entry of navigation) {
  const key = entry.section ?? ''
  if (!sections.has(key)) sections.set(key, [])
  sections.get(key).push(entry)
}
const sidebar = [...sections].map(([section, entries]) => {
  const items = entries.map((entry) => \`<li><a href="\${entry.href}">\${escapeHtml(entry.title)}</a></li>\`).join('')
  return section ? \`<li><strong>\${escapeHtml(section)}</strong><ul>\${items}</ul></li>\` : items
}).join('')

for (const item of navigation) {
  const sourcePath = join(root, ${JSON.stringify(contentDir)}, item.file)
  const parsed = matter(await readFile(sourcePath, 'utf8'))
  const ast = Markdoc.parse(parsed.content)
  const errors = Markdoc.validate(ast, config)
  if (errors.length > 0) {
    throw new Error(\`\${item.file}: \${errors.map((error) => error.error?.message ?? error.type).join(', ')}\`)
  }
  const rendered = Markdoc.renderers.html(Markdoc.transform(ast, config))
  const hasMermaid = rendered.includes('class="mermaid"')
  const target = item.href === '/' ? join(output, 'index.html') : join(output, item.href, 'index.html')
  await mkdir(dirname(target), { recursive: true })
  const title = parsed.data.title ?? item.title
  const description = parsed.data.description ?? ''
  await writeFile(target, \`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="\${escapeHtml(description)}"><title>\${escapeHtml(title)}</title><link rel="stylesheet" href="/site.css"></head>
<body><header><a class="brand" href="/">${escapeForTemplate(title)}</a></header><div class="markdoc-layout">
<aside class="markdoc-sidebar"><nav aria-label="Documentation"><ul>\${sidebar}</ul></nav></aside>
<main class="markdoc-content"><article>\${rendered}</article></main></div>\${hasMermaid ? '<script type="module">import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs"; mermaid.initialize({ startOnLoad: true });</script>' : ''}</body></html>\`)
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
      .filter((file): file is string => typeof file === 'string')
      .map((file) => file.replace(/^\.?\//, '')),
  )
  const pageFiles = new Set(contentRelativePages(context.contentRoot, context.pages))
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
        file: `${context.project.contentDir}/${file}`,
      })
    }
  }
  return issues
}

/** `navigation.json` is a flat list in reader order; a `section` groups entries in the sidebar. */
async function writeMarkdocNavigation(context: GeneratorNavigationContext): Promise<void> {
  const navigationPath = join(context.root, 'navigation.json')
  if (!(await pathExists(navigationPath))) {
    throw new DoxloopError('navigation.json is missing, so the navigation cannot be updated.', 2)
  }
  const parsed = JSON.parse(await readFile(navigationPath, 'utf8')) as unknown
  if (!Array.isArray(parsed)) throw new DoxloopError('navigation.json must contain an array.', 2)
  const entries = parsed.filter(isRecord)
  const { action, page } = context
  const file = page.path.replace(/^\.?\//, '')
  const previous = action === 'rename' ? (context.from ?? file).replace(/^\.?\//, '') : file
  const index = entries.findIndex((entry) => entry.file === previous)
  if (action === 'remove') {
    if (index !== -1) entries.splice(index, 1)
  } else {
    const entry = {
      title: page.title,
      file,
      href: markdocHref(file),
      ...(page.section ? { section: page.section } : {}),
    }
    if (index !== -1) entries[index] = { ...entries[index], ...entry }
    else if (page.section) {
      const last = entries.map((item) => item.section).lastIndexOf(page.section)
      entries.splice(last === -1 ? entries.length : last + 1, 0, entry)
    } else entries.push(entry)
  }
  await writeJsonFile(navigationPath, entries)
}

export function markdocHref(file: string): string {
  const route = file.replace(/\.md$/i, '').replace(/(^|\/)index$/, '')
  return route ? `/${route}/` : '/'
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
