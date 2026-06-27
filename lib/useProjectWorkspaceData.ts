'use client';

import { useEffect, useState, useCallback } from 'react';
import type { ForgeGeneratedDecision } from '@/lib/forgeDecisionGenerator';
import { supabase } from '@/lib/supabaseClient';
import type { ProjectExecutionItemRow } from '@/lib/executionItems';
import { isMissingProjectIdColumnError } from '@/lib/isMissingProjectIdColumnError';
import { perfEnd, perfMeasure, perfStart } from '@/lib/perf';
import {
  loadProjectActivityEvents,
  type ActivityQueryBuilder,
  type ActivityQueryClient,
} from '@/lib/projectActivityEvents';
import type {
  CanonicalProjectTransactionDatasetInput,
  CanonicalProjectTransactionRowInput,
} from '@/lib/projectFacts';
import { useCurrentOrg } from '@/lib/useCurrentOrg';
import { useOrgMembers } from '@/lib/useOrgMembers';
import type { ValidationEvidence, ValidationFinding } from '@/types/validator';
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
  'id, document_id, project_id, source, decision_type, title, summary, severity, status, confidence, last_detected_at, created_at, updated_at, due_at, assigned_to, details, assignee:user_profiles!assigned_to(id, display_name), documents(id, project_id, title, name, document_type)';
const BASE_TASK_SELECT =
  'id, decision_id, document_id, task_type, title, description, priority, status, created_at, updated_at, due_at, assigned_to, details, source_metadata, assignee:user_profiles!assigned_to(id, display_name), documents(id, project_id, title, name, document_type)';
const DOCUMENT_SELECT_WITH_PRECEDENCE =
  'id, title, name, document_type, domain, processing_status, operational_status, processing_error, created_at, processed_at, project_id, document_role, authority_status, effective_date, precedence_rank, operator_override_precedence, intelligence_trace';
const DOCUMENT_SELECT_LEGACY =
  'id, title, name, document_type, domain, processing_status, operational_status, processing_error, created_at, processed_at, project_id, intelligence_trace';
const DOCUMENT_RELATIONSHIP_SELECT =
  'id, project_id, source_document_id, target_document_id, relationship_type, created_by, created_at';
const TRANSACTION_DATA_ROW_SELECT =
  'id, document_id, project_id, invoice_number, transaction_number, rate_code, billing_rate_key, description_match_key, site_material_key, invoice_rate_key, transaction_quantity, extended_cost, invoice_date, source_sheet_name, source_row_number, record_json, raw_row_json, created_at';
const TRANSACTION_DATA_ROW_PAGE_SIZE = 1000;

const activityQueryClient: ActivityQueryClient = {
  from(table) {
    return {
      select(columns) {
        return supabase.from(table).select(columns) as unknown as ActivityQueryBuilder;
      },
    };
  },
};

export function isNonCoreWorkspaceLoadError(
  label: string,
  error: { code?: string | null; message?: string | null } | null | undefined,
): boolean {
  if (!error?.message) return false;
  const normalizedLabel = label.toLowerCase();
  const message = error.message.toLowerCase();

  return (
    normalizedLabel === 'audit events'
    && (
      message.includes('bad request')
      || message.includes('activity_events')
      || message.includes('schema cache')
    )
  );
}

function collectError(
  messageParts: string[],
  label: string,
  error: { code?: string | null; message?: string | null } | null | undefined,
) {
  if (error?.message) {
    if (isNonCoreWorkspaceLoadError(label, error)) {
      console.warn('[project workspace non-core load issue]', {
        label,
        error: error.message,
        code: error.code ?? null,
      });
      return;
    }

    messageParts.push(`${label}: ${error.message}`);
  }
}

function logDeveloperSchemaFallback(
  message: string,
  migration: string,
  error: { message?: string | null } | null | undefined,
) {
  console.warn(`[project workspace schema fallback] ${message}`, {
    migration,
    error: error?.message ?? null,
  });
}

type ProjectTransactionDatasetRow = CanonicalProjectTransactionDatasetInput;

type ProjectRowsQueryResult = {
  data: unknown[] | null;
  error: { code?: string | null; message?: string | null } | null;
};

type ProjectTransactionRowsQueryResult = {
  data: CanonicalProjectTransactionRowInput[];
  error: { code?: string | null; message?: string | null } | null;
};

function isMissingDocumentPrecedenceColumnError(
  error: { code?: string | null; message?: string | null } | null | undefined,
): boolean {
  const message = (error?.message ?? '').toLowerCase();
  if (error?.code !== '42703' && error?.code !== 'PGRST204') {
    return false;
  }
  return [
    'document_role',
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

function isMissingExecutionItemsTableError(
  error: { code?: string | null; message?: string | null } | null | undefined,
): boolean {
  return error?.code === '42P01'
    || error?.code === 'PGRST205'
    || (error?.message ?? '').toLowerCase().includes('execution_items');
}

function isMissingTransactionRowsTableError(
  error: { code?: string | null; message?: string | null } | null | undefined,
): boolean {
  return error?.code === '42P01'
    || error?.code === 'PGRST205'
    || (error?.message ?? '').toLowerCase().includes('transaction_data_rows');
}

async function loadTransactionRowsForProject(
  projectId: string,
): Promise<ProjectTransactionRowsQueryResult> {
  const rows: CanonicalProjectTransactionRowInput[] = [];
  let offset = 0;

  while (true) {
    const result = await supabase
      .from('transaction_data_rows')
      .select(TRANSACTION_DATA_ROW_SELECT)
      .eq('project_id', projectId)
      .order('invoice_date', { ascending: true })
      .order('source_sheet_name', { ascending: true })
      .order('source_row_number', { ascending: true })
      .range(offset, offset + TRANSACTION_DATA_ROW_PAGE_SIZE - 1);

    if (result.error) {
      return { data: rows, error: result.error };
    }

    const batch = (result.data ?? []) as CanonicalProjectTransactionRowInput[];
    rows.push(...batch);
    if (batch.length < TRANSACTION_DATA_ROW_PAGE_SIZE) {
      return { data: rows, error: null };
    }
    offset += TRANSACTION_DATA_ROW_PAGE_SIZE;
  }
}

function attachRowsToTransactionDatasets(
  datasets: readonly ProjectTransactionDatasetRow[],
  rows: readonly CanonicalProjectTransactionRowInput[],
): ProjectTransactionDatasetRow[] {
  if (rows.length === 0) return [...datasets];

  const rowsByDocumentId = new Map<string, CanonicalProjectTransactionRowInput[]>();
  for (const row of rows) {
    if (!row.document_id) continue;
    const existing = rowsByDocumentId.get(row.document_id) ?? [];
    existing.push(row);
    rowsByDocumentId.set(row.document_id, existing);
  }

  return datasets.map((dataset) => ({
    ...dataset,
    rows: rowsByDocumentId.get(dataset.document_id) ?? [],
  }));
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
  validationEvidence: ValidationEvidence[];
  executionItems: ProjectExecutionItemRow[];
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
  const [validationEvidence, setValidationEvidence] = useState<ValidationEvidence[]>([]);
  const [executionItems, setExecutionItems] = useState<ProjectExecutionItemRow[]>([]);
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
      perfStart('[EightForge] workspace total load');
      const silentRefetch = refetchState.projectId === projectId && refetchState.tick > 0;
      try {
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
          transactionRowsResult,
          validationFindingsResult,
          documentRelationshipsResult,
          executionItemsResult,
        ] = await Promise.all([
          supabase
            .from('projects')
            .select('id, name, code, status, created_at, validation_status, validation_summary_json, validation_phase')
            .eq('organization_id', organizationId)
            .eq('id', projectId)
            .maybeSingle(),
          perfMeasure('[EightForge] documents fetch', () =>
            supabase
              .from('documents')
              .select(DOCUMENT_SELECT_WITH_PRECEDENCE)
              .eq('organization_id', organizationId)
              .eq('project_id', projectId)
              .is('deleted_at', null)
              .order('created_at', { ascending: false }),
          ),
          perfMeasure('[EightForge] facts fetch', () =>
            supabase
              .from('transaction_data_datasets')
              .select('document_id, row_count, date_range_start, date_range_end, summary_json, created_at')
              .eq('project_id', projectId)
              .order('created_at', { ascending: false }),
          ),
          perfMeasure('[EightForge] transaction rows fetch', () => loadTransactionRowsForProject(projectId)),
          perfMeasure('[EightForge] findings fetch', () =>
            supabase
              .from('project_validation_findings')
              .select('*')
              .eq('project_id', projectId)
              .eq('status', 'open'),
          ),
          perfMeasure('[EightForge] document relationships fetch', () =>
            supabase
              .from('document_relationships')
              .select(DOCUMENT_RELATIONSHIP_SELECT)
              .eq('organization_id', organizationId)
              .eq('project_id', projectId)
              .order('created_at', { ascending: false }),
          ),
          perfMeasure('[EightForge] execution items fetch', () =>
            supabase
              .from('execution_items')
              .select('*')
              .eq('project_id', projectId)
              .order('updated_at', { ascending: false }),
          ),
        ]);
      collectError(issues, 'Transaction datasets', transactionDatasetsResult.error);
      if (transactionRowsResult.error) {
        if (isMissingTransactionRowsTableError(transactionRowsResult.error)) {
          issues.push(
            'Canonical transaction rows are not available yet; project projection is falling back to persisted transaction summaries.',
          );
        } else {
          collectError(issues, 'Transaction rows', transactionRowsResult.error);
        }
      }
      collectError(issues, 'Validation findings', validationFindingsResult.error);

      let resolvedProjectResult = projectResult;
      if (projectResult.error && isMissingProjectValidationPhaseColumnError(projectResult.error)) {
        logDeveloperSchemaFallback(
          'projects.validation_phase is unavailable; defaulting to contract_setup for this workspace load.',
          'supabase/migrations/20260430000000_document_truth_governance_phase.sql',
          projectResult.error,
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
        logDeveloperSchemaFallback(
          'Document precedence columns are unavailable; using legacy document records for this workspace load.',
          'supabase/migrations/20260323000000_document_precedence.sql',
          documentsWithPrecedenceResult.error,
        );
        documentsResult = await perfMeasure('[EightForge] documents fetch legacy fallback', () =>
          supabase
            .from('documents')
            .select(DOCUMENT_SELECT_LEGACY)
            .eq('organization_id', organizationId)
            .eq('project_id', projectId)
            .is('deleted_at', null)
            .order('created_at', { ascending: false }),
        ) as ProjectRowsQueryResult;
      }

      collectError(issues, 'Documents', documentsResult.error);

      if (resolvedProjectResult.error) {
        if (!cancelled) {
          setPageError('Failed to load this project.');
          setDocumentRelationships([]);
          setValidationFindings([]);
          setValidationEvidence([]);
          setExecutionItems([]);
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
          setValidationEvidence([]);
          setExecutionItems([]);
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
        ? attachRowsToTransactionDatasets(
            (transactionDatasetsResult.data ?? []) as ProjectTransactionDatasetRow[],
            transactionRowsResult.error ? [] : transactionRowsResult.data,
          )
        : [];
      const projectValidationFindings = !validationFindingsResult.error
        ? ((validationFindingsResult.data ?? []) as ValidationFinding[])
        : [];
      let projectExecutionItems: ProjectExecutionItemRow[] = [];
      if (executionItemsResult.error) {
        if (isMissingExecutionItemsTableError(executionItemsResult.error)) {
          issues.push(
            'Execution items are not available yet; project execution is falling back to legacy decision and task records until that table is migrated.',
          );
        } else {
          collectError(issues, 'Execution items', executionItemsResult.error);
        }
      } else {
        projectExecutionItems = (executionItemsResult.data ?? []) as ProjectExecutionItemRow[];
      }
      const projectDocumentIds = projectDocuments.map((document) => document.id);
      const reviewsResult = projectDocumentIds.length > 0
        ? await perfMeasure('[EightForge] document reviews fetch', () =>
            supabase
              .from('document_reviews')
              .select('document_id, status, reviewed_at')
              .eq('organization_id', organizationId)
              .in('document_id', projectDocumentIds),
          )
        : { data: [], error: null };
      const projectDocumentReviews = !reviewsResult.error
        ? ((reviewsResult.data ?? []) as ProjectDocumentReviewRow[])
        : [];
      const hydratedProjectDocuments = projectDocuments;
      const generated: ForgeGeneratedDecision[] = [];

      // Prefer direct project_id (migration 20260329000000_add_project_id_to_decisions_and_tasks.sql).
      // If columns are missing, fall back to document_id / decision_id scoping only.
      const [linkedDecisionsResult, fallbackDecisionsResult, documentScopedDecisionsResult, contextualValidatorDecisionsResult, documentTasksResult, fallbackTasksResult] = await perfMeasure('[EightForge] decisions fetch', () => Promise.all([
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
        projectDocumentIds.length === 0
          ? { data: [], error: null }
          : supabase
              .from('decisions')
              .select(BASE_DECISION_SELECT)
              .eq('organization_id', organizationId)
              .is('project_id', null)
              .in('document_id', projectDocumentIds)
              .order('last_detected_at', { ascending: false }),
        supabase
          .from('decisions')
          .select(BASE_DECISION_SELECT)
          .eq('organization_id', organizationId)
          .eq('source', 'project_validator')
          .order('last_detected_at', { ascending: false })
          .limit(200),
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
      ]));

      const projectIdColumnMissing =
        isMissingProjectIdColumnError(linkedDecisionsResult.error) ||
        isMissingProjectIdColumnError(fallbackDecisionsResult.error) ||
        isMissingProjectIdColumnError(documentScopedDecisionsResult.error) ||
        isMissingProjectIdColumnError(contextualValidatorDecisionsResult.error) ||
        isMissingProjectIdColumnError(documentTasksResult.error) ||
        isMissingProjectIdColumnError(fallbackTasksResult.error);

      let projectDecisions: ProjectDecisionRow[];
      let projectTasks: ProjectTaskRow[];

      if (projectIdColumnMissing) {
        issues.push(
          'Loaded decisions/tasks via document links (project_id columns not on database yet). Apply supabase/migrations/20260329000000_add_project_id_to_decisions_and_tasks.sql.',
        );
        const legacy = await perfMeasure('[EightForge] decisions fetch legacy fallback', () =>
          fetchDecisionsAndTasksViaDocumentScope(
            organizationId,
            projectRow,
            projectDocumentIds,
            issues,
          ),
        );
        projectDecisions = legacy.decisions;
        projectTasks = legacy.tasks;
      } else {
        collectError(issues, 'Decisions', linkedDecisionsResult.error);
        collectError(issues, 'Decision fallbacks', fallbackDecisionsResult.error);
        collectError(issues, 'Decisions (document fallback)', documentScopedDecisionsResult.error);
        collectError(issues, 'Validator decision fallbacks', contextualValidatorDecisionsResult.error);
        collectError(issues, 'Tasks', documentTasksResult.error);
        collectError(issues, 'Task fallbacks', fallbackTasksResult.error);

        projectDecisions = dedupeById([
          ...((linkedDecisionsResult.data ?? []) as ProjectDecisionRow[]),
          ...((documentScopedDecisionsResult.data ?? []) as ProjectDecisionRow[]),
          ...((contextualValidatorDecisionsResult.data ?? []) as ProjectDecisionRow[]).filter((decision) =>
            matchesProjectDecision(decision, projectRow),
          ),
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
      const executionItemIds = new Set(projectExecutionItems.map((item) => item.id));
      const executionFindingIds = new Set(
        [
          ...projectValidationFindings.map((finding) => finding.id),
          ...projectExecutionItems
            .filter((item) => item.source_type === 'validator_finding')
            .map((item) => item.source_id),
        ].filter((value): value is string => typeof value === 'string' && value.length > 0),
      );

      const validationEvidenceResult = executionFindingIds.size > 0
        ? await perfMeasure('[EightForge] validation evidence fetch', () =>
            supabase
              .from('project_validation_evidence')
              .select('*')
              .in('finding_id', Array.from(executionFindingIds)),
          )
        : { data: [], error: null };

      collectError(issues, 'Validation evidence', validationEvidenceResult.error);
      const projectValidationEvidence = !validationEvidenceResult.error
        ? ((validationEvidenceResult.data ?? []) as ValidationEvidence[])
        : [];

      const activityResult = await perfMeasure('[EightForge] audit fetch', () =>
        loadProjectActivityEvents({
          client: activityQueryClient,
          organizationId,
          scope: {
            projectId,
            projectDecisionIds,
            projectTaskIds,
            projectDocumentIds: projectDocumentIdSet,
            executionItemIds,
            executionFindingIds,
          },
        }),
      );

      collectError(issues, 'Audit events', activityResult.error);

      if (cancelled) return;

      setProject(projectRow);
      setDocuments(hydratedProjectDocuments);
      setDocumentRelationships(projectDocumentRelationships);
      setTransactionDatasets(projectTransactionDatasets);
      setValidationFindings(projectValidationFindings);
      setValidationEvidence(projectValidationEvidence);
      setExecutionItems(projectExecutionItems);
      setDocumentReviews(projectDocumentReviews);
      setGeneratedDecisions(generated);
      setDecisions(projectDecisions);
      setTasks(projectTasks);
      setActivityEvents(activityResult.data);
      setLoadIssue(issues.length > 0 ? `Project loaded with partial data issues. ${issues.join(' | ')}` : null);
      setLoading(false);
      } finally {
        perfEnd('[EightForge] workspace total load');
      }
    };

    load().catch((error) => {
      if (cancelled) return;
      setPageError(error instanceof Error ? error.message : 'Failed to load this project.');
      setDocumentRelationships([]);
      setValidationFindings([]);
      setValidationEvidence([]);
      setExecutionItems([]);
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
    validationEvidence,
    executionItems,
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
