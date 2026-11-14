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

/** The linked server-derived case. Explicit, unmatched context never opens another case. */
export function selectDeepLinkedCase(queue: ResolutionQueue, link: ResolutionDeepLink): string | null {
  const order = queue.groups.flatMap((group) => group.caseIds);
  const byId = new Map(queue.cases.map((entry) => [entry.caseId, entry]));
  const ordered = order.flatMap((caseId) => (byId.has(caseId) ? [byId.get(caseId)!] : []));
  const hasContext = Boolean(link.caseId || link.findingId || link.documentId || link.anchorKey);
  if (!hasContext) return ordered[0]?.caseId ?? null;
  return ordered.find((entry) => (!link.caseId || entry.caseId === link.caseId)
    && (!link.findingId || entry.sourceRefs.findingId === link.findingId)
    && (!link.documentId || entry.documentId === link.documentId)
    && (!link.anchorKey || entry.sourceRefs.anchorKey === link.anchorKey))?.caseId ?? null;
}
