export const DOCUMENT_ROLE_VALUES = [
  'base_contract',
  'contract_amendment',
  'rate_sheet',
  'permit',
  'ticket_export',
  'invoice',
  'invoice_revision',
  'supporting_attachment',
  'other',
] as const;

export const AUTHORITY_STATUS_VALUES = [
  'active',
  'superseded',
  'draft',
  'archived',
  'reference_only',
] as const;

export const DOCUMENT_RELATIONSHIP_TYPES = [
  'supersedes',
  'amends',
  'governs',
  'replaces',
  'supports',
  'applies_to',
] as const;

export const GOVERNING_DOCUMENT_FAMILIES = [
  'contract',
  'rate_sheet',
  'permit',
  'invoice',
  'ticket_support',
] as const;

export type DocumentRole = (typeof DOCUMENT_ROLE_VALUES)[number];
export type AuthorityStatus = (typeof AUTHORITY_STATUS_VALUES)[number];
export type DocumentRelationshipType = (typeof DOCUMENT_RELATIONSHIP_TYPES)[number];
export type GoverningDocumentFamily = (typeof GOVERNING_DOCUMENT_FAMILIES)[number];
export type DocumentPrecedenceReason =
  | 'operator_override'
  | 'supersedes_relationship'
  | 'amends_relationship'
  | 'role_priority'
  | 'effective_date'
  | 'upload_recency_fallback';

export type DocumentPrecedenceRecord = {
  id: string;
  project_id: string | null;
  title: string | null;
  name: string;
  document_type: string | null;
  created_at: string;
  document_role?: string | null;
  authority_status?: string | null;
  effective_date?: string | null;
  precedence_rank?: number | null;
  operator_override_precedence?: boolean | null;
};

export type DocumentRelationshipRecord = {
  id?: string;
  project_id: string | null;
  source_document_id: string;
  target_document_id: string;
  relationship_type: string;
  created_by?: string | null;
  created_at?: string | null;
};

export type ResolvedDocumentPrecedenceRecord = DocumentPrecedenceRecord & {
  family: GoverningDocumentFamily;
  resolved_role: DocumentRole;
  resolved_order: number;
  is_governing: boolean;
  governing_document_id: string | null;
  governing_reason: DocumentPrecedenceReason | null;
  governing_reason_detail: string | null;
  considered_document_ids: string[];
  relationship_summary: string[];
};

export type ResolvedDocumentPrecedenceFamily = {
  family: GoverningDocumentFamily;
  label: string;
  governing_document_id: string | null;
  governing_reason: DocumentPrecedenceReason | null;
  governing_reason_detail: string | null;
  has_operator_override: boolean;
  considered_document_ids: string[];
  documents: ResolvedDocumentPrecedenceRecord[];
};

type EnrichedDocument = DocumentPrecedenceRecord & {
  family: GoverningDocumentFamily;
  resolved_role: DocumentRole;
  authority_tier: number;
  role_priority: number;
  effective_timestamp: number | null;
  created_timestamp: number;
};

type RelationshipStats = {
  incoming_weight: number;
  outgoing_weight: number;
  outgoing_supersedes: number;
  outgoing_amends: number;
};

const FAMILY_LABELS: Record<GoverningDocumentFamily, string> = {
  contract: 'Contract',
  rate_sheet: 'Rate Sheet',
  permit: 'Permit',
  invoice: 'Invoice',
  ticket_support: 'Ticket Support',
};

const PRECEDENCE_RELATIONSHIP_WEIGHTS: Partial<Record<DocumentRelationshipType, number>> = {
  supersedes: 4,
  replaces: 4,
  amends: 3,
};

function normalizeText(value: string | null | undefined): string {
  return (value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ');
}

function normalizeRole(value: string | null | undefined): DocumentRole | null {
  return DOCUMENT_ROLE_VALUES.includes(value as DocumentRole)
    ? (value as DocumentRole)
    : null;
}

function normalizeAuthorityStatus(value: string | null | undefined): AuthorityStatus | null {
  return AUTHORITY_STATUS_VALUES.includes(value as AuthorityStatus)
    ? (value as AuthorityStatus)
    : null;
}

function normalizeRelationshipType(value: string | null | undefined): DocumentRelationshipType | null {
  return DOCUMENT_RELATIONSHIP_TYPES.includes(value as DocumentRelationshipType)
    ? (value as DocumentRelationshipType)
    : null;
}

function parseTimestamp(value: string | null | undefined): number | null {
  if (!value) return null;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

function authorityTier(status: AuthorityStatus | null): number {
  switch (status) {
    case 'draft':
    case 'reference_only':
      return 1;
    case 'superseded':
      return 2;
    case 'archived':
      return 3;
    case 'active':
    default:
      return 0;
  }
}

function inferFamilyFromRole(role: DocumentRole | null): GoverningDocumentFamily | null {
  switch (role) {
    case 'base_contract':
    case 'contract_amendment':
      return 'contract';
    case 'rate_sheet':
      return 'rate_sheet';
    case 'permit':
      return 'permit';
    case 'invoice':
    case 'invoice_revision':
      return 'invoice';
    case 'ticket_export':
      return 'ticket_support';
    default:
      return null;
  }
}

export function inferGoverningDocumentFamily(
  document: Pick<DocumentPrecedenceRecord, 'document_role' | 'document_type' | 'title' | 'name'>,
): GoverningDocumentFamily | null {
  const explicitRole = normalizeRole(document.document_role ?? null);
  const familyFromRole = inferFamilyFromRole(explicitRole);
  if (familyFromRole) return familyFromRole;

  const documentType = normalizeText(document.document_type);
  const combinedText = normalizeText(`${document.title ?? ''} ${document.name}`);

  if (
    documentType === 'contract' ||
    documentType === 'williamson contract' ||
    combinedText.includes('contract amendment') ||
    combinedText.includes('amendment') ||
    combinedText.includes('addendum')
  ) {
    return 'contract';
  }

  if (
    documentType === 'spreadsheet' ||
    combinedText.includes('rate sheet') ||
    combinedText.includes('rate schedule') ||
    combinedText.includes('pricing schedule') ||
    combinedText.includes('schedule of values') ||
    combinedText.includes('sov ')
  ) {
    return 'rate_sheet';
  }

  if (
    documentType === 'permit' ||
    combinedText.includes('permit') ||
    combinedText.includes('tdec')
  ) {
    return 'permit';
  }

  if (
    documentType === 'invoice' ||
    combinedText.includes('invoice revision') ||
    combinedText.includes('revised invoice') ||
    combinedText.includes('invoice')
  ) {
    return 'invoice';
  }

  if (
    documentType === 'ticket' ||
    documentType === 'debris ticket' ||
    combinedText.includes('ticket export') ||
    combinedText.includes('ticket')
  ) {
    return 'ticket_support';
  }

  return null;
}

function inferDocumentRole(
  document: Pick<DocumentPrecedenceRecord, 'document_role' | 'document_type' | 'title' | 'name'>,
  family: GoverningDocumentFamily,
): DocumentRole {
  const explicitRole = normalizeRole(document.document_role ?? null);
  if (explicitRole) return explicitRole;

  const documentType = normalizeText(document.document_type);
  const combinedText = normalizeText(`${document.title ?? ''} ${document.name}`);

  switch (family) {
    case 'contract':
      if (
        combinedText.includes('amendment') ||
        combinedText.includes('addendum') ||
        combinedText.includes('change order') ||
        combinedText.includes('revision')
      ) {
        return 'contract_amendment';
      }
      return 'base_contract';
    case 'rate_sheet':
      return 'rate_sheet';
    case 'permit':
      return 'permit';
    case 'invoice':
      if (
        combinedText.includes('revision') ||
        combinedText.includes('revised') ||
        combinedText.includes('corrected') ||
        combinedText.includes('supplement')
      ) {
        return 'invoice_revision';
      }
      return 'invoice';
    case 'ticket_support':
      if (
        documentType === 'ticket' ||
        documentType === 'debris ticket' ||
        combinedText.includes('export')
      ) {
        return 'ticket_export';
      }
      return 'supporting_attachment';
    default:
      return 'other';
  }
}

function rolePriority(family: GoverningDocumentFamily, role: DocumentRole): number {
  switch (family) {
    case 'contract':
      if (role === 'contract_amendment') return 0;
      if (role === 'base_contract') return 1;
      if (role === 'supporting_attachment') return 2;
      return 3;
    case 'invoice':
      if (role === 'invoice_revision') return 0;
      if (role === 'invoice') return 1;
      if (role === 'supporting_attachment') return 2;
      return 3;
    case 'ticket_support':
      if (role === 'ticket_export') return 0;
      if (role === 'supporting_attachment') return 1;
      return 2;
    case 'rate_sheet':
      if (role === 'rate_sheet') return 0;
      if (role === 'supporting_attachment') return 1;
      return 2;
    case 'permit':
      if (role === 'permit') return 0;
      if (role === 'supporting_attachment') return 1;
      return 2;
    default:
      return 9;
  }
}

function compareStrings(left: string, right: string): number {
  return left.localeCompare(right, 'en-US');
}

function compareNullableNumbers(left: number | null, right: number | null, descending = false): number {
  if (left == null && right == null) return 0;
  if (left == null) return 1;
  if (right == null) return -1;
  return descending ? right - left : left - right;
}

function buildRelationshipStats(
  documents: EnrichedDocument[],
  relationships: DocumentRelationshipRecord[],
): Map<string, RelationshipStats> {
  const documentIds = new Set(documents.map((document) => document.id));
  const stats = new Map<string, RelationshipStats>();

  for (const document of documents) {
    stats.set(document.id, {
      incoming_weight: 0,
      outgoing_weight: 0,
      outgoing_supersedes: 0,
      outgoing_amends: 0,
    });
  }

  for (const relationship of relationships) {
    const type = normalizeRelationshipType(relationship.relationship_type);
    const weight = type ? PRECEDENCE_RELATIONSHIP_WEIGHTS[type] ?? 0 : 0;
    if (!weight) continue;
    if (!documentIds.has(relationship.source_document_id) || !documentIds.has(relationship.target_document_id)) {
      continue;
    }

    const sourceStats = stats.get(relationship.source_document_id);
    const targetStats = stats.get(relationship.target_document_id);
    if (!sourceStats || !targetStats) continue;

    sourceStats.outgoing_weight += weight;
    targetStats.incoming_weight += weight;

    if (type === 'supersedes' || type === 'replaces') {
      sourceStats.outgoing_supersedes += 1;
    }
    if (type === 'amends') {
      sourceStats.outgoing_amends += 1;
    }
  }

  return stats;
}

function relationshipSummary(
  document: EnrichedDocument,
  documentsById: Map<string, EnrichedDocument>,
  relationships: DocumentRelationshipRecord[],
): string[] {
  const summary: string[] = [];

  for (const relationship of relationships) {
    const type = normalizeRelationshipType(relationship.relationship_type);
    if (!type) continue;

    if (relationship.source_document_id === document.id) {
      const target = documentsById.get(relationship.target_document_id);
      if (!target) continue;
      summary.push(`${type.replace(/_/g, ' ')} ${target.title ?? target.name}`);
    }

    if (relationship.target_document_id === document.id) {
      const source = documentsById.get(relationship.source_document_id);
      if (!source) continue;
      summary.push(`${source.title ?? source.name} ${type.replace(/_/g, ' ')} this document`);
    }
  }

  return summary.slice(0, 3);
}

function determineReason(params: {
  winner: EnrichedDocument;
  sortedDocuments: EnrichedDocument[];
  relationshipStats: Map<string, RelationshipStats>;
  family: GoverningDocumentFamily;
  hasOperatorOverride: boolean;
}): DocumentPrecedenceReason {
  const { winner, sortedDocuments, relationshipStats, hasOperatorOverride } = params;
  if (hasOperatorOverride && winner.operator_override_precedence) {
    return 'operator_override';
  }

  const stats = relationshipStats.get(winner.id);
  if ((stats?.outgoing_supersedes ?? 0) > 0) {
    return 'supersedes_relationship';
  }
  if ((stats?.outgoing_amends ?? 0) > 0) {
    return 'amends_relationship';
  }

  const comparableDocuments = sortedDocuments.filter(
    (document) =>
      document.id !== winner.id &&
      document.authority_tier === winner.authority_tier,
  );
  const comparisonDocument = comparableDocuments[0] ?? null;

  if (!comparisonDocument) {
    if (winner.effective_timestamp != null) return 'effective_date';
    if (winner.resolved_role !== 'other') return 'role_priority';
    return 'upload_recency_fallback';
  }

  if (winner.role_priority !== comparisonDocument.role_priority) {
    return 'role_priority';
  }

  if (
    winner.effective_timestamp != null &&
    winner.effective_timestamp !== comparisonDocument.effective_timestamp
  ) {
    return 'effective_date';
  }

  return 'upload_recency_fallback';
}

function buildReasonDetail(params: {
  family: GoverningDocumentFamily;
  winner: EnrichedDocument;
  reason: DocumentPrecedenceReason;
  sortedDocuments: EnrichedDocument[];
  relationshipStats: Map<string, RelationshipStats>;
}): string {
  const { family, winner, reason, sortedDocuments, relationshipStats } = params;
  const familyLabel = FAMILY_LABELS[family].toLowerCase();
  const authorityNote = sortedDocuments.some(
    (document) =>
      document.id !== winner.id &&
      document.authority_tier > winner.authority_tier,
  )
    ? ' Lower-authority records marked draft, superseded, reference-only, or archived were deprioritized.'
    : '';

  switch (reason) {
    case 'operator_override':
      return `Selected by operator override for the ${familyLabel} family.` + authorityNote;
    case 'supersedes_relationship': {
      const count = relationshipStats.get(winner.id)?.outgoing_supersedes ?? 0;
      return `Selected because it explicitly supersedes ${count} ${familyLabel} document${count === 1 ? '' : 's'}.` + authorityNote;
    }
    case 'amends_relationship': {
      const count = relationshipStats.get(winner.id)?.outgoing_amends ?? 0;
      return `Selected because it explicitly amends ${count} ${familyLabel} document${count === 1 ? '' : 's'}.` + authorityNote;
    }
    case 'role_priority':
      return `Selected because its ${familyLabel} role outranks the other candidate documents.` + authorityNote;
    case 'effective_date':
      return `Selected because it has the strongest effective date among the active ${familyLabel} candidates.` + authorityNote;
    case 'upload_recency_fallback':
    default:
      return `Selected by upload recency fallback after override, relationship, role, and effective-date checks.` + authorityNote;
  }
}

export function resolveDocumentPrecedence(params: {
  documents: DocumentPrecedenceRecord[];
  relationships?: DocumentRelationshipRecord[];
}): ResolvedDocumentPrecedenceFamily[] {
  const { documents, relationships = [] } = params;
  const documentsById = new Map<string, EnrichedDocument>();
  const familyBuckets = new Map<GoverningDocumentFamily, EnrichedDocument[]>();

  for (const document of documents) {
    const family = inferGoverningDocumentFamily(document);
    if (!family) continue;

    const resolvedRole = inferDocumentRole(document, family);
    const normalizedAuthorityStatus = normalizeAuthorityStatus(document.authority_status ?? null);
    const enriched: EnrichedDocument = {
      ...document,
      family,
      resolved_role: resolvedRole,
      authority_tier: authorityTier(normalizedAuthorityStatus),
      role_priority: rolePriority(family, resolvedRole),
      effective_timestamp: parseTimestamp(document.effective_date ?? null),
      created_timestamp: parseTimestamp(document.created_at) ?? 0,
    };

    documentsById.set(document.id, enriched);
    const existing = familyBuckets.get(family) ?? [];
    existing.push(enriched);
    familyBuckets.set(family, existing);
  }

  return GOVERNING_DOCUMENT_FAMILIES.flatMap((family) => {
    const familyDocuments = familyBuckets.get(family) ?? [];
    if (familyDocuments.length === 0) return [];

    const familyRelationships = relationships.filter((relationship) => {
      if (relationship.project_id == null) return false;
      if (relationship.project_id !== familyDocuments[0]?.project_id) return false;
      return documentsById.has(relationship.source_document_id) && documentsById.has(relationship.target_document_id);
    });
    const relationshipStats = buildRelationshipStats(familyDocuments, familyRelationships);
    const hasOperatorOverride = familyDocuments.some((document) => document.operator_override_precedence);

    const sortedDocuments = [...familyDocuments].sort((left, right) => {
      if (hasOperatorOverride) {
        const leftOverride = Boolean(left.operator_override_precedence);
        const rightOverride = Boolean(right.operator_override_precedence);
        if (leftOverride !== rightOverride) return leftOverride ? -1 : 1;
        if (leftOverride && rightOverride) {
          const manualRankCompare = compareNullableNumbers(
            left.precedence_rank ?? null,
            right.precedence_rank ?? null,
          );
          if (manualRankCompare !== 0) return manualRankCompare;
        }
      }

      if (left.authority_tier !== right.authority_tier) {
        return left.authority_tier - right.authority_tier;
      }

      const leftRelationshipStats = relationshipStats.get(left.id);
      const rightRelationshipStats = relationshipStats.get(right.id);
      const incomingCompare = compareNullableNumbers(
        leftRelationshipStats?.incoming_weight ?? 0,
        rightRelationshipStats?.incoming_weight ?? 0,
      );
      if (incomingCompare !== 0) return incomingCompare;

      const outgoingCompare = compareNullableNumbers(
        leftRelationshipStats?.outgoing_weight ?? 0,
        rightRelationshipStats?.outgoing_weight ?? 0,
        true,
      );
      if (outgoingCompare !== 0) return outgoingCompare;

      if (left.role_priority !== right.role_priority) {
        return left.role_priority - right.role_priority;
      }

      const effectiveCompare = compareNullableNumbers(
        left.effective_timestamp,
        right.effective_timestamp,
        true,
      );
      if (effectiveCompare !== 0) return effectiveCompare;

      if (left.created_timestamp !== right.created_timestamp) {
        return right.created_timestamp - left.created_timestamp;
      }

      const titleCompare = compareStrings(left.title ?? left.name, right.title ?? right.name);
      if (titleCompare !== 0) return titleCompare;

      return compareStrings(left.id, right.id);
    });

    const winner = sortedDocuments[0] ?? null;
    const governingReason = winner
      ? determineReason({
          winner,
          sortedDocuments,
          relationshipStats,
          family,
          hasOperatorOverride,
        })
      : null;
    const governingReasonDetail = winner && governingReason
      ? buildReasonDetail({
          family,
          winner,
          reason: governingReason,
          sortedDocuments,
          relationshipStats,
        })
      : null;
    const governingDocumentId = winner?.id ?? null;
    const consideredDocumentIds = sortedDocuments.map((document) => document.id);

    return [{
      family,
      label: FAMILY_LABELS[family],
      governing_document_id: governingDocumentId,
      governing_reason: governingReason,
      governing_reason_detail: governingReasonDetail,
      has_operator_override: hasOperatorOverride,
      considered_document_ids: consideredDocumentIds,
      documents: sortedDocuments.map((document, index) => ({
        ...document,
        resolved_order: index,
        is_governing: document.id === governingDocumentId,
        governing_document_id: governingDocumentId,
        governing_reason: governingReason,
        governing_reason_detail: governingReasonDetail,
        considered_document_ids: consideredDocumentIds,
        relationship_summary: relationshipSummary(document, documentsById, familyRelationships),
      })),
    }];
  });
}
