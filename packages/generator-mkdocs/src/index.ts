import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DoxloopError,
  defineGenerator,
  type GeneratorPreviewOptions,
  type GeneratorScaffoldContext,
  type ValidationIssue,
} from '@doxbrix/doxloop/generator-api'
import { parse as parseYaml } from 'yaml'

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
  },
  build: {
    command: 'mkdocs build --strict',
    outputDir: 'site',
  },
  scaffold: scaffoldMkDocs,
  preview: startMkDocsPreview,
  validate: validateMkDocs,
})

export default adapter

export function mkdocsPreviewInvocation(options: GeneratorPreviewOptions): {
  command: string
  args: string[]
} {
  const binary = mkdocsBinary(options.root)
  return {
    command: binary,
    args: [
      'serve',
      '--dev-addr',
      `${options.host}:${options.port}`,
    ],
  }
}

async function scaffoldMkDocs(context: GeneratorScaffoldContext): Promise<void> {
  const { root, title, contentDir } = context
  await mkdir(join(root, contentDir, 'stylesheets'), { recursive: true })
  const existing = await readPackageJson(root)
  await writeJson(join(root, 'package.json'), {
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
  - pymdownx.superfences
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

async function validateMkDocs(context: {
  root: string
  contentRoot: string
  pages: string[]
  pageIds: string[]
}): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = []
  for (const file of ['package.json', 'requirements.txt', 'mkdocs.yml']) {
    if (!(await exists(join(context.root, file)))) {
      issues.push({
        severity: 'error',
        code: 'missing-generator-file',
        message: `MkDocs project is missing ${file}.`,
        file,
      })
    }
  }
  const configPath = join(context.root, 'mkdocs.yml')
  if (!(await exists(configPath))) return issues

  let config: unknown
  try {
    config = parseYaml(await readFile(configPath, 'utf8'))
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
  if (config.nav !== undefined) {
    const navFiles = new Set<string>()
    collectNavFiles(config.nav, navFiles)
    const pageFiles = new Set(
      context.pages.map((page) =>
        relative(context.contentRoot, page).split('\\').join('/'),
      ),
    )
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
          file,
        })
      }
    }
  }
  return issues
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

async function startMkDocsPreview(options: GeneratorPreviewOptions): Promise<void> {
  await ensureMkDocsDependencies(options.root)
  const invocation = mkdocsPreviewInvocation(options)
  process.stdout.write(
    `Starting MkDocs preview at http://${shownHost(options.host)}:${options.port}\n`,
  )
  if (options.open) {
    setTimeout(() => {
      void openBrowser(`http://${shownHost(options.host)}:${options.port}`)
    }, 800)
  }
  await runPreview(invocation.command, invocation.args, options.root)
}

async function ensureMkDocsDependencies(root: string): Promise<void> {
  const binary = mkdocsBinary(root)
  if (await exists(binary)) return
  if (!(await exists(join(root, 'requirements.txt')))) {
    throw new DoxloopError('This MkDocs project has no requirements.txt.', 2)
  }
  const python = process.platform === 'win32' ? 'python' : 'python3'
  process.stdout.write(
    'Creating .doxloop/venv and installing MkDocs dependencies (first preview only)...\n',
  )
  const venv = join(root, '.doxloop', 'venv')
  let code = await runChild(python, ['-m', 'venv', venv], root)
  if (code === 0) {
    code = await runChild(
      venvExecutable(root, 'python'),
      ['-m', 'pip', 'install', '-r', 'requirements.txt'],
      root,
    )
  }
  if (code !== 0 || !(await exists(binary))) {
    throw new DoxloopError(
      'MkDocs dependency installation did not complete. Create a Python virtual environment and run `pip install -r requirements.txt`.',
      2,
    )
  }
}

async function runPreview(
  command: string,
  args: string[],
  root: string,
): Promise<void> {
  const child = spawn(command, args, { cwd: root, stdio: 'inherit' })
  const forward = (signal: NodeJS.Signals): void => {
    if (!child.killed) child.kill(signal)
  }
  const onSigint = (): void => forward('SIGINT')
  const onSigterm = (): void => forward('SIGTERM')
  process.once('SIGINT', onSigint)
  process.once('SIGTERM', onSigterm)
  try {
    const result = await new Promise<{
      code: number | null
      signal: NodeJS.Signals | null
    }>((resolveExit, reject) => {
      child.once('error', reject)
      child.once('exit', (code, signal) => resolveExit({ code, signal }))
    })
    if (result.code !== 0 && result.signal === null) {
      throw new DoxloopError(`MkDocs preview exited with code ${result.code ?? 1}.`)
    }
  } finally {
    process.off('SIGINT', onSigint)
    process.off('SIGTERM', onSigterm)
  }
}

async function openBrowser(url: string): Promise<void> {
  const invocation =
    process.platform === 'darwin'
      ? { command: 'open', args: [url] }
      : process.platform === 'win32'
        ? { command: 'cmd', args: ['/c', 'start', '', url] }
        : { command: 'xdg-open', args: [url] }
  await new Promise<void>((resolveOpen) => {
    const child = spawn(invocation.command, invocation.args, {
      stdio: 'ignore',
      detached: true,
    })
    child.once('error', () => resolveOpen())
    child.once('spawn', () => {
      child.unref()
      resolveOpen()
    })
  })
}

async function runChild(command: string, args: string[], root: string): Promise<number> {
  return new Promise((resolveExit, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', (code) => resolveExit(code ?? 1))
  })
}

function mkdocsBinary(root: string): string {
  return venvExecutable(root, 'mkdocs')
}

function venvExecutable(root: string, name: string): string {
  return join(
    root,
    '.doxloop',
    'venv',
    process.platform === 'win32' ? 'Scripts' : 'bin',
    process.platform === 'win32' ? `${name}.exe` : name,
  )
}

async function exists(path: string): Promise<boolean> {
  try {
    await readFile(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function readPackageJson(root: string): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as Record<
      string,
      unknown
    >
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw error
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function slugFromTitle(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'documentation'
  )
}

function yamlString(value: string): string {
  return JSON.stringify(value)
}

function shownHost(host: string): string {
  return host === '0.0.0.0' || host === '::' ? 'localhost' : host
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
