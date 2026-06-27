import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';
import {
  DECISION_OPEN_STATUSES,
} from '@/lib/overdue';
import {
  EXECUTION_ITEM_OUTCOMES,
  EXECUTION_ITEM_SEVERITIES,
  EXECUTION_ITEM_STATUSES,
  executionItemBlocksApproval,
  type ProjectExecutionItemRow,
} from '@/lib/executionItems';
import type {
  ActionableItemQueueState,
  ActionableItemSeverity,
  ActionableItemSummary,
  CurrentActionableItem,
  GetCurrentActionableItemsOptions,
} from '@/types/executionQueue';
import { logStateProjectionMismatch } from '@/lib/stateProjectionShadow';

type Relation<T> = T | T[] | null | undefined;

type ProjectRelationRow = {
  id: string;
  name: string | null;
};

type RawExecutionItemRow = Pick<
  ProjectExecutionItemRow,
  | 'id'
  | 'organization_id'
  | 'project_id'
  | 'source_type'
  | 'source_id'
  | 'source_key'
  | 'severity'
  | 'title'
  | 'problem'
  | 'expected_value'
  | 'actual_value'
  | 'impact'
  | 'required_action'
  | 'status'
  | 'outcome'
  | 'queue_state'
  | 'evidence_refs'
  | 'fact_refs'
  | 'validator_rule_key'
  | 'created_at'
  | 'updated_at'
> & {
  projects?: Relation<ProjectRelationRow>;
};

type RawFindingRow = {
  id: string;
  linked_decision_id: string | null;
  linked_action_id: string | null;
  status: string;
  lifecycle_state: string | null;
};

type RawEvidenceCountRow = {
  finding_id: string;
};

type RawLegacyDecisionRow = {
  id: string;
  project_id: string | null;
  title: string;
  summary: string | null;
  severity: string;
  status: string;
  created_at: string;
  updated_at: string | null;
  projects?: Relation<ProjectRelationRow>;
};

const EXECUTION_ITEM_RESOLVED_STATUS = EXECUTION_ITEM_STATUSES[2];
const EXECUTION_ITEM_RESOLVABLE_STATUS = EXECUTION_ITEM_STATUSES[1];
const EXECUTION_ITEM_OVERRIDDEN_OUTCOME = EXECUTION_ITEM_OUTCOMES[2];
const EXECUTION_ITEM_CRITICAL_SEVERITY = EXECUTION_ITEM_SEVERITIES[0];
const EXECUTION_ITEM_HIGH_SEVERITY = EXECUTION_ITEM_SEVERITIES[1];

const QUEUE_STATE_RANK: Record<ActionableItemQueueState, number> = {
  blocked: 0,
  needs_review: 1,
  needs_verification: 2,
  ready: 3,
  resolved: 4,
};

const SEVERITY_RANK: Record<ActionableItemSeverity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
};

function firstRelation<T>(value: Relation<T>): T | null {
  if (!value) return null;
  return Array.isArray(value) ? value[0] ?? null : value;
}

function nonEmptyString(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function normalizeSeverity(value: string | null | undefined): ActionableItemSeverity {
  switch (value) {
    case 'critical':
    case 'high':
    case 'medium':
    case 'low':
    case 'info':
      return value;
    case 'warning':
      return 'medium';
    default:
      return 'info';
  }
}

function isRawSystemKey(value: string | null | undefined): boolean {
  const text = nonEmptyString(value);
  if (!text) return false;
  return /^[A-Z0-9_]+(?::|$)/.test(text) || /^[a-z0-9_]+:[^ ]+$/.test(text);
}

function humanTitleFromExecutionItem(item: RawExecutionItemRow): string {
  if (!isRawSystemKey(item.title)) return nonEmptyString(item.title) ?? 'Requires Review';
  if (!isRawSystemKey(item.problem)) return nonEmptyString(item.problem) ?? 'Requires Review';
  return nonEmptyString(item.impact) ?? nonEmptyString(item.required_action) ?? 'Requires Review';
}

function executionItemSummary(item: RawExecutionItemRow): string {
  return (
    [item.problem, item.impact, item.required_action]
      .map((value) => nonEmptyString(value))
      .filter((value): value is string => value != null && !isRawSystemKey(value))
      .join(' ')
    || nonEmptyString(item.impact)
    || 'Operator review is required before this item can be cleared.'
  );
}

function actionLabelForQueueState(queueState: ActionableItemQueueState): string {
  switch (queueState) {
    case 'blocked':
      return 'Review';
    case 'needs_verification':
      return 'Confirm';
    case 'ready':
      return 'Resolve';
    case 'resolved':
      return 'View';
    case 'needs_review':
    default:
      return 'Review';
  }
}

function deriveQueueState(executionItem: RawExecutionItemRow): ActionableItemQueueState {
  if (executionItem.status === EXECUTION_ITEM_RESOLVED_STATUS) {
    return 'resolved';
  }

  if (executionItem.outcome === EXECUTION_ITEM_OVERRIDDEN_OUTCOME) {
    return 'needs_verification';
  }

  if (
    executionItem.severity === EXECUTION_ITEM_CRITICAL_SEVERITY
    || executionItemBlocksApproval(executionItem)
  ) {
    return 'blocked';
  }

  if (executionItem.severity === EXECUTION_ITEM_HIGH_SEVERITY) {
    return 'needs_review';
  }

  if (executionItem.status === EXECUTION_ITEM_RESOLVABLE_STATUS) {
    return 'needs_verification';
  }

  return 'needs_review';
}

function deriveLegacyQueueState(decision: RawLegacyDecisionRow): ActionableItemQueueState {
  if (decision.status === 'blocked' || decision.status === 'approval_blocked') {
    return 'blocked';
  }

  if (decision.status === 'in_review' || decision.status === 'needs_correction') {
    return 'needs_verification';
  }

  return 'needs_review';
}

function deriveLegacyItemSeverity(decision: RawLegacyDecisionRow): ActionableItemSeverity {
  switch (decision.severity) {
    case 'critical':
    case 'high':
    case 'medium':
    case 'low':
      return decision.severity;
    default:
      return 'info';
  }
}

function buildExecutionItemHref(projectId: string, executionItemId: string): string {
  return `/platform/projects/${projectId}?executionItemId=${executionItemId}#project-decisions`;
}

function buildLegacyDecisionHref(projectId: string, decisionId: string): string {
  return `/platform/projects/${projectId}?decisionId=${decisionId}#project-decisions`;
}

function mapExecutionItem(params: {
  row: RawExecutionItemRow;
  findingById: Map<string, RawFindingRow>;
  evidenceCountByFindingId: Map<string, number>;
  shadowSinkAdmin: ReturnType<typeof getSupabaseAdmin>;
}): CurrentActionableItem | null {
  const projectId = nonEmptyString(params.row.project_id);
  if (!projectId) {
    console.warn('[executionQueue] omitted execution item with missing project_id', {
      executionItemId: params.row.id,
    });
    return null;
  }

  const project = firstRelation(params.row.projects);
  const projectName = nonEmptyString(project?.name) ?? 'Unknown Project';
  if (projectName === 'Unknown Project') {
    console.warn('[executionQueue] project join missing for execution item', {
      executionItemId: params.row.id,
      projectId,
    });
  }

  const findingId = params.row.source_type === 'validator_finding' ? params.row.source_id : null;
  const finding = findingId ? params.findingById.get(findingId) ?? null : null;
  const queueState = deriveQueueState(params.row);
  logStateProjectionMismatch({
    record_type: 'execution_item',
    record_id: params.row.id,
    project_id: projectId,
    legacy_value: queueState,
    persisted_value: params.row.queue_state,
    surface: 'executionQueue.mapExecutionItem',
  }, {
    adminClient: params.shadowSinkAdmin,
    organization_id: params.row.organization_id,
  });

  return {
    id: params.row.id,
    source_type: 'execution_item',
    source_id: params.row.id,
    project_id: projectId,
    project_name: projectName,
    title: humanTitleFromExecutionItem(params.row),
    summary: executionItemSummary(params.row),
    severity: normalizeSeverity(params.row.severity),
    status: params.row.status,
    queue_state: queueState,
    action_label: actionLabelForQueueState(queueState),
    href: buildExecutionItemHref(projectId, params.row.id),
    created_at: params.row.created_at,
    updated_at: params.row.updated_at,
    exposure_amount: null,
    evidence_count: findingId ? params.evidenceCountByFindingId.get(findingId) ?? 0 : 0,
    finding_id: finding?.id ?? findingId,
    decision_id: finding?.linked_decision_id ?? null,
    execution_item_id: params.row.id,
  };
}

function mapLegacyDecision(row: RawLegacyDecisionRow): CurrentActionableItem | null {
  const projectId = nonEmptyString(row.project_id);
  if (!projectId) {
    console.warn('[executionQueue] omitted legacy decision with missing project_id', {
      decisionId: row.id,
    });
    return null;
  }

  const project = firstRelation(row.projects);
  const projectName = nonEmptyString(project?.name) ?? 'Unknown Project';
  if (projectName === 'Unknown Project') {
    console.warn('[executionQueue] project join missing for legacy decision', {
      decisionId: row.id,
      projectId,
    });
  }

  const queueState = deriveLegacyQueueState(row);

  return {
    id: `legacy:${row.id}`,
    source_type: 'legacy_decision',
    source_id: row.id,
    project_id: projectId,
    project_name: projectName,
    title: nonEmptyString(row.title) ?? nonEmptyString(row.summary) ?? 'Requires Review',
    summary: nonEmptyString(row.summary) ?? nonEmptyString(row.title) ?? 'Requires Review',
    severity: deriveLegacyItemSeverity(row),
    status: row.status,
    queue_state: queueState,
    action_label: 'Review',
    href: buildLegacyDecisionHref(projectId, row.id),
    created_at: row.created_at,
    updated_at: row.updated_at ?? row.created_at,
    exposure_amount: null,
    evidence_count: 0,
    finding_id: null,
    decision_id: row.id,
    execution_item_id: null,
  };
}

function sortCurrentItems(items: CurrentActionableItem[]): CurrentActionableItem[] {
  return [...items].sort((left, right) => {
    const stateDelta = QUEUE_STATE_RANK[left.queue_state] - QUEUE_STATE_RANK[right.queue_state];
    if (stateDelta !== 0) return stateDelta;
    return new Date(right.updated_at).getTime() - new Date(left.updated_at).getTime();
  });
}

async function loadExecutionItems(
  orgId: string,
  options: GetCurrentActionableItemsOptions,
): Promise<RawExecutionItemRow[]> {
  const admin = getSupabaseAdmin();
  if (!admin) {
    throw new Error('Supabase admin client is not configured.');
  }

  let query = admin
    .from('execution_items')
    .select(
      'id, organization_id, project_id, source_type, source_id, source_key, severity, title, problem, expected_value, actual_value, impact, required_action, status, outcome, queue_state, evidence_refs, fact_refs, validator_rule_key, created_at, updated_at, projects(id, name)',
    )
    .eq('organization_id', orgId)
    .order('updated_at', { ascending: false });

  if (!options.include_resolved) {
    query = query.neq('status', EXECUTION_ITEM_RESOLVED_STATUS);
  }

  if (options.project_id) {
    query = query.eq('project_id', options.project_id);
  }

  const { data, error } = await query;
  if (error) {
    throw new Error(`Failed to load current execution items: ${error.message}`);
  }

  return (data ?? []) as RawExecutionItemRow[];
}

async function loadFindingRows(findingIds: string[]): Promise<RawFindingRow[]> {
  if (findingIds.length === 0) return [];

  const admin = getSupabaseAdmin();
  if (!admin) {
    throw new Error('Supabase admin client is not configured.');
  }

  const { data, error } = await admin
    .from('project_validation_findings')
    .select('id, linked_decision_id, linked_action_id, status, lifecycle_state')
    .in('id', findingIds);

  if (error) {
    throw new Error(`Failed to load validation findings for execution queue: ${error.message}`);
  }

  return (data ?? []) as RawFindingRow[];
}

async function loadEvidenceCounts(findingIds: string[]): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  for (const findingId of findingIds) {
    counts.set(findingId, 0);
  }
  if (findingIds.length === 0) return counts;

  const admin = getSupabaseAdmin();
  if (!admin) {
    throw new Error('Supabase admin client is not configured.');
  }

  const { data, error } = await admin
    .from('project_validation_evidence')
    .select('finding_id')
    .in('finding_id', findingIds);

  if (error) {
    throw new Error(`Failed to count validation evidence for execution queue: ${error.message}`);
  }

  for (const row of (data ?? []) as RawEvidenceCountRow[]) {
    counts.set(row.finding_id, (counts.get(row.finding_id) ?? 0) + 1);
  }

  return counts;
}

async function loadLegacyDecisionItems(
  orgId: string,
  options: GetCurrentActionableItemsOptions,
): Promise<CurrentActionableItem[]> {
  const admin = getSupabaseAdmin();
  if (!admin) {
    throw new Error('Supabase admin client is not configured.');
  }

  let routedQuery = admin
    .from('project_validation_findings')
    .select('linked_decision_id, linked_action_id')
    .not('linked_decision_id', 'is', null)
    .not('linked_action_id', 'is', null);

  if (options.project_id) {
    routedQuery = routedQuery.eq('project_id', options.project_id);
  }

  const { data: routedRows } = await routedQuery.throwOnError();
  const routedDecisionIds = Array.from(
    new Set(
      ((routedRows ?? []) as RawFindingRow[])
        .map((row) => nonEmptyString(row.linked_decision_id))
        .filter((value): value is string => value != null),
    ),
  );

  let query = admin
    .from('decisions')
    .select('id, project_id, title, summary, severity, status, created_at, updated_at, projects(id, name)')
    .eq('organization_id', orgId)
    .in('status', [...DECISION_OPEN_STATUSES])
    .order('updated_at', { ascending: false });

  if (options.project_id) {
    query = query.eq('project_id', options.project_id);
  }

  if (routedDecisionIds.length > 0) {
    query = query.not('id', 'in', `(${routedDecisionIds.join(',')})`);
  }

  const { data } = await query.throwOnError();
  return ((data ?? []) as RawLegacyDecisionRow[])
    .map(mapLegacyDecision)
    .filter((item): item is CurrentActionableItem => item != null);
}

export async function getCurrentActionableItems(
  orgId: string,
  options: GetCurrentActionableItemsOptions = {},
): Promise<CurrentActionableItem[]> {
  const normalizedOptions: GetCurrentActionableItemsOptions = {
    include_legacy_decisions: true,
    include_resolved: false,
    ...options,
  };

  const executionRows = await loadExecutionItems(orgId, normalizedOptions);
  const findingIds = Array.from(
    new Set(
      executionRows
        .filter((row) => row.source_type === 'validator_finding')
        .map((row) => row.source_id)
        .filter((value): value is string => Boolean(nonEmptyString(value))),
    ),
  );

  const [findingRows, evidenceCountByFindingId, legacyItems] = await Promise.all([
    loadFindingRows(findingIds),
    loadEvidenceCounts(findingIds),
    normalizedOptions.include_legacy_decisions
      ? loadLegacyDecisionItems(orgId, normalizedOptions)
      : Promise.resolve([]),
  ]);

  const findingById = new Map(findingRows.map((row) => [row.id, row] as const));
  const shadowSinkAdmin = getSupabaseAdmin();
  const executionItems = executionRows
    .map((row) => mapExecutionItem({
      row,
      findingById,
      evidenceCountByFindingId,
      shadowSinkAdmin,
    }))
    .filter((item): item is CurrentActionableItem => item != null);

  return sortCurrentItems([...executionItems, ...legacyItems]);
}

export async function getActionableItemSummary(
  orgId: string,
  options: GetCurrentActionableItemsOptions = {},
): Promise<ActionableItemSummary> {
  const items = await getCurrentActionableItems(orgId, options);
  const summary: ActionableItemSummary = {
    total: items.length,
    blocked: 0,
    needs_review: 0,
    needs_verification: 0,
    by_project: {},
    highest_severity: null,
  };

  for (const item of items) {
    if (item.queue_state === 'blocked') summary.blocked += 1;
    if (item.queue_state === 'needs_review') summary.needs_review += 1;
    if (item.queue_state === 'needs_verification') summary.needs_verification += 1;

    summary.by_project[item.project_id] = (summary.by_project[item.project_id] ?? 0) + 1;

    if (
      summary.highest_severity == null
      || SEVERITY_RANK[item.severity] < SEVERITY_RANK[summary.highest_severity]
    ) {
      summary.highest_severity = item.severity;
    }
  }

  return summary;
}
