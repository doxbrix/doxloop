import { spawnSync } from 'node:child_process'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const skills = [
  join('skills', 'doxloop-authoring'),
  join('skills', 'doxloop-doxbrix'),
]

for (const entry of await readdir(join(root, 'packages'), {
  withFileTypes: true,
})) {
  if (!entry.isDirectory() || !entry.name.startsWith('generator-')) continue
  const directory = join(root, 'packages', entry.name, 'skills')
  for (const skill of await readdir(directory, { withFileTypes: true })) {
    if (skill.isDirectory()) {
      skills.push(join('packages', entry.name, 'skills', skill.name))
    }
  }
}

for (const skill of skills.sort()) {
  const result = spawnSync(
    'python3',
    [join(root, 'scripts', 'validate-skill.py'), skill],
    { cwd: root, stdio: 'inherit' },
  )
  if (result.status !== 0) process.exit(result.status ?? 1)
}

const authoring = await readFile(
  join(root, 'skills', 'doxloop-authoring', 'SKILL.md'),
  'utf8',
)
const authoringReferences = join(root, 'skills', 'doxloop-authoring', 'references')
const authoringReferenceFiles = await readdir(authoringReferences)
const expertTemplates = authoringReferenceFiles.filter((file) =>
  /^(domain|type)-[a-z0-9-]+\.md$/.test(file),
)
const domainTemplates = expertTemplates.filter((file) => file.startsWith('domain-'))
const typeTemplates = expertTemplates.filter((file) => file.startsWith('type-'))

if (domainTemplates.length < 10 || typeTemplates.length < 12) {
  console.error(
    `Skill validation failed: expected at least 10 domain and 12 documentation-type expert templates; found ${domainTemplates.length} and ${typeTemplates.length}.`,
  )
  process.exit(1)
}

for (const file of [
  'template-routing.md',
  'audience-flavors.md',
  'navigation-architecture.md',
  ...expertTemplates,
]) {
  if (!authoring.includes(`(references/${file})`)) {
    console.error(
      `Skill validation failed: doxloop-authoring does not route expert reference "${file}".`,
    )
    process.exit(1)
  }
}

for (const file of expertTemplates) {
  const text = await readFile(join(authoringReferences, file), 'utf8')
  if (!text.includes('## Senior quality gate')) {
    console.error(
      `Skill validation failed: expert template "${file}" lacks a senior quality gate.`,
    )
    process.exit(1)
  }
  if (file.startsWith('domain-') && !text.includes('## Navigation overlay')) {
    console.error(
      `Skill validation failed: domain template "${file}" lacks a navigation overlay.`,
    )
    process.exit(1)
  }
  if (file.startsWith('type-') && !text.includes('## Standard navigation')) {
    console.error(
      `Skill validation failed: documentation-type template "${file}" lacks standard navigation.`,
    )
    process.exit(1)
  }
}

const routing = await readFile(
  join(authoringReferences, 'template-routing.md'),
  'utf8',
)
if (
  !routing.includes('Do not ask the user to choose a template') ||
  !routing.includes('Do not treat audience as an independent documentation template')
) {
  console.error(
    'Skill validation failed: expert template routing must remain automatic and audience must remain a flavor.',
  )
  process.exit(1)
}

const navigation = await readFile(
  join(authoringReferences, 'navigation-architecture.md'),
  'utf8',
)
for (const contract of [
  '## Common top navigation',
  '## Common left-navigation grammar',
  '## Merge type blocks',
  '## Apply audience flavor',
  '## Navigation quality gate',
]) {
  if (!navigation.includes(contract)) {
    console.error(
      `Skill validation failed: navigation architecture lacks "${contract}".`,
    )
    process.exit(1)
  }
}

const generatorSkills = [
  'doxbrix',
  'docusaurus',
  'mkdocs',
  'sphinx',
  'hugo',
  'vitepress',
  'markdoc',
  'nextra',
  'starlight',
  'jekyll',
  'static',
]
for (const generator of generatorSkills) {
  if (!authoring.includes(`$doxloop-${generator}`)) {
    console.error(
      `Skill validation failed: doxloop-authoring does not route generator "${generator}".`,
    )
    process.exit(1)
  }
}

for (const skill of skills.filter((value) => value.includes('doxloop-') && !value.endsWith('doxloop-authoring'))) {
  if (skill.endsWith('doxloop-doxbrix') || skill.includes(`${join('packages', 'generator-')}`)) {
    const text = await readFile(join(root, skill, 'SKILL.md'), 'utf8')
    if (!text.includes('$doxloop-authoring')) {
      console.error(
        `Skill validation failed: ${skill} must delegate shared quality work to $doxloop-authoring.`,
      )
      process.exit(1)
    }
    if (!text.includes('semantic top/left navigation plan')) {
      console.error(
        `Skill validation failed: ${skill} does not translate the shared semantic navigation plan.`,
      )
      process.exit(1)
    }
  }
}
