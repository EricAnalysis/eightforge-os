import type { SupabaseClient } from '@supabase/supabase-js';
import { pickPreferredExtractionBlob } from '@/lib/blobExtractionSelection';
import type { RelatedDocInput } from '@/lib/documentIntelligence';
import {
  inferGoverningDocumentFamily,
  resolveDocumentPrecedence,
  type DocumentPrecedenceRecord,
  type DocumentRelationshipRecord,
  type ResolvedDocumentPrecedenceFamily,
  type ResolvedDocumentPrecedenceRecord,
} from '@/lib/documentPrecedence';

const DOCUMENT_PRECEDENCE_SELECT = [
  'id',
  'project_id',
  'title',
  'name',
  'document_type',
  'created_at',
  'document_role',
  'authority_status',
  'effective_date',
  'precedence_rank',
  'operator_override_precedence',
].join(', ');

const LEGACY_DOCUMENT_PRECEDENCE_SELECT = [
  'id',
  'project_id',
  'title',
  'name',
  'document_type',
  'created_at',
].join(', ');

const LEGACY_SUPPORT_DOCUMENT_TYPES = new Set([
  'payment rec',
  'disposal checklist',
  'dms checklist',
  'kickoff',
  'kickoff checklist',
  'daily ops',
  'ops report',
]);

export type ProjectDocumentPrecedenceSnapshot = {
  documents: DocumentPrecedenceRecord[];
  relationships: DocumentRelationshipRecord[];
  families: ResolvedDocumentPrecedenceFamily[];
};

function normalizeText(value: string | null | undefined): string {
  return (value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ');
}

function isMissingRelationshipTable(error: { code?: string | null; message?: string | null } | null | undefined): boolean {
  return error?.code === '42P01' || (error?.message ?? '').toLowerCase().includes('document_relationships');
}

function isMissingDocumentPrecedenceColumn(error: { code?: string | null; message?: string | null } | null | undefined): boolean {
  if (error?.code !== '42703') return false;

  const message = (error?.message ?? '').toLowerCase();
  return [
    'document_role',
    'authority_status',
    'effective_date',
    'precedence_rank',
    'operator_override_precedence',
  ].some((column) => message.includes(column));
}

function shouldIncludeLegacySupportDocument(document: DocumentPrecedenceRecord): boolean {
  return LEGACY_SUPPORT_DOCUMENT_TYPES.has(normalizeText(document.document_type));
}

async function loadExtractionMap(
  admin: SupabaseClient,
  documentIds: string[],
): Promise<Map<string, Record<string, unknown> | null>> {
  if (documentIds.length === 0) return new Map();

  const { data, error } = await admin
    .from('document_extractions')
    .select('document_id, data, created_at')
    .in('document_id', documentIds)
    .is('field_key', null)
    .order('created_at', { ascending: false });

  if (error || !data) return new Map();

  const candidatesByDocumentId = new Map<string, Array<{ data?: Record<string, unknown> | null }>>();
  for (const row of data) {
    const documentId = row.document_id as string;
    const candidates = candidatesByDocumentId.get(documentId) ?? [];
    candidates.push(row as { data?: Record<string, unknown> | null });
    candidatesByDocumentId.set(documentId, candidates);
  }

  const extractionMap = new Map<string, Record<string, unknown> | null>();
  for (const [documentId, candidates] of candidatesByDocumentId.entries()) {
    extractionMap.set(documentId, pickPreferredExtractionBlob(candidates)?.data ?? null);
  }

  return extractionMap;
}

export async function loadProjectDocumentPrecedenceSnapshot(
  admin: SupabaseClient,
  params: {
    organizationId: string;
    projectId: string;
  },
): Promise<ProjectDocumentPrecedenceSnapshot> {
  const { organizationId, projectId } = params;

  const { data: documentsWithPrecedence, error: documentsError } = await admin
    .from('documents')
    .select(DOCUMENT_PRECEDENCE_SELECT)
    .eq('organization_id', organizationId)
    .eq('project_id', projectId)
    .order('created_at', { ascending: false });

  let documents = documentsWithPrecedence;
  if (documentsError && isMissingDocumentPrecedenceColumn(documentsError)) {
    const legacyDocumentsResult = await admin
      .from('documents')
      .select(LEGACY_DOCUMENT_PRECEDENCE_SELECT)
      .eq('organization_id', organizationId)
      .eq('project_id', projectId)
      .order('created_at', { ascending: false });

    documents = legacyDocumentsResult.data;
    if (legacyDocumentsResult.error) {
      throw new Error(legacyDocumentsResult.error.message);
    }
  } else if (documentsError) {
    throw new Error(documentsError.message);
  }

  const { data: relationships, error: relationshipsError } = await admin
    .from('document_relationships')
    .select('id, project_id, source_document_id, target_document_id, relationship_type, created_by, created_at')
    .eq('organization_id', organizationId)
    .eq('project_id', projectId)
    .order('created_at', { ascending: false });

  const safeDocuments = (documents ?? []) as unknown as DocumentPrecedenceRecord[];
  let safeRelationships: DocumentRelationshipRecord[] = [];
  if (relationshipsError) {
    if (!isMissingRelationshipTable(relationshipsError)) {
      throw new Error(relationshipsError.message);
    }
  } else {
    safeRelationships = (relationships ?? []) as unknown as DocumentRelationshipRecord[];
  }

  return {
    documents: safeDocuments,
    relationships: safeRelationships,
    families: resolveDocumentPrecedence({
      documents: safeDocuments,
      relationships: safeRelationships,
    }),
  };
}

function buildResolvedDocumentMap(
  families: ResolvedDocumentPrecedenceFamily[],
): Map<string, ResolvedDocumentPrecedenceRecord> {
  const resolvedById = new Map<string, ResolvedDocumentPrecedenceRecord>();
  for (const family of families) {
    for (const document of family.documents) {
      resolvedById.set(document.id, document);
    }
  }
  return resolvedById;
}

function sortDocumentsByCreatedAt(
  documents: DocumentPrecedenceRecord[],
): DocumentPrecedenceRecord[] {
  return [...documents].sort((left, right) => {
    const leftTimestamp = new Date(left.created_at).getTime();
    const rightTimestamp = new Date(right.created_at).getTime();
    if (leftTimestamp !== rightTimestamp) return rightTimestamp - leftTimestamp;
    return (left.title ?? left.name).localeCompare(right.title ?? right.name, 'en-US');
  });
}

function toRelatedDocInput(
  document: DocumentPrecedenceRecord,
  extraction: Record<string, unknown> | null,
  resolved: ResolvedDocumentPrecedenceRecord | null,
): RelatedDocInput {
  return {
    id: document.id,
    document_type: document.document_type ?? null,
    name: document.name,
    title: document.title ?? null,
    extraction,
    document_role: document.document_role ?? null,
    authority_status: document.authority_status ?? null,
    effective_date: document.effective_date ?? null,
    precedence_rank: document.precedence_rank ?? null,
    operator_override_precedence: Boolean(document.operator_override_precedence),
    governing_family: resolved?.family ?? null,
    governing_reason: resolved?.governing_reason ?? null,
    governing_reason_detail: resolved?.governing_reason_detail ?? null,
    governing_document_id: resolved?.governing_document_id ?? null,
    considered_document_ids: resolved?.considered_document_ids ?? [],
    is_governing: resolved?.is_governing ?? false,
  };
}

export async function loadPrecedenceAwareRelatedDocs(
  admin: SupabaseClient,
  params: {
    organizationId: string;
    projectId: string;
    currentDocumentId?: string | null;
  },
): Promise<RelatedDocInput[]> {
  const snapshot = await loadProjectDocumentPrecedenceSnapshot(admin, {
    organizationId: params.organizationId,
    projectId: params.projectId,
  });

  const resolvedById = buildResolvedDocumentMap(snapshot.families);
  const familyDocumentsInOrder = snapshot.families.flatMap((family) => family.documents);
  const familyDocumentIds = new Set(familyDocumentsInOrder.map((document) => document.id));
  const currentDocumentId = params.currentDocumentId ?? null;

  const orderedDocuments: DocumentPrecedenceRecord[] = [
    ...familyDocumentsInOrder,
    ...sortDocumentsByCreatedAt(
      snapshot.documents.filter((document) =>
        !familyDocumentIds.has(document.id) &&
        shouldIncludeLegacySupportDocument(document),
      ),
    ),
  ].filter((document) => document.id !== currentDocumentId);

  const extractionMap = await loadExtractionMap(
    admin,
    orderedDocuments.map((document) => document.id),
  );

  return orderedDocuments.map((document) =>
    toRelatedDocInput(
      document,
      extractionMap.get(document.id) ?? null,
      resolvedById.get(document.id) ?? null,
    ),
  );
}

export function resolveDocumentFamilyForProjectDocument(
  document: DocumentPrecedenceRecord,
): ReturnType<typeof inferGoverningDocumentFamily> {
  return inferGoverningDocumentFamily(document);
}
