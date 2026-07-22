export type ValidationTriggerEntityType =
  | 'decision'
  | 'invoice_line_rate_link'
  | 'fact';

export type ValidationTriggerEntity = {
  trigger_entity_type?: ValidationTriggerEntityType;
  trigger_entity_id?: string;
};

export function completeValidationTriggerEntity(
  value: ValidationTriggerEntity | null | undefined,
): { trigger_entity_type: ValidationTriggerEntityType; trigger_entity_id: string } | null {
  if (!value?.trigger_entity_type || !value.trigger_entity_id) return null;
  return {
    trigger_entity_type: value.trigger_entity_type,
    trigger_entity_id: value.trigger_entity_id,
  };
}
