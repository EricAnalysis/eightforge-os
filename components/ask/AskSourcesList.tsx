'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import type { AskSourceViewModel } from '@/components/ask/askResponseAdapter';

type AskSourcesListProps = {
  sources: AskSourceViewModel[];
};

function sourceTypeClassName(type: AskSourceViewModel['type']): string {
  if (type === 'validator') {
    return 'border-[#F59E0B]/35 bg-[#31230F] text-[#FCD34D]';
  }
  if (type === 'decision') {
    return 'border-[#38BDF8]/30 bg-[#10283A] text-[#7DD3FC]';
  }
  if (type === 'document') {
    return 'border-[#2F3B52]/80 bg-[#131A29] text-[#C7D2E3]';
  }
  if (type === 'calculation') {
    return 'border-[#A855F7]/30 bg-[#261339] text-[#D8B4FE]';
  }
  return 'border-[#22C55E]/35 bg-[#0F2417] text-[#86EFAC]';
}

function navigationButtonClassName(
  source: AskSourceViewModel,
): string {
  if (!source.isNavigable) {
    return 'cursor-not-allowed border-[#2F3B52]/60 bg-[#0E1522] text-[#64748B]';
  }

  if (source.navigationState === 'evidence') {
    return 'border-[#3B82F6]/60 bg-[#101A2E] text-[#DCEBFF] hover:border-[#60A5FA] hover:text-white';
  }

  if (source.navigationState === 'page') {
    return 'border-[#2F3B52]/80 bg-[#131A29] text-[#E5EDF7] hover:border-[#3B82F6]/60 hover:text-white';
  }

  return 'border-[#2F3B52]/80 bg-[#131A29] text-[#C7D2E3] hover:border-[#3B82F6]/50 hover:text-white';
}

function quoteSnippet(snippet?: string): string | null {
  const trimmed = snippet?.trim();
  return trimmed ? `"${trimmed}"` : null;
}

export function AskSourcesList({ sources }: AskSourcesListProps) {
  const [expanded, setExpanded] = useState(false);
  const visibleSources = useMemo(
    () => (expanded ? sources : sources.slice(0, 3)),
    [expanded, sources],
  );

  if (sources.length === 0) {
    return (
      <div className="rounded-lg border border-[#2F3B52]/60 bg-[#0F172A] px-3 py-3 text-[11px] text-[#94A3B8]">
        No evidence sources were returned for this answer.
      </div>
    );
  }

  return (
    <div className="space-y-2.5">
      {visibleSources.map((source) => {
        const snippet = quoteSnippet(source.snippet);

        return (
          <div
            key={source.id}
            className="flex flex-col gap-3 rounded-lg border border-[#2F3B52]/60 bg-[#0F172A] px-3 py-3 sm:flex-row sm:items-start sm:justify-between"
          >
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className={`inline-flex rounded-full border px-2 py-0.5 text-[9px] font-semibold uppercase tracking-[0.16em] ${sourceTypeClassName(source.type)}`}>
                  {source.typeLabel}
                </span>
                <span className="text-[12px] font-semibold text-[#E5EDF7]">
                  {source.title}
                </span>
              </div>

              <p className="mt-1 text-[10px] uppercase tracking-[0.16em] text-[#7F90AA]">
                {source.detail}
              </p>

              {snippet ? (
                <p className="mt-2 max-w-[70ch] text-[11px] leading-relaxed text-[#C7D2E3]">
                  {snippet}
                </p>
              ) : null}
            </div>

            <div className="flex items-center gap-2 sm:flex-col sm:items-end">
              <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[#64748B]">
                {source.confidence}%
              </span>
              {source.isNavigable && source.href ? (
                <Link
                  href={source.href}
                  className={`inline-flex rounded-md border px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.16em] transition ${navigationButtonClassName(source)}`}
                >
                  {source.navigationLabel}
                </Link>
              ) : (
                <button
                  type="button"
                  disabled
                  aria-disabled="true"
                  className={`inline-flex rounded-md border px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.16em] ${navigationButtonClassName(source)}`}
                >
                  {source.navigationLabel}
                </button>
              )}
            </div>
          </div>
        );
      })}

      {sources.length > 3 ? (
        <button
          type="button"
          onClick={() => setExpanded((current) => !current)}
          className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#3B82F6] transition hover:text-[#60A5FA]"
        >
          {expanded ? 'Show fewer sources' : `Show ${sources.length - 3} more source${sources.length - 3 === 1 ? '' : 's'}`}
        </button>
      ) : null}
    </div>
  );
}
