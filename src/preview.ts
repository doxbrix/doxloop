import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { createServer, type ServerResponse } from 'node:http'
import { extname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import chokidar from 'chokidar'
import { renderMarkdown, type TocEntry } from './doxbrix-markdown.js'
import { DoxloopError } from './errors.js'
import { resolveContainedDirectory } from './fs.js'
import { loadGeneratorAdapter } from './generators.js'
import {
  loadPages,
  loadProject,
  loadSiteConfig,
  pageId,
  readPage,
  siteConfigPath,
} from './project.js'
import type {
  DoxloopProject,
  DoxbrixNavNode,
  DoxbrixSiteConfig,
} from './types.js'

interface PreviewOptions {
  root: string
  host: string
  port: number
  open: boolean
}

const PACKAGE_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const DOXBRIX_CSS = resolve(PACKAGE_ROOT, 'assets', 'doxbrix-preview.css')

interface ReaderLayout {
  headerHeight: number
  tabsHeight: number
  shellMaxWidth: number
  sidebarWidth: number
  tocWidth: number
  contentMaxWidth: number
  contentPadding: number
  navPadding: number
}

const ATLAS_LAYOUT: ReaderLayout = {
  headerHeight: 64,
  tabsHeight: 48,
  shellMaxWidth: 1400,
  sidebarWidth: 256,
  tocWidth: 248,
  contentMaxWidth: 800,
  contentPadding: 4,
  navPadding: 24,
}

const STATIC_TYPES: Record<string, string> = {
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
}

export async function startPreview(options: PreviewOptions): Promise<void> {
  const project = await loadProject(options.root)
  if (project.generator !== 'doxbrix') {
    await (await loadGeneratorAdapter(options.root, project)).preview(options)
    return
  }
  await startDoxbrixPreview(options, project)
}

async function startDoxbrixPreview(
  options: PreviewOptions,
  project: DoxloopProject,
): Promise<void> {
  const contentRoot = await resolveContainedDirectory(
    options.root,
    project.contentDir,
    'Preview content directory',
  )
  const css = await readFile(DOXBRIX_CSS, 'utf8')
  const clients = new Set<ServerResponse>()

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)
      if (url.pathname === '/__doxloop/events') {
        response.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        })
        response.write(': connected\n\n')
        clients.add(response)
        request.once('close', () => clients.delete(response))
        return
      }
      if (url.pathname === '/__doxloop/doxbrix.css') {
        send(response, 200, 'text/css; charset=utf-8', css)
        return
      }

      const staticPath = safeStaticPath(contentRoot, url.pathname)
      if (staticPath && STATIC_TYPES[extname(staticPath).toLowerCase()]) {
        try {
          send(
            response,
            200,
            STATIC_TYPES[extname(staticPath).toLowerCase()]!,
            await readFile(staticPath),
          )
          return
        } catch {
          // A missing static asset may still be an extension-bearing documentation route.
        }
      }

      const [pages, site] = await Promise.all([
        loadPages(options.root, project),
        loadSiteConfig(options.root, project),
      ])
      const pagesById = new Map(pages.map((path) => [pageId(contentRoot, path), path]))
      const requested = requestedPage(url.pathname, site, pagesById)
      if (requested === undefined || !pagesById.has(requested)) {
        send(response, 404, 'text/html; charset=utf-8', errorPage(requested ?? '', site))
        return
      }

      const page = await readPage(pagesById.get(requested)!)
      const rendered = renderMarkdown(page.body)
      send(
        response,
        200,
        'text/html; charset=utf-8',
        doxbrixDocument({
          site,
          title: page.title || labelFromId(requested),
          ...(page.description ? { description: page.description } : {}),
          current: requested,
          rendered,
        }),
      )
    } catch (error) {
      send(
        response,
        500,
        'text/plain; charset=utf-8',
        error instanceof Error ? error.message : String(error),
      )
    }
  })

  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(options.port, options.host, resolveListen)
  })

  const url = `http://${shownHost(options.host)}:${options.port}`
  process.stdout.write(`Doxbrix preview: ${url}\nPress Ctrl+C to stop.\n`)
  if (options.open) openBrowser(url)

  const configPath = await siteConfigPath(options.root, project)
  const watcher = chokidar.watch([contentRoot, configPath], { ignoreInitial: true })
  watcher.on('all', () => {
    for (const client of clients) client.write('event: reload\ndata: now\n\n')
  })

  let stopping = false
  const stop = async (): Promise<void> => {
    if (stopping) return
    stopping = true
    await watcher.close()
    for (const client of clients) client.end()
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
  }
  process.once('SIGINT', () => void stop())
  process.once('SIGTERM', () => void stop())
}

function requestedPage(
  pathname: string,
  site: DoxbrixSiteConfig,
  pages: Map<string, string>,
): string | undefined {
  if (pathname === '/' || pathname === '') {
    return firstSitePage(site) ?? pages.keys().next().value
  }
  return decodeURIComponent(pathname.replace(/^\/+|\/+$/g, '')).replace(/\.(md|mdx)$/i, '')
}

export function doxbrixDocument(input: {
  site: DoxbrixSiteConfig
  title: string
  description?: string
  current: string
  rendered: { html: string; toc: TocEntry[] }
}): string {
  const visibleSpaces = input.site.spaces.filter((space) => hasVisibleNavigation(space.nav))
  const showTabs = visibleSpaces.length > 1
  const activeSpace =
    visibleSpaces.find((space) => containsPage(space.nav, input.current)) ??
    visibleSpaces[0]
  const primary = themeColor(input.site, 'primaryColor', '#6366f1')
  const primaryLight = themeColor(input.site, 'lightColor', primary)
  const primaryDark = themeColor(input.site, 'darkColor', primary)
  const layout = themeLayout(input.site)
  const configuredMode =
    typeof input.site.theme === 'string'
      ? input.site.theme
      : themeString(input.site, 'mode', 'system')
  const mode = ['light', 'dark', 'system'].includes(configuredMode)
    ? configuredMode
    : 'system'
  const resolvedMode = mode === 'dark' ? 'dark' : 'light'
  const font = themeString(input.site, 'font', 'Inter')
  const headingFont = themeString(input.site, 'headingFont', font)
  const codeFont = themeString(input.site, 'codeFont', 'ui-monospace')
  const backgroundLight = themeColor(input.site, 'backgroundColorLight', '#ffffff')
  const backgroundDark = themeColor(input.site, 'backgroundColorDark', '#12131a')
  const backgroundImage = themeString(input.site, 'backgroundImage', '')
  const logoLight = themeString(input.site, 'logoLight', '')
  const logoDark = themeString(input.site, 'logoDark', '')
  const codeTheme = resolveCodeTheme(themeString(input.site, 'codeTheme', 'auto'))
  const favicon =
    themeString(input.site, 'faviconLight', '') ||
    themeString(input.site, 'favicon', '') ||
    themeString(input.site, 'faviconDark', '')
  const siteName = input.site.name?.trim() || 'Documentation'
  const tabs = visibleSpaces
    .map((space) => {
      const first = firstPage(space.nav)
      const active = space === activeSpace ? ' active' : ''
      const tabIcon =
        typeof space.icon === 'string' && space.icon.trim()
          ? space.icon
          : spaceIcon(space.name)
      const tabTag =
        typeof space.tag === 'string' && space.tag
          ? `<span class="dxb-atlas-tab-tag">${escapeHtml(space.tag)}</span>`
          : ''
      const label = `<span class="dxb-atlas-tab-icon">${brandIcon(tabIcon, 16)}</span><span>${escapeHtml(space.name)}</span>${tabTag}`
      return first
        ? `<a class="dxb-atlas-tab${active}" href="/${escapeAttr(first)}">${label}</a>`
        : `<span class="dxb-atlas-tab${active}">${label}</span>`
    })
    .join('')
  const first = firstSitePage(input.site) ?? ''
  const logoHref = safeHref(themeString(input.site, 'logoHref', `/${first}`), `/${first}`)
  const leftnav = activeSpace
    ? `<aside class="dp-leftnav"><div class="dp-nav-tree">${navTree(activeSpace.nav, input.current)}</div></aside>`
    : ''
  const toc = tocHtml(input.rendered.toc)
  const groupLabel = activeSpace
    ? groupContainingPage(activeSpace.nav, input.current)
    : undefined
  const fontFaces = fontSourceCss(input.site)
  const fontStylesheet = googleFontStylesheet([font, headingFont])
  const faviconLink = favicon
    ? `<link rel="icon" href="${escapeAttr(favicon)}">`
    : ''
  const logo = logoLight || logoDark
    ? `<span class="dp-topnav-logo-img-wrap">${logoLight ? `<img class="dp-topnav-logo-img dp-topnav-logo-img--light${logoDark ? ' has-dark' : ''}" src="${escapeAttr(logoLight)}" alt="${escapeAttr(siteName)}">` : ''}${logoDark ? `<img class="dp-topnav-logo-img dp-topnav-logo-img--dark${logoLight ? ' has-light' : ''}" src="${escapeAttr(logoDark)}" alt="${escapeAttr(siteName)}">` : ''}</span>`
    : `<span class="dp-topnav-logo-mark" aria-hidden="true">${icon('book', 16)}</span><span class="dp-topnav-logo-text">${escapeHtml(siteName)}</span>`
  const description = input.description
    ? `<p class="dxb-atlas-description">${escapeHtml(input.description)}</p>`
    : ''
  const eyebrow = groupLabel
    ? `<div class="dxb-atlas-eyebrow">${escapeHtml(groupLabel)}</div>`
    : ''

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(input.title)} · ${escapeHtml(siteName)}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  ${fontStylesheet}
  ${faviconLink}
  <link rel="stylesheet" href="/__doxloop/doxbrix.css">
  <style>
    ${fontFaces}
    body{margin:0}.dp-tab-panel{display:none}.dp-tab-panel.active{display:block}
    .dp-nav-chevron{transition:transform .15s}.dp-nav-chevron:not(.open){transform:rotate(-90deg)}
    .dp-root--published{--project-primary:${escapeAttr(primary)};--project-primary-hover:${escapeAttr(primary)};
      --project-primary-rgb:${hexToRgb(primary)};--primary:${escapeAttr(primary)};--primary-rgb:${hexToRgb(primary)};
      --dxb-primary-light:${escapeAttr(primaryLight)};
      --dxb-primary-dark:${escapeAttr(primaryDark)};--project-font-family:${cssFontFamily(font)},system-ui,sans-serif;
      --project-heading-font-family:${cssFontFamily(headingFont)},system-ui,sans-serif;
      --project-code-font-family:${cssFontFamily(codeFont)},SFMono-Regular,Menlo,Monaco,Consolas,monospace;
      --dxb-background-light:${escapeAttr(backgroundLight)};--dxb-background-dark:${escapeAttr(backgroundDark)};
      --dxb-background-image:${backgroundImage ? `url('${cssString(backgroundImage)}')` : 'none'};
      --dxb-banner-height:0px;--dxb-header-height:${layout.headerHeight}px;--dxb-tabs-height:${showTabs ? layout.tabsHeight : 0}px;
      --dxb-shell-max-width:${layout.shellMaxWidth}px;--dxb-sidebar-width:${layout.sidebarWidth}px;
      --dxb-toc-width:${layout.tocWidth}px;--dxb-content-max-width:${layout.contentMaxWidth}px;
      --dxb-content-padding:${layout.contentPadding}px;--dxb-nav-padding:${layout.navPadding}px}
  </style>
</head>
<body>
<div class="dp-root dp-root--published" data-color-theme="${resolvedMode}" data-project-color-theme="${escapeAttr(mode)}" data-code-theme="${codeTheme}" data-shell-theme="atlas">
  <header class="dxb-atlas-header">
    <div class="dxb-atlas-header-main"><div class="dxb-atlas-header-inner">
      <a class="dp-topnav-logo" href="${escapeAttr(logoHref)}">${logo}</a>
      <div class="dxb-atlas-search-cluster">
        <button class="dp-topnav-search" type="button" aria-disabled="true">${icon('search', 17)}<span>Search...</span><kbd>⌘K</kbd></button>
        <button class="dxb-atlas-assistant" type="button" aria-disabled="true">${icon('sparkle', 16)}<span>Ask Assistant</span></button>
      </div>
      <div class="dxb-atlas-header-actions">
        <button class="dp-theme-toggle" type="button" aria-label="Switch color theme" aria-pressed="${resolvedMode === 'dark'}" data-theme-toggle>${icon(resolvedMode === 'dark' ? 'sun' : 'moon', 17)}</button>
      </div>
    </div></div>
    ${showTabs ? `<div class="dxb-atlas-tabs-bar"><nav class="dxb-atlas-tabs" aria-label="Documentation spaces">${tabs}</nav></div>` : ''}
  </header>
  <div class="dp-body">
    ${leftnav}
    <main class="dp-main"><div class="dp-content-wrap">
      <div class="dxb-atlas-title-row">
        <div class="dxb-atlas-title-copy">${eyebrow}<h1 class="dp-page-title">${escapeHtml(input.title)}</h1>${description}</div>
        <button class="dxb-atlas-copy-page" type="button" data-copy-page>${icon('copy', 16)}<span>Copy page</span>${icon('chevron-down', 14)}</button>
      </div>
      <div class="dp-blocks">${input.rendered.html}</div>
    </div></main>
    ${toc}
  </div>
</div>
<script>
  const root = document.querySelector('.dp-root--published');
  let colorTheme = root?.dataset.projectColorTheme || 'system';
  try {
    const stored = localStorage.getItem('docflow:docs:color-theme:v1');
    if (stored === 'light' || stored === 'dark') colorTheme = stored;
  } catch {}
  if (colorTheme === 'system') {
    colorTheme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  if (root) root.dataset.colorTheme = colorTheme;
  const themeToggle = document.querySelector('[data-theme-toggle]');
  function updateThemeToggle() {
    if (!themeToggle || !root) return;
    const dark = root.dataset.colorTheme === 'dark';
    themeToggle.setAttribute('aria-label', 'Switch to ' + (dark ? 'light' : 'dark') + ' theme');
    themeToggle.setAttribute('aria-pressed', String(dark));
    themeToggle.innerHTML = dark ? '${icon('sun', 17)}' : '${icon('moon', 17)}';
  }
  updateThemeToggle();
  const events = new EventSource('/__doxloop/events');
  events.addEventListener('reload', () => location.reload());
  document.addEventListener('click', (event) => {
    const toggle = event.target.closest('[data-theme-toggle]');
    if (toggle && root) {
      root.dataset.colorTheme = root.dataset.colorTheme === 'dark' ? 'light' : 'dark';
      try { localStorage.setItem('docflow:docs:color-theme:v1', root.dataset.colorTheme); } catch {}
      updateThemeToggle();
    }
    const copyPage = event.target.closest('[data-copy-page]');
    if (copyPage && navigator.clipboard) {
      navigator.clipboard.writeText(location.href);
    }
    const tab = event.target.closest('.dp-code-group-tab');
    if (tab) {
      const box = tab.closest('.dp-tabs,.dp-code-group');
      const id = tab.getAttribute('data-tab');
      box.querySelectorAll('.dp-code-group-tab').forEach((item) => item.classList.toggle('active', item === tab));
      box.querySelectorAll('.dp-tab-panel').forEach((panel) => panel.classList.toggle('active', panel.id === id));
    }
    const copy = event.target.closest('.dp-code-copy-btn');
    if (copy) {
      const code = copy.closest('.dp-code-block')?.querySelector('pre');
      if (code && navigator.clipboard) navigator.clipboard.writeText(code.innerText);
    }
    const apiCopy = event.target.closest('.dp-api-code-copy[type="button"],.dp-api-light-copy');
    if (apiCopy) {
      const card = apiCopy.closest('.dp-api-code-card,.dp-api-resp-card');
      const code = card?.querySelector('pre:not([hidden])');
      if (code && navigator.clipboard) navigator.clipboard.writeText(code.innerText);
    }
    const responseTab = event.target.closest('[data-api-response-tab]');
    if (responseTab) {
      const card = responseTab.closest('.dp-api-resp-card');
      const target = responseTab.getAttribute('data-api-response-tab');
      card?.querySelectorAll('[data-api-response-tab]').forEach((item) => item.classList.toggle('active', item === responseTab));
      card?.querySelectorAll('[data-api-response-panel]').forEach((panel) => {
        panel.hidden = panel.id !== target;
      });
    }
    const apiSection = event.target.closest('.dp-api-section-btn:not(.dp-api-section-btn--static)');
    if (apiSection) {
      const body = apiSection.nextElementSibling;
      if (body) {
        const open = apiSection.getAttribute('aria-expanded') !== 'false';
        apiSection.setAttribute('aria-expanded', String(!open));
        body.hidden = open;
      }
    }
    const group = event.target.closest('[data-nav-toggle]');
    if (group) {
      const children = group.parentElement?.querySelector(':scope > .dp-nav-children');
      if (children) {
        const open = children.style.display !== 'none';
        children.style.display = open ? 'none' : '';
        group.setAttribute('aria-expanded', String(!open));
        group.querySelector('.dp-nav-chevron')?.classList.toggle('open', !open);
      }
    }
  });
</script>
</body>
</html>`
}

function navTree(nodes: DoxbrixNavNode[], current: string, depth = 0): string {
  return nodes
    .map((node) => {
      if ('hidden' in node && node.hidden) return ''
      if (node.type === 'label') {
        return `<div class="dp-nav-section-title"><span class="dp-nav-item-label">${escapeHtml(node.text)}</span></div>`
      }
      if (node.type === 'divider') return '<div class="dp-nav-divider"></div>'
      if (node.type === 'link') {
        return `<a class="dp-nav-item${depthClass(depth)}" href="${escapeAttr(safeNavigationHref(node.href))}">${navIcon(node.icon)}<span class="dp-nav-item-label">${escapeHtml(node.title)}</span></a>`
      }
      if (node.type === 'api') {
        return `<div class="dp-nav-item${depthClass(depth)}">${navIcon(node.icon)}<span class="dp-nav-item-label">${escapeHtml(node.title)}</span></div>`
      }
      if (node.type === 'group') {
        const children = navTree(node.items, current, depth + 1)
        const activeBranch = containsPage(node.items, current) ? ' active-branch' : ''
        const groupIcon = navIcon(node.icon)
        if (depth === 0) {
          return `<div class="dp-nav-root-block${activeBranch}"><div class="dp-nav-section-title">${groupIcon}<span class="dp-nav-item-label">${escapeHtml(node.label)}</span></div><div class="dp-nav-children dp-nav-children--root">${children}</div></div>`
        }
        return `<div class="dp-nav-branch${activeBranch}"><button class="dp-nav-item dp-nav-group${activeBranch}${depthClass(depth)}" data-nav-toggle aria-expanded="true">${groupIcon}<span class="dp-nav-item-label">${escapeHtml(node.label)}</span>${chevron(true)}</button><div class="dp-nav-children">${children}</div></div>`
      }
      const active = normalizePage(node.file) === current ? ' active' : ''
      return `<a class="dp-nav-item${active}${depthClass(depth)}" href="/${escapeAttr(normalizePage(node.file))}">${navIcon(node.icon)}<span class="dp-nav-item-label">${escapeHtml(node.title || labelFromId(node.file))}</span></a>`
    })
    .join('')
}

function tocHtml(entries: TocEntry[]): string {
  if (entries.length === 0) return '<aside class="dp-toc"></aside>'
  return `<aside class="dp-toc"><div class="dp-toc-header">${icon('list', 16)} On this page</div>${entries
    .map(
      (entry, index) =>
        `<a class="dp-toc-entry level-${entry.level}${index === 0 ? ' active' : ''}" href="#${escapeAttr(entry.id)}">${escapeHtml(entry.title)}</a>`,
    )
    .join('')}</aside>`
}

function firstPage(nodes: DoxbrixNavNode[]): string | undefined {
  for (const node of nodes) {
    if ('hidden' in node && node.hidden) continue
    if (node.type === 'page') return normalizePage(node.file)
    if (node.type === 'group') {
      const found = firstPage(node.items)
      if (found) return found
    }
  }
  return undefined
}

function firstSitePage(site: DoxbrixSiteConfig): string | undefined {
  for (const space of site.spaces) {
    const first = firstPage(space.nav)
    if (first) return first
  }
  return undefined
}

function containsPage(nodes: DoxbrixNavNode[], current: string): boolean {
  return nodes.some(
    (node) =>
      (node.type === 'page' && normalizePage(node.file) === current) ||
      (node.type === 'group' && containsPage(node.items, current)),
  )
}

function hasVisibleNavigation(nodes: DoxbrixNavNode[]): boolean {
  return nodes.some((node) => {
    if ('hidden' in node && node.hidden) return false
    if (node.type === 'group') return hasVisibleNavigation(node.items)
    return true
  })
}

function groupContainingPage(
  nodes: DoxbrixNavNode[],
  current: string,
  parent?: string,
): string | undefined {
  for (const node of nodes) {
    if (node.type === 'page' && normalizePage(node.file) === current) return parent
    if (node.type === 'group') {
      const found = groupContainingPage(node.items, current, node.label)
      if (found !== undefined) return found
    }
  }
  return undefined
}

function normalizePage(value: string): string {
  return value.replace(/^\/+/, '').replace(/\.(md|mdx)$/i, '')
}

function themeString(
  site: DoxbrixSiteConfig,
  key: string,
  fallback: string,
): string {
  if (!site.theme || typeof site.theme !== 'object') return fallback
  const value = site.theme[key]
  return typeof value === 'string' && value.trim() ? value : fallback
}

function themeColor(
  site: DoxbrixSiteConfig,
  key: string,
  fallback: string,
): string {
  const value = themeString(site, key, fallback)
  return /^#[0-9a-f]{6}$/i.test(value) ? value : fallback
}

function themeLayout(site: DoxbrixSiteConfig): ReaderLayout {
  const theme =
    site.theme && typeof site.theme === 'object'
      ? site.theme
      : undefined
  const raw =
    theme?.layout && typeof theme.layout === 'object' && !Array.isArray(theme.layout)
      ? theme.layout as Record<string, unknown>
      : {}
  return {
    headerHeight: boundedNumber(raw.headerHeight, 48, 96, ATLAS_LAYOUT.headerHeight),
    tabsHeight: boundedNumber(raw.tabsHeight, 36, 72, ATLAS_LAYOUT.tabsHeight),
    shellMaxWidth: boundedNumber(raw.shellMaxWidth, 960, 1800, ATLAS_LAYOUT.shellMaxWidth),
    sidebarWidth: boundedNumber(raw.sidebarWidth, 240, 380, ATLAS_LAYOUT.sidebarWidth),
    tocWidth: boundedNumber(raw.tocWidth, 220, 360, ATLAS_LAYOUT.tocWidth),
    contentMaxWidth: boundedNumber(raw.contentMaxWidth, 640, 1200, ATLAS_LAYOUT.contentMaxWidth),
    contentPadding: boundedNumber(raw.contentPadding, 0, 80, ATLAS_LAYOUT.contentPadding),
    navPadding: boundedNumber(raw.navPadding, 8, 48, ATLAS_LAYOUT.navPadding),
  }
}

function boundedNumber(
  value: unknown,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.round(Math.max(minimum, Math.min(maximum, value)))
}

function resolveCodeTheme(value: string): 'auto' | 'light' | 'dark' {
  const normalized = value.toLowerCase()
  if (!normalized || normalized === 'system' || normalized === 'auto') return 'auto'
  if (normalized.includes('light') || normalized === 'day') return 'light'
  return 'dark'
}

const ICON_PATHS: Record<string, string> = {
  book: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>',
  'book-open': '<path d="M2 4.5A2.5 2.5 0 0 1 4.5 2H11a1 1 0 0 1 1 1v18a1 1 0 0 0-1-1H4.5A2.5 2.5 0 0 0 2 22z"/><path d="M22 4.5A2.5 2.5 0 0 0 19.5 2H13a1 1 0 0 0-1 1v18a1 1 0 0 1 1-1h6.5A2.5 2.5 0 0 1 22 22z"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>',
  'file-text': '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="16" y2="17"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>',
  sparkle: '<path d="M12 3l1.9 5.8L20 11l-6.1 2.2L12 19l-1.9-5.8L4 11l6.1-2.2z"/>',
  home: '<path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>',
  house: '<path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>',
  rocket: '<path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/><path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.87 12.87 0 0 1 22 2c0 2.72-.78 7.5-6.05 11a22.35 22.35 0 0 1-3.95 2z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/>',
  bolt: '<path d="m13 2-9 12h8l-1 8 9-12h-8z"/>',
  zap: '<path d="m13 2-9 12h8l-1 8 9-12h-8z"/>',
  terminal: '<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>',
  code: '<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>',
  braces: '<path d="M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5a2 2 0 0 0 2 2h1"/><path d="M16 21h1a2 2 0 0 0 2-2v-5a2 2 0 0 1 2-2 2 2 0 0 1-2-2V5a2 2 0 0 0-2-2h-1"/>',
  plug: '<path d="M12 22v-5"/><path d="M9 8V2"/><path d="M15 8V2"/><path d="M18 8v3a6 6 0 0 1-12 0V8z"/>',
  settings: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.38a2 2 0 0 0-.73-2.73l-.15-.09a2 2 0 0 1-1-1.74v-.51a2 2 0 0 1 1-1.72l.15-.1a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
  wrench: '<path d="M14.7 6.3a4 4 0 0 0-5-5L7 4l3 3-2.7 2.7a4 4 0 0 0 5 5L21 6l-3-3z"/><path d="m5 16-3 3 3 3 3-3"/>',
  'shield-check': '<path d="M20 13c0 5-3.5 7.5-8 9-4.5-1.5-8-4-8-9V5l8-3 8 3z"/><path d="m9 12 2 2 4-4"/>',
  key: '<circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6"/><path d="m15 7 2 2"/><path d="m18 4 2 2"/>',
  database: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 1.7 4 3 9 3s9-1.3 9-3V5"/><path d="M3 12c0 1.7 4 3 9 3s9-1.3 9-3"/>',
  server: '<rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/><line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/>',
  cloud: '<path d="M17.5 19H9a7 7 0 1 1 6.7-9h1.8a4.5 4.5 0 1 1 0 9Z"/>',
  package: '<path d="m16.5 9.4-9-5.2"/><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><polyline points="3.3 7 12 12 20.7 7"/><line x1="12" y1="22" x2="12" y2="12"/>',
  workflow: '<rect x="3" y="3" width="6" height="6" rx="1"/><rect x="15" y="15" width="6" height="6" rx="1"/><path d="M9 6h4a4 4 0 0 1 4 4v5"/><path d="m14 12 3 3 3-3"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  compass: '<circle cx="12" cy="12" r="10"/><polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76"/>',
  globe: '<circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 0 20"/><path d="M12 2a15.3 15.3 0 0 0 0 20"/>',
  list: '<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  github: '<path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3.3-.4 6.8-1.6 6.8-7A5.4 5.4 0 0 0 19.4 4 5 5 0 0 0 19.3.5S18.2.1 15 1.8a13.4 13.4 0 0 0-7 0C4.8.1 3.7.5 3.7.5A5 5 0 0 0 3.6 4a5.4 5.4 0 0 0-1.4 3.7c0 5.4 3.5 6.6 6.8 7A4.8 4.8 0 0 0 8 18v4"/><path d="M8 19c-3 .9-3-1.5-4-2"/>',
  clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l3 2"/>',
  moon: '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.42 1.42M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.42-1.42M17.66 6.34l1.41-1.41"/>',
  copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  chevron: '<polyline points="6 9 12 15 18 9"/>',
  'chevron-down': '<polyline points="6 9 12 15 18 9"/>',
}

function icon(name: string, size = 16): string {
  const paths = ICON_PATHS[name] ?? ICON_PATHS.file!
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`
}

function brandIcon(value: string, size = 16): string {
  const trimmed = value.trim()
  if (!trimmed) return icon('file', size)
  const image = iconImageSource(trimmed)
  if (image) {
    return `<img src="${escapeAttr(image)}" alt="" width="${size}" height="${size}">`
  }
  if (!/^[a-z0-9][a-z0-9 _-]*$/i.test(trimmed)) return escapeHtml(trimmed)
  const normalized = trimmed.toLowerCase().replace(/[_\s]+/g, '-')
  if (normalized === 'js' || normalized.includes('javascript') || normalized.includes('typescript')) {
    return `<span class="dxb-atlas-letter-icon" style="width:${size}px;height:${size}px">JS</span>`
  }
  if (normalized === 'py' || normalized.includes('python')) {
    return `<span class="dxb-atlas-letter-icon dxb-atlas-letter-icon--python" style="width:${size}px;height:${size}px">Py</span>`
  }
  const aliases: Record<string, string> = {
    api: 'braces',
    changelog: 'history',
    cli: 'terminal',
    documentation: 'book-open',
    'get-started': 'rocket',
    overview: 'house',
  }
  return icon(aliases[normalized] ?? normalized, size)
}

function navIcon(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) return ''
  return `<span class="dp-nav-item-icon dxb-atlas-nav-icon" aria-hidden="true">${brandIcon(value, 15)}</span>`
}

function iconImageSource(value: string): string | undefined {
  if (/^data:image\/(?:avif|gif|jpeg|png|svg\+xml|webp)[;,]/i.test(value)) return value
  if (!/\.(?:avif|gif|jpe?g|png|svg|webp)(?:[?#].*)?$/i.test(value)) return undefined
  if (value.startsWith('/') || /^https:\/\//i.test(value)) return value
  if (!/^[a-z0-9_./-]+(?:[?#][a-z0-9_=&.-]*)?$/i.test(value)) return undefined
  return `/${value.replace(/^\.?\//, '')}`
}

function spaceIcon(name: string): string {
  const normalized = name.toLowerCase()
  if (normalized.includes('python')) return 'python'
  if (normalized.includes('typescript') || normalized.includes('javascript')) return 'js'
  if (normalized === 'cli' || normalized.includes('command')) return 'terminal'
  return 'rocket'
}

function chevron(open: boolean): string {
  return `<svg class="dp-nav-chevron${open ? ' open' : ''}" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON_PATHS.chevron}</svg>`
}

function fontSourceCss(site: DoxbrixSiteConfig): string {
  const sources =
    site.theme && typeof site.theme === 'object'
      ? site.theme.fontSources
      : undefined
  if (!Array.isArray(sources)) return ''
  return sources
    .flatMap((entry) => {
      if (!entry || typeof entry !== 'object') return []
      const source = entry as Record<string, unknown>
      const family = typeof source.family === 'string' ? source.family.trim() : ''
      const path = typeof source.source === 'string' ? source.source.trim() : ''
      if (!family || !path) return []
      const format =
        typeof source.format === 'string' && /^[a-z0-9-]+$/i.test(source.format)
          ? source.format
          : 'woff2'
      const weight =
        typeof source.weight === 'number' && Number.isFinite(source.weight)
          ? Math.max(100, Math.min(900, Math.round(source.weight)))
          : 400
      const style = source.style === 'italic' ? 'italic' : 'normal'
      return [
        `@font-face{font-family:${cssFontFamily(family)};src:url('${cssString(path)}') format('${format}');font-weight:${weight};font-style:${style};font-display:swap}`,
      ]
    })
    .join('')
}

function googleFontStylesheet(families: string[]): string {
  const unique = [...new Set(families.map((family) => family.trim()).filter(Boolean))]
  if (unique.length === 0) return ''
  const query = unique
    .slice(0, 3)
    .map((family) => `family=${encodeURIComponent(family)}:wght@400;500;600;700;800`)
    .join('&')
  return `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?${query}&display=swap">`
}

function cssFontFamily(value: string): string {
  return `'${cssString(value.replaceAll(',', ' '))}'`
}

function cssString(value: string): string {
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll("'", "\\'")
    .replaceAll('<', '\\3C ')
    .replaceAll('>', '\\3E ')
    .replaceAll('\n', '')
    .replaceAll('\r', '')
}

function safeHref(value: string, fallback: string): string {
  return value.startsWith('/') || /^https:\/\//i.test(value) ? value : fallback
}

function safeNavigationHref(value: string): string {
  const trimmed = value.trim()
  if (
    (trimmed.startsWith('/') && !trimmed.startsWith('//')) ||
    trimmed.startsWith('#') ||
    /^(?:https?|mailto|tel):/i.test(trimmed)
  ) {
    return trimmed
  }
  return '#'
}

function depthClass(depth: number): string {
  return depth === 0 ? '' : ` dp-nav-d${Math.min(depth, 3)}`
}

function labelFromId(id: string): string {
  const last = normalizePage(id).split('/').at(-1) ?? id
  return last
    .split(/[-_]+/)
    .map((word) => `${word[0]?.toUpperCase() ?? ''}${word.slice(1)}`)
    .join(' ')
}

function safeStaticPath(contentRoot: string, pathname: string): string | undefined {
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return undefined
  }
  const path = resolve(contentRoot, decoded.replace(/^\/+/, ''))
  const rel = relative(contentRoot, path)
  return rel === '' || rel.startsWith('..') || isAbsolute(rel) ? undefined : path
}

function errorPage(requested: string, site: DoxbrixSiteConfig): string {
  return `<!doctype html><meta charset="utf-8"><title>Page not found</title><body style="font-family:system-ui;padding:40px"><h1>Page not found</h1><p>No Doxbrix page matches <code>/${escapeHtml(requested)}</code> in ${escapeHtml(site.name ?? 'this project')}.</p></body>`
}

function send(
  response: ServerResponse,
  status: number,
  type: string,
  body: string | Buffer,
): void {
  response.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': type.startsWith('text/html') ? 'no-store' : 'public, max-age=60',
  })
  response.end(body)
}

function shownHost(host: string): string {
  return host === '0.0.0.0' ? 'localhost' : host
}

function hexToRgb(value: string): string {
  const match = /^#([0-9a-f]{6})$/i.exec(value)
  if (!match) return '99 102 241'
  const hex = match[1]!
  return `${Number.parseInt(hex.slice(0, 2), 16)} ${Number.parseInt(hex.slice(2, 4), 16)} ${Number.parseInt(hex.slice(4, 6), 16)}`
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')
}

function escapeAttr(value: string): string {
  return escapeHtml(value)
}

function openBrowser(url: string): void {
  const command =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open'
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url]
  const child = spawn(command, args, { detached: true, stdio: 'ignore' })
  child.unref()
}
