import { withProjectLock } from './project-lock.js'
import { writeCoverageResolution } from './coverage-resolutions.js'
import { DoxloopError } from './errors.js'
import { readEvidenceMap, writeEvidenceMap } from './evidence.js'
import { loadProject, saveProjectSettings } from './project.js'
import { buildSourceIntelligence } from './source-intelligence.js'

export type CoverageResolutionAction = 'link' | 'exclude' | 'needs-human' | 'remove-priority' | 'reset'

export async function resolveCoverageItem(
  root: string,
  input: { id: string; action: CoverageResolutionAction; page?: string; reason?: string },
): Promise<void> {
  return withProjectLock(root, 'write', () => resolveCoverageItemLocked(root, input))
}
async function resolveCoverageItemLocked(root: string, input: { id: string; action: CoverageResolutionAction; page?: string; reason?: string }): Promise<void> {
  const report = await buildSourceIntelligence(root)
  const item = report.coverage.metrics.flatMap((metric) => metric.items).find((candidate) => candidate.id === input.id)
  if (!item) throw new DoxloopError('The requested coverage item no longer exists. Refresh coverage and try again.')
  const reason = input.reason?.trim()

  if (input.action === 'reset') {
    await writeCoverageResolution(root, item.id)
    return
  }
  if (input.action === 'needs-human') {
    await writeCoverageResolution(root, item.id, { disposition: 'needs-human', ...(reason ? { reason } : {}) })
    return
  }
  if (input.action === 'exclude') {
    if (item.surface === 'verified-pages') throw new DoxloopError('Page verification cannot be excluded. Reverify the page or decide later.')
    if (item.surface === 'reader-journeys') throw new DoxloopError('Remove a reader journey from priority outcomes instead of excluding it as a product surface.')
    if (!reason) throw new DoxloopError('Explain why this item is not part of the supported public surface.')
    await writeCoverageResolution(root, item.id, { disposition: 'excluded', reason })
    return
  }
  if (input.action === 'remove-priority') {
    if (item.surface !== 'reader-journeys') throw new DoxloopError('Only reader journeys can be removed from priority outcomes.')
    const project = await loadProject(root)
    const priorityOutcomes = (project.documentation.priorityOutcomes ?? []).filter((outcome) => outcome !== item.label)
    await saveProjectSettings(root, { documentation: { ...project.documentation, priorityOutcomes } })
    await writeCoverageResolution(root, item.id)
    return
  }
  if (input.action === 'link') {
    const page = input.page?.trim()
    if (!page || !report.coverage.pages.includes(page)) throw new DoxloopError('Choose an existing evidence-mapped documentation page.')
    if (item.surface === 'reader-journeys') {
      await writeCoverageResolution(root, item.id, { disposition: 'documented', page, ...(reason ? { reason } : {}) })
      return
    }
    if (!item.source) throw new DoxloopError('This coverage item cannot be linked to source evidence.')
    const map = await readEvidenceMap(root)
    if (!map?.pages[page]) throw new DoxloopError('The selected documentation page is not present in the evidence map.')
    const evidence = map.pages[page]
    const identifier = item.kind === 'export' && item.label.startsWith('Schema ')
      ? `schema:${item.label.replace(/^Schema /, '')}`
      : item.label
    const existing = evidence.sources.find((entry) => entry.source === item.source)
    if (existing) existing.operations = [...new Set([...(existing.operations ?? []), identifier])]
    else evidence.sources.push({ source: item.source, operations: [identifier] })
    await writeEvidenceMap(root, map)
    await writeCoverageResolution(root, item.id)
    return
  }
  throw new DoxloopError('Unsupported coverage resolution action.')
}
