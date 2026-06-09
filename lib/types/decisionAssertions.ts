/**
 * TypeScript types for the decision_assertions table.
 *
 * These types are the machine-readable contract between the operator decision
 * propagation system and the validator. The rationale field is human-facing
 * only and is explicitly excluded from DecisionAssertionQuery to prevent
 * validator logic from depending on it.
 *
 * Corresponds to: supabase/migrations/20260609000000_decision_assertions.sql
 * See: docs/decisions/OPERATOR_DECISION_PROPAGATION.md
 */

// ============================================================================
// UNION TYPES (match CHECK constraints in migration exactly)
// ============================================================================

export type DecisionAssertionType =
  | 'contractor_alias'
  | 'rate_interpretation'
  | 'scope_exception'
  | 'invoice_correction'
  | 'business_rule';

export type ScopeLevel =
  | 'invoice'
  | 'project'
  | 'contract_vehicle'
  | 'client'
  | 'organization'
  | 'global';

export type AssertionStatus =
  | 'active'
  | 'superseded'
  | 'expired'
  | 'revoked';

export type ExpirationTriggerType =
  | 'document_event'
  | 'time'
  | 'contract_end'
  | 'operator_revoke';

// ============================================================================
// STRUCTURED JSONB INTERFACES
// Different decision_type values use different subsets of ConditionJson fields.
// All fields are optional — validator code must guard each before using it.
// ============================================================================

/**
 * Structured, queryable conditions stored in condition_json.
 * NEVER parsed as raw text by validator logic — access fields directly.
 */
export interface ConditionJson {
  /** Priority order when multiple assertions match; lower wins. */
  match_priority?: number;
  /** Field keys that must be present on the subject entity for this assertion to apply. */
  required_fields?: string[];
  /** Raw name variant this assertion resolves (for contractor_alias decisions). */
  name_variant?: string;
  /** Canonical resolved name this assertion maps to. */
  canonical_name?: string;
  /** Minimum similarity threshold (0–1) for fuzzy name matching. */
  match_threshold?: number;
  /** Structured basis for a scope_exception (e.g. eligibility category, disaster code). */
  exception_basis?: string;
  /** Document anchor ID or reference that evidence for this assertion is tied to. */
  document_anchor?: string;
  /** Domain tag limiting which rule packs consider this assertion (e.g. 'rate', 'identity'). */
  rule_domain?: string;
  /** Condition expression or tag describing when this assertion activates. */
  applies_when?: string;
  /** Minimum evidence level required to honour this assertion (e.g. 'confirmed', 'reviewed'). */
  evidence_requirement?: string;
}

/**
 * Conditions under which this assertion binds — i.e. when it is applicable.
 * Validator reads these before applying condition_json to determine relevance.
 */
export interface ConfidenceBinding {
  /** Field keys that must be non-null on the subject for this binding to hold. */
  requires_fields?: string[];
  /** Whether the governing contract must have rate codes present (null = don't care). */
  contract_has_codes?: boolean | null;
  /** Whether the unit of measure on the subject must match the assertion's canonical unit. */
  unit_match_required?: boolean;
  /** Catch-all for domain-specific binding conditions not covered above. */
  custom_conditions?: Record<string, unknown>;
}

// ============================================================================
// ROW TYPES
// ============================================================================

/** Full database row — matches all columns of public.decision_assertions. */
export interface DecisionAssertion {
  id: string;
  created_at: string;
  updated_at: string;
  org_id: string;
  project_id: string | null;
  contract_vehicle_id: string | null;
  client_id: string | null;
  scope_level: ScopeLevel;
  scope_id: string;
  decision_type: DecisionAssertionType;
  subject_entity_type: string;
  subject_entity_id: string | null;
  condition_json: ConditionJson;
  confidence_binding: ConfidenceBinding;
  status: AssertionStatus;
  expiration_trigger_type: ExpirationTriggerType | null;
  expiration_trigger_id: string | null;
  superseded_by: string | null;
  /** Human-facing only — NEVER read by validator logic. */
  rationale: string | null;
  operator_id: string;
  source_decision_id: string | null;
}

/**
 * Shape for inserting a new decision assertion.
 * id, created_at, and updated_at are DB-generated.
 */
export type DecisionAssertionInsert = Omit<DecisionAssertion, 'id' | 'created_at' | 'updated_at'>;

/**
 * Subset read by the validator.
 * rationale is intentionally excluded — validator logic must never branch on it.
 */
export type DecisionAssertionQuery = Pick<
  DecisionAssertion,
  | 'id'
  | 'decision_type'
  | 'scope_level'
  | 'subject_entity_type'
  | 'subject_entity_id'
  | 'condition_json'
  | 'confidence_binding'
  | 'status'
>;
