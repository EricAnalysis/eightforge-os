import type { TriggerProjectValidationResult } from '@/lib/validator/triggerProjectValidation';
import { triggerProjectValidation } from '@/lib/validator/triggerProjectValidation';
import type { ValidationTriggerSource } from '@/types/validator';
import type { ValidationTriggerEntity } from '@/lib/validator/validationTriggerAttribution';

function triggerEntityOptions(triggerEntity: ValidationTriggerEntity) {
  return { triggerEntity };
}

export async function requestDecisionStatusRevalidation(params: {
  projectId: string | null;
  actorId?: string;
  newStatus: string;
  decisionId: string;
}): Promise<TriggerProjectValidationResult | null> {
  if (!params.projectId) return null;
  if (params.newStatus !== 'resolved' && params.newStatus !== 'dismissed') {
    return null;
  }

  return triggerProjectValidation(
    params.projectId,
    'manual',
    params.actorId,
    triggerEntityOptions({ trigger_entity_type: 'decision', trigger_entity_id: params.decisionId }),
  );
}

export async function requestDecisionFeedbackRevalidation(params: {
  projectId: string | null;
  actorId?: string;
  feedbackType?: 'correct' | 'incorrect' | 'needs_review' | 'override' | null;
}): Promise<TriggerProjectValidationResult | null> {
  if (!params.projectId) return null;

  let triggerSource: ValidationTriggerSource = 'review_confirmed';
  if (params.feedbackType === 'override') {
    triggerSource = 'review_corrected';
  } else if (params.feedbackType === 'incorrect' || params.feedbackType === 'needs_review') {
    triggerSource = 'review_flagged';
  }

  return triggerProjectValidation(params.projectId, triggerSource, params.actorId);
}

export async function requestFactOverrideRevalidation(params: {
  projectId: string | null;
  actorId?: string;
  factId: string;
}): Promise<TriggerProjectValidationResult | null> {
  if (!params.projectId) return null;
  return triggerProjectValidation(
    params.projectId,
    'override_applied',
    params.actorId,
    triggerEntityOptions({ trigger_entity_type: 'fact', trigger_entity_id: params.factId }),
  );
}

export async function requestDocumentPrecedenceRevalidation(params: {
  projectId: string | null;
  actorId?: string;
}): Promise<TriggerProjectValidationResult | null> {
  if (!params.projectId) return null;
  return triggerProjectValidation(params.projectId, 'relationship_change', params.actorId);
}

export async function requestManualRateLinkRevalidation(params: {
  projectId: string | null;
  actorId?: string;
  linkId: string;
}): Promise<TriggerProjectValidationResult | null> {
  if (!params.projectId) return null;
  return triggerProjectValidation(
    params.projectId,
    'relationship_change',
    params.actorId,
    triggerEntityOptions({
      trigger_entity_type: 'invoice_line_rate_link',
      trigger_entity_id: params.linkId,
    }),
  );
}
