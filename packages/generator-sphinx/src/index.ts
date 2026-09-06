import { readFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, posix, relative } from 'node:path'
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
  navigationUnverifiedIssue,
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
  planning: { navigationFiles: ['docs/index.rst', 'docs/conf.py'] },
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
    'Sphinx==9.1.0\nfuro==2025.12.19\nsphinx-autobuild==2025.8.25\nsphinxcontrib-mermaid==1.0.0\n',
    { encoding: 'utf8', flag: 'wx' },
  )
  await writeFile(
    join(root, contentDir, 'conf.py'),
    `project = ${JSON.stringify(title)}
author = ${JSON.stringify(title)}
language = "en"
extensions = ["sphinxcontrib.mermaid"]
exclude_patterns = ["_build"]
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

.. doxloop:starter-page

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

.. doxloop:starter-page

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

/**
 * Follows every toctree from the root document, so pages listed by a nested
 * index count as navigated. Glob entries are expanded against the real page
 * list; anything the reader cannot expand statically (autosummary-generated
 * pages, includes) is reported as unverified rather than as a missing page.
 */
async function validateSphinx(
  context: GeneratorValidationContext,
): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = []
  const contentDir = relative(context.root, context.contentRoot).split('\\').join('/') || '.'
  for (const file of ['package.json', 'requirements.txt', `${contentDir}/conf.py`]) {
    if (!(await pathExists(join(context.root, file)))) {
      issues.push({
        severity: 'error',
        code: 'missing-generator-file',
        message: `Sphinx project is missing ${file}.`,
        file,
      })
    }
  }
  const rootDoc = await sphinxRootDocument(context.contentRoot)
  const indexPath = join(context.contentRoot, `${rootDoc}.rst`)
  if (!(await pathExists(indexPath))) {
    issues.push({
      severity: 'error',
      code: 'missing-generator-file',
      message: `Sphinx project is missing ${contentDir}/${rootDoc}.rst.`,
      file: `${contentDir}/${rootDoc}.rst`,
    })
    return issues
  }
  const pageIds = new Set(context.pageIds)
  const navigation = new Set<string>([rootDoc])
  const missing = new Map<string, string>()
  const queue = [rootDoc]
  let unverified: string | undefined
  while (queue.length > 0) {
    const doc = queue.shift()!
    const path = join(context.contentRoot, `${doc}.rst`)
    if (!(await pathExists(path))) continue
    const source = await readFile(path, 'utf8')
    if (/^\.\.\s+(?:autosummary|automodapi)::/m.test(source) && /^\s+:toctree:/m.test(source)) {
      unverified ??= `${doc}.rst generates pages with autosummary.`
    }
    if (/^\.\.\s+include::/m.test(source)) {
      unverified ??= `${doc}.rst includes other files.`
    }
    for (const tree of readToctrees(source)) {
      for (const entry of tree.entries) {
        if (entry === 'self') continue
        if (tree.glob) {
          const pattern = resolveDocReference(doc, entry)
          const matcher = globMatcher(pattern)
          for (const id of pageIds) {
            if (matcher.test(id) && !navigation.has(id)) {
              navigation.add(id)
              queue.push(id)
            }
          }
          continue
        }
        const target = resolveDocReference(doc, entry)
        if (navigation.has(target)) continue
        if (pageIds.has(target)) {
          navigation.add(target)
          queue.push(target)
        } else {
          missing.set(target, `${contentDir}/${doc}.rst`)
        }
      }
    }
  }
  for (const [id, file] of missing) {
    issues.push({
      severity: 'error',
      code: 'missing-page',
      message: `Sphinx toctree references missing page "${id}".`,
      file,
    })
  }
  if (unverified) {
    issues.push(navigationUnverifiedIssue('Sphinx', `${contentDir}/${rootDoc}.rst`, unverified))
    return issues
  }
  for (const id of context.pageIds) {
    if (!navigation.has(id)) {
      issues.push({
        severity: 'error',
        code: 'unnavigated-page',
        message: `Page "${id}" is not reachable from any Sphinx toctree.`,
        file: `${contentDir}/${id}.rst`,
      })
    }
  }
  return issues
}

async function sphinxRootDocument(contentRoot: string): Promise<string> {
  const confPath = join(contentRoot, 'conf.py')
  if (!(await pathExists(confPath))) return 'index'
  const conf = await readFile(confPath, 'utf8')
  const match = conf.match(/^\s*(?:root_doc|master_doc)\s*=\s*["']([^"']+)["']/m)
  return match?.[1] ?? 'index'
}

export function readToctrees(source: string): Array<{ glob: boolean; entries: string[] }> {
  const trees: Array<{ glob: boolean; entries: string[] }> = []
  const lines = source.split(/\r?\n/)
  let current: { glob: boolean; entries: string[] } | undefined
  let indent = 0
  for (const line of lines) {
    if (/^\s*\.\.\s+toctree::/.test(line)) {
      current = { glob: false, entries: [] }
      trees.push(current)
      indent = 0
      continue
    }
    if (!current) continue
    if (line.trim() === '') continue
    const option = line.match(/^\s+:(\w+):/)
    if (option) {
      if (option[1] === 'glob') current.glob = true
      continue
    }
    const item = line.match(/^(\s+)(\S.*?)\s*$/)
    if (!item || (indent > 0 && item[1]!.length < indent)) {
      current = undefined
      continue
    }
    indent ||= item[1]!.length
    const text = item[2]!
    const target = text.replace(/^.*<(.+)>$/, '$1').replace(/\.rst$/, '')
    if (!/^[a-z]+:\/\//i.test(target)) current.entries.push(target)
  }
  return trees
}

function resolveDocReference(fromDoc: string, target: string): string {
  if (target.startsWith('/')) return target.replace(/^\/+/, '')
  const base = posix.dirname(fromDoc.split('\\').join('/'))
  return posix.normalize(posix.join(base === '.' ? '' : base, target)).replace(/^\.\//, '')
}

function globMatcher(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\u0000/g, '.*')
  return new RegExp(`^${escaped}$`)
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
