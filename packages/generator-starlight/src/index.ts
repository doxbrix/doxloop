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

const PACKAGE_NAME = '@doxbrix/doxloop-generator-starlight'
const PACKAGE_VERSION = (
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    version: string
  }
).version

const adapter = defineGenerator({
  apiVersion: 1,
  id: 'starlight',
  displayName: 'Starlight',
  packageName: PACKAGE_NAME,
  packageVersion: PACKAGE_VERSION,
  authoring: {
    skillName: 'doxloop-starlight',
    skillDirectory: fileURLToPath(
      new URL('../skills/doxloop-starlight', import.meta.url),
    ),
  },
  project: {
    defaultContentDir: 'src/content/docs',
    pageExtensions: ['.md', '.mdx'],
    gitignore: ['dist/', '.astro/', 'node_modules/'],
    contentFormat: 'markdown' as const,
  },
  build: { command: 'npm run build', outputDir: 'dist' },
  scaffold: scaffoldStarlight,
  preview: startStarlightPreview,
  resolveLocalAsset({ root, reference }) {
    return resolvePublicAsset(root, 'public', reference)
  },
  validate: validateStarlight,
})

export default adapter

export function starlightPreviewInvocation(
  options: GeneratorPreviewOptions,
  command: string,
): { command: string; args: string[] } {
  return {
    command,
    args: [
      'dev',
      '--host',
      options.host,
      '--port',
      String(options.port),
    ],
  }
}

async function scaffoldStarlight(context: GeneratorScaffoldContext): Promise<void> {
  const { root, title, contentDir } = context
  await mkdir(join(root, contentDir), { recursive: true })
  await mkdir(join(root, 'src', 'styles'), { recursive: true })
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
      dev: 'astro dev',
      start: 'astro dev',
      build: 'astro build',
      preview: 'astro preview',
      'docs:test': 'doxloop test',
    },
    dependencies: {
      ...(isRecord(existing.dependencies) ? existing.dependencies : {}),
      '@astrojs/starlight': '0.41.3',
      astro: '7.1.1',
    },
    devDependencies: {
      ...(isRecord(existing.devDependencies) ? existing.devDependencies : {}),
      [context.corePackage.name]: `^${context.corePackage.version}`,
      [context.generatorPackage.name]: `^${context.generatorPackage.version}`,
    },
    engines: {
      ...(isRecord(existing.engines) ? existing.engines : {}),
      node: '>=22.12.0',
    },
  })
  await writeFile(
    join(root, 'astro.config.mjs'),
    `import { defineConfig } from 'astro/config'
import starlight from '@astrojs/starlight'

export default defineConfig({
  site: process.env.DOXLOOP_SITE_URL || 'https://example.com',
  integrations: [
    starlight({
      title: ${JSON.stringify(title)},
      description: ${JSON.stringify(`Documentation for ${title}.`)},
      customCss: ['./src/styles/custom.css'],
      sidebar: [
        {
          label: 'Get started',
          items: [
            { slug: 'index', label: 'Overview' },
            { slug: 'quickstart' },
          ],
        },
      ],
    }),
  ],
})
`,
    { encoding: 'utf8', flag: 'wx' },
  )
  await writeFile(
    join(root, 'src', 'content.config.ts'),
    `import { defineCollection } from 'astro:content'
import { docsLoader } from '@astrojs/starlight/loaders'
import { docsSchema } from '@astrojs/starlight/schema'

export const collections = {
  docs: defineCollection({ loader: docsLoader(), schema: docsSchema() }),
}
`,
    { encoding: 'utf8', flag: 'wx' },
  )
  await writeFile(
    join(root, 'src', 'styles', 'custom.css'),
    `:root {
  --sl-color-accent-low: #eef2ff;
  --sl-color-accent: #4f46e5;
  --sl-color-accent-high: #312e81;
}
`,
    { encoding: 'utf8', flag: 'wx' },
  )
  await writeJsonFile(join(root, 'tsconfig.json'), {
    extends: 'astro/tsconfigs/strict',
  })
  await writeFile(
    join(root, contentDir, 'index.md'),
    `---
title: ${JSON.stringify(title)}
description: "Understand what ${title} helps you accomplish and choose your first workflow."
template: splash
hero:
  tagline: "Evidence-backed documentation for ${title}."
---

<!-- doxloop:starter-page -->

:::note
The authoring agent will replace this starter with an evidence-backed product overview.
:::

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

async function startStarlightPreview(options: GeneratorPreviewOptions): Promise<void> {
  const binary = await ensureNodeDependencies(options.root, 'astro', 'Starlight')
  const invocation = starlightPreviewInvocation(options, binary)
  const url = `http://${shownHost(options.host)}:${options.port}`
  process.stdout.write(`Starting Starlight preview at ${url}\n`)
  if (options.open) setTimeout(() => void openBrowser(url), 800)
  await runPreviewProcess(
    invocation.command,
    invocation.args,
    options.root,
    'Starlight',
  )
}

async function validateStarlight(
  context: GeneratorValidationContext,
): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = []
  for (const file of [
    'package.json',
    'astro.config.mjs',
    'src/content.config.ts',
    'tsconfig.json',
  ]) {
    if (!(await pathExists(join(context.root, file)))) {
      issues.push({
        severity: 'error',
        code: 'missing-generator-file',
        message: `Starlight project is missing ${file}.`,
        file,
      })
    }
  }
  const configPath = join(context.root, 'astro.config.mjs')
  if (!(await pathExists(configPath))) return issues
  const source = await readFile(configPath, 'utf8')
  const navigation = new Set<string>()
  for (const match of source.matchAll(/\bslug\s*:\s*["']([^"']+)["']/g)) {
    if (match[1]) navigation.add(match[1])
  }
  for (const id of navigation) {
    if (!context.pageIds.includes(id)) {
      issues.push({
        severity: 'error',
        code: 'missing-page',
        message: `Starlight sidebar references missing page "${id}".`,
        file: 'astro.config.mjs',
      })
    }
  }
  for (const id of context.pageIds) {
    if (!navigation.has(id)) {
      issues.push({
        severity: 'error',
        code: 'unnavigated-page',
        message: `Page "${id}" is not in the Starlight sidebar.`,
        file: `${id}.md`,
      })
    }
  }
  return issues
}
