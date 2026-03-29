'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabaseClient';
import { useCurrentOrg } from '@/lib/useCurrentOrg';
import { useOrgMembers } from '@/lib/useOrgMembers';
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

function collectError(messageParts: string[], label: string, error: { message?: string } | null | undefined) {
  if (error?.message) {
    messageParts.push(`${label}: ${error.message}`);
  }
}

export type ProjectWorkspaceDataState = {
  project: ProjectRecord | null;
  documents: ProjectDocumentRow[];
  documentReviews: ProjectDocumentReviewRow[];
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
  const [decisions, setDecisions] = useState<ProjectDecisionRow[]>([]);
  const [tasks, setTasks] = useState<ProjectTaskRow[]>([]);
  const [activityEvents, setActivityEvents] = useState<ProjectActivityEventRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [pageError, setPageError] = useState<string | null>(null);
  const [loadIssue, setLoadIssue] = useState<string | null>(null);

  useEffect(() => {
    if (orgLoading || !organizationId) {
      return;
    }

    let cancelled = false;

    const load = async () => {
      setLoading(true);
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
          setLoading(false);
        }
        return;
      }

      if (!projectResult.data) {
        if (!cancelled) {
          setNotFound(true);
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
      const projectDocumentReviews = !reviewsResult.error
        ? ((reviewsResult.data ?? []) as ProjectDocumentReviewRow[])
        : [];

      const baseDecisionSelect =
        'id, document_id, decision_type, title, summary, severity, status, confidence, last_detected_at, created_at, due_at, assigned_to, details, assignee:user_profiles!assigned_to(id, display_name), documents(id, project_id, title, name, document_type)';
      const baseTaskSelect =
        'id, decision_id, document_id, task_type, title, description, priority, status, created_at, updated_at, due_at, assigned_to, details, source_metadata, assignee:user_profiles!assigned_to(id, display_name), documents(id, project_id, title, name, document_type)';

      // Primary queries use direct project_id FK (added in migration 20260329).
      // Fallback queries catch legacy rows where project_id was never set and
      // neither document_id nor project_id link the row to any project.
      const [linkedDecisionsResult, fallbackDecisionsResult, documentTasksResult, fallbackTasksResult] = await Promise.all([
        supabase
          .from('decisions')
          .select(baseDecisionSelect)
          .eq('organization_id', organizationId)
          .eq('project_id', projectId)
          .order('last_detected_at', { ascending: false }),
        supabase
          .from('decisions')
          .select(baseDecisionSelect)
          .eq('organization_id', organizationId)
          .is('project_id', null)
          .is('document_id', null)
          .order('last_detected_at', { ascending: false })
          .limit(50),
        supabase
          .from('workflow_tasks')
          .select(baseTaskSelect)
          .eq('organization_id', organizationId)
          .eq('project_id', projectId)
          .order('created_at', { ascending: false }),
        supabase
          .from('workflow_tasks')
          .select(baseTaskSelect)
          .eq('organization_id', organizationId)
          .is('project_id', null)
          .is('document_id', null)
          .order('created_at', { ascending: false })
          .limit(50),
      ]);

      collectError(issues, 'Decisions', linkedDecisionsResult.error);
      collectError(issues, 'Decision fallbacks', fallbackDecisionsResult.error);
      collectError(issues, 'Tasks', documentTasksResult.error);
      collectError(issues, 'Task fallbacks', fallbackTasksResult.error);

      const projectDecisions = dedupeById([
        ...((linkedDecisionsResult.data ?? []) as ProjectDecisionRow[]),
        ...((fallbackDecisionsResult.data ?? []) as ProjectDecisionRow[]).filter((decision) =>
          matchesProjectDecision(decision, projectRow),
        ),
      ]);

      const projectDecisionIds = new Set(projectDecisions.map((decision) => decision.id));

      const projectTasks = dedupeById([
        ...((documentTasksResult.data ?? []) as ProjectTaskRow[]),
        ...((fallbackTasksResult.data ?? []) as ProjectTaskRow[]).filter((task) =>
          matchesProjectTask(task, projectRow, projectDecisionIds),
        ),
      ]);

      const projectTaskIds = new Set(projectTasks.map((task) => task.id));

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
        return false;
      });

      if (cancelled) return;

      setProject(projectRow);
      setDocuments(projectDocuments);
      setDocumentReviews(projectDocumentReviews);
      setDecisions(projectDecisions);
      setTasks(projectTasks);
      setActivityEvents(filteredActivityEvents);
      setLoadIssue(issues.length > 0 ? `Project loaded with partial data issues. ${issues.join(' | ')}` : null);
      setLoading(false);
    };

    load().catch((error) => {
      if (cancelled) return;
      setPageError(error instanceof Error ? error.message : 'Failed to load this project.');
      setLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, [projectId, organizationId, orgLoading]);

  return {
    project,
    documents,
    documentReviews,
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
  };
}
