'use client';

import Link from 'next/link';
import type { MouseEvent, ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { inferGoverningDocumentFamily } from '@/lib/documentPrecedence';
import {
  PROJECT_TERM_AT_RISK_AMOUNT,
  PROJECT_TERM_INVOICE_BILLED_AMOUNT,
} from '@/lib/projectTerminology';
import { AskProjectSection } from '@/components/projects/AskProjectSection';
import { ProjectAskBar } from '@/components/projects/ProjectAskBar';
import { DocumentPrecedenceSection } from '@/components/projects/DocumentPrecedenceSection';
import { ProjectDecisionExecutionCard } from '@/components/projects/ProjectDecisionExecutionCard';
import { ProjectAdminControls } from '@/components/projects/ProjectAdminControls';
import { ApprovalActionTimeline } from '@/components/approval/ApprovalActionTimeline';
import { ValidationAuditEventSummary } from '@/components/validator/ValidationAuditEventSummary';
import { ValidatorStatusChip } from '@/components/validator/ValidatorStatusChip';
import { PROJECT_FORGE_TABS, projectTabFromHash, type ProjectTabKey } from '@/lib/projectForgeNavigation';
import { supabase } from '@/lib/supabaseClient';
import {
  approvalStatusLabelForProjectFacts,
  type CanonicalProjectDocumentRelationshipInput,
  resolveCanonicalProjectOverviewBriefing,
  resolveCanonicalProjectTruthSections,
  type CanonicalProjectOverviewSignal,
  type CanonicalProjectOverviewSummaryItem,
  type CanonicalProjectTransactionDatasetInput,
  type CanonicalTransactionSummary,
  type CanonicalProjectTruthRow,
  type CanonicalProjectTruthSection,
  type CanonicalProjectTruthState,
} from '@/lib/projectFacts';
import { resolveProjectIssueObjects } from '@/lib/resolveProjectIssueObjects';
import { resolveProjectIssueObjectDecisionSummary } from '@/lib/projectOverview';
import {
  isIssueRequiringReview,
  type IssueObject,
} from '@/lib/issueObjects';
import type { ProjectExecutionItemRow } from '@/lib/executionItems';
import type { StateProjectionShadowMismatch } from '@/lib/stateProjectionShadow';
import type {
  OverviewTone,
  ProjectDecisionRow,
  ProjectDocumentRow,
  ProjectOverviewActionItem,
  ProjectOverviewAuditItem,
  ProjectOverviewInvoiceItem,
  ProjectOverviewModel,
  ProjectOverviewTag,
  ProjectActivityEventRow,
  ProjectMember,
  ProjectTaskRow,
} from '@/lib/projectOverview';
import type { ValidationEvidence, ValidationFinding } from '@/types/validator';

type ProjectOverviewProps = {
  model: ProjectOverviewModel;
  documents?: ProjectDocumentRow[];
  documentRelationships?: readonly CanonicalProjectDocumentRelationshipInput[];
  transactionDatasets?: CanonicalProjectTransactionDatasetInput[];
  transactionSummary?: CanonicalTransactionSummary | null;
  validationFindings?: readonly ValidationFinding[];
  validationEvidence?: readonly ValidationEvidence[];
  executionItems?: readonly ProjectExecutionItemRow[];
  decisions?: ProjectDecisionRow[];
  tasks?: ProjectTaskRow[];
  members?: ProjectMember[];
  activityEvents?: ProjectActivityEventRow[];
  loadIssue?: string | null;
  onProjectRefresh?: (() => void) | (() => Promise<void>);
  validatorTab?: (issueObjects: readonly IssueObject[]) => ReactNode;
};

type ProjectWorkModeKey = 'documents';
type DocumentRoleKey = 'contract' | 'invoice' | 'transaction_data' | 'support';

function readActiveTabFromLocation(): ProjectTabKey {
  if (typeof window === 'undefined') return 'overview';
  if (window.location.hash) {
    return projectTabFromHash(window.location.hash);
  }
  const activeTab = new URLSearchParams(window.location.search).get('activeTab');
  if (activeTab && PROJECT_FORGE_TABS.some((tab) => tab.key === activeTab)) {
    return activeTab as ProjectTabKey;
  }
  return projectTabFromHash(window.location.hash);
}

function isWorkModeTab(tab: ProjectTabKey): tab is ProjectWorkModeKey {
  return tab === 'documents';
}

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

function relativeTime(value: string | null | undefined): string {
  if (!value) return 'No recent activity';
  const diff = Date.now() - new Date(value).getTime();
  const seconds = Math.max(0, Math.floor(diff / 1000));
  if (seconds < 60) return 'Just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`;
  return `${Math.floor(seconds / 604800)}w ago`;
}

function formatAuditTimestamp(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

function ProjectTagPill({ tag }: { tag: ProjectOverviewTag }) {
  return (
    <span className={`inline-flex items-center rounded-sm px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.18em] ${toneBadgeClass(tag.tone)}`}>
      {tag.label}
    </span>
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

const DOCUMENT_ROLE_LABELS: Record<DocumentRoleKey, string> = {
  contract: 'Contract',
  invoice: 'Invoice',
  transaction_data: 'Transaction Data',
  support: 'Support',
};

function projectDocumentTitle(document: Pick<ProjectDocumentRow, 'title' | 'name'>): string {
  return document.title?.trim() || document.name;
}

function formatDocumentType(value: string | null | undefined): string {
  if (!value) return 'Unknown';
  return value
    .replace(/[_-]+/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function documentRoleKey(document: ProjectDocumentRow): DocumentRoleKey {
  const family = inferGoverningDocumentFamily({
    document_role: null,
    document_type: document.document_type,
    title: document.title,
    name: document.name,
  });

  switch (family) {
    case 'contract':
      return 'contract';
    case 'invoice':
      return 'invoice';
    case 'rate_sheet':
      return 'transaction_data';
    case 'permit':
    case 'ticket_support':
      return 'support';
    default: {
      const normalizedType = (document.document_type ?? '').trim().toLowerCase();
      if (
        normalizedType.includes('transaction') ||
        normalizedType.includes('spreadsheet') ||
        normalizedType.includes('rate')
      ) {
        return 'transaction_data';
      }
      if (normalizedType.includes('invoice')) return 'invoice';
      if (normalizedType.includes('contract')) return 'contract';
      return 'support';
    }
  }
}

function documentRoleLabel(document: ProjectDocumentRow): string {
  return DOCUMENT_ROLE_LABELS[documentRoleKey(document)];
}

function documentProcessingStatusLabel(status: string): string {
  switch (status) {
    case 'uploaded':
      return 'Uploaded';
    case 'processing':
      return 'Processing';
    case 'extracted':
      return 'Extracted';
    case 'decisioned':
      return 'Decisioned';
    case 'failed':
      return 'Failed';
    default:
      return formatDocumentType(status);
  }
}

function documentImpact(
  document: ProjectDocumentRow,
  model: ProjectOverviewModel,
): { label: string; tone: OverviewTone } {
  const status = model.document_status_by_id?.[document.id];
  if (status?.tone === 'danger') {
    return { label: status.label === 'Failed' ? 'Blocked' : 'Blocking', tone: 'danger' };
  }
  if (status?.label.toLowerCase() === 'needs review') {
    return { label: 'Needs Review', tone: 'warning' };
  }
  if (status?.label.toLowerCase() === 'warning') {
    return { label: 'Warning', tone: 'info' };
  }
  if (status?.tone === 'info') {
    return { label: status.label, tone: 'info' };
  }
  if (status?.tone === 'success') {
    return { label: status.label === 'Reviewed' ? 'Reviewed' : 'Clear', tone: 'success' };
  }
  if (document.processing_status === 'failed') {
    return { label: 'Blocked', tone: 'danger' };
  }
  const looksProcessed =
    document.processed_at != null ||
    ['extracted', 'decisioned'].includes(document.processing_status);
  if (looksProcessed) {
    return { label: 'Needs Review', tone: 'warning' };
  }
  return { label: 'Needs Review', tone: 'warning' };
}

function documentProcessedLabel(document: ProjectDocumentRow): string {
  return document.processed_at ? relativeTime(document.processed_at) : 'Not processed';
}

function DocumentListRow({
  document,
  model,
  selected,
  processing,
  reprocessDisabled,
  error,
  onSelect,
  onReprocess,
}: {
  document: ProjectDocumentRow;
  model: ProjectOverviewModel;
  selected: boolean;
  processing: boolean;
  reprocessDisabled: boolean;
  error?: string | null;
  onSelect: (documentId: string, selected: boolean) => void;
  onReprocess: (documentId: string) => void;
}) {
  const primaryLabel = projectDocumentTitle(document);
  const secondaryLabel =
    document.title && document.title.trim() && document.title.trim() !== document.name
      ? document.name
      : null;
  const impact = documentImpact(document, model);

  return (
    <div className="grid gap-3 px-4 py-4 lg:grid-cols-[minmax(0,0.28fr)_minmax(0,2.2fr)_minmax(0,1fr)_minmax(0,0.9fr)_minmax(0,1fr)_minmax(0,0.9fr)_minmax(0,0.9fr)_minmax(0,0.9fr)] lg:items-center">
      <div>
        <label
          className="inline-flex items-center gap-2 text-[11px] text-[#94A3B8]"
          onClick={(event) => event.stopPropagation()}
        >
          <span className="text-[10px] font-bold uppercase tracking-[0.18em] lg:hidden">
            Select
          </span>
          <input
            type="checkbox"
            checked={selected}
            onChange={(event) => onSelect(document.id, event.target.checked)}
            aria-label={`Select ${primaryLabel}`}
            className="h-3.5 w-3.5 rounded border-[#2F3B52] bg-[#0B1020] text-[#3B82F6] focus:ring-[#3B82F6]"
          />
        </label>
      </div>

      <div className="min-w-0">
        <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#94A3B8] lg:hidden">
          File Name
        </p>
        <Link
          href={`/platform/documents/${document.id}`}
          className="block truncate text-[12px] font-medium text-[#E5EDF7] transition-colors hover:text-[#3B82F6]"
        >
          {primaryLabel}
        </Link>
        {secondaryLabel ? (
          <p className="mt-1 truncate text-[11px] text-[#94A3B8]">
            {secondaryLabel}
          </p>
        ) : null}
      </div>

      <div>
        <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#94A3B8] lg:hidden">
          Document Type
        </p>
        <p className="text-[12px] text-[#C7D2E3]">
          {formatDocumentType(document.document_type)}
        </p>
      </div>

      <div>
        <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#94A3B8] lg:hidden">
          Role
        </p>
        <p className="text-[12px] text-[#C7D2E3]">
          {documentRoleLabel(document)}
        </p>
      </div>

      <div>
        <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#94A3B8] lg:hidden">
          Processing Status
        </p>
        <p className="text-[12px] text-[#C7D2E3]">
          {documentProcessingStatusLabel(document.processing_status)}
        </p>
      </div>

      <div>
        <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#94A3B8] lg:hidden">
          Last Processed
        </p>
        <p className="text-[12px] text-[#C7D2E3]">
          {documentProcessedLabel(document)}
        </p>
      </div>

      <div>
        <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#94A3B8] lg:hidden">
          Decision Impact
        </p>
        <span className={`inline-flex rounded-sm px-2 py-0.5 text-[9px] font-bold uppercase tracking-[0.16em] ${toneBadgeClass(impact.tone)}`}>
          {impact.label}
        </span>
      </div>

      <div>
        <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#94A3B8] lg:hidden">
          Actions
        </p>
        <button
          type="button"
          disabled={reprocessDisabled}
          onClick={(event) => {
            event.stopPropagation();
            onReprocess(document.id);
          }}
          className="rounded-sm border border-[#3B82F6]/30 px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.14em] text-[#93C5FD] transition-colors hover:border-[#3B82F6]/60 hover:bg-[#3B82F6]/10 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {processing ? 'Reprocessing...' : 'Reprocess'}
        </button>
        {error ? (
          <p className="mt-2 text-[11px] text-[#FCA5A5]">
            {error}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function AuditTimeline({ items }: { items: ProjectOverviewAuditItem[] }) {
  return (
    <div className="relative space-y-5 border-l border-[#2F3B52]/70 pl-4">
      {items.map((item) => (
        <div key={item.id} className="relative">
          <div className={`absolute -left-[21px] top-1 h-2.5 w-2.5 rounded-full border-2 border-[#0B1020] ${toneDotClass(item.tone)}`} />
          {item.href ? (
            <Link
              href={item.href}
              className={`block rounded-sm border-y border-r border-[#2F3B52]/50 border-l-2 ${toneBorderClass(item.tone)} bg-[#111827] p-4 transition-colors hover:bg-[#151C2C]`}
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 space-y-2">
                  <span className={`inline-flex rounded-sm px-2 py-0.5 text-[9px] font-bold uppercase tracking-[0.16em] ${toneBadgeClass(item.tone)}`}>
                    {item.label}
                  </span>
                  <p className="text-[12px] leading-6 text-[#E5EDF7]">
                    {item.detail}
                  </p>
                </div>
                <div className="text-right">
                  <p className="text-[11px] font-medium text-[#C7D2E3]">
                    {formatAuditTimestamp(item.timestamp_at)}
                  </p>
                  <p className="mt-1 text-[10px] font-medium uppercase tracking-[0.14em] text-[#94A3B8]">
                    {item.timestamp_label}
                  </p>
                </div>
              </div>
              {item.object_label || item.source_label ? (
                <div className="mt-3 flex flex-wrap gap-2">
                  {item.object_label ? (
                    <span className="rounded-sm border border-[#2F3B52]/60 bg-[#0F172A] px-2 py-1 text-[10px] font-medium uppercase tracking-[0.14em] text-[#C7D2E3]">
                      Object: {item.object_label}
                    </span>
                  ) : null}
                  {item.source_label ? (
                    <span className="rounded-sm border border-[#2F3B52]/60 bg-[#0F172A] px-2 py-1 text-[10px] font-medium uppercase tracking-[0.14em] text-[#94A3B8]">
                      Source: {item.source_label}
                    </span>
                  ) : null}
                </div>
              ) : null}
            </Link>
          ) : (
            <div className={`rounded-sm border-y border-r border-[#2F3B52]/50 border-l-2 ${toneBorderClass(item.tone)} bg-[#111827] p-4`}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 space-y-2">
                  <span className={`inline-flex rounded-sm px-2 py-0.5 text-[9px] font-bold uppercase tracking-[0.16em] ${toneBadgeClass(item.tone)}`}>
                    {item.label}
                  </span>
                  <p className="text-[12px] leading-6 text-[#E5EDF7]">
                    {item.detail}
                  </p>
                </div>
                <div className="text-right">
                  <p className="text-[11px] font-medium text-[#C7D2E3]">
                    {formatAuditTimestamp(item.timestamp_at)}
                  </p>
                  <p className="mt-1 text-[10px] font-medium uppercase tracking-[0.14em] text-[#94A3B8]">
                    {item.timestamp_label}
                  </p>
                </div>
              </div>
              {item.object_label || item.source_label ? (
                <div className="mt-3 flex flex-wrap gap-2">
                  {item.object_label ? (
                    <span className="rounded-sm border border-[#2F3B52]/60 bg-[#0F172A] px-2 py-1 text-[10px] font-medium uppercase tracking-[0.14em] text-[#C7D2E3]">
                      Object: {item.object_label}
                    </span>
                  ) : null}
                  {item.source_label ? (
                    <span className="rounded-sm border border-[#2F3B52]/60 bg-[#0F172A] px-2 py-1 text-[10px] font-medium uppercase tracking-[0.14em] text-[#94A3B8]">
                      Source: {item.source_label}
                    </span>
                  ) : null}
                </div>
              ) : null}
            </div>
          )}
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

function truthStateTone(state: CanonicalProjectTruthState): OverviewTone {
  switch (state) {
    case 'resolved':
      return 'success';
    case 'derived':
      return 'info';
    case 'conflicted':
      return 'danger';
    case 'requires_review':
      return 'warning';
    case 'unresolved':
      return 'muted';
    case 'missing':
    default:
      return 'muted';
  }
}

function truthStateLabel(state: CanonicalProjectTruthState): string {
  switch (state) {
    case 'resolved':
      return 'Resolved';
    case 'derived':
      return 'Derived';
    case 'conflicted':
      return 'Conflicted';
    case 'requires_review':
      return 'Requires Review';
    case 'unresolved':
      return 'Unresolved';
    case 'missing':
    default:
      return 'Missing';
  }
}

function TruthSheetRow({ row }: { row: CanonicalProjectTruthRow }) {
  const tone = truthStateTone(row.state);

  return (
    <div className="grid gap-3 px-4 py-4 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1.5fr)_minmax(0,0.9fr)_auto] lg:items-center">
      <div>
        <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#94A3B8] lg:hidden">
          Fact
        </p>
        <p className="text-[12px] font-semibold text-[#E5EDF7]">
          {row.label}
        </p>
      </div>

      <div>
        <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#94A3B8] lg:hidden">
          Resolved Value
        </p>
        <p className="text-[12px] text-[#C7D2E3]">
          {row.value}
        </p>
      </div>

      <div>
        <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#94A3B8] lg:hidden">
          Source
        </p>
        <p className="text-[10px] font-medium uppercase tracking-[0.16em] text-[#94A3B8]">
          {row.source_label}
        </p>
      </div>

      <div>
        <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#94A3B8] lg:hidden">
          State
        </p>
        <span className={`inline-flex rounded-sm px-2 py-0.5 text-[9px] font-bold uppercase tracking-[0.16em] ${toneBadgeClass(tone)}`}>
          {truthStateLabel(row.state)}
        </span>
      </div>
    </div>
  );
}

function TruthSheetSection({ section }: { section: CanonicalProjectTruthSection }) {
  return (
    <section className="overflow-hidden rounded-sm border border-[#2F3B52]/70 bg-[#111827]">
      <div className="border-b border-[#2F3B52]/70 px-4 py-4">
        <h3 className="text-[11px] font-bold uppercase tracking-[0.2em] text-[#94A3B8]">
          {section.title}
        </h3>
      </div>

      <div className="hidden border-b border-[#2F3B52]/70 px-4 py-3 lg:grid lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1.5fr)_minmax(0,0.9fr)_auto] lg:gap-3">
        {['Fact', 'Resolved Value', 'Source', 'State'].map((label) => (
          <p
            key={label}
            className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#94A3B8]"
          >
            {label}
          </p>
        ))}
      </div>

      <div className="divide-y divide-[#2F3B52]/70">
        {section.rows.map((row) => (
          <TruthSheetRow key={`${section.key}:${row.key}`} row={row} />
        ))}
      </div>
    </section>
  );
}

function signalTone(severity: CanonicalProjectOverviewSignal['severity']): OverviewTone {
  switch (severity) {
    case 'critical':
      return 'danger';
    case 'warning':
      return 'warning';
    case 'info':
    default:
      return 'info';
  }
}

function SummaryStripItem({ item }: { item: CanonicalProjectOverviewSummaryItem }) {
  const tone = truthStateTone(item.state);

  return (
    <div className={`border-l-2 ${toneBorderClass(tone)} bg-[#111827] px-4 py-4`}>
      <div className="flex items-start justify-between gap-3">
        <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#94A3B8]">
          {item.label}
        </p>
        <span className={`rounded-sm px-2 py-0.5 text-[9px] font-bold uppercase tracking-[0.14em] ${toneBadgeClass(tone)}`}>
          {truthStateLabel(item.state)}
        </span>
      </div>
      <p className="mt-3 text-xl font-black tracking-tight text-[#E5EDF7]">
        {item.value}
      </p>
    </div>
  );
}

function CriticalSignalCard({ signal }: { signal: CanonicalProjectOverviewSignal }) {
  const tone = signalTone(signal.severity);

  return (
    <div className={`border-l-2 ${toneBorderClass(tone)} rounded-sm border-y border-r border-[#2F3B52]/70 bg-[#111827] p-5`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-sm font-bold text-[#E5EDF7]">
          {signal.title}
        </h3>
        <span className={`rounded-sm px-2.5 py-1 text-[9px] font-bold uppercase tracking-[0.18em] ${toneBadgeClass(tone)}`}>
          {signal.severity}
        </span>
      </div>
      <p className="mt-3 text-sm leading-6 text-[#C7D2E3]">
        {signal.description}
      </p>
      <div className="mt-4 grid gap-3 lg:grid-cols-2">
        <div className="rounded-sm border border-[#2F3B52]/70 bg-[#0B1020] px-3 py-3">
          <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#94A3B8]">
            Gate Impact
          </p>
          <p className="mt-2 text-[12px] text-[#C7D2E3]">
            {signal.gate_impact}
          </p>
        </div>
        <div className="rounded-sm border border-[#2F3B52]/70 bg-[#0B1020] px-3 py-3">
          <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#94A3B8]">
            Next Action
          </p>
          <p className="mt-2 text-[12px] text-[#C7D2E3]">
            {signal.next_action}
          </p>
        </div>
      </div>
    </div>
  );
}

function TruthSnapshotCard({
  title,
  rows,
}: {
  title: string;
  rows: CanonicalProjectTruthRow[];
}) {
  return (
    <section className="overflow-hidden rounded-sm border border-[#2F3B52]/70 bg-[#111827]">
      <div className="border-b border-[#2F3B52]/70 px-4 py-4">
        <h3 className="text-[11px] font-bold uppercase tracking-[0.2em] text-[#94A3B8]">
          {title}
        </h3>
      </div>
      <div className="divide-y divide-[#2F3B52]/70">
        {rows.map((row) => {
          const tone = truthStateTone(row.state);
          return (
            <div key={row.key} className="flex items-start justify-between gap-4 px-4 py-4">
              <div className="min-w-0">
                <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#94A3B8]">
                  {row.label}
                </p>
                <p className="mt-2 text-[12px] text-[#E5EDF7]">
                  {row.value}
                </p>
              </div>
              <span className={`shrink-0 rounded-sm px-2 py-0.5 text-[9px] font-bold uppercase tracking-[0.14em] ${toneBadgeClass(tone)}`}>
                {truthStateLabel(row.state)}
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

type OverviewActionGroup = {
  key: 'approval_blockers' | 'verification' | 'workflow';
  title: string;
  subtitle: string;
  actions: ProjectOverviewActionItem[];
};

function groupOverviewActions(actions: ProjectOverviewActionItem[]): OverviewActionGroup[] {
  const approvalBlockers = actions.filter((action) =>
    action.approval_status === 'blocked' || (action.blocked_amount ?? 0) > 0,
  );
  const verification = actions.filter((action) =>
    !approvalBlockers.some((candidate) => candidate.id === action.id)
    && (
      action.approval_status === 'needs_review'
      || (action.requires_verification_amount ?? 0) > 0
      || (action.at_risk_amount ?? 0) > 0
    ),
  );
  const workflow = actions.filter((action) =>
    !approvalBlockers.some((candidate) => candidate.id === action.id)
    && !verification.some((candidate) => candidate.id === action.id),
  );

  const groups: OverviewActionGroup[] = [
    {
      key: 'approval_blockers',
      title: 'Approval Blockers',
      subtitle: 'Actions that directly stop approval movement.',
      actions: approvalBlockers,
    },
    {
      key: 'verification',
      title: 'Needs Verification',
      subtitle: 'Actions that clear at-risk or needs-review truth.',
      actions: verification,
    },
    {
      key: 'workflow',
      title: 'Workflow Queue',
      subtitle: 'Remaining operator actions in the project queue.',
      actions: workflow,
    },
  ];

  return groups.filter((group) => group.actions.length > 0);
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
  const hasCents = Math.abs(value - Math.round(value)) >= 0.005;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: hasCents ? 2 : 0,
    maximumFractionDigits: hasCents ? 2 : 0,
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
            <th className="pb-2 pr-4 text-right font-semibold uppercase tracking-[0.13em] text-[#7F90AA]">{PROJECT_TERM_INVOICE_BILLED_AMOUNT}</th>
            <th className="pb-2 pr-4 text-right font-semibold uppercase tracking-[0.13em] text-[#7F90AA]">Supported</th>
            <th className="pb-2 pr-4 text-right font-semibold uppercase tracking-[0.13em] text-[#7F90AA]">{PROJECT_TERM_AT_RISK_AMOUNT}</th>
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
                {invoiceReconciliationDisplay(inv)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function invoiceReconciliationDisplay(invoice: ProjectOverviewInvoiceItem): string {
  const fullySupported =
    invoice.approval_status === 'approved'
    && invoice.billed_amount != null
    && invoice.supported_amount != null
    && invoice.supported_amount >= invoice.billed_amount
    && (invoice.at_risk_amount == null || invoice.at_risk_amount <= 0)
    && (invoice.requires_verification_amount == null || invoice.requires_verification_amount <= 0);
  return fullySupported ? 'MATCH' : invoice.reconciliation_status;
}

export function approvalPanelReconciliationDisplay(model: ProjectOverviewModel): string | null {
  const rawStatus = model.validator_summary.reconciliation_overall;
  switch (rawStatus) {
    case 'MATCH':
      return 'Reconciled';
    case 'PARTIAL':
      return 'Partial';
    case 'MISSING':
    case null:
      return null;
    default:
      return rawStatus;
  }
}

function ApprovalStatusPanel({ model }: { model: ProjectOverviewModel }) {
  const readiness = model.validator_summary.validator_readiness;
  const totalBilled = model.validator_summary.total_billed;
  const totalAtRisk = model.validator_summary.total_at_risk;
  const requiresVerificationAmount = model.validator_summary.requires_verification_amount;
  const requiresVerificationCount =
    model.validator_summary.approval_blocker_count
    + model.validator_summary.warning_count
    + model.validator_summary.requires_review_count;
  const blockedAmount = model.validator_summary.blocked_amount;
  const invoices = model.validator_summary.invoice_summaries;

  const hasFinancials = totalBilled != null;
  const hasInvoices = invoices.length > 0;
  const hasPanel = readiness != null || hasFinancials || hasInvoices;
  if (!hasPanel) return null;

  const approvalLabel = approvalStatusLabelForProjectFacts({
    status: model.validator_summary.status,
    validator_status: readiness,
  });

  const approvalTone: OverviewTone =
    approvalLabel === 'Approved' ? 'success'
    : approvalLabel === 'Blocked' ? 'danger'
    : approvalLabel === 'Needs Review' ? 'warning'
    : 'muted';
  const reconciliationDisplay = approvalPanelReconciliationDisplay(model);

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
              <p className="text-[9px] font-bold uppercase tracking-[0.2em] text-[#7F90AA]">{PROJECT_TERM_INVOICE_BILLED_AMOUNT}</p>
              <p className="mt-0.5 text-sm font-semibold text-[#E5EDF7]">{fmtMoney(totalBilled)}</p>
            </div>
            {totalAtRisk != null ? (
              <div>
                <p className="text-[9px] font-bold uppercase tracking-[0.2em] text-[#7F90AA]">{PROJECT_TERM_AT_RISK_AMOUNT}</p>
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
            ) : requiresVerificationCount > 0 ? (
              <div>
                <p className="text-[9px] font-bold uppercase tracking-[0.2em] text-[#7F90AA]">Requires Verification</p>
                <p className="mt-0.5 text-sm font-semibold text-[#FCD34D]">
                  {requiresVerificationCount} finding{requiresVerificationCount === 1 ? '' : 's'}
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
        {reconciliationDisplay ? (
          <div className="ml-auto shrink-0">
            <span className="rounded border border-white/10 bg-white/[0.04] px-2.5 py-1 text-[10px] font-mono text-[#8FA1BC]">
              {reconciliationDisplay}
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
  documentRelationships = [],
  transactionDatasets = [],
  transactionSummary,
  validationFindings,
  validationEvidence = [],
  executionItems = [],
  decisions = [],
  tasks = [],
  members = [],
  activityEvents = [],
  loadIssue,
  onProjectRefresh,
  validatorTab,
}: ProjectOverviewProps) {
  const [activeTab, setActiveTab] = useState<ProjectTabKey>(() => readActiveTabFromLocation());
  const [selectedDocumentIds, setSelectedDocumentIds] = useState<Set<string>>(new Set());
  const [reprocessingDocumentIds, setReprocessingDocumentIds] = useState<Set<string>>(new Set());
  const [reprocessErrors, setReprocessErrors] = useState<Record<string, string>>({});
  const [bulkReprocessing, setBulkReprocessing] = useState(false);
  const [bulkMessage, setBulkMessage] = useState<string | null>(null);
  const tableReprocessInFlightRef = useRef(false);
  const shadowMismatchQueueRef = useRef<StateProjectionShadowMismatch[]>([]);

  useEffect(() => {
    const syncWithLocation = () => {
      setActiveTab(readActiveTabFromLocation());
    };

    syncWithLocation();
    window.addEventListener('hashchange', syncWithLocation);
    window.addEventListener('popstate', syncWithLocation);
    return () => {
      window.removeEventListener('hashchange', syncWithLocation);
      window.removeEventListener('popstate', syncWithLocation);
    };
  }, []);

  const issueObjects = useMemo(() => resolveProjectIssueObjects({
    projectId: model.project.id,
    findings: validationFindings ?? [],
    evidence: validationEvidence,
    decisions,
    executionItems,
    activityEvents,
    documents,
  }, {
    onMismatch: (payload) => {
      shadowMismatchQueueRef.current.push(payload);
    },
  }), [
    activityEvents,
    decisions,
    documents,
    executionItems,
    model.project.id,
    validationEvidence,
    validationFindings,
  ]);

  useEffect(() => {
    if (shadowMismatchQueueRef.current.length === 0) return;

    const payloads = shadowMismatchQueueRef.current;
    shadowMismatchQueueRef.current = [];

    void (async () => {
      const { data: { session } } = await supabase.auth.getSession();
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (session?.access_token) {
        headers.Authorization = `Bearer ${session.access_token}`;
      }

      const response = await fetch(`/api/projects/${model.project.id}/shadow-mismatches`, {
        method: 'POST',
        headers,
        body: JSON.stringify(payloads),
      });

      if (!response.ok) {
        throw new Error(await response.text());
      }
    })().catch((error) => {
      console.error('[ProjectOverview] failed to persist state projection shadow mismatches', error);
    });
  }, [issueObjects, model.project.id]);

  const requiredReviewDecisions = useMemo(
    () => resolveProjectIssueObjectDecisionSummary(
      issueObjects,
      tasks,
      members,
      model.project.id,
      activityEvents,
    ),
    [activityEvents, issueObjects, members, model.project.id, tasks],
  );
  // Single source of truth for "requires review" across Overview and Validator:
  // the same resolveProjectIssueObjects() result the Validator Findings panel
  // renders, filtered with the same shared lifecycle predicate.
  const requiredReviewCount = issueObjects.filter(isIssueRequiringReview).length;
  const orderedDocuments = [...documents].sort((left, right) => {
    const leftTimestamp = new Date(left.processed_at ?? left.created_at).getTime();
    const rightTimestamp = new Date(right.processed_at ?? right.created_at).getTime();
    return rightTimestamp - leftTimestamp;
  });
  const selectedOrderedDocumentIds = orderedDocuments
    .map((document) => document.id)
    .filter((documentId) => selectedDocumentIds.has(documentId));
  const selectedDocumentCount = selectedOrderedDocumentIds.length;
  const allOrderedDocumentsSelected =
    orderedDocuments.length > 0 && selectedDocumentCount === orderedDocuments.length;
  const documentReprocessInProgress = reprocessingDocumentIds.size > 0 || bulkReprocessing;

  useEffect(() => {
    setSelectedDocumentIds((previous) => {
      const visibleIds = new Set(documents.map((document) => document.id));
      const next = new Set(Array.from(previous).filter((documentId) => visibleIds.has(documentId)));
      return next.size === previous.size ? previous : next;
    });
  }, [documents]);

  const clearReprocessError = useCallback((documentId: string) => {
    setReprocessErrors((previous) => {
      if (!(documentId in previous)) return previous;
      const next = { ...previous };
      delete next[documentId];
      return next;
    });
  }, []);

  const processProjectDocument = useCallback(async (documentId: string) => {
    const {
      data: { session },
    } = await supabase.auth.getSession();

    if (!session?.access_token) {
      throw new Error('Authentication required.');
    }

    const response = await fetch('/api/documents/process', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({ documentId }),
    });

    const body = await response.json().catch(() => ({}));
    if (!response.ok || body?.success === false) {
      throw new Error(body?.message ?? body?.error ?? 'Reprocess failed.');
    }
  }, []);

  const refreshProject = useCallback(async () => {
    await onProjectRefresh?.();
  }, [onProjectRefresh]);

  const handleSelectDocument = useCallback((documentId: string, selected: boolean) => {
    setSelectedDocumentIds((previous) => {
      const next = new Set(previous);
      if (selected) {
        next.add(documentId);
      } else {
        next.delete(documentId);
      }
      return next;
    });
  }, []);

  const handleSelectAllDocuments = useCallback((selected: boolean) => {
    setSelectedDocumentIds((previous) => {
      const next = new Set(previous);
      for (const document of orderedDocuments) {
        if (selected) {
          next.add(document.id);
        } else {
          next.delete(document.id);
        }
      }
      return next;
    });
  }, [orderedDocuments]);

  const handleReprocessDocument = useCallback(async (documentId: string) => {
    if (tableReprocessInFlightRef.current || bulkReprocessing) return;
    tableReprocessInFlightRef.current = true;
    setBulkMessage(null);
    clearReprocessError(documentId);
    setReprocessingDocumentIds((previous) => new Set(previous).add(documentId));

    try {
      await processProjectDocument(documentId);
      await refreshProject();
    } catch (error) {
      setReprocessErrors((previous) => ({
        ...previous,
        [documentId]: error instanceof Error ? error.message : 'Reprocess failed.',
      }));
    } finally {
      setReprocessingDocumentIds((previous) => {
        const next = new Set(previous);
        next.delete(documentId);
        return next;
      });
      tableReprocessInFlightRef.current = false;
    }
  }, [bulkReprocessing, clearReprocessError, processProjectDocument, refreshProject]);

  const handleBulkReprocess = useCallback(async () => {
    if (
      selectedOrderedDocumentIds.length === 0 ||
      bulkReprocessing ||
      reprocessingDocumentIds.size > 0 ||
      tableReprocessInFlightRef.current
    ) {
      return;
    }

    tableReprocessInFlightRef.current = true;
    setBulkReprocessing(true);
    setBulkMessage(null);
    setReprocessErrors((previous) => {
      const next = { ...previous };
      for (const documentId of selectedOrderedDocumentIds) {
        delete next[documentId];
      }
      return next;
    });

    const failures: Array<{ documentId: string; message: string }> = [];

    for (const documentId of selectedOrderedDocumentIds) {
      setReprocessingDocumentIds((previous) => new Set(previous).add(documentId));
      try {
        await processProjectDocument(documentId);
      } catch (error) {
        failures.push({
          documentId,
          message: error instanceof Error ? error.message : 'Reprocess failed.',
        });
      } finally {
        setReprocessingDocumentIds((previous) => {
          const next = new Set(previous);
          next.delete(documentId);
          return next;
        });
      }
    }

    if (failures.length > 0) {
      setReprocessErrors((previous) => {
        const next = { ...previous };
        for (const failure of failures) {
          next[failure.documentId] = failure.message;
        }
        return next;
      });
      setBulkMessage(
        `${selectedOrderedDocumentIds.length - failures.length} reprocessed, ${failures.length} failed.`,
      );
    } else {
      setSelectedDocumentIds(new Set());
      setBulkMessage(`${selectedOrderedDocumentIds.length} document${selectedOrderedDocumentIds.length === 1 ? '' : 's'} reprocessed.`);
    }

    try {
      await refreshProject();
    } catch (error) {
      setBulkMessage(
        error instanceof Error
          ? `Reprocess finished, but refresh failed: ${error.message}`
          : 'Reprocess finished, but refresh failed.',
      );
    } finally {
      setBulkReprocessing(false);
      tableReprocessInFlightRef.current = false;
    }
  }, [bulkReprocessing, processProjectDocument, refreshProject, reprocessingDocumentIds.size, selectedOrderedDocumentIds]);

  const truthDocuments = documents.map((document) => ({
    id: document.id,
    title: document.title,
    name: document.name,
    created_at: document.created_at,
    project_id: document.project_id,
    document_type: document.document_type,
    document_role: document.document_role ?? null,
    authority_status: document.authority_status ?? null,
    effective_date: document.effective_date ?? null,
    precedence_rank: document.precedence_rank ?? null,
    operator_override_precedence: document.operator_override_precedence ?? null,
    intelligence_trace: document.intelligence_trace ?? null,
  }));
  const precomputedTransactionSummary = transactionSummary ?? null;
  const truthSections = resolveCanonicalProjectTruthSections({
    validationStatus: model.project.validation_status ?? null,
    validationSummary: model.project.validation_summary_json,
    validationFindings,
    decisions,
    documents: truthDocuments,
    documentRelationships,
    transactionDatasets,
    precomputed: precomputedTransactionSummary,
  });
  const overviewBriefing = resolveCanonicalProjectOverviewBriefing({
    validationStatus: model.project.validation_status ?? null,
    validationSummary: model.project.validation_summary_json,
    validationFindings,
    decisions,
    documents: truthDocuments,
    documentRelationships,
    transactionDatasets,
    precomputed: precomputedTransactionSummary,
    requiredReviewCount,
  });

  function switchWorkMode(tab: ProjectWorkModeKey) {
    if (typeof window === 'undefined') {
      setActiveTab(tab);
      return;
    }

    const target = PROJECT_FORGE_TABS.find((candidate) => candidate.key === tab);
    const nextUrl = new URL(window.location.href);
    nextUrl.hash = target?.href.slice(1) ?? '';
    window.history.pushState(null, '', nextUrl);
    setActiveTab(tab);
  }

  function handleTabClick(
    event: MouseEvent<HTMLAnchorElement>,
    tab: { key: ProjectTabKey; href: string },
  ) {
    if (isWorkModeTab(tab.key)) {
      event.preventDefault();
      switchWorkMode(tab.key);
      return;
    }

    setActiveTab(tab.key);
  }

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
                model.validator_summary.approval_blocker_count > 0
                  ? model.validator_summary.approval_blocker_count
                  : undefined
              }
              warningCount={
                model.validator_summary.warning_count + model.validator_summary.requires_review_count > 0
                  ? model.validator_summary.warning_count + model.validator_summary.requires_review_count
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

      <nav className="border-b border-[#2F3B52]/40 bg-[#111827] px-8 pt-3">
        <div className="space-y-2">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.26em] text-[#94A3B8]">
              The Forge
            </p>
            <p className="mt-1 text-[11px] text-[#64748B]">
              Documents (incl. Facts) -&gt; Validator (incl. Decisions) -&gt; Audit
            </p>
          </div>

          <div className="-mb-px flex flex-wrap items-center gap-8">
            {PROJECT_FORGE_TABS.map((tab) => (
              <a
                key={tab.key}
                href={tab.href}
                onClick={(event) => handleTabClick(event, tab)}
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
        </div>
      </nav>

      <div className="space-y-8 p-8">
        {activeTab === 'documents' ? (
          <section id="project-documents" className="space-y-8">
            <section className="space-y-4">
              <SectionHeading
                title="Document List"
                subtitle={`${documents.length} linked document${documents.length === 1 ? '' : 's'} in this project workspace`}
              />
              {orderedDocuments.length === 0 ? (
                <div className="rounded-sm border border-[#2F3B52]/70 bg-[#111827] p-4 text-sm text-[#94A3B8]">
                  {model.document_empty_state}
                </div>
              ) : (
                <div className="overflow-hidden rounded-sm border border-[#2F3B52]/70 bg-[#111827]">
                  {selectedDocumentCount > 0 || bulkMessage ? (
                    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#2F3B52]/70 bg-[#0B1020]/60 px-4 py-3">
                      <div className="flex flex-wrap items-center gap-3">
                        <p className="text-[11px] font-medium text-[#C7D2E3]">
                          {selectedDocumentCount} selected
                        </p>
                        {selectedDocumentCount > 0 ? (
                          <button
                            type="button"
                            onClick={() => setSelectedDocumentIds(new Set())}
                            disabled={bulkReprocessing}
                            className="text-[10px] font-bold uppercase tracking-[0.14em] text-[#94A3B8] hover:text-[#E5EDF7] disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            Clear
                          </button>
                        ) : null}
                        {bulkMessage ? (
                          <p className="text-[11px] text-[#FCD34D]">
                            {bulkMessage}
                          </p>
                        ) : null}
                      </div>
                      {selectedDocumentCount > 0 ? (
                        <button
                          type="button"
                          onClick={handleBulkReprocess}
                          disabled={bulkReprocessing || reprocessingDocumentIds.size > 0}
                          className="rounded-sm border border-[#3B82F6]/30 px-3 py-1.5 text-[10px] font-bold uppercase tracking-[0.14em] text-[#93C5FD] transition-colors hover:border-[#3B82F6]/60 hover:bg-[#3B82F6]/10 disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          {bulkReprocessing ? 'Reprocessing selected...' : 'Reprocess selected'}
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                  <div className="hidden border-b border-[#2F3B52]/70 px-4 py-3 lg:grid lg:grid-cols-[minmax(0,0.28fr)_minmax(0,2.2fr)_minmax(0,1fr)_minmax(0,0.9fr)_minmax(0,1fr)_minmax(0,0.9fr)_minmax(0,0.9fr)_minmax(0,0.9fr)] lg:gap-3">
                    <label className="inline-flex items-center">
                      <input
                        type="checkbox"
                        checked={allOrderedDocumentsSelected}
                        onChange={(event) => handleSelectAllDocuments(event.target.checked)}
                        aria-label="Select all documents"
                        className="h-3.5 w-3.5 rounded border-[#2F3B52] bg-[#0B1020] text-[#3B82F6] focus:ring-[#3B82F6]"
                      />
                    </label>
                    {['File Name', 'Document Type', 'Role', 'Processing Status', 'Last Processed', 'Decision Impact', 'Actions'].map((label) => (
                      <p
                        key={label}
                        className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#94A3B8]"
                      >
                        {label}
                      </p>
                    ))}
                  </div>
                  <div className="divide-y divide-[#2F3B52]/70">
                    {orderedDocuments.map((document) => (
                      <DocumentListRow
                        key={document.id}
                        document={document}
                        model={model}
                        selected={selectedDocumentIds.has(document.id)}
                        processing={reprocessingDocumentIds.has(document.id)}
                        reprocessDisabled={documentReprocessInProgress}
                        error={reprocessErrors[document.id] ?? null}
                        onSelect={handleSelectDocument}
                        onReprocess={handleReprocessDocument}
                      />
                    ))}
                  </div>
                </div>
              )}
            </section>

            <DocumentPrecedenceSection projectId={model.project.id} />

            <section id="project-facts" className="space-y-6">
              <SectionHeading
                title="Project Facts"
                subtitle="Resolved canonical project truth across contract, invoice, transaction, and validation layers."
              />
              <div className="space-y-5">
                {truthSections.map((section) => (
                  <TruthSheetSection key={section.key} section={section} />
                ))}
              </div>
            </section>
          </section>
        ) : activeTab === 'validator' ? (
          <section id="project-validator" className="space-y-4">
            {/* Legacy deep-link anchors: Decisions was folded into this surface. */}
            <span id="project-actions" className="sr-only" aria-hidden="true" />
            <span id="project-decisions" className="sr-only" aria-hidden="true" />
            <SectionHeading
              title="Validator"
              subtitle="Rule-backed validation findings, evidence, and decision & execution for this project."
            />
            {validatorTab ? (
              validatorTab(issueObjects)
            ) : (
              <div className="rounded-sm border border-[#2F3B52]/70 bg-[#111827] p-4 text-sm text-[#94A3B8]">
                Validator details are not available for this project yet.
              </div>
            )}
          </section>
        ) : activeTab === 'audit' ? (
          <section id="project-audit" className="space-y-4">
            <SectionHeading
              title="Audit Timeline"
              subtitle="Newest-first project history across documents, validation, and workflow state changes."
            />
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
        ) : (
          <>
            <section className="space-y-4">
              <SectionHeading
                title="Overview"
                subtitle="Decision-ready briefing sourced from canonical project truth."
              />
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                {overviewBriefing.summary_items.map((item) => (
                  <SummaryStripItem key={item.key} item={item} />
                ))}
              </div>
            </section>

            <section className="space-y-4">
              <ProjectAskBar projectId={model.project.id} />
              <AskProjectSection
                projectId={model.project.id}
                validatorStatus={model.validator_status}
                criticalFindings={model.validator_summary.approval_blocker_count ?? 0}
                documents={documents}
                decisions={decisions}
                tasks={tasks}
              />
            </section>

            <section className="space-y-4">
              <SectionHeading
                title="Critical Signals"
                subtitle="High-impact truth that changes approval flow, risk, or required operator verification."
              />
              {overviewBriefing.critical_signals.length === 0 ? (
                <div className="rounded-sm border border-[#2F3B52]/70 bg-[#111827] p-4 text-sm text-[#94A3B8]">
                  No critical signals are open right now. Canonical project truth is not surfacing an approval, support, invoice, or contract risk that needs escalation.
                </div>
              ) : (
                <div className="space-y-4">
                  {overviewBriefing.critical_signals.map((signal) => (
                    <CriticalSignalCard key={signal.key} signal={signal} />
                  ))}
                </div>
              )}
            </section>

            <section className="space-y-4">
              <SectionHeading
                title="Project Truth Snapshot"
                subtitle="Condensed canonical truth across contract, invoice, and transaction layers."
              />
              <div className="grid gap-4 xl:grid-cols-3">
                {overviewBriefing.snapshot_sections.map((section) => (
                  <TruthSnapshotCard key={section.key} title={section.title} rows={section.rows} />
                ))}
              </div>
            </section>

            <section id="project-required-reviews" className="space-y-4">
              <SectionHeading
                title="Required Reviews"
                subtitle={
                  requiredReviewCount > 0
                    ? `${requiredReviewCount} validator-backed review${requiredReviewCount === 1 ? '' : 's'} are open and ready for operator action.`
                    : 'No validator-backed reviews are currently open.'
                }
              />
              {requiredReviewDecisions.length === 0 ? (
                <div className="rounded-sm border border-[#2F3B52]/70 bg-[#111827] p-4 text-sm text-[#94A3B8]">
                  {requiredReviewCount > 0
                    ? 'Validator findings are open, but decision execution records are not ready yet. Open the Validator tab to confirm the current blockers and review path.'
                    : model.decision_empty_state}
                </div>
              ) : (
                <div className="space-y-4">
                  {requiredReviewDecisions.map((decision) => (
                    <ProjectDecisionExecutionCard
                      key={decision.id}
                      decision={decision}
                      onProjectRefresh={onProjectRefresh}
                    />
                  ))}
                </div>
              )}
            </section>
          </>
        )}
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
            <a href="#project-validator" className="text-xs font-bold uppercase tracking-[0.14em] text-[#C7D2E3] transition-colors hover:text-[#3B82F6]">
              Validator
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
