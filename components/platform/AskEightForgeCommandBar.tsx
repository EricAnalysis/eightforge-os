'use client';

import { FormEvent, useMemo, useState, type ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import {
  detectAskScope,
  scopeLabel,
} from '@/lib/ask/globalCommand';
import { useAskDispatch } from '@/lib/ask/useAskDispatch';
import { AskEightForgeResponsePanel } from '@/components/platform/AskEightForgeResponsePanel';

type AskEightForgeCommandBarProps = {
  icon: ReactNode;
};

export function AskEightForgeCommandBar({ icon }: AskEightForgeCommandBarProps) {
  const pathname = usePathname();
  const [draft, setDraft] = useState('');
  const { contract, submit, dismiss } = useAskDispatch(pathname);

  const detectedScope = useMemo(() => detectAskScope(pathname, draft), [pathname, draft]);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const question = draft.trim();
    if (!question) return;
    submit(question);
  }

  return (
    <div className="relative hidden sm:block">
      <form onSubmit={handleSubmit} className="relative">
        <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--ef-text-muted)]">
          {icon}
        </span>
        <input
          type="text"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Ask EightForge..."
          className="w-52 rounded-full border border-[var(--ef-border-subtle-a70)] bg-[var(--ef-background-secondary)] py-2 pl-9 pr-[5.75rem] text-[12px] text-[var(--ef-text-primary)] outline-none transition placeholder:text-[var(--ef-text-muted)] focus:border-[var(--ef-purple-primary)] focus:ring-1 focus:ring-[var(--ef-purple-glow)] lg:w-80"
        />
        <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 rounded-full border border-[var(--ef-border-subtle-a60)] bg-[var(--ef-surface-elevated)] px-2 py-0.5 text-[9px] font-semibold uppercase tracking-[0.14em] text-[var(--ef-text-muted)]">
          {scopeLabel(detectedScope)}
        </span>
      </form>

      {contract ? (
        <AskEightForgeResponsePanel
          contract={contract}
          onDismiss={dismiss}
          className="absolute right-0 top-12 z-50 w-[min(28rem,calc(100vw-2rem))]"
        />
      ) : null}
    </div>
  );
}
