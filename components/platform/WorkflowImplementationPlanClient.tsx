'use client';

import React, { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePlatformSessionToken } from '@/components/platform/PlatformSessionContext';
import WorkflowImplementationPlanView from '@/components/platform/WorkflowImplementationPlanView';
import { ImplementationPlanPinSchema, ImplementationPlanResponseSchema, type BrowserSafeImplementationPlan, type ImplementationPlanPin, type ImplementationPlanFailureCode } from '@/lib/workflowImplementationPlanWire';

export type PlanDisplayState = { kind: 'loading' } | { kind: 'ready'; plan: BrowserSafeImplementationPlan } | { kind: 'error'; category: keyof typeof errorMessages };
export const errorMessages = {
  unauthenticated: 'Sign in to view this implementation plan.',
  forbidden: 'Viewing implementation plans requires platform review access.',
  invalid_pin: 'Invalid plan link. The complete exact assessment and review identity is required.',
  unavailable: 'The exact requested assessment or review version is unavailable.',
  historical: 'This historical review is incompatible with Implementation Plan V1.',
  incompatible: 'Incompatible response. No implementation plan can be displayed.',
  server: 'The implementation plan is currently unavailable. Retry this same review pin.',
};

export function parsePlanPin(assessmentId: string, query: string): ImplementationPlanPin | null {
  const values = new URLSearchParams(query);
  const names = ['assessmentVersion', 'reviewId', 'reviewVersion'];
  if ([...values.keys()].some((key) => !names.includes(key)) || names.some((key) => values.getAll(key).length !== 1)) return null;
  const assessmentVersion = values.get('assessmentVersion')!;
  const reviewVersion = values.get('reviewVersion')!;
  if (!/^[1-9][0-9]*$/.test(assessmentVersion) || !/^[1-9][0-9]*$/.test(reviewVersion)) return null;
  const result = ImplementationPlanPinSchema.safeParse({ assessmentId, assessmentVersion: Number(assessmentVersion), reviewId: values.get('reviewId'), reviewVersion: Number(reviewVersion) });
  return result.success ? result.data : null;
}

function expectedFailure(code: ImplementationPlanFailureCode): { status: number; category: keyof typeof errorMessages } {
  switch (code) {
    case 'unauthorized': return { status: 401, category: 'unauthenticated' };
    case 'reviewer_not_eligible': return { status: 403, category: 'forbidden' };
    case 'invalid_pin': return { status: 400, category: 'invalid_pin' };
    case 'assessment_not_found': case 'review_not_found': return { status: 404, category: 'unavailable' };
    case 'not_configured': return { status: 503, category: 'server' };
    case 'plan_not_composable': case 'read_failed': return { status: 500, category: 'server' };
    case 'invalid_json': case 'invalid_evidence': case 'assessment_pin_mismatch': case 'review_pin_mismatch':
    case 'source_submission_mismatch': case 'step_review_parent_mismatch': case 'duplicate_step_review': case 'orphan_step_review':
    case 'missing_step_review': case 'classification_mismatch': case 'incoherent_disposition': case 'proposal_not_composable':
    case 'invalid_specification': case 'overall_disposition_mismatch': return { status: 422, category: 'historical' };
    default: {
      const exhaustive: never = code;
      throw new Error(`Unhandled implementation plan failure code: ${exhaustive}`);
    }
  }
}

export async function requestImplementationPlan(pin: ImplementationPlanPin, token: string, signal: AbortSignal, fetcher: typeof fetch = fetch): Promise<PlanDisplayState> {
  try {
    const query = new URLSearchParams({ assessmentVersion: String(pin.assessmentVersion), reviewId: pin.reviewId, reviewVersion: String(pin.reviewVersion) });
    const response = await fetcher(`/api/internal/workflow-assessments/${encodeURIComponent(pin.assessmentId)}/implementation-plan?${query}`, { method: 'GET', headers: { authorization: `Bearer ${token}` }, cache: 'no-store', signal });
    let json: unknown;
    try { json = await response.json(); } catch { return { kind: 'error', category: 'incompatible' }; }
    const parsed = ImplementationPlanResponseSchema.safeParse(json);
    if (!parsed.success) return { kind: 'error', category: 'incompatible' };
    const body = parsed.data;
    if (!body.ok) {
      const expected = expectedFailure(body.error);
      return { kind: 'error', category: response.status === expected.status ? expected.category : 'incompatible' };
    }
    if (response.status !== 200) return { kind: 'error', category: 'incompatible' };
    const returned = body.plan.source.pin;
    if (pin.assessmentId !== returned.assessmentId || pin.assessmentVersion !== returned.assessmentVersion || pin.reviewId !== returned.reviewId || pin.reviewVersion !== returned.reviewVersion) return { kind: 'error', category: 'incompatible' };
    return { kind: 'ready', plan: body.plan };
  } catch { return { kind: 'error', category: 'server' }; }
}

export type PlanSnapshot = { key: string; token: string; state: PlanDisplayState };

/** Used by the component as well as race tests; abort alone is insufficient for already-resolved promises. */
export function createPlanRequestController(emit: (snapshot: PlanSnapshot) => void, fetcher: typeof fetch = fetch) {
  let generation = 0;
  let active: AbortController | undefined;
  return {
    cancel() { generation += 1; active?.abort(); },
    async run(key: string, pin: ImplementationPlanPin, token: string) {
      active?.abort();
      const controller = new AbortController();
      active = controller;
      const requestGeneration = ++generation;
      emit({ key, token, state: { kind: 'loading' } });
      const state = await requestImplementationPlan(pin, token, controller.signal, fetcher);
      if (requestGeneration !== generation || controller.signal.aborted) return;
      emit({ key, token, state });
    },
  };
}

// Synchronous gating prevents an old plan flashing before the new effect starts.
export function visiblePlanState(snapshot: PlanSnapshot | null, key: string, token: string | null, pin: ImplementationPlanPin | null): PlanDisplayState {
  if (!pin) return { kind: 'error', category: 'invalid_pin' };
  if (!token) return { kind: 'error', category: 'unauthenticated' };
  return snapshot?.key === key && snapshot.token === token ? snapshot.state : { kind: 'loading' };
}

export function PlanStatus({ state, retry }: { state: Exclude<PlanDisplayState, { kind: 'ready' }>; retry: () => void }) {
  if (state.kind === 'loading') return <p role="status">Loading implementation plan…</p>;
  return <div role="alert" className="space-y-3"><p>{errorMessages[state.category]}</p>
    {state.category === 'unauthenticated' && <Link href="/login" className="underline">Sign in</Link>}
    {['server', 'historical', 'incompatible'].includes(state.category) && <button type="button" onClick={retry} className="rounded border border-[var(--ef-border-subtle)] px-3 py-2 text-sm">Retry same review</button>}
  </div>;
}

export default function WorkflowImplementationPlanClient({ assessmentId, query }: { assessmentId: string; query: string }) {
  const token = usePlatformSessionToken();
  const [snapshot, setSnapshot] = useState<PlanSnapshot | null>(null);
  const [retry, setRetry] = useState(0);
  const controller = useRef<ReturnType<typeof createPlanRequestController> | null>(null);
  if (controller.current === null) controller.current = createPlanRequestController(setSnapshot);
  const key = JSON.stringify([assessmentId, query]);
  const pin = parsePlanPin(assessmentId, query);
  useEffect(() => {
    const requests = controller.current!;
    const requestedPin = parsePlanPin(assessmentId, query);
    if (requestedPin && token) void requests.run(key, requestedPin, token);
    return () => requests.cancel();
  }, [assessmentId, query, key, token, retry]);
  const state = visiblePlanState(snapshot, key, token, pin);
  return <div data-testid="implementation-plan-surface" className="mx-auto max-w-5xl space-y-6 p-6 text-[var(--ef-text-primary)]">
    <header className="space-y-4"><Link href="/platform/workflows/reviews" className="text-sm text-[var(--ef-text-muted)] hover:underline">← Review queue</Link>
      <h1 className="text-xl font-semibold">Deterministic Implementation Plan V1</h1>
      <div className="rounded-md border border-[var(--ef-warning-a)] bg-[var(--ef-warning-bg)] p-4">
        <p className="font-medium">Non-authoritative · Not executable · Does not grant execution authority</p>
        <p className="mt-2 text-sm">Specification complete does not authorize execution.</p>
      </div>
    </header>
    {state.kind === 'ready' ? <WorkflowImplementationPlanView plan={state.plan} /> : <PlanStatus state={state} retry={() => setRetry((value) => value + 1)} />}
  </div>;
}
