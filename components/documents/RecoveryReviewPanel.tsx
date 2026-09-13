'use client';

import { useCallback, useEffect, useState } from 'react';

import { SourceEvidencePage } from '@/components/recovery/SourceEvidencePage';
import { supabase } from '@/lib/supabaseClient';
import type { VisualSourceEvidence, VisualSourceBox } from '@/lib/recovery/visualSourceEvidence';
import type {
  RecoveryReviewCandidate,
  RecoveryReviewState,
} from '@/lib/server/forgewingRecoveryReviewRead';

/**
 * Operator review of withheld priced rows.
 *
 * The panel is deliberately explicit about what each state means. Accepting a
 * recovery records a human decision; it does not change any canonical output.
 * Only a deterministic reprocess can do that, and until one has run and
 * consumed the confirmation the row is still withheld. Showing "applied" at
 * acceptance time would be a lie the audit trail would then contradict.
 *
 * Every action here is a database write. Nothing on this surface calls a
 * provider, and there is no control that asks Forgewing to try again.
 */

type ReviewDisposition = 'accepted' | 'modified' | 'rejected' | 'deferred';

const STATE_LABEL: Record<RecoveryReviewState | 'reprocessing' | 'applied', string> = {
  pending_review: 'Pending review',
  accepted_awaiting_reprocess: 'Confirmed — reprocessing required',
  rejected: 'Rejected — row remains withheld',
  deferred: 'Deferred — row remains withheld',
  ambiguous_authority: 'Ambiguous authority — no recovery applied',
  reprocessing: 'Reprocessing',
  applied: 'Applied',
};

const STATE_TONE: Record<string, string> = {
  pending_review: 'text-[var(--ef-warning)]',
  accepted_awaiting_reprocess: 'text-[var(--ef-purple-accent)]',
  rejected: 'text-[var(--ef-text-muted)]',
  deferred: 'text-[var(--ef-text-muted)]',
  ambiguous_authority: 'text-[var(--ef-critical)]',
  reprocessing: 'text-[var(--ef-warning)]',
  applied: 'text-[var(--ef-success)]',
};

/**
 * Slightly under the route's 300s signed-URL expiry, so a URL is never handed
 * to the viewer with only a sliver of life left.
 */
const SIGNED_URL_REUSE_MS = 240_000;

async function authorizedFetch(input: string, init?: RequestInit): Promise<Response | null> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) return null;
  return fetch(input, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session.access_token}`,
      ...(init?.headers ?? {}),
    },
  });
}

function visualEvidence(
  candidate: RecoveryReviewCandidate,
  selectedId: string,
): VisualSourceEvidence | null {
  if (candidate.proposalVersion === 2) {
    const selected = candidate.selectableCandidates.find((entry) => entry.candidateId === selectedId);
    if (!selected) return null;
    const boxes: VisualSourceBox[] = [
      ...selected.observations.map((observation, memberIndex) => ({
        ...observation, role: 'candidate_member' as const, memberIndex,
      })),
      ...selected.targetContext.map((observation, memberIndex) => ({
        ...observation, role: 'target_row_context' as const, memberIndex,
      })),
      ...candidate.selectableCandidates
        .filter((entry) => entry.candidateId !== selected.candidateId)
        .flatMap((entry) => entry.targetContext.map((observation, memberIndex) => ({
          ...observation, role: 'alternative_candidate' as const, memberIndex,
        }))),
    ];
    return {
      sourceDocumentId: selected.sourceDocumentId,
      sourceArtifactId: selected.sourceArtifactId,
      physicalPageNumber: selected.physicalPageNumber,
      pageRepresentationDigest: selected.pageRepresentationDigest,
      candidateId: selected.candidateId,
      recoveryType: selected.recoveryType,
      composedRawText: selected.composedRawText,
      boxes,
    };
  }
  if (!candidate.sourceArtifactId || !candidate.pageRepresentationDigest) return null;
  const selected = candidate.selectableObservations.find((entry) => entry.observationId === selectedId);
  if (!selected) return null;
  return {
    sourceDocumentId: candidate.sourceDocumentId,
    sourceArtifactId: candidate.sourceArtifactId,
    physicalPageNumber: candidate.physicalPageNumber,
    pageRepresentationDigest: candidate.pageRepresentationDigest,
    candidateId: `v1:${selected.observationId}`,
    recoveryType: 'pricing_rate_single_observation',
    composedRawText: selected.rawText,
    boxes: [{ ...selected, role: 'candidate_member', memberIndex: 0 }],
  };
}

export function RecoveryReviewPanel({
  documentId,
  onReprocessed,
}: {
  documentId: string;
  onReprocessed?: () => void;
}) {
  const [candidates, setCandidates] = useState<readonly RecoveryReviewCandidate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyProposalId, setBusyProposalId] = useState<string | null>(null);
  const [selection, setSelection] = useState<Record<string, string>>({});
  const [rationale, setRationale] = useState<Record<string, string>>({});
  const [reprocessState, setReprocessState] = useState<'idle' | 'reprocessing'>('idle');
  const [openSourceProposalId, setOpenSourceProposalId] = useState<string | null>(null);
  const [source, setSource] = useState<{ url: string; expiresAt: number } | null>(null);
  const [sourceLoading, setSourceLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const response = await authorizedFetch(
      `/api/internal/forgewing-recovery-review?documentId=${encodeURIComponent(documentId)}`,
    );
    if (!response) {
      setError('Authentication required.');
      setLoading(false);
      return;
    }
    const body = await response.json().catch(() => null);
    if (!response.ok || !body?.ok) {
      // A deployment without the recovery tables is not an error worth showing
      // an operator; the panel simply has nothing to review.
      setError(response.status === 503 ? null : 'Could not load withheld rows.');
      setCandidates([]);
      setLoading(false);
      return;
    }
    setCandidates(body.candidates ?? []);
    setLoading(false);
  }, [documentId]);

  useEffect(() => { void load(); }, [load]);

  const toggleSource = async (proposalId: string) => {
    if (openSourceProposalId === proposalId) {
      setOpenSourceProposalId(null);
      return;
    }
    setOpenSourceProposalId(proposalId);
    // The signed URL expires. Reuse it only while it is still usable, and
    // otherwise fetch a fresh one through the same authenticated route -- the
    // alternative is a viewer that silently fails to load after five minutes.
    // Fetched on open only: no polling, no background refresh.
    if (source && Date.now() < source.expiresAt) return;
    setSourceLoading(true);
    const response = await authorizedFetch(`/api/documents/${encodeURIComponent(documentId)}/file`);
    const body = await response?.json().catch(() => null);
    setSourceLoading(false);
    if (!response?.ok || typeof body?.signedUrl !== 'string') {
      setSource(null);
      setError('The authenticated source file could not be loaded.');
      setOpenSourceProposalId(null);
      return;
    }
    setSource({ url: body.signedUrl, expiresAt: Date.now() + SIGNED_URL_REUSE_MS });
  };

  const submit = async (candidate: RecoveryReviewCandidate, disposition: ReviewDisposition) => {
    const reviewerRationale = rationale[candidate.proposalId]?.trim();
    if (!reviewerRationale) {
      setError('A rationale is required: the review is immutable audit history.');
      return;
    }
    const confirmedSelectionId = selection[candidate.proposalId]
      ?? (candidate.proposalVersion === 2
        ? candidate.selectableCandidates.find((entry) => entry.proposed)?.candidateId
        : candidate.selectableObservations.find((entry) => entry.proposed)?.observationId);
    if ((disposition === 'accepted' || disposition === 'modified') && !confirmedSelectionId) {
      setError('Select the source-backed candidate you are confirming.');
      return;
    }
    setBusyProposalId(candidate.proposalId);
    setError(null);
    const response = await authorizedFetch('/api/internal/forgewing-recovery-review', {
      method: 'POST',
      body: JSON.stringify({
        // Exact pin. Never "the newest proposal for this page".
        proposalId: candidate.proposalId,
        proposalDigestSha256: candidate.proposalDigestSha256,
        disposition,
        ...(disposition === 'accepted' || disposition === 'modified'
          ? candidate.proposalVersion === 2
            ? { confirmedCandidateId: confirmedSelectionId }
            : { confirmedObservationId: confirmedSelectionId }
          : {}),
        reviewerRationale,
      }),
    });
    setBusyProposalId(null);
    if (!response) {
      setError('Authentication required.');
      return;
    }
    if (!response.ok) {
      setError('The review was not recorded.');
      return;
    }
    await load();
  };

  const reprocess = async () => {
    setReprocessState('reprocessing');
    setError(null);
    const response = await authorizedFetch('/api/documents/process', {
      method: 'POST',
      body: JSON.stringify({ documentId, processingPurpose: 'recovery_reprocess' }),
    });
    setReprocessState('idle');
    if (!response?.ok) {
      setError('Reprocessing could not be started.');
      return;
    }
    await load();
    onReprocessed?.();
  };

  if (loading || (candidates.length === 0 && !error)) return null;

  const awaitingReprocess = candidates.some(
    (candidate) => candidate.reviewState === 'accepted_awaiting_reprocess',
  );

  return (
    <section className="rounded-lg border border-white/5 bg-[var(--ef-background-secondary)] p-4">
      <header className="mb-3">
        <h3 className="text-sm font-semibold text-[var(--ef-text-primary)]">
          Withheld priced rows
        </h3>
        <p className="mt-1 text-xs text-[var(--ef-text-muted)]">
          These rows were not extracted. Confirming one authorizes a
          deterministic reprocess; it does not change any value on its own.
        </p>
      </header>

      {error ? (
        <p className="mb-3 text-xs text-[var(--ef-critical)]">{error}</p>
      ) : null}

      <ul className="space-y-4">
        {candidates.map((candidate) => {
          const state = reprocessState === 'reprocessing'
            && candidate.reviewState === 'accepted_awaiting_reprocess'
            ? 'reprocessing'
            : candidate.reviewState;
          const decided = candidate.reviewState !== 'pending_review';
          const chosen = selection[candidate.proposalId]
            ?? (candidate.proposalVersion === 2
              ? candidate.selectableCandidates.find((entry) => entry.proposed)?.candidateId
              : candidate.selectableObservations.find((entry) => entry.proposed)?.observationId)
            ?? '';
          const sourceEvidence = visualEvidence(candidate, chosen);
          return (
            <li
              key={candidate.proposalId}
              id={`recovery-proposal-${candidate.proposalId}`}
              className="rounded border border-white/5 bg-[var(--ef-surface-elevated)] p-3"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="text-xs text-[var(--ef-text-muted)]">
                  Page {candidate.physicalPageNumber}
                </span>
                <span className={`text-xs font-medium ${STATE_TONE[state] ?? ''}`}>
                  {STATE_LABEL[state]}
                </span>
              </div>

              <dl className="mt-3 space-y-2 text-xs">
                <div>
                  <dt className="text-[var(--ef-text-muted)]">EightForge result</dt>
                  <dd className="text-[var(--ef-text-primary)]">
                    {candidate.recoveryType === 'priced_schedule_continuation_attribution'
                      ? 'Continuation withheld — ambiguous row assignment'
                      : 'Row withheld — ambiguous rate cluster'}
                  </dd>
                </div>
                <div>
                  <dt className="text-[var(--ef-text-muted)]">Forgewing suggests</dt>
                  <dd className="text-[var(--ef-text-primary)]">
                    <span className="font-mono">{candidate.proposedValue}</span>
                    <span className="ml-2 text-[var(--ef-text-muted)]">
                      {candidate.reasonCategory.replace(/_/g, ' ')}
                      {' · confidence '}
                      {candidate.certainty.toFixed(2)}
                    </span>
                  </dd>
                </div>
              </dl>

              <button type="button" className="mt-3 rounded border border-white/10 px-3 py-1 text-xs text-[var(--ef-text-primary)]"
                aria-expanded={openSourceProposalId === candidate.proposalId}
                disabled={!sourceEvidence || sourceLoading}
                onClick={() => void toggleSource(candidate.proposalId)}>
                {sourceLoading && openSourceProposalId === candidate.proposalId ? 'Loading source…'
                  : openSourceProposalId === candidate.proposalId ? 'Hide source' : 'View source'}
              </button>
              {!sourceEvidence ? (
                candidate.sourceEvidenceBinding === 'unbound_identity_incomplete'
                  ? <p className="mt-2 text-xs text-[var(--ef-critical)]" data-testid="source-evidence-unbound">
                    Source evidence is unbound: the persisted candidates no longer close over this
                    source. No highlights are shown.</p>
                  : <p className="mt-2 text-xs text-[var(--ef-warning)]">
                    Exact source geometry is unavailable for this historical proposal.</p>
              ) : null}
              {openSourceProposalId === candidate.proposalId && source && sourceEvidence ? (
                <div className="mt-3 max-h-[42rem] overflow-hidden rounded border border-white/10">
                  <SourceEvidencePage key={source.url} sourceUrl={source.url} evidence={sourceEvidence}
                    unbound={candidate.sourceEvidenceBinding === 'unbound_identity_incomplete'} />
                </div>
              ) : null}

              {decided ? (
                candidate.latestReview ? (
                  <p className="mt-3 text-xs text-[var(--ef-text-muted)]">
                    {candidate.latestReview.disposition} · review v
                    {candidate.latestReview.reviewVersion}
                    {candidate.latestReview.confirmedObservationId
                      ? ' · confirmed selection recorded'
                      : ''}
                  </p>
                ) : null
              ) : (
                <div className="mt-3 space-y-3">
                  <fieldset>
                    <legend className="text-xs text-[var(--ef-text-muted)]">
                      Human decision — select an existing deterministic candidate
                    </legend>
                    <div className="mt-2 space-y-1">
                      {(candidate.proposalVersion === 2
                        ? candidate.selectableCandidates.map((entry) => ({
                            id: entry.candidateId,
                            label: entry.composedRawText,
                            detail: entry.recoveryType === 'priced_schedule_continuation_attribution'
                              ? `Target ${entry.targetRowIdentity}`
                              : entry.observations.map((observation) => observation.rawText).join(' + '),
                            proposed: entry.proposed,
                          }))
                        : candidate.selectableObservations.map((entry) => ({
                            id: entry.observationId, label: entry.rawText,
                            detail: '', proposed: entry.proposed,
                          }))).map((option) => (
                        <label
                          key={option.id}
                          className="flex items-center gap-2 text-xs text-[var(--ef-text-primary)]"
                        >
                          <input
                            type="radio"
                            name={`recovery-${candidate.proposalId}`}
                            value={option.id}
                            checked={chosen === option.id}
                            onChange={() => setSelection((previous) => ({
                              ...previous,
                              [candidate.proposalId]: option.id,
                            }))}
                          />
                          <span className="font-mono">{option.label}</span>
                          {option.detail ? <span className="text-[var(--ef-text-muted)]">{option.detail}</span> : null}
                          {option.proposed ? (
                            <span className="text-[var(--ef-text-muted)]">(proposed)</span>
                          ) : null}
                        </label>
                      ))}
                    </div>
                  </fieldset>

                  <label className="block text-xs text-[var(--ef-text-muted)]">
                    Rationale
                    <textarea
                      className="mt-1 w-full rounded border border-white/10 bg-transparent p-2 text-xs text-[var(--ef-text-primary)]"
                      rows={2}
                      value={rationale[candidate.proposalId] ?? ''}
                      onChange={(event) => setRationale((previous) => ({
                        ...previous,
                        [candidate.proposalId]: event.target.value,
                      }))}
                    />
                  </label>

                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      disabled={busyProposalId === candidate.proposalId}
                      onClick={() => submit(
                        candidate,
                        chosen === (candidate.proposalVersion === 2
                          ? candidate.selectableCandidates.find((entry) => entry.proposed)?.candidateId
                          : candidate.selectableObservations.find((entry) => entry.proposed)?.observationId)
                          ? 'accepted'
                          : 'modified',
                      )}
                      className="rounded bg-[var(--ef-purple-primary-a20)] px-3 py-1 text-xs text-[var(--ef-purple-accent)]"
                    >
                      Confirm and authorize reprocessing
                    </button>
                    <button
                      type="button"
                      disabled={busyProposalId === candidate.proposalId}
                      onClick={() => submit(candidate, 'rejected')}
                      className="rounded border border-white/10 px-3 py-1 text-xs text-[var(--ef-text-muted)]"
                    >
                      Reject
                    </button>
                    <button
                      type="button"
                      disabled={busyProposalId === candidate.proposalId}
                      onClick={() => submit(candidate, 'deferred')}
                      className="rounded border border-white/10 px-3 py-1 text-xs text-[var(--ef-text-muted)]"
                    >
                      Defer
                    </button>
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>

      {awaitingReprocess ? (
        <button
          type="button"
          disabled={reprocessState === 'reprocessing'}
          onClick={reprocess}
          className="mt-4 rounded bg-[var(--ef-purple-primary-a20)] px-3 py-1 text-xs text-[var(--ef-purple-accent)]"
        >
          {reprocessState === 'reprocessing' ? 'Reprocessing…' : 'Reprocess document'}
        </button>
      ) : null}
    </section>
  );
}
