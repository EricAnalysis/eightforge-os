'use client';

import Link from 'next/link';
import type { ProjectQueryResult } from '@/lib/projectQuery/types';

function sectionHeading(label: string) {
  return (
    <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--ef-text-soft)]">
      {label}
    </p>
  );
}

function statusTone(status: ProjectQueryResult['status']): string {
  if (status === 'Verified') return 'text-[var(--ef-success-soft)] border-[var(--ef-success-a30)] bg-[var(--ef-success-a08)]';
  if (status === 'Derived') return 'text-[var(--ef-text-secondary)] border-[var(--ef-border-subtle-a70)] bg-[var(--ef-surface-hover-a70)]';
  if (status === 'Mismatch') return 'text-[var(--ef-warning-soft)] border-[var(--ef-warning-a35)] bg-[var(--ef-warning-bg)]';
  if (status === 'Signal') return 'text-[var(--ef-critical-soft)] border-[var(--ef-critical-a40)] bg-[var(--ef-critical-a10)]';
  return 'text-[var(--ef-text-muted)] border-[var(--ef-border-subtle-a70)] bg-[var(--ef-background-secondary)]';
}

function confidenceTone(level: ProjectQueryResult['confidenceLevel']): string {
  if (level === 'HIGH') return 'text-[var(--ef-success-soft)]';
  if (level === 'MEDIUM') return 'text-[var(--ef-warning-soft)]';
  if (level === 'LOW') return 'text-[var(--ef-text-muted)]';
  return 'text-[var(--ef-text-faint)]';
}

export function ProjectQueryResultCard({
  result,
}: {
  result: ProjectQueryResult;
}) {
  return (
    <section className="rounded-xl border border-[var(--ef-border-subtle-a70)] bg-[linear-gradient(180deg,var(--ef-surface-overlay),var(--ef-surface-overlay))] px-4 py-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className={`inline-flex items-center rounded border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.14em] ${statusTone(result.status)}`}>
          {result.status}
        </span>
        <span
          className={`text-[10px] font-semibold uppercase tracking-[0.16em] ${confidenceTone(result.confidenceLevel)}`}
        >
          Confidence {result.confidenceLevel}
        </span>
      </div>

      <div className="mt-3">
        {sectionHeading('Result')}
        <div className="mt-2 rounded-lg border border-[var(--ef-border-subtle-a60)] bg-[var(--ef-background-primary)] px-3 py-2">
          <p className="text-[12px] leading-relaxed text-[var(--ef-text-primary)]">
            {result.result}
          </p>
        </div>
      </div>

      <div className="mt-4 border-t border-[var(--ef-border-subtle-a50)] pt-3">
        {sectionHeading('Evidence')}
        {result.evidence.length === 0 ? (
          <p className="mt-2 text-[11px] text-[var(--ef-text-muted)]">
            None.
          </p>
        ) : (
          <div className="mt-2 space-y-2">
            {result.evidence.map((ev) => (
              <Link
                key={`${ev.href}-${ev.label}`}
                href={ev.href}
                className="block rounded-lg border border-[var(--ef-border-subtle-a60)] bg-[var(--ef-background-primary)] px-3 py-2 transition hover:border-[var(--ef-purple-primary-a40)]"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="text-[11px] font-semibold text-[var(--ef-text-secondary)]">
                    {ev.label}
                  </p>
                  {ev.locator ? (
                    <p className="text-[10px] font-mono text-[var(--ef-text-faint)]">
                      {ev.locator}
                    </p>
                  ) : null}
                </div>
                <p className="mt-1 text-[11px] leading-relaxed text-[var(--ef-text-muted)]">
                  {ev.snippet}
                </p>
              </Link>
            ))}
          </div>
        )}
      </div>

      <div className="mt-4 border-t border-[var(--ef-border-subtle-a50)] pt-3">
        {sectionHeading('Next Action')}
        <p className="mt-2 text-[11px] text-[var(--ef-text-secondary)]">
          {result.nextAction ?? '—'}
        </p>
      </div>

      <details className="mt-4 border-t border-[var(--ef-border-subtle-a50)] pt-3">
        <summary className="cursor-pointer text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--ef-text-muted)] transition hover:text-[var(--ef-text-primary)]">
          Debug
        </summary>
        <div className="mt-2 space-y-1 text-[11px] text-[var(--ef-text-muted)]">
          <p>
            <span className="text-[var(--ef-text-soft)]">Query type</span>: {result.trace.detectedType}
          </p>
          <p>
            <span className="text-[var(--ef-text-soft)]">Status</span>: {result.trace.status}
          </p>
          <p>
            <span className="text-[var(--ef-text-soft)]">Sources</span>: {result.trace.sourceIds.length > 0 ? result.trace.sourceIds.join(', ') : '—'}
          </p>
          <p>
            <span className="text-[var(--ef-text-soft)]">Precedence</span>: {result.trace.precedenceApplied ? 'applied' : 'not applied'}
          </p>
          <p>
            <span className="text-[var(--ef-text-soft)]">Confidence</span>: {result.trace.confidenceLevel}
          </p>
        </div>
      </details>
    </section>
  );
}

