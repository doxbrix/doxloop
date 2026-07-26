import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, hostname } from 'node:os'
import { dirname, join } from 'node:path'
import { spawn } from 'node:child_process'
import { DoxloopError } from './errors.js'
import { pathExists } from './fs.js'

const DEFAULT_API_URL = 'https://app.doxbrix.com'
const TOKEN_PREFIX = 'dxb_'
const DEVICE_SCOPES = ['docs:read', 'docs:write', 'project:read', 'project:admin']

interface UserConfig {
  apiUrl: string
  token?: string
}

interface DeviceStart {
  deviceCode: string
  userCode: string
  verificationUri: string
  expiresIn: number
  interval: number
}

type DevicePoll =
  | { status: 'pending' }
  | { status: 'approved'; token: string }
  | { status: 'expired' }

interface CurrentUser {
  id: string
  email: string
  name: string | null
}

export function apiUrl(override?: string): string {
  const raw = override ?? process.env.DOXLOOP_API_URL ?? DEFAULT_API_URL
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new DoxloopError(`Invalid Doxbrix API URL: ${raw}`, 2)
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new DoxloopError(
      'The Doxbrix API URL cannot contain credentials, a query, or a fragment.',
      2,
    )
  }
  if (
    parsed.protocol !== 'https:' &&
    !(parsed.protocol === 'http:' && isLoopbackHost(parsed.hostname))
  ) {
    throw new DoxloopError(
      'The Doxbrix API URL must use HTTPS. HTTP is allowed only for localhost development.',
      2,
    )
  }
  return parsed.toString().replace(/\/+$/, '')
}

export async function loadUserConfig(): Promise<UserConfig> {
  const path = configPath()
  if (!(await pathExists(path))) return { apiUrl: apiUrl() }
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as UserConfig
    return { apiUrl: apiUrl(parsed.apiUrl), ...(parsed.token ? { token: parsed.token } : {}) }
  } catch {
    throw new DoxloopError(`Cannot read Doxloop credentials at ${path}.`)
  }
}

export async function saveToken(token: string, baseUrl: string): Promise<void> {
  const path = configPath()
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await writeFile(path, `${JSON.stringify({ apiUrl: baseUrl, token }, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  })
  if (process.platform !== 'win32') await chmod(path, 0o600)
}

export async function logout(): Promise<void> {
  await rm(configPath(), { force: true })
}

export async function login(options: {
  apiUrl?: string
  token?: string
}): Promise<void> {
  const baseUrl = apiUrl(options.apiUrl)
  const directToken = options.token ?? process.env.DOXLOOP_TOKEN ?? process.env.DOXBRIX_TOKEN
  if (directToken) {
    await verifyAndSaveToken(baseUrl, directToken)
    return
  }

  let start: DeviceStart | undefined
  try {
    start = await requestJson<DeviceStart>(`${baseUrl}/api/v1/auth/device/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: `doxloop @ ${hostname()}`, scopes: DEVICE_SCOPES }),
    })
  } catch {
    // The server may not offer the device flow; fall back to token paste.
    start = undefined
  }
  if (!start) {
    process.stdout.write(
      `Browser sign-in is unavailable.\nCreate a token at ${baseUrl}/settings/tokens and paste it below.\n`,
    )
    if (!process.stdin.isTTY) {
      throw new DoxloopError('Pass --token dxb_… (stdin is not a TTY).')
    }
    await verifyAndSaveToken(baseUrl, await readSecret('Token: '))
    return
  }
  process.stdout.write(`Open ${start.verificationUri}\nEnter code: ${start.userCode}\n`)
  openBrowser(`${start.verificationUri}?code=${encodeURIComponent(start.userCode)}`)

  const deadline = Date.now() + start.expiresIn * 1000
  while (Date.now() < deadline) {
    await delay(Math.max(2, start.interval) * 1000)
    let poll: DevicePoll
    try {
      poll = await requestJson<DevicePoll>(`${baseUrl}/api/v1/auth/device/poll`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceCode: start.deviceCode }),
      })
    } catch {
      continue
    }
    if (poll.status === 'expired') break
    if (poll.status === 'approved') {
      await verifyAndSaveToken(baseUrl, poll.token)
      return
    }
  }
  throw new DoxloopError('Doxbrix authorization expired. Run `doxloop login` again.')
}

async function verifyAndSaveToken(baseUrl: string, token: string): Promise<void> {
  if (!token.startsWith(TOKEN_PREFIX)) {
    throw new DoxloopError(
      `That does not look like a Doxbrix token (expected a "${TOKEN_PREFIX}" prefix). Create one in the Doxbrix web app under Settings > Tokens.`,
    )
  }
  const user = await verifyToken(baseUrl, token)
  await saveToken(token, baseUrl)
  process.stdout.write(`Signed in to Doxbrix as ${user.email}.\n`)
}

function readSecret(promptText: string): Promise<string> {
  process.stdout.write(promptText)
  return new Promise((resolveSecret, reject) => {
    const stdin = process.stdin
    stdin.setRawMode(true)
    stdin.resume()
    stdin.setEncoding('utf8')
    let value = ''
    const cleanup = (): void => {
      stdin.setRawMode(false)
      stdin.pause()
      stdin.off('data', onData)
    }
    const onData = (chunk: string): void => {
      for (const character of chunk) {
        if (character === '\u0003') {
          cleanup()
          process.stdout.write('\n')
          reject(new DoxloopError('Sign-in cancelled.'))
          return
        }
        if (character === '\r' || character === '\n') {
          cleanup()
          process.stdout.write('\n')
          resolveSecret(value.trim())
          return
        }
        if (character === '\u007f' || character === '\b') {
          value = value.slice(0, -1)
          continue
        }
        value += character
      }
    }
    stdin.on('data', onData)
  })
}

async function verifyToken(baseUrl: string, token: string): Promise<CurrentUser> {
  try {
    return await requestJson<CurrentUser>(`${baseUrl}/api/v1/me`, {
      headers: { Authorization: `Bearer ${token}` },
    })
  } catch {
    throw new DoxloopError(
      'That token was rejected by the API. Check the token and --api-url, then try again.',
    )
  }
}

export async function whoami(override?: string): Promise<void> {
  const config = await loadUserConfig()
  const token = config.token ?? process.env.DOXLOOP_TOKEN ?? process.env.DOXBRIX_TOKEN
  if (!token) throw new DoxloopError('Not signed in. Run `doxloop login`.')
  const account = await requestJson<CurrentUser>(
    `${apiUrl(override ?? config.apiUrl)}/api/v1/me`,
    { headers: { Authorization: `Bearer ${token}` } },
  )
  process.stdout.write(`${account.email}${account.name ? ` (${account.name})` : ''}\n`)
}

export async function authenticatedRequest<T>(
  path: string,
  init: RequestInit,
  override?: string,
): Promise<T> {
  const result = await authenticatedRequestInternal<T>(path, init, override, false)
  return result as T
}

export async function authenticatedRequestOptional<T>(
  path: string,
  init: RequestInit,
  override?: string,
): Promise<T | undefined> {
  return authenticatedRequestInternal<T>(path, init, override, true)
}

async function authenticatedRequestInternal<T>(
  path: string,
  init: RequestInit,
  override: string | undefined,
  allowNotFound: boolean,
): Promise<T | undefined> {
  const config = await loadUserConfig()
  const token = config.token ?? process.env.DOXLOOP_TOKEN ?? process.env.DOXBRIX_TOKEN
  if (!token) throw new DoxloopError('Not signed in. Run `doxloop login` first.')
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${token}`)
  const url = `${apiUrl(override ?? config.apiUrl)}${path}`
  let response: Response
  try {
    response = await fetch(url, { ...init, headers, redirect: 'error' })
  } catch (error) {
    throw new DoxloopError(
      `Cannot connect to ${new URL(url).origin}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (allowNotFound && response.status === 404) return undefined
  if (!response.ok) throw await responseError(response, init.method, url)
  return (await response.json()) as T
}

async function requestJson<T>(url: string, init: RequestInit): Promise<T> {
  let response: Response
  try {
    response = await fetch(url, { ...init, redirect: 'error' })
  } catch (error) {
    throw new DoxloopError(
      `Cannot connect to ${new URL(url).origin}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (!response.ok) throw await responseError(response, init.method, url)
  return (await response.json()) as T
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  return (
    normalized === 'localhost' ||
    normalized === '::1' ||
    /^127(?:\.\d{1,3}){3}$/.test(normalized)
  )
}

async function responseError(
  response: Response,
  method = 'GET',
  url?: string,
): Promise<DoxloopError> {
  let message = `${response.status} ${response.statusText}`
  let code: string | undefined
  let details: unknown
  let requestId = response.headers.get('x-request-id') ?? undefined
  try {
    const body = (await response.json()) as {
      error?: { message?: string } | string
      message?: string
      code?: string
      details?: unknown
      requestId?: string
    }
    if (typeof body.error === 'string') message = body.error
    else if (body.error?.message) message = body.error.message
    else if (body.message) message = body.message
    code = body.code
    details = body.details
    requestId = body.requestId ?? requestId
  } catch {
    // Keep the HTTP status when the response is not JSON.
  }
  const operation = formatApiOperation(method, url)
  const status = `${response.status}${response.statusText ? ` ${response.statusText}` : ''}`
  const lines = [
    `Doxbrix API error: ${operation} returned ${status}${code ? ` [${code}]` : ''}`,
    message,
  ]
  if (details !== undefined) lines.push(`Details: ${formatErrorDetails(details)}`)
  if (requestId) {
    lines.push(`Request ID: ${requestId}`)
    if (code === 'internal_error' && details === undefined) {
      lines.push('The underlying exception is recorded in the Doxbrix server logs under this request ID.')
    }
  }
  return new DoxloopError(lines.join('\n'))
}

function formatApiOperation(method: string | undefined, url: string | undefined): string {
  let target = url ?? 'Doxbrix API'
  if (url) {
    try {
      const parsed = new URL(url)
      target = `${parsed.pathname}${parsed.search}`
    } catch {
      // Keep the supplied target when it is not a valid URL.
    }
  }
  return `${method?.toUpperCase() || 'GET'} ${target}`
}

function formatErrorDetails(details: unknown): string {
  if (typeof details === 'string') return details
  try {
    return JSON.stringify(details)
  } catch {
    return String(details)
  }
}

function configPath(): string {
  if (process.platform === 'win32') {
    return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'doxloop', 'config.json')
  }
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'doxloop', 'config.json')
}

function openBrowser(url: string): void {
  const command =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open'
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url]
  const child = spawn(command, args, { detached: true, stdio: 'ignore' })
  child.unref()
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds))
}
