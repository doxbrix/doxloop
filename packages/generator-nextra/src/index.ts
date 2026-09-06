import { readFileSync } from 'node:fs'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join, posix } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  defineGenerator,
  type GeneratorPreviewOptions,
  type GeneratorScaffoldContext,
  type GeneratorValidationContext,
  type ValidationIssue,
} from '@doxbrix/doxloop/generator-api'
import {
  contentRelativePages,
  ensureNodeDependencies,
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

const PACKAGE_NAME = '@doxbrix/doxloop-generator-nextra'
const PACKAGE_VERSION = (
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    version: string
  }
).version
const META_FILES = ['_meta.js', '_meta.jsx', '_meta.ts', '_meta.tsx', '_meta.json']

const adapter = defineGenerator({
  apiVersion: 1,
  id: 'nextra',
  displayName: 'Nextra',
  packageName: PACKAGE_NAME,
  packageVersion: PACKAGE_VERSION,
  authoring: {
    skillName: 'doxloop-nextra',
    skillDirectory: fileURLToPath(new URL('../skills/doxloop-nextra', import.meta.url)),
  },
  planning: { navigationFiles: ['content/_meta.js', 'app/layout.jsx'] },
  project: {
    defaultContentDir: 'content',
    pageExtensions: ['.md', '.mdx'],
    gitignore: ['.next/', 'out/', 'node_modules/'],
    contentFormat: 'markdown' as const,
  },
  build: { command: 'npm run build', outputDir: 'out' },
  scaffold: scaffoldNextra,
  preview: startNextraPreview,
  resolveLocalAsset({ root, reference }) {
    return resolvePublicAsset(root, 'public', reference)
  },
  validate: validateNextra,
})

export default adapter

export function nextraPreviewInvocation(
  options: GeneratorPreviewOptions,
  command: string,
): { command: string; args: string[] } {
  return {
    command,
    args: [
      'dev',
      '--hostname',
      options.host,
      '--port',
      String(options.port),
    ],
  }
}

async function scaffoldNextra(context: GeneratorScaffoldContext): Promise<void> {
  const { root, title, contentDir } = context
  await mkdir(join(root, contentDir), { recursive: true })
  await mkdir(join(root, 'app', '[[...mdxPath]]'), { recursive: true })
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
      dev: 'next dev',
      build: 'next build',
      start: 'next start',
      'docs:test': 'doxloop test',
    },
    dependencies: {
      ...(isRecord(existing.dependencies) ? existing.dependencies : {}),
      next: '16.2.10',
      nextra: '4.6.0',
      'nextra-theme-docs': '4.6.0',
      react: '19.2.7',
      'react-dom': '19.2.7',
    },
    devDependencies: {
      ...(isRecord(existing.devDependencies) ? existing.devDependencies : {}),
      [context.corePackage.name]: `^${context.corePackage.version}`,
      [context.generatorPackage.name]: `^${context.generatorPackage.version}`,
    },
    engines: {
      ...(isRecord(existing.engines) ? existing.engines : {}),
      node: '>=20.9.0',
    },
  })
  await writeFile(
    join(root, 'next.config.mjs'),
    `import nextra from 'nextra'

const withNextra = nextra({})

export default withNextra({
  output: 'export',
  images: { unoptimized: true },
})
`,
    { encoding: 'utf8', flag: 'wx' },
  )
  await writeFile(
    join(root, 'mdx-components.jsx'),
    `import { useMDXComponents as getThemeComponents } from 'nextra-theme-docs'

const themeComponents = getThemeComponents()

export function useMDXComponents(components) {
  return { ...themeComponents, ...components }
}
`,
    { encoding: 'utf8', flag: 'wx' },
  )
  await writeFile(
    join(root, 'app', 'layout.jsx'),
    `import { Footer, Layout, Navbar } from 'nextra-theme-docs'
import { Head } from 'nextra/components'
import { getPageMap } from 'nextra/page-map'
import 'nextra-theme-docs/style.css'

export const metadata = {
  title: { default: ${JSON.stringify(title)}, template: \`%s · ${escapeTemplate(title)}\` },
  description: ${JSON.stringify(`Documentation for ${title}.`)},
}

const navbar = <Navbar logo={<b>${escapeJsx(title)}</b>} />
const footer = <Footer>{new Date().getFullYear()} © ${escapeJsx(title)}</Footer>

export default async function RootLayout({ children }) {
  return (
    <html lang="en" dir="ltr" suppressHydrationWarning>
        <Head>
          <meta name="theme-color" content="#ffffff" />
        </Head>
      <body>
        <Layout
          navbar={navbar}
          pageMap={await getPageMap()}
          docsRepositoryBase="https://example.com/docs"
          footer={footer}
        >
          {children}
        </Layout>
      </body>
    </html>
  )
}
`,
    { encoding: 'utf8', flag: 'wx' },
  )
  await writeFile(
    join(root, 'app', '[[...mdxPath]]', 'page.jsx'),
    `import { generateStaticParamsFor, importPage } from 'nextra/pages'
import { useMDXComponents as getMDXComponents } from '../../mdx-components'

export const generateStaticParams = generateStaticParamsFor('mdxPath')

export async function generateMetadata(props) {
  const params = await props.params
  const { metadata } = await importPage(params.mdxPath)
  return metadata
}

const Wrapper = getMDXComponents().wrapper

export default async function Page(props) {
  const params = await props.params
  const { default: MDXContent, toc, metadata, sourceCode } = await importPage(params.mdxPath)
  return (
    <Wrapper toc={toc} metadata={metadata} sourceCode={sourceCode}>
      <MDXContent {...props} params={params} />
    </Wrapper>
  )
}
`,
    { encoding: 'utf8', flag: 'wx' },
  )
  await writeFile(
    join(root, 'app', 'not-found.jsx'),
    `import { NotFoundPage } from 'nextra-theme-docs'

export default function NotFound() {
  return (
    <NotFoundPage content="Return to the documentation">
      <h1>Page not found</h1>
    </NotFoundPage>
  )
}
`,
    { encoding: 'utf8', flag: 'wx' },
  )
  await writeFile(
    join(root, contentDir, '_meta.js'),
    `export default {
  index: ${JSON.stringify(title)},
  quickstart: 'Quickstart',
}
`,
    { encoding: 'utf8', flag: 'wx' },
  )
  await writeFile(
    join(root, contentDir, 'index.mdx'),
    `---
title: ${JSON.stringify(title)}
description: "Understand what ${title} helps you accomplish and choose your first workflow."
---

# ${title}

{/* doxloop:starter-page */}

> [!NOTE]
> The authoring agent will replace this starter with an evidence-backed product overview.

[Follow the quickstart](/quickstart) to reach your first successful result.
`,
    { encoding: 'utf8', flag: 'wx' },
  )
  await writeFile(
    join(root, contentDir, 'quickstart.mdx'),
    `---
title: "Quickstart"
description: "Reach your first successful result with verified product instructions."
---

# Quickstart

{/* doxloop:starter-page */}

1. Confirm prerequisites from the configured product source.
2. Complete the first supported workflow.
3. Verify the observable result.
`,
    { encoding: 'utf8', flag: 'wx' },
  )
}

async function startNextraPreview(options: GeneratorPreviewOptions): Promise<void> {
  const binary = await ensureNodeDependencies(options.root, 'next', 'Nextra')
  const invocation = nextraPreviewInvocation(options, binary)
  const url = `http://${shownHost(options.host)}:${options.port}`
  process.stdout.write(`Starting Nextra preview at ${url}\n`)
  if (options.open) setTimeout(() => void openBrowser(url), 1200)
  await runPreviewProcess(invocation.command, invocation.args, options.root, 'Nextra')
}

/**
 * Nextra builds its page map from every file under the content directory, so
 * no page can be "unnavigated". What can go wrong is a `_meta` file naming a
 * page or folder that does not exist beside it, in any directory.
 */
async function validateNextra(
  context: GeneratorValidationContext,
): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = []
  for (const [label, candidates] of [
    ['package.json', ['package.json']],
    ['next.config.mjs', ['next.config.mjs', 'next.config.js', 'next.config.ts', 'next.config.mts']],
    ['mdx-components.jsx', ['mdx-components.jsx', 'mdx-components.js', 'mdx-components.tsx', 'mdx-components.ts']],
    ['app/layout.jsx', ['app/layout.jsx', 'app/layout.js', 'app/layout.tsx', 'src/app/layout.jsx', 'src/app/layout.tsx']],
    ['app/[[...mdxPath]]/page.jsx', ['app/[[...mdxPath]]/page.jsx', 'app/[[...mdxPath]]/page.js', 'app/[[...mdxPath]]/page.tsx', 'src/app/[[...mdxPath]]/page.jsx', 'src/app/[[...mdxPath]]/page.tsx']],
  ] as const) {
    let found = false
    for (const candidate of candidates) {
      if (await pathExists(join(context.root, candidate))) {
        found = true
        break
      }
    }
    if (!found) {
      issues.push({
        severity: 'error',
        code: 'missing-generator-file',
        message: `Nextra project is missing ${label}.`,
        file: label,
      })
    }
  }
  const pages = contentRelativePages(context.contentRoot, context.pages)
  const pageIds = new Set(pages.map((page) => page.replace(/\.(?:md|mdx)$/i, '')))
  const directories = new Set<string>(['.'])
  for (const id of pageIds) {
    let directory = posix.dirname(id)
    while (directory !== '.') {
      directories.add(directory)
      directory = posix.dirname(directory)
    }
  }
  for (const directory of directories) {
    const absoluteDirectory = directory === '.' ? context.contentRoot : join(context.contentRoot, directory)
    const metaFile = await findMetaFile(absoluteDirectory)
    if (!metaFile) continue
    const metaPath = posix.join(context.project.contentDir.split('\\').join('/'), directory === '.' ? metaFile : `${directory}/${metaFile}`)
    const source = await readFile(join(absoluteDirectory, metaFile), 'utf8')
    for (const key of readNextraMetaKeys(source, metaFile.endsWith('.json'))) {
      const target = directory === '.' ? key : `${directory}/${key}`
      if (pageIds.has(target) || directories.has(target)) continue
      issues.push({
        severity: 'error',
        code: 'missing-page',
        message: `Nextra ${metaFile} references missing page "${target}".`,
        file: metaPath,
      })
    }
  }
  return issues
}

async function findMetaFile(directory: string): Promise<string | undefined> {
  let entries: string[]
  try {
    entries = await readdir(directory)
  } catch {
    return undefined
  }
  return META_FILES.find((name) => entries.includes(name))
}

/**
 * Top-level keys of a `_meta` object that name pages or folders. Entries with
 * an `href`, separators, and menus are navigation chrome and are skipped, as
 * is the `*` default entry.
 */
export function readNextraMetaKeys(source: string, json: boolean): string[] {
  const keys: string[] = []
  const body = json ? source : source.replace(/\/\*[\s\S]*?\*\/|(^|[^:'"])\/\/.*$/gm, '$1')
  const start = body.indexOf('{')
  if (start === -1) return keys
  let depth = 0
  let quote: string | undefined
  let current: { key: string; from: number } | undefined
  const finish = (end: number): void => {
    if (!current) return
    const value = body.slice(current.from, end)
    const chrome = /\bhref\s*:|["']?type["']?\s*:\s*["'](?:separator|menu)["']/.test(value)
    if (!chrome && current.key !== '*' && /^[A-Za-z0-9][\w.-]*$/.test(current.key)) keys.push(current.key)
    current = undefined
  }
  for (let index = start; index < body.length; index += 1) {
    const character = body[index]!
    if (quote) {
      if (character === '\\') index += 1
      else if (character === quote) quote = undefined
      continue
    }
    if (character === '"' || character === "'" || character === '`') {
      if (depth === 1 && !current) {
        const end = body.indexOf(character, index + 1)
        const rest = body.slice(end + 1).match(/^\s*:/)
        if (end !== -1 && rest) {
          current = { key: body.slice(index + 1, end), from: end + 1 + rest[0].length }
          index = end + rest[0].length
          continue
        }
      }
      quote = character
      continue
    }
    if (character === '{' || character === '[' || character === '(') {
      depth += 1
      continue
    }
    if (character === '}' || character === ']' || character === ')') {
      if (depth === 1) finish(index)
      depth -= 1
      if (depth === 0) break
      continue
    }
    if (depth === 1 && character === ',') {
      finish(index)
      continue
    }
    if (depth === 1 && !current && /[A-Za-z_$]/.test(character)) {
      const match = body.slice(index).match(/^([A-Za-z_$][\w$-]*)\s*:/)
      if (match) {
        current = { key: match[1]!, from: index + match[0].length }
        index += match[0].length - 1
      }
    }
  }
  return keys
}

function escapeJsx(value: string): string {
  return value.replace(/[<>{}]/g, '')
}

function escapeTemplate(value: string): string {
  return value.replaceAll('`', '')
}
