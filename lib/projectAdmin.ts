export const PROJECT_ADMIN_ROLES = ['owner', 'admin'] as const;

export function normalizeUserRole(role: string | null | undefined): string | null {
  if (typeof role !== 'string') return null;
  const normalized = role.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

export function hasProjectAdminRole(role: string | null | undefined): boolean {
  const normalized = normalizeUserRole(role);
  return normalized != null && PROJECT_ADMIN_ROLES.includes(normalized as (typeof PROJECT_ADMIN_ROLES)[number]);
}
