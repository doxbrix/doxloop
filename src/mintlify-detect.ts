import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Detection never treats Mintlify as a generator that can be adopted in place. */
export async function mintlifyMarker(root: string): Promise<string | undefined> {
  for (const name of ['docs.json', 'mint.json']) {
    try {
      const config = JSON.parse(await readFile(join(root, name), 'utf8')) as Record<string, unknown>
      // Existing Doxbrix projects also have a legacy title + navigation-array format.
      if (name === 'docs.json' && typeof config?.title === 'string' && Array.isArray(config.navigation)) continue
      if (config && config.navigation && !Array.isArray(config.spaces)) return name
    } catch { /* Not a Mintlify configuration. */ }
  }
  return undefined
}
