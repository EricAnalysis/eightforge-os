'use client';

// Improvement lifecycle and measurement evidence for one triaged submission
// (B8.4d). It shows what the database recorded and offers only the human
// actions B8.4 defines: attest the merge commit of an approved request,
// measure a proven deployment, and decide on a completed measurement.
// Deployment is never claimed here: the worker proves it by git ancestry.
// Nothing is closed automatically; `resolved` is a person's decision on a
// resolution candidate. The Linear copy is shown as an outbound projection
// only and decides nothing.

import { useCallback, useEffect, useState } from 'react';

type Row = Record<string, unknown>;
export type LifecycleView = {
  submissionId: string;
  measurable: boolean;
  engineeringRequests: {
    reviewId: string; reviewVersion: number; planV2RunId: string; planV2DigestSha256: string;
    recommendationId: string; disposition: string; current: boolean; linearStatus: string | null;
    linearIssueIdentifier: string | null;
  }[];
  events: Row[];
  snapshots: Row[];
  decisions: Row[];
  successors: Row[];
  predecessor: Row | null;
};

export const DECISIONS_BY_OUTCOME: Readonly<Record<string, readonly ('resolved' | 'recurred_confirmed' | 'deferred')[]>> = {
  resolution_candidate: ['resolved', 'deferred'],
  recurred: ['recurred_confirmed', 'deferred'],
  confounded: ['deferred'],
};

const OUTCOME_LABEL: Record<string, string> = {
  resolution_candidate: 'Resolution candidate',
  recurred: 'Recurred',
  insufficient_exposure: 'Insufficient exposure',
  confounded: 'Confounded',
  unmeasurable: 'Unmeasurable',
};
const DECISION_LABEL: Record<string, string> = {
  resolved: 'Resolved', recurred_confirmed: 'Recurrence confirmed', deferred: 'Deferred',
};
const EVENT_LABEL: Record<string, string> = {
  implemented: 'Fix commit attested', deployed: 'Deployment proven', measuring: 'Measuring',
  measurement_completed: 'Measurement completed',
};

/** Per deployed fix: what is recorded and which human action is open. Pure. */
export function deployedFixState(view: LifecycleView, deployedEventId: string) {
  const completed = view.events.find((event) => event.event_kind === 'measurement_completed'
    && event.deployed_event_id === deployedEventId);
  const completedSnapshot = completed
    ? view.snapshots.find((snapshot) => snapshot.id === completed.measurement_snapshot_id) ?? null : null;
  const decisions = view.decisions.filter((decision) => decision.deployed_event_id === deployedEventId)
    .sort((a, b) => Number(a.decision_version) - Number(b.decision_version));
  const latestDecision = decisions.at(-1) ?? null;
  const successor = latestDecision
    ? view.successors.find((link) => link.decision_id === latestDecision.id) ?? null : null;
  return {
    canMeasure: !completed,
    completedSnapshot,
    allowedDecisions: completedSnapshot ? DECISIONS_BY_OUTCOME[String(completedSnapshot.outcome)] ?? [] : [],
    latestDecisionVersion: latestDecision ? Number(latestDecision.decision_version) : 0,
    latestDecision,
    successor,
    successorMissing: latestDecision?.decision === 'recurred_confirmed' && !successor,
  };
}

/** Approved, current requests not yet attested: the only attestation targets. Pure. */
export function attestableRequests(view: LifecycleView) {
  const attested = new Set(view.events.filter((event) => event.event_kind === 'implemented')
    .map((event) => String(event.engineering_review_id)));
  return view.engineeringRequests.filter((request) => request.current && !attested.has(request.reviewId));
}

const short = (value: unknown, length = 12) => (typeof value === 'string' ? value.slice(0, length) : '—');
const when = (value: unknown) => (typeof value === 'string' ? new Date(value).toLocaleString() : '—');

async function post(path: string, token: string, body: unknown): Promise<{ ok: boolean; error?: string }> {
  try {
    const response = await fetch(path, { method: 'POST', cache: 'no-store',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const parsed = await response.json().catch(() => ({})) as { error?: string };
    return response.ok ? { ok: true } : { ok: false, error: parsed.error ?? `HTTP ${response.status}` };
  } catch {
    return { ok: false, error: 'network_error' };
  }
}

export async function fetchImprovementLifecycle(submissionId: string, accessToken: string, fetcher: typeof fetch = fetch):
  Promise<{ view: LifecycleView } | { error: string }> {
  try {
    const response = await fetcher(`/api/internal/improvement-lifecycle?submissionId=${encodeURIComponent(submissionId)}`,
      { headers: { authorization: `Bearer ${accessToken}` }, cache: 'no-store' });
    if (!response.ok) return { error: `Lifecycle unavailable (${response.status}).` };
    return { view: await response.json() as LifecycleView };
  } catch {
    return { error: 'Lifecycle unavailable.' };
  }
}

export default function ImprovementLifecyclePanel({ submissionId, accessToken }: { submissionId: string; accessToken: string }) {
  const [view, setView] = useState<LifecycleView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [sha, setSha] = useState<Record<string, string>>({});
  const [decision, setDecision] = useState<Record<string, { value: string; rationale: string }>>({});

  useEffect(() => {
    let cancelled = false;
    void fetchImprovementLifecycle(submissionId, accessToken).then((result) => {
      if (cancelled) return;
      if ('view' in result) { setView(result.view); setError(null); } else setError(result.error);
    });
    return () => { cancelled = true; };
  }, [submissionId, accessToken, reloadKey]);

  const act = useCallback(async (path: string, body: unknown) => {
    setBusy(true);
    const result = await post(path, accessToken, body);
    setBusy(false);
    if (!result.ok) setError(`Not recorded: ${result.error}`);
    setReloadKey((key) => key + 1);
  }, [accessToken]);

  if (error && !view) return <p className="mt-3 text-xs text-[var(--ef-text-muted)]">{error}</p>;
  if (!view) return null;
  const deployed = view.events.filter((event) => event.event_kind === 'deployed');
  const attestable = attestableRequests(view);
  if (view.engineeringRequests.length === 0 && view.events.length === 0 && !view.predecessor) return null;

  return (
    <section aria-label="Improvement lifecycle" className="mt-3 space-y-3 rounded border border-[var(--ef-border-subtle)] p-3">
      <h3 className="text-xs font-semibold text-[var(--ef-text-primary)]">Lifecycle and measurement</h3>
      {view.predecessor ? (
        <p className="text-[11px] text-[var(--ef-text-secondary)]">
          Recurrence of submission <span className="font-mono">{short(view.predecessor.originating_submission_id, 8)}</span>,
          confirmed {when(view.predecessor.recorded_at)}.
        </p>
      ) : null}
      {error ? <p role="alert" className="text-[11px] text-[var(--ef-critical-a)]">{error}</p> : null}

      {view.engineeringRequests.length > 0 ? (
        <ul className="space-y-1 text-[11px] text-[var(--ef-text-secondary)]">
          {view.engineeringRequests.map((request) => (
            <li key={request.reviewId}>
              Approved request <span className="font-mono">{short(request.recommendationId, 16)}</span> ({request.disposition},
              review v{request.reviewVersion}{request.current ? '' : ', superseded'})
              {request.linearStatus ? ` · Linear copy ${request.linearStatus}${request.linearIssueIdentifier ? ` ${request.linearIssueIdentifier}` : ''} (outbound only)` : ''}
            </li>
          ))}
        </ul>
      ) : null}

      {attestable.map((request) => (
        <div key={request.reviewId} className="flex flex-wrap items-center gap-2 text-[11px]">
          <label className="flex items-center gap-2 text-[var(--ef-text-secondary)]">
            Merge commit that shipped <span className="font-mono">{short(request.recommendationId, 16)}</span>
            <input aria-label="Merge commit SHA" value={sha[request.reviewId] ?? ''} maxLength={40}
              onChange={(event) => setSha({ ...sha, [request.reviewId]: event.target.value.trim().toLowerCase() })}
              className="w-80 rounded border border-[var(--ef-border-subtle)] bg-transparent px-1 font-mono" />
          </label>
          <button type="button" disabled={busy || !/^[a-f0-9]{40}$/.test(sha[request.reviewId] ?? '')}
            onClick={() => void act('/api/internal/improvement-lifecycle/fix-attestations', {
              planV2RunId: request.planV2RunId, planV2DigestSha256: request.planV2DigestSha256,
              recommendationId: request.recommendationId, reviewId: request.reviewId, reviewVersion: request.reviewVersion,
              fixCommitSha: sha[request.reviewId] })}
            className="rounded border border-[var(--ef-border-subtle)] px-2 py-0.5 text-[var(--ef-text-secondary)]">
            Attest fix commit
          </button>
        </div>
      ))}

      {view.events.length > 0 ? (
        <ol className="space-y-1 text-[11px] text-[var(--ef-text-secondary)]">
          {view.events.map((event) => (
            <li key={String(event.id)}>
              <span className="font-medium">{EVENT_LABEL[String(event.event_kind)] ?? String(event.event_kind)}</span>
              {' · '}{when(event.recorded_at)}
              {event.event_kind === 'implemented' ? <> · commit <span className="font-mono">{short(event.fix_commit_sha)}</span></> : null}
              {event.event_kind === 'deployed' ? <> · production <span className="font-mono">{short(event.production_revision)}</span>
                {' '}contains <span className="font-mono">{short(event.fix_commit_sha)}</span> (git ancestry), first observed {when(event.deployment_observed_at)}</> : null}
            </li>
          ))}
        </ol>
      ) : null}

      {deployed.map((event) => {
        const state = deployedFixState(view, String(event.id));
        const key = String(event.id);
        const snapshots = view.snapshots.filter((snapshot) => snapshot.deployed_event_id === event.id);
        const draft = decision[key] ?? { value: state.allowedDecisions[0] ?? '', rationale: '' };
        return (
          <div key={key} className="space-y-2">
            {snapshots.length > 0 ? (
              <table className="w-full text-[11px] text-[var(--ef-text-secondary)]">
                <thead><tr className="text-left text-[var(--ef-text-faint)]">
                  <th>Measured</th><th>Baseline</th><th>After deployment</th><th>Outcome</th><th>Reasons</th></tr></thead>
                <tbody>{snapshots.map((snapshot) => (
                  <tr key={String(snapshot.id)}>
                    <td>{when(snapshot.measured_at)}</td>
                    <td>{String(snapshot.baseline_occurrences)} / {String(snapshot.baseline_exposure)}</td>
                    <td>{String(snapshot.post_occurrences)} / {String(snapshot.post_exposure)}</td>
                    <td>{OUTCOME_LABEL[String(snapshot.outcome)] ?? String(snapshot.outcome)}</td>
                    <td className="font-mono">{Array.isArray(snapshot.reasons) ? snapshot.reasons.join(', ') : ''}</td>
                  </tr>
                ))}</tbody>
              </table>
            ) : null}
            {state.canMeasure ? (
              <button type="button" disabled={busy}
                onClick={() => void act('/api/internal/improvement-lifecycle/measurements', { deployedEventId: key })}
                className="rounded border border-[var(--ef-border-subtle)] px-2 py-0.5 text-[11px] text-[var(--ef-text-secondary)]">
                Measure now (friction_measurement_v1)
              </button>
            ) : null}
            {view.decisions.filter((row) => row.deployed_event_id === event.id).map((row) => (
              <p key={String(row.id)} className="text-[11px] text-[var(--ef-text-secondary)]">
                Decision v{String(row.decision_version)}: <span className="font-medium">{DECISION_LABEL[String(row.decision)]}</span>
                {' · '}{when(row.decided_at)} — {String(row.rationale)}
              </p>
            ))}
            {state.completedSnapshot && state.allowedDecisions.length > 0 ? (
              <div className="flex flex-wrap items-center gap-2 text-[11px]">
                <select aria-label="Decision" value={draft.value}
                  onChange={(changed) => setDecision({ ...decision, [key]: { ...draft, value: changed.target.value } })}
                  className="rounded border border-[var(--ef-border-subtle)] bg-transparent px-1">
                  {state.allowedDecisions.map((option) => <option key={option} value={option}>{DECISION_LABEL[option]}</option>)}
                </select>
                <input aria-label="Decision rationale" value={draft.rationale} maxLength={4000}
                  onChange={(changed) => setDecision({ ...decision, [key]: { ...draft, rationale: changed.target.value } })}
                  className="min-w-64 flex-1 rounded border border-[var(--ef-border-subtle)] bg-transparent px-1" />
                <button type="button" disabled={busy || !draft.value || !draft.rationale.trim()}
                  onClick={() => void act('/api/internal/improvement-lifecycle/measurement-decisions', {
                    snapshotId: state.completedSnapshot!.id, expectedDecisionVersion: state.latestDecisionVersion,
                    decision: draft.value, rationale: draft.rationale })}
                  className="rounded border border-[var(--ef-border-subtle)] px-2 py-0.5 text-[var(--ef-text-secondary)]">
                  Record decision
                </button>
              </div>
            ) : null}
            {state.successor ? (
              <p className="text-[11px] text-[var(--ef-text-secondary)]">
                Successor submission <span className="font-mono">{short(state.successor.successor_submission_id, 8)}</span> re-entered triage.
              </p>
            ) : null}
            {state.successorMissing ? (
              <button type="button" disabled={busy}
                onClick={() => void act('/api/internal/improvement-lifecycle/recurrence-successors',
                  { decisionId: state.latestDecision!.id })}
                className="rounded border border-[var(--ef-border-subtle)] px-2 py-0.5 text-[11px] text-[var(--ef-text-secondary)]">
                Re-submit current signal as successor
              </button>
            ) : null}
          </div>
        );
      })}
    </section>
  );
}
