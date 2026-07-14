import type { ProjectExecutionItemRow } from '@/lib/executionItems';
import type {
  ProjectActivityEventRow,
  ProjectDecisionRow,
} from '@/lib/projectOverview';
import {
  type AuditEntry,
  type EvidenceSourceType,
  type EvidenceTarget,
  type IssueLifecycleState,
  type IssueObject,
  type IssueObjectResolverInput,
  type IssueSeverity,
  type IssueStatus,
} from '@/lib/issueObjects';
import { DECISION_OPEN_STATUSES } from '@/lib/overdue';
import { buildEvidenceTarget } from '@/lib/validator/evidenceNavigation';
import { normalizeValidationFinding } from '@/lib/validator/findingSemantics';
import { logStateProjectionMismatch, type StateProjectionShadowMismatch } from '@/lib/stateProjectionShadow';
import type { ValidationEvidence, ValidationFinding } from '@/types/validator';

type DocumentLike = NonNullable<IssueObjectResolverInput['documents']>[number];
type ActivityLike = ProjectActivityEventRow | Record<string, unknown>;
type ResolveProjectIssueObjectsOptions = {
  onMismatch?: (payload: StateProjectionShadowMismatch) => void;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
}

function detailStringArray(record: Record<string, unknown> | null, keys: string[]): string[] {
  for (const key of keys) {
    const values = stringArray(record?.[key]);
    if (values.length > 0) return values;
  }
  return [];
}

function detailString(record: Record<string, unknown> | null, keys: string[]): string | null {
  for (const key of keys) {
    const value = stringValue(record?.[key]);
    if (value) return value;
  }
  return null;
}

function numberValue(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value.replace(/[$,\s]/g, ''));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function toDate(value: string | null | undefined): Date {
  const parsed = value ? new Date(value) : null;
  return parsed && !Number.isNaN(parsed.getTime()) ? parsed : new Date(0);
}

function titleize(value: string | null | undefined): string {
  if (!value) return 'Unknown';
  return value
    .replace(/[_-]+/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(' ');
}

function severityForFinding(finding: ValidationFinding): IssueSeverity {
  const normalized = normalizeValidationFinding(finding);
  if (normalized.business_severity === 'critical') return 'critical';
  if (normalized.business_severity === 'high' || finding.severity === 'critical') return 'high';
  if (normalized.business_severity === 'medium' || finding.severity === 'warning') return 'medium';
  return 'low';
}

function confidenceForFinding(finding: ValidationFinding): number {
  const raw = asRecord(finding)?.confidence_score ?? asRecord(finding)?.confidence;
  return clamp(numberValue(raw) ?? 1, 0, 1);
}

function documentLabel(document: DocumentLike | null): string {
  return document?.title?.trim() || document?.name?.trim() || 'Project evidence';
}

function sourceTypeForDocument(document: DocumentLike | null, evidence: ValidationEvidence): EvidenceSourceType {
  const source = [
    document?.document_role,
    document?.document_type,
    evidence.evidence_type,
  ].filter(Boolean).join(' ').toLowerCase();
  if (source.includes('amendment')) return 'amendment';
  if (source.includes('fema')) return 'fema_doc';
  if (source.includes('contract') || source.includes('rate')) return 'contract';
  if (source.includes('invoice')) return 'invoice';
  return 'other';
}

function evidenceSnippet(evidence: ValidationEvidence): string {
  return evidence.note?.trim()
    || evidence.field_value?.trim()
    || evidence.field_name?.trim()
    || evidence.evidence_type
    || 'Evidence target';
}

function buildIssueEvidenceTarget(params: {
  projectId: string;
  evidence: ValidationEvidence;
  decisionId: string | null;
  document: DocumentLike | null;
}): EvidenceTarget {
  const target = buildEvidenceTarget({
    projectId: params.projectId,
    evidence: params.evidence,
    action: params.evidence.fact_id || params.evidence.field_name ? 'review' : 'inspect',
    decisionId: params.decisionId,
    findingId: params.evidence.finding_id,
  });

  return {
    id: params.evidence.id,
    sourceType: sourceTypeForDocument(params.document, params.evidence),
    sourceName: documentLabel(params.document),
    documentId: target.documentId,
    snippet: evidenceSnippet(params.evidence),
    confidence: 1,
    pdfAnchor: target.href
      ? {
          url: target.href,
          ...(target.page != null ? { page: target.page } : {}),
        }
      : undefined,
  };
}

function decisionFindingIds(decision: ProjectDecisionRow): string[] {
  const details = asRecord(decision.details);
  return [
    ...detailStringArray(details, ['source_finding_ids', 'validator_finding_ids']),
    ...(detailString(details, ['validator_finding_id']) ? [detailString(details, ['validator_finding_id'])!] : []),
  ];
}

function decisionMatchesFinding(decision: ProjectDecisionRow, finding: ValidationFinding): boolean {
  if (finding.linked_decision_id && decision.id === finding.linked_decision_id) return true;
  return decisionFindingIds(decision).includes(finding.id);
}

function executionMatchesFinding(
  item: ProjectExecutionItemRow,
  finding: ValidationFinding,
  decisionId: string | null,
): boolean {
  const raw = asRecord(item);
  if (finding.linked_action_id && item.id === finding.linked_action_id) return true;
  if (item.source_type === 'validator_finding' && item.source_id === finding.id) return true;
  if (stringValue(raw?.finding_id) === finding.id) return true;
  if (decisionId && stringValue(raw?.decision_id) === decisionId) return true;
  return false;
}

function executionMatchesFindingByValidatorSource(
  item: ProjectExecutionItemRow | null,
  finding: ValidationFinding,
): boolean {
  return item?.source_type === 'validator_finding' && item.source_id === finding.id;
}

function isExecutionComplete(item: ProjectExecutionItemRow | null): boolean {
  if (!item) return false;
  const raw = asRecord(item);
  const outcomeStatus = stringValue(raw?.outcome_status);
  return item.status === 'resolved' || outcomeStatus === 'resolved' || outcomeStatus === 'complete';
}

function hasTerminalFindingExecutionEvidence(
  finding: ValidationFinding,
  executionItem: ProjectExecutionItemRow,
): boolean {
  return finding.status !== 'open'
    || finding.resolved_at != null
    || finding.linked_action_id === executionItem.id;
}

function executionItemForFindingLifecycle(
  finding: ValidationFinding,
  executionItem: ProjectExecutionItemRow | null,
): ProjectExecutionItemRow | null {
  if (
    executionItem
    && isExecutionComplete(executionItem)
    && executionMatchesFindingByValidatorSource(executionItem, finding)
    && !hasTerminalFindingExecutionEvidence(finding, executionItem)
  ) {
    return null;
  }

  return executionItem;
}

function statusForRecords(
  decision: ProjectDecisionRow | null,
  executionItem: ProjectExecutionItemRow | null,
): IssueStatus {
  if (isExecutionComplete(executionItem)) return 'COMPLETE';
  if (executionItem) return 'EXECUTING';
  if (decision) return 'DECIDED';
  return 'FINDING';
}

function isEscalated(finding: ValidationFinding, decision: ProjectDecisionRow | null): boolean {
  const findingRecord = asRecord(finding);
  const decisionDetails = asRecord(decision?.details);
  return findingRecord?.escalation_required === true
    || decisionDetails?.escalated === true
    || decisionDetails?.escalation_required === true;
}

function isBlocker(finding: ValidationFinding): boolean {
  const normalized = normalizeValidationFinding(finding);
  return normalized.approval_gate_effect === 'blocks_approval'
    || normalized.finding_disposition === 'blocker'
    || finding.severity === 'critical';
}

function lifecycleForIssue(params: {
  finding: ValidationFinding;
  decision: ProjectDecisionRow | null;
  status: IssueStatus;
}): IssueLifecycleState {
  const { finding, decision, status } = params;
  if (status === 'COMPLETE') return 'resolved';
  if (isEscalated(finding, decision)) return 'escalated';
  if (!decision && isBlocker(finding)) return 'blocked';
  if (!decision) return 'open';

  const decisionStatus = decision.status.toLowerCase();
  const details = asRecord(decision.details);
  const persistedDecisionStatus =
    detailString(details, ['decision_status', 'operator_status'])?.toUpperCase() ?? null;

  if (persistedDecisionStatus === 'PENDING_VERIFICATION' || ['in_review', 'needs_review', 'flagged'].includes(decisionStatus)) {
    return 'needs_verification';
  }
  if (persistedDecisionStatus === 'PENDING_OPERATOR_DECISION' || ['open', 'pending'].includes(decisionStatus)) {
    return 'ready_for_authorization';
  }
  if (['resolved', 'dismissed', 'suppressed'].includes(decisionStatus)) return 'resolved';
  return status === 'EXECUTING' ? 'needs_verification' : 'ready_for_authorization';
}

function nextActionForIssue(issue: {
  decision: ProjectDecisionRow | null;
  executionItem: ProjectExecutionItemRow | null;
  status: IssueStatus;
}): string {
  if (!issue.decision) return 'Needs decision';
  if (issue.status === 'COMPLETE') return 'Resolved';
  if (issue.executionItem && issue.executionItem.status !== 'resolved') {
    return 'Awaiting execution approval';
  }
  return 'Review decision';
}

function eventString(event: ActivityLike, key: string): string | null {
  return stringValue(asRecord(event)?.[key]);
}

function eventRecord(event: ActivityLike, key: string): Record<string, unknown> | null {
  return asRecord(asRecord(event)?.[key]);
}

function eventMatchesIssue(params: {
  event: ActivityLike;
  finding: ValidationFinding;
  decisionId: string | null;
  executionItemId: string | null;
}): boolean {
  const { event, finding, decisionId, executionItemId } = params;
  const entityType = eventString(event, 'entity_type');
  const entityId = eventString(event, 'entity_id');
  if (entityType === 'project_validation_finding' && entityId === finding.id) return true;
  if (decisionId && entityType === 'decision' && entityId === decisionId) return true;
  if (executionItemId && entityType === 'execution_item' && entityId === executionItemId) return true;
  if (entityType === 'project_validation_run' && entityId === finding.run_id) return true;

  const values = [asRecord(event), eventRecord(event, 'old_value'), eventRecord(event, 'new_value')];
  return values.some((record) => {
    if (!record) return false;
    if (stringValue(record.finding_id) === finding.id) return true;
    if (stringValue(record.validation_finding_id) === finding.id) return true;
    if (decisionId && stringValue(record.decision_id) === decisionId) return true;
    if (executionItemId && stringValue(record.execution_item_id) === executionItemId) return true;
    return stringValue(record.validation_run_id) === finding.run_id;
  });
}

function descriptionForEvent(event: ActivityLike): string {
  const newValue = eventRecord(event, 'new_value');
  const oldValue = eventRecord(event, 'old_value');
  return stringValue(newValue?.description)
    ?? stringValue(newValue?.message)
    ?? stringValue(newValue?.notes)
    ?? stringValue(oldValue?.description)
    ?? `${titleize(eventString(event, 'event_type'))} recorded.`;
}

function auditEntryForEvent(event: ActivityLike): AuditEntry {
  const timestamp = toDate(eventString(event, 'created_at'));
  return {
    timestamp,
    activityType: eventString(event, 'event_type') ?? 'activity',
    actorId: eventString(event, 'changed_by'),
    description: descriptionForEvent(event),
    metadata: {
      entity_type: eventString(event, 'entity_type'),
      entity_id: eventString(event, 'entity_id'),
      old_value: eventRecord(event, 'old_value'),
      new_value: eventRecord(event, 'new_value'),
    },
  };
}

function issueSummary(finding: ValidationFinding): string {
  const normalized = normalizeValidationFinding(finding);
  return normalized.problem
    ?? finding.problem
    ?? finding.blocked_reason
    ?? `${titleize(finding.check_key || finding.rule_id)} requires operator review.`;
}

function issueType(finding: ValidationFinding): string {
  return finding.check_key || finding.rule_id || finding.category;
}

function executedAt(item: ProjectExecutionItemRow | null): Date | null {
  if (!item) return null;
  const raw = asRecord(item);
  return toDate(
    stringValue(raw?.outcome_timestamp)
    ?? item.resolved_at
    ?? item.overridden_at
    ?? (item.status === 'resolved' ? item.updated_at : null),
  );
}

function executionItemHref(projectId: string, executionItemId: string): string {
  return `/platform/projects/${projectId}?executionItemId=${executionItemId}#project-decisions`;
}

function queueLifecycleForExecutionItem(item: ProjectExecutionItemRow): IssueLifecycleState {
  if (item.status === 'resolved') return 'resolved';
  if (item.status === 'open') return 'blocked';
  if (item.status === 'resolvable') return 'needs_verification';
  return 'open';
}

function statusForExecutionItem(item: ProjectExecutionItemRow): IssueStatus {
  return item.status === 'resolved' ? 'COMPLETE' : 'EXECUTING';
}

function isPipelineBLegacyDecision(decision: ProjectDecisionRow): boolean {
  return decision.source === 'deterministic' || decision.source === 'rule_engine';
}

function severityForDecision(decision: ProjectDecisionRow): IssueSeverity {
  switch (decision.severity) {
    case 'critical':
    case 'high':
    case 'medium':
    case 'low':
      return decision.severity;
    case 'warning':
      return 'medium';
    default:
      return 'low';
  }
}

function lifecycleForLegacyDecision(decision: ProjectDecisionRow): IssueLifecycleState {
  if (decision.status === 'in_review') return 'needs_verification';
  return 'needs_verification';
}

function legacyDecisionHref(projectId: string, decisionId: string): string {
  return `/platform/projects/${projectId}?decisionId=${decisionId}#project-decisions`;
}

function syntheticFindingForExecutionItem(item: ProjectExecutionItemRow): ValidationFinding {
  const lifecycleState = queueLifecycleForExecutionItem(item);
  const severity = item.severity === 'critical' ? 'critical' : item.severity === 'low' ? 'info' : 'warning';
  const findingId = item.source_id || item.id;

  return {
    id: findingId,
    run_id: `execution:${item.id}`,
    project_id: item.project_id,
    rule_id: item.validator_rule_key ?? item.source_key,
    check_key: item.source_key,
    category: 'financial_integrity',
    severity,
    status: item.status === 'resolved' ? 'resolved' : 'open',
    subject_type: item.source_type,
    subject_id: item.source_id,
    field: null,
    expected: item.expected_value,
    actual: item.actual_value,
    variance: null,
    variance_unit: null,
    blocked_reason: item.status === 'open' ? item.problem : null,
    finding_disposition: item.status === 'open' ? 'blocker' : 'requires_review',
    business_severity: item.severity,
    problem: item.problem,
    impact: item.impact,
    required_action: item.required_action,
    evidence_refs: item.evidence_refs,
    source_family: 'project',
    affected_amount: null,
    approval_gate_effect: lifecycleState === 'blocked' ? 'blocks_approval' : 'requires_operator_review',
    exposure_type: 'other',
    decision_eligible: true,
    action_eligible: true,
    linked_decision_id: null,
    linked_action_id: item.id,
    resolved_by_user_id: null,
    resolved_at: item.resolved_at,
    created_at: item.created_at,
    updated_at: item.updated_at,
  };
}

function syntheticFindingForLegacyDecision(decision: ProjectDecisionRow, projectId: string): ValidationFinding {
  const severity = severityForDecision(decision) === 'critical' ? 'critical' : severityForDecision(decision) === 'low' ? 'info' : 'warning';
  const summary = decision.summary ?? decision.title;

  return {
    id: `decision:${decision.id}`,
    run_id: `decision:${decision.id}`,
    project_id: projectId,
    rule_id: decision.decision_type,
    check_key: decision.decision_type,
    category: 'financial_integrity',
    severity,
    status: 'open',
    subject_type: 'decision',
    subject_id: decision.id,
    field: null,
    expected: null,
    actual: null,
    variance: null,
    variance_unit: null,
    blocked_reason: null,
    finding_disposition: 'requires_review',
    business_severity: severityForDecision(decision),
    problem: summary,
    impact: summary,
    required_action: 'Review contract intelligence decision',
    evidence_refs: [],
    source_family: 'project',
    affected_amount: null,
    approval_gate_effect: 'requires_operator_review',
    exposure_type: 'other',
    decision_eligible: true,
    action_eligible: false,
    linked_decision_id: decision.id,
    linked_action_id: null,
    resolved_by_user_id: null,
    resolved_at: null,
    created_at: decision.created_at,
    updated_at: decision.updated_at ?? decision.created_at,
  };
}

function buildExecutionBackedIssueObject(params: {
  input: IssueObjectResolverInput;
  executionItem: ProjectExecutionItemRow;
  activityEvents: readonly ActivityLike[];
  options?: ResolveProjectIssueObjectsOptions;
}): IssueObject | null {
  const { input, executionItem, activityEvents } = params;
  if (!executionItem.project_id) {
    console.warn('[resolveProjectIssueObjects] omitted execution-backed issue with missing project_id', {
      executionItemId: executionItem.id,
    });
    return null;
  }

  const finding = syntheticFindingForExecutionItem(executionItem);
  const decisionId = null;
  const executionItemId = executionItem.id;
  const status = statusForExecutionItem(executionItem);
  const lifecycleState = queueLifecycleForExecutionItem(executionItem);
  logStateProjectionMismatch({
    record_type: 'execution_item',
    record_id: executionItem.id,
    project_id: executionItem.project_id,
    legacy_value: lifecycleState,
    persisted_value: executionItem.queue_state,
    surface: 'resolveProjectIssueObjects.executionBacked',
  }, {
    onMismatch: params.options?.onMismatch,
  });
  const auditChain = activityEvents
    .filter((event) => eventMatchesIssue({ event, finding, decisionId, executionItemId }))
    .map(auditEntryForEvent)
    .sort((left, right) => left.timestamp.getTime() - right.timestamp.getTime());
  const summary = executionItem.problem || executionItem.title;

  return {
    issueId: `exec:${executionItem.id}`,
    projectId: executionItem.project_id,
    findingId: finding.id,
    decisionId,
    executionItemId,
    finding,
    decision: null,
    executionItem,
    evidenceTargets: [],
    auditChain,
    status,
    lifecycleState,
    title: executionItem.title,
    summary,
    issueType: executionItem.validator_rule_key ?? executionItem.source_key,
    severity: executionItem.severity,
    confidence: 1,
    exposureAmount: null,
    nextAction: nextActionForIssue({ decision: null, executionItem, status }),
    nextHref: executionItemHref(input.projectId, executionItem.id),
    createdAt: toDate(executionItem.created_at),
    decisionMadeAt: null,
    executedAt: executedAt(executionItem),
  };
}

function buildLegacyDecisionIssueObject(params: {
  input: IssueObjectResolverInput;
  decision: ProjectDecisionRow;
  activityEvents: readonly ActivityLike[];
}): IssueObject | null {
  const { input, decision, activityEvents } = params;
  if (!decision.project_id || decision.project_id !== input.projectId) {
    console.warn('[resolveProjectIssueObjects] omitted legacy decision issue with missing or mismatched project_id', {
      decisionId: decision.id,
      decisionProjectId: decision.project_id ?? null,
      projectId: input.projectId,
    });
    return null;
  }

  const finding = syntheticFindingForLegacyDecision(decision, input.projectId);
  const decisionId = decision.id;
  const executionItemId = null;
  const status: IssueStatus = 'DECIDED';
  const lifecycleState = lifecycleForLegacyDecision(decision);
  const auditChain = activityEvents
    .filter((event) => eventMatchesIssue({ event, finding, decisionId, executionItemId }))
    .map(auditEntryForEvent)
    .sort((left, right) => left.timestamp.getTime() - right.timestamp.getTime());
  const summary = decision.summary ?? decision.title;

  return {
    issueId: decision.id,
    projectId: decision.project_id,
    findingId: finding.id,
    decisionId,
    executionItemId,
    finding,
    decision,
    executionItem: null,
    evidenceTargets: [],
    auditChain,
    status,
    lifecycleState,
    title: decision.title,
    summary,
    issueType: decision.decision_type,
    severity: severityForDecision(decision),
    confidence: clamp(decision.confidence ?? 1, 0, 1),
    exposureAmount: null,
    nextAction: 'Review decision',
    nextHref: legacyDecisionHref(input.projectId, decision.id),
    createdAt: toDate(decision.created_at),
    decisionMadeAt: toDate(decision.updated_at ?? decision.created_at),
    executedAt: null,
  };
}

function sortIssueObjects(issues: IssueObject[]): IssueObject[] {
  return [...issues].sort((left, right) => {
    const lifecycleRank: Record<IssueLifecycleState, number> = {
      blocked: 0,
      escalated: 1,
      needs_verification: 2,
      ready_for_authorization: 3,
      open: 4,
      resolved: 5,
    };
    const lifecycleDelta = lifecycleRank[left.lifecycleState] - lifecycleRank[right.lifecycleState];
    if (lifecycleDelta !== 0) return lifecycleDelta;
    const exposureDelta = (right.exposureAmount ?? 0) - (left.exposureAmount ?? 0);
    if (exposureDelta !== 0) return exposureDelta;
    return right.createdAt.getTime() - left.createdAt.getTime();
  });
}

export function resolveProjectIssueObjects(
  input: IssueObjectResolverInput,
  options: ResolveProjectIssueObjectsOptions = {},
): IssueObject[] {
  const documentsById = new Map((input.documents ?? []).map((document) => [document.id, document] as const));
  const decisions = input.decisions ?? [];
  const executionItems = input.executionItems ?? [];
  const evidenceRows = (input.evidence ?? []) as ValidationEvidence[];
  const activityEvents = input.activityEvents ?? [];

  const findingBackedIssueObjects = input.findings.map((finding) => {
    const decision =
      decisions.find((candidate) => decisionMatchesFinding(candidate, finding))
      ?? (finding.linked_decision_id ? decisions.find((candidate) => candidate.id === finding.linked_decision_id) ?? null : null);
    const decisionId = decision?.id ?? finding.linked_decision_id ?? null;
    const executionItem =
      executionItems.find((candidate) => executionMatchesFinding(candidate, finding, decisionId))
      ?? null;
    const executionItemId = executionItem?.id ?? finding.linked_action_id ?? null;
    const status = statusForRecords(decision, executionItemForFindingLifecycle(finding, executionItem));
    const findingEvidence = evidenceRows.filter((evidence) => evidence.finding_id === finding.id);
    const evidenceTargets = findingEvidence.map((evidence) => buildIssueEvidenceTarget({
      projectId: input.projectId,
      evidence,
      decisionId,
      document: evidence.source_document_id ? documentsById.get(evidence.source_document_id) ?? null : null,
    }));
    const auditChain = activityEvents
      .filter((event) => eventMatchesIssue({ event, finding, decisionId, executionItemId }))
      .map(auditEntryForEvent)
      .sort((left, right) => left.timestamp.getTime() - right.timestamp.getTime());
    const lifecycleState = lifecycleForIssue({ finding, decision, status });
    logStateProjectionMismatch({
      record_type: 'project_validation_finding',
      record_id: finding.id,
      project_id: finding.project_id,
      legacy_value: lifecycleState,
      persisted_value: finding.lifecycle_state,
      surface: 'resolveProjectIssueObjects.findingBacked',
    }, {
      onMismatch: options.onMismatch,
    });
    const summary = issueSummary(finding);
    const nextHref = `/platform/projects/${input.projectId}?activeTab=decisions&selectedIssue=${finding.id}#project-decisions`;

    return {
      issueId: finding.id,
      projectId: input.projectId,
      findingId: finding.id,
      decisionId,
      executionItemId,
      finding,
      decision,
      executionItem,
      evidenceTargets,
      auditChain,
      status,
      lifecycleState,
      title: finding.check_key || finding.rule_id || summary,
      summary,
      issueType: issueType(finding),
      severity: severityForFinding(finding),
      confidence: confidenceForFinding(finding),
      exposureAmount: finding.affected_amount ?? null,
      nextAction: nextActionForIssue({ decision, executionItem, status }),
      nextHref,
      createdAt: toDate(finding.created_at),
      decisionMadeAt: decision ? toDate(decision.updated_at ?? decision.created_at) : null,
      executedAt: executedAt(executionItem),
    };
  });

  const executionBackedIssueObjects = executionItems
    .filter((executionItem) => !findingBackedIssueObjects.some((issue) =>
      issue.executionItemId === executionItem.id || issue.findingId === executionItem.source_id,
    ))
    .map((executionItem) => buildExecutionBackedIssueObject({ input, executionItem, activityEvents, options }))
    .filter((issue): issue is IssueObject => issue != null);

  const existingIssueObjects = [...findingBackedIssueObjects, ...executionBackedIssueObjects];
  const legacyDecisionIssueObjects = decisions
    .filter((decision) =>
      DECISION_OPEN_STATUSES.includes(decision.status)
      && isPipelineBLegacyDecision(decision)
      && existingIssueObjects.every((issue) => issue.decisionId !== decision.id)
    )
    .map((decision) => buildLegacyDecisionIssueObject({ input, decision, activityEvents }))
    .filter((issue): issue is IssueObject => issue != null);

  return sortIssueObjects([...findingBackedIssueObjects, ...executionBackedIssueObjects, ...legacyDecisionIssueObjects]);
}
