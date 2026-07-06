'use client';

import Link from 'next/link';
import { type ReactNode, useEffect, useState } from 'react';
import type { DocumentFactAnchorRecord } from '@/lib/documentFactAnchors';
import type { DocumentFactReviewStatus } from '@/lib/documentFactReviews';
import type { DocumentFactOverrideActionType } from '@/lib/documentFactOverrides';
import type { DocumentIntelligenceViewModel } from '@/lib/documentIntelligenceViewModel';
import { deriveLedgerInsightSignals, type LedgerInsightSignals } from '@/lib/invoiceLedgerInsights';
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

type DocumentExperienceTab = 'extraction' | 'facts' | 'evidence' | 'insights';

type ContractRateRow = NonNullable<DocumentIntelligenceViewModel['contractPricingAssemblyRows']>[number];

function statusClass(status: string): string {
  switch (status) {
    case 'processing':
      return 'bg-[var(--ef-warning-a20)] text-[var(--ef-warning-soft)] border border-[var(--ef-warning-a40)]';
    case 'ready':
      return 'bg-white/[0.03] text-[var(--ef-text-secondary)] border border-[var(--ef-border-white-10)]';
    case 'needs_review':
      return 'bg-[var(--ef-warning-a20)] text-[var(--ef-warning-soft)] border border-[var(--ef-warning-a40)]';
    case 'extracted':
      return 'bg-white/[0.03] text-[var(--ef-text-secondary)] border border-[var(--ef-border-white-10)]';
    case 'decisioned':
      return 'bg-[var(--ef-success-a20)] text-[var(--ef-success-soft)] border border-[var(--ef-success-a40)]';
    case 'failed':
      return 'bg-[var(--ef-critical-a20)] text-[var(--ef-critical-soft)] border border-[var(--ef-critical-a40)]';
    default:
      return 'bg-white/[0.05] text-[var(--ef-text-secondary)] border border-[var(--ef-border-white-10)]';
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

function ExperienceTabButton({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full border px-3 py-1.5 text-[11px] font-medium transition ${
        active
          ? 'border-[var(--ef-purple-primary-a30)] bg-[var(--ef-purple-primary-a10)] text-[var(--ef-purple-glow)]'
          : 'border-[var(--ef-border-white-10)] bg-white/[0.03] text-[var(--ef-text-muted)] hover:text-[var(--ef-text-primary)]'
      }`}
    >
      {label}
    </button>
  );
}

function DocumentImpactContext({
  decisions,
  tasks,
  reviewableDecisionIds,
  summary,
  unavailableMessage,
  projectContextLabel,
  ledgerSignals,
}: {
  decisions: GeneratedDecision[];
  tasks: TriggeredWorkflowTask[];
  reviewableDecisionIds: string[];
  summary: DocumentSummary | null;
  unavailableMessage?: string | null;
  projectContextLabel?: string;
  ledgerSignals?: LedgerInsightSignals | null;
}) {
  const openActionCount = countOpenActionTasks(tasks);
  const highPriorityActionCount = countHighPriorityActionTasks(tasks);
  const criticalDecisionCount = countCriticalDecisions(decisions);
  const decisionCount = decisions.length;
  const reviewCount = reviewableDecisionIds.length;
  const ledgerHasImpact = Boolean(ledgerSignals);
  const invoiceSurface = Boolean(ledgerSignals?.isInvoiceInsights);
  const showImpactContext =
    Boolean(unavailableMessage) ||
    decisionCount > 0 ||
    openActionCount > 0 ||
    reviewCount > 0 ||
    Boolean(summary?.nextAction) ||
    ledgerHasImpact;

  if (!showImpactContext) {
    return null;
  }

  const primaryFinding = decisions.find(
    (decision) =>
      decision.status === 'mismatch' ||
      decision.normalized_severity === 'critical' ||
      decision.severity === 'critical',
  );
  const ledgerDecisionDetail = ledgerSignals
    ? [
        ledgerSignals.crossDocComparisonDebt
          ? 'Cross-document checks show contract comparisons that need review.'
          : null,
        ledgerSignals.missingInvoiceParties
          ? 'Contractor or client identity is still missing in the normalized invoice facts.'
          : null,
        ledgerSignals.conflictedFactCount > 0
          ? `${pluralize(ledgerSignals.conflictedFactCount, 'fact is', 'facts are')} conflicted in the ledger.`
          : null,
        ledgerSignals.needsReviewFactCount > 0
          ? `${pluralize(ledgerSignals.needsReviewFactCount, 'fact still needs', 'facts still need')} normalization review.`
          : null,
      ]
        .filter(Boolean)
        .join(' ')
    : '';

  const invoiceBlocking =
    Boolean(ledgerSignals?.missingInvoiceParties)
    || (ledgerSignals?.needsReviewFactCount ?? 0) > 0
    || (ledgerSignals?.conflictedFactCount ?? 0) > 0
    || Boolean(ledgerSignals?.crossDocComparisonDebt);

  let decisionValue: string;
  let decisionDetail: string;
  let actionValue: string;
  let actionDetail: string;
  let reviewValue: string;
  let reviewDetail: string;

  if (unavailableMessage) {
    decisionValue = 'Pending';
    decisionDetail = unavailableMessage;
    actionValue = 'Pending';
    actionDetail = 'Workflow context will populate when the linked project refresh completes.';
    reviewValue = 'Pending';
    reviewDetail = unavailableMessage;
  } else if (invoiceSurface) {
    const ledgerReviewBusy = invoiceBlocking || decisionCount > 0;
    decisionValue = ledgerReviewBusy ? 'Ledger review in progress' : 'No open findings';
    decisionDetail = [
      criticalDecisionCount > 0
        ? `${pluralize(criticalDecisionCount, 'critical issue', 'critical issues')} still reference this document.${
            primaryFinding?.title ? ` Latest: ${primaryFinding.title}.` : ''
          }`.trim()
        : null,
      decisionCount > 0 && decisions[0]?.title
        ? `Open findings include "${decisions[0].title}".`
        : null,
      ledgerDecisionDetail || null,
    ]
      .filter(Boolean)
      .join(' ')
      .trim();
    if (!decisionDetail) {
      decisionDetail = 'Read-only context for this invoice; Insights does not create or close findings.';
    }

    if (openActionCount > 0) {
      actionValue = `${pluralize(openActionCount, 'open action', 'open actions')}`;
      actionDetail = highPriorityActionCount > 0
        ? `${pluralize(highPriorityActionCount, 'high-priority action', 'high-priority actions')} still depend on this document.`
        : 'Linked execution tasks remain open until they are completed in the Forge.';
    } else if (ledgerSignals?.missingInvoiceParties) {
      actionValue = 'Confirm missing contractor/client facts';
      actionDetail = 'Verify contractor and client in the Facts tab when extraction omitted either party.';
    } else {
      actionValue = 'No action required';
      actionDetail = 'Insights is read-only; use Facts and Evidence to change extraction outcomes.';
    }

    reviewValue = invoiceBlocking ? 'Project follow-up queued' : 'Not currently blocking';
    reviewDetail = invoiceBlocking
      ? 'Outstanding normalization or cross-document comparison gaps can queue billing follow-up until resolved.'
      : 'No blocking follow-up is indicated from the current ledger and comparison checks.';

    if (reviewCount > 0) {
      reviewValue = `${pluralize(reviewCount, 'approval review', 'approval reviews')}`;
      reviewDetail = `Use ${projectContextLabel ?? 'the linked project'} to resolve approval-facing findings tied to this document.`;
    } else if (summary?.nextAction && !invoiceBlocking) {
      reviewDetail = summary.nextAction;
    }
  } else {
    decisionValue = decisionCount > 0
      ? `${pluralize(decisionCount, 'open finding', 'open findings')}`
      : ledgerHasImpact
        ? 'Ledger review in progress'
        : 'No open findings';
    decisionDetail = criticalDecisionCount > 0
      ? `${pluralize(criticalDecisionCount, 'critical issue', 'critical issues')} still reference this document.${
          primaryFinding?.title ? ` Latest: ${primaryFinding.title}.` : ''
        }${ledgerDecisionDetail ? ` ${ledgerDecisionDetail}` : ''}`.trim()
      : [
          decisionCount > 0
            ? decisions[0]?.title
              ? `Open findings include "${decisions[0].title}".`
              : 'Open findings attached to this document still need closure in the project workspace.'
            : 'This document contributes evidence to project-level decisions when findings are raised.',
          ledgerDecisionDetail,
        ]
          .filter(Boolean)
          .join(' ')
          .trim();
    actionValue = openActionCount > 0
      ? `${pluralize(openActionCount, 'open action', 'open actions')}`
      : ledgerHasImpact
        ? 'Confirm ledger facts'
        : 'No open actions';
    actionDetail = openActionCount > 0
      ? highPriorityActionCount > 0
        ? `${pluralize(highPriorityActionCount, 'high-priority action', 'high-priority actions')} still depend on this document.`
        : 'Linked execution tasks remain open until they are completed in the Forge.'
      : ledgerHasImpact
        ? summary?.nextAction
          ? `${summary.nextAction} Confirm outstanding facts via the Evidence tab before approval.`
          : 'Use the Evidence workspace to resolve outstanding normalization items before approvals advance.'
        : 'Project actions stay in the Forge; this page keeps only document-level impact context.';
    reviewValue = reviewCount > 0
      ? `${pluralize(reviewCount, 'approval review', 'approval reviews')}`
      : summary?.nextAction
        ? 'Project follow-up queued'
        : unavailableMessage
          ? 'Pending'
          : ledgerSignals?.missingInvoiceParties
            ? 'Invoice parties incomplete'
            : ledgerHasImpact
              ? 'Facts need review'
              : 'Not blocking';
    reviewDetail = reviewCount > 0
      ? `Use ${projectContextLabel ?? 'the linked project'} to resolve approval-facing findings tied to this document.`
      : summary?.nextAction
        ? summary.nextAction
        : ledgerSignals?.missingInvoiceParties
          ? 'Contractor and client fields must be populated before this invoice can be treated as approval-ready.'
          : ledgerHasImpact
            ? 'Normalized facts still include low-confidence, missing, or conflicted values that should be reviewed even if processing status is current.'
            : 'Approval flow and action completion stay in the project workspace.';
  }

  return (
    <section className="rounded-2xl border border-[var(--ef-border-white-10)] bg-[var(--ef-background-primary)]">
      <div className="border-b border-white/8 px-5 py-4">
        <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-[var(--ef-purple-accent)]">
          Project Impact
        </p>
        <p className="mt-1 text-[12px] text-[var(--ef-text-soft)]">
          This document informs project decisions and actions, but detailed workflow stays in the Forge.
        </p>
      </div>
      <div className="grid gap-3 px-5 py-4 md:grid-cols-3">
        <div className="rounded-2xl border border-white/8 bg-white/[0.03] px-4 py-3">
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--ef-text-soft)]">
            Decisions
          </p>
          <p className="mt-2 text-sm font-semibold text-[var(--ef-text-primary)]">{decisionValue}</p>
          <p className="mt-1 text-[11px] leading-relaxed text-[var(--ef-text-soft)]">{decisionDetail}</p>
        </div>
        <div className="rounded-2xl border border-white/8 bg-white/[0.03] px-4 py-3">
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--ef-text-soft)]">
            Next Actions
          </p>
          <p className="mt-2 text-sm font-semibold text-[var(--ef-text-primary)]">{actionValue}</p>
          <p className="mt-1 text-[11px] leading-relaxed text-[var(--ef-text-soft)]">{actionDetail}</p>
        </div>
        <div className="rounded-2xl border border-white/8 bg-white/[0.03] px-4 py-3">
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--ef-text-soft)]">
            Approval Flow
          </p>
          <p className="mt-2 text-sm font-semibold text-[var(--ef-text-primary)]">{reviewValue}</p>
          <p className="mt-1 text-[11px] leading-relaxed text-[var(--ef-text-soft)]">{reviewDetail}</p>
        </div>
      </div>
    </section>
  );
}

function formatRateValue(rate: number | null): string {
  if (rate == null) return 'N/A';
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
  query.set('rateRowId', params.row.id);
  if (params.row.page != null) query.set('page', String(params.row.page));
  return `/platform/documents/${params.documentId}?${query.toString()}`;
}

function pricingStateLabel(row: ContractRateRow): string {
  switch (row.confidence) {
    case 'high':
      return 'Confirmed';
    case 'medium':
    case 'low':
      return 'Derived';
    case 'needs_review':
      return 'Needs review';
    default:
      return row.sourceAnchor ? 'Derived' : 'Missing evidence';
  }
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
    <section id="rate-table" className="scroll-mt-24 rounded-2xl border border-[var(--ef-border-white-10)] bg-[var(--ef-background-primary)]">
      <div className="border-b border-white/8 px-5 py-4">
        <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-[var(--ef-purple-accent)]">
          Rate Table
        </p>
        <p className="mt-1 text-[12px] text-[var(--ef-text-soft)]">
          Clean contract pricing rows assembled from the persisted contract analysis. Select a row to inspect its source context.
        </p>
      </div>

      <div className="overflow-x-auto">
        <div className="hidden min-w-[820px] border-b border-white/8 px-5 py-3 text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--ef-text-soft)] md:grid md:grid-cols-[minmax(0,1.3fr)_minmax(0,3.1fr)_minmax(0,0.75fr)_minmax(0,0.75fr)_minmax(0,0.7fr)_minmax(0,0.9fr)] md:gap-3">
          <span>Category</span>
          <span>Description or Scope</span>
          <span>Unit</span>
          <span>Rate</span>
          <span>Page</span>
          <span>State</span>
        </div>

        <div className="min-w-[820px] divide-y divide-white/8">
          {rows.map((row) => {
            const isSelected = selectedRateRowId === row.id;
            const href = buildRateRowHref({
              documentId,
              row,
              navigationSource,
              navigationProjectId,
            });

            return (
              <Link
                key={row.id}
                href={href}
                scroll={false}
                className={`block px-5 py-3 transition ${
                  isSelected ? 'bg-[var(--ef-purple-primary-a10)]' : 'hover:bg-white/[0.03]'
                }`}
              >
                <div className="grid gap-3 md:grid-cols-[minmax(0,1.3fr)_minmax(0,3.1fr)_minmax(0,0.75fr)_minmax(0,0.75fr)_minmax(0,0.7fr)_minmax(0,0.9fr)] md:items-start">
                  <div className="text-sm text-[var(--ef-text-secondary)]">{row.category ?? 'Needs review'}</div>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="truncate text-sm font-semibold text-[var(--ef-text-primary)]">
                        {row.description}
                      </p>
                      {isSelected ? (
                        <span className="rounded-full border border-[var(--ef-purple-primary-a30)] bg-[var(--ef-purple-primary-a12)] px-2 py-0.5 text-[10px] font-medium text-[var(--ef-purple-glow)]">
                          Selected
                        </span>
                      ) : null}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-[var(--ef-text-soft)]">
                      <span className="font-mono text-[10px] text-[var(--ef-text-soft)]">{row.id}</span>
                      {row.sourceAnchor ? (
                        <span>1 source anchor</span>
                      ) : (
                        <span>Page-level source context</span>
                      )}
                      {row.rawText ? <span>Raw row retained</span> : null}
                    </div>
                  </div>

                  <div className="text-sm text-[var(--ef-text-secondary)]">{row.unit ?? 'N/A'}</div>
                  <div className="text-sm font-medium text-[var(--ef-text-primary)]">{formatRateValue(row.rate)}</div>
                  <div className="text-sm text-[var(--ef-text-secondary)]">
                    {row.page != null ? `Page ${row.page}` : 'Context'}
                  </div>
                  <div className="text-sm text-[var(--ef-text-secondary)]">{pricingStateLabel(row)}</div>
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
  initialTab,
  initialSection,
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
  initialTab?: DocumentExperienceTab | null;
  initialSection?: string | null;
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
  const [activeTab, setActiveTab] = useState<DocumentExperienceTab>(initialTab ?? 'evidence');

  useEffect(() => {
    if (initialSection !== 'rate-table' || activeTab !== 'extraction') return;
    window.requestAnimationFrame(() => {
      document.getElementById('rate-table')?.scrollIntoView({ block: 'start' });
    });
  }, [activeTab, initialSection]);

  return (
    <div className="space-y-5">
      <nav
        aria-label="Breadcrumb"
        className="flex flex-wrap items-center gap-2 text-[10px] font-medium uppercase tracking-[0.18em] text-[var(--ef-text-muted)]"
      >
        {breadcrumbs.map((item, index) => (
          <div key={`${item.label}-${index}`} className="flex items-center gap-2">
            {item.href ? (
              <Link href={item.href} className="transition-colors hover:text-[var(--ef-text-primary)]">
                {item.label}
              </Link>
            ) : (
              <span className="text-[var(--ef-text-primary)]">{item.label}</span>
            )}
            {index < breadcrumbs.length - 1 ? (
              <span className="text-[var(--ef-purple-primary)]">/</span>
            ) : null}
          </div>
        ))}
      </nav>

      <section className="overflow-hidden rounded-[28px] border border-[var(--ef-surface-hover)] bg-[linear-gradient(180deg,var(--ef-background-secondary)_0%,var(--ef-background-primary)_100%)] shadow-[0_24px_80px_var(--ef-shadow-overlay)]">
        <div className="grid gap-6 px-5 py-5 xl:grid-cols-[minmax(0,1fr)_auto] xl:px-6 xl:py-6">
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-full border border-[var(--ef-purple-primary-a30)] bg-[var(--ef-purple-primary-a10)] px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--ef-purple-glow)]">
                {contextLabel}
              </span>
              <span className="rounded-full border border-[var(--ef-border-white-10)] bg-[var(--ef-border-white-06)] px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--ef-text-secondary)]">
                {projectName ? 'Linked Project' : 'Standalone Document'}
              </span>
              <span className="rounded-full border border-[var(--ef-border-white-10)] bg-[var(--ef-background-secondary)] px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--ef-text-soft)]">
                {documentType ? documentType.replace(/_/g, ' ') : 'Document'}
              </span>
              {fileContentType ? (
                <span className="rounded-full border border-[var(--ef-border-white-10)] bg-[var(--ef-border-white-06)] px-3 py-1 text-[10px] font-medium uppercase tracking-[0.16em] text-[var(--ef-text-soft)]">
                  {fileContentType}
                </span>
              ) : null}
            </div>

            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-3">
                <h1 className="text-2xl font-semibold tracking-[-0.02em] text-[var(--ef-text-primary)] sm:text-[30px]">
                  {displayTitle}
                </h1>
                <StatusPill status={processingStatus} />
              </div>

              <p className="max-w-4xl text-sm leading-relaxed text-[var(--ef-text-secondary)]">
                {summary?.headline ?? contextDescription}
              </p>

              <div className="flex flex-wrap gap-3 text-[12px] text-[var(--ef-text-soft)]">
                <span>Project: <span className="text-[var(--ef-text-primary)]">{projectName ?? 'No linked project'}</span></span>
                {summary?.nextAction ? (
                  <span>Next action: <span className="text-[var(--ef-text-primary)]">{summary.nextAction}</span></span>
                ) : null}
                {summary?.traceHint ? (
                  <span>Trace: <span className="text-[var(--ef-text-primary)]">{summary.traceHint}</span></span>
                ) : null}
              </div>
            </div>

            <div className="grid gap-3 md:grid-cols-2 2xl:grid-cols-4">
              <div className="rounded-2xl border border-[var(--ef-border-white-10)] bg-white/[0.03] px-4 py-3">
                <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--ef-text-soft)]">
                  Project Context
                </p>
                <p className="mt-2 text-sm font-semibold text-[var(--ef-text-primary)]">
                  {projectName ?? 'Standalone intake'}
                </p>
                <p className="mt-1 text-[11px] leading-relaxed text-[var(--ef-text-soft)]">
                  {contextDescription}
                </p>
              </div>

              <div className="rounded-2xl border border-[var(--ef-border-white-10)] bg-white/[0.03] px-4 py-3">
                <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--ef-text-soft)]">
                  Processing
                </p>
                <p className="mt-2 text-sm font-semibold text-[var(--ef-text-primary)]">{processingStatus}</p>
                <p className="mt-1 text-[11px] leading-relaxed text-[var(--ef-text-soft)]">
                  {extractionTimestamp
                    ? `Last processed ${new Date(extractionTimestamp).toLocaleString()}`
                    : 'No completed extraction timestamp yet.'}
                </p>
              </div>

              <div className="rounded-2xl border border-[var(--ef-border-white-10)] bg-white/[0.03] px-4 py-3">
                <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--ef-text-soft)]">
                  Extraction Version
                </p>
                <p className="mt-2 text-sm font-semibold text-[var(--ef-text-primary)]">{extractionVersion ?? 'Pending'}</p>
                <p className="mt-1 text-[11px] leading-relaxed text-[var(--ef-text-soft)]">
                  {hasIntelligenceWorkspace && intelligenceViewModel
                    ? `${intelligenceViewModel.counts.totalFacts} normalized facts ready for review.`
                    : 'Structured facts will appear here after extraction normalizes.'}
                </p>
              </div>

              <div className="rounded-2xl border border-[var(--ef-border-white-10)] bg-white/[0.03] px-4 py-3">
                <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--ef-text-soft)]">
                  File Actions
                </p>
                <p className="mt-2 text-sm font-semibold text-[var(--ef-text-primary)]">
                  {signedUrl ? 'Ready' : fileLoading ? 'Preparing secure link' : 'Not ready'}
                </p>
                <p className="mt-1 text-[11px] leading-relaxed text-[var(--ef-text-soft)]">
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
                    className="inline-flex items-center gap-2 rounded-full border border-[var(--ef-purple-primary-a20)] bg-[var(--ef-surface-elevated)] px-3 py-1 text-[11px]"
                  >
                    <span className="text-[var(--ef-purple-accent)]">{entity.label}</span>
                    <span className="font-medium text-[var(--ef-text-primary)]">{entity.value}</span>
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
                  className="rounded-md border border-[var(--ef-border-subtle)] bg-[var(--ef-background-secondary)] px-3 py-2 text-[11px] font-medium text-[var(--ef-text-secondary)] hover:border-[var(--ef-purple-primary-a40)] hover:text-white"
                >
                  Project Documents
                </Link>
              ) : null}
              {secondaryBackHref ? (
                <Link
                  href={secondaryBackHref}
                  className="rounded-md border border-[var(--ef-border-subtle)] bg-[var(--ef-background-secondary)] px-3 py-2 text-[11px] font-medium text-[var(--ef-text-secondary)] hover:border-[var(--ef-purple-primary-a40)] hover:text-white"
                >
                  {secondaryBackLabel}
                </Link>
              ) : null}
              <Link
                href={primaryBackHref}
                className="rounded-md border border-[var(--ef-purple-primary-a30)] bg-[var(--ef-purple-primary-a10)] px-3 py-2 text-[11px] font-medium text-[var(--ef-purple-glow)] hover:bg-[var(--ef-purple-primary-a15)]"
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
                  className="rounded-md bg-[var(--ef-purple-primary)] px-3 py-2 text-[11px] font-medium text-white hover:bg-[var(--ef-purple-glow)]"
                >
                  Open File
                </a>
                <a
                  href={signedUrl}
                  download={filename}
                  rel="noopener noreferrer"
                  className="rounded-md border border-[var(--ef-border-subtle)] bg-[var(--ef-background-secondary)] px-3 py-2 text-[11px] font-medium text-[var(--ef-text-secondary)] hover:border-[var(--ef-purple-primary-a40)] hover:text-white"
                >
                  Download
                </a>
              </div>
            ) : null}

            <div className="max-w-xs rounded-2xl border border-[var(--ef-border-white-10)] bg-white/[0.03] px-4 py-3 text-[11px] text-[var(--ef-text-soft)] xl:text-right">
              <p className="font-semibold uppercase tracking-[0.18em] text-[var(--ef-text-soft)]">Operator Note</p>
              <p className="mt-2 leading-relaxed">
                {operatorNote}
              </p>
            </div>

            {managementNode}
          </div>
        </div>
      </section>

      {processingStatusNode}

      {hasIntelligenceWorkspace && intelligenceViewModel ? (
        <section className="space-y-4">
          <section className="rounded-3xl border border-[var(--ef-surface-hover)] bg-[var(--ef-background-secondary)] px-5 py-4">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-[var(--ef-purple-accent)]">
                  Extraction Workspace
                </p>
                <p className="mt-1 text-[12px] text-[var(--ef-text-soft)]">
                  Evidence is the default working surface. Use the adjacent tabs to inspect extracted output, mapped facts, and downstream impact.
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                {([
                  ['extraction', 'Extraction'],
                  ['facts', 'Facts'],
                  ['evidence', 'Evidence'],
                  ['insights', 'Insights'],
                ] as Array<[DocumentExperienceTab, string]>).map(([key, label]) => (
                  <ExperienceTabButton
                    key={key}
                    active={activeTab === key}
                    label={label}
                    onClick={() => setActiveTab(key)}
                  />
                ))}
              </div>
            </div>
          </section>

          {/* Single SpreadsheetReviewSurface instance hoisted above tab conditionals.
              CSS-hidden (display:none via HTML hidden attribute) when not on Extraction
              or Evidence tab so the DOM node stays alive and React does not tear it down
              on every tab switch. aria-hidden mirrors visibility for screen readers. */}
          {isSpreadsheetDocument && intelligenceViewModel.spreadsheetReviewDataset ? (
            <div
              hidden={activeTab !== 'extraction' && activeTab !== 'evidence'}
              aria-hidden={activeTab !== 'extraction' && activeTab !== 'evidence' ? true : undefined}
            >
              <SpreadsheetReviewSurface
                dataset={intelligenceViewModel.spreadsheetReviewDataset}
                selectedRecordId={selectedRecordId}
                navigationAction={navigationAction}
                decisionContextHref={navigationDecisionHref}
                validatorHref={navigationValidatorHref}
              />
            </div>
          ) : null}

          {activeTab === 'extraction' ? (
            <section className="space-y-4">
              <DocumentIntelligenceStrip items={intelligenceViewModel.strip} />

              {/* SpreadsheetReviewSurface for spreadsheet docs is hoisted above and
                  shown/hidden via CSS — only render non-spreadsheet content here. */}
              {isSpreadsheetDocument ? null : (
                <>
                  {intelligenceViewModel.shouldSurfaceContractPricingAssembly ? (
                    <ContractRateTablePanel
                      documentId={documentId}
                      rows={intelligenceViewModel.contractPricingAssemblyRows ?? []}
                      selectedRateRowId={selectedRateRowId}
                      navigationSource={navigationSource}
                      navigationProjectId={navigationProjectId}
                    />
                  ) : null}

                  {intelligenceViewModel.invoiceExtraction ? (
                    <InvoiceSurface extraction={intelligenceViewModel.invoiceExtraction} />
                  ) : (
                    <section className="rounded-3xl border border-[var(--ef-border-white-10)] bg-[var(--ef-background-primary)] px-5 py-5">
                      <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--ef-purple-accent)]">
                        Extracted Output
                      </p>
                      <p className="mt-2 text-[12px] leading-relaxed text-[var(--ef-text-soft)]">
                        This document&apos;s primary extracted surface is the evidence workspace and the normalized fact set below.
                      </p>
                    </section>
                  )}
                </>
              )}
            </section>
          ) : null}

          {activeTab === 'facts' ? (
            <section className="grid gap-4 xl:grid-cols-2">
              {intelligenceViewModel.groups.map((group) => (
                <section
                  key={group.key}
                  className="rounded-3xl border border-[var(--ef-border-white-10)] bg-[var(--ef-background-primary)] px-5 py-5"
                >
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--ef-purple-accent)]">
                        {group.label}
                      </p>
                      <p className="mt-1 text-[12px] text-[var(--ef-text-soft)]">
                        {group.factCount} fact{group.factCount === 1 ? '' : 's'} mapped
                      </p>
                    </div>
                    <div className="text-right text-[11px] text-[var(--ef-text-soft)]">
                      <p>{group.conflictedCount} conflicted</p>
                      <p>{group.missingCount} missing</p>
                    </div>
                  </div>

                  <div className="mt-4 space-y-2">
                    {group.facts.slice(0, 6).map((fact) => (
                      <div
                        key={fact.id}
                        className="rounded-2xl border border-[var(--ef-border-white-10)] bg-white/[0.03] px-3 py-3"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="text-[12px] font-semibold text-[var(--ef-text-primary)]">
                              {fact.fieldLabel}
                            </p>
                            <p className="mt-1 line-clamp-2 text-[11px] text-[var(--ef-text-soft)]">
                              {fact.displayValue}
                            </p>
                          </div>
                          <span className="text-[10px] uppercase tracking-[0.16em] text-[var(--ef-text-muted)]">
                            {fact.statusLabel}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              ))}
            </section>
          ) : null}

          {/* Evidence tab: SpreadsheetReviewSurface for spreadsheet docs is handled by
              the hoisted div above. Only render the non-spreadsheet workspace here. */}
          {activeTab === 'evidence' && !isSpreadsheetDocument ? (
            <section className="overflow-hidden rounded-3xl border border-[var(--ef-surface-hover)] bg-[var(--ef-background-primary)]">
              <div className="border-b border-white/8 px-5 py-4">
                <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-[var(--ef-purple-accent)]">
                  Evidence
                </p>
                <p className="mt-1 text-[12px] text-[var(--ef-text-soft)]">
                  Viewer highlights stay synced with the evidence inspector so overrides remain deliberate and traceable.
                </p>
              </div>
              <div className="min-h-[840px]">
                <DocumentIntelligenceWorkspace
                  key={`${documentId}:${navigationKey ?? 'default'}:${initialSelectedFactId ?? initialSelectedFieldKey ?? selectedRateRowId ?? 'workspace'}`}
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
                  variant="workspace"
                />
              </div>
            </section>
          ) : null}

          {activeTab === 'insights' ? (
            <section className="space-y-4">
              {showAskThisDocument ? (
                <AskDocumentSection questions={suggestedQuestions} documentId={documentId} />
              ) : null}

              {isSpreadsheetDocument ? null : (
                <DocumentImpactContext
                  decisions={decisions}
                  tasks={tasks}
                  reviewableDecisionIds={reviewableDecisionIds}
                  summary={summary}
                  unavailableMessage={unavailableMessage}
                  projectContextLabel={projectContextLabel}
                  ledgerSignals={deriveLedgerInsightSignals(intelligenceViewModel, comparisons)}
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
                    <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-[var(--ef-purple-accent)]">
                      Diagnostics
                    </p>
                    <p className="mt-1 text-[12px] text-[var(--ef-text-soft)]">
                      Raw parser payloads, OCR text, schema logs, and audit traces stay available but collapsed by default.
                    </p>
                  </div>

                  {intelligenceViewModel.diagnostics.length > 0 ? (
                    intelligenceViewModel.diagnostics.map((drawer) => (
                      <DiagnosticsDrawer key={drawer.id} drawer={drawer} />
                    ))
                  ) : (
                    <div className="rounded-2xl border border-[var(--ef-border-white-10)] bg-[var(--ef-background-primary)] px-5 py-4 text-sm text-[var(--ef-text-soft)]">
                      Diagnostics will populate when extraction outputs are available.
                    </div>
                  )}

                  {hasAuditData ? (
                    <details className="overflow-hidden rounded-2xl border border-[var(--ef-border-white-10)] bg-[var(--ef-background-primary)]">
                      <summary className="cursor-pointer list-none px-5 py-4">
                        <div className="flex flex-wrap items-center justify-between gap-3">
                          <div>
                            <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[var(--ef-purple-accent)]">
                              Audit Timeline
                            </p>
                            <p className="mt-1 text-[12px] text-[var(--ef-text-soft)]">
                              Processing milestones, decision trace notes, and pipeline execution history.
                            </p>
                          </div>
                          <span className="text-[11px] text-[var(--ef-text-soft)]">Expand</span>
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
            </section>
          ) : null}
        </section>
      ) : (
        <section className="rounded-3xl border border-[var(--ef-warning-a20)] bg-[var(--ef-warning-bg)] px-5 py-5">
          <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[var(--ef-warning-soft)]">
            Structured Facts Pending
          </p>
          <p className="mt-2 text-sm leading-relaxed text-[var(--ef-text-primary)]">
            {unavailableMessage ??
              'Normalized facts and evidence anchors are not ready yet. Reprocess the document or wait for extraction to finish.'}
          </p>
        </section>
      )}

      {isSpreadsheetDocument ? null : evaluationNode}
    </div>
  );
}
