import { logActivityEvent } from '@/lib/server/activity/logActivityEvent';
import { normalizeValidationFinding } from '@/lib/validator/findingSemantics';
import type { ValidationFinding } from '@/types/validator';

export type ValidationFindingLifecycleEventType =
  | 'validation_finding_resolved'
  | 'validation_finding_changed';

export type ValidationFindingLifecycleActivityResult =
  | { ok: true; emitted: boolean }
  | { ok: false; emitted: true; error: string };

type ValidationFindingActivityContext = {
  organizationId: string;
  projectId: string;
  findingId: string;
  changedBy?: string;
  previousFinding: ValidationFinding;
  currentFinding: ValidationFinding;
  runId?: string;
};

function lifecycleValue(finding: ValidationFinding) {
  const normalized = normalizeValidationFinding(finding);
  return {
    status: finding.status,
    rule_id: finding.rule_id,
    check_key: finding.check_key,
    severity: finding.severity,
    business_severity: normalized.business_severity ?? null,
    finding_disposition: normalized.finding_disposition ?? null,
    affected_amount: normalized.affected_amount ?? null,
  };
}

function changedInPlace(
  previousFinding: ValidationFinding,
  currentFinding: ValidationFinding,
): boolean {
  const previous = lifecycleValue(previousFinding);
  const current = lifecycleValue(currentFinding);
  return previous.severity !== current.severity
    || previous.business_severity !== current.business_severity
    || previous.finding_disposition !== current.finding_disposition;
}

function lifecycleEventType(
  previousFinding: ValidationFinding,
  currentFinding: ValidationFinding,
): ValidationFindingLifecycleEventType | null {
  if (
    previousFinding.status === 'open'
    && (currentFinding.status === 'resolved' || currentFinding.status === 'dismissed')
  ) {
    return 'validation_finding_resolved';
  }

  if (
    previousFinding.status === 'open'
    && currentFinding.status === 'open'
    && changedInPlace(previousFinding, currentFinding)
  ) {
    return 'validation_finding_changed';
  }

  return null;
}

export async function emitValidationFindingLifecycleActivity(
  context: ValidationFindingActivityContext,
): Promise<ValidationFindingLifecycleActivityResult> {
  try {
    const eventType = lifecycleEventType(context.previousFinding, context.currentFinding);
    if (!eventType) return { ok: true, emitted: false };

    const result = await logActivityEvent({
      organization_id: context.organizationId,
      project_id: context.projectId,
      entity_type: 'project_validation_finding',
      entity_id: context.findingId,
      event_type: eventType,
      changed_by: context.changedBy ?? null,
      old_value: lifecycleValue(context.previousFinding),
      new_value: {
        ...lifecycleValue(context.currentFinding),
        ...(context.runId ? { run_id: context.runId } : {}),
      },
    });

    if (!result.ok) {
      return { ok: false, emitted: true, error: result.error };
    }

    return { ok: true, emitted: true };
  } catch (error) {
    return {
      ok: false,
      emitted: true,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
