// app/api/workspace/projects/route.ts
// GET: Returns per-project stage counts for all projects in the authenticated
// user's organization. Used by WorkspacePageContent to render pressure signals
// on project cards without loading full project data per card.
//
// Counts are derived from direct project_id columns on decisions and workflow_tasks
// (added in migration 20260329). Documents still use their own project_id column.
//
// Runs with the service role client to skip per-table RLS on aggregation reads.

import { NextResponse } from 'next/server';
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

    const admin = getSupabaseAdmin();
    if (!admin) return jsonError('Server not configured', 503);

    // Run all reads in parallel. Documents are fetched in full to cover all
    // processing_status values. Decisions and tasks fetch only open rows to keep
    // payload small — closed rows don't contribute to pressure counts.
    const [projectsResult, docsResult, decisionsResult, tasksResult] = await Promise.all([
      admin
        .from('projects')
        .select('id')
        .eq('organization_id', organizationId),

      admin
        .from('documents')
        .select('project_id, processing_status')
        .eq('organization_id', organizationId)
        .not('project_id', 'is', null),

      admin
        .from('decisions')
        .select('project_id')
        .eq('organization_id', organizationId)
        .in('status', ['open', 'in_review'])
        .not('project_id', 'is', null),

      admin
        .from('workflow_tasks')
        .select('project_id, due_at')
        .eq('organization_id', organizationId)
        .in('status', ['open', 'in_progress', 'blocked'])
        .not('project_id', 'is', null),
    ]);

    // Seed a count record for every project in the org.
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

    // Map documents to stages by processing_status.
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
      }
    }

    // Map open decisions directly — project_id is now a first-class column.
    for (const dec of decisionsResult.data ?? []) {
      const pid = dec.project_id as string;
      if (!pid || !counts[pid]) continue;
      counts[pid].decide++;
    }

    // Map open tasks directly and compute overdue count.
    const now = new Date();
    for (const task of tasksResult.data ?? []) {
      const pid = task.project_id as string;
      if (!pid || !counts[pid]) continue;
      counts[pid].act++;
      if (task.due_at && new Date(task.due_at as string) < now) {
        counts[pid].overdue++;
      }
    }

    return NextResponse.json({ counts: Object.values(counts) });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal error' },
      { status: 500 },
    );
  }
}
