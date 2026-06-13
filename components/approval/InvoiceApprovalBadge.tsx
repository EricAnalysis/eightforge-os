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
      bgColor: 'bg-red-950/40',
      borderColor: 'border-red-500/40',
      textColor: 'text-red-300',
      iconColor: 'text-red-400',
    },
    needs_review: {
      icon: Clock,
      label: 'Needs Review',
      bgColor: 'bg-yellow-950/40',
      borderColor: 'border-yellow-500/40',
      textColor: 'text-yellow-300',
      iconColor: 'text-yellow-400',
    },
    approved: {
      icon: CheckCircle,
      label: 'Approved',
      bgColor: 'bg-green-950/40',
      borderColor: 'border-green-500/40',
      textColor: 'text-green-300',
      iconColor: 'text-green-400',
    },
    approved_with_exceptions: {
      icon: HelpCircle,
      label: 'Approved (Exceptions)',
      bgColor: 'bg-slate-700/40',
      borderColor: 'border-slate-500/40',
      textColor: 'text-slate-300',
      iconColor: 'text-slate-400',
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
        <span className={`text-xs font-mono ml-1 ${config.textColor}/80`}>
          ${(approval.at_risk_amount / 100).toFixed(2)}
        </span>
      )}
    </div>
  );

  // Show tooltip only if there are blocking reasons or at-risk amount
  if (approval.blocking_reasons?.length > 0 || (approval.at_risk_amount && approval.at_risk_amount > 0)) {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>{content}</TooltipTrigger>
          <TooltipContent side="left" className="max-w-xs">
            <div className="space-y-2">
              {approval.approval_status === 'blocked' && (
                <p className="font-semibold text-red-300">Blocked</p>
              )}
              {approval.blocking_reasons && approval.blocking_reasons.length > 0 && (
                <ul className="text-sm space-y-1">
                  {approval.blocking_reasons.map((reason, idx) => (
                    <li key={idx} className="flex gap-2">
                      <span className="text-slate-400">•</span>
                      {reason}
                    </li>
                  ))}
                </ul>
              )}
              {approval.at_risk_amount && approval.at_risk_amount > 0 && (
                <p className="text-sm text-slate-300">
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
