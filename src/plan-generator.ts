import { loadGeneratorAdapter } from './generators.js'
import type { DocumentationPlanTarget, DoxloopProject } from './types.js'

export async function documentationPlanTarget(root: string, project: DoxloopProject): Promise<DocumentationPlanTarget> {
  if (project.generator === 'doxbrix') {
    return {
      generator: 'doxbrix',
      contentDir: project.contentDir,
      contentFormat: 'markdown',
      pageExtensions: ['.md', '.mdx'],
      navigationFiles: [project.contentDir ? `${project.contentDir}/docs.json` : 'docs.json'],
    }
  }
  const adapter = await loadGeneratorAdapter(root, project)
  return {
    generator: project.generator,
    contentDir: project.contentDir,
    contentFormat: adapter.project.contentFormat ?? 'markdown',
    pageExtensions: adapter.project.pageExtensions,
    navigationFiles: adapter.planning?.navigationFiles ?? [],
  }
}
