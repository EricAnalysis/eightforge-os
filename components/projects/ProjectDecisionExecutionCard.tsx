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
      return 'border-l-[#38BDF8]';
    case 'success':
      return 'border-l-[#22C55E]';
    case 'warning':
      return 'border-l-[#F59E0B]';
    case 'danger':
      return 'border-l-[#EF4444]';
    case 'muted':
      return 'border-l-[#2F3B52]';
    default:
      return 'border-l-[#3B82F6]';
  }
}

function toneBadgeClass(tone: OverviewTone): string {
  switch (tone) {
    case 'info':
      return 'border border-[#38BDF8]/25 bg-[#38BDF8]/10 text-[#38BDF8]';
    case 'success':
      return 'border border-[#22C55E]/25 bg-[#22C55E]/10 text-[#22C55E]';
    case 'warning':
      return 'border border-[#F59E0B]/25 bg-[#F59E0B]/10 text-[#F59E0B]';
    case 'danger':
      return 'border border-[#EF4444]/25 bg-[#EF4444]/10 text-[#EF4444]';
    case 'muted':
      return 'border border-[#2F3B52] bg-[#1A2333] text-[#94A3B8]';
    default:
      return 'border border-[#2F3B52] bg-[#1A2333] text-[#E5EDF7]';
  }
}

function ExecutionField(props: {
  label: string;
  value: string;
  emphasis?: 'default' | 'warning';
}) {
  const { label, value, emphasis = 'default' } = props;
  return (
    <div className="rounded-sm border border-[#2F3B52]/70 bg-[#0F172A] p-4">
      <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#94A3B8]">
        {label}
      </p>
      <p className={`mt-2 text-sm leading-6 ${emphasis === 'warning' ? 'text-[#FDE68A]' : 'text-[#C7D2E3]'}`}>
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
  const showSuppress = decision.status_key !== 'suppressed';
  const sourceDocumentLabel = decision.source_document_title ?? 'Project record';
  const inspectEvidenceHref = buildDecisionEvidenceHref(decision.id);

  return (
    <article
      className={`rounded-sm border-y border-r border-[#2F3B52]/50 border-l-2 ${toneBorderClass(decision.border_tone)} bg-[#111827] p-6`}
    >
      <div className="flex flex-col gap-5">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
          <div className="min-w-0">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <Link
                href={decision.href}
                className="text-lg font-bold tracking-tight text-[#E5EDF7] transition-colors hover:text-[#3B82F6]"
              >
                {decision.title}
              </Link>
              <span className={`rounded-sm px-2 py-0.5 text-[9px] font-bold uppercase tracking-[0.18em] ${toneBadgeClass(decision.status_tone)}`}>
                {decision.status_label}
              </span>
            </div>
            <p className="text-xs text-[#94A3B8]">
              {decision.freshness_label}
            </p>
          </div>

          <div className="flex flex-wrap gap-3">
            <Link
              href={decision.href}
              className="inline-flex items-center justify-center rounded-sm border border-[#2F3B52] bg-[#1A2333] px-4 py-2 text-[11px] font-bold uppercase tracking-[0.14em] text-[#E5EDF7] transition-colors hover:bg-[#243044]"
            >
              Open Decision Context
            </Link>
            <Link
              href={inspectEvidenceHref}
              className="inline-flex items-center justify-center rounded-sm border border-[#2F3B52] bg-[#0F172A] px-4 py-2 text-[11px] font-bold uppercase tracking-[0.14em] text-[#C7D2E3] transition-colors hover:bg-[#172033]"
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
          <div className="flex flex-wrap items-center gap-3 text-[10px] font-medium uppercase tracking-[0.14em] text-[#94A3B8]">
            {decision.metadata.map((item) => (
              <span key={item}>{item}</span>
            ))}
          </div>
        ) : null}

        <div className="rounded-sm border border-[#2F3B52]/70 bg-[#0F172A] p-4">
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={() => runResolution('mark_correct')}
              disabled={savingAction != null}
              className="rounded-sm border border-[#22C55E]/30 bg-[#22C55E]/12 px-3 py-2 text-[11px] font-bold uppercase tracking-[0.18em] text-[#22C55E] transition-colors hover:bg-[#22C55E]/18 disabled:opacity-60"
            >
              Mark Correct
            </button>
            <button
              type="button"
              onClick={() => runResolution('request_correction')}
              disabled={savingAction != null}
              className="rounded-sm border border-[#F59E0B]/30 bg-[#F59E0B]/12 px-3 py-2 text-[11px] font-bold uppercase tracking-[0.18em] text-[#F59E0B] transition-colors hover:bg-[#F59E0B]/18 disabled:opacity-60"
            >
              Request Correction
            </button>
            {showResolve ? (
              <button
                type="button"
                onClick={() => runResolution('mark_resolved')}
                disabled={savingAction != null}
                className="rounded-sm border border-[#3B82F6]/30 bg-[#3B82F6]/12 px-3 py-2 text-[11px] font-bold uppercase tracking-[0.18em] text-[#93C5FD] transition-colors hover:bg-[#3B82F6]/18 disabled:opacity-60"
              >
                Mark Resolved
              </button>
            ) : null}
            {showSuppress ? (
              <button
                type="button"
                onClick={() => runResolution('suppress')}
                disabled={savingAction != null}
                className="rounded-sm border border-[#2F3B52] bg-[#1A2333] px-3 py-2 text-[11px] font-bold uppercase tracking-[0.18em] text-[#C7D2E3] transition-colors hover:bg-[#243044] disabled:opacity-60"
              >
                Suppress
              </button>
            ) : null}
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-[#94A3B8]">
            {savingAction ? <span>Saving decision update...</span> : null}
            {actionMessage ? <span className="text-[#22C55E]">{actionMessage}</span> : null}
            {actionError ? <span className="text-[#EF4444]">{actionError}</span> : null}
          </div>
        </div>
      </div>
    </article>
  );
}
