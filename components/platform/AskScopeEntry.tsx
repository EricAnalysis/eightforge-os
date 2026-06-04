'use client';

import { FormEvent, useState } from 'react';
import { usePathname } from 'next/navigation';
import { AskEightForgeResponsePanel } from '@/components/platform/AskEightForgeResponsePanel';
import { scopeLabel as formatScopeLabel, type AskScope } from '@/lib/ask/globalCommand';
import { useAskDispatch } from '@/lib/ask/useAskDispatch';

type AskScopeEntryProps = {
  scope: Extract<AskScope, 'portfolio' | 'intelligence'>;
  scopeLabel: string;
  placeholder: string;
  chips: string[];
};

export function AskScopeEntry({
  scope,
  scopeLabel,
  placeholder,
  chips,
}: AskScopeEntryProps) {
  const pathname = usePathname();
  const [draft, setDraft] = useState('');
  const { contract, submit, dismiss } = useAskDispatch(pathname);
  const inputPlaceholder =
    scope === 'portfolio' ? 'Ask about your portfolio...' : 'Ask about operational patterns...';

  function submitQuestion(question: string) {
    const trimmed = question.trim();
    if (!trimmed) return;
    setDraft(trimmed);
    submit(trimmed, scope);
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    submitQuestion(draft);
  }

  return (
    <section className="rounded-2xl border border-[var(--ef-border-subtle-a80)] bg-[var(--ef-background-secondary)] p-5 shadow-[0_24px_90px_-64px_var(--ef-shadow-ambient)]">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-[var(--ef-text-muted)]">
            {scopeLabel} scope
          </p>
          <h2 className="mt-2 text-[16px] font-semibold text-[var(--ef-text-primary)]">
            Ask EightForge
          </h2>
          <p className="mt-1 text-[12px] text-[var(--ef-text-muted)]">{placeholder}</p>
        </div>
        <div className="min-w-0 lg:w-[24rem]">
          <div className="rounded-xl border border-[var(--ef-border-subtle-a70)] bg-[var(--ef-background-primary)] px-4 py-3 text-[12px] text-[var(--ef-text-muted)]">
            Ask here or from the global top bar. Both use the same command contract.
          </div>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="mt-4">
        <div className="flex flex-col gap-2 sm:flex-row">
          <div className="relative min-w-0 flex-1">
            <input
              type="text"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder={inputPlaceholder}
              className="w-full rounded-xl border border-[var(--ef-border-subtle-a70)] bg-[var(--ef-background-primary)] px-4 py-3 pr-28 text-[13px] text-[var(--ef-text-primary)] outline-none transition placeholder:text-[var(--ef-text-muted)] focus:border-[var(--ef-purple-primary)] focus:ring-1 focus:ring-[var(--ef-purple-glow)]"
            />
            <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 rounded-full border border-[var(--ef-border-subtle-a60)] bg-[var(--ef-surface-elevated)] px-2 py-0.5 text-[9px] font-semibold uppercase tracking-[0.14em] text-[var(--ef-text-muted)]">
              {formatScopeLabel(scope)}
            </span>
          </div>
          <button
            type="submit"
            disabled={draft.trim().length === 0}
            className="rounded-xl border border-[var(--ef-purple-primary-a40)] bg-[var(--ef-purple-primary-a12)] px-4 py-3 text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--ef-purple-glow)] transition hover:border-[var(--ef-purple-primary)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            Ask
          </button>
        </div>
      </form>

      <div className="mt-4 flex flex-wrap gap-2">
        {chips.map((chip) => (
          <button
            key={chip}
            type="button"
            onClick={() => submitQuestion(chip)}
            className="rounded-full border border-[var(--ef-purple-primary-a20)] bg-[var(--ef-purple-primary-a10)] px-3 py-1.5 text-left text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--ef-purple-glow)] transition hover:border-[var(--ef-purple-primary)]"
          >
            {chip}
          </button>
        ))}
      </div>

      {contract ? (
        <AskEightForgeResponsePanel
          contract={contract}
          onDismiss={dismiss}
          className="mt-4 shadow-none"
        />
      ) : null}
    </section>
  );
}
