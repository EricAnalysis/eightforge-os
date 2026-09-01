'use client';

// Entry point to the Workflow Assessment review queue, shown on the workflows
// hub.
//
// Deliberately a separate card rather than rows merged into the task list.
// A task is operational work to perform; an assessment review is a
// system-design decision to make. Mixing them would blur two different objects
// the moment either one grows.
//
// The card hides itself for anyone who cannot review. Eligibility is decided by
// the server on every request — hiding an entry point is a courtesy, not a
// control — so there is no reason to advertise a queue the operator would be
// refused at.

import { useEffect, useState } from 'react';
import Link from 'next/link';

import { supabase } from '@/lib/supabaseClient';

type CardState =
  | { kind: 'hidden' }
  | { kind: 'ready'; pending: number };

export function WorkflowReviewsCard() {
  const [state, setState] = useState<CardState>({ kind: 'hidden' });

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      if (!token) return;

      try {
        const response = await fetch('/api/internal/workflow-assessments/review-queue', {
          headers: { authorization: `Bearer ${token}` },
        });
        // 403 means this operator is not a reviewer; stay hidden rather than
        // offering a link that would refuse them.
        if (!response.ok || cancelled) return;
        const body = await response.json() as { rows?: unknown[] };
        if (!cancelled) {
          setState({ kind: 'ready', pending: body.rows?.length ?? 0 });
        }
      } catch {
        // A queue that cannot be reached is not worth an error on someone
        // else's page; the reviews surface reports its own failures.
      }
    })();

    return () => { cancelled = true; };
  }, []);

  if (state.kind === 'hidden') return null;

  return (
    <section className="flex flex-wrap items-center justify-between gap-4 rounded-md border border-[var(--ef-border-subtle)] bg-[var(--ef-background-panel)] p-4">
      <div className="min-w-0">
        <h2 className="mb-1 text-sm font-semibold text-[var(--ef-text-primary)]">
          Workflow Reviews
        </h2>
        <p className="text-xs text-[var(--ef-text-primary)]">
          {state.pending === 0
            ? 'No assessments waiting for review'
            : `${state.pending} assessment${state.pending === 1 ? '' : 's'} waiting for review`}
        </p>
        <p className="mt-0.5 text-[11px] text-[var(--ef-text-muted)]">
          Review Forgewing-generated workflow specifications.
        </p>
      </div>
      <Link
        href="/platform/workflows/reviews"
        className="shrink-0 rounded-md border border-[var(--ef-purple-primary-a40)] px-3 py-1.5 text-xs text-[var(--ef-text-primary)] hover:border-[var(--ef-purple-primary)]"
      >
        Review assessments →
      </Link>
    </section>
  );
}
