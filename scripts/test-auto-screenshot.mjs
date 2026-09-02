#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import process from 'node:process'
import { agentArguments } from '../dist/author.js'
import {
  checkScreenCaptureBrowser,
  screenCaptureProvider,
} from '../dist/screen-capture-provider.js'

const options = parseArguments(process.argv.slice(2))
const workspace = resolve(options.output)
const captureDirectory = join(workspace, '.doxloop', 'capture-output')
const screenshot = join(workspace, 'standalone-capture.png')
const logFile = join(workspace, 'agent.log')
const resultFile = join(workspace, 'result.json')
const target = new URL(options.route, options.url).href

await mkdir(captureDirectory, { recursive: true })
await rm(screenshot, { force: true })
await rm(resultFile, { force: true })

const readiness = await checkScreenCaptureBrowser()
if (!readiness.available) fail(readiness.message)

let response
try {
  response = await fetch(target, { signal: AbortSignal.timeout(10_000) })
} catch (error) {
  fail(`Application is not reachable at ${target}: ${error instanceof Error ? error.message : String(error)}`)
}
if (!response.ok) fail(`Application returned HTTP ${response.status} at ${target}.`)

const provider = screenCaptureProvider(workspace, {
  baseUrl: options.url,
  screenshots: {
    policy: 'required',
    viewport: { width: options.width, height: options.height },
  },
})
const prompt = `This is a standalone Doxloop screenshot smoke test.

Use only the doxloop_capture browser tools for browser work.
1. Navigate to ${target}.
2. Wait until the page is stable.
3. Inspect the browser snapshot and identify the visible page heading or primary landmark.
4. Save one PNG screenshot with browser_take_screenshot using exactly this filename: standalone-capture.png
5. Do not modify the application and do not create any other files.
6. In your final response, report the visible heading and confirm the screenshot filename.

The test fails unless browser_take_screenshot is called and the PNG exists.`
const args = agentArguments(options.agent, prompt, {
  mode: 'create',
  nonInteractive: true,
  captureProvider: provider,
  captureRequired: true,
})

process.stdout.write(`Testing ${options.agent} screenshot capture at ${target}\n`)
process.stdout.write(`Output: ${workspace}\n`)

const execution = await run(options.agent, args, workspace, options.timeoutMinutes)
await writeFile(logFile, execution.output, 'utf8')

if (execution.exitCode !== 0) {
  await writeResult(false, `Agent exited with status ${execution.exitCode}.`)
  fail(`Agent exited with status ${execution.exitCode}. See ${logFile}`)
}

let bytes
try {
  bytes = await readFile(screenshot)
} catch {
  await writeResult(false, 'The agent completed without producing the PNG.')
  fail(`The agent completed, but no screenshot was created at ${screenshot}. See ${logFile}`)
}
const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
if (bytes.length < 1_024 || !bytes.subarray(0, 8).equals(pngSignature)) {
  await writeResult(false, `The output is not a valid non-empty PNG (${bytes.length} bytes).`)
  fail(`Invalid screenshot output at ${screenshot}.`)
}

const details = await stat(screenshot)
await writeResult(true, `Captured a valid ${details.size}-byte PNG.`)
process.stdout.write(`PASS: captured ${details.size} bytes at ${screenshot}\n`)

async function writeResult(passed, message) {
  await writeFile(resultFile, `${JSON.stringify({
    passed,
    agent: options.agent,
    target,
    screenshot: 'standalone-capture.png',
    message,
  }, null, 2)}\n`, 'utf8')
}

function run(command, args, cwd, timeoutMinutes) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    const append = (chunk, destination) => {
      const text = chunk.toString()
      output += text
      destination.write(text)
    }
    child.stdout.on('data', (chunk) => append(chunk, process.stdout))
    child.stderr.on('data', (chunk) => append(chunk, process.stderr))
    child.once('error', rejectRun)
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      resolveRun({ exitCode: signal ? 1 : code ?? 1, output })
    })
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
    }, timeoutMinutes * 60_000)
  })
}

function parseArguments(args) {
  const parsed = {
    agent: 'codex',
    url: 'http://127.0.0.1:4317',
    route: '/',
    output: join('.doxloop', 'screenshot-smoke'),
    width: 1440,
    height: 900,
    timeoutMinutes: 5,
  }
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index]
    if (key === '--') continue
    if (key === '--help') usage(0)
    const value = args[index + 1]
    if (!value || value.startsWith('--')) usage(1, `Missing value for ${key}.`)
    if (key === '--agent' && (value === 'codex' || value === 'claude')) parsed.agent = value
    else if (key === '--url') parsed.url = new URL(value).href
    else if (key === '--route') parsed.route = value
    else if (key === '--output') parsed.output = isAbsolute(value) ? value : resolve(value)
    else if (key === '--width') parsed.width = positiveInteger(value, key)
    else if (key === '--height') parsed.height = positiveInteger(value, key)
    else if (key === '--timeout-minutes') parsed.timeoutMinutes = positiveInteger(value, key)
    else usage(1, `Unknown or invalid option: ${key} ${value}`)
    index += 1
  }
  return parsed
}

function positiveInteger(value, option) {
  const number = Number(value)
  if (!Number.isInteger(number) || number <= 0) usage(1, `${option} must be a positive integer.`)
  return number
}

function usage(code, message) {
  if (message) process.stderr.write(`${message}\n\n`)
  process.stderr.write(`Usage: pnpm test:screenshot -- [options]\n\n`)
  process.stderr.write(`  --agent codex|claude       Agent to test (default: codex)\n`)
  process.stderr.write(`  --url URL                  Application base URL\n`)
  process.stderr.write(`  --route PATH               Route to capture (default: /)\n`)
  process.stderr.write(`  --output DIRECTORY         Isolated test output directory\n`)
  process.stderr.write(`  --width PIXELS             Viewport width (default: 1440)\n`)
  process.stderr.write(`  --height PIXELS            Viewport height (default: 900)\n`)
  process.stderr.write(`  --timeout-minutes MINUTES  Agent timeout (default: 5)\n`)
  process.exit(code)
}

function fail(message) {
  process.stderr.write(`FAIL: ${message}\n`)
  process.exit(1)
}
