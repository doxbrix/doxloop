export type Role = 'admin' | 'operator' | 'viewer'

export function canInvite(role: Role): boolean {
  return role === 'admin'
}
