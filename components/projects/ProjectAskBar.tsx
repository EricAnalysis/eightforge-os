'use client';

import { startTransition, useState, type FormEvent } from 'react';
import { supabase } from '@/lib/supabaseClient';

type ProjectAskBarProps = {
  projectId: string;
};

type ProjectAskResponse = {
  answer?: string;
  model?: string;
  error?: string;
  code?: string;
};

const AI_NOT_CONFIGURED_CODE = 'ai_not_configured';
const AI_NOT_CONFIGURED_MESSAGE = 'AI assistance is not configured for this environment.';

export function getProjectAskErrorMessage(payload: ProjectAskResponse): string {
  if (payload.code === AI_NOT_CONFIGURED_CODE) {
    return AI_NOT_CONFIGURED_MESSAGE;
  }

  return payload.error ?? 'Ask failed';
}

export function ProjectAskBar({ projectId }: ProjectAskBarProps) {
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState<string | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submitAsk() {
    const trimmed = question.trim();
    if (!trimmed) return;

    setPending(true);
    setError(null);
    setAnswer(null);
    setModel(null);

    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const token = session?.access_token;
      if (!token) throw new Error('Authentication required.');

      const response = await fetch(`/api/projects/${projectId}/ask`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ question: trimmed }),
      });
      const payload = (await response.json().catch(() => ({}))) as ProjectAskResponse;
      if (!response.ok) {
        throw new Error(getProjectAskErrorMessage(payload));
      }

      setAnswer(payload.answer ?? '');
      setModel(payload.model ?? null);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'Ask failed');
    } finally {
      setPending(false);
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    startTransition(() => {
      void submitAsk();
    });
  }

  return (
    <div className="rounded-sm border border-[#2F3B52]/70 bg-[#111827]">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#2F3B52]/70 px-4 py-3">
        <div>
          <h3 className="text-[11px] font-bold uppercase tracking-[0.18em] text-[#E5EDF7]">
            Ask This Project
          </h3>
          <p className="mt-1 text-[11px] text-[#94A3B8]">
            Read-only Claude explanation from scoped canonical project context.
          </p>
        </div>
        {model ? (
          <span className="rounded-sm border border-[#2F3B52]/70 px-2 py-1 text-[10px] uppercase tracking-[0.14em] text-[#94A3B8]">
            {model}
          </span>
        ) : null}
      </div>

      <div className="space-y-3 px-4 py-4">
        <form onSubmit={handleSubmit} className="flex flex-col gap-2 sm:flex-row">
          <input
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            maxLength={1200}
            placeholder="Ask for a read-only explanation of the current project truth"
            className="min-w-0 flex-1 rounded-sm border border-[#2F3B52]/70 bg-[#0B1020] px-3 py-2 text-sm text-[#E5EDF7] outline-none placeholder:text-[#64748B] focus:border-[#3B82F6]/70"
          />
          <button
            type="submit"
            disabled={pending || question.trim().length === 0}
            className="rounded-sm border border-[#3B82F6]/40 bg-[#3B82F6]/10 px-4 py-2 text-[11px] font-bold uppercase tracking-[0.16em] text-[#93C5FD] transition hover:border-[#3B82F6]/70 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {pending ? 'Asking' : 'Ask'}
          </button>
        </form>

        {error ? (
          <div className="rounded-sm border border-[#EF4444]/40 bg-[#7F1D1D]/20 px-3 py-2 text-[11px] text-[#FCA5A5]">
            {error}
          </div>
        ) : null}

        {answer ? (
          <div className="rounded-sm border border-[#2F3B52]/70 bg-[#0B1020]/70 px-4 py-3">
            <p className="whitespace-pre-wrap text-sm leading-6 text-[#DCE6F2]">{answer}</p>
          </div>
        ) : null}
      </div>
    </div>
  );
}
