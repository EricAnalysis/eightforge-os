// lib/types/rules.ts
// Shared types for the deterministic rule engine.
// Column names match the PRODUCTION Supabase schema exactly.

// -- Condition Grammar (v1) --------------------------------------------------

export type ConditionOperator =
  | 'equals'
  | 'not_equals'
  | 'greater_than'
  | 'greater_than_or_equal'
  | 'less_than'
  | 'less_than_or_equal'
  | 'contains'
  | 'not_contains'
  | 'in'
  | 'not_in'
  | 'exists'
  | 'not_exists';

export type Condition = {
  field_key: string;
  operator: ConditionOperator;
  value: unknown;
};

export type ConditionJson = {
  match_type: 'all' | 'any';
  conditions: Condition[];
};

export type ActionJson = {
  create_task?: boolean;
  task_type?: string;
  title_template?: string;
  description_template?: string;
  assign_to_role?: string;
  due_in_hours?: number;
};

// -- Rule Row (matches public.rules) ------------------------------------------

export type RuleRow = {
  id: string;
  organization_id: string | null;
  domain: string;
  document_type: string;
  rule_group: string | null;
  name: string;
  description: string | null;
  decision_type: string;
  severity: string;
  priority: number;
  status: string;
  condition_json: ConditionJson;
  action_json: ActionJson;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  updated_by: string | null;
};

// -- Facts (normalized extraction data) ---------------------------------------

/** A flat key→value map derived from document_extractions rows. */
export type Facts = Record<string, string | number | boolean | Date | null>;

// -- Rule Evaluation Result ---------------------------------------------------

export type ConditionResult = {
  field_key: string;
  operator: ConditionOperator;
  expected: unknown;
  actual: unknown;
  passed: boolean;
};

export type RuleEvalResult = {
  rule: RuleRow;
  matched: boolean;
  condition_results: ConditionResult[];
};

// -- Decision Insert (matches public.decisions) --------------------------------

export type DecisionInsert = {
  organization_id: string;
  document_id: string;
  decision_rule_id: string | null;
  decision_type: string;
  severity: string;
  status: string;
  source: string;
  confidence: number;
  title: string;
  summary: string | null;
  details: Record<string, unknown>;
  rule_key: string | null;
  first_detected_at: string;
  last_detected_at: string;
};

// -- Decision Update (for upsert on re-detection) -----------------------------

export type DecisionUpdate = {
  last_detected_at: string;
  details: Record<string, unknown>;
  confidence: number;
};

// -- Workflow Task Insert (matches public.workflow_tasks) -----------------------

export type WorkflowTaskInsert = {
  organization_id: string;
  document_id: string;
  decision_id: string;
  task_type: string;
  title: string;
  description: string | null;
  priority: string;
  status: string;
  due_at: string | null;
  source: string;
  source_metadata: Record<string, unknown>;
};
