'use client';

import type { ValidationStatus } from '@/types/validator';

type ValidatorStatusChipProps = {
  status: ValidationStatus;
  criticalCount?: number;
  warningCount?: number;
  size?: 'sm' | 'md';
};

const STATUS_LABELS: Record<ValidationStatus, string> = {
  NOT_READY: 'Not Evaluated',
  BLOCKED: 'Requires Verification',
  VALIDATED: 'Approved',
  FINDINGS_OPEN: 'Needs Review',
};

function statusClassName(status: ValidationStatus): string {
  switch (status) {
    case 'BLOCKED':
      return 'border-[var(--ef-critical-a45)] bg-[var(--ef-critical-bg)] text-[var(--ef-critical-soft)]';
    case 'VALIDATED':
      return 'border-[var(--ef-success-a35)] bg-[var(--ef-success-bg)] text-[var(--ef-success-soft)]';
    case 'FINDINGS_OPEN':
      return 'border-[var(--ef-warning-a35)] bg-[var(--ef-warning-bg)] text-[var(--ef-warning-soft)]';
    case 'NOT_READY':
    default:
      return 'border-[var(--ef-border-subtle-a80)] bg-[var(--ef-background-secondary)] text-[var(--ef-text-secondary)]';
  }
}

function countBadgeClassName(kind: 'critical' | 'warning'): string {
  if (kind === 'critical') {
    return 'bg-[var(--ef-critical-bg)] text-[var(--ef-critical-soft)]';
  }

  return 'bg-[var(--ef-warning-bg)] text-[var(--ef-warning-soft)]';
}

export function ValidatorStatusChip({
  status,
  criticalCount,
  warningCount,
  size = 'md',
}: ValidatorStatusChipProps) {
  const hasCriticalCount = typeof criticalCount === 'number';
  const hasWarningCount = typeof warningCount === 'number';
  const sizeClassName =
    size === 'sm'
      ? 'gap-2 px-2.5 py-1 text-[10px] tracking-[0.14em]'
      : 'gap-2.5 px-3.5 py-1.5 text-[11px] tracking-[0.16em]';

  return (
    <span
      className={`inline-flex items-center rounded-full border font-semibold uppercase ${sizeClassName} ${statusClassName(status)}`}
    >
      <span>{STATUS_LABELS[status]}</span>
      {hasCriticalCount ? (
        <span className={`rounded-full px-2 py-0.5 text-[9px] font-bold ${countBadgeClassName('critical')}`}>
          {criticalCount} critical
        </span>
      ) : null}
      {hasWarningCount ? (
        <span className={`rounded-full px-2 py-0.5 text-[9px] font-bold ${countBadgeClassName('warning')}`}>
          {warningCount} warning
        </span>
      ) : null}
    </span>
  );
}
