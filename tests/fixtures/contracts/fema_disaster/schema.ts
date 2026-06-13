import { z } from 'zod';

import type { ContractFieldId, ContractFieldState } from '@/lib/contracts/types';

export const FEMA_DISASTER_MOCK_SCHEMA_VERSION = 'fema_disaster_mock_contract:v1';

export const FEMA_DISASTER_MOCK_FAMILIES = [
  'signature_page_last_only',
  'ntp_required_activation',
  'execution_vs_effective',
  'estimated_vs_ceiling',
  'bafo_not_contract',
  'monitoring_gated_payment',
  'disaster_trigger_activation',
  'amendment_term_only',
  'pass_through_disposal',
  'dual_party_client_vs_agency',
  'weird_clause_phrasing',
  'multi_schedule_pricing',
  'estimated_quantities_no_guarantee',
  'standby_minimum_not_quantity',
  'body_exhibit_quantity_conflict',
  'zone_estimates_not_global',
  'multi_schedule_quantity_disclaimers',
  'historical_event_reference_not_commitment',
  'small_minimum_with_large_estimate',
  'signature_low_quality',
  'signature_split_package',
  'bafo_with_vendor_signature_only',
  'amendment_pricing_only',
  'amendment_without_base_package',
  'waterway_channel_maintenance_base',
  // Batch 4 — cross-document quantity and payment interactions (debris domain)
  'task_order_authorized_quantity',
  'contract_estimate_vs_task_order_authorized',
  'invoice_actuals_exceed_authorized_quantity',
  'ticket_actuals_below_authorized_quantity',
  'amendment_increases_authorized_quantity',
  'amendment_changes_unit_pricing_not_quantity',
  'base_contract_plus_missing_task_order',
  'estimate_authorized_actual_three_way_drift',
  // Batch 5 — waterway P3 variant families
  'waterway_ntp_and_permit_gated_activation',
  'waterway_emergency_triggered_assignment',
  'waterway_amendment_depth_change',
  'waterway_multi_channel_pricing',
  // Batch 6 — cross-document waterway joins
  'waterway_task_order_channel_assignment',
  'waterway_invoice_against_channel_assignment',
  'waterway_permit_blocks_task_order',
  'waterway_invoice_channel_rate_mismatch',
] as const;

export const FEMA_DISASTER_DOCUMENT_SHAPES = [
  'executed_contract',
  'non_executed_contract_shape',
  'amendment_term_only',
] as const;

export const FEMA_DISASTER_CONTRACT_DOMAINS = [
  'debris_removal',
  'waterway_maintenance',
] as const;

// Batch 4: document roles for cross-document fixture sets
export const FEMA_DISASTER_DOCUMENT_ROLES = [
  'base_contract',
  'task_order',
  'amendment',
  'invoice',
  'field_ticket',
  // Batch 6: permit status document (waterway cross-document joins)
  'permit_status',
] as const;

export const FEMA_DISASTER_EXPECTED_FAILURE_MODES = [
  'signature_page_not_detected',
  'ntp_activation_missed',
  'effective_date_used_as_execution',
  'estimate_misread_as_ceiling',
  'estimate_treated_as_guarantee',
  'standby_misread_as_quantity_commitment',
  'body_quantity_text_overrides_exhibit_disclaimer',
  'historical_quantity_used_as_contract_quantity',
  'bafo_misclassified_as_contract',
  'vendor_signature_misread_as_bilateral_execution',
  'monitoring_dependency_missed',
  'using_agency_collapsed_into_client',
  // 'task_order_activation_missed' — removed Batch 11: no fixture uses this as
  //   expected_failure_mode. The task_order_activation scenario is not yet covered
  //   by a dedicated fixture family. Add back when a fixture is authored for it.
  'disaster_trigger_activation_missed',
  'pass_through_disposal_missed',
  'weird_clause_not_normalized',
  'multi_schedule_pricing_collapsed',
  'amendment_term_scope_overread',
  'amendment_without_base_overwrites_core_fields',
  'signature_ocr_loss',
  'debris_contract_normalization_applied_to_waterway',
  // Batch 4 — cross-document quantity and payment failure modes
  'estimate_used_as_authorized',
  'estimate_not_narrowed_by_task_order',
  'invoice_overrun_not_flagged',
  'underrun_falsely_flagged_as_issue',
  'amendment_quantity_increase_not_applied',
  'rate_amendment_mutates_quantity',
  'missing_task_order_treated_as_authorized',
  'quantity_levels_collapsed',
  // Batch 5 — waterway variant failure modes
  'single_gate_activation_assumed',
  // 'permit_dependency_ignored' — removed Batch 11: referenced only in target_engine_behavior
  //   prose, never used as an expected_failure_mode assertion. Covered semantically by
  //   single_gate_activation_assumed in waterway_ntp_and_permit_gated_activation.
  'emergency_waterway_normalized_to_debris',
  'depth_amendment_mutates_pricing',
  'channel_rates_aggregated',
  // Batch 6 — cross-document waterway join failure modes
  'task_order_channel_scope_ignored',
  'invoice_channel_not_validated_against_assignment',
  'task_order_activated_without_permit',
  'invoice_rate_not_validated_against_channel_schedule',
] as const;

const EXPECTED_STATE_FIELD_IDS = [
  'contractor_name',
  'owner_name',
  'executed_date',
  'effective_date',
  'activation_trigger_type',
  'authorization_required',
  'performance_start_basis',
  'mobilization_sla',
  'rate_schedule_present',
  'pricing_applicability',
  'contract_ceiling',
  'no_guarantee_quantity',
  'disposal_fee_treatment',
  'monitoring_required',
  'billing_documentation_required',
  'fema_eligibility_gate',
] as const satisfies readonly ContractFieldId[];

const CONTRACT_FIELD_STATES = [
  'explicit',
  'derived',
  'conditional',
  'conflicted',
  'missing_critical',
] as const satisfies readonly ContractFieldState[];

const looseRecordSchema = z.record(z.string(), z.unknown());

// Batch 4: per-document entry schema for cross-document fixture sets.
// fixture_documents is fixture-only and has no runtime or pipeline counterpart.
export const femaDisasterFixtureDocumentSchema = z.object({
  document_role: z.enum(FEMA_DISASTER_DOCUMENT_ROLES),
  document_shape: z.enum(FEMA_DISASTER_DOCUMENT_SHAPES).optional(),
  document_name: z.string().min(1),
  page_text: z.array(z.string().min(1)).min(1),
  typed_fields: looseRecordSchema.optional(),
  structured_fields: looseRecordSchema.optional(),
  section_signals: looseRecordSchema.optional(),
});

export const femaDisasterMockCanonicalOutputsSchema = z.object({
  document_shape: z.enum(FEMA_DISASTER_DOCUMENT_SHAPES).optional(),
  contract_domain: z.enum(FEMA_DISASTER_CONTRACT_DOMAINS).optional(),
  contractor_name: z.string().nullable().optional(),
  client_name: z.string().nullable().optional(),
  using_agency_name: z.string().nullable().optional(),
  executed_date: z.string().nullable().optional(),
  effective_date: z.string().nullable().optional(),
  term_start_date: z.string().nullable().optional(),
  term_end_date: z.string().nullable().optional(),
  contract_ceiling: z.number().nullable().optional(),
  rate_schedule_present: z.boolean().optional(),
  pricing_applicability: z.string().nullable().optional(),
  scope_semantics: z.string().nullable().optional(),
  pricing_semantics: z.string().nullable().optional(),
  compliance_semantics: z.array(z.string()).optional(),
  quantity_semantics: z.string().nullable().optional(),
  activation_triggers: z.array(z.string()).optional(),
  documentation_and_monitoring_dependencies: z.array(z.string()).optional(),
  // Batch 4: cross-document quantity fields (fixture-only, not runtime)
  authorized_quantity: z.number().nullable().optional(),
  actual_quantity: z.number().nullable().optional(),
  authorization_conditional: z.boolean().optional(),
  // Batch 6: cross-document waterway channel join fields (fixture-only)
  authorized_channel_ids: z.array(z.string()).optional(),
  actual_channel_ids: z.array(z.string()).optional(),
  permit_status: z.string().nullable().optional(),
  channel_rate_mismatch: z.boolean().optional(),
});

export const femaDisasterMockIssueExpectationsSchema = z.object({
  present_issue_ids: z.array(z.string()).default([]),
  absent_issue_ids: z.array(z.string()).default([]),
  coverage_gap_ids: z.array(z.string()).default([]),
  expected_failure_mode: z.enum(FEMA_DISASTER_EXPECTED_FAILURE_MODES).optional(),
  target_engine_behavior: z.string().min(1),
});

// Batch 10: expected decision and task assertion schemas.
// Fixtures opt in by authoring expected_decisions / expected_tasks arrays.
// Fixtures without these arrays are skipped silently by the harness assertion functions.

const OPERATIONAL_DECISION_SEVERITIES = ['critical', 'high', 'medium', 'info'] as const;
const OPERATIONAL_TASK_PRIORITIES = ['urgent', 'high', 'standard'] as const;

export const femaDisasterExpectedDecisionSchema = z.object({
  rule_id: z.string().min(1),
  should_trigger: z.boolean(),
  expected_severity: z.enum(OPERATIONAL_DECISION_SEVERITIES).optional(),
  expected_action: z.string().optional(),
  description: z.string().optional(),
});

export const femaDisasterExpectedTaskSchema = z.object({
  source_rule_id: z.string().min(1),
  should_generate: z.boolean(),
  expected_priority: z.enum(OPERATIONAL_TASK_PRIORITIES).optional(),
  expected_assignee_role: z.string().optional(),
  expected_category: z.string().optional(),
  description: z.string().optional(),
});

export const femaDisasterMockFixtureSchema = z.object({
  schema_version: z.literal(FEMA_DISASTER_MOCK_SCHEMA_VERSION),
  id: z.string().min(1),
  family: z.enum(FEMA_DISASTER_MOCK_FAMILIES),
  priority: z.enum(['P1', 'P2', 'P3']),
  source_label: z.string().min(1),
  document_name: z.string().min(1),
  description: z.string().min(1),
  page_text: z.array(z.string().min(1)).min(1),
  // Batch 4: optional cross-document fixture metadata (fixture-only, no runtime counterpart)
  fixture_documents: z.array(femaDisasterFixtureDocumentSchema).optional(),
  typed_fields: looseRecordSchema.optional(),
  structured_fields: looseRecordSchema.optional(),
  section_signals: looseRecordSchema.optional(),
  expected: z.object({
    canonical_outputs: femaDisasterMockCanonicalOutputsSchema.default({}),
    state_expectations: z
      .record(
        z.enum(EXPECTED_STATE_FIELD_IDS),
        z.enum(CONTRACT_FIELD_STATES),
      )
      .optional(),
    issue_expectations: femaDisasterMockIssueExpectationsSchema,
    // Batch 10: optional decision and task expectations authored per-fixture.
    // Harness assertion functions skip silently when these are absent.
    expected_decisions: z.array(femaDisasterExpectedDecisionSchema).optional(),
    expected_tasks: z.array(femaDisasterExpectedTaskSchema).optional(),
  }),
});

export type FemaDisasterMockFamily = (typeof FEMA_DISASTER_MOCK_FAMILIES)[number];
export type FemaDisasterMockDocumentShape = (typeof FEMA_DISASTER_DOCUMENT_SHAPES)[number];
export type FemaDisasterContractDomain = (typeof FEMA_DISASTER_CONTRACT_DOMAINS)[number];
export type FemaDisasterExpectedFailureMode =
  (typeof FEMA_DISASTER_EXPECTED_FAILURE_MODES)[number];
export type FemaDisasterMockFixture = z.infer<typeof femaDisasterMockFixtureSchema>;
// Batch 4 types
export type FemaDisasterDocumentRole = (typeof FEMA_DISASTER_DOCUMENT_ROLES)[number];
export type FemaDisasterFixtureDocument = z.infer<typeof femaDisasterFixtureDocumentSchema>;
// Batch 10 types
export type FemaDisasterExpectedDecision = z.infer<typeof femaDisasterExpectedDecisionSchema>;
export type FemaDisasterExpectedTask = z.infer<typeof femaDisasterExpectedTaskSchema>;
