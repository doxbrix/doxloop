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

const PACKAGE_NAME = '@doxbrix/doxloop-generator-vitepress'
const PACKAGE_VERSION = (
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    version: string
  }
).version

const adapter = defineGenerator({
  apiVersion: 1,
  id: 'vitepress',
  displayName: 'VitePress',
  packageName: PACKAGE_NAME,
  packageVersion: PACKAGE_VERSION,
  authoring: {
    skillName: 'doxloop-vitepress',
    skillDirectory: fileURLToPath(
      new URL('../skills/doxloop-vitepress', import.meta.url),
    ),
  },
  planning: { navigationFiles: ['docs/.vitepress/config.mts'] },
  project: {
    defaultContentDir: 'docs',
    pageExtensions: ['.md'],
    gitignore: ['docs/.vitepress/cache/', 'docs/.vitepress/dist/', 'node_modules/'],
    contentFormat: 'markdown' as const,
  },
  build: { command: 'npm run docs:build', outputDir: 'docs/.vitepress/dist' },
  scaffold: scaffoldVitePress,
  preview: startVitePressPreview,
  resolveLocalAsset({ contentRoot, reference }) {
    return resolvePublicAsset(contentRoot, 'public', reference)
  },
  validate: validateVitePress,
})

export default adapter

export function vitePressPreviewInvocation(
  options: GeneratorPreviewOptions,
  command: string,
): { command: string; args: string[] } {
  return {
    command,
    args: [
      'dev',
      'docs',
      '--host',
      options.host,
      '--port',
      String(options.port),
      '--strictPort',
    ],
  }
}

async function scaffoldVitePress(context: GeneratorScaffoldContext): Promise<void> {
  const { root, title, contentDir } = context
  await mkdir(join(root, contentDir, '.vitepress', 'theme'), { recursive: true })
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
      'docs:dev': 'vitepress dev docs',
      'docs:build': 'vitepress build docs',
      'docs:preview': 'vitepress preview docs',
      'docs:test': 'doxloop test',
    },
    devDependencies: {
      ...(isRecord(existing.devDependencies) ? existing.devDependencies : {}),
      [context.corePackage.name]: `^${context.corePackage.version}`,
      [context.generatorPackage.name]: `^${context.generatorPackage.version}`,
      vitepress: '1.6.4',
      vue: '3.5.28',
    },
    engines: {
      ...(isRecord(existing.engines) ? existing.engines : {}),
      node: '>=20.12.0',
    },
  })
  await writeFile(
    join(root, contentDir, '.vitepress', 'config.mts'),
    `import { defineConfig } from 'vitepress'

export default defineConfig({
  title: ${JSON.stringify(title)},
  description: ${JSON.stringify(`Documentation for ${title}.`)},
  cleanUrls: true,
  themeConfig: {
    nav: [{ text: 'Documentation', link: '/' }],
    sidebar: [
      {
        text: 'Get started',
        items: [
          { text: 'Overview', link: '/' },
          { text: 'Quickstart', link: '/quickstart' },
        ],
      },
    ],
    search: { provider: 'local' },
  },
})
`,
    { encoding: 'utf8', flag: 'wx' },
  )
  await writeFile(
    join(root, contentDir, '.vitepress', 'theme', 'index.ts'),
    `import DefaultTheme from 'vitepress/theme'
import './custom.css'

export default DefaultTheme
`,
    { encoding: 'utf8', flag: 'wx' },
  )
  await writeFile(
    join(root, contentDir, '.vitepress', 'theme', 'custom.css'),
    `:root {
  --vp-c-brand-1: #4f46e5;
  --vp-c-brand-2: #4338ca;
  --vp-c-brand-3: #3730a3;
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

::: info
The authoring agent will replace this starter with an evidence-backed product overview.
:::

[Follow the quickstart](/quickstart) to reach your first successful result.
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

async function startVitePressPreview(options: GeneratorPreviewOptions): Promise<void> {
  const binary = await ensureNodeDependencies(options.root, 'vitepress', 'VitePress')
  const invocation = vitePressPreviewInvocation(options, binary)
  const url = `http://${shownHost(options.host)}:${options.port}`
  process.stdout.write(`Starting VitePress preview at ${url}\n`)
  if (options.open) setTimeout(() => void openBrowser(url), 800)
  await runPreviewProcess(
    invocation.command,
    invocation.args,
    options.root,
    'VitePress',
  )
}

async function validateVitePress(
  context: GeneratorValidationContext,
): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = []
  const configFile = join(context.project.contentDir, '.vitepress', 'config.mts')
  for (const file of ['package.json', configFile]) {
    if (!(await pathExists(join(context.root, file)))) {
      issues.push({
        severity: 'error',
        code: 'missing-generator-file',
        message: `VitePress project is missing ${file}.`,
        file,
      })
    }
  }
  const configPath = join(context.root, configFile)
  if (!(await pathExists(configPath))) return issues
  const source = await readFile(configPath, 'utf8')
  const navigation = new Set<string>()
  for (const match of source.matchAll(/\blink\s*:\s*["']([^"']+)["']/g)) {
    const link = match[1]
    if (!link || /^[a-z]+:\/\//i.test(link)) continue
    navigation.add(link === '/' ? 'index' : link.replace(/^\/|\/$/g, ''))
  }
  for (const id of navigation) {
    if (!context.pageIds.includes(id)) {
      issues.push({
        severity: 'error',
        code: 'missing-page',
        message: `VitePress navigation references missing page "${id}".`,
        file: configFile,
      })
    }
  }
  for (const id of context.pageIds) {
    if (!navigation.has(id)) {
      issues.push({
        severity: 'error',
        code: 'unnavigated-page',
        message: `Page "${id}" is not in VitePress navigation.`,
        file: `${id}.md`,
      })
    }
  }
  return issues
}
