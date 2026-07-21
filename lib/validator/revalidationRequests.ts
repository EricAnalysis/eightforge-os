import type { TriggerProjectValidationResult } from '@/lib/validator/triggerProjectValidation';
import { triggerProjectValidation } from '@/lib/validator/triggerProjectValidation';
import type { ValidationTriggerSource } from '@/types/validator';

export async function requestDecisionStatusRevalidation(params: {
  projectId: string | null;
  actorId?: string;
  newStatus: string;
}): Promise<TriggerProjectValidationResult | null> {
  if (!params.projectId) return null;
  if (params.newStatus !== 'resolved' && params.newStatus !== 'dismissed') {
    return null;
  }

  return triggerProjectValidation(params.projectId, 'manual', params.actorId);
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
}): Promise<TriggerProjectValidationResult | null> {
  if (!params.projectId) return null;
  return triggerProjectValidation(params.projectId, 'override_applied', params.actorId);
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
}): Promise<TriggerProjectValidationResult | null> {
  if (!params.projectId) return null;
  return triggerProjectValidation(params.projectId, 'relationship_change', params.actorId);
}
