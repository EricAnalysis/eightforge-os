'use client';

import type { ValidationStatus } from '@/types/validator';

type ValidatorStatusChipProps = {
  status: ValidationStatus;
  criticalCount?: number;
  warningCount?: number;
  size?: 'sm' | 'md';
};

const STATUS_LABELS: Record<ValidationStatus, string> = {
  NOT_READY: 'Not Ready',
  BLOCKED: 'Blocked',
  VALIDATED: 'Validated',
  FINDINGS_OPEN: 'Findings Open',
};

function statusClassName(status: ValidationStatus): string {
  switch (status) {
    case 'BLOCKED':
      return 'border-[#EF4444]/45 bg-[#3A1117] text-[#FCA5A5]';
    case 'VALIDATED':
      return 'border-[#22C55E]/35 bg-[#0F2417] text-[#86EFAC]';
    case 'FINDINGS_OPEN':
      return 'border-[#F59E0B]/35 bg-[#2A1C08] text-[#FCD34D]';
    case 'NOT_READY':
    default:
      return 'border-[#2F3B52]/80 bg-[#111827] text-[#C7D2E3]';
  }
}

function countBadgeClassName(kind: 'critical' | 'warning'): string {
  if (kind === 'critical') {
    return 'bg-[#45141B] text-[#FCA5A5]';
  }

  return 'bg-[#31230F] text-[#FCD34D]';
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
