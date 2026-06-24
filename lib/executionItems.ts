import { buildProjectDocumentHref } from '@/lib/documentNavigation';

export const EXECUTION_ITEM_SOURCE_TYPES = ['validator_finding'] as const;
export type ExecutionItemSourceType = (typeof EXECUTION_ITEM_SOURCE_TYPES)[number];

export const EXECUTION_ITEM_SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;
export type ExecutionItemSeverity = (typeof EXECUTION_ITEM_SEVERITIES)[number];

export const EXECUTION_ITEM_STATUSES = ['open', 'resolvable', 'resolved'] as const;
export type ExecutionItemStatus = (typeof EXECUTION_ITEM_STATUSES)[number];

export const EXECUTION_ITEM_OUTCOMES = ['confirmed', 'resolved', 'overridden'] as const;
export type ExecutionItemOutcome = (typeof EXECUTION_ITEM_OUTCOMES)[number];

export type ExecutionItemQueueState =
  | 'blocked'
  | 'needs_review'
  | 'needs_verification'
  | 'resolved';

export type ProjectExecutionItemRow = {
  id: string;
  organization_id: string;
  project_id: string;
  source_type: ExecutionItemSourceType;
  source_id: string;
  source_key: string;
  severity: ExecutionItemSeverity;
  title: string;
  problem: string;
  expected_value: string | null;
  actual_value: string | null;
  impact: string;
  required_action: string;
  status: ExecutionItemStatus;
  outcome: ExecutionItemOutcome | null;
  queue_state?: ExecutionItemQueueState | null;
  evidence_refs: string[] | null;
  fact_refs: string[] | null;
  validator_rule_key: string | null;
  override_reason: string | null;
  suppression_signature: string | null;
  created_at: string;
  updated_at: string;
  last_seen_at: string | null;
  overridden_at: string | null;
  resolved_at: string | null;
};

export type ExecutionItemSuppressionSignatureInput = {
  project_id: string;
  validator_rule_key: string | null;
  source_key: string;
  expected_value: string | null;
  actual_value: string | null;
  evidence_refs?: readonly (string | null | undefined)[] | null;
  fact_refs?: readonly (string | null | undefined)[] | null;
};

function normalizeExecutionSignatureText(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function normalizeExecutionSignatureRefs(
  values: readonly (string | null | undefined)[] | null | undefined,
): string[] {
  const seen = new Set<string>();
  const refs: string[] = [];

  for (const value of values ?? []) {
    const trimmed = value?.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    refs.push(trimmed);
  }

  return refs.sort((left, right) => left.localeCompare(right, 'en-US'));
}

export function buildExecutionItemSuppressionSignature(
  input: ExecutionItemSuppressionSignatureInput,
): string {
  return JSON.stringify({
    project_id: input.project_id,
    validator_rule_key: normalizeExecutionSignatureText(input.validator_rule_key),
    source_key: normalizeExecutionSignatureText(input.source_key) ?? '',
    expected_value: normalizeExecutionSignatureText(input.expected_value),
    actual_value: normalizeExecutionSignatureText(input.actual_value),
    evidence_refs: normalizeExecutionSignatureRefs(input.evidence_refs),
    fact_refs: normalizeExecutionSignatureRefs(input.fact_refs),
  });
}

export function executionItemSuppressionSignatureForRow(
  item: Pick<
    ProjectExecutionItemRow,
    | 'project_id'
    | 'validator_rule_key'
    | 'source_key'
    | 'expected_value'
    | 'actual_value'
    | 'evidence_refs'
    | 'fact_refs'
  >,
): string {
  return buildExecutionItemSuppressionSignature({
    project_id: item.project_id,
    validator_rule_key: item.validator_rule_key,
    source_key: item.source_key,
    expected_value: item.expected_value,
    actual_value: item.actual_value,
    evidence_refs: item.evidence_refs,
    fact_refs: item.fact_refs,
  });
}

export function executionItemStatusLabel(status: ExecutionItemStatus): string {
  switch (status) {
    case 'open':
      return 'Open';
    case 'resolvable':
      return 'Resolvable Now';
    case 'resolved':
      return 'Resolved';
    default:
      return 'Open';
  }
}

export function executionItemOutcomeLabel(outcome: ExecutionItemOutcome | null): string | null {
  switch (outcome) {
    case 'confirmed':
      return 'Approved';
    case 'resolved':
      return 'Corrected';
    case 'overridden':
      return 'Overridden';
    default:
      return null;
  }
}

export function executionItemBlocksApproval(item: Pick<ProjectExecutionItemRow, 'status'>): boolean {
  return item.status === 'open';
}

export function executionItemIsResolvableNow(item: Pick<ProjectExecutionItemRow, 'status'>): boolean {
  return item.status === 'resolvable';
}

export function executionItemProjectHref(projectId: string, executionItemId?: string | null): string {
  const params = new URLSearchParams();
  if (executionItemId) {
    params.set('executionItemId', executionItemId);
  }
  const query = params.toString();
  return `/platform/projects/${projectId}${query ? `?${query}` : ''}#project-decisions`;
}

export function buildExecutionInspectorHref(args: {
  projectId: string;
  documentId: string;
  page?: number | null;
  factId?: string | null;
  fieldKey?: string | null;
  recordId?: string | null;
  rateRowId?: string | null;
  action?: 'inspect' | 'review' | 'request_correction' | 'manual_override' | null;
  executionItemId?: string | null;
  findingId?: string | null;
}): string {
  const baseHref = buildProjectDocumentHref(args.documentId, args.projectId);
  const params = new URLSearchParams(baseHref.split('?')[1] ?? '');
  if (args.page != null) params.set('page', String(args.page));
  if (args.factId) params.set('factId', args.factId);
  if (args.fieldKey) params.set('fieldKey', args.fieldKey);
  if (args.recordId) params.set('recordId', args.recordId);
  if (args.rateRowId) params.set('rateRowId', args.rateRowId);
  if (args.action) params.set('action', args.action);
  if (args.executionItemId) params.set('executionItemId', args.executionItemId);
  if (args.findingId) params.set('findingId', args.findingId);
  return `${baseHref.split('?')[0]}?${params.toString()}`;
}
