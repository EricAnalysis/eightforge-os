'use client';

import { useEffect, useState, useCallback } from 'react';
import { pickPreferredExtractionBlob } from '@/lib/blobExtractionSelection';
import {
  generateForgeDecisionsForDocument,
  type ForgeGeneratedDecision,
} from '@/lib/forgeDecisionGenerator';
import { supabase } from '@/lib/supabaseClient';
import { isMissingProjectIdColumnError } from '@/lib/isMissingProjectIdColumnError';
import { useCurrentOrg } from '@/lib/useCurrentOrg';
import { useOrgMembers } from '@/lib/useOrgMembers';
import type { DocumentExecutionTrace } from '@/lib/types/documentIntelligence';
import {
  dedupeById,
  matchesProjectDecision,
  matchesProjectTask,
  type ProjectActivityEventRow,
  type ProjectDecisionRow,
  type ProjectDocumentRow,
  type ProjectDocumentReviewRow,
  type ProjectMember,
  type ProjectRecord,
  type ProjectTaskRow,
} from '@/lib/projectOverview';

const BASE_DECISION_SELECT =
  'id, document_id, decision_type, title, summary, severity, status, confidence, last_detected_at, created_at, due_at, assigned_to, details, assignee:user_profiles!assigned_to(id, display_name), documents(id, project_id, title, name, document_type)';
const BASE_TASK_SELECT =
  'id, decision_id, document_id, task_type, title, description, priority, status, created_at, updated_at, due_at, assigned_to, details, source_metadata, assignee:user_profiles!assigned_to(id, display_name), documents(id, project_id, title, name, document_type)';

function collectError(messageParts: string[], label: string, error: { message?: string } | null | undefined) {
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

function parseExecutionTrace(
  raw: ProjectDocumentRow['intelligence_trace'],
): DocumentExecutionTrace | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const candidate = raw as Partial<DocumentExecutionTrace>;
  if (!candidate.facts || typeof candidate.facts !== 'object') return null;
  if (!Array.isArray(candidate.decisions) || !Array.isArray(candidate.flow_tasks)) return null;
  return candidate as DocumentExecutionTrace;
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
  const [documentReviews, setDocumentReviews] = useState<ProjectDocumentReviewRow[]>([]);
  const [generatedDecisions, setGeneratedDecisions] = useState<ForgeGeneratedDecision[]>([]);
  const [decisions, setDecisions] = useState<ProjectDecisionRow[]>([]);
  const [tasks, setTasks] = useState<ProjectTaskRow[]>([]);
  const [activityEvents, setActivityEvents] = useState<ProjectActivityEventRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [pageError, setPageError] = useState<string | null>(null);
  const [loadIssue, setLoadIssue] = useState<string | null>(null);
  const [refetchTick, setRefetchTick] = useState(0);

  const refetch = useCallback(() => {
    setRefetchTick((n) => n + 1);
  }, []);

  useEffect(() => {
    setRefetchTick(0);
  }, [projectId]);

  useEffect(() => {
    if (orgLoading || !organizationId) {
      return;
    }

    let cancelled = false;

    const load = async () => {
      const silentRefetch = refetchTick > 0;
      if (!silentRefetch) {
        setLoading(true);
      }
      setPageError(null);
      setLoadIssue(null);
      setNotFound(false);

      const issues: string[] = [];

      const [projectResult, documentsResult] = await Promise.all([
        supabase
          .from('projects')
          .select('id, name, code, status, created_at')
          .eq('organization_id', organizationId)
          .eq('id', projectId)
          .maybeSingle(),
        supabase
          .from('documents')
          .select('id, title, name, document_type, domain, processing_status, processing_error, created_at, processed_at, project_id, intelligence_trace')
          .eq('organization_id', organizationId)
          .eq('project_id', projectId)
          .order('created_at', { ascending: false }),
      ]);

      collectError(issues, 'Documents', documentsResult.error);

      if (projectResult.error) {
        if (!cancelled) {
          setPageError('Failed to load this project.');
          setGeneratedDecisions([]);
          setLoading(false);
        }
        return;
      }

      if (!projectResult.data) {
        if (!cancelled) {
          setNotFound(true);
          setGeneratedDecisions([]);
          setLoading(false);
        }
        return;
      }

      const projectRow = projectResult.data as ProjectRecord;
      const projectDocuments = (documentsResult.data ?? []) as ProjectDocumentRow[];
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

      const generated = projectDocuments
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
        .select('id, entity_type, entity_id, event_type, old_value, new_value, changed_by, created_at')
        .eq('organization_id', organizationId)
        .order('created_at', { ascending: false })
        .limit(150);

      collectError(issues, 'Audit events', activityResult.error);

      const filteredActivityEvents = ((activityResult.data ?? []) as ProjectActivityEventRow[]).filter((event) => {
        if (event.entity_type === 'decision') return projectDecisionIds.has(event.entity_id);
        if (event.entity_type === 'workflow_task') return projectTaskIds.has(event.entity_id);
        if (event.entity_type === 'project') return event.entity_id === projectId;
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
      setDocuments(projectDocuments);
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
      setGeneratedDecisions([]);
      setLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, [projectId, organizationId, orgLoading, refetchTick]);

  return {
    project,
    documents,
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
