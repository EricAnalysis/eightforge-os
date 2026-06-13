'use client';

import Link from 'next/link';
import type { ProjectQueryResult } from '@/lib/projectQuery/types';

function sectionHeading(label: string) {
  return (
    <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#7F90AA]">
      {label}
    </p>
  );
}

function statusTone(status: ProjectQueryResult['status']): string {
  if (status === 'Verified') return 'text-[#86EFAC] border-[#22C55E]/30 bg-[#22C55E]/8';
  if (status === 'Derived') return 'text-[#93C5FD] border-[#3B82F6]/35 bg-[#3B82F6]/10';
  if (status === 'Mismatch') return 'text-[#FCD34D] border-[#F59E0B]/35 bg-[#F59E0B]/10';
  if (status === 'Signal') return 'text-[#FCA5A5] border-[#EF4444]/35 bg-[#EF4444]/10';
  return 'text-[#94A3B8] border-[#2F3B52]/70 bg-[#111827]';
}

function confidenceTone(level: ProjectQueryResult['confidenceLevel']): string {
  if (level === 'HIGH') return 'text-[#86EFAC]';
  if (level === 'MEDIUM') return 'text-[#FCD34D]';
  if (level === 'LOW') return 'text-[#94A3B8]';
  return 'text-[#64748B]';
}

export function ProjectQueryResultCard({
  result,
}: {
  result: ProjectQueryResult;
}) {
  return (
    <section className="rounded-xl border border-[#2F3B52]/70 bg-[linear-gradient(180deg,rgba(15,23,42,0.96),rgba(10,15,26,0.96))] px-4 py-4">
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
        <div className="mt-2 rounded-lg border border-[#2F3B52]/60 bg-[#0F1117] px-3 py-2">
          <p className="text-[12px] leading-relaxed text-[#E5EDF7]">
            {result.result}
          </p>
        </div>
      </div>

      <div className="mt-4 border-t border-[#2F3B52]/50 pt-3">
        {sectionHeading('Evidence')}
        {result.evidence.length === 0 ? (
          <p className="mt-2 text-[11px] text-[#94A3B8]">
            None.
          </p>
        ) : (
          <div className="mt-2 space-y-2">
            {result.evidence.map((ev) => (
              <Link
                key={`${ev.href}-${ev.label}`}
                href={ev.href}
                className="block rounded-lg border border-[#2F3B52]/60 bg-[#0B1020] px-3 py-2 transition hover:border-[#3B82F6]/40"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="text-[11px] font-semibold text-[#C7D2E3]">
                    {ev.label}
                  </p>
                  {ev.locator ? (
                    <p className="text-[10px] font-mono text-[#5B6578]">
                      {ev.locator}
                    </p>
                  ) : null}
                </div>
                <p className="mt-1 text-[11px] leading-relaxed text-[#94A3B8]">
                  {ev.snippet}
                </p>
              </Link>
            ))}
          </div>
        )}
      </div>

      <div className="mt-4 border-t border-[#2F3B52]/50 pt-3">
        {sectionHeading('Next Action')}
        <p className="mt-2 text-[11px] text-[#C7D2E3]">
          {result.nextAction ?? '—'}
        </p>
      </div>

      <details className="mt-4 border-t border-[#2F3B52]/50 pt-3">
        <summary className="cursor-pointer text-[10px] font-semibold uppercase tracking-[0.18em] text-[#94A3B8] transition hover:text-[#E5EDF7]">
          Debug
        </summary>
        <div className="mt-2 space-y-1 text-[11px] text-[#94A3B8]">
          <p>
            <span className="text-[#7F90AA]">Query type</span>: {result.trace.detectedType}
          </p>
          <p>
            <span className="text-[#7F90AA]">Status</span>: {result.trace.status}
          </p>
          <p>
            <span className="text-[#7F90AA]">Sources</span>: {result.trace.sourceIds.length > 0 ? result.trace.sourceIds.join(', ') : '—'}
          </p>
          <p>
            <span className="text-[#7F90AA]">Precedence</span>: {result.trace.precedenceApplied ? 'applied' : 'not applied'}
          </p>
          <p>
            <span className="text-[#7F90AA]">Confidence</span>: {result.trace.confidenceLevel}
          </p>
        </div>
      </details>
    </section>
  );
}

