import { spawn } from 'node:child_process'
import { lookup } from 'node:dns/promises'
import { mkdir, writeFile } from 'node:fs/promises'
import { isIP } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DoxloopError, UsageError } from './errors.js'
import { pathExists } from './fs.js'
import { loadProject } from './project.js'
import type { DesignReference } from './types.js'

const PLAYWRIGHT_SPEC = 'playwright@^1.50.0'
const PAGES_PER_ORIGIN = 3
const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
] as const
const COLOR_SCHEMES = ['light', 'dark'] as const

export interface PlaywrightPage {
  goto(url: string, options?: object): Promise<{ url(): string } | null>
  waitForTimeout(milliseconds: number): Promise<void>
  screenshot(options: object): Promise<unknown>
  setContent(html: string, options?: object): Promise<void>
  evaluate<T>(script: string): Promise<T>
  evaluate<T, A>(callback: (argument: A) => T | Promise<T>, argument: A): Promise<T>
  evaluate<T>(callback: () => T | Promise<T>): Promise<T>
  addScriptTag(options: { content: string }): Promise<unknown>
  keyboard: { press(key: string): Promise<void> }
  route(
    pattern: string,
    handler: (route: PlaywrightRoute) => Promise<void>,
  ): Promise<void>
  url(): string
}

interface PlaywrightRoute {
  request(): {
    url(): string
    isNavigationRequest(): boolean
  }
  abort(reason?: string): Promise<void>
  continue(): Promise<void>
}

export interface PlaywrightContext {
  newPage(): Promise<PlaywrightPage>
  close(): Promise<void>
}

export interface PlaywrightBrowser {
  newContext(options: object): Promise<PlaywrightContext>
  close(): Promise<void>
}

export interface PlaywrightModule {
  chromium: { launch(options?: object): Promise<PlaywrightBrowser> }
}

export function toolsDir(): string {
  if (process.env.DOXLOOP_TOOLS_DIR) return process.env.DOXLOOP_TOOLS_DIR
  if (process.platform === 'win32') {
    return join(
      process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'),
      'doxloop',
      'tools',
    )
  }
  return join(
    process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'),
    'doxloop',
    'tools',
  )
}

export function resolveCaptureUrls(
  references: DesignReference[],
  requested: string[],
): string[] {
  if (references.length === 0) {
    throw new UsageError(
      'No design reference is configured. Add one with `doxloop create --reference <url>` first; the capture boundary is limited to configured reference origins.',
    )
  }
  const origins = new Set(references.map((reference) => new URL(reference.url).origin))
  const urls = requested.length > 0 ? requested : references.map((reference) => reference.url)
  const perOrigin = new Map<string, number>()
  const output: string[] = []
  for (const raw of urls) {
    let url: URL
    try {
      url = new URL(raw)
    } catch {
      throw new UsageError(`Invalid capture URL "${raw}". Use an absolute HTTP or HTTPS URL.`)
    }
    if (!origins.has(url.origin)) {
      throw new UsageError(
        `Refusing to capture ${url.origin}: it is not the origin of a configured design reference. Add it with \`doxloop create --reference <url>\` first.`,
      )
    }
    const count = perOrigin.get(url.origin) ?? 0
    if (count >= PAGES_PER_ORIGIN) {
      throw new UsageError(
        `Refusing to capture more than ${PAGES_PER_ORIGIN} pages from ${url.origin}; pick the most representative pages.`,
      )
    }
    perOrigin.set(url.origin, count + 1)
    url.hash = ''
    output.push(url.toString())
  }
  return output
}

export function captureSlug(raw: string): string {
  const url = new URL(raw)
  const slug = `${url.host}${url.pathname}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'reference'
}

export async function capture(options: { root: string; urls: string[] }): Promise<void> {
  const project = await loadProject(options.root)
  const urls = resolveCaptureUrls(project.designReferences, options.urls)
  const playwright = await ensurePlaywright()
  const outputRoot = join(options.root, '.doxloop', 'cache', 'reference')

  const browser = await playwright.chromium.launch()
  try {
    for (const url of urls) {
      const expectedOrigin = new URL(url).origin
      const networkCache = new Map<string, Promise<void>>()
      await assertPublicNetworkUrl(url, networkCache)
      const directory = join(outputRoot, captureSlug(url))
      await mkdir(directory, { recursive: true })
      const pages: Array<Record<string, unknown>> = []
      for (const scheme of COLOR_SCHEMES) {
        for (const viewport of VIEWPORTS) {
          const context = await browser.newContext({
            viewport: { width: viewport.width, height: viewport.height },
            colorScheme: scheme,
            deviceScaleFactor: 2,
          })
          try {
            const page = await context.newPage()
            let blockedError: Error | undefined
            await page.route('**/*', async (route) => {
              const request = route.request()
              try {
                const requestUrl = new URL(request.url())
                if (
                  request.isNavigationRequest() &&
                  requestUrl.origin !== expectedOrigin
                ) {
                  throw new DoxloopError(
                    `Reference capture navigation left the configured origin: ${requestUrl.origin}`,
                  )
                }
                await assertPublicNetworkUrl(requestUrl.toString(), networkCache)
                await route.continue()
              } catch (error) {
                blockedError =
                  error instanceof Error ? error : new Error(String(error))
                await route.abort('blockedbyclient')
              }
            })
            let response: { url(): string } | null
            try {
              response = await page.goto(url, {
                waitUntil: 'load',
                timeout: 45_000,
              })
            } catch (error) {
              if (blockedError) throw blockedError
              throw error
            }
            if (blockedError) throw blockedError
            const finalUrl = response?.url() ?? page.url()
            if (new URL(finalUrl).origin !== expectedOrigin) {
              throw new DoxloopError(
                `Reference capture redirected outside ${expectedOrigin}.`,
              )
            }
            await page.waitForTimeout(1_500)
            if (blockedError) throw blockedError
            const screenshot = join(directory, `${viewport.name}-${scheme}.png`)
            await page.screenshot({ path: screenshot, fullPage: true })
            pages.push({
              viewport: viewport.name,
              colorScheme: scheme,
              screenshot: `${viewport.name}-${scheme}.png`,
              ...(viewport.name === 'desktop' ? await extractStyles(page) : {}),
            })
            process.stdout.write(`captured ${viewport.name} ${scheme}: ${screenshot}\n`)
          } finally {
            await context.close()
          }
        }
      }
      await writeFile(
        join(directory, 'capture.json'),
        `${JSON.stringify(
          { version: 1, url, capturedAt: new Date().toISOString(), states: pages },
          null,
          2,
        )}\n`,
        'utf8',
      )
      process.stdout.write(`measured styles: ${join(directory, 'capture.json')}\n`)
    }
  } finally {
    await browser.close()
  }
  process.stdout.write(
    `Captured ${urls.length} page${urls.length === 1 ? '' : 's'} to .doxloop/cache/reference/ (Git-ignored; treat as local evidence only).\n`,
  )
}

async function assertPublicNetworkUrl(
  raw: string,
  cache: Map<string, Promise<void>>,
): Promise<void> {
  const url = new URL(raw)
  if (!['http:', 'https:'].includes(url.protocol)) return
  if (process.env.DOXLOOP_ALLOW_PRIVATE_REFERENCES === '1') return
  const key = url.hostname.toLowerCase()
  let pending = cache.get(key)
  if (!pending) {
    pending = assertPublicHostname(url.hostname)
    cache.set(key, pending)
  }
  return pending
}

async function assertPublicHostname(hostname: string): Promise<void> {
  const normalized = hostname.replace(/^\[|\]$/g, '')
  const addresses =
    isIP(normalized) > 0
      ? [normalized]
      : (await lookup(normalized, { all: true, verbatim: true })).map(
          (entry) => entry.address,
        )
  if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
    throw new DoxloopError(
      `Reference capture blocked a private or non-public host: ${hostname}. Set DOXLOOP_ALLOW_PRIVATE_REFERENCES=1 only for a trusted local reference.`,
      2,
    )
  }
}

export function isPrivateAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a = 0, b = 0, c = 0] = address.split('.').map(Number)
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 0 || b === 168)) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113) ||
      a >= 224
    )
  }
  const normalized = address.toLowerCase()
  if (normalized.startsWith('::ffff:')) {
    return isPrivateAddress(normalized.slice('::ffff:'.length))
  }
  return (
    normalized === '::' ||
    normalized === '::1' ||
    /^f[cd]/.test(normalized) ||
    /^fe[89ab]/.test(normalized) ||
    normalized.startsWith('ff') ||
    normalized.startsWith('2001:db8:')
  )
}

// The script is a plain string so build tooling can never inject helper
// identifiers (such as esbuild's __name) that do not exist inside the page.
const EXTRACT_SCRIPT = String.raw`(() => {
  const rootVariables = {}
  for (const sheet of Array.from(document.styleSheets)) {
    let rules
    try {
      rules = sheet.cssRules
    } catch {
      continue
    }
    for (const rule of Array.from(rules)) {
      if (
        rule instanceof CSSStyleRule &&
        /(^|,)\s*(:root|html|body)\s*($|,)/.test(rule.selectorText)
      ) {
        for (const name of Array.from(rule.style)) {
          if (name.startsWith('--')) {
            rootVariables[name] = rule.style.getPropertyValue(name).trim()
          }
        }
      }
    }
  }
  const pick = (element) => {
    if (!element) return undefined
    const style = getComputedStyle(element)
    return {
      fontFamily: style.fontFamily,
      fontSize: style.fontSize,
      fontWeight: style.fontWeight,
      lineHeight: style.lineHeight,
      letterSpacing: style.letterSpacing,
      color: style.color,
      backgroundColor: style.backgroundColor,
    }
  }
  const query = (selector) => pick(document.querySelector(selector))
  const main = document.querySelector('main, article, [role="main"]')
  return {
    title: document.title,
    rootVariables,
    elements: {
      body: pick(document.body),
      h1: query('h1'),
      h2: query('h2'),
      h3: query('h3'),
      paragraph: query('main p, article p, p'),
      link: query('main a[href], article a[href], a[href]'),
      code: query('code'),
      pre: query('pre'),
    },
    layout: {
      contentWidth: main ? Math.round(main.getBoundingClientRect().width) : undefined,
      viewportWidth: window.innerWidth,
    },
  }
})()`

async function extractStyles(page: PlaywrightPage): Promise<Record<string, unknown>> {
  return page.evaluate(EXTRACT_SCRIPT)
}

export async function ensurePlaywright(): Promise<PlaywrightModule> {
  const directory = toolsDir()
  const entry = join(directory, 'node_modules', 'playwright', 'index.js')
  const browserSentinel = join(directory, '.chromium-ready')

  if (!(await pathExists(entry))) {
    process.stdout.write(
      'Installing the managed capture browser (Playwright + Chromium, one-time download of a few hundred MB)...\n',
    )
    await mkdir(directory, { recursive: true })
    if (!(await pathExists(join(directory, 'package.json')))) {
      await writeFile(
        join(directory, 'package.json'),
        `${JSON.stringify({ name: 'doxloop-tools', private: true }, null, 2)}\n`,
        'utf8',
      )
    }
    await runTool(directory, npmCommand(), ['install', '--no-fund', '--no-audit', PLAYWRIGHT_SPEC])
  }
  if (!(await pathExists(browserSentinel))) {
    await runTool(directory, process.execPath, [
      join(directory, 'node_modules', 'playwright', 'cli.js'),
      'install',
      'chromium',
    ])
    await writeFile(browserSentinel, `${new Date().toISOString()}\n`, 'utf8')
  }

  const loaded = (await import(pathToFileURL(entry).href)) as
    | PlaywrightModule
    | { default: PlaywrightModule }
  const playwright = 'chromium' in loaded ? loaded : loaded.default
  if (!playwright?.chromium) {
    throw new DoxloopError(
      `The managed Playwright installation at ${directory} is unusable. Delete the directory and run \`doxloop capture\` again.`,
    )
  }
  return playwright
}

function npmCommand(): string {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm'
}

async function runTool(cwd: string, command: string, args: string[]): Promise<void> {
  const exitCode = await new Promise<number>((resolveExit, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', (code) => resolveExit(code ?? 1))
  })
  if (exitCode !== 0) {
    throw new DoxloopError(
      `\`${command} ${args.join(' ')}\` failed with exit code ${exitCode}. Fix the reported problem and run \`doxloop capture\` again.`,
    )
  }
}
