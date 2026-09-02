import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DoxloopError,
  defineGenerator,
  type GeneratorPreviewOptions,
  type GeneratorScaffoldContext,
  type ValidationIssue,
} from '@doxbrix/doxloop/generator-api'
import { resolvePublicAsset } from '@doxbrix/doxloop/generator-runtime'

const PACKAGE_NAME = '@doxbrix/doxloop-generator-docusaurus'
const PACKAGE_VERSION = (
  JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  ) as { version: string }
).version

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
  async validate({ root }) {
    const issues: ValidationIssue[] = []
    const required = ['package.json', 'docusaurus.config.js', 'sidebars.js']
    for (const file of required) {
      if (!(await exists(join(root, file)))) {
        issues.push({
          severity: 'error',
          code: 'missing-generator-file',
          message: `Docusaurus project is missing ${file}.`,
          file,
        })
      }
    }
    return issues
  },
})

export default adapter

export function docusaurusPreviewInvocation(options: GeneratorPreviewOptions): {
  command: string
  args: string[]
} {
  const executable = process.platform === 'win32' ? 'docusaurus.cmd' : 'docusaurus'
  return {
    command: resolve(options.root, 'node_modules', '.bin', executable),
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
  const suffix = process.platform === 'win32' ? '.cmd' : ''
  if (await exists(join(root, 'pnpm-lock.yaml'))) {
    return { command: `pnpm${suffix}`, args: ['install'] }
  }
  if (await exists(join(root, 'yarn.lock'))) {
    return { command: `yarn${suffix}`, args: ['install'] }
  }
  return { command: `npm${suffix}`, args: ['install'] }
}

async function scaffoldDocusaurus(context: GeneratorScaffoldContext): Promise<void> {
  const { root, title, contentDir } = context
  await mkdir(join(root, contentDir), { recursive: true })
  await mkdir(join(root, 'src', 'css'), { recursive: true })
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
      docusaurus: 'docusaurus',
      start: 'docusaurus start',
      build: 'docusaurus build',
      serve: 'docusaurus serve',
    },
    dependencies: {
      ...(isRecord(existing.dependencies) ? existing.dependencies : {}),
      '@docusaurus/core': '3.10.2',
      '@docusaurus/faster': '3.10.2',
      '@docusaurus/preset-classic': '3.10.2',
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
      '@docusaurus/module-type-aliases': '3.10.2',
      '@docusaurus/types': '3.10.2',
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
  const invocation = docusaurusPreviewInvocation(options)
  await ensureDocusaurusDependencies(options.root)
  process.stdout.write(
    `Starting Docusaurus preview at http://${shownHost(options.host)}:${options.port}\n`,
  )
  await runPreview(invocation.command, invocation.args, options.root, 'Docusaurus')
}

async function ensureDocusaurusDependencies(root: string): Promise<void> {
  const binary = docusaurusPreviewInvocation({
    root,
    host: '127.0.0.1',
    port: 4321,
    open: false,
  }).command
  if (await exists(binary)) return
  if (!(await exists(join(root, 'package.json')))) {
    throw new DoxloopError('This Docusaurus project has no package.json.', 2)
  }
  const install = await docusaurusInstallInvocation(root)
  process.stdout.write(
    `Installing Docusaurus dependencies with \`${install.command} ${install.args.join(' ')}\` (first preview only)...\n`,
  )
  const code = await runChild(install.command, install.args, root)
  if (code !== 0 || !(await exists(binary))) {
    throw new DoxloopError(
      `Docusaurus dependency installation did not complete. Run \`${install.command} ${install.args.join(' ')}\` in this documentation project.`,
      2,
    )
  }
}

async function runPreview(
  command: string,
  args: string[],
  root: string,
  label: string,
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
      throw new DoxloopError(`${label} preview exited with code ${result.code ?? 1}.`)
    }
  } finally {
    process.off('SIGINT', onSigint)
    process.off('SIGTERM', onSigterm)
  }
}

async function runChild(command: string, args: string[], root: string): Promise<number> {
  return new Promise((resolveExit, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', (code) => resolveExit(code ?? 1))
  })
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

function shownHost(host: string): string {
  return host === '0.0.0.0' || host === '::' ? 'localhost' : host
}
