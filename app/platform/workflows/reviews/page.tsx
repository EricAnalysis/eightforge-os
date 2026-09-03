'use client';

// Pending Workflow Assessment review queue.
//
// Deliberately narrow: enough to answer "what needs review?" and nothing more.
// No search, assignment, dashboards, pagination machinery, or analytics.
//
// Reviewability is derived server-side from immutable evidence — an assessment
// is listed exactly when no review exists for that precise version — so there is
// no client-side notion of "pending" that could drift.

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

import { redirectIfUnauthorized } from '@/lib/redirectIfUnauthorized';
import { supabase } from '@/lib/supabaseClient';

type QueueRow = {
  assessmentId: string;
  assessmentVersion: number;
  sourceSubmissionId: string;
  createdAt: string;
  summary: string | null;
  stepCount: number;
  groundedUnverifiedCount: number;
  stepsWithGapsCount: number;
  humanDecisionCount: number;
};

type LoadState =
  | { kind: 'loading' }
  | { kind: 'forbidden' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; rows: QueueRow[] };

function formatDate(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? '—' : parsed.toLocaleString();
}

export default function WorkflowReviewQueuePage() {
  const router = useRouter();
  const [state, setState] = useState<LoadState>({ kind: 'loading' });

  const load = useCallback(async () => {
    setState({ kind: 'loading' });
    const { data: { session } } = await supabase.auth.getSession();
    const token = session?.access_token;
    if (!token) {
      router.replace('/login');
      return;
    }

    try {
      const response = await fetch('/api/internal/workflow-assessments/review-queue', {
        headers: { authorization: `Bearer ${token}` },
      });
      if (redirectIfUnauthorized(response, router.replace)) return;
      if (response.status === 403) {
        setState({ kind: 'forbidden' });
        return;
      }
      if (!response.ok) {
        setState({ kind: 'error', message: `Queue unavailable (${response.status}).` });
        return;
      }
      const body = await response.json() as { rows?: QueueRow[] };
      setState({ kind: 'ready', rows: body.rows ?? [] });
    } catch {
      setState({ kind: 'error', message: 'Queue unavailable.' });
    }
  }, [router]);

  useEffect(() => { void load(); }, [load]);

  return (
    <div className="space-y-6 p-6">
      <header className="space-y-2">
        <h1 className="text-lg font-semibold text-[var(--ef-text-primary)]">
          Workflow Assessment review
        </h1>
        <p className="max-w-3xl text-sm text-[var(--ef-text-muted)]">
          Assessments awaiting operator review. Each is a non-authoritative proposal:
          reviewing one records a specification decision and does not enable, deploy,
          or execute anything.
        </p>
      </header>

      {state.kind === 'loading' && (
        <p className="text-sm text-[var(--ef-text-muted)]">Loading queue…</p>
      )}

      {state.kind === 'forbidden' && (
        <div className="rounded-md border border-[var(--ef-border-subtle)] bg-[var(--ef-background-panel)] p-4">
          <p className="text-sm font-medium text-[var(--ef-text-primary)]">
            Review access required
          </p>
          <p className="mt-1 text-xs text-[var(--ef-text-muted)]">
            Reviewing workflow assessments requires platform review access.
          </p>
        </div>
      )}

      {state.kind === 'error' && (
        <div className="rounded-md border border-[var(--ef-critical-a)] bg-[var(--ef-critical-bg)] p-4">
          <p className="text-sm text-[var(--ef-text-primary)]">{state.message}</p>
          <button
            type="button"
            onClick={() => void load()}
            className="mt-2 rounded border border-[var(--ef-border-subtle)] px-2 py-1 text-xs text-[var(--ef-text-secondary)]"
          >
            Retry
          </button>
        </div>
      )}

      {state.kind === 'ready' && state.rows.length === 0 && (
        <div className="rounded-md border border-[var(--ef-border-subtle)] bg-[var(--ef-background-panel)] p-6">
          <p className="text-sm text-[var(--ef-text-primary)]">Nothing awaiting review.</p>
          <p className="mt-1 text-xs text-[var(--ef-text-muted)]">
            Assessments appear here until every proposed step has been dispositioned.
          </p>
        </div>
      )}

      {state.kind === 'ready' && state.rows.length > 0 && (
        <ul className="space-y-3">
          {state.rows.map((row) => (
            <li
              key={`${row.assessmentId}:${row.assessmentVersion}`}
              className="rounded-md border border-[var(--ef-border-subtle)] bg-[var(--ef-background-panel)] p-4"
            >
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <Link
                    href={`/platform/workflows/reviews/${row.assessmentId}`}
                    className="text-sm font-semibold text-[var(--ef-text-primary)] hover:underline"
                  >
                    {row.summary ?? 'Untitled workflow assessment'}
                  </Link>
                  <p className="mt-1 text-[11px] text-[var(--ef-text-faint)]">
                    Version {row.assessmentVersion} · Recorded {formatDate(row.createdAt)}
                  </p>
                </div>
                <span className="shrink-0 rounded border border-[var(--ef-warning-a)] bg-[var(--ef-warning-bg)] px-2 py-0.5 text-[11px] text-[var(--ef-text-secondary)]">
                  Pending review
                </span>
              </div>

              <div className="mt-3 flex flex-wrap items-center gap-4 text-[11px] text-[var(--ef-text-muted)]">
                <span>
                  <span className="font-medium text-[var(--ef-text-primary)]">
                    {row.stepCount}
                  </span>{' '}
                  steps
                </span>
                <span title="Grounding traced to the intake; not yet confirmed by an operator">
                  <span className="font-medium text-[var(--ef-text-primary)]">
                    {row.groundedUnverifiedCount}
                  </span>{' '}
                  grounded, unverified
                </span>
                <span>
                  <span className="font-medium text-[var(--ef-text-primary)]">
                    {row.stepsWithGapsCount}
                  </span>{' '}
                  with gaps
                </span>
                <span>
                  <span className="font-medium text-[var(--ef-text-primary)]">
                    {row.humanDecisionCount}
                  </span>{' '}
                  human decisions
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
