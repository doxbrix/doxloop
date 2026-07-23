import { authenticatedRequest } from './auth.js'

export type DeploymentVisibility = 'private' | 'public'

export function deploymentVisibility(publicSite?: boolean): DeploymentVisibility {
  return publicSite ? 'public' : 'private'
}

export async function updateDeploymentVisibility(
  project: { id: string; visibility?: DeploymentVisibility },
  visibility: DeploymentVisibility,
  apiUrl?: string,
): Promise<void> {
  if (project.visibility === visibility) return
  await authenticatedRequest(
    `/api/v1/projects/${encodeURIComponent(project.id)}/settings`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ visibility }),
    },
    apiUrl,
  )
}
