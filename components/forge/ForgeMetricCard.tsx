'use client';

import type { ReactNode } from 'react';

export type ForgeMetricTone = 'critical' | 'warning' | 'success' | 'interactive' | 'neutral';

type ForgeMetricRadius = 'sm' | 'lg';
type ForgeMetricValueSize = 'md' | 'lg';
type ForgeMetricLabelWeight = 'semibold' | 'bold';
type ForgeMetricAccent = 'dot' | 'none';

function joinClasses(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

function valueToneClass(tone: ForgeMetricTone): string {
  switch (tone) {
    case 'critical':
      return 'text-[var(--ef-critical-soft)]';
    case 'warning':
      return 'text-[var(--ef-warning-soft)]';
    case 'success':
      return 'text-[var(--ef-success-soft)]';
    case 'interactive':
      return 'text-[var(--ef-purple-glow)]';
    case 'neutral':
    default:
      return 'text-[var(--ef-text-primary)]';
  }
}

function accentDotClass(tone: ForgeMetricTone): string {
  switch (tone) {
    case 'critical':
      return 'bg-[var(--ef-critical)]';
    case 'warning':
      return 'bg-[var(--ef-warning)]';
    case 'success':
      return 'bg-[var(--ef-success)]';
    case 'interactive':
      return 'bg-[var(--ef-purple-primary)]';
    case 'neutral':
    default:
      return 'bg-[var(--ef-border-subtle)]';
  }
}

function radiusClass(radius: ForgeMetricRadius): string {
  return radius === 'sm' ? 'rounded-sm' : 'rounded-2xl';
}

function valueSizeClass(valueSize: ForgeMetricValueSize): string {
  return valueSize === 'lg'
    ? 'mt-4 text-[28px] font-bold tracking-tight'
    : 'mt-4 text-[24px] font-semibold tracking-tight';
}

function labelWeightClass(labelWeight: ForgeMetricLabelWeight): string {
  return labelWeight === 'bold' ? 'font-bold' : 'font-semibold';
}

export function ForgeMetricCard(props: {
  label: string;
  value: ReactNode;
  supporting?: ReactNode;
  tone?: ForgeMetricTone;
  accent?: ForgeMetricAccent;
  radius?: ForgeMetricRadius;
  valueSize?: ForgeMetricValueSize;
  labelWeight?: ForgeMetricLabelWeight;
  className?: string;
}) {
  const {
    label,
    value,
    supporting,
    tone = 'neutral',
    accent = 'none',
    radius = 'lg',
    valueSize = 'md',
    labelWeight = 'semibold',
    className,
  } = props;

  return (
    <div
      className={joinClasses(
        radiusClass(radius),
        'border border-[var(--ef-border-subtle-a70)] bg-[var(--ef-background-secondary)] px-4 py-4',
        className,
      )}
    >
      {accent === 'dot' ? (
        <div className="flex items-center gap-2">
          <span className={joinClasses('h-2 w-2 rounded-full', accentDotClass(tone))} />
          <p
            className={joinClasses(
              'text-[10px] uppercase tracking-[0.18em] text-[var(--ef-text-muted)]',
              labelWeightClass(labelWeight),
            )}
          >
            {label}
          </p>
        </div>
      ) : (
        <p
          className={joinClasses(
            'text-[10px] uppercase tracking-[0.18em] text-[var(--ef-text-muted)]',
            labelWeightClass(labelWeight),
          )}
        >
          {label}
        </p>
      )}

      <p className={joinClasses(valueSizeClass(valueSize), valueToneClass(tone))}>{value}</p>

      {supporting ? (
        <p className="mt-2 text-[11px] leading-relaxed text-[var(--ef-text-muted)]">
          {supporting}
        </p>
      ) : null}
    </div>
  );
}
