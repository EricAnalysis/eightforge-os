'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { buildDecisionEvidenceHref } from '@/lib/decisionNavigation';
import { executeProjectDecisionResolution, type ProjectDecisionResolutionAction } from '@/lib/projectDecisionResolution';
import type { OverviewTone, ProjectOverviewDecisionCard } from '@/lib/projectOverview';
import { redirectIfUnauthorized } from '@/lib/redirectIfUnauthorized';
import { supabase } from '@/lib/supabaseClient';

type ProjectDecisionExecutionCardProps = {
  decision: ProjectOverviewDecisionCard;
  onProjectRefresh?: (() => void) | (() => Promise<void>);
};

function toneBorderClass(tone: OverviewTone): string {
  switch (tone) {
    case 'info':
      return 'border-l-[var(--ef-purple-accent)]';
    case 'success':
      return 'border-l-[var(--ef-success)]';
    case 'warning':
      return 'border-l-[var(--ef-warning)]';
    case 'danger':
      return 'border-l-[var(--ef-critical)]';
    case 'muted':
      return 'border-l-[var(--ef-border-subtle)]';
    default:
      return 'border-l-[var(--ef-purple-primary)]';
  }
}

function toneBadgeClass(tone: OverviewTone): string {
  switch (tone) {
    case 'info':
      return 'border border-[var(--ef-purple-glow-a25)] bg-[var(--ef-purple-glow-a10)] text-[var(--ef-purple-accent)]';
    case 'success':
      return 'border border-[var(--ef-success-a30)] bg-[var(--ef-success-bg)] text-[var(--ef-success)]';
    case 'warning':
      return 'border border-[var(--ef-warning-a30)] bg-[var(--ef-warning-bg)] text-[var(--ef-warning)]';
    case 'danger':
      return 'border border-[var(--ef-critical-a30)] bg-[var(--ef-critical-a10)] text-[var(--ef-critical)]';
    case 'muted':
      return 'border border-[var(--ef-border-subtle)] bg-[var(--ef-surface-elevated)] text-[var(--ef-text-muted)]';
    default:
      return 'border border-[var(--ef-border-subtle)] bg-[var(--ef-surface-elevated)] text-[var(--ef-text-primary)]';
  }
}

function ExecutionField(props: {
  label: string;
  value: string;
  emphasis?: 'default' | 'warning';
}) {
  const { label, value, emphasis = 'default' } = props;
  return (
    <div className="rounded-sm border border-[var(--ef-border-subtle-a70)] bg-[var(--ef-background-secondary)] p-4">
      <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[var(--ef-text-muted)]">
        {label}
      </p>
      <p className={`mt-2 text-sm leading-6 ${emphasis === 'warning' ? 'text-[var(--ef-warning-soft)]' : 'text-[var(--ef-text-secondary)]'}`}>
        {value}
      </p>
    </div>
  );
}

export function ProjectDecisionExecutionCard(
  props: ProjectDecisionExecutionCardProps,
) {
  const { decision, onProjectRefresh } = props;
  const router = useRouter();
  const [savingAction, setSavingAction] = useState<ProjectDecisionResolutionAction | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  async function runResolution(action: ProjectDecisionResolutionAction) {
    setSavingAction(action);
    setActionMessage(null);
    setActionError(null);

    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      if (!token) {
        setActionError('Authentication required.');
        return;
      }

      const result = await executeProjectDecisionResolution({
        decisionId: decision.id,
        action,
        accessToken: token,
      });

      if (redirectIfUnauthorized(result.response as Response, router.replace)) return;

      const body = await result.response.json().catch(() => ({}));
      if (!result.response.ok) {
        const message =
          typeof (body as { error?: unknown }).error === 'string'
            ? (body as { error: string }).error
            : 'Decision update failed.';
        setActionError(message);
        return;
      }

      setActionMessage(result.successMessage);
      await onProjectRefresh?.();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Decision update failed.');
    } finally {
      setSavingAction(null);
    }
  }

  const showResolve = decision.status_key !== 'resolved';
  const showSuppress = decision.status_key !== 'dismissed';
  const sourceDocumentLabel = decision.source_document_title ?? 'Project record';
  const inspectEvidenceHref = buildDecisionEvidenceHref(decision.id);

  return (
    <article
      className={`rounded-sm border-y border-r border-[var(--ef-border-subtle-a50)] border-l-2 ${toneBorderClass(decision.border_tone)} bg-[var(--ef-background-secondary)] p-6`}
    >
      <div className="flex flex-col gap-5">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
          <div className="min-w-0">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <Link
                href={decision.href}
                className="text-lg font-bold tracking-tight text-[var(--ef-text-primary)] transition-colors hover:text-[var(--ef-purple-primary)]"
              >
                {decision.title}
              </Link>
              <span className={`rounded-sm px-2 py-0.5 text-[9px] font-bold uppercase tracking-[0.18em] ${toneBadgeClass(decision.status_tone)}`}>
                {decision.status_label}
              </span>
            </div>
            <p className="text-xs text-[var(--ef-text-muted)]">
              {decision.freshness_label}
            </p>
          </div>

          <div className="flex flex-wrap gap-3">
            <Link
              href={decision.href}
              className="inline-flex items-center justify-center rounded-sm border border-[var(--ef-border-subtle)] bg-[var(--ef-surface-elevated)] px-4 py-2 text-[11px] font-bold uppercase tracking-[0.14em] text-[var(--ef-text-primary)] transition-colors hover:bg-[var(--ef-surface-hover)]"
            >
              Open Decision Context
            </Link>
            <Link
              href={inspectEvidenceHref}
              className="inline-flex items-center justify-center rounded-sm border border-[var(--ef-border-subtle)] bg-[var(--ef-background-secondary)] px-4 py-2 text-[11px] font-bold uppercase tracking-[0.14em] text-[var(--ef-text-secondary)] transition-colors hover:bg-[var(--ef-surface-hover)]"
            >
              Inspect Evidence
            </Link>
          </div>
        </div>

        <div className="grid gap-4 xl:grid-cols-3">
          <ExecutionField label="Problem" value={decision.problem} />
          <ExecutionField label="Impact" value={decision.impact} emphasis="warning" />
          <ExecutionField label="Required Action" value={decision.required_action} />
        </div>

        <div className="grid gap-4 lg:grid-cols-4">
          <ExecutionField label="Owner" value={decision.owner_label} />
          <ExecutionField label="Due Date" value={decision.due_label ?? 'No due date'} />
          <ExecutionField label="Status" value={decision.status_label} />
          <ExecutionField label="Source Evidence" value={decision.source_evidence_label || sourceDocumentLabel} />
        </div>

        {decision.metadata.length > 0 ? (
          <div className="flex flex-wrap items-center gap-3 text-[10px] font-medium uppercase tracking-[0.14em] text-[var(--ef-text-muted)]">
            {decision.metadata.map((item) => (
              <span key={item}>{item}</span>
            ))}
          </div>
        ) : null}

        <div className="rounded-sm border border-[var(--ef-border-subtle-a70)] bg-[var(--ef-background-secondary)] p-4">
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={() => runResolution('mark_correct')}
              disabled={savingAction != null}
              className="rounded-sm border border-[var(--ef-success-a30)] bg-[var(--ef-success-bg)] px-3 py-2 text-[11px] font-bold uppercase tracking-[0.18em] text-[var(--ef-success)] transition-colors hover:bg-[var(--ef-success-a18)] disabled:opacity-60"
            >
              Mark Correct
            </button>
            <button
              type="button"
              onClick={() => runResolution('request_correction')}
              disabled={savingAction != null}
              className="rounded-sm border border-[var(--ef-warning-a30)] bg-[var(--ef-warning-bg)] px-3 py-2 text-[11px] font-bold uppercase tracking-[0.18em] text-[var(--ef-warning)] transition-colors hover:bg-[var(--ef-warning-a18)] disabled:opacity-60"
            >
              Request Correction
            </button>
            {showResolve ? (
              <button
                type="button"
                onClick={() => runResolution('mark_resolved')}
                disabled={savingAction != null}
                className="rounded-sm border border-[var(--ef-purple-primary-a30)] bg-[var(--ef-purple-primary-a12)] px-3 py-2 text-[11px] font-bold uppercase tracking-[0.18em] text-[var(--ef-purple-glow)] transition-colors hover:bg-[var(--ef-purple-primary-a18)] disabled:opacity-60"
              >
                Mark Resolved
              </button>
            ) : null}
            {showSuppress ? (
              <button
                type="button"
                onClick={() => runResolution('suppress')}
                disabled={savingAction != null}
                className="rounded-sm border border-[var(--ef-border-subtle)] bg-[var(--ef-surface-elevated)] px-3 py-2 text-[11px] font-bold uppercase tracking-[0.18em] text-[var(--ef-text-secondary)] transition-colors hover:bg-[var(--ef-surface-hover)] disabled:opacity-60"
              >
                Suppress
              </button>
            ) : null}
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-[var(--ef-text-muted)]">
            {savingAction ? <span>Saving decision update...</span> : null}
            {actionMessage ? <span className="text-[var(--ef-success)]">{actionMessage}</span> : null}
            {actionError ? <span className="text-[var(--ef-critical)]">{actionError}</span> : null}
          </div>
        </div>
      </div>
    </article>
  );
}
