'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import type { AskSourceViewModel } from '@/components/ask/askResponseAdapter';

type AskSourcesListProps = {
  sources: AskSourceViewModel[];
};

function sourceTypeClassName(type: AskSourceViewModel['type']): string {
  if (type === 'validator') {
    return 'border-[var(--ef-warning-a35)] bg-[var(--ef-warning-bg)] text-[var(--ef-warning-soft)]';
  }
  if (type === 'decision') {
    return 'border-[var(--ef-purple-glow-a30)] bg-[var(--ef-purple-primary-a10)] text-[var(--ef-purple-glow)]';
  }
  if (type === 'document') {
    return 'border-[var(--ef-border-subtle-a80)] bg-[var(--ef-surface-elevated)] text-[var(--ef-text-secondary)]';
  }
  if (type === 'calculation') {
    return 'border-[var(--ef-purple-accent-a30)] bg-[var(--ef-purple-primary-a12)] text-[var(--ef-purple-glow)]';
  }
  return 'border-[var(--ef-success-a35)] bg-[var(--ef-success-bg)] text-[var(--ef-success-soft)]';
}

function navigationButtonClassName(
  source: AskSourceViewModel,
): string {
  if (!source.isNavigable) {
    return 'cursor-not-allowed border-[var(--ef-border-subtle-a60)] bg-[var(--ef-background-secondary)] text-[var(--ef-text-faint)]';
  }

  if (source.navigationState === 'evidence') {
    return 'border-[var(--ef-purple-primary-a60)] bg-[var(--ef-surface-elevated)] text-[var(--ef-purple-glow)] hover:border-[var(--ef-purple-glow)] hover:text-white';
  }

  if (source.navigationState === 'page') {
    return 'border-[var(--ef-border-subtle-a80)] bg-[var(--ef-surface-elevated)] text-[var(--ef-text-primary)] hover:border-[var(--ef-purple-primary-a60)] hover:text-white';
  }

  return 'border-[var(--ef-border-subtle-a80)] bg-[var(--ef-surface-elevated)] text-[var(--ef-text-secondary)] hover:border-[var(--ef-purple-primary-a50)] hover:text-white';
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
      <div className="rounded-lg border border-[var(--ef-border-subtle-a60)] bg-[var(--ef-background-secondary)] px-3 py-3 text-[11px] text-[var(--ef-text-muted)]">
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
            className="flex flex-col gap-3 rounded-lg border border-[var(--ef-border-subtle-a60)] bg-[var(--ef-background-secondary)] px-3 py-3 sm:flex-row sm:items-start sm:justify-between"
          >
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className={`inline-flex rounded-full border px-2 py-0.5 text-[9px] font-semibold uppercase tracking-[0.16em] ${sourceTypeClassName(source.type)}`}>
                  {source.typeLabel}
                </span>
                <span className="text-[12px] font-semibold text-[var(--ef-text-primary)]">
                  {source.title}
                </span>
              </div>

              <p className="mt-1 text-[10px] uppercase tracking-[0.16em] text-[var(--ef-text-soft)]">
                {source.detail}
              </p>

              {snippet ? (
                <p className="mt-2 max-w-[70ch] text-[11px] leading-relaxed text-[var(--ef-text-secondary)]">
                  {snippet}
                </p>
              ) : null}
            </div>

            <div className="flex items-center gap-2 sm:flex-col sm:items-end">
              <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--ef-text-faint)]">
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
          className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--ef-purple-primary)] transition hover:text-[var(--ef-purple-glow)]"
        >
          {expanded ? 'Show fewer sources' : `Show ${sources.length - 3} more source${sources.length - 3 === 1 ? '' : 's'}`}
        </button>
      ) : null}
    </div>
  );
}
