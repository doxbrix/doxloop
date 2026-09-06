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
const ASTRO_CONFIG_FILES = ['astro.config.mjs', 'astro.config.ts', 'astro.config.js', 'astro.config.mts']

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
  planning: { navigationFiles: ['astro.config.mjs'] },
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
  // Astro 7 daemonises `astro dev` when it detects a coding agent in the
  // environment, which would end this command at once and leave a server
  // Doxloop cannot stop. Its own guard against double daemonising keeps the
  // server in the foreground.
  await runPreviewProcess(
    invocation.command,
    invocation.args,
    options.root,
    'Starlight',
    { ...process.env, ASTRO_DEV_BACKGROUND: '1' },
  )
}

/**
 * Reads the sidebar Starlight would build: no `sidebar` option lists every
 * page, an `autogenerate` group covers a whole directory, and `slug` or
 * `link` entries name single pages. A sidebar assembled by code or a plugin is
 * reported as unverified rather than guessed at.
 */
async function validateStarlight(
  context: GeneratorValidationContext,
): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = []
  for (const file of ['package.json', 'src/content.config.ts']) {
    if (!(await pathExists(join(context.root, file)))) {
      issues.push({
        severity: 'error',
        code: 'missing-generator-file',
        message: `Starlight project is missing ${file}.`,
        file,
      })
    }
  }
  let configFile: string | undefined
  for (const candidate of ASTRO_CONFIG_FILES) {
    if (await pathExists(join(context.root, candidate))) {
      configFile = candidate
      break
    }
  }
  if (!configFile) {
    issues.push({
      severity: 'error',
      code: 'missing-generator-file',
      message: 'Starlight project is missing astro.config.mjs.',
      file: 'astro.config.mjs',
    })
    return issues
  }
  const source = await readFile(join(context.root, configFile), 'utf8')
  const sidebar = readStarlightSidebar(source)
  if (sidebar.unverified) {
    issues.push(navigationUnverifiedIssue('Starlight', configFile, sidebar.unverified))
    return issues
  }
  const pages = contentRelativePages(context.contentRoot, context.pages)
  const slugs = new Map<string, string>()
  for (const page of pages) slugs.set(starlightSlug(page), page)
  if (sidebar.everything) return issues
  for (const slug of sidebar.slugs) {
    if (!slugs.has(slug)) {
      issues.push({
        severity: 'error',
        code: 'missing-page',
        message: `Starlight sidebar references missing page "${slug || 'index'}".`,
        file: configFile,
      })
    }
  }
  for (const [slug, page] of slugs) {
    if (sidebar.slugs.has(slug)) continue
    if (sidebar.directories.some((directory) => slug === directory || slug.startsWith(`${directory}/`))) continue
    const raw = await readFile(join(context.contentRoot, page), 'utf8')
    if (isStarlightPageHidden(raw)) continue
    issues.push({
      severity: 'error',
      code: 'unnavigated-page',
      message: `Page "${slug || 'index'}" is not in the Starlight sidebar.`,
      file: `${context.project.contentDir}/${page}`,
    })
  }
  return issues
}

export function readStarlightSidebar(source: string): {
  everything: boolean
  slugs: Set<string>
  directories: string[]
  unverified?: string
} {
  const slugs = new Set<string>()
  const directories: string[] = []
  const body = source.replace(/\/\*[\s\S]*?\*\/|(^|[^:])\/\/.*$/gm, '$1')
  if (/[{,]\s*sidebar\s*(?:[,}]|$)/m.test(body)) {
    return { everything: false, slugs, directories, unverified: 'the sidebar is built by code rather than listed in the configuration.' }
  }
  const sidebarIndex = body.search(/\bsidebar\s*:/)
  if (sidebarIndex === -1) {
    if (/\bplugins\s*:\s*\[\s*[^\]]/.test(body)) {
      return { everything: false, slugs, directories, unverified: 'a Starlight plugin may change the sidebar.' }
    }
    return { everything: true, slugs, directories }
  }
  const afterKey = body.slice(sidebarIndex).replace(/^sidebar\s*:\s*/, '')
  if (!afterKey.startsWith('[')) {
    return { everything: false, slugs, directories, unverified: 'the sidebar is built by code rather than listed in the configuration.' }
  }
  const literal = balancedArray(afterKey)
  if (literal === undefined || /\.\.\.|=>|\.map\(|\bfunction\b/.test(literal)) {
    return { everything: false, slugs, directories, unverified: 'the sidebar is built by code rather than listed in the configuration.' }
  }
  for (const match of literal.matchAll(/\bslug\s*:\s*["']([^"']*)["']/g)) {
    slugs.add(normaliseStarlightSlug(match[1] ?? ''))
  }
  for (const match of literal.matchAll(/\blink\s*:\s*["']\/([^"'#?]*)["']/g)) {
    slugs.add(normaliseStarlightSlug(match[1] ?? ''))
  }
  for (const match of literal.matchAll(/\bautogenerate\s*:\s*\{[^}]*\bdirectory\s*:\s*["']([^"']+)["']/g)) {
    directories.push(normaliseStarlightSlug(match[1] ?? ''))
  }
  if (/\bplugins\s*:\s*\[\s*[^\]]/.test(body)) {
    return { everything: false, slugs, directories, unverified: 'a Starlight plugin may change the sidebar.' }
  }
  return { everything: false, slugs, directories }
}

function balancedArray(source: string): string | undefined {
  let depth = 0
  let quote: string | undefined
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!
    if (quote) {
      if (character === '\\') index += 1
      else if (character === quote) quote = undefined
      continue
    }
    if (character === '"' || character === "'" || character === '`') {
      quote = character
      continue
    }
    if (character === '[' || character === '{' || character === '(') depth += 1
    if (character === ']' || character === '}' || character === ')') {
      depth -= 1
      if (depth === 0) return source.slice(0, index + 1)
    }
  }
  return undefined
}

function normaliseStarlightSlug(value: string): string {
  const clean = value.replace(/^\/+|\/+$/g, '')
  return clean === 'index' ? '' : clean.replace(/\/index$/, '')
}

export function starlightSlug(page: string): string {
  return normaliseStarlightSlug(page.replace(/\.(?:md|mdx)$/i, ''))
}

function isStarlightPageHidden(raw: string): boolean {
  const frontmatter = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? ''
  return /^template\s*:\s*splash\s*$/m.test(frontmatter) || /^\s+hidden\s*:\s*true\s*$/m.test(frontmatter)
}
