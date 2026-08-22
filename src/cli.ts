#!/usr/bin/env node

import { mkdir, readFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import {
  assertAllowedFlags,
  booleanFlag,
  flag,
  flags,
  numberFlag,
  parseArgs,
} from './args.js'
import { installSkill, parseAgent, skillStatus } from './agents.js'
import { loadUserConfig, login, logout, whoami } from './auth.js'
import {
  parseClaudeEffort,
  parseReasoning,
  resolveScreenshotIntent,
  runAuthor,
} from './author.js'
import { capture } from './capture.js'
import {
  applySyncConfig,
  computeConfiguredDrift,
  disableSync,
  formatSyncStatus,
  parseSyncMode,
  parseTriggerList,
  replaySyncSetupCommand,
  runSyncNow,
  runSyncSetupWizard,
} from './autosync.js'
import { deploy } from './deploy.js'
import { formatDrift } from './drift.js'
import { formatDoctorReport, runDoctor } from './doctor.js'
import { DoxloopError, UsageError } from './errors.js'
import {
  addGenerator,
  diagnoseGenerator,
  formatGeneratorInfo,
  formatGeneratorList,
  removeGenerator,
} from './generator-manager.js'
import {
  GENERATOR_CATALOG,
  generatorCatalogEntry,
  parseGenerator,
  resolveGeneratorPackage,
} from './generators.js'
import {
  formatInitPlan,
  promptForRequest,
  replayInitCommand,
  runCreateRescueWizard,
  runInitWizard,
  selectAgentInteractive,
  type InitPlan,
} from './interactive.js'
import {
  addDesignReferences,
  assertNewProjectDirectory,
  findProjectRoot,
  isSpecUrl,
  loadProject,
  parseDesignReference,
  parseSource,
  parseSpec,
  resolveSeparateProjectLayout,
  saveDefaultAgent,
  scaffoldProject,
  validateProjectSourceBoundaries,
} from './project.js'
import { isInteractive, promptConfirm, type PromptIo } from './prompts.js'
import { startPreview } from './preview.js'
import { startUiServer } from './ui-server.js'
import { formatSyncRunHistory, listSyncRuns } from './sync-runs.js'
import {
  effectiveDeployment,
  formatProjectSettings,
  runSettingsWizard,
} from './settings.js'
import { collectSourceChanges, formatSourceChanges } from './sync.js'
import type {
  GeneratorName,
  ParsedArgs,
  SourceChange,
  SyncConfig,
  SyncRunTrigger,
} from './types.js'
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
      if (
        flag(args, 'source') !== undefined ||
        flag(args, 'output') !== undefined ||
        flags(args, 'spec').length > 0
      ) {
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
    case 'check':
      return checkCommand(
        cwd,
        outputFormat(flag(args, 'format')),
        booleanFlag(args, 'quiet'),
      )
    case 'sync':
      return syncCommand(args, cwd)
    case 'ui': {
      const page = flag(args, 'page')
      await startUiServer({
        cwd,
        port: numberFlag(args, 'port', 4317),
        open: !booleanFlag(args, 'no-open'),
        ...(page ? { page } : {}),
      })
      return 0
    }
    case 'status':
      return statusCommand(cwd, outputFormat(flag(args, 'format')))
    case 'settings': {
      const root = await findProjectRoot(cwd)
      if (!isInteractive(args)) {
        process.stdout.write(
          `${formatProjectSettings(root, await loadProject(root))}\n`,
        )
        return 0
      }
      await runSettingsWizard(root, cwd, promptIo())
      return 0
    }
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
      const project = await loadProject(root)
      const userConfig = await loadUserConfig()
      const savedDeployment = effectiveDeployment(project, userConfig.apiUrl)
      const name = flag(args, 'name') ?? savedDeployment.name
      const slug = flag(args, 'slug') ?? savedDeployment.slug
      const apiOverride = flag(args, 'api-url') ?? savedDeployment.apiUrl
      const dryRun = booleanFlag(args, 'dry-run')
      const publicSite =
        flag(args, 'public') !== undefined
          ? booleanFlag(args, 'public')
          : savedDeployment.visibility === 'public'
      if (isInteractive(args) && !dryRun) {
        const validation = await validateProject(root)
        if (validation.errors > 0) {
          throw new DoxloopError(
            `Deployment stopped because documentation has ${validation.errors} validation error${validation.errors === 1 ? '' : 's'}. Run \`doxloop test\`.`,
          )
        }
        process.stdout.write(
          `\nDeployment summary\n\n  Project:      ${name}\n  Slug:         ${slug}\n  Destination:  ${apiOverride}\n  Visibility:   ${publicSite ? 'PUBLIC' : 'Private'}\n  Pages:        ${validation.pages.length}\n  Warnings:     ${validation.warnings}\n  Product files: 0\n\n`,
        )
        if (publicSite) {
          process.stdout.write(
            'Anyone on the internet will be able to access this documentation.\n\n',
          )
        }
        const proceed = await promptConfirm({
          message: publicSite ? 'Deploy publicly?' : 'Deploy now?',
          initial: !publicSite,
        })
        if (!proceed) {
          process.stdout.write('Deployment canceled. No data was uploaded.\n')
          return 0
        }

        const token =
          userConfig.token ?? process.env.DOXLOOP_TOKEN ?? process.env.DOXBRIX_TOKEN
        if (!token) {
          process.stdout.write('You are not signed in to Doxbrix.\n')
          const signIn = await promptConfirm({
            message: 'Sign in now?',
            initial: true,
          })
          if (!signIn) {
            process.stdout.write('Deployment canceled. No data was uploaded.\n')
            return 0
          }
          await login({ apiUrl: apiOverride })
        }
      }
      await deploy({
        root,
        name,
        slug,
        dryRun,
        public: publicSite,
        apiUrl: apiOverride,
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
  const providedDirectory = args.positionals[0]
  let sources = [
    ...flags(args, 'source').map(parseSource),
    ...flags(args, 'spec').map(parseSpec),
  ]
  let title = flag(args, 'title')
  let generator = parseGenerator(flag(args, 'generator'))
  let fromWizard = false
  let directory = providedDirectory
  if (!providedDirectory) {
    if (!isInteractive(args)) {
      throw new UsageError(
        'Guided setup requires an interactive terminal. For automation, use `doxloop init <directory>` with optional --source or --spec values.',
      )
    }
    const plan = await runInitWizard(cwd)
    directory = plan.directory
    if (sources.length === 0) sources = plan.sources
    title = title ?? plan.title
    generator = generator ?? plan.generator
    fromWizard = true
  }
  if (args.positionals.length > 1) {
    throw new UsageError('The init command accepts one destination directory.')
  }
  if (!directory) throw new UsageError('A documentation project directory is required.')
  const plan: InitPlan = {
    directory,
    ...(title ? { title } : {}),
    sources,
    generator: generator ?? 'doxbrix',
  }
  if (fromWizard && !(await confirmInitPlan(cwd, plan))) {
    process.stdout.write('Setup canceled. No project was created.\n')
    return 0
  }
  const root = await initializeProject(
    args,
    cwd,
    plan,
    flags(args, 'reference').map(parseDesignReference),
  )
  if (fromWizard) {
    process.stdout.write(
      `\nRerun this setup non-interactively:\n  ${replayInitCommand(plan)}\n`,
    )
  }
  process.stdout.write(
    `\nNext:\n  cd ${directory}\n  doxloop create\n  doxloop preview --open\n  doxloop test\n`,
  )
  return 0
}

async function confirmInitPlan(cwd: string, plan: InitPlan): Promise<boolean> {
  process.stdout.write(`\n${formatInitPlan(cwd, plan)}\n\n`)
  return promptConfirm({ message: 'Create this project?', initial: true })
}

async function initializeProject(
  args: ParsedArgs,
  cwd: string,
  plan: InitPlan,
  designReferences: ReturnType<typeof parseDesignReference>[] = [],
): Promise<string> {
  const projectRoot = resolve(cwd, plan.directory)
  await validateProjectSourceBoundaries(projectRoot, plan.sources)
  if (plan.generator !== 'doxbrix') {
    await ensureGeneratorAvailable(args, projectRoot, plan.generator)
  }
  const root = await scaffoldProject({
    directory: projectRoot,
    ...(plan.title ? { title: plan.title } : {}),
    sources: plan.sources,
    designReferences,
    generator: plan.generator,
  })
  const installs = await installSkill({ root })
  process.stdout.write(`Created Doxloop project at ${root}\n`)
  for (const install of installs) {
    process.stdout.write(`${install.action}: ${install.path}\n`)
  }
  return root
}

async function ensureGeneratorAvailable(
  args: ParsedArgs,
  projectRoot: string,
  generator: GeneratorName,
): Promise<void> {
  const entry = generatorCatalogEntry(generator)
  if (!entry?.packageName) return
  if (resolveGeneratorPackage(projectRoot, entry.packageName)) return
  if (isInteractive(args)) {
    const install = await promptConfirm({
      message: `${entry.displayName} support needs ${entry.packageName}. Install it into the new project now?`,
      initial: true,
    })
    if (!install) {
      throw new DoxloopError(
        `${entry.displayName} support is not installed. Install it with \`doxloop generator add ${generator}\` inside the documentation project.`,
        2,
      )
    }
  }
  await mkdir(projectRoot, { recursive: true })
  await addGenerator(projectRoot, generator)
}

async function createProjectCommand(
  args: ParsedArgs,
  cwd: string,
): Promise<number> {
  const source = flag(args, 'source')
  const output = flag(args, 'output')
  const specs = flags(args, 'spec').map(parseSpec)
  if (!output || (!source && specs.length === 0)) {
    throw new UsageError(
      'Creating a new documentation project requires `--output <documentation-directory>` plus `--source <product-directory>`, `--spec <openapi-file-or-url>`, or both.',
    )
  }
  if (flags(args, 'source').length > 1 || flags(args, 'output').length > 1) {
    throw new UsageError(
      'The first-run create command accepts one source and one output directory.',
    )
  }

  const layout = source
    ? await resolveSeparateProjectLayout({ cwd, source, output })
    : undefined
  const projectRoot = layout?.projectRoot ?? resolve(cwd, output)
  const sources = [
    ...(layout ? [layout.sourceBinding] : []),
    ...specs.map((spec) => projectRelativeSpec(spec, cwd, projectRoot)),
  ]
  const print = booleanFlag(args, 'print')
  const designReferences = flags(args, 'reference').map(parseDesignReference)

  if (!layout) await assertNewProjectDirectory(projectRoot)
  await validateProjectSourceBoundaries(projectRoot, sources)

  const sourceText = layout
    ? `Product source:\n  ${layout.sourceRoot}\n  Read-only — product files will not be changed or deployed.\n\n`
    : specs.length > 0
      ? `API specification${specs.length === 1 ? '' : 's'}:\n${specs.map((spec) => `  ${spec.path}`).join('\n')}\n  Read-only API evidence.\n\n`
      : ''
  process.stdout.write(
    `Welcome to Doxloop\n\n${sourceText}Documentation project:\n  ${projectRoot}\n  Only this project can be previewed or deployed.\n\n`,
  )

  const root = await scaffoldProject({
    directory: projectRoot,
    sources,
    designReferences,
  })
  if (print) {
    const requestedAgent = parseAgent(flag(args, 'agent'))
    await installSkill({
      root,
      ...(requestedAgent ? { agent: requestedAgent } : {}),
    })
  }

  const result = await authorCommand(args, root, 'create')

  return result
}

async function authorCommand(
  args: ParsedArgs,
  cwd: string,
  mode: 'create' | 'update' | 'review',
): Promise<number> {
  const interactive = isInteractive(args)
  const print = booleanFlag(args, 'print')
  let root: string
  try {
    root = await findProjectRoot(cwd)
  } catch (error) {
    if (mode === 'create' && interactive && !print) {
      const plan = await runCreateRescueWizard(cwd, promptIo())
      if (plan) {
        if (!(await confirmInitPlan(cwd, plan))) {
          process.stdout.write('Setup canceled. No project was created.\n')
          return 0
        }
        root = await initializeProject(args, cwd, plan)
        process.stdout.write(
          '\nSetup complete. Tell Doxloop what documentation to create.\n\n',
        )
      } else {
        throw error
      }
    } else {
      throw error
    }
  }
  const project = await loadProject(root)
  if (mode !== 'review') {
    await validateProjectSourceBoundaries(root, project.sources)
  }
  let selectedAgent = parseAgent(flag(args, 'agent')) ?? project.defaultAgent
  let request = args.positionals.join(' ') || undefined
  let changeSummary: string | undefined
  let requestedInteractively = false
  let offerToRememberAgent = false

  if (mode === 'update') {
    if (interactive && !print && !(await hasCompletedAuthoringRun(root))) {
      process.stdout.write(
        'This project has not completed its first documentation run yet.\n\nNext:\n  doxloop create\n',
      )
      return 0
    }
    if (project.sources.length === 0) {
      if (interactive && !print) {
        process.stdout.write(
          'No product source or API specification is configured.\nUse `doxloop settings` to add evidence, or describe a documentation-only change below.\n\n',
        )
        if (!request) {
          request = await promptForRequest('update', promptIo(), false)
          requestedInteractively = true
          if (!request) {
            process.stdout.write('No documentation change requested.\n')
            return 0
          }
        }
      }
    } else {
      const changes = await collectSourceChanges(root, project.sources)
      changeSummary = formatSourceChanges(changes)
      if (interactive && !print) {
        process.stdout.write(`${formatSourceChangeOverview(changes)}\n\n`)
        if (!hasPendingSourceChanges(changes) && !request) {
          const proceed = await promptConfirm({
            message: 'Documentation is synchronized. Make a documentation-only change?',
            initial: false,
          })
          if (!proceed) {
            process.stdout.write(
              'Documentation is synchronized with the recorded source baseline.\n',
            )
            return 0
          }
        }
      }
    }
  }

  if (
    interactive &&
    !print &&
    !request &&
    !requestedInteractively &&
    (mode === 'create' || mode === 'update')
  ) {
    request = await promptForRequest(mode, promptIo(), project.sources.length > 0)
  }
  if (interactive && !print && !selectedAgent) {
    selectedAgent = await selectAgentInteractive(promptIo())
    if (selectedAgent && mode !== 'review' && !project.defaultAgent) {
      offerToRememberAgent = true
    }
  }

  if (interactive && !print && mode === 'create') {
    process.stdout.write(
      `\nAuthoring summary\n\n  Project:    ${project.title}\n  Evidence:   ${project.sources.length === 0 ? 'None yet' : `${project.sources.length} configured source${project.sources.length === 1 ? '' : 's'}`}\n  Generator:  ${project.generator}\n  Agent:      ${selectedAgent ?? 'Automatically detected'}\n  Request:    ${request ?? 'Let the agent propose a documentation plan'}\n\n`,
    )
    const proceed = await promptConfirm({
      message: 'Start creating documentation?',
      initial: true,
    })
    if (!proceed) {
      process.stdout.write('Authoring canceled. Project settings were preserved.\n')
      return 0
    }
  }
  if (offerToRememberAgent && selectedAgent) {
    const remember = await promptConfirm({
      message: `Remember ${selectedAgent} as this project's default agent?`,
      initial: true,
    })
    if (remember) await saveDefaultAgent(root, selectedAgent)
  }

  const designReferences = flags(args, 'reference').map(parseDesignReference)
  if (mode !== 'review') await addDesignReferences(root, designReferences)
  const model = flag(args, 'model')
  const reasoning = parseReasoning(flag(args, 'reasoning'))
  const effort = parseClaudeEffort(flag(args, 'effort'))
  const screenshots = screenshotIntent(args)
  const result = await runAuthor({
    root,
    mode,
    nonInteractive: !interactive,
    ...(changeSummary !== undefined ? { changeSummary } : {}),
    ...(selectedAgent ? { agent: selectedAgent } : {}),
    ...(model ? { model } : {}),
    ...(reasoning ? { reasoning } : {}),
    ...(effort ? { effort } : {}),
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
  if (result === 0 && !print && mode === 'create') {
    const validation = await validateProject(root)
    process.stdout.write(
      `\nDocumentation created successfully.\n\nPages created: ${validation.pages.length}\nDocumentation project: ${root}\nProduct source files included in deployment: 0\n\nNext:\n  cd ${root}\n  doxloop preview --open\n  doxloop test\n\nWhen the product changes:\n  doxloop update\n`,
    )
  }
  return result
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

async function syncCommand(args: ParsedArgs, cwd: string): Promise<number> {
  const action = args.positionals[0] ?? 'status'
  if (!['setup', 'status', 'now', 'review', 'history', 'off'].includes(action)) {
    throw new UsageError('Usage: doxloop sync <setup|status|now|review|history|off>')
  }
  if (args.positionals.length > 1) {
    throw new UsageError('The sync command accepts one action.')
  }
  const root = await findProjectRoot(cwd)
  const project = await loadProject(root)

  if (action === 'history') {
    process.stdout.write(`${formatSyncRunHistory(await listSyncRuns(root))}\n`)
    return 0
  }
  if (action === 'review') {
    await startUiServer({
      cwd: root,
      host: flag(args, 'host') ?? '127.0.0.1',
      port: numberFlag(args, 'port', 4317),
      open: booleanFlag(args, 'open'),
      page: 'proposals',
    })
    return 0
  }

  if (action === 'status') {
    process.stdout.write(`${await formatSyncStatus(root, project)}\n`)
    return 0
  }
  if (action === 'now') {
    const trigger = flag(args, 'trigger')
    const request = flag(args, 'request')
    const agent = parseAgent(flag(args, 'agent'))
    const model = flag(args, 'model')
    const reasoning = parseReasoning(flag(args, 'reasoning'))
    const effort = parseClaudeEffort(flag(args, 'effort'))
    const hasManualAuthoring = Boolean(request || agent || model || reasoning || effort || booleanFlag(args, 'screenshots') || booleanFlag(args, 'no-screenshots'))
    return runSyncNow({
      root,
      project,
      quiet: booleanFlag(args, 'quiet'),
      ...(trigger ? { trigger: parseSyncRunTrigger(trigger) } : {}),
      ...(hasManualAuthoring ? {
        authoring: {
          ...(request ? { request } : {}),
          ...(agent ? { agent } : {}),
          ...(model ? { model } : {}),
          ...(reasoning ? { reasoning } : {}),
          ...(effort ? { effort } : {}),
          screenshots: screenshotIntent(args),
        },
      } : {}),
    })
  }
  if (action === 'off') {
    const lines = await disableSync(root, project)
    process.stdout.write(`\n${lines.join('\n')}\n\nAutomatic sync: OFF\n`)
    return 0
  }

  const modeFlag = flag(args, 'mode')
  const onFlag = flag(args, 'on')
  const branchFlag = flag(args, 'branch')
  let sync: SyncConfig | undefined
  if (isInteractive(args) && modeFlag === undefined && onFlag === undefined) {
    sync = await runSyncSetupWizard({ root, project, io: promptIo() })
    if (!sync) {
      process.stdout.write('Setup canceled. Nothing was changed.\n')
      return 0
    }
  } else {
    if (modeFlag === undefined && onFlag === undefined) {
      throw new UsageError(
        'Guided setup requires an interactive terminal. For automation, use `doxloop sync setup --mode <check|propose|auto> --on <every@Nm|every@Nh|daily@HH:MM|manual>`.',
      )
    }
    sync = {
      ...project.sync,
      ...(modeFlag ? { mode: parseSyncMode(modeFlag) } : {}),
      ...(branchFlag ? { branch: branchFlag } : {}),
      ...(onFlag ? { on: parseTriggerList(onFlag) } : {}),
    }
  }

  const applied = await applySyncConfig(root, project, sync)
  process.stdout.write(`\n${applied.join('\n')}\n`)
  process.stdout.write(
    `\nRerun this setup non-interactively:\n  ${replaySyncSetupCommand(sync)}\n`,
  )
  process.stdout.write(
    '\nNext:\n  doxloop sync status         confirm everything is working\n  doxloop check               see the current drift\n  doxloop sync review --open  review generated proposals\n',
  )
  return 0
}

async function checkCommand(
  cwd: string,
  format: string,
  quiet: boolean,
): Promise<number> {
  const root = await findProjectRoot(cwd)
  const project = await loadProject(root)
  const result = await computeConfiguredDrift(root, project)
  // Quiet mode keeps scheduled checks silent unless there is something to act on.
  if (!quiet || result.status !== 'current') {
    process.stdout.write(
      format === 'json'
        ? `${JSON.stringify(result, null, 2)}\n`
        : `${formatDrift(result)}\n`,
    )
  }
  return result.status === 'current' ? 0 : 1
}

async function statusCommand(cwd: string, format?: string): Promise<number> {
  const root = await findProjectRoot(cwd)
  const project = await loadProject(root)
  const deployment = effectiveDeployment(project)
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
          deployment,
          errors: result.errors,
          warnings: result.warnings,
        },
        null,
        2,
      )}\n`,
    )
  } else {
    process.stdout.write(
      `${project.title}\nRoot: ${root}\nGenerator: ${project.generator}\nPages: ${result.pages.length}\nSources: ${project.sources.length}\nDesign references: ${project.designReferences.length}\nApplication screenshots: ${project.application ? `${project.application.screenshots?.policy ?? 'requested'} (${project.application.baseUrl})` : 'not configured'}\nDeployment: ${deployment.slug} (${deployment.visibility}) → ${deployment.apiUrl}\nErrors: ${result.errors}\nWarnings: ${result.warnings}\n`,
    )
    for (const source of project.sources) {
      process.stdout.write(`source ${source.name}: ${source.path}\n`)
    }
  }
  return result.errors > 0 ? 1 : 0
}

function validateCommandArguments(args: ParsedArgs): void {
  const allowed: Record<string, string[]> = {
    init: ['title', 'source', 'spec', 'reference', 'generator'],
    agent: ['agent'],
    generator: [],
    doctor: ['source', 'output', 'agent'],
    create: ['agent', 'model', 'reasoning', 'effort', 'reference', 'print', 'screenshots', 'no-screenshots', 'source', 'spec', 'output'],
    update: ['agent', 'model', 'reasoning', 'effort', 'reference', 'print', 'screenshots', 'no-screenshots'],
    review: ['agent', 'model', 'reasoning', 'effort', 'reference', 'print'],
    capture: [],
    test: ['format'],
    check: ['format', 'quiet'],
    sync: ['mode', 'on', 'branch', 'quiet', 'trigger', 'host', 'port', 'open', 'request', 'agent', 'model', 'reasoning', 'effort', 'screenshots', 'no-screenshots'],
    ui: ['port', 'page', 'no-open'],
    status: ['format'],
    settings: [],
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
    ![
      'init',
      'agent',
      'generator',
      'create',
      'update',
      'review',
      'capture',
      'sync',
    ].includes(args.command) &&
    args.positionals.length > 0
  ) {
    throw new UsageError(`The ${args.command} command does not accept arguments.`)
  }
}

function promptIo(): PromptIo {
  return { input: process.stdin, output: process.stdout }
}

function hasPendingSourceChanges(changes: SourceChange[]): boolean {
  return changes.some(
    (change) => change.kind !== 'unchanged' && change.kind !== 'spec-unchanged',
  )
}

function formatSourceChangeOverview(changes: SourceChange[]): string {
  const pending = changes.filter(
    (change) => change.kind !== 'unchanged' && change.kind !== 'spec-unchanged',
  )
  const committedFiles = changes.reduce(
    (total, change) =>
      total + (change.kind === 'changed' ? change.changedFiles.length : 0),
    0,
  )
  const workingTreeFiles = changes.reduce(
    (total, change) =>
      total +
      ('uncommittedFiles' in change ? change.uncommittedFiles.length : 0),
    0,
  )
  const status =
    pending.length === 0
      ? 'Synchronized'
      : `${pending.length} source${pending.length === 1 ? '' : 's'} need inspection`
  return `Source check\n\n  Sources checked:       ${changes.length}\n  Status:                ${status}\n  Committed files:       ${committedFiles}\n  Working-tree files:    ${workingTreeFiles}`
}

async function hasCompletedAuthoringRun(root: string): Promise<boolean> {
  try {
    const receipt = JSON.parse(
      await readFile(join(root, '.doxloop', 'last-run.json'), 'utf8'),
    ) as { mode?: unknown; completedAt?: unknown }
    return (
      (receipt.mode === 'create' || receipt.mode === 'update') &&
      typeof receipt.completedAt === 'string'
    )
  } catch {
    try {
      const syncState = JSON.parse(
        await readFile(join(root, '.doxloop', 'sync-state.json'), 'utf8'),
      ) as { schemaVersion?: unknown; sources?: unknown }
      return (
        syncState.schemaVersion === 1 &&
        syncState.sources !== null &&
        typeof syncState.sources === 'object' &&
        !Array.isArray(syncState.sources)
      )
    } catch {
      return false
    }
  }
}

function projectRelativeSpec(
  spec: ReturnType<typeof parseSpec>,
  cwd: string,
  projectRoot: string,
): ReturnType<typeof parseSpec> {
  if (isSpecUrl(spec.path)) return spec
  return {
    ...spec,
    path: relative(projectRoot, resolve(cwd, spec.path)).split('\\').join('/'),
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

function parseSyncRunTrigger(value: string): SyncRunTrigger {
  if (
    value === 'manual' ||
    value === 'schedule'
  ) {
    return value
  }
  throw new UsageError('--trigger is reserved for the Doxloop scheduler.')
}

function help(command?: string): string {
  if (command === 'init') {
    return `Usage: doxloop init [directory] [options]

Create a local documentation project and install the authoring and format skills.
Run without arguments in a terminal to answer a short set of setup questions.

Options:
  --title <title>          Documentation site title
  --source <name=path>     Add a local product source; may be repeated
  --spec <name=file|url>   Add an OpenAPI specification as API evidence; may be repeated
  --reference <url>        Add a documentation design reference; may be repeated
  --generator <name>       Generator: ${GENERATOR_CATALOG.map((entry) => entry.id).join(', ')}
  --yes                    Never prompt; fail instead of asking
  --cwd <directory>        Resolve paths from this directory

Examples:
  doxloop init
  doxloop init my-docs --source product=../my-app
  doxloop init api-docs --spec https://example.com/openapi.json
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
      ? `\nRun inside a Doxloop project to answer a short set of authoring questions.\nWhen run inside a detected product repository, Doxloop offers the complete setup\nwizard first. No flags are required for interactive use.\n\nOptional automation form:\n  doxloop create --source <product-directory> --output <documentation-directory> [request]\n  doxloop create --spec <openapi-file-or-url> --output <documentation-directory> [request]\n`
      : ''
    const createOptions = command === 'create'
      ? `  --source <directory>      Read-only product source for a new documentation project\n  --spec <name=file|url>    OpenAPI specification used as read-only API evidence\n  --output <directory>      New, separate documentation project directory\n`
      : ''
    return `Usage: doxloop ${command} [request] [options]
${createUsage}

Start an authoring agent with the project-local skill.

Options:
${createOptions}  --agent <name>           codex, claude, or gemini
  --model <name>           Model passed to the selected agent CLI
  --reasoning <level>      Codex reasoning effort (supported levels depend on the model)
  --effort <level>         Claude effort: low, medium, high, xhigh, or max
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
  if (command === 'sync') {
    return `Usage: doxloop sync <setup|status|now|review|history|off> [options]

Keep documentation current automatically.

Detection, proposal generation, review, and application are separate. Generated
changes stay in an isolated workspace until the user accepts them. Git is not
required for the documentation directory.

Actions:
  setup                    Answer a few questions, then install the triggers
  status                   Verify the triggers, agent sign-in, and current drift
  now                      Generate one isolated proposal when pages are stale
  review                   Open the local run history and visual change review
  history                  List every proposal and its decision status
  off                      Remove the schedule, keeping settings

Options:
  --mode <name>            check (report only), propose, or auto
  --on <frequency>         daily, weekdays, weekly, monthly, interval, or manual syntax
  --branch <name>          Product branch documentation follows
  --quiet                  Print nothing when documentation is current
  --host <host>            Review server host (default: 127.0.0.1)
  --port <port>            Review server port (default: 4317)
  --open                   Open the visual review in a browser
  --cwd <directory>        Run from this project directory

Examples:
  doxloop sync setup
  doxloop sync setup --mode propose --on every@15m --branch main
  doxloop sync status
  doxloop sync history
  doxloop sync review --open
`
  }
  if (command === 'check') {
    return `Usage: doxloop check [options]

Report which documentation pages no longer match the configured sources.

No authoring agent is started and no model is used: the answer comes from the
provider API, the recorded sync baseline, and the evidence map written by the
last authoring run. Safe to run on a schedule or in continuous integration.

Exit status:
  0   documentation is current
  1   pages are stale, or drift could not be determined

Options:
  --format <text|json>     Output format (default: text)
  --quiet                  Print nothing when documentation is current
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
  if (command === 'settings') {
    return `Usage: doxloop settings

View or interactively change the current project's evidence, identity, default
agent, documentation preferences, design references, screenshots, and
deployment settings. When output is not a terminal, prints the saved settings.

Options:
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
  if (command === 'ui') {
    return `Usage: doxloop ui [options]

Open the local Doxloop project control center. Outside a Doxloop project, the UI
starts with the new-project setup wizard. Project files and credentials stay on
this computer.

Options:
  --page <name>            Open home, sources, authoring, sync, proposals, quality, preview, publish, or settings
  --port <port>            Local UI port (default: 4317)
  --no-open                Start the server without opening a browser
  --cwd <directory>        Run from this directory

Examples:
  doxloop ui
  doxloop ui --page sync
  doxloop ui --no-open --port 4400
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
  --yes                    Use saved settings without prompting
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

Maintain:
  check      Report documentation stale since the last source change
  sync       Set up and run automatic documentation maintenance

Visual:
  ui         Open the local Doxloop project control center

Verify:
  doctor     Check runtime, source, agent, generator, skills, and documentation
  status     Summarize the documentation project
  settings   View or change project settings
  test       Validate pages, navigation, links, and code fences
  preview    Run a beautiful local preview

Publish:
  login      Sign in to Doxbrix
  logout     Remove the local token
  whoami     Show the current Doxbrix account
  deploy     Publish through the public Doxbrix HTTP API

Global options:
  --cwd <directory>  Run as if started in this directory
  --yes              Never prompt; accept safe defaults or fail instead of asking
  -h, --help         Show help
  -v, --version      Show version

Get started:
  doxloop init                       Answer a few questions interactively
  doxloop create                     Create docs from saved project settings
  doxloop settings                   View or change project settings

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
