'use client';

import { ValidatorStatusChip } from '@/components/validator/ValidatorStatusChip';
import type { ProjectOverviewAuditItem } from '@/lib/projectOverview';

export function ValidationAuditEventSummary({
  item,
}: {
  item: ProjectOverviewAuditItem;
}) {
  const summary = item.validation_run;
  if (!summary) return null;

  const rulesAppliedLabel = summary.rule_version
    ? `${summary.rules_applied_count} rules applied / ${summary.rule_version}`
    : `${summary.rules_applied_count} rules applied`;

  return (
    <div className="mt-2 space-y-2">
      <ValidatorStatusChip
        status={summary.status}
        criticalCount={summary.critical_count}
        warningCount={summary.warning_count}
        size="sm"
      />

      <details className="rounded-sm border border-[#2F3B52]/70 bg-[#111827]/70 px-3 py-2">
        <summary className="cursor-pointer text-[10px] font-bold uppercase tracking-[0.16em] text-[#94A3B8]">
          Run summary
        </summary>
        <div className="mt-2 space-y-1 text-[11px] text-[#C7D2E3]">
          <p>New findings: {summary.new_findings_count}</p>
          <p>Resolved findings: {summary.resolved_findings_count}</p>
          <p>{rulesAppliedLabel}</p>
        </div>
      </details>
    </div>
  );
}
