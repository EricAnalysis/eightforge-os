'use client';

import Link from 'next/link';
import { type ReactNode } from 'react';
import type { DocumentFactAnchorRecord } from '@/lib/documentFactAnchors';
import type { DocumentFactReviewStatus } from '@/lib/documentFactReviews';
import type { DocumentFactOverrideActionType } from '@/lib/documentFactOverrides';
import type { DocumentIntelligenceViewModel } from '@/lib/documentIntelligenceViewModel';
import { DocumentIntelligenceStrip } from '@/components/document-intelligence/DocumentIntelligenceStrip';
import { DocumentIntelligenceWorkspace } from '@/components/document-intelligence/DocumentIntelligenceWorkspace';
import { InvoiceSurface } from '@/components/document-intelligence/InvoiceSurface';
import { SpreadsheetReviewSurface } from '@/components/document-intelligence/SpreadsheetReviewSurface';
import { DiagnosticsDrawer } from '@/components/document-intelligence/DiagnosticsDrawer';
import { ReviewSection } from '@/components/document-intelligence/ReviewSection';
import { AuditSection } from '@/components/document-intelligence/AuditSection';
import { AskDocumentSection } from '@/components/document-intelligence/AskDocumentSection';
import { CrossDocChecks } from '@/components/document-intelligence/CrossDocChecks';
import type {
  AuditNote,
  ComparisonResult,
  DetectedEntity,
  DocumentSummary,
  GeneratedDecision,
  PipelineTraceNode,
  SuggestedQuestion,
  TriggeredWorkflowTask,
} from '@/lib/types/documentIntelligence';

type BreadcrumbItem = {
  label: string;
  href?: string;
};

type ContractRateRow = NonNullable<DocumentIntelligenceViewModel['contractRateRows']>[number];

function statusClass(status: string): string {
  switch (status) {
    case 'processing':
      return 'bg-amber-500/20 text-amber-300 border border-amber-500/40';
    case 'ready':
      return 'bg-sky-500/20 text-sky-300 border border-sky-500/40';
    case 'needs_review':
      return 'bg-amber-500/20 text-amber-300 border border-amber-500/40';
    case 'extracted':
      return 'bg-sky-500/20 text-sky-300 border border-sky-500/40';
    case 'decisioned':
      return 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40';
    case 'failed':
      return 'bg-red-500/20 text-red-300 border border-red-500/40';
    default:
      return 'bg-white/[0.05] text-[#D9E3F3] border border-white/10';
  }
}

function StatusPill({ status }: { status: string }) {
  return (
    <span className={`inline-flex rounded-full px-2.5 py-1 text-[11px] font-medium ${statusClass(status)}`}>
      {status}
    </span>
  );
}

function countOpenActionTasks(tasks: TriggeredWorkflowTask[]): number {
  return tasks.filter((task) => task.status === 'open' || task.status === 'in_progress').length;
}

function countHighPriorityActionTasks(tasks: TriggeredWorkflowTask[]): number {
  return tasks.filter(
    (task) => (task.status === 'open' || task.status === 'in_progress') && task.priority === 'P1',
  ).length;
}

function countCriticalDecisions(decisions: GeneratedDecision[]): number {
  return decisions.filter(
    (decision) =>
      decision.normalized_severity === 'critical' ||
      decision.severity === 'critical' ||
      decision.status === 'mismatch',
  ).length;
}

function pluralize(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function DocumentImpactContext({
  decisions,
  tasks,
  reviewableDecisionIds,
  summary,
  unavailableMessage,
  projectContextLabel,
}: {
  decisions: GeneratedDecision[];
  tasks: TriggeredWorkflowTask[];
  reviewableDecisionIds: string[];
  summary: DocumentSummary | null;
  unavailableMessage?: string | null;
  projectContextLabel?: string;
}) {
  const openActionCount = countOpenActionTasks(tasks);
  const highPriorityActionCount = countHighPriorityActionTasks(tasks);
  const criticalDecisionCount = countCriticalDecisions(decisions);
  const decisionCount = decisions.length;
  const reviewCount = reviewableDecisionIds.length;
  const showImpactContext =
    Boolean(unavailableMessage) ||
    decisionCount > 0 ||
    openActionCount > 0 ||
    reviewCount > 0 ||
    Boolean(summary?.nextAction);

  if (!showImpactContext) {
    return null;
  }

  const decisionValue = unavailableMessage
    ? 'Pending'
    : decisionCount > 0
      ? `${pluralize(decisionCount, 'open finding', 'open findings')}`
      : 'No open findings';
  const decisionDetail = unavailableMessage
    ? unavailableMessage
    : criticalDecisionCount > 0
      ? `${pluralize(criticalDecisionCount, 'critical issue', 'critical issues')} still reference this document.`
      : 'This document contributes evidence to project-level decisions when findings are raised.';
  const actionValue = unavailableMessage
    ? 'Pending'
    : openActionCount > 0
      ? `${pluralize(openActionCount, 'open action', 'open actions')}`
      : 'No open actions';
  const actionDetail = unavailableMessage
    ? 'Workflow context will populate when the linked project refresh completes.'
    : highPriorityActionCount > 0
      ? `${pluralize(highPriorityActionCount, 'high-priority action', 'high-priority actions')} still depend on this document.`
      : 'Project actions stay in the Forge; this page keeps only document-level impact context.';
  const reviewValue = reviewCount > 0
    ? `${pluralize(reviewCount, 'approval review', 'approval reviews')}`
    : summary?.nextAction
      ? 'Project follow-up queued'
      : unavailableMessage
        ? 'Pending'
        : 'No approval follow-up';
  const reviewDetail = reviewCount > 0
    ? `Use ${projectContextLabel ?? 'the linked project'} to resolve approval-facing findings tied to this document.`
    : summary?.nextAction
      ? summary.nextAction
      : 'Approval flow and action completion stay in the project workspace.';

  return (
    <section className="rounded-2xl border border-white/10 bg-[#0B1220]">
      <div className="border-b border-white/8 px-5 py-4">
        <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-[#7FA6FF]">
          Project Impact
        </p>
        <p className="mt-1 text-[12px] text-[#8FA1BC]">
          This document informs project decisions and actions, but detailed workflow stays in the Forge.
        </p>
      </div>
      <div className="grid gap-3 px-5 py-4 md:grid-cols-3">
        <div className="rounded-2xl border border-white/8 bg-white/[0.03] px-4 py-3">
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#7F90AA]">
            Decisions
          </p>
          <p className="mt-2 text-sm font-semibold text-[#F5F7FA]">{decisionValue}</p>
          <p className="mt-1 text-[11px] leading-relaxed text-[#8FA1BC]">{decisionDetail}</p>
        </div>
        <div className="rounded-2xl border border-white/8 bg-white/[0.03] px-4 py-3">
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#7F90AA]">
            Next Actions
          </p>
          <p className="mt-2 text-sm font-semibold text-[#F5F7FA]">{actionValue}</p>
          <p className="mt-1 text-[11px] leading-relaxed text-[#8FA1BC]">{actionDetail}</p>
        </div>
        <div className="rounded-2xl border border-white/8 bg-white/[0.03] px-4 py-3">
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#7F90AA]">
            Approval Flow
          </p>
          <p className="mt-2 text-sm font-semibold text-[#F5F7FA]">{reviewValue}</p>
          <p className="mt-1 text-[11px] leading-relaxed text-[#8FA1BC]">{reviewDetail}</p>
        </div>
      </div>
    </section>
  );
}

function formatRateValue(rate: number | null): string {
  if (rate == null) return '—';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(rate);
}

function buildRateRowHref(params: {
  documentId: string;
  row: ContractRateRow;
  navigationSource?: string | null;
  navigationProjectId?: string | null;
}): string {
  const query = new URLSearchParams();
  if (params.navigationSource) query.set('source', params.navigationSource);
  if (params.navigationProjectId) query.set('projectId', params.navigationProjectId);
  query.set('fieldKey', 'rate_schedule_pages');
  query.set('rateRowId', params.row.rowId);
  if (params.row.page != null) query.set('page', String(params.row.page));
  return `/platform/documents/${params.documentId}?${query.toString()}`;
}

function ContractRateTablePanel({
  documentId,
  rows,
  selectedRateRowId,
  navigationSource,
  navigationProjectId,
}: {
  documentId: string;
  rows: ContractRateRow[];
  selectedRateRowId?: string | null;
  navigationSource?: string | null;
  navigationProjectId?: string | null;
}) {
  if (rows.length === 0) return null;

  return (
    <section className="rounded-2xl border border-white/10 bg-[#0B1220]">
      <div className="border-b border-white/8 px-5 py-4">
        <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-[#7FA6FF]">
          Rate Table
        </p>
        <p className="mt-1 text-[12px] text-[#8FA1BC]">
          Canonical contract rate rows from the persisted contract analysis. Select a row to inspect its source context.
        </p>
      </div>

      <div className="overflow-x-auto">
        <div className="hidden min-w-[760px] border-b border-white/8 px-5 py-3 text-[10px] font-semibold uppercase tracking-[0.18em] text-[#7F90AA] md:grid md:grid-cols-[minmax(0,2.2fr)_minmax(0,0.8fr)_minmax(0,0.9fr)_minmax(0,0.9fr)_minmax(0,0.6fr)] md:gap-3">
          <span>Description</span>
          <span>Unit</span>
          <span>Rate</span>
          <span>Category</span>
          <span>Page</span>
        </div>

        <div className="min-w-[760px] divide-y divide-white/8">
          {rows.map((row) => {
            const isSelected = selectedRateRowId === row.rowId;
            const href = buildRateRowHref({
              documentId,
              row,
              navigationSource,
              navigationProjectId,
            });

            return (
              <Link
                key={row.rowId}
                href={href}
                scroll={false}
                className={`block px-5 py-3 transition ${
                  isSelected ? 'bg-[#3B82F6]/10' : 'hover:bg-white/[0.03]'
                }`}
              >
                <div className="grid gap-3 md:grid-cols-[minmax(0,2.2fr)_minmax(0,0.8fr)_minmax(0,0.9fr)_minmax(0,0.9fr)_minmax(0,0.6fr)] md:items-start">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="truncate text-sm font-semibold text-[#F5F7FA]">
                        {row.description ?? 'Untitled rate row'}
                      </p>
                      {isSelected ? (
                        <span className="rounded-full border border-[#3B82F6]/30 bg-[#3B82F6]/12 px-2 py-0.5 text-[10px] font-medium text-[#CFE4FF]">
                          Selected
                        </span>
                      ) : null}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-[#8FA1BC]">
                      <span className="font-mono text-[10px] text-[#7F90AA]">{row.rowId}</span>
                      {row.sourceAnchorIds.length > 0 ? (
                        <span>
                          {row.sourceAnchorIds.length} source anchor{row.sourceAnchorIds.length === 1 ? '' : 's'}
                        </span>
                      ) : (
                        <span>Page-level source context</span>
                      )}
                    </div>
                  </div>

                  <div className="text-sm text-[#D9E3F3]">{row.unit ?? '—'}</div>
                  <div className="text-sm font-medium text-[#F5F7FA]">{formatRateValue(row.rate)}</div>
                  <div className="text-sm text-[#D9E3F3]">{row.category ?? '—'}</div>
                  <div className="text-sm text-[#D9E3F3]">
                    {row.page != null ? `Page ${row.page}` : 'Context'}
                  </div>
                </div>
              </Link>
            );
          })}
        </div>
      </div>
    </section>
  );
}

export function DocumentDetailExperience({
  breadcrumbs,
  contextLabel,
  contextDescription,
  projectName,
  documentType,
  displayTitle,
  processingStatus,
  summary,
  entities,
  fileContentType,
  fileLoading,
  fileError,
  signedUrl,
  fileExt,
  filename,
  projectDocumentsHref,
  secondaryBackHref,
  secondaryBackLabel,
  primaryBackHref,
  primaryBackLabel,
  processingStatusNode,
  hasIntelligenceWorkspace,
  intelligenceViewModel,
  extractionVersion,
  extractionTimestamp,
  decisions,
  tasks,
  projectContextLabel,
  reviewableDecisionIds,
  unavailableMessage,
  documentId,
  orgId,
  comparisons,
  suggestedQuestions,
  uploadedAt,
  processedAt,
  decisionsGeneratedAt,
  tasksCreatedAt,
  auditNotes,
  nodeTraces,
  evaluationNode,
  managementNode,
  onSaveFactOverride,
  onSaveFactReview,
  onSaveFactAnchor,
  onSaveRateScheduleAnchor,
  initialSelectedFactId,
  initialSelectedFieldKey,
  initialPage,
  navigationKey,
  selectedRecordId,
  selectedRateRowId,
  navigationAction,
  navigationSource,
  navigationProjectId,
  navigationDecisionHref,
  navigationValidatorHref,
}: {
  breadcrumbs: BreadcrumbItem[];
  contextLabel: string;
  contextDescription: string;
  projectName: string | null;
  documentType: string | null;
  displayTitle: string;
  processingStatus: string;
  summary: DocumentSummary | null;
  entities: DetectedEntity[];
  fileContentType: string;
  fileLoading: boolean;
  fileError: string | null;
  signedUrl: string | null;
  fileExt: string;
  filename: string;
  projectDocumentsHref: string | null;
  secondaryBackHref: string | null;
  secondaryBackLabel: string;
  primaryBackHref: string;
  primaryBackLabel: string;
  processingStatusNode: ReactNode;
  hasIntelligenceWorkspace: boolean;
  intelligenceViewModel: DocumentIntelligenceViewModel | null;
  extractionVersion: string | null;
  extractionTimestamp: string | null;
  decisions: GeneratedDecision[];
  tasks: TriggeredWorkflowTask[];
  projectContextLabel?: string;
  reviewableDecisionIds: string[];
  unavailableMessage?: string | null;
  documentId: string;
  orgId?: string;
  comparisons: ComparisonResult[];
  suggestedQuestions: SuggestedQuestion[];
  uploadedAt: string;
  processedAt?: string | null;
  decisionsGeneratedAt?: string | null;
  tasksCreatedAt?: string | null;
  auditNotes: AuditNote[];
  nodeTraces: PipelineTraceNode[];
  evaluationNode?: ReactNode;
  managementNode?: ReactNode;
  onSaveFactOverride: (input: {
    fieldKey: string;
    valueJson: unknown;
    rawValue?: string | null;
    actionType: DocumentFactOverrideActionType;
    reason?: string | null;
  }) => Promise<{ ok: true } | { ok: false; error: string }>;
  onSaveFactReview: (input: {
    fieldKey: string;
    reviewStatus: DocumentFactReviewStatus;
    reviewedValueJson?: unknown;
    notes?: string | null;
  }) => Promise<{ ok: true } | { ok: false; error: string }>;
  onSaveFactAnchor: (input: {
    fieldKey: string;
    overrideId?: string | null;
    anchorType: 'text' | 'region';
    pageNumber: number;
    snippet?: string | null;
    quoteText?: string | null;
    rectJson?: Record<string, unknown> | null;
    anchorJson?: Record<string, unknown> | null;
  }) => Promise<
    | { ok: true; anchor: DocumentFactAnchorRecord }
    | { ok: false; error: string }
  >;
  onSaveRateScheduleAnchor: (input: {
    startPage: number;
    endPage: number;
    rectJson?: Record<string, unknown> | null;
  }) => Promise<
    | { ok: true; anchor: DocumentFactAnchorRecord }
    | { ok: false; error: string }
  >;
  initialSelectedFactId?: string | null;
  initialSelectedFieldKey?: string | null;
  initialPage?: number | null;
  navigationKey?: string | null;
  selectedRecordId?: string | null;
  selectedRateRowId?: string | null;
  navigationAction?: string | null;
  navigationSource?: string | null;
  navigationProjectId?: string | null;
  navigationDecisionHref?: string | null;
  navigationValidatorHref?: string | null;
}) {
  const headerEntities = entities.slice(0, 6);
  const hasAuditData =
    auditNotes.length > 0 ||
    nodeTraces.length > 0 ||
    processedAt != null ||
    decisionsGeneratedAt != null ||
    tasksCreatedAt != null;
  const hasRightRail = comparisons.length > 0;
  const showAskThisDocument = suggestedQuestions.length > 0;
  const isSpreadsheetDocument = Boolean(intelligenceViewModel?.transactionDataExtraction);
  const operatorNote = fileLoading
    ? 'Generating secure source access.'
    : fileError
      ? fileError
      : navigationAction === 'manual_override' && !isSpreadsheetDocument
        ? 'Selected fact is focused for manual override in the evidence panel.'
        : navigationAction != null && !isSpreadsheetDocument
          ? 'Selected fact is focused in the evidence panel for confirmation or correction.'
          : selectedRateRowId
            ? 'Selected contract rate row is highlighted below.'
            : isSpreadsheetDocument && selectedRecordId
              ? 'Selected spreadsheet row is highlighted below for exact evidence review.'
              : 'Select a fact to jump directly into its source evidence.';

  return (
    <div className="space-y-5">
      <nav
        aria-label="Breadcrumb"
        className="flex flex-wrap items-center gap-2 text-[10px] font-medium uppercase tracking-[0.18em] text-[#8B94A3]"
      >
        {breadcrumbs.map((item, index) => (
          <div key={`${item.label}-${index}`} className="flex items-center gap-2">
            {item.href ? (
              <Link href={item.href} className="transition-colors hover:text-[#E5EDF7]">
                {item.label}
              </Link>
            ) : (
              <span className="text-[#E5EDF7]">{item.label}</span>
            )}
            {index < breadcrumbs.length - 1 ? (
              <span className="text-[#3B82F6]">/</span>
            ) : null}
          </div>
        ))}
      </nav>

      <section className="overflow-hidden rounded-[28px] border border-[#25324A] bg-[linear-gradient(180deg,#10192B_0%,#0A101B_100%)] shadow-[0_24px_80px_rgba(2,8,23,0.45)]">
        <div className="grid gap-6 px-5 py-5 xl:grid-cols-[minmax(0,1fr)_auto] xl:px-6 xl:py-6">
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-full border border-[#3B82F6]/30 bg-[#3B82F6]/10 px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-[#8CC2FF]">
                {contextLabel}
              </span>
              <span className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-[#D9E3F3]">
                {projectName ? 'Linked Project' : 'Standalone Document'}
              </span>
              <span className="rounded-full border border-white/10 bg-[#0F172A] px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-[#8FA1BC]">
                {documentType ? documentType.replace(/_/g, ' ') : 'Document'}
              </span>
              {fileContentType ? (
                <span className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-[10px] font-medium uppercase tracking-[0.16em] text-[#7F90AA]">
                  {fileContentType}
                </span>
              ) : null}
            </div>

            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-3">
                <h1 className="text-2xl font-semibold tracking-[-0.02em] text-[#F5F7FA] sm:text-[30px]">
                  {displayTitle}
                </h1>
                <StatusPill status={processingStatus} />
              </div>

              <p className="max-w-4xl text-sm leading-relaxed text-[#D9E3F3]">
                {summary?.headline ?? contextDescription}
              </p>

              <div className="flex flex-wrap gap-3 text-[12px] text-[#8FA1BC]">
                <span>Project: <span className="text-[#F5F7FA]">{projectName ?? 'No linked project'}</span></span>
                {summary?.nextAction ? (
                  <span>Next action: <span className="text-[#F5F7FA]">{summary.nextAction}</span></span>
                ) : null}
                {summary?.traceHint ? (
                  <span>Trace: <span className="text-[#F5F7FA]">{summary.traceHint}</span></span>
                ) : null}
              </div>
            </div>

            <div className="grid gap-3 md:grid-cols-2 2xl:grid-cols-4">
              <div className="rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3">
                <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#7F90AA]">
                  Project Context
                </p>
                <p className="mt-2 text-sm font-semibold text-[#F5F7FA]">
                  {projectName ?? 'Standalone intake'}
                </p>
                <p className="mt-1 text-[11px] leading-relaxed text-[#8FA1BC]">
                  {contextDescription}
                </p>
              </div>

              <div className="rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3">
                <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#7F90AA]">
                  Processing
                </p>
                <p className="mt-2 text-sm font-semibold text-[#F5F7FA]">{processingStatus}</p>
                <p className="mt-1 text-[11px] leading-relaxed text-[#8FA1BC]">
                  {extractionTimestamp
                    ? `Last processed ${new Date(extractionTimestamp).toLocaleString()}`
                    : 'No completed extraction timestamp yet.'}
                </p>
              </div>

              <div className="rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3">
                <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#7F90AA]">
                  Extraction Version
                </p>
                <p className="mt-2 text-sm font-semibold text-[#F5F7FA]">{extractionVersion ?? 'Pending'}</p>
                <p className="mt-1 text-[11px] leading-relaxed text-[#8FA1BC]">
                  {hasIntelligenceWorkspace && intelligenceViewModel
                    ? `${intelligenceViewModel.counts.totalFacts} normalized facts ready for review.`
                    : 'Structured facts will appear here after extraction normalizes.'}
                </p>
              </div>

              <div className="rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3">
                <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#7F90AA]">
                  File Actions
                </p>
                <p className="mt-2 text-sm font-semibold text-[#F5F7FA]">
                  {signedUrl ? 'Ready' : fileLoading ? 'Preparing secure link' : 'Not ready'}
                </p>
                <p className="mt-1 text-[11px] leading-relaxed text-[#8FA1BC]">
                  {fileError
                    ? fileError
                    : signedUrl
                      ? 'Open or download without leaving the intelligence workspace.'
                      : 'Secure preview link will appear when available.'}
                </p>
              </div>
            </div>

            {headerEntities.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {headerEntities.map((entity) => (
                  <span
                    key={entity.key}
                    className="inline-flex items-center gap-2 rounded-full border border-[#3B82F6]/20 bg-[#0D1728] px-3 py-1 text-[11px]"
                  >
                    <span className="text-[#7FA6FF]">{entity.label}</span>
                    <span className="font-medium text-[#F5F7FA]">{entity.value}</span>
                  </span>
                ))}
              </div>
            ) : null}
          </div>

          <div className="flex flex-col gap-3 xl:items-end">
            <div className="flex flex-wrap items-center gap-2">
              {projectDocumentsHref ? (
                <Link
                  href={projectDocumentsHref}
                  className="rounded-md border border-[#2F3B52] bg-[#101827] px-3 py-2 text-[11px] font-medium text-[#D9E3F3] hover:border-[#3B82F6]/40 hover:text-white"
                >
                  Project Documents
                </Link>
              ) : null}
              {secondaryBackHref ? (
                <Link
                  href={secondaryBackHref}
                  className="rounded-md border border-[#2F3B52] bg-[#101827] px-3 py-2 text-[11px] font-medium text-[#D9E3F3] hover:border-[#3B82F6]/40 hover:text-white"
                >
                  {secondaryBackLabel}
                </Link>
              ) : null}
              <Link
                href={primaryBackHref}
                className="rounded-md border border-[#3B82F6]/30 bg-[#3B82F6]/10 px-3 py-2 text-[11px] font-medium text-[#CFE4FF] hover:bg-[#3B82F6]/15"
              >
                {primaryBackLabel}
              </Link>
            </div>

            {signedUrl ? (
              <div className="flex flex-wrap items-center gap-2">
                <a
                  href={signedUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="rounded-md bg-[#8B5CFF] px-3 py-2 text-[11px] font-medium text-white hover:bg-[#7A4FE8]"
                >
                  Open File
                </a>
                <a
                  href={signedUrl}
                  download={filename}
                  rel="noopener noreferrer"
                  className="rounded-md border border-[#2F3B52] bg-[#101827] px-3 py-2 text-[11px] font-medium text-[#D9E3F3] hover:border-[#3B82F6]/40 hover:text-white"
                >
                  Download
                </a>
              </div>
            ) : null}

            <div className="max-w-xs rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3 text-[11px] text-[#8FA1BC] xl:text-right">
              <p className="font-semibold uppercase tracking-[0.18em] text-[#7F90AA]">Operator Note</p>
              <p className="mt-2 leading-relaxed">
                {operatorNote}
              </p>
            </div>

            {managementNode}
          </div>
        </div>
      </section>

      {showAskThisDocument ? (
        <AskDocumentSection questions={suggestedQuestions} documentId={documentId} />
      ) : null}

      {processingStatusNode}

      {hasIntelligenceWorkspace && intelligenceViewModel ? (
        <>
          {isSpreadsheetDocument ? (
            intelligenceViewModel.spreadsheetReviewDataset ? (
              <SpreadsheetReviewSurface
                dataset={intelligenceViewModel.spreadsheetReviewDataset}
                selectedRecordId={selectedRecordId}
                navigationAction={navigationAction}
                decisionContextHref={navigationDecisionHref}
                validatorHref={navigationValidatorHref}
              />
            ) : null
          ) : (
            <>
              <DocumentIntelligenceStrip items={intelligenceViewModel.strip} />

              {intelligenceViewModel.family === 'contract' &&
              (intelligenceViewModel.contractRateRows?.length ?? 0) > 0 ? (
                <ContractRateTablePanel
                  documentId={documentId}
                  rows={intelligenceViewModel.contractRateRows ?? []}
                  selectedRateRowId={selectedRateRowId}
                  navigationSource={navigationSource}
                  navigationProjectId={navigationProjectId}
                />
              ) : null}

              {/* Type-specific inspection surfaces — rendered before the fact ledger.
                  Contracts intentionally render nothing here; their UX is the fact ledger itself. */}
              {intelligenceViewModel.invoiceExtraction ? (
                <InvoiceSurface extraction={intelligenceViewModel.invoiceExtraction} />
              ) : null}

              {/* Fact workspace — always available as evidence drilldown for supported document types */}
              <DocumentIntelligenceWorkspace
                model={intelligenceViewModel}
                signedUrl={signedUrl}
                fileExt={fileExt}
                filename={filename}
                initialSelectedFactId={initialSelectedFactId}
                initialSelectedFieldKey={initialSelectedFieldKey}
                initialPage={initialPage}
                navigationKey={navigationKey}
                onSaveFactOverride={onSaveFactOverride}
                onSaveFactReview={onSaveFactReview}
                onSaveFactAnchor={onSaveFactAnchor}
                onSaveRateScheduleAnchor={onSaveRateScheduleAnchor}
              />
            </>
          )}
        </>
      ) : (
        <section className="rounded-3xl border border-amber-400/20 bg-amber-400/10 px-5 py-5">
          <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-amber-100">
            Structured Facts Pending
          </p>
          <p className="mt-2 text-sm leading-relaxed text-amber-50">
            {unavailableMessage ??
              'Normalized facts and evidence anchors are not ready yet. Reprocess the document or wait for extraction to finish.'}
          </p>
        </section>
      )}

      {isSpreadsheetDocument ? null : (
        <DocumentImpactContext
          decisions={decisions}
          tasks={tasks}
          reviewableDecisionIds={reviewableDecisionIds}
          summary={summary}
          unavailableMessage={unavailableMessage}
          projectContextLabel={projectContextLabel}
        />
      )}

      {isSpreadsheetDocument ? null : hasRightRail ? (
        <section className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,0.95fr)]">
          <ReviewSection documentId={documentId} orgId={orgId} />
          <div className="space-y-4">
            {comparisons.length > 0 ? <CrossDocChecks comparisons={comparisons} /> : null}
          </div>
        </section>
      ) : (
        <ReviewSection documentId={documentId} orgId={orgId} />
      )}

      {isSpreadsheetDocument ? null : (
      <section className="space-y-4">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-[#7FA6FF]">
            Diagnostics
          </p>
          <p className="mt-1 text-[12px] text-[#8FA1BC]">
            Raw parser payloads, OCR text, schema logs, and audit traces stay available but collapsed by default.
          </p>
        </div>

        {hasIntelligenceWorkspace && intelligenceViewModel && intelligenceViewModel.diagnostics.length > 0 ? (
          intelligenceViewModel.diagnostics.map((drawer) => (
            <DiagnosticsDrawer key={drawer.id} drawer={drawer} />
          ))
        ) : (
          <div className="rounded-2xl border border-white/10 bg-[#0B1220] px-5 py-4 text-sm text-[#8FA1BC]">
            Diagnostics will populate when extraction outputs are available.
          </div>
        )}

        {hasAuditData ? (
          <details className="overflow-hidden rounded-2xl border border-white/10 bg-[#0B1220]">
            <summary className="cursor-pointer list-none px-5 py-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[#7FA6FF]">
                    Audit Timeline
                  </p>
                  <p className="mt-1 text-[12px] text-[#8FA1BC]">
                    Processing milestones, decision trace notes, and pipeline execution history.
                  </p>
                </div>
                <span className="text-[11px] text-[#7F90AA]">Expand</span>
              </div>
            </summary>
            <div className="border-t border-white/8 p-4">
              <AuditSection
                uploadedAt={uploadedAt}
                processedAt={processedAt}
                decisionsGeneratedAt={decisionsGeneratedAt}
                tasksCreatedAt={tasksCreatedAt}
                currentStatus={processingStatus}
                auditNotes={auditNotes}
                nodeTraces={nodeTraces}
              />
            </div>
          </details>
        ) : null}
      </section>
      )}

      {isSpreadsheetDocument ? null : evaluationNode}
    </div>
  );
}
