import { buildProjectDocumentHref } from '@/lib/documentNavigation';
import type { ValidationEvidence } from '@/types/validator';

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

export function getEvidenceDocumentUrl(args: {
  projectId: string;
  evidence: ValidationEvidence;
}): string | null {
  const documentId = normalizeString(args.evidence.source_document_id);
  const page = normalizePositivePage(args.evidence.source_page);

  if (!documentId || page == null) {
    return null;
  }

  const baseHref = buildProjectDocumentHref(documentId, args.projectId);
  const params = new URLSearchParams();
  params.set('source', 'project');
  params.set('projectId', args.projectId);
  params.set('page', String(page));

  const factId = normalizeString(args.evidence.fact_id);
  if (factId) {
    params.set('factId', factId);
  }

  const fieldKey = normalizeString(args.evidence.field_name) ?? fieldKeyFromFactId(factId);
  if (fieldKey) {
    params.set('fieldKey', fieldKey);
  }

  return `${baseHref.split('?')[0]}?${params.toString()}`;
}
