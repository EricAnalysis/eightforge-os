'use client';

import { AlertCircle, CheckCircle, Clock, HelpCircle } from 'lucide-react';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import type { InvoiceApprovalSnapshot } from '@/lib/server/approvalSnapshots';

type InvoiceApprovalBadgeProps = {
  approval: InvoiceApprovalSnapshot;
  compact?: boolean;
};

export function InvoiceApprovalBadge({ approval, compact = false }: InvoiceApprovalBadgeProps) {
  const statusConfig = {
    blocked: {
      icon: AlertCircle,
      label: 'Blocked',
      bgColor: 'bg-[var(--ef-critical-bg)]',
      borderColor: 'border-[var(--ef-critical-a40)]',
      textColor: 'text-[var(--ef-critical-soft)]',
      iconColor: 'text-[var(--ef-critical)]',
    },
    needs_review: {
      icon: Clock,
      label: 'Needs Review',
      bgColor: 'bg-[var(--ef-warning-bg)]',
      borderColor: 'border-[var(--ef-warning-a40)]',
      textColor: 'text-[var(--ef-warning-soft)]',
      iconColor: 'text-[var(--ef-warning)]',
    },
    approved: {
      icon: CheckCircle,
      label: 'Approved',
      bgColor: 'bg-[var(--ef-success-bg)]',
      borderColor: 'border-[var(--ef-success-a40)]',
      textColor: 'text-[var(--ef-success-soft)]',
      iconColor: 'text-[var(--ef-success-soft)]',
    },
    approved_with_exceptions: {
      icon: HelpCircle,
      label: 'Approved (Exceptions)',
      bgColor: 'bg-[var(--ef-warning-bg)]',
      borderColor: 'border-[var(--ef-warning-a40)]',
      textColor: 'text-[var(--ef-warning-soft)]',
      iconColor: 'text-[var(--ef-warning)]',
    },
  };

  const config = statusConfig[approval.approval_status];
  const Icon = config.icon;

  const content = (
    <div className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 ${config.bgColor} ${config.borderColor}`}>
      <Icon className={`h-4 w-4 flex-shrink-0 ${config.iconColor}`} />
      <span className={`text-sm font-medium ${config.textColor}`}>
        {compact ? approval.approval_status.split('_')[0]?.toUpperCase() : config.label}
      </span>
      {!compact && approval.at_risk_amount && approval.at_risk_amount > 0 && (
        <span className="ml-1 text-xs font-mono text-[var(--ef-text-secondary)]">
          ${(approval.at_risk_amount / 100).toFixed(2)}
        </span>
      )}
    </div>
  );

  // Show tooltip only if there are blocking reasons or at-risk amount
  if (
    approval.blocking_reasons?.length > 0 ||
    (approval.at_risk_amount && approval.at_risk_amount > 0)
  ) {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>{content}</TooltipTrigger>
          <TooltipContent side="left" className="max-w-xs">
            <div className="space-y-2">
              {approval.approval_status === 'blocked' && (
                <p className="font-semibold text-[var(--ef-critical-soft)]">Blocked</p>
              )}
              {approval.blocking_reasons && approval.blocking_reasons.length > 0 && (
                <ul className="space-y-1 text-sm">
                  {approval.blocking_reasons.map((reason, idx) => (
                    <li key={idx} className="flex gap-2">
                      <span className="text-[var(--ef-text-faint)]">-</span>
                      {reason}
                    </li>
                  ))}
                </ul>
              )}
              {approval.at_risk_amount && approval.at_risk_amount > 0 && (
                <p className="text-sm text-[var(--ef-text-secondary)]">
                  At-risk amount: ${(approval.at_risk_amount / 100).toFixed(2)}
                </p>
              )}
            </div>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  return content;
}
