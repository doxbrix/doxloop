import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DoxloopError, UsageError } from './errors.js'
import {
  GENERATOR_API_VERSION,
  type GeneratorAdapter,
} from './generator-api.js'
import type { DoxloopProject, GeneratorName } from './types.js'

export interface GeneratorCatalogEntry {
  id: GeneratorName
  displayName: string
  packageName?: string
  skillName: string
  buildCommand?: string
  outputDir?: string
}

export const GENERATOR_CATALOG: readonly GeneratorCatalogEntry[] = [
  {
    id: 'doxbrix',
    displayName: 'Doxbrix',
    skillName: 'doxloop-doxbrix',
  },
  {
    id: 'docusaurus',
    displayName: 'Docusaurus',
    packageName: '@doxbrix/doxloop-generator-docusaurus',
    skillName: 'doxloop-docusaurus',
    buildCommand: 'npm run build',
    outputDir: 'build',
  },
  {
    id: 'mkdocs',
    displayName: 'MkDocs Material',
    packageName: '@doxbrix/doxloop-generator-mkdocs',
    skillName: 'doxloop-mkdocs',
    buildCommand: 'mkdocs build --strict',
    outputDir: 'site',
  },
  {
    id: 'sphinx',
    displayName: 'Sphinx',
    packageName: '@doxbrix/doxloop-generator-sphinx',
    skillName: 'doxloop-sphinx',
    buildCommand: 'sphinx-build -W -b html docs _build/html',
    outputDir: '_build/html',
  },
  {
    id: 'hugo',
    displayName: 'Hugo',
    packageName: '@doxbrix/doxloop-generator-hugo',
    skillName: 'doxloop-hugo',
    buildCommand: 'hugo --minify',
    outputDir: 'public',
  },
  {
    id: 'vitepress',
    displayName: 'VitePress',
    packageName: '@doxbrix/doxloop-generator-vitepress',
    skillName: 'doxloop-vitepress',
    buildCommand: 'npm run docs:build',
    outputDir: 'docs/.vitepress/dist',
  },
  {
    id: 'markdoc',
    displayName: 'Markdoc',
    packageName: '@doxbrix/doxloop-generator-markdoc',
    skillName: 'doxloop-markdoc',
    buildCommand: 'npm run build',
    outputDir: 'dist',
  },
  {
    id: 'nextra',
    displayName: 'Nextra',
    packageName: '@doxbrix/doxloop-generator-nextra',
    skillName: 'doxloop-nextra',
    buildCommand: 'npm run build',
    outputDir: 'out',
  },
  {
    id: 'starlight',
    displayName: 'Starlight',
    packageName: '@doxbrix/doxloop-generator-starlight',
    skillName: 'doxloop-starlight',
    buildCommand: 'npm run build',
    outputDir: 'dist',
  },
  {
    id: 'jekyll',
    displayName: 'Jekyll',
    packageName: '@doxbrix/doxloop-generator-jekyll',
    skillName: 'doxloop-jekyll',
    buildCommand: 'bundle exec jekyll build --strict_front_matter',
    outputDir: '_site',
  },
  {
    id: 'static',
    displayName: 'Prebuilt static HTML',
    packageName: '@doxbrix/doxloop-generator-static',
    skillName: 'doxloop-static',
    buildCommand: 'npm run build',
    outputDir: 'site',
  },
] as const

export function generatorCatalogEntry(id: string): GeneratorCatalogEntry | undefined {
  return GENERATOR_CATALOG.find((entry) => entry.id === id)
}

export function parseGenerator(value: string | undefined): GeneratorName | undefined {
  if (value === undefined) return undefined
  const entry = generatorCatalogEntry(value)
  if (entry) return entry.id
  throw new UsageError(
    `--generator must be one of: ${GENERATOR_CATALOG.map((entry) => entry.id).join(', ')}`,
  )
}

export function generatorPackageName(
  generator: GeneratorName,
  configured?: string,
): string | undefined {
  return configured ?? generatorCatalogEntry(generator)?.packageName
}

export function generatorSkillName(generator: GeneratorName): string {
  return generatorCatalogEntry(generator)?.skillName ?? `doxloop-${generator}`
}

export async function loadGeneratorAdapter(
  root: string,
  projectOrGenerator: DoxloopProject | GeneratorName,
  configuredPackage?: string,
): Promise<GeneratorAdapter> {
  const generator =
    typeof projectOrGenerator === 'string'
      ? projectOrGenerator
      : projectOrGenerator.generator
  if (generator === 'doxbrix') {
    throw new DoxloopError('Doxbrix is a built-in generator and has no external adapter.')
  }
  const packageName = generatorPackageName(
    generator,
    typeof projectOrGenerator === 'string'
      ? configuredPackage
      : projectOrGenerator.generatorPackage,
  )
  if (!packageName) {
    throw new DoxloopError(`No generator package is configured for "${generator}".`, 2)
  }

  const resolved = resolveGeneratorPackage(root, packageName)
  if (!resolved) {
    throw new DoxloopError(
      `The ${generator} generator package is not installed.\nInstall it in the documentation project with:\n  npm install --save-dev ${packageName}`,
      2,
    )
  }

  let loaded: unknown
  try {
    const module = (await import(pathToFileURL(resolved).href)) as {
      default?: unknown
    }
    loaded = module.default
  } catch (error) {
    throw new DoxloopError(
      `Cannot load generator package ${packageName}: ${errorMessage(error)}`,
    )
  }
  return validateAdapter(loaded, generator, packageName)
}

export function resolveGeneratorPackage(
  root: string,
  packageName: string,
): string | undefined {
  const attempts = [
    createRequire(join(resolve(root), 'package.json')),
    createRequire(import.meta.url),
  ]
  for (const require of attempts) {
    try {
      return require.resolve(packageName)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'MODULE_NOT_FOUND') throw error
    }
  }
  return undefined
}

export async function installedGeneratorEntries(
  root: string,
): Promise<Array<GeneratorCatalogEntry & { installed: boolean }>> {
  return Promise.all(
    GENERATOR_CATALOG.map(async (entry) => ({
      ...entry,
      installed:
        entry.id === 'doxbrix' ||
        (entry.packageName !== undefined &&
          resolveGeneratorPackage(root, entry.packageName) !== undefined),
    })),
  )
}

function validateAdapter(
  value: unknown,
  expectedId: GeneratorName,
  packageName: string,
): GeneratorAdapter {
  if (!value || typeof value !== 'object') {
    throw incompatible(packageName, 'does not export a default generator adapter')
  }
  const adapter = value as Partial<GeneratorAdapter>
  if (adapter.apiVersion !== GENERATOR_API_VERSION) {
    throw incompatible(
      packageName,
      `uses generator API ${String(adapter.apiVersion)}; Doxloop requires ${GENERATOR_API_VERSION}`,
    )
  }
  if (adapter.id !== expectedId) {
    throw incompatible(
      packageName,
      `registers "${String(adapter.id)}" instead of "${expectedId}"`,
    )
  }
  if (
    adapter.packageName !== packageName ||
    typeof adapter.displayName !== 'string' ||
    typeof adapter.packageVersion !== 'string' ||
    !adapter.authoring ||
    typeof adapter.authoring.skillName !== 'string' ||
    typeof adapter.authoring.skillDirectory !== 'string' ||
    (adapter.planning !== undefined &&
      (!Array.isArray(adapter.planning.navigationFiles) ||
        !adapter.planning.navigationFiles.every((file) => typeof file === 'string'))) ||
    !adapter.project ||
    !Array.isArray(adapter.project.pageExtensions) ||
    !Array.isArray(adapter.project.gitignore) ||
    (adapter.project.contentFormat !== undefined &&
      !['markdown', 'rst', 'html'].includes(adapter.project.contentFormat)) ||
    !adapter.build ||
    typeof adapter.build.command !== 'string' ||
    typeof adapter.build.outputDir !== 'string' ||
    typeof adapter.scaffold !== 'function' ||
    typeof adapter.preview !== 'function' ||
    typeof adapter.validate !== 'function' ||
    (adapter.resolveLocalAsset !== undefined &&
      typeof adapter.resolveLocalAsset !== 'function') ||
    (adapter.readPage !== undefined && typeof adapter.readPage !== 'function')
  ) {
    throw incompatible(packageName, 'does not satisfy the generator adapter contract')
  }
  return adapter as GeneratorAdapter
}

function incompatible(packageName: string, reason: string): DoxloopError {
  return new DoxloopError(`Generator package ${packageName} is incompatible: ${reason}.`)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
