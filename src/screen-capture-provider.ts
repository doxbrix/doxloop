import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
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
    const require = createRequire(import.meta.url)
    const packageJson = require.resolve('@playwright/mcp/package.json')
    const playwrightPath = createRequire(packageJson).resolve('playwright')
    const imported = await import(pathToFileURL(playwrightPath).href) as {
      default?: { chromium?: BrowserType }
      chromium?: BrowserType
    }
    const chromium = imported.chromium ?? imported.default?.chromium
    if (!chromium) throw new Error('Playwright did not expose Chromium.')
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

interface BrowserType {
  launch(options: { channel: string; headless: boolean; timeout: number }): Promise<{ close(): Promise<void> }>
}

/**
 * Build a private Playwright MCP server for one authoring run. The server is
 * passed directly to the selected agent, so users do not have to install or
 * configure a browser plugin in Codex or Claude Code themselves.
 */
export function screenCaptureProvider(
  workspace: string,
  application: ApplicationConfig,
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
