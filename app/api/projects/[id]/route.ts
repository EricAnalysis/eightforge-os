import { NextResponse } from 'next/server';
import { getActorContext } from '@/lib/server/getActorContext';
import { logActivityEvent } from '@/lib/server/activity/logActivityEvent';
import {
  getProjectDeletionBlockers,
  loadScopedProject,
  requireProjectAdminRole,
} from '@/lib/server/projectAdmin';
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

function formatBlockerLabel(count: number, singular: string, plural: string): string | null {
  if (count <= 0) return null;
  return `${count} ${count === 1 ? singular : plural}`;
}

function buildProjectDeleteBlockedMessage(params: {
  documentCount: number;
  directDecisionCount: number;
  directTaskCount: number;
  relationshipCount: number;
}): string {
  const parts = [
    formatBlockerLabel(params.documentCount, 'linked document', 'linked documents'),
    formatBlockerLabel(params.directDecisionCount, 'direct project decision', 'direct project decisions'),
    formatBlockerLabel(params.directTaskCount, 'direct workflow task', 'direct workflow tasks'),
    formatBlockerLabel(params.relationshipCount, 'project relationship', 'project relationships'),
  ].filter((value): value is string => value != null);

  if (parts.length === 0) {
    return 'Project cannot be deleted right now.';
  }

  return `Project cannot be deleted because it still has ${parts.join(', ')}. Remove, reassign, or archive it instead.`;
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: projectId } = await params;
  if (!projectId) return jsonError('Project id is required', 400);

  const ctx = await getActorContext(request);
  if (!ctx.ok) return jsonError(ctx.error, ctx.status);

  const permission = requireProjectAdminRole(ctx.actor.role);
  if (!permission.ok) return jsonError(permission.error, permission.status);

  const admin = getSupabaseAdmin();
  if (!admin) return jsonError('Server not configured', 503);

  const project = await loadScopedProject(admin, {
    organizationId: ctx.actor.organizationId,
    projectId,
  });
  if (!project) return jsonError('Project not found', 404);

  const body = await request.json().catch(() => ({}));
  const action = typeof body?.action === 'string' ? body.action : null;
  if (action !== 'archive') {
    return jsonError('action must be "archive"', 400);
  }

  if (project.status === 'archived') {
    return NextResponse.json({
      ok: true,
      action: 'archive',
      project,
    });
  }

  const { data: updated, error: updateError } = await admin
    .from('projects')
    .update({ status: 'archived' })
    .eq('organization_id', ctx.actor.organizationId)
    .eq('id', projectId)
    .select('id, name, code, status, created_at')
    .single();

  if (updateError) return jsonError(updateError.message, 500);

  const activityResult = await logActivityEvent({
    organization_id: ctx.actor.organizationId,
    entity_type: 'project',
    entity_id: projectId,
    event_type: 'project_archived',
    changed_by: ctx.actor.actorId,
    old_value: {
      status: project.status,
      project_name: project.name,
      project_code: project.code,
    },
    new_value: {
      status: 'archived',
      project_name: project.name,
      project_code: project.code,
    },
  });
  if (!activityResult.ok) {
    console.error('[projects] archive audit log failed:', activityResult.error);
  }

  return NextResponse.json({
    ok: true,
    action: 'archive',
    project: updated,
  });
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: projectId } = await params;
  if (!projectId) return jsonError('Project id is required', 400);

  const ctx = await getActorContext(request);
  if (!ctx.ok) return jsonError(ctx.error, ctx.status);

  const permission = requireProjectAdminRole(ctx.actor.role);
  if (!permission.ok) return jsonError(permission.error, permission.status);

  const admin = getSupabaseAdmin();
  if (!admin) return jsonError('Server not configured', 503);

  const project = await loadScopedProject(admin, {
    organizationId: ctx.actor.organizationId,
    projectId,
  });
  if (!project) return jsonError('Project not found', 404);

  const blockers = await getProjectDeletionBlockers(admin, {
    organizationId: ctx.actor.organizationId,
    projectId,
  });

  if (blockers.errors.length > 0) {
    return jsonError(blockers.errors[0] ?? 'Failed to validate project dependencies', 500);
  }

  if (blockers.missingProjectIdColumns) {
    return jsonError(
      'Project delete is blocked until decisions.project_id and workflow_tasks.project_id are available. Apply the project-id migration first.',
      409,
    );
  }

  if (
    blockers.documentCount > 0 ||
    blockers.directDecisionCount > 0 ||
    blockers.directTaskCount > 0 ||
    blockers.relationshipCount > 0
  ) {
    return jsonError(
      buildProjectDeleteBlockedMessage(blockers),
      409,
    );
  }

  const { error: deleteError } = await admin
    .from('projects')
    .delete()
    .eq('organization_id', ctx.actor.organizationId)
    .eq('id', projectId);

  if (deleteError) return jsonError(deleteError.message, 500);

  const activityResult = await logActivityEvent({
    organization_id: ctx.actor.organizationId,
    entity_type: 'project',
    entity_id: projectId,
    event_type: 'project_deleted',
    changed_by: ctx.actor.actorId,
    old_value: {
      status: project.status,
      project_name: project.name,
      project_code: project.code,
    },
    new_value: {
      deleted: true,
      project_name: project.name,
      project_code: project.code,
    },
  });
  if (!activityResult.ok) {
    console.error('[projects] delete audit log failed:', activityResult.error);
  }

  return NextResponse.json({
    ok: true,
    action: 'delete',
    deletedProjectId: projectId,
  });
}
