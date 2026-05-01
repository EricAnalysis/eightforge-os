import { filterCurrentQueueRecords } from '@/lib/currentWork';
import {
  resolveDecisionPrimaryAction,
  resolveDecisionProjectContext,
  resolveDecisionReason,
} from '@/lib/decisionActions';
import { buildProjectDocumentHref } from '@/lib/documentNavigation';
import { formatDueDate } from '@/lib/dateUtils';
import type { DocumentRelationshipRecord } from '@/lib/documentPrecedence';
import {
  PROJECT_TERM_AT_RISK_AMOUNT,
  PROJECT_TERM_INVOICE_BILLED_AMOUNT,
} from '@/lib/projectTerminology';
import {
  approvalBlockerCountForProjectFacts,
  approvalStatusLabelForProjectFacts,
  blockedAmountForProjectFacts,
  deriveCanonicalProjectInvoiceFallbackSummary,
  resolveCanonicalProjectValidationSnapshot,
} from '@/lib/projectFacts';
import {
  isProjectPrimaryApprovalDecisionRow,
  resolveProjectPrimaryApprovalDecision,
} from '@/lib/validator/primaryApprovalDecision';
import { DECISION_OPEN_STATUSES, TASK_OPEN_STATUSES } from '@/lib/overdue';
import type {
  DocumentExecutionTrace,
  FlowTask,
  NormalizedDecision,
} from '@/lib/types/documentIntelligence';
import type {
  ValidationFinding,
  ValidationStatus,
  ValidationTriggerSource,
  ValidatorStatus,
} from '@/types/validator';

type Relation<T> = T | T[] | null | undefined;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export type ProjectRecord = {
  id: string;
  name: string;
  code: string | null;
  status: string | null;
  created_at: string;
  validation_status?: ValidationStatus | null;
  validation_summary_json?: unknown;
  validation_phase?: string | null;
};

export type ProjectDocumentRelation = {
  id: string;
  project_id: string | null;
  title: string | null;
  name: string;
  document_type: string | null;
};

export type ProjectAssigneeRelation = {
  id: string;
  display_name: string | null;
};

export type ProjectDocumentRow = {
  id: string;
  title: string | null;
  name: string;
  document_type: string | null;
  domain: string | null;
  processing_status: string;
  processing_error: string | null;
  created_at: string;
  processed_at: string | null;
  project_id: string | null;
  document_role?: string | null;
  document_subtype?: string | null;
  authority_status?: string | null;
  effective_date?: string | null;
  precedence_rank?: number | null;
  operator_override_precedence?: boolean | null;
  intelligence_trace?: DocumentExecutionTrace | Record<string, unknown> | null;
};

export type ProjectDocumentRelationshipRow = DocumentRelationshipRecord;

export type ProjectDecisionRow = {
  id: string;
  document_id: string | null;
  source?: string | null;
  decision_type: string;
  title: string;
  summary: string | null;
  severity: string;
  status: string;
  confidence: number | null;
  last_detected_at: string | null;
  created_at: string;
  due_at: string | null;
  assigned_to: string | null;
  details?: Record<string, unknown> | null;
  assignee?: Relation<ProjectAssigneeRelation>;
  documents?: Relation<ProjectDocumentRelation>;
};

export type ProjectTaskRow = {
  id: string;
  decision_id: string | null;
  document_id: string | null;
  task_type: string;
  title: string;
  description: string | null;
  priority: string;
  status: string;
  created_at: string;
  updated_at: string;
  due_at: string | null;
  assigned_to: string | null;
  details?: Record<string, unknown> | null;
  source_metadata?: Record<string, unknown> | null;
  assignee?: Relation<ProjectAssigneeRelation>;
  documents?: Relation<ProjectDocumentRelation>;
};

export type ProjectActivityEventRow = {
  id: string;
  project_id: string | null;
  entity_type: string;
  entity_id: string;
  event_type: string;
  old_value: Record<string, unknown> | null;
  new_value: Record<string, unknown> | null;
  changed_by: string | null;
  created_at: string;
};

export type ProjectMember = {
  id: string;
  display_name: string | null;
};

export type ProjectDocumentReviewStatus =
  | 'not_reviewed'
  | 'in_review'
  | 'approved'
  | 'needs_correction';

export type ProjectDocumentReviewRow = {
  document_id: string;
  status: ProjectDocumentReviewStatus;
  reviewed_at: string | null;
};

export type OverviewTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger' | 'muted';

export type ProjectOverviewTag = {
  label: string;
  tone: OverviewTone;
};

export type ProjectOverviewStatus = {
  key: 'blocked' | 'needs_review' | 'attention_required' | 'operationally_clear';
  label: string;
  tone: OverviewTone;
  detail: string;
  is_clear: boolean;
};

export type ProjectOverviewExposure = {
  percent: number | null;
  bar_percent: number;
  percent_label: string;
  limit_label: string;
  actual_label: string;
  detail: string;
  help_href: string | null;
  help_label: string | null;
  tone: OverviewTone;
  derived: boolean;
};

export type ProjectOverviewInvoiceItem = {
  invoice_number: string | null;
  approval_status: 'approved' | 'approved_with_exceptions' | 'needs_review' | 'blocked';
  billed_amount: number | null;
  supported_amount: number | null;
  at_risk_amount: number | null;
  requires_verification_amount: number | null;
  reconciliation_status: string;
};

export type ProjectValidatorSummarySnapshot = {
  status: ValidationStatus;
  critical_count: number;
  warning_count: number;
  requires_review_count: number;
  info_count: number;
  open_count: number;
  required_review_total: number;
  blocked_reasons: string[];
  trigger_source: ValidationTriggerSource | null;
  nte_amount: number | null;
  total_billed: number | null;
  /** Total exposure variance not yet confirmed — parsed from validation_summary_json.exposure. */
  total_at_risk: number | null;
  /** Total dollars tied to blocked or needs-review findings. */
  requires_verification_amount: number | null;
  /** Unsupported billed amount from the primary approval decision or canonical exposure truth. */
  unsupported_amount: number | null;
  /** READY / BLOCKED / NEEDS_REVIEW from persisted validation summary when present. */
  validator_readiness: ValidatorStatus | null;
  reconciliation_overall: string | null;
  /** Per-invoice approval breakdown parsed from validation_summary_json.exposure.invoices. */
  invoice_summaries: ProjectOverviewInvoiceItem[];
  /** Canonical approval blocker count resolved from validator-backed project facts. */
  approval_blocker_count: number;
  /** Sum of billed_amount for invoices with approval_status === 'blocked'. Null when no blocked invoices. */
  blocked_amount: number | null;
};

export type ProjectOverviewMetric = {
  key: string;
  label: string;
  value: string;
  supporting: string;
  tone: OverviewTone;
};

export type ProjectOverviewFact = {
  label: string;
  value: string;
};

export type ProjectOverviewDecisionCard = {
  id: string;
  href: string;
  title: string;
  status_key: string;
  status_label: string;
  status_tone: OverviewTone;
  freshness_label: string;
  reason: string;
  problem: string;
  impact: string;
  required_action: string;
  assignees: string[];
  owner_label: string;
  due_at: string | null;
  due_label: string | null;
  evidence_refs: string[];
  source_document_title: string | null;
  source_document_href: string | null;
  source_evidence_label: string;
  metadata: string[];
  primary_action: string | null;
  border_tone: OverviewTone;
};

export type ProjectOverviewActionItem = {
  id: string;
  href: string;
  title: string;
  due_label: string;
  due_tone: OverviewTone;
  assignee_label: string;
  priority_label: string;
  priority_tone: OverviewTone;
  status_label: string;
  source_document_title?: string | null;
  source_document_type?: string | null;
  /** Invoice number this action relates to — set for invoice-approval synthetic actions. */
  invoice_number?: string | null;
  /** Invoice approval state that triggered this action. */
  approval_status?: 'approved' | 'approved_with_exceptions' | 'needs_review' | 'blocked' | null;
  /** Total billed amount on the affected invoice or finding. */
  impacted_amount?: number | null;
  /** Dollars currently at risk (unreconciled / unsupported). */
  at_risk_amount?: number | null;
  /** Dollars currently tied to blocked or needs-review findings. */
  requires_verification_amount?: number | null;
  /** Dollars fully blocked from payment approval. */
  blocked_amount?: number | null;
  /** Billing group IDs associated with this action — populated when available from findings. */
  billing_group_ids?: string[] | null;
  /** Human-readable next step for the operator. */
  next_step?: string | null;
  /** Queue-ready validator finding detail: expected value. */
  expected_value?: string | null;
  /** Queue-ready validator finding detail: actual value. */
  actual_value?: string | null;
  /** Queue-ready validator finding detail: human-readable variance. */
  variance_label?: string | null;
};

export type ProjectOverviewDocumentItem = {
  id: string;
  href: string;
  title: string;
  detail: string;
  processed_label: string;
  status_label: string;
  status_tone: OverviewTone;
};

export type ProjectOverviewAuditItem = {
  id: string;
  label: string;
  detail: string;
  object_label: string | null;
  source_label: string | null;
  timestamp_at: string;
  timestamp_label: string;
  tone: OverviewTone;
  href: string | null;
  validation_run?: {
    status: ValidationStatus;
    critical_count: number;
    warning_count: number;
    new_findings_count: number;
    resolved_findings_count: number;
    rules_applied_count: number;
    rule_version: string | null;
  } | null;
};

export type ProjectOverviewModel = {
  project: ProjectRecord;
  context_label: string;
  title: string;
  project_id_label: string;
  tags: ProjectOverviewTag[];
  status: ProjectOverviewStatus;
  validator_status: ValidationStatus;
  validator_summary: ProjectValidatorSummarySnapshot;
  exposure: ProjectOverviewExposure;
  metrics: ProjectOverviewMetric[];
  facts: ProjectOverviewFact[];
  decisions: ProjectOverviewDecisionCard[];
  decision_total: number;
  decision_empty_state: string;
  actions: ProjectOverviewActionItem[];
  action_total: number;
  action_empty_state: string;
  documents: ProjectOverviewDocumentItem[];
  document_status_by_id?: ProjectOperationalRollup['document_status_by_id'];
  document_total: number;
  document_empty_state: string;
  audit: ProjectOverviewAuditItem[];
  audit_empty_state: string;
};

export type ProjectOperationalRollup = {
  status: ProjectOverviewStatus;
  linked_document_count?: number;
  processed_document_count: number;
  needs_review_document_count: number;
  open_document_action_count: number;
  unresolved_finding_count: number;
  blocked_count: number;
  anomaly_count: number;
  project_clear: boolean;
  pending_actions: ProjectOverviewActionItem[];
  document_status_by_id: Record<
    string,
    {
      label: string;
      tone: OverviewTone;
    }
  >;
};

type ProjectMatchContext = {
  id: string;
  code: string | null;
  name: string;
};

const SEVERITY_RANK: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

const DECISION_STATUS_RANK: Record<string, number> = {
  open: 0,
  in_review: 1,
  resolved: 2,
  dismissed: 3,
  suppressed: 4,
};

const TASK_PRIORITY_RANK: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

const TASK_STATUS_LABELS: Record<string, string> = {
  open: 'Open',
  in_progress: 'In Progress',
  blocked: 'Blocked',
  resolved: 'Resolved',
  completed: 'Completed',
  cancelled: 'Cancelled',
  canceled: 'Cancelled',
};

const DECISION_STATUS_LABELS: Record<string, string> = {
  open: 'Open',
  in_review: 'In Review',
  resolved: 'Finalized',
  dismissed: 'Dismissed',
  suppressed: 'Suppressed',
};

function firstRelation<T>(value: Relation<T>): T | null {
  if (!value) return null;
  return Array.isArray(value) ? value[0] ?? null : value;
}

function normalizeText(value: string | null | undefined): string {
  return (value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ');
}

function titleize(value: string | null | undefined): string {
  if (!value) return 'Unknown';
  return value
    .replace(/[_-]+/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
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

function formatCurrency(value: number | null): string {
  if (value == null || Number.isNaN(value)) return 'Awaiting data';
  const hasCents = Math.abs(value - Math.round(value)) >= 0.005;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: hasCents ? 2 : 0,
    maximumFractionDigits: hasCents ? 2 : 0,
  }).format(value);
}

function formatCompactNumber(value: number): string {
  return new Intl.NumberFormat('en-US', {
    notation: value >= 1000 ? 'compact' : 'standard',
    maximumFractionDigits: value >= 1000 ? 1 : 0,
  }).format(value);
}

export function resolveProjectValidatorSummary(
  project: ProjectRecord,
  documents: readonly ProjectDocumentRow[] = [],
  validationFindings?: readonly ValidationFinding[],
  decisions: readonly ProjectDecisionRow[] = [],
): ProjectValidatorSummarySnapshot {
  const projectPrimaryDecision = resolveProjectPrimaryApprovalDecision(decisions);
  const snapshot = resolveCanonicalProjectValidationSnapshot({
    validationStatus: project.validation_status ?? null,
    validationSummary: project.validation_summary_json,
    validationFindings,
    decisions,
  });
  const facts = snapshot.facts;
  const documentInvoiceFallback = deriveCanonicalProjectInvoiceFallbackSummary({
    documents,
  });
  const unsupportedAmount =
    facts.unsupported_amount
    ?? (
      facts.total_billed != null
      && facts.exposure?.total_fully_reconciled_amount != null
        ? Math.max(0, facts.total_billed - facts.exposure.total_fully_reconciled_amount)
        : null
    );
  const openDecisionCount = decisions.filter((decision) => DECISION_OPEN_STATUSES.includes(decision.status)).length;

  return {
    status: facts.status,
    critical_count: facts.critical_count,
    warning_count: facts.warning_count,
    requires_review_count: facts.requires_review_count,
    info_count: facts.info_count,
    open_count: facts.open_count,
    required_review_total:
      projectPrimaryDecision?.required_reviews
      ?? (facts.open_count > 0 ? facts.open_count : openDecisionCount),
    blocked_reasons: facts.blocked_reasons,
    trigger_source: facts.trigger_source,
    nte_amount: facts.nte_amount,
    total_billed: facts.total_billed ?? documentInvoiceFallback.total_billed,
    total_at_risk: facts.total_at_risk,
    requires_verification_amount: facts.requires_verification_amount,
    unsupported_amount: unsupportedAmount,
    validator_readiness: facts.validator_status,
    reconciliation_overall: facts.reconciliation_overall,
    invoice_summaries:
      snapshot.invoice_summaries.length > 0
        ? snapshot.invoice_summaries
        : documentInvoiceFallback.invoice_summaries,
    approval_blocker_count: approvalBlockerCountForProjectFacts(facts),
    blocked_amount: blockedAmountForProjectFacts(facts, snapshot.blocked_amount),
  };
}

function formatOpenApprovalFindingSummary(
  blockerCount: number,
  warningCount: number,
): string {
  if (blockerCount <= 0 && warningCount <= 0) {
    return 'No open approval findings for this project';
  }

  const parts: string[] = [];
  if (blockerCount > 0) {
    parts.push(`${blockerCount} blocker${blockerCount === 1 ? '' : 's'}`);
  }
  if (warningCount > 0) {
    parts.push(`${warningCount} warning/review finding${warningCount === 1 ? '' : 's'}`);
  }

  const totalCount = blockerCount + warningCount;
  return `${parts.join(' and ')} ${totalCount === 1 ? 'is' : 'are'} open`;
}

function resolveProjectStatus(
  project: ProjectRecord,
  rollup: ProjectOperationalRollup,
  validatorSummary: ProjectValidatorSummarySnapshot,
  openDecisionCount: number,
): ProjectOverviewStatus {
  const approvalStatus = approvalStatusLabelForProjectFacts({
    status: validatorSummary.status,
    validator_status: validatorSummary.validator_readiness,
  });
  const approvalBlockerCount = validatorSummary.approval_blocker_count;
  const requiredReviewCount = Math.max(
    validatorSummary.required_review_total,
    openDecisionCount,
  );

  if (approvalBlockerCount > 0 || approvalStatus === 'Blocked') {
    return {
      key: 'blocked',
      label: 'Blocked',
      tone: 'danger',
      detail:
        approvalBlockerCount > 0
          ? `${approvalBlockerCount} approval blocker${approvalBlockerCount === 1 ? '' : 's'} are preventing payment. Resolve mismatches or missing support to unblock.`
          : (validatorSummary.blocked_reasons[0]
            ? `Approval is blocked. ${validatorSummary.blocked_reasons[0]}`
            : 'Approval is blocked pending validator-backed review.'),
      is_clear: false,
    };
  }

  if (approvalStatus === 'Needs Review' || rollup.needs_review_document_count > 0) {
    const needsReviewCount = Math.max(
      rollup.needs_review_document_count,
      requiredReviewCount,
      1,
    );
    return {
      key: 'needs_review',
      label: 'Needs Review',
      tone: 'warning',
      detail: `${needsReviewCount} linked document${needsReviewCount === 1 ? '' : 's'} have at-risk amounts or open findings that require operator confirmation.`,
      is_clear: false,
    };
  }

  if (approvalStatus === 'Not Evaluated') {
    return {
      key: 'attention_required',
      label: 'Attention Required',
      tone: processedDocumentCountForStatus(rollup) > 0 ? 'info' : 'muted',
      detail:
        processedDocumentCountForStatus(rollup) > 0
          ? 'Approval analysis is pending — canonical project truth has not resolved readiness yet.'
          : `No processed documents are linked to ${shortProjectId(project)} yet. Upload and process to begin approval analysis.`,
      is_clear: false,
    };
  }

  if (requiredReviewCount > 0 || rollup.unresolved_finding_count > 0 || rollup.anomaly_count > 0) {
    const openDecisionCount = requiredReviewCount;
    return {
      key: 'attention_required',
      label: 'Attention Required',
      tone: 'info',
      detail: `${openDecisionCount} required review${openDecisionCount === 1 ? '' : 's'} and ${rollup.unresolved_finding_count} unresolved finding${rollup.unresolved_finding_count === 1 ? '' : 's'} are pending review — no payment blockers.`,
      is_clear: false,
    };
  }

  return {
    key: 'operationally_clear',
    label: 'Approved',
    tone: 'success',
    detail: processedDocumentCountForStatus(rollup) > 0
      ? 'Invoice claims are supported by contract and transaction data. No open approval blockers.'
      : `No processed documents are linked to ${shortProjectId(project)} yet. Upload and process to begin approval analysis.`,
    is_clear: processedDocumentCountForStatus(rollup) > 0,
  };
}

function processedDocumentCountForStatus(rollup: ProjectOperationalRollup): number {
  return rollup.processed_document_count;
}

function getFactValue(
  facts: Record<string, unknown> | undefined,
  keys: string[],
): unknown {
  for (const key of keys) {
    if (key in (facts ?? {})) return facts?.[key];
  }
  return null;
}

function shortProjectId(project: ProjectRecord): string {
  return project.code?.trim() || project.id.slice(0, 8).toUpperCase();
}

function memberName(members: ProjectMember[], id: string | null): string {
  if (!id) return 'Unassigned';
  const member = members.find((candidate) => candidate.id === id);
  return member?.display_name?.trim() || `${id.slice(0, 8)}...`;
}

function decisionDocument(decision: ProjectDecisionRow): ProjectDocumentRelation | null {
  return firstRelation(decision.documents);
}

function taskDocument(task: ProjectTaskRow): ProjectDocumentRelation | null {
  return firstRelation(task.documents);
}

function parseProjectContext(
  value: Record<string, unknown> | null | undefined,
): { label: string; project_id: string | null; project_code: string | null } | null {
  const raw = value?.project_context;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const context = raw as Record<string, unknown>;
  const label = typeof context.label === 'string' ? context.label.trim() : '';
  if (!label) return null;
  return {
    label,
    project_id: typeof context.project_id === 'string' ? context.project_id : null,
    project_code: typeof context.project_code === 'string' ? context.project_code : null,
  };
}

function contextMatchesProject(
  context: { label: string; project_id: string | null; project_code: string | null } | null,
  project: ProjectMatchContext,
): boolean {
  if (!context) return false;
  if (context.project_id && context.project_id === project.id) return true;
  if (context.project_code && project.code && normalizeText(context.project_code) === normalizeText(project.code)) {
    return true;
  }
  return normalizeText(context.label) === normalizeText(project.name);
}

export function parseDocumentExecutionTrace(
  trace: DocumentExecutionTrace | Record<string, unknown> | null | undefined,
): DocumentExecutionTrace | null {
  if (!trace || typeof trace !== 'object') return null;
  const candidate = trace as Partial<DocumentExecutionTrace>;
  if (!candidate.facts || typeof candidate.facts !== 'object') return null;
  if (!Array.isArray(candidate.decisions) || !Array.isArray(candidate.flow_tasks)) return null;
  return {
    extraction_snapshot_id:
      typeof candidate.extraction_snapshot_id === 'string'
        ? candidate.extraction_snapshot_id
        : undefined,
    facts: candidate.facts as Record<string, unknown>,
    decisions: candidate.decisions,
    flow_tasks: candidate.flow_tasks,
    generated_at: typeof candidate.generated_at === 'string' ? candidate.generated_at : '',
    engine_version: typeof candidate.engine_version === 'string' ? candidate.engine_version : '',
  };
}

export function dedupeById<T extends { id: string }>(rows: T[]): T[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    if (seen.has(row.id)) return false;
    seen.add(row.id);
    return true;
  });
}

export function matchesProjectDecision(
  decision: ProjectDecisionRow,
  project: ProjectRecord,
): boolean {
  const document = decisionDocument(decision);
  if (document?.project_id && document.project_id === project.id) return true;
  const embeddedContext = resolveDecisionProjectContext(decision.details ?? null);
  return contextMatchesProject(
    embeddedContext
      ? {
          label: embeddedContext.label,
          project_id: embeddedContext.project_id ?? null,
          project_code: embeddedContext.project_code ?? null,
        }
      : null,
    { id: project.id, code: project.code, name: project.name },
  );
}

export function matchesProjectTask(
  task: ProjectTaskRow,
  project: ProjectRecord,
  projectDecisionIds: Set<string>,
): boolean {
  const document = taskDocument(task);
  if (document?.project_id && document.project_id === project.id) return true;
  if (task.decision_id && projectDecisionIds.has(task.decision_id)) return true;
  const detailsContext = parseProjectContext(task.details ?? null);
  if (contextMatchesProject(detailsContext, { id: project.id, code: project.code, name: project.name })) {
    return true;
  }
  const sourceContext = parseProjectContext(task.source_metadata ?? null);
  return contextMatchesProject(sourceContext, { id: project.id, code: project.code, name: project.name });
}

function resolveProjectTags(
  project: ProjectRecord,
  documents: ProjectDocumentRow[],
): ProjectOverviewTag[] {
  const tags: ProjectOverviewTag[] = [];
  const domainCounts = new Map<string, number>();
  let hasFema = false;

  for (const document of documents) {
    if (document.domain) {
      const key = document.domain.trim().toLowerCase();
      domainCounts.set(key, (domainCounts.get(key) ?? 0) + 1);
    }
    const trace = parseDocumentExecutionTrace(document.intelligence_trace ?? null);
    const femaValue = getFactValue(trace?.facts, ['fema_disaster', 'femaCompliant']);
    if (
      femaValue === true ||
      (typeof femaValue === 'string' && femaValue.trim().length > 0)
    ) {
      hasFema = true;
    }
  }

  const orderedDomains = [...domainCounts.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 2)
    .map(([domain]) => ({
      label: titleize(domain).toUpperCase(),
      tone: 'neutral' as const,
    }));
  tags.push(...orderedDomains);

  const hasTicketOps = documents.some((document) =>
    ['ticket', 'debris_ticket', 'daily_ops', 'ops_report'].includes(document.document_type ?? ''),
  );
  if (hasTicketOps) {
    tags.push({ label: 'OPS', tone: 'info' });
  }

  if (hasFema) {
    tags.push({ label: 'FEMA', tone: 'warning' });
  }

  if (tags.length === 0 && project.code) {
    tags.push({ label: project.code.toUpperCase(), tone: 'neutral' });
  }

  return tags.slice(0, 3);
}

type ProjectActionDraft = ProjectOverviewActionItem & {
  sort_status_rank: number;
  /**
   * Financial importance tier within a status bucket.
   * 0 = blocked invoice (highest — payment fully stopped)
   * 1 = needs-review invoice (second — payment at risk)
   * 9 = standard finding / task (no financial tier)
   */
  sort_financial_rank: number;
  sort_priority_rank: number;
  sort_due_rank: number;
  sort_timestamp: number;
};

function isProcessedDocument(document: ProjectDocumentRow): boolean {
  return (
    document.processed_at != null ||
    ['extracted', 'decisioned', 'failed'].includes(document.processing_status)
  );
}

function documentTitle(
  document: Pick<ProjectDocumentRow, 'title' | 'name'> | Pick<ProjectDocumentRelation, 'title' | 'name'> | null,
): string {
  return document?.title?.trim() || document?.name || 'Untitled document';
}

function documentTypeLabel(documentType: string | null | undefined): string | null {
  return typeof documentType === 'string' && documentType.trim().length > 0
    ? titleize(documentType)
    : null;
}

function addGroupedValue<T>(map: Map<string, T[]>, key: string | null, value: T) {
  if (!key) return;
  const current = map.get(key) ?? [];
  current.push(value);
  map.set(key, current);
}

function resolveDecisionSourceDocumentId(decision: ProjectDecisionRow): string | null {
  return decision.document_id ?? decisionDocument(decision)?.id ?? null;
}

function resolveTaskSourceDocumentId(
  task: ProjectTaskRow,
  decisionById: Map<string, ProjectDecisionRow>,
): string | null {
  if (task.document_id) return task.document_id;
  const linkedDocument = taskDocument(task);
  if (linkedDocument?.id) return linkedDocument.id;
  if (!task.decision_id) return null;
  const linkedDecision = decisionById.get(task.decision_id) ?? null;
  return linkedDecision ? resolveDecisionSourceDocumentId(linkedDecision) : null;
}

function decisionFamilyFromPersisted(decision: ProjectDecisionRow): string | null {
  const family = decision.details?.family;
  return typeof family === 'string' ? family : null;
}

function hasMissingSourceContext(
  value: unknown,
): boolean {
  return Array.isArray(value) && value.some((entry) => typeof entry === 'string' && entry.trim().length > 0);
}

export function isBlockedPersistedDecision(decision: ProjectDecisionRow): boolean {
  const family = decisionFamilyFromPersisted(decision);
  if (family === 'mismatch') return true;
  return decision.severity === 'critical';
}

const FORGE_QUEUE_OPEN_DECISION_STATUSES = new Set([
  'open',
  'in_review',
  'needs_review',
  'flagged',
  'draft',
]);

/** Count of open decisions in Forge queue scope that block approval (critical / mismatch). */
export function countForgeQueueBlockedDecisions(decisions: ProjectDecisionRow[]): number {
  return decisions.filter(
    (d) => FORGE_QUEUE_OPEN_DECISION_STATUSES.has(d.status) && isBlockedPersistedDecision(d),
  ).length;
}

function isMissingSupportPersistedDecision(decision: ProjectDecisionRow): boolean {
  const family = decisionFamilyFromPersisted(decision);
  return family === 'missing' || hasMissingSourceContext(decision.details?.missing_source_context);
}

function isBlockedTraceDecision(decision: NormalizedDecision): boolean {
  return decision.family === 'mismatch';
}

function isMissingSupportTraceDecision(decision: NormalizedDecision): boolean {
  return decision.family === 'missing' || hasMissingSourceContext(decision.missing_source_context);
}

function traceTaskPriorityRank(task: FlowTask): number {
  if (task.priority === 'high') return 0;
  if (task.priority === 'medium') return 1;
  return 2;
}

function traceTaskPriorityTone(task: FlowTask): OverviewTone {
  if (task.priority === 'high') return 'warning';
  if (task.priority === 'medium') return 'info';
  return 'muted';
}

function decisionPriorityToneFromSeverity(severity: string): OverviewTone {
  if (severity === 'critical') return 'danger';
  if (severity === 'high' || severity === 'medium') return 'warning';
  return 'info';
}

function traceDecisionPriorityTone(decision: NormalizedDecision): OverviewTone {
  if (decision.family === 'mismatch') return 'danger';
  if (decision.severity === 'critical') return 'danger';
  if (decision.severity === 'warning') return 'warning';
  return 'info';
}

function persistedDecisionActionTitle(decision: ProjectDecisionRow): string {
  return (resolveDecisionPrimaryAction(decision.details ?? null)?.description ??
    decision.title) ||
    titleize(decision.decision_type);
}

function traceDecisionActionTitle(decision: NormalizedDecision): string {
  return decision.primary_action?.description ??
    decision.suggested_actions?.[0]?.description ??
    decision.title;
}

function finalizePendingActions(actions: ProjectActionDraft[]): ProjectOverviewActionItem[] {
  return [...actions]
    .sort((left, right) => {
      if (left.sort_status_rank !== right.sort_status_rank) {
        return left.sort_status_rank - right.sort_status_rank;
      }
      // Financial tier: blocked invoice (0) → needs-review invoice (1) → standard (9)
      if (left.sort_financial_rank !== right.sort_financial_rank) {
        return left.sort_financial_rank - right.sort_financial_rank;
      }
      if (left.sort_priority_rank !== right.sort_priority_rank) {
        return left.sort_priority_rank - right.sort_priority_rank;
      }
      if (left.sort_due_rank !== right.sort_due_rank) {
        return left.sort_due_rank - right.sort_due_rank;
      }
      // sort_timestamp is used as a descending dollar-amount key for invoice actions
      if (left.sort_timestamp !== right.sort_timestamp) {
        return right.sort_timestamp - left.sort_timestamp;
      }
      return left.title.localeCompare(right.title);
    })
    .map((action) => ({
      id: action.id,
      href: action.href,
      title: action.title,
      due_label: action.due_label,
      due_tone: action.due_tone,
      assignee_label: action.assignee_label,
      priority_label: action.priority_label,
      priority_tone: action.priority_tone,
      status_label: action.status_label,
      source_document_title: action.source_document_title,
      source_document_type: action.source_document_type,
      ...(action.invoice_number != null ? { invoice_number: action.invoice_number } : {}),
      ...(action.approval_status != null ? { approval_status: action.approval_status } : {}),
      ...(action.impacted_amount != null ? { impacted_amount: action.impacted_amount } : {}),
      ...(action.at_risk_amount != null ? { at_risk_amount: action.at_risk_amount } : {}),
      ...(action.requires_verification_amount != null
        ? { requires_verification_amount: action.requires_verification_amount }
        : {}),
      ...(action.blocked_amount != null ? { blocked_amount: action.blocked_amount } : {}),
      ...(action.billing_group_ids != null ? { billing_group_ids: action.billing_group_ids } : {}),
      ...(action.next_step != null ? { next_step: action.next_step } : {}),
      ...(action.expected_value != null ? { expected_value: action.expected_value } : {}),
      ...(action.actual_value != null ? { actual_value: action.actual_value } : {}),
      ...(action.variance_label != null ? { variance_label: action.variance_label } : {}),
    }));
}

export function buildProjectOperationalRollup(params: {
  project: ProjectRecord;
  documents: ProjectDocumentRow[];
  decisions: ProjectDecisionRow[];
  tasks: ProjectTaskRow[];
  documentReviews?: ProjectDocumentReviewRow[];
  members?: ProjectMember[];
}): ProjectOperationalRollup {
  const {
    project,
    documents,
    decisions,
    tasks,
    documentReviews = [],
    members = [],
  } = params;

  const processedDocuments = documents.filter(isProcessedDocument);
  const reviewStatusByDocumentId = new Map(
    documentReviews.map((review) => [review.document_id, review.status] as const),
  );
  const currentDecisions = filterCurrentQueueRecords(decisions);
  const currentTasks = filterCurrentQueueRecords(tasks);
  const openDecisions = currentDecisions.filter((decision) =>
    DECISION_OPEN_STATUSES.includes(decision.status),
  );
  const openTasks = currentTasks.filter((task) =>
    TASK_OPEN_STATUSES.includes(task.status),
  );
  const decisionById = new Map(currentDecisions.map((decision) => [decision.id, decision]));
  const currentDecisionIds = new Set(currentDecisions.map((decision) => decision.id));
  const currentTaskIds = new Set(currentTasks.map((task) => task.id));
  const openDecisionsByDocumentId = new Map<string, ProjectDecisionRow[]>();
  const openTasksByDocumentId = new Map<string, ProjectTaskRow[]>();
  const projectLevelOpenDecisions: ProjectDecisionRow[] = [];
  const projectLevelOpenTasks: ProjectTaskRow[] = [];

  for (const decision of openDecisions) {
    const documentId = resolveDecisionSourceDocumentId(decision);
    if (documentId) {
      addGroupedValue(openDecisionsByDocumentId, documentId, decision);
    } else {
      projectLevelOpenDecisions.push(decision);
    }
  }

  for (const task of openTasks) {
    const documentId = resolveTaskSourceDocumentId(task, decisionById);
    if (documentId) {
      addGroupedValue(openTasksByDocumentId, documentId, task);
    } else {
      projectLevelOpenTasks.push(task);
    }
  }

  let needsReviewDocumentCount = 0;
  let unresolvedFindingCount = 0;
  let blockedCount = 0;
  const anomalyCount = documents.filter((document) => document.processing_status === 'failed').length;
  const pendingActionDrafts: ProjectActionDraft[] = [];
  const documentStatusById: ProjectOperationalRollup['document_status_by_id'] = {};

  for (const document of processedDocuments) {
    const trace = parseDocumentExecutionTrace(document.intelligence_trace ?? null);
    const persistedDocumentDecisions = openDecisionsByDocumentId.get(document.id) ?? [];
    const persistedDocumentTasks = openTasksByDocumentId.get(document.id) ?? [];
    const persistedTaskDecisionIds = new Set(
      persistedDocumentTasks
        .map((task) => task.decision_id)
        .filter((decisionId): decisionId is string => Boolean(decisionId)),
    );
    const traceDecisions = (trace?.decisions ?? []).filter((decision) =>
      decision.family !== 'confirmed' && !currentDecisionIds.has(decision.id),
    );
    const traceTasks = (trace?.flow_tasks ?? []).filter((task) =>
      !currentTaskIds.has(task.id),
    );
    const traceTaskDecisionIds = new Set(
      traceTasks.flatMap((task) => task.source_decision_ids ?? []),
    );
    const blockedPersistedDecisionIds = new Set(
      persistedDocumentDecisions
        .filter(isBlockedPersistedDecision)
        .map((decision) => decision.id),
    );
    const blockedTraceDecisionIds = new Set(
      traceDecisions
        .filter(isBlockedTraceDecision)
        .map((decision) => decision.id),
    );
    const documentHref = buildProjectDocumentHref(document.id, project.id);
    const documentTitleLabel = documentTitle(document);
    const documentType = documentTypeLabel(document.document_type);

    let documentPendingActionCount = 0;

    for (const task of persistedDocumentTasks) {
      const assignee = firstRelation(task.assignee);
      const dueTone = taskDueTone(task);
      const dueLabel =
        !task.due_at
          ? 'No due date'
          : dueTone === 'danger'
            ? `Overdue since ${formatDueDate(task.due_at)}`
            : `Due ${formatDueDate(task.due_at)}`;

      pendingActionDrafts.push({
        id: task.id,
        href: documentHref,
        title: task.title,
        due_label: dueLabel,
        due_tone: dueTone,
        assignee_label: assignee?.display_name?.trim() || memberName(members, task.assigned_to),
        priority_label: titleize(task.priority),
        priority_tone: taskPriorityTone(task.priority),
        status_label: TASK_STATUS_LABELS[task.status] ?? titleize(task.status),
        source_document_title: documentTitleLabel,
        source_document_type: documentType,
        sort_status_rank: task.status === 'blocked' ? 0 : 1,
        sort_financial_rank: 9,
        sort_priority_rank: TASK_PRIORITY_RANK[task.priority] ?? 9,
        sort_due_rank: task.due_at ? new Date(task.due_at).getTime() : Number.MAX_SAFE_INTEGER,
        sort_timestamp: new Date(task.created_at).getTime(),
      });
      documentPendingActionCount += 1;
    }

    for (const task of traceTasks) {
      const blockedFromSource = task.source_decision_ids.some((decisionId) =>
        blockedPersistedDecisionIds.has(decisionId) || blockedTraceDecisionIds.has(decisionId),
      );

      pendingActionDrafts.push({
        id: `trace-task:${document.id}:${task.id}`,
        href: documentHref,
        title: task.title,
        due_label: blockedFromSource ? 'Approval blocker' : 'Source document action',
        due_tone: blockedFromSource ? 'danger' : traceTaskPriorityTone(task),
        assignee_label: task.suggested_owner?.trim()
          ? `Suggested owner: ${task.suggested_owner}`
          : 'Pending document follow-up',
        priority_label: titleize(task.priority),
        priority_tone: traceTaskPriorityTone(task),
        status_label: blockedFromSource ? 'Blocked' : 'Open',
        source_document_title: documentTitleLabel,
        source_document_type: documentType,
        sort_status_rank: blockedFromSource ? 0 : 1,
        sort_financial_rank: 9,
        sort_priority_rank: traceTaskPriorityRank(task),
        sort_due_rank: Number.MAX_SAFE_INTEGER,
        sort_timestamp: new Date(document.processed_at ?? document.created_at).getTime(),
      });
      documentPendingActionCount += 1;
    }

    for (const decision of persistedDocumentDecisions) {
      if (persistedTaskDecisionIds.has(decision.id)) continue;

      const assignee = firstRelation(decision.assignee);
      const blockedDecision = isBlockedPersistedDecision(decision);

      pendingActionDrafts.push({
        id: `decision-action:${decision.id}`,
        href: documentHref,
        title: persistedDecisionActionTitle(decision),
        due_label: blockedDecision ? 'Approval blocker' : 'Decision follow-up',
        due_tone: blockedDecision ? 'danger' : 'warning',
        assignee_label: assignee?.display_name?.trim() || memberName(members, decision.assigned_to),
        priority_label: titleize(decision.severity),
        priority_tone: decisionPriorityToneFromSeverity(decision.severity),
        status_label: blockedDecision
          ? 'Blocked'
          : DECISION_STATUS_LABELS[decision.status] ?? titleize(decision.status),
        source_document_title: documentTitleLabel,
        source_document_type: documentType,
        sort_status_rank: blockedDecision ? 0 : 1,
        sort_financial_rank: 9,
        sort_priority_rank: SEVERITY_RANK[decision.severity] ?? 9,
        sort_due_rank: decision.due_at ? new Date(decision.due_at).getTime() : Number.MAX_SAFE_INTEGER,
        sort_timestamp: new Date(decision.last_detected_at ?? decision.created_at).getTime(),
      });
      documentPendingActionCount += 1;
    }

    for (const decision of traceDecisions) {
      if (traceTaskDecisionIds.has(decision.id)) continue;

      const blockedDecision = isBlockedTraceDecision(decision);

      pendingActionDrafts.push({
        id: `trace-decision:${document.id}:${decision.id}`,
        href: documentHref,
        title: traceDecisionActionTitle(decision),
        due_label: blockedDecision ? 'Approval blocker' : 'Source document follow-up',
        due_tone: blockedDecision ? 'danger' : 'warning',
        assignee_label: decision.primary_action?.target_label
          ? `Context: ${decision.primary_action.target_label}`
          : 'Pending document review',
        priority_label: titleize(decision.severity),
        priority_tone: traceDecisionPriorityTone(decision),
        status_label: blockedDecision ? 'Blocked' : 'Needs review',
        source_document_title: documentTitleLabel,
        source_document_type: documentType,
        sort_status_rank: blockedDecision ? 0 : 1,
        sort_financial_rank: 9,
        sort_priority_rank: decision.severity === 'critical' ? 0 : decision.severity === 'warning' ? 1 : 2,
        sort_due_rank: Number.MAX_SAFE_INTEGER,
        sort_timestamp: new Date(document.processed_at ?? document.created_at).getTime(),
      });
      documentPendingActionCount += 1;
    }

    const documentBlockedCount =
      persistedDocumentTasks.filter((task) => task.status === 'blocked').length +
      persistedDocumentDecisions.filter(isBlockedPersistedDecision).length +
      traceDecisions.filter(isBlockedTraceDecision).length;
    const documentUnresolvedFindingCount = persistedDocumentDecisions.length + traceDecisions.length;
    const documentMissingSupportCount =
      persistedDocumentDecisions.filter(isMissingSupportPersistedDecision).length +
      traceDecisions.filter(isMissingSupportTraceDecision).length;
    const reviewStatus = reviewStatusByDocumentId.get(document.id) ?? 'not_reviewed';
    const documentNeedsReview =
      reviewStatus !== 'approved' &&
      (
        reviewStatus === 'needs_correction' ||
        reviewStatus === 'in_review' ||
        documentBlockedCount > 0 ||
        documentMissingSupportCount > 0 ||
        documentUnresolvedFindingCount > 0 ||
        documentPendingActionCount > 0
      );

    unresolvedFindingCount += documentUnresolvedFindingCount;
    blockedCount += documentBlockedCount;

    if (document.processing_status === 'failed') {
      documentStatusById[document.id] = { label: 'Failed', tone: 'danger' };
      continue;
    }

    if (documentBlockedCount > 0) {
      documentStatusById[document.id] = { label: 'Blocked', tone: 'danger' };
      continue;
    }

    if (documentNeedsReview) {
      needsReviewDocumentCount += 1;
      documentStatusById[document.id] = { label: 'Needs review', tone: 'warning' };
      continue;
    }

    if (documentPendingActionCount > 0 || documentUnresolvedFindingCount > 0) {
      documentStatusById[document.id] = { label: 'Attention required', tone: 'info' };
      continue;
    }

    documentStatusById[document.id] = { label: 'Operationally clear', tone: 'success' };
  }

  const decisionIdsWithOpenTasks = new Set(
    projectLevelOpenTasks
      .map((task) => task.decision_id)
      .filter((decisionId): decisionId is string => Boolean(decisionId)),
  );

  for (const task of projectLevelOpenTasks) {
    const assignee = firstRelation(task.assignee);
    const dueTone = taskDueTone(task);
    const dueLabel =
      !task.due_at
        ? 'No due date'
        : dueTone === 'danger'
          ? `Overdue since ${formatDueDate(task.due_at)}`
          : `Due ${formatDueDate(task.due_at)}`;

    pendingActionDrafts.push({
      id: task.id,
      href: task.decision_id ? `/platform/decisions/${task.decision_id}` : `/platform/decisions`,
      title: task.title,
      due_label: dueLabel,
      due_tone: dueTone,
      assignee_label: assignee?.display_name?.trim() || memberName(members, task.assigned_to),
      priority_label: titleize(task.priority),
      priority_tone: taskPriorityTone(task.priority),
      status_label: TASK_STATUS_LABELS[task.status] ?? titleize(task.status),
      source_document_title: 'Project record',
      source_document_type: null,
      sort_status_rank: task.status === 'blocked' ? 0 : 1,
      sort_financial_rank: 9,
      sort_priority_rank: TASK_PRIORITY_RANK[task.priority] ?? 9,
      sort_due_rank: task.due_at ? new Date(task.due_at).getTime() : Number.MAX_SAFE_INTEGER,
      sort_timestamp: new Date(task.created_at).getTime(),
    });
  }

  for (const decision of projectLevelOpenDecisions) {
    if (decisionIdsWithOpenTasks.has(decision.id)) continue;

    const assignee = firstRelation(decision.assignee);
    const blockedDecision = isBlockedPersistedDecision(decision);

    pendingActionDrafts.push({
      id: `decision-action:${decision.id}`,
      href: `/platform/decisions/${decision.id}`,
      title: persistedDecisionActionTitle(decision),
      due_label: blockedDecision ? 'Blocked finding' : 'Decision follow-up',
      due_tone: blockedDecision ? 'danger' : 'warning',
      assignee_label: assignee?.display_name?.trim() || memberName(members, decision.assigned_to),
      priority_label: titleize(decision.severity),
      priority_tone: decisionPriorityToneFromSeverity(decision.severity),
      status_label: blockedDecision
        ? 'Blocked'
        : DECISION_STATUS_LABELS[decision.status] ?? titleize(decision.status),
      source_document_title: 'Project record',
      source_document_type: null,
      sort_status_rank: blockedDecision ? 0 : 1,
      sort_financial_rank: 9,
      sort_priority_rank: SEVERITY_RANK[decision.severity] ?? 9,
      sort_due_rank: decision.due_at ? new Date(decision.due_at).getTime() : Number.MAX_SAFE_INTEGER,
      sort_timestamp: new Date(decision.last_detected_at ?? decision.created_at).getTime(),
    });
  }

  unresolvedFindingCount += projectLevelOpenDecisions.length;
  blockedCount +=
    projectLevelOpenTasks.filter((task) => task.status === 'blocked').length +
    projectLevelOpenDecisions.filter(isBlockedPersistedDecision).length;

  const pendingActions = finalizePendingActions(pendingActionDrafts);
  const openDocumentActionCount = pendingActions.length;

  let status: ProjectOverviewStatus;
  if (blockedCount > 0) {
    status = {
      key: 'blocked',
      label: 'Blocked',
      tone: 'danger',
      detail: `${blockedCount} approval blocker${blockedCount === 1 ? '' : 's'} are preventing payment. Resolve mismatches or missing support to unblock.`,
      is_clear: false,
    };
  } else if (needsReviewDocumentCount > 0) {
    status = {
      key: 'needs_review',
      label: 'Needs Review',
      tone: 'warning',
      detail: `${needsReviewDocumentCount} linked document${needsReviewDocumentCount === 1 ? '' : 's'} have at-risk amounts or open findings that require operator confirmation.`,
      is_clear: false,
    };
  } else if (openDocumentActionCount > 0 || unresolvedFindingCount > 0 || anomalyCount > 0) {
    status = {
      key: 'attention_required',
      label: 'Attention Required',
      tone: 'info',
      detail: `${openDocumentActionCount} required review item${openDocumentActionCount === 1 ? '' : 's'} and ${unresolvedFindingCount} unresolved finding${unresolvedFindingCount === 1 ? '' : 's'} are pending review — no payment blockers.`,
      is_clear: false,
    };
  } else {
    status = {
      key: 'operationally_clear',
      label: 'Approved',
      tone: 'success',
      detail: processedDocuments.length > 0
        ? 'Invoice claims are supported by contract and transaction data. No open approval blockers.'
        : `No processed documents are linked to ${shortProjectId(project)} yet. Upload and process to begin approval analysis.`,
      is_clear: true,
    };
  }

  return {
    status,
    linked_document_count: documents.length,
    processed_document_count: processedDocuments.length,
    needs_review_document_count: needsReviewDocumentCount,
    open_document_action_count: openDocumentActionCount,
    unresolved_finding_count: unresolvedFindingCount,
    blocked_count: blockedCount,
    anomaly_count: anomalyCount,
    project_clear: status.is_clear,
    pending_actions: pendingActions,
    document_status_by_id: documentStatusById,
  };
}

export function resolveProjectExposure(
  project: ProjectRecord,
  documents: ProjectDocumentRow[],
  validatorSummary: ProjectValidatorSummarySnapshot,
): ProjectOverviewExposure {
  const limitAmount = validatorSummary.nte_amount;
  const actualAmount = validatorSummary.total_billed;
  const hasCeiling =
    limitAmount != null && Number.isFinite(limitAmount) && limitAmount > 0;
  const hasActual = actualAmount != null && Number.isFinite(actualAmount);
  const percent = hasCeiling && hasActual
    ? Number(((actualAmount / limitAmount) * 100).toFixed(0))
    : null;

  if (percent == null) {
    if (hasActual) {
      const approvalLabel = validatorSummary.validator_readiness === 'READY'
        ? 'Approved'
        : validatorSummary.validator_readiness === 'BLOCKED'
          ? 'Blocked'
          : validatorSummary.validator_readiness === 'NEEDS_REVIEW'
            ? 'Needs Review'
            : null;
      const detailParts = [
        'Invoice billed amount comes from canonical invoice truth.',
        validatorSummary.reconciliation_overall
          ? `Reconciliation: ${validatorSummary.reconciliation_overall}.`
          : null,
        approvalLabel ? `Approval status: ${approvalLabel}.` : null,
        'Link contract NTE to show NTE utilization.',
      ].filter(Boolean);

      return {
        percent: null,
        bar_percent: 0,
        percent_label: '--',
        limit_label: 'LIMIT: NTE not linked',
        actual_label: `ACTUAL: ${formatCurrency(actualAmount)}`,
        detail: detailParts.join(' '),
        help_href: '#project-validator',
        help_label: 'Review approval analysis',
        tone: 'info',
        derived: true,
      };
    }

    return {
      percent: null,
      bar_percent: 0,
      percent_label: '--',
      limit_label: 'LIMIT: No contract NTE',
      actual_label: 'ACTUAL: No invoice data',
      detail:
        documents.length > 0
          ? `Approval analysis is pending — no invoice or NTE data is available yet for ${shortProjectId(project)}.`
          : 'Upload and process an invoice and contract to begin approval analysis.',
      help_href: '#project-validator',
      help_label: 'Review approval analysis',
      tone: 'muted',
      derived: true,
    };
  }

  const tone: OverviewTone =
    percent >= 90 ? 'danger' :
    percent >= 70 ? 'warning' :
    'info';

  const reconNote = validatorSummary.reconciliation_overall
    ? ` Reconciliation: ${validatorSummary.reconciliation_overall}.`
    : '';
  const approvalNote = validatorSummary.validator_readiness
    ? ` Approval: ${validatorSummary.validator_readiness === 'READY' ? 'Approved' : validatorSummary.validator_readiness === 'BLOCKED' ? 'Blocked' : 'Needs Review'}.`
    : '';

  return {
    percent,
    bar_percent: clamp(percent, 0, 100),
    percent_label: `${percent}%`,
    limit_label: `LIMIT: ${formatCurrency(limitAmount)}`,
    actual_label: `ACTUAL: ${formatCurrency(actualAmount)}`,
    detail: `NTE utilization from canonical invoice truth.${reconNote}${approvalNote}`.trim(),
    help_href: null,
    help_label: null,
    tone,
    derived: true,
  };
}

function resolveProjectMetrics(
  project: ProjectRecord,
  rollup: ProjectOperationalRollup,
  validatorSummary: ProjectValidatorSummarySnapshot,
): ProjectOverviewMetric[] {
  const blockerCount = validatorSummary.approval_blocker_count;
  const warningCount = validatorSummary.warning_count + validatorSummary.requires_review_count;
  const anomalyCount = blockerCount + warningCount;
  const anomalyTone: OverviewTone =
    blockerCount > 0
      ? 'danger'
      : anomalyCount > 0
        ? 'warning'
        : 'success';
  const hasExposureData = validatorSummary.total_billed != null;

  if (hasExposureData) {
    const atRisk = validatorSummary.total_at_risk;
    const blockedAmount = validatorSummary.blocked_amount;
    const requiresVerification = validatorSummary.requires_verification_amount;
    const requiresVerificationCount = blockerCount + warningCount;
    const requiredReviewCount = validatorSummary.required_review_total;
    const atRiskTone: OverviewTone =
      atRisk != null && atRisk > 0 ? 'warning' : 'success';
    const readiness = validatorSummary.validator_readiness;
    const readinessTone: OverviewTone =
      readiness === 'BLOCKED' ? 'danger' : readiness === 'NEEDS_REVIEW' ? 'warning' : 'success';

    const approvalLabel =
      readiness === 'READY' ? 'Approved'
      : readiness === 'BLOCKED' ? 'Blocked'
      : readiness === 'NEEDS_REVIEW' ? 'Needs Review'
      : 'Not Evaluated';

    return [
      {
        key: 'total-billed',
        label: PROJECT_TERM_INVOICE_BILLED_AMOUNT,
        value: formatCurrency(validatorSummary.total_billed),
        supporting: 'Invoice billed total from canonical invoice truth across all linked claims',
        tone: 'neutral',
      },
      {
        key: 'blocked-amount',
        label: 'Blocked Amount',
        value: formatCurrency(blockedAmount ?? 0),
        supporting:
          (blockedAmount ?? 0) > 0
            ? 'Validator-backed approval blockers are currently stopping these billed dollars'
            : 'No billed dollars are currently blocked from approval',
        tone: (blockedAmount ?? 0) > 0 ? 'danger' : 'success',
      },
      {
        key: 'at-risk',
        label: PROJECT_TERM_AT_RISK_AMOUNT,
        value: atRisk != null ? formatCurrency(atRisk) : '—',
        supporting: atRisk != null && atRisk > 0
          ? 'Exposure variance is still awaiting confirmation'
          : 'No at-risk variance is currently open',
        tone: atRiskTone,
      },
      {
        key: 'requires-verification',
        label: 'Requires Verification',
        value:
          requiresVerification != null
            ? formatCurrency(requiresVerification)
            : requiresVerificationCount > 0
              ? `${formatCompactNumber(requiresVerificationCount)} finding${requiresVerificationCount === 1 ? '' : 's'}`
              : '—',
        supporting:
          requiresVerification != null && requiresVerification > 0
            ? 'Blocked or needs-review findings are carrying approval-gated dollars'
            : requiresVerificationCount > 0
              ? 'Approval findings are still open even though validator dollars are not yet quantified'
              : 'No approval-gated verification dollars are currently open',
        tone:
          requiresVerification != null && requiresVerification > 0
            ? 'danger'
            : requiresVerificationCount > 0
              ? 'warning'
              : 'success',
      },
      {
        key: 'required-reviews',
        label: 'Required Reviews',
        value: formatCompactNumber(requiredReviewCount),
        supporting: requiredReviewCount > 0
          ? `${requiredReviewCount} validator-backed review${requiredReviewCount === 1 ? '' : 's'} are unresolved and ready for operator action`
          : 'No validator-backed reviews are currently open',
        tone: requiredReviewCount > 0 ? 'warning' : 'muted',
      },
      {
        key: 'approval-status',
        label: 'Approval Status',
        value: approvalLabel,
        supporting: formatOpenApprovalFindingSummary(blockerCount, warningCount),
        tone: readinessTone,
      },
    ];
  }

  return [
    {
      key: 'processed-docs',
      label: 'Processed Docs',
      value: formatCompactNumber(rollup.processed_document_count),
      supporting: rollup.processed_document_count === 0
        ? `No processed documents are contributing to ${shortProjectId(project)} yet — upload to begin`
        : `${rollup.processed_document_count} linked document${rollup.processed_document_count === 1 ? '' : 's'} are contributing to the approval record`,
      tone: rollup.processed_document_count > 0 ? 'neutral' : 'muted',
    },
    {
      key: 'needs-review',
      label: 'Needs Review',
      value: formatCompactNumber(rollup.needs_review_document_count),
      supporting: rollup.needs_review_document_count === 0
        ? 'No documents have at-risk amounts or open findings'
        : `${rollup.needs_review_document_count} document${rollup.needs_review_document_count === 1 ? '' : 's'} have at-risk amounts or open findings`,
      tone: rollup.needs_review_document_count > 0 ? 'warning' : 'success',
    },
    {
      key: 'required-reviews',
      label: 'Required Reviews',
      value: formatCompactNumber(validatorSummary.required_review_total),
      supporting: validatorSummary.required_review_total > 0
        ? `${validatorSummary.required_review_total} validator-backed review${validatorSummary.required_review_total === 1 ? '' : 's'} are unresolved and ready for operator action`
        : 'No validator-backed reviews are currently open',
      tone: validatorSummary.required_review_total > 0 ? 'warning' : 'muted',
    },
    {
      key: 'approval-findings',
      label: 'Approval Findings',
      value: formatCompactNumber(anomalyCount),
      supporting: formatOpenApprovalFindingSummary(blockerCount, warningCount),
      tone: anomalyTone,
    },
  ];
}

function resolveProjectFacts(
  project: ProjectRecord,
  validatorSummary: ProjectValidatorSummarySnapshot,
): ProjectOverviewFact[] {
  const approvalStatusLabel = approvalStatusLabelForProjectFacts({
    status: validatorSummary.status,
    validator_status: validatorSummary.validator_readiness,
  });
  return [
    { label: 'Project Code', value: shortProjectId(project) },
    { label: 'Approval Status', value: approvalStatusLabel },
    { label: 'Blocked Amount', value: formatCurrency(validatorSummary.blocked_amount ?? 0) },
    { label: 'Required Reviews', value: formatCompactNumber(validatorSummary.required_review_total) },
    { label: 'Approval Blockers', value: formatCompactNumber(validatorSummary.approval_blocker_count) },
  ];
}

function decisionBorderTone(decision: ProjectDecisionRow): OverviewTone {
  if (decision.status === 'resolved') return 'success';
  if (decision.status === 'suppressed' || decision.status === 'dismissed') return 'muted';
  if (decision.severity === 'critical') return 'danger';
  if (decision.severity === 'high' || decision.severity === 'medium') return 'warning';
  return 'info';
}

function decisionStatusTone(decision: ProjectDecisionRow): OverviewTone {
  if (decision.status === 'resolved') return 'success';
  if (decision.status === 'suppressed' || decision.status === 'dismissed') return 'muted';
  if (decision.status === 'in_review') return 'info';
  if (decision.severity === 'critical' || decision.severity === 'high') return 'warning';
  return 'neutral';
}

function detailString(
  details: Record<string, unknown> | null | undefined,
  keys: string[],
): string | null {
  if (!details) return null;

  for (const key of keys) {
    const value = details[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }

  return null;
}

function detailStringArray(
  details: Record<string, unknown> | null | undefined,
  keys: string[],
): string[] {
  if (!details) return [];

  for (const key of keys) {
    const value = details[key];
    if (!Array.isArray(value)) continue;
    const entries = value
      .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
      .filter((entry) => entry.length > 0);
    if (entries.length > 0) return entries;
  }

  return [];
}

function decisionOrigin(decision: ProjectDecisionRow): string | null {
  const explicitOrigin = detailString(decision.details ?? null, ['origin']);
  if (explicitOrigin) return explicitOrigin;

  return typeof decision.source === 'string' && decision.source.trim().length > 0
    ? decision.source.trim()
    : null;
}

export function isValidatorManagedDecision(decision: ProjectDecisionRow): boolean {
  const origin = decisionOrigin(decision);
  if (origin === 'project_validator') return true;

  const detailRecord = asRecord(decision.details);
  if (Array.isArray(detailRecord?.validator_finding_ids) && detailRecord.validator_finding_ids.length > 0) {
    return true;
  }

  return decision.decision_type.startsWith('validator_');
}

function decisionSourceLabel(decision: ProjectDecisionRow): string {
  const explicit = detailString(decision.details ?? null, ['source_label']);
  if (explicit) return explicit;

  const origin = decisionOrigin(decision);
  if (origin === 'project_validator') return 'Validator output';

  if (decision.source === 'deterministic') {
    const family = detailString(decision.details ?? null, ['document_family', 'source_family']);
    if (family === 'contract') return 'Legacy contract intelligence';
    if (family === 'invoice') return 'Legacy invoice intelligence';
    return 'Legacy document intelligence';
  }

  if (decision.source === 'rule_engine') return 'Legacy rule engine';
  if (decision.source === 'system') return 'System decision';
  return 'Project decision record';
}

function hasValidatorDecisionContext(summary: ProjectValidatorSummarySnapshot): boolean {
  return summary.status !== 'NOT_READY'
    || summary.trigger_source != null
    || summary.open_count > 0
    || summary.approval_blocker_count > 0
    || summary.warning_count > 0
    || summary.requires_review_count > 0
    || summary.total_at_risk != null
    || summary.requires_verification_amount != null
    || summary.blocked_amount != null;
}

function resolveForgeDecisions(
  decisions: ProjectDecisionRow[],
): ProjectDecisionRow[] {
  return decisions.filter(isValidatorManagedDecision);
}

function countOpenForgeDecisions(decisions: readonly ProjectDecisionRow[]): number {
  return decisions.filter((decision) => DECISION_OPEN_STATUSES.includes(decision.status)).length;
}

function resolveDecisionEmptyState(params: {
  visibleDecisions: ProjectDecisionRow[];
  rawDecisions: ProjectDecisionRow[];
  documents: ProjectDocumentRow[];
  validatorSummary: ProjectValidatorSummarySnapshot;
}): string {
  const { visibleDecisions, rawDecisions, documents, validatorSummary } = params;
  if (visibleDecisions.length > 0) {
    return 'All validator-backed decisions are resolved, dismissed, or suppressed.';
  }

  const hasLegacyDecisions = rawDecisions.some((decision) => !isValidatorManagedDecision(decision));
  if (!hasValidatorDecisionContext(validatorSummary)) {
    return hasLegacyDecisions
      ? 'Validator has not produced decision outputs yet. Legacy document-intelligence decisions remain supporting context only until validation runs.'
      : 'Validator has not produced decision outputs yet. Run validation after project truth is ready to generate approval decisions.';
  }

  if (documents.length === 0) {
    return 'No project documents yet. Upload and process documents to generate validator-backed approval decisions.';
  }

  return hasLegacyDecisions
    ? 'No open validator-backed decisions are driving approval right now. Legacy document-intelligence records remain supporting context only.'
    : 'No validator-backed project decisions are linked right now.';
}

function sortDecisionTasks(tasks: ProjectTaskRow[]): ProjectTaskRow[] {
  return [...tasks].sort((left, right) => {
    const leftOpenRank = TASK_OPEN_STATUSES.includes(left.status) ? 0 : 1;
    const rightOpenRank = TASK_OPEN_STATUSES.includes(right.status) ? 0 : 1;
    if (leftOpenRank !== rightOpenRank) return leftOpenRank - rightOpenRank;

    const leftPriorityRank = TASK_PRIORITY_RANK[left.priority] ?? 9;
    const rightPriorityRank = TASK_PRIORITY_RANK[right.priority] ?? 9;
    if (leftPriorityRank !== rightPriorityRank) return leftPriorityRank - rightPriorityRank;

    const leftDueRank = left.due_at ? new Date(left.due_at).getTime() : Number.MAX_SAFE_INTEGER;
    const rightDueRank = right.due_at ? new Date(right.due_at).getTime() : Number.MAX_SAFE_INTEGER;
    if (leftDueRank !== rightDueRank) return leftDueRank - rightDueRank;

    const leftUpdated = new Date(left.updated_at ?? left.created_at).getTime();
    const rightUpdated = new Date(right.updated_at ?? right.created_at).getTime();
    return rightUpdated - leftUpdated;
  });
}

function fallbackDecisionImpact(decision: ProjectDecisionRow): string {
  if (decision.status === 'resolved') {
    return 'This decision is closed and retained for approval history.';
  }
  if (decision.severity === 'critical') {
    return 'Approval risk remains open until this decision is resolved.';
  }
  if (decision.status === 'in_review') {
    return 'Operator review is in progress before this item can be cleared.';
  }
  return 'Operator review is still required before this item can be closed.';
}

function normalizeSourceFamilyLabel(value: string | null): string | null {
  if (!value) return null;
  if (value === 'cross_document') return 'Cross-document';
  return titleize(value);
}

export function resolveProjectDecisionSummary(
  decisions: ProjectDecisionRow[],
  tasks: ProjectTaskRow[],
  members: ProjectMember[],
  projectId?: string,
): ProjectOverviewDecisionCard[] {
  const relatedTaskCountByDecisionId = new Map<string, number>();
  const relatedTasksByDecisionId = new Map<string, ProjectTaskRow[]>();
  for (const task of tasks) {
    if (!task.decision_id) continue;
    relatedTaskCountByDecisionId.set(
      task.decision_id,
      (relatedTaskCountByDecisionId.get(task.decision_id) ?? 0) + 1,
    );
    const current = relatedTasksByDecisionId.get(task.decision_id) ?? [];
    current.push(task);
    relatedTasksByDecisionId.set(task.decision_id, current);
  }

  const sorted = [...decisions].sort((left, right) => {
    const leftCurrent = DECISION_OPEN_STATUSES.includes(left.status) ? 0 : 1;
    const rightCurrent = DECISION_OPEN_STATUSES.includes(right.status) ? 0 : 1;
    if (leftCurrent !== rightCurrent) return leftCurrent - rightCurrent;

    const leftPrimaryProjectRank = isProjectPrimaryApprovalDecisionRow(left) ? 0 : 1;
    const rightPrimaryProjectRank = isProjectPrimaryApprovalDecisionRow(right) ? 0 : 1;
    if (leftPrimaryProjectRank !== rightPrimaryProjectRank) {
      return leftPrimaryProjectRank - rightPrimaryProjectRank;
    }

    const leftStatusRank = DECISION_STATUS_RANK[left.status] ?? 9;
    const rightStatusRank = DECISION_STATUS_RANK[right.status] ?? 9;
    if (leftStatusRank !== rightStatusRank) return leftStatusRank - rightStatusRank;

    const leftSeverityRank = SEVERITY_RANK[left.severity] ?? 9;
    const rightSeverityRank = SEVERITY_RANK[right.severity] ?? 9;
    if (leftSeverityRank !== rightSeverityRank) return leftSeverityRank - rightSeverityRank;

    const leftTimestamp = new Date(left.last_detected_at ?? left.created_at).getTime();
    const rightTimestamp = new Date(right.last_detected_at ?? right.created_at).getTime();
    return rightTimestamp - leftTimestamp;
  });

  return sorted.slice(0, 6).map((decision) => {
    const relatedDecisionTasks = sortDecisionTasks(relatedTasksByDecisionId.get(decision.id) ?? []);
    const primaryTask = relatedDecisionTasks[0] ?? null;
    const reason = resolveDecisionReason(decision.details ?? null, decision.summary);
    const primaryAction = resolveDecisionPrimaryAction(decision.details ?? null);
    const metadata: string[] = [];
    if (decision.document_id) metadata.push('1 linked file');
    const relatedTaskCount = relatedTaskCountByDecisionId.get(decision.id) ?? 0;
    if (relatedTaskCount > 0) metadata.push(`${relatedTaskCount} pending action${relatedTaskCount === 1 ? '' : 's'}`);
    if (decision.confidence != null) metadata.push(`${Math.round(decision.confidence * 100)}% confidence`);

    const assignee = firstRelation(decision.assignee);
    const taskAssignee = primaryTask ? firstRelation(primaryTask.assignee) : null;
    const assigneeLabel =
      assignee?.display_name?.trim()
      || taskAssignee?.display_name?.trim()
      || memberName(members, decision.assigned_to ?? primaryTask?.assigned_to ?? null);
    const sourceDocument = decisionDocument(decision) ?? (primaryTask ? taskDocument(primaryTask) : null);
    const sourceDocumentTitle = sourceDocument ? documentTitle(sourceDocument) : null;
    const sourceDocumentHref =
      sourceDocument?.id && projectId
        ? buildProjectDocumentHref(sourceDocument.id, projectId)
        : null;
    const sourceLabel = decisionSourceLabel(decision);
    const evidenceRefs = [
      ...detailStringArray(decision.details ?? null, ['evidence_refs', 'fact_refs', 'source_refs']),
      ...detailStringArray(primaryTask?.details ?? null, ['evidence_refs', 'fact_refs', 'source_refs']),
    ];
    const uniqueEvidenceRefs = [...new Set(evidenceRefs)];
    const sourceFamilyLabel = normalizeSourceFamilyLabel(
      detailString(decision.details ?? null, ['source_family'])
      ?? detailString(primaryTask?.details ?? null, ['source_family'])
      ?? detailString(primaryTask?.source_metadata ?? null, ['origin']),
    );
    const problem = (
      detailString(decision.details ?? null, ['problem'])
      ?? detailString(primaryTask?.details ?? null, ['problem'])
      ?? reason
    ) || 'Decision detail is available in the full record.';
    const impact =
      detailString(decision.details ?? null, ['impact'])
      ?? detailString(primaryTask?.details ?? null, ['impact'])
      ?? fallbackDecisionImpact(decision);
    const requiredAction =
      detailString(decision.details ?? null, ['required_action'])
      ?? primaryAction?.description
      ?? detailString(primaryTask?.details ?? null, ['required_action'])
      ?? primaryTask?.title
      ?? primaryTask?.description
      ?? 'Review the decision context and determine the next disposition.';
    const dueAt = decision.due_at ?? primaryTask?.due_at ?? null;
    const sourceEvidenceLabelParts = [
      sourceLabel,
      sourceDocumentTitle ?? 'Project decision record',
      uniqueEvidenceRefs.length > 0
        ? `${uniqueEvidenceRefs.length} evidence ref${uniqueEvidenceRefs.length === 1 ? '' : 's'}`
        : null,
      sourceFamilyLabel,
    ].filter(Boolean);

    return {
      id: decision.id,
      href: `/platform/decisions/${decision.id}`,
      title: decision.title || titleize(decision.decision_type),
      status_key: decision.status,
      status_label: DECISION_STATUS_LABELS[decision.status] ?? titleize(decision.status),
      status_tone: decisionStatusTone(decision),
      freshness_label: relativeTime(decision.last_detected_at ?? decision.created_at),
      reason: reason || 'Decision detail is available in the full record.',
      problem,
      impact,
      required_action: requiredAction,
      assignees: assigneeLabel === 'Unassigned' ? [] : [assigneeLabel],
      owner_label: assigneeLabel,
      due_at: dueAt,
      due_label: dueAt ? formatDueDate(dueAt) : null,
      evidence_refs: uniqueEvidenceRefs,
      source_document_title: sourceDocumentTitle,
      source_document_href: sourceDocumentHref,
      source_evidence_label: sourceEvidenceLabelParts.join(' · ') || 'Project decision record',
      metadata,
      primary_action: primaryAction?.description ?? null,
      border_tone: decisionBorderTone(decision),
    };
  });
}

function taskPriorityTone(priority: string): OverviewTone {
  if (priority === 'critical') return 'danger';
  if (priority === 'high') return 'warning';
  if (priority === 'medium') return 'info';
  return 'muted';
}

function taskDueTone(task: ProjectTaskRow): OverviewTone {
  if (!task.due_at) return 'muted';
  const overdue = TASK_OPEN_STATUSES.includes(task.status) && new Date(task.due_at).getTime() < Date.now();
  if (overdue) return 'danger';
  return 'neutral';
}

/** Compact currency label for action titles. $1,234 → "$1k", $125,000 → "$125k", $1.2M → "$1.2M". */
function fmtMoneyCompact(amount: number): string {
  if (!Number.isFinite(amount) || amount <= 0) return '';
  if (amount >= 1_000_000) return `$${(amount / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (amount >= 1_000) return `$${Math.round(amount / 1_000)}k`;
  return `$${Math.round(amount)}`;
}

/**
 * Derive invoice-level action items from the validator snapshot.
 * Blocked invoices sort before needs-review; within each tier, larger billed amounts sort first.
 * Approved and approved_with_exceptions invoices are excluded (they don't need operator action).
 */
function buildInvoiceApprovalActionItems(
  invoices: ProjectOverviewInvoiceItem[],
  projectId: string,
): ProjectOverviewActionItem[] {
  const actionable = invoices.filter(
    (inv) => inv.approval_status === 'blocked' || inv.approval_status === 'needs_review',
  );

  // Sort: blocked first, then needs_review; within each group by billed_amount DESC
  actionable.sort((a, b) => {
    const tierA = a.approval_status === 'blocked' ? 0 : 1;
    const tierB = b.approval_status === 'blocked' ? 0 : 1;
    if (tierA !== tierB) return tierA - tierB;
    return (b.billed_amount ?? 0) - (a.billed_amount ?? 0);
  });

  return actionable.map((inv) => {
    const isBlocked = inv.approval_status === 'blocked';
    const invLabel = inv.invoice_number ? `Invoice ${inv.invoice_number}` : 'Invoice';
    const billedSuffix = inv.billed_amount != null
      ? ` · ${fmtMoneyCompact(inv.billed_amount)} billed`
      : '';
    const atRiskSuffix =
      !isBlocked && inv.at_risk_amount != null && inv.at_risk_amount > 0
        ? ` · ${fmtMoneyCompact(inv.at_risk_amount)} at risk`
        : '';

    const title = isBlocked
      ? `Review blocked ${invLabel}${billedSuffix}`
      : `Review ${invLabel} — reconciliation issues${atRiskSuffix}`;

    const statusLabel = isBlocked ? 'Blocked' : 'Needs Review';
    const dueLabel = isBlocked
      ? 'Payment blocked — requires resolution'
      : 'Payment at risk — requires review';

    const nextStep = isBlocked
      ? `Resolve ${inv.reconciliation_status.toLowerCase().replace(/_/g, ' ')} status to unblock payment`
      : `Review ${fmtMoneyCompact(inv.at_risk_amount ?? 0)} in exposure variance`;

    return {
      id: `invoice-action:${inv.invoice_number ?? 'unknown'}`,
      href: `/platform/projects/${projectId}#project-validator`,
      title,
      due_label: dueLabel,
      due_tone: (isBlocked ? 'danger' : 'warning') as OverviewTone,
      assignee_label: 'Project reviewer',
      priority_label: isBlocked ? 'Critical' : 'High',
      priority_tone: (isBlocked ? 'danger' : 'warning') as OverviewTone,
      status_label: statusLabel,
      source_document_title: 'Validator exposure analysis',
      source_document_type: 'validator',
      invoice_number: inv.invoice_number,
      approval_status: inv.approval_status,
      impacted_amount: inv.billed_amount,
      at_risk_amount: inv.at_risk_amount,
      requires_verification_amount: inv.requires_verification_amount,
      blocked_amount: isBlocked ? inv.billed_amount : null,
      billing_group_ids: null,
      next_step: nextStep,
    };
  });
}

export function resolveProjectPendingActions(
  rollup: ProjectOperationalRollup,
  validatorSummary?: ProjectValidatorSummarySnapshot | null,
  projectId?: string,
): ProjectOverviewActionItem[] {
  // Invoice-level actions always lead — they represent money movement blockers.
  const invoiceActions =
    validatorSummary && projectId
      ? buildInvoiceApprovalActionItems(validatorSummary.invoice_summaries, projectId)
      : [];
  // Keep up to 5 task/decision actions after invoice actions so they are not crowded out entirely.
  const taskActions = rollup.pending_actions.slice(0, 5);
  return [...invoiceActions, ...taskActions];
}

function documentStatusTone(status: string): OverviewTone {
  switch (status) {
    case 'decisioned':
      return 'success';
    case 'processing':
      return 'warning';
    case 'failed':
      return 'danger';
    case 'extracted':
      return 'info';
    default:
      return 'muted';
  }
}

export function resolveProjectProcessedDocs(
  project: ProjectRecord,
  documents: ProjectDocumentRow[],
  rollup: ProjectOperationalRollup,
): ProjectOverviewDocumentItem[] {
  const processedDocuments = [...documents]
    .filter(isProcessedDocument)
    .sort((left, right) => {
      const leftTimestamp = new Date(left.processed_at ?? left.created_at).getTime();
      const rightTimestamp = new Date(right.processed_at ?? right.created_at).getTime();
      return rightTimestamp - leftTimestamp;
    });

  return processedDocuments.slice(0, 6).map((document) => ({
    id: document.id,
    href: buildProjectDocumentHref(document.id, project.id),
    title: documentTitle(document),
    detail: [titleize(document.document_type), document.domain ? titleize(document.domain) : null]
      .filter(Boolean)
      .join(' / ') || 'Unclassified document',
    processed_label: relativeTime(document.processed_at ?? document.created_at),
    status_label: rollup.document_status_by_id[document.id]?.label ?? titleize(document.processing_status),
    status_tone: rollup.document_status_by_id[document.id]?.tone ?? documentStatusTone(document.processing_status),
  }));
}

function auditToneForStatus(value: string | null | undefined): OverviewTone {
  if (!value) return 'muted';
  if (value === 'resolved' || value === 'decisioned' || value === 'completed') return 'success';
  if (value === 'failed' || value === 'blocked') return 'danger';
  if (value === 'in_review' || value === 'processing') return 'warning';
  return 'info';
}

function extractStatus(value: Record<string, unknown> | null | undefined): string | null {
  const status = value?.status;
  return typeof status === 'string' ? status : null;
}

function extractStringValue(
  value: Record<string, unknown> | null | undefined,
  key: string,
): string | null {
  const result = value?.[key];
  return typeof result === 'string' && result.trim().length > 0 ? result : null;
}

function extractNumberValue(
  value: Record<string, unknown> | null | undefined,
  key: string,
): number | null {
  const result = value?.[key];
  return typeof result === 'number' && Number.isFinite(result) ? result : null;
}

function extractStringArrayValue(
  value: Record<string, unknown> | null | undefined,
  key: string,
): string[] {
  const result = value?.[key];
  if (!Array.isArray(result)) return [];

  return result.filter(
    (entry): entry is string => typeof entry === 'string' && entry.trim().length > 0,
  );
}

function extractValidationStatus(
  value: Record<string, unknown> | null | undefined,
): ValidationStatus | null {
  const status = extractStringValue(value, 'status');
  if (
    status === 'NOT_READY' ||
    status === 'BLOCKED' ||
    status === 'VALIDATED' ||
    status === 'FINDINGS_OPEN'
  ) {
    return status;
  }

  return null;
}

export function resolveProjectAuditEvents(
  project: ProjectRecord,
  documents: ProjectDocumentRow[],
  decisions: ProjectDecisionRow[],
  tasks: ProjectTaskRow[],
  activityEvents: ProjectActivityEventRow[],
  members: ProjectMember[],
): ProjectOverviewAuditItem[] {
  const decisionTitleById = new Map(decisions.map((decision) => [decision.id, decision.title]));
  const taskTitleById = new Map(tasks.map((task) => [task.id, task.title]));
  const documentTitleById = new Map(documents.map((document) => [document.id, documentTitle(document)]));

  const documentEvents = documents.flatMap((document) => {
    const title = documentTitle(document);
    const events: Array<ProjectOverviewAuditItem & { sort_at: string }> = [
      {
        id: `document-created-${document.id}`,
        label: 'Document added',
        detail: 'Linked into the project document record.',
        object_label: title,
        source_label: 'Document record',
        timestamp_at: document.created_at,
        timestamp_label: relativeTime(document.created_at),
        tone: 'info',
        href: buildProjectDocumentHref(document.id, project.id),
        sort_at: document.created_at,
      },
    ];
    if (document.processed_at) {
      events.push({
        id: `document-processed-${document.id}`,
        label: document.processing_status === 'failed' ? 'Document processing failed' : 'Document processed',
        detail:
          document.processing_status === 'failed'
            ? 'Processing ended with an error and needs operator attention.'
            : 'Extraction and project intelligence processing completed.',
        object_label: title,
        source_label: 'Processing record',
        timestamp_at: document.processed_at,
        timestamp_label: relativeTime(document.processed_at),
        tone: auditToneForStatus(document.processing_status),
        href: buildProjectDocumentHref(document.id, project.id),
        sort_at: document.processed_at,
      });
    }
    return events;
  });

  const derivedActivityEvents = activityEvents.map((event) => {
    const isValidationRun =
      event.entity_type === 'project_validation_run' &&
      event.event_type === 'validation_run_completed';
    if (isValidationRun) {
      const status = extractValidationStatus(event.new_value) ?? 'NOT_READY';
      const criticalCount = extractNumberValue(event.new_value, 'critical_count') ?? 0;
      const warningCount = extractNumberValue(event.new_value, 'warning_count') ?? 0;
      const newFindingsCount = extractNumberValue(event.new_value, 'new_findings') ?? 0;
      const resolvedFindingsCount = extractNumberValue(event.new_value, 'resolved_findings') ?? 0;
      const rulesApplied = extractStringArrayValue(event.new_value, 'rules_applied');
      const ruleVersion = extractStringValue(event.new_value, 'rule_version');
      const tone: OverviewTone =
        status === 'BLOCKED'
          ? 'danger'
          : status === 'VALIDATED'
            ? 'success'
            : status === 'FINDINGS_OPEN'
              ? 'warning'
              : 'muted';

      return {
        id: event.id,
        label: 'Validation run',
        detail:
          status === 'BLOCKED'
            ? 'Validator recorded blocking findings against the current project truth.'
            : status === 'VALIDATED'
              ? 'Validator confirmed the current project truth snapshot.'
              : status === 'FINDINGS_OPEN'
                ? 'Validator recorded open findings that still need review.'
                : 'Validator recorded a new project consistency snapshot.',
        object_label: project.name,
        source_label: 'Validator snapshot',
        timestamp_at: event.created_at,
        timestamp_label: relativeTime(event.created_at),
        tone,
        href: null,
        sort_at: event.created_at,
        validation_run: {
          status,
          critical_count: criticalCount,
          warning_count: warningCount,
          new_findings_count: newFindingsCount,
          resolved_findings_count: resolvedFindingsCount,
          rules_applied_count: rulesApplied.length,
          rule_version: ruleVersion,
        },
      };
    }

    const isDecision = event.entity_type === 'decision';
    const isTask = event.entity_type === 'workflow_task';
    const isProject = event.entity_type === 'project';
    const oldStatus = extractStatus(event.old_value);
    const fieldKey = extractStringValue(event.new_value, 'field_key')
      ?? extractStringValue(event.old_value, 'field_key');
    const reason = extractStringValue(event.new_value, 'reason');
    const reviewStatus = extractStringValue(event.new_value, 'review_status');
    const notes = extractStringValue(event.new_value, 'notes');
    const familyLabel = extractStringValue(event.new_value, 'family_label')
      ?? extractStringValue(event.old_value, 'family_label');
    const governingDocumentTitle = extractStringValue(event.new_value, 'governing_document_title');
    const previousGoverningDocumentTitle = extractStringValue(event.old_value, 'governing_document_title');
    const authorityStatus = extractStringValue(event.new_value, 'authority_status');
    const relationshipType = extractStringValue(event.new_value, 'relationship_type');
    const relationshipTargetTitle = extractStringValue(event.new_value, 'target_document_title');
    const sourceDocumentTitle = extractStringValue(event.new_value, 'source_document_title');
    const precedenceMode = extractStringValue(event.new_value, 'precedence_mode');
    const entityTitle = isDecision
      ? decisionTitleById.get(event.entity_id) ?? documentTitleById.get(event.entity_id) ?? 'Decision'
      : isTask
        ? taskTitleById.get(event.entity_id) ?? 'Action'
        : isProject
          ? extractStringValue(event.new_value, 'project_name') ??
            extractStringValue(event.old_value, 'project_name') ??
            project.name
          : extractStringValue(event.new_value, 'document_title') ??
            extractStringValue(event.old_value, 'document_title') ??
            'Document';
    const nextStatus = extractStatus(event.new_value);
    const nextAssigneeId = extractStringValue(event.new_value, 'assigned_to');
    const nextAssigneeLabel = nextAssigneeId ? memberName(members, nextAssigneeId) : null;
    const previousDueAt = extractStringValue(event.old_value, 'due_at');
    const nextDueAt = extractStringValue(event.new_value, 'due_at');

    let label = 'Record updated';
    let detail = `${entityTitle} changed.`;
    let tone: OverviewTone = 'info';
    let objectLabel: string | null = entityTitle;
    let sourceLabel: string | null = 'Activity log';
    let href: string | null = isDecision
      ? `/platform/decisions/${event.entity_id}`
      : isTask
        ? `/platform/decisions`
        : isProject
          ? `/platform/projects/${event.entity_id}`
          : `/platform/documents/${event.entity_id}`;

    switch (event.event_type) {
      case 'created':
        label = isDecision ? 'Decision created' : isTask ? 'Action created' : 'Record created';
        detail = isDecision
          ? 'A new decision entered the project workflow.'
          : isTask
            ? 'A new action entered the workflow queue.'
            : `${entityTitle} was created.`;
        sourceLabel = isDecision ? 'Decision record' : isTask ? 'Workflow record' : 'Activity log';
        break;
      case 'updated':
        label = isDecision ? 'Decision updated' : 'Record updated';
        detail = isDecision
          ? 'Primary approval decision details were refreshed from the latest validator output.'
          : `${entityTitle} was updated.`;
        tone = 'info';
        sourceLabel = isDecision ? 'Validator decision sync' : 'Activity log';
        break;
      case 'validation_run_requested':
        label = 'Validation rerun requested';
        detail = 'Project truth changed and a validator rerun was requested to refresh approval status.';
        tone = 'info';
        sourceLabel = 'Validator request';
        href = `/platform/projects/${event.entity_id}#project-validator`;
        break;
      case 'status_changed':
        if (isDecision && nextStatus === 'in_review') {
          label = 'Decision moved to review';
          detail = 'Decision now requires operator review.';
        } else if (isDecision && nextStatus === 'resolved') {
          label = 'Decision resolved';
          detail = 'Decision was resolved and removed from the open queue.';
        } else if (isTask && (nextStatus === 'resolved' || nextStatus === 'completed')) {
          label = 'Action completed';
          detail = 'Workflow action was completed.';
        } else {
          label = isDecision ? 'Decision status changed' : isTask ? 'Action status changed' : 'Status changed';
          detail = oldStatus && nextStatus
            ? `Moved from ${titleize(oldStatus)} to ${titleize(nextStatus)}.`
            : nextStatus
              ? `Status updated to ${titleize(nextStatus)}.`
              : 'Status was updated.';
        }
        tone = auditToneForStatus(nextStatus);
        sourceLabel = isDecision ? 'Decision workflow' : isTask ? 'Action workflow' : 'Activity log';
        break;
      case 'assignment_changed':
        label = isDecision ? 'Decision reassigned' : isTask ? 'Action reassigned' : 'Assignment changed';
        detail = nextAssigneeLabel ? `Assigned to ${nextAssigneeLabel}.` : 'Assignment was cleared.';
        tone = 'warning';
        sourceLabel = 'Workflow assignment';
        break;
      case 'due_date_changed':
        label = isDecision ? 'Decision due date adjusted' : isTask ? 'Action due date adjusted' : 'Due date adjusted';
        detail = nextDueAt
          ? `Due date set to ${formatDueDate(nextDueAt)}.`
          : previousDueAt
            ? 'Due date was cleared.'
            : 'Due date was updated.';
        tone = 'muted';
        sourceLabel = 'Workflow schedule';
        break;
      case 'document_removed_from_project':
        label = 'Document removed from project';
        detail = 'Removed from the project document set.';
        tone = 'warning';
        sourceLabel = 'Project link';
        href = `/platform/documents/${event.entity_id}`;
        break;
      case 'document_moved_to_project': {
        const fromProject = extractStringValue(event.old_value, 'project_name');
        const toProject = extractStringValue(event.new_value, 'project_name');
        label = 'Document moved to project';
        detail =
          fromProject && toProject
            ? `Moved from ${fromProject} to ${toProject}.`
            : toProject
              ? `Moved into ${toProject}.`
              : 'Project link changed.';
        tone = 'info';
        sourceLabel = 'Project link';
        href = `/platform/documents/${event.entity_id}`;
        break;
      }
      case 'project_archived':
        label = 'Project archived';
        detail = 'Project was archived and removed from default active views.';
        tone = 'muted';
        sourceLabel = 'Project record';
        href = `/platform/projects/${event.entity_id}`;
        break;
      case 'project_deleted':
        label = 'Project deleted';
        detail = 'Project record was deleted.';
        tone = 'danger';
        sourceLabel = 'Project record';
        href = null;
        break;
      case 'override_applied':
        label = 'Override applied';
        detail = fieldKey
          ? `${titleize(fieldKey)} was updated by manual override.${reason ? ` Reason: ${reason}` : ''}`
          : `Manual override applied.${reason ? ` Reason: ${reason}` : ''}`;
        tone = 'warning';
        objectLabel = entityTitle;
        sourceLabel = fieldKey ? `Fact override / ${titleize(fieldKey)}` : 'Fact override';
        href = `/platform/documents/${event.entity_id}`;
        break;
      case 'review_recorded':
        label =
          reviewStatus === 'confirmed'
            ? 'Fact review confirmed'
            : reviewStatus === 'needs_followup'
              ? 'Fact review flagged'
              : reviewStatus === 'missing_confirmed'
                ? 'Missing fact confirmed'
                : 'Fact review recorded';
        detail =
          reviewStatus === 'confirmed'
            ? `${fieldKey ? titleize(fieldKey) : 'Fact'} was confirmed during review.`
            : reviewStatus === 'needs_followup'
              ? `${fieldKey ? titleize(fieldKey) : 'Fact'} needs follow-up verification.${notes ? ` Notes: ${notes}` : ''}`
              : reviewStatus === 'missing_confirmed'
                ? `${fieldKey ? titleize(fieldKey) : 'Fact'} was confirmed missing.${notes ? ` Notes: ${notes}` : ''}`
                : `Review recorded for ${fieldKey ? titleize(fieldKey) : 'fact'}.${notes ? ` Notes: ${notes}` : ''}`;
        tone =
          reviewStatus === 'confirmed'
            ? 'success'
            : reviewStatus === 'needs_followup' || reviewStatus === 'missing_confirmed'
              ? 'warning'
              : 'info';
        objectLabel = entityTitle;
        sourceLabel = fieldKey ? `Fact review / ${titleize(fieldKey)}` : 'Fact review';
        href = `/platform/documents/${event.entity_id}`;
        break;
      case 'review_correction_applied':
        label = 'Review correction applied';
        detail = `${fieldKey ? titleize(fieldKey) : 'Fact'} was corrected during review.${notes ? ` Notes: ${notes}` : ''}`;
        tone = 'warning';
        objectLabel = entityTitle;
        sourceLabel = fieldKey ? `Fact review / ${titleize(fieldKey)}` : 'Fact review';
        href = `/platform/documents/${event.entity_id}`;
        break;
      case 'governing_document_changed':
        label = 'Governing document changed';
        detail =
          governingDocumentTitle && previousGoverningDocumentTitle && governingDocumentTitle !== previousGoverningDocumentTitle
            ? `${familyLabel ?? 'Document family'} now governed by ${governingDocumentTitle} (was ${previousGoverningDocumentTitle}).`
            : governingDocumentTitle
              ? `${familyLabel ?? 'Document family'} now governed by ${governingDocumentTitle}.`
              : 'Governing document changed.';
        tone = 'warning';
        objectLabel = governingDocumentTitle ?? entityTitle;
        sourceLabel = 'Document precedence';
        href = `/platform/documents/${event.entity_id}`;
        break;
      case 'document_precedence_changed':
        label = 'Document precedence changed';
        detail =
          authorityStatus
            ? `${entityTitle} authority set to ${titleize(authorityStatus)}.`
            : precedenceMode === 'automatic'
              ? `${familyLabel ?? 'Document family'} reverted to automatic precedence ordering.`
              : `${entityTitle} moved within ${familyLabel ?? 'document'} precedence.`;
        tone = authorityStatus === 'superseded' ? 'warning' : 'info';
        objectLabel = isProject ? familyLabel ?? entityTitle : entityTitle;
        sourceLabel = 'Document precedence';
        href = isProject ? `/platform/projects/${event.entity_id}#project-documents` : `/platform/documents/${event.entity_id}`;
        break;
      case 'document_relationship_created':
      case 'document_relationship_changed':
        label = 'Document relationship recorded';
        detail =
          relationshipType && relationshipTargetTitle
            ? `${sourceDocumentTitle ?? entityTitle} now ${relationshipType.replace(/_/g, ' ')} ${relationshipTargetTitle}.`
            : 'Document relationship updated.';
        tone = 'info';
        objectLabel = sourceDocumentTitle ?? entityTitle;
        sourceLabel = 'Document relationship';
        href = `/platform/documents/${event.entity_id}`;
        break;
      case 'document_subtype_updated':
        label = 'Document subtype updated';
        detail =
          typeof event.new_value?.document_subtype === 'string'
            ? `${entityTitle} is now classified as ${titleize(String(event.new_value.document_subtype))}.`
            : 'Document subtype updated.';
        tone = 'info';
        objectLabel = entityTitle;
        sourceLabel = 'Document classification';
        href = `/platform/documents/${event.entity_id}`;
        break;
      case 'project_validation_phase_changed':
        label = 'Validation phase changed';
        detail =
          typeof event.old_value?.validation_phase === 'string' && typeof event.new_value?.validation_phase === 'string'
            ? `Validation moved from ${titleize(String(event.old_value.validation_phase))} to ${titleize(String(event.new_value.validation_phase))}.`
            : 'Project validation phase updated.';
        tone = 'info';
        objectLabel = entityTitle;
        sourceLabel = 'Validator phase';
        href = `/platform/projects/${event.entity_id}`;
        break;
      default:
        break;
    }

    return {
      id: event.id,
      label,
      detail,
      object_label: objectLabel,
      source_label: sourceLabel,
      timestamp_at: event.created_at,
      timestamp_label: relativeTime(event.created_at),
      tone,
      href,
      sort_at: event.created_at,
      validation_run: null,
    };
  });

  return [...documentEvents, ...derivedActivityEvents]
    .sort((left, right) => new Date(right.sort_at).getTime() - new Date(left.sort_at).getTime())
    .slice(0, 20)
    .map((event) => ({
      id: event.id,
      label: event.label,
      detail: event.detail,
      object_label: event.object_label ?? null,
      source_label: event.source_label ?? null,
      timestamp_at: event.timestamp_at,
      timestamp_label: event.timestamp_label,
      tone: event.tone,
      href: event.href,
      validation_run: event.validation_run ?? null,
    }));
}

export function buildProjectOverviewModel(params: {
  project: ProjectRecord;
  documents: ProjectDocumentRow[];
  decisions: ProjectDecisionRow[];
  tasks: ProjectTaskRow[];
  documentReviews?: ProjectDocumentReviewRow[];
  activityEvents: ProjectActivityEventRow[];
  members: ProjectMember[];
  validationFindings?: readonly ValidationFinding[];
}): ProjectOverviewModel {
  const {
    project,
    documents,
    decisions,
    tasks,
    documentReviews = [],
    activityEvents,
    members,
    validationFindings,
  } = params;
  const validatorSummary = resolveProjectValidatorSummary(project, documents, validationFindings, decisions);
  const forgeDecisions = resolveForgeDecisions(decisions);
  const openDecisionCount = countOpenForgeDecisions(forgeDecisions);
  const rollup = buildProjectOperationalRollup({
    project,
    documents,
    decisions: forgeDecisions,
    tasks,
    documentReviews,
    members,
  });
  const exposure = resolveProjectExposure(project, documents, validatorSummary);
  const decisionCards = resolveProjectDecisionSummary(forgeDecisions, tasks, members, project.id);
  const actionItems = resolveProjectPendingActions(rollup, validatorSummary, project.id);
  const processedDocuments = resolveProjectProcessedDocs(project, documents, rollup);
  const auditItems = resolveProjectAuditEvents(project, documents, decisions, tasks, activityEvents, members);

  return {
    project,
    context_label: 'Operations / Projects',
    title: project.name,
    project_id_label: shortProjectId(project),
    tags: resolveProjectTags(project, documents),
    status: resolveProjectStatus(project, rollup, validatorSummary, openDecisionCount),
    validator_status: validatorSummary.status,
    validator_summary: validatorSummary,
    exposure,
    metrics: resolveProjectMetrics(project, rollup, validatorSummary),
    facts: resolveProjectFacts(project, validatorSummary),
    decisions: decisionCards,
    decision_total: forgeDecisions.length,
    decision_empty_state: resolveDecisionEmptyState({
      visibleDecisions: forgeDecisions,
      rawDecisions: decisions,
      documents,
      validatorSummary,
    }),
    actions: actionItems,
    action_total: rollup.open_document_action_count,
    action_empty_state: documents.length === 0
      ? 'No pending actions because the project has no linked operational records yet.'
      : 'No pending actions remain in the project rollup.',
    documents: processedDocuments,
    document_status_by_id: rollup.document_status_by_id,
    document_total: rollup.processed_document_count,
    document_empty_state: documents.length === 0
      ? 'No documents are linked to this project yet.'
      : 'Documents are linked, but none have completed processing yet.',
    audit: auditItems,
    audit_empty_state: documents.length === 0
      ? 'Project history will appear once documents, validation, or workflow activity starts.'
      : 'No canonical project events are recorded yet.',
  };
}

// --- Forge inspector: reuse persistence rules without duplicating operational signals ---

export function forgeInspectorDocumentLabel(
  document:
    | Pick<ProjectDocumentRow, 'title' | 'name'>
    | Pick<ProjectDocumentRelation, 'title' | 'name'>
    | null,
): string {
  return documentTitle(document);
}

export function forgeInspectorDecisionOperationalState(decision: ProjectDecisionRow): {
  blocked: boolean;
  missingSupport: boolean;
} {
  return {
    blocked: isBlockedPersistedDecision(decision),
    missingSupport: isMissingSupportPersistedDecision(decision),
  };
}

export function forgeInspectorDecisionLinkedDocument(decision: ProjectDecisionRow): ProjectDocumentRelation | null {
  return decisionDocument(decision);
}

export function forgeInspectorDecisionSourceDocumentId(decision: ProjectDecisionRow): string | null {
  return resolveDecisionSourceDocumentId(decision);
}

export function forgeInspectorTaskLinkedDocument(task: ProjectTaskRow): ProjectDocumentRelation | null {
  return taskDocument(task);
}

export function forgeInspectorTaskSourceDocumentId(
  task: ProjectTaskRow,
  decisions: ProjectDecisionRow[],
): string | null {
  const decisionById = new Map(decisions.map((d) => [d.id, d]));
  return resolveTaskSourceDocumentId(task, decisionById);
}
