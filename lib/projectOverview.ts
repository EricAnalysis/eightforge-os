import { filterCurrentQueueRecords } from '@/lib/currentWork';
import {
  resolveDecisionPrimaryAction,
  resolveDecisionProjectContext,
  resolveDecisionReason,
} from '@/lib/decisionActions';
import { buildProjectDocumentHref } from '@/lib/documentNavigation';
import { formatDueDate } from '@/lib/dateUtils';
import { DECISION_OPEN_STATUSES, TASK_OPEN_STATUSES } from '@/lib/overdue';
import type {
  DocumentExecutionTrace,
  FlowTask,
  NormalizedDecision,
} from '@/lib/types/documentIntelligence';
import type {
  ValidationStatus,
  ValidationTriggerSource,
  ValidatorStatus,
} from '@/types/validator';

type Relation<T> = T | T[] | null | undefined;

export type ProjectRecord = {
  id: string;
  name: string;
  code: string | null;
  status: string | null;
  created_at: string;
  validation_status?: ValidationStatus | null;
  validation_summary_json?: unknown;
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
  intelligence_trace?: DocumentExecutionTrace | Record<string, unknown> | null;
};

export type ProjectDecisionRow = {
  id: string;
  document_id: string | null;
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
  info_count: number;
  open_count: number;
  blocked_reasons: string[];
  trigger_source: ValidationTriggerSource | null;
  nte_amount: number | null;
  total_billed: number | null;
  /** Total exposure variance not yet confirmed — parsed from validation_summary_json.exposure. */
  total_at_risk: number | null;
  /** Total dollars tied to blocked or needs-review findings. */
  requires_verification_amount: number | null;
  /** READY / BLOCKED / NEEDS_REVIEW from persisted validation summary when present. */
  validator_readiness: ValidatorStatus | null;
  reconciliation_overall: string | null;
  /** Per-invoice approval breakdown parsed from validation_summary_json.exposure.invoices. */
  invoice_summaries: ProjectOverviewInvoiceItem[];
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
  status_label: string;
  status_tone: OverviewTone;
  freshness_label: string;
  reason: string;
  assignees: string[];
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
  document_total: number;
  document_empty_state: string;
  audit: ProjectOverviewAuditItem[];
  audit_empty_state: string;
};

export type ProjectOperationalRollup = {
  status: ProjectOverviewStatus;
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
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: value >= 1000 ? 0 : 2,
  }).format(value);
}

function formatCompactNumber(value: number): string {
  return new Intl.NumberFormat('en-US', {
    notation: value >= 1000 ? 'compact' : 'standard',
    maximumFractionDigits: value >= 1000 ? 1 : 0,
  }).format(value);
}

function parseNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(/[$,]/g, '').trim();
  if (!cleaned) return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

function isValidationStatus(value: unknown): value is ValidationStatus {
  return (
    value === 'NOT_READY' ||
    value === 'BLOCKED' ||
    value === 'VALIDATED' ||
    value === 'FINDINGS_OPEN'
  );
}

function isValidationTriggerSource(value: unknown): value is ValidationTriggerSource {
  return (
    value === 'document_processed' ||
    value === 'fact_override' ||
    value === 'relationship_change' ||
    value === 'manual'
  );
}

function isValidatorStatus(value: unknown): value is ValidatorStatus {
  return value === 'READY' || value === 'BLOCKED' || value === 'NEEDS_REVIEW';
}

function deriveOverviewInvoiceApprovalStatus(
  reconciliationStatus: string,
  requiresVerificationAmount: number,
): ProjectOverviewInvoiceItem['approval_status'] {
  if (reconciliationStatus === 'MISMATCH' || reconciliationStatus === 'MISSING') {
    return 'blocked';
  }
  if (reconciliationStatus === 'PARTIAL') {
    return requiresVerificationAmount > 0 ? 'needs_review' : 'approved_with_exceptions';
  }
  return 'approved';
}

function parseOverviewInvoiceSummaries(rawInvoices: unknown[]): ProjectOverviewInvoiceItem[] {
  return rawInvoices.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null) return [];
    const e = entry as Record<string, unknown>;
    const reconciliation_status =
      typeof e.reconciliation_status === 'string' && e.reconciliation_status.trim()
        ? e.reconciliation_status.trim()
        : null;
    if (!reconciliation_status) return [];
    const at_risk_raw = parseNumber(e.unreconciled_amount);
    const requires_verification_raw =
      parseNumber(e.requires_verification_amount)
      ?? parseNumber(e.at_risk_amount);
    const requires_verification_amount = requires_verification_raw ?? 0;
    return [{
      invoice_number:
        typeof e.invoice_number === 'string' && e.invoice_number.trim()
          ? e.invoice_number.trim()
          : null,
      approval_status: deriveOverviewInvoiceApprovalStatus(
        reconciliation_status,
        requires_verification_amount,
      ),
      billed_amount: parseNumber(e.billed_amount) ?? null,
      supported_amount: parseNumber(e.supported_amount) ?? null,
      at_risk_amount: at_risk_raw ?? null,
      requires_verification_amount: requires_verification_raw ?? null,
      reconciliation_status,
    }];
  });
}

function resolveProjectValidatorSummary(
  project: ProjectRecord,
): ProjectValidatorSummarySnapshot {
  const raw =
    project.validation_summary_json &&
    typeof project.validation_summary_json === 'object' &&
    !Array.isArray(project.validation_summary_json)
      ? (project.validation_summary_json as Record<string, unknown>)
      : null;

  const status = isValidationStatus(project.validation_status)
    ? project.validation_status
    : raw && isValidationStatus(raw.status)
      ? raw.status
      : 'NOT_READY';

  const rawExposure =
    raw?.exposure && typeof raw.exposure === 'object' && !Array.isArray(raw.exposure)
      ? (raw.exposure as Record<string, unknown>)
      : null;
  const rawReconciliation =
    raw?.reconciliation && typeof raw.reconciliation === 'object' && !Array.isArray(raw.reconciliation)
      ? (raw.reconciliation as Record<string, unknown>)
      : null;

  const nte_amount = parseNumber(raw?.nteAmount ?? raw?.nte_amount) ?? null;
  const total_billed =
    parseNumber(raw?.totalBilled ?? raw?.total_billed)
    ?? (rawExposure ? parseNumber(rawExposure.total_billed_amount) : null)
    ?? null;
  const total_at_risk =
    rawExposure ? parseNumber(rawExposure.total_unreconciled_amount) : null;
  const requires_verification_amount =
    parseNumber(raw?.requires_verification_amount)
    ?? (rawExposure
      ? parseNumber(rawExposure.total_requires_verification_amount)
        ?? parseNumber(rawExposure.total_at_risk_amount)
      : null)
    ?? null;

  const invoice_summaries = parseOverviewInvoiceSummaries(
    rawExposure && Array.isArray(rawExposure.invoices) ? rawExposure.invoices : [],
  );
  const blocked_total = invoice_summaries
    .filter((i) => i.approval_status === 'blocked')
    .reduce((sum, i) => sum + (i.billed_amount ?? 0), 0);
  const blocked_amount = blocked_total > 0 ? blocked_total : null;

  return {
    status,
    critical_count: parseNumber(raw?.critical_count) ?? 0,
    warning_count: parseNumber(raw?.warning_count) ?? 0,
    info_count: parseNumber(raw?.info_count) ?? 0,
    open_count: parseNumber(raw?.open_count) ?? 0,
    blocked_reasons: Array.isArray(raw?.blocked_reasons)
      ? raw.blocked_reasons.filter(
          (value): value is string => typeof value === 'string' && value.trim().length > 0,
        )
      : [],
    trigger_source: isValidationTriggerSource(raw?.trigger_source)
      ? raw.trigger_source
      : null,
    nte_amount,
    total_billed,
    total_at_risk,
    requires_verification_amount,
    validator_readiness: raw && isValidatorStatus(raw.validator_status)
      ? raw.validator_status
      : null,
    reconciliation_overall:
      typeof rawReconciliation?.overall_reconciliation_status === 'string'
        ? rawReconciliation.overall_reconciliation_status
        : null,
    invoice_summaries,
    blocked_amount,
  };
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
      href: task.decision_id ? `/platform/decisions/${task.decision_id}` : `/platform/workflows/${task.id}`,
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
      detail: `${openDocumentActionCount} open action${openDocumentActionCount === 1 ? '' : 's'} and ${unresolvedFindingCount} unresolved finding${unresolvedFindingCount === 1 ? '' : 's'} are pending review — no payment blockers.`,
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
        'Total billed comes from invoice exposure analysis.',
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
    detail: `NTE utilization from invoice exposure analysis.${reconNote}${approvalNote}`.trim(),
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
  const anomalyCount = validatorSummary.critical_count + validatorSummary.warning_count;
  const anomalyTone: OverviewTone =
    validatorSummary.critical_count > 0
      ? 'danger'
      : anomalyCount > 0
        ? 'warning'
        : 'success';
  const hasExposureData = validatorSummary.total_billed != null;

  if (hasExposureData) {
    const atRisk = validatorSummary.total_at_risk;
    const requiresVerification = validatorSummary.requires_verification_amount;
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
        label: 'Total Billed',
        value: formatCurrency(validatorSummary.total_billed),
        supporting: `Invoice billed total from exposure analysis across all linked claims`,
        tone: 'neutral',
      },
      {
        key: 'at-risk',
        label: 'At Risk',
        value: atRisk != null ? formatCurrency(atRisk) : '—',
        supporting: atRisk != null && atRisk > 0
          ? 'Exposure variance is still awaiting confirmation'
          : 'No at-risk variance is currently open',
        tone: atRiskTone,
      },
      {
        key: 'requires-verification',
        label: 'Requires Verification',
        value: requiresVerification != null ? formatCurrency(requiresVerification) : '—',
        supporting: requiresVerification != null && requiresVerification > 0
          ? 'Blocked or needs-review findings are carrying approval-gated dollars'
          : 'No approval-gated verification dollars are currently open',
        tone: requiresVerification != null && requiresVerification > 0 ? 'danger' : 'success',
      },
      {
        key: 'open-actions',
        label: 'Open Actions',
        value: formatCompactNumber(rollup.open_document_action_count),
        supporting: `${rollup.unresolved_finding_count} open finding${rollup.unresolved_finding_count === 1 ? '' : 's'} are driving the current queue`,
        tone: rollup.open_document_action_count > 0 ? 'warning' : 'muted',
      },
      {
        key: 'approval-status',
        label: 'Approval Status',
        value: approvalLabel,
        supporting: anomalyCount > 0
          ? `${validatorSummary.critical_count} critical and ${validatorSummary.warning_count} warning finding${anomalyCount === 1 ? '' : 's'} are open`
          : 'No open approval findings for this project',
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
      key: 'open-actions',
      label: 'Open Actions',
      value: formatCompactNumber(rollup.open_document_action_count),
      supporting: `${rollup.unresolved_finding_count} open finding${rollup.unresolved_finding_count === 1 ? '' : 's'} are driving the current queue`,
      tone: rollup.open_document_action_count > 0 ? 'warning' : 'muted',
    },
    {
      key: 'approval-findings',
      label: 'Approval Findings',
      value: formatCompactNumber(anomalyCount),
      supporting: anomalyCount > 0
        ? `${validatorSummary.critical_count} critical and ${validatorSummary.warning_count} warning finding${anomalyCount === 1 ? '' : 's'} are open`
        : 'No open approval findings',
      tone: anomalyTone,
    },
  ];
}

function resolveProjectFacts(
  project: ProjectRecord,
  rollup: ProjectOperationalRollup,
  validatorSummary: ProjectValidatorSummarySnapshot,
): ProjectOverviewFact[] {
  const readiness = validatorSummary.validator_readiness;
  const approvalStatusLabel =
    readiness === 'READY' ? 'Approved'
    : readiness === 'BLOCKED' ? 'Blocked'
    : readiness === 'NEEDS_REVIEW' ? 'Needs Review'
    : 'Not Evaluated';

  return [
    { label: 'Project Code', value: shortProjectId(project) },
    { label: 'Approval Status', value: approvalStatusLabel },
    { label: 'Open Findings', value: formatCompactNumber(validatorSummary.open_count) },
    { label: 'Approval Blockers', value: formatCompactNumber(rollup.blocked_count) },
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

export function resolveProjectDecisionSummary(
  decisions: ProjectDecisionRow[],
  tasks: ProjectTaskRow[],
  members: ProjectMember[],
): ProjectOverviewDecisionCard[] {
  const relatedTaskCountByDecisionId = new Map<string, number>();
  for (const task of tasks) {
    if (!task.decision_id) continue;
    relatedTaskCountByDecisionId.set(
      task.decision_id,
      (relatedTaskCountByDecisionId.get(task.decision_id) ?? 0) + 1,
    );
  }

  const sorted = [...decisions].sort((left, right) => {
    const leftCurrent = DECISION_OPEN_STATUSES.includes(left.status) ? 0 : 1;
    const rightCurrent = DECISION_OPEN_STATUSES.includes(right.status) ? 0 : 1;
    if (leftCurrent !== rightCurrent) return leftCurrent - rightCurrent;

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
    const reason = resolveDecisionReason(decision.details ?? null, decision.summary);
    const primaryAction = resolveDecisionPrimaryAction(decision.details ?? null);
    const metadata: string[] = [];
    if (decision.document_id) metadata.push('1 linked file');
    const relatedTasks = relatedTaskCountByDecisionId.get(decision.id) ?? 0;
    if (relatedTasks > 0) metadata.push(`${relatedTasks} pending action${relatedTasks === 1 ? '' : 's'}`);
    if (decision.confidence != null) metadata.push(`${Math.round(decision.confidence * 100)}% confidence`);

    const assignee = firstRelation(decision.assignee);
    const assigneeLabel = assignee?.display_name?.trim() || memberName(members, decision.assigned_to);

    return {
      id: decision.id,
      href: `/platform/decisions/${decision.id}`,
      title: decision.title || titleize(decision.decision_type),
      status_label: DECISION_STATUS_LABELS[decision.status] ?? titleize(decision.status),
      status_tone: decisionStatusTone(decision),
      freshness_label: relativeTime(decision.last_detected_at ?? decision.created_at),
      reason: reason || 'Decision detail is available in the full record.',
      assignees: assigneeLabel === 'Unassigned' ? [] : [assigneeLabel],
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

  const documentEvents = documents.flatMap((document) => {
    const events: Array<ProjectOverviewAuditItem & { sort_at: string }> = [
      {
        id: `document-created-${document.id}`,
        label: 'Document added',
        detail: document.title ?? document.name,
        timestamp_label: relativeTime(document.created_at),
        tone: 'muted',
        href: buildProjectDocumentHref(document.id, project.id),
        sort_at: document.created_at,
      },
    ];
    if (document.processed_at) {
      events.push({
        id: `document-processed-${document.id}`,
        label: document.processing_status === 'failed' ? 'Document processing failed' : 'Document processed',
        detail: document.title ?? document.name,
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
        detail: 'Project validator completed and recorded a new consistency snapshot.',
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
    const entityTitle = isDecision
      ? decisionTitleById.get(event.entity_id) ?? 'Decision'
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
    const actor = memberName(members, event.changed_by);

    let label = 'Record updated';
    let detail = entityTitle;
    let tone: OverviewTone = 'info';
    let href: string | null = isDecision
      ? `/platform/decisions/${event.entity_id}`
      : isTask
        ? `/platform/workflows/${event.entity_id}`
        : isProject
          ? `/platform/projects/${event.entity_id}`
          : `/platform/documents/${event.entity_id}`;

    switch (event.event_type) {
      case 'created':
        label = isDecision ? 'Decision created' : isTask ? 'Action created' : 'Record created';
        break;
      case 'status_changed':
        label = isDecision ? 'Decision status changed' : isTask ? 'Action status changed' : 'Status changed';
        detail = nextStatus ? `${entityTitle} -> ${titleize(nextStatus)}` : entityTitle;
        tone = auditToneForStatus(nextStatus);
        break;
      case 'assignment_changed':
        label = isDecision ? 'Decision reassigned' : isTask ? 'Action reassigned' : 'Assignment changed';
        detail = `${entityTitle} / ${actor}`;
        tone = 'warning';
        break;
      case 'due_date_changed':
        label = isDecision ? 'Decision due date adjusted' : isTask ? 'Action due date adjusted' : 'Due date adjusted';
        tone = 'muted';
        break;
      case 'document_removed_from_project':
        label = 'Document removed from project';
        detail = entityTitle;
        tone = 'warning';
        href = `/platform/documents/${event.entity_id}`;
        break;
      case 'document_moved_to_project': {
        const fromProject = extractStringValue(event.old_value, 'project_name');
        const toProject = extractStringValue(event.new_value, 'project_name');
        label = 'Document moved to project';
        detail = [entityTitle, fromProject && toProject ? `${fromProject} -> ${toProject}` : toProject]
          .filter(Boolean)
          .join(' / ');
        tone = 'info';
        href = `/platform/documents/${event.entity_id}`;
        break;
      }
      case 'project_archived':
        label = 'Project archived';
        detail = entityTitle;
        tone = 'muted';
        href = `/platform/projects/${event.entity_id}`;
        break;
      case 'project_deleted':
        label = 'Project deleted';
        detail = entityTitle;
        tone = 'danger';
        href = null;
        break;
      default:
        break;
    }

    return {
      id: event.id,
      label,
      detail,
      timestamp_label: relativeTime(event.created_at),
      tone,
      href,
      sort_at: event.created_at,
      validation_run: null,
    };
  });

  return [...documentEvents, ...derivedActivityEvents]
    .sort((left, right) => new Date(right.sort_at).getTime() - new Date(left.sort_at).getTime())
    .slice(0, 8)
    .map((event) => ({
      id: event.id,
      label: event.label,
      detail: event.detail,
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
}): ProjectOverviewModel {
  const {
    project,
    documents,
    decisions,
    tasks,
    documentReviews = [],
    activityEvents,
    members,
  } = params;
  const validatorSummary = resolveProjectValidatorSummary(project);
  const rollup = buildProjectOperationalRollup({
    project,
    documents,
    decisions,
    tasks,
    documentReviews,
    members,
  });
  const exposure = resolveProjectExposure(project, documents, validatorSummary);
  const decisionCards = resolveProjectDecisionSummary(decisions, tasks, members);
  const actionItems = resolveProjectPendingActions(rollup, validatorSummary, project.id);
  const processedDocuments = resolveProjectProcessedDocs(project, documents, rollup);
  const auditItems = resolveProjectAuditEvents(project, documents, decisions, tasks, activityEvents, members);

  return {
    project,
    context_label: 'Operations / Projects',
    title: project.name,
    project_id_label: shortProjectId(project),
    tags: resolveProjectTags(project, documents),
    status: rollup.status,
    validator_status: validatorSummary.status,
    validator_summary: validatorSummary,
    exposure,
    metrics: resolveProjectMetrics(project, rollup, validatorSummary),
    facts: resolveProjectFacts(project, rollup, validatorSummary),
    decisions: decisionCards,
    decision_total: decisions.length,
    decision_empty_state: decisions.length === 0
      ? (documents.length === 0
          ? 'No project documents yet. Upload and process documents to generate a project record.'
          : 'No persisted project decisions are linked right now.')
      : 'All decisions are resolved, dismissed, or superseded.',
    actions: actionItems,
    action_total: rollup.open_document_action_count,
    action_empty_state: documents.length === 0
      ? 'No pending actions because the project has no linked operational records yet.'
      : 'No pending actions remain in the project rollup.',
    documents: processedDocuments,
    document_total: rollup.processed_document_count,
    document_empty_state: documents.length === 0
      ? 'No documents are linked to this project yet.'
      : 'Documents are linked, but none have completed processing yet.',
    audit: auditItems,
    audit_empty_state: documents.length === 0
      ? 'Audit history will appear once project activity starts.'
      : 'Recent audit activity is not available yet for this project.',
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
