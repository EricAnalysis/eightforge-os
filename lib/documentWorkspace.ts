import { buildDocumentsDocumentHref } from '@/lib/documentNavigation';
import type { DocumentExecutionTrace } from '@/lib/types/documentIntelligence';

export type DocumentReviewStatus =
  | 'not_reviewed'
  | 'in_review'
  | 'approved'
  | 'needs_correction';

export type DocumentWorkspaceMode =
  | 'all'
  | 'needs_review'
  | 'contracts'
  | 'invoices'
  | 'unlinked';

export type DocumentWorkspaceAttentionFilter =
  | ''
  | 'needs_review'
  | 'findings'
  | 'blocked'
  | 'clear';

export type DocumentWorkspaceRecentFilter = '' | '24h' | '7d' | '30d';

export type DocumentWorkspaceSort =
  | 'updated_desc'
  | 'created_desc'
  | 'title_asc'
  | 'findings_desc';

export type DocumentWorkspaceTone =
  | 'danger'
  | 'warning'
  | 'info'
  | 'success'
  | 'muted';

export type DocumentWorkspaceProjectRelation = {
  id: string;
  name: string;
  code: string | null;
};

export type DocumentWorkspaceDocRow = {
  id: string;
  title: string | null;
  name: string;
  document_type: string | null;
  processing_status: string;
  processing_error: string | null;
  created_at: string;
  processed_at: string | null;
  domain: string | null;
  project_id: string | null;
  // Optional: not selected on the list view to avoid fetching large JSONB for
  // every document. Present on the detail page only.
  intelligence_trace?: DocumentExecutionTrace | Record<string, unknown> | null;
  projects:
    | DocumentWorkspaceProjectRelation
    | DocumentWorkspaceProjectRelation[]
    | null;
};

export type DocumentWorkspaceReviewRow = {
  document_id: string;
  status: DocumentReviewStatus;
  reviewed_at: string | null;
};

export type DocumentWorkspaceItem = {
  id: string;
  title: string;
  fileName: string;
  documentHref: string;
  projectId: string | null;
  projectName: string | null;
  projectCode: string | null;
  projectHref: string | null;
  isUnlinked: boolean;
  documentType: string | null;
  documentTypeLabel: string;
  processingStatus: string;
  processingStatusLabel: string;
  processingError: string | null;
  reviewStatus: DocumentReviewStatus;
  reviewStatusLabel: string;
  unresolvedFindingCount: number;
  pendingActionCount: number;
  blockedCount: number;
  needsReview: boolean;
  workspaceStatusLabel: string;
  workspaceTone: DocumentWorkspaceTone;
  domain: string | null;
  createdAt: string;
  processedAt: string | null;
  reviewedAt: string | null;
  latestActivityAt: string;
  searchText: string;
};

export type DocumentWorkspaceGroup = {
  key: string;
  projectId: string | null;
  projectName: string;
  projectCode: string | null;
  projectHref: string | null;
  isUnlinked: boolean;
  totalDocuments: number;
  needsReviewCount: number;
  unresolvedFindingCount: number;
  blockedCount: number;
  lastUpdatedAt: string;
  documents: DocumentWorkspaceItem[];
};

export type DocumentWorkspaceFilters = {
  search: string;
  mode: DocumentWorkspaceMode;
  projectId: string;
  documentType: string;
  processingStatus: string;
  attention: DocumentWorkspaceAttentionFilter;
  recent: DocumentWorkspaceRecentFilter;
};

export type DocumentWorkspaceSummary = {
  totalDocuments: number;
  totalProjects: number;
  needsReviewCount: number;
  unlinkedCount: number;
  blockedCount: number;
};

function normalizeText(value: string | null | undefined): string {
  return value?.trim().toLowerCase() ?? '';
}

function titleize(value: string | null | undefined): string {
  if (!value) return 'Unknown';

  return value
    .replace(/_/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function resolveProjectRelation(
  relation: DocumentWorkspaceDocRow['projects'],
): DocumentWorkspaceProjectRelation | null {
  if (!relation) return null;
  return Array.isArray(relation) ? relation[0] ?? null : relation;
}

function parseDocumentTrace(
  trace: DocumentExecutionTrace | Record<string, unknown> | null | undefined,
): DocumentExecutionTrace | null {
  if (!trace || typeof trace !== 'object' || Array.isArray(trace)) return null;

  const candidate = trace as Partial<DocumentExecutionTrace>;
  if (!candidate.facts || typeof candidate.facts !== 'object') return null;
  if (!Array.isArray(candidate.decisions) || !Array.isArray(candidate.flow_tasks)) return null;

  return {
    extraction_snapshot_id:
      typeof candidate.extraction_snapshot_id === 'string'
        ? candidate.extraction_snapshot_id
        : undefined,
    facts: candidate.facts as Record<string, unknown>,
    decisions: candidate.decisions,
    flow_tasks: candidate.flow_tasks,
    generated_at:
      typeof candidate.generated_at === 'string' ? candidate.generated_at : '',
    engine_version:
      typeof candidate.engine_version === 'string' ? candidate.engine_version : '',
    classification: candidate.classification,
    summary: candidate.summary,
    entities: candidate.entities,
    key_facts: candidate.key_facts,
    suggested_questions: candidate.suggested_questions,
    extracted:
      candidate.extracted && typeof candidate.extracted === 'object'
        ? (candidate.extracted as Record<string, unknown>)
        : undefined,
    evidence: Array.isArray(candidate.evidence) ? candidate.evidence : undefined,
    extraction_gaps: Array.isArray(candidate.extraction_gaps)
      ? candidate.extraction_gaps
      : undefined,
    audit_notes: Array.isArray(candidate.audit_notes) ? candidate.audit_notes : undefined,
    node_traces: Array.isArray(candidate.node_traces) ? candidate.node_traces : undefined,
  };
}

function reviewStatusLabel(status: DocumentReviewStatus): string {
  switch (status) {
    case 'in_review':
      return 'In Review';
    case 'approved':
      return 'Approved';
    case 'needs_correction':
      return 'Needs Correction';
    default:
      return 'Not Reviewed';
  }
}

function workspaceStatus(params: {
  processingStatus: string;
  blockedCount: number;
  needsReview: boolean;
}): { label: string; tone: DocumentWorkspaceTone } {
  const { processingStatus, blockedCount, needsReview } = params;

  if (processingStatus === 'failed') {
    return { label: 'Failed', tone: 'danger' };
  }

  if (blockedCount > 0) {
    return { label: 'Blocked', tone: 'danger' };
  }

  if (needsReview) {
    return { label: 'Needs Review', tone: 'warning' };
  }

  if (processingStatus === 'decisioned') {
    return { label: 'Operationally Clear', tone: 'success' };
  }

  if (processingStatus === 'processing') {
    return { label: 'Processing', tone: 'info' };
  }

  if (processingStatus === 'extracted') {
    return { label: 'Extracted', tone: 'info' };
  }

  return { label: titleize(processingStatus), tone: 'muted' };
}

function latestTimestamp(values: Array<string | null | undefined>): string {
  const timestamps = values
    .filter((value): value is string => Boolean(value))
    .map((value) => new Date(value).getTime())
    .filter((value) => Number.isFinite(value));

  if (timestamps.length === 0) {
    return new Date(0).toISOString();
  }

  return new Date(Math.max(...timestamps)).toISOString();
}

function matchesRecentFilter(
  timestamp: string,
  recent: DocumentWorkspaceRecentFilter,
): boolean {
  if (!recent) return true;

  const now = Date.now();
  const activityAt = new Date(timestamp).getTime();
  if (!Number.isFinite(activityAt)) return false;

  const ageMs = now - activityAt;
  const thresholds: Record<Exclude<DocumentWorkspaceRecentFilter, ''>, number> = {
    '24h': 24 * 60 * 60 * 1000,
    '7d': 7 * 24 * 60 * 60 * 1000,
    '30d': 30 * 24 * 60 * 60 * 1000,
  };

  return ageMs <= thresholds[recent];
}

function matchesAttentionFilter(
  item: DocumentWorkspaceItem,
  attention: DocumentWorkspaceAttentionFilter,
): boolean {
  switch (attention) {
    case 'needs_review':
      return item.needsReview;
    case 'findings':
      return item.unresolvedFindingCount > 0;
    case 'blocked':
      return item.blockedCount > 0 || item.processingStatus === 'failed';
    case 'clear':
      return !item.needsReview && item.unresolvedFindingCount === 0 && item.processingStatus === 'decisioned';
    default:
      return true;
  }
}

function matchesMode(item: DocumentWorkspaceItem, mode: DocumentWorkspaceMode): boolean {
  switch (mode) {
    case 'needs_review':
      return item.needsReview || item.unresolvedFindingCount > 0;
    case 'contracts':
      return item.documentType === 'contract';
    case 'invoices':
      return item.documentType === 'invoice';
    case 'unlinked':
      return item.isUnlinked;
    default:
      return true;
  }
}

function compareItems(
  left: DocumentWorkspaceItem,
  right: DocumentWorkspaceItem,
  sort: DocumentWorkspaceSort,
): number {
  if (sort === 'title_asc') {
    return left.title.localeCompare(right.title);
  }

  if (sort === 'created_desc') {
    return new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime();
  }

  if (sort === 'findings_desc') {
    const findingDelta = right.unresolvedFindingCount - left.unresolvedFindingCount;
    if (findingDelta !== 0) return findingDelta;

    const pendingDelta = right.pendingActionCount - left.pendingActionCount;
    if (pendingDelta !== 0) return pendingDelta;
  }

  return new Date(right.latestActivityAt).getTime() - new Date(left.latestActivityAt).getTime();
}

export function buildDocumentWorkspaceItems(params: {
  documents: DocumentWorkspaceDocRow[];
  reviews: DocumentWorkspaceReviewRow[];
}): DocumentWorkspaceItem[] {
  const reviewByDocumentId = new Map(
    params.reviews.map((review) => [review.document_id, review]),
  );

  return params.documents.map((document) => {
    const project = resolveProjectRelation(document.projects);
    const trace = parseDocumentTrace(document.intelligence_trace);
    const review = reviewByDocumentId.get(document.id) ?? null;
    const unresolvedFindingCount =
      trace?.decisions.filter((decision) => decision.family !== 'confirmed').length ?? 0;
    const pendingActionCount = trace?.flow_tasks.length ?? 0;
    const blockedCount =
      trace?.decisions.filter((decision) => decision.family === 'mismatch').length ?? 0;
    const missingSupportCount =
      trace?.decisions.filter((decision) => decision.family === 'missing').length ?? 0;
    const reviewStatus = review?.status ?? 'not_reviewed';
    const needsReview =
      reviewStatus !== 'approved' &&
      (
        reviewStatus === 'needs_correction' ||
        reviewStatus === 'in_review' ||
        blockedCount > 0 ||
        missingSupportCount > 0 ||
        unresolvedFindingCount > 0 ||
        pendingActionCount > 0
      );
    const workspace = workspaceStatus({
      processingStatus: document.processing_status,
      blockedCount,
      needsReview,
    });
    const title = document.title?.trim() || document.name;
    const latestActivityAt = latestTimestamp([
      document.created_at,
      document.processed_at,
      review?.reviewed_at ?? null,
    ]);
    const projectId = project?.id ?? document.project_id ?? null;
    const projectName = project?.name ?? null;
    const projectCode = project?.code ?? null;

    return {
      id: document.id,
      title,
      fileName: document.name,
      documentHref: buildDocumentsDocumentHref(document.id),
      projectId,
      projectName,
      projectCode,
      projectHref: projectId ? `/platform/projects/${projectId}` : null,
      isUnlinked: !projectId,
      documentType: document.document_type,
      documentTypeLabel: titleize(document.document_type ?? 'Unknown'),
      processingStatus: document.processing_status,
      processingStatusLabel: titleize(document.processing_status),
      processingError: document.processing_error,
      reviewStatus,
      reviewStatusLabel: reviewStatusLabel(reviewStatus),
      unresolvedFindingCount,
      pendingActionCount,
      blockedCount,
      needsReview,
      workspaceStatusLabel: workspace.label,
      workspaceTone: workspace.tone,
      domain: document.domain,
      createdAt: document.created_at,
      processedAt: document.processed_at,
      reviewedAt: review?.reviewed_at ?? null,
      latestActivityAt,
      searchText: normalizeText([
        title,
        document.name,
        projectName,
        projectCode,
        document.document_type,
        document.domain,
        workspace.label,
      ].filter(Boolean).join(' ')),
    };
  });
}

export function filterDocumentWorkspaceItems(
  items: DocumentWorkspaceItem[],
  filters: DocumentWorkspaceFilters,
): DocumentWorkspaceItem[] {
  const search = normalizeText(filters.search);

  return items.filter((item) => {
    if (!matchesMode(item, filters.mode)) return false;

    if (filters.projectId === '__unlinked' && !item.isUnlinked) return false;
    if (
      filters.projectId &&
      filters.projectId !== '__unlinked' &&
      item.projectId !== filters.projectId
    ) {
      return false;
    }

    if (filters.documentType && item.documentType !== filters.documentType) return false;
    if (filters.processingStatus && item.processingStatus !== filters.processingStatus) return false;
    if (!matchesAttentionFilter(item, filters.attention)) return false;
    if (!matchesRecentFilter(item.latestActivityAt, filters.recent)) return false;

    if (search && !item.searchText.includes(search)) return false;

    return true;
  });
}

export function sortDocumentWorkspaceItems(
  items: DocumentWorkspaceItem[],
  sort: DocumentWorkspaceSort,
): DocumentWorkspaceItem[] {
  return [...items].sort((left, right) => compareItems(left, right, sort));
}

export function groupDocumentWorkspaceItems(
  items: DocumentWorkspaceItem[],
  sort: DocumentWorkspaceSort,
): DocumentWorkspaceGroup[] {
  const grouped = new Map<string, DocumentWorkspaceGroup>();

  for (const item of sortDocumentWorkspaceItems(items, sort)) {
    const key = item.projectId ?? '__unlinked';
    const existing = grouped.get(key);

    if (existing) {
      existing.documents.push(item);
      existing.totalDocuments += 1;
      existing.needsReviewCount += item.needsReview ? 1 : 0;
      existing.unresolvedFindingCount += item.unresolvedFindingCount;
      existing.blockedCount += item.blockedCount > 0 || item.processingStatus === 'failed' ? 1 : 0;

      if (
        new Date(item.latestActivityAt).getTime() >
        new Date(existing.lastUpdatedAt).getTime()
      ) {
        existing.lastUpdatedAt = item.latestActivityAt;
      }

      continue;
    }

    grouped.set(key, {
      key,
      projectId: item.projectId,
      projectName: item.projectName ?? 'Unlinked Documents',
      projectCode: item.projectCode,
      projectHref: item.projectHref,
      isUnlinked: item.isUnlinked,
      totalDocuments: 1,
      needsReviewCount: item.needsReview ? 1 : 0,
      unresolvedFindingCount: item.unresolvedFindingCount,
      blockedCount: item.blockedCount > 0 || item.processingStatus === 'failed' ? 1 : 0,
      lastUpdatedAt: item.latestActivityAt,
      documents: [item],
    });
  }

  return [...grouped.values()].sort((left, right) => {
    if (left.isUnlinked !== right.isUnlinked) {
      return left.isUnlinked ? 1 : -1;
    }

    return (
      new Date(right.lastUpdatedAt).getTime() -
      new Date(left.lastUpdatedAt).getTime()
    );
  });
}

export function summarizeDocumentWorkspaceItems(
  items: DocumentWorkspaceItem[],
): DocumentWorkspaceSummary {
  return {
    totalDocuments: items.length,
    totalProjects: new Set(items.filter((item) => item.projectId).map((item) => item.projectId)).size,
    needsReviewCount: items.filter((item) => item.needsReview).length,
    unlinkedCount: items.filter((item) => item.isUnlinked).length,
    blockedCount: items.filter((item) => item.blockedCount > 0 || item.processingStatus === 'failed').length,
  };
}
