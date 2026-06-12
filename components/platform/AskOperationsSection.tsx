'use client';

import { useCallback, useMemo, useState, type FormEvent } from 'react';
import { AskOperationsResultCard } from '@/components/platform/AskOperationsResultCard';
import {
  buildAskOperationsQueryChips,
  type AskOperationsChip,
} from '@/lib/operationsQuery/askOperationsChips';
import { executeOperationsQuery } from '@/lib/operationsQuery/executeOperationsQuery';
import type { AskOperationsResult } from '@/lib/operationsQuery/types';
import type { OperationalQueueModel } from '@/lib/server/operationalQueue';

function chipButtonClass(severity: AskOperationsChip['severity']): string {
  const base =
    'shrink-0 rounded-full border px-3 py-1 text-[10px] font-medium leading-snug disabled:cursor-not-allowed disabled:opacity-50';
  if (severity === 'critical') {
    return `${base} border-[var(--ef-critical-a40)] bg-[var(--ef-critical-a10)] text-[var(--ef-critical-soft)] hover:border-[var(--ef-critical-a45)] hover:bg-[var(--ef-critical-a15)]`;
  }
  if (severity === 'warning') {
    return `${base} border-[var(--ef-warning-a35)] bg-[var(--ef-warning-bg)] text-[var(--ef-warning-soft)] hover:border-[var(--ef-warning-a40)] hover:bg-[var(--ef-warning-a18)]`;
  }
  return `${base} border-[var(--ef-border-subtle-a80)] bg-[var(--ef-background-secondary)] text-[var(--ef-purple-glow)] hover:border-[var(--ef-purple-primary-a40)] hover:bg-[var(--ef-surface-elevated)]`;
}

type AskOperationsSectionProps = {
  operationalModel: OperationalQueueModel | null;
  loading: boolean;
};

export function AskOperationsSection({ operationalModel, loading }: AskOperationsSectionProps) {
  const [draft, setDraft] = useState('');
  const [result, setResult] = useState<AskOperationsResult | null>(null);
  const [pending, setPending] = useState(false);

  const queryChips = useMemo(
    () => buildAskOperationsQueryChips(operationalModel, 5),
    [operationalModel],
  );

  const runQuery = useCallback(
    (raw: string) => {
      const trimmed = raw.trim();
      if (!trimmed) return;

      setPending(true);
      setResult(null);
      try {
        const next = executeOperationsQuery(trimmed, operationalModel);
        setResult(next);
      } finally {
        setPending(false);
      }
    },
    [operationalModel],
  );

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    runQuery(draft);
  }

  return (
    <section className="w-full rounded-2xl border border-[var(--ef-border-subtle-a80)] bg-[var(--ef-background-secondary)] p-5 shadow-[0_24px_90px_-64px_var(--ef-shadow-ambient)]">
      <div className="mb-3 flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.26em] text-[var(--ef-text-muted)]">
            Portfolio command
          </p>
          <h2 className="mt-1 text-[15px] font-semibold tracking-tight text-[var(--ef-text-primary)]">
            Ask Operations
          </h2>
          <p className="mt-1 max-w-3xl text-[11px] leading-relaxed text-[var(--ef-text-muted)]">
            Ask cross project operational questions and route to the right project, queue, or document.
          </p>
        </div>
      </div>

      <div className="mb-3 flex h-8 min-h-[32px] max-w-full flex-nowrap items-center gap-2 overflow-x-auto overflow-y-hidden">
        {queryChips.map((chip) => (
          <button
            key={chip.query}
            type="button"
            disabled={loading || pending}
            onClick={() => {
              setDraft(chip.query);
              runQuery(chip.query);
            }}
            className={chipButtonClass(chip.severity)}
          >
            {chip.query}
          </button>
        ))}
      </div>

      <form onSubmit={handleSubmit} className="space-y-2">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-stretch">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Cross-project operational question (one shot, no conversation history)"
            disabled={loading}
            className="min-h-[44px] min-w-0 flex-1 rounded-xl border border-[var(--ef-border-subtle)] bg-[var(--ef-background-secondary)] px-4 py-3 text-sm text-[var(--ef-text-primary)] outline-none placeholder:text-[var(--ef-text-faint)] focus:border-[var(--ef-purple-primary-a50)] disabled:opacity-60"
            aria-label="Ask Operations query"
          />
          <button
            type="submit"
            disabled={loading || pending || draft.trim().length === 0}
            className="shrink-0 rounded-xl border border-[var(--ef-purple-primary-a50)] bg-[var(--ef-purple-primary-a12)] px-6 py-3 text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--ef-purple-glow)] transition hover:bg-[var(--ef-purple-primary-a20)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {pending ? 'Running' : 'Ask'}
          </button>
        </div>
      </form>

      <p className="mt-3 text-[10px] leading-relaxed text-[var(--ef-text-faint)]">
        Ask Operations reads portfolio summaries, project rollups, decisions, actions, validator signals, and key
        project facts in that order.
      </p>

      {loading ? (
        <p className="mt-4 text-[11px] text-[var(--ef-text-muted)]">Loading operational data for portfolio queries…</p>
      ) : null}

      {!loading && result ? (
        <div className="mt-4">
          <AskOperationsResultCard result={result} />
        </div>
      ) : null}
    </section>
  );
}
