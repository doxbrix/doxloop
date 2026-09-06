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
  contentRelativePages,
  ensureNodeDependencies,
  isRecord,
  navigationUnverifiedIssue,
  nodeBinary,
  nodeInstallInvocation,
  pathExists,
  readPackageJson,
  resolvePublicAsset,
  runPreviewProcess,
  shownHost,
  slugFromTitle,
  writeJsonFile,
} from '@doxbrix/doxloop/generator-runtime'

const PACKAGE_NAME = '@doxbrix/doxloop-generator-docusaurus'
const PACKAGE_VERSION = (
  JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  ) as { version: string }
).version
const DOCUSAURUS_VERSION = '3.10.2'

const adapter = defineGenerator({
  apiVersion: 1,
  id: 'docusaurus',
  displayName: 'Docusaurus',
  packageName: PACKAGE_NAME,
  packageVersion: PACKAGE_VERSION,
  authoring: {
    skillName: 'doxloop-docusaurus',
    skillDirectory: fileURLToPath(
      new URL('../skills/doxloop-docusaurus', import.meta.url),
    ),
  },
  planning: { navigationFiles: ['sidebars.js', 'docusaurus.config.js'] },
  project: {
    defaultContentDir: 'docs',
    pageExtensions: ['.md', '.mdx'],
    gitignore: ['node_modules/', 'build/', '.docusaurus/'],
    contentFormat: 'markdown' as const,
  },
  build: {
    command: 'npm run build',
    outputDir: 'build',
  },
  scaffold: scaffoldDocusaurus,
  preview: startDocusaurusPreview,
  resolveLocalAsset({ root, reference }) {
    return resolvePublicAsset(root, 'static', reference)
  },
  validate: validateDocusaurus,
})

export default adapter

export function docusaurusPreviewInvocation(options: GeneratorPreviewOptions): {
  command: string
  args: string[]
} {
  return {
    command: nodeBinary(options.root, 'docusaurus'),
    args: [
      'start',
      '--host',
      options.host,
      '--port',
      String(options.port),
      ...(options.open ? [] : ['--no-open']),
    ],
  }
}

export async function docusaurusInstallInvocation(root: string): Promise<{
  command: string
  args: string[]
}> {
  return nodeInstallInvocation(root)
}

async function scaffoldDocusaurus(context: GeneratorScaffoldContext): Promise<void> {
  const { root, title, contentDir } = context
  await mkdir(join(root, contentDir), { recursive: true })
  await mkdir(join(root, 'src', 'css'), { recursive: true })
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
      docusaurus: 'docusaurus',
      start: 'docusaurus start',
      build: 'docusaurus build',
      serve: 'docusaurus serve',
      'docs:test': 'doxloop test',
    },
    dependencies: {
      ...(isRecord(existing.dependencies) ? existing.dependencies : {}),
      '@docusaurus/core': DOCUSAURUS_VERSION,
      '@docusaurus/faster': DOCUSAURUS_VERSION,
      '@docusaurus/preset-classic': DOCUSAURUS_VERSION,
      '@docusaurus/theme-mermaid': DOCUSAURUS_VERSION,
      // theme-mermaid 3.10 imports the ELK layout unconditionally, so the build needs it present.
      '@mermaid-js/layout-elk': '^0.1.9',
      '@mdx-js/react': '^3.0.0',
      clsx: '^2.1.1',
      'prism-react-renderer': '^2.4.1',
      react: '^19.0.0',
      'react-dom': '^19.0.0',
    },
    devDependencies: {
      ...(isRecord(existing.devDependencies) ? existing.devDependencies : {}),
      [context.corePackage.name]: `^${context.corePackage.version}`,
      [context.generatorPackage.name]: `^${context.generatorPackage.version}`,
      '@docusaurus/module-type-aliases': DOCUSAURUS_VERSION,
      '@docusaurus/types': DOCUSAURUS_VERSION,
    },
    engines: {
      ...(isRecord(existing.engines) ? existing.engines : {}),
      node: '>=20.0',
    },
  })
  await writeFile(
    join(root, 'docusaurus.config.js'),
    `export default {
  title: ${JSON.stringify(title)},
  tagline: ${JSON.stringify(`Documentation for ${title}.`)},
  url: process.env.DOXLOOP_SITE_URL || 'https://example.com',
  baseUrl: '/',
  onBrokenLinks: 'throw',
  markdown: {
    mermaid: true,
  },
  themes: ['@docusaurus/theme-mermaid'],
  presets: [
    [
      'classic',
      {
        docs: {
          sidebarPath: './sidebars.js',
          routeBasePath: '/',
        },
        blog: false,
        theme: {
          customCss: './src/css/custom.css',
        },
      },
    ],
  ],
  themeConfig: {
    navbar: {
      title: ${JSON.stringify(title)},
    },
    docs: {
      sidebar: {
        hideable: true,
      },
    },
  },
}
`,
    { encoding: 'utf8', flag: 'wx' },
  )
  await writeFile(
    join(root, 'sidebars.js'),
    `export default {
  docs: [{ type: 'autogenerated', dirName: '.' }],
}
`,
    { encoding: 'utf8', flag: 'wx' },
  )
  await writeFile(
    join(root, 'src', 'css', 'custom.css'),
    `:root {
  --ifm-color-primary: #4f46e5;
  --ifm-color-primary-dark: #4338ca;
  --ifm-color-primary-light: #6366f1;
  --ifm-code-font-size: 95%;
}
`,
    { encoding: 'utf8', flag: 'wx' },
  )
  await writeFile(
    join(root, contentDir, 'index.md'),
    `---
title: ${JSON.stringify(title)}
description: "Understand what ${title} helps you accomplish and choose your first workflow."
slug: /
sidebar_position: 1
---

# ${title}

<!-- doxloop:starter-page -->

:::info

The authoring agent will replace this starter with an evidence-backed product overview.

:::

[Follow the quickstart](./quickstart.md) to reach your first successful result.
`,
    { encoding: 'utf8', flag: 'wx' },
  )
  await writeFile(
    join(root, contentDir, 'quickstart.md'),
    `---
title: "Quickstart"
description: "Reach your first successful result with verified product instructions."
sidebar_position: 2
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

async function startDocusaurusPreview(options: GeneratorPreviewOptions): Promise<void> {
  await ensureNodeDependencies(options.root, 'docusaurus', 'Docusaurus')
  const invocation = docusaurusPreviewInvocation(options)
  process.stdout.write(
    `Starting Docusaurus preview at http://${shownHost(options.host)}:${options.port}\n`,
  )
  await runPreviewProcess(
    invocation.command,
    invocation.args,
    options.root,
    'Docusaurus',
  )
}

/**
 * Docusaurus sidebars are JavaScript, so this reads the common literal forms
 * and reports what it cannot follow instead of guessing. A sidebar that
 * autogenerates from a directory covers every page under it; any sidebar built
 * by code or imported from another module is left to the strict build.
 */
async function validateDocusaurus(
  context: GeneratorValidationContext,
): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = []
  for (const file of ['package.json', 'docusaurus.config.js', 'sidebars.js']) {
    if (!(await pathExists(join(context.root, file)))) {
      issues.push({
        severity: 'error',
        code: 'missing-generator-file',
        message: `Docusaurus project is missing ${file}.`,
        file,
      })
    }
  }
  const sidebarPath = join(context.root, 'sidebars.js')
  if (!(await pathExists(sidebarPath))) return issues
  const source = await readFile(sidebarPath, 'utf8')
  const sidebar = readDocusaurusSidebar(source)
  if (sidebar.unverified) {
    issues.push(navigationUnverifiedIssue('Docusaurus', 'sidebars.js', sidebar.unverified))
    return issues
  }
  const pagesById = new Map(
    contentRelativePages(context.contentRoot, context.pages).map((page) => [
      page.replace(/\.(?:md|mdx)$/i, ''),
      page,
    ]),
  )
  for (const id of sidebar.docIds) {
    if (!pagesById.has(id)) {
      issues.push({
        severity: 'error',
        code: 'missing-page',
        message: `Docusaurus sidebar references missing doc "${id}".`,
        file: 'sidebars.js',
      })
    }
  }
  if (sidebar.autogenerated.length === 0) {
    for (const [id, page] of pagesById) {
      if (!sidebar.docIds.has(id)) {
        issues.push({
          severity: 'error',
          code: 'unnavigated-page',
          message: `Page "${id}" is not in any Docusaurus sidebar.`,
          file: `${context.project.contentDir}/${page}`,
        })
      }
    }
  }
  return issues
}

export function readDocusaurusSidebar(source: string): {
  docIds: Set<string>
  autogenerated: string[]
  unverified?: string
} {
  const docIds = new Set<string>()
  const autogenerated: string[] = []
  const body = source.replace(/\/\*[\s\S]*?\*\/|(^|[^:])\/\/.*$/gm, '$1')
  if (/^\s*(?:import|const|let|var)\s[\s\S]*?require\(|^\s*import\s/m.test(body)) {
    return { docIds, autogenerated, unverified: 'sidebars.js imports other modules.' }
  }
  if (/\b(?:function|=>|\.map\(|\.filter\(|\.concat\(|\.\.\.)/.test(body)) {
    return { docIds, autogenerated, unverified: 'sidebars.js builds its entries with code.' }
  }
  for (const match of body.matchAll(/\bdirName\s*:\s*['"]([^'"]*)['"]/g)) {
    autogenerated.push(match[1] ?? '.')
  }
  for (const match of body.matchAll(/\btype\s*:\s*['"]doc['"][^}]*?\bid\s*:\s*['"]([^'"]+)['"]/g)) {
    if (match[1]) docIds.add(match[1])
  }
  for (const match of body.matchAll(/\bid\s*:\s*['"]([^'"]+)['"][^}]*?\btype\s*:\s*['"]doc['"]/g)) {
    if (match[1]) docIds.add(match[1])
  }
  // Bare string items inside arrays are doc ids: ['intro', 'guides/install'].
  for (const match of body.matchAll(/(?:\[|,)\s*['"]([A-Za-z0-9][\w./-]*)['"]\s*(?=,|\])/g)) {
    if (match[1]) docIds.add(match[1])
  }
  return { docIds, autogenerated }
}
