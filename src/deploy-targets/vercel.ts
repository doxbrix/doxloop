import { createHash } from 'node:crypto'
import { lstat, readdir, readFile } from 'node:fs/promises'
import { relative, resolve, sep } from 'node:path'
import { deployCredential } from '../deploy-credentials.js'
import { DoxloopError } from '../errors.js'
import type { DeployTarget } from './types.js'

export const vercelTarget: DeployTarget = {
  id: 'vercel',
  label: 'Vercel',
  async configure(options) {
    if (!options.projectId?.trim()) throw new DoxloopError('Vercel requires a project ID or project name.')
    return { ...options, projectId: options.projectId.trim(), apiUrl: apiOrigin(options.apiUrl) }
  },
  async publish(bundle, rawOptions) {
    const options = await this.configure(rawOptions)
    const token = await deployCredential('vercel')
    const files = await deploymentFiles(bundle.outputDir)
    const query = options.teamId ? `?teamId=${encodeURIComponent(options.teamId)}` : ''
    for (const file of files) {
      const upload = await fetch(`${options.apiUrl}/v2/files${query}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(file.data.byteLength),
          'x-vercel-digest': file.sha,
        },
        body: file.data as unknown as BodyInit,
        redirect: 'error',
      })
      if (!upload.ok) throw await providerError(upload)
    }
    const response = await fetch(`${options.apiUrl}/v13/deployments${query}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: options.projectId,
        project: options.projectId,
        target: 'production',
        files: files.map(({ file, sha, size }) => ({ file, sha, size })),
        projectSettings: { framework: null },
      }),
      redirect: 'error',
    })
    if (!response.ok) throw await providerError(response)
    const result = await response.json() as { id?: string; url?: string; alias?: string[]; readyState?: string }
    const hostname = result.alias?.[0] ?? result.url
    return { ...(result.id ? { id: result.id } : {}), ...(hostname ? { url: `https://${hostname.replace(/^https?:\/\//, '')}` } : {}), detail: result.readyState ? `Deploy ${result.readyState.toLowerCase()}` : 'Deploy created' }
  },
}

async function deploymentFiles(root: string): Promise<Array<{ file: string; data: Uint8Array; sha: string; size: number }>> {
  const files: Array<{ file: string; data: Uint8Array; sha: string; size: number }> = []
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = resolve(directory, entry.name)
      const stat = await lstat(absolute)
      if (stat.isSymbolicLink()) throw new DoxloopError('Vercel deployment output cannot contain symbolic links.')
      if (stat.isDirectory()) await visit(absolute)
      else if (stat.isFile()) {
        const data = new Uint8Array(await readFile(absolute))
        files.push({ file: relative(root, absolute).split(sep).join('/'), data, sha: createHash('sha1').update(data).digest('hex'), size: data.byteLength })
      }
    }
  }
  await visit(root)
  return files
}

function apiOrigin(value?: string): string {
  const raw = value?.trim() || 'https://api.vercel.com'
  let url: URL
  try { url = new URL(raw) } catch { throw new DoxloopError(`Invalid Vercel API URL: ${raw}`) }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '::1'].includes(url.hostname))) throw new DoxloopError('Vercel API URL must use HTTPS.')
  if (url.username || url.password || url.search || url.hash) throw new DoxloopError('Vercel API URL cannot contain credentials, query, or fragment.')
  return url.toString().replace(/\/+$/, '')
}

async function providerError(response: Response): Promise<DoxloopError> {
  let detail = `${response.status} ${response.statusText}`.trim()
  try { detail = (await response.text()).trim().slice(0, 1_000) || detail } catch {}
  return new DoxloopError(`Vercel deployment failed: ${detail}`)
}
