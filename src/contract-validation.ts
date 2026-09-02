import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js'
import addFormatsModule from 'ajv-formats'
import { DoxloopError } from './errors.js'

export type PublicContract = 'quality-report-v1' | 'evaluation-v1' | 'coverage-v1'

const validators = new Map<PublicContract, ValidateFunction>()

/** Validate output at its public boundary so an incompatible report is never persisted. */
export async function assertPublicContract(contract: PublicContract, value: unknown): Promise<void> {
  let validate = validators.get(contract)
  if (!validate) {
    const path = fileURLToPath(new URL(`../contracts/${contract}.schema.json`, import.meta.url))
    const schema = JSON.parse(await readFile(path, 'utf8')) as object
    const ajv = new Ajv2020({ allErrors: true, strict: true })
    const addFormats = addFormatsModule as unknown as (instance: Ajv2020) => Ajv2020
    addFormats(ajv)
    const compiled = ajv.compile(schema)
    validators.set(contract, compiled)
    validate = compiled
  }
  if (validate(value)) return
  const detail = validate.errors?.map((error) => `${error.instancePath || '/'} ${error.message ?? 'is invalid'}`).join('; ') ?? 'unknown schema error'
  throw new DoxloopError(`Doxloop refused to write an invalid ${contract} payload: ${detail}`)
}
