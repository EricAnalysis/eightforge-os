'use client';

import { startTransition, useState, type FormEvent } from 'react';
import { ProjectQueryResultCard } from '@/components/ask/ProjectQueryResultCard';
import type { ProjectQueryContext } from '@/lib/projectQuery/executeProjectQuery';
import { runAskThisProjectQueryWithLogging } from '@/lib/projectQuery/runClientQuery';
import type { ProjectQueryResult } from '@/lib/projectQuery/types';

type AskInterfaceProps = {
  projectId: string;
  title?: string;
  context?: ProjectQueryContext;
};

export function AskInterface({
  projectId,
  title = 'Ask This Project',
  context,
}: AskInterfaceProps) {
  const [draft, setDraft] = useState('');
  const [result, setResult] = useState<ProjectQueryResult | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submitQuestion(question: string) {
    const trimmed = question.trim();
    if (!trimmed) return;

    setPending(true);
    setError(null);
    setResult(null);
    try {
      const next = await runAskThisProjectQueryWithLogging({ projectId, input: trimmed, context });
      setResult(next);
    } catch {
      setError('Query failed');
    } finally {
      setPending(false);
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    startTransition(() => {
      void submitQuestion(draft);
    });
  }

  return (
    <div className="rounded-xl border border-[var(--ef-border-subtle-a70)] bg-[var(--ef-background-primary)]">
      <div className="flex items-center justify-between border-b border-[var(--ef-border-subtle-a60)] px-5 py-3">
        <h3 className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--ef-text-muted)]">
          {title}
        </h3>
        <span className="text-[10px] uppercase tracking-[0.16em] text-[var(--ef-text-faint)]">
          Single-shot query
        </span>
      </div>

      <div className="space-y-3 px-5 py-4">
        <p className="text-[11px] text-[var(--ef-text-muted)]">
          One query, one result. Prior output is replaced each time.
        </p>

        <form onSubmit={handleSubmit} className="space-y-2">
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="contract ceiling · invoice 2026-003 · rate 6A · signal approval blockers"
              className="min-w-0 flex-1 rounded-lg border border-[var(--ef-border-subtle)] bg-[var(--ef-background-secondary)] px-3 py-2.5 text-sm text-[var(--ef-text-primary)] outline-none placeholder:text-[var(--ef-text-faint)] focus:border-[var(--ef-purple-primary-a50)]"
            />
            <button
              type="submit"
              disabled={pending || draft.trim().length === 0}
              className="rounded-lg border border-[var(--ef-purple-primary-a50)] bg-[var(--ef-purple-primary-a12)] px-4 py-2.5 text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--ef-purple-glow)] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {pending ? 'Running' : 'Ask'}
            </button>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {(['contract ceiling', '/signal blockers', 'list blocked documents'] as const).map((example) => (
              <button
                key={example}
                type="button"
                disabled={pending}
                onClick={() => {
                  setDraft(example);
                  startTransition(() => {
                    void submitQuestion(example);
                  });
                }}
                className="rounded border border-[var(--ef-border-subtle-a60)] bg-[var(--ef-background-secondary)] px-2 py-0.5 font-mono text-[10px] text-[var(--ef-text-faint)] transition hover:border-[var(--ef-purple-primary-a40)] hover:text-[var(--ef-purple-glow)] disabled:cursor-not-allowed disabled:opacity-40"
              >
                {example}
              </button>
            ))}
          </div>
          <p className="text-[10px] text-[var(--ef-text-faint)]">
            Sources: structured extracted facts, validator findings, decisions, then project documents (precedence applied when sources conflict).
          </p>
        </form>

        {error ? (
          <div className="rounded-lg border border-[var(--ef-critical-a40)] bg-[var(--ef-critical-bg)] px-3 py-2 text-[11px] text-[var(--ef-critical-soft)]">
            {error}
          </div>
        ) : null}

        {result ? <ProjectQueryResultCard result={result} /> : null}
      </div>
    </div>
  );
}
