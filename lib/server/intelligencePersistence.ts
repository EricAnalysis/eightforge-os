import type { SupabaseClient } from '@supabase/supabase-js';
import {
  buildDocumentIntelligence,
  type BuildIntelligenceParams,
  type RelatedDocInput,
} from '@/lib/documentIntelligence';
import {
  pipelineResultToIntelligence,
  runDocumentPipeline,
} from '@/lib/pipeline/documentPipeline';
import {
  isContractInvoicePrimaryDocumentType,
  isContractInvoicePrimaryFamily,
} from '@/lib/contractInvoicePrimary';
import {
  hasUsableExtractionBlobData,
  pickPreferredExtractionBlob,
} from '@/lib/blobExtractionSelection';
import type {
  DocumentExecutionTrace,
  DocumentFamily,
  DocumentIntelligenceOutput,
} from '@/lib/types/documentIntelligence';
import { supportsCanonicalIntelligencePersistence } from '@/lib/canonicalIntelligenceFamilies';
import {
  INTELLIGENCE_PERSISTENCE_GENERATOR,
  INTELLIGENCE_PERSISTENCE_VERSION,
  materializePersistedExecutionTrace,
  mapIntelligenceToPersistenceRows,
  type IntelligenceDecisionInsert,
  type IntelligenceTaskInsert,
} from '@/lib/server/intelligenceAdapter';
import { loadPrecedenceAwareRelatedDocs } from '@/lib/server/documentPrecedence';

type DocumentRow = {
  id: string;
  title: string | null;
  name: string;
  document_type: string | null;
  project_id: string | null;
  projects: { name?: string | null } | Array<{ name?: string | null }> | null;
};

type ExistingDecisionRow = {
  id: string;
  decision_type: string;
  status: string;
  assigned_to: string | null;
  assigned_at: string | null;
  due_at: string | null;
  details: Record<string, unknown> | null;
};

type ExistingTaskRow = {
  id: string;
  task_type: string;
  status: string;
  assigned_to: string | null;
  assigned_at: string | null;
  due_at: string | null;
  details: Record<string, unknown> | null;
};

type ExistingGeneratedDecisionRow = ExistingDecisionRow & {
  source: string | null;
};

type ExistingGeneratedTaskRow = ExistingTaskRow & {
  source: string | null;
};

type PreferredBlobExtraction = {
  id: string;
  data: Record<string, unknown> | null;
};

type ResolvedBuildContext = {
  buildParams: BuildIntelligenceParams;
  extractionSnapshotId?: string;
};

export type PersistCanonicalIntelligenceResult = {
  handled: boolean;
  family: DocumentFamily | null;
  intelligence: DocumentIntelligenceOutput | null;
  decisions_created: number;
  decisions_updated: number;
  decisions_deleted: number;
  decisions_preserved: number;
  tasks_created: number;
  tasks_updated: number;
  tasks_deleted: number;
  tasks_preserved: number;
  legacy_decisions_suppressed: number;
  legacy_tasks_cancelled: number;
};

function resolveProjectName(
  raw: DocumentRow['projects'],
): string | null {
  if (!raw) return null;
  if (Array.isArray(raw)) return raw[0]?.name ?? null;
  return raw.name ?? null;
}

function isOperatorManagedDecision(row: ExistingDecisionRow): boolean {
  return row.status !== 'open' ||
    row.assigned_to != null ||
    row.assigned_at != null ||
    row.due_at != null;
}

function isOperatorManagedTask(row: ExistingTaskRow): boolean {
  return row.status !== 'open' ||
    row.assigned_to != null ||
    row.assigned_at != null ||
    row.due_at != null;
}

function hasV2DetailsMarker(details: Record<string, unknown> | null | undefined): boolean {
  return details?.intelligence_version === INTELLIGENCE_PERSISTENCE_VERSION &&
    details?.generated_by === INTELLIGENCE_PERSISTENCE_GENERATOR;
}

function hasSupersededMarker(details: Record<string, unknown> | null | undefined): boolean {
  return typeof details?.superseded_at === 'string' && details.superseded_at.length > 0;
}

function getIdentityKey(details: Record<string, unknown> | null | undefined): string | null {
  const identityKey = details?.identity_key;
  return typeof identityKey === 'string' && identityKey.length > 0 ? identityKey : null;
}

function isReusableDecisionRow(row: ExistingDecisionRow): boolean {
  return !hasSupersededMarker(row.details) && ['open', 'in_review'].includes(row.status);
}

function isReusableTaskRow(row: ExistingTaskRow): boolean {
  return !hasSupersededMarker(row.details) && ['open', 'in_progress', 'blocked'].includes(row.status);
}

function withSupersededDetails(
  details: Record<string, unknown> | null | undefined,
  supersededAt: string,
): Record<string, unknown> {
  return {
    ...(details ?? {}),
    superseded_by_generated_by: INTELLIGENCE_PERSISTENCE_GENERATOR,
    superseded_by_intelligence_version: INTELLIGENCE_PERSISTENCE_VERSION,
    superseded_at: supersededAt,
  };
}

async function loadDocumentRow(
  admin: SupabaseClient,
  documentId: string,
  organizationId: string,
): Promise<DocumentRow | null> {
  const { data, error } = await admin
    .from('documents')
    .select('id, title, name, document_type, project_id, projects(name)')
    .eq('id', documentId)
    .eq('organization_id', organizationId)
    .maybeSingle();

  if (error || !data) return null;
  return data as DocumentRow;
}

async function loadPreferredBlobExtraction(
  admin: SupabaseClient,
  documentId: string,
): Promise<PreferredBlobExtraction | null> {
  const { data, error } = await admin
    .from('document_extractions')
    .select('id, data')
    .eq('document_id', documentId)
    .is('field_key', null)
    .order('created_at', { ascending: false });

  if (error || !data || data.length === 0) return null;
  const preferred = pickPreferredExtractionBlob(
    data as Array<{ id: string; data?: Record<string, unknown> | null }>,
  );
  if (!preferred) return null;
  return {
    id: preferred.id as string,
    data: preferred.data ?? null,
  };
}

async function loadRelatedDocs(
  admin: SupabaseClient,
  document: DocumentRow,
  organizationId: string,
): Promise<RelatedDocInput[]> {
  if (!document.project_id) return [];
  return loadPrecedenceAwareRelatedDocs(admin, {
    organizationId,
    projectId: document.project_id,
    currentDocumentId: document.id,
  });
}

async function loadBuildParams(
  admin: SupabaseClient,
  params: {
    documentId: string;
    organizationId: string;
    extractionData?: Record<string, unknown> | null;
  },
): Promise<ResolvedBuildContext | null> {
  const document = await loadDocumentRow(admin, params.documentId, params.organizationId);
  if (!document) return null;

  const extractionRecord = (() => {
    if (params.extractionData !== undefined && hasUsableExtractionBlobData(params.extractionData)) {
      return Promise.resolve<PreferredBlobExtraction | null>({
        id: '',
        data: params.extractionData,
      });
    }
    return loadPreferredBlobExtraction(admin, params.documentId);
  })();

  const relatedDocs = await loadRelatedDocs(admin, document, params.organizationId);

  const resolvedExtractionRecord = await extractionRecord;

  return {
    buildParams: {
      documentType: document.document_type,
      documentTitle: document.title,
      documentName: document.name,
      projectName: resolveProjectName(document.projects),
      extractionData: resolvedExtractionRecord?.data ?? null,
      relatedDocs,
    },
    extractionSnapshotId: resolvedExtractionRecord?.id || undefined,
  };
}

async function persistDocumentExecutionTrace(
  admin: SupabaseClient,
  params: {
    documentId: string;
    organizationId: string;
    executionTrace: DocumentExecutionTrace;
  },
): Promise<void> {
  const { error } = await admin
    .from('documents')
    .update({
      intelligence_trace: params.executionTrace,
    })
    .eq('id', params.documentId)
    .eq('organization_id', params.organizationId);

  if (error) {
    console.error('[generateAndPersistCanonicalIntelligence] persist execution trace failed', {
      documentId: params.documentId,
      organizationId: params.organizationId,
      error: error.message,
    });
  }
}

async function loadExistingV2Decisions(
  admin: SupabaseClient,
  documentId: string,
  organizationId: string,
): Promise<ExistingDecisionRow[]> {
  const { data, error } = await admin
    .from('decisions')
    .select('id, decision_type, status, assigned_to, assigned_at, due_at, details')
    .eq('document_id', documentId)
    .eq('organization_id', organizationId)
    .contains('details', {
      intelligence_version: INTELLIGENCE_PERSISTENCE_VERSION,
      generated_by: INTELLIGENCE_PERSISTENCE_GENERATOR,
    });

  if (error || !data) return [];
  return data as ExistingDecisionRow[];
}

async function loadExistingV2Tasks(
  admin: SupabaseClient,
  documentId: string,
  organizationId: string,
): Promise<ExistingTaskRow[]> {
  const { data, error } = await admin
    .from('workflow_tasks')
    .select('id, task_type, status, assigned_to, assigned_at, due_at, details')
    .eq('document_id', documentId)
    .eq('organization_id', organizationId)
    .contains('details', {
      intelligence_version: INTELLIGENCE_PERSISTENCE_VERSION,
      generated_by: INTELLIGENCE_PERSISTENCE_GENERATOR,
    });

  if (error || !data) return [];
  return data as ExistingTaskRow[];
}

async function suppressLegacyGeneratedDecisions(
  admin: SupabaseClient,
  documentId: string,
  organizationId: string,
): Promise<number> {
  const { data, error } = await admin
    .from('decisions')
    .select('id, decision_type, status, assigned_to, assigned_at, due_at, source, details')
    .eq('document_id', documentId)
    .eq('organization_id', organizationId)
    .in('source', ['rule_engine', 'deterministic', 'system']);

  if (error || !data) return 0;

  const candidates = (data as ExistingGeneratedDecisionRow[]).filter(
    (row) => !hasV2DetailsMarker(row.details),
  );
  if (candidates.length === 0) return 0;

  const now = new Date().toISOString();
  let suppressed = 0;

  for (const row of candidates) {
    if (isOperatorManagedDecision(row)) continue;

    const { error: updateError } = await admin
      .from('decisions')
      .update({
        status: 'suppressed',
        updated_at: now,
        details: withSupersededDetails(row.details, now),
      })
      .eq('id', row.id);

    if (updateError) {
      console.error('[generateAndPersistCanonicalIntelligence] suppress legacy decision failed', {
        documentId,
        organizationId,
        decisionId: row.id,
        error: updateError.message,
      });
      continue;
    }

    suppressed += 1;
  }

  return suppressed;
}

async function cancelLegacyGeneratedTasks(
  admin: SupabaseClient,
  documentId: string,
  organizationId: string,
): Promise<number> {
  const { data, error } = await admin
    .from('workflow_tasks')
    .select('id, task_type, status, assigned_to, assigned_at, due_at, source, details')
    .eq('document_id', documentId)
    .eq('organization_id', organizationId)
    .in('source', ['rule_engine', 'decision_engine', 'system']);

  if (error || !data) return 0;

  const candidates = (data as ExistingGeneratedTaskRow[]).filter(
    (row) => !hasV2DetailsMarker(row.details),
  );
  if (candidates.length === 0) return 0;

  const now = new Date().toISOString();
  let cancelled = 0;

  for (const row of candidates) {
    if (isOperatorManagedTask(row)) continue;

    const { error: updateError } = await admin
      .from('workflow_tasks')
      .update({
        status: 'cancelled',
        updated_at: now,
        details: withSupersededDetails(row.details, now),
      })
      .eq('id', row.id);

    if (updateError) {
      console.error('[generateAndPersistCanonicalIntelligence] cancel legacy workflow task failed', {
        documentId,
        organizationId,
        taskId: row.id,
        error: updateError.message,
      });
      continue;
    }

    cancelled += 1;
  }

  return cancelled;
}

async function upsertV2Decisions(
  admin: SupabaseClient,
  params: {
    documentId: string;
    organizationId: string;
    projectId?: string | null;
    decisions: IntelligenceDecisionInsert[];
    allowLegacyTypeFallback: boolean;
  },
): Promise<{
  decisionIdsByLocalId: Map<string, string>;
  created: number;
  updated: number;
  deleted: number;
  preserved: number;
}> {
  const { documentId, organizationId, projectId, decisions, allowLegacyTypeFallback } = params;
  const now = new Date().toISOString();
  const existing = await loadExistingV2Decisions(admin, documentId, organizationId);
  const reusableExisting = existing.filter((row) => isReusableDecisionRow(row));
  const existingByIdentityKey = new Map(
    reusableExisting
      .map((row) => [getIdentityKey(row.details), row] as const)
      .filter((entry): entry is [string, ExistingDecisionRow] => entry[0] != null),
  );
  const fallbackRowsByType = new Map<string, ExistingDecisionRow[]>();
  for (const row of reusableExisting) {
    if (getIdentityKey(row.details)) continue;
    const rows = fallbackRowsByType.get(row.decision_type) ?? [];
    rows.push(row);
    fallbackRowsByType.set(row.decision_type, rows);
  }
  const incomingCountByType = new Map<string, number>();
  for (const decision of decisions) {
    incomingCountByType.set(
      decision.decision_type,
      (incomingCountByType.get(decision.decision_type) ?? 0) + 1,
    );
  }
  const matchedExistingIds = new Set<string>();
  const decisionIdsByLocalId = new Map<string, string>();

  let created = 0;
  let updated = 0;

  for (const decision of decisions) {
    const fallbackRows = allowLegacyTypeFallback
      ? (fallbackRowsByType.get(decision.decision_type) ?? [])
      : [];
    const existingRow =
      existingByIdentityKey.get(decision.identity_key) ??
      (fallbackRows.length === 1 && (incomingCountByType.get(decision.decision_type) ?? 0) === 1
        ? fallbackRows[0]
        : undefined);

    if (existingRow) {
      const { error } = await admin
        .from('decisions')
        .update({
          title: decision.title,
          summary: decision.summary,
          severity: decision.severity,
          confidence: decision.confidence,
          details: decision.details,
          source: decision.source,
          last_detected_at: now,
          updated_at: now,
        })
        .eq('id', existingRow.id);

      if (error) {
        throw new Error(`Failed to update v2 decision ${existingRow.id}: ${error.message}`);
      }

      matchedExistingIds.add(existingRow.id);
      decisionIdsByLocalId.set(decision.local_id, existingRow.id);
      updated += 1;
      continue;
    }

    const { data: inserted, error } = await admin
      .from('decisions')
      .insert({
        organization_id: organizationId,
        document_id: documentId,
        project_id: projectId ?? null,
        decision_type: decision.decision_type,
        title: decision.title,
        summary: decision.summary,
        severity: decision.severity,
        status: decision.lifecycle_status,
        confidence: decision.confidence,
        details: decision.details,
        source: decision.source,
        first_detected_at: now,
        last_detected_at: now,
        created_at: now,
        updated_at: now,
      })
      .select('id')
      .single();

    if (error || !inserted) {
      throw new Error(`Failed to insert v2 decision ${decision.decision_type}: ${error?.message ?? 'unknown error'}`);
    }

    const insertedId = (inserted as { id: string }).id;
    matchedExistingIds.add(insertedId);
    decisionIdsByLocalId.set(decision.local_id, insertedId);
    created += 1;
  }

  let deleted = 0;
  let preserved = 0;

  for (const existingRow of existing) {
    if (matchedExistingIds.has(existingRow.id)) continue;

    if (hasSupersededMarker(existingRow.details)) {
      preserved += 1;
      continue;
    }

    if (isOperatorManagedDecision(existingRow)) {
      const { error } = await admin
        .from('decisions')
        .update({
          details: withSupersededDetails(existingRow.details, now),
          updated_at: now,
        })
        .eq('id', existingRow.id);

      if (error) {
        throw new Error(`Failed to preserve stale v2 decision ${existingRow.id}: ${error.message}`);
      }

      preserved += 1;
      continue;
    }

    const { error } = await admin
      .from('decisions')
      .delete()
      .eq('id', existingRow.id);

    if (error) {
      throw new Error(`Failed to delete stale v2 decision ${existingRow.id}: ${error.message}`);
    }

    deleted += 1;
  }

  return { decisionIdsByLocalId, created, updated, deleted, preserved };
}

async function upsertV2Tasks(
  admin: SupabaseClient,
  params: {
    documentId: string;
    organizationId: string;
    projectId?: string | null;
    tasks: IntelligenceTaskInsert[];
    decisionIdsByLocalId: Map<string, string>;
    allowLegacyTypeFallback: boolean;
  },
): Promise<{
  taskIdsByLocalId: Map<string, string>;
  created: number;
  updated: number;
  deleted: number;
  preserved: number;
}> {
  const { documentId, organizationId, projectId, tasks, decisionIdsByLocalId, allowLegacyTypeFallback } = params;
  const now = new Date().toISOString();
  const existing = await loadExistingV2Tasks(admin, documentId, organizationId);
  const reusableExisting = existing.filter((row) => isReusableTaskRow(row));
  const existingByIdentityKey = new Map(
    reusableExisting
      .map((row) => [getIdentityKey(row.details), row] as const)
      .filter((entry): entry is [string, ExistingTaskRow] => entry[0] != null),
  );
  const fallbackRowsByType = new Map<string, ExistingTaskRow[]>();
  for (const row of reusableExisting) {
    if (getIdentityKey(row.details)) continue;
    const rows = fallbackRowsByType.get(row.task_type) ?? [];
    rows.push(row);
    fallbackRowsByType.set(row.task_type, rows);
  }
  const incomingCountByType = new Map<string, number>();
  for (const task of tasks) {
    incomingCountByType.set(
      task.task_type,
      (incomingCountByType.get(task.task_type) ?? 0) + 1,
    );
  }
  const matchedExistingIds = new Set<string>();
  const taskIdsByLocalId = new Map<string, string>();

  let created = 0;
  let updated = 0;

  for (const task of tasks) {
    const fallbackRows = allowLegacyTypeFallback
      ? (fallbackRowsByType.get(task.task_type) ?? [])
      : [];
    const existingRow =
      existingByIdentityKey.get(task.identity_key) ??
      (fallbackRows.length === 1 && (incomingCountByType.get(task.task_type) ?? 0) === 1
        ? fallbackRows[0]
        : undefined);
    const decisionId = task.related_decision_local_id
      ? decisionIdsByLocalId.get(task.related_decision_local_id) ?? null
      : null;

    if (existingRow) {
      const { error } = await admin
        .from('workflow_tasks')
        .update({
          decision_id: decisionId,
          title: task.title,
          description: task.description,
          priority: task.priority,
          source: task.source,
          source_metadata: task.source_metadata,
          details: task.details,
          updated_at: now,
        })
        .eq('id', existingRow.id);

      if (error) {
        throw new Error(`Failed to update v2 workflow task ${existingRow.id}: ${error.message}`);
      }

      matchedExistingIds.add(existingRow.id);
      taskIdsByLocalId.set(task.local_id, existingRow.id);
      updated += 1;
      continue;
    }

    const { data: inserted, error } = await admin
      .from('workflow_tasks')
      .insert({
        organization_id: organizationId,
        document_id: documentId,
        project_id: projectId ?? null,
        decision_id: decisionId,
        task_type: task.task_type,
        title: task.title,
        description: task.description,
        priority: task.priority,
        status: task.lifecycle_status,
        source: task.source,
        source_metadata: task.source_metadata,
        details: task.details,
        created_at: now,
        updated_at: now,
      })
      .select('id')
      .single();

    if (error || !inserted) {
      throw new Error(`Failed to insert v2 workflow task ${task.task_type}: ${error?.message ?? 'unknown error'}`);
    }

    const insertedId = (inserted as { id: string }).id;
    taskIdsByLocalId.set(task.local_id, insertedId);
    created += 1;
  }

  let deleted = 0;
  let preserved = 0;

  for (const existingRow of existing) {
    if (matchedExistingIds.has(existingRow.id)) continue;

    if (hasSupersededMarker(existingRow.details)) {
      preserved += 1;
      continue;
    }

    if (isOperatorManagedTask(existingRow)) {
      const { error } = await admin
        .from('workflow_tasks')
        .update({
          details: withSupersededDetails(existingRow.details, now),
          updated_at: now,
        })
        .eq('id', existingRow.id);

      if (error) {
        throw new Error(`Failed to preserve stale v2 workflow task ${existingRow.id}: ${error.message}`);
      }

      preserved += 1;
      continue;
    }

    const { error } = await admin
      .from('workflow_tasks')
      .delete()
      .eq('id', existingRow.id);

    if (error) {
      throw new Error(`Failed to delete stale v2 workflow task ${existingRow.id}: ${error.message}`);
    }

    deleted += 1;
  }

  return { taskIdsByLocalId, created, updated, deleted, preserved };
}

export async function generateAndPersistCanonicalIntelligence(params: {
  admin: SupabaseClient;
  documentId: string;
  organizationId: string;
  projectId?: string | null;
  extractionData?: Record<string, unknown> | null;
}): Promise<PersistCanonicalIntelligenceResult> {
  const buildContext = await loadBuildParams(params.admin, {
    documentId: params.documentId,
    organizationId: params.organizationId,
    extractionData: params.extractionData,
  });

  if (!buildContext) {
    return {
      handled: false,
      family: null,
      intelligence: null,
      decisions_created: 0,
      decisions_updated: 0,
      decisions_deleted: 0,
      decisions_preserved: 0,
      tasks_created: 0,
      tasks_updated: 0,
      tasks_deleted: 0,
      tasks_preserved: 0,
      legacy_decisions_suppressed: 0,
      legacy_tasks_cancelled: 0,
    };
  }

  const pipelineResult = runDocumentPipeline({
    documentId: params.documentId,
    documentType: buildContext.buildParams.documentType,
    documentName: buildContext.buildParams.documentName,
    documentTitle: buildContext.buildParams.documentTitle,
    projectName: buildContext.buildParams.projectName,
    extractionData: buildContext.buildParams.extractionData,
    relatedDocs: buildContext.buildParams.relatedDocs,
  });
  const contractInvoicePrimaryMode = isContractInvoicePrimaryDocumentType(
    buildContext.buildParams.documentType,
  );

  if (contractInvoicePrimaryMode && !pipelineResult.handled) {
    throw new Error(
      `Contract/invoice canonical pipeline did not handle document ${params.documentId}.`,
    );
  }

  const intelligence = pipelineResult.handled
    ? pipelineResultToIntelligence(pipelineResult)
    : buildDocumentIntelligence(buildContext.buildParams);
  const family = intelligence.classification.family;
  const mapped = mapIntelligenceToPersistenceRows({
    documentId: params.documentId,
    organizationId: params.organizationId,
    intelligence,
    extractionSnapshotId: buildContext.extractionSnapshotId,
    relatedDocs: buildContext.buildParams.relatedDocs,
  });

  if (!supportsCanonicalIntelligencePersistence(family)) {
    await persistDocumentExecutionTrace(params.admin, {
      documentId: params.documentId,
      organizationId: params.organizationId,
      executionTrace: mapped.executionTrace,
    });
    return {
      handled: false,
      family,
      intelligence,
      decisions_created: 0,
      decisions_updated: 0,
      decisions_deleted: 0,
      decisions_preserved: 0,
      tasks_created: 0,
      tasks_updated: 0,
      tasks_deleted: 0,
      tasks_preserved: 0,
      legacy_decisions_suppressed: 0,
      legacy_tasks_cancelled: 0,
    };
  }

  const decisionResult = await upsertV2Decisions(params.admin, {
    documentId: params.documentId,
    organizationId: params.organizationId,
    projectId: params.projectId ?? null,
    decisions: mapped.decisions,
    allowLegacyTypeFallback: !isContractInvoicePrimaryFamily(family),
  });

  const taskResult = await upsertV2Tasks(params.admin, {
    documentId: params.documentId,
    organizationId: params.organizationId,
    projectId: params.projectId ?? null,
    tasks: mapped.tasks,
    decisionIdsByLocalId: decisionResult.decisionIdsByLocalId,
    allowLegacyTypeFallback: !isContractInvoicePrimaryFamily(family),
  });

  await persistDocumentExecutionTrace(params.admin, {
    documentId: params.documentId,
    organizationId: params.organizationId,
    executionTrace: materializePersistedExecutionTrace({
      executionTrace: mapped.executionTrace,
      decisionIdsByLocalId: decisionResult.decisionIdsByLocalId,
      taskIdsByLocalId: taskResult.taskIdsByLocalId,
    }),
  });

  const legacyTasksCancelled = await cancelLegacyGeneratedTasks(
    params.admin,
    params.documentId,
    params.organizationId,
  );
  const legacyDecisionsSuppressed = await suppressLegacyGeneratedDecisions(
    params.admin,
    params.documentId,
    params.organizationId,
  );

  return {
    handled: true,
    family,
    intelligence,
    decisions_created: decisionResult.created,
    decisions_updated: decisionResult.updated,
    decisions_deleted: decisionResult.deleted,
    decisions_preserved: decisionResult.preserved,
    tasks_created: taskResult.created,
    tasks_updated: taskResult.updated,
    tasks_deleted: taskResult.deleted,
    tasks_preserved: taskResult.preserved,
    legacy_decisions_suppressed: legacyDecisionsSuppressed,
    legacy_tasks_cancelled: legacyTasksCancelled,
  };
}
