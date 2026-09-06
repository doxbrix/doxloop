import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { MAX_RECENT_PROJECTS, forgetProject, listRecentProjects, projectRegistryPath, rememberProject } from './project-registry.js'
import { scaffoldProject } from './project.js'

let home: string
const previousHome = process.env.DOXLOOP_HOME

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'doxloop-registry-'))
  process.env.DOXLOOP_HOME = join(home, 'home')
})

afterEach(async () => {
  if (previousHome === undefined) delete process.env.DOXLOOP_HOME
  else process.env.DOXLOOP_HOME = previousHome
  await rm(home, { recursive: true, force: true })
})

describe('project registry', () => {
  test('lives under DOXLOOP_HOME and starts empty', async () => {
    expect(projectRegistryPath()).toBe(join(home, 'home', 'projects.json'))
    expect(await listRecentProjects()).toEqual([])
  })

  test('remembers opened projects newest first and flags ones that disappeared', async () => {
    const first = await scaffoldProject({ directory: join(home, 'first'), sources: [] })
    const second = await scaffoldProject({ directory: join(home, 'second'), sources: [] })
    await rememberProject({ path: first, title: 'First', generator: 'doxbrix' })
    await rememberProject({ path: second, title: 'Second', generator: 'doxbrix' })
    let recent = await listRecentProjects()
    expect(recent.map((entry) => entry.path)).toEqual([second, first])
    expect(recent.every((entry) => !entry.missing)).toBe(true)

    // Reopening moves a project to the front without duplicating it.
    await rememberProject({ path: first, title: 'First again', generator: 'doxbrix' })
    recent = await listRecentProjects()
    expect(recent.map((entry) => [entry.path, entry.title])).toEqual([[first, 'First again'], [second, 'Second']])

    await rm(second, { recursive: true, force: true })
    recent = await listRecentProjects()
    expect(recent.find((entry) => entry.path === second)?.missing).toBe(true)

    await forgetProject(second)
    expect((await listRecentProjects()).map((entry) => entry.path)).toEqual([first])
  })

  test('caps the list and survives a damaged file', async () => {
    for (let index = 0; index < MAX_RECENT_PROJECTS + 5; index += 1) {
      await rememberProject({ path: join(home, `project-${index}`), title: `Project ${index}`, generator: 'mkdocs' })
    }
    const recent = await listRecentProjects()
    expect(recent).toHaveLength(MAX_RECENT_PROJECTS)
    expect(recent[0]?.title).toBe(`Project ${MAX_RECENT_PROJECTS + 4}`)
    expect(recent.every((entry) => entry.missing)).toBe(true)

    await mkdir(join(home, 'home'), { recursive: true })
    await writeFile(projectRegistryPath(), '{not json', 'utf8')
    expect(await listRecentProjects()).toEqual([])
    await rememberProject({ path: join(home, 'fresh'), title: 'Fresh', generator: 'doxbrix' })
    expect(JSON.parse(await readFile(projectRegistryPath(), 'utf8'))).toMatchObject({ schemaVersion: 1 })
    expect((await listRecentProjects()).map((entry) => entry.title)).toEqual(['Fresh'])
  })
})
