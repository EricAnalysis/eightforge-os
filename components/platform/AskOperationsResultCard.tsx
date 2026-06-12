'use client';

import Link from 'next/link';
import type { AskOperationsResult } from '@/lib/operationsQuery/types';

function sectionHeading(label: string) {
  return (
    <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--ef-text-soft)]">
      {label}
    </p>
  );
}

function statusTone(status: AskOperationsResult['status']): string {
  if (status === 'Verified') return 'text-[var(--ef-success-soft)] border-[var(--ef-success-a30)] bg-[var(--ef-success-a08)]';
  if (status === 'Derived') return 'text-[var(--ef-text-secondary)] border-[var(--ef-border-subtle-a70)] bg-[var(--ef-surface-hover-a70)]';
  if (status === 'Ranked') return 'text-[var(--ef-text-secondary)] border-[var(--ef-border-subtle-a70)] bg-[var(--ef-surface-hover-a70)]';
  if (status === 'Signal') return 'text-[var(--ef-critical-soft)] border-[var(--ef-critical-a40)] bg-[var(--ef-critical-a10)]';
  if (status === 'Missing') return 'text-[var(--ef-text-muted)] border-[var(--ef-border-subtle-a70)] bg-[var(--ef-background-secondary)]';
  return 'text-[var(--ef-text-muted)] border-[var(--ef-border-subtle-a70)] bg-[var(--ef-background-secondary)]';
}

function confidenceTone(level: AskOperationsResult['confidenceLevel']): string {
  if (level === 'HIGH') return 'text-[var(--ef-success-soft)]';
  if (level === 'MEDIUM') return 'text-[var(--ef-warning-soft)]';
  if (level === 'LOW') return 'text-[var(--ef-text-muted)]';
  return 'text-[var(--ef-text-faint)]';
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

function extractFreshnessTimestamp(result: AskOperationsResult): string | null {
  void result;
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
          className="block rounded-lg border border-[var(--ef-purple-primary-a45)] bg-[var(--ef-purple-primary-a14)] px-3 py-2.5 text-center text-[11px] font-semibold text-[var(--ef-purple-glow)] transition hover:border-[var(--ef-purple-primary-a60)] hover:bg-[var(--ef-purple-primary-a20)]"
        >
          {primaryQueue.label}
        </Link>
        {otherActions.length > 0 ? (
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--ef-text-faint)]">
              Secondary links
            </p>
            <div className="mt-1.5 flex flex-wrap gap-2">
              {otherActions.map((action) => (
                <Link
                  key={`${action.label}-${action.href}`}
                  href={action.href}
                  className="rounded-lg border border-[var(--ef-border-subtle-a70)] bg-[var(--ef-background-primary)] px-2.5 py-1 text-[10px] font-medium text-[var(--ef-purple-glow)] transition hover:border-[var(--ef-purple-primary-a35)]"
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
          className="rounded-lg border border-[var(--ef-purple-primary-a35)] bg-[var(--ef-purple-primary-a10)] px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--ef-purple-glow)] transition hover:border-[var(--ef-purple-primary-a60)] hover:bg-[var(--ef-purple-primary-a16)]"
        >
          {action.label}
        </Link>
      ))}
    </div>
  );
}

export function AskOperationsResultCard({ result }: { result: AskOperationsResult }) {
  return (
    <section className="rounded-xl border border-[var(--ef-border-subtle-a70)] bg-[linear-gradient(180deg,var(--ef-surface-overlay),var(--ef-surface-overlay))] px-4 py-4">
      <div>
        {sectionHeading('Result')}
        <div className="mt-2 rounded-lg border border-[var(--ef-border-subtle-a60)] bg-[var(--ef-background-primary)] px-3 py-2">
          <p className="text-[12px] leading-relaxed text-[var(--ef-text-primary)]">{result.result}</p>
        </div>
      </div>

      <div className="mt-4 border-t border-[var(--ef-border-subtle-a50)] pt-3">
        {sectionHeading('Evidence')}
        {result.evidence.length === 0 ? (
          <p className="mt-2 text-[11px] text-[var(--ef-text-muted)]">None.</p>
        ) : (
          <div className="mt-2 space-y-2">
            {result.evidence.map((ev) => (
              <Link
                key={ev.sourceId}
                href={ev.href}
                className="block rounded-lg border border-[var(--ef-border-subtle-a60)] bg-[var(--ef-background-primary)] px-3 py-2 transition hover:border-[var(--ef-purple-primary-a40)]"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="text-[11px] font-semibold text-[var(--ef-text-secondary)]">{ev.projectName}</p>
                  <p className="text-[10px] font-mono text-[var(--ef-text-faint)]">{ev.sourceId}</p>
                </div>
                <p className="mt-1 text-[11px] leading-relaxed text-[var(--ef-text-muted)]">{ev.detail}</p>
              </Link>
            ))}
          </div>
        )}
      </div>

      <div className="mt-4 border-t border-[var(--ef-border-subtle-a50)] pt-3">
        {sectionHeading('Data freshness')}
        <p className="mt-1.5 truncate text-[10px] font-normal leading-snug text-[var(--ef-text-faint)]">
          {formatDataFreshnessLine(result)}
        </p>
      </div>

      <div className="mt-4 border-t border-[var(--ef-border-subtle-a50)] pt-3">
        {sectionHeading('Status')}
        <div className="mt-2">
          <span
            className={`inline-flex items-center rounded border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.14em] ${statusTone(result.status)}`}
          >
            {result.status}
          </span>
        </div>
      </div>

      <div className="mt-4 border-t border-[var(--ef-border-subtle-a50)] pt-3">
        {sectionHeading('Next action')}
        <p className="mt-2 text-[11px] text-[var(--ef-text-secondary)]">{result.nextAction ?? '—'}</p>
      </div>

      <div className="mt-4 border-t border-[var(--ef-border-subtle-a50)] pt-3">
        {sectionHeading('Confidence')}
        <p className={`mt-2 text-[11px] font-semibold uppercase tracking-[0.12em] ${confidenceTone(result.confidenceLevel)}`}>
          {result.confidenceLevel}
        </p>
      </div>

      {result.routingActions.length > 0 ? (
        <div className="mt-4 border-t border-[var(--ef-border-subtle-a50)] pt-3">
          {sectionHeading('Route')}
          <RoutingBlock actions={result.routingActions} />
        </div>
      ) : null}

      <details className="mt-4 border-t border-[var(--ef-border-subtle-a50)] pt-3">
        <summary className="cursor-pointer text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--ef-text-faint)] transition hover:text-[var(--ef-text-muted)]">
          Trace
        </summary>
        <dl className="mt-2 space-y-1 text-[10px] font-mono text-[var(--ef-text-faint)]">
          <div>
            <dt className="inline text-[var(--ef-text-faint)]">intent </dt>
            <dd className="inline text-[var(--ef-text-muted)]">{result.trace.intentType}</dd>
          </div>
          <div>
            <dt className="inline text-[var(--ef-text-faint)]">routing </dt>
            <dd className="inline text-[var(--ef-text-muted)]">{result.trace.routingAttached ? 'yes' : 'no'}</dd>
          </div>
          {result.trace.sourceIds.length > 0 ? (
            <div>
              <dt className="mb-0.5 text-[var(--ef-text-faint)]">sources</dt>
              <dd className="whitespace-pre-wrap break-all text-[var(--ef-text-muted)]">
                {result.trace.sourceIds.join(', ')}
              </dd>
            </div>
          ) : null}
        </dl>
      </details>
    </section>
  );
}
