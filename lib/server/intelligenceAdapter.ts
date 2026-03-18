import type {
  DocumentIntelligenceOutput,
  DocumentFamily,
  GeneratedDecision,
  TriggeredWorkflowTask,
} from '../types/documentIntelligence';

export const INTELLIGENCE_PERSISTENCE_VERSION = 'v2';
export const INTELLIGENCE_PERSISTENCE_GENERATOR = 'document_intelligence';

type PersistedDecisionSeverity = 'low' | 'medium' | 'high' | 'critical';
type PersistedDecisionLifecycleStatus = 'open';
type PersistedTaskPriority = 'low' | 'medium' | 'high' | 'critical';
type PersistedTaskStatus = 'open' | 'in_progress' | 'resolved';

export type IntelligenceDecisionInsert = {
  local_id: string;
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
  related_decision_local_id: string | null;
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

function deriveTaskType(
  family: DocumentFamily,
  task: TriggeredWorkflowTask,
  relatedDecision: GeneratedDecision | null,
): string {
  if (relatedDecision?.type) {
    return `intelligence_${slugify(family)}_${slugify(relatedDecision.type)}`;
  }
  const taskSlug = slugify(task.title);
  return `intelligence_${slugify(family)}_${taskSlug || 'review'}`;
}

export function mapIntelligenceToPersistenceRows(params: {
  documentId: string;
  organizationId: string;
  intelligence: DocumentIntelligenceOutput;
}): IntelligencePersistenceRows {
  const { documentId, organizationId, intelligence } = params;
  const family = intelligence.classification.family;

  const actionableDecisions = intelligence.decisions.filter(
    (decision) => decision.status !== 'passed',
  );

  const decisions: IntelligenceDecisionInsert[] = actionableDecisions.map((decision) => ({
    local_id: decision.id,
    decision_type: decision.type,
    title: decision.title,
    summary: decision.explanation || null,
    severity: severityFromDecision(decision),
    lifecycle_status: 'open',
    confidence: decision.confidence ?? null,
    source: 'deterministic',
    details: {
      generated_by: INTELLIGENCE_PERSISTENCE_GENERATOR,
      intelligence_version: INTELLIGENCE_PERSISTENCE_VERSION,
      document_id: documentId,
      organization_id: organizationId,
      document_family: family,
      intelligence_status: decision.status,
      action: decision.action ?? null,
      explanation: decision.explanation,
      related_task_local_ids: decision.relatedTaskIds ?? [],
    },
  }));

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
    return {
      local_id: task.id,
      related_decision_local_id: relatedDecision?.id ?? null,
      task_type: deriveTaskType(family, task, relatedDecision),
      title: task.title,
      description: task.reason || null,
      priority: normalizeTaskPriority(task.priority),
      lifecycle_status: normalizeTaskStatus(task.status),
      source: 'system',
      source_metadata: {
        generated_by: INTELLIGENCE_PERSISTENCE_GENERATOR,
        intelligence_version: INTELLIGENCE_PERSISTENCE_VERSION,
        document_family: family,
        related_decision_type: relatedDecision?.type ?? null,
        suggested_owner: task.suggestedOwner ?? null,
      },
      details: {
        generated_by: INTELLIGENCE_PERSISTENCE_GENERATOR,
        intelligence_version: INTELLIGENCE_PERSISTENCE_VERSION,
        document_family: family,
        reason: task.reason,
        intelligence_status: task.status,
        suggested_owner: task.suggestedOwner ?? null,
      },
    };
  });

  return {
    family,
    decisions,
    tasks,
  };
}
