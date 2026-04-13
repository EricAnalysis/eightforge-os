import { z } from 'zod';

import type {
  ContractInvoiceReconciliationSummary,
  InvoiceExposureSummary,
  InvoiceTransactionReconciliationSummary,
  ProjectExposureSummary,
  ProjectReconciliationSummary,
  ValidationFinding,
  ValidationSummary,
  ValidatorSummaryItem,
} from '@/types/validator';

const validationStatusValues = ['NOT_READY', 'BLOCKED', 'VALIDATED', 'FINDINGS_OPEN'] as const;
const validatorStatusValues = ['READY', 'BLOCKED', 'NEEDS_REVIEW'] as const;
const contractInvoiceReconciliationStatusValues = [
  'MATCH',
  'MISMATCH',
  'MISSING',
  'PARTIAL',
] as const;
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

export const validatorSummaryItemSchema: z.ZodType<ValidatorSummaryItem> = z.object({
  rule_id: z.string(),
  severity: z.enum(validationSeverityValues),
  subject_type: z.string(),
  subject_id: z.string(),
  field: z.string().nullable(),
  fact_keys: z.array(z.string()),
  message: z.string(),
});

export const contractInvoiceReconciliationSummarySchema: z.ZodType<ContractInvoiceReconciliationSummary> =
  z.object({
    matched_invoice_lines: z.number().int().nonnegative(),
    unmatched_invoice_lines: z.number().int().nonnegative(),
    rate_mismatches: z.number().int().nonnegative(),
    vendor_identity_status: z.enum(contractInvoiceReconciliationStatusValues),
    client_identity_status: z.enum(contractInvoiceReconciliationStatusValues),
    service_period_status: z.enum(contractInvoiceReconciliationStatusValues),
    invoice_total_status: z.enum(contractInvoiceReconciliationStatusValues),
  });

export const invoiceTransactionReconciliationSummarySchema: z.ZodType<InvoiceTransactionReconciliationSummary> =
  z.object({
    matched_groups: z.number().int().nonnegative(),
    unmatched_groups: z.number().int().nonnegative(),
    cost_mismatches: z.number().int().nonnegative(),
    quantity_mismatches: z.number().int().nonnegative(),
    orphan_transactions: z.number().int().nonnegative(),
    outlier_rows: z.number().int().nonnegative(),
  });

export const projectReconciliationSummarySchema: z.ZodType<ProjectReconciliationSummary> =
  z.object({
    contract_invoice_status: z.enum(contractInvoiceReconciliationStatusValues),
    invoice_transaction_status: z.enum(contractInvoiceReconciliationStatusValues),
    overall_reconciliation_status: z.enum(contractInvoiceReconciliationStatusValues),
    matched_billing_groups: z.number().int().nonnegative(),
    unmatched_billing_groups: z.number().int().nonnegative(),
    rate_mismatches: z.number().int().nonnegative(),
    quantity_mismatches: z.number().int().nonnegative(),
    orphan_invoice_lines: z.number().int().nonnegative(),
    orphan_transactions: z.number().int().nonnegative(),
  });

export const invoiceExposureSummarySchema: z.ZodType<InvoiceExposureSummary> = z.object({
  invoice_number: z.string().nullable(),
  billed_amount: z.number().finite().nullable(),
  billed_amount_source: z.enum(['invoice_total', 'line_total_fallback', 'missing']),
  contract_supported_amount: z.number().finite(),
  transaction_supported_amount: z.number().finite(),
  fully_reconciled_amount: z.number().finite(),
  supported_amount: z.number().finite(),
  unreconciled_amount: z.number().finite().nullable(),
  at_risk_amount: z.number().finite(),
  requires_verification_amount: z.number().finite().optional(),
  reconciliation_status: z.enum(contractInvoiceReconciliationStatusValues),
});

export const projectExposureSummarySchema: z.ZodType<ProjectExposureSummary> = z.object({
  total_billed_amount: z.number().finite(),
  total_contract_supported_amount: z.number().finite(),
  total_transaction_supported_amount: z.number().finite(),
  total_fully_reconciled_amount: z.number().finite(),
  total_unreconciled_amount: z.number().finite(),
  total_at_risk_amount: z.number().finite(),
  total_requires_verification_amount: z.number().finite().optional(),
  support_gap_tolerance_amount: z.number().finite(),
  at_risk_tolerance_amount: z.number().finite(),
  moderate_severity: z.literal('warning'),
  invoices: z.array(invoiceExposureSummarySchema),
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
  validator_status: z.enum(validatorStatusValues),
  validator_open_items: z.array(validatorSummaryItemSchema),
  validator_blockers: z.array(validatorSummaryItemSchema),
  contract_invoice_reconciliation: contractInvoiceReconciliationSummarySchema.nullable().optional(),
  invoice_transaction_reconciliation:
    invoiceTransactionReconciliationSummarySchema.nullable().optional(),
  reconciliation: projectReconciliationSummarySchema.nullable().optional(),
  exposure: projectExposureSummarySchema.nullable().optional(),
  requires_verification_amount: z.number().finite().nullable().optional(),
});
