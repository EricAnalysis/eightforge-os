'use client';

import { useEffect, useState } from 'react';

import { redirectIfUnauthorized } from '@/lib/redirectIfUnauthorized';
import {
  orderRelationshipProposals,
  relationshipProposalState,
  type RelationshipProposalView,
} from '@/lib/relationshipProposalView';
import { supabase } from '@/lib/supabaseClient';

/**
 * Relationship proposals (P3.2, `amends` only). Non-authoritative: a proposal
 * never creates a relationship. "Prefill link" only fills the operator's Link
 * Relationship form; the operator still saves the link, and that existing
 * `link_relationship` action is what records the acceptance. Reject and defer
 * write only a review record.
 */

type ProposalsResponse = { proposals?: RelationshipProposalView[]; error?: string };

const DECIDED_LABEL = {
  accepted: 'Accepted by operator link',
  already_linked: 'Already linked',
  rejected: 'Rejected',
} as const;

export function RelationshipProposalsPanel({
  projectId,
  documentLabel,
  refreshKey,
  saving,
  onProposalsLoaded,
  onPrefill,
}: {
  projectId: string;
  documentLabel: (documentId: string) => string;
  refreshKey: number;
  saving: boolean;
  onProposalsLoaded: (proposals: readonly RelationshipProposalView[]) => void;
  onPrefill: (proposal: RelationshipProposalView) => void;
}) {
  const [proposals, setProposals] = useState<RelationshipProposalView[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState<{ proposalId: string; reason: string } | null>(null);
  const [localRefresh, setLocalRefresh] = useState(0);

  async function authorizedFetch(input: string, init?: RequestInit): Promise<Response | null> {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.access_token) {
      setError('Your session has expired. Please sign in again.');
      return null;
    }
    const response = await fetch(input, {
      ...init,
      headers: { ...(init?.body ? { 'Content-Type': 'application/json' } : {}), Authorization: `Bearer ${session.access_token}` },
    });
    if (redirectIfUnauthorized(response, () => { window.location.href = '/login'; })) return null;
    return response;
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const response = await authorizedFetch(`/api/projects/${projectId}/relationship-proposals`);
      if (!response || cancelled) return;
      const body = await response.json().catch(() => ({})) as ProposalsResponse;
      if (cancelled) return;
      if (!response.ok) {
        setError(body.error ?? 'Relationship proposals are unavailable.');
        return;
      }
      const next = body.proposals ?? [];
      setProposals(next);
      onProposalsLoaded(next);
    })().catch(() => { if (!cancelled) setError('Relationship proposals are unavailable.'); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reload on project, parent saves and local actions only
  }, [projectId, refreshKey, localRefresh]);

  async function run(action: () => Promise<Response | null>, successNotice: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const response = await action();
      if (!response) return;
      const body = await response.json().catch(() => ({})) as { error?: string; created?: number };
      if (!response.ok) throw new Error(body.error ?? 'The proposal action failed.');
      setNotice(typeof body.created === 'number' ? `${successNotice} (${body.created} new)` : successNotice);
      setLocalRefresh((value) => value + 1);
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : 'The proposal action failed.');
    } finally {
      setBusy(false);
    }
  }

  const review = (proposalId: string, disposition: 'rejected' | 'deferred', reason: string | null) => run(
    () => authorizedFetch(`/api/projects/${projectId}/relationship-proposals/${proposalId}/review`, {
      method: 'POST', body: JSON.stringify(reason ? { disposition, reason } : { disposition }),
    }),
    disposition === 'rejected' ? 'Proposal rejected. No relationship was changed.' : 'Proposal deferred.',
  );

  const disabled = saving || busy;
  const ordered = orderRelationshipProposals(proposals);

  return (
    <div className="rounded-sm border border-[var(--ef-border-subtle-a70)] bg-[var(--ef-background-secondary)] p-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[var(--ef-text-muted)]">
            Forgewing Relationship Proposals
          </p>
          <p className="mt-1 text-[11px] text-[var(--ef-text-muted)]">
            Non-authoritative. A proposal never links documents: prefill it, check it, then save the link yourself.
          </p>
        </div>
        <button
          type="button"
          disabled={disabled}
          onClick={() => run(
            () => authorizedFetch(`/api/projects/${projectId}/relationship-proposals`, { method: 'POST', body: '{}' }),
            'Checked referenced amendments for proposals',
          )}
          className="rounded-sm border border-[var(--ef-border-subtle)] px-3 py-2 text-[10px] font-bold uppercase tracking-[0.14em] text-[var(--ef-text-secondary)] transition-colors disabled:cursor-default disabled:opacity-50"
        >
          Check for proposals
        </button>
      </div>

      {error ? <p className="mt-2 text-[11px] text-[var(--ef-critical-soft)]">{error}</p> : null}
      {notice ? <p className="mt-2 text-[11px] text-[var(--ef-text-secondary)]">{notice}</p> : null}

      {ordered.length === 0 ? (
        <p className="mt-3 text-sm text-[var(--ef-text-muted)]">No relationship proposals for this project.</p>
      ) : (
        <div className="mt-3 space-y-2">
          {ordered.map((proposal) => {
            const state = relationshipProposalState(proposal);
            const isRejecting = rejecting?.proposalId === proposal.id;
            return (
              <div
                key={proposal.id}
                className="rounded-sm border border-[var(--ef-border-subtle-a70)] bg-[var(--ef-background-secondary)] px-3 py-3"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 space-y-1">
                    <p className="text-sm text-[var(--ef-text-primary)]">
                      {documentLabel(proposal.source_document_id)} modifies {documentLabel(proposal.target_document_id)}
                      {proposal.amendment_number != null ? ` (Amendment ${proposal.amendment_number})` : ''}
                    </p>
                    <p className="text-[11px] text-[var(--ef-text-muted)]">{proposal.rationale}</p>
                  </div>
                  <span className="rounded-sm border border-[var(--ef-border-subtle)] px-2 py-1 text-[10px] font-bold uppercase tracking-[0.14em] text-[var(--ef-text-muted)]">
                    {state.kind === 'decided' ? DECIDED_LABEL[state.disposition] : state.deferred ? 'Deferred' : 'Proposal'}
                  </span>
                </div>

                {state.kind === 'open' ? (
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      disabled={disabled}
                      onClick={() => {
                        onPrefill(proposal);
                        setNotice('Link form prefilled. Review it, then Save Link to confirm.');
                      }}
                      className="rounded-sm border border-[var(--ef-purple-primary-a30)] bg-[var(--ef-purple-primary-a10)] px-3 py-2 text-[10px] font-bold uppercase tracking-[0.14em] text-[var(--ef-purple-primary)] transition-colors hover:bg-[var(--ef-purple-primary-a20)] disabled:cursor-default disabled:opacity-50"
                    >
                      Prefill link
                    </button>
                    {!state.deferred ? (
                      <button
                        type="button"
                        disabled={disabled}
                        onClick={() => review(proposal.id, 'deferred', null)}
                        className="rounded-sm border border-[var(--ef-border-subtle)] px-3 py-2 text-[10px] font-bold uppercase tracking-[0.14em] text-[var(--ef-text-secondary)] disabled:cursor-default disabled:opacity-50"
                      >
                        Defer
                      </button>
                    ) : null}
                    {isRejecting ? (
                      <>
                        <input
                          value={rejecting.reason}
                          onChange={(event) => setRejecting({ proposalId: proposal.id, reason: event.target.value })}
                          placeholder="Reason (required)"
                          maxLength={2000}
                          className="min-w-[220px] flex-1 rounded-sm border border-[var(--ef-border-subtle)] bg-[var(--ef-background-secondary)] px-3 py-2 text-sm text-[var(--ef-text-primary)] outline-none"
                        />
                        <button
                          type="button"
                          disabled={disabled || !rejecting.reason.trim()}
                          onClick={() => {
                            const reason = rejecting.reason.trim();
                            setRejecting(null);
                            void review(proposal.id, 'rejected', reason);
                          }}
                          className="rounded-sm border border-[var(--ef-critical-a40)] bg-[var(--ef-critical-bg)] px-3 py-2 text-[10px] font-bold uppercase tracking-[0.14em] text-[var(--ef-critical-soft)] disabled:cursor-default disabled:opacity-50"
                        >
                          Confirm reject
                        </button>
                        <button
                          type="button"
                          disabled={disabled}
                          onClick={() => setRejecting(null)}
                          className="px-2 py-2 text-[10px] font-bold uppercase tracking-[0.14em] text-[var(--ef-text-muted)]"
                        >
                          Cancel
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        disabled={disabled}
                        onClick={() => setRejecting({ proposalId: proposal.id, reason: '' })}
                        className="rounded-sm border border-[var(--ef-critical-a40)] px-3 py-2 text-[10px] font-bold uppercase tracking-[0.14em] text-[var(--ef-critical-soft)] disabled:cursor-default disabled:opacity-50"
                      >
                        Reject
                      </button>
                    )}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
