'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { buildDecisionContextHref } from '@/lib/decisionNavigation';
import { executeProjectDecisionResolution, type ProjectDecisionResolutionAction } from '@/lib/projectDecisionResolution';
import { redirectIfUnauthorized } from '@/lib/redirectIfUnauthorized';
import { supabase } from '@/lib/supabaseClient';
import {
  findingApprovalLabel,
  findingGateImpact,
  findingNextAction,
  findingProblem,
} from '@/lib/truthToAction';
import {
  buildEvidenceTarget,
  type EvidenceReviewAction,
} from '@/lib/validator/evidenceNavigation';
import type {
  ValidationCategory,
  ValidationEvidence,
  ValidationFinding,
  ValidationSeverity,
} from '@/types/validator';

type ValidatorEvidenceDrawerProps = {
  finding: ValidationFinding | null;
  evidence: ValidationEvidence[];
  loading: boolean;
  onClose: () => void;
  onFindingActionComplete?: (() => void | Promise<void>) | undefined;
};

const CATEGORY_LABELS: Record<ValidationCategory, string> = {
  required_sources: 'Required Sources',
  identity_consistency: 'Identity Consistency',
  financial_integrity: 'Financial Integrity',
  ticket_integrity: 'Ticket Integrity',
};

const SEVERITY_LABELS: Record<ValidationSeverity, string> = {
  critical: 'Critical',
  warning: 'Warning',
  info: 'Info',
};

function severityClassName(severity: ValidationSeverity): string {
  switch (severity) {
    case 'critical':
      return 'border-[#EF4444]/40 bg-[#45141B] text-[#FCA5A5]';
    case 'warning':
      return 'border-[#F59E0B]/35 bg-[#31230F] text-[#FCD34D]';
    case 'info':
    default:
      return 'border-[#38BDF8]/30 bg-[#10283A] text-[#7DD3FC]';
  }
}

function isDocumentEvidence(item: ValidationEvidence): boolean {
  if (item.source_document_id) {
    return true;
  }

  return (
    item.evidence_type === 'document'
    || item.evidence_type === 'fact'
    || item.evidence_type === 'rate_schedule'
  );
}

function formatSubject(finding: ValidationFinding): string {
  return `${finding.subject_type}:${finding.subject_id}`;
}

function formatVariance(finding: ValidationFinding): string {
  if (finding.variance == null) {
    return 'Not provided';
  }

  return finding.variance_unit
    ? `${finding.variance} ${finding.variance_unit}`
    : String(finding.variance);
}

function findingSourceReference(finding: ValidationFinding): string {
  return [
    finding.rule_id,
    formatSubject(finding),
    finding.field,
  ]
    .filter((value): value is string => Boolean(value))
    .join(' | ');
}

function findingValue(finding: ValidationFinding): string {
  return findingProblem(finding);
}

function ValueBlock({
  label,
  value,
}: {
  label: string;
  value: string | null;
}) {
  return (
    <div className="rounded-sm border border-[#2F3B52]/70 bg-[#0F172A] p-4">
      <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#94A3B8]">
        {label}
      </p>
      <p className="mt-2 break-words text-sm text-[#E5EDF7]">
        {value && value.trim().length > 0 ? value : 'Not provided'}
      </p>
    </div>
  );
}

function buildEvidenceHref(params: {
  finding: ValidationFinding;
  item: ValidationEvidence;
  action: EvidenceReviewAction;
}): string | null {
  return buildEvidenceTarget({
    projectId: params.finding.project_id,
    evidence: params.item,
    action: params.action,
    decisionId: params.finding.linked_decision_id,
    findingId: params.finding.id,
  }).href;
}

function EvidenceCard({
  finding,
  item,
}: {
  finding: ValidationFinding;
  item: ValidationEvidence;
}) {
  const target = buildEvidenceTarget({
    projectId: finding.project_id,
    evidence: item,
    action: item.fact_id || item.field_name ? 'review' : 'inspect',
    decisionId: finding.linked_decision_id,
    findingId: finding.id,
  });
  const overrideHref = buildEvidenceHref({
    finding,
    item,
    action: 'manual_override',
  });

  return (
    <div className="rounded-sm border border-[#2F3B52]/70 bg-[#0F172A] p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#94A3B8]">
            {item.evidence_type}
          </p>
          <p className="mt-2 text-sm text-[#E5EDF7]">
            {item.note?.trim() ? item.note : 'Validator evidence item.'}
          </p>
          <p className="mt-2 text-[11px] text-[#94A3B8]">
            Target: <span className="text-[#E5EDF7]">{target.label}</span>
          </p>
          <p className="mt-1 text-[11px] text-[#64748B]">
            {target.detail}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {target.href ? (
            <Link
              href={target.href}
              className="rounded-sm border border-[#3B82F6]/35 bg-[#15233A] px-3 py-2 text-[10px] font-bold uppercase tracking-[0.14em] text-[#BFDBFE] transition-colors hover:border-[#60A5FA] hover:text-white"
            >
              {target.exactTarget ? 'Open exact evidence' : 'Open source document'}
            </Link>
          ) : null}
          {overrideHref ? (
            <Link
              href={overrideHref}
              className="rounded-sm border border-[#2F3B52] px-3 py-2 text-[10px] font-bold uppercase tracking-[0.14em] text-[#E5EDF7] transition-colors hover:border-[#E5EDF7] hover:text-white"
            >
              Manual Override
            </Link>
          ) : null}
        </div>
      </div>

      {target.missingReason ? (
        <div className="mt-3 rounded-sm border border-[#F59E0B]/30 bg-[#31230F] px-3 py-3 text-sm text-[#FDE68A]">
          {target.missingReason}
        </div>
      ) : null}

      <dl className="mt-4 grid gap-3 sm:grid-cols-2">
        <div>
          <dt className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#94A3B8]">
            Record
          </dt>
          <dd className="mt-1 break-words text-sm text-[#C7D2E3]">
            {item.record_id ?? 'Not provided'}
          </dd>
        </div>
        <div>
          <dt className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#94A3B8]">
            Field
          </dt>
          <dd className="mt-1 break-words text-sm text-[#C7D2E3]">
            {item.field_name ?? 'Not provided'}
          </dd>
        </div>
        <div className="sm:col-span-2">
          <dt className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#94A3B8]">
            Value
          </dt>
          <dd className="mt-1 break-words text-sm text-[#C7D2E3]">
            {item.field_value ?? 'Not provided'}
          </dd>
        </div>
      </dl>
    </div>
  );
}

export function ValidatorEvidenceDrawer({
  finding,
  evidence,
  loading,
  onClose,
  onFindingActionComplete,
}: ValidatorEvidenceDrawerProps) {
  const router = useRouter();
  const [savingAction, setSavingAction] = useState<ProjectDecisionResolutionAction | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  if (!finding) {
    return (
      <aside className="rounded-sm border border-[#2F3B52]/70 bg-[#111827] p-5 xl:sticky xl:top-6">
        <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-[#94A3B8]">
          Evidence Drawer
        </p>
        <h3 className="mt-3 text-lg font-bold text-[#E5EDF7]">
          Select a finding
        </h3>
        <p className="mt-2 text-sm text-[#94A3B8]">
          Pick a validator finding from the table to review its evidence and compare the expected and actual values.
        </p>
      </aside>
    );
  }

  const structuredEvidence = evidence.filter((item) => !isDocumentEvidence(item));
  const documentEvidence = evidence.filter((item) => isDocumentEvidence(item));
  const evidenceTargets = evidence.map((item) => buildEvidenceTarget({
    projectId: finding.project_id,
    evidence: item,
    action: item.fact_id || item.field_name ? 'review' : 'inspect',
    decisionId: finding.linked_decision_id,
    findingId: finding.id,
  }));
  const primaryTarget =
    evidenceTargets.find((target) => target.exactTarget && target.href)
    ?? evidenceTargets.find((target) => target.href)
    ?? null;
  const primaryReviewHref = primaryTarget?.href ?? null;
  const primaryOverrideHref = primaryTarget
    ? buildEvidenceTarget({
        projectId: finding.project_id,
        evidence: evidence[evidenceTargets.indexOf(primaryTarget)]!,
        action: 'manual_override',
        decisionId: finding.linked_decision_id,
        findingId: finding.id,
      }).href
    : null;
  const decisionContextHref = finding.linked_decision_id
    ? buildDecisionContextHref(finding.linked_decision_id)
    : null;
  const approvalLabel = findingApprovalLabel(finding);
  const gateImpact = findingGateImpact(finding);
  const nextAction = findingNextAction(finding);
  const missingEvidenceMessage =
    primaryTarget?.missingReason
    ?? (
      evidence.length === 0
        ? 'Validator has not persisted any document, page, fact, or row evidence for this finding yet.'
        : 'Evidence exists, but it does not include an exact document target yet.'
    );

  async function runResolution(action: ProjectDecisionResolutionAction) {
    if (!finding.linked_decision_id) {
      setActionError('Decision context has not been linked to this finding yet.');
      return;
    }

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
        decisionId: finding.linked_decision_id,
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
      await onFindingActionComplete?.();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Decision update failed.');
    } finally {
      setSavingAction(null);
    }
  }

  return (
    <aside className="rounded-sm border border-[#2F3B52]/70 bg-[#111827] p-5 xl:sticky xl:top-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-[#94A3B8]">
            Evidence Drawer
          </p>
          <h3 className="mt-2 text-lg font-bold text-[#E5EDF7]">
            {finding.rule_id}
          </h3>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-sm border border-[#2F3B52] px-2.5 py-1.5 text-[10px] font-bold uppercase tracking-[0.14em] text-[#94A3B8] transition-colors hover:border-[#E5EDF7] hover:text-[#E5EDF7]"
        >
          Close
        </button>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <span className={`inline-flex rounded-sm border px-2 py-1 text-[10px] font-bold uppercase tracking-[0.14em] ${severityClassName(finding.severity)}`}>
          {SEVERITY_LABELS[finding.severity]}
        </span>
        <span className="inline-flex rounded-sm border border-[#2F3B52] bg-[#0F172A] px-2 py-1 text-[10px] font-bold uppercase tracking-[0.14em] text-[#C7D2E3]">
          {CATEGORY_LABELS[finding.category]}
        </span>
      </div>

      <div className="mt-5 grid gap-3">
        <ValueBlock label="Value" value={findingValue(finding)} />
        <ValueBlock label="Source" value={findingSourceReference(finding)} />
        <ValueBlock label="Validation" value={approvalLabel} />
        <ValueBlock label="Gate impact" value={gateImpact} />
        <ValueBlock label="Next action" value={nextAction} />
      </div>

      <dl className="mt-5 grid gap-3 sm:grid-cols-2">
        <div>
          <dt className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#94A3B8]">
            Subject
          </dt>
          <dd className="mt-1 break-words text-sm text-[#E5EDF7]">
            {formatSubject(finding)}
          </dd>
        </div>
        <div>
          <dt className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#94A3B8]">
            Field
          </dt>
          <dd className="mt-1 break-words text-sm text-[#E5EDF7]">
            {finding.field ?? 'Not provided'}
          </dd>
        </div>
        <div>
          <dt className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#94A3B8]">
            Variance
          </dt>
          <dd className="mt-1 break-words text-sm text-[#E5EDF7]">
            {formatVariance(finding)}
          </dd>
        </div>
        <div>
          <dt className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#94A3B8]">
            Finding state
          </dt>
          <dd className="mt-1 break-words text-sm text-[#E5EDF7]">
            {finding.status}
          </dd>
        </div>
      </dl>

      {finding.blocked_reason ? (
        <div className="mt-5 rounded-sm border border-[#EF4444]/35 bg-[#3A1117] px-4 py-3">
          <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#FCA5A5]">
            Blocked Reason
          </p>
          <p className="mt-2 text-sm text-[#FDE2E2]">
            {finding.blocked_reason}
          </p>
        </div>
      ) : null}

      <div className="mt-5 grid gap-3">
        <ValueBlock label="Expected" value={finding.expected} />
        <ValueBlock label="Actual" value={finding.actual} />
      </div>

      <section className="mt-6 rounded-sm border border-[#2F3B52]/70 bg-[#0F172A] p-4">
        <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-[#94A3B8]">
          Resolution Actions
        </p>
        <p className="mt-2 text-sm text-[#C7D2E3]">
          Start from the linked decision when it exists, then open the exact evidence target to confirm, correct, or override the canonical fact.
        </p>

        <div className="mt-4 flex flex-wrap gap-2">
          {decisionContextHref ? (
            <Link
              href={decisionContextHref}
              className="rounded-sm border border-[#3B82F6]/35 bg-[#15233A] px-3 py-2 text-[10px] font-bold uppercase tracking-[0.14em] text-[#BFDBFE] transition-colors hover:border-[#60A5FA] hover:text-white"
            >
              Open Decision Context
            </Link>
          ) : null}
          {primaryReviewHref ? (
            <Link
              href={primaryReviewHref}
              className="rounded-sm border border-[#2F3B52] px-3 py-2 text-[10px] font-bold uppercase tracking-[0.14em] text-[#E5EDF7] transition-colors hover:border-[#E5EDF7] hover:text-white"
            >
              {primaryTarget?.exactTarget ? 'Inspect Evidence' : 'Open Source Document'}
            </Link>
          ) : null}
          {primaryOverrideHref ? (
            <Link
              href={primaryOverrideHref}
              className="rounded-sm border border-[#2F3B52] px-3 py-2 text-[10px] font-bold uppercase tracking-[0.14em] text-[#E5EDF7] transition-colors hover:border-[#E5EDF7] hover:text-white"
            >
              Manual Override
            </Link>
          ) : null}
        </div>

        {!primaryReviewHref ? (
          <div className="mt-4 rounded-sm border border-[#F59E0B]/30 bg-[#31230F] px-3 py-3 text-sm text-[#FDE68A]">
            {missingEvidenceMessage}
          </div>
        ) : null}

        {finding.linked_decision_id ? (
          <div className="mt-4 rounded-sm border border-[#2F3B52]/70 bg-[#111827] p-4">
            <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#94A3B8]">
              Decision controls
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => runResolution('mark_correct')}
                disabled={savingAction != null}
                className="rounded-sm border border-[#22C55E]/30 bg-[#22C55E]/12 px-3 py-2 text-[10px] font-bold uppercase tracking-[0.18em] text-[#22C55E] transition-colors hover:bg-[#22C55E]/18 disabled:opacity-60"
              >
                Mark Correct
              </button>
              <button
                type="button"
                onClick={() => runResolution('request_correction')}
                disabled={savingAction != null}
                className="rounded-sm border border-[#F59E0B]/30 bg-[#F59E0B]/12 px-3 py-2 text-[10px] font-bold uppercase tracking-[0.18em] text-[#F59E0B] transition-colors hover:bg-[#F59E0B]/18 disabled:opacity-60"
              >
                Request Correction
              </button>
              <button
                type="button"
                onClick={() => runResolution('mark_resolved')}
                disabled={savingAction != null}
                className="rounded-sm border border-[#3B82F6]/30 bg-[#3B82F6]/12 px-3 py-2 text-[10px] font-bold uppercase tracking-[0.18em] text-[#93C5FD] transition-colors hover:bg-[#3B82F6]/18 disabled:opacity-60"
              >
                Mark Resolved
              </button>
              <button
                type="button"
                onClick={() => runResolution('suppress')}
                disabled={savingAction != null}
                className="rounded-sm border border-[#2F3B52] bg-[#1A2333] px-3 py-2 text-[10px] font-bold uppercase tracking-[0.18em] text-[#C7D2E3] transition-colors hover:bg-[#243044] disabled:opacity-60"
              >
                Suppress
              </button>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-[#94A3B8]">
              {savingAction ? <span>Saving decision update...</span> : null}
              {actionMessage ? <span className="text-[#22C55E]">{actionMessage}</span> : null}
              {actionError ? <span className="text-[#EF4444]">{actionError}</span> : null}
            </div>
          </div>
        ) : (
          <div className="mt-4 rounded-sm border border-[#2F3B52]/70 bg-[#111827] px-3 py-3 text-sm text-[#94A3B8]">
            Decision resolution controls will appear after validator sync links this finding to a decision.
          </div>
        )}
      </section>

      <div className="mt-6 space-y-5">
        <section className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-[#94A3B8]">
              Structured Data
            </p>
            {loading ? (
              <span className="text-[10px] uppercase tracking-[0.14em] text-[#94A3B8]">
                Loading
              </span>
            ) : null}
          </div>
          {structuredEvidence.length === 0 ? (
            <div className="rounded-sm border border-[#2F3B52]/70 bg-[#0F172A] px-4 py-3 text-sm text-[#94A3B8]">
              {loading ? 'Loading evidence...' : 'No structured evidence attached to this finding.'}
            </div>
          ) : (
            structuredEvidence.map((item) => (
              <EvidenceCard
                key={item.id}
                finding={finding}
                item={item}
              />
            ))
          )}
        </section>

        <section className="space-y-3">
          <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-[#94A3B8]">
            Document Evidence
          </p>
          {documentEvidence.length === 0 ? (
            <div className="rounded-sm border border-[#2F3B52]/70 bg-[#0F172A] px-4 py-3 text-sm text-[#94A3B8]">
              {loading ? 'Loading evidence...' : 'No document evidence attached to this finding.'}
            </div>
          ) : (
            documentEvidence.map((item) => (
              <EvidenceCard
                key={item.id}
                finding={finding}
                item={item}
              />
            ))
          )}
        </section>
      </div>
    </aside>
  );
}
