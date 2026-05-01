'use client';

import { useEffect, useState, useCallback } from 'react';
import { pickPreferredExtractionBlob } from '@/lib/blobExtractionSelection';
import {
  generateForgeDecisionsForDocument,
  type ForgeGeneratedDecision,
} from '@/lib/forgeDecisionGenerator';
import { supabase } from '@/lib/supabaseClient';
import { isMissingProjectIdColumnError } from '@/lib/isMissingProjectIdColumnError';
import type { CanonicalProjectTransactionDatasetInput } from '@/lib/projectFacts';
import { useCurrentOrg } from '@/lib/useCurrentOrg';
import { useOrgMembers } from '@/lib/useOrgMembers';
import type { DocumentExecutionTrace } from '@/lib/types/documentIntelligence';
import type { ValidationFinding } from '@/types/validator';
import {
  dedupeById,
  matchesProjectDecision,
  matchesProjectTask,
  type ProjectActivityEventRow,
  type ProjectDecisionRow,
  type ProjectDocumentRow,
  type ProjectDocumentRelationshipRow,
  type ProjectDocumentReviewRow,
  type ProjectMember,
  type ProjectRecord,
  type ProjectTaskRow,
} from '@/lib/projectOverview';

const BASE_DECISION_SELECT =
  'id, document_id, source, decision_type, title, summary, severity, status, confidence, last_detected_at, created_at, due_at, assigned_to, details, assignee:user_profiles!assigned_to(id, display_name), documents(id, project_id, title, name, document_type)';
const BASE_TASK_SELECT =
  'id, decision_id, document_id, task_type, title, description, priority, status, created_at, updated_at, due_at, assigned_to, details, source_metadata, assignee:user_profiles!assigned_to(id, display_name), documents(id, project_id, title, name, document_type)';
const DOCUMENT_SELECT_WITH_PRECEDENCE =
  'id, title, name, document_type, document_subtype, domain, processing_status, processing_error, created_at, processed_at, project_id, document_role, authority_status, effective_date, precedence_rank, operator_override_precedence, intelligence_trace';
const DOCUMENT_SELECT_LEGACY =
  'id, title, name, document_type, domain, processing_status, processing_error, created_at, processed_at, project_id, intelligence_trace';
const DOCUMENT_RELATIONSHIP_SELECT =
  'id, project_id, source_document_id, target_document_id, relationship_type, created_by, created_at';

function collectError(
  messageParts: string[],
  label: string,
  error: { message?: string | null } | null | undefined,
) {
  if (error?.message) {
    messageParts.push(`${label}: ${error.message}`);
  }
}

type ProjectDocumentExtractionRow = {
  id: string;
  document_id: string;
  data: Record<string, unknown> | null;
  created_at: string;
};

type ProjectTransactionDatasetRow = CanonicalProjectTransactionDatasetInput;

type ProjectRowsQueryResult = {
  data: unknown[] | null;
  error: { code?: string | null; message?: string | null } | null;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isMissingDocumentPrecedenceColumnError(
  error: { code?: string | null; message?: string | null } | null | undefined,
): boolean {
  const message = (error?.message ?? '').toLowerCase();
  if (error?.code !== '42703' && error?.code !== 'PGRST204') {
    return false;
  }
  return [
    'document_role',
    'document_subtype',
    'authority_status',
    'effective_date',
    'precedence_rank',
    'operator_override_precedence',
  ].some((column) => message.includes(column));
}

function isMissingDocumentRelationshipsTableError(
  error: { code?: string | null; message?: string | null } | null | undefined,
): boolean {
  return error?.code === '42P01'
    || error?.code === 'PGRST205'
    || (error?.message ?? '').toLowerCase().includes('document_relationships');
}

function isMissingProjectValidationPhaseColumnError(
  error: { code?: string | null; message?: string | null } | null | undefined,
): boolean {
  const message = (error?.message ?? '').toLowerCase();
  return (
    (error?.code === '42703' || error?.code === 'PGRST204')
    && message.includes('validation_phase')
  );
}

function parseExecutionTrace(
  raw: ProjectDocumentRow['intelligence_trace'],
): DocumentExecutionTrace | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const candidate = raw as Partial<DocumentExecutionTrace>;
  if (!candidate.facts || typeof candidate.facts !== 'object') return null;
  if (!Array.isArray(candidate.decisions) || !Array.isArray(candidate.flow_tasks)) return null;
  return candidate as DocumentExecutionTrace;
}

function hydrateDocumentTraceWithPreferredExtraction(
  document: ProjectDocumentRow,
  extractionData: Record<string, unknown> | null | undefined,
): ProjectDocumentRow {
  const typedFields = asRecord(asRecord(extractionData)?.fields)?.typed_fields;
  if (!typedFields) return document;

  const rawTrace = asRecord(document.intelligence_trace);
  const existingExtracted = asRecord(rawTrace?.extracted);
  const hydratedTrace = rawTrace
    ? {
        ...rawTrace,
        extracted: {
          ...(existingExtracted ?? {}),
          ...typedFields,
        },
      }
    : {
        facts: {},
        decisions: [],
        flow_tasks: [],
        extracted: {
          ...typedFields,
        },
      };

  return {
    ...document,
    intelligence_trace: hydratedTrace,
  };
}

/**
 * When `decisions.project_id` / `workflow_tasks.project_id` are not migrated yet,
 * scope rows via document_id and decision_id joins only (no project_id filters).
 */
async function fetchDecisionsAndTasksViaDocumentScope(
  organizationId: string,
  projectRow: ProjectRecord,
  projectDocumentIds: string[],
  issues: string[],
): Promise<{ decisions: ProjectDecisionRow[]; tasks: ProjectTaskRow[] }> {
  const docDecisions =
    projectDocumentIds.length === 0
      ? { data: [] as unknown[], error: null }
      : await supabase
          .from('decisions')
          .select(BASE_DECISION_SELECT)
          .eq('organization_id', organizationId)
          .in('document_id', projectDocumentIds)
          .order('last_detected_at', { ascending: false });

  collectError(issues, 'Decisions (by document)', docDecisions.error);

  const orphanDecisions = await supabase
    .from('decisions')
    .select(BASE_DECISION_SELECT)
    .eq('organization_id', organizationId)
    .is('document_id', null)
    .order('last_detected_at', { ascending: false })
    .limit(100);

  collectError(issues, 'Decisions (unlinked)', orphanDecisions.error);

  const fromDocs = (docDecisions.data ?? []) as ProjectDecisionRow[];
  const fromOrphans = ((orphanDecisions.data ?? []) as ProjectDecisionRow[]).filter((d) =>
    matchesProjectDecision(d, projectRow),
  );
  const projectDecisions = dedupeById([...fromDocs, ...fromOrphans]);
  const projectDecisionIds = new Set(projectDecisions.map((d) => d.id));
  const decisionIds = projectDecisions.map((d) => d.id);

  const docTasks =
    projectDocumentIds.length === 0
      ? { data: [] as unknown[], error: null }
      : await supabase
          .from('workflow_tasks')
          .select(BASE_TASK_SELECT)
          .eq('organization_id', organizationId)
          .in('document_id', projectDocumentIds)
          .order('created_at', { ascending: false });

  collectError(issues, 'Tasks (by document)', docTasks.error);

  const byDecisionTasks =
    decisionIds.length === 0
      ? { data: [] as unknown[], error: null }
      : await supabase
          .from('workflow_tasks')
          .select(BASE_TASK_SELECT)
          .eq('organization_id', organizationId)
          .in('decision_id', decisionIds)
          .order('created_at', { ascending: false });

  collectError(issues, 'Tasks (by decision)', byDecisionTasks.error);

  const orphanTasks = await supabase
    .from('workflow_tasks')
    .select(BASE_TASK_SELECT)
    .eq('organization_id', organizationId)
    .is('document_id', null)
    .order('created_at', { ascending: false })
    .limit(150);

  collectError(issues, 'Tasks (unlinked)', orphanTasks.error);

  const projectTasks = dedupeById([
    ...((docTasks.data ?? []) as ProjectTaskRow[]),
    ...((byDecisionTasks.data ?? []) as ProjectTaskRow[]),
    ...((orphanTasks.data ?? []) as ProjectTaskRow[]).filter((t) =>
      matchesProjectTask(t, projectRow, projectDecisionIds),
    ),
  ]);

  return { decisions: projectDecisions, tasks: projectTasks };
}

export type ProjectWorkspaceDataState = {
  project: ProjectRecord | null;
  documents: ProjectDocumentRow[];
  documentRelationships: ProjectDocumentRelationshipRow[];
  transactionDatasets: ProjectTransactionDatasetRow[];
  validationFindings: ValidationFinding[];
  documentReviews: ProjectDocumentReviewRow[];
  generatedDecisions: ForgeGeneratedDecision[];
  decisions: ProjectDecisionRow[];
  tasks: ProjectTaskRow[];
  activityEvents: ProjectActivityEventRow[];
  loading: boolean;
  notFound: boolean;
  pageError: string | null;
  loadIssue: string | null;
  organizationId: string | null;
  orgLoading: boolean;
  members: ProjectMember[];
  /** Re-runs the project workspace query (documents, decisions, tasks, audit). */
  refetch: () => void;
};

/**
 * Loads all rows needed for {@link buildProjectOverviewModel} and forge layouts.
 * Scoped to `projectId` and the current organization — no unscoped queries.
 */
export function useProjectWorkspaceData(projectId: string): ProjectWorkspaceDataState {
  const { organization, loading: orgLoading } = useCurrentOrg();
  const organizationId = organization?.id ?? null;
  const { members } = useOrgMembers(organizationId);

  const [project, setProject] = useState<ProjectRecord | null>(null);
  const [documents, setDocuments] = useState<ProjectDocumentRow[]>([]);
  const [documentRelationships, setDocumentRelationships] = useState<ProjectDocumentRelationshipRow[]>([]);
  const [transactionDatasets, setTransactionDatasets] = useState<ProjectTransactionDatasetRow[]>([]);
  const [validationFindings, setValidationFindings] = useState<ValidationFinding[]>([]);
  const [documentReviews, setDocumentReviews] = useState<ProjectDocumentReviewRow[]>([]);
  const [generatedDecisions, setGeneratedDecisions] = useState<ForgeGeneratedDecision[]>([]);
  const [decisions, setDecisions] = useState<ProjectDecisionRow[]>([]);
  const [tasks, setTasks] = useState<ProjectTaskRow[]>([]);
  const [activityEvents, setActivityEvents] = useState<ProjectActivityEventRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [pageError, setPageError] = useState<string | null>(null);
  const [loadIssue, setLoadIssue] = useState<string | null>(null);
  const [refetchState, setRefetchState] = useState({ projectId, tick: 0 });

  const refetch = useCallback(() => {
    setRefetchState((current) => ({
      projectId,
      tick: current.projectId === projectId ? current.tick + 1 : 1,
    }));
  }, [projectId]);

  useEffect(() => {
    if (orgLoading || !organizationId) {
      return;
    }

    let cancelled = false;

    const load = async () => {
      const silentRefetch = refetchState.projectId === projectId && refetchState.tick > 0;
      if (!silentRefetch) {
        setLoading(true);
      }
      setPageError(null);
      setLoadIssue(null);
      setNotFound(false);

      const issues: string[] = [];

      const [
        projectResult,
        documentsWithPrecedenceResult,
        transactionDatasetsResult,
        validationFindingsResult,
        documentRelationshipsResult,
      ] = await Promise.all([
        supabase
          .from('projects')
          .select('id, name, code, status, created_at, validation_status, validation_summary_json, validation_phase')
          .eq('organization_id', organizationId)
          .eq('id', projectId)
          .maybeSingle(),
        supabase
          .from('documents')
          .select(DOCUMENT_SELECT_WITH_PRECEDENCE)
          .eq('organization_id', organizationId)
          .eq('project_id', projectId)
          .order('created_at', { ascending: false }),
        supabase
          .from('transaction_data_datasets')
          .select('document_id, row_count, date_range_start, date_range_end, summary_json, created_at')
          .eq('project_id', projectId)
          .order('created_at', { ascending: false }),
        supabase
          .from('project_validation_findings')
          .select('*')
          .eq('project_id', projectId)
          .eq('status', 'open'),
        supabase
          .from('document_relationships')
          .select(DOCUMENT_RELATIONSHIP_SELECT)
          .eq('organization_id', organizationId)
          .eq('project_id', projectId)
          .order('created_at', { ascending: false }),
      ]);
      collectError(issues, 'Transaction datasets', transactionDatasetsResult.error);
      collectError(issues, 'Validation findings', validationFindingsResult.error);

      let resolvedProjectResult = projectResult;
      if (projectResult.error && isMissingProjectValidationPhaseColumnError(projectResult.error)) {
        issues.push(
          'Project validation phase is not available yet; using the default contract setup phase until that field is migrated.',
        );
        resolvedProjectResult = await supabase
          .from('projects')
          .select('id, name, code, status, created_at, validation_status, validation_summary_json')
          .eq('organization_id', organizationId)
          .eq('id', projectId)
          .maybeSingle();
      }

      let documentsResult = documentsWithPrecedenceResult as ProjectRowsQueryResult;
      if (documentsWithPrecedenceResult.error && isMissingDocumentPrecedenceColumnError(documentsWithPrecedenceResult.error)) {
        issues.push(
          'Document precedence columns are not available yet; using legacy document records until those fields are migrated.',
        );
        documentsResult = await supabase
          .from('documents')
          .select(DOCUMENT_SELECT_LEGACY)
          .eq('organization_id', organizationId)
          .eq('project_id', projectId)
          .order('created_at', { ascending: false }) as ProjectRowsQueryResult;
      }

      collectError(issues, 'Documents', documentsResult.error);

      if (resolvedProjectResult.error) {
        if (!cancelled) {
          setPageError('Failed to load this project.');
          setDocumentRelationships([]);
          setValidationFindings([]);
          setGeneratedDecisions([]);
          setLoading(false);
        }
        return;
      }

      if (!resolvedProjectResult.data) {
        if (!cancelled) {
          setNotFound(true);
          setDocumentRelationships([]);
          setValidationFindings([]);
          setGeneratedDecisions([]);
          setLoading(false);
        }
        return;
      }

      const projectRow = resolvedProjectResult.data as ProjectRecord;
      const projectDocuments = (documentsResult.data ?? []) as ProjectDocumentRow[];
      let projectDocumentRelationships: ProjectDocumentRelationshipRow[] = [];
      if (documentRelationshipsResult.error) {
        if (isMissingDocumentRelationshipsTableError(documentRelationshipsResult.error)) {
          issues.push(
            'Document relationship records are not available yet; project truth is falling back to document heuristics.',
          );
        } else {
          collectError(issues, 'Document relationships', documentRelationshipsResult.error);
        }
      } else {
        projectDocumentRelationships =
          (documentRelationshipsResult.data ?? []) as ProjectDocumentRelationshipRow[];
      }
      const projectTransactionDatasets = !transactionDatasetsResult.error
        ? ((transactionDatasetsResult.data ?? []) as ProjectTransactionDatasetRow[])
        : [];
      const projectValidationFindings = !validationFindingsResult.error
        ? ((validationFindingsResult.data ?? []) as ValidationFinding[])
        : [];
      const projectDocumentIds = projectDocuments.map((document) => document.id);
      const reviewsResult = projectDocumentIds.length > 0
        ? await supabase
            .from('document_reviews')
            .select('document_id, status, reviewed_at')
            .eq('organization_id', organizationId)
            .in('document_id', projectDocumentIds)
        : { data: [], error: null };
      const extractionsResult = projectDocumentIds.length > 0
        ? await supabase
            .from('document_extractions')
            .select('id, document_id, data, created_at')
            .eq('organization_id', organizationId)
            .in('document_id', projectDocumentIds)
            .is('field_key', null)
            .order('created_at', { ascending: false })
        : { data: [], error: null };
      const projectDocumentReviews = !reviewsResult.error
        ? ((reviewsResult.data ?? []) as ProjectDocumentReviewRow[])
        : [];
      collectError(issues, 'Extraction blobs', extractionsResult.error);

      const extractionRows = !extractionsResult.error
        ? ((extractionsResult.data ?? []) as ProjectDocumentExtractionRow[])
        : [];
      const extractionRowsByDocumentId = new Map<string, ProjectDocumentExtractionRow[]>();
      for (const row of extractionRows) {
        const current = extractionRowsByDocumentId.get(row.document_id) ?? [];
        current.push(row);
        extractionRowsByDocumentId.set(row.document_id, current);
      }

      const hydratedProjectDocuments = projectDocuments.map((document) => {
        const preferredExtraction = pickPreferredExtractionBlob(
          extractionRowsByDocumentId.get(document.id) ?? [],
        );
        return hydrateDocumentTraceWithPreferredExtraction(
          document,
          preferredExtraction?.data ?? null,
        );
      });

      const generated = hydratedProjectDocuments
        .filter((document) => document.processing_status === 'extracted' || document.processing_status === 'decisioned')
        .flatMap((document) => {
          const preferredExtraction = pickPreferredExtractionBlob(
            extractionRowsByDocumentId.get(document.id) ?? [],
          );
          const executionTrace = parseExecutionTrace(document.intelligence_trace ?? null);
          if (!preferredExtraction?.data) return [];

          try {
            return generateForgeDecisionsForDocument({
              documentId: document.id,
              documentName: document.name,
              documentTitle: document.title,
              documentType: document.document_type,
              projectName: projectRow.name,
              preferredExtractionData: preferredExtraction.data,
              executionTrace,
            });
          } catch (error) {
            issues.push(
              `Forge decisions (${document.title || document.name}): ${
                error instanceof Error ? error.message : 'failed to derive decision prompts'
              }`,
            );
            return [];
          }
        });

      // Prefer direct project_id (migration 20260329000000_add_project_id_to_decisions_and_tasks.sql).
      // If columns are missing, fall back to document_id / decision_id scoping only.
      const [linkedDecisionsResult, fallbackDecisionsResult, documentTasksResult, fallbackTasksResult] = await Promise.all([
        supabase
          .from('decisions')
          .select(BASE_DECISION_SELECT)
          .eq('organization_id', organizationId)
          .eq('project_id', projectId)
          .order('last_detected_at', { ascending: false }),
        supabase
          .from('decisions')
          .select(BASE_DECISION_SELECT)
          .eq('organization_id', organizationId)
          .is('project_id', null)
          .is('document_id', null)
          .order('last_detected_at', { ascending: false })
          .limit(50),
        supabase
          .from('workflow_tasks')
          .select(BASE_TASK_SELECT)
          .eq('organization_id', organizationId)
          .eq('project_id', projectId)
          .order('created_at', { ascending: false }),
        supabase
          .from('workflow_tasks')
          .select(BASE_TASK_SELECT)
          .eq('organization_id', organizationId)
          .is('project_id', null)
          .is('document_id', null)
          .order('created_at', { ascending: false })
          .limit(50),
      ]);

      const projectIdColumnMissing =
        isMissingProjectIdColumnError(linkedDecisionsResult.error) ||
        isMissingProjectIdColumnError(fallbackDecisionsResult.error) ||
        isMissingProjectIdColumnError(documentTasksResult.error) ||
        isMissingProjectIdColumnError(fallbackTasksResult.error);

      let projectDecisions: ProjectDecisionRow[];
      let projectTasks: ProjectTaskRow[];

      if (projectIdColumnMissing) {
        issues.push(
          'Loaded decisions/tasks via document links (project_id columns not on database yet). Apply supabase/migrations/20260329000000_add_project_id_to_decisions_and_tasks.sql.',
        );
        const legacy = await fetchDecisionsAndTasksViaDocumentScope(
          organizationId,
          projectRow,
          projectDocumentIds,
          issues,
        );
        projectDecisions = legacy.decisions;
        projectTasks = legacy.tasks;
      } else {
        collectError(issues, 'Decisions', linkedDecisionsResult.error);
        collectError(issues, 'Decision fallbacks', fallbackDecisionsResult.error);
        collectError(issues, 'Tasks', documentTasksResult.error);
        collectError(issues, 'Task fallbacks', fallbackTasksResult.error);

        projectDecisions = dedupeById([
          ...((linkedDecisionsResult.data ?? []) as ProjectDecisionRow[]),
          ...((fallbackDecisionsResult.data ?? []) as ProjectDecisionRow[]).filter((decision) =>
            matchesProjectDecision(decision, projectRow),
          ),
        ]);

        const idsForFallbackTasks = new Set(projectDecisions.map((decision) => decision.id));

        projectTasks = dedupeById([
          ...((documentTasksResult.data ?? []) as ProjectTaskRow[]),
          ...((fallbackTasksResult.data ?? []) as ProjectTaskRow[]).filter((task) =>
            matchesProjectTask(task, projectRow, idsForFallbackTasks),
          ),
        ]);
      }

      const projectDecisionIds = new Set(projectDecisions.map((decision) => decision.id));

      const projectTaskIds = new Set(projectTasks.map((task) => task.id));
      const projectDocumentIdSet = new Set(projectDocumentIds);

      const activityResult = await supabase
        .from('activity_events')
        .select('id, project_id, entity_type, entity_id, event_type, old_value, new_value, changed_by, created_at')
        .eq('organization_id', organizationId)
        .order('created_at', { ascending: false })
        .limit(150);

      collectError(issues, 'Audit events', activityResult.error);

      const filteredActivityEvents = ((activityResult.data ?? []) as ProjectActivityEventRow[]).filter((event) => {
        if (event.entity_type === 'decision') return projectDecisionIds.has(event.entity_id);
        if (event.entity_type === 'workflow_task') return projectTaskIds.has(event.entity_id);
        if (event.entity_type === 'project') return event.entity_id === projectId;
        if (event.entity_type === 'project_validation_run') return event.project_id === projectId;
        if (event.entity_type === 'document') {
          if (projectDocumentIdSet.has(event.entity_id)) return true;
          const oldProjectId = typeof event.old_value?.project_id === 'string'
            ? event.old_value.project_id
            : null;
          const newProjectId = typeof event.new_value?.project_id === 'string'
            ? event.new_value.project_id
            : null;
          return oldProjectId === projectId || newProjectId === projectId;
        }
        return false;
      });

      if (cancelled) return;

      setProject(projectRow);
      setDocuments(hydratedProjectDocuments);
      setDocumentRelationships(projectDocumentRelationships);
      setTransactionDatasets(projectTransactionDatasets);
      setValidationFindings(projectValidationFindings);
      setDocumentReviews(projectDocumentReviews);
      setGeneratedDecisions(generated);
      setDecisions(projectDecisions);
      setTasks(projectTasks);
      setActivityEvents(filteredActivityEvents);
      setLoadIssue(issues.length > 0 ? `Project loaded with partial data issues. ${issues.join(' | ')}` : null);
      setLoading(false);
    };

    load().catch((error) => {
      if (cancelled) return;
      setPageError(error instanceof Error ? error.message : 'Failed to load this project.');
      setDocumentRelationships([]);
      setValidationFindings([]);
      setGeneratedDecisions([]);
      setLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, [projectId, organizationId, orgLoading, refetchState]);

  return {
    project,
    documents,
    documentRelationships,
    transactionDatasets,
    validationFindings,
    documentReviews,
    generatedDecisions,
    decisions,
    tasks,
    activityEvents,
    loading,
    notFound,
    pageError,
    loadIssue,
    organizationId,
    orgLoading,
    members,
    refetch,
  };
}
