import { readFile } from 'node:fs/promises'
import { resolve, relative } from 'node:path'

export function affectedPages(project, evidence, changedFiles, documentationRoot = '.') {
  const matches = (path, glob) => new RegExp('^' + glob.split('**').map((part) => part.split('*').map((piece) => piece.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')).join('.*') + '$').test(path)
  const affected = []
  const unavailable = []
  for (const source of project.sources ?? []) {
    if (source.remote || !source.path) { unavailable.push(source.name); continue }
    const prefix = relative(process.cwd(), resolve(documentationRoot, source.path)).replace(/\\/g, '/')
    if (prefix.startsWith('..') || prefix.startsWith('/')) { unavailable.push(source.name); continue }
    const paths = changedFiles.filter((path) => !prefix || path.startsWith(prefix + '/')).map((path) => prefix ? path.slice(prefix.length + 1) : path)
    for (const [page, entry] of Object.entries(evidence.pages ?? {})) {
      const references = entry.sources?.filter((item) => item.source === source.name) ?? []
      const hits = paths.filter((path) => references.some((item) => !item.paths?.length || item.paths.some((glob) => matches(path, glob))))
      if (hits.length) affected.push({ page, source: source.name, paths: hits })
    }
  }
  return { affected, unavailable }
}
export function impactComment(result) {
  const code = (value) => String(value).replace(/[`\r\n<>]/g, '').replace(/@/g, '@\u200b')
  return ['<!-- doxloop-docs-impact -->', '### Documentation impact', result.affected.length ? 'These pages reference source files changed by this pull request:' : 'No changed files matched the available evidence map; unmapped changes still require review.', ...result.affected.slice(0, 100).map((item) => `- \`${code(item.page)}\` — ${code(item.source)}: ${item.paths.slice(0, 6).map((path) => `\`${code(path)}\``).join(', ')}`), ...(result.unavailable.length ? [`Sources outside this checkout could not be checked: ${result.unavailable.map(code).join(', ')}.`] : []), 'This is a deterministic impact check. It does not verify claims, rewrite pages, or start an agent.'].join('\n\n')
}
export async function loadImpact(root, files) {
  const project = JSON.parse(await readFile(resolve(root, '.doxloop/project.json'), 'utf8'))
  const evidence = JSON.parse(await readFile(resolve(root, '.doxloop/evidence-map.json'), 'utf8'))
  return affectedPages(project, evidence, files, root)
}
