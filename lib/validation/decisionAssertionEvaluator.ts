/**
 * Decision Assertion Condition Evaluator
 *
 * Phase B implementation: pure, side-effect-free evaluator for applying
 * operator decision assertions to validator findings.
 *
 * Constraints:
 * - No Supabase imports.
 * - The `rationale` field on DecisionAssertion is intentionally excluded from
 *   DecisionAssertionQuery. No function here reads or branches on it.
 * - All functions are pure — no side effects.
 */

import type { DecisionAssertionQuery, ScopeLevel } from '../types/decisionAssertions';

// ============================================================================
// FINDING EVALUATION CONTEXT
// ============================================================================

/**
 * Context available at a makeFinding() call site, used to determine whether
 * a decision assertion applies to the finding being evaluated.
 *
 * IMPORTANT: invoice_id is absent for 14 finding type groups per
 * VALIDATOR_INTEGRATION_AUDIT.md Section 2 — assertions keyed on invoice_id
 * cannot match project-subject or ticket-subject findings.
 */
export interface FindingEvaluationContext {
  project_id: string;
  /** Null if no contract document is loaded (e.g. SOURCES_NO_CONTRACT). */
  contract_id: string | null;
  /**
   * Absent (null) for SOURCES_*, IDENTITY_*, FINANCIAL_RATE_BASED_*,
   * FINANCIAL_NTE_*, and TICKET_* finding types. Assertions keyed on
   * invoice_id cannot match these finding types.
   */
  invoice_id: string | null;
  subject_entity_type: string;
  subject_entity_id: string | null;
  /** Derived as rateScheduleItems.some(i => i.rate_code != null) || contractCeilingType === 'rate_based'. */
  contract_has_codes: boolean | null;
  /** Unit of measure on the subject entity, if available. */
  unit: string | null;
  /** Match priority label in scope for this finding, if applicable. */
  match_priority: string | null;
  finding_type: string;
}

// ============================================================================
// VALIDATOR INFERENCE
// ============================================================================

/**
 * Structured representation of what the validator inferred for a finding.
 * Passed alongside context to determine assertion–inference conflicts.
 */
export interface ValidatorInference {
  finding_type: string;
  conclusion: 'pass' | 'fail' | 'warn' | 'unknown';
  confidence: number | null;
  evidence_refs: string[];
}

// ============================================================================
// CONFLICT AND RESOLUTION TYPES
// ============================================================================

export interface AssertionConflict {
  assertion: DecisionAssertionQuery;
  inference: ValidatorInference;
  conflict_type: 'suppression' | 'override' | 'escalation';
}

export interface AssertionResolution {
  applied_assertions: DecisionAssertionQuery[];
  conflicts: AssertionConflict[];
  resolution: 'suppressed' | 'overridden' | 'confirmed' | 'requires_review';
  evidence_chain: string[];
}

// ============================================================================
// SCOPE HIERARCHY
// Invoice is most specific (0); global is least specific (5).
// client sits between contract_vehicle and organization per the ScopeLevel enum.
// ============================================================================

const SCOPE_PRIORITY: Record<ScopeLevel, number> = {
  invoice: 0,
  project: 1,
  contract_vehicle: 2,
  client: 3,
  organization: 4,
  global: 5,
};

// ============================================================================
// EXPORTED FUNCTIONS
// ============================================================================

/**
 * Determines whether a decision assertion applies to the given finding context.
 *
 * Rules (applied in order — return false on first mismatch):
 * 1. confidence_binding.contract_has_codes: if binding specifies a boolean value
 *    and context.contract_has_codes is null, return false (never assume).
 *    If both are non-null and differ, return false.
 * 2. confidence_binding.requires_fields: every listed field must be non-null on
 *    context. Return false on the first missing or null field.
 * 3. Return false on any missing/non-matching condition; never throw.
 *
 * NEVER reads assertion.rationale.
 */
export function evaluateAssertionApplies(
  assertion: DecisionAssertionQuery,
  context: FindingEvaluationContext,
): boolean {
  const binding = assertion.confidence_binding;

  // Check contract_has_codes binding.
  // binding.contract_has_codes === null means "don't care" (per ConfidenceBinding docs).
  if (binding.contract_has_codes !== null && binding.contract_has_codes !== undefined) {
    if (context.contract_has_codes === null) {
      // Cannot confirm the binding condition; do not assume.
      return false;
    }
    if (context.contract_has_codes !== binding.contract_has_codes) {
      return false;
    }
  }

  // Check requires_fields: every listed field must be non-null in context.
  const requiredFields = binding.requires_fields ?? [];
  if (requiredFields.length > 0) {
    const contextRecord = context as unknown as Record<string, unknown>;
    for (const field of requiredFields) {
      const value = contextRecord[field];
      if (value === null || value === undefined) {
        return false;
      }
    }
  }

  return true;
}

/**
 * Evaluates whether a decision assertion is in conflict with a validator inference.
 *
 * Conflict detection rules (checked in order):
 * 1. decision_type === 'rate_interpretation' AND inference.conclusion === 'fail'
 *    → conflict_type = 'suppression'
 * 2. decision_type === 'scope_exception' AND inference.conclusion !== 'pass'
 *    → conflict_type = 'override'
 * 3. inference.confidence !== null AND inference.confidence < 0.5
 *    → conflict_type = 'escalation'
 *
 * Returns null if no conflict is detected.
 * NEVER reads assertion.rationale.
 */
export function evaluateAssertionConflicts(
  assertion: DecisionAssertionQuery,
  inference: ValidatorInference,
): AssertionConflict | null {
  if (assertion.decision_type === 'rate_interpretation' && inference.conclusion === 'fail') {
    return { assertion, inference, conflict_type: 'suppression' };
  }

  if (assertion.decision_type === 'scope_exception' && inference.conclusion !== 'pass') {
    return { assertion, inference, conflict_type: 'override' };
  }

  if (inference.confidence !== null && inference.confidence < 0.5) {
    return { assertion, inference, conflict_type: 'escalation' };
  }

  return null;
}

/**
 * Resolves operator decision assertions against a validator finding context and
 * inference, producing a structured resolution with full evidence chain.
 *
 * Resolution rules (enforced in this exact order):
 * 1. Filter to assertions where evaluateAssertionApplies returns true.
 * 2. No applicable assertions → resolution = 'confirmed', empty arrays.
 * 3. Check each applicable assertion for conflicts via evaluateAssertionConflicts.
 * 4. Any conflict where scope_level is 'invoice' or 'project':
 *    resolution = 'requires_review' — never silent.
 *    NOTE: DecisionAssertionQuery does not expose operator_id; all assertions at
 *    invoice/project scope are treated as operator-set by definition (operator_id
 *    is non-nullable on DecisionAssertion and is always present on DB rows).
 * 5. Multiple conflicts at the same scope_level → resolution = 'requires_review'.
 * 6. Conflicts across different scope levels → apply hierarchy
 *    (invoice > project > contract_vehicle > client > organization > global),
 *    resolution = 'overridden', log all conflicts in evidence_chain.
 * 7. No conflicts → resolution = 'suppressed'.
 *    Single conflict below invoice/project scope: resolved by conflict_type
 *    ('suppression' → 'suppressed', 'override' → 'overridden',
 *    'escalation' → 'requires_review').
 * 8. Always populate evidence_chain with assertion IDs and decision_type labels
 *    for every applied assertion.
 *
 * Pure — no side effects. NEVER reads assertion.rationale.
 */
export function resolveAssertionsForFinding(
  assertions: DecisionAssertionQuery[],
  context: FindingEvaluationContext,
  inference: ValidatorInference,
): AssertionResolution {
  // Rule 1: Filter to applicable assertions.
  const applied_assertions = assertions.filter((a) => evaluateAssertionApplies(a, context));

  // Rule 2: No applicable assertions → confirmed.
  if (applied_assertions.length === 0) {
    return {
      applied_assertions: [],
      conflicts: [],
      resolution: 'confirmed',
      evidence_chain: [],
    };
  }

  // Rule 3: Check each applicable assertion for conflicts.
  const conflicts: AssertionConflict[] = applied_assertions
    .map((a) => evaluateAssertionConflicts(a, inference))
    .filter((c): c is AssertionConflict => c !== null);

  // Rule 8: Base evidence chain — one entry per applied assertion.
  const evidence_chain: string[] = applied_assertions.map(
    (a) => `${a.id}:${a.decision_type}`,
  );

  // Rule 4: Any conflict at invoice/project scope → requires_review (never silent).
  // Note: operator_id is not available on DecisionAssertionQuery; invoice/project
  // scope is used as the proxy for operator-set assertions per audit findings.
  const highScopeConflict = conflicts.find(
    (c) => c.assertion.scope_level === 'invoice' || c.assertion.scope_level === 'project',
  );
  if (highScopeConflict) {
    return { applied_assertions, conflicts, resolution: 'requires_review', evidence_chain };
  }

  // Rules 5 & 6: Handle multiple conflicts.
  if (conflicts.length > 1) {
    const scopeLevels = new Set(conflicts.map((c) => c.assertion.scope_level));

    // Rule 5: All conflicts at the same scope level → requires_review.
    if (scopeLevels.size === 1) {
      return { applied_assertions, conflicts, resolution: 'requires_review', evidence_chain };
    }

    // Rule 6: Conflicts across scope levels → apply hierarchy, resolution = 'overridden'.
    for (const conflict of conflicts) {
      evidence_chain.push(
        `conflict:${conflict.assertion.id}:${conflict.conflict_type}:${conflict.assertion.scope_level}`,
      );
    }
    return { applied_assertions, conflicts, resolution: 'overridden', evidence_chain };
  }

  // Rule 7: No conflicts → suppressed.
  if (conflicts.length === 0) {
    return { applied_assertions, conflicts: [], resolution: 'suppressed', evidence_chain };
  }

  // Single conflict below invoice/project scope (rule 4 already cleared).
  // Conflict type determines resolution.
  const singleConflict = conflicts[0];
  switch (singleConflict.conflict_type) {
    case 'suppression':
      return { applied_assertions, conflicts, resolution: 'suppressed', evidence_chain };
    case 'override':
      return { applied_assertions, conflicts, resolution: 'overridden', evidence_chain };
    case 'escalation':
      return { applied_assertions, conflicts, resolution: 'requires_review', evidence_chain };
  }
}
