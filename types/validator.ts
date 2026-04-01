export type ValidationStatus = 'NOT_READY' | 'BLOCKED' | 'VALIDATED' | 'FINDINGS_OPEN';

export type ValidationSeverity = 'critical' | 'warning' | 'info';

export type ValidationCategory =
  | 'required_sources'
  | 'identity_consistency'
  | 'financial_integrity'
  | 'ticket_integrity';

export type ValidationTriggerSource =
  | 'document_processed'
  | 'fact_override'
  | 'relationship_change'
  | 'manual';

export type FindingStatus = 'open' | 'resolved' | 'dismissed' | 'muted';

export type ValidationRun = {
  id: string;
  project_id: string;
  triggered_by: ValidationTriggerSource;
  triggered_by_user_id: string | null;
  rules_applied: string[];
  rule_version: string;
  status: string;
  findings_count: number;
  critical_count: number;
  warning_count: number;
  info_count: number;
  inputs_snapshot_hash: string | null;
  run_at: string;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
};

export type ValidationFinding = {
  id: string;
  run_id: string;
  project_id: string;
  rule_id: string;
  check_key: string;
  category: ValidationCategory;
  severity: ValidationSeverity;
  status: FindingStatus;
  subject_type: string;
  subject_id: string;
  field: string | null;
  expected: string | null;
  actual: string | null;
  variance: number | null;
  variance_unit: string | null;
  blocked_reason: string | null;
  decision_eligible: boolean;
  action_eligible: boolean;
  linked_decision_id: string | null;
  linked_action_id: string | null;
  resolved_by_user_id: string | null;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
};

export type ValidationEvidence = {
  id: string;
  finding_id: string;
  evidence_type: string;
  source_document_id: string | null;
  source_page: number | null;
  fact_id: string | null;
  record_id: string | null;
  field_name: string | null;
  field_value: string | null;
  note: string | null;
  created_at: string;
};

export type ValidationRuleState = {
  id: string;
  project_id: string;
  rule_id: string;
  enabled: boolean;
  tolerance_override: unknown | null;
  muted_until: string | null;
  created_at: string;
  updated_at: string;
};

export type ValidationSummary = {
  status: ValidationStatus;
  last_run_at: string | null;
  critical_count: number;
  warning_count: number;
  info_count: number;
  open_count: number;
  blocked_reasons: string[];
  trigger_source: ValidationTriggerSource | null;
};

export type ValidatorResult = {
  status: ValidationStatus;
  blocked_reasons: string[];
  findings: ValidationFinding[];
  summary: ValidationSummary;
  rulesApplied: string[];
};
