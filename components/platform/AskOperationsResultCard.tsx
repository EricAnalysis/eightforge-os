'use client';

import Link from 'next/link';
import type { AskOperationsResult } from '@/lib/operationsQuery/types';

function sectionHeading(label: string) {
  return (
    <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#7F90AA]">
      {label}
    </p>
  );
}

function statusTone(status: AskOperationsResult['status']): string {
  if (status === 'Verified') return 'text-[#86EFAC] border-[#22C55E]/30 bg-[#22C55E]/8';
  if (status === 'Derived') return 'text-[#93C5FD] border-[#3B82F6]/35 bg-[#3B82F6]/10';
  if (status === 'Ranked') return 'text-[#C4B5FD] border-[#8B5CF6]/35 bg-[#8B5CF6]/10';
  if (status === 'Signal') return 'text-[#FCA5A5] border-[#EF4444]/35 bg-[#EF4444]/10';
  if (status === 'Missing') return 'text-[#94A3B8] border-[#2F3B52]/70 bg-[#111827]';
  return 'text-[#94A3B8] border-[#2F3B52]/70 bg-[#111827]';
}

function confidenceTone(level: AskOperationsResult['confidenceLevel']): string {
  if (level === 'HIGH') return 'text-[#86EFAC]';
  if (level === 'MEDIUM') return 'text-[#FCD34D]';
  if (level === 'LOW') return 'text-[#94A3B8]';
  return 'text-[#64748B]';
}

type DataFreshnessKind = 'rollup' | 'queue' | 'validator';

function collectSourceIds(result: AskOperationsResult): string[] {
  const fromTrace = result.trace.sourceIds ?? [];
  const fromEvidence = result.evidence.map((e) => e.sourceId);
  return [...fromTrace, ...fromEvidence];
}

function inferDataFreshnessKind(sourceIds: string[]): DataFreshnessKind | null {
  if (sourceIds.length === 0) return null;

  const validatorPattern = /^rank:(nte|contract|uninvoiced|exposure_proxy):/;
  if (sourceIds.some((id) => validatorPattern.test(id))) {
    return 'validator';
  }

  const queuePattern = /^decisions:/;
  const criticalPattern = /^queue:critical:(\d+)$/;
  const hasQueue = sourceIds.some((id) => queuePattern.test(id));
  const hasCriticalQueue = sourceIds.some((id) => {
    const m = id.match(criticalPattern);
    return m != null && Number(m[1]) > 0;
  });
  if (hasQueue || hasCriticalQueue) {
    return 'queue';
  }

  return 'rollup';
}

/**
 * Infers rollup vs queue vs validator from trace/evidence sourceId prefixes set by operations query.
 * Timestamps are read via extractFreshnessTimestamp when the result type gains a field (card-local hook).
 */
function formatDataFreshnessLine(result: AskOperationsResult): string {
  const ids = collectSourceIds(result);
  const kind = inferDataFreshnessKind(ids);

  const formatStamp = (value: string): string | null => {
    try {
      const d = new Date(value);
      if (Number.isNaN(d.getTime())) return null;
      return d.toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      });
    } catch {
      return null;
    }
  };

  const ts = extractFreshnessTimestamp(result);
  const stamp = ts ? formatStamp(ts) : null;

  if (stamp) {
    if (kind === 'queue') return `Decision queue snapshot ${stamp}`;
    if (kind === 'validator') return `Validator signals as of ${stamp}`;
    if (kind === 'rollup') return `Portfolio rollup as of ${stamp}`;
    return 'Data freshness unknown';
  }

  if (kind === 'queue') return 'Decision queue snapshot — Data freshness unknown';
  if (kind === 'validator') return 'Validator signals — Data freshness unknown';
  if (kind === 'rollup') return 'Portfolio rollup — Data freshness unknown';
  return 'Data freshness unknown';
}

function extractFreshnessTimestamp(_result: AskOperationsResult): string | null {
  return null;
}

function RoutingBlock({ actions }: { actions: AskOperationsResult['routingActions'] }) {
  const queueActions = actions.filter((a) => a.routingKind === 'OPEN_QUEUE');
  const otherActions = [
    ...queueActions.slice(1),
    ...actions.filter((a) => a.routingKind !== 'OPEN_QUEUE'),
  ];
  const primaryQueue = queueActions[0];

  if (primaryQueue) {
    return (
      <div className="mt-2 space-y-3">
        <Link
          href={primaryQueue.href}
          className="block rounded-lg border border-[#3B82F6]/45 bg-[#3B82F6]/14 px-3 py-2.5 text-center text-[11px] font-semibold text-[#93C5FD] transition hover:border-[#3B82F6]/60 hover:bg-[#3B82F6]/20"
        >
          {primaryQueue.label}
        </Link>
        {otherActions.length > 0 ? (
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[#64748B]">
              Secondary links
            </p>
            <div className="mt-1.5 flex flex-wrap gap-2">
              {otherActions.map((action) => (
                <Link
                  key={`${action.label}-${action.href}`}
                  href={action.href}
                  className="rounded-lg border border-[#2F3B52]/70 bg-[#0B1020] px-2.5 py-1 text-[10px] font-medium text-[#93C5FD] transition hover:border-[#3B82F6]/35"
                >
                  {action.label}
                </Link>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="mt-2 flex flex-wrap gap-2">
      {actions.map((action) => (
        <Link
          key={`${action.label}-${action.href}`}
          href={action.href}
          className="rounded-lg border border-[#3B82F6]/35 bg-[#3B82F6]/10 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-[#93C5FD] transition hover:border-[#3B82F6]/55 hover:bg-[#3B82F6]/16"
        >
          {action.label}
        </Link>
      ))}
    </div>
  );
}

export function AskOperationsResultCard({ result }: { result: AskOperationsResult }) {
  return (
    <section className="rounded-xl border border-[#2F3B52]/70 bg-[linear-gradient(180deg,rgba(15,23,42,0.96),rgba(10,15,26,0.96))] px-4 py-4">
      <div>
        {sectionHeading('Result')}
        <div className="mt-2 rounded-lg border border-[#2F3B52]/60 bg-[#0F1117] px-3 py-2">
          <p className="text-[12px] leading-relaxed text-[#E5EDF7]">{result.result}</p>
        </div>
      </div>

      <div className="mt-4 border-t border-[#2F3B52]/50 pt-3">
        {sectionHeading('Evidence')}
        {result.evidence.length === 0 ? (
          <p className="mt-2 text-[11px] text-[#94A3B8]">None.</p>
        ) : (
          <div className="mt-2 space-y-2">
            {result.evidence.map((ev) => (
              <Link
                key={ev.sourceId}
                href={ev.href}
                className="block rounded-lg border border-[#2F3B52]/60 bg-[#0B1020] px-3 py-2 transition hover:border-[#3B82F6]/40"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="text-[11px] font-semibold text-[#C7D2E3]">{ev.projectName}</p>
                  <p className="text-[10px] font-mono text-[#5B6578]">{ev.sourceId}</p>
                </div>
                <p className="mt-1 text-[11px] leading-relaxed text-[#94A3B8]">{ev.detail}</p>
              </Link>
            ))}
          </div>
        )}
      </div>

      <div className="mt-4 border-t border-[#2F3B52]/50 pt-3">
        {sectionHeading('Data freshness')}
        <p className="mt-1.5 truncate text-[10px] font-normal leading-snug text-[#64748B]">
          {formatDataFreshnessLine(result)}
        </p>
      </div>

      <div className="mt-4 border-t border-[#2F3B52]/50 pt-3">
        {sectionHeading('Status')}
        <div className="mt-2">
          <span
            className={`inline-flex items-center rounded border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.14em] ${statusTone(result.status)}`}
          >
            {result.status}
          </span>
        </div>
      </div>

      <div className="mt-4 border-t border-[#2F3B52]/50 pt-3">
        {sectionHeading('Next action')}
        <p className="mt-2 text-[11px] text-[#C7D2E3]">{result.nextAction ?? '—'}</p>
      </div>

      <div className="mt-4 border-t border-[#2F3B52]/50 pt-3">
        {sectionHeading('Confidence')}
        <p className={`mt-2 text-[11px] font-semibold uppercase tracking-[0.12em] ${confidenceTone(result.confidenceLevel)}`}>
          {result.confidenceLevel}
        </p>
      </div>

      {result.routingActions.length > 0 ? (
        <div className="mt-4 border-t border-[#2F3B52]/50 pt-3">
          {sectionHeading('Route')}
          <RoutingBlock actions={result.routingActions} />
        </div>
      ) : null}

      <details className="mt-4 border-t border-[#2F3B52]/50 pt-3">
        <summary className="cursor-pointer text-[10px] font-semibold uppercase tracking-[0.18em] text-[#64748B] transition hover:text-[#94A3B8]">
          Trace
        </summary>
        <dl className="mt-2 space-y-1 text-[10px] font-mono text-[#5B6578]">
          <div>
            <dt className="inline text-[#64748B]">intent </dt>
            <dd className="inline text-[#94A3B8]">{result.trace.intentType}</dd>
          </div>
          <div>
            <dt className="inline text-[#64748B]">routing </dt>
            <dd className="inline text-[#94A3B8]">{result.trace.routingAttached ? 'yes' : 'no'}</dd>
          </div>
          {result.trace.sourceIds.length > 0 ? (
            <div>
              <dt className="mb-0.5 text-[#64748B]">sources</dt>
              <dd className="whitespace-pre-wrap break-all text-[#94A3B8]">
                {result.trace.sourceIds.join(', ')}
              </dd>
            </div>
          ) : null}
        </dl>
      </details>
    </section>
  );
}
