import type { GeneratorEntry, ProjectInspection, RecentProject } from './types'

/** Recent projects other than the open one, newest first, as the switcher lists them. */
export function recentProjectChoices(recent: RecentProject[] | undefined, currentRoot: string | undefined): RecentProject[] {
  return (recent ?? [])
    .filter((project) => project.path !== currentRoot)
    .sort((left, right) => right.lastOpenedAt.localeCompare(left.lastOpenedAt))
}

export function projectFolderName(path: string): string {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path
}

export function generatorLabel(id: string | undefined, generators: Array<Pick<GeneratorEntry, 'id' | 'displayName'>>): string {
  if (!id) return 'Unknown generator'
  return generators.find((entry) => entry.id === id)?.displayName ?? id
}

export interface InspectionSummary {
  headline: string
  detail: string
  tone: 'ok' | 'warn' | 'bad'
  /** The folder can be adopted as it is described. */
  canImport: boolean
}

/**
 * One line a person can act on: what the folder looks like and whether
 * importing it makes sense. Detection never blocks a corrected choice, so a
 * wrong guess is a warning, not an error.
 */
export function inspectionSummary(inspection: ProjectInspection, generators: Array<Pick<GeneratorEntry, 'id' | 'displayName'>>): InspectionSummary {
  if (inspection.alreadyProject) {
    return { headline: 'Already a Doxloop project', detail: 'Open it instead of importing it again.', tone: 'bad', canImport: false }
  }
  if (!inspection.generator) {
    return {
      headline: 'No documentation generator recognized',
      detail: 'Choose the generator and the folder that holds the pages if this is a documentation site.',
      tone: 'warn',
      canImport: false,
    }
  }
  const label = generatorLabel(inspection.generator, generators)
  const where = inspection.contentDir ? `in ${inspection.contentDir}/` : 'in the folder itself'
  const pages = `${inspection.pageCount} ${inspection.pageCount === 1 ? 'page' : 'pages'}`
  if (inspection.pageCount === 0) {
    return { headline: `${label} site with no pages ${where}`, detail: 'Check the content directory before importing.', tone: 'warn', canImport: true }
  }
  if (!inspection.generatorInstalled) {
    return {
      headline: `${label} site · ${pages}`,
      detail: `The ${inspection.generatorPackage ?? label} package is not installed in this folder. Import can add it as a development dependency.`,
      tone: 'warn',
      canImport: true,
    }
  }
  const markers = inspection.markers.length ? ` · detected from ${inspection.markers.join(', ')}` : ''
  return { headline: `${label} site · ${pages}`, detail: `Pages ${where}${markers}. No page will be changed.`, tone: 'ok', canImport: true }
}
