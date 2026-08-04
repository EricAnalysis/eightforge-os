export type CanonicalShadowPublicationFlag =
  | { readonly mode: 'off'; readonly projectIds: readonly string[] }
  | { readonly mode: 'all'; readonly projectIds: readonly string[] }
  | { readonly mode: 'allowlist'; readonly projectIds: readonly string[] };

export function resolveCanonicalShadowPublicationFlag(
  modeRaw: string | null | undefined,
  projectIdsRaw?: string | null,
): CanonicalShadowPublicationFlag {
  const mode = modeRaw?.trim().toLowerCase();
  if (!mode || mode === 'off') return { mode: 'off', projectIds: [] };
  if (mode === 'all') return { mode: 'all', projectIds: [] };
  if (mode !== 'allowlist') return { mode: 'off', projectIds: [] };
  const ids = [...new Set((projectIdsRaw ?? '').split(',').map((id) => id.trim()).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right, 'en-US'));
  return ids.length === 0 ? { mode: 'off', projectIds: [] } : { mode: 'allowlist', projectIds: ids };
}

export function isCanonicalShadowPublicationEnabled(
  projectId: string,
  modeRaw: string | null | undefined,
  projectIdsRaw?: string | null,
): boolean {
  const flag = resolveCanonicalShadowPublicationFlag(modeRaw, projectIdsRaw);
  return flag.mode === 'all' || (flag.mode === 'allowlist' && flag.projectIds.includes(projectId));
}
