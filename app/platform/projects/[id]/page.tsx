'use client';

import { use, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { supabase } from '@/lib/supabaseClient';
import { useCurrentOrg } from '@/lib/useCurrentOrg';
import { useOrgMembers } from '@/lib/useOrgMembers';
import { ProjectOverview } from '@/components/projects/ProjectOverview';
import {
  buildProjectOverviewModel,
  dedupeById,
  matchesProjectDecision,
  matchesProjectTask,
  type ProjectActivityEventRow,
  type ProjectDecisionRow,
  type ProjectDocumentRow,
  type ProjectDocumentReviewRow,
  type ProjectRecord,
  type ProjectTaskRow,
} from '@/lib/projectOverview';

function collectError(messageParts: string[], label: string, error: { message?: string } | null | undefined) {
  if (error?.message) {
    messageParts.push(`${label}: ${error.message}`);
  }
}

export default function ProjectDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
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
          .eq('id', id)
          .maybeSingle(),
        supabase
          .from('documents')
          .select('id, title, name, document_type, domain, processing_status, processing_error, created_at, processed_at, project_id, intelligence_trace')
          .eq('organization_id', organizationId)
          .eq('project_id', id)
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

      const [linkedDecisionsResult, fallbackDecisionsResult] = await Promise.all([
        projectDocumentIds.length > 0
          ? supabase
              .from('decisions')
              .select(baseDecisionSelect)
              .eq('organization_id', organizationId)
              .in('document_id', projectDocumentIds)
              .order('last_detected_at', { ascending: false })
          : Promise.resolve({ data: [], error: null }),
        supabase
          .from('decisions')
          .select(baseDecisionSelect)
          .eq('organization_id', organizationId)
          .is('document_id', null)
          .order('last_detected_at', { ascending: false })
          .limit(100),
      ]);

      collectError(issues, 'Decisions', linkedDecisionsResult.error);
      collectError(issues, 'Decision fallbacks', fallbackDecisionsResult.error);

      const projectDecisions = dedupeById([
        ...((linkedDecisionsResult.data ?? []) as ProjectDecisionRow[]),
        ...((fallbackDecisionsResult.data ?? []) as ProjectDecisionRow[]).filter((decision) =>
          matchesProjectDecision(decision, projectRow),
        ),
      ]);

      const projectDecisionIds = new Set(projectDecisions.map((decision) => decision.id));

      const [documentTasksResult, decisionTasksResult, fallbackTasksResult] = await Promise.all([
        projectDocumentIds.length > 0
          ? supabase
              .from('workflow_tasks')
              .select(baseTaskSelect)
              .eq('organization_id', organizationId)
              .in('document_id', projectDocumentIds)
              .order('created_at', { ascending: false })
          : Promise.resolve({ data: [], error: null }),
        projectDecisionIds.size > 0
          ? supabase
              .from('workflow_tasks')
              .select(baseTaskSelect)
              .eq('organization_id', organizationId)
              .in('decision_id', [...projectDecisionIds])
              .order('created_at', { ascending: false })
          : Promise.resolve({ data: [], error: null }),
        supabase
          .from('workflow_tasks')
          .select(baseTaskSelect)
          .eq('organization_id', organizationId)
          .is('document_id', null)
          .order('created_at', { ascending: false })
          .limit(100),
      ]);

      collectError(issues, 'Tasks', documentTasksResult.error);
      collectError(issues, 'Task fallbacks', fallbackTasksResult.error);

      const projectTasks = dedupeById([
        ...((documentTasksResult.data ?? []) as ProjectTaskRow[]),
        ...((decisionTasksResult.data ?? []) as ProjectTaskRow[]),
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
  }, [id, organizationId, orgLoading]);

  const model = useMemo(() => {
    if (!project) return null;
    return buildProjectOverviewModel({
      project,
      documents,
      documentReviews,
      decisions,
      tasks,
      activityEvents,
      members,
    });
  }, [activityEvents, decisions, documentReviews, documents, members, project, tasks]);

  if (loading || orgLoading) {
    return (
      <div className="space-y-3 px-8 py-10">
        <Link href="/platform/projects" className="text-[11px] text-[#3B82F6] hover:underline">
          Back to projects
        </Link>
        <p className="text-[11px] text-[#94A3B8]">Loading project overview...</p>
      </div>
    );
  }

  if (pageError) {
    return (
      <div className="space-y-3 px-8 py-10">
        <Link href="/platform/projects" className="text-[11px] text-[#3B82F6] hover:underline">
          Back to projects
        </Link>
        <div className="rounded-sm border border-[#EF4444]/30 bg-[#EF4444]/10 px-4 py-3 text-[11px] text-[#EF4444]">
          {pageError}
        </div>
      </div>
    );
  }

  if (notFound || !model) {
    return (
      <div className="space-y-3 px-8 py-10">
        <Link href="/platform/projects" className="text-[11px] text-[#3B82F6] hover:underline">
          Back to projects
        </Link>
        <div className="rounded-sm border border-[#2F3B52]/70 bg-[#111827] px-4 py-4 text-[11px] text-[#94A3B8]">
          Project not found, or you no longer have access to it.
        </div>
      </div>
    );
  }

  return <ProjectOverview model={model} loadIssue={loadIssue} />;
}
