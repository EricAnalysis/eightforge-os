'use client';

import { useState, type FormEvent } from 'react';
import { supabase } from '@/lib/supabaseClient';
import type { SuggestedQuestion } from '@/lib/types/documentIntelligence';

interface AskDocumentSectionProps {
  questions: SuggestedQuestion[];
  documentId?: string;
  projectId?: string;
  endpoint?: '/api/ask/document' | '/api/ask/project';
  title?: string;
}

type AskResponse = {
  status: 'answered' | 'unsupported';
  answer: string;
  support: string[];
  trace?: {
    template_id?: string;
    template_label?: string;
    query_plan?: string;
  };
};

export function AskDocumentSection({
  questions,
  documentId,
  projectId,
  endpoint,
  title = 'Ask This Document',
}: AskDocumentSectionProps) {
  const [draft, setDraft] = useState('');
  const [answer, setAnswer] = useState<AskResponse | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!questions || questions.length === 0) return null;

  const targetId = documentId ?? projectId ?? null;
  const resolvedEndpoint = endpoint ?? (projectId ? '/api/ask/project' : '/api/ask/document');

  async function submitQuestion(question: string) {
    if (!targetId) return;

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

      const payload = documentId
        ? { documentId, question: trimmed }
        : { projectId, question: trimmed };
      const response = await fetch(resolvedEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify(payload),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError((body as { error?: string }).error ?? 'Query failed');
        return;
      }
      setAnswer(body as AskResponse);
    } catch {
      setError('Query failed');
    } finally {
      setPending(false);
    }
  }

  function handleQuestionClick(q: SuggestedQuestion) {
    setDraft(q.question);
    void submitQuestion(q.question);
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void submitQuestion(draft);
  }

  return (
    <div className="rounded-xl border border-[var(--ef-border-white-10)] bg-[var(--ef-background-primary)]">
      <div className="flex items-center justify-between border-b border-white/8 px-5 py-3">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--ef-text-muted)]">
          {title}
        </h3>
        <span className="text-[10px] text-[var(--ef-text-faint)]">Constrained query</span>
      </div>

      <div className="flex flex-col gap-2 px-5 py-3">
        <div className="flex flex-col gap-2">
          {questions.map((q) => (
            <button
              key={q.id}
              type="button"
              onClick={() => handleQuestionClick(q)}
              className="group w-full cursor-pointer rounded-lg border border-white/8 bg-white/3 px-4 py-2.5 text-left transition-colors duration-150 hover:border-white/15 hover:bg-white/6"
            >
              <span className="text-xs leading-relaxed text-[var(--ef-text-secondary)] group-hover:text-white">
                {q.question}
              </span>
            </button>
          ))}
        </div>

        <form onSubmit={handleSubmit} className="mt-1 flex flex-col gap-2">
          <input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Ask a supported question about grounded facts"
            className="rounded-lg border border-[var(--ef-border-white-10)] bg-[var(--ef-background-secondary)] px-3 py-2 text-xs text-[var(--ef-text-primary)] outline-none placeholder:text-[var(--ef-text-faint)] focus:border-[var(--ef-purple-primary-a50)]"
          />
          <div className="flex items-center justify-between gap-2">
            <p className="text-[10px] text-[var(--ef-text-faint)]">
              Supported: review status, missing support, next actions, grounded facts
            </p>
            <button
              type="submit"
              disabled={pending || !targetId || draft.trim().length === 0}
              className="rounded border border-[var(--ef-purple-primary-a30)] bg-[var(--ef-purple-primary-a10)] px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--ef-purple-glow)] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {pending ? 'Running' : 'Ask'}
            </button>
          </div>
        </form>

        {error && (
          <div className="rounded-lg border border-[var(--ef-critical-a30)] bg-[var(--ef-critical-a10)] px-3 py-2 text-[11px] text-[var(--ef-critical-soft)]">
            {error}
          </div>
        )}

        {answer && (
          <div className="rounded-lg border border-[var(--ef-border-white-10)] bg-[var(--ef-background-secondary)] px-4 py-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className={`rounded px-1.5 py-0.5 text-[10px] ${answer.status === 'answered' ? 'bg-[var(--ef-success-bg)] text-[var(--ef-success)]' : 'bg-[var(--ef-warning-bg)] text-[var(--ef-warning-soft)]'}`}>
                {answer.status === 'answered' ? 'Answered' : 'Unsupported'}
              </span>
              {answer.trace?.template_label && (
                <span className="text-[10px] text-[var(--ef-text-faint)]">
                  {answer.trace.template_label}
                </span>
              )}
            </div>
            <p className="mt-2 text-sm leading-relaxed text-[var(--ef-text-primary)]">
              {answer.answer}
            </p>
            {answer.support.length > 0 && (
              <div className="mt-3 space-y-1">
                {answer.support.map((item) => (
                  <p key={item} className="text-[11px] leading-relaxed text-[var(--ef-text-muted)]">
                    {item}
                  </p>
                ))}
              </div>
            )}
            {answer.trace?.query_plan && (
              <p className="mt-3 text-[10px] text-[var(--ef-text-faint)]">
                Trace: {answer.trace.query_plan}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
