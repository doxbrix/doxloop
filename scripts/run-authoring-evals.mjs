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

Run the same review, generation, or update fixtures through installed agents.

Options:
  --agent <name>  codex, claude, or gemini; may be repeated
  --case <id>     Run one fixture; may be repeated
  --model <agent=model>  Select a model for one agent; may be repeated
  --mode <review|generation|update>  Evaluation workflow (default: review)
  --regression-threshold <points>  Allowed score drop (default: 3)
  --reasoning <level>  Codex reasoning effort (default: medium)
  --approve-baseline     Replace evals/baseline.json after review
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
const summaries = []
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
      const request = options.mode === 'review'
        ? 'Review the documentation against the persisted brief, configured product source, and professional quality rubric. Report evidence-based findings and do not edit files.'
        : options.mode === 'generation'
          ? 'Create a complete evidence-grounded documentation set for the persisted brief. Replace incomplete pages and validate the result.'
          : 'Apply only the reader-visible changes supported by current evidence. Preserve every unrelated page and validate the result.'
      const model = options.models.get(agent)
      const before = await workspaceDigest(projectRoot)
      const startedAt = Date.now()
      let result
      if (options.mode === 'review') {
        const prepared = await run(process.execPath, [join(root, 'dist', 'cli.js'), 'review', request, '--print', '--cwd', projectRoot], root)
        if (prepared.code !== 0) throw new Error(`Could not prepare the review prompt for ${entry.id}:\n${prepared.stderr}`)
        const responsePath = join(workspace, 'review-response.txt')
        const invocation = headlessInvocation(agent, prepared.stdout.trim(), model, true, responsePath)
        result = await run(invocation.command, invocation.args, projectRoot)
        if (agent === 'codex') {
          const response = await readFile(responsePath, 'utf8').catch(() => '')
          result = { ...result, stdout: response, stderr: result.code === 0 ? result.stderr : `${result.stderr}\n${result.stdout}` }
        }
      } else {
        result = await runPlanFirstUiWorkflow({ projectRoot, agent, model, mode: options.mode, request })
      }
      const report = `${result.stdout}\n${result.stderr}`.trim()
      const durationMs = Date.now() - startedAt
      const scoredText = result.code === 0 ? result.stdout : ''
      const score = scoreReport(scoredText, entry.signalGroups)
      const evidence = scoreReport(scoredText, entry.evidenceGroups ?? [])
      const unchanged = before === (await workspaceDigest(projectRoot))
      const hasPriorities = /\b(blocker|major|minor|priority|severity)\b/i.test(scoredText)
      const hasRubricScore = /\b(?:score|total)\b[^\n]{0,30}\b\d{1,3}\s*\/\s*100\b/i.test(scoredText) || /"score"\s*:\s*\d{1,3}\b/.test(scoredText)
      let quality
      let workspaceEvaluation
      if (options.mode !== 'review' && result.code === 0) {
        const checked = await run(process.execPath, [join(root, 'dist', 'cli.js'), 'quality', '--offline', '--format', 'json', '--cwd', projectRoot], root)
        quality = parseReport(checked.stdout)
        await mkdir(join(resultsRoot, agent), { recursive: true })
        await writeFile(join(resultsRoot, agent, `${entry.id}.quality.txt`), `${checked.stdout}\n${checked.stderr}`)
        if (!quality) quality = { status: 'fail', counts: { failed: 1 }, infrastructureError: 'Quality command did not emit JSON.' }
        const evaluated = await run(process.execPath, [join(root, 'dist', 'cli.js'), 'evaluate', '--format', 'json', '--mode', options.mode, '--cwd', projectRoot, ...(entry.maximumPages ? ['--max-pages', String(entry.maximumPages)] : [])], root)
        workspaceEvaluation = parseReport(evaluated.stdout) ?? { score: 0, infrastructureError: 'Evaluation command did not emit JSON.' }
        await writeFile(join(resultsRoot, agent, `${entry.id}.evaluation.txt`), `${evaluated.stdout}\n${evaluated.stderr}`)
      }
      const passed = options.mode === 'review'
        ? result.code === 0 && score.matched >= entry.minimumSignalGroups && evidence.matched >= (entry.minimumEvidenceGroups ?? 0) && hasPriorities && hasRubricScore && unchanged
        : result.code === 0 && !unchanged && quality?.status !== 'fail' && workspaceEvaluation?.score >= (entry.minimumEvaluationScore ?? 60)
      if (!passed) failures += 1
      const aggregateScore = options.mode === 'review' ? Math.round(100 * (score.matched + evidence.matched) / Math.max(entry.signalGroups.length + (entry.evidenceGroups ?? []).length, 1)) : (workspaceEvaluation?.score ?? null)
      summaries.push({ exitCode: result.code, executionStatus: result.code === 0 ? 'completed' : 'failed', agentVersion: (await run(agent, ['--version'], root)).stdout.trim(), fixtureDigest: await workspaceDigest(join(root, 'evals', 'fixtures', entry.id)), nodeVersion: process.version, agent, model: model ?? 'default', reasoning: agent === 'codex' ? options.reasoning : undefined, runtimeDigest: await workspaceDigest(join(root, 'dist')), case: entry.id, mode: options.mode, productType: entry.productType, score: aggregateScore, matchedSignals: score.matched, totalSignals: entry.signalGroups.length, matchedEvidence: evidence.matched, totalEvidence: (entry.evidenceGroups ?? []).length, prioritized: hasPriorities, rubricScore: hasRubricScore, readOnly: unchanged, qualityStatus: quality?.status, durationMs, passed })

      const agentRoot = join(resultsRoot, agent)
      await mkdir(agentRoot, { recursive: true })
      if (options.mode !== 'review') await cp(projectRoot, join(agentRoot, `${entry.id}-workspace`), { recursive: true, filter: (path) => !/(?:^|[/\\])(?:node_modules|[.]git|[.]claude|[.]agents|[.]codex|runs|ui-job-logs)(?:[/\\]|$)/.test(path) })
      if (options.mode !== 'review') {
        const runDirectory = join(projectRoot, '.doxloop', 'runs')
        for (const runId of await readdir(runDirectory).catch(() => [])) {
          await cp(join(runDirectory, runId), join(agentRoot, `${entry.id}-proposals`, runId), { recursive: true, filter: (path) => !/(?:^|[/\\])(?:node_modules|[.]git|[.]claude|[.]agents|[.]codex|ui-job-logs)(?:[/\\]|$)/.test(path) })
        }
      }
      await writeFile(
        join(agentRoot, `${entry.id}.txt`),
        [
          `agent: ${agent}`,
          `model: ${model ?? 'default'}`,
          `case: ${entry.id}`,
          `mode: ${options.mode}`,
          `exitCode: ${result.code}`,
          `matchedSignals: ${score.matched}/${entry.signalGroups.length}`,
          `minimumSignals: ${entry.minimumSignalGroups}`,
          `matchedEvidence: ${evidence.matched}/${(entry.evidenceGroups ?? []).length}`,
          `minimumEvidence: ${entry.minimumEvidenceGroups ?? 0}`,
          `prioritized: ${hasPriorities}`,
          `rubricScore: ${hasRubricScore}`,
          `readOnly: ${unchanged}`,
          `durationMs: ${durationMs}`,
          ...(quality ? [`qualityStatus: ${quality.status}`, `qualityFailures: ${quality.counts?.failed ?? 0}`] : []),
          ...(workspaceEvaluation ? [`evaluationScore: ${workspaceEvaluation.score}`] : []),
          `result: ${passed ? 'pass' : 'fail'}`,
          '',
          report,
          '',
        ].join('\n'),
      )
      process.stdout.write(
        `${passed ? 'pass' : 'fail'} ${agent}/${entry.id}: ${options.mode === 'review' ? `${score.matched}/${entry.signalGroups.length} signals` : result.code !== 0 ? 'workflow failed; quality not scored' : `quality ${aggregateScore}/100`}\n`,
      )
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  }
}

const baselinePath = join(root, 'evals', 'baseline.json')
let regressions = []
try {
  const baseline = JSON.parse(await readFile(baselinePath, 'utf8'))
  regressions = summaries.flatMap((summary) => {
    const previous = baseline.results?.find((entry) => entry.agent === summary.agent && entry.model === summary.model && entry.case === summary.case && (entry.mode ?? 'review') === summary.mode && (entry.reasoning ?? 'unspecified') === (summary.reasoning ?? 'unspecified') && entry.fixtureDigest === summary.fixtureDigest)
    if (!previous) return []
    if (summary.score === null || previous.score === null) return []
    const delta = summary.score - previous.score
    return delta < -options.regressionThreshold ? [{ ...summary, baselineScore: previous.score, delta }] : []
  })
} catch {
  // A baseline is optional until explicitly approved.
}
if (regressions.length > 0) failures += regressions.length
const matrix = { schemaVersion: 1, contractVersion: '1.0.0', generatedAt: new Date().toISOString(), regressionThreshold: options.regressionThreshold, results: summaries, regressions }
await writeFile(join(resultsRoot, 'matrix.json'), `${JSON.stringify(matrix, null, 2)}\n`)
if (options.approveBaseline) {
  if (failures > 0) throw new Error('A failing evaluation cannot replace the approved baseline. Inspect its reports first.')
  let previous = { results: [] }
  try { previous = JSON.parse(await readFile(baselinePath, 'utf8')) } catch (error) { if (error.code !== 'ENOENT') throw error }
  const key = (entry) => JSON.stringify([entry.agent, entry.model, entry.mode ?? 'review', entry.case, entry.reasoning ?? 'unspecified'])
  const replacements = new Map(summaries.map((entry) => [key(entry), entry]))
  for (const entry of previous.results ?? []) if (!replacements.has(key(entry))) replacements.set(key(entry), entry)
  await writeFile(baselinePath, `${JSON.stringify({ ...matrix, results: [...replacements.values()] }, null, 2)}\n`)
}
process.stdout.write(`Evaluation reports: ${resultsRoot}\n`)
if (regressions.length > 0) process.stdout.write(`Release blocked by ${regressions.length} agent/model regression${regressions.length === 1 ? '' : 's'}.\n`)
process.exitCode = failures === 0 ? 0 : 1

function parseArgs(args) {
  const output = { agents: [], cases: [], models: new Map(), reasoning: 'medium', mode: 'review', regressionThreshold: 3, approveBaseline: false, help: false }
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--help') output.help = true
    else if (argument === '--approve-baseline') output.approveBaseline = true
    else if (argument === '--agent' || argument === '--case' || argument === '--model' || argument === '--mode' || argument === '--regression-threshold' || argument === '--reasoning') {
      const value = args[index + 1]
      if (!value || value.startsWith('--')) {
        throw new Error(`${argument} needs a value.`)
      }
      if (argument === '--reasoning') { if (!['low', 'medium', 'high', 'xhigh'].includes(value)) throw new Error('Choose low, medium, high, or xhigh reasoning.'); output.reasoning = value }
      else if (argument === '--agent') output.agents.push(value)
      else if (argument === '--case') output.cases.push(value)
      else if (argument === '--mode') {
        if (!['review', 'generation', 'update'].includes(value)) throw new Error('--mode must be review, generation, or update.')
        output.mode = value
      }
      else if (argument === '--model') {
        const separator = value.indexOf('=')
        if (separator < 1 || !value.slice(separator + 1)) throw new Error('--model must use agent=model.')
        output.models.set(value.slice(0, separator), value.slice(separator + 1))
      } else {
        output.regressionThreshold = Number(value)
        if (!Number.isFinite(output.regressionThreshold) || output.regressionThreshold < 0) throw new Error('--regression-threshold must be zero or greater.')
      }
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
    const timer = setTimeout(() => child.kill('SIGTERM'), 15 * 60_000)
    timer.unref()
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.once('error', (error) => { clearTimeout(timer); reject(error) })
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      resolveRun({
        code: signal ? 1 : (code ?? 1),
        stdout,
        stderr: signal ? `${stderr}\nStopped by ${signal}.` : stderr,
      })
    })
  })
}

function entryLimit(mode) { return mode === 'update' ? 5 : 8 }

async function runPlanFirstUiWorkflow({ projectRoot, agent, model, mode, request }) {
  const port = 44000 + Math.floor(Math.random() * 15000)
  const origin = `http://127.0.0.1:${port}`
  const child = spawn(process.execPath, [join(root, 'dist', 'cli.js'), 'ui', '--no-open', '--port', String(port), '--cwd', projectRoot], { cwd: root, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''; let errorOutput = ''
  child.stdout.on('data', (chunk) => { output += chunk })
  child.stderr.on('data', (chunk) => { errorOutput += chunk })
  try {
    await waitUntil(async () => {
      try { return (await fetch(origin)).ok } catch { return false }
    }, 15_000, 'The evaluation UI server did not start.')
    const initial = await fetch(origin)
    const cookie = initial.headers.get('set-cookie')?.split(';')[0]
    if (!cookie) throw new Error('The evaluation UI did not establish a local session.')
    const api = async (path, init = {}) => {
      const response = await fetch(`${origin}${path}`, { ...init, headers: { cookie, origin, 'content-type': 'application/json', ...(init.headers ?? {}) } })
      const body = await response.json()
      if (!response.ok) throw new Error(body.error ?? `${path} returned ${response.status}`)
      return body
    }
    const started = await api('/api/plans', { method: 'POST', body: JSON.stringify({ mode: mode === 'generation' ? 'create' : 'update', scope: 'comprehensive', request, agent, ...(model ? { model } : {}), ...(agent === 'codex' ? { reasoning: options.reasoning } : {}), clarificationMode: 'defaults', screenshots: false, limits: { maxPages: entryLimit(mode), maxScreenshots: 0, maxMinutes: 15 } }) })
    const planId = started.plan.id
    await waitUntil(async () => {
      const plan = await api(`/api/plans/${planId}`)
      if (plan.status === 'failed' || plan.status === 'cancelled') throw new Error(plan.error ?? `Planning ended as ${plan.status}.`)
      return plan.status === 'ready-for-review'
    }, 15 * 60_000, 'Planning did not reach review.')
    await api(`/api/plans/${planId}/approve`, { method: 'POST', body: '{}' })
    await api(`/api/plans/${planId}/generate`, { method: 'POST', body: '{}' })
    await waitUntil(async () => {
      const plan = await api(`/api/plans/${planId}`)
      if (plan.status === 'failed' || plan.status === 'cancelled' || plan.status === 'stale') throw new Error(plan.error ?? `Generation ended as ${plan.status}.`)
      return plan.status === 'generated'
    }, 30 * 60_000, 'Generation did not produce a review proposal.')
    const proposals = await api('/api/proposals')
    const proposal = proposals.find((item) => item.status === 'awaiting-review' && item.changes?.length)
    if (!proposal) throw new Error('The plan-first workflow did not produce a reviewable proposal.')
    const applied = await api(`/api/proposals/${proposal.id}/accept`, { method: 'POST', body: JSON.stringify({ scope: 'all' }) })
    if (applied.status !== 'applied') throw new Error(`The generated proposal ended as ${applied.status}.`)
    return { code: 0, stdout: `${output}\nPlan ${planId} approved; proposal ${proposal.id} applied.`, stderr: errorOutput }
  } catch (error) {
    return { code: 1, stdout: output, stderr: `${errorOutput}\n${error instanceof Error ? error.message : String(error)}` }
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM')
      await new Promise((resolveExit) => child.once('exit', resolveExit))
    }
  }
}

async function waitUntil(check, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500))
  }
  throw new Error(message)
}

function headlessInvocation(agent, prompt, model, readOnly, responsePath) {
  if (agent === 'codex') {
    return {
      command: 'codex',
      args: [
        'exec',
        '--sandbox',
        readOnly ? 'read-only' : 'workspace-write',
        '--skip-git-repo-check',
        ...(responsePath ? ['--output-last-message', responsePath] : []),
        '--ephemeral', '-c', `model_reasoning_effort=${JSON.stringify(options.reasoning)}`,
        ...(model ? ['--model', model] : []),
        prompt,
      ],
    }
  }
  if (agent === 'claude') {
    return {
      command: 'claude',
      args: ['--print', '--permission-mode', readOnly ? 'plan' : 'acceptEdits', '--max-turns', '20', ...(model ? ['--model', model] : []), prompt],
    }
  }
  return {
    command: 'gemini',
    args: ['--approval-mode', readOnly ? 'plan' : 'auto_edit', ...(model ? ['--model', model] : []), '--prompt', prompt],
  }
}

function parseReport(text) {
  try { return JSON.parse(text) } catch { /* A generator may write build progress before the report. */ }
  const starts = [...text.matchAll(/^\{/gm)].map((match) => match.index).reverse()
  for (const start of starts) { try { return JSON.parse(text.slice(start)) } catch { /* Try the preceding object. */ } }
  return undefined
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
