type SearchParamsLike = {
  get(name: string): string | null;
};

export type DocumentLinkContext =
  | { source: 'project'; projectId: string }
  | { source: 'documents' };

export type DocumentDetailContextMode = 'project' | 'documents' | 'direct';

export type ResolvedDocumentDetailContext = {
  mode: DocumentDetailContextMode;
  linkedProjectId: string | null;
};

function normalizeValue(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function buildDocumentDetailHref(
  documentId: string,
  context?: DocumentLinkContext,
): string {
  const baseHref = `/platform/documents/${documentId}`;
  if (!context) return baseHref;

  const params = new URLSearchParams();
  params.set('source', context.source);

  if (context.source === 'project') {
    params.set('projectId', context.projectId);
  }

  const query = params.toString();
  return query ? `${baseHref}?${query}` : baseHref;
}

export function buildDocumentsDocumentHref(documentId: string): string {
  return buildDocumentDetailHref(documentId, { source: 'documents' });
}

export function buildProjectDocumentHref(documentId: string, projectId: string): string {
  return buildDocumentDetailHref(documentId, { source: 'project', projectId });
}

export function resolveDocumentDetailContext(
  searchParams: SearchParamsLike,
  linkedProjectId?: string | null,
): ResolvedDocumentDetailContext {
  const source = searchParams.get('source');
  const requestedProjectId = normalizeValue(searchParams.get('projectId'));
  const normalizedLinkedProjectId = normalizeValue(linkedProjectId);

  if (
    source === 'project' &&
    normalizedLinkedProjectId &&
    requestedProjectId === normalizedLinkedProjectId
  ) {
    return {
      mode: 'project',
      linkedProjectId: normalizedLinkedProjectId,
    };
  }

  if (source === 'documents') {
    return {
      mode: 'documents',
      linkedProjectId: normalizedLinkedProjectId,
    };
  }

  return {
    mode: 'direct',
    linkedProjectId: normalizedLinkedProjectId,
  };
}
