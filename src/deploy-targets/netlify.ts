import { deployCredential } from '../deploy-credentials.js'
import { DoxloopError } from '../errors.js'
import type { DeployTarget } from './types.js'

export const netlifyTarget: DeployTarget = {
  id: 'netlify',
  label: 'Netlify',
  async configure(options) {
    if (!options.siteId?.trim()) throw new DoxloopError('Netlify requires a site ID.')
    return { ...options, siteId: options.siteId.trim(), apiUrl: apiOrigin(options.apiUrl, 'https://api.netlify.com') }
  },
  async publish(bundle, rawOptions) {
    const options = await this.configure(rawOptions)
    const token = await deployCredential('netlify')
    const response = await fetch(`${options.apiUrl}/api/v1/sites/${encodeURIComponent(options.siteId!)}/deploys`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/zip' },
      body: bundle.archive as unknown as BodyInit,
      redirect: 'error',
    })
    if (!response.ok) throw await providerError('Netlify', response)
    const result = await response.json() as { id?: string; deploy_ssl_url?: string; ssl_url?: string; url?: string; state?: string }
    return { ...(result.id ? { id: result.id } : {}), ...(result.deploy_ssl_url ?? result.ssl_url ?? result.url ? { url: result.deploy_ssl_url ?? result.ssl_url ?? result.url } : {}), detail: result.state ? `Deploy ${result.state}` : 'Deploy uploaded' }
  },
}

function apiOrigin(value: string | undefined, fallback: string): string {
  const raw = value?.trim() || fallback
  let url: URL
  try { url = new URL(raw) } catch { throw new DoxloopError(`Invalid Netlify API URL: ${raw}`) }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '::1'].includes(url.hostname))) throw new DoxloopError('Netlify API URL must use HTTPS.')
  if (url.username || url.password || url.search || url.hash) throw new DoxloopError('Netlify API URL cannot contain credentials, query, or fragment.')
  return url.toString().replace(/\/+$/, '')
}

async function providerError(provider: string, response: Response): Promise<DoxloopError> {
  let detail = `${response.status} ${response.statusText}`.trim()
  try { detail = (await response.text()).trim().slice(0, 1_000) || detail } catch {}
  return new DoxloopError(`${provider} deployment failed: ${detail}`)
}
