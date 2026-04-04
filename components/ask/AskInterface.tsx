'use client';

import { startTransition, useState, type FormEvent } from 'react';
import type { AskResponse } from '@/lib/ask/types';
import { AskResponsePanel } from '@/components/ask/AskResponsePanel';
import { SuggestedQueries, type SuggestedQuery } from '@/components/ask/SuggestedQueries';
import { supabase } from '@/lib/supabaseClient';

type AskInterfaceProps = {
  projectId: string;
  title?: string;
  suggestedQueries: SuggestedQuery[];
};

export function AskInterface({
  projectId,
  title = 'Ask This Project',
  suggestedQueries,
}: AskInterfaceProps) {
  const [draft, setDraft] = useState('');
  const [answer, setAnswer] = useState<AskResponse | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submitQuestion(question: string) {
    const trimmed = question.trim();
    if (!trimmed) return;

    setPending(true);
    setError(null);
    setDraft(trimmed);

    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) {
        setError('Authentication required');
        return;
      }

      const response = await fetch('/api/ask/project', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          projectId,
          question: trimmed,
        }),
      });

      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError((body as { error?: string }).error ?? 'Ask failed');
        return;
      }

      setAnswer(body as AskResponse);
    } catch {
      setError('Ask failed');
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
          Query to result
        </span>
      </div>

      <div className="space-y-3 px-5 py-4">
        <SuggestedQueries
          queries={suggestedQueries}
          disabled={pending}
          onSelect={(query) => {
            setDraft(query.text);
            startTransition(() => {
              void submitQuestion(query.text);
            });
          }}
        />

        <form onSubmit={handleSubmit} className="space-y-2">
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="Ask about facts, blockers, missing data, documents, or actions"
              className="min-w-0 flex-1 rounded-lg border border-[#2F3B52] bg-[#111827] px-3 py-2 text-sm text-[#E5EDF7] outline-none placeholder:text-[#5B6578] focus:border-[#3B82F6]/50"
            />
            <button
              type="submit"
              disabled={pending || draft.trim().length === 0}
              className="rounded-lg border border-[#3B82F6]/50 bg-[#3B82F6]/12 px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-[#93C5FD] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {pending ? 'Running' : 'Ask'}
            </button>
          </div>
          <p className="text-[10px] text-[#5B6578]">
            Ask reads persisted facts, validator findings, decisions, and project documents in that order.
          </p>
        </form>

        {error ? (
          <div className="rounded-lg border border-[#EF4444]/35 bg-[#3A141A] px-3 py-2 text-[11px] text-[#FCA5A5]">
            {error}
          </div>
        ) : null}

        {answer ? (
          <AskResponsePanel
            response={answer}
            projectId={projectId}
            pending={pending}
            onSelectFollowup={(question) => {
              setDraft(question);
              startTransition(() => {
                void submitQuestion(question);
              });
            }}
          />
        ) : null}
      </div>
    </div>
  );
}
