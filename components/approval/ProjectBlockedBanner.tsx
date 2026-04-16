'use client';

import { AlertCircle, XCircle } from 'lucide-react';
import { useState } from 'react';
import type { ProjectApprovalSnapshot } from '@/lib/server/approvalSnapshots';

type ProjectBlockedBannerProps = {
  approval: ProjectApprovalSnapshot;
  dismissible?: boolean;
  onDismiss?: () => void;
};

export function ProjectBlockedBanner({
  approval,
  dismissible = false,
  onDismiss,
}: ProjectBlockedBannerProps) {
  const [isDismissed, setIsDismissed] = useState(false);

  // Only show if blocked
  if (approval.approval_status !== 'blocked' || isDismissed) {
    return null;
  }

  const handleDismiss = () => {
    setIsDismissed(true);
    onDismiss?.();
  };

  // Extract blocking reasons from finding_ids or status
  const blockingReasons: string[] = [];
  if (approval.blocked_invoice_count > 0) {
    blockingReasons.push(`${approval.blocked_invoice_count} blocked invoice(s)`);
  }
  if (approval.needs_review_invoice_count > 0) {
    blockingReasons.push(`${approval.needs_review_invoice_count} invoice(s) need review`);
  }
  if (blockingReasons.length === 0) {
    blockingReasons.push('Project contains blocking issues');
  }

  return (
    <div className="rounded-lg border border-red-500/40 bg-red-950/30 px-4 py-3 backdrop-blur-sm">
      <div className="flex items-start gap-3">
        <AlertCircle className="h-5 w-5 flex-shrink-0 text-red-400 mt-0.5" />

        <div className="flex-1 min-w-0">
          <h3 className="font-semibold text-red-100 mb-1">Project Blocked</h3>

          {approval.blocked_amount && approval.blocked_amount > 0 && (
            <p className="text-sm text-red-200/80 mb-2">
              Blocked amount: <span className="font-mono font-semibold">${(approval.blocked_amount / 100).toFixed(2)}</span>
            </p>
          )}

          {blockingReasons.length > 0 && (
            <ul className="text-sm text-red-200/70 space-y-1 mb-3">
              {blockingReasons.slice(0, 3).map((reason, idx) => (
                <li key={idx} className="flex items-center gap-2">
                  <span className="text-red-400">•</span>
                  {reason}
                </li>
              ))}
            </ul>
          )}

          <a
            href={`/platform/projects/${approval.project_id}#project-validator`}
            className="inline-flex items-center gap-1 text-sm font-medium text-red-300 hover:text-red-200 transition-colors"
          >
            View Blocked Items →
          </a>
        </div>

        {dismissible && (
          <button
            onClick={handleDismiss}
            className="flex-shrink-0 text-red-400/60 hover:text-red-300 transition-colors p-1"
            aria-label="Dismiss banner"
          >
            <XCircle className="h-5 w-5" />
          </button>
        )}
      </div>
    </div>
  );
}
