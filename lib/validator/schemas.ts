import { z } from 'zod';

import type { ValidationFinding, ValidationSummary } from '@/types/validator';

const validationStatusValues = ['NOT_READY', 'BLOCKED', 'VALIDATED', 'FINDINGS_OPEN'] as const;
const validationSeverityValues = ['critical', 'warning', 'info'] as const;
const validationCategoryValues = [
  'required_sources',
  'identity_consistency',
  'financial_integrity',
  'ticket_integrity',
] as const;
const validationTriggerSourceValues = [
  'document_processed',
  'fact_override',
  'relationship_change',
  'manual',
] as const;
const findingStatusValues = ['open', 'resolved', 'dismissed', 'muted'] as const;

export const validationFindingSchema: z.ZodType<ValidationFinding> = z
  .object({
    id: z.string().uuid(),
    run_id: z.string().uuid(),
    project_id: z.string().uuid(),
    rule_id: z.string(),
    check_key: z.string(),
    category: z.enum(validationCategoryValues),
    severity: z.enum(validationSeverityValues),
    status: z.enum(findingStatusValues),
    subject_type: z.string(),
    subject_id: z.string(),
    field: z.string().nullable(),
    expected: z.string().nullable(),
    actual: z.string().nullable(),
    variance: z.number().finite().nullable(),
    variance_unit: z.string().nullable(),
    blocked_reason: z.string().nullable(),
    decision_eligible: z.boolean(),
    action_eligible: z.boolean(),
    linked_decision_id: z.string().uuid().nullable(),
    linked_action_id: z.string().uuid().nullable(),
    resolved_by_user_id: z.string().uuid().nullable(),
    resolved_at: z.string().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .superRefine((value, ctx) => {
    if (value.check_key !== `${value.rule_id}:${value.subject_id}`) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'check_key must equal `${rule_id}:${subject_id}`.',
        path: ['check_key'],
      });
    }
  });

export const validationSummarySchema: z.ZodType<ValidationSummary> = z.object({
  status: z.enum(validationStatusValues),
  last_run_at: z.string().nullable(),
  critical_count: z.number().int().nonnegative(),
  warning_count: z.number().int().nonnegative(),
  info_count: z.number().int().nonnegative(),
  open_count: z.number().int().nonnegative(),
  blocked_reasons: z.array(z.string()),
  trigger_source: z.enum(validationTriggerSourceValues).nullable(),
});
