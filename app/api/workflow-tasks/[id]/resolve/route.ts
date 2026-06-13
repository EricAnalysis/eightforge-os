// app/api/workflow-tasks/[id]/resolve/route.ts
// POST: resolve an approval-generated workflow task (org-scoped).
//
// Body: { resolution: 'resolved' | 'accepted_exception', note?: string }
//
// Behaviours:
//   resolved          → closes task, re-runs approval action engine for project
//   accepted_exception → closes task with override flag, no recompute
//
// Also supports: { action: 'in_review' } to mark a task under review without closing it.

import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';
import { getActorContext } from '@/lib/server/getActorContext';
import {
  resolveApprovalTask,
  markApprovalTaskInReview,
} from '@/lib/server/resolveApprovalTask';

const VALID_RESOLUTIONS = ['resolved', 'accepted_exception'] as const;

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: taskId } = await params;
  if (!taskId) return jsonError('Task not found', 404);

  try {
    const ctx = await getActorContext(req);
    if (!ctx.ok) return jsonError(ctx.error, ctx.status);
    const { actorId, organizationId } = ctx.actor;

    const admin = getSupabaseAdmin();
    if (!admin) return jsonError('Server not configured', 503);

    const body = await req.json().catch(() => ({}));

    // Handle in_review shortcut
    if (body?.action === 'in_review') {
      const result = await markApprovalTaskInReview(taskId, organizationId, actorId);
      if (!result.ok) return jsonError(result.error, result.status);

      console.info('[workflow-tasks/resolve] marked in_review', { taskId, actorId });
      return NextResponse.json(result.task);
    }

    // Validate resolution type
    const resolution = typeof body?.resolution === 'string' ? body.resolution : null;
    if (!resolution || !VALID_RESOLUTIONS.includes(resolution as (typeof VALID_RESOLUTIONS)[number])) {
      return jsonError(
        `Invalid resolution. Must be one of: ${VALID_RESOLUTIONS.join(', ')}`,
        400,
      );
    }

    const note = typeof body?.note === 'string' && body.note.trim().length > 0
      ? body.note.trim()
      : null;

    const result = await resolveApprovalTask({
      taskId,
      organizationId,
      resolution: resolution as 'resolved' | 'accepted_exception',
      resolvedBy: actorId,
      note,
    });

    if (!result.ok) {
      return jsonError(result.error, result.status);
    }

    console.info('[workflow-tasks/resolve] resolved', {
      taskId,
      resolution,
      actorId,
      recompute_status: result.recompute?.approval_status ?? null,
      recompute_errors: result.recompute?.errors ?? [],
    });

    return NextResponse.json({
      task: result.task,
      recompute: result.recompute,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[workflow-tasks/resolve] unhandled error', { taskId, error: message });
    return jsonError('Internal server error', 500);
  }
}
