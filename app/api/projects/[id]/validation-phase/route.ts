import { NextResponse } from 'next/server';
import { getActorContext } from '@/lib/server/getActorContext';
import { logActivityEvent } from '@/lib/server/activity/logActivityEvent';
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';
import { triggerProjectValidation } from '@/lib/validator/triggerProjectValidation';
import {
  PROJECT_VALIDATION_PHASE_VALUES,
  type ProjectValidationPhase,
} from '@/types/validator';

function jsonError(message: string, status: number) {
  return NextResponse.json({ ok: false, error: message }, { status });
}

function isProjectValidationPhase(value: unknown): value is ProjectValidationPhase {
  return typeof value === 'string'
    && PROJECT_VALIDATION_PHASE_VALUES.includes(value as ProjectValidationPhase);
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: projectId } = await params;
  if (!projectId) return jsonError('Project not found', 404);

  const ctx = await getActorContext(request);
  if (!ctx.ok) return jsonError(ctx.error, ctx.status);
  const { actorId, organizationId } = ctx.actor;

  const body = await request.json().catch(() => ({}));
  const validationPhase = body?.validationPhase;
  if (!isProjectValidationPhase(validationPhase)) {
    return jsonError('validationPhase is required', 400);
  }

  const admin = getSupabaseAdmin();
  if (!admin) return jsonError('Server not configured', 503);

  const { data: projectRow, error: projectError } = await admin
    .from('projects')
    .select('id, validation_phase')
    .eq('id', projectId)
    .eq('organization_id', organizationId)
    .maybeSingle();

  if (projectError) return jsonError(projectError.message, 500);
  if (!projectRow) return jsonError('Project not found', 404);

  const previousPhase =
    typeof projectRow.validation_phase === 'string'
      ? projectRow.validation_phase
      : 'contract_setup';

  if (previousPhase !== validationPhase) {
    const { error: updateError } = await admin
      .from('projects')
      .update({
        validation_phase: validationPhase,
      })
      .eq('id', projectId)
      .eq('organization_id', organizationId);

    if (updateError) return jsonError(updateError.message, 500);

    const activityResult = await logActivityEvent({
      organization_id: organizationId,
      project_id: projectId,
      entity_type: 'project',
      entity_id: projectId,
      event_type: 'project_validation_phase_changed',
      changed_by: actorId,
      old_value: {
        validation_phase: previousPhase,
      },
      new_value: {
        validation_phase: validationPhase,
      },
    });

    if (!activityResult.ok) {
      console.error('[project-validation-phase] failed to log activity event', {
        projectId,
        error: activityResult.error,
      });
    }
  }

  const validationResult = await triggerProjectValidation(projectId, 'manual', actorId);

  return NextResponse.json({
    ok: true,
    validation_phase: validationPhase,
    validation: validationResult,
  });
}
