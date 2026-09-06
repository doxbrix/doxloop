import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { CaptureAuthMaterial, CaptureStorageState } from './capture-auth.js'
import { DoxloopError } from './errors.js'
import type { ApplicationConfig } from './types.js'

export const SCREEN_CAPTURE_SERVER = 'doxloop_capture'

export interface ScreenCaptureProvider {
  name: typeof SCREEN_CAPTURE_SERVER
  command: string
  args: string[]
}

export interface ScreenCaptureBrowserReadiness {
  available: boolean
  message: string
}

/** Launch the same Chrome channel used by the MCP server, then close it. */
export async function checkScreenCaptureBrowser(): Promise<ScreenCaptureBrowserReadiness> {
  try {
    const chromium = await loadChromium()
    const browser = await chromium.launch({ channel: 'chrome', headless: true, timeout: 15_000 })
    await browser.close()
    return { available: true, message: 'The Doxloop capture browser started successfully.' }
  } catch (cause) {
    return {
      available: false,
      message: `The Doxloop capture browser could not start. Install Google Chrome and retry. ${cause instanceof Error ? cause.message.split('\n')[0] : String(cause)}`,
    }
  }
}

/** The Playwright bundled with the MCP server, so the sign-in window matches the capture browser. */
async function loadChromium(): Promise<BrowserType> {
  const require = createRequire(import.meta.url)
  const packageJson = require.resolve('@playwright/mcp/package.json')
  const playwrightPath = createRequire(packageJson).resolve('playwright')
  const imported = await import(pathToFileURL(playwrightPath).href) as {
    default?: { chromium?: BrowserType }
    chromium?: BrowserType
  }
  const chromium = imported.chromium ?? imported.default?.chromium
  if (!chromium) throw new Error('Playwright did not expose Chromium.')
  return chromium
}

interface BrowserType {
  launch(options: { channel: string; headless: boolean; timeout: number }): Promise<Browser>
}

interface Browser {
  close(): Promise<void>
  isConnected(): boolean
  on(event: 'disconnected', listener: () => void): unknown
  newContext(options: { viewport: { width: number; height: number } }): Promise<BrowserContext>
}

interface BrowserContext {
  newPage(): Promise<Page>
  storageState(): Promise<CaptureStorageState>
  pages(): Page[]
}

interface Page {
  goto(url: string, options?: { waitUntil?: 'commit' | 'load' | 'domcontentloaded'; timeout?: number }): Promise<unknown>
  url(): string
}

export interface CaptureSignInSession {
  /** The page the window opened on. */
  url: string
  /** Where the user currently is, or the last known page once the window closed. */
  currentUrl(): string
  /** Whether the Chrome window is still open. */
  open(): boolean
  /** Snapshot cookies and local storage now, or return the last snapshot if the window has closed. */
  state(): Promise<CaptureStorageState | undefined>
  /** Snapshot the session and close the window. */
  finish(): Promise<CaptureStorageState>
  /** Close the window without keeping anything. */
  cancel(): Promise<void>
}

/**
 * Open a visible Chrome window on the application's sign-in page so the user
 * can authenticate by hand, including MFA, SSO, and passkeys. The session is
 * snapshotted every couple of seconds while the window is open, so closing
 * the window early still leaves the last signed-in state to save.
 */
export async function startCaptureSignIn(application: ApplicationConfig): Promise<CaptureSignInSession> {
  const viewport = application.screenshots?.viewport ?? { width: 1440, height: 900 }
  const path = application.authentication?.loginPath ?? application.screenshots?.startPath ?? application.readyPath ?? '/'
  const url = new URL(path, application.baseUrl).toString()
  let chromium: BrowserType
  try {
    chromium = await loadChromium()
  } catch (cause) {
    throw new DoxloopError(`The sign-in browser could not load: ${cause instanceof Error ? cause.message.split('\n')[0] : String(cause)}`)
  }
  let browser: Browser
  try {
    browser = await chromium.launch({ channel: 'chrome', headless: false, timeout: 20_000 })
  } catch (cause) {
    throw new DoxloopError(`The sign-in browser could not start. Install Google Chrome and retry. ${cause instanceof Error ? cause.message.split('\n')[0] : String(cause)}`)
  }
  const context = await browser.newContext({ viewport })
  const page = await context.newPage()
  let latest: CaptureStorageState | undefined
  let lastUrl = url
  let connected = true
  const snapshot = async (): Promise<CaptureStorageState | undefined> => {
    if (!connected) return latest
    try {
      const pages = context.pages()
      const active = pages[pages.length - 1]
      if (active) lastUrl = active.url()
      latest = await context.storageState()
    } catch {
      // The window is closing; keep the previous snapshot.
    }
    return latest
  }
  const timer = setInterval(() => { void snapshot() }, 2_000)
  timer.unref?.()
  browser.on('disconnected', () => {
    connected = false
    clearInterval(timer)
  })
  const close = async (): Promise<void> => {
    clearInterval(timer)
    if (!connected) return
    connected = false
    try { await browser.close() } catch { /* Already gone. */ }
  }
  try {
    await page.goto(url, { waitUntil: 'commit', timeout: 30_000 })
  } catch (cause) {
    await close()
    throw new DoxloopError(`The sign-in page could not be opened: ${cause instanceof Error ? cause.message.split('\n')[0] : String(cause)}`)
  }
  return {
    url,
    currentUrl: () => lastUrl,
    open: () => connected && browser.isConnected(),
    state: snapshot,
    finish: async () => {
      const state = await snapshot()
      await close()
      if (!state) throw new DoxloopError('The sign-in window closed before a session could be read. Start the sign-in again.')
      return state
    },
    cancel: close,
  }
}

/**
 * Build a private Playwright MCP server for one authoring run. The server is
 * passed directly to the selected agent, so users do not have to install or
 * configure a browser plugin in Codex or Claude Code themselves.
 */
export function screenCaptureProvider(
  workspace: string,
  application: ApplicationConfig,
  auth?: Pick<CaptureAuthMaterial, 'storageStatePath' | 'secretsPath'>,
): ScreenCaptureProvider {
  const require = createRequire(import.meta.url)
  const packageJson = require.resolve('@playwright/mcp/package.json')
  const viewport = application.screenshots?.viewport ?? { width: 1440, height: 900 }

  return {
    name: SCREEN_CAPTURE_SERVER,
    command: process.execPath,
    args: [
      join(dirname(packageJson), 'cli.js'),
      '--headless',
      '--browser',
      'chrome',
      '--isolated',
      '--output-dir',
      join(resolve(workspace), '.doxloop', 'capture-output'),
      '--viewport-size',
      `${viewport.width}x${viewport.height}`,
      '--timeout-action',
      '10000',
      '--timeout-navigation',
      '60000',
      // A recorded sign-in session seeds the isolated profile, so the agent
      // lands on the signed-in application instead of its login page.
      ...(auth?.storageStatePath ? ['--storage-state', auth.storageStatePath] : []),
      // Saved credentials are typed by name: the agent passes the secret's
      // name to the type or fill tool and the server substitutes the value,
      // then redacts it from every tool response.
      ...(auth?.secretsPath ? ['--secrets', auth.secretsPath] : []),
    ],
  }
}

export function codexCaptureArguments(provider: ScreenCaptureProvider, required: boolean): string[] {
  const prefix = `mcp_servers.${provider.name}`
  return [
    '-c',
    `${prefix}.command=${JSON.stringify(provider.command)}`,
    '-c',
    `${prefix}.args=${JSON.stringify(provider.args)}`,
    '-c',
    `${prefix}.startup_timeout_sec=20`,
    '-c',
    `${prefix}.required=${required}`,
    '-c',
    `${prefix}.default_tools_approval_mode="approve"`,
  ]
}

export function claudeCaptureArguments(provider: ScreenCaptureProvider): string[] {
  return [
    '--mcp-config',
    JSON.stringify({
      mcpServers: {
        [provider.name]: {
          type: 'stdio',
          command: provider.command,
          args: provider.args,
        },
      },
    }),
  ]
}

/**
 * Gemini CLI has no flag for a one-off MCP server: it reads `mcpServers` from
 * the project's `.gemini/settings.json`. Merge the run's capture server into
 * that file, keeping every other setting the user has there. `trust` lets the
 * capture tools run without a confirmation Gemini cannot get unattended.
 */
export async function writeGeminiCaptureSettings(root: string, provider: ScreenCaptureProvider): Promise<string> {
  const directory = join(root, '.gemini')
  const path = join(directory, 'settings.json')
  await mkdir(directory, { recursive: true })
  let settings: Record<string, unknown> = {}
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) settings = parsed as Record<string, unknown>
  } catch {
    // A missing or unreadable file starts from an empty object.
  }
  const existing = settings.mcpServers
  const servers = existing && typeof existing === 'object' && !Array.isArray(existing) ? { ...(existing as Record<string, unknown>) } : {}
  servers[provider.name] = geminiCaptureServer(provider)
  settings.mcpServers = servers
  await writeFile(path, `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
  return path
}

export function geminiCaptureServer(provider: ScreenCaptureProvider): Record<string, unknown> {
  return {
    command: provider.command,
    args: provider.args,
    timeout: 20_000,
    trust: true,
  }
}
