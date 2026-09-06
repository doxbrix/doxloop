import { execFile } from 'node:child_process'
import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { DoxloopError } from '../errors.js'
import type { DeployTarget } from './types.js'

const execute = promisify(execFile)

export const githubPagesTarget: DeployTarget = {
  id: 'github-pages',
  label: 'GitHub Pages',
  async configure(options) {
    const branch = options.branch?.trim() || 'gh-pages'
    if (!(branch === 'gh-pages' || /^doxloop-pages\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(branch)) || branch.includes('..')) {
      throw new DoxloopError('Use gh-pages or doxloop-pages/<site> as a deployment-only branch. Source branches cannot be deployment targets.')
    }
    await git(options.root, ['rev-parse', '--is-inside-work-tree'])
    await git(options.root, ['check-ref-format', '--branch', branch])
    const current = (await git(options.root, ['branch', '--show-current'])).trim()
    if (current === branch) throw new DoxloopError('The deployment branch is checked out. Switch to your documentation source branch before publishing.')
    const remote = (await git(options.root, ['remote', 'get-url', 'origin'])).trim()
    const withBase = { ...options, branch, ...(options.basePath ? {} : inferredBasePath(remote)) }
    const siteUrl = githubPagesUrl(remote, withBase.basePath)
    return { ...withBase, ...(siteUrl ? { siteUrl } : {}) }
  },
  async publish(bundle, rawOptions) {
    const options = await this.configure(rawOptions)
    const remote = (await git(options.root, ['remote', 'get-url', 'origin'])).trim()
    const parent = await mkdtemp(join(tmpdir(), 'doxloop-pages-'))
    const checkout = join(parent, 'site')
    try {
      await git(parent, ['clone', '--no-checkout', options.root, checkout])
      await git(checkout, ['remote', 'set-url', 'origin', remote])
      const ref = `refs/heads/${options.branch}`
      const advertised = (await git(checkout, ['ls-remote', '--heads', 'origin', ref])).trim().split(/\s+/)[0] || ''
      if (advertised) {
        await git(checkout, ['fetch', '--no-tags', 'origin', ref])
        const fetched = (await git(checkout, ['rev-parse', 'FETCH_HEAD'])).trim()
        if (fetched !== advertised) throw new DoxloopError('The deployment branch changed during preparation. Retry publishing.')
        const marker = await git(checkout, ['show', `${fetched}:.doxloop-deployment.json`]).catch(() => '')
        if (marker.trim() !== '{"schemaVersion":1,"owner":"doxloop-static-deploy"}') throw new DoxloopError('The remote branch is not owned by Doxloop static deployments. Choose a new doxloop-pages/<site> branch to preserve its existing content.')
        await git(checkout, ['checkout', '--detach', fetched])
      } else {
        await git(checkout, ['checkout', '--orphan', `doxloop-publish-${Date.now()}`])
      }
      for (const entry of await readdir(checkout)) {
        if (entry !== '.git') await rm(join(checkout, entry), { recursive: true, force: true })
      }
      for (const entry of await readdir(bundle.outputDir)) {
        await cp(join(bundle.outputDir, entry), join(checkout, entry), { recursive: true })
      }
      await writeFile(join(checkout, '.nojekyll'), '', 'utf8')
      await writeFile(join(checkout, '.doxloop-deployment.json'), '{"schemaVersion":1,"owner":"doxloop-static-deploy"}\n', 'utf8')
      await git(checkout, ['add', '--all'])
      await git(checkout, ['-c', 'user.name=Doxloop', '-c', 'user.email=doxloop@local', 'commit', '--allow-empty', '-m', 'docs: publish static site'])
      const commit = (await git(checkout, ['rev-parse', 'HEAD'])).trim()
      // Existing deployments retain their history. An explicit lease rejects concurrent updates.
      await git(checkout, ['push', `--force-with-lease=${ref}:${advertised}`, 'origin', `HEAD:${ref}`])
      const url = githubPagesUrl(remote, options.basePath)
      return {
        id: commit,
        ...(url ? { url } : {}),
        detail: `Pushed ${bundle.files} files to ${options.branch}`,
      }
    } finally {
      await rm(parent, { recursive: true, force: true })
    }
  },
}

async function git(cwd: string, args: string[]): Promise<string> {
  try { return (await execute('git', args, { cwd, maxBuffer: 4_000_000 })).stdout }
  catch (error) { throw new DoxloopError(`GitHub Pages publish failed: ${error instanceof Error ? error.message : String(error)}`) }
}

function repository(remote: string): { owner: string; name: string } | undefined {
  const match = /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/.exec(remote)
  return match ? { owner: match[1]!, name: match[2]! } : undefined
}

function inferredBasePath(remote: string): { basePath?: string } {
  const repo = repository(remote)
  if (!repo || repo.name.toLowerCase() === `${repo.owner.toLowerCase()}.github.io`) return {}
  return { basePath: `/${repo.name}` }
}

function githubPagesUrl(remote: string, basePath?: string): string | undefined {
  const repo = repository(remote)
  if (!repo) return undefined
  const path = basePath?.replace(/^\/+|\/+$/g, '')
  return `https://${repo.owner.toLowerCase()}.github.io/${path ? `${path}/` : ''}`
}
