import type { ResolutionQueue } from '@/lib/resolution/resolutionCases';

/**
 * Deep links into the Resolution Workspace (B5-B). A link names a record the
 * linking surface already holds (a finding, a document line's anchor, a
 * document); the workspace picks the case whose server-given source refs
 * match it. The link never constructs a case id, so it can never point at a
 * case the server did not derive.
 */
export type ResolutionDeepLink = Readonly<{
  caseId?: string | null;
  findingId?: string | null;
  documentId?: string | null;
  anchorKey?: string | null;
}>;

export function resolutionWorkspaceHref(projectId: string, link: ResolutionDeepLink = {}): string {
  const query = new URLSearchParams();
  if (link.caseId) query.set('case', link.caseId);
  if (link.findingId) query.set('finding', link.findingId);
  if (link.documentId) query.set('document', link.documentId);
  if (link.anchorKey) query.set('anchor', link.anchorKey);
  const search = query.toString();
  return `/platform/projects/${encodeURIComponent(projectId)}/resolve${search ? `?${search}` : ''}`;
}

/** The linked case in queue order, or the first case when the link matches none. */
export function selectDeepLinkedCase(queue: ResolutionQueue, link: ResolutionDeepLink): string | null {
  const order = queue.groups.flatMap((group) => group.caseIds);
  const byId = new Map(queue.cases.map((entry) => [entry.caseId, entry]));
  const ordered = order.flatMap((caseId) => (byId.has(caseId) ? [byId.get(caseId)!] : []));
  const match = (link.caseId ? ordered.find((entry) => entry.caseId === link.caseId) : undefined)
    ?? (link.findingId ? ordered.find((entry) => entry.sourceRefs.findingId === link.findingId) : undefined)
    ?? (link.documentId && link.anchorKey
      ? ordered.find((entry) => entry.documentId === link.documentId && entry.sourceRefs.anchorKey === link.anchorKey)
      : undefined)
    ?? (link.documentId ? ordered.find((entry) => entry.documentId === link.documentId) : undefined);
  return match?.caseId ?? ordered[0]?.caseId ?? null;
}
