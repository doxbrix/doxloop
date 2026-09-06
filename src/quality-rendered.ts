import { createHash } from 'node:crypto'
import { cp, mkdir, readFile, readdir } from 'node:fs/promises'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import axe from 'axe-core'
import pixelmatch from 'pixelmatch'
import { PNG } from 'pngjs'
import { ensurePlaywright } from './capture.js'
import { renderMarkdown } from './doxbrix-markdown.js'
import { pathExists } from './fs.js'
import { loadGeneratorAdapter } from './generators.js'
import { loadPages, loadProject, loadSiteConfig, pageId, readPage } from './project.js'
import { doxbrixDocument } from './preview.js'
import { QUALITY_CODES } from './quality-contract.js'
import type { DoxloopProject, QualityCheck, QualityConfig } from './types.js'

interface RenderedPage { route: string; html: string }

export async function checkRenderedQuality(root: string, project: DoxloopProject, config: QualityConfig, updateVisuals: boolean): Promise<{ checks: QualityCheck[]; accessibility?: string; visuals?: string }> {
  if (!config.rendered?.enabled) return { checks: [
    { code: QUALITY_CODES.accessibilityManual, category: 'accessibility', status: 'skipped', message: 'Rendered checks are opt-in. Enable rendered.enabled in .doxloop/quality.json.' },
    { code: QUALITY_CODES.visualSkipped, category: 'visual', status: 'skipped', message: 'Visual regression checks are disabled.' },
  ] }
  const pages = await renderedPages(root, project, config.rendered.routes ?? ['/'])
  if (pages.length === 0) return { checks: [{ code: QUALITY_CODES.accessibilityIssue, category: 'accessibility', status: 'fail', message: 'No representative rendered pages were found.' }, { code: QUALITY_CODES.visualSkipped, category: 'visual', status: 'skipped', message: 'No rendered pages are available for visual comparison.' }] }
  const outputRoot = join(root, '.doxloop', 'quality-artifacts')
  const currentRoot = join(outputRoot, 'visuals', project.generator)
  const baselineRoot = join(root, '.doxloop', 'visual-baselines', project.generator)
  await mkdir(currentRoot, { recursive: true })
  const checks: QualityCheck[] = []
  let playwright
  try { playwright = await ensurePlaywright() }
  catch (error) {
    return { checks: [
      { code: QUALITY_CODES.accessibilityManual, category: 'accessibility', status: 'warning', message: 'Rendered accessibility automation is unavailable; manual review is required.', detail: error instanceof Error ? error.message : String(error) },
      { code: QUALITY_CODES.visualSkipped, category: 'visual', status: 'warning', message: 'Visual screenshots could not be captured in this environment.' },
    ] }
  }
  const browser = await playwright.chromium.launch({ headless: true })
  try {
    for (const rendered of pages) {
      for (const theme of config.rendered.themes ?? ['light', 'dark']) for (const viewport of config.rendered.viewports ?? []) {
        const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, colorScheme: theme, reducedMotion: 'reduce' })
        try {
          const page = await context.newPage()
          await page.route('**/*', (route) => route.abort('blockedbyclient'))
          await page.setContent(rendered.html, { waitUntil: 'load' })
          await page.evaluate((selectedTheme: 'light' | 'dark') => {
            document.documentElement.dataset.colorTheme = selectedTheme
            document.querySelectorAll<HTMLElement>('[data-color-theme]').forEach((element) => { element.dataset.colorTheme = selectedTheme })
          }, theme)
          const slug = routeSlug(rendered.route)
          const directory = join(currentRoot, theme, slug)
          const screenshot = join(directory, `${viewport.name}.png`)
          await mkdir(directory, { recursive: true })
          await page.screenshot({ path: screenshot, fullPage: true, animations: 'disabled' })
          await page.addScriptTag({ content: axe.source })
          const axeIssues = await page.evaluate(async () => {
            const runner = (globalThis as typeof globalThis & { axe?: { run(): Promise<{ violations: Array<{ id: string; help: string; impact?: string; nodes: Array<{ target: string[] }> }> }> } }).axe
            return runner ? (await runner.run()).violations.map((violation) => `${violation.id}: ${violation.help}${violation.nodes.length ? ` — ${violation.nodes.slice(0, 3).flatMap((node) => node.target).join(', ')}` : ''}`) : ['Axe could not be loaded into the rendered page.']
          })
          const issues = [...await page.evaluate<string[]>(ACCESSIBILITY_SCRIPT), ...await keyboardIssues(page), ...axeIssues]
          for (const issue of issues) checks.push({ code: QUALITY_CODES.accessibilityIssue, category: 'accessibility', status: 'fail', message: issue, file: rendered.route })
          if (issues.length === 0) checks.push({ code: QUALITY_CODES.accessibilityPassed, category: 'accessibility', status: 'pass', message: `${rendered.route} passed automated landmark, name, heading, image, overflow, and focus checks at ${viewport.name}.`, file: rendered.route })
          const baseline = join(baselineRoot, theme, slug, `${viewport.name}.png`)
          if (updateVisuals) {
            await mkdir(dirname(baseline), { recursive: true }); await cp(screenshot, baseline)
            checks.push({ code: QUALITY_CODES.visualCreated, category: 'visual', status: 'pass', message: `Updated ${project.generator}/${theme}/${slug}/${viewport.name} visual baseline.`, file: rendered.route })
          } else if (!(await pathExists(baseline))) checks.push({ code: QUALITY_CODES.visualChanged, category: 'visual', status: 'warning', message: `No approved visual baseline exists for ${rendered.route} at ${viewport.name}.`, file: rendered.route, detail: 'Run doxloop quality --rendered --update-visuals after intentional review.' })
          else {
            const comparison = await compareScreenshots(baseline, screenshot, join(directory, `${viewport.name}.diff.png`))
            const maximum = config.rendered.maximumDiffRatio ?? 0.001
            if (comparison.ratio <= maximum) checks.push({ code: QUALITY_CODES.visualMatched, category: 'visual', status: 'pass', message: `${rendered.route} matches the approved ${theme} ${viewport.name} visual baseline (${(comparison.ratio * 100).toFixed(3)}% changed).`, file: rendered.route })
            else checks.push({ code: QUALITY_CODES.visualChanged, category: 'visual', status: 'fail', message: `${rendered.route} differs from the approved ${theme} ${viewport.name} baseline by ${(comparison.ratio * 100).toFixed(3)}%.`, file: rendered.route, detail: `Current: ${relative(root, screenshot)}\nDiff: ${relative(root, comparison.diff)}` })
          }
        } finally { await context.close() }
      }
    }
  } finally { await browser.close() }
  checks.push({ code: QUALITY_CODES.accessibilityManual, category: 'accessibility', status: 'warning', message: 'Automation cannot prove WCAG conformance. Manually review keyboard order, visible focus, contrast, zoom, screen-reader output, and reflow before release.' })
  return { checks, accessibility: relative(root, outputRoot), visuals: relative(root, currentRoot) }
}

async function renderedPages(root: string, project: DoxloopProject, routes: string[]): Promise<RenderedPage[]> {
  if (project.generator === 'doxbrix') {
    const [site, files] = await Promise.all([loadSiteConfig(root, project), loadPages(root, project)])
    const contentRoot = resolve(root, project.contentDir)
    const css = await readFile(resolve(fileURLToPath(new URL('..', import.meta.url)), 'assets', 'doxbrix-preview.css'), 'utf8')
    const byRoute = new Map(files.map((path) => [`/${pageId(contentRoot, path)}`, path]))
    if (files[0]) byRoute.set('/', files[0])
    return Promise.all(routes.flatMap((route) => byRoute.get(route) ? [{ route, path: byRoute.get(route)! }] : []).map(async ({ route, path }) => {
      const page = await readPage(path)
      return { route, html: doxbrixDocument({ site, title: page.title, ...(page.description ? { description: page.description } : {}), current: pageId(contentRoot, path), rendered: renderMarkdown(page.body) }).replace('<link rel="stylesheet" href="/__doxloop/doxbrix.css">', `<style>${css}</style>`) }
    }))
  }
  const adapter = await loadGeneratorAdapter(root, project)
  const output = resolve(root, adapter.build.outputDir)
  if (!(await pathExists(output))) return []
  const html = await listHtml(output)
  const byRoute = new Map(html.map((path) => [htmlRoute(output, path), path]))
  return Promise.all(routes.flatMap((route) => {
    const normalized = normalizeRoute(route)
    const path = byRoute.get(normalized)
    return path ? [{ route: normalized, path }] : []
  }).map(async ({ route, path }) => ({ route, html: await inlineLocalAssets(await readFile(path, 'utf8'), path, output) })))
}

async function listHtml(root: string): Promise<string[]> {
  const output: string[] = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) output.push(...await listHtml(path))
    else if (extname(path) === '.html') output.push(path)
  }
  return output.sort()
}

function routeSlug(route: string): string { return route.replace(/^\/+|\/+$/g, '').replace(/[^a-z0-9]+/gi, '-') || 'index' }
function normalizeRoute(route: string): string { const value = `/${route.replace(/^\/+|\/+$/g, '')}`; return value === '/' ? value : `${value}/` }
function htmlRoute(output: string, path: string): string {
  const value = relative(output, path).replace(/\\/g, '/').replace(/(?:^|\/)index\.html$/, '').replace(/\.html$/, '/')
  return normalizeRoute(value)
}

async function inlineLocalAssets(html: string, htmlPath: string, outputRoot: string): Promise<string> {
  let result = html
  const styles = [...html.matchAll(/<link\b[^>]*\brel=["']stylesheet["'][^>]*\bhref=["']([^"']+)["'][^>]*>/gi)]
  for (const match of styles) {
    const asset = await localAsset(match[1]!, htmlPath, outputRoot)
    if (asset) result = result.replace(match[0], `<style data-doxloop-inline="${escapeAttribute(match[1]!)}">${(await readFile(asset, 'utf8')).replace(/<\/style/gi, '<\\/style')}</style>`)
  }
  const scripts = [...result.matchAll(/<script\b([^>]*)\bsrc=["']([^"']+)["']([^>]*)><\/script>/gi)]
  for (const match of scripts) {
    const asset = await localAsset(match[2]!, htmlPath, outputRoot)
    if (asset) result = result.replace(match[0], `<script${match[1] ?? ''}${match[3] ?? ''}>${(await readFile(asset, 'utf8')).replace(/<\/script/gi, '<\\/script')}</script>`)
  }
  return result
}

async function localAsset(reference: string, htmlPath: string, outputRoot: string): Promise<string | undefined> {
  if (/^(?:[a-z]+:|\/\/|data:)/i.test(reference)) return undefined
  const clean = reference.split(/[?#]/, 1)[0]!
  const path = resolve(clean.startsWith('/') ? outputRoot : dirname(htmlPath), clean.replace(/^\/+/, ''))
  const rel = relative(outputRoot, path)
  return rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\') && await pathExists(path) ? path : undefined
}

function escapeAttribute(value: string): string { return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;') }
async function digest(path: string): Promise<string> { return createHash('sha256').update(await readFile(path)).digest('hex') }

export async function compareScreenshots(baselinePath: string, currentPath: string, diffPath: string): Promise<{ ratio: number; diff: string }> {
  if (await digest(baselinePath) === await digest(currentPath)) return { ratio: 0, diff: diffPath }
  const [baseline, current] = await Promise.all([readFile(baselinePath).then((value) => PNG.sync.read(value)), readFile(currentPath).then((value) => PNG.sync.read(value))])
  if (baseline.width !== current.width || baseline.height !== current.height) return { ratio: 1, diff: currentPath }
  const diff = new PNG({ width: current.width, height: current.height })
  const changed = pixelmatch(baseline.data, current.data, diff.data, current.width, current.height, { threshold: 0.1, includeAA: false })
  await writePng(diffPath, diff)
  return { ratio: changed / Math.max(current.width * current.height, 1), diff: diffPath }
}

async function writePng(path: string, png: PNG): Promise<void> {
  const { writeFile } = await import('node:fs/promises')
  await writeFile(path, PNG.sync.write(png))
}

async function keyboardIssues(page: Pick<import('./capture.js').PlaywrightPage, 'keyboard' | 'evaluate'>): Promise<string[]> {
  const count = await page.evaluate(() => document.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])').length)
  if (count === 0) return []
  const seen = new Set<string>()
  for (let index = 0; index < Math.min(count + 1, 80); index += 1) {
    await page.keyboard.press('Tab')
    const name = await page.evaluate(() => {
      const active = document.activeElement as HTMLElement | null
      if (!active || active === document.body) return ''
      return active.getAttribute('aria-label') ?? active.getAttribute('href') ?? active.id ?? active.textContent?.trim().slice(0, 80) ?? active.tagName
    })
    if (name) seen.add(name)
  }
  return seen.size < Math.min(count, 2) ? ['Keyboard traversal did not reach the expected interactive controls.'] : []
}

const ACCESSIBILITY_SCRIPT = String.raw`(() => {
  const issues = [];
  if (!document.documentElement.lang) issues.push('The rendered document needs a language declaration.');
  if (!document.querySelector('main, [role="main"]')) issues.push('The rendered document needs a main landmark.');
  if (!document.querySelector('h1')) issues.push('The rendered document needs an h1.');
  document.querySelectorAll('img').forEach((image) => { if (!image.hasAttribute('alt')) issues.push('Every rendered image needs an alt attribute.'); });
  document.querySelectorAll('button, a[href], input, select, textarea').forEach((control) => {
    const name = control.getAttribute('aria-label') || control.getAttribute('title') || control.textContent?.trim() || control.getAttribute('placeholder');
    if (!name) issues.push('Every interactive control needs an accessible name.');
    if (control.getAttribute('tabindex') && Number(control.getAttribute('tabindex')) > 0) issues.push('Positive tabindex values create an unpredictable keyboard order.');
  });
  let previous = 0;
  document.querySelectorAll('h1,h2,h3,h4,h5,h6').forEach((heading) => { const level = Number(heading.tagName.slice(1)); if (previous && level > previous + 1) issues.push('Rendered heading levels must not skip ranks.'); previous = level; });
  if (document.documentElement.scrollWidth > window.innerWidth + 2) issues.push('The rendered page overflows horizontally at this viewport.');
  const focusTarget = document.querySelector('a[href], button, input, select, textarea');
  if (focusTarget) {
    focusTarget.focus();
    const focus = getComputedStyle(focusTarget);
    if (focus.outlineStyle === 'none' && focus.boxShadow === 'none') issues.push('The first keyboard control has no detectable focus indicator.');
  }
  document.documentElement.style.zoom = '2';
  if (document.documentElement.scrollWidth > window.innerWidth * 2 + 2) issues.push('The rendered page does not reflow cleanly at 200% zoom.');
  return Array.from(new Set(issues));
})()`
