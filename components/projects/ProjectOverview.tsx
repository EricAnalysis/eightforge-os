'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { AskProjectSection } from '@/components/projects/AskProjectSection';
import { DocumentPrecedenceSection } from '@/components/projects/DocumentPrecedenceSection';
import { ProjectAdminControls } from '@/components/projects/ProjectAdminControls';
import { ApprovalActionTimeline } from '@/components/approval/ApprovalActionTimeline';
import { ValidationAuditEventSummary } from '@/components/validator/ValidationAuditEventSummary';
import { ValidatorStatusChip } from '@/components/validator/ValidatorStatusChip';
import {
  processedDocsEmptyState,
  processedDocsSubtitle,
} from '@/lib/projectOverviewCopy';
import type {
  OverviewTone,
  ProjectDecisionRow,
  ProjectDocumentRow,
  ProjectOverviewActionItem,
  ProjectOverviewAuditItem,
  ProjectOverviewDecisionCard,
  ProjectOverviewDocumentItem,
  ProjectOverviewFact,
  ProjectOverviewInvoiceItem,
  ProjectOverviewMetric,
  ProjectOverviewModel,
  ProjectOverviewTag,
  ProjectTaskRow,
} from '@/lib/projectOverview';

type ProjectOverviewProps = {
  model: ProjectOverviewModel;
  documents?: ProjectDocumentRow[];
  decisions?: ProjectDecisionRow[];
  tasks?: ProjectTaskRow[];
  loadIssue?: string | null;
  onProjectRefresh?: (() => void) | (() => Promise<void>);
  validatorTab?: ReactNode;
};

type ProjectTabKey =
  | 'overview'
  | 'facts'
  | 'decisions'
  | 'actions'
  | 'documents'
  | 'validator'
  | 'audit';

const TABS: Array<{ key: ProjectTabKey; label: string; href: string }> = [
  { key: 'overview', label: 'Overview', href: '#project-overview' },
  { key: 'facts', label: 'Facts', href: '#project-facts' },
  { key: 'decisions', label: 'Decisions', href: '#project-decisions' },
  { key: 'actions', label: 'Actions', href: '#project-actions' },
  { key: 'documents', label: 'Documents', href: '#project-documents' },
  { key: 'validator', label: 'Validator', href: '#project-validator' },
  { key: 'audit', label: 'Audit', href: '#project-audit' },
];

function toneTextClass(tone: OverviewTone): string {
  switch (tone) {
    case 'info':
      return 'text-[#38BDF8]';
    case 'success':
      return 'text-[#22C55E]';
    case 'warning':
      return 'text-[#F59E0B]';
    case 'danger':
      return 'text-[#EF4444]';
    case 'muted':
      return 'text-[#94A3B8]';
    default:
      return 'text-[#E5EDF7]';
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

function toneDotClass(tone: OverviewTone): string {
  switch (tone) {
    case 'info':
      return 'bg-[#38BDF8]';
    case 'success':
      return 'bg-[#22C55E]';
    case 'warning':
      return 'bg-[#F59E0B]';
    case 'danger':
      return 'bg-[#EF4444]';
    case 'muted':
      return 'bg-[#2F3B52]';
    default:
      return 'bg-[#3B82F6]';
  }
}

function initials(name: string): string {
  return name
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join('') || 'EF';
}

function ProjectTagPill({ tag }: { tag: ProjectOverviewTag }) {
  return (
    <span className={`inline-flex items-center rounded-sm px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.18em] ${toneBadgeClass(tag.tone)}`}>
      {tag.label}
    </span>
  );
}

function MetricCard({ metric }: { metric: ProjectOverviewMetric }) {
  return (
    <div className={`border-l-2 ${toneBorderClass(metric.tone)} bg-[#1A2333] p-5`}>
      <p className="mb-2 text-[10px] font-bold uppercase tracking-[0.18em] text-[#94A3B8]">
        {metric.label}
      </p>
      <div className="flex items-end justify-between gap-3">
        <span className="text-2xl font-bold tracking-tight text-[#E5EDF7]">
          {metric.value}
        </span>
        <span className={`text-[10px] font-medium ${toneTextClass(metric.tone)}`}>
          {metric.supporting}
        </span>
      </div>
    </div>
  );
}

function FactCard({ fact }: { fact: ProjectOverviewFact }) {
  return (
    <div className="rounded-sm border border-[#2F3B52]/70 bg-[#111827] px-4 py-3">
      <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#94A3B8]">
        {fact.label}
      </p>
      <p className="mt-2 text-sm font-medium text-[#E5EDF7]">
        {fact.value}
      </p>
    </div>
  );
}

function DecisionCard({ decision }: { decision: ProjectOverviewDecisionCard }) {
  return (
    <Link
      href={decision.href}
      className={`group block rounded-sm border-y border-r border-[#2F3B52]/50 border-l-2 ${toneBorderClass(decision.border_tone)} bg-[#1A2333] p-6 transition-colors hover:bg-[#243044]`}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="mb-1 flex flex-wrap items-center gap-2">
            <h3 className="text-lg font-bold tracking-tight text-[#E5EDF7]">
              {decision.title}
            </h3>
            <span className={`rounded-sm px-2 py-0.5 text-[9px] font-bold uppercase tracking-[0.18em] ${toneBadgeClass(decision.status_tone)}`}>
              {decision.status_label}
            </span>
          </div>
          <p className="text-xs text-[#94A3B8]">
            {decision.freshness_label}
          </p>
        </div>
        <span className="text-[10px] text-[#94A3B8] transition-colors group-hover:text-[#3B82F6]">
          View
        </span>
      </div>

      <p className="mt-5 text-sm leading-6 text-[#C7D2E3]">
        {decision.reason}
      </p>

      <div className="mt-6 flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-4">
          {decision.assignees.length > 0 && (
            <div className="flex items-center gap-2">
              <div className="flex -space-x-2">
                {decision.assignees.map((assignee) => (
                  <span
                    key={assignee}
                    className="flex h-7 w-7 items-center justify-center rounded-full border-2 border-[#1A2333] bg-[#243044] text-[10px] font-bold text-[#E5EDF7]"
                    title={assignee}
                  >
                    {initials(assignee)}
                  </span>
                ))}
              </div>
              <span className="text-[11px] text-[#C7D2E3]">
                {decision.assignees.join(', ')}
              </span>
            </div>
          )}
          {decision.metadata.length > 0 && (
            <div className="flex flex-wrap items-center gap-3 text-[10px] font-medium uppercase tracking-[0.14em] text-[#94A3B8]">
              {decision.metadata.map((item) => (
                <span key={item}>{item}</span>
              ))}
            </div>
          )}
        </div>
        {decision.primary_action && (
          <span className="rounded-sm bg-[#3B82F6] px-4 py-2 text-[10px] font-bold uppercase tracking-[0.14em] text-white">
            {decision.primary_action}
          </span>
        )}
      </div>
    </Link>
  );
}

function fmtActionMoney(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value) || value <= 0) return '';
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (value >= 1_000) return `$${Math.round(value / 1_000)}k`;
  return `$${Math.round(value)}`;
}

function ActionRow({ action }: { action: ProjectOverviewActionItem }) {
  const isInvoiceAction = action.approval_status != null;
  const borderClass = isInvoiceAction
    ? action.due_tone === 'danger'
      ? 'border-l-[#EF4444]/60'
      : 'border-l-[#F59E0B]/60'
    : 'border-l-[#2F3B52]';

  const billedLabel = fmtActionMoney(action.impacted_amount);
  const atRiskLabel = fmtActionMoney(action.at_risk_amount);
  const requiresVerificationLabel = fmtActionMoney(action.requires_verification_amount);
  const blockedLabel = fmtActionMoney(action.blocked_amount);

  return (
    <Link
      href={action.href}
      className={`flex items-start gap-3 border-y border-r border-[#2F3B52]/40 border-l-2 bg-[#1A2333] p-3 transition-colors hover:bg-[#243044] ${borderClass}`}
    >
      <div className={`mt-1 h-2 w-2 shrink-0 rounded-full ${toneDotClass(action.due_tone)}`} />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-[#E5EDF7]">
          {action.title}
        </p>
        <div className="mt-1 flex flex-wrap items-center gap-2 text-[10px] font-medium uppercase tracking-[0.14em]">
          <span className={toneTextClass(action.due_tone)}>{action.due_label}</span>
          <span className="text-[#94A3B8]">{action.priority_label}</span>
          <span className="text-[#C7D2E3]">{action.status_label}</span>
        </div>

        {/* Financial impact pills — shown for invoice-level actions */}
        {isInvoiceAction && (billedLabel || atRiskLabel || requiresVerificationLabel || blockedLabel) ? (
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            {billedLabel ? (
              <span className="rounded border border-white/10 bg-white/[0.04] px-1.5 py-0.5 font-mono text-[10px] text-[#C7D2E3]">
                {billedLabel} billed
              </span>
            ) : null}
            {requiresVerificationLabel ? (
              <span className="rounded border border-[#EF4444]/25 bg-[#EF4444]/[0.07] px-1.5 py-0.5 font-mono text-[10px] text-[#FCA5A5]">
                {requiresVerificationLabel} requires verification
              </span>
            ) : null}
            {atRiskLabel ? (
              <span className="rounded border border-[#F59E0B]/25 bg-[#F59E0B]/[0.07] px-1.5 py-0.5 font-mono text-[10px] text-[#FCD34D]">
                {atRiskLabel} at risk
              </span>
            ) : null}
            {blockedLabel ? (
              <span className="rounded border border-[#EF4444]/25 bg-[#EF4444]/[0.07] px-1.5 py-0.5 font-mono text-[10px] text-[#FCA5A5]">
                {blockedLabel} blocked
              </span>
            ) : null}
          </div>
        ) : null}

        <p className="mt-1 text-[11px] text-[#94A3B8]">
          {action.assignee_label}
        </p>
        {action.next_step ? (
          <p className="mt-1 text-[11px] text-[#5A7090]">
            Next: {action.next_step}
          </p>
        ) : null}
        {(action.source_document_title || action.source_document_type) && (
          <p className="mt-1 text-[10px] uppercase tracking-[0.14em] text-[#94A3B8]">
            Source: {action.source_document_title ?? 'Project record'}
            {action.source_document_type ? ` · ${action.source_document_type}` : ''}
          </p>
        )}
      </div>
    </Link>
  );
}

function DocumentRow({ document }: { document: ProjectOverviewDocumentItem }) {
  return (
    <Link
      href={document.href}
      className="group flex items-start justify-between gap-3 rounded-sm px-2 py-2 transition-colors hover:bg-[#243044]"
    >
      <div className="min-w-0">
        <p className="truncate text-[12px] font-medium text-[#E5EDF7]">
          {document.title}
        </p>
        <p className="mt-1 text-[10px] uppercase tracking-[0.14em] text-[#94A3B8]">
          {document.detail}
        </p>
      </div>
      <div className="shrink-0 text-right">
        <span className={`inline-flex rounded-sm px-2 py-0.5 text-[9px] font-bold uppercase tracking-[0.16em] ${toneBadgeClass(document.status_tone)}`}>
          {document.status_label}
        </span>
        <p className="mt-1 text-[10px] text-[#94A3B8]">
          {document.processed_label}
        </p>
      </div>
    </Link>
  );
}

function AuditTimeline({ items }: { items: ProjectOverviewAuditItem[] }) {
  return (
    <div className="relative space-y-5 border-l border-[#2F3B52]/70 pl-4">
      {items.map((item) => (
        <div key={item.id} className="relative">
          <div className={`absolute -left-[21px] top-1 h-2.5 w-2.5 rounded-full border-2 border-[#0B1020] ${toneDotClass(item.tone)}`} />
          {item.href ? (
            <Link href={item.href} className="block">
              <p className="text-[12px] font-semibold text-[#E5EDF7]">
                {item.label}
              </p>
              <p className="mt-1 text-[11px] text-[#C7D2E3]">
                {item.detail}
              </p>
            </Link>
          ) : (
            <>
              <p className="text-[12px] font-semibold text-[#E5EDF7]">
                {item.label}
              </p>
              <p className="mt-1 text-[11px] text-[#C7D2E3]">
                {item.detail}
              </p>
            </>
          )}
          <p className="mt-1 text-[10px] font-medium uppercase tracking-[0.14em] text-[#94A3B8]">
            {item.timestamp_label}
          </p>
          <ValidationAuditEventSummary item={item} />
        </div>
      ))}
    </div>
  );
}

function SectionHeading({
  title,
  subtitle,
  id,
}: {
  title: string;
  subtitle?: string;
  id?: string;
}) {
  return (
    <div id={id} className="flex items-center justify-between gap-4">
      <div>
        <h2 className="text-[11px] font-bold uppercase tracking-[0.2em] text-[#94A3B8]">
          {title}
        </h2>
        {subtitle && (
          <p className="mt-2 text-[11px] text-[#C7D2E3]">
            {subtitle}
          </p>
        )}
      </div>
    </div>
  );
}

const INVOICE_APPROVAL_LABEL: Record<ProjectOverviewInvoiceItem['approval_status'], string> = {
  approved: 'Approved',
  approved_with_exceptions: 'Approved w/ Exceptions',
  needs_review: 'Needs Review',
  blocked: 'Blocked',
};

const INVOICE_APPROVAL_BADGE: Record<ProjectOverviewInvoiceItem['approval_status'], string> = {
  approved: 'border-[#22C55E]/30 bg-[#0F2417] text-[#86EFAC]',
  approved_with_exceptions: 'border-[#F59E0B]/30 bg-[#2A1B08] text-[#FCD34D]',
  needs_review: 'border-[#F59E0B]/30 bg-[#2A1B08] text-[#FCD34D]',
  blocked: 'border-[#EF4444]/30 bg-[#2A1016] text-[#FCA5A5]',
};

function fmtMoney(value: number | null | undefined): string {
  if (value == null) return '—';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: value >= 1000 ? 0 : 2,
  }).format(value);
}

function InvoiceApprovalTable({ invoices }: { invoices: ProjectOverviewInvoiceItem[] }) {
  if (invoices.length === 0) return null;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[12px]">
        <thead>
          <tr className="border-b border-white/[0.06]">
            <th className="pb-2 pr-4 text-left font-semibold uppercase tracking-[0.13em] text-[#7F90AA]">Invoice</th>
            <th className="pb-2 pr-4 text-left font-semibold uppercase tracking-[0.13em] text-[#7F90AA]">Status</th>
            <th className="pb-2 pr-4 text-right font-semibold uppercase tracking-[0.13em] text-[#7F90AA]">Billed</th>
            <th className="pb-2 pr-4 text-right font-semibold uppercase tracking-[0.13em] text-[#7F90AA]">Supported</th>
            <th className="pb-2 pr-4 text-right font-semibold uppercase tracking-[0.13em] text-[#7F90AA]">At Risk</th>
            <th className="pb-2 pr-4 text-right font-semibold uppercase tracking-[0.13em] text-[#7F90AA]">Requires Verification</th>
            <th className="pb-2 text-left font-semibold uppercase tracking-[0.13em] text-[#7F90AA]">Reconciliation</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-white/[0.04]">
          {invoices.map((inv, i) => (
            <tr key={i} className="hover:bg-white/[0.02]">
              <td className="py-2 pr-4 font-mono text-[11px] text-[#C7D2E3]">
                {inv.invoice_number ?? <span className="text-[#5A6E88] italic">No number</span>}
              </td>
              <td className="py-2 pr-4">
                <span className={`inline-flex items-center rounded border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] ${INVOICE_APPROVAL_BADGE[inv.approval_status]}`}>
                  {INVOICE_APPROVAL_LABEL[inv.approval_status]}
                </span>
              </td>
              <td className="py-2 pr-4 text-right tabular-nums text-[#D9E3F3]">
                {fmtMoney(inv.billed_amount)}
              </td>
              <td className="py-2 pr-4 text-right tabular-nums text-[#D9E3F3]">
                {fmtMoney(inv.supported_amount)}
              </td>
              <td className={`py-2 pr-4 text-right font-semibold tabular-nums ${
                inv.at_risk_amount != null && inv.at_risk_amount > 0
                  ? 'text-[#FCD34D]'
                  : 'text-[#4ADE80]'
              }`}>
                {fmtMoney(inv.at_risk_amount)}
              </td>
              <td className={`py-2 pr-4 text-right font-semibold tabular-nums ${
                inv.requires_verification_amount != null && inv.requires_verification_amount > 0
                  ? 'text-[#F87171]'
                  : 'text-[#4ADE80]'
              }`}>
                {fmtMoney(inv.requires_verification_amount)}
              </td>
              <td className="py-2 font-mono text-[10px] text-[#5A7090]">
                {inv.reconciliation_status}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ApprovalStatusPanel({ model }: { model: ProjectOverviewModel }) {
  const readiness = model.validator_summary.validator_readiness;
  const totalBilled = model.validator_summary.total_billed;
  const totalAtRisk = model.validator_summary.total_at_risk;
  const requiresVerificationAmount = model.validator_summary.requires_verification_amount;
  const blockedAmount = model.validator_summary.blocked_amount;
  const invoices = model.validator_summary.invoice_summaries;

  const hasFinancials = totalBilled != null;
  const hasInvoices = invoices.length > 0;
  const hasPanel = readiness != null || hasFinancials || hasInvoices;
  if (!hasPanel) return null;

  const approvalLabel =
    readiness === 'READY' ? 'Approved'
    : readiness === 'BLOCKED' ? 'Blocked'
    : readiness === 'NEEDS_REVIEW' ? 'Needs Review'
    : 'Not Evaluated';

  const approvalTone: OverviewTone =
    readiness === 'READY' ? 'success'
    : readiness === 'BLOCKED' ? 'danger'
    : readiness === 'NEEDS_REVIEW' ? 'warning'
    : 'muted';

  const panelBorder =
    approvalTone === 'danger' ? 'border-[#EF4444]/25 bg-[#0E0810]'
    : approvalTone === 'warning' ? 'border-[#F59E0B]/20 bg-[#0D0A05]'
    : approvalTone === 'success' ? 'border-[#22C55E]/20 bg-[#050E08]'
    : 'border-[#2F3B52]/60 bg-[#0B101D]';

  return (
    <div className={`mt-5 overflow-hidden rounded-xl border ${panelBorder}`}>
      {/* Top strip — status + financial pills */}
      <div className="flex flex-wrap items-center gap-x-8 gap-y-3 px-5 py-4">
        {/* Status */}
        <div className="flex items-center gap-3">
          <div className={`h-2.5 w-2.5 shrink-0 rounded-full ${toneDotClass(approvalTone)}`} />
          <div>
            <p className="text-[9px] font-bold uppercase tracking-[0.2em] text-[#7F90AA]">
              Approval Status
            </p>
            <p className={`text-lg font-black tracking-tight leading-none mt-0.5 ${toneTextClass(approvalTone)}`}>
              {approvalLabel}
            </p>
          </div>
        </div>

        {/* Divider */}
        {hasFinancials ? (
          <div className="h-10 w-px shrink-0 bg-white/[0.08]" />
        ) : null}

        {/* Financial stats */}
        {hasFinancials ? (
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
            <div>
              <p className="text-[9px] font-bold uppercase tracking-[0.2em] text-[#7F90AA]">Total Billed</p>
              <p className="mt-0.5 text-sm font-semibold text-[#E5EDF7]">{fmtMoney(totalBilled)}</p>
            </div>
            {totalAtRisk != null ? (
              <div>
                <p className="text-[9px] font-bold uppercase tracking-[0.2em] text-[#7F90AA]">At Risk</p>
                <p className={`mt-0.5 text-sm font-semibold ${totalAtRisk > 0 ? 'text-[#FCD34D]' : 'text-[#4ADE80]'}`}>
                  {fmtMoney(totalAtRisk)}
                </p>
              </div>
            ) : null}
            {requiresVerificationAmount != null ? (
              <div>
                <p className="text-[9px] font-bold uppercase tracking-[0.2em] text-[#7F90AA]">Requires Verification</p>
                <p className={`mt-0.5 text-sm font-semibold ${requiresVerificationAmount > 0 ? 'text-[#F87171]' : 'text-[#4ADE80]'}`}>
                  {fmtMoney(requiresVerificationAmount)}
                </p>
              </div>
            ) : null}
            {blockedAmount != null ? (
              <div>
                <p className="text-[9px] font-bold uppercase tracking-[0.2em] text-[#7F90AA]">Blocked</p>
                <p className="mt-0.5 text-sm font-semibold text-[#F87171]">{fmtMoney(blockedAmount)}</p>
              </div>
            ) : null}
            {model.exposure.percent != null ? (
              <div>
                <p className="text-[9px] font-bold uppercase tracking-[0.2em] text-[#7F90AA]">NTE Used</p>
                <p className={`mt-0.5 text-sm font-semibold ${toneTextClass(model.exposure.tone)}`}>
                  {model.exposure.percent_label}
                </p>
              </div>
            ) : null}
          </div>
        ) : null}

        {/* Reconciliation pill */}
        {model.validator_summary.reconciliation_overall ? (
          <div className="ml-auto shrink-0">
            <span className="rounded border border-white/10 bg-white/[0.04] px-2.5 py-1 text-[10px] font-mono text-[#8FA1BC]">
              {model.validator_summary.reconciliation_overall}
            </span>
          </div>
        ) : null}
      </div>

      {/* Invoice table */}
      {hasInvoices ? (
        <div className="border-t border-white/[0.06] px-5 pb-4 pt-3">
          <p className="mb-2.5 text-[9px] font-bold uppercase tracking-[0.2em] text-[#7FA6FF]">
            Invoice Approval Breakdown
          </p>
          <InvoiceApprovalTable invoices={invoices} />
        </div>
      ) : null}
    </div>
  );
}

export function ProjectOverview({
  model,
  documents = [],
  decisions = [],
  tasks = [],
  loadIssue,
  onProjectRefresh,
  validatorTab,
}: ProjectOverviewProps) {
  const [activeTab, setActiveTab] = useState<ProjectTabKey>('overview');

  useEffect(() => {
    const syncWithHash = () => {
      const currentHash = window.location.hash;
      const matched = TABS.find((tab) => tab.href === currentHash);
      if (matched) {
        setActiveTab(matched.key);
      }
    };

    syncWithHash();
    window.addEventListener('hashchange', syncWithHash);
    return () => window.removeEventListener('hashchange', syncWithHash);
  }, []);

  const blockedFilterActive =
    typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).get('filter') === 'blocked';

  const visibleDecisions = blockedFilterActive
    ? model.decisions.filter((decision) => decision.border_tone === 'danger')
    : model.decisions;

  const visibleDecisionTotal = blockedFilterActive
    ? visibleDecisions.length
    : model.decision_total;

  return (
    <div className="bg-[#0B1020] text-[#E5EDF7]">
      {loadIssue && (
        <div className="mx-8 mt-6 rounded-sm border border-[#F59E0B]/30 bg-[#F59E0B]/10 px-4 py-3 text-[11px] text-[#F59E0B]">
          {loadIssue}
        </div>
      )}

      <section id="project-overview" className="border-b border-[#2F3B52]/40 px-8 pb-6 pt-10">
        <div className="space-y-4">
          <div className="flex items-center gap-3">
            <span className="text-xs font-bold uppercase tracking-[0.2em] text-[#3B82F6]">
              {model.context_label}
            </span>
            <div className="h-px w-8 bg-[#2F3B52]" />
            <span className="text-xs text-[#94A3B8]">
              ID: {model.project_id_label}
            </span>
          </div>

          <div>
            <Link href="/platform/projects" className="text-[11px] text-[#94A3B8] transition-colors hover:text-[#E5EDF7]">
              Back to projects
            </Link>
            <h1 className="mt-3 text-4xl font-black tracking-tight text-[#E5EDF7] xl:text-5xl">
              {model.title}
            </h1>
            <p className="mt-3 max-w-3xl text-sm text-[#C7D2E3]">
              {model.status.detail}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2 pt-2">
            {model.tags.map((tag) => (
              <ProjectTagPill key={tag.label} tag={tag} />
            ))}
            <div className={`ml-2 inline-flex items-center gap-2 border-l-2 px-3 py-1 ${toneBadgeClass(model.status.tone)}`}>
              <div className={`h-1.5 w-1.5 rounded-full ${toneDotClass(model.status.tone)}`} />
              <span className="text-[10px] font-bold uppercase tracking-[0.18em]">
                {model.status.label}
              </span>
            </div>
            <ValidatorStatusChip
              status={model.validator_status}
              criticalCount={
                model.validator_summary.critical_count > 0
                  ? model.validator_summary.critical_count
                  : undefined
              }
              warningCount={
                model.validator_summary.warning_count > 0
                  ? model.validator_summary.warning_count
                  : undefined
              }
              size="sm"
            />
          </div>

          <div className="pt-2">
            <ProjectAdminControls
              project={model.project}
              deleteRedirectHref="/platform/projects"
              onProjectRefresh={onProjectRefresh}
            />
          </div>
        </div>

        <ApprovalStatusPanel model={model} />
        <ApprovalActionTimeline projectId={model.project.id} />
      </section>

      <nav className="border-b border-[#2F3B52]/40 bg-[#111827] px-8">
        <div className="flex flex-wrap items-center gap-8">
          {TABS.map((tab) => (
            <a
              key={tab.key}
              href={tab.href}
              onClick={() => setActiveTab(tab.key)}
              className={`border-b-2 py-4 text-xs font-bold uppercase tracking-[0.18em] transition-colors ${
                activeTab === tab.key
                  ? 'border-[#3B82F6] text-[#3B82F6]'
                  : 'border-transparent text-[#94A3B8] hover:text-[#E5EDF7]'
              }`}
            >
              {tab.label}
            </a>
          ))}
        </div>
      </nav>

      <div className="space-y-8 p-8">
        <section id="project-facts" className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {model.metrics.map((metric) => (
              <MetricCard key={metric.key} metric={metric} />
            ))}
          </div>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {model.facts.map((fact) => (
              <FactCard key={fact.label} fact={fact} />
            ))}
          </div>
        </section>

        <section className="space-y-4">
          <AskProjectSection
            projectId={model.project.id}
            validatorStatus={model.validator_status}
            criticalFindings={model.validator_summary.critical_count ?? 0}
            documents={documents}
            decisions={decisions}
            tasks={tasks}
          />
        </section>

        <div className="grid grid-cols-1 items-start gap-8 xl:grid-cols-12">
          <div className="space-y-6 xl:col-span-8">
            <SectionHeading
              id="project-decisions"
              title="Project Decisions"
              subtitle={
                blockedFilterActive
                  ? `${visibleDecisionTotal} blocked decision${visibleDecisionTotal === 1 ? '' : 's'}`
                  : `${model.decision_total} linked decision record${model.decision_total === 1 ? '' : 's'} in this project context`
              }
            />

            {visibleDecisions.length === 0 ? (
              <div className="rounded-sm border border-[#2F3B52]/70 bg-[#111827] p-6 text-sm text-[#94A3B8]">
                {model.decision_empty_state}
              </div>
            ) : (
              <div className="space-y-4">
                {visibleDecisions.map((decision) => (
                  <DecisionCard key={decision.id} decision={decision} />
                ))}
              </div>
            )}
          </div>

          <div className="space-y-8 xl:col-span-4">
            <section id="project-actions" className="space-y-4">
              <SectionHeading
                title="Pending Actions"
                subtitle={`${model.action_total} action${model.action_total === 1 ? '' : 's'} still open in the project queue`}
              />
              {model.actions.length === 0 ? (
                <div className="rounded-sm border border-[#2F3B52]/70 bg-[#111827] p-4 text-sm text-[#94A3B8]">
                  {model.action_empty_state}
                </div>
              ) : (
                <div className="space-y-3">
                  {model.actions.map((action) => (
                    <ActionRow key={action.id} action={action} />
                  ))}
                </div>
              )}
            </section>

            <section id="project-documents" className="space-y-4">
              <SectionHeading
                title="Processed Docs"
                subtitle={processedDocsSubtitle(model)}
              />
              {model.documents.length === 0 ? (
                <div className="rounded-sm border border-[#2F3B52]/70 bg-[#111827] p-4 text-sm text-[#94A3B8]">
                  {processedDocsEmptyState(model)}
                </div>
              ) : (
                <div className="space-y-2 rounded-sm border border-[#2F3B52]/70 bg-[#111827] p-2">
                  {model.documents.map((document) => (
                    <DocumentRow key={document.id} document={document} />
                  ))}
                </div>
              )}
              <DocumentPrecedenceSection projectId={model.project.id} />
            </section>

            {validatorTab ? (
              <section id="project-validator" className="space-y-4">
                {validatorTab}
              </section>
            ) : null}

            <section id="project-audit" className="space-y-4">
              <SectionHeading title="Recent Audit" />
              {model.audit.length === 0 ? (
                <div className="rounded-sm border border-[#2F3B52]/70 bg-[#111827] p-4 text-sm text-[#94A3B8]">
                  {model.audit_empty_state}
                </div>
              ) : (
                <div className="rounded-sm border border-[#2F3B52]/70 bg-[#111827] p-5">
                  <AuditTimeline items={model.audit} />
                </div>
              )}
            </section>
          </div>
        </div>
      </div>

      <div className="pointer-events-none fixed bottom-6 left-1/2 z-40 hidden -translate-x-1/2 xl:block">
        <div className="glass-panel pointer-events-auto flex items-center gap-6 rounded-full border border-[#2F3B52]/40 px-6 py-3 shadow-2xl">
          <div className="flex items-center gap-2 border-r border-[#2F3B52]/40 pr-6">
            <kbd className="rounded border border-[#2F3B52]/70 bg-[#243044] px-1.5 py-0.5 text-[10px] text-[#E5EDF7]">Ctrl</kbd>
            <kbd className="rounded border border-[#2F3B52]/70 bg-[#243044] px-1.5 py-0.5 text-[10px] text-[#E5EDF7]">K</kbd>
            <span className="ml-1 text-[11px] text-[#94A3B8]">Quick Search</span>
          </div>
          <div className="flex items-center gap-4">
            <Link href="/platform/documents" className="text-xs font-bold uppercase tracking-[0.14em] text-[#C7D2E3] transition-colors hover:text-[#3B82F6]">
              Upload Document
            </Link>
            <a href="#project-actions" className="text-xs font-bold uppercase tracking-[0.14em] text-[#C7D2E3] transition-colors hover:text-[#3B82F6]">
              Pending Actions
            </a>
            <a href="#project-audit" className="text-xs font-bold uppercase tracking-[0.14em] text-[#C7D2E3] transition-colors hover:text-[#3B82F6]">
              Audit Trail
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
