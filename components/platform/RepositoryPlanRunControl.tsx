'use client';

import { useEffect, useRef, useState } from 'react';

import {
  RepositoryPlanRunCreatedResponseSchema,
  RepositoryPlanRunReadResponseSchema,
  type RepositoryPlanRunRequest,
} from '@/lib/repositoryPlanRunWire';

export type RepositoryPlanRunDisplayState =
  | Readonly<{ kind: 'ready' }>
  | Readonly<{ kind: 'queueing' }>
  | Readonly<{ kind: 'queued'; jobId: string }>
  | Readonly<{ kind: 'analyzing'; jobId: string }>
  | Readonly<{ kind: 'complete'; jobId: string; planV2RunId: string; planV2DigestSha256: string }>
  | Readonly<{ kind: 'failed'; jobId: string | null }>
  | Readonly<{ kind: 'unavailable'; jobId: string }>;

async function json(response: Response): Promise<unknown> {
  try { return await response.json(); } catch { return null; }
}

export async function requestRepositoryPlanRun(
  request: RepositoryPlanRunRequest,
  token: string,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<Readonly<{ ok: true; jobId: string }> | Readonly<{ ok: false }>> {
  try {
    const response = await fetcher('/api/internal/repository-plan-runs', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(request),
      cache: 'no-store',
      signal,
    });
    const parsed = RepositoryPlanRunCreatedResponseSchema.safeParse(await json(response));
    return response.status === 201 && parsed.success
      && parsed.data.job.classification === request.classification
      ? { ok: true, jobId: parsed.data.job.jobId }
      : { ok: false };
  } catch { return { ok: false }; }
}

export async function readRepositoryPlanRun(
  jobId: string,
  token: string,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
  expectedClassification?: RepositoryPlanRunRequest['classification'],
): Promise<RepositoryPlanRunDisplayState> {
  try {
    const response = await fetcher(`/api/internal/repository-plan-runs/${encodeURIComponent(jobId)}`, {
      method: 'GET', headers: { authorization: `Bearer ${token}` }, cache: 'no-store', signal,
    });
    const parsed = RepositoryPlanRunReadResponseSchema.safeParse(await json(response));
    if (response.status !== 200 || !parsed.success || !parsed.data.ok || parsed.data.job.jobId !== jobId
      || (expectedClassification !== undefined && parsed.data.job.classification !== expectedClassification)) {
      return { kind: 'failed', jobId };
    }
    const job = parsed.data.job;
    if (job.status === 'pending') return { kind: 'queued', jobId };
    if (job.status === 'claimed') return { kind: 'analyzing', jobId };
    if (job.status === 'failed') {
      return job.failureCode === 'provider_disabled'
        ? { kind: 'unavailable', jobId }
        : { kind: 'failed', jobId };
    }
    return { kind: 'complete', jobId, planV2RunId: job.result.planV2RunId,
      planV2DigestSha256: job.result.planV2DigestSha256 };
  } catch { return { kind: 'failed', jobId }; }
}

export async function pollRepositoryPlanRun(
  jobId: string,
  token: string,
  signal: AbortSignal,
  expectedClassification: RepositoryPlanRunRequest['classification'],
  emit: (state: RepositoryPlanRunDisplayState) => void,
  dependencies: Readonly<{
    fetcher?: typeof fetch;
    wait?: (milliseconds: number) => Promise<void>;
    shouldContinue?: () => boolean;
  }> = {},
): Promise<void> {
  const wait = dependencies.wait ?? ((milliseconds: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const shouldContinue = dependencies.shouldContinue ?? (() => true);
  while (!signal.aborted && shouldContinue()) {
    await wait(2_500);
    if (signal.aborted || !shouldContinue()) return;
    const next = await readRepositoryPlanRun(jobId, token, signal,
      dependencies.fetcher ?? fetch, expectedClassification);
    if (signal.aborted || !shouldContinue()) return;
    emit(next);
    if (next.kind !== 'queued' && next.kind !== 'analyzing') return;
  }
}

const labels: Record<RepositoryPlanRunDisplayState['kind'], string> = {
  ready: 'Ready', queueing: 'Queuing…', queued: 'Queued', analyzing: 'Analyzing',
  complete: 'Analysis complete', failed: 'Analysis failed', unavailable: 'Forgewing unavailable',
};

export default function RepositoryPlanRunControl({ request, accessToken }: {
  request: RepositoryPlanRunRequest;
  accessToken: string;
}) {
  const [state, setState] = useState<RepositoryPlanRunDisplayState>({ kind: 'ready' });
  const generation = useRef(0);
  const active = useRef<AbortController | null>(null);

  useEffect(() => () => {
    generation.current += 1;
    active.current?.abort();
  }, [accessToken, request.assessmentId, request.assessmentVersion, request.reviewId,
    request.reviewVersion, request.classification]);

  async function run(): Promise<void> {
    generation.current += 1;
    const current = generation.current;
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    setState({ kind: 'queueing' });
    const created = await requestRepositoryPlanRun(request, accessToken, controller.signal);
    if (current !== generation.current || controller.signal.aborted) return;
    if (!created.ok) { setState({ kind: 'failed', jobId: null }); return; }
    setState({ kind: 'queued', jobId: created.jobId });
    await pollRepositoryPlanRun(created.jobId, accessToken, controller.signal, request.classification,
      setState, { shouldContinue: () => current === generation.current });
  }

  return <section className="space-y-3 rounded-md border border-[var(--ef-border-subtle)] bg-[var(--ef-background-panel)] p-4" aria-label="Forgewing repository analysis">
    <div><h2 className="font-semibold">Forgewing repository analysis</h2>
      <p className="mt-1 text-sm text-[var(--ef-text-secondary)]">Forgewing suggests. Human decides. Analysis is non-authoritative and never approves, executes, or projects to Linear.</p></div>
    <p className="text-sm">Classification: <span className="font-mono">{request.classification}</span></p>
    <p role="status">{labels[state.kind]}</p>
    {(state.kind === 'ready' || state.kind === 'failed' || state.kind === 'unavailable')
      && <button type="button" onClick={() => void run()} className="rounded border border-[var(--ef-border-subtle)] px-3 py-2 text-sm">Run Forgewing analysis</button>}
    {state.kind === 'complete' && <div className="text-sm"><p>Exact persisted Plan V2 selected.</p>
      <p className="font-mono text-xs">Run {state.planV2RunId}</p>
      <p className="break-all font-mono text-xs">Digest {state.planV2DigestSha256}</p></div>}
  </section>;
}
