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
    <div className="rounded-xl border border-[#2F3B52]/70 bg-[#0F1117]">
      <div className="flex items-center justify-between border-b border-[#2F3B52]/60 px-5 py-3">
        <h3 className="text-xs font-semibold uppercase tracking-[0.18em] text-[#8B94A3]">
          {title}
        </h3>
        <span className="text-[10px] uppercase tracking-[0.16em] text-[#5B6578]">
          Single-shot query
        </span>
      </div>

      <div className="space-y-3 px-5 py-4">
        <p className="text-[11px] text-[#94A3B8]">
          One query, one result. Prior output is replaced each time.
        </p>

        <form onSubmit={handleSubmit} className="space-y-2">
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="contract ceiling · invoice 2026-003 · rate 6A · signal approval blockers"
              className="min-w-0 flex-1 rounded-lg border border-[#2F3B52] bg-[#111827] px-3 py-2.5 text-sm text-[#E5EDF7] outline-none placeholder:text-[#5B6578] focus:border-[#3B82F6]/50"
            />
            <button
              type="submit"
              disabled={pending || draft.trim().length === 0}
              className="rounded-lg border border-[#3B82F6]/50 bg-[#3B82F6]/12 px-4 py-2.5 text-[11px] font-semibold uppercase tracking-[0.16em] text-[#93C5FD] disabled:cursor-not-allowed disabled:opacity-50"
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
                className="rounded border border-[#2F3B52]/60 bg-[#0D1526] px-2 py-0.5 font-mono text-[10px] text-[#5B6578] transition hover:border-[#3B82F6]/40 hover:text-[#93C5FD] disabled:cursor-not-allowed disabled:opacity-40"
              >
                {example}
              </button>
            ))}
          </div>
          <p className="text-[10px] text-[#5B6578]">
            Sources: structured extracted facts, validator findings, decisions, then project documents (precedence applied when sources conflict).
          </p>
        </form>

        {error ? (
          <div className="rounded-lg border border-[#EF4444]/35 bg-[#3A141A] px-3 py-2 text-[11px] text-[#FCA5A5]">
            {error}
          </div>
        ) : null}

        {result ? <ProjectQueryResultCard result={result} /> : null}
      </div>
    </div>
  );
}
