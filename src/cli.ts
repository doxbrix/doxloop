#!/usr/bin/env node

import { resolve } from 'node:path'
import {
  assertAllowedFlags,
  booleanFlag,
  flag,
  flags,
  numberFlag,
  parseArgs,
} from './args.js'
import { chooseAgent, installSkill, parseAgent, skillStatus } from './agents.js'
import { login, logout, whoami } from './auth.js'
import {
  parseReasoning,
  resolveScreenshotIntent,
  runAuthor,
} from './author.js'
import { capture } from './capture.js'
import { deploy } from './deploy.js'
import { formatDoctorReport, runDoctor } from './doctor.js'
import { DoxloopError, UsageError } from './errors.js'
import {
  addGenerator,
  diagnoseGenerator,
  formatGeneratorInfo,
  formatGeneratorList,
  removeGenerator,
} from './generator-manager.js'
import { GENERATOR_CATALOG, parseGenerator } from './generators.js'
import {
  addDesignReferences,
  findProjectRoot,
  loadProject,
  parseDesignReference,
  parseSource,
  resolveSeparateProjectLayout,
  scaffoldProject,
  validateProjectSourceBoundaries,
} from './project.js'
import { startPreview } from './preview.js'
import { confirmPublicDeployment } from './public-deploy-confirmation.js'
import type { ParsedArgs } from './types.js'
import { formatValidation, validateProject } from './validation.js'
import { VERSION } from './version.js'

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2))
  validateCommandArguments(args)
  if (booleanFlag(args, 'version', 'v')) {
    process.stdout.write(`${VERSION}\n`)
    return 0
  }
  if (args.command === undefined || booleanFlag(args, 'help', 'h')) {
    process.stdout.write(help(args.command))
    return 0
  }

  const cwd = resolve(flag(args, 'cwd') ?? process.cwd())
  switch (args.command) {
    case 'init':
      return initCommand(args, cwd)
    case 'agent':
      return agentCommand(args, cwd)
    case 'generator':
      return generatorCommand(args, cwd)
    case 'doctor': {
      const source = flag(args, 'source')
      const output = flag(args, 'output')
      const selectedAgent = parseAgent(flag(args, 'agent'))
      const report = await runDoctor({
        cwd,
        ...(source ? { source } : {}),
        ...(output ? { output } : {}),
        ...(selectedAgent ? { agent: selectedAgent } : {}),
      })
      process.stdout.write(`${formatDoctorReport(report)}\n`)
      return report.ready ? 0 : 1
    }
    case 'create':
      if (flag(args, 'source') !== undefined || flag(args, 'output') !== undefined) {
        return createProjectCommand(args, cwd)
      }
      return authorCommand(args, cwd, 'create')
    case 'update':
      return authorCommand(args, cwd, 'update')
    case 'review': {
      return authorCommand(args, cwd, 'review')
    }
    case 'capture': {
      const root = await findProjectRoot(cwd)
      await capture({ root, urls: args.positionals })
      return 0
    }
    case 'test': {
      const root = await findProjectRoot(cwd)
      const result = await validateProject(root)
      const format = outputFormat(flag(args, 'format'))
      process.stdout.write(
        format === 'json'
          ? `${JSON.stringify(result, null, 2)}\n`
          : `${formatValidation(result)}\n`,
      )
      return result.errors > 0 ? 1 : 0
    }
    case 'status':
      return statusCommand(cwd, outputFormat(flag(args, 'format')))
    case 'preview': {
      const root = await findProjectRoot(cwd)
      await startPreview({
        root,
        host: flag(args, 'host') ?? '127.0.0.1',
        port: numberFlag(args, 'port', 4321),
        open: booleanFlag(args, 'open'),
      })
      return 0
    }
    case 'login':
      {
        const apiOverride = flag(args, 'api-url')
        const token = flag(args, 'token')
        await login({
          ...(apiOverride ? { apiUrl: apiOverride } : {}),
          ...(token ? { token } : {}),
        })
      }
      return 0
    case 'logout':
      await logout()
      process.stdout.write('Signed out of Doxbrix.\n')
      return 0
    case 'whoami':
      await whoami(flag(args, 'api-url'))
      return 0
    case 'deploy': {
      const root = await findProjectRoot(cwd)
      const name = flag(args, 'name')
      const slug = flag(args, 'slug')
      const apiOverride = flag(args, 'api-url')
      const dryRun = booleanFlag(args, 'dry-run')
      const publicSite = booleanFlag(args, 'public')
      if (publicSite && !dryRun && !(await confirmPublicDeployment())) {
        throw new DoxloopError('Public deployment canceled. No data was uploaded.')
      }
      await deploy({
        root,
        ...(name ? { name } : {}),
        ...(slug ? { slug } : {}),
        dryRun,
        public: publicSite,
        ...(apiOverride ? { apiUrl: apiOverride } : {}),
      })
      return 0
    }
    default:
      throw new UsageError(
        `Unknown command "${args.command}". Run \`doxloop --help\` for available commands.`,
      )
  }
}

async function initCommand(args: ParsedArgs, cwd: string): Promise<number> {
  const directory = args.positionals[0]
  if (!directory) throw new UsageError('Usage: doxloop init <directory> [--source name=path]')
  if (args.positionals.length > 1) {
    throw new UsageError('The init command accepts one destination directory.')
  }
  const sources = flags(args, 'source').map(parseSource)
  const designReferences = flags(args, 'reference').map(parseDesignReference)
  const title = flag(args, 'title')
  const generator = parseGenerator(flag(args, 'generator'))
  const projectRoot = resolve(cwd, directory)
  await validateProjectSourceBoundaries(projectRoot, sources)
  const root = await scaffoldProject({
    directory: projectRoot,
    ...(title ? { title } : {}),
    sources,
    designReferences,
    ...(generator ? { generator } : {}),
  })
  const installs = await installSkill({ root })
  process.stdout.write(`Created Doxloop project at ${root}\n`)
  for (const install of installs) {
    process.stdout.write(`${install.action}: ${install.path}\n`)
  }
  process.stdout.write(
    `\nNext:\n  cd ${directory}\n  doxloop create\n  doxloop preview --open\n  doxloop test\n`,
  )
  return 0
}

async function createProjectCommand(
  args: ParsedArgs,
  cwd: string,
): Promise<number> {
  const source = flag(args, 'source')
  const output = flag(args, 'output')
  if (!source || !output) {
    throw new UsageError(
      'Creating a new documentation project requires both `--source <product-directory>` and `--output <documentation-directory>`.',
    )
  }
  if (flags(args, 'source').length > 1 || flags(args, 'output').length > 1) {
    throw new UsageError(
      'The first-run create command accepts one source and one output directory.',
    )
  }

  const layout = await resolveSeparateProjectLayout({ cwd, source, output })
  const requestedAgent = parseAgent(flag(args, 'agent'))
  const print = booleanFlag(args, 'print')
  const selectedAgent = print ? requestedAgent : (await chooseAgent(requestedAgent)).name
  const designReferences = flags(args, 'reference').map(parseDesignReference)
  const model = flag(args, 'model')
  const reasoning = parseReasoning(flag(args, 'reasoning'))
  const screenshots = screenshotIntent(args)
  if (reasoning && selectedAgent && selectedAgent !== 'codex') {
    throw new DoxloopError(
      `--reasoning is only supported with Codex. Configure the reasoning behavior of ${selectedAgent} in its own settings.`,
      2,
    )
  }

  process.stdout.write(
    `Welcome to Doxloop\n\nProduct source:\n  ${layout.sourceRoot}\n  Read-only — product files will not be changed or deployed.\n\nDocumentation project:\n  ${layout.projectRoot}\n  Only this project can be previewed or deployed.\n\n`,
  )

  const root = await scaffoldProject({
    directory: layout.projectRoot,
    sources: [layout.sourceBinding],
    designReferences,
  })
  if (print) {
    await installSkill({
      root,
      ...(selectedAgent ? { agent: selectedAgent } : {}),
    })
  }

  const result = await runAuthor({
    root,
    mode: 'create',
    ...(selectedAgent ? { agent: selectedAgent } : {}),
    ...(model ? { model } : {}),
    ...(reasoning ? { reasoning } : {}),
    screenshots,
    print,
    ...(args.positionals.length > 0
      ? { request: args.positionals.join(' ') }
      : {}),
  })

  if (result === 0 && !print) {
    const validation = await validateProject(root)
    process.stdout.write(
      `\nDocumentation created successfully.\n\nPages created: ${validation.pages.length}\nDocumentation project: ${root}\nProduct source files included in deployment: 0\n\nPreview the documentation:\n  cd ${root}\n  doxloop preview --open\n\nWhen the product changes:\n  cd ${root}\n  doxloop update\n`,
    )
  }
  return result
}

async function authorCommand(
  args: ParsedArgs,
  cwd: string,
  mode: 'create' | 'update' | 'review',
): Promise<number> {
  const root = await findProjectRoot(cwd)
  if (mode !== 'review') {
    const project = await loadProject(root)
    await validateProjectSourceBoundaries(root, project.sources)
  }
  const selectedAgent = parseAgent(flag(args, 'agent'))
  const request = args.positionals.join(' ') || undefined
  const designReferences = flags(args, 'reference').map(parseDesignReference)
  if (mode !== 'review') await addDesignReferences(root, designReferences)
  const model = flag(args, 'model')
  const reasoning = parseReasoning(flag(args, 'reasoning'))
  const screenshots = screenshotIntent(args)
  return runAuthor({
    root,
    mode,
    ...(selectedAgent ? { agent: selectedAgent } : {}),
    ...(model ? { model } : {}),
    ...(reasoning ? { reasoning } : {}),
    screenshots,
    print: booleanFlag(args, 'print'),
    ...(request || (mode === 'review' && designReferences.length > 0)
      ? {
          request: [
            request,
            ...(mode === 'review'
              ? designReferences.map(
                  (reference) =>
                    `Use ${reference.url} as an external documentation design reference for this read-only review.`,
                )
              : []),
          ]
            .filter(Boolean)
            .join('\n'),
        }
      : {}),
  })
}

async function agentCommand(args: ParsedArgs, cwd: string): Promise<number> {
  const action = args.positionals[0]
  if (!action || !['setup', 'status', 'update'].includes(action)) {
    throw new UsageError('Usage: doxloop agent <setup|status|update> [--agent <name>]')
  }
  const root = await findProjectRoot(cwd)
  if (action === 'status') {
    for (const item of await skillStatus(root)) {
      process.stdout.write(`${item.status.padEnd(8)} ${item.path}\n`)
    }
    return 0
  }
  const selected = parseAgent(flag(args, 'agent'))
  const results = await installSkill({
    root,
    ...(selected ? { agent: selected } : {}),
    replace: action === 'update',
  })
  for (const item of results) process.stdout.write(`${item.action}: ${item.path}\n`)
  return 0
}

async function generatorCommand(args: ParsedArgs, cwd: string): Promise<number> {
  const action = args.positionals[0]
  if (!action || !['list', 'add', 'remove', 'info', 'doctor'].includes(action)) {
    throw new UsageError(
      'Usage: doxloop generator <list|add|remove|info|doctor> [generator]',
    )
  }
  if (action === 'list') {
    process.stdout.write(`${await formatGeneratorList(cwd)}\n`)
    return 0
  }
  if (action === 'doctor') {
    process.stdout.write(`${await diagnoseGenerator(cwd)}\n`)
    return 0
  }
  const generator = args.positionals[1]
  if (!generator) {
    throw new UsageError(`Usage: doxloop generator ${action} <generator>`)
  }
  if (args.positionals.length > 2) {
    throw new UsageError(`The generator ${action} command accepts one generator name.`)
  }
  if (action === 'add') {
    await addGenerator(cwd, generator)
    return 0
  }
  if (action === 'remove') {
    await removeGenerator(cwd, generator)
    return 0
  }
  process.stdout.write(`${await formatGeneratorInfo(cwd, generator)}\n`)
  return 0
}

async function statusCommand(cwd: string, format?: string): Promise<number> {
  const root = await findProjectRoot(cwd)
  const project = await loadProject(root)
  const result = await validateProject(root)
  if (format === 'json') {
    process.stdout.write(
      `${JSON.stringify(
        {
          title: project.title,
          root,
          generator: project.generator,
          pages: result.pages.length,
          sources: project.sources,
          designReferences: project.designReferences,
          ...(project.application ? { application: project.application } : {}),
          errors: result.errors,
          warnings: result.warnings,
        },
        null,
        2,
      )}\n`,
    )
  } else {
    process.stdout.write(
      `${project.title}\nRoot: ${root}\nGenerator: ${project.generator}\nPages: ${result.pages.length}\nSources: ${project.sources.length}\nDesign references: ${project.designReferences.length}\nApplication screenshots: ${project.application ? `${project.application.screenshots?.policy ?? 'requested'} (${project.application.baseUrl})` : 'not configured'}\nErrors: ${result.errors}\nWarnings: ${result.warnings}\n`,
    )
    for (const source of project.sources) {
      process.stdout.write(`source ${source.name}: ${source.path}\n`)
    }
  }
  return result.errors > 0 ? 1 : 0
}

function validateCommandArguments(args: ParsedArgs): void {
  const allowed: Record<string, string[]> = {
    init: ['title', 'source', 'reference', 'generator'],
    agent: ['agent'],
    generator: [],
    doctor: ['source', 'output', 'agent'],
    create: ['agent', 'model', 'reasoning', 'reference', 'print', 'screenshots', 'no-screenshots', 'source', 'output'],
    update: ['agent', 'model', 'reasoning', 'reference', 'print', 'screenshots', 'no-screenshots'],
    review: ['agent', 'model', 'reasoning', 'reference', 'print'],
    capture: [],
    test: ['format'],
    status: ['format'],
    preview: ['host', 'port', 'open'],
    login: ['api-url', 'token'],
    logout: [],
    whoami: ['api-url'],
    deploy: ['dry-run', 'public', 'name', 'slug', 'api-url'],
  }
  if (args.command === undefined) {
    assertAllowedFlags(args, new Set())
    return
  }
  const commandFlags = allowed[args.command]
  if (commandFlags === undefined) return
  assertAllowedFlags(args, new Set(commandFlags))
  if (
    !['init', 'agent', 'generator', 'create', 'update', 'review', 'capture'].includes(
      args.command,
    ) &&
    args.positionals.length > 0
  ) {
    throw new UsageError(`The ${args.command} command does not accept arguments.`)
  }
}

function screenshotIntent(args: ParsedArgs): 'auto' | 'enabled' | 'disabled' {
  if (args.command === 'review') return 'disabled'
  return resolveScreenshotIntent(
    booleanFlag(args, 'screenshots'),
    booleanFlag(args, 'no-screenshots'),
  )
}

function outputFormat(value: string | undefined): 'text' | 'json' {
  if (value === undefined || value === 'text') return 'text'
  if (value === 'json') return 'json'
  throw new UsageError('--format must be text or json')
}

function help(command?: string): string {
  if (command === 'init') {
    return `Usage: doxloop init <directory> [options]

Create a local documentation project and install the authoring and format skills.

Options:
  --title <title>          Documentation site title
  --source <name=path>     Add a local product source; may be repeated
  --reference <url>        Add a documentation design reference; may be repeated
  --generator <name>       Generator: ${GENERATOR_CATALOG.map((entry) => entry.id).join(', ')}
  --cwd <directory>        Resolve paths from this directory
`
  }
  if (command === 'agent') {
    return `Usage: doxloop agent <setup|status|update> [options]

Install or inspect the project-local Doxloop authoring and format skills.

Options:
  --agent <name>           codex, claude, or gemini
  --cwd <directory>        Run from this project directory
`
  }
  if (command === 'generator') {
    return `Usage: doxloop generator <action> [generator]

Install and inspect generator packages.

Actions:
  list                     List official generators and installation state
  add <generator>          Install a generator package in the current project
  remove <generator>       Remove an unused generator package
  info <generator>         Show package, skill, build, and output information
  doctor                   Verify the current project's selected generator

Options:
  --cwd <directory>        Run from this directory
`
  }
  if (command === 'doctor') {
    return `Usage: doxloop doctor [options]

Check whether Doxloop is ready to create, update, and preview documentation.

Run inside an existing documentation project, or check a new project layout:
  doxloop doctor --source ./my-product --output ./my-docs

Options:
  --source <directory>      Read-only product source for a new project check
  --output <directory>      Separate documentation output for a new project check
  --agent <name>            Check codex, claude, or gemini
  --cwd <directory>         Run from this directory
`
  }
  if (command === 'create' || command === 'update' || command === 'review') {
    const screenshotOptions =
      command === 'review'
        ? ''
        : `  --screenshots            Capture and embed application guide screenshots
  --no-screenshots         Do not capture application screenshots
`
    const createUsage = command === 'create'
      ? `\nCreate a separate documentation project from an existing product:\n  doxloop create --source <product-directory> --output <documentation-directory> [request]\n`
      : ''
    const createOptions = command === 'create'
      ? `  --source <directory>      Read-only product source for a new documentation project\n  --output <directory>      New, separate documentation project directory\n`
      : ''
    return `Usage: doxloop ${command} [request] [options]
${createUsage}

Start an authoring agent with the project-local skill.

Options:
${createOptions}  --agent <name>           codex, claude, or gemini
  --model <name>           Model passed to the selected agent CLI
  --reasoning <level>      Codex reasoning effort: minimal, low, medium, high, or xhigh
  --reference <url>        Use a documentation design reference; may be repeated
${screenshotOptions}  --print                  Print the prepared prompt instead of starting an agent
  --cwd <directory>        Run from this project directory
`
  }
  if (command === 'capture') {
    return `Usage: doxloop capture [url ...]

Render configured design-reference pages with a managed headless browser and
write full-page screenshots plus measured styles to .doxloop/cache/reference/.
Installs Playwright and Chromium on first use. URLs must be pages on a
configured design-reference origin; with no URLs, the configured reference
pages are captured.

Options:
  --cwd <directory>        Run from this project directory
`
  }
  if (command === 'preview') {
    return `Usage: doxloop preview [options]

Run the local documentation preview with live reload.

Options:
  --host <host>            Listening host (default: 127.0.0.1)
  --port <port>            Listening port (default: 4321)
  --open                   Open the preview in a browser
  --cwd <directory>        Run from this project directory
`
  }
  if (command === 'test' || command === 'status') {
    return `Usage: doxloop ${command} [options]

${command === 'test' ? 'Validate documentation structure and content.' : 'Summarize the project and its validation state.'}

Options:
  --format <text|json>      Output format (default: text)
  --cwd <directory>        Run from this project directory
`
  }
  if (command === 'login') {
    return `Usage: doxloop login [options]

Sign in with the Doxbrix device flow or verify a supplied personal access token.

Options:
  --token <token>          Token to verify and store; prefer the device flow or an environment variable
  --api-url <url>          HTTPS API base URL; HTTP is allowed only for localhost
`
  }
  if (command === 'logout') {
    return `Usage: doxloop logout

Remove the locally stored Doxbrix token.
`
  }
  if (command === 'whoami') {
    return `Usage: doxloop whoami [options]

Show the Doxbrix account for the active token.

Options:
  --api-url <url>          HTTPS API base URL; HTTP is allowed only for localhost
`
  }
  if (command === 'deploy') {
    return `Usage: doxloop deploy [options]

Validate and publish documentation through the public Doxbrix HTTP API.

Options:
  --dry-run                Validate and summarize without uploading
  --public                 Deploy publicly after an explicit confirmation
  --name <name>            Hosted project name
  --slug <slug>            Hosted project slug
  --api-url <url>          Override the Doxbrix API base URL
  --cwd <directory>        Run from this project directory
`
  }
  return `Doxloop ${VERSION}

Local-first documentation authoring with Codex, Claude Code, or Gemini.

Usage:
  doxloop <command> [options]

Author:
  init       Create a documentation project
  create     Ask an agent to create documentation
  update     Maintain docs after product changes
  review     Ask an agent for a read-only review
  agent      Set up project-local agent skills
  generator  Install and inspect generator packages
  capture    Capture rendered design-reference evidence

Verify:
  doctor     Check runtime, source, agent, generator, skills, and documentation
  status     Summarize the documentation project
  test       Validate pages, navigation, links, and code fences
  preview    Run a beautiful local preview

Publish:
  login      Sign in to Doxbrix
  logout     Remove the local token
  whoami     Show the current Doxbrix account
  deploy     Publish through the public Doxbrix HTTP API

Global options:
  --cwd <directory>  Run as if started in this directory
  -h, --help         Show help
  -v, --version      Show version

Run \`doxloop <command> --help\` for command details.
`
}

main()
  .then((code) => {
    process.exitCode = code
  })
  .catch((error) => {
    if (error instanceof DoxloopError) {
      process.stderr.write(`doxloop: ${error.message}\n`)
      process.exitCode = error.exitCode
      return
    }
    process.stderr.write(
      `doxloop: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
    )
    process.exitCode = 1
  })
