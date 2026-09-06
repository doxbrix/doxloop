import { documentationCollections, collectionForPath } from './documentation-collections.js'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import matter from 'gray-matter'
import { parseDocument } from 'yaml'
import type { DoxloopProject } from './types.js'

/** Read native routing without executing project configuration code. */
export async function resolvePageRoute(root: string, project: DoxloopProject, path: string, content?: string): Promise<string> {
  const collection = collectionForPath(await documentationCollections(root, project), path)
  const directory = project.generator === 'docusaurus' ? collection?.directory ?? project.contentDir : project.contentDir
  const relative = path.replace(/\\/g, '/').slice(directory ? directory.length + 1 : 0)
  let route = relative.replace(/\.[^/.]+$/, '').replace(/(^|\/)index$/, '')
  if (project.generator === 'docusaurus') {
    const raw = content ?? await readFile(join(root, path), 'utf8')
    const slug = matter(raw).data.slug
    const config = await readFirst(root, ['docusaurus.config.js', 'docusaurus.config.ts', 'docusaurus.config.mjs', 'docusaurus.config.cjs'])
    const base = literal(config, 'baseUrl') ?? '/'
    const docs = literal(config, 'routeBasePath') ?? '/docs'
    if (typeof slug === 'string') route = slug
    else route = route.split('/').map((segment) => segment.replace(/^\d+[-_]/, '')).join('/')
    let versions: string[] = []
    try { versions = JSON.parse(await readFile(join(root, 'versions.json'), 'utf8')) } catch { /* An unversioned site. */ }
    const version = collection?.version ?? 'current'
    const versionPath = versions.length ? version === 'current' ? 'next' : version === versions[0] ? '' : version : ''
    const localePath = collection?.locale && collection.locale !== 'default' ? collection.locale : ''
    return clean(`${base}/${localePath}/${docs}/${versionPath}/${route}`)
  }
  if (project.generator === 'mkdocs') {
    const config = parseDocument(await readFirst(root, ['mkdocs.yml', 'mkdocs.yaml']), { logLevel: 'silent' }).toJS() as Record<string, unknown> | null
    let base = ''
    if (typeof config?.site_url === 'string') { try { base = new URL(config.site_url).pathname } catch { /* Native build reports invalid URLs. */ } }
    if (config?.use_directory_urls === false && route) route += '.html'
    return clean(`${base}/${route}`)
  }
  return clean(`/${route}`)
}
function clean(value: string): string { return `/${value}`.replace(/\/+/g, '/').replace(/\/$/, '') || '/' }
function literal(config: string, key: string): string | undefined { return new RegExp(`\\b${key}\\s*:\\s*['\"]([^'\"]*)['\"]`).exec(config)?.[1] }
async function readFirst(root: string, paths: string[]): Promise<string> {
  for (const path of paths) { try { return await readFile(join(root, path), 'utf8') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error } }
  return ''
}
