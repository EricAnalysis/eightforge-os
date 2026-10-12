'use client';

// Improvement signal triage (B8.3c).
//
// Deliberately narrow: the recent submissions, each with its latest triage and
// a form to record the next one. Authority is the existing platform-review
// allowlist, decided by the server on every request; this page only reflects
// it. Recording a triage executes nothing: routing to engineering makes a
// signal eligible for the existing Plan V2 path, nothing more. Routing records
// the Plan V2 classification the reviewer chooses; nothing derives it (B8.3d).
// The analysis control is the existing one; it never approves or projects.
// B8.4d: each submission also shows its recorded lifecycle and measurement
// evidence, with the human actions B8.4 defines (attest, measure, decide).

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

import ImprovementLifecyclePanel from '@/components/platform/ImprovementLifecyclePanel';
import RepositoryPlanRunControl from '@/components/platform/RepositoryPlanRunControl';
import {
  TRIAGE_CAPABILITY_SCOPES,
  TRIAGE_DISPOSITIONS,
  TRIAGE_PLAN_CLASSIFICATIONS,
  TRIAGE_SEMANTICS_DEFECT_CLASSES,
  triageRequiresDefectClass,
  triageRequiresPlanClassification,
  triageRequiresScope,
  triageShapeError,
  type TriageDisposition,
  type TriagePlanClassification,
} from '@/lib/improvementSignalTriageContract';
import { redirectIfUnauthorized } from '@/lib/redirectIfUnauthorized';
import { supabase } from '@/lib/supabaseClient';

type Payload = {
  counts?: { occurrences?: number; documents?: number; projects?: number };
  recordRefs?: string[];
  catalogueFingerprint?: string | null;
};
type QueueRow = {
  submissionId: string;
  organizationId: string;
  signalKind: string;
  signalCode: string;
  payload: Payload;
  readBounds: { projectsTruncated?: boolean; overridesTruncated?: boolean };
  submittedAt: string;
  latestTriage: {
    triageReviewId: string;
    triageVersion: number;
    disposition: TriageDisposition;
    capabilityScope: string | null;
    semanticsDefectClass: string | null;
    planClassification: TriagePlanClassification | null;
    rationale: string;
    reviewedAt: string;
  } | null;
  awaitingTriage: boolean;
};

type LoadState =
  | { kind: 'loading' }
  | { kind: 'forbidden' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; rows: QueueRow[]; token: string };

const LABEL: Record<string, string> = {
  route_to_engineering: 'Route to engineering',
  customer_config_or_mapping: 'Customer config or mapping',
  reject: 'Reject',
  defer: 'Defer',
  client_specific: 'Client-specific',
  workflow_specific: 'Workflow-specific',
  reusable_platform_capability: 'Reusable platform capability',
  wording_defect: 'Wording defect',
  rule_logic_defect: 'Rule-logic defect',
};

async function accessToken(): Promise<string | null> {
  const { data: { session } } = await supabase.auth.getSession();
  return session?.access_token ?? null;
}

function TriageForm({ row, onRecorded }: { row: QueueRow; onRecorded: () => void }) {
  const router = useRouter();
  const [disposition, setDisposition] = useState<TriageDisposition>('route_to_engineering');
  const [scope, setScope] = useState('');
  const [defectClass, setDefectClass] = useState('');
  const [planClassification, setPlanClassification] = useState('');
  const [rationale, setRationale] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const needsScope = triageRequiresScope(disposition);
  const needsClass = triageRequiresDefectClass(row.signalKind, disposition);
  const needsPlan = triageRequiresPlanClassification(disposition);

  async function submit() {
    const capabilityScope = needsScope ? scope || null : null;
    const semanticsDefectClass = needsClass ? defectClass || null : null;
    const plan = needsPlan ? planClassification || null : null;
    const shape = triageShapeError({ signalKind: row.signalKind, disposition, capabilityScope, semanticsDefectClass,
      planClassification: plan });
    if (shape) { setError(shape.replaceAll('_', ' ')); return; }
    if (!rationale.trim()) { setError('rationale required'); return; }
    setSaving(true);
    setError(null);
    try {
      const token = await accessToken();
      if (!token) { router.replace('/login'); return; }
      const response = await fetch('/api/internal/improvement-signals/triage', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          submissionId: row.submissionId,
          expectedTriageVersion: row.latestTriage?.triageVersion ?? 0,
          disposition, capabilityScope, semanticsDefectClass, planClassification: plan, rationale,
        }),
      });
      if (redirectIfUnauthorized(response, router.replace)) return;
      if (response.status === 409) { setError('Someone triaged this since you loaded it. Reload and review again.'); return; }
      if (!response.ok) { setError(`Triage not recorded (${response.status}).`); return; }
      onRecorded();
    } catch {
      setError('Triage not recorded.');
    } finally {
      setSaving(false);
    }
  }

  const select = 'w-full rounded border border-[var(--ef-border-subtle)] bg-transparent p-1.5 text-xs text-[var(--ef-text-primary)]';
  return (
    <div className="mt-3 grid gap-2 border-t border-[var(--ef-border-subtle)] pt-3 sm:grid-cols-3">
      <select aria-label="disposition" className={select} value={disposition}
        onChange={(event) => setDisposition(event.target.value as TriageDisposition)}>
        {TRIAGE_DISPOSITIONS.map((value) => <option key={value} value={value}>{LABEL[value]}</option>)}
      </select>
      {needsScope ? (
        <select aria-label="capability scope" className={select} value={scope} onChange={(event) => setScope(event.target.value)}>
          <option value="">Scope (required)</option>
          {TRIAGE_CAPABILITY_SCOPES.map((value) => <option key={value} value={value}>{LABEL[value]}</option>)}
        </select>
      ) : <span />}
      {needsClass ? (
        <select aria-label="semantics defect class" className={select} value={defectClass}
          onChange={(event) => setDefectClass(event.target.value)}>
          <option value="">Defect class (required)</option>
          {TRIAGE_SEMANTICS_DEFECT_CLASSES.map((value) => <option key={value} value={value}>{LABEL[value]}</option>)}
        </select>
      ) : <span />}
      {needsPlan ? (
        <select aria-label="plan classification" className={select} value={planClassification}
          onChange={(event) => setPlanClassification(event.target.value)}>
          <option value="">Plan classification (required)</option>
          {TRIAGE_PLAN_CLASSIFICATIONS.map((value) => <option key={value} value={value}>{value}</option>)}
        </select>
      ) : null}
      <textarea aria-label="rationale" rows={2} maxLength={4000} value={rationale}
        onChange={(event) => setRationale(event.target.value)}
        placeholder="Rationale (required; immutable, stays platform-local)"
        className="rounded border border-[var(--ef-border-subtle)] bg-transparent p-2 text-xs text-[var(--ef-text-primary)] sm:col-span-3" />
      <div className="flex items-center gap-3 sm:col-span-3">
        <button type="button" disabled={saving} onClick={() => void submit()}
          className="rounded-md border border-[var(--ef-purple-primary-a40)] px-3 py-1.5 text-xs text-[var(--ef-text-primary)] hover:border-[var(--ef-purple-primary)] disabled:opacity-50">
          {saving ? 'Recording…' : row.latestTriage ? 'Record re-triage' : 'Record triage'}
        </button>
        {error ? <span className="text-xs text-[var(--ef-critical)]">{error}</span> : null}
      </div>
    </div>
  );
}

export default function ImprovementSignalTriagePage() {
  const router = useRouter();
  const [state, setState] = useState<LoadState>({ kind: 'loading' });

  const load = useCallback(async () => {
    setState({ kind: 'loading' });
    const token = await accessToken();
    if (!token) { router.replace('/login'); return; }
    try {
      const response = await fetch('/api/internal/improvement-signals/triage-queue', {
        headers: { authorization: `Bearer ${token}` },
      });
      if (redirectIfUnauthorized(response, router.replace)) return;
      if (response.status === 403) { setState({ kind: 'forbidden' }); return; }
      if (!response.ok) { setState({ kind: 'error', message: `Queue unavailable (${response.status}).` }); return; }
      const body = await response.json() as { rows?: QueueRow[] };
      setState({ kind: 'ready', rows: body.rows ?? [], token });
    } catch {
      setState({ kind: 'error', message: 'Queue unavailable.' });
    }
  }, [router]);

  useEffect(() => { void load(); }, [load]);

  return (
    <div className="space-y-6 p-6">
      <header className="space-y-2">
        <h1 className="text-lg font-semibold text-[var(--ef-text-primary)]">Improvement signal triage</h1>
        <p className="max-w-3xl text-sm text-[var(--ef-text-muted)]">
          Friction signals organizations submitted, as allowlisted metadata only. Triage decides where each goes;
          it executes nothing. Routing to engineering makes a signal eligible for repository planning and
          engineering review.
        </p>
      </header>

      {state.kind === 'loading' && <p className="text-sm text-[var(--ef-text-muted)]">Loading queue…</p>}
      {state.kind === 'forbidden' && (
        <div className="rounded-md border border-[var(--ef-border-subtle)] bg-[var(--ef-background-panel)] p-4">
          <p className="text-sm font-medium text-[var(--ef-text-primary)]">Review access required</p>
          <p className="mt-1 text-xs text-[var(--ef-text-muted)]">Triage requires platform review access.</p>
        </div>
      )}
      {state.kind === 'error' && (
        <div className="rounded-md border border-[var(--ef-critical-a)] bg-[var(--ef-critical-bg)] p-4">
          <p className="text-sm text-[var(--ef-text-primary)]">{state.message}</p>
          <button type="button" onClick={() => void load()}
            className="mt-2 rounded border border-[var(--ef-border-subtle)] px-2 py-1 text-xs text-[var(--ef-text-secondary)]">
            Retry
          </button>
        </div>
      )}
      {state.kind === 'ready' && state.rows.length === 0 && (
        <div className="rounded-md border border-[var(--ef-border-subtle)] bg-[var(--ef-background-panel)] p-6">
          <p className="text-sm text-[var(--ef-text-primary)]">No signals submitted.</p>
        </div>
      )}
      {state.kind === 'ready' && state.rows.length > 0 && (
        <ul className="space-y-3">
          {state.rows.map((row) => (
            <li key={row.submissionId} className="rounded-md border border-[var(--ef-border-subtle)] bg-[var(--ef-background-panel)] p-4">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-[var(--ef-text-primary)]">
                    <span className="font-mono">{row.signalCode}</span>
                    <span className="ml-2 text-xs font-normal text-[var(--ef-text-muted)]">{row.signalKind}</span>
                  </p>
                  <p className="mt-1 text-[11px] text-[var(--ef-text-faint)]">
                    Organization <span className="font-mono">{row.organizationId}</span> · Submitted {new Date(row.submittedAt).toLocaleString()}
                  </p>
                </div>
                <span className="shrink-0 rounded border border-[var(--ef-border-subtle)] px-2 py-0.5 text-[11px] text-[var(--ef-text-secondary)]">
                  {row.latestTriage ? `${LABEL[row.latestTriage.disposition]} (v${row.latestTriage.triageVersion})` : 'Awaiting triage'}
                </span>
              </div>
              <div className="mt-3 flex flex-wrap gap-4 text-[11px] text-[var(--ef-text-muted)]">
                <span>{row.payload.counts?.occurrences ?? 0} occurrences</span>
                <span>{row.payload.counts?.documents ?? 0} documents</span>
                <span>{row.payload.counts?.projects ?? 0} projects</span>
                <span>{row.payload.recordRefs?.length ?? 0} record refs</span>
                {row.readBounds.projectsTruncated || row.readBounds.overridesTruncated
                  ? <span className="text-[var(--ef-warning-soft)]">read truncated: counts may be low</span> : null}
              </div>
              {row.latestTriage ? (
                <p className="mt-2 text-xs text-[var(--ef-text-secondary)]">
                  {[row.latestTriage.capabilityScope, row.latestTriage.semanticsDefectClass]
                    .filter(Boolean).map((value) => LABEL[value as string])
                    .concat(row.latestTriage.planClassification ? [`Plan ${row.latestTriage.planClassification}`] : [])
                    .join(' · ')}
                  {row.latestTriage.capabilityScope || row.latestTriage.semanticsDefectClass ? ' — ' : ''}
                  {row.latestTriage.rationale}
                </p>
              ) : null}
              {row.latestTriage?.disposition === 'route_to_engineering' && row.latestTriage.planClassification ? (
                <div className="mt-3">
                  <RepositoryPlanRunControl accessToken={state.token} request={{
                    triageReviewId: row.latestTriage.triageReviewId,
                    triageVersion: row.latestTriage.triageVersion,
                    classification: row.latestTriage.planClassification,
                  }} />
                </div>
              ) : null}
              <ImprovementLifecyclePanel submissionId={row.submissionId} accessToken={state.token} />
              <TriageForm row={row} onRecorded={() => void load()} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
