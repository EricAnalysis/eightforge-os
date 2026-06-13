import Link from 'next/link';
import type { AskActionViewModel } from '@/components/ask/askResponseAdapter';

type AskActionsRowProps = {
  actions: AskActionViewModel[];
};

function actionClassName(tone: AskActionViewModel['tone']): string {
  if (tone === 'brand') {
    return 'border-[#3B82F6]/45 bg-[#3B82F6]/12 text-[#93C5FD] hover:bg-[#3B82F6]/20';
  }

  return 'border-[#2F3B52]/80 bg-[#131A29] text-[#E5EDF7] hover:border-[#3B82F6]/50 hover:text-white';
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
