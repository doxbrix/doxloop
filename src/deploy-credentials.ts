import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { DoxloopError } from './errors.js'
import { pathExists } from './fs.js'
import type { DeployTargetId } from './deploy-targets/types.js'
import { promisify } from 'node:util'

type CredentialTarget = Extract<DeployTargetId, 'netlify' | 'vercel'>
type CredentialFile = Partial<Record<CredentialTarget, string>>
const execute = promisify(execFile)
const KEYCHAIN_SERVICE = 'com.doxloop.deploy'

export async function saveDeployCredential(target: CredentialTarget, token: string): Promise<void> {
  const value = token.trim()
  if (value.length < 8) throw new DoxloopError(`${targetLabel(target)} token is too short.`)
  if (process.platform === 'darwin') {
    try {
      await execute('security', ['add-generic-password', '-a', target, '-s', KEYCHAIN_SERVICE, '-w', value, '-U'])
      return
    } catch (error) {
      throw new DoxloopError(`Could not save the ${targetLabel(target)} token in macOS Keychain: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const path = credentialPath()
  const current = await readCredentials()
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await writeFile(path, `${JSON.stringify({ ...current, [target]: value }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  if (process.platform !== 'win32') await chmod(path, 0o600)
}

export async function deployCredential(target: CredentialTarget): Promise<string> {
  const environment = target === 'netlify'
    ? process.env.DOXLOOP_NETLIFY_TOKEN ?? process.env.NETLIFY_AUTH_TOKEN
    : process.env.DOXLOOP_VERCEL_TOKEN ?? process.env.VERCEL_TOKEN
  const token = environment ?? await storedCredential(target)
  if (!token) {
    throw new DoxloopError(`No ${targetLabel(target)} token is configured. Set ${target === 'netlify' ? 'DOXLOOP_NETLIFY_TOKEN' : 'DOXLOOP_VERCEL_TOKEN'} or save one from the Deploy page.`)
  }
  return token
}

export async function deployCredentialState(): Promise<Record<CredentialTarget, boolean>> {
  const [netlify, vercel] = await Promise.all([storedCredential('netlify'), storedCredential('vercel')])
  return {
    netlify: Boolean(process.env.DOXLOOP_NETLIFY_TOKEN ?? process.env.NETLIFY_AUTH_TOKEN ?? netlify),
    vercel: Boolean(process.env.DOXLOOP_VERCEL_TOKEN ?? process.env.VERCEL_TOKEN ?? vercel),
  }
}

async function storedCredential(target: CredentialTarget): Promise<string | undefined> {
  if (process.platform === 'darwin') {
    try {
      const result = await execute('security', ['find-generic-password', '-a', target, '-s', KEYCHAIN_SERVICE, '-w'])
      return result.stdout.trim() || undefined
    } catch { return undefined }
  }
  return (await readCredentials())[target]
}

async function readCredentials(): Promise<CredentialFile> {
  const path = credentialPath()
  if (!(await pathExists(path))) return {}
  try { return JSON.parse(await readFile(path, 'utf8')) as CredentialFile }
  catch { throw new DoxloopError(`Cannot read deployment credentials at ${path}.`) }
}

function credentialPath(): string {
  return process.env.DOXLOOP_CONFIG_HOME
    ? join(process.env.DOXLOOP_CONFIG_HOME, 'deploy-targets.json')
    : join(homedir(), '.config', 'doxloop', 'deploy-targets.json')
}

function targetLabel(target: CredentialTarget): string { return target === 'netlify' ? 'Netlify' : 'Vercel' }
