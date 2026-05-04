'use client';

import type { Dispatch, SetStateAction } from 'react';
import { useEffect, useState } from 'react';
import type {
  CanonicalDocumentRelationshipType,
  DocumentPrecedenceRecord,
  DocumentRelationshipRecord,
  DocumentRelationshipType,
  GoverningDocumentFamily,
  ResolvedDocumentPrecedenceFamily,
  ResolvedDocumentPrecedenceRecord,
} from '@/lib/documentPrecedence';
import {
  canonicalizeRelationshipType,
  getDocumentRelationshipLabel,
} from '@/lib/documentPrecedence';
import { redirectIfUnauthorized } from '@/lib/redirectIfUnauthorized';
import { supabase } from '@/lib/supabaseClient';

type DocumentPrecedenceSectionProps = {
  projectId: string;
};

type RelationshipFormState = {
  sourceDocumentId: string;
  targetDocumentId: string;
  relationshipType: CanonicalDocumentRelationshipType;
};

type SupportRelationshipFormState = {
  sourceDocumentId: string;
  targetDocumentId: string;
  relationshipType: Extract<DocumentRelationshipType, 'attached_to' | 'supplements'>;
};

type PrecedenceResponse = {
  ok?: boolean;
  error?: string;
  documents?: DocumentPrecedenceRecord[];
  relationships?: DocumentRelationshipRecord[];
  families?: ResolvedDocumentPrecedenceFamily[];
};

type RelationshipCandidate = DocumentPrecedenceRecord & {
  resolvedRecord: ResolvedDocumentPrecedenceRecord | null;
};

type RelationshipSuggestion = {
  sourceDocumentId: string;
  targetDocumentId: string;
  relationshipType: CanonicalDocumentRelationshipType;
  reason: string;
  needsReview: boolean;
};

type SavedRelationshipRow = {
  id: string;
  sourceDocumentId: string;
  targetDocumentId: string;
  relationshipType: CanonicalDocumentRelationshipType;
  summary: string;
};

type GovernanceRoleKey = 'contract' | 'invoice' | 'transaction_data' | 'support';

const RELATIONSHIP_OPTIONS: Array<{
  value: CanonicalDocumentRelationshipType;
  label: string;
}> = [
  { value: 'attached_to', label: 'Attached To' },
  { value: 'supplements', label: 'Adds Requirements' },
  { value: 'amends', label: 'Modifies Contract' },
  { value: 'supersedes', label: 'Replaces Contract' },
];

const SUPPORT_RELATIONSHIP_OPTIONS: Array<{
  value: Extract<DocumentRelationshipType, 'attached_to' | 'supplements'>;
  label: string;
}> = [
  { value: 'attached_to', label: 'Attached To' },
  { value: 'supplements', label: 'Adds Requirements' },
];

const GOVERNANCE_ROLE_GROUPS: Array<{
  key: GovernanceRoleKey;
  label: string;
  description: string;
  families: GoverningDocumentFamily[];
}> = [
  {
    key: 'contract',
    label: 'Contract',
    description: 'Control the governing contract record and amendment order.',
    families: ['contract'],
  },
  {
    key: 'invoice',
    label: 'Invoice',
    description: 'Track billing sequence and revisions while preserving invoice precedence controls.',
    families: ['invoice'],
  },
  {
    key: 'transaction_data',
    label: 'Transaction Data',
    description: 'Keep rate-sheet and transaction datasets in the correct priority order.',
    families: ['rate_sheet'],
  },
  {
    key: 'support',
    label: 'Support',
    description: 'Maintain supporting and compliance records that influence project review.',
    families: ['permit', 'ticket_support'],
  },
];

function titleize(value: string | null | undefined): string {
  if (!value) return 'Unknown';
  return value
    .replace(/[_-]+/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function normalizeText(value: string | null | undefined): string {
  return (value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ');
}

function isInactiveAuthorityStatus(value: string | null | undefined): boolean {
  const normalized = normalizeText(value);
  return normalized === 'superseded' || normalized === 'archived';
}

function buildResolvedDocumentMap(
  families: readonly ResolvedDocumentPrecedenceFamily[],
): Map<string, ResolvedDocumentPrecedenceRecord> {
  const resolvedById = new Map<string, ResolvedDocumentPrecedenceRecord>();
  for (const family of families) {
    for (const document of family.documents) {
      resolvedById.set(document.id, document);
    }
  }
  return resolvedById;
}

function buildRelationshipCandidates(
  documents: readonly DocumentPrecedenceRecord[],
  resolvedById: ReadonlyMap<string, ResolvedDocumentPrecedenceRecord>,
): RelationshipCandidate[] {
  return documents.map((document) => ({
    ...document,
    resolvedRecord: resolvedById.get(document.id) ?? null,
  }));
}

function relationshipCandidateLabel(candidate: RelationshipCandidate): string {
  const meta = candidate.resolvedRecord?.family
    ? titleize(candidate.resolvedRecord.family)
    : candidate.document_type
      ? titleize(candidate.document_type)
      : candidate.document_subtype
        ? titleize(candidate.document_subtype)
        : null;

  return meta ? `${documentLabel(candidate)} (${meta})` : documentLabel(candidate);
}

function classifyContractRelationshipSuggestion(
  candidate: RelationshipCandidate,
): CanonicalDocumentRelationshipType | null {
  const normalizedType = normalizeText(candidate.document_type);
  const normalizedSubtype = normalizeText(candidate.document_subtype);
  const normalizedResolvedSubtype = normalizeText(candidate.resolvedRecord?.resolved_subtype);
  const normalizedRole = normalizeText(candidate.document_role);
  const normalizedResolvedFamily = normalizeText(candidate.resolvedRecord?.family);
  const combinedText = normalizeText(`${candidate.title ?? ''} ${candidate.name}`);
  const isSupportFlowDocument =
    normalizedResolvedFamily === 'permit'
    || normalizedResolvedFamily === 'ticket support'
    || normalizedRole === 'ticket export'
    || normalizedRole === 'supporting attachment';

  if (
    normalizedSubtype === 'replacement contract'
    || normalizedResolvedSubtype === 'replacement contract'
  ) {
    return 'supersedes';
  }

  if (
    normalizedSubtype === 'amendment'
    || normalizedResolvedSubtype === 'amendment'
    || combinedText.includes('amendment')
  ) {
    return 'amends';
  }

  if (
    normalizedSubtype === 'pricing schedule'
    || normalizedResolvedSubtype === 'pricing schedule'
    || combinedText.includes('exhibit')
    || combinedText.includes('pricing schedule')
    || combinedText.includes('rate schedule')
  ) {
    return 'attached_to';
  }

  if (
    normalizedSubtype === 'compliance requirements'
    || normalizedResolvedSubtype === 'compliance requirements'
    || normalizedSubtype === 'requirements doc'
  ) {
    return 'supplements';
  }

  if (isSupportFlowDocument) return null;

  if (
    normalizedType === 'specification'
    || normalizedType === 'policy'
    || normalizedType === 'procedure'
    || normalizedType === 'report'
    || normalizedType === 'compliance'
  ) {
    return 'supplements';
  }

  return null;
}

function relationshipSuggestionReason(relationshipType: CanonicalDocumentRelationshipType): string {
  switch (relationshipType) {
    case 'attached_to':
      return 'Exhibit-style and pricing schedule documents usually attach to the governing base contract.';
    case 'supplements':
      return 'Requirement-style documents usually add requirements to the governing base contract.';
    case 'amends':
      return 'Amendment documents usually modify the governing base contract without replacing it.';
    case 'supersedes':
      return 'Replacement contracts usually replace the prior governing contract.';
    default:
      return 'Review and confirm this relationship before saving it.';
  }
}

function buildContractRelationshipSuggestions(params: {
  candidates: readonly RelationshipCandidate[];
  relationships: readonly DocumentRelationshipRecord[];
  contractFamily: ResolvedDocumentPrecedenceFamily | null;
}): RelationshipSuggestion[] {
  const { candidates, relationships, contractFamily } = params;
  if (!contractFamily) return [];

  const baseContractCandidates = contractFamily.documents.filter(
    (document) =>
      document.resolved_subtype === 'base_contract'
      && !isInactiveAuthorityStatus(document.authority_status),
  );
  const governingBaseContract = baseContractCandidates.find(
    (document) => document.is_governing,
  ) ?? null;
  const hasSingleBaseContract = governingBaseContract != null && baseContractCandidates.length === 1;
  const linkedDocumentIds = new Set<string>();

  for (const relationship of relationships) {
    linkedDocumentIds.add(relationship.source_document_id);
    linkedDocumentIds.add(relationship.target_document_id);
  }

  const suggestions: RelationshipSuggestion[] = [];
  for (const candidate of candidates) {
    if (linkedDocumentIds.has(candidate.id)) continue;

    const relationshipType = classifyContractRelationshipSuggestion(candidate);
    if (!relationshipType) continue;

    if (hasSingleBaseContract && governingBaseContract) {
      if (candidate.id === governingBaseContract.id) continue;
      suggestions.push({
        sourceDocumentId: candidate.id,
        targetDocumentId: governingBaseContract.id,
        relationshipType,
        reason: relationshipSuggestionReason(relationshipType),
        needsReview: false,
      });
      continue;
    }

    if (baseContractCandidates.length > 1) {
      suggestions.push({
        sourceDocumentId: candidate.id,
        targetDocumentId: '',
        relationshipType,
        reason: 'Multiple possible base contracts exist, so this document needs relationship review before linking.',
        needsReview: true,
      });
    }
  }

  return suggestions;
}

function reasonLabel(family: ResolvedDocumentPrecedenceFamily): string {
  switch (family.governing_reason) {
    case 'operator_override':
      return 'Operator Override';
    case 'supersedes_relationship':
      return 'Replaces Contract';
    case 'amends_relationship':
      return 'Modifies Contract';
    case 'role_priority':
      return 'Role Priority';
    case 'effective_date':
      return 'Effective Date';
    case 'upload_recency_fallback':
      return 'Upload Fallback';
    default:
      return 'Automatic';
  }
}

function badgeClass(active: boolean): string {
  return active
    ? 'border border-[#3B82F6]/30 bg-[#3B82F6]/10 text-[#3B82F6]'
    : 'border border-[#2F3B52] bg-[#1A2333] text-[#94A3B8]';
}

function defaultRelationshipForm(
  family: ResolvedDocumentPrecedenceFamily,
): RelationshipFormState {
  return {
    sourceDocumentId: family.documents[0]?.id ?? '',
    targetDocumentId: family.documents[1]?.id ?? family.documents[0]?.id ?? '',
    relationshipType: 'amends',
  };
}

function defaultSupportRelationshipForm(
  families: readonly ResolvedDocumentPrecedenceFamily[],
): SupportRelationshipFormState {
  const supportSourceDocuments = families
    .filter((family) =>
      family.family === 'rate_sheet'
      || family.family === 'permit'
      || family.family === 'ticket_support',
    )
    .flatMap((family) => family.documents);
  const supportTargetDocuments = families
    .filter((family) => family.family === 'contract' || family.family === 'invoice')
    .flatMap((family) => family.documents);

  return {
    sourceDocumentId: supportSourceDocuments[0]?.id ?? '',
    targetDocumentId: supportTargetDocuments[0]?.id ?? '',
    relationshipType: 'attached_to',
  };
}

function documentLabel(document: { title: string | null; name: string }): string {
  return document.title ?? document.name;
}

function buildSavedRelationshipRows(params: {
  documents: readonly DocumentPrecedenceRecord[];
  relationships: readonly DocumentRelationshipRecord[];
  include: (
    relationship: DocumentRelationshipRecord,
    relationshipType: CanonicalDocumentRelationshipType,
  ) => boolean;
}): SavedRelationshipRow[] {
  const documentsById = new Map(
    params.documents.map((document) => [document.id, document] as const),
  );

  return params.relationships.flatMap((relationship) => {
    if (!relationship.id) return [];

    const relationshipType = canonicalizeRelationshipType(relationship.relationship_type);
    if (!relationshipType || !params.include(relationship, relationshipType)) return [];

    const sourceDocument = documentsById.get(relationship.source_document_id);
    const targetDocument = documentsById.get(relationship.target_document_id);
    if (!sourceDocument || !targetDocument) return [];

    return [{
      id: relationship.id,
      sourceDocumentId: relationship.source_document_id,
      targetDocumentId: relationship.target_document_id,
      relationshipType,
      summary: `${documentLabel(sourceDocument)} ${(getDocumentRelationshipLabel(relationshipType) ?? titleize(relationshipType))} ${documentLabel(targetDocument)}`,
    }];
  });
}

function buildFamilyRelationshipRows(params: {
  family: ResolvedDocumentPrecedenceFamily;
  documents: readonly DocumentPrecedenceRecord[];
  relationships: readonly DocumentRelationshipRecord[];
}): SavedRelationshipRow[] {
  const familyDocumentIds = new Set(params.family.documents.map((document) => document.id));
  const allowedRelationshipTypes = new Set<CanonicalDocumentRelationshipType>(
    params.family.family === 'contract'
      ? ['attached_to', 'supplements', 'amends', 'supersedes']
      : ['amends', 'supersedes'],
  );

  return buildSavedRelationshipRows({
    documents: params.documents,
    relationships: params.relationships,
    include: (relationship, relationshipType) =>
      allowedRelationshipTypes.has(relationshipType)
      && (
        familyDocumentIds.has(relationship.source_document_id)
        || familyDocumentIds.has(relationship.target_document_id)
      ),
  });
}

function buildSupportRelationshipRows(params: {
  documents: readonly DocumentPrecedenceRecord[];
  relationships: readonly DocumentRelationshipRecord[];
}): SavedRelationshipRow[] {
  return buildSavedRelationshipRows({
    documents: params.documents,
    relationships: params.relationships,
    include: (_relationship, relationshipType) =>
      relationshipType === 'attached_to' || relationshipType === 'supplements',
  });
}

function formatRelationshipSummary(summary: string): string {
  return summary
    .replace(/\battached to\b/gi, 'Attached To')
    .replace(/\bsupplements\b/gi, 'Adds Requirements')
    .replace(/\bamends\b/gi, 'Modifies Contract')
    .replace(/\bsupersedes\b/gi, 'Replaces Contract');
}

function createdAtTimestamp(value: string | null | undefined): number {
  if (!value) return 0;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function uploadOrderLabel(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function invoiceRelationshipLabel(
  document: ResolvedDocumentPrecedenceFamily['documents'][number],
  familyDocuments: ResolvedDocumentPrecedenceFamily['documents'],
): 'Original' | 'Revision' | 'Subsequent' | null {
  const relationshipSummary = document.relationship_summary.map((summary) => summary.toLowerCase());
  if (
    document.resolved_role === 'invoice_revision' ||
    relationshipSummary.some((summary) => summary.startsWith('supersedes ') || summary.startsWith('amends '))
  ) {
    return 'Revision';
  }

  if (
    relationshipSummary.some((summary) => summary.includes('supersedes this document') || summary.includes('amends this document'))
  ) {
    return 'Original';
  }

  const sequencedInvoices = [...familyDocuments]
    .filter((candidate) => candidate.resolved_role === 'invoice')
    .sort((left, right) => createdAtTimestamp(left.created_at) - createdAtTimestamp(right.created_at));

  if (document.resolved_role !== 'invoice' || sequencedInvoices.length <= 1) {
    return null;
  }

  return sequencedInvoices[0]?.id === document.id ? 'Original' : 'Subsequent';
}

function GovernanceFamilyCard({
  family,
  saving,
  mutate,
}: {
  family: ResolvedDocumentPrecedenceFamily;
  saving: boolean;
  mutate: (payload: Record<string, unknown>, successMessage: string) => Promise<void>;
}) {
  const isInvoiceFamily = family.family === 'invoice';
  const governingDocument =
    family.documents.find((document) => document.is_governing) ?? null;
  const displayedDocuments = isInvoiceFamily
    ? [...family.documents].sort(
        (left, right) => createdAtTimestamp(right.created_at) - createdAtTimestamp(left.created_at),
      )
    : family.documents;

  return (
    <div className="rounded-sm border border-[#2F3B52]/70 bg-[#111827] p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-bold text-[#E5EDF7]">
              {family.label}
            </h3>
            <span className={`rounded-sm px-2 py-1 text-[10px] font-bold uppercase tracking-[0.14em] ${badgeClass(family.has_operator_override)}`}>
              {reasonLabel(family)}
            </span>
          </div>
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#94A3B8]">
              {isInvoiceFamily ? 'Current Active Invoice' : 'Current Governing Document'}
            </p>
            <p className="mt-1 text-sm text-[#E5EDF7]">
              {governingDocument
                ? documentLabel(governingDocument)
                : `No ${family.label.toLowerCase()} governing document selected yet.`}
            </p>
          </div>
          {isInvoiceFamily ? (
            <p className="text-[11px] text-[#94A3B8]">
              Track original billings, revisions, and subsequent invoice files here. Rows are shown newest upload first while governing controls still manage invoice precedence when files overlap.
            </p>
          ) : null}
          <p className="text-[11px] text-[#94A3B8]">
            {family.governing_reason_detail ?? 'Automatic precedence is active for this family.'}
          </p>
        </div>
        <button
          type="button"
          disabled={saving}
          onClick={() => mutate(
            {
              action: 'revert_to_automatic',
              family: family.family,
            },
            `${family.label} precedence reverted to automatic ordering.`,
          )}
          className="rounded-sm border border-[#2F3B52] bg-[#1A2333] px-3 py-2 text-[10px] font-bold uppercase tracking-[0.14em] text-[#C7D2E3] transition-colors hover:bg-[#243044] disabled:cursor-default disabled:opacity-50"
        >
          Revert To Automatic
        </button>
      </div>

      <div className="mt-4">
        <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#94A3B8]">
          {isInvoiceFamily ? 'Invoice Sequence & Revisions' : 'Candidate Documents'}
        </p>
        <div className="mt-3 space-y-2">
          {displayedDocuments.map((document) => {
            const precedenceIndex = family.documents.findIndex((candidate) => candidate.id === document.id);
            const authorityStatus = titleize(document.authority_status ?? 'active');
            const roleLabel = titleize(document.resolved_role);
            const invoiceLabel = isInvoiceFamily
              ? invoiceRelationshipLabel(document, family.documents)
              : null;
            const uploadedLabel = isInvoiceFamily
              ? uploadOrderLabel(document.created_at)
              : null;

            return (
              <div
                key={document.id}
                className="rounded-sm border border-[#2F3B52]/70 bg-[#1A2333] p-3"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-sm font-medium text-[#E5EDF7]">
                        {documentLabel(document)}
                      </p>
                      {invoiceLabel ? (
                        <span className="rounded-sm border border-[#38BDF8]/30 bg-[#38BDF8]/10 px-2 py-1 text-[10px] font-bold uppercase tracking-[0.14em] text-[#38BDF8]">
                          {invoiceLabel}
                        </span>
                      ) : null}
                      {document.is_governing ? (
                        <span className="rounded-sm border border-[#22C55E]/30 bg-[#22C55E]/10 px-2 py-1 text-[10px] font-bold uppercase tracking-[0.14em] text-[#22C55E]">
                          Governing
                        </span>
                      ) : null}
                    </div>
                    <p className="mt-1 text-[10px] uppercase tracking-[0.14em] text-[#94A3B8]">
                      {roleLabel}
                      {document.document_type ? ` / ${titleize(document.document_type)}` : ''}
                      {document.effective_date ? ` / Effective ${document.effective_date}` : ''}
                      {uploadedLabel ? ` / Uploaded ${uploadedLabel}` : ''}
                      {authorityStatus ? ` / ${authorityStatus}` : ''}
                    </p>
                    {document.relationship_summary.length > 0 ? (
                      <p className="mt-2 text-[11px] text-[#94A3B8]">
                        {document.relationship_summary.map(formatRelationshipSummary).join(' / ')}
                      </p>
                    ) : null}
                  </div>

                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      disabled={saving || document.is_governing}
                      onClick={() => mutate(
                        {
                          action: 'set_governing',
                          family: family.family,
                          documentId: document.id,
                        },
                        `${documentLabel(document)} is now the governing ${family.label.toLowerCase()} document.`,
                      )}
                      className="rounded-sm border border-[#3B82F6]/30 bg-[#3B82F6]/10 px-3 py-2 text-[10px] font-bold uppercase tracking-[0.14em] text-[#3B82F6] transition-colors hover:bg-[#3B82F6]/20 disabled:cursor-default disabled:opacity-50"
                    >
                      {isInvoiceFamily ? 'Mark Active' : 'Set Governing'}
                    </button>
                    <button
                      type="button"
                      disabled={saving || precedenceIndex <= 0}
                      onClick={() => mutate(
                        {
                          action: 'move',
                          family: family.family,
                          documentId: document.id,
                          direction: 'up',
                        },
                        `${documentLabel(document)} moved up in ${family.label.toLowerCase()} precedence.`,
                      )}
                      className="rounded-sm border border-[#2F3B52] bg-[#1F2937] px-3 py-2 text-[10px] font-bold uppercase tracking-[0.14em] text-[#C7D2E3] transition-colors hover:bg-[#243044] disabled:cursor-default disabled:opacity-50"
                    >
                      Up
                    </button>
                    <button
                      type="button"
                      disabled={saving || precedenceIndex === family.documents.length - 1}
                      onClick={() => mutate(
                        {
                          action: 'move',
                          family: family.family,
                          documentId: document.id,
                          direction: 'down',
                        },
                        `${documentLabel(document)} moved down in ${family.label.toLowerCase()} precedence.`,
                      )}
                      className="rounded-sm border border-[#2F3B52] bg-[#1F2937] px-3 py-2 text-[10px] font-bold uppercase tracking-[0.14em] text-[#C7D2E3] transition-colors hover:bg-[#243044] disabled:cursor-default disabled:opacity-50"
                    >
                      Down
                    </button>
                    <button
                      type="button"
                      disabled={saving}
                      onClick={() => mutate(
                        {
                          action: 'set_authority_status',
                          documentId: document.id,
                          authorityStatus: document.authority_status === 'superseded' ? 'active' : 'superseded',
                        },
                        document.authority_status === 'superseded'
                          ? `${documentLabel(document)} restored to active authority status.`
                          : `${documentLabel(document)} marked as superseded.`,
                      )}
                      className="rounded-sm border border-[#2F3B52] bg-[#1F2937] px-3 py-2 text-[10px] font-bold uppercase tracking-[0.14em] text-[#C7D2E3] transition-colors hover:bg-[#243044] disabled:cursor-default disabled:opacity-50"
                    >
                      {document.authority_status === 'superseded' ? 'Mark Active' : 'Mark Superseded'}
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function RelationshipFamilyCard({
  family,
  candidateDocuments,
  existingRelationships,
  form,
  saving,
  suggestions,
  setRelationshipForms,
  mutate,
}: {
  family: ResolvedDocumentPrecedenceFamily;
  candidateDocuments: readonly RelationshipCandidate[];
  existingRelationships: readonly SavedRelationshipRow[];
  form: RelationshipFormState;
  saving: boolean;
  suggestions: readonly RelationshipSuggestion[];
  setRelationshipForms: Dispatch<
    SetStateAction<Partial<Record<GoverningDocumentFamily, RelationshipFormState>>>
  >;
  mutate: (payload: Record<string, unknown>, successMessage: string) => Promise<void>;
}) {
  const relationshipOptions =
    family.family === 'contract'
      ? RELATIONSHIP_OPTIONS
      : RELATIONSHIP_OPTIONS.filter(
          (option) => option.value === 'amends' || option.value === 'supersedes',
        );
  const selectedRelationshipType = relationshipOptions.some(
    (option) => option.value === form.relationshipType,
  )
    ? form.relationshipType
    : relationshipOptions[0]?.value ?? 'amends';
  const selectedSourceDocumentId = candidateDocuments.some(
    (document) => document.id === form.sourceDocumentId,
  )
    ? form.sourceDocumentId
    : candidateDocuments[0]?.id ?? '';
  const fallbackTargetDocumentId =
    candidateDocuments.find((document) => document.id !== selectedSourceDocumentId)?.id
    ?? candidateDocuments[0]?.id
    ?? '';
  const selectedTargetDocumentId = candidateDocuments.some(
    (document) => document.id === form.targetDocumentId,
  )
    ? form.targetDocumentId
    : fallbackTargetDocumentId;

  return (
    <div className="rounded-sm border border-[#2F3B52]/70 bg-[#111827] p-4">
      <div>
        <h3 className="text-sm font-bold text-[#E5EDF7]">
          {family.family === 'invoice' ? 'Invoice Relationships' : family.label}
        </h3>
        <p className="mt-2 text-[11px] text-[#94A3B8]">
          {family.family === 'invoice'
            ? 'Track invoice revisions and billing sequence across related invoice files.'
            : 'Preserve relationship links inside the same project document family without changing governing selection unless the link truly replaces the contract.'}
        </p>
      </div>

      <div className="mt-4 space-y-3">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#94A3B8]">
            {family.family === 'invoice' ? 'Invoice Relationships' : 'Existing Links'}
          </p>
          {existingRelationships.length === 0 ? (
            <p className="mt-2 text-sm text-[#94A3B8]">
              {family.family === 'invoice'
                ? 'No billing sequence or revision links have been recorded for this invoice set yet.'
                : 'No relationship links have been recorded for this role yet.'}
            </p>
          ) : (
            <div className="mt-2 space-y-2">
              {existingRelationships.map((relationship) => (
                <div
                  key={relationship.id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-sm border border-[#2F3B52]/70 bg-[#0F172A] px-3 py-2"
                >
                  <p className="text-[11px] text-[#C7D2E3]">
                    {relationship.summary}
                  </p>
                  <button
                    type="button"
                    disabled={saving}
                    onClick={() => mutate(
                      {
                        action: 'delete_relationship',
                        relationshipId: relationship.id,
                      },
                      `Removed ${(getDocumentRelationshipLabel(relationship.relationshipType) ?? relationship.relationshipType).toLowerCase()} relationship.`,
                    )}
                    className="rounded-sm border border-[#7F1D1D]/60 bg-[#450A0A]/30 px-2 py-1 text-[10px] font-bold uppercase tracking-[0.14em] text-[#FCA5A5] transition-colors hover:bg-[#5F1111]/40 disabled:cursor-default disabled:opacity-50"
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {suggestions.length > 0 ? (
          <div className="rounded-sm border border-[#2F3B52]/70 bg-[#111827] p-3">
            <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#94A3B8]">
              Suggested Links
            </p>
            <div className="mt-3 space-y-2">
              {suggestions.map((suggestion) => {
                const sourceDocument = candidateDocuments.find(
                  (document) => document.id === suggestion.sourceDocumentId,
                ) ?? null;
                const targetDocument = candidateDocuments.find(
                  (document) => document.id === suggestion.targetDocumentId,
                ) ?? null;
                const suggestionLabel = getDocumentRelationshipLabel(suggestion.relationshipType)
                  ?? suggestion.relationshipType;

                return (
                  <div
                    key={`${suggestion.sourceDocumentId}:${suggestion.relationshipType}:${suggestion.targetDocumentId || 'review'}`}
                    className="rounded-sm border border-[#2F3B52]/70 bg-[#0F172A] px-3 py-3"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="space-y-1">
                        <p className="text-sm text-[#E5EDF7]">
                          {sourceDocument ? relationshipCandidateLabel(sourceDocument) : 'Document'}
                          {' '}
                          {suggestion.needsReview
                            ? `may need "${suggestionLabel}" review`
                            : `${suggestionLabel} ${targetDocument ? relationshipCandidateLabel(targetDocument) : 'governing base contract'}`}
                        </p>
                        <p className="text-[11px] text-[#94A3B8]">
                          {suggestion.reason}
                        </p>
                      </div>
                      {suggestion.needsReview ? (
                        <span className="rounded-sm border border-[#F59E0B]/30 bg-[#F59E0B]/10 px-2 py-1 text-[10px] font-bold uppercase tracking-[0.14em] text-[#FBBF24]">
                          Needs Relationship Review
                        </span>
                      ) : (
                        <button
                          type="button"
                          disabled={saving || !sourceDocument || !targetDocument}
                          onClick={() => setRelationshipForms((current) => ({
                            ...current,
                            [family.family]: {
                              sourceDocumentId: suggestion.sourceDocumentId,
                              targetDocumentId: suggestion.targetDocumentId,
                              relationshipType: suggestion.relationshipType,
                            },
                          }))}
                          className="rounded-sm border border-[#3B82F6]/30 bg-[#3B82F6]/10 px-3 py-2 text-[10px] font-bold uppercase tracking-[0.14em] text-[#3B82F6] transition-colors hover:bg-[#3B82F6]/20 disabled:cursor-default disabled:opacity-50"
                        >
                          Use Suggestion
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ) : null}

        <div className="rounded-sm border border-[#2F3B52]/70 bg-[#0F172A] p-3">
          <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#94A3B8]">
            Link Relationship
          </p>
          <div className="mt-3 grid gap-3 md:grid-cols-[minmax(0,1fr)_180px_minmax(0,1fr)_auto]">
            <select
              value={selectedSourceDocumentId}
              onChange={(event) => setRelationshipForms((current) => ({
                ...current,
                [family.family]: {
                  ...form,
                  sourceDocumentId: event.target.value,
                },
              }))}
              className="rounded-sm border border-[#2F3B52] bg-[#111827] px-3 py-2 text-sm text-[#E5EDF7] outline-none"
            >
              {candidateDocuments.map((document) => (
                <option key={document.id} value={document.id}>
                  {relationshipCandidateLabel(document)}
                </option>
              ))}
            </select>
            <select
              value={selectedRelationshipType}
              onChange={(event) => setRelationshipForms((current) => ({
                ...current,
                [family.family]: {
                  ...form,
                  relationshipType: event.target.value as RelationshipFormState['relationshipType'],
                },
              }))}
              className="rounded-sm border border-[#2F3B52] bg-[#111827] px-3 py-2 text-sm text-[#E5EDF7] outline-none"
            >
              {relationshipOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <select
              value={selectedTargetDocumentId}
              onChange={(event) => setRelationshipForms((current) => ({
                ...current,
                [family.family]: {
                  ...form,
                  targetDocumentId: event.target.value,
                },
              }))}
              className="rounded-sm border border-[#2F3B52] bg-[#111827] px-3 py-2 text-sm text-[#E5EDF7] outline-none"
            >
              {candidateDocuments.map((document) => (
                <option key={document.id} value={document.id}>
                  {relationshipCandidateLabel(document)}
                </option>
              ))}
            </select>
            <button
              type="button"
              disabled={
                saving
                || !selectedSourceDocumentId
                || !selectedTargetDocumentId
                || selectedSourceDocumentId === selectedTargetDocumentId
              }
              onClick={() => mutate(
                {
                  action: 'link_relationship',
                  sourceDocumentId: selectedSourceDocumentId,
                  targetDocumentId: selectedTargetDocumentId,
                  relationshipType: selectedRelationshipType,
                },
                `Recorded ${(getDocumentRelationshipLabel(selectedRelationshipType) ?? selectedRelationshipType).toLowerCase()} relationship for ${family.label.toLowerCase()} documents.`,
              )}
              className="rounded-sm border border-[#3B82F6]/30 bg-[#3B82F6]/10 px-3 py-2 text-[10px] font-bold uppercase tracking-[0.14em] text-[#3B82F6] transition-colors hover:bg-[#3B82F6]/20 disabled:cursor-default disabled:opacity-50"
            >
              Save Link
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function SupportRelationshipCard({
  allDocuments,
  allRelationships,
  families,
  form,
  saving,
  setSupportRelationshipForm,
  mutate,
}: {
  allDocuments: readonly DocumentPrecedenceRecord[];
  allRelationships: readonly DocumentRelationshipRecord[];
  families: readonly ResolvedDocumentPrecedenceFamily[];
  form: SupportRelationshipFormState;
  saving: boolean;
  setSupportRelationshipForm: Dispatch<SetStateAction<SupportRelationshipFormState>>;
  mutate: (payload: Record<string, unknown>, successMessage: string) => Promise<void>;
}) {
  const supportSourceFamilies = families.filter(
    (family) =>
      family.family === 'rate_sheet'
      || family.family === 'permit'
      || family.family === 'ticket_support',
  );
  const supportTargetFamilies = families.filter(
    (family) => family.family === 'contract' || family.family === 'invoice',
  );
  const supportSourceDocuments = supportSourceFamilies.flatMap((family) =>
    family.documents.map((document) => ({
      document,
      familyLabel: family.label,
    })),
  );
  const supportTargetDocuments = supportTargetFamilies.flatMap((family) =>
    family.documents.map((document) => ({
      document,
      familyLabel: family.label,
    })),
  );
  const existingRelationships = buildSupportRelationshipRows({
    documents: allDocuments,
    relationships: allRelationships,
  });

  return (
    <div className="rounded-sm border border-[#2F3B52]/70 bg-[#111827] p-4">
      <div>
        <h3 className="text-sm font-bold text-[#E5EDF7]">
          Support Attachments
        </h3>
        <p className="mt-2 text-[11px] text-[#94A3B8]">
          Attach exhibits, pricing schedules, permits, ticket exports, and support records to the active invoice or governing contract so downstream facts and validation can stop guessing.
        </p>
      </div>

      <div className="mt-4 space-y-3">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#94A3B8]">
            Existing Support Links
          </p>
          {existingRelationships.length === 0 ? (
            <p className="mt-2 text-sm text-[#94A3B8]">
              No support relationships have been recorded yet.
            </p>
          ) : (
            <div className="mt-2 space-y-2">
              {existingRelationships.map((relationship) => (
                <div
                  key={relationship.id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-sm border border-[#2F3B52]/70 bg-[#0F172A] px-3 py-2"
                >
                  <p className="text-[11px] text-[#C7D2E3]">
                    {relationship.summary}
                  </p>
                  <button
                    type="button"
                    disabled={saving}
                    onClick={() => mutate(
                      {
                        action: 'delete_relationship',
                        relationshipId: relationship.id,
                      },
                      `Removed ${(getDocumentRelationshipLabel(relationship.relationshipType) ?? relationship.relationshipType).toLowerCase()} relationship.`,
                    )}
                    className="rounded-sm border border-[#7F1D1D]/60 bg-[#450A0A]/30 px-2 py-1 text-[10px] font-bold uppercase tracking-[0.14em] text-[#FCA5A5] transition-colors hover:bg-[#5F1111]/40 disabled:cursor-default disabled:opacity-50"
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {supportSourceDocuments.length === 0 || supportTargetDocuments.length === 0 ? (
          <div className="rounded-sm border border-[#2F3B52]/70 bg-[#0F172A] px-3 py-3 text-sm text-[#94A3B8]">
            Add attachment/support documents and invoice or contract documents to this project before recording support links.
          </div>
        ) : (
          <div className="rounded-sm border border-[#2F3B52]/70 bg-[#0F172A] p-3">
            <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#94A3B8]">
              Attach Support
            </p>
            <div className="mt-3 grid gap-3 md:grid-cols-[minmax(0,1fr)_180px_minmax(0,1fr)_auto]">
              <select
                value={form.sourceDocumentId}
                onChange={(event) => setSupportRelationshipForm((current) => ({
                  ...current,
                  sourceDocumentId: event.target.value,
                }))}
                className="rounded-sm border border-[#2F3B52] bg-[#111827] px-3 py-2 text-sm text-[#E5EDF7] outline-none"
              >
                {supportSourceDocuments.map(({ document, familyLabel }) => (
                  <option key={document.id} value={document.id}>
                    {documentLabel(document)} ({familyLabel})
                  </option>
                ))}
              </select>
              <select
                value={form.relationshipType}
                onChange={(event) => setSupportRelationshipForm((current) => ({
                  ...current,
                  relationshipType: event.target.value as SupportRelationshipFormState['relationshipType'],
                }))}
                className="rounded-sm border border-[#2F3B52] bg-[#111827] px-3 py-2 text-sm text-[#E5EDF7] outline-none"
              >
                {SUPPORT_RELATIONSHIP_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              <select
                value={form.targetDocumentId}
                onChange={(event) => setSupportRelationshipForm((current) => ({
                  ...current,
                  targetDocumentId: event.target.value,
                }))}
                className="rounded-sm border border-[#2F3B52] bg-[#111827] px-3 py-2 text-sm text-[#E5EDF7] outline-none"
              >
                {supportTargetDocuments.map(({ document, familyLabel }) => (
                  <option key={document.id} value={document.id}>
                    {documentLabel(document)} ({familyLabel}{document.is_governing ? ', current' : ''})
                  </option>
                ))}
              </select>
              <button
                type="button"
                disabled={saving || !form.sourceDocumentId || !form.targetDocumentId || form.sourceDocumentId === form.targetDocumentId}
                onClick={() => mutate(
                  {
                    action: 'link_relationship',
                    sourceDocumentId: form.sourceDocumentId,
                    targetDocumentId: form.targetDocumentId,
                    relationshipType: form.relationshipType,
                  },
                  `Recorded ${(getDocumentRelationshipLabel(form.relationshipType) ?? form.relationshipType).toLowerCase()} link for canonical project truth.`,
                )}
                className="rounded-sm border border-[#3B82F6]/30 bg-[#3B82F6]/10 px-3 py-2 text-[10px] font-bold uppercase tracking-[0.14em] text-[#3B82F6] transition-colors hover:bg-[#3B82F6]/20 disabled:cursor-default disabled:opacity-50"
              >
                Save Link
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export function DocumentPrecedenceSection({
  projectId,
}: DocumentPrecedenceSectionProps) {
  const [families, setFamilies] = useState<ResolvedDocumentPrecedenceFamily[]>([]);
  const [allDocuments, setAllDocuments] = useState<DocumentPrecedenceRecord[]>([]);
  const [allRelationships, setAllRelationships] = useState<DocumentRelationshipRecord[]>([]);
  const [relationshipForms, setRelationshipForms] = useState<
    Partial<Record<GoverningDocumentFamily, RelationshipFormState>>
  >({});
  const [supportRelationshipForm, setSupportRelationshipForm] = useState<SupportRelationshipFormState>({
    sourceDocumentId: '',
    targetDocumentId: '',
    relationshipType: 'attached_to',
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);

      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session?.access_token) {
        if (!cancelled) {
          setError('You need to be signed in to manage governing documents.');
          setLoading(false);
        }
        return;
      }

      try {
        const response = await fetch(`/api/projects/${projectId}/document-precedence`, {
          headers: {
            Authorization: `Bearer ${session.access_token}`,
          },
        });

        if (redirectIfUnauthorized(response, () => {
          window.location.href = '/login';
        })) {
          return;
        }

        const body = await response.json().catch(() => ({})) as PrecedenceResponse;
        if (!response.ok) {
          throw new Error(body.error ?? 'Failed to load document precedence.');
        }

        if (!cancelled) {
          const nextFamilies = body.families ?? [];
          const nextDocuments = body.documents ?? [];
          const nextRelationships = body.relationships ?? [];
          setFamilies(nextFamilies);
          setAllDocuments(nextDocuments);
          setAllRelationships(nextRelationships);
          setRelationshipForms((current) => {
            const nextForms = { ...current };
            for (const family of nextFamilies) {
              if (!nextForms[family.family]) {
                nextForms[family.family] = defaultRelationshipForm(family);
              }
            }
            return nextForms;
          });
          setSupportRelationshipForm((current) => {
            const nextDefault = defaultSupportRelationshipForm(nextFamilies);
            return current.sourceDocumentId && current.targetDocumentId
              ? current
              : nextDefault;
          });
        }
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : 'Failed to load document precedence.');
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    load().catch(() => {
      if (!cancelled) {
        setError('Failed to load document precedence.');
        setLoading(false);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const mutate = async (payload: Record<string, unknown>, successMessage: string) => {
    setSaving(true);
    setError(null);
    setSuccess(null);

    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (!session?.access_token) {
      setSaving(false);
      setError('Your session has expired. Please sign in again.');
      return;
    }

    try {
      const response = await fetch(`/api/projects/${projectId}/document-precedence`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify(payload),
      });

      if (redirectIfUnauthorized(response, () => {
        window.location.href = '/login';
      })) {
        return;
      }

      const body = await response.json().catch(() => ({})) as PrecedenceResponse;
      if (!response.ok) {
        throw new Error(body.error ?? 'Failed to update document precedence.');
      }

      const nextFamilies = body.families ?? [];
      const nextDocuments = body.documents ?? [];
      const nextRelationships = body.relationships ?? [];
      setFamilies(nextFamilies);
      setAllDocuments(nextDocuments);
      setAllRelationships(nextRelationships);
      setSupportRelationshipForm((current) => {
        const nextDefault = defaultSupportRelationshipForm(nextFamilies);
        const sourceStillExists = nextFamilies.some((family) =>
          family.documents.some((document) => document.id === current.sourceDocumentId),
        );
        const targetStillExists = nextFamilies.some((family) =>
          family.documents.some((document) => document.id === current.targetDocumentId),
        );

        return sourceStillExists && targetStillExists ? current : nextDefault;
      });
      setSuccess(successMessage);
    } catch (mutationError) {
      setError(
        mutationError instanceof Error
          ? mutationError.message
          : 'Failed to update document precedence.',
      );
    } finally {
      setSaving(false);
    }
  };

  const governanceGroups = GOVERNANCE_ROLE_GROUPS.map((group) => ({
    ...group,
    resolvedFamilies: families.filter((family) => group.families.includes(family.family)),
  })).filter((group) => group.resolvedFamilies.length > 0);
  const resolvedById = buildResolvedDocumentMap(families);
  const relationshipCandidates = buildRelationshipCandidates(allDocuments, resolvedById);
  const contractFamily = families.find((family) => family.family === 'contract') ?? null;
  const contractRelationshipSuggestions = buildContractRelationshipSuggestions({
    candidates: relationshipCandidates,
    relationships: allRelationships,
    contractFamily,
  });
  const relationshipFamilies = families.filter((family) =>
    family.family === 'contract'
      ? family.documents.length > 0 && relationshipCandidates.length > 1
      : family.documents.length > 1,
  );

  if (loading) {
    return (
      <div className="rounded-sm border border-[#2F3B52]/70 bg-[#111827] p-4 text-sm text-[#94A3B8]">
        Loading document management controls...
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <section className="space-y-4">
        <div className="rounded-sm border border-[#2F3B52]/70 bg-[#111827] p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#94A3B8]">
                Document Roles & Governance
              </p>
              <p className="mt-2 text-sm text-[#C7D2E3]">
                Manage governing documents by role using the same precedence rules already applied across the project.
              </p>
            </div>
            {saving ? (
              <span className="text-[10px] uppercase tracking-[0.14em] text-[#38BDF8]">
                Saving...
              </span>
            ) : null}
          </div>

          {error ? (
            <div className="mt-4 rounded-sm border border-[#EF4444]/30 bg-[#EF4444]/10 px-3 py-2 text-[11px] text-[#FCA5A5]">
              {error}
            </div>
          ) : null}

          {success ? (
            <div className="mt-4 rounded-sm border border-[#22C55E]/30 bg-[#22C55E]/10 px-3 py-2 text-[11px] text-[#86EFAC]">
              {success}
            </div>
          ) : null}
        </div>

        {families.length === 0 ? (
          <div className="rounded-sm border border-[#2F3B52]/70 bg-[#111827] p-4 text-sm text-[#94A3B8]">
            Governing document controls will appear once the project has contracts, permits, invoices, rate sheets, or ticket-support records to compare.
          </div>
        ) : (
          governanceGroups.map((group) => (
            <div
              key={group.key}
              className="rounded-sm border border-[#2F3B52]/70 bg-[#0F172A] p-4"
            >
              <div>
                <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#94A3B8]">
                  {group.label}
                </p>
                <p className="mt-2 text-sm text-[#C7D2E3]">
                  {group.description}
                </p>
              </div>
              <div className="mt-4 space-y-4">
                {group.resolvedFamilies.map((family) => (
                  <GovernanceFamilyCard
                    key={family.family}
                    family={family}
                    saving={saving}
                    mutate={mutate}
                  />
                ))}
              </div>
            </div>
          ))
        )}
      </section>

      <section className="space-y-4">
        <div className="rounded-sm border border-[#2F3B52]/70 bg-[#111827] p-4">
          <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#94A3B8]">
            Document Relationships
          </p>
          <p className="mt-2 text-sm text-[#C7D2E3]">
            Preserve attachment, requirement, amendment, and replacement links in one dedicated place without duplicating the governing controls.
          </p>
        </div>

        {families.length === 0 ? (
          <div className="rounded-sm border border-[#2F3B52]/70 bg-[#111827] p-4 text-sm text-[#94A3B8]">
            Relationship controls will appear once there are comparable project documents to link.
          </div>
        ) : relationshipFamilies.length === 0 ? (
          <div className="rounded-sm border border-[#2F3B52]/70 bg-[#111827] p-4 text-sm text-[#94A3B8]">
            Add enough project documents to review relationships before recording links here.
          </div>
        ) : (
          relationshipFamilies.map((family) => (
            <RelationshipFamilyCard
              key={family.family}
              family={family}
              candidateDocuments={family.family === 'contract' ? relationshipCandidates : family.documents.map((document) => ({
                ...document,
                resolvedRecord: document,
              }))}
              existingRelationships={buildFamilyRelationshipRows({
                family,
                documents: allDocuments,
                relationships: allRelationships,
              })}
              form={relationshipForms[family.family] ?? defaultRelationshipForm(family)}
              saving={saving}
              suggestions={family.family === 'contract' ? contractRelationshipSuggestions : []}
              setRelationshipForms={setRelationshipForms}
              mutate={mutate}
            />
          ))
        )}

        <SupportRelationshipCard
          allDocuments={allDocuments}
          allRelationships={allRelationships}
          families={families}
          form={supportRelationshipForm}
          saving={saving}
          setSupportRelationshipForm={setSupportRelationshipForm}
          mutate={mutate}
        />
      </section>
    </div>
  );
}
