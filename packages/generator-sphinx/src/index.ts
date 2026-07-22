import { readFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  defineGenerator,
  type GeneratorPage,
  type GeneratorPreviewOptions,
  type GeneratorScaffoldContext,
  type GeneratorValidationContext,
  type ValidationIssue,
} from '@doxbrix/doxloop/generator-api'
import {
  ensurePythonDependencies,
  isRecord,
  openBrowser,
  pathExists,
  readPackageJson,
  runPreviewProcess,
  shownHost,
  slugFromTitle,
  writeJsonFile,
} from '@doxbrix/doxloop/generator-runtime'

const PACKAGE_NAME = '@doxbrix/doxloop-generator-sphinx'
const PACKAGE_VERSION = (
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    version: string
  }
).version

const adapter = defineGenerator({
  apiVersion: 1,
  id: 'sphinx',
  displayName: 'Sphinx',
  packageName: PACKAGE_NAME,
  packageVersion: PACKAGE_VERSION,
  authoring: {
    skillName: 'doxloop-sphinx',
    skillDirectory: fileURLToPath(new URL('../skills/doxloop-sphinx', import.meta.url)),
  },
  project: {
    defaultContentDir: 'docs',
    pageExtensions: ['.rst'],
    gitignore: ['_build/', '.doxloop/venv/'],
    contentFormat: 'rst' as const,
  },
  build: {
    command: 'sphinx-build -W -b html docs _build/html',
    outputDir: '_build/html',
  },
  scaffold: scaffoldSphinx,
  preview: startSphinxPreview,
  validate: validateSphinx,
  readPage: readSphinxPage,
})

export default adapter

export function sphinxPreviewInvocation(
  options: GeneratorPreviewOptions,
  command: string,
): { command: string; args: string[] } {
  return {
    command,
    args: [
      'docs',
      '_build/html',
      '--host',
      options.host,
      '--port',
      String(options.port),
    ],
  }
}

async function scaffoldSphinx(context: GeneratorScaffoldContext): Promise<void> {
  const { root, title, contentDir } = context
  await mkdir(join(root, contentDir, '_static'), { recursive: true })
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
      'docs:build': 'sphinx-build -W -b html docs _build/html',
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
    'Sphinx==9.1.0\nfuro==2025.12.19\nsphinx-autobuild==2025.8.25\n',
    { encoding: 'utf8', flag: 'wx' },
  )
  await writeFile(
    join(root, contentDir, 'conf.py'),
    `project = ${JSON.stringify(title)}
author = ${JSON.stringify(title)}
language = "en"
extensions = []
exclude_patterns = []
html_theme = "furo"
html_static_path = ["_static"]
html_css_files = ["custom.css"]
`,
    { encoding: 'utf8', flag: 'wx' },
  )
  await writeFile(
    join(root, contentDir, '_static', 'custom.css'),
    `:root {
  --color-brand-primary: #4f46e5;
  --color-brand-content: #4338ca;
}
`,
    { encoding: 'utf8', flag: 'wx' },
  )
  await writeFile(
    join(root, contentDir, 'index.rst'),
    `${title}
${'='.repeat(Math.max(title.length, 3))}

.. meta::
   :description: Understand what ${title} helps you accomplish and choose your first workflow.

The authoring agent will replace this starter with an evidence-backed product overview.

Continue with the :doc:\`quickstart\` to reach your first successful result.

.. toctree::
   :maxdepth: 2
   :caption: Get started
   :hidden:

   quickstart
`,
    { encoding: 'utf8', flag: 'wx' },
  )
  await writeFile(
    join(root, contentDir, 'quickstart.rst'),
    `Quickstart
==========

.. meta::
   :description: Reach your first successful result with verified product instructions.

The authoring agent will replace this starter with verified steps.

#. Confirm prerequisites from the configured product source.
#. Complete the first supported workflow.
#. Verify the observable result.
`,
    { encoding: 'utf8', flag: 'wx' },
  )
}

async function startSphinxPreview(options: GeneratorPreviewOptions): Promise<void> {
  const binary = await ensurePythonDependencies(
    options.root,
    'sphinx-autobuild',
    'Sphinx',
  )
  const invocation = sphinxPreviewInvocation(options, binary)
  const url = `http://${shownHost(options.host)}:${options.port}`
  process.stdout.write(`Starting Sphinx preview at ${url}\n`)
  if (options.open) setTimeout(() => void openBrowser(url), 800)
  await runPreviewProcess(invocation.command, invocation.args, options.root, 'Sphinx', {
    ...process.env,
    LANG: 'C',
    LC_ALL: 'C',
  })
}

async function validateSphinx(
  context: GeneratorValidationContext,
): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = []
  for (const file of ['package.json', 'requirements.txt', 'docs/conf.py', 'docs/index.rst']) {
    if (!(await pathExists(join(context.root, file)))) {
      issues.push({
        severity: 'error',
        code: 'missing-generator-file',
        message: `Sphinx project is missing ${file}.`,
        file,
      })
    }
  }
  const indexPath = join(context.contentRoot, 'index.rst')
  if (!(await pathExists(indexPath))) return issues
  const navigation = new Set(['index'])
  const source = await readFile(indexPath, 'utf8')
  const lines = source.split(/\r?\n/)
  let inTree = false
  for (const line of lines) {
    if (/^\.\.\s+toctree::/.test(line)) {
      inTree = true
      continue
    }
    if (!inTree) continue
    if (line.trim() === '' || /^\s+:\w+/.test(line)) continue
    const item = line.match(/^\s{3,}(.+?)\s*$/)?.[1]
    if (!item) {
      inTree = false
      continue
    }
    const target = item.replace(/^.*<(.+)>$/, '$1').replace(/\.rst$/, '')
    if (!/^[a-z]+:\/\//i.test(target)) navigation.add(target)
  }
  for (const id of navigation) {
    if (!context.pageIds.includes(id)) {
      issues.push({
        severity: 'error',
        code: 'missing-page',
        message: `Sphinx toctree references missing page "${id}".`,
        file: relative(context.root, indexPath),
      })
    }
  }
  for (const id of context.pageIds) {
    if (!navigation.has(id)) {
      issues.push({
        severity: 'error',
        code: 'unnavigated-page',
        message: `Page "${id}" is not in the Sphinx toctree.`,
        file: `${id}.rst`,
      })
    }
  }
  return issues
}

async function readSphinxPage(path: string): Promise<GeneratorPage> {
  const raw = await readFile(path, 'utf8')
  const lines = raw.split(/\r?\n/)
  let title = ''
  for (let index = 0; index < lines.length - 1; index += 1) {
    const current = lines[index]?.trim() ?? ''
    const underline = lines[index + 1]?.trim() ?? ''
    if (current && /^[=~`^"'_*+#<>-]{3,}$/.test(underline)) {
      title = current
      break
    }
  }
  const description = raw.match(
    /^\s*:description:\s*(.+?)\s*$/m,
  )?.[1]?.trim()
  return description
    ? { title, description, body: raw }
    : { title, body: raw }
}
