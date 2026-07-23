#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { createInterface } from 'node:readline/promises'
import { fileURLToPath } from 'node:url'
import { join, relative } from 'node:path'

const root = fileURLToPath(new URL('..', import.meta.url))
const packagePath = join(root, 'package.json')
const changelogPath = join(root, 'CHANGELOG.md')
const packagesRoot = join(root, 'packages')
const repository = 'doxbrix/doxloop'
const githubUser = 'doxbrix'
const releaseBranch = 'main'

let options

try {
  options = parseArguments(process.argv.slice(2))
  await main()
} catch (error) {
  process.stderr.write(
    `release: ${error instanceof Error ? error.message : String(error)}\n`,
  )
  process.exitCode = 1
}

async function main() {
  process.chdir(root)
  await requireCommand('git', ['--version'])
  await requireCommand('pnpm', ['--version'])
  await requireCommand('npm', ['--version'])
  await requireCommand('gh', ['--version'])
  await activateGitHubAccount()
  await assertManualPublishingOnly()

  const branch = await output('git', ['branch', '--show-current'])
  if (branch !== releaseBranch) {
    throw new Error(
      `Releases must run from ${releaseBranch}; current branch is ${branch || '(detached)'}.`,
    )
  }

  await run('git', ['fetch', 'origin', releaseBranch, '--tags'])
  const head = await output('git', ['rev-parse', 'HEAD'])
  const remoteHead = await output('git', ['rev-parse', `origin/${releaseBranch}`])
  if (head !== remoteHead) {
    throw new Error(
      `Local ${releaseBranch} must exactly match origin/${releaseBranch}. Push or pull your existing commits before releasing.`,
    )
  }

  const manifest = JSON.parse(await readFile(packagePath, 'utf8'))
  const currentVersion = parseVersion(manifest.version, 'package.json version')
  const currentTag = `v${formatVersion(currentVersion)}`
  const currentTagAtHead = await tagPointsAtHead(currentTag)
  const currentPublished = await packageVersionExists(
    manifest.name,
    formatVersion(currentVersion),
  )
  const changelog = await readFile(changelogPath, 'utf8')
  const generators = await loadGeneratorPackages()
  const releaseStamped =
    currentTagAtHead &&
    changelog.includes(`## ${formatVersion(currentVersion)} -`)
  const currentGeneratorPublications = releaseStamped
    ? await Promise.all(
        generators
          .filter(
            (candidate) =>
              candidate.version === formatVersion(currentVersion),
          )
          .map((candidate) =>
            packageVersionExists(candidate.name, candidate.version),
          ),
      )
    : []
  const currentReleaseComplete =
    releaseStamped &&
    currentPublished &&
    currentGeneratorPublications.every(Boolean) &&
    (await githubReleaseExists(currentTag))
  const prepared = releaseStamped && !currentReleaseComplete

  if (prepared) {
    await resumeRelease({
      manifest,
      version: formatVersion(currentVersion),
      tag: currentTag,
      published: currentPublished,
      generators,
    })
    return
  }

  if (!currentPublished) {
    throw new Error(
      `${manifest.name}@${formatVersion(currentVersion)} is not on npm and ${currentTag} is not a prepared local release. Resolve this inconsistent state before continuing.`,
    )
  }

  const version = resolveNextVersion(currentVersion, options.version)
  const versionText = formatVersion(version)
  const tag = `v${versionText}`
  if (await packageVersionExists(manifest.name, versionText)) {
    throw new Error(`${manifest.name}@${versionText} already exists on npm.`)
  }
  if (await tagExists(tag)) {
    throw new Error(`Git tag ${tag} already exists.`)
  }
  if (await githubReleaseExists(tag)) {
    throw new Error(`GitHub Release ${tag} already exists.`)
  }
  const changedGenerators = await detectChangedGenerators(generators)
  for (const generator of changedGenerators) {
    if (await packageVersionExists(generator.name, versionText)) {
      throw new Error(`${generator.name}@${versionText} already exists on npm.`)
    }
    if (
      compareVersions(
        parseVersion(generator.version, `${generator.name} version`),
        version,
      ) >= 0
    ) {
      throw new Error(
        `${generator.name} is modified but its current version ${generator.version} is not lower than release version ${versionText}. Choose a higher release version.`,
      )
    }
  }
  const releasePackages = [
    releasePackage(manifest.name, manifest.version, versionText, root, false),
    ...changedGenerators.map((generator) =>
      releasePackage(
        generator.name,
        generator.version,
        versionText,
        generator.directory,
        false,
      ),
    ),
  ]

  const statusBeforeChecks = await output('git', ['status', '--short'])
  const fingerprintBeforeChecks = await worktreeFingerprint()
  printPlan({
    packages: releasePackages,
    unchangedGenerators: generators.length - changedGenerators.length,
    tag,
    status: statusBeforeChecks,
    dryRun: options.dryRun,
  })

  process.stdout.write('\nRunning release checks...\n')
  await run('pnpm', ['check'])
  await inspectReleasePackages(releasePackages)
  const fingerprintAfterChecks = await worktreeFingerprint()
  if (fingerprintAfterChecks !== fingerprintBeforeChecks) {
    throw new Error(
      'Release checks changed worktree files. Review those changes and rerun the release.',
    )
  }

  if (options.dryRun) {
    process.stdout.write(
      `\nDry run passed. No files were changed and nothing was published.\nRun \`pnpm release:local ${options.version}\` to release ${tag}.\n`,
    )
    return
  }

  await ensureGitHubAccess()
  await confirmRelease(versionText)
  await ensureNpmLogin()

  manifest.version = versionText
  await writeFile(packagePath, `${JSON.stringify(manifest, null, 2)}\n`)
  await versionGeneratorPackages(changedGenerators, versionText)
  await promoteChangelog(changelog, versionText)

  await run('git', ['add', '--all'])
  await run('git', ['diff', '--cached', '--check'])
  await run('git', ['commit', '-m', `Release ${tag}`])
  await run('git', ['tag', '-a', tag, '-m', `Doxloop ${tag}`])

  process.stdout.write('\nPushing the release commit and tag to GitHub...\n')
  await run('git', [
    'push',
    '--atomic',
    'origin',
    `HEAD:${releaseBranch}`,
    `refs/tags/${tag}`,
  ])

  await publishAndCreateRelease({
    packages: releasePackages,
    tag,
  })
}

async function resumeRelease({
  manifest,
  version,
  tag,
  published,
  generators,
}) {
  const status = await output('git', ['status', '--short'])
  if (status) {
    throw new Error(
      `Cannot resume ${tag} with uncommitted changes:\n${indent(status)}`,
    )
  }
  const releasePackages = [
    releasePackage(manifest.name, version, version, root, published),
  ]
  for (const generator of generators.filter(
    (candidate) => candidate.version === version,
  )) {
    releasePackages.push(
      releasePackage(
        generator.name,
        version,
        version,
        generator.directory,
        await packageVersionExists(generator.name, version),
      ),
    )
  }
  printPlan({
    packages: releasePackages,
    unchangedGenerators: generators.length - (releasePackages.length - 1),
    tag,
    status: '',
    dryRun: options.dryRun,
    resume: true,
  })
  process.stdout.write('\nRunning release checks...\n')
  await run('pnpm', ['check'])
  await inspectReleasePackages(releasePackages)
  if (options.dryRun) {
    process.stdout.write(
      `\nDry run passed. Run \`pnpm release:local\` to resume ${tag}.\n`,
    )
    return
  }

  await ensureGitHubAccess()
  await confirmRelease(version)
  if (releasePackages.some((candidate) => !candidate.published)) {
    await ensureNpmLogin()
  }

  const remoteTag = await remoteTagExists(tag)
  if (!remoteTag) {
    process.stdout.write('\nPushing the prepared release commit and tag...\n')
    await run('git', [
      'push',
      '--atomic',
      'origin',
      `HEAD:${releaseBranch}`,
      `refs/tags/${tag}`,
    ])
  }

  await publishAndCreateRelease({
    packages: releasePackages,
    tag,
  })
}

async function publishAndCreateRelease({ packages, tag }) {
  for (const candidate of packages) {
    if (candidate.published) {
      process.stdout.write(
        `\n${candidate.name}@${candidate.version} is already on npm; skipping publish.\n`,
      )
    } else {
      process.stdout.write(
        `\nPublishing ${candidate.name}@${candidate.version}. Complete the npm 2FA/WebAuthn prompt when requested...\n`,
      )
      await run('npm', ['publish', '--access', 'public'], {
        cwd: candidate.directory,
      })
      if (!(await waitForPackageVersion(candidate.name, candidate.version))) {
        throw new Error(
          `npm publish returned successfully, but ${candidate.name}@${candidate.version} is not visible in the registry.`,
        )
      }
    }
  }

  if (await githubReleaseExists(tag)) {
    process.stdout.write(`GitHub Release ${tag} already exists; skipping creation.\n`)
  } else {
    process.stdout.write('\nCreating the GitHub Release...\n')
    await run('gh', [
      'release',
      'create',
      tag,
      '--repo',
      repository,
      '--verify-tag',
      '--title',
      `Doxloop ${tag}`,
      '--generate-notes',
    ])
  }

  process.stdout.write(
    `\nReleased packages:\n${packages.map((candidate) => `- ${candidate.name}@${candidate.version}`).join('\n')}\n` +
      `GitHub: https://github.com/${repository}/releases/tag/${tag}\n`,
  )
}

async function loadGeneratorPackages() {
  const entries = await readdir(packagesRoot, { withFileTypes: true })
  const generators = []
  for (const entry of entries.filter((candidate) => candidate.isDirectory())) {
    const directory = join(packagesRoot, entry.name)
    const manifestPath = join(directory, 'package.json')
    let manifest
    try {
      manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    } catch (error) {
      if (error && typeof error === 'object' && error.code === 'ENOENT') continue
      throw error
    }
    if (
      typeof manifest.name !== 'string' ||
      typeof manifest.version !== 'string'
    ) {
      throw new Error(`${relative(root, manifestPath)} must declare name and version.`)
    }
    generators.push({
      name: manifest.name,
      version: manifest.version,
      directory,
      manifestPath,
      manifest,
    })
  }
  return generators.sort((left, right) => left.name.localeCompare(right.name))
}

async function detectChangedGenerators(generators) {
  const initialCommit = await output('git', [
    'rev-list',
    '--max-parents=0',
    'HEAD',
  ])
  const detected = await Promise.all(
    generators.map(async (generator) => {
      const published = await packageVersionExists(
        generator.name,
        generator.version,
      )
      if (!published) return { ...generator, changed: true }

      const publishedHead = await publishedGitHead(
        generator.name,
        generator.version,
      )
      let baseline = publishedHead
      if (!baseline || !(await commitExists(baseline))) {
        const versionTag = `v${generator.version}`
        baseline = (await tagExists(versionTag))
          ? await output('git', ['rev-list', '-n', '1', versionTag])
          : initialCommit
      }
      return {
        ...generator,
        changed: await directoryChangedSince(generator.directory, baseline),
      }
    }),
  )
  return detected.filter((generator) => generator.changed)
}

async function publishedGitHead(packageName, version) {
  const result = await run(
    'npm',
    ['view', `${packageName}@${version}`, 'gitHead'],
    { allowFailure: true, capture: true },
  )
  return result.code === 0 ? result.stdout.trim() : ''
}

async function commitExists(commit) {
  const result = await run(
    'git',
    ['rev-parse', '--verify', '--quiet', `${commit}^{commit}`],
    { allowFailure: true, capture: true },
  )
  return result.code === 0
}

async function directoryChangedSince(directory, baseline) {
  const path = relative(root, directory)
  const tracked = await run(
    'git',
    ['diff', '--quiet', baseline, '--', path],
    { allowFailure: true, capture: true },
  )
  if (tracked.code > 1) {
    throw new Error(
      `Could not compare ${path} with ${baseline}.\n${tracked.stderr.trim()}`,
    )
  }
  if (tracked.code === 1) return true
  const untracked = await output('git', [
    'ls-files',
    '--others',
    '--exclude-standard',
    '--',
    path,
  ])
  return untracked.length > 0
}

function releasePackage(
  name,
  currentVersion,
  version,
  directory,
  published,
) {
  return { name, currentVersion, version, directory, published }
}

async function inspectReleasePackages(packages) {
  for (const candidate of packages) {
    await run('npm', ['pack', '--dry-run', '--ignore-scripts'], {
      cwd: candidate.directory,
    })
  }
}

async function versionGeneratorPackages(generators, version) {
  for (const generator of generators) {
    generator.manifest.version = version
    const corePeer = generator.manifest.peerDependencies?.['@doxbrix/doxloop']
    if (
      typeof corePeer === 'string' &&
      !caretRangeIncludes(corePeer, version)
    ) {
      generator.manifest.peerDependencies['@doxbrix/doxloop'] = `^${version}`
    }
    await writeFile(
      generator.manifestPath,
      `${JSON.stringify(generator.manifest, null, 2)}\n`,
    )
  }
}

function caretRangeIncludes(range, version) {
  const match = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(range)
  if (!match) return false
  const base = {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  }
  const target = parseVersion(version, 'release version')
  if (compareVersions(target, base) < 0) return false
  if (base.major > 0) return target.major === base.major
  if (base.minor > 0) {
    return target.major === 0 && target.minor === base.minor
  }
  return (
    target.major === 0 &&
    target.minor === 0 &&
    target.patch === base.patch
  )
}

async function waitForPackageVersion(packageName, version) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (await packageVersionExists(packageName, version)) return true
    if (attempt < 4) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 2_000))
    }
  }
  return false
}

async function promoteChangelog(content, version) {
  const heading = '## Unreleased'
  if (!content.includes(heading)) {
    throw new Error('CHANGELOG.md does not contain an "## Unreleased" heading.')
  }
  if (content.includes(`## ${version} -`)) {
    throw new Error(`CHANGELOG.md already contains a ${version} release.`)
  }
  const date = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'UTC',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date())
  const updated = content.replace(
    heading,
    `${heading}\n\n## ${version} - ${date}`,
  )
  await writeFile(changelogPath, updated)
}

async function ensureGitHubAccess() {
  const permission = await output('gh', [
    'repo',
    'view',
    repository,
    '--json',
    'viewerPermission',
    '--jq',
    '.viewerPermission',
  ])
  if (!['ADMIN', 'MAINTAIN', 'WRITE'].includes(permission)) {
    throw new Error(
      `The active GitHub account has ${permission || 'no'} access to ${repository}. Run \`gh auth switch --hostname github.com --user doxbrix\`.`,
    )
  }
}

async function activateGitHubAccount() {
  const switched = await run(
    'gh',
    ['auth', 'switch', '--hostname', 'github.com', '--user', githubUser],
    { allowFailure: true, capture: true },
  )
  if (switched.code !== 0) {
    throw new Error(
      `GitHub account ${githubUser} is not available. Run \`gh auth login --hostname github.com\` and authenticate that account first.\n${switched.stderr.trim()}`,
    )
  }
  await run('gh', ['auth', 'setup-git'])
  const activeUser = await output('gh', ['api', 'user', '--jq', '.login'])
  if (activeUser.toLowerCase() !== githubUser) {
    throw new Error(
      `Expected GitHub account ${githubUser}, but ${activeUser || 'no account'} is active.`,
    )
  }
  process.stdout.write(`GitHub account: ${activeUser}\n`)
}

async function ensureNpmLogin() {
  const whoami = await run('npm', ['whoami'], {
    allowFailure: true,
    capture: true,
  })
  if (whoami.code === 0) {
    process.stdout.write(`npm account: ${whoami.stdout.trim()}\n`)
    return
  }
  process.stdout.write(
    '\nNo active npm login was found. Opening npm browser authentication...\n',
  )
  await run('npm', [
    'login',
    '--registry',
    'https://registry.npmjs.org',
  ])
  await requireCommand('npm', ['whoami'])
}

async function confirmRelease(version) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('Interactive confirmation is required for a release.')
  }
  const prompt = createInterface({
    input: process.stdin,
    output: process.stdout,
  })
  try {
    const answer = await prompt.question(
      `\nType ${version} to publish this release to npm and GitHub: `,
    )
    if (answer.trim() !== version) throw new Error('Release canceled.')
  } finally {
    prompt.close()
  }
}

function printPlan({
  packages,
  unchangedGenerators,
  tag,
  status,
  dryRun,
  resume = false,
}) {
  process.stdout.write(
    `Local ${resume ? 'release recovery' : 'release'}${dryRun ? ' dry run' : ''}\n` +
      `Tag: ${tag}\n` +
      `GitHub repository: ${repository}\n\n` +
      `Packages:\n${packages
        .map(
          (candidate) =>
            `- ${candidate.name}: ${candidate.currentVersion}${
              candidate.currentVersion === candidate.version
                ? ''
                : ` → ${candidate.version}`
            } (${candidate.published ? 'already published' : 'will publish interactively'})`,
        )
        .join('\n')}\n` +
      `Unchanged generators: ${unchangedGenerators}\n`,
  )
  if (status) {
    process.stdout.write(
      `\nThe release commit will include these current worktree changes:\n${indent(status)}\n`,
    )
  }
}

function resolveNextVersion(current, requested) {
  if (/^\d+\.\d+\.\d+$/.test(requested)) {
    const exact = parseVersion(requested, 'requested version')
    if (compareVersions(exact, current) <= 0) {
      throw new Error(
        `Requested version ${requested} must be greater than ${formatVersion(current)}.`,
      )
    }
    return exact
  }
  const next = { ...current }
  if (requested === 'major') {
    next.major += 1
    next.minor = 0
    next.patch = 0
  } else if (requested === 'minor') {
    next.minor += 1
    next.patch = 0
  } else if (requested === 'patch') {
    next.patch += 1
  } else {
    throw new Error(
      `Unknown version "${requested}". Use patch, minor, major, or an exact x.y.z version.`,
    )
  }
  return next
}

function parseArguments(args) {
  const dryRun = args.includes('--dry-run')
  const positional = args.filter((argument) => !argument.startsWith('--'))
  const unknownFlags = args.filter(
    (argument) => argument.startsWith('--') && argument !== '--dry-run',
  )
  if (unknownFlags.length > 0) {
    throw new Error(`Unknown option ${unknownFlags[0]}.`)
  }
  if (positional.length > 1) {
    throw new Error(
      'Usage: pnpm release:local [patch|minor|major|x.y.z] [--dry-run]',
    )
  }
  return { version: positional[0] ?? 'patch', dryRun }
}

function parseVersion(value, label) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(value))
  if (!match) throw new Error(`${label} must use x.y.z semantic versioning.`)
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  }
}

function formatVersion(version) {
  return `${version.major}.${version.minor}.${version.patch}`
}

function compareVersions(left, right) {
  return (
    left.major - right.major ||
    left.minor - right.minor ||
    left.patch - right.patch
  )
}

async function assertManualPublishingOnly() {
  const workflowPath = join(root, '.github', 'workflows', 'release.yml')
  let workflow
  try {
    workflow = await readFile(workflowPath, 'utf8')
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return
    throw error
  }
  if (
    workflow.includes('types: [published]') &&
    /\b(?:npm|pnpm)\s+publish\b/.test(workflow)
  ) {
    throw new Error(
      '.github/workflows/release.yml still publishes to npm when a GitHub Release is created. Remove that workflow before using local publishing.',
    )
  }
}

async function tagExists(tag) {
  const result = await run('git', ['rev-parse', '--verify', '--quiet', tag], {
    allowFailure: true,
    capture: true,
  })
  return result.code === 0
}

async function tagPointsAtHead(tag) {
  if (!(await tagExists(tag))) return false
  const tagCommit = await output('git', ['rev-list', '-n', '1', tag])
  const head = await output('git', ['rev-parse', 'HEAD'])
  return tagCommit === head
}

async function remoteTagExists(tag) {
  const result = await output('git', [
    'ls-remote',
    '--tags',
    'origin',
    `refs/tags/${tag}`,
  ])
  return result.length > 0
}

async function packageVersionExists(packageName, version) {
  const result = await run(
    'npm',
    ['view', `${packageName}@${version}`, 'version'],
    { allowFailure: true, capture: true },
  )
  return result.code === 0 && result.stdout.trim() === version
}

async function worktreeFingerprint() {
  const hash = createHash('sha256')
  const tracked = await run('git', ['diff', '--binary', 'HEAD', '--'], {
    capture: true,
  })
  hash.update(tracked.stdout)
  const untracked = await run(
    'git',
    ['ls-files', '--others', '--exclude-standard', '-z'],
    { capture: true },
  )
  const paths = untracked.stdout.split('\0').filter(Boolean).sort()
  for (const path of paths) {
    hash.update(path)
    hash.update(await readFile(join(root, path)))
  }
  return hash.digest('hex')
}

async function githubReleaseExists(tag) {
  const result = await run(
    'gh',
    ['release', 'view', tag, '--repo', repository],
    { allowFailure: true, capture: true },
  )
  return result.code === 0
}

async function requireCommand(command, args) {
  const result = await run(command, args, {
    allowFailure: true,
    capture: true,
  })
  if (result.code !== 0) {
    throw new Error(
      `${command} is required but unavailable.\n${result.stderr.trim()}`,
    )
  }
  return result.stdout.trim()
}

async function output(command, args) {
  const result = await run(command, args, { capture: true })
  return result.stdout.trim()
}

async function run(
  command,
  args,
  { allowFailure = false, capture = false, cwd = root } = {},
) {
  const result = await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
      shell: false,
    })
    let stdout = ''
    let stderr = ''
    if (capture) {
      child.stdout.on('data', (chunk) => {
        stdout += String(chunk)
      })
      child.stderr.on('data', (chunk) => {
        stderr += String(chunk)
      })
    }
    child.once('error', reject)
    child.once('exit', (code) => {
      resolve({ code: code ?? 1, stdout, stderr })
    })
  })
  if (!allowFailure && result.code !== 0) {
    const details = [result.stderr.trim(), result.stdout.trim()]
      .filter(Boolean)
      .join('\n')
    throw new Error(
      `Command failed (${result.code}): ${command} ${args.join(' ')}${details ? `\n${details}` : ''}`,
    )
  }
  return result
}

function indent(value) {
  return value
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n')
}
