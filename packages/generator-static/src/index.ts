import { readFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, posix } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  defineGenerator,
  type GeneratorPage,
  type GeneratorRenderContext,
  type GeneratorRenderedPage,
  type GeneratorScaffoldContext,
  type GeneratorValidationContext,
  type ValidationIssue,
} from '@doxbrix/doxloop/generator-api'
import {
  contentRelativePages,
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
  planning: { navigationFiles: ['site/index.html'] },
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
  renderPage: renderHtmlPage,
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
nav ul { list-style: none; padding: 0; } nav a { display: block; padding: .5rem; } nav ul ul { padding-left: 1rem; }
main { line-height: 1.7; min-width: 0; }
.callout { border-left: 4px solid var(--primary); padding: .75rem 1rem; margin: 1rem 0; background: #eef2ff; }
.callout-warning { border-color: #d97706; background: #fffbeb; } .callout-danger { border-color: #dc2626; background: #fef2f2; }
.tabs details { border: 1px solid #e5e7eb; border-radius: .5rem; margin: .5rem 0; } .tabs summary { cursor: pointer; padding: .5rem 1rem; font-weight: 600; } .tabs details > :not(summary) { padding: 0 1rem 1rem; }
pre { overflow: auto; padding: 1rem; background: #111827; color: #f9fafb; border-radius: .5rem; } pre.mermaid { background: transparent; color: inherit; }
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

/**
 * A static page is navigated when the home page reaches it through internal
 * links, directly or through a section page. Links are followed page by page,
 * so a section index that lists its own children is enough.
 */
async function validateStatic(
  context: GeneratorValidationContext,
): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = []
  const contentDir = context.project.contentDir.split('\\').join('/').replace(/\/+$/, '')
  for (const file of ['package.json', 'scripts/build.mjs', `${contentDir}/index.html`]) {
    if (!(await pathExists(join(context.root, file)))) {
      issues.push({
        severity: 'error',
        code: 'missing-generator-file',
        message: `Static HTML project is missing ${file}.`,
        file,
      })
    }
  }
  if (!(await pathExists(join(context.contentRoot, 'index.html')))) return issues
  const pages = contentRelativePages(context.contentRoot, context.pages)
  const pageIds = new Set(pages.map((page) => page.replace(/\.html?$/i, '')))
  const resolvePage = (route: string): string | undefined => {
    const clean = route.replace(/^\/+|\/+$/g, '').replace(/\.html?$/i, '')
    if (clean === '') return pageIds.has('index') ? 'index' : undefined
    if (pageIds.has(clean)) return clean
    if (pageIds.has(`${clean}/index`)) return `${clean}/index`
    return undefined
  }
  const reached = new Set<string>(['index'])
  const queue = ['index']
  while (queue.length > 0) {
    const id = queue.shift()!
    const file = pages.find((page) => page.replace(/\.html?$/i, '') === id)
    if (!file) continue
    const source = await readFile(join(context.contentRoot, file), 'utf8')
    const base = `http://doxloop.local/${posix.dirname(file) === '.' ? '' : `${posix.dirname(file)}/`}`
    for (const match of source.matchAll(/<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>/gi)) {
      const href = match[1]
      if (!href || /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('#') || href.startsWith('//')) continue
      let route: string
      try {
        route = new URL(href, base).pathname
      } catch {
        continue
      }
      const target = resolvePage(route)
      if (!target) {
        if (!/\.[a-z0-9]+$/i.test(route) || /\.html?$/i.test(route)) {
          issues.push({
            severity: 'error',
            code: 'missing-page',
            message: `Static navigation references missing page "${route}".`,
            file: `${contentDir}/${file}`,
          })
        }
        continue
      }
      if (!reached.has(target)) {
        reached.add(target)
        queue.push(target)
      }
    }
  }
  for (const page of pages) {
    const id = page.replace(/\.html?$/i, '')
    if (!reached.has(id)) {
      issues.push({
        severity: 'error',
        code: 'unnavigated-page',
        message: `Page "${id}" is not reachable from the static site's home page.`,
        file: `${contentDir}/${page}`,
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

/** The page is already HTML; the preview shows its main landmark without the site chrome. */
async function renderHtmlPage(context: GeneratorRenderContext): Promise<GeneratorRenderedPage> {
  const raw = context.page.body
  const main = raw.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1]
  const body = main ?? raw.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1] ?? raw
  return { html: body.replace(/<script\b[\s\S]*?<\/script>/gi, '').trim() }
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
