#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const prompt = process.argv.at(-1) ?? ''
const section = /Pages to edit:\n([\s\S]*?)\n\nReviewer instruction:/.exec(prompt)?.[1] ?? ''
const paths = [...section.matchAll(/^- ([^\s]+) \(.+\)$/gm)].map((match) => match[1])
if (paths.length === 0) {
  process.stderr.write('Fake page-edit agent could not find the selected page.\n')
  process.exit(1)
}

for (const path of paths) {
  const absolute = join(process.cwd(), path)
  const current = readFileSync(absolute, 'utf8').trimEnd()
  writeFileSync(absolute, `${current}\n\nThis page now includes the requested smoke-test clarification.\n`)
}

const evidencePath = join(process.cwd(), '.doxloop', 'evidence-map.json')
const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'))
for (const path of paths) {
  const entry = evidence.pages[path] ?? { sources: [] }
  entry.claims = [...new Set([...(entry.claims ?? []), 'The requested smoke-test clarification was added.'])]
  evidence.pages[path] = entry
}
writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`)
process.stdout.write('Updated the selected page and its evidence entry.\n')
