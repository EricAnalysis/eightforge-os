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

type Relation<T> = T | T[] | null | undefined;

export type ProjectRecord = {
  id: string;
  name: string;
  code: string | null;
  status: string | null;
  created_at: string;
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
  tone: OverviewTone;
  derived: boolean;
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
};

export type ProjectOverviewModel = {
  project: ProjectRecord;
  context_label: string;
  title: string;
  project_id_label: string;
  tags: ProjectOverviewTag[];
  status: ProjectOverviewStatus;
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

type ExposureDocumentInsight = {
  document: ProjectDocumentRow;
  trace: DocumentExecutionTrace | null;
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

function getFactValue(
  facts: Record<string, unknown> | undefined,
  keys: string[],
): unknown {
  for (const key of keys) {
    if (key in (facts ?? {})) return facts?.[key];
  }
  return null;
}

function getFactNumber(
  facts: Record<string, unknown> | undefined,
  keys: string[],
): number | null {
  return parseNumber(getFactValue(facts, keys));
}

function getFactString(
  facts: Record<string, unknown> | undefined,
  keys: string[],
): string | null {
  const value = getFactValue(facts, keys);
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
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
      if (left.sort_priority_rank !== right.sort_priority_rank) {
        return left.sort_priority_rank - right.sort_priority_rank;
      }
      if (left.sort_due_rank !== right.sort_due_rank) {
        return left.sort_due_rank - right.sort_due_rank;
      }
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
        due_label: blockedFromSource ? 'Blocked finding' : 'Source document action',
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
        due_label: blockedDecision ? 'Blocked finding' : 'Decision follow-up',
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
        due_label: blockedDecision ? 'Blocked finding' : 'Source document follow-up',
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
      detail: `${blockedCount} blocked finding${blockedCount === 1 ? '' : 's'} are stopping project progress.`,
      is_clear: false,
    };
  } else if (needsReviewDocumentCount > 0) {
    status = {
      key: 'needs_review',
      label: 'Needs Review',
      tone: 'warning',
      detail: `${needsReviewDocumentCount} linked document${needsReviewDocumentCount === 1 ? '' : 's'} still need operator review.`,
      is_clear: false,
    };
  } else if (openDocumentActionCount > 0 || unresolvedFindingCount > 0 || anomalyCount > 0) {
    status = {
      key: 'attention_required',
      label: 'Attention Required',
      tone: 'info',
      detail: `${openDocumentActionCount} pending action${openDocumentActionCount === 1 ? '' : 's'}, ${unresolvedFindingCount} unresolved finding${unresolvedFindingCount === 1 ? '' : 's'}, and ${anomalyCount} anomal${anomalyCount === 1 ? 'y' : 'ies'} are still active.`,
      is_clear: false,
    };
  } else {
    status = {
      key: 'operationally_clear',
      label: 'Operationally Clear',
      tone: 'success',
      detail: processedDocuments.length > 0
        ? 'Linked processed documents and project rows show no unresolved operational work.'
        : `No unresolved operational work is linked to ${shortProjectId(project)} yet.`,
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
): ProjectOverviewExposure {
  const insights: ExposureDocumentInsight[] = documents.map((document) => ({
    document,
    trace: parseDocumentExecutionTrace(document.intelligence_trace ?? null),
  }));

  const limitCandidates: number[] = [];
  const actualByInvoiceKey = new Map<string, { amount: number; precedence: number }>();

  for (const insight of insights) {
    const facts = insight.trace?.facts;
    const limitCandidate = getFactNumber(facts, [
      'nte_amount',
      'notToExceedAmount',
      'original_contract_sum',
      'g702_contract_sum',
      'approved_amount',
    ]);
    if (limitCandidate != null && limitCandidate > 0) {
      limitCandidates.push(limitCandidate);
    }

    const actualCandidate = getFactNumber(facts, [
      'amount_recommended_for_payment',
      'approved_amount',
      'current_payment_due',
      'total_earned_less_retainage',
      'extended_cost',
    ]);
    if (actualCandidate == null || actualCandidate <= 0) continue;

    const invoiceKey =
      getFactString(facts, ['invoice_number', 'invoiceNumber']) ??
      insight.document.id;
    const precedence =
      insight.document.document_type === 'payment_rec' ||
      insight.document.document_type === 'payment_recommendation'
        ? 2
        : 1;
    const existing = actualByInvoiceKey.get(invoiceKey);
    if (!existing || precedence >= existing.precedence) {
      actualByInvoiceKey.set(invoiceKey, { amount: actualCandidate, precedence });
    }
  }

  const limitAmount = limitCandidates.length > 0 ? Math.max(...limitCandidates) : null;
  const actualAmount = actualByInvoiceKey.size > 0
    ? [...actualByInvoiceKey.values()].reduce((sum, entry) => sum + entry.amount, 0)
    : null;
  const percent = limitAmount && actualAmount != null
    ? Number(((actualAmount / limitAmount) * 100).toFixed(0))
    : null;

  if (percent == null) {
    return {
      percent: null,
      bar_percent: 0,
      percent_label: '--',
      limit_label: 'LIMIT: Awaiting source docs',
      actual_label: 'ACTUAL: Awaiting source docs',
      detail:
        documents.length > 0
          ? `Exposure is waiting on contract or invoice totals for ${shortProjectId(project)}.`
          : 'Exposure will appear once a contract or payment document is linked.',
      tone: 'muted',
      derived: true,
    };
  }

  const tone: OverviewTone =
    percent >= 90 ? 'danger' :
    percent >= 70 ? 'warning' :
    'info';

  return {
    percent,
    bar_percent: clamp(percent, 0, 100),
    percent_label: `${percent}%`,
    limit_label: `LIMIT: ${formatCurrency(limitAmount)}`,
    actual_label: `ACTUAL: ${formatCurrency(actualAmount)}`,
    detail: 'Derived from linked contract and invoice trace amounts.',
    tone,
    derived: true,
  };
}

function resolveProjectMetrics(
  project: ProjectRecord,
  documents: ProjectDocumentRow[],
  rollup: ProjectOperationalRollup,
): ProjectOverviewMetric[] {
  return [
    {
      key: 'processed-docs',
      label: 'Processed Docs',
      value: formatCompactNumber(rollup.processed_document_count),
      supporting: rollup.processed_document_count === 0
        ? `No processed operational records are linked to ${shortProjectId(project)} yet`
        : `${rollup.processed_document_count} linked document${rollup.processed_document_count === 1 ? '' : 's'} are contributing project truth`,
      tone: rollup.processed_document_count > 0 ? 'neutral' : 'muted',
    },
    {
      key: 'needs-review',
      label: 'Needs Review',
      value: formatCompactNumber(rollup.needs_review_document_count),
      supporting: rollup.needs_review_document_count === 0
        ? 'No linked documents are waiting on review'
        : `${rollup.needs_review_document_count} document${rollup.needs_review_document_count === 1 ? '' : 's'} still need operator review`,
      tone: rollup.needs_review_document_count > 0 ? 'warning' : 'success',
    },
    {
      key: 'open-actions',
      label: 'Open Actions',
      value: formatCompactNumber(rollup.open_document_action_count),
      supporting: `${rollup.unresolved_finding_count} unresolved finding${rollup.unresolved_finding_count === 1 ? '' : 's'} are driving the current queue`,
      tone: rollup.open_document_action_count > 0 ? 'warning' : 'muted',
    },
    {
      key: 'anomalies',
      label: 'Anomalies',
      value: formatCompactNumber(rollup.anomaly_count),
      supporting: rollup.anomaly_count > 0
        ? `${rollup.anomaly_count} linked document${rollup.anomaly_count === 1 ? '' : 's'} have processing anomalies or failed execution`
        : 'No processing anomalies are currently active',
      tone: rollup.anomaly_count > 0 ? 'danger' : 'success',
    },
  ];
}

function resolveProjectFacts(
  project: ProjectRecord,
  rollup: ProjectOperationalRollup,
): ProjectOverviewFact[] {
  return [
    { label: 'Project Code', value: shortProjectId(project) },
    { label: 'Unresolved Findings', value: formatCompactNumber(rollup.unresolved_finding_count) },
    { label: 'Blocked', value: formatCompactNumber(rollup.blocked_count) },
    { label: 'Project Clear', value: rollup.project_clear ? 'Yes' : 'No' },
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

export function resolveProjectPendingActions(
  rollup: ProjectOperationalRollup,
): ProjectOverviewActionItem[] {
  return rollup.pending_actions.slice(0, 5);
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
    const isDecision = event.entity_type === 'decision';
    const entityTitle = isDecision
      ? decisionTitleById.get(event.entity_id) ?? 'Decision'
      : taskTitleById.get(event.entity_id) ?? 'Action';
    const nextStatus = extractStatus(event.new_value);
    const actor = memberName(members, event.changed_by);

    let label = 'Record updated';
    let detail = entityTitle;
    let tone: OverviewTone = 'info';

    switch (event.event_type) {
      case 'created':
        label = isDecision ? 'Decision created' : 'Action created';
        break;
      case 'status_changed':
        label = isDecision ? 'Decision status changed' : 'Action status changed';
        detail = nextStatus ? `${entityTitle} -> ${titleize(nextStatus)}` : entityTitle;
        tone = auditToneForStatus(nextStatus);
        break;
      case 'assignment_changed':
        label = isDecision ? 'Decision reassigned' : 'Action reassigned';
        detail = `${entityTitle} / ${actor}`;
        tone = 'warning';
        break;
      case 'due_date_changed':
        label = isDecision ? 'Decision due date adjusted' : 'Action due date adjusted';
        tone = 'muted';
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
      href: isDecision ? `/platform/decisions/${event.entity_id}` : `/platform/workflows/${event.entity_id}`,
      sort_at: event.created_at,
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
  const rollup = buildProjectOperationalRollup({
    project,
    documents,
    decisions,
    tasks,
    documentReviews,
    members,
  });
  const exposure = resolveProjectExposure(project, documents);
  const decisionCards = resolveProjectDecisionSummary(decisions, tasks, members);
  const actionItems = resolveProjectPendingActions(rollup);
  const processedDocuments = resolveProjectProcessedDocs(project, documents, rollup);
  const auditItems = resolveProjectAuditEvents(project, documents, decisions, tasks, activityEvents, members);

  return {
    project,
    context_label: 'Operations / Projects',
    title: project.name,
    project_id_label: shortProjectId(project),
    tags: resolveProjectTags(project, documents),
    status: rollup.status,
    exposure,
    metrics: resolveProjectMetrics(project, documents, rollup),
    facts: resolveProjectFacts(project, rollup),
    decisions: decisionCards,
    decision_total: decisions.length,
    decision_empty_state: documents.length === 0
      ? 'No project decisions yet. Link and process documents to generate a project record.'
      : rollup.unresolved_finding_count > 0
        ? 'Linked documents still carry unresolved findings, but no promoted project decision rows are open yet.'
        : 'No project decisions are linked right now.',
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
