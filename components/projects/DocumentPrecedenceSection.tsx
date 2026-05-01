'use client';

import type { Dispatch, SetStateAction } from 'react';
import { useEffect, useState } from 'react';
import type {
  DocumentRelationshipType,
  GoverningDocumentFamily,
  ResolvedDocumentPrecedenceFamily,
} from '@/lib/documentPrecedence';
import { redirectIfUnauthorized } from '@/lib/redirectIfUnauthorized';
import { supabase } from '@/lib/supabaseClient';

type DocumentPrecedenceSectionProps = {
  projectId: string;
};

type RelationshipFormState = {
  sourceDocumentId: string;
  targetDocumentId: string;
  relationshipType: Extract<DocumentRelationshipType, 'amends' | 'supersedes'>;
};

type SupportRelationshipFormState = {
  sourceDocumentId: string;
  targetDocumentId: string;
  relationshipType: Extract<DocumentRelationshipType, 'attached_to' | 'supplements'>;
};

type PrecedenceResponse = {
  ok?: boolean;
  error?: string;
  families?: ResolvedDocumentPrecedenceFamily[];
};

type GovernanceRoleKey = 'contract' | 'invoice' | 'transaction_data' | 'support';

const RELATIONSHIP_OPTIONS: Array<{
  value: Extract<DocumentRelationshipType, 'amends' | 'supersedes'>;
  label: string;
}> = [
  { value: 'amends', label: 'Amends' },
  { value: 'supersedes', label: 'Supersedes' },
];

const SUPPORT_RELATIONSHIP_OPTIONS: Array<{
  value: Extract<DocumentRelationshipType, 'attached_to' | 'supplements'>;
  label: string;
}> = [
  { value: 'attached_to', label: 'Attached To' },
  { value: 'supplements', label: 'Supplements' },
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

function reasonLabel(family: ResolvedDocumentPrecedenceFamily): string {
  switch (family.governing_reason) {
    case 'operator_override':
      return 'Operator Override';
    case 'supersedes_relationship':
      return 'Supersedes';
    case 'amends_relationship':
      return 'Amends';
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
    .filter((family) => family.family === 'permit' || family.family === 'ticket_support')
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

function relationshipSummaryLines(family: ResolvedDocumentPrecedenceFamily): string[] {
  return [
    ...new Set(
      family.documents.flatMap((document) =>
        document.relationship_summary
          .filter((summary) => /^(amends|supersedes)\b/i.test(summary))
          .map((summary) => `${documentLabel(document)} ${summary}`),
      ),
    ),
  ];
}

function supportRelationshipSummaryLines(
  families: readonly ResolvedDocumentPrecedenceFamily[],
): string[] {
  return [
    ...new Set(
      families.flatMap((family) =>
        family.documents.flatMap((document) =>
          document.relationship_summary
            .filter((summary) => /^(supports|applies to)\b/i.test(summary))
            .map((summary) => `${documentLabel(document)} ${summary}`),
        ),
      ),
    ),
  ];
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
                        {document.relationship_summary.join(' / ')}
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
  form,
  saving,
  setRelationshipForms,
  mutate,
}: {
  family: ResolvedDocumentPrecedenceFamily;
  form: RelationshipFormState;
  saving: boolean;
  setRelationshipForms: Dispatch<
    SetStateAction<Partial<Record<GoverningDocumentFamily, RelationshipFormState>>>
  >;
  mutate: (payload: Record<string, unknown>, successMessage: string) => Promise<void>;
}) {
  const relationshipLines = relationshipSummaryLines(family);

  return (
    <div className="rounded-sm border border-[#2F3B52]/70 bg-[#111827] p-4">
      <div>
        <h3 className="text-sm font-bold text-[#E5EDF7]">
          {family.family === 'invoice' ? 'Invoice Relationships' : family.label}
        </h3>
        <p className="mt-2 text-[11px] text-[#94A3B8]">
          {family.family === 'invoice'
            ? 'Track invoice revisions and billing sequence across related invoice files.'
            : 'Preserve amends and supersedes links inside the same project document family.'}
        </p>
      </div>

      <div className="mt-4 space-y-3">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#94A3B8]">
            {family.family === 'invoice' ? 'Invoice Relationships' : 'Existing Links'}
          </p>
          {relationshipLines.length === 0 ? (
            <p className="mt-2 text-sm text-[#94A3B8]">
              {family.family === 'invoice'
                ? 'No billing sequence or revision links have been recorded for this invoice set yet.'
                : 'No amends or supersedes links have been recorded for this role yet.'}
            </p>
          ) : (
            <div className="mt-2 space-y-2">
              {relationshipLines.map((line) => (
                <p
                  key={line}
                  className="rounded-sm border border-[#2F3B52]/70 bg-[#0F172A] px-3 py-2 text-[11px] text-[#C7D2E3]"
                >
                  {line}
                </p>
              ))}
            </div>
          )}
        </div>

        <div className="rounded-sm border border-[#2F3B52]/70 bg-[#0F172A] p-3">
          <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#94A3B8]">
            Link Relationship
          </p>
          <div className="mt-3 grid gap-3 md:grid-cols-[minmax(0,1fr)_180px_minmax(0,1fr)_auto]">
            <select
              value={form.sourceDocumentId}
              onChange={(event) => setRelationshipForms((current) => ({
                ...current,
                [family.family]: {
                  ...form,
                  sourceDocumentId: event.target.value,
                },
              }))}
              className="rounded-sm border border-[#2F3B52] bg-[#111827] px-3 py-2 text-sm text-[#E5EDF7] outline-none"
            >
              {family.documents.map((document) => (
                <option key={document.id} value={document.id}>
                  {documentLabel(document)}
                </option>
              ))}
            </select>
            <select
              value={form.relationshipType}
              onChange={(event) => setRelationshipForms((current) => ({
                ...current,
                [family.family]: {
                  ...form,
                  relationshipType: event.target.value as RelationshipFormState['relationshipType'],
                },
              }))}
              className="rounded-sm border border-[#2F3B52] bg-[#111827] px-3 py-2 text-sm text-[#E5EDF7] outline-none"
            >
              {RELATIONSHIP_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <select
              value={form.targetDocumentId}
              onChange={(event) => setRelationshipForms((current) => ({
                ...current,
                [family.family]: {
                  ...form,
                  targetDocumentId: event.target.value,
                },
              }))}
              className="rounded-sm border border-[#2F3B52] bg-[#111827] px-3 py-2 text-sm text-[#E5EDF7] outline-none"
            >
              {family.documents.map((document) => (
                <option key={document.id} value={document.id}>
                  {documentLabel(document)}
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
                `Recorded ${form.relationshipType.replace(/_/g, ' ')} relationship for ${family.label.toLowerCase()} documents.`,
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
  families,
  form,
  saving,
  setSupportRelationshipForm,
  mutate,
}: {
  families: readonly ResolvedDocumentPrecedenceFamily[];
  form: SupportRelationshipFormState;
  saving: boolean;
  setSupportRelationshipForm: Dispatch<SetStateAction<SupportRelationshipFormState>>;
  mutate: (payload: Record<string, unknown>, successMessage: string) => Promise<void>;
}) {
  const supportSourceFamilies = families.filter(
    (family) => family.family === 'permit' || family.family === 'ticket_support',
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
  const relationshipLines = supportRelationshipSummaryLines(families);

  return (
    <div className="rounded-sm border border-[#2F3B52]/70 bg-[#111827] p-4">
      <div>
        <h3 className="text-sm font-bold text-[#E5EDF7]">
          Support Attachments
        </h3>
        <p className="mt-2 text-[11px] text-[#94A3B8]">
          Attach permit, ticket, and support records to the active invoice or governing contract so downstream facts and validation can stop guessing.
        </p>
      </div>

      <div className="mt-4 space-y-3">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#94A3B8]">
            Existing Support Links
          </p>
          {relationshipLines.length === 0 ? (
            <p className="mt-2 text-sm text-[#94A3B8]">
              No support relationships have been recorded yet.
            </p>
          ) : (
            <div className="mt-2 space-y-2">
              {relationshipLines.map((line) => (
                <p
                  key={line}
                  className="rounded-sm border border-[#2F3B52]/70 bg-[#0F172A] px-3 py-2 text-[11px] text-[#C7D2E3]"
                >
                  {line}
                </p>
              ))}
            </div>
          )}
        </div>

        {supportSourceDocuments.length === 0 || supportTargetDocuments.length === 0 ? (
          <div className="rounded-sm border border-[#2F3B52]/70 bg-[#0F172A] px-3 py-3 text-sm text-[#94A3B8]">
            Add support or invoice/contract documents to this project before recording support attachments.
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
                  'Recorded support attachment for canonical project truth.',
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
          setFamilies(nextFamilies);
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

      setFamilies(body.families ?? []);
      setSupportRelationshipForm((current) => {
        const nextDefault = defaultSupportRelationshipForm(body.families ?? []);
        const sourceStillExists = (body.families ?? []).some((family) =>
          family.documents.some((document) => document.id === current.sourceDocumentId),
        );
        const targetStillExists = (body.families ?? []).some((family) =>
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
  const relationshipFamilies = families.filter((family) => family.documents.length > 1);

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
            Preserve amendment chains, superseded records, and support attachments in one dedicated place without duplicating the governing controls.
          </p>
        </div>

        {families.length === 0 ? (
          <div className="rounded-sm border border-[#2F3B52]/70 bg-[#111827] p-4 text-sm text-[#94A3B8]">
            Relationship controls will appear once there are comparable project documents to link.
          </div>
        ) : relationshipFamilies.length === 0 ? (
          <div className="rounded-sm border border-[#2F3B52]/70 bg-[#111827] p-4 text-sm text-[#94A3B8]">
            At least two candidate documents in the same role are needed before amends or supersedes links can be recorded.
          </div>
        ) : (
          relationshipFamilies.map((family) => (
            <RelationshipFamilyCard
              key={family.family}
              family={family}
              form={relationshipForms[family.family] ?? defaultRelationshipForm(family)}
              saving={saving}
              setRelationshipForms={setRelationshipForms}
              mutate={mutate}
            />
          ))
        )}

        <SupportRelationshipCard
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
