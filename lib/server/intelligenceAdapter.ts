import { createHash } from 'crypto';
import type { RelatedDocInput } from '../documentIntelligence';
import type {
  DocumentExecutionTrace,
  DocumentIntelligenceOutput,
  DocumentFamily,
  DecisionProjectContext,
  FlowTask,
  GeneratedDecision,
  NormalizedDecision,
  TriggeredWorkflowTask,
} from '../types/documentIntelligence';

export const INTELLIGENCE_PERSISTENCE_VERSION = 'v2';
export const INTELLIGENCE_PERSISTENCE_GENERATOR = 'document_intelligence';
export const DOCUMENT_INTELLIGENCE_ENGINE_VERSION = 'document_intelligence:v2';

type PersistedDecisionSeverity = 'low' | 'medium' | 'high' | 'critical';
type PersistedDecisionLifecycleStatus = 'open';
type PersistedTaskPriority = 'low' | 'medium' | 'high' | 'critical';
type PersistedTaskStatus = 'open' | 'in_progress' | 'resolved';

export type IntelligenceDecisionInsert = {
  local_id: string;
  identity_key: string;
  decision_type: string;
  title: string;
  summary: string | null;
  severity: PersistedDecisionSeverity;
  lifecycle_status: PersistedDecisionLifecycleStatus;
  confidence: number | null;
  source: 'deterministic';
  details: Record<string, unknown>;
};

export type IntelligenceTaskInsert = {
  local_id: string;
  identity_key: string;
  related_decision_local_id: string | null;
  related_decision_identity_key: string | null;
  task_type: string;
  title: string;
  description: string | null;
  priority: PersistedTaskPriority;
  lifecycle_status: PersistedTaskStatus;
  source: 'system';
  source_metadata: Record<string, unknown>;
  details: Record<string, unknown>;
};

export type IntelligencePersistenceRows = {
  family: DocumentFamily;
  executionTrace: DocumentExecutionTrace;
  decisions: IntelligenceDecisionInsert[];
  tasks: IntelligenceTaskInsert[];
};

function severityFromDecision(decision: GeneratedDecision): PersistedDecisionSeverity {
  if (decision.severity) return decision.severity;
  switch (decision.status) {
    case 'mismatch':
      return 'critical';
    case 'missing':
    case 'risky':
      return 'high';
    case 'info':
      return 'medium';
    default:
      return 'low';
  }
}

function normalizeTaskPriority(priority: TriggeredWorkflowTask['priority']): PersistedTaskPriority {
  switch (priority) {
    case 'P1':
      return 'critical';
    case 'P2':
      return 'high';
    case 'P3':
      return 'medium';
    default:
      return 'low';
  }
}

function normalizeTaskStatus(status: TriggeredWorkflowTask['status']): PersistedTaskStatus {
  switch (status) {
    case 'in_progress':
      return 'in_progress';
    case 'resolved':
    case 'auto_completed':
      return 'resolved';
    default:
      return 'open';
  }
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
}

function stableHash(input: unknown): string {
  return createHash('sha1')
    .update(JSON.stringify(input))
    .digest('hex')
    .slice(0, 16);
}

function getFactString(
  facts: Record<string, unknown> | undefined,
  key: string,
): string | null {
  const value = facts?.[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function deriveProjectContext(
  facts: Record<string, unknown> | undefined,
): DecisionProjectContext | null {
  const label = getFactString(facts, 'project_name');
  const projectCode = getFactString(facts, 'project_code');
  if (!label && !projectCode) return null;

  return {
    label: label ?? projectCode ?? 'Project',
    project_id: null,
    project_code: projectCode,
  };
}

function extractRelatedDocumentIds(sourceRefs: string[] | undefined): string[] {
  const relatedDocumentIds = new Set<string>();
  for (const sourceRef of sourceRefs ?? []) {
    const match = /^xref:document:([^:]+):fact:/i.exec(sourceRef);
    if (match?.[1]) {
      relatedDocumentIds.add(match[1]);
    }
  }
  return [...relatedDocumentIds];
}

function deriveGoverningContext(params: {
  sourceRefs: string[] | undefined;
  relatedDocs: RelatedDocInput[];
}): {
  applied_governing_document_id: string | null;
  governing_family: string | null;
  governing_reason: string | null;
  supporting_document_ids_considered: string[];
} {
  const relatedDocIds = extractRelatedDocumentIds(params.sourceRefs);
  if (relatedDocIds.length === 0 || params.relatedDocs.length === 0) {
    return {
      applied_governing_document_id: null,
      governing_family: null,
      governing_reason: null,
      supporting_document_ids_considered: [],
    };
  }

  const relatedDocById = new Map(
    params.relatedDocs.map((document) => [document.id, document] as const),
  );
  const matchedDocs = relatedDocIds
    .map((documentId) => relatedDocById.get(documentId) ?? null)
    .filter((document): document is RelatedDocInput => document != null);

  const matchedGoverningDoc = matchedDocs.find((document) =>
    document.governing_document_id != null ||
    document.is_governing,
  ) ?? null;

  const consideredDocumentIds = new Set<string>();
  for (const documentId of relatedDocIds) {
    consideredDocumentIds.add(documentId);
  }
  for (const documentId of matchedGoverningDoc?.considered_document_ids ?? []) {
    consideredDocumentIds.add(documentId);
  }

  return {
    applied_governing_document_id:
      matchedGoverningDoc?.governing_document_id ??
      (matchedGoverningDoc?.is_governing ? matchedGoverningDoc.id : null),
    governing_family: matchedGoverningDoc?.governing_family ?? null,
    governing_reason: matchedGoverningDoc?.governing_reason ?? null,
    supporting_document_ids_considered: [...consideredDocumentIds],
  };
}

function deriveDecisionIdentityKey(
  family: DocumentFamily,
  decision: GeneratedDecision,
  normalizedDecision: NormalizedDecision | null,
): string {
  const normalizedFamily = normalizedDecision?.family ?? decision.family ?? 'confirmed';
  const fieldKey = normalizedDecision?.field_key ?? decision.field_key ?? decision.type;
  const expectedLocation = normalizedDecision?.expected_location ?? decision.expected_location ?? null;
  const ruleId = normalizedDecision?.rule_id ?? decision.rule_id ?? decision.type;
  const factRefs = normalizedDecision?.fact_refs ?? decision.fact_refs ?? [];
  const title = normalizedDecision?.title ?? decision.title;
  const detail = normalizedDecision?.detail ?? decision.detail ?? decision.explanation;
  const observedValue = normalizedDecision?.observed_value ?? decision.observed_value ?? null;
  const expectedValue = normalizedDecision?.expected_value ?? decision.expected_value ?? null;

  return [
    'decision',
    slugify(family),
    slugify(normalizedFamily),
    slugify(fieldKey || decision.type || 'decision'),
    stableHash({
      type: decision.type,
      normalized_family: normalizedFamily,
      field_key: fieldKey,
      expected_location: expectedLocation,
      rule_id: ruleId,
      fact_refs: factRefs,
      title,
      detail,
      observed_value: observedValue,
      expected_value: expectedValue,
    }),
  ].join(':');
}

function deriveTaskType(
  family: DocumentFamily,
  task: TriggeredWorkflowTask,
  relatedDecision: GeneratedDecision | null,
  flowTask: FlowTask | null,
): string {
  if (relatedDecision?.type && flowTask?.verb && flowTask?.entity_type) {
    return `intelligence_${slugify(family)}_${slugify(relatedDecision.type)}_${slugify(flowTask.verb)}_${slugify(flowTask.entity_type)}`;
  }
  if (relatedDecision?.type && flowTask?.flow_type) {
    return `intelligence_${slugify(family)}_${slugify(relatedDecision.type)}_${slugify(flowTask.flow_type)}`;
  }
  if (relatedDecision?.type) {
    return `intelligence_${slugify(family)}_${slugify(relatedDecision.type)}`;
  }
  const taskSlug = slugify(task.title);
  return `intelligence_${slugify(family)}_${taskSlug || 'review'}`;
}

function deriveTaskIdentityKey(
  family: DocumentFamily,
  task: TriggeredWorkflowTask,
  flowTask: FlowTask | null,
  relatedDecisionIdentityKey: string | null,
): string {
  return [
    'task',
    slugify(family),
    slugify(flowTask?.flow_type ?? 'workflow'),
    slugify(flowTask?.verb ?? task.title),
    slugify(flowTask?.entity_type ?? 'review'),
    stableHash({
      related_decision_identity_key: relatedDecisionIdentityKey,
      title: task.title,
      flow_type: flowTask?.flow_type ?? task.flow_type ?? null,
      verb: flowTask?.verb ?? null,
      entity_type: flowTask?.entity_type ?? null,
      scope: flowTask?.scope ?? null,
      expected_outcome: flowTask?.expected_outcome ?? task.reason ?? null,
    }),
  ].join(':');
}

function buildDocumentExecutionTrace(params: {
  intelligence: DocumentIntelligenceOutput;
  extractionSnapshotId?: string;
}): DocumentExecutionTrace {
  const { intelligence, extractionSnapshotId } = params;
  return {
    extraction_snapshot_id: extractionSnapshotId,
    facts: intelligence.facts ?? {},
    decisions: intelligence.normalizedDecisions ?? [],
    flow_tasks: intelligence.flowTasks ?? [],
    generated_at: new Date().toISOString(),
    engine_version: DOCUMENT_INTELLIGENCE_ENGINE_VERSION,
    classification: intelligence.classification,
    summary: intelligence.summary,
    entities: intelligence.entities,
    key_facts: intelligence.keyFacts,
    suggested_questions: intelligence.suggestedQuestions,
    extracted: intelligence.extracted as Record<string, unknown>,
    evidence: intelligence.evidence,
    extraction_gaps: intelligence.extractionGaps,
    audit_notes: intelligence.auditNotes,
    node_traces: intelligence.nodeTraces,
    contract_analysis: intelligence.contractAnalysis ?? null,
  };
}

function normalizePersistedDecisionDetails(params: {
  decision: GeneratedDecision;
  normalizedDecision: NormalizedDecision | null;
  identityKey: string;
  executionTrace: DocumentExecutionTrace;
  documentId: string;
  organizationId: string;
  family: DocumentFamily;
  relatedDocs: RelatedDocInput[];
}): Record<string, unknown> {
  const {
    decision,
    normalizedDecision,
    identityKey,
    executionTrace,
    documentId,
    organizationId,
    family,
    relatedDocs,
  } = params;
  const primaryAction = normalizedDecision?.primary_action ?? decision.primary_action ?? null;
  const suggestedActions = normalizedDecision?.suggested_actions ?? decision.suggested_actions ?? [];
  const reason =
    normalizedDecision?.reason
    ?? decision.reason
    ?? normalizedDecision?.detail
    ?? decision.detail
    ?? decision.explanation;
  const governingContext = deriveGoverningContext({
    sourceRefs: normalizedDecision?.source_refs ?? decision.source_refs,
    relatedDocs,
  });
  return {
    generated_by: INTELLIGENCE_PERSISTENCE_GENERATOR,
    intelligence_version: INTELLIGENCE_PERSISTENCE_VERSION,
    identity_key: identityKey,
    document_id: documentId,
    organization_id: organizationId,
    document_family: family,
    intelligence_status: decision.status,
    action: primaryAction?.description ?? decision.action ?? null,
    reason,
    primary_action: primaryAction,
    suggested_actions: suggestedActions,
    project_context: deriveProjectContext(executionTrace.facts),
    explanation: decision.explanation,
    related_task_local_ids: decision.relatedTaskIds ?? [],
    family: normalizedDecision?.family ?? decision.family ?? null,
    normalized_severity: normalizedDecision?.severity ?? decision.normalized_severity ?? null,
    detail: normalizedDecision?.detail ?? decision.detail ?? decision.explanation,
    field_key: normalizedDecision?.field_key ?? decision.field_key ?? null,
    expected_location: normalizedDecision?.expected_location ?? decision.expected_location ?? null,
    observed_value: normalizedDecision?.observed_value ?? decision.observed_value ?? null,
    expected_value: normalizedDecision?.expected_value ?? decision.expected_value ?? null,
    impact: normalizedDecision?.impact ?? decision.impact ?? null,
    fact_refs: normalizedDecision?.fact_refs ?? decision.fact_refs ?? [],
    source_refs: normalizedDecision?.source_refs ?? decision.source_refs ?? [],
    evidence_objects: normalizedDecision?.evidence_objects ?? decision.evidence_objects ?? [],
    missing_source_context:
      normalizedDecision?.missing_source_context ??
      decision.missing_source_context ??
      [],
    applied_governing_document_id: governingContext.applied_governing_document_id,
    governing_family: governingContext.governing_family,
    governing_reason: governingContext.governing_reason,
    supporting_document_ids_considered: governingContext.supporting_document_ids_considered,
    rule_id: normalizedDecision?.rule_id ?? decision.rule_id ?? null,
    normalized_decision: normalizedDecision,
    execution_trace_generated_at: executionTrace.generated_at,
    execution_trace_engine_version: executionTrace.engine_version,
  };
}

export function materializePersistedExecutionTrace(params: {
  executionTrace: DocumentExecutionTrace;
  decisionIdsByLocalId: Map<string, string>;
  taskIdsByLocalId: Map<string, string>;
}): DocumentExecutionTrace {
  const { executionTrace, decisionIdsByLocalId, taskIdsByLocalId } = params;

  return {
    ...executionTrace,
    decisions: executionTrace.decisions.map((decision) => ({
      ...decision,
      id: decisionIdsByLocalId.get(decision.id) ?? decision.id,
    })),
    flow_tasks: executionTrace.flow_tasks.map((task) => ({
      ...task,
      id: taskIdsByLocalId.get(task.id) ?? task.id,
      source_decision_ids: task.source_decision_ids.map(
        (decisionId) => decisionIdsByLocalId.get(decisionId) ?? decisionId,
      ),
    })),
  };
}

export function mapIntelligenceToPersistenceRows(params: {
  documentId: string;
  organizationId: string;
  intelligence: DocumentIntelligenceOutput;
  extractionSnapshotId?: string;
  relatedDocs?: RelatedDocInput[];
}): IntelligencePersistenceRows {
  const {
    documentId,
    organizationId,
    intelligence,
    extractionSnapshotId,
    relatedDocs = [],
  } = params;
  const family = intelligence.classification.family;
  const executionTrace = buildDocumentExecutionTrace({
    intelligence,
    extractionSnapshotId,
  });
  const normalizedDecisionById = new Map(
    executionTrace.decisions.map((decision) => [decision.id, decision]),
  );
  const flowTaskById = new Map(
    executionTrace.flow_tasks.map((task) => [task.id, task]),
  );

  const actionableDecisions = intelligence.decisions.filter(
    (decision) => decision.status !== 'passed',
  );

  const decisionIdentityByLocalId = new Map<string, string>();
  const decisions: IntelligenceDecisionInsert[] = actionableDecisions.map((decision) => {
    const normalizedDecision = normalizedDecisionById.get(decision.id) ?? null;
    const identityKey = deriveDecisionIdentityKey(family, decision, normalizedDecision);
    decisionIdentityByLocalId.set(decision.id, identityKey);
    return {
      local_id: decision.id,
      identity_key: identityKey,
      decision_type: decision.type,
      title: decision.title,
      summary: decision.explanation || null,
      severity: severityFromDecision(decision),
      lifecycle_status: 'open',
      confidence: decision.confidence ?? null,
      source: 'deterministic',
      details: normalizePersistedDecisionDetails({
        decision,
        normalizedDecision,
        identityKey,
        executionTrace,
        documentId,
        organizationId,
        family,
        relatedDocs,
      }),
    };
  });

  const decisionByTaskLocalId = new Map<string, GeneratedDecision>();
  for (const decision of actionableDecisions) {
    for (const relatedTaskId of decision.relatedTaskIds ?? []) {
      if (!decisionByTaskLocalId.has(relatedTaskId)) {
        decisionByTaskLocalId.set(relatedTaskId, decision);
      }
    }
  }

  const tasks: IntelligenceTaskInsert[] = intelligence.tasks.map((task) => {
    const relatedDecision = decisionByTaskLocalId.get(task.id) ?? null;
    const flowTask = flowTaskById.get(task.id) ?? null;
    const relatedDecisionIdentityKey = relatedDecision
      ? decisionIdentityByLocalId.get(relatedDecision.id) ?? null
      : null;
    const identityKey = deriveTaskIdentityKey(family, task, flowTask, relatedDecisionIdentityKey);
    const governingContext = deriveGoverningContext({
      sourceRefs: flowTask?.source_decision_ids
        .flatMap((decisionId) =>
          normalizedDecisionById.get(decisionId)?.source_refs ?? [],
        ),
      relatedDocs,
    });
    return {
      local_id: task.id,
      identity_key: identityKey,
      related_decision_local_id: relatedDecision?.id ?? null,
      related_decision_identity_key: relatedDecisionIdentityKey,
      task_type: deriveTaskType(family, task, relatedDecision, flowTask),
      title: task.title,
      description: task.reason || null,
      priority: normalizeTaskPriority(task.priority),
      lifecycle_status: normalizeTaskStatus(task.status),
      source: 'system',
      source_metadata: {
        generated_by: INTELLIGENCE_PERSISTENCE_GENERATOR,
        intelligence_version: INTELLIGENCE_PERSISTENCE_VERSION,
        identity_key: identityKey,
        document_family: family,
        related_decision_type: relatedDecision?.type ?? null,
        related_decision_identity_key: relatedDecisionIdentityKey,
        suggested_owner: task.suggestedOwner ?? null,
        flow_type: flowTask?.flow_type ?? task.flow_type ?? null,
        verb: flowTask?.verb ?? null,
        entity_type: flowTask?.entity_type ?? null,
        applied_governing_document_id: governingContext.applied_governing_document_id,
        governing_family: governingContext.governing_family,
        governing_reason: governingContext.governing_reason,
        supporting_document_ids_considered: governingContext.supporting_document_ids_considered,
        execution_trace_generated_at: executionTrace.generated_at,
      },
      details: {
        generated_by: INTELLIGENCE_PERSISTENCE_GENERATOR,
        intelligence_version: INTELLIGENCE_PERSISTENCE_VERSION,
        identity_key: identityKey,
        document_family: family,
        reason: task.reason,
        intelligence_status: task.status,
        suggested_owner: task.suggestedOwner ?? null,
        related_decision_identity_key: relatedDecisionIdentityKey,
        flow_type: flowTask?.flow_type ?? task.flow_type ?? null,
        verb: flowTask?.verb ?? null,
        entity_type: flowTask?.entity_type ?? null,
        scope: flowTask?.scope ?? null,
        expected_outcome: flowTask?.expected_outcome ?? task.reason,
        auto_safe: flowTask?.auto_safe ?? null,
        source_decision_local_ids: flowTask?.source_decision_ids ?? [],
        applied_governing_document_id: governingContext.applied_governing_document_id,
        governing_family: governingContext.governing_family,
        governing_reason: governingContext.governing_reason,
        supporting_document_ids_considered: governingContext.supporting_document_ids_considered,
        flow_task: flowTask,
        execution_trace_generated_at: executionTrace.generated_at,
        execution_trace_engine_version: executionTrace.engine_version,
      },
    };
  });

  return {
    family,
    executionTrace,
    decisions,
    tasks,
  };
}
