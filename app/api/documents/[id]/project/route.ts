import { NextResponse } from 'next/server';
import { getActorContext } from '@/lib/server/getActorContext';
import { logActivityEvent } from '@/lib/server/activity/logActivityEvent';
import {
  getDocumentProjectMutationBlockers,
  loadScopedDocument,
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

function buildDocumentMutationBlockedMessage(params: {
  verb: 'removed from its project' | 'moved to another project';
  decisionCount: number;
  taskCount: number;
  relationshipCount: number;
}): string {
  const parts = [
    formatBlockerLabel(params.decisionCount, 'linked decision', 'linked decisions'),
    formatBlockerLabel(params.taskCount, 'linked workflow task', 'linked workflow tasks'),
    formatBlockerLabel(params.relationshipCount, 'linked project relationship', 'linked project relationships'),
  ].filter((value): value is string => value != null);

  if (parts.length === 0) {
    return `Document cannot be ${params.verb} right now.`;
  }

  return `Document cannot be ${params.verb} while it still has ${parts.join(', ')}. Resolve or reassign those downstream records first.`;
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: documentId } = await params;
  if (!documentId) return jsonError('Document id is required', 400);

  const ctx = await getActorContext(request);
  if (!ctx.ok) return jsonError(ctx.error, ctx.status);

  const permission = requireProjectAdminRole(ctx.actor.role);
  if (!permission.ok) return jsonError(permission.error, permission.status);

  const admin = getSupabaseAdmin();
  if (!admin) return jsonError('Server not configured', 503);

  const document = await loadScopedDocument(admin, {
    organizationId: ctx.actor.organizationId,
    documentId,
  });
  if (!document) return jsonError('Document not found', 404);

  const body = await request.json().catch(() => ({}));
  const action = typeof body?.action === 'string' ? body.action : null;
  if (action !== 'remove' && action !== 'move') {
    return jsonError('action must be "remove" or "move"', 400);
  }

  const blockers = await getDocumentProjectMutationBlockers(admin, {
    organizationId: ctx.actor.organizationId,
    documentId,
  });
  if (blockers.errors.length > 0) {
    return jsonError(blockers.errors[0] ?? 'Failed to validate document dependencies', 500);
  }
  if (blockers.decisionCount > 0 || blockers.taskCount > 0 || blockers.relationshipCount > 0) {
    return jsonError(
      buildDocumentMutationBlockedMessage({
        verb: action === 'remove' ? 'removed from its project' : 'moved to another project',
        decisionCount: blockers.decisionCount,
        taskCount: blockers.taskCount,
        relationshipCount: blockers.relationshipCount,
      }),
      409,
    );
  }

  const currentProject = document.project_id
    ? await loadScopedProject(admin, {
        organizationId: ctx.actor.organizationId,
        projectId: document.project_id,
      })
    : null;

  if (action === 'remove') {
    if (!document.project_id) {
      return jsonError('Document is not currently linked to a project', 400);
    }

    const { data: updated, error: updateError } = await admin
      .from('documents')
      .update({ project_id: null })
      .eq('organization_id', ctx.actor.organizationId)
      .eq('id', documentId)
      .select('id, project_id')
      .single();

    if (updateError) return jsonError(updateError.message, 500);

    const activityResult = await logActivityEvent({
      organization_id: ctx.actor.organizationId,
      entity_type: 'document',
      entity_id: documentId,
      event_type: 'document_removed_from_project',
      changed_by: ctx.actor.actorId,
      old_value: {
        project_id: document.project_id,
        project_name: currentProject?.name ?? null,
        document_title: document.title ?? document.name,
      },
      new_value: {
        project_id: null,
        project_name: null,
        document_title: document.title ?? document.name,
      },
    });
    if (!activityResult.ok) {
      console.error('[documents/project] remove audit log failed:', activityResult.error);
    }

    return NextResponse.json({
      ok: true,
      action: 'remove',
      document: updated,
    });
  }

  const targetProjectId =
    typeof body?.targetProjectId === 'string' && body.targetProjectId.trim().length > 0
      ? body.targetProjectId.trim()
      : null;
  if (!targetProjectId) return jsonError('targetProjectId is required', 400);
  if (targetProjectId === document.project_id) {
    return jsonError('Document is already linked to that project', 400);
  }

  const targetProject = await loadScopedProject(admin, {
    organizationId: ctx.actor.organizationId,
    projectId: targetProjectId,
  });
  if (!targetProject) return jsonError('Target project not found', 404);
  if (targetProject.status === 'archived') {
    return jsonError('Documents cannot be moved into an archived project', 400);
  }

  const { data: updated, error: updateError } = await admin
    .from('documents')
    .update({ project_id: targetProject.id })
    .eq('organization_id', ctx.actor.organizationId)
    .eq('id', documentId)
    .select('id, project_id')
    .single();

  if (updateError) return jsonError(updateError.message, 500);

  const activityResult = await logActivityEvent({
    organization_id: ctx.actor.organizationId,
    entity_type: 'document',
    entity_id: documentId,
    event_type: 'document_moved_to_project',
    changed_by: ctx.actor.actorId,
    old_value: {
      project_id: document.project_id,
      project_name: currentProject?.name ?? null,
      document_title: document.title ?? document.name,
    },
    new_value: {
      project_id: targetProject.id,
      project_name: targetProject.name,
      document_title: document.title ?? document.name,
    },
  });
  if (!activityResult.ok) {
    console.error('[documents/project] move audit log failed:', activityResult.error);
  }

  return NextResponse.json({
    ok: true,
    action: 'move',
    document: updated,
    targetProject: {
      id: targetProject.id,
      name: targetProject.name,
    },
  });
}
