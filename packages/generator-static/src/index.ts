import { readFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  defineGenerator,
  type GeneratorPage,
  type GeneratorScaffoldContext,
  type GeneratorValidationContext,
  type ValidationIssue,
} from '@doxbrix/doxloop/generator-api'
import {
  isRecord,
  pathExists,
  readPackageJson,
  serveStaticDirectory,
  slugFromTitle,
  writeJsonFile,
} from '@doxbrix/doxloop/generator-runtime'

const PACKAGE_NAME = '@doxbrix/doxloop-generator-static'
const PACKAGE_VERSION = (
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    version: string
  }
).version

const adapter = defineGenerator({
  apiVersion: 1,
  id: 'static',
  displayName: 'Prebuilt static HTML',
  packageName: PACKAGE_NAME,
  packageVersion: PACKAGE_VERSION,
  authoring: {
    skillName: 'doxloop-static',
    skillDirectory: fileURLToPath(new URL('../skills/doxloop-static', import.meta.url)),
  },
  planning: { navigationFiles: ['scripts/build.mjs'] },
  project: {
    defaultContentDir: 'site',
    pageExtensions: ['.html'],
    gitignore: [],
    contentFormat: 'html' as const,
  },
  build: { command: 'npm run build', outputDir: 'site' },
  scaffold: scaffoldStatic,
  preview: (options) => serveStaticDirectory(options, 'site', 'Static HTML'),
  validate: validateStatic,
  readPage: readHtmlPage,
})

export default adapter

async function scaffoldStatic(context: GeneratorScaffoldContext): Promise<void> {
  const { root, title, contentDir } = context
  await mkdir(join(root, contentDir, 'quickstart'), { recursive: true })
  await mkdir(join(root, 'scripts'), { recursive: true })
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
      dev: 'doxloop preview',
      build: 'node scripts/build.mjs',
      'docs:test': 'doxloop test',
    },
    devDependencies: {
      ...(isRecord(existing.devDependencies) ? existing.devDependencies : {}),
      [context.corePackage.name]: `^${context.corePackage.version}`,
      [context.generatorPackage.name]: `^${context.generatorPackage.version}`,
    },
  })
  await writeFile(
    join(root, 'scripts', 'build.mjs'),
    `import { access } from 'node:fs/promises'

await access(new URL('../site/index.html', import.meta.url))
console.log('Static HTML is ready in site/')
`,
    { encoding: 'utf8', flag: 'wx' },
  )
  await writeFile(
    join(root, contentDir, 'styles.css'),
    `:root { font-family: Inter, system-ui, sans-serif; --primary: #4f46e5; }
body { margin: 0; color: #1f2937; } header { border-bottom: 1px solid #e5e7eb; padding: 1rem 2rem; }
.brand { color: var(--primary); font-weight: 700; text-decoration: none; }
.layout { display: grid; grid-template-columns: 16rem minmax(0, 48rem); gap: 3rem; max-width: 72rem; margin: 0 auto; padding: 2rem; }
nav ul { list-style: none; padding: 0; } nav a { display: block; padding: .5rem; }
main { line-height: 1.7; min-width: 0; }
@media (max-width: 720px) { .layout { grid-template-columns: 1fr; } }
`,
    { encoding: 'utf8', flag: 'wx' },
  )
  const nav = `<nav aria-label="Documentation"><ul><li><a href="/">Overview</a></li><li><a href="/quickstart/">Quickstart</a></li></ul></nav>`
  await writeFile(
    join(root, contentDir, 'index.html'),
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="description" content="Understand what ${escapeHtml(title)} helps you accomplish and choose your first workflow.">
    <title>${escapeHtml(title)}</title>
    <link rel="stylesheet" href="/styles.css">
  </head>
  <body>
    <header><a class="brand" href="/">${escapeHtml(title)}</a></header>
    <div class="layout">
      <aside>${nav}</aside>
      <main><article><h1>${escapeHtml(title)}</h1>
        <!-- doxloop:starter-page -->
        <p>The authoring agent will replace this starter with an evidence-backed product overview.</p>
        <p><a href="/quickstart/">Follow the quickstart</a> to reach your first successful result.</p>
      </article></main>
    </div>
  </body>
</html>
`,
    { encoding: 'utf8', flag: 'wx' },
  )
  await writeFile(
    join(root, contentDir, 'quickstart', 'index.html'),
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="description" content="Reach your first successful result with verified product instructions.">
    <title>Quickstart · ${escapeHtml(title)}</title>
    <link rel="stylesheet" href="/styles.css">
  </head>
  <body>
    <header><a class="brand" href="/">${escapeHtml(title)}</a></header>
    <div class="layout">
      <aside>${nav}</aside>
      <main><article><h1>Quickstart</h1>
        <!-- doxloop:starter-page -->
        <ol><li>Confirm prerequisites from the configured product source.</li><li>Complete the first supported workflow.</li><li>Verify the observable result.</li></ol>
      </article></main>
    </div>
  </body>
</html>
`,
    { encoding: 'utf8', flag: 'wx' },
  )
}

async function validateStatic(
  context: GeneratorValidationContext,
): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = []
  for (const file of ['package.json', 'scripts/build.mjs', 'site/index.html']) {
    if (!(await pathExists(join(context.root, file)))) {
      issues.push({
        severity: 'error',
        code: 'missing-generator-file',
        message: `Static HTML project is missing ${file}.`,
        file,
      })
    }
  }
  const indexPath = join(context.contentRoot, 'index.html')
  if (!(await pathExists(indexPath))) return issues
  const source = await readFile(indexPath, 'utf8')
  const navigation = new Set<string>()
  for (const match of source.matchAll(/<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>/gi)) {
    const href = match[1]
    if (!href || /^[a-z]+:\/\//i.test(href) || href.startsWith('#')) continue
    const clean = href.split(/[?#]/)[0]?.replace(/^\/|\/$/g, '') ?? ''
    navigation.add(clean === '' ? 'index' : `${clean}/index`)
  }
  for (const id of navigation) {
    if (!context.pageIds.includes(id)) {
      issues.push({
        severity: 'error',
        code: 'missing-page',
        message: `Static navigation references missing page "${id}".`,
        file: 'site/index.html',
      })
    }
  }
  for (const id of context.pageIds) {
    if (!navigation.has(id)) {
      issues.push({
        severity: 'error',
        code: 'unnavigated-page',
        message: `Page "${id}" is not in static navigation.`,
        file: `${id}.html`,
      })
    }
  }
  return issues
}

async function readHtmlPage(path: string): Promise<GeneratorPage> {
  const raw = await readFile(path, 'utf8')
  const title = decodeEntities(
    raw.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() ?? '',
  )
  const description = decodeEntities(
    raw.match(
      /<meta\b(?=[^>]*\bname=["']description["'])(?=[^>]*\bcontent=["']([^"']*)["'])[^>]*>/i,
    )?.[1]?.trim() ?? '',
  )
  return description
    ? { title, description, body: raw }
    : { title, body: raw }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function decodeEntities(value: string): string {
  return value
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
}
