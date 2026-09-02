import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import { assertPublicContract } from './contract-validation.js'
import { QUALITY_CATEGORIES, QUALITY_CODES, QUALITY_CONTRACT_VERSION } from './quality-contract.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

describe('public quality contracts', () => {
  test('ships parseable v1 schemas for stable automation surfaces', async () => {
    for (const file of ['quality-report-v1.schema.json', 'validation-v1.schema.json', 'drift-v1.schema.json', 'coverage-v1.schema.json', 'evaluation-v1.schema.json', 'agent-events-v1.schema.json', 'quality-codes-v1.json']) {
      expect(JSON.parse(await readFile(join(root, 'contracts', file), 'utf8'))).toBeTruthy()
    }
    expect(QUALITY_CONTRACT_VERSION).toBe('1.0.0')
    expect(QUALITY_CATEGORIES).toContain('claims')
    expect(new Set(Object.values(QUALITY_CODES)).size).toBe(Object.values(QUALITY_CODES).length)
  })

  test('rejects an emitted report that breaks a public schema', async () => {
    await expect(assertPublicContract('quality-report-v1', { schemaVersion: 1 })).rejects.toThrow('invalid quality-report-v1')
  })
})
