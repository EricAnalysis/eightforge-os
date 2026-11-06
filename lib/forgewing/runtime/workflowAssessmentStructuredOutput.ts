import {
  WorkflowAssessmentModelOutputSchema,
  type WorkflowAssessmentModelOutput,
} from '@/lib/workflowAssessmentSchema';

export * from '@/lib/workflowAssessmentSchema';

/** Version of the prompt that instructs the compact transport envelope. */
export const WORKFLOW_ASSESSMENT_ENVELOPE_PROMPT_VERSION = 'v3' as const;

/**
 * The provider constrains only this transport envelope. The complete assessment
 * is still checked by WorkflowAssessmentModelOutputSchema before any downstream
 * validation or persistence. The flat grammar removes the nested schema that
 * the provider rejected in D1; provider acceptance still requires qualification.
 */
export const WORKFLOW_ASSESSMENT_OUTPUT_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['assessmentJson'],
  properties: { assessmentJson: { type: 'string' } },
} as const;

export function parseWorkflowAssessmentModelOutput(
  raw: string,
): WorkflowAssessmentModelOutput {
  let envelope: unknown;
  try { envelope = JSON.parse(raw); } catch { throw new Error('invalid_model_envelope_json'); }
  if (envelope === null || typeof envelope !== 'object' || Array.isArray(envelope)
    || Object.keys(envelope).length !== 1
    || !Object.prototype.hasOwnProperty.call(envelope, 'assessmentJson')
    || typeof (envelope as { assessmentJson: unknown }).assessmentJson !== 'string'
    || !(envelope as { assessmentJson: string }).assessmentJson.trim()) {
    throw new Error('invalid_model_envelope');
  }

  let value: unknown;
  try { value = JSON.parse((envelope as { assessmentJson: string }).assessmentJson); }
  catch { throw new Error('invalid_embedded_model_json'); }
  const parsed = WorkflowAssessmentModelOutputSchema.safeParse(value);
  if (!parsed.success) throw new Error('model_schema_rejected');
  return parsed.data;
}
