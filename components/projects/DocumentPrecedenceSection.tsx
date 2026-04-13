'use client';

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

type PrecedenceResponse = {
  ok?: boolean;
  error?: string;
  families?: ResolvedDocumentPrecedenceFamily[];
};

const RELATIONSHIP_OPTIONS: Array<{
  value: Extract<DocumentRelationshipType, 'amends' | 'supersedes'>;
  label: string;
}> = [
  { value: 'amends', label: 'Amends' },
  { value: 'supersedes', label: 'Supersedes' },
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

export function DocumentPrecedenceSection({
  projectId,
}: DocumentPrecedenceSectionProps) {
  const [families, setFamilies] = useState<ResolvedDocumentPrecedenceFamily[]>([]);
  const [relationshipForms, setRelationshipForms] = useState<
    Partial<Record<GoverningDocumentFamily, RelationshipFormState>>
  >({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);

      const { data: { session } } = await supabase.auth.getSession();
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

    const { data: { session } } = await supabase.auth.getSession();
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

  if (loading) {
    return (
      <div className="rounded-sm border border-[#2F3B52]/70 bg-[#111827] p-4 text-sm text-[#94A3B8]">
        Loading governing document precedence...
      </div>
    );
  }

  if (families.length === 0) {
    return (
      <div className="rounded-sm border border-[#2F3B52]/70 bg-[#111827] p-4 text-sm text-[#94A3B8]">
        Governing document controls will appear once the project has contracts, permits, invoices, rate sheets, or ticket-support records to compare.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="rounded-sm border border-[#2F3B52]/70 bg-[#111827] p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#94A3B8]">
              Governing Documents
            </p>
            <p className="mt-2 text-sm text-[#C7D2E3]">
              Precedence is resolved from operator overrides, explicit supersedes or amends links, role priority, effective date, then upload recency.
            </p>
          </div>
          {saving && (
            <span className="text-[10px] uppercase tracking-[0.14em] text-[#38BDF8]">
              Saving...
            </span>
          )}
        </div>

        {error && (
          <div className="mt-4 rounded-sm border border-[#EF4444]/30 bg-[#EF4444]/10 px-3 py-2 text-[11px] text-[#FCA5A5]">
            {error}
          </div>
        )}

        {success && (
          <div className="mt-4 rounded-sm border border-[#22C55E]/30 bg-[#22C55E]/10 px-3 py-2 text-[11px] text-[#86EFAC]">
            {success}
          </div>
        )}
      </div>

      {families.map((family) => {
        const form = relationshipForms[family.family] ?? defaultRelationshipForm(family);

        return (
          <div
            key={family.family}
            className="rounded-sm border border-[#2F3B52]/70 bg-[#111827] p-4"
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-sm font-bold text-[#E5EDF7]">
                    {family.label}
                  </h3>
                  <span className={`rounded-sm px-2 py-1 text-[10px] font-bold uppercase tracking-[0.14em] ${badgeClass(family.has_operator_override)}`}>
                    {reasonLabel(family)}
                  </span>
                </div>
                <p className="mt-2 text-[11px] text-[#94A3B8]">
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

            <div className="mt-4 space-y-2">
              {family.documents.map((document, index) => {
                const authorityStatus = titleize(document.authority_status ?? 'active');
                const roleLabel = titleize(document.resolved_role);
                return (
                  <div
                    key={document.id}
                    className="rounded-sm border border-[#2F3B52]/70 bg-[#1A2333] p-3"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="text-sm font-medium text-[#E5EDF7]">
                            {document.title ?? document.name}
                          </p>
                          {document.is_governing && (
                            <span className="rounded-sm border border-[#22C55E]/30 bg-[#22C55E]/10 px-2 py-1 text-[10px] font-bold uppercase tracking-[0.14em] text-[#22C55E]">
                              Governing
                            </span>
                          )}
                        </div>
                        <p className="mt-1 text-[10px] uppercase tracking-[0.14em] text-[#94A3B8]">
                          {roleLabel}
                          {document.document_type ? ` / ${titleize(document.document_type)}` : ''}
                          {document.effective_date ? ` / Effective ${document.effective_date}` : ''}
                          {authorityStatus ? ` / ${authorityStatus}` : ''}
                        </p>
                        {document.relationship_summary.length > 0 && (
                          <p className="mt-2 text-[11px] text-[#94A3B8]">
                            {document.relationship_summary.join(' · ')}
                          </p>
                        )}
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
                            `${document.title ?? document.name} is now the governing ${family.label.toLowerCase()} document.`,
                          )}
                          className="rounded-sm border border-[#3B82F6]/30 bg-[#3B82F6]/10 px-3 py-2 text-[10px] font-bold uppercase tracking-[0.14em] text-[#3B82F6] transition-colors hover:bg-[#3B82F6]/20 disabled:cursor-default disabled:opacity-50"
                        >
                          Set Governing
                        </button>
                        <button
                          type="button"
                          disabled={saving || index === 0}
                          onClick={() => mutate(
                            {
                              action: 'move',
                              family: family.family,
                              documentId: document.id,
                              direction: 'up',
                            },
                            `${document.title ?? document.name} moved up in ${family.label.toLowerCase()} precedence.`,
                          )}
                          className="rounded-sm border border-[#2F3B52] bg-[#1F2937] px-3 py-2 text-[10px] font-bold uppercase tracking-[0.14em] text-[#C7D2E3] transition-colors hover:bg-[#243044] disabled:cursor-default disabled:opacity-50"
                        >
                          Up
                        </button>
                        <button
                          type="button"
                          disabled={saving || index === family.documents.length - 1}
                          onClick={() => mutate(
                            {
                              action: 'move',
                              family: family.family,
                              documentId: document.id,
                              direction: 'down',
                            },
                            `${document.title ?? document.name} moved down in ${family.label.toLowerCase()} precedence.`,
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
                              ? `${document.title ?? document.name} restored to active authority status.`
                              : `${document.title ?? document.name} marked as superseded.`,
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

            {family.documents.length > 1 && (
              <div className="mt-4 rounded-sm border border-[#2F3B52]/70 bg-[#0F172A] p-3">
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
                        {document.title ?? document.name}
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
                        {document.title ?? document.name}
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
            )}
          </div>
        );
      })}
    </div>
  );
}
