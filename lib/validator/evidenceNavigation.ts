import { buildProjectDocumentHref } from '@/lib/documentNavigation';
import type { ValidationEvidence } from '@/types/validator';

export type EvidenceReviewAction =
  | 'inspect'
  | 'review'
  | 'request_correction'
  | 'manual_override';

export type ValidationEvidenceTarget = {
  href: string | null;
  documentId: string | null;
  page: number | null;
  factId: string | null;
  fieldKey: string | null;
  recordId: string | null;
  rateRowId: string | null;
  exactTarget: boolean;
  label: string;
  detail: string;
  missingReason: string | null;
};

function normalizePositivePage(value: number | null): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const normalized = Math.trunc(value);
  return normalized > 0 ? normalized : null;
}

function normalizeString(value: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function fieldKeyFromFactId(factId: string | null): string | null {
  const normalizedFactId = normalizeString(factId);
  if (!normalizedFactId) return null;

  const separatorIndex = normalizedFactId.indexOf(':');
  if (separatorIndex < 0 || separatorIndex === normalizedFactId.length - 1) {
    return null;
  }

  return normalizeString(normalizedFactId.slice(separatorIndex + 1));
}

function rateRowIdFromRecordId(recordId: string | null): string | null {
  const normalized = normalizeString(recordId);
  if (!normalized) return null;
  return normalized.startsWith('rate_row:') ? normalized : null;
}

function targetLabel(target: {
  rateRowId: string | null;
  recordId: string | null;
  factId: string | null;
  fieldKey: string | null;
  page: number | null;
  documentId: string | null;
}): string {
  if (target.rateRowId) {
    return `Contract rate row ${target.rateRowId}`;
  }
  if (target.recordId) {
    return `Spreadsheet row ${target.recordId}`;
  }
  if (target.fieldKey) {
    return `Canonical fact ${target.fieldKey}`;
  }
  if (target.factId) {
    return `Canonical fact ${target.factId}`;
  }
  if (target.page != null) {
    return `Document page ${target.page}`;
  }
  if (target.documentId) {
    return 'Source document';
  }
  return 'Missing evidence target';
}

function targetDetail(target: {
  page: number | null;
  fieldKey: string | null;
  factId: string | null;
  recordId: string | null;
  rateRowId: string | null;
}): string {
  const parts: string[] = [];
  if (target.page != null) {
    parts.push(`Page ${target.page}`);
  }
  if (target.rateRowId) {
    parts.push(`rate row ${target.rateRowId}`);
  } else if (target.recordId) {
    parts.push(`row ${target.recordId}`);
  }
  if (target.fieldKey) {
    parts.push(`fact ${target.fieldKey}`);
  } else if (target.factId) {
    parts.push(`fact ${target.factId}`);
  }
  return parts.length > 0 ? parts.join(' | ') : 'Document-level context only';
}

function targetMissingReason(target: {
  documentId: string | null;
  exactTarget: boolean;
}): string | null {
  if (!target.documentId) {
    return 'No source document is attached to this evidence item yet.';
  }
  if (!target.exactTarget) {
    return 'The source document is linked, but validator did not persist an exact page, row, or fact target.';
  }
  return null;
}

export function buildEvidenceTarget(args: {
  projectId: string;
  evidence: ValidationEvidence;
  action?: EvidenceReviewAction | null;
  decisionId?: string | null;
  findingId?: string | null;
}): ValidationEvidenceTarget {
  const documentId = normalizeString(args.evidence.source_document_id);
  const page = normalizePositivePage(args.evidence.source_page);
  const factId = normalizeString(args.evidence.fact_id);
  const recordId = normalizeString(args.evidence.record_id);
  const rateRowId = rateRowIdFromRecordId(recordId);
  const fieldKey = normalizeString(args.evidence.field_name) ?? fieldKeyFromFactId(factId);
  const exactTarget =
    page != null
    || factId != null
    || fieldKey != null
    || recordId != null
    || rateRowId != null;

  if (!documentId) {
    return {
      href: null,
      documentId: null,
      page,
      factId,
      fieldKey,
      recordId,
      rateRowId,
      exactTarget: false,
      label: targetLabel({
        rateRowId,
        recordId,
        factId,
        fieldKey,
        page,
        documentId: null,
      }),
      detail: targetDetail({
        page,
        fieldKey,
        factId,
        recordId,
        rateRowId,
      }),
      missingReason: targetMissingReason({
        documentId: null,
        exactTarget: false,
      }),
    };
  }

  const baseHref = buildProjectDocumentHref(documentId, args.projectId);
  const params = new URLSearchParams();
  params.set('source', 'project');
  params.set('projectId', args.projectId);
  if (page != null) {
    params.set('page', String(page));
  }
  if (factId) {
    params.set('factId', factId);
  }
  if (fieldKey) {
    params.set('fieldKey', fieldKey);
  }
  if (recordId) {
    params.set('recordId', recordId);
  }
  if (rateRowId) {
    params.set('rateRowId', rateRowId);
  }
  if (args.action) {
    params.set('action', args.action);
  }
  if (args.decisionId) {
    params.set('decisionId', args.decisionId);
  }
  if (args.findingId) {
    params.set('findingId', args.findingId);
  }

  return {
    href: `${baseHref.split('?')[0]}?${params.toString()}`,
    documentId,
    page,
    factId,
    fieldKey,
    recordId,
    rateRowId,
    exactTarget,
    label: targetLabel({
      rateRowId,
      recordId,
      factId,
      fieldKey,
      page,
      documentId,
    }),
    detail: targetDetail({
      page,
      fieldKey,
      factId,
      recordId,
      rateRowId,
    }),
    missingReason: targetMissingReason({
      documentId,
      exactTarget,
    }),
  };
}

export function getEvidenceDocumentUrl(args: {
  projectId: string;
  evidence: ValidationEvidence;
  action?: EvidenceReviewAction | null;
  decisionId?: string | null;
  findingId?: string | null;
}): string | null {
  return buildEvidenceTarget(args).href;
}
