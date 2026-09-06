export type DeployTargetId = 'doxbrix' | 'export' | 'github-pages' | 'netlify' | 'vercel'

export interface DeployBundle {
  outputDir: string
  archive: Uint8Array
  files: number
  bytes: number
  sha256: string
}

export interface DeployTargetOptions {
  root: string
  name: string
  slug: string
  apiUrl?: string
  siteId?: string
  projectId?: string
  teamId?: string
  branch?: string
  basePath?: string
  siteUrl?: string
}

export interface DeployTargetResult {
  url?: string
  id?: string
  detail?: string
}

export interface DeployTarget {
  id: DeployTargetId
  label: string
  configure(options: DeployTargetOptions): Promise<DeployTargetOptions>
  publish(bundle: DeployBundle, options: DeployTargetOptions): Promise<DeployTargetResult>
}
