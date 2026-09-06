#!/usr/bin/env node
/**
 * Scaffold, preview, and build one generator end to end with the adapter
 * built in this checkout. Used by the CI generator matrix and runnable
 * locally:
 *
 *   node scripts/ci-generator-smoke.mjs mkdocs
 *
 * Requires `pnpm run build` first. The generator's own toolchain (Node.js,
 * Python, Hugo, Ruby) must already be on the PATH.
 */
import { spawn } from 'node:child_process'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const cli = join(root, 'dist', 'cli.js')
const generator = process.argv[2]
const keep = process.argv.includes('--keep')
if (!generator) {
  console.error('Usage: node scripts/ci-generator-smoke.mjs <generator> [--keep]')
  process.exit(2)
}

const { GENERATOR_CATALOG } = await import(join(root, 'dist', 'generators.js'))
const entry = GENERATOR_CATALOG.find((candidate) => candidate.id === generator)
if (!entry) {
  console.error(`Unknown generator "${generator}". Known: ${GENERATOR_CATALOG.map((candidate) => candidate.id).join(', ')}`)
  process.exit(2)
}

const parent = await mkdtemp(join(tmpdir(), `doxloop-smoke-${generator}-`))
const project = join(parent, 'docs')
const step = (label) => console.log(`\n=== ${label}`)

try {
  step(`Scaffold ${generator}`)
  await run(process.execPath, [cli, 'init', project, '--title', `Smoke ${generator}`, '--generator', generator], parent)
  await access(join(project, '.doxloop', 'project.json'))

  if (entry.toolchain.includes('node')) {
    // The scaffold pins the published @doxbrix packages as devDependencies.
    // Drop them so the adapter under test stays the one built in this checkout
    // (resolution falls back to the monorepo when the project has no copy).
    step('Install site dependencies')
    const packagePath = join(project, 'package.json')
    const manifest = JSON.parse(await readFile(packagePath, 'utf8'))
    for (const name of Object.keys(manifest.devDependencies ?? {})) {
      if (name.startsWith('@doxbrix/')) delete manifest.devDependencies[name]
    }
    await writeFile(packagePath, `${JSON.stringify(manifest, null, 2)}\n`)
    await run(npmCommand(), ['install', '--no-audit', '--no-fund', '--loglevel=error'], project)
  }

  step('Preview')
  const port = await freePort()
  await previewOnce(port)

  step(`Build with \`${entry.buildCommand}\``)
  const env = { ...process.env, PATH: buildPath() }
  await run(shell(), shellArgs(entry.buildCommand), project, env)
  await access(join(project, entry.outputDir, 'index.html'))
  console.log(`\nOK: ${generator} scaffolded, previewed, and built ${entry.outputDir}/index.html`)
} finally {
  if (keep) console.log(`Kept ${project}`)
  else await removeWorkspace(parent)
}

/** A dev server can still be flushing files when it is stopped; retry rather than fail the run. */
async function removeWorkspace(directory) {
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      await rm(directory, { recursive: true, force: true, maxRetries: 3 })
      return
    } catch (error) {
      if (attempt === 5) {
        console.warn(`Could not remove ${directory}: ${error.message}`)
        return
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 2000))
    }
  }
}

async function previewOnce(port) {
  // Preview installs the toolchain on first run (venv, gems, node_modules) and
  // serves the site; wait for the first 200 then stop it.
  const child = spawn(process.execPath, [cli, 'preview', '--port', String(port), '--cwd', project], {
    cwd: project,
    env: { ...process.env, PATH: buildPath() },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  })
  let output = ''
  child.stdout.on('data', (chunk) => { output += chunk; process.stdout.write(chunk) })
  child.stderr.on('data', (chunk) => { output += chunk; process.stderr.write(chunk) })
  let exited = false
  child.once('exit', () => { exited = true })
  const deadline = Date.now() + 10 * 60 * 1000
  try {
    while (Date.now() < deadline) {
      if (exited) throw new Error(`Preview exited before serving.\n${output.slice(-2000)}`)
      try {
        const response = await fetch(`http://127.0.0.1:${port}/`)
        if (response.ok) {
          const html = await response.text()
          if (!/<html/i.test(html)) throw new Error('Preview responded without an HTML document.')
          console.log(`Preview served ${html.length} bytes on port ${port}.`)
          return
        }
      } catch (error) {
        if (!(error instanceof TypeError)) throw error
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 1500))
    }
    throw new Error('Preview did not respond within 10 minutes.')
  } finally {
    if (!exited) {
      if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
      else process.kill(-child.pid, 'SIGTERM')
      await new Promise((resolveExit) => {
        const timer = setTimeout(() => { if (!exited && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); resolveExit() }, 10_000)
        child.once('exit', () => { clearTimeout(timer); resolveExit() })
      })
    }
  }
}

function buildPath() {
  const binary = process.platform === 'win32' ? 'Scripts' : 'bin'
  const extra = [join(project, '.doxloop', 'venv', binary), join(project, 'node_modules', '.bin')]
  return [...extra, process.env.PATH ?? ''].join(delimiter)
}

function npmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm'
}

function shell() {
  return process.platform === 'win32' ? (process.env.ComSpec ?? 'cmd.exe') : '/bin/sh'
}

function shellArgs(command) {
  return process.platform === 'win32' ? ['/d', '/s', '/c', command] : ['-c', command]
}

function run(command, args, cwd, env = process.env) {
  return new Promise((resolveExit, reject) => {
    console.log(`$ ${[command, ...args].join(' ')}`)
    const child = spawn(command, args, { cwd, env, stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', (code) => {
      if (code === 0) resolveExit()
      else reject(new Error(`${command} ${args.join(' ')} exited with code ${code}`))
    })
  })
}

function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolvePort(port))
    })
  })
}

// Keep resolve imported for callers that pass relative generator roots.
void resolve
