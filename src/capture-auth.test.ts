import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
  CAPTURE_PASSWORD_SECRET,
  CAPTURE_USERNAME_SECRET,
  captureAuthContext,
  captureAuthDirectory,
  captureAuthStatus,
  describeCaptureAuth,
  loadCaptureCredentials,
  prepareCaptureAuth,
  removeCaptureCredentials,
  removeCaptureSession,
  saveCaptureCredentials,
  saveCaptureSession,
  sessionCookieHeader,
} from './capture-auth.js'

const roots: string[] = []
let previousHome: string | undefined

beforeEach(async () => {
  previousHome = process.env.DOXLOOP_CONFIG_HOME
  const home = await mkdtemp(join(tmpdir(), 'doxloop-config-'))
  roots.push(home)
  process.env.DOXLOOP_CONFIG_HOME = home
})

afterEach(async () => {
  if (previousHome === undefined) delete process.env.DOXLOOP_CONFIG_HOME
  else process.env.DOXLOOP_CONFIG_HOME = previousHome
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const state = {
  cookies: [
    { name: 'sid', value: 'abc', domain: 'localhost', path: '/', expires: -1, httpOnly: true, secure: false, sameSite: 'Lax' as const },
    { name: 'pref', value: 'dark', domain: '.example.com', path: '/app', expires: Date.now() / 1000 + 3600, secure: true },
    { name: 'old', value: 'gone', domain: 'localhost', path: '/', expires: 1 },
  ],
  origins: [{ origin: 'http://localhost:3000', localStorage: [{ name: 'token', value: 'jwt' }] }],
}

describe('capture sign-in store', () => {
  test('keeps material outside the project, keyed by root, with owner-only permissions', async () => {
    const root = '/tmp/doxloop-project-a'
    const directory = captureAuthDirectory(root)
    expect(directory.startsWith(process.env.DOXLOOP_CONFIG_HOME!)).toBe(true)
    expect(directory).not.toBe(captureAuthDirectory('/tmp/doxloop-project-b'))

    await saveCaptureCredentials(root, { username: 'demo@example.com', password: 'p"a\nss' })
    await saveCaptureSession(root, 'http://localhost:3000', state)
    if (process.platform !== 'win32') {
      expect((await stat(directory)).mode & 0o777).toBe(0o700)
      expect((await stat(join(directory, 'credentials.json'))).mode & 0o777).toBe(0o600)
    }

    const status = await captureAuthStatus(root)
    expect(status).toEqual({
      credentials: { username: 'demo@example.com', savedAt: expect.any(String) },
      session: { savedAt: expect.any(String), origin: 'http://localhost:3000', cookies: 3, origins: 1 },
    })
    expect(JSON.stringify(status)).not.toContain('pass')
    expect(describeCaptureAuth(status)).toBe('both')
    expect(describeCaptureAuth(await captureAuthContext('/tmp/doxloop-project-b'))).toBe('none')

    await removeCaptureCredentials(root)
    expect(await loadCaptureCredentials(root)).toBeUndefined()
    expect(describeCaptureAuth(await captureAuthContext(root))).toBe('session')
    await removeCaptureSession(root)
    expect(await captureAuthStatus(root)).toEqual({})
  })

  test('refuses empty credentials and an empty browser session', async () => {
    await expect(saveCaptureCredentials('/tmp/p', { username: ' ', password: 'x' })).rejects.toThrow('username')
    await expect(saveCaptureCredentials('/tmp/p', { username: 'demo', password: '' })).rejects.toThrow('password')
    await expect(saveCaptureSession('/tmp/p', 'http://localhost', { cookies: [], origins: [] })).rejects.toThrow('Complete the sign-in')
  })

  test('materializes a plain storage state and a per-run dotenv secrets file', async () => {
    const root = '/tmp/doxloop-project-c'
    expect(await prepareCaptureAuth(root)).toBeUndefined()
    await saveCaptureCredentials(root, { username: 'demo@example.com', password: 'p"a\nss\\word' })
    await saveCaptureSession(root, 'http://localhost:3000', state)

    const material = await prepareCaptureAuth(root)
    expect(material?.storageStatePath).toBeDefined()
    expect(material?.secretsPath).toBeDefined()
    // Playwright reads the storage state directly, so it carries no metadata.
    expect(JSON.parse(await readFile(material!.storageStatePath!, 'utf8'))).toEqual(state)
    const secrets = await readFile(material!.secretsPath!, 'utf8')
    expect(secrets).toBe(`${CAPTURE_USERNAME_SECRET}="demo@example.com"\n${CAPTURE_PASSWORD_SECRET}="p\\"a\\nss\\\\word"\n\n`)

    await material!.cleanup()
    await expect(stat(material!.secretsPath!)).rejects.toThrow()
    await expect(stat(material!.storageStatePath!)).resolves.toBeDefined()
  })

  test('builds the cookie header a browser would send for the probe URL', () => {
    expect(sessionCookieHeader(state, 'http://localhost:3000/app')).toBe('sid=abc')
    expect(sessionCookieHeader(state, 'https://app.example.com/app/settings')).toBe('pref=dark')
    expect(sessionCookieHeader(state, 'https://app.example.com/other')).toBeUndefined()
    expect(sessionCookieHeader(state, 'http://app.example.com/app')).toBeUndefined()
    expect(sessionCookieHeader(undefined, 'http://localhost:3000')).toBeUndefined()
  })
})
