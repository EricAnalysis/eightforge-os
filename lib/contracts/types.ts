export const LANGUAGE_ENGINE_FIELDS_VERSION_V1 = 'language_engine_fields:v1';
export const CLAUSE_PATTERN_LIBRARY_VERSION_V1 = 'clause_pattern_library:v1';
export const COVERAGE_LIBRARY_VERSION_V1 = 'coverage_library:v1';

export type ContractObjectFamily =
  | 'contract_identity'
  | 'term_model'
  | 'activation_model'
  | 'scope_model'
  | 'pricing_model'
  | 'documentation_model'
  | 'compliance_model'
  | 'payment_model';

export type ContractFieldState =
  | 'explicit'
  | 'derived'
  | 'conditional'
  | 'conflicted'
  | 'missing_critical';

export type ContractValueType =
  | 'text'
  | 'boolean'
  | 'number'
  | 'date'
  | 'currency'
  | 'duration';

export type ContractCriticality = 'P1' | 'P2' | 'P3';

export type ContractDownstreamDependency =
  | 'activation'
  | 'decisioning'
  | 'workflow_generation'
  | 'billing_review'
  | 'reimbursement_logic'
  | 'operator_review';

export type ContractFieldId =
  | 'contractor_name'
  | 'owner_name'
  | 'contract_number'
  | 'solicitation_number'
  | 'executed_date'
  | 'effective_date'
  | 'initial_term_length'
  | 'expiration_date'
  | 'activation_trigger_type'
  | 'authorization_required'
  | 'performance_start_basis'
  | 'mobilization_sla'
  | 'rate_schedule_present'
  | 'rate_schedule_pages'
  | 'pricing_applicability'
  | 'contract_ceiling'
  | 'no_guarantee_quantity'
  | 'disposal_fee_treatment'
  | 'monitoring_required'
  | 'billing_documentation_required'
  | 'fema_eligibility_gate';

export interface LanguageEngineFieldDefinition {
  field_id: ContractFieldId;
  label: string;
  object_family: ContractObjectFamily;
  value_type: ContractValueType;
  aliases: string[];
  states_allowed: ContractFieldState[];
  criticality: ContractCriticality;
  downstream_dependency: ContractDownstreamDependency[];
  confidence_rules: string[];
  derivation_rules: string[];
  question_rule_ids: string[];
}

export type ClausePatternFamily =
  | 'execution_based_term'
  | 'ntp_activation'
  | 'task_order_activation'
  | 'disaster_triggered_activation'
  | 'renewal_option'
  | 'unit_rate_schedule'
  | 'not_to_exceed'
  | 'no_guarantee_quantity'
  | 'pass_through_disposal'
  | 'monitoring_dependency'
  | 'ticket_load_documentation'
  | 'fema_eligibility_restriction'
  | 'mobilization_deadline'
  | 'insurance_bond_requirements'
  | 'subcontract_controls'
  | 'audit_record_retention'
  | 'termination_convenience_or_cause';

export interface ClausePatternDefinition {
  pattern_id: string;
  pattern_name: string;
  family: ClausePatternFamily;
  trigger_phrases: string[];
  semantic_slots: string[];
  document_zones: string[];
  confidence_rules: string[];
  conflict_rules: string[];
  question_rules: string[];
  example_variants: string[];
}

export interface DetectedClausePattern {
  pattern_id: string;
  pattern_name: string;
  family: ClausePatternFamily;
  confidence: number;
  evidence_anchors: string[];
  semantic_slots: Record<string, unknown>;
  matched_phrases: string[];
  conflict: boolean;
}

export type ContractDocumentTypeProfile = 'fema_disaster_recovery_debris_contract';
export type ContractCoverageFamily =
  | 'term_and_activation'
  | 'pricing_and_payment'
  | 'scope_and_services'
  | 'documentation_and_compliance'
  | 'contract_formation';

export type ContractExtractionQuality = 'strong' | 'partial' | 'weak' | 'missing';
export type ContractEvidenceDistribution =
  | 'none'
  | 'same_page'
  | 'multi_page'
  | 'exhibit_only'
  | 'table_only';

export interface ContractCoverageDefinition {
  coverage_id: string;
  family: ContractCoverageFamily;
  clause_family: string;
  expected_for_doc_type: boolean;
  criticality: ContractCriticality;
  minimum_extraction_quality: ContractExtractionQuality;
  downstream_dependency: ContractDownstreamDependency[];
  operator_review_if: string[];
}

export interface ContractCoverageResult extends ContractCoverageDefinition {
  found: boolean;
  extraction_quality: ContractExtractionQuality;
  evidence_count: number;
  evidence_distribution: ContractEvidenceDistribution;
  operator_review_required: boolean;
  evidence_anchors: string[];
}

export type ContractIssueType =
  | 'missing_required_clause'
  | 'derived_value_requires_confirmation'
  | 'conflicting_evidence'
  | 'conditional_without_trigger_status'
  | 'pricing_applicability_unclear'
  | 'documentation_prerequisite_unclear'
  | 'fema_gate_ambiguous';

export interface ContractIssue {
  issue_id: string;
  issue_type: ContractIssueType;
  priority: ContractCriticality;
  field_ids: ContractFieldId[];
  pattern_ids: string[];
  reason: string;
  evidence_anchors: string[];
  resolution_effect: string;
}

export interface ContractFieldAnalysis {
  field_id: ContractFieldId;
  label: string;
  object_family: ContractObjectFamily;
  value_type: ContractValueType;
  value: unknown;
  state: ContractFieldState;
  criticality: ContractCriticality;
  confidence: number | null;
  evidence_anchors: string[];
  source_fact_ids: string[];
  pattern_ids: string[];
  notes: string[];
}

export type ContractFieldAnalysisMap = Partial<Record<ContractFieldId, ContractFieldAnalysis>>;

export interface ContractAnalysisResult {
  document_id: string;
  document_family: 'contract';
  document_type_profile: ContractDocumentTypeProfile | null;
  language_engine_version: string;
  pattern_library_version: string;
  coverage_library_version: string;
  contract_identity: ContractFieldAnalysisMap;
  term_model: ContractFieldAnalysisMap;
  activation_model: ContractFieldAnalysisMap;
  scope_model: ContractFieldAnalysisMap;
  pricing_model: ContractFieldAnalysisMap;
  documentation_model: ContractFieldAnalysisMap;
  compliance_model: ContractFieldAnalysisMap;
  payment_model: ContractFieldAnalysisMap;
  clause_patterns_detected: DetectedClausePattern[];
  coverage_status: ContractCoverageResult[];
  issues: ContractIssue[];
}
