import { createHash } from 'node:crypto'
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { DoxloopError } from './errors.js'
import { pathExists } from './fs.js'

/**
 * Sign-in material for the screenshot capture browser.
 *
 * Applications that need a signed-in user can be documented in two ways:
 * a recorded browser session (cookies and local storage saved after the user
 * signs in by hand in a visible Chrome window) or saved credentials the agent
 * types into the sign-in form through the capture server's secret store.
 * Neither is written into the project: both live under the user's Doxloop
 * config home, keyed by the project root, with owner-only permissions.
 */

export const CAPTURE_USERNAME_SECRET = 'DOXLOOP_APP_USERNAME'
export const CAPTURE_PASSWORD_SECRET = 'DOXLOOP_APP_PASSWORD'

export interface StorageStateCookie {
  name: string
  value: string
  domain: string
  path: string
  expires?: number
  httpOnly?: boolean
  secure?: boolean
  sameSite?: 'Strict' | 'Lax' | 'None'
}

/** The Playwright storage-state shape the capture server reads back. */
export interface CaptureStorageState {
  cookies: StorageStateCookie[]
  origins: Array<{ origin: string; localStorage: Array<{ name: string; value: string }> }>
}

export interface CaptureCredentials {
  username: string
  password: string
}

export interface StoredCaptureSession {
  savedAt: string
  origin: string
  state: CaptureStorageState
}

export interface CaptureAuthStatus {
  credentials?: { username: string; savedAt: string }
  session?: { savedAt: string; origin: string; cookies: number; origins: number }
}

/** What the readiness check and prompts need to know, without the secrets. */
export interface CaptureAuthContext {
  session?: CaptureStorageState
  credentials: boolean
}

export interface CaptureAuthMaterial {
  /** Playwright storage-state file passed to the capture server, when a session is saved. */
  storageStatePath?: string
  /** dotenv secrets file passed to the capture server, when credentials are saved. */
  secretsPath?: string
  /** Delete the per-run secrets file. The storage state stays for the next run. */
  cleanup(): Promise<void>
}

interface StoredCredentials extends CaptureCredentials {
  savedAt: string
}

export function captureAuthDirectory(root: string): string {
  const key = createHash('sha256').update(resolve(root)).digest('hex').slice(0, 20)
  const home = process.env.DOXLOOP_CONFIG_HOME ?? join(homedir(), '.config', 'doxloop')
  return join(home, 'capture-auth', key)
}

export async function saveCaptureCredentials(root: string, credentials: CaptureCredentials): Promise<void> {
  const username = credentials.username.trim()
  const password = credentials.password
  if (!username) throw new DoxloopError('Enter the sign-in username or email.')
  if (!password) throw new DoxloopError('Enter the sign-in password.')
  if (/[\r\n]/.test(username)) throw new DoxloopError('The sign-in username cannot span lines.')
  const stored: StoredCredentials = { username, password, savedAt: new Date().toISOString() }
  await writePrivateFile(join(captureAuthDirectory(root), 'credentials.json'), JSON.stringify(stored, null, 2))
}

export async function removeCaptureCredentials(root: string): Promise<void> {
  await rm(join(captureAuthDirectory(root), 'credentials.json'), { force: true })
}

export async function loadCaptureCredentials(root: string): Promise<StoredCredentials | undefined> {
  const parsed = await readPrivateJson<Partial<StoredCredentials>>(join(captureAuthDirectory(root), 'credentials.json'))
  if (!parsed || typeof parsed.username !== 'string' || typeof parsed.password !== 'string') return undefined
  return { username: parsed.username, password: parsed.password, savedAt: typeof parsed.savedAt === 'string' ? parsed.savedAt : '' }
}

export async function saveCaptureSession(root: string, origin: string, state: CaptureStorageState): Promise<StoredCaptureSession> {
  if (!isStorageState(state)) throw new DoxloopError('The browser did not return a usable session.')
  if (state.cookies.length === 0 && state.origins.every((item) => item.localStorage.length === 0)) {
    throw new DoxloopError('The browser session holds no cookies or local storage yet. Complete the sign-in in the Chrome window before saving.')
  }
  const stored: StoredCaptureSession = { savedAt: new Date().toISOString(), origin, state }
  await writePrivateFile(join(captureAuthDirectory(root), 'session.json'), JSON.stringify(stored, null, 2))
  return stored
}

export async function removeCaptureSession(root: string): Promise<void> {
  const directory = captureAuthDirectory(root)
  await Promise.all([
    rm(join(directory, 'session.json'), { force: true }),
    rm(join(directory, 'storage-state.json'), { force: true }),
  ])
}

export async function loadCaptureSession(root: string): Promise<StoredCaptureSession | undefined> {
  const parsed = await readPrivateJson<Partial<StoredCaptureSession>>(join(captureAuthDirectory(root), 'session.json'))
  if (!parsed || !isStorageState(parsed.state)) return undefined
  return {
    savedAt: typeof parsed.savedAt === 'string' ? parsed.savedAt : '',
    origin: typeof parsed.origin === 'string' ? parsed.origin : '',
    state: parsed.state,
  }
}

export async function captureAuthStatus(root: string): Promise<CaptureAuthStatus> {
  const [credentials, session] = await Promise.all([loadCaptureCredentials(root), loadCaptureSession(root)])
  return {
    ...(credentials ? { credentials: { username: credentials.username, savedAt: credentials.savedAt } } : {}),
    ...(session ? { session: { savedAt: session.savedAt, origin: session.origin, cookies: session.state.cookies.length, origins: session.state.origins.length } } : {}),
  }
}

export async function captureAuthContext(root: string): Promise<CaptureAuthContext> {
  const [credentials, session] = await Promise.all([loadCaptureCredentials(root), loadCaptureSession(root)])
  return { ...(session ? { session: session.state } : {}), credentials: Boolean(credentials) }
}

/**
 * Materialize the saved sign-in for one capture run. The storage state is
 * rewritten from the stored session so the file the browser reads is always
 * the plain Playwright shape; the secrets file exists only while the run does.
 */
export async function prepareCaptureAuth(root: string): Promise<CaptureAuthMaterial | undefined> {
  const [credentials, session] = await Promise.all([loadCaptureCredentials(root), loadCaptureSession(root)])
  if (!credentials && !session) return undefined
  const directory = captureAuthDirectory(root)
  const material: CaptureAuthMaterial = { cleanup: async () => {} }
  if (session) {
    const path = join(directory, 'storage-state.json')
    await writePrivateFile(path, JSON.stringify(session.state))
    material.storageStatePath = path
  }
  if (credentials) {
    const path = join(directory, `secrets-${process.pid}-${Date.now()}.env`)
    await writePrivateFile(path, `${CAPTURE_USERNAME_SECRET}=${dotenvValue(credentials.username)}\n${CAPTURE_PASSWORD_SECRET}=${dotenvValue(credentials.password)}\n`)
    material.secretsPath = path
    material.cleanup = () => rm(path, { force: true })
  }
  return material
}

/**
 * The readiness probe is a plain HTTP request, so it carries the session
 * cookies the browser would send for the URL: matching domain, matching path
 * prefix, not expired, and not secure-only on a plain HTTP page.
 */
export function sessionCookieHeader(state: CaptureStorageState | undefined, url: string): string | undefined {
  if (!state) return undefined
  const target = new URL(url)
  const now = Date.now() / 1000
  const pairs = state.cookies
    .filter((cookie) => cookieMatchesHost(cookie.domain, target.hostname))
    .filter((cookie) => target.pathname.startsWith(cookie.path || '/'))
    .filter((cookie) => cookie.expires === undefined || cookie.expires < 0 || cookie.expires > now)
    .filter((cookie) => !cookie.secure || target.protocol === 'https:' || target.hostname === 'localhost' || target.hostname === '127.0.0.1')
    .map((cookie) => `${cookie.name}=${cookie.value}`)
  return pairs.length > 0 ? pairs.join('; ') : undefined
}

export type CaptureAuthMode = 'none' | 'session' | 'credentials' | 'both'

export function describeCaptureAuth(context: CaptureAuthContext | CaptureAuthStatus | undefined): CaptureAuthMode {
  if (!context) return 'none'
  const session = Boolean(context.session)
  const credentials = 'credentials' in context && Boolean(context.credentials)
  if (session && credentials) return 'both'
  if (session) return 'session'
  if (credentials) return 'credentials'
  return 'none'
}

function cookieMatchesHost(domain: string, hostname: string): boolean {
  const normalized = domain.startsWith('.') ? domain.slice(1) : domain
  return hostname === normalized || hostname.endsWith(`.${normalized}`)
}

function dotenvValue(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r')}"`
}

function isStorageState(value: unknown): value is CaptureStorageState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const state = value as Partial<CaptureStorageState>
  return Array.isArray(state.cookies) && Array.isArray(state.origins)
}

async function writePrivateFile(path: string, content: string): Promise<void> {
  const directory = join(path, '..')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await writeFile(path, `${content}\n`, { encoding: 'utf8', mode: 0o600 })
  if (process.platform !== 'win32') {
    await chmod(directory, 0o700)
    await chmod(path, 0o600)
  }
}

async function readPrivateJson<T>(path: string): Promise<T | undefined> {
  if (!(await pathExists(path))) return undefined
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch {
    throw new DoxloopError(`Cannot read the saved capture sign-in at ${path}. Remove the file and save it again.`)
  }
}
