#!/usr/bin/env node
import { auditDocumentation, backfillEvidence } from './workspace-tools.js'

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
import { createDemoWorkspace } from './demo.js'
import {
  continueDocumentationPlanGeneration,
  generateApprovedDocumentationPlan,
  planAuthoringRecord,
  proposeDocumentationPlan,
  readDocumentationPlan,
  reviseDocumentationPlan,
} from './documentation-plan.js'
import { historyAvailable } from './db.js'
import { formatDrift } from './drift.js'
import {
  backfillHistory,
  formatRequestHistory,
  listDeployments,
  listRequests,
  pageHistory,
} from './history.js'
import { formatDoctorReport, runDoctor } from './doctor.js'
import { DoxloopError, UsageError } from './errors.js'
import { exportStaticSite } from './site-export.js'
import { approveEvaluationBaseline, evaluateWorkspace, formatEvaluation } from './evaluation.js'
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
import { importExistingDocumentation } from './project-import.js'
import { isInteractive, promptConfirm, type PromptIo } from './prompts.js'
import { listPages as listDocumentationPages } from './pages.js'
import { startPreview } from './preview.js'
import { startUiServer } from './ui-server.js'
import { createSyncRun, formatSyncRunHistory, listSyncRuns, readSyncRun, recoverSyncRun, resumeSyncRun, reviseSyncRun } from './sync-runs.js'
import {
  effectiveDeployment,
  formatProjectSettings,
  runSettingsWizard,
} from './settings.js'
import { collectSourceChanges, formatSourceChanges } from './sync.js'
import { buildSourceIntelligence, formatSourceIntelligence } from './source-intelligence.js'
import { formatQualityReport, runQuality } from './quality-gates.js'
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
    case 'audit': {
      const root = await findProjectRoot(cwd)
      if (booleanFlag(args, 'backfill-evidence')) await backfillEvidence(root)
      const result = await auditDocumentation(root)
      if (flag(args, 'format') === 'json') process.stdout.write(JSON.stringify(result, null, 2) + '\n')
      else process.stdout.write(`${result.generator}: ${result.pages.length} pages, ${result.drift.pages.length} stale, ${result.unverified.length} unverified, ${result.unmapped.length} unmapped.\n${result.message}\n`)
      return 0
    }
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
    case 'demo': {
      const demo = await createDemoWorkspace()
      const keep = booleanFlag(args, 'keep')
      process.stdout.write(`Doxloop demo is ready.\n\n  Workspace:  ${demo.root}\n  Plan:       generated (${demo.plan.pages.length} pages)\n  Evidence:   ${demo.validation.pages.length} verified pages\n  Validation: ${demo.validation.errors} errors, ${demo.validation.warnings} warnings\n  Review:     ${demo.review.score}/100 (${demo.review.hardGates})\n\n`)
      if (booleanFlag(args, 'no-preview')) {
        process.stdout.write(`${keep ? `The demo was kept at ${demo.root}.` : 'The isolated demo has been cleaned up.'}\n`)
        if (!keep) await demo.cleanup()
        return 0
      }
      if (!keep) {
        const cleanup = () => void demo.cleanup()
        process.once('SIGINT', cleanup)
        process.once('SIGTERM', cleanup)
      }
      process.stdout.write('Opening the finished documentation preview. Press Ctrl+C to stop and clean up.\n')
      try {
        await startPreview({ root: demo.root, host: '127.0.0.1', port: numberFlag(args, 'port', 4321), open: !booleanFlag(args, 'no-open') })
      } catch (error) {
        if (!keep) await demo.cleanup()
        throw error
      }
      return 0
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
    case 'plan':
      return documentationPlanCommand(args, cwd)
    case 'proposal':
      return proposalCommand(args, cwd)
    case 'pages':
      return pagesCommand(args, cwd)
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
    case 'coverage': {
      const root = await findProjectRoot(cwd)
      const report = await buildSourceIntelligence(root)
      process.stdout.write(outputFormat(flag(args, 'format')) === 'json' ? `${JSON.stringify(report, null, 2)}\n` : `${formatSourceIntelligence(report)}\n`)
      return report.evidenceDiagnostics.some((item) => item.severity === 'error') || report.health.some((item) => item.status === 'error') ? 1 : 0
    }
    case 'quality': {
      const root = await findProjectRoot(cwd)
      const report = await runQuality(root, {
        ...(args.flags.has('offline') ? { offline: booleanFlag(args, 'offline') } : {}),
        ...(args.flags.has('rendered') ? { rendered: booleanFlag(args, 'rendered') } : {}),
        ...(args.flags.has('examples') ? { examples: booleanFlag(args, 'examples') } : {}),
        fix: booleanFlag(args, 'fix'),
        updateVisuals: booleanFlag(args, 'update-visuals'),
        approveBaseline: booleanFlag(args, 'approve-quality-baseline'),
      })
      process.stdout.write(outputFormat(flag(args, 'format')) === 'json' ? `${JSON.stringify(report, null, 2)}\n` : `${formatQualityReport(report)}\n`)
      return report.status === 'fail' || (booleanFlag(args, 'warnings-as-errors') && report.status === 'warning') ? 1 : 0
    }
    case 'evaluate': {
      const root = await findProjectRoot(cwd)
      const mode = flag(args, 'mode') ?? 'generation'
      if (mode !== 'generation' && mode !== 'update') throw new UsageError('--mode must be generation or update')
      const report = await evaluateWorkspace(root, {
        mode,
        ...(flag(args, 'before') ? { before: resolve(cwd, flag(args, 'before')!) } : {}),
        expectedChangedPages: flags(args, 'expected-change'),
        ...(flag(args, 'max-pages') ? { maximumPages: numberFlag(args, 'max-pages', 1) } : {}),
        ...(flag(args, 'regression-threshold') ? { regressionThreshold: numberFlag(args, 'regression-threshold', 3) } : {}),
      })
      if (booleanFlag(args, 'approve-baseline')) await approveEvaluationBaseline(root, report)
      process.stdout.write(outputFormat(flag(args, 'format')) === 'json' ? `${JSON.stringify(report, null, 2)}\n` : `${formatEvaluation(report)}\n`)
      return report.regression?.blocked ? 1 : 0
    }
    case 'sync':
      return syncCommand(args, cwd)
    case 'ui': {
      const page = flag(args, 'page')
      const project = flag(args, 'project')
      await startUiServer({
        cwd,
        port: numberFlag(args, 'port', 4317),
        open: !booleanFlag(args, 'no-open'),
        ...(page ? { page } : {}),
        ...(project ? { project } : {}),
      })
      return 0
    }
    case 'status':
      return statusCommand(cwd, outputFormat(flag(args, 'format')))
    case 'history':
      return historyCommand(args, cwd)
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
      const rawTarget = flag(args, 'target') ?? savedDeployment.target
      if (!['doxbrix', 'github-pages', 'netlify', 'vercel'].includes(rawTarget)) throw new UsageError('--target must be doxbrix, github-pages, netlify, or vercel.')
      const target = rawTarget as typeof savedDeployment.target
      const name = flag(args, 'name') ?? savedDeployment.name
      const slug = flag(args, 'slug') ?? savedDeployment.slug
      const defaultTargetApi = target === 'netlify' ? 'https://api.netlify.com' : target === 'vercel' ? 'https://api.vercel.com' : savedDeployment.apiUrl
      const apiOverride = flag(args, 'api-url') ?? (target === savedDeployment.target ? savedDeployment.apiUrl : defaultTargetApi)
      const siteId = flag(args, 'site-id') ?? savedDeployment.siteId
      const projectId = flag(args, 'project-id') ?? savedDeployment.projectId
      const teamId = flag(args, 'team-id') ?? savedDeployment.teamId
      const branch = flag(args, 'branch') ?? savedDeployment.branch
      const basePath = flag(args, 'base-path') ?? savedDeployment.basePath
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
          `\nDeployment summary\n\n  Project:      ${name}\n  Slug:         ${slug}\n  Target:       ${target}\n  Destination:  ${apiOverride}\n  Visibility:   ${publicSite ? 'PUBLIC' : 'Private'}\n  Pages:        ${validation.pages.length}\n  Warnings:     ${validation.warnings}\n  Product files: 0\n\n`,
        )
        if (target === 'doxbrix' && publicSite) {
          process.stdout.write(
            'Anyone on the internet will be able to access this documentation.\n\n',
          )
        }
        const proceed = await promptConfirm({
          message: target === 'doxbrix' && publicSite ? 'Deploy publicly?' : 'Deploy now?',
          initial: target !== 'doxbrix' || !publicSite,
        })
        if (!proceed) {
          process.stdout.write('Deployment canceled. No data was uploaded.\n')
          return 0
        }

        const token =
          userConfig.token ?? process.env.DOXLOOP_TOKEN ?? process.env.DOXBRIX_TOKEN
        if (target === 'doxbrix' && !token) {
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
        target,
        name,
        slug,
        dryRun,
        public: publicSite,
        apiUrl: apiOverride,
        ...(siteId ? { siteId } : {}),
        ...(projectId ? { projectId } : {}),
        ...(teamId ? { teamId } : {}),
        ...(branch ? { branch } : {}),
        ...(basePath ? { basePath } : {}),
      })
      return 0
    }
    case 'export': {
      const root = await findProjectRoot(cwd)
      const rawOut = flag(args, 'out')
      if (!rawOut) throw new UsageError('doxloop export requires --out <directory>.')
      const basePath = flag(args, 'base-path')
      const siteUrl = flag(args, 'site-url')
      const result = await exportStaticSite({
        root,
        out: resolve(cwd, rawOut),
        zip: booleanFlag(args, 'zip'),
        ...(basePath ? { basePath } : {}),
        ...(siteUrl ? { siteUrl } : {}),
      })
      process.stdout.write(
        `Exported ${result.files} files to ${result.outputDir}\n${result.zipPath ? `Archive: ${result.zipPath}\n` : ''}SHA-256: ${result.sha256}\n`,
      )
      return 0
    }
    default:
      throw new UsageError(
        `Unknown command "${args.command}". Run \`doxloop --help\` for available commands.`,
      )
  }
}

async function initCommand(args: ParsedArgs, cwd: string): Promise<number> {
  if (booleanFlag(args, 'existing')) return importExistingCommand(args, cwd)
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

/**
 * Adopt a folder that already holds a documentation site. Nothing in the
 * folder is converted or rewritten; Doxloop only adds its own project files.
 */
async function importExistingCommand(args: ParsedArgs, cwd: string): Promise<number> {
  if (args.positionals.length > 1) throw new UsageError('The init command accepts one documentation directory.')
  if (flags(args, 'source').length > 0 || flags(args, 'spec').length > 0 || flags(args, 'reference').length > 0) {
    throw new UsageError('`doxloop init --existing` adopts the folder as it is. Connect sources afterwards from the control center.')
  }
  const generator = parseGenerator(flag(args, 'generator'))
  const contentDir = flag(args, 'content-dir')
  const title = flag(args, 'title')
  const result = await importExistingDocumentation({
    directory: resolve(cwd, args.positionals[0] ?? '.'),
    ...(generator ? { generator } : {}),
    ...(contentDir !== undefined ? { contentDir } : {}),
    ...(title ? { title } : {}),
  })
  const entry = generatorCatalogEntry(result.generator)
  process.stdout.write(
    `Imported existing documentation at ${result.root}\n` +
    `  Generator: ${entry?.displayName ?? result.generator}\n` +
    `  Content directory: ${result.contentDir || '.'}\n` +
    `  Pages: ${result.pageCount}\n`,
  )
  for (const install of result.skills) process.stdout.write(`${install.action}: ${install.path}\n`)
  for (const warning of result.warnings) process.stdout.write(`Warning: ${warning}\n`)
  process.stdout.write(`\nNo page was changed. Open the control center with:\n  doxloop ui --project ${result.root}\n`)
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

/** Internal UI workflow command. The UI owns plan state and approval. */
async function documentationPlanCommand(args: ParsedArgs, cwd: string): Promise<number> {
  const action = args.positionals[0]
  const id = flag(args, 'id')
  if (!id || !action || !['propose', 'revise', 'generate', 'continue'].includes(action)) {
    throw new UsageError('Usage: doxloop plan <propose|revise|generate|continue> --id <plan-id> [--strategy resume|ignore-errors]')
  }
  if (args.positionals.length > 1) {
    throw new UsageError('The plan command accepts one action.')
  }
  const strategy = flag(args, 'strategy')
  if (action === 'continue' && strategy !== 'resume' && strategy !== 'ignore-errors') {
    throw new UsageError('doxloop plan continue needs --strategy resume or --strategy ignore-errors.')
  }
  const root = await findProjectRoot(cwd)
  const plan = action === 'propose'
    ? await proposeDocumentationPlan(root, id)
    : action === 'revise'
      ? await reviseDocumentationPlan(root, id, flag(args, 'feedback') ?? '')
      : action === 'continue'
        ? await continueDocumentationPlanGeneration(root, id, strategy as 'resume' | 'ignore-errors')
        : await generateApprovedDocumentationPlan(root, id)
  process.stdout.write(`\nDocumentation plan ${plan.id} is ${plan.status}.\n`)
  return 0
}

/** Internal UI workflow command. Proposal mutations remain mediated by the local server. */
async function proposalCommand(args: ParsedArgs, cwd: string): Promise<number> {
  const action = args.positionals[0]
  const id = flag(args, 'id')
  if (!id || (action !== 'revise' && action !== 'recover' && action !== 'resume')) {
    throw new UsageError('Usage: doxloop proposal <revise|recover|resume> --id <run-id> [--change <change-id> --request <instruction>] [--ignore-screenshot-problems]')
  }
  if (action === 'recover') {
    const run = await recoverSyncRun(await findProjectRoot(cwd), id, {
      ignoreScreenshotProblems: booleanFlag(args, 'ignore-screenshot-problems'),
    })
    process.stdout.write(`\nDocumentation proposal ${run.id} is ${run.status}.\n`)
    return 0
  }
  if (action === 'resume') {
    const root = await findProjectRoot(cwd)
    const failed = await readSyncRun(root, id)
    // A run started from an approved plan can rebuild its instructions from
    // that plan when it predates the recorded authoring inputs.
    const fallbackAuthoring = failed.planId
      ? await planAuthoringRecord(root, await readDocumentationPlan(root, failed.planId)).catch(() => undefined)
      : undefined
    const run = await resumeSyncRun(root, id, fallbackAuthoring ? { fallbackAuthoring } : {})
    if (run.status === 'failed') throw new DoxloopError(run.error ?? 'The resumed proposal failed.')
    process.stdout.write(`\nDocumentation proposal ${run.id} is ${run.status}.\n`)
    return 0
  }
  const changes = flags(args, 'change')
  const request = flag(args, 'request') ?? ''
  const root = await findProjectRoot(cwd)
  const run = await reviseSyncRun(root, id, {
    instruction: request,
    changeIds: changes,
    hunkIds: flags(args, 'hunk'),
  })
  if (run.status === 'failed') throw new DoxloopError(run.error ?? 'The proposal revision failed.')
  process.stdout.write(`\nDocumentation proposal ${run.id} is ${run.status}.\n`)
  return 0
}

async function pagesCommand(args: ParsedArgs, cwd: string): Promise<number> {
  const action = args.positionals[0]
  if (action !== 'list' && action !== 'edit') {
    throw new UsageError('Usage: doxloop pages <list|edit> [--path <page> --request <instruction>]')
  }
  if (args.positionals.length > 1) throw new UsageError(`The pages ${action} command does not accept positional arguments.`)
  const root = await findProjectRoot(cwd)
  if (action === 'list') {
    const pages = await listDocumentationPages(root)
    if (outputFormat(flag(args, 'format')) === 'json') {
      process.stdout.write(`${JSON.stringify(pages, null, 2)}\n`)
    } else if (pages.length === 0) {
      process.stdout.write('No documentation pages found.\n')
    } else {
      process.stdout.write(`${formatPageList(pages)}\n`)
    }
    return 0
  }

  const paths = [...new Set(flags(args, 'path').map((path) => path.trim()).filter(Boolean))]
  const request = flag(args, 'request')?.trim()
  if (paths.length === 0) throw new UsageError('pages edit requires at least one --path <page>.')
  if (!request) throw new UsageError('pages edit requires --request <instruction>.')
  if (request.length < 8) throw new UsageError('pages edit requires an instruction of at least 8 characters.')
  if (paths.length > 10) throw new UsageError('pages edit accepts at most 10 --path values.')
  const project = await loadProject(root)
  const selectedAgent = parseAgent(flag(args, 'agent'))
  const run = await createSyncRun({
    ...(flag(args, 'run-id') ? { id: flag(args, 'run-id')! } : {}),
    root,
    project,
    drift: await computeConfiguredDrift(root, project),
    sourceChanges: await collectSourceChanges(root, project.sources),
    trigger: 'edit',
    editRequest: { instruction: request, paths, allowRelated: booleanFlag(args, 'allow-related'), followUps: [] },
    authoring: {
      mode: 'update',
      historyRequest: request,
      ...(selectedAgent ? { agent: selectedAgent } : {}),
      ...(flag(args, 'model') ? { model: flag(args, 'model')! } : {}),
      ...(flag(args, 'reasoning') ? { reasoning: parseReasoning(flag(args, 'reasoning'))! } : {}),
      ...(flag(args, 'effort') ? { effort: parseClaudeEffort(flag(args, 'effort'))! } : {}),
      screenshots: booleanFlag(args, 'screenshots') ? 'enabled' : 'disabled',
    },
  })
  process.stdout.write(`Documentation edit ${run.id} is ${run.status}.\n`)
  if (run.status === 'failed') throw new DoxloopError(run.error ?? 'The documentation edit failed.')
  return 0
}

function formatPageList(pages: Awaited<ReturnType<typeof listDocumentationPages>>): string {
  const headings = ['Path', 'Title', 'Section', 'Words', 'Evidence']
  const rows = pages.map((page) => [page.path, page.title, page.section ?? 'Not in navigation', String(page.wordCount), page.evidence])
  const widths = headings.map((heading, index) => Math.max(heading.length, ...rows.map((row) => row[index]!.length)))
  return [headings, ...rows].map((row) => row.map((cell, index) => cell.padEnd(widths[index]!)).join('  ').trimEnd()).join('\n')
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

/**
 * Show what the project has been asked to do and what happened. History is
 * derived data; supported Doxloop runtimes include built-in SQLite.
 */
async function historyCommand(args: ParsedArgs, cwd: string): Promise<number> {
  const root = await findProjectRoot(cwd)
  if (!(await historyAvailable())) {
    process.stdout.write(
      process.env.DOXLOOP_NO_HISTORY === '1'
        ? 'Documentation history is explicitly disabled by DOXLOOP_NO_HISTORY=1. Remove that variable to restore request and deployment history.\n'
        : `Documentation history requires Node.js 22.13 or newer. This runtime is ${process.version}; upgrade before authoring so request and deployment history remain available.\n`,
    )
    return 0
  }
  await backfillHistory(root)
  const limit = numberFlag(args, 'limit', 20)
  const page = flag(args, 'page')
  const format = outputFormat(flag(args, 'format'))

  if (page) {
    const entries = await pageHistory(root, page, limit)
    if (format === 'json') {
      process.stdout.write(`${JSON.stringify(entries, null, 2)}\n`)
      return 0
    }
    if (entries.length === 0) {
      process.stdout.write(`No recorded history for ${page}.\n`)
      return 0
    }
    process.stdout.write(`History for ${page}\n`)
    for (const entry of entries) {
      const when = entry.requestedAt.replace('T', ' ').slice(0, 16)
      process.stdout.write(
        `  ${when}  ${entry.changeKind.padEnd(8)} ${entry.decision.padEnd(9)} +${entry.linesAdded}/-${entry.linesRemoved}${entry.agent ? ` · ${entry.agent}` : ''}\n`,
      )
      if (entry.requestText) {
        process.stdout.write(`      "${entry.requestText.replace(/\s+/g, ' ').trim()}"\n`)
      }
    }
    return 0
  }

  if (booleanFlag(args, 'deployments')) {
    const deployments = await listDeployments(root, limit)
    if (format === 'json') {
      process.stdout.write(`${JSON.stringify(deployments, null, 2)}\n`)
      return 0
    }
    if (deployments.length === 0) {
      process.stdout.write('No deployments recorded yet.\n')
      return 0
    }
    for (const record of deployments) {
      const when = record.startedAt.replace('T', ' ').slice(0, 16)
      process.stdout.write(
        `  ${record.status === 'succeeded' ? '✓' : '✗'} ${when}  ${record.slug ?? record.target}  ${record.pagesCount ?? 0} pages${record.error ? `  ${record.error}` : ''}\n`,
      )
    }
    return 0
  }

  const requests = await listRequests(root, limit)
  process.stdout.write(
    format === 'json'
      ? `${JSON.stringify(requests, null, 2)}\n`
      : `${formatRequestHistory(requests)}\n`,
  )
  return 0
}

function validateCommandArguments(args: ParsedArgs): void {
  const allowed: Record<string, string[]> = {
    init: ['title', 'source', 'spec', 'reference', 'generator', 'existing', 'content-dir'],
    agent: ['agent'],
    generator: [],
    doctor: ['source', 'output', 'agent'],
    audit: ['format', 'backfill-evidence'],
    demo: ['port', 'no-open', 'no-preview', 'keep'],
    create: ['agent', 'model', 'reasoning', 'effort', 'reference', 'print', 'screenshots', 'no-screenshots', 'source', 'spec', 'output'],
    update: ['agent', 'model', 'reasoning', 'effort', 'reference', 'print', 'screenshots', 'no-screenshots'],
    review: ['agent', 'model', 'reasoning', 'effort', 'reference', 'print'],
    plan: ['id', 'feedback', 'strategy'],
    proposal: ['id', 'change', 'hunk', 'request', 'ignore-screenshot-problems'],
    pages: ['format', 'path', 'request', 'allow-related', 'screenshots', 'run-id', 'agent', 'model', 'reasoning', 'effort'],
    capture: [],
    test: ['format'],
    check: ['format', 'quiet'],
    coverage: ['format'],
    quality: ['format', 'offline', 'rendered', 'examples', 'fix', 'update-visuals', 'warnings-as-errors', 'approve-quality-baseline'],
    evaluate: ['format', 'mode', 'before', 'expected-change', 'max-pages', 'regression-threshold', 'approve-baseline'],
    sync: ['mode', 'on', 'branch', 'quiet', 'trigger', 'host', 'port', 'open', 'request', 'agent', 'model', 'reasoning', 'effort', 'screenshots', 'no-screenshots'],
    ui: ['port', 'page', 'no-open', 'project'],
    status: ['format'],
    history: ['format', 'limit', 'page', 'deployments'],
    settings: [],
    preview: ['host', 'port', 'open'],
    login: ['api-url', 'token'],
    logout: [],
    whoami: ['api-url'],
    deploy: ['dry-run', 'public', 'name', 'slug', 'api-url', 'target', 'site-id', 'project-id', 'team-id', 'branch', 'base-path'],
    export: ['out', 'zip', 'base-path', 'site-url'],
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
      'plan',
      'proposal',
      'pages',
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
  if (command === 'demo') {
    return `Usage: doxloop demo [options]

Create a complete bundled documentation project in an isolated temporary
directory, then open its local preview. No agent sign-in, repository, commit,
or network source is required, and the current directory is never modified.

Options:
  --port <port>            Preview port (default: 4321)
  --no-open                Start the preview without opening a browser
  --no-preview             Validate the showcase without starting a server
  --keep                   Keep the temporary workspace after the demo

Try without installing:
  npx @doxbrix/doxloop demo
`
  }
  if (command === 'init') {
    return `Usage: doxloop init [directory] [options]

Create a local documentation project and install the authoring and format skills.
Run without arguments in a terminal to answer a short set of setup questions.
With --existing, adopt a folder that already holds a documentation site: the
generator is detected from its configuration files and no page is changed.

Options:
  --title <title>          Documentation site title
  --source <name=path>     Add a local product source; may be repeated
  --spec <name=file|url>   Add an OpenAPI specification as API evidence; may be repeated
  --reference <url>        Add a documentation design reference; may be repeated
  --generator <name>       Generator: ${GENERATOR_CATALOG.map((entry) => entry.id).join(', ')}
  --existing               Adopt the existing documentation in [directory] (default: current folder)
  --content-dir <path>     With --existing, the folder that holds the pages when detection is wrong
  --yes                    Never prompt; fail instead of asking
  --cwd <directory>        Resolve paths from this directory

Examples:
  doxloop init
  doxloop init my-docs --source product=../my-app
  doxloop init api-docs --spec https://example.com/openapi.json
  doxloop init --existing ./website
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
  if (command === 'pages') {
    return `Usage:
  doxloop pages list [--format text|json]
  doxloop pages edit --path <page> [--path <page> ...] --request <instruction> [options]

List documentation pages or ask the agent for an isolated, reviewable edit.

Options:
  --path <page>            Existing page to edit; may be repeated
  --request <text>         Describe what should change
  --allow-related          Allow navigation and page-related image changes
  --screenshots            Capture application screenshots when configured
  --run-id <id>            Use a caller-supplied proposal id
  --agent <name>           codex, claude, or gemini
  --model <name>           Model passed to the selected agent CLI
  --reasoning <level>      Codex reasoning effort
  --effort <level>         Claude effort
  --format <text|json>     Page-list output format (default: text)
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
  if (command === 'coverage') {
    return `Usage: doxloop coverage [options]

Report source health, documented public-surface coverage, and evidence precision.
Coverage is a traceability measure and does not claim that documentation is correct.

Options:
  --format <text|json>     Output format (default: text)
  --cwd <directory>        Run from this project directory
`
  }
  if (command === 'quality') {
    return `Usage: doxloop quality [options]

Run the versioned release-quality contract: deterministic validation, the
selected generator's strict build, external links, executable examples,
OpenAPI schemas, documentation linting, claim reverification, and optional
rendered accessibility and visual regression checks.

Options:
  --format <text|json>     Stable human or CI output (default: text)
  --offline                Use cached external-link results without network
  --examples               Run opt-in .doxloop/examples.json checks
  --rendered               Run rendered accessibility and visual checks
  --update-visuals         Approve current screenshots as visual baselines
  --approve-quality-baseline Approve current issue codes/files for ratcheting
  --fix                    Apply only deterministic formatting fixes first
  --warnings-as-errors     Return exit code 1 for warnings as well as failures
  --cwd <directory>        Run from this project directory

Exit status:
  0   no failing gates (and no warnings with --warnings-as-errors)
  1   one or more release gates failed
`
  }
  if (command === 'evaluate') {
    return `Usage: doxloop evaluate [options]

Score a generated or updated documentation workspace using the stable
evaluation contract. Reports include factual grounding, coverage, examples,
information architecture, evidence precision, page economy, update locality,
accessibility, duration/usage when supplied, and reviewer outcomes.

Options:
  --mode <generation|update> Evaluation mode (default: generation)
  --before <directory>       Original workspace for update-locality scoring
  --expected-change <page>   Expected changed page; may be repeated
  --max-pages <count>        Expected page ceiling for page-economy scoring
  --regression-threshold <n> Allowed score drop from the approved baseline
  --approve-baseline         Save this report as the approved project baseline
  --format <text|json>       Output format (default: text)
  --cwd <directory>          Run from this project directory
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
  if (command === 'history') {
    return `Usage: doxloop history [options]

Show what this project was asked to document and what happened. Records the
request, its outcome, and the pages it touched. Agent transcripts stay in
.doxloop/ui-job-logs and are never stored.

Options:
  --page <path>            History for one page, such as docs/quickstart.mdx
  --deployments            List publishing history instead of documentation runs
  --limit <count>          Entries to show (default: 20)
  --format <text|json>     Output format (default: text)
  --cwd <directory>        Run from this project directory

Examples:
  doxloop history
  doxloop history --page docs/quickstart.mdx
  doxloop history --deployments --limit 5
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
  --page <name>            Open overview, sources, update, pages, review, deploy, or settings
  --project <directory>    Open this documentation project instead of the current folder
  --port <port>            Local UI port (default: 4317)
  --no-open                Start the server without opening a browser
  --cwd <directory>        Run from this directory

Examples:
  doxloop ui
  doxloop ui --page review
  doxloop ui --project ~/work/product-docs
  doxloop ui --no-open --port 4400
`
  }
  if (command === 'deploy') {
    return `Usage: doxloop deploy [options]

Validate and publish documentation to Doxbrix or a configured static host.

Options:
  --dry-run                Validate and summarize without uploading
  --target <target>        doxbrix, github-pages, netlify, or vercel
  --public                 Deploy publicly after an explicit confirmation
  --name <name>            Hosted project name
  --slug <slug>            Hosted project slug
  --api-url <url>          Override the Doxbrix API base URL
  --site-id <id>           Netlify site ID
  --project-id <id>        Vercel project ID or name
  --team-id <id>           Optional Vercel team ID
  --branch <name>          GitHub Pages branch (default: gh-pages)
  --base-path <path>       Static site mount path, such as /repository
  --yes                    Use saved settings without prompting
  --cwd <directory>        Run from this project directory
`
  }
  if (command === 'export') {
    return `Usage: doxloop export --out <directory> [options]

Build a portable static site for any configured generator.

Options:
  --out <directory>       Write the static site to this directory
  --zip                   Also write <directory>.zip
  --base-path <path>      Host below an origin path, such as /repository
  --site-url <url>        Public URL used by the sitemap and canonical metadata
  --cwd <directory>       Run from this project directory
`
  }
  return `Doxloop ${VERSION}

Local-first documentation authoring with Codex, Claude Code, or Gemini.

Usage:
  doxloop <command> [options]

Author:
  demo       Try a safe, complete example in a temporary workspace
  init       Create a documentation project
  create     Ask an agent to create documentation
  update     Maintain docs after product changes
  review     Ask an agent for a read-only review
  agent      Set up project-local agent skills
  generator  Install and inspect generator packages
  capture    Capture rendered design-reference evidence
  pages      List pages or ask the agent for a scoped page edit

Maintain:
  check      Report documentation stale since the last source change
  coverage   Report source health, coverage, and evidence precision
  sync       Set up and run automatic documentation maintenance

Visual:
  ui         Open the local Doxloop project control center

Verify:
  doctor     Check runtime, source, agent, generator, skills, and documentation
  audit      Inspect existing docs without an agent; optionally backfill unverified evidence
  quality    Run the versioned release-quality contract
  evaluate   Score generation/update quality and regressions
  status     Summarize the documentation project
  history    Show past documentation requests, page changes, and deployments
  settings   View or change project settings
  test       Validate pages, navigation, links, and code fences
  preview    Run a beautiful local preview

Publish:
  login      Sign in to Doxbrix
  logout     Remove the local token
  whoami     Show the current Doxbrix account
  deploy     Publish through the public Doxbrix HTTP API
  export     Build a self-hostable static folder or zip archive

Global options:
  --cwd <directory>  Run as if started in this directory
  --yes              Never prompt; accept safe defaults or fail instead of asking
  -h, --help         Show help
  -v, --version      Show version

Get started:
  npx @doxbrix/doxloop demo           Preview a complete example safely
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
