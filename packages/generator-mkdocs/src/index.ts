import { readFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DoxloopError,
  defineGenerator,
  type GeneratorNavigationContext,
  type GeneratorNavigationTree,
  type GeneratorNavigationTreeContext,
  type GeneratorNavigationTreeNode,
  type GeneratorPreviewOptions,
  type GeneratorScaffoldContext,
  type GeneratorValidationContext,
  type ValidationIssue,
} from '@doxbrix/doxloop/generator-api'
import {
  contentRelativePages,
  ensurePythonDependencies,
  isRecord,
  navigationUnverifiedIssue,
  openBrowser,
  pathExists,
  readPackageJson,
  runPreviewProcess,
  shownHost,
  slugFromTitle,
  venvExecutable,
  writeJsonFile,
} from '@doxbrix/doxloop/generator-runtime'
import { isMap, isSeq, parse as parseYaml, parseDocument, YAMLMap, YAMLSeq } from 'yaml'

const PACKAGE_NAME = '@doxbrix/doxloop-generator-mkdocs'
const PACKAGE_VERSION = (
  JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  ) as { version: string }
).version

const adapter = defineGenerator({
  apiVersion: 1,
  id: 'mkdocs',
  displayName: 'MkDocs Material',
  packageName: PACKAGE_NAME,
  packageVersion: PACKAGE_VERSION,
  authoring: {
    skillName: 'doxloop-mkdocs',
    skillDirectory: fileURLToPath(
      new URL('../skills/doxloop-mkdocs', import.meta.url),
    ),
  },
  planning: { navigationFiles: ['mkdocs.yml'] },
  project: {
    defaultContentDir: 'docs',
    pageExtensions: ['.md'],
    gitignore: ['site/', '.doxloop/venv/'],
    contentFormat: 'markdown' as const,
  },
  build: {
    command: 'mkdocs build --strict',
    outputDir: 'site',
  },
  scaffold: scaffoldMkDocs,
  preview: startMkDocsPreview,
  validate: validateMkDocs,
  writeNavigation: writeMkDocsNavigation,
  readNavigationTree: readMkDocsNavigationTree,
  writeNavigationTree: writeMkDocsNavigationTree,
})

export default adapter

export function mkdocsPreviewInvocation(options: GeneratorPreviewOptions): {
  command: string
  args: string[]
} {
  return {
    command: venvExecutable(options.root, 'mkdocs'),
    args: ['serve', '--dev-addr', `${options.host}:${options.port}`],
  }
}

async function scaffoldMkDocs(context: GeneratorScaffoldContext): Promise<void> {
  const { root, title, contentDir } = context
  await mkdir(join(root, contentDir, 'stylesheets'), { recursive: true })
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
      'docs:test': 'doxloop test',
    },
    devDependencies: {
      ...(isRecord(existing.devDependencies) ? existing.devDependencies : {}),
      [context.corePackage.name]: `^${context.corePackage.version}`,
      [context.generatorPackage.name]: `^${context.generatorPackage.version}`,
    },
  })
  await writeFile(
    join(root, 'requirements.txt'),
    'mkdocs==1.6.1\nmkdocs-material==9.6.16\n',
    { encoding: 'utf8', flag: 'wx' },
  )
  await writeFile(
    join(root, 'mkdocs.yml'),
    `site_name: ${yamlString(title)}
site_description: ${yamlString(`Documentation for ${title}.`)}
docs_dir: ${yamlString(contentDir)}
site_dir: site
strict: true

theme:
  name: material
  features:
    - navigation.sections
    - navigation.indexes
    - content.code.copy
    - content.tabs.link
  palette:
    - media: "(prefers-color-scheme: light)"
      scheme: default
      primary: indigo
      toggle:
        icon: material/brightness-7
        name: Switch to dark mode
    - media: "(prefers-color-scheme: dark)"
      scheme: slate
      primary: indigo
      toggle:
        icon: material/brightness-4
        name: Switch to light mode

nav:
  - Overview: index.md
  - Quickstart: quickstart.md

markdown_extensions:
  - meta
  - admonition
  - attr_list
  - md_in_html
  - pymdownx.details
  - pymdownx.superfences:
      custom_fences:
        - name: mermaid
          class: mermaid
          format: !!python/name:pymdownx.superfences.fence_code_format
  - pymdownx.tabbed:
      alternate_style: true

extra_css:
  - stylesheets/extra.css
`,
    { encoding: 'utf8', flag: 'wx' },
  )
  await writeFile(
    join(root, contentDir, 'stylesheets', 'extra.css'),
    `:root {
  --md-primary-fg-color: #4f46e5;
  --md-primary-fg-color--dark: #4338ca;
  --md-primary-fg-color--light: #6366f1;
}
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

!!! info

    The authoring agent will replace this starter with an evidence-backed product overview.

[Follow the quickstart](quickstart.md) to reach your first successful result.
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

async function validateMkDocs(
  context: GeneratorValidationContext,
): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = []
  // Existing Python-only sites need no Node manifest or dependency lockfile.
  for (const file of ['mkdocs.yml']) {
    if (!(await pathExists(join(context.root, file)))) {
      issues.push({
        severity: 'error',
        code: 'missing-generator-file',
        message: `MkDocs project is missing ${file}.`,
        file,
      })
    }
  }
  const configPath = join(context.root, 'mkdocs.yml')
  if (!(await pathExists(configPath))) return issues

  let config: unknown
  try {
    config = parseYaml(await readFile(configPath, 'utf8'), { logLevel: 'silent' })
  } catch (error) {
    issues.push({
      severity: 'error',
      code: 'generator-config',
      message: `Cannot parse mkdocs.yml: ${errorMessage(error)}`,
      file: 'mkdocs.yml',
    })
    return issues
  }
  if (!isRecord(config)) {
    issues.push({
      severity: 'error',
      code: 'generator-config',
      message: 'mkdocs.yml must contain a mapping.',
      file: 'mkdocs.yml',
    })
    return issues
  }

  const docsDir = typeof config.docs_dir === 'string' ? config.docs_dir : 'docs'
  if (resolve(context.root, docsDir) !== resolve(context.contentRoot)) {
    issues.push({
      severity: 'error',
      code: 'content-directory',
      message: `mkdocs.yml docs_dir "${docsDir}" does not match the Doxloop content directory.`,
      file: 'mkdocs.yml',
    })
  }
  if (config.nav === undefined) return issues
  const navigationPlugin = navigationPluginName(config.plugins)
  if (navigationPlugin) {
    issues.push(
      navigationUnverifiedIssue(
        'MkDocs',
        'mkdocs.yml',
        `the ${navigationPlugin} plugin builds the navigation.`,
      ),
    )
    return issues
  }
  const navFiles = new Set<string>()
  collectNavFiles(config.nav, navFiles)
  const pageFiles = new Set(contentRelativePages(context.contentRoot, context.pages))
  for (const file of navFiles) {
    if (!pageFiles.has(file)) {
      issues.push({
        severity: 'error',
        code: 'missing-page',
        message: `MkDocs navigation references missing page "${file}".`,
        file: 'mkdocs.yml',
      })
    }
  }
  for (const file of pageFiles) {
    if (!navFiles.has(file)) {
      issues.push({
        severity: 'error',
        code: 'unnavigated-page',
        message: `Page "${file}" is not in MkDocs navigation.`,
        file: `${docsDir.replace(/\/+$/, '')}/${file}`,
      })
    }
  }
  return issues
}

/** Plugins that generate or rewrite `nav`, so the literal list is not the whole story. */
function navigationPluginName(plugins: unknown): string | undefined {
  if (!Array.isArray(plugins)) return undefined
  for (const plugin of plugins) {
    const name = typeof plugin === 'string' ? plugin : isRecord(plugin) ? Object.keys(plugin)[0] : undefined
    if (name && /^(?:awesome-pages|awesome-nav|literate-nav|section-index|gen-files|monorepo|mkdocs-simple-hooks)$/.test(name)) {
      return name
    }
  }
  return undefined
}

function collectNavFiles(value: unknown, output: Set<string>): void {
  if (typeof value === 'string') {
    if (!/^(?:[a-z]+:)?\/\//i.test(value) && /\.md$/i.test(value)) {
      output.add(value.replace(/^\.\//, ''))
    }
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) collectNavFiles(item, output)
    return
  }
  if (isRecord(value)) {
    for (const item of Object.values(value)) collectNavFiles(item, output)
  }
}

/**
 * Edits the `nav` list in place through the YAML document model so comments,
 * anchors, and the Python tags Material relies on survive the rewrite. A
 * missing `nav` means MkDocs lists every page itself, so nothing is written.
 */
async function writeMkDocsNavigation(context: GeneratorNavigationContext): Promise<void> {
  const configPath = join(context.root, 'mkdocs.yml')
  if (!(await pathExists(configPath))) {
    throw new DoxloopError('mkdocs.yml is missing, so the navigation cannot be updated.', 2)
  }
  const document = parseDocument(await readFile(configPath, 'utf8'), { logLevel: 'silent' })
  const nav = document.get('nav', true)
  if (nav === undefined) return
  if (!isSeq(nav)) {
    throw new DoxloopError('mkdocs.yml nav must be a list to update it.', 2)
  }
  const { action, page } = context
  const target = page.path.replace(/^\.\//, '')
  if (action === 'remove' || action === 'rename') {
    removeNavEntry(nav, action === 'rename' ? (context.from ?? target) : target)
  }
  if (action === 'add' || action === 'rename') {
    if (!navContains(nav, target)) {
      const entry = document.createNode({ [page.title]: target })
      const section = page.section ? findSection(nav, page.section) : undefined
      if (page.section && !section) {
        nav.add(document.createNode({ [page.section]: [{ [page.title]: target }] }))
      } else {
        ;(section ?? nav).add(entry)
      }
    }
  }
  await writeFile(configPath, document.toString(), 'utf8')
}

/**
 * The `nav` list as a tree. MkDocs accepts plain paths, `Title: path` pairs,
 * and `Section: [...]` pairs; every shape maps onto page and group nodes so
 * the control center can reorder and regroup it.
 */
async function readMkDocsNavigationTree(context: GeneratorNavigationTreeContext): Promise<GeneratorNavigationTree> {
  const configPath = join(context.root, 'mkdocs.yml')
  if (!(await pathExists(configPath))) return { nodes: [] }
  // Python tags such as `!!python/name:` are common in mkdocs.yml; a silent
  // document parse keeps them from logging warnings on every read.
  const config = parseDocument(await readFile(configPath, 'utf8'), { logLevel: 'silent' }).toJS() as Record<string, unknown> | null
  const nav = config?.nav
  return { nodes: Array.isArray(nav) ? mkdocsNavToTree(nav) : [] }
}

export function mkdocsNavToTree(entries: unknown[]): GeneratorNavigationTreeNode[] {
  const nodes: GeneratorNavigationTreeNode[] = []
  for (const entry of entries) {
    if (typeof entry === 'string') {
      nodes.push({ type: 'page', file: entry })
      continue
    }
    if (!isRecord(entry)) continue
    for (const [label, value] of Object.entries(entry)) {
      if (typeof value === 'string') nodes.push({ type: 'page', file: value, title: label })
      else if (Array.isArray(value)) nodes.push({ type: 'group', label, items: mkdocsNavToTree(value) })
    }
  }
  return nodes
}

export function treeToMkdocsNav(nodes: GeneratorNavigationTreeNode[]): unknown[] {
  return nodes.map((node) => (node.type === 'group'
    ? { [node.label]: treeToMkdocsNav(node.items) }
    : node.title ? { [node.title]: node.file } : node.file))
}

async function writeMkDocsNavigationTree(context: GeneratorNavigationTreeContext & { tree: GeneratorNavigationTree }): Promise<void> {
  const configPath = join(context.root, 'mkdocs.yml')
  if (!(await pathExists(configPath))) {
    throw new DoxloopError('mkdocs.yml is missing, so the navigation cannot be updated.', 2)
  }
  const document = parseDocument(await readFile(configPath, 'utf8'), { logLevel: 'silent' })
  document.set('nav', document.createNode(treeToMkdocsNav(context.tree.nodes)))
  await writeFile(configPath, document.toString(), 'utf8')
}

function findSection(nav: YAMLSeq, label: string): YAMLSeq | undefined {
  for (const item of nav.items) {
    if (!isMap(item)) continue
    for (const pair of (item as YAMLMap).items) {
      if (String(pair.key) === label && isSeq(pair.value)) return pair.value as YAMLSeq
    }
  }
  return undefined
}

function navContains(nav: YAMLSeq, target: string): boolean {
  for (const item of nav.items) {
    if (typeof item === 'string' ? item === target : isMap(item)
      ? (item as YAMLMap).items.some((pair) => {
        const value = pair.value
        if (isSeq(value)) return navContains(value as YAMLSeq, target)
        return String((value as { value?: unknown })?.value ?? value) === target
      })
      : String((item as { value?: unknown })?.value ?? item) === target) {
      return true
    }
  }
  return false
}

function removeNavEntry(nav: YAMLSeq, target: string): void {
  for (let index = nav.items.length - 1; index >= 0; index -= 1) {
    const item = nav.items[index]
    const scalar = String((item as { value?: unknown })?.value ?? item)
    if (!isMap(item)) {
      if (scalar === target) nav.items.splice(index, 1)
      continue
    }
    const map = item as YAMLMap
    for (let pairIndex = map.items.length - 1; pairIndex >= 0; pairIndex -= 1) {
      const pair = map.items[pairIndex]!
      if (isSeq(pair.value)) {
        removeNavEntry(pair.value as YAMLSeq, target)
        if ((pair.value as YAMLSeq).items.length === 0) map.items.splice(pairIndex, 1)
        continue
      }
      const value = String((pair.value as { value?: unknown })?.value ?? pair.value)
      if (value === target) map.items.splice(pairIndex, 1)
    }
    if (map.items.length === 0) nav.items.splice(index, 1)
  }
}

async function startMkDocsPreview(options: GeneratorPreviewOptions): Promise<void> {
  await ensurePythonDependencies(options.root, 'mkdocs', 'MkDocs')
  const invocation = mkdocsPreviewInvocation(options)
  const url = `http://${shownHost(options.host)}:${options.port}`
  process.stdout.write(`Starting MkDocs preview at ${url}\n`)
  if (options.open) setTimeout(() => void openBrowser(url), 800)
  await runPreviewProcess(invocation.command, invocation.args, options.root, 'MkDocs')
}

function yamlString(value: string): string {
  return JSON.stringify(value)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
