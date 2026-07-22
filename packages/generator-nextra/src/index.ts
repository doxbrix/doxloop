import { readFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  defineGenerator,
  type GeneratorPreviewOptions,
  type GeneratorScaffoldContext,
  type GeneratorValidationContext,
  type ValidationIssue,
} from '@doxbrix/doxloop/generator-api'
import {
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

async function validateNextra(
  context: GeneratorValidationContext,
): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = []
  const metaFile = join(context.project.contentDir, '_meta.js')
  for (const file of [
    'package.json',
    'next.config.mjs',
    'mdx-components.jsx',
    'app/layout.jsx',
    'app/not-found.jsx',
    'app/[[...mdxPath]]/page.jsx',
    metaFile,
  ]) {
    if (!(await pathExists(join(context.root, file)))) {
      issues.push({
        severity: 'error',
        code: 'missing-generator-file',
        message: `Nextra project is missing ${file}.`,
        file,
      })
    }
  }
  const metaPath = join(context.root, metaFile)
  if (!(await pathExists(metaPath))) return issues
  const source = await readFile(metaPath, 'utf8')
  const navigation = new Set<string>()
  for (const match of source.matchAll(/^\s*([A-Za-z][\w-]*)\s*:/gm)) {
    if (match[1]) navigation.add(match[1])
  }
  for (const id of navigation) {
    if (!context.pageIds.includes(id)) {
      issues.push({
        severity: 'error',
        code: 'missing-page',
        message: `Nextra _meta.js references missing page "${id}".`,
        file: metaFile,
      })
    }
  }
  for (const id of context.pageIds) {
    if (!navigation.has(id)) {
      issues.push({
        severity: 'error',
        code: 'unnavigated-page',
        message: `Page "${id}" is not in Nextra _meta.js.`,
        file: `${id}.mdx`,
      })
    }
  }
  return issues
}

function escapeJsx(value: string): string {
  return value.replace(/[<>{}]/g, '')
}

function escapeTemplate(value: string): string {
  return value.replaceAll('`', '')
}
