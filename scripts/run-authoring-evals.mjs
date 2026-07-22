#!/usr/bin/env node

import { constants } from 'node:fs'
import { createHash } from 'node:crypto'
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(
  await readFile(join(root, 'evals', 'cases.json'), 'utf8'),
)
const options = parseArgs(process.argv.slice(2))

if (options.help) {
  process.stdout.write(`Usage: pnpm eval:agents -- [options]

Run the same read-only documentation-review fixtures through installed agents.

Options:
  --agent <name>  codex, claude, or gemini; may be repeated
  --case <id>     Run one fixture; may be repeated
  --help          Show this help
`)
  process.exit(0)
}

const requestedAgents =
  options.agents.length > 0 ? options.agents : ['codex', 'claude', 'gemini']
const agents = []
for (const agent of requestedAgents) {
  if (!['codex', 'claude', 'gemini'].includes(agent)) {
    throw new Error(`Unsupported agent "${agent}".`)
  }
  if (await executableExists(agent)) agents.push(agent)
  else if (options.agents.length > 0) {
    throw new Error(`${agent} is not available on PATH.`)
  } else {
    process.stdout.write(`skip ${agent}: not available on PATH\n`)
  }
}
if (agents.length === 0) throw new Error('No supported agents are available on PATH.')

const cases = manifest.cases.filter(
  (entry) => options.cases.length === 0 || options.cases.includes(entry.id),
)
if (cases.length === 0) throw new Error('No matching evaluation cases.')

const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
const resultsRoot = join(root, 'evals', 'results', timestamp)
await mkdir(resultsRoot, { recursive: true })

let failures = 0
for (const agent of agents) {
  for (const entry of cases) {
    const workspace = await mkdtemp(join(tmpdir(), `doxloop-eval-${entry.id}-`))
    try {
      await cp(join(root, 'evals', 'fixtures', entry.id), workspace, {
        recursive: true,
      })
      const projectRoot = join(workspace, 'project')
      const setup = await run(
        process.execPath,
        [
          join(root, 'dist', 'cli.js'),
          'agent',
          'setup',
          '--agent',
          agent,
          '--cwd',
          projectRoot,
        ],
        root,
      )
      if (setup.code !== 0) {
        throw new Error(
          `Could not install ${agent} skills for ${entry.id}:\n${setup.stderr}`,
        )
      }
      const prepared = await run(
        process.execPath,
        [
          join(root, 'dist', 'cli.js'),
          'review',
          'Review the documentation against the persisted brief, configured product source, and professional quality rubric. Report evidence-based findings and do not edit files.',
          '--print',
          '--cwd',
          projectRoot,
        ],
        root,
      )
      if (prepared.code !== 0) {
        throw new Error(
          `Could not prepare the review prompt for ${entry.id}:\n${prepared.stderr}`,
        )
      }
      const invocation = headlessInvocation(agent, prepared.stdout.trim())
      const before = await workspaceDigest(projectRoot)
      const result = await run(
        invocation.command,
        invocation.args,
        projectRoot,
      )
      const report = `${result.stdout}\n${result.stderr}`.trim()
      const score = scoreReport(report, entry.signalGroups)
      const evidence = scoreReport(report, entry.evidenceGroups ?? [])
      const unchanged = before === (await workspaceDigest(projectRoot))
      const hasPriorities = /\b(blocker|major|minor|priority|severity)\b/i.test(report)
      const hasRubricScore = /\b(?:score|total)\b[^\n]{0,30}\b\d{1,3}\s*\/\s*100\b/i.test(report)
      const passed =
        result.code === 0 &&
        score.matched >= entry.minimumSignalGroups &&
        evidence.matched >= (entry.minimumEvidenceGroups ?? 0) &&
        hasPriorities &&
        hasRubricScore &&
        unchanged
      if (!passed) failures += 1

      const agentRoot = join(resultsRoot, agent)
      await mkdir(agentRoot, { recursive: true })
      await writeFile(
        join(agentRoot, `${entry.id}.txt`),
        [
          `agent: ${agent}`,
          `case: ${entry.id}`,
          `exitCode: ${result.code}`,
          `matchedSignals: ${score.matched}/${entry.signalGroups.length}`,
          `minimumSignals: ${entry.minimumSignalGroups}`,
          `matchedEvidence: ${evidence.matched}/${(entry.evidenceGroups ?? []).length}`,
          `minimumEvidence: ${entry.minimumEvidenceGroups ?? 0}`,
          `prioritized: ${hasPriorities}`,
          `rubricScore: ${hasRubricScore}`,
          `readOnly: ${unchanged}`,
          `result: ${passed ? 'pass' : 'fail'}`,
          '',
          report,
          '',
        ].join('\n'),
      )
      process.stdout.write(
        `${passed ? 'pass' : 'fail'} ${agent}/${entry.id}: ${score.matched}/${entry.signalGroups.length} signals\n`,
      )
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  }
}

process.stdout.write(`Evaluation reports: ${resultsRoot}\n`)
process.exitCode = failures === 0 ? 0 : 1

function parseArgs(args) {
  const output = { agents: [], cases: [], help: false }
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--help') output.help = true
    else if (argument === '--agent' || argument === '--case') {
      const value = args[index + 1]
      if (!value || value.startsWith('--')) {
        throw new Error(`${argument} needs a value.`)
      }
      if (argument === '--agent') output.agents.push(value)
      else output.cases.push(value)
      index += 1
    } else {
      throw new Error(`Unknown option "${argument}".`)
    }
  }
  return output
}

async function executableExists(name) {
  const path = process.env.PATH
  if (!path) return false
  const suffixes =
    process.platform === 'win32'
      ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';')
      : ['']
  for (const directory of path.split(delimiter)) {
    for (const suffix of suffixes) {
      const candidate = join(directory, `${name}${suffix.toLowerCase()}`)
      try {
        await access(candidate, process.platform === 'win32' ? constants.F_OK : constants.X_OK)
        return true
      } catch {
        // Continue searching PATH.
      }
    }
  }
  return false
}

function run(command, args, cwd) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      resolveRun({
        code: signal ? 1 : (code ?? 1),
        stdout,
        stderr: signal ? `${stderr}\nStopped by ${signal}.` : stderr,
      })
    })
  })
}

function headlessInvocation(agent, prompt) {
  if (agent === 'codex') {
    return {
      command: 'codex',
      args: [
        'exec',
        '--sandbox',
        'read-only',
        '--skip-git-repo-check',
        '--ephemeral',
        prompt,
      ],
    }
  }
  if (agent === 'claude') {
    return {
      command: 'claude',
      args: ['--print', '--permission-mode', 'plan', '--max-turns', '20', prompt],
    }
  }
  return {
    command: 'gemini',
    args: ['--approval-mode', 'plan', '--prompt', prompt],
  }
}

function scoreReport(report, groups) {
  const normalized = report.toLowerCase()
  return {
    matched: groups.filter((group) =>
      group.some((signal) => normalized.includes(signal.toLowerCase())),
    ).length,
  }
}

async function workspaceDigest(directory) {
  const hash = createHash('sha256')
  for (const file of await treeFiles(directory, directory)) {
    hash.update(file.relative)
    hash.update('\0')
    hash.update(await readFile(file.absolute))
    hash.update('\0')
  }
  return hash.digest('hex')
}

async function treeFiles(root, directory) {
  const output = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name)
    const relativePath = absolute.slice(root.length + 1).split('\\').join('/')
    if (
      relativePath === '.git' ||
      relativePath.startsWith('.git/') ||
      relativePath === 'node_modules' ||
      relativePath.startsWith('node_modules/') ||
      relativePath === '.doxloop/cache' ||
      relativePath.startsWith('.doxloop/cache/')
    ) {
      continue
    }
    if (entry.isDirectory()) output.push(...(await treeFiles(root, absolute)))
    else if (entry.isFile()) {
      output.push({
        absolute,
        relative: relativePath,
      })
    }
  }
  return output.sort((a, b) => a.relative.localeCompare(b.relative))
}
