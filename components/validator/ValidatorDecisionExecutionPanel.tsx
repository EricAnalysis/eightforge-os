'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ForgeDetailPanel } from '@/components/forge/ForgeDetailPanel';
import { ForgeSectionCard } from '@/components/forge/ForgeSectionCard';
import { executionItemOutcomeLabel, executionItemStatusLabel } from '@/lib/executionItems';
import type { IssueObject } from '@/lib/issueObjects';
import {
  executeProjectExecutionResolution,
  type ProjectExecutionResolutionAction,
} from '@/lib/projectExecutionResolution';
import { redirectIfUnauthorized } from '@/lib/redirectIfUnauthorized';
import { supabase } from '@/lib/supabaseClient';
import { ManualRateLinkResolutionPanel } from '@/components/validator/ManualRateLinkResolutionPanel';

type ValidatorDecisionExecutionPanelProps = {
  issue: IssueObject | null;
  onActionComplete: () => void | Promise<void>;
};

const ACTIONS: Array<{ key: ProjectExecutionResolutionAction; label: string }> = [
  { key: 'approve', label: 'Confirm' },
  { key: 'correct', label: 'Correct' },
  { key: 'override', label: 'Override' },
];

function buttonToneClassName(action: ProjectExecutionResolutionAction): string {
  if (action === 'approve') {
    return 'border-[var(--ef-purple-primary-a30)] bg-[var(--ef-purple-primary)] text-white hover:bg-[var(--ef-purple-glow)]';
  }
  if (action === 'override') {
    return 'border-[var(--ef-warning-a35)] bg-[var(--ef-background-primary)] text-[var(--ef-warning-soft)] hover:bg-[var(--ef-warning-bg)]';
  }
  return 'border-[var(--ef-border-subtle)] bg-[var(--ef-background-primary)] text-[var(--ef-text-primary)] hover:border-[var(--ef-text-primary)] hover:text-white';
}

export function ValidatorDecisionExecutionPanel({
  issue,
  onActionComplete,
}: ValidatorDecisionExecutionPanelProps) {
  const router = useRouter();
  const [justification, setJustification] = useState('');
  const [savingAction, setSavingAction] = useState<ProjectExecutionResolutionAction | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setJustification('');
    setMessage(null);
    setError(null);
    setSavingAction(null);
  }, [issue?.issueId]);

  if (issue?.finding.rule_id === 'FINANCIAL_RATE_CODE_MISSING') {
    return (
      <ManualRateLinkResolutionPanel
        issue={issue}
        onActionComplete={onActionComplete}
      />
    );
  }

  const header = (
    <div className="space-y-2">
      <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-[var(--ef-text-muted)]">
        Decision &amp; Execution
      </p>
      <div className="rounded-sm border border-[var(--ef-warning-a30)] bg-[var(--ef-warning-bg)] px-3 py-2 text-[11px] leading-5 text-[var(--ef-warning-soft)]">
        Any action below creates an Execution record. Validator never mutates canonical truth directly.
      </div>
    </div>
  );

  if (!issue) {
    return (
      <ForgeDetailPanel surface="subtle" radius="sm" padding="md">
        {header}
        <p className="mt-4 text-sm leading-6 text-[var(--ef-text-muted)]">
          Select a finding to review the available Confirm, Correct, or Override actions.
        </p>
      </ForgeDetailPanel>
    );
  }

  const executionItem = issue.executionItem;
  const executionItemId = issue.executionItemId;
  const alreadyResolved = executionItem?.status === 'resolved';

  async function runAction(action: ProjectExecutionResolutionAction) {
    if (!executionItemId) return;
    setSavingAction(action);
    setMessage(null);
    setError(null);

    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const token = session?.access_token;
      if (!token) {
        setError('Authentication required.');
        return;
      }

      const result = await executeProjectExecutionResolution({
        executionItemId,
        action,
        reason: justification,
        accessToken: token,
      });

      if (redirectIfUnauthorized(result.response as Response, router.replace)) return;

      const body = await result.response.json().catch(() => ({}));
      if (!result.response.ok) {
        const messageText =
          typeof (body as { error?: unknown }).error === 'string'
            ? (body as { error: string }).error
            : 'Execution update failed.';
        setError(messageText);
        return;
      }

      setMessage(result.successMessage);
      setJustification('');
      await onActionComplete();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Execution update failed.');
    } finally {
      setSavingAction(null);
    }
  }

  return (
    <ForgeDetailPanel surface="subtle" radius="sm" padding="md">
      {header}

      {!executionItemId ? (
        <ForgeSectionCard as="div" surface="primary" radius="sm" padding="md" className="mt-4">
          <p className="text-sm leading-6 text-[var(--ef-text-muted)]">
            No execution item exists yet for this finding. Execution items are created automatically
            when validator findings are synced &mdash; revalidate the project if this finding is new.
          </p>
        </ForgeSectionCard>
      ) : alreadyResolved ? (
        <ForgeSectionCard as="div" surface="primary" radius="sm" padding="md" className="mt-4">
          <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-[var(--ef-success-soft)]">
            Resolved &mdash; history record
          </p>
          <p className="mt-2 text-sm leading-6 text-[var(--ef-text-secondary)]">
            {[
              executionItemStatusLabel(executionItem.status),
              executionItemOutcomeLabel(executionItem.outcome),
              executionItem.override_reason ? `Reason: ${executionItem.override_reason}` : null,
            ].filter(Boolean).join(' / ')}
          </p>
        </ForgeSectionCard>
      ) : (
        <div className="mt-4 space-y-3">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[var(--ef-text-muted)]">
              Justification
            </p>
            <textarea
              value={justification}
              onChange={(event) => setJustification(event.target.value)}
              rows={3}
              placeholder="Explain the basis for this action before it can be submitted."
              className="mt-2 w-full rounded-sm border border-[var(--ef-border-subtle)] bg-[var(--ef-background-primary)] px-3 py-2 text-sm text-[var(--ef-text-primary)] outline-none focus:border-[var(--ef-purple-primary)]"
            />
          </div>

          <div className="grid gap-2 sm:grid-cols-3">
            {ACTIONS.map((entry) => (
              <button
                key={entry.key}
                type="button"
                onClick={() => void runAction(entry.key)}
                disabled={savingAction != null || justification.trim().length === 0}
                className={`rounded-sm border px-3 py-2 text-[10px] font-bold uppercase tracking-[0.14em] transition-colors disabled:cursor-not-allowed disabled:border-[var(--ef-border-subtle-a70)] disabled:bg-[var(--ef-background-primary)] disabled:text-[var(--ef-text-soft)] ${buttonToneClassName(entry.key)}`}
              >
                {savingAction === entry.key ? 'Recording...' : entry.label}
              </button>
            ))}
          </div>

          {message ? <p className="text-[11px] text-[var(--ef-success-soft)]">{message}</p> : null}
          {error ? <p className="text-[11px] text-[var(--ef-critical-soft)]">{error}</p> : null}
        </div>
      )}
    </ForgeDetailPanel>
  );
}
