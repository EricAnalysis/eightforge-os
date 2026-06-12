import Link from 'next/link';
import type { AskActionViewModel } from '@/components/ask/askResponseAdapter';

type AskActionsRowProps = {
  actions: AskActionViewModel[];
};

function actionClassName(tone: AskActionViewModel['tone']): string {
  if (tone === 'brand') {
    return 'border-[var(--ef-purple-primary-a45)] bg-[var(--ef-purple-primary-a12)] text-[var(--ef-purple-glow)] hover:bg-[var(--ef-purple-primary-a20)]';
  }

  return 'border-[var(--ef-border-subtle-a80)] bg-[var(--ef-surface-elevated)] text-[var(--ef-text-primary)] hover:border-[var(--ef-purple-primary-a50)] hover:text-white';
}

export function AskActionsRow({ actions }: AskActionsRowProps) {
  if (actions.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-2">
      {actions.map((action) => (
        <Link
          key={action.id}
          href={action.href}
          className={`inline-flex rounded-xl border px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.16em] transition ${actionClassName(action.tone)}`}
        >
          {action.label}
        </Link>
      ))}
    </div>
  );
}
