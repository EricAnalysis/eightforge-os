// app/api/workspace/projects/route.ts
// GET: Returns per-project stage counts for all projects in the authenticated
// user's organization. Used by WorkspacePageContent to render pressure signals
// on project cards without loading full project data per card.
//
// Prefers decisions.project_id and workflow_tasks.project_id when present
// (migration 20260329000000_add_project_id_to_decisions_and_tasks.sql).
// Falls back to mapping open rows through documents.document_id → project_id
// when those columns are not migrated yet.
//
// Runs with the service role client to skip per-table RLS on aggregation reads.

import { NextResponse } from 'next/server';
import { isMissingProjectIdColumnError } from '@/lib/isMissingProjectIdColumnError';
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';
import { getActorContext } from '@/lib/server/getActorContext';

export type WorkspaceProjectCounts = {
  project_id: string;
  intake: number;
  extract: number;
  structure: number;
  decide: number;
  act: number;
  overdue: number;
};

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

export async function GET(req: Request) {
  try {
    const ctx = await getActorContext(req);
    if (!ctx.ok) return jsonError(ctx.error, ctx.status);
    const { organizationId } = ctx.actor;
    const includeArchived = new URL(req.url).searchParams.get('includeArchived') === '1';

    const admin = getSupabaseAdmin();
    if (!admin) return jsonError('Server not configured', 503);

    const projectsQuery = admin
      .from('projects')
      .select('id')
      .eq('organization_id', organizationId);

    if (!includeArchived) {
      projectsQuery.neq('status', 'archived');
    }

    const projectsResult = await projectsQuery;

    if (projectsResult.error) return jsonError(projectsResult.error.message, 500);

    const counts: Record<string, WorkspaceProjectCounts> = {};
    for (const p of projectsResult.data ?? []) {
      counts[p.id] = {
        project_id: p.id,
        intake: 0,
        extract: 0,
        structure: 0,
        decide: 0,
        act: 0,
        overdue: 0,
      };
    }

    const projectIds = Object.keys(counts);
    if (projectIds.length === 0) {
      return NextResponse.json({ counts: [] });
    }

    const [docsResult, decisionsResult, tasksResult] = await Promise.all([
      admin
        .from('documents')
        .select('id, project_id, processing_status')
        .eq('organization_id', organizationId)
        .in('project_id', projectIds),

      admin
        .from('decisions')
        .select('project_id')
        .eq('organization_id', organizationId)
        .in('status', ['open', 'in_review'])
        .in('project_id', projectIds),

      admin
        .from('workflow_tasks')
        .select('project_id, due_at')
        .eq('organization_id', organizationId)
        .in('status', ['open', 'in_progress', 'blocked'])
        .in('project_id', projectIds),
    ]);

    if (docsResult.error) return jsonError(docsResult.error.message, 500);

    const docIdToProjectId = new Map<string, string>();
    for (const doc of docsResult.data ?? []) {
      const pid = doc.project_id as string;
      const did = doc.id as string;
      if (did && pid && counts[pid]) {
        docIdToProjectId.set(did, pid);
      }
    }

    for (const doc of docsResult.data ?? []) {
      const pid = doc.project_id as string;
      if (!counts[pid]) continue;
      switch (doc.processing_status) {
        case 'uploaded':
          counts[pid].intake++;
          break;
        case 'processing':
        case 'failed':
          counts[pid].extract++;
          break;
        case 'extracted':
          counts[pid].structure++;
          break;
        default:
          break;
      }
    }

    const decisionsMissing = isMissingProjectIdColumnError(decisionsResult.error);
    const tasksMissing = isMissingProjectIdColumnError(tasksResult.error);

    if (!decisionsResult.error && !decisionsMissing) {
      for (const dec of decisionsResult.data ?? []) {
        const pid = dec.project_id as string;
        if (!pid || !counts[pid]) continue;
        counts[pid].decide++;
      }
    } else if (decisionsMissing) {
      const leg = await admin
        .from('decisions')
        .select('document_id')
        .eq('organization_id', organizationId)
        .in('status', ['open', 'in_review'])
        .not('document_id', 'is', null);
      if (leg.error) return jsonError(leg.error.message, 500);
      for (const row of leg.data ?? []) {
        const did = row.document_id as string;
        const pid = docIdToProjectId.get(did);
        if (pid && counts[pid]) counts[pid].decide++;
      }
    } else {
      return jsonError(decisionsResult.error?.message ?? 'Decisions query failed', 500);
    }

    const now = new Date();

    if (!tasksResult.error && !tasksMissing) {
      for (const task of tasksResult.data ?? []) {
        const pid = task.project_id as string;
        if (!pid || !counts[pid]) continue;
        counts[pid].act++;
        if (task.due_at && new Date(task.due_at as string) < now) {
          counts[pid].overdue++;
        }
      }
    } else if (tasksMissing) {
      const leg = await admin
        .from('workflow_tasks')
        .select('document_id, decision_id, due_at')
        .eq('organization_id', organizationId)
        .in('status', ['open', 'in_progress', 'blocked']);
      if (leg.error) return jsonError(leg.error.message, 500);

      const decMap = await admin
        .from('decisions')
        .select('id, document_id')
        .eq('organization_id', organizationId)
        .in('status', ['open', 'in_review']);
      if (decMap.error) return jsonError(decMap.error.message, 500);
      const decisionToDoc = new Map<string, string>();
      for (const d of decMap.data ?? []) {
        const docId = d.document_id as string | null;
        if (d.id && docId) decisionToDoc.set(d.id as string, docId);
      }

      for (const task of leg.data ?? []) {
        let pid: string | undefined;
        const docId = task.document_id as string | null;
        if (docId) pid = docIdToProjectId.get(docId);
        if (!pid && task.decision_id) {
          const linkedDoc = decisionToDoc.get(task.decision_id as string);
          if (linkedDoc) pid = docIdToProjectId.get(linkedDoc);
        }
        if (!pid || !counts[pid]) continue;
        counts[pid].act++;
        if (task.due_at && new Date(task.due_at as string) < now) {
          counts[pid].overdue++;
        }
      }
    } else {
      return jsonError(tasksResult.error?.message ?? 'Tasks query failed', 500);
    }

    return NextResponse.json({ counts: Object.values(counts) });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal error' },
      { status: 500 },
    );
  }
}
