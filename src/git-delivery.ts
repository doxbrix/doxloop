import { execFile } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { DoxloopError } from './errors.js'
import { ensureGitignoreEntries, pathExists } from './fs.js'
import { readSyncRun, runWorkspace } from './sync-runs.js'

const execute = promisify(execFile)

export interface GitDeliveryResult {
  schemaVersion: 1
  proposalId: string
  branch: string
  baseBranch: string
  commit: string
  createdAt: string
  compareUrl?: string
  pullRequestCommand?: string
  pushedAt?: string
  pullRequestUrl?: string
}

/** Push a previously prepared branch and optionally ask GitHub CLI to open its pull request. */
export async function publishProposalBranch(root: string, proposalId: string, createPullRequest: boolean): Promise<GitDeliveryResult> {
  const path = join(root, '.doxloop', 'deliveries', `${proposalId}.json`)
  if (!(await pathExists(path))) throw new DoxloopError('Prepare the proposal branch before publishing it.')
  let delivery: GitDeliveryResult
  try { delivery = JSON.parse(await readFile(path, 'utf8')) as GitDeliveryResult } catch { throw new DoxloopError('The saved proposal delivery record is unreadable.') }
  if (delivery.schemaVersion !== 1 || delivery.proposalId !== proposalId || !delivery.branch || !delivery.commit) throw new DoxloopError('The saved proposal delivery record is invalid.')
  const current = (await git(root, ['rev-parse', delivery.branch])).trim()
  if (current !== delivery.commit) throw new DoxloopError('The prepared delivery branch changed after review. Prepare a new branch before publishing.')
  if (!(await optionalGit(root, ['remote', 'get-url', 'origin']))) throw new DoxloopError('Add a Git remote named origin before publishing this branch.')
  await git(root, ['push', '--set-upstream', 'origin', delivery.branch])
  let pullRequestUrl = delivery.pullRequestUrl
  if (createPullRequest && !pullRequestUrl) {
    try {
      pullRequestUrl = (await execute('gh', ['pr', 'create', '--fill', '--base', delivery.baseBranch, '--head', delivery.branch], { cwd: root, maxBuffer: 2_000_000 })).stdout.trim()
    } catch (error) { throw new DoxloopError(`The branch was pushed, but GitHub CLI could not create the pull request: ${error instanceof Error ? error.message : String(error)}`) }
  }
  delivery = { ...delivery, pushedAt: new Date().toISOString(), ...(pullRequestUrl ? { pullRequestUrl } : {}) }
  await writeFile(path, `${JSON.stringify(delivery, null, 2)}\n`, 'utf8')
  return delivery
}

/** Materialize a reviewed proposal on an isolated local Git branch. */
export async function createProposalBranch(root: string, proposalId: string, requestedBranch?: string): Promise<GitDeliveryResult> {
  const run = await readSyncRun(root, proposalId)
  if (!['awaiting-review', 'partially-applied'].includes(run.status)) throw new DoxloopError('Only a reviewable proposal can be prepared as a Git branch.')
  if (!(await pathExists(join(root, '.git')))) throw new DoxloopError('Pull-request delivery requires the documentation project to be a Git repository.')
  const branch = requestedBranch?.trim() || `doxloop/${proposalId}`
  await git(root, ['check-ref-format', '--branch', branch])
  const baseBranch = (await git(root, ['branch', '--show-current'])).trim() || 'HEAD'
  const parent = await mkdtemp(join(tmpdir(), 'doxloop-delivery-'))
  const worktree = join(parent, 'worktree')
  try {
    await git(root, ['worktree', 'add', '--detach', worktree, 'HEAD'])
    await git(worktree, ['checkout', '-b', branch])
    for (const change of run.changes) {
      const target = contained(worktree, change.path)
      if (change.kind === 'deleted') await rm(target, { force: true, recursive: true })
      else {
        const source = contained(runWorkspace(root, proposalId), change.path)
        await mkdir(dirname(target), { recursive: true })
        await cp(source, target, { recursive: true })
      }
    }
    await git(worktree, ['add', '--all'])
    const status = await git(worktree, ['status', '--porcelain'])
    if (!status.trim()) throw new DoxloopError('The proposal does not produce a Git change against the current documentation branch.')
    await git(worktree, ['-c', 'user.name=Doxloop', '-c', 'user.email=doxloop@local', 'commit', '-m', `docs: apply ${proposalId}`])
    const commit = (await git(worktree, ['rev-parse', 'HEAD'])).trim()
    const remote = await optionalGit(root, ['remote', 'get-url', 'origin'])
    const compareUrl = remote ? githubCompareUrl(remote.trim(), baseBranch, branch) : undefined
    const result: GitDeliveryResult = {
      schemaVersion: 1,
      proposalId,
      branch,
      baseBranch,
      commit,
      createdAt: new Date().toISOString(),
      ...(compareUrl ? { compareUrl } : {}),
    }
    await ensureGitignoreEntries(root, ['.doxloop/deliveries/'])
    const directory = join(root, '.doxloop', 'deliveries'); await mkdir(directory, { recursive: true, mode: 0o700 })
    await writeFile(join(directory, `${proposalId}.json`), `${JSON.stringify(result, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    return result
  } finally {
    await optionalGit(root, ['worktree', 'remove', '--force', worktree])
    await rm(parent, { recursive: true, force: true })
  }
}

async function git(cwd: string, args: string[]): Promise<string> {
  try { return (await execute('git', args, { cwd, maxBuffer: 2_000_000 })).stdout }
  catch (error) { throw new DoxloopError(error instanceof Error ? error.message : String(error)) }
}

async function optionalGit(cwd: string, args: string[]): Promise<string | undefined> {
  try { return (await execute('git', args, { cwd, maxBuffer: 2_000_000 })).stdout } catch { return undefined }
}

function contained(root: string, candidate: string): string {
  const path = resolve(root, candidate)
  const rel = relative(resolve(root), path)
  if (rel === '..' || rel.startsWith(`..${sep}`)) throw new DoxloopError(`Proposal path leaves the Git worktree: ${candidate}`)
  return path
}

function githubCompareUrl(remote: string, base: string, branch: string): string | undefined {
  const match = /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/.exec(remote)
  return match ? `https://github.com/${match[1]}/${match[2]}/compare/${encodeURIComponent(base)}...${encodeURIComponent(branch)}?expand=1` : undefined
}
