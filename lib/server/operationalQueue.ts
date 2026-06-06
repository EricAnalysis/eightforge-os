import type { SupabaseClient } from '@supabase/supabase-js';
import { filterCurrentQueueRecords } from '@/lib/currentWork';
import {
  buildExecutionInspectorHref,
  executionItemBlocksApproval,
  executionItemIsResolvableNow,
  executionItemProjectHref,
  executionItemStatusLabel,
  type ProjectExecutionItemRow,
} from '@/lib/executionItems';
import {
  resolveDecisionPrimaryAction,
  resolveDecisionProjectContext,
  resolveDecisionReason,
} from '@/lib/decisionActions';
import { DECISION_OPEN_STATUSES, TASK_OPEN_STATUSES, isTaskOverdue } from '@/lib/overdue';
import {
  buildProjectOperationalRollup,
  matchesProjectDecision,
  matchesProjectTask,
  parseDocumentExecutionTrace,
  resolveProjectStatus,
  resolveProjectValidatorSummary,
  type ProjectDecisionRow,
  type ProjectDocumentReviewRow,
  type ProjectDocumentRow,
  type ProjectOperationalRollup,
  type ProjectOverviewActionItem,
  type ProjectRecord,
  type ProjectTaskRow,
} from '@/lib/projectOverview';
import { buildValidatorFindingActionsByProjectId } from '@/lib/validator/queueFindingActions';
import type {
  FlowTask,
  NormalizedDecision,
  ReviewErrorType,
} from '@/lib/types/documentIntelligence';
import type { ValidationEvidence, ValidationFinding } from '@/types/validator';

type Relation<T> = T | T[] | null | undefined;

export type OperationalDecisionSeverity = 'critical' | 'high' | 'medium' | 'low';
export type OperationalActionPriority = 'critical' | 'high' | 'medium' | 'low';
export type OperationalReviewStatus =
  | 'not_reviewed'
  | 'in_review'
  | 'approved'
  | 'needs_correction';

export type OperationalDecisionQueueItem = {
  id: string;
  decision_id: string | null;
  decision_type: string;
  project_id: string | null;
  project_label: string | null;
  project_code: string | null;
  document_id: string | null;
  title: string;
  summary: string;
  status: string;
  severity: OperationalDecisionSeverity;
  confidence: number | null;
  review_status: OperationalReviewStatus;
  assigned_to: string | null;
  assigned_to_name: string | null;
  source_document_title: string | null;
  source_document_type: string | null;
  source_refs: string[];
  evidence_summary: string | null;
  deep_link_target: string;
  source_document_target: string | null;
  decision_target: string | null;
  created_at: string;
  detected_at: string | null;
  due_at: string | null;
  kind: 'persisted_decision' | 'trace_decision' | 'execution_item';
  action_mode: 'decision' | 'document_review' | 'execution';
  missing_action: boolean;
  vague_action: boolean;
  blocked: boolean;
};

export type OperationalActionQueueItem = {
  id: string;
  task_id: string | null;
  project_id: string | null;
  project_label: string | null;
  project_code: string | null;
  document_id: string | null;
  decision_id: string | null;
  title: string;
  summary: string;
  instructions: string;
  status: string;
  priority: OperationalActionPriority;
  assigned_to: string | null;
  assigned_to_name: string | null;
  suggested_owner: string | null;
  due_at: string | null;
  source_document_title: string | null;
  source_document_type: string | null;
  deep_link_target: string;
  source_document_target: string | null;
  created_at: string;
  kind:
    | 'persisted_task'
    | 'trace_task'
    | 'decision_action'
    | 'trace_decision_action';
  blocked: boolean;
  is_overdue: boolean;
  is_urgent_unassigned: boolean;
  is_vague: boolean;
};

export type OperationalProjectRollupItem = {
  project: ProjectRecord;
  rollup: ProjectOperationalRollup;
  href: string;
};

export type OperationalDocumentSignal = {
  document_id: string;
  project_id: string | null;
  title: string;
  document_type: string | null;
  review_status: OperationalReviewStatus;
  status_key:
    | 'failed'
    | 'blocked'
    | 'needs_review'
    | 'attention_required'
    | 'operationally_clear';
  status_label: string;
  blocked_count: number;
  unresolved_finding_count: number;
  pending_action_count: number;
  low_trust_mode: 'pdf_fallback' | 'binary_fallback' | null;
  href: string;
};

export type OperationalFeedbackException = {
  id: string;
  decision_id: string;
  decision_title: string;
  decision_severity: string;
  document_id: string | null;
  is_correct: boolean | null;
  feedback_type: string | null;
  disposition: string | null;
  review_error_type: ReviewErrorType | null;
  notes: string | null;
  created_at: string;
  href: string;
};

export type OperationalIntelligenceSummary = {
  open_decisions_count: number;
  open_actions_count: number;
  needs_review_count: number;
  blocked_count: number;
  high_risk_count: number;
  recent_feedback_exception_count: number;
  low_trust_document_count: number;
  recent_feedback_exceptions: OperationalFeedbackException[];
  low_trust_documents: OperationalDocumentSignal[];
  needs_review_documents: OperationalDocumentSignal[];
  blocked_documents: OperationalDocumentSignal[];
};

export type OperationalQueueModel = {
  generated_at: string;
  recent_documents_count: number | null;
  superseded_counts: {
    decisions: number;
    actions: number;
  };
  warnings: string[];
  decisions: OperationalDecisionQueueItem[];
  actions: OperationalActionQueueItem[];
  intelligence: OperationalIntelligenceSummary;
  project_rollups: OperationalProjectRollupItem[];
};

export type OperationalFeedbackRow = {
  id: string;
  decision_id: string;
  is_correct: boolean | null;
  feedback_type: string | null;
  review_error_type: ReviewErrorType | null;
  notes: string | null;
  disposition: string | null;
  created_at: string;
  decisions:
    | {
        id: string;
        title: string;
        severity: string;
        document_id: string | null;
        status: string;
      }
    | Array<{
        id: string;
        title: string;
        severity: string;
        document_id: string | null;
        status: string;
      }>
    | null;
};

type QueueFindingRow = Pick<
  ValidationFinding,
  | 'id'
  | 'project_id'
  | 'rule_id'
  | 'severity'
  | 'status'
  | 'subject_type'
  | 'subject_id'
  | 'field'
  | 'expected'
  | 'actual'
  | 'variance'
  | 'variance_unit'
  | 'blocked_reason'
  | 'decision_eligible'
  | 'action_eligible'
>;

type QueueFindingEvidenceRow = Pick<
  ValidationEvidence,
  | 'finding_id'
  | 'evidence_type'
  | 'source_document_id'
  | 'source_page'
  | 'fact_id'
  | 'record_id'
  | 'field_name'
  | 'field_value'
  | 'note'
>;

function firstRelation<T>(value: Relation<T>): T | null {
  if (!value) return null;
  return Array.isArray(value) ? value[0] ?? null : value;
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

function normalizeText(value: string | null | undefined): string {
  return (value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ');
}

function isProcessedDocument(document: ProjectDocumentRow): boolean {
  return (
    document.processed_at != null ||
    ['extracted', 'decisioned', 'failed'].includes(document.processing_status)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : null;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => nonEmptyString(entry))
    .filter((entry): entry is string => entry != null);
}

function parseProjectContext(
  value: unknown,
): { label: string; project_id: string | null; project_code: string | null } | null {
  if (!isRecord(value)) return null;

  const label = nonEmptyString(value.label) ?? nonEmptyString(value.project_label);
  const projectId = nonEmptyString(value.project_id);
  const projectCode = nonEmptyString(value.project_code);

  if (!label && !projectId && !projectCode) return null;

  return {
    label: label ?? projectCode ?? 'Project',
    project_id: projectId,
    project_code: projectCode,
  };
}

function buildDocumentProjectContext(
  document: ProjectDocumentRow | null,
  projectsById: Map<string, ProjectRecord>,
): { label: string; project_id: string | null; project_code: string | null } | null {
  if (!document?.project_id) return null;
  const project = projectsById.get(document.project_id) ?? null;
  return {
    label: project?.name ?? 'Project',
    project_id: document.project_id,
    project_code: project?.code ?? null,
  };
}

function matchProjectFromContext(
  projects: ProjectRecord[],
  context: { label: string; project_id: string | null; project_code: string | null } | null,
): ProjectRecord | null {
  if (!context) return null;

  return (
    projects.find((project) => project.id === context.project_id) ??
    projects.find(
      (project) =>
        project.code &&
        context.project_code &&
        normalizeText(project.code) === normalizeText(context.project_code),
    ) ??
    projects.find((project) => normalizeText(project.name) === normalizeText(context.label)) ??
    null
  );
}

function resolveProjectIdentity(params: {
  projects: ProjectRecord[];
  projectsById: Map<string, ProjectRecord>;
  document: ProjectDocumentRow | null;
  explicitContext?: { label: string; project_id: string | null; project_code: string | null } | null;
}): {
  project_id: string | null;
  project_label: string | null;
  project_code: string | null;
} {
  const fallbackContext = buildDocumentProjectContext(params.document, params.projectsById);
  const context = params.explicitContext ?? fallbackContext;
  const matchedProject = matchProjectFromContext(params.projects, context);

  return {
    project_id:
      matchedProject?.id ??
      params.document?.project_id ??
      context?.project_id ??
      null,
    project_label:
      matchedProject?.name ??
      context?.label ??
      null,
    project_code:
      matchedProject?.code ??
      context?.project_code ??
      null,
  };
}

function decisionDocument(decision: ProjectDecisionRow): {
  id: string;
  project_id: string | null;
  title: string | null;
  name: string;
  document_type: string | null;
} | null {
  return firstRelation(decision.documents);
}

function taskDocument(task: ProjectTaskRow): {
  id: string;
  project_id: string | null;
  title: string | null;
  name: string;
  document_type: string | null;
} | null {
  return firstRelation(task.documents);
}

function documentTitle(
  document:
    | Pick<ProjectDocumentRow, 'title' | 'name'>
    | Pick<NonNullable<ReturnType<typeof decisionDocument>>, 'title' | 'name'>
    | null,
): string {
  return document?.title?.trim() || document?.name || 'Untitled document';
}

function documentTypeLabel(documentType: string | null | undefined): string | null {
  return typeof documentType === 'string' && documentType.trim().length > 0
    ? titleize(documentType)
    : null;
}

function hasMissingSourceContext(value: unknown): boolean {
  return Array.isArray(value) && value.some((entry) => typeof entry === 'string' && entry.trim().length > 0);
}

function decisionFamilyFromPersisted(decision: ProjectDecisionRow): string | null {
  const family = decision.details?.family;
  return typeof family === 'string' ? family : null;
}

function isBlockedPersistedDecision(decision: ProjectDecisionRow): boolean {
  const family = decisionFamilyFromPersisted(decision);
  if (family === 'mismatch') return true;
  return decision.severity === 'critical';
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

function decisionSeverityFromTrace(decision: NormalizedDecision): OperationalDecisionSeverity {
  if (decision.family === 'mismatch' || decision.severity === 'critical') return 'critical';
  if (decision.family === 'missing' || decision.severity === 'warning') return 'high';
  return 'low';
}

function actionPriorityFromTraceTask(task: FlowTask): OperationalActionPriority {
  if (task.priority === 'high') return 'high';
  if (task.priority === 'medium') return 'medium';
  return 'low';
}

function actionPriorityFromDecisionSeverity(severity: string): OperationalActionPriority {
  if (severity === 'critical') return 'critical';
  if (severity === 'high') return 'high';
  if (severity === 'medium') return 'medium';
  return 'low';
}

function severityRank(severity: string): number {
  switch (severity) {
    case 'critical':
      return 0;
    case 'high':
      return 1;
    case 'medium':
      return 2;
    default:
      return 3;
  }
}

function priorityRank(priority: string): number {
  switch (priority) {
    case 'critical':
      return 0;
    case 'high':
      return 1;
    case 'medium':
      return 2;
    default:
      return 3;
  }
}

function resolveDecisionSourceDocumentId(decision: ProjectDecisionRow | null): string | null {
  if (!decision) return null;
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
  return resolveDecisionSourceDocumentId(decisionById.get(task.decision_id) ?? null);
}

function resolveEvidenceSummary(sourceRefs: string[], factRefs: string[], fallback: string | null): string | null {
  const total = sourceRefs.length + factRefs.length;
  if (total > 0) {
    const firstRef = sourceRefs[0] ?? factRefs[0] ?? null;
    if (firstRef) {
      return total === 1 ? firstRef : `${firstRef} +${total - 1} more refs`;
    }
    return `${total} evidence refs`;
  }

  return fallback;
}

function executionEvidenceHref(params: {
  item: ProjectExecutionItemRow;
  evidence: QueueFindingEvidenceRow[];
}): string | null {
  const primaryEvidence = params.evidence.find((entry) => entry.source_document_id) ?? null;
  if (!primaryEvidence?.source_document_id) {
    return null;
  }

  return buildExecutionInspectorHref({
    projectId: params.item.project_id,
    documentId: primaryEvidence.source_document_id,
    page: primaryEvidence.source_page,
    factId: primaryEvidence.fact_id,
    fieldKey: primaryEvidence.field_name,
    recordId: primaryEvidence.record_id,
    action: 'inspect',
    executionItemId: params.item.id,
    findingId: params.item.source_type === 'validator_finding' ? params.item.source_id : null,
  });
}

function executionItemSummary(item: ProjectExecutionItemRow): string {
  const parts = [item.problem, item.impact].filter((value): value is string => Boolean(value?.trim()));
  return parts.join(' ');
}

function executionPendingActionFromItem(item: ProjectExecutionItemRow): ProjectOverviewActionItem {
  return {
    id: item.id,
    href: executionItemProjectHref(item.project_id, item.id),
    title: item.title,
    due_label: item.status === 'resolved' ? 'Resolved' : executionItemBlocksApproval(item) ? 'Blocking' : 'Resolvable Now',
    due_tone: item.status === 'resolved' ? 'success' : executionItemBlocksApproval(item) ? 'danger' : 'warning',
    assignee_label: 'Unassigned',
    priority_label: titleize(item.severity),
    priority_tone:
      item.severity === 'critical' || item.severity === 'high'
        ? 'danger'
        : item.status === 'resolved'
          ? 'success'
          : 'warning',
    status_label: executionItemStatusLabel(item.status),
    source_document_title: null,
    source_document_type: item.source_type === 'validator_finding' ? 'validator' : item.source_type,
    approval_status:
      item.status === 'resolved'
        ? 'approved'
        : executionItemBlocksApproval(item)
          ? 'blocked'
          : 'needs_review',
    impacted_amount: null,
    at_risk_amount: null,
    requires_verification_amount: null,
    blocked_amount: null,
    next_step: item.required_action,
    expected_value: item.expected_value,
    actual_value: item.actual_value,
    variance_label: item.impact,
  };
}

function isVagueDescription(description: string | null | undefined): boolean {
  const normalized = nonEmptyString(description)
    ?.toLowerCase()
    .replace(/[.!?]+$/g, '')
    .replace(/\s+/g, ' ');

  if (!normalized) return true;

  if (
    normalized === 'review invoice' ||
    normalized === 'check mapping' ||
    normalized === 'validate contract' ||
    normalized === 'investigate issue' ||
    normalized === 'manual review' ||
    normalized === 'review document' ||
    normalized === 'resolve issue' ||
    normalized === 'follow up'
  ) {
    return true;
  }

  if (
    normalized.includes('may require review') ||
    normalized.includes('possible issue') ||
    normalized.includes('further validation needed') ||
    normalized.includes('requires operator review') ||
    normalized.includes('manual review required') ||
    normalized.includes('follow up as needed')
  ) {
    return true;
  }

  const wordCount = normalized.split(' ').length;
  if (/^(review|investigate)\b/.test(normalized) && wordCount <= 4) {
    return true;
  }
  if (/^(check|validate)\b/.test(normalized) && wordCount <= 3) {
    return true;
  }

  return false;
}

function resolveLowTrustExtractionMode(decisions: ProjectDecisionRow[]): 'pdf_fallback' | 'binary_fallback' | null {
  for (const decision of decisions) {
    if (decision.decision_type !== 'extraction_mode') continue;

    const decisionValue = nonEmptyString(decision.details?.decision_value) ?? normalizeText(decision.summary);
    if (decisionValue === 'binary fallback' || decisionValue === 'binary_fallback') {
      return 'binary_fallback';
    }
    if (decisionValue === 'pdf fallback' || decisionValue === 'pdf_fallback') {
      return 'pdf_fallback';
    }
  }

  return null;
}

function resolveDecisionActionTitle(decision: ProjectDecisionRow): string {
  return (
    resolveDecisionPrimaryAction(decision.details ?? null)?.description ??
    decision.title ??
    titleize(decision.decision_type)
  );
}

function resolveTraceDecisionActionTitle(decision: NormalizedDecision): string {
  return (
    decision.primary_action?.description ??
    decision.suggested_actions?.[0]?.description ??
    decision.title
  );
}

function isActivationBasisWorkAuthorizationText(value: string | null | undefined): boolean {
  const normalized = nonEmptyString(value)?.toLowerCase().replace(/[-\s]+/g, ' ');
  return Boolean(
    normalized?.includes('confirm the activation basis before treating the contract as work authorizing'),
  );
}

function isActivationBasisWorkAuthorizationDecision(item: OperationalDecisionQueueItem): boolean {
  return (
    isActivationBasisWorkAuthorizationText(item.title)
    || isActivationBasisWorkAuthorizationText(item.summary)
  );
}

function isActivationBasisWorkAuthorizationAction(item: ProjectOverviewActionItem): boolean {
  return (
    isActivationBasisWorkAuthorizationText(item.title)
    || isActivationBasisWorkAuthorizationText(item.next_step)
  );
}

function buildTraceDecisionType(decision: NormalizedDecision): string {
  return decision.rule_id ?? decision.field_key ?? decision.family ?? decision.id;
}

function buildTaskSummary(task: ProjectTaskRow): string {
  return (
    nonEmptyString(task.description) ??
    nonEmptyString(task.details?.reason) ??
    task.title
  );
}

function buildTaskInstructions(task: ProjectTaskRow): string {
  return (
    nonEmptyString(task.details?.expected_outcome) ??
    nonEmptyString(task.description) ??
    nonEmptyString(task.details?.reason) ??
    task.title
  );
}

function buildActionStatusFromDecision(decision: ProjectDecisionRow): string {
  if (isBlockedPersistedDecision(decision)) return 'blocked';
  if (decision.status === 'in_review') return 'in_progress';
  return 'open';
}

function buildActionStatusFromTraceDecision(decision: NormalizedDecision): string {
  return isBlockedTraceDecision(decision) ? 'blocked' : 'open';
}

function sortDecisionItems(items: OperationalDecisionQueueItem[]): OperationalDecisionQueueItem[] {
  return [...items].sort((left, right) => {
    const blockedDiff = Number(right.blocked) - Number(left.blocked);
    if (blockedDiff !== 0) return blockedDiff;

    const severityDiff = severityRank(left.severity) - severityRank(right.severity);
    if (severityDiff !== 0) return severityDiff;

    return new Date(right.detected_at ?? right.created_at).getTime() - new Date(left.detected_at ?? left.created_at).getTime();
  });
}

function sortActionItems(items: OperationalActionQueueItem[]): OperationalActionQueueItem[] {
  return [...items].sort((left, right) => {
    const blockedDiff = Number(right.blocked) - Number(left.blocked);
    if (blockedDiff !== 0) return blockedDiff;

    const overdueDiff = Number(right.is_overdue) - Number(left.is_overdue);
    if (overdueDiff !== 0) return overdueDiff;

    const priorityDiff = priorityRank(left.priority) - priorityRank(right.priority);
    if (priorityDiff !== 0) return priorityDiff;

    const leftDue = left.due_at ? new Date(left.due_at).getTime() : Number.MAX_SAFE_INTEGER;
    const rightDue = right.due_at ? new Date(right.due_at).getTime() : Number.MAX_SAFE_INTEGER;
    if (leftDue !== rightDue) return leftDue - rightDue;

    return new Date(right.created_at).getTime() - new Date(left.created_at).getTime();
  });
}

function sortDocumentSignals(items: OperationalDocumentSignal[]): OperationalDocumentSignal[] {
  const rank = (statusKey: OperationalDocumentSignal['status_key']) => {
    switch (statusKey) {
      case 'failed':
        return 0;
      case 'blocked':
        return 1;
      case 'needs_review':
        return 2;
      case 'attention_required':
        return 3;
      default:
        return 4;
    }
  };

  return [...items].sort((left, right) => {
    const statusDiff = rank(left.status_key) - rank(right.status_key);
    if (statusDiff !== 0) return statusDiff;

    const rightWeight = right.blocked_count + right.unresolved_finding_count + right.pending_action_count;
    const leftWeight = left.blocked_count + left.unresolved_finding_count + left.pending_action_count;
    if (leftWeight !== rightWeight) return rightWeight - leftWeight;

    return left.title.localeCompare(right.title);
  });
}

function augmentRollupWithValidatorActions(
  rollup: ProjectOperationalRollup,
  validatorActions: readonly ProjectOverviewActionItem[],
): ProjectOperationalRollup {
  if (validatorActions.length === 0) {
    return rollup;
  }

  const blockedFindingCount = validatorActions.filter(
    (action) => action.approval_status === 'blocked',
  ).length;
  const reviewFindingCount = validatorActions.filter(
    (action) => action.approval_status === 'needs_review',
  ).length;

  let status = rollup.status;
  if (blockedFindingCount > 0 && rollup.status.key !== 'blocked') {
    status = {
      key: 'blocked',
      label: 'Blocked',
      tone: 'danger',
      detail: `${blockedFindingCount} validator finding${blockedFindingCount === 1 ? '' : 's'} are blocking approval.`,
      is_clear: false,
    };
  }

  return {
    ...rollup,
    status,
    project_clear: status.is_clear,
    open_document_action_count: rollup.open_document_action_count + validatorActions.length,
    unresolved_finding_count: rollup.unresolved_finding_count + validatorActions.length,
    blocked_count: rollup.blocked_count + blockedFindingCount,
    pending_actions: [...validatorActions, ...rollup.pending_actions],
  };
}

function rollupStatusRank(key: ProjectOperationalRollup['status']['key']): number {
  switch (key) {
    case 'blocked':
      return 0;
    case 'needs_review':
      return 1;
    case 'attention_required':
      return 2;
    case 'operationally_clear':
      return 3;
    default:
      return 3;
  }
}

function executionItemIsUnresolved(item: Pick<ProjectExecutionItemRow, 'status'>): boolean {
  return item.status !== 'resolved';
}

function executionItemIsBlockedTier(item: ProjectExecutionItemRow): boolean {
  if (!executionItemIsUnresolved(item)) return false;
  return executionItemBlocksApproval(item) || item.severity === 'critical';
}

function statusFromUnresolvedExecutionItems(
  unresolvedItems: ProjectExecutionItemRow[],
): ProjectOperationalRollup['status'] | null {
  const blockedTier = unresolvedItems.filter(executionItemIsBlockedTier);

  if (blockedTier.length > 0) {
    return {
      key: 'blocked',
      label: 'Blocked',
      tone: 'danger',
      detail: `${blockedTier.length} execution item${blockedTier.length === 1 ? '' : 's'} block approval or are critical.`,
      is_clear: false,
    };
  }

  return null;
}

function mergeOperationalRollupStatus(
  base: ProjectOperationalRollup['status'],
  exec: ProjectOperationalRollup['status'] | null,
): ProjectOperationalRollup['status'] {
  if (!exec) return base;
  const baseRank = rollupStatusRank(base.key);
  const execRank = rollupStatusRank(exec.key);
  if (execRank < baseRank) return exec;
  if (execRank > baseRank) return base;
  return {
    ...base,
    detail: [base.detail, exec.detail].filter(Boolean).join(' '),
    is_clear: false,
  };
}

function suppressApprovedActivationBasisActions(
  rollup: ProjectOperationalRollup,
): ProjectOperationalRollup {
  if (rollup.status.label !== 'Approved') {
    return rollup;
  }

  const pendingActions = rollup.pending_actions.filter(
    (action) => !isActivationBasisWorkAuthorizationAction(action),
  );
  const suppressedCount = rollup.pending_actions.length - pendingActions.length;

  if (suppressedCount === 0) {
    return rollup;
  }

  return {
    ...rollup,
    open_document_action_count: Math.max(0, rollup.open_document_action_count - suppressedCount),
    unresolved_finding_count: Math.max(0, rollup.unresolved_finding_count - suppressedCount),
    pending_actions: pendingActions,
  };
}

/**
 * Merges execution-item queue data into a project rollup without discarding
 * document, trace, or validator-derived operational status (Command Center shaping).
 */
export function mergeProjectRollupWithExecutionItems(params: {
  rollup: ProjectOperationalRollup;
  unresolvedItems: ProjectExecutionItemRow[];
  pendingExecutionActions: ProjectOverviewActionItem[];
}): ProjectOperationalRollup {
  const { rollup, unresolvedItems, pendingExecutionActions } = params;
  const execStatus = statusFromUnresolvedExecutionItems(unresolvedItems);
  const mergedStatus = mergeOperationalRollupStatus(rollup.status, execStatus);
  const blockedTierCount = unresolvedItems.filter(executionItemIsBlockedTier).length;

  return suppressApprovedActivationBasisActions({
    ...rollup,
    status: mergedStatus,
    project_clear: mergedStatus.is_clear,
    open_document_action_count: rollup.open_document_action_count + unresolvedItems.length,
    unresolved_finding_count: rollup.unresolved_finding_count + unresolvedItems.length,
    blocked_count: rollup.blocked_count + blockedTierCount,
    pending_actions: [...pendingExecutionActions, ...rollup.pending_actions],
  });
}

export function buildOperationalQueueModel(params: {
  projects: ProjectRecord[];
  documents: ProjectDocumentRow[];
  decisions: ProjectDecisionRow[];
  tasks: ProjectTaskRow[];
  documentReviews?: ProjectDocumentReviewRow[];
  feedback?: OperationalFeedbackRow[];
  validatorFindingActionsByProjectId?: Map<string, ProjectOverviewActionItem[]>;
  recentDocumentsCount?: number | null;
  supersededCounts?: {
    decisions: number;
    actions: number;
  };
  warnings?: string[];
}): OperationalQueueModel {
  const {
    projects,
    documents,
    decisions,
    tasks,
    documentReviews = [],
    feedback = [],
    validatorFindingActionsByProjectId = new Map<string, ProjectOverviewActionItem[]>(),
    recentDocumentsCount = null,
    supersededCounts = { decisions: 0, actions: 0 },
    warnings = [],
  } = params;

  const projectsById = new Map(projects.map((project) => [project.id, project]));
  const documentsById = new Map(documents.map((document) => [document.id, document]));
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
      const current = openDecisionsByDocumentId.get(documentId) ?? [];
      current.push(decision);
      openDecisionsByDocumentId.set(documentId, current);
    } else {
      projectLevelOpenDecisions.push(decision);
    }
  }

  for (const task of openTasks) {
    const documentId = resolveTaskSourceDocumentId(task, decisionById);
    if (documentId) {
      const current = openTasksByDocumentId.get(documentId) ?? [];
      current.push(task);
      openTasksByDocumentId.set(documentId, current);
    } else {
      projectLevelOpenTasks.push(task);
    }
  }

  const decisionItems: OperationalDecisionQueueItem[] = [];
  const actionItems: OperationalActionQueueItem[] = [];
  const documentSignals: OperationalDocumentSignal[] = [];
  const processedDocuments = documents.filter(isProcessedDocument);

  for (const document of processedDocuments) {
    const trace = parseDocumentExecutionTrace(document.intelligence_trace ?? null);
    const persistedDocumentDecisions = openDecisionsByDocumentId.get(document.id) ?? [];
    const persistedDocumentTasks = openTasksByDocumentId.get(document.id) ?? [];
    const persistedTaskDecisionIds = new Set(
      persistedDocumentTasks
        .map((task) => task.decision_id)
        .filter((decisionId): decisionId is string => Boolean(decisionId)),
    );
    const traceDecisions = (trace?.decisions ?? []).filter(
      (decision) => decision.family !== 'confirmed' && !currentDecisionIds.has(decision.id),
    );
    const traceTasks = (trace?.flow_tasks ?? []).filter(
      (task) => !currentTaskIds.has(task.id),
    );
    const traceTaskDecisionIds = new Set(
      traceTasks.flatMap((task) => task.source_decision_ids ?? []),
    );
    const reviewStatus = reviewStatusByDocumentId.get(document.id) ?? 'not_reviewed';
    const explicitDocumentContext = buildDocumentProjectContext(document, projectsById);
    const documentProjectIdentity = resolveProjectIdentity({
      projects,
      projectsById,
      document,
      explicitContext: explicitDocumentContext,
    });
    const documentHref = `/platform/documents/${document.id}`;
    const documentTitleLabel = documentTitle(document);
    const documentType = documentTypeLabel(document.document_type);
    let documentPendingActionCount = 0;

    for (const decision of persistedDocumentDecisions) {
      const explicitContext = resolveDecisionProjectContext(
        decision.details ?? null,
        explicitDocumentContext,
      );
      const projectIdentity = resolveProjectIdentity({
        projects,
        projectsById,
        document,
        explicitContext: explicitContext
          ? {
              label: explicitContext.label,
              project_id: explicitContext.project_id ?? null,
              project_code: explicitContext.project_code ?? null,
            }
          : explicitDocumentContext,
      });
      const sourceRefs = stringArray(decision.details?.source_refs);
      const factRefs = stringArray(decision.details?.fact_refs);
      const evidenceRefs = stringArray(decision.details?.evidence_refs);
      const summary = resolveDecisionReason(decision.details ?? null, decision.summary);
      const primaryAction = resolveDecisionPrimaryAction(decision.details ?? null);

      decisionItems.push({
        id: decision.id,
        decision_id: decision.id,
        decision_type: decision.decision_type,
        project_id: projectIdentity.project_id,
        project_label: projectIdentity.project_label,
        project_code: projectIdentity.project_code,
        document_id: document.id,
        title: decision.title,
        summary,
        status: decision.status,
        severity: decision.severity as OperationalDecisionSeverity,
        confidence: decision.confidence ?? null,
        review_status: reviewStatus,
        assigned_to: decision.assigned_to ?? null,
        assigned_to_name: firstRelation(decision.assignee)?.display_name ?? null,
        source_document_title: documentTitleLabel,
        source_document_type: documentType,
        source_refs: [...evidenceRefs, ...sourceRefs, ...factRefs],
        evidence_summary: resolveEvidenceSummary([...evidenceRefs, ...sourceRefs], factRefs, summary || null),
        deep_link_target: `/platform/decisions/${decision.id}`,
        source_document_target: documentHref,
        decision_target: `/platform/decisions/${decision.id}`,
        created_at: decision.created_at,
        detected_at: decision.last_detected_at ?? decision.created_at,
        due_at: decision.due_at ?? null,
        kind: 'persisted_decision',
        action_mode: 'decision',
        missing_action: primaryAction == null,
        vague_action: primaryAction ? isVagueDescription(primaryAction.description) : false,
        blocked: isBlockedPersistedDecision(decision),
      });
    }

    for (const decision of traceDecisions) {
      const sourceRefs = decision.source_refs ?? [];
      const factRefs = decision.fact_refs ?? [];
      const summary = decision.reason ?? decision.detail ?? decision.title;
      const primaryAction = decision.primary_action ?? null;

      decisionItems.push({
        id: `trace-decision:${document.id}:${decision.id}`,
        decision_id: null,
        decision_type: buildTraceDecisionType(decision),
        project_id: documentProjectIdentity.project_id,
        project_label: documentProjectIdentity.project_label,
        project_code: documentProjectIdentity.project_code,
        document_id: document.id,
        title: decision.title,
        summary,
        status: 'open',
        severity: decisionSeverityFromTrace(decision),
        confidence: decision.confidence ?? null,
        review_status: reviewStatus,
        assigned_to: null,
        assigned_to_name: null,
        source_document_title: documentTitleLabel,
        source_document_type: documentType,
        source_refs: [...sourceRefs, ...factRefs],
        evidence_summary: resolveEvidenceSummary(sourceRefs, factRefs, summary || null),
        deep_link_target: documentHref,
        source_document_target: documentHref,
        decision_target: null,
        created_at: document.processed_at ?? document.created_at,
        detected_at: trace?.generated_at ?? document.processed_at ?? document.created_at,
        due_at: null,
        kind: 'trace_decision',
        action_mode: 'document_review',
        missing_action: primaryAction == null,
        vague_action: primaryAction ? isVagueDescription(primaryAction.description) : false,
        blocked: isBlockedTraceDecision(decision),
      });
    }

    for (const task of persistedDocumentTasks) {
      const linkedDecision = task.decision_id ? decisionById.get(task.decision_id) ?? null : null;
      const explicitTaskContext =
        resolveDecisionProjectContext(linkedDecision?.details ?? null, explicitDocumentContext) ??
        parseProjectContext(task.details?.project_context) ??
        parseProjectContext(task.source_metadata?.project_context);
      const projectIdentity = resolveProjectIdentity({
        projects,
        projectsById,
        document,
        explicitContext: explicitTaskContext
          ? {
              label: explicitTaskContext.label,
              project_id: explicitTaskContext.project_id ?? null,
              project_code: explicitTaskContext.project_code ?? null,
            }
          : explicitDocumentContext,
      });

      actionItems.push({
        id: task.id,
        task_id: task.id,
        project_id: projectIdentity.project_id,
        project_label: projectIdentity.project_label,
        project_code: projectIdentity.project_code,
        document_id: document.id,
        decision_id: task.decision_id ?? null,
        title: task.title,
        summary: buildTaskSummary(task),
        instructions: buildTaskInstructions(task),
        status: task.status,
        priority: task.priority as OperationalActionPriority,
        assigned_to: task.assigned_to ?? null,
        assigned_to_name: firstRelation(task.assignee)?.display_name ?? null,
        suggested_owner: nonEmptyString(task.details?.suggested_owner) ?? null,
        due_at: task.due_at ?? null,
        source_document_title: documentTitleLabel,
        source_document_type: documentType,
        deep_link_target: `/platform/workflows/${task.id}`,
        source_document_target: documentHref,
        created_at: task.created_at,
        kind: 'persisted_task',
        blocked: task.status === 'blocked',
        is_overdue: isTaskOverdue(task.due_at, task.status),
        is_urgent_unassigned:
          !task.assigned_to &&
          (task.priority === 'critical' || task.priority === 'high'),
        is_vague: isVagueDescription(task.title) && isVagueDescription(task.description),
      });
      documentPendingActionCount += 1;
    }

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

    for (const task of traceTasks) {
      const blockedFromSource = task.source_decision_ids.some(
        (decisionId) =>
          blockedPersistedDecisionIds.has(decisionId) ||
          blockedTraceDecisionIds.has(decisionId),
      );

      actionItems.push({
        id: `trace-task:${document.id}:${task.id}`,
        task_id: null,
        project_id: documentProjectIdentity.project_id,
        project_label: documentProjectIdentity.project_label,
        project_code: documentProjectIdentity.project_code,
        document_id: document.id,
        decision_id: task.source_decision_ids[0] ?? null,
        title: task.title,
        summary: task.expected_outcome,
        instructions: task.expected_outcome,
        status: blockedFromSource ? 'blocked' : 'open',
        priority: actionPriorityFromTraceTask(task),
        assigned_to: null,
        assigned_to_name: null,
        suggested_owner: nonEmptyString(task.suggested_owner) ?? null,
        due_at: null,
        source_document_title: documentTitleLabel,
        source_document_type: documentType,
        deep_link_target: documentHref,
        source_document_target: documentHref,
        created_at: document.processed_at ?? document.created_at,
        kind: 'trace_task',
        blocked: blockedFromSource,
        is_overdue: false,
        is_urgent_unassigned: blockedFromSource || task.priority === 'high',
        is_vague: isVagueDescription(task.title) && isVagueDescription(task.expected_outcome),
      });
      documentPendingActionCount += 1;
    }

    for (const decision of persistedDocumentDecisions) {
      if (persistedTaskDecisionIds.has(decision.id)) continue;

      const explicitContext = resolveDecisionProjectContext(
        decision.details ?? null,
        explicitDocumentContext,
      );
      const projectIdentity = resolveProjectIdentity({
        projects,
        projectsById,
        document,
        explicitContext: explicitContext
          ? {
              label: explicitContext.label,
              project_id: explicitContext.project_id ?? null,
              project_code: explicitContext.project_code ?? null,
            }
          : explicitDocumentContext,
      });
      const primaryAction = resolveDecisionPrimaryAction(decision.details ?? null);
      const instructions =
        primaryAction?.expected_outcome ??
        resolveDecisionReason(decision.details ?? null, decision.summary) ??
        decision.title;

      actionItems.push({
        id: `decision-action:${decision.id}`,
        task_id: null,
        project_id: projectIdentity.project_id,
        project_label: projectIdentity.project_label,
        project_code: projectIdentity.project_code,
        document_id: document.id,
        decision_id: decision.id,
        title: resolveDecisionActionTitle(decision),
        summary: resolveDecisionReason(decision.details ?? null, decision.summary) ?? decision.title,
        instructions,
        status: buildActionStatusFromDecision(decision),
        priority: actionPriorityFromDecisionSeverity(decision.severity),
        assigned_to: decision.assigned_to ?? null,
        assigned_to_name: firstRelation(decision.assignee)?.display_name ?? null,
        suggested_owner: null,
        due_at: decision.due_at ?? null,
        source_document_title: documentTitleLabel,
        source_document_type: documentType,
        deep_link_target: `/platform/decisions/${decision.id}`,
        source_document_target: documentHref,
        created_at: decision.last_detected_at ?? decision.created_at,
        kind: 'decision_action',
        blocked: isBlockedPersistedDecision(decision),
        is_overdue: isTaskOverdue(decision.due_at, buildActionStatusFromDecision(decision)),
        is_urgent_unassigned:
          !decision.assigned_to &&
          (decision.severity === 'critical' || decision.severity === 'high'),
        is_vague: isVagueDescription(resolveDecisionActionTitle(decision)) && isVagueDescription(instructions),
      });
      documentPendingActionCount += 1;
    }

    for (const decision of traceDecisions) {
      if (traceTaskDecisionIds.has(decision.id)) continue;

      const primaryAction = decision.primary_action ?? null;
      const instructions =
        primaryAction?.expected_outcome ??
        decision.reason ??
        decision.detail ??
        decision.title;

      actionItems.push({
        id: `trace-decision-action:${document.id}:${decision.id}`,
        task_id: null,
        project_id: documentProjectIdentity.project_id,
        project_label: documentProjectIdentity.project_label,
        project_code: documentProjectIdentity.project_code,
        document_id: document.id,
        decision_id: null,
        title: resolveTraceDecisionActionTitle(decision),
        summary: decision.reason ?? decision.detail ?? decision.title,
        instructions,
        status: buildActionStatusFromTraceDecision(decision),
        priority: actionPriorityFromDecisionSeverity(decisionSeverityFromTrace(decision)),
        assigned_to: null,
        assigned_to_name: null,
        suggested_owner: primaryAction?.target_label ?? null,
        due_at: null,
        source_document_title: documentTitleLabel,
        source_document_type: documentType,
        deep_link_target: documentHref,
        source_document_target: documentHref,
        created_at: trace?.generated_at ?? document.processed_at ?? document.created_at,
        kind: 'trace_decision_action',
        blocked: isBlockedTraceDecision(decision),
        is_overdue: false,
        is_urgent_unassigned: isBlockedTraceDecision(decision) || decision.severity === 'critical',
        is_vague: isVagueDescription(resolveTraceDecisionActionTitle(decision)) && isVagueDescription(instructions),
      });
      documentPendingActionCount += 1;
    }

    const documentBlockedCount =
      persistedDocumentTasks.filter((task) => task.status === 'blocked').length +
      persistedDocumentDecisions.filter(isBlockedPersistedDecision).length +
      traceDecisions.filter(isBlockedTraceDecision).length;
    const documentUnresolvedFindingCount =
      persistedDocumentDecisions.length + traceDecisions.length;
    const documentMissingSupportCount =
      persistedDocumentDecisions.filter(isMissingSupportPersistedDecision).length +
      traceDecisions.filter(isMissingSupportTraceDecision).length;
    const lowTrustMode = resolveLowTrustExtractionMode(
      currentDecisions.filter((decision) => resolveDecisionSourceDocumentId(decision) === document.id),
    );
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

    let statusKey: OperationalDocumentSignal['status_key'];
    let statusLabel: string;

    if (document.processing_status === 'failed') {
      statusKey = 'failed';
      statusLabel = 'Failed';
    } else if (documentBlockedCount > 0) {
      statusKey = 'blocked';
      statusLabel = 'Blocked';
    } else if (documentNeedsReview) {
      statusKey = 'needs_review';
      statusLabel = 'Needs review';
    } else if (documentPendingActionCount > 0 || documentUnresolvedFindingCount > 0) {
      statusKey = 'attention_required';
      statusLabel = 'Attention required';
    } else {
      statusKey = 'operationally_clear';
      statusLabel = 'Operationally clear';
    }

    documentSignals.push({
      document_id: document.id,
      project_id: documentProjectIdentity.project_id,
      title: documentTitleLabel,
      document_type: document.document_type ?? null,
      review_status: reviewStatus,
      status_key: statusKey,
      status_label: statusLabel,
      blocked_count: documentBlockedCount,
      unresolved_finding_count: documentUnresolvedFindingCount,
      pending_action_count: documentPendingActionCount,
      low_trust_mode: lowTrustMode,
      href: documentHref,
    });
  }

  const decisionIdsWithOpenTasks = new Set(
    projectLevelOpenTasks
      .map((task) => task.decision_id)
      .filter((decisionId): decisionId is string => Boolean(decisionId)),
  );

  for (const task of projectLevelOpenTasks) {
    const linkedDecision = task.decision_id ? decisionById.get(task.decision_id) ?? null : null;
    const linkedDocumentId = resolveTaskSourceDocumentId(task, decisionById);
    const linkedDocument = linkedDocumentId ? documentsById.get(linkedDocumentId) ?? null : null;
    const decisionContext = linkedDecision
      ? resolveDecisionProjectContext(
          linkedDecision.details ?? null,
          buildDocumentProjectContext(linkedDocument, projectsById),
        )
      : null;
    const taskContext =
      decisionContext ??
      parseProjectContext(task.details?.project_context) ??
      parseProjectContext(task.source_metadata?.project_context);
    const projectIdentity = resolveProjectIdentity({
      projects,
      projectsById,
      document: linkedDocument,
      explicitContext: taskContext
        ? {
            label: taskContext.label,
            project_id: taskContext.project_id ?? null,
            project_code: taskContext.project_code ?? null,
          }
        : null,
    });

    actionItems.push({
      id: task.id,
      task_id: task.id,
      project_id: projectIdentity.project_id,
      project_label: projectIdentity.project_label,
      project_code: projectIdentity.project_code,
      document_id: linkedDocument?.id ?? null,
      decision_id: task.decision_id ?? null,
      title: task.title,
      summary: buildTaskSummary(task),
      instructions: buildTaskInstructions(task),
      status: task.status,
      priority: task.priority as OperationalActionPriority,
      assigned_to: task.assigned_to ?? null,
      assigned_to_name: firstRelation(task.assignee)?.display_name ?? null,
      suggested_owner: nonEmptyString(task.details?.suggested_owner) ?? null,
      due_at: task.due_at ?? null,
      source_document_title: linkedDocument ? documentTitle(linkedDocument) : 'Project record',
      source_document_type: linkedDocument ? documentTypeLabel(linkedDocument.document_type) : null,
      deep_link_target: `/platform/workflows/${task.id}`,
      source_document_target: linkedDocument ? `/platform/documents/${linkedDocument.id}` : null,
      created_at: task.created_at,
      kind: 'persisted_task',
      blocked: task.status === 'blocked',
      is_overdue: isTaskOverdue(task.due_at, task.status),
      is_urgent_unassigned:
        !task.assigned_to &&
        (task.priority === 'critical' || task.priority === 'high'),
      is_vague: isVagueDescription(task.title) && isVagueDescription(task.description),
    });
  }

  for (const decision of projectLevelOpenDecisions) {
    const explicitContext = resolveDecisionProjectContext(decision.details ?? null);
    const projectIdentity = resolveProjectIdentity({
      projects,
      projectsById,
      document: null,
      explicitContext: explicitContext
        ? {
            label: explicitContext.label,
            project_id: explicitContext.project_id ?? null,
            project_code: explicitContext.project_code ?? null,
          }
        : null,
    });
    const sourceDocumentId = resolveDecisionSourceDocumentId(decision);
    const sourceDocument = sourceDocumentId ? documentsById.get(sourceDocumentId) ?? null : null;
    const sourceDocumentTarget = sourceDocument ? `/platform/documents/${sourceDocument.id}` : null;
    const sourceDocumentTitle = sourceDocument ? documentTitle(sourceDocument) : 'Project record';
    const sourceDocumentType = sourceDocument ? documentTypeLabel(sourceDocument.document_type) : null;
    const summary = resolveDecisionReason(decision.details ?? null, decision.summary);
    const primaryAction = resolveDecisionPrimaryAction(decision.details ?? null);

    decisionItems.push({
      id: decision.id,
      decision_id: decision.id,
      decision_type: decision.decision_type,
      project_id: projectIdentity.project_id,
      project_label: projectIdentity.project_label,
      project_code: projectIdentity.project_code,
      document_id: sourceDocument?.id ?? null,
      title: decision.title,
      summary,
      status: decision.status,
      severity: decision.severity as OperationalDecisionSeverity,
      confidence: decision.confidence ?? null,
      review_status: reviewStatusByDocumentId.get(sourceDocument?.id ?? '') ?? 'not_reviewed',
      assigned_to: decision.assigned_to ?? null,
      assigned_to_name: firstRelation(decision.assignee)?.display_name ?? null,
      source_document_title: sourceDocumentTitle,
      source_document_type: sourceDocumentType,
      source_refs: [
        ...stringArray(decision.details?.evidence_refs),
        ...stringArray(decision.details?.source_refs),
        ...stringArray(decision.details?.fact_refs),
      ],
      evidence_summary: resolveEvidenceSummary(
        [
          ...stringArray(decision.details?.evidence_refs),
          ...stringArray(decision.details?.source_refs),
        ],
        stringArray(decision.details?.fact_refs),
        summary || null,
      ),
      deep_link_target: `/platform/decisions/${decision.id}`,
      source_document_target: sourceDocumentTarget,
      decision_target: `/platform/decisions/${decision.id}`,
      created_at: decision.created_at,
      detected_at: decision.last_detected_at ?? decision.created_at,
      due_at: decision.due_at ?? null,
      kind: 'persisted_decision',
      action_mode: 'decision',
      missing_action: primaryAction == null,
      vague_action: primaryAction ? isVagueDescription(primaryAction.description) : false,
      blocked: isBlockedPersistedDecision(decision),
    });

    if (decisionIdsWithOpenTasks.has(decision.id)) continue;

    actionItems.push({
      id: `decision-action:${decision.id}`,
      task_id: null,
      project_id: projectIdentity.project_id,
      project_label: projectIdentity.project_label,
      project_code: projectIdentity.project_code,
      document_id: sourceDocument?.id ?? null,
      decision_id: decision.id,
      title: resolveDecisionActionTitle(decision),
      summary: summary || decision.title,
      instructions:
        resolveDecisionPrimaryAction(decision.details ?? null)?.expected_outcome ??
        summary ??
        decision.title,
      status: buildActionStatusFromDecision(decision),
      priority: actionPriorityFromDecisionSeverity(decision.severity),
      assigned_to: decision.assigned_to ?? null,
      assigned_to_name: firstRelation(decision.assignee)?.display_name ?? null,
      suggested_owner: null,
      due_at: decision.due_at ?? null,
      source_document_title: sourceDocumentTitle,
      source_document_type: sourceDocumentType,
      deep_link_target: `/platform/decisions/${decision.id}`,
      source_document_target: sourceDocumentTarget,
      created_at: decision.last_detected_at ?? decision.created_at,
      kind: 'decision_action',
      blocked: isBlockedPersistedDecision(decision),
      is_overdue: isTaskOverdue(decision.due_at, buildActionStatusFromDecision(decision)),
      is_urgent_unassigned:
        !decision.assigned_to &&
        (decision.severity === 'critical' || decision.severity === 'high'),
      is_vague:
        isVagueDescription(resolveDecisionActionTitle(decision)) &&
        isVagueDescription(
          resolveDecisionPrimaryAction(decision.details ?? null)?.expected_outcome ?? summary,
        ),
    });
  }

  const sortedDecisions = sortDecisionItems(decisionItems);
  const sortedActions = sortActionItems(actionItems);
  const sortedSignals = sortDocumentSignals(documentSignals);

  const projectRollups = projects.map((project) => {
    const scopedDocuments = documents.filter((document) => document.project_id === project.id);
    const scopedDocumentIds = new Set(scopedDocuments.map((document) => document.id));
    const scopedDecisions = currentDecisions.filter((decision) =>
      (resolveDecisionSourceDocumentId(decision) != null &&
        scopedDocumentIds.has(resolveDecisionSourceDocumentId(decision) as string)) ||
      matchesProjectDecision(decision, project),
    );
    const scopedDecisionIds = new Set(scopedDecisions.map((decision) => decision.id));
    const scopedTasks = currentTasks.filter((task) =>
      (resolveTaskSourceDocumentId(task, decisionById) != null &&
        scopedDocumentIds.has(resolveTaskSourceDocumentId(task, decisionById) as string)) ||
      (task.decision_id != null && scopedDecisionIds.has(task.decision_id)) ||
      matchesProjectTask(task, project, scopedDecisionIds),
    );
    const scopedDocumentReviews = documentReviews.filter((review) =>
      scopedDocumentIds.has(review.document_id),
    );

    const baseRollup = buildProjectOperationalRollup({
      project,
      documents: scopedDocuments,
      decisions: scopedDecisions,
      tasks: scopedTasks,
      documentReviews: scopedDocumentReviews,
    });
    const validatorSummary = resolveProjectValidatorSummary(project, scopedDocuments, undefined, scopedDecisions);
    const canonicalStatus = resolveProjectStatus(
      project,
      baseRollup,
      validatorSummary,
      scopedDecisions.filter((decision) => DECISION_OPEN_STATUSES.includes(decision.status)).length,
    );
    const canonicalRollup = {
      ...baseRollup,
      status: canonicalStatus,
      project_clear: canonicalStatus.is_clear,
    };

    return {
      project,
      rollup: augmentRollupWithValidatorActions(
        canonicalRollup,
        validatorFindingActionsByProjectId.get(project.id) ?? [],
      ),
      href: `/platform/projects/${project.id}`,
    };
  });

  const recentFeedbackExceptions = feedback
    .filter((row) =>
      row.is_correct === false ||
      row.review_error_type != null ||
      row.feedback_type === 'needs_review' ||
      row.disposition === 'reject' ||
      row.disposition === 'escalate',
    )
    .map((row) => {
      const linkedDecision = firstRelation(row.decisions);
      return {
        id: row.id,
        decision_id: row.decision_id,
        decision_title: linkedDecision?.title ?? 'Decision',
        decision_severity: linkedDecision?.severity ?? 'medium',
        document_id: linkedDecision?.document_id ?? null,
        is_correct: row.is_correct,
        feedback_type: row.feedback_type,
        disposition: row.disposition,
        review_error_type: row.review_error_type,
        notes: row.notes,
        created_at: row.created_at,
        href: `/platform/decisions/${row.decision_id}`,
      };
    })
    .sort((left, right) => new Date(right.created_at).getTime() - new Date(left.created_at).getTime())
    .slice(0, 12);

  const intelligence: OperationalIntelligenceSummary = {
    open_decisions_count: sortedDecisions.length,
    open_actions_count: sortedActions.length,
    needs_review_count: sortedSignals.filter((signal) => signal.status_key === 'needs_review').length,
    blocked_count:
      sortedDecisions.filter((decision) => decision.blocked).length +
      sortedActions.filter((action) => action.blocked).length,
    high_risk_count: sortedDecisions.filter(
      (decision) => decision.severity === 'critical' || decision.severity === 'high',
    ).length,
    recent_feedback_exception_count: recentFeedbackExceptions.length,
    low_trust_document_count: sortedSignals.filter((signal) => signal.low_trust_mode != null).length,
    recent_feedback_exceptions: recentFeedbackExceptions,
    low_trust_documents: sortedSignals
      .filter((signal) => signal.low_trust_mode != null)
      .slice(0, 12),
    needs_review_documents: sortedSignals
      .filter((signal) => signal.status_key === 'needs_review')
      .slice(0, 12),
    blocked_documents: sortedSignals
      .filter((signal) => signal.status_key === 'blocked' || signal.status_key === 'failed')
      .slice(0, 12),
  };

  return {
    generated_at: new Date().toISOString(),
    recent_documents_count: recentDocumentsCount,
    superseded_counts: supersededCounts,
    warnings,
    decisions: sortedDecisions,
    actions: sortedActions,
    intelligence,
    project_rollups: projectRollups.sort((left, right) => {
      const statusRank = (status: ProjectOperationalRollup['status']['key']) => {
        if (status === 'blocked') return 0;
        if (status === 'needs_review') return 1;
        if (status === 'attention_required') return 2;
        return 3;
      };

      const leftRank = statusRank(left.rollup.status.key);
      const rightRank = statusRank(right.rollup.status.key);
      if (leftRank !== rightRank) return leftRank - rightRank;

      const leftWeight =
        left.rollup.blocked_count +
        left.rollup.needs_review_document_count +
        left.rollup.open_document_action_count +
        left.rollup.unresolved_finding_count;
      const rightWeight =
        right.rollup.blocked_count +
        right.rollup.needs_review_document_count +
        right.rollup.open_document_action_count +
        right.rollup.unresolved_finding_count;
      if (leftWeight !== rightWeight) return rightWeight - leftWeight;

      return left.project.name.localeCompare(right.project.name);
    }),
  };
}

export async function loadOperationalQueueModel(params: {
  admin: SupabaseClient;
  organizationId: string;
}): Promise<OperationalQueueModel> {
  const { admin, organizationId } = params;
  const warnings: string[] = [];

  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

  const [
    decisionsResult,
    tasksResult,
    projectsResult,
    documentsResult,
    executionItemsResult,
    reviewsResult,
    feedbackResult,
    recentDocumentsResult,
  ] = await Promise.all([
    admin
      .from('decisions')
      .select(
        'id, document_id, project_id, decision_type, title, summary, severity, status, confidence, last_detected_at, created_at, due_at, assigned_to, details, assignee:user_profiles!assigned_to(id, display_name), documents(id, project_id, title, name, document_type)',
      )
      .eq('organization_id', organizationId)
      .in('status', [...DECISION_OPEN_STATUSES])
      .order('last_detected_at', { ascending: false }),
    admin
      .from('workflow_tasks')
      .select(
        'id, decision_id, document_id, task_type, title, description, priority, status, created_at, updated_at, due_at, assigned_to, details, source_metadata, assignee:user_profiles!assigned_to(id, display_name), documents(id, project_id, title, name, document_type)',
      )
      .eq('organization_id', organizationId)
      .in('status', [...TASK_OPEN_STATUSES])
      .order('created_at', { ascending: false }),
    admin
      .from('projects')
      .select('id, name, code, status, created_at, validation_status, validation_summary_json')
      .eq('organization_id', organizationId)
      .order('created_at', { ascending: false }),
    admin
      .from('documents')
      .select(
        'id, title, name, document_type, domain, processing_status, processing_error, created_at, processed_at, project_id, intelligence_trace',
      )
      .eq('organization_id', organizationId)
      .order('created_at', { ascending: false }),
    admin
      .from('execution_items')
      .select('*')
      .eq('organization_id', organizationId)
      .order('updated_at', { ascending: false }),
    admin
      .from('document_reviews')
      .select('document_id, status, reviewed_at')
      .eq('organization_id', organizationId),
    admin
      .from('decision_feedback')
      .select(
        'id, decision_id, is_correct, feedback_type, review_error_type, notes, disposition, created_at, decisions(id, title, severity, document_id, status)',
      )
      .eq('organization_id', organizationId)
      .order('created_at', { ascending: false })
      .limit(30),
    admin
      .from('documents')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', organizationId)
      .gte('created_at', sevenDaysAgo.toISOString()),
  ]);

  if (decisionsResult.error) {
    throw new Error(`Failed to load decisions: ${decisionsResult.error.message}`);
  }
  if (tasksResult.error) {
    throw new Error(`Failed to load actions: ${tasksResult.error.message}`);
  }
  if (projectsResult.error) {
    throw new Error(`Failed to load projects: ${projectsResult.error.message}`);
  }
  if (documentsResult.error) {
    throw new Error(`Failed to load documents: ${documentsResult.error.message}`);
  }
  if (executionItemsResult.error) {
    throw new Error(`Failed to load execution items: ${executionItemsResult.error.message}`);
  }

  if (reviewsResult.error) {
    warnings.push('Document review state is unavailable. Review-based signals may be incomplete.');
  }
  if (feedbackResult.error) {
    warnings.push('Recent feedback is unavailable. Intelligence exceptions may be incomplete.');
  }
  if (recentDocumentsResult.error) {
    warnings.push('Recent document counts are unavailable.');
  }

  const rawDecisions = (decisionsResult.data ?? []) as ProjectDecisionRow[];
  const rawTasks = (tasksResult.data ?? []) as ProjectTaskRow[];
  const currentDecisions = filterCurrentQueueRecords(rawDecisions);
  const currentTasks = filterCurrentQueueRecords(rawTasks);
  const projects = (projectsResult.data ?? []) as ProjectRecord[];
  const projectIds = projects.map((project) => project.id);
  const executionItems = (executionItemsResult.data ?? []) as ProjectExecutionItemRow[];
  let validatorFindingActionsByProjectId = new Map<string, ProjectOverviewActionItem[]>();
  let queueFindings: QueueFindingRow[] = [];
  let queueEvidence: QueueFindingEvidenceRow[] = [];

  if (projectIds.length > 0) {
    const findingsResult = await admin
      .from('project_validation_findings')
      .select(
        'id, project_id, rule_id, severity, status, subject_type, subject_id, field, expected, actual, variance, variance_unit, blocked_reason, decision_eligible, action_eligible',
      )
      .in('project_id', projectIds)
      .eq('status', 'open');

    if (findingsResult.error) {
      warnings.push('Validator findings are unavailable. Queue-backed line issues may be incomplete.');
    } else {
      queueFindings = (findingsResult.data ?? []) as QueueFindingRow[];
      const findingIds = queueFindings.map((finding) => finding.id);

      if (findingIds.length > 0) {
        const evidenceResult = await admin
          .from('project_validation_evidence')
          .select(
            'finding_id, evidence_type, source_document_id, source_page, fact_id, record_id, field_name, field_value, note',
          )
          .in('finding_id', findingIds);

        if (evidenceResult.error) {
          warnings.push('Validator evidence links are unavailable. Queue deep links may fall back to the validator tab.');
        } else {
          queueEvidence = (evidenceResult.data ?? []) as QueueFindingEvidenceRow[];
        }
      }

      validatorFindingActionsByProjectId = buildValidatorFindingActionsByProjectId({
        findings: queueFindings,
        evidence: queueEvidence,
      });
    }
  }

  const legacyModel = buildOperationalQueueModel({
    projects,
    documents: (documentsResult.data ?? []) as ProjectDocumentRow[],
    decisions: currentDecisions,
    tasks: currentTasks,
    documentReviews: reviewsResult.error
      ? []
      : ((reviewsResult.data ?? []) as ProjectDocumentReviewRow[]),
    feedback: feedbackResult.error
      ? []
      : ((feedbackResult.data ?? []) as OperationalFeedbackRow[]),
    validatorFindingActionsByProjectId,
    recentDocumentsCount: recentDocumentsResult.error
      ? null
      : (recentDocumentsResult.count ?? 0),
    supersededCounts: {
      decisions: Math.max(0, rawDecisions.length - currentDecisions.length),
      actions: Math.max(0, rawTasks.length - currentTasks.length),
    },
    warnings,
  });

  const projectsById = new Map(projects.map((project) => [project.id, project] as const));
  const documentsById = new Map(
    ((documentsResult.data ?? []) as ProjectDocumentRow[]).map((document) => [document.id, document] as const),
  );
  const evidenceByFindingId = new Map<string, QueueFindingEvidenceRow[]>();
  for (const evidenceRow of queueEvidence) {
    const current = evidenceByFindingId.get(evidenceRow.finding_id) ?? [];
    current.push(evidenceRow);
    evidenceByFindingId.set(evidenceRow.finding_id, current);
  }

  const unresolvedExecutionItems = executionItems.filter((item) => item.status !== 'resolved');
  const executionQueueItems = sortDecisionItems(
    unresolvedExecutionItems.map((item) => {
      const project = projectsById.get(item.project_id) ?? null;
      const evidenceRows = item.source_type === 'validator_finding'
        ? evidenceByFindingId.get(item.source_id) ?? []
        : [];
      const primaryEvidence = evidenceRows.find((entry) => entry.source_document_id) ?? null;
      const sourceDocument = primaryEvidence?.source_document_id
        ? documentsById.get(primaryEvidence.source_document_id) ?? null
        : null;

      return {
        id: item.id,
        decision_id: null,
        decision_type: item.validator_rule_key ?? item.source_key,
        project_id: item.project_id,
        project_label: project?.name ?? null,
        project_code: project?.code ?? null,
        document_id: sourceDocument?.id ?? null,
        title: item.title,
        summary: executionItemSummary(item),
        status: item.status,
        severity: item.severity,
        confidence: null,
        review_status: 'not_reviewed' as const,
        assigned_to: null,
        assigned_to_name: null,
        source_document_title: sourceDocument ? documentTitle(sourceDocument) : null,
        source_document_type: sourceDocument ? documentTypeLabel(sourceDocument.document_type) : null,
        source_refs: item.evidence_refs ?? [],
        evidence_summary:
          primaryEvidence != null
            ? [
                sourceDocument ? documentTitle(sourceDocument) : null,
                primaryEvidence.source_page != null ? `Page ${primaryEvidence.source_page}` : null,
                primaryEvidence.field_name ? titleize(primaryEvidence.field_name) : null,
                primaryEvidence.field_value ?? primaryEvidence.note,
              ].filter((value): value is string => Boolean(value)).join(' | ')
            : item.impact,
        deep_link_target: executionItemProjectHref(item.project_id, item.id),
        source_document_target: executionEvidenceHref({ item, evidence: evidenceRows }),
        decision_target: null,
        created_at: item.created_at,
        detected_at: item.updated_at,
        due_at: null,
        kind: 'execution_item' as const,
        action_mode: 'execution' as const,
        missing_action: item.required_action.trim().length === 0,
        vague_action: isVagueDescription(item.required_action),
        blocked: executionItemBlocksApproval(item),
      };
    }),
  );
  const executionItemDecisionKeys = new Set(
    executionQueueItems.map((item) =>
      [
        item.project_id ?? 'no_project',
        item.decision_type,
        item.decision_id ?? item.id,
      ].join(':'),
    ),
  );
  const persistedDecisionQueueItems = legacyModel.decisions.filter((item) => {
    if (item.kind !== 'persisted_decision') return true;
    const key = [
      item.project_id ?? 'no_project',
      item.decision_type,
      item.decision_id ?? item.id,
    ].join(':');
    return !executionItemDecisionKeys.has(key);
  });
  const mergedDecisionQueueItems = sortDecisionItems([
    ...executionQueueItems,
    ...persistedDecisionQueueItems,
  ]);

  const executionActionsByProjectId = new Map<string, ProjectOverviewActionItem[]>();
  for (const item of unresolvedExecutionItems) {
    const current = executionActionsByProjectId.get(item.project_id) ?? [];
    current.push(executionPendingActionFromItem(item));
    executionActionsByProjectId.set(item.project_id, current);
  }

  const updatedRollups = legacyModel.project_rollups.map((rollupItem) => {
    const projectExecutionItems = executionItems.filter((item) => item.project_id === rollupItem.project.id);
    const unresolvedItems = projectExecutionItems.filter(executionItemIsUnresolved);
    const pendingActions = executionActionsByProjectId.get(rollupItem.project.id) ?? [];

    return {
      ...rollupItem,
      rollup: mergeProjectRollupWithExecutionItems({
        rollup: rollupItem.rollup,
        unresolvedItems,
        pendingExecutionActions: pendingActions,
      }),
    };
  });
  const approvedProjectIds = new Set(
    updatedRollups
      .filter((rollupItem) => rollupItem.rollup.status.label === 'Approved')
      .map((rollupItem) => rollupItem.project.id),
  );
  const commandCenterDecisionQueueItems = mergedDecisionQueueItems.filter(
    (item) =>
      !(
        item.project_id != null
        && approvedProjectIds.has(item.project_id)
        && isActivationBasisWorkAuthorizationDecision(item)
      ),
  );
  const commandCenterPersistedDecisionItems = persistedDecisionQueueItems.filter(
    (item) =>
      !(
        item.project_id != null
        && approvedProjectIds.has(item.project_id)
        && isActivationBasisWorkAuthorizationDecision(item)
      ),
  );
  const sortedUpdatedRollups = [...updatedRollups].sort((left, right) => {
    const statusRank = (status: ProjectOperationalRollup['status']['key']) => {
      if (status === 'blocked') return 0;
      if (status === 'needs_review') return 1;
      if (status === 'attention_required') return 2;
      return 3;
    };

    const leftRank = statusRank(left.rollup.status.key);
    const rightRank = statusRank(right.rollup.status.key);
    if (leftRank !== rightRank) return leftRank - rightRank;

    const leftWeight =
      left.rollup.blocked_count +
      left.rollup.needs_review_document_count +
      left.rollup.open_document_action_count +
      left.rollup.unresolved_finding_count;
    const rightWeight =
      right.rollup.blocked_count +
      right.rollup.needs_review_document_count +
      right.rollup.open_document_action_count +
      right.rollup.unresolved_finding_count;
    if (leftWeight !== rightWeight) return rightWeight - leftWeight;

    return left.project.name.localeCompare(right.project.name);
  });

  const blockingCount = unresolvedExecutionItems.filter((item) => executionItemBlocksApproval(item)).length;
  const resolvableCount = unresolvedExecutionItems.filter((item) => executionItemIsResolvableNow(item)).length;

  return {
    ...legacyModel,
    warnings,
    decisions: commandCenterDecisionQueueItems,
    actions: [],
    intelligence: {
      ...legacyModel.intelligence,
      open_decisions_count: commandCenterDecisionQueueItems.length,
      open_actions_count: resolvableCount,
      blocked_count: blockingCount,
      high_risk_count: unresolvedExecutionItems.filter(
        (item) => item.severity === 'critical' || item.severity === 'high',
      ).length + commandCenterPersistedDecisionItems.filter(
        (item) => item.severity === 'critical' || item.severity === 'high',
      ).length,
    },
    project_rollups: sortedUpdatedRollups,
  };
}
