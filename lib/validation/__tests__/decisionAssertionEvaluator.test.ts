/**
 * Unit tests for decisionAssertionEvaluator.ts
 *
 * All 6 required cases:
 *  1. No assertions → 'confirmed', empty arrays
 *  2. Applicable assertion, no conflict → 'suppressed', assertion in applied_assertions
 *  3. confidence_binding not satisfied (contract_has_codes mismatch) → assertion not applied, 'confirmed'
 *  4. Conflict at same scope level → 'requires_review'
 *  5. Human-reviewed invoice-level override conflicts with inference → 'requires_review' (rule 4 beats rule 6)
 *  6. Williamson canonical case
 *
 * No Supabase imports. All mocks are inline objects.
 */

import { describe, it, expect } from 'vitest';
import {
  evaluateAssertionApplies,
  evaluateAssertionConflicts,
  resolveAssertionsForFinding,
} from '../decisionAssertionEvaluator';
import type {
  FindingEvaluationContext,
  ValidatorInference,
} from '../decisionAssertionEvaluator';
import type { DecisionAssertionQuery } from '../../types/decisionAssertions';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAssertion(overrides: Partial<DecisionAssertionQuery> = {}): DecisionAssertionQuery {
  return {
    id: 'assertion-1',
    decision_type: 'business_rule',
    scope_level: 'contract_vehicle',
    subject_entity_type: 'invoice_line',
    subject_entity_id: null,
    condition_json: {},
    confidence_binding: {},
    status: 'active',
    ...overrides,
  };
}

function makeContext(overrides: Partial<FindingEvaluationContext> = {}): FindingEvaluationContext {
  return {
    project_id: 'proj-1',
    contract_id: 'contract-1',
    invoice_id: null,
    subject_entity_type: 'invoice_line',
    subject_entity_id: 'line-1',
    contract_has_codes: true,
    unit: null,
    match_priority: null,
    finding_type: 'FINANCIAL_RATE_CODE_MISSING',
    ...overrides,
  };
}

function makeInference(overrides: Partial<ValidatorInference> = {}): ValidatorInference {
  return {
    finding_type: 'FINANCIAL_RATE_CODE_MISSING',
    conclusion: 'pass',
    confidence: 0.9,
    evidence_refs: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test 1: No assertions → 'confirmed', empty arrays
// ---------------------------------------------------------------------------

describe('resolveAssertionsForFinding', () => {
  it('test 1: no assertions returns confirmed with empty arrays', () => {
    const result = resolveAssertionsForFinding([], makeContext(), makeInference());

    expect(result.resolution).toBe('confirmed');
    expect(result.applied_assertions).toEqual([]);
    expect(result.conflicts).toEqual([]);
    expect(result.evidence_chain).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Test 2: Applicable assertion, no conflict → 'suppressed'
  // -------------------------------------------------------------------------

  it('test 2: applicable assertion with no conflict returns suppressed', () => {
    const assertion = makeAssertion({
      id: 'assert-no-conflict',
      decision_type: 'business_rule',
      scope_level: 'project',
      confidence_binding: {},
    });
    // conclusion='pass' → no conflict rules fire
    const inference = makeInference({ conclusion: 'pass', confidence: 0.95 });

    const result = resolveAssertionsForFinding([assertion], makeContext(), inference);

    expect(result.resolution).toBe('suppressed');
    expect(result.applied_assertions).toContain(assertion);
    expect(result.conflicts).toEqual([]);
    expect(result.evidence_chain).toContain('assert-no-conflict:business_rule');
  });

  // -------------------------------------------------------------------------
  // Test 3: confidence_binding not satisfied (contract_has_codes mismatch)
  //         → assertion not applied, 'confirmed'
  // -------------------------------------------------------------------------

  it('test 3: confidence_binding contract_has_codes mismatch means assertion is not applied', () => {
    // Binding requires contract_has_codes=false; context has contract_has_codes=true → mismatch.
    const assertion = makeAssertion({
      id: 'assert-binding-mismatch',
      confidence_binding: { contract_has_codes: false },
    });
    const context = makeContext({ contract_has_codes: true });
    const inference = makeInference();

    const result = resolveAssertionsForFinding([assertion], context, inference);

    expect(result.resolution).toBe('confirmed');
    expect(result.applied_assertions).toEqual([]);
    expect(result.evidence_chain).toEqual([]);
  });

  // Also verify: null context value with a non-null binding → return false (do not assume)
  it('test 3b: confidence_binding contract_has_codes=false with null context returns confirmed', () => {
    const assertion = makeAssertion({
      id: 'assert-null-context',
      confidence_binding: { contract_has_codes: false },
    });
    const context = makeContext({ contract_has_codes: null });

    const result = resolveAssertionsForFinding([assertion], context, makeInference());

    expect(result.resolution).toBe('confirmed');
    expect(result.applied_assertions).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Test 4: Conflict at same scope level → 'requires_review'
  // -------------------------------------------------------------------------

  it('test 4: two assertions with conflicts at the same scope level returns requires_review', () => {
    // Both assertions at 'contract_vehicle' scope.
    // rate_interpretation + fail → conflict(type='suppression') for each.
    // Two conflicts at same scope level → rule 5 → requires_review.
    const assertionA = makeAssertion({
      id: 'assert-same-scope-A',
      decision_type: 'rate_interpretation',
      scope_level: 'contract_vehicle',
      confidence_binding: {},
    });
    const assertionB = makeAssertion({
      id: 'assert-same-scope-B',
      decision_type: 'rate_interpretation',
      scope_level: 'contract_vehicle',
      confidence_binding: {},
    });
    const inference = makeInference({ conclusion: 'fail', confidence: 0.8 });

    const result = resolveAssertionsForFinding(
      [assertionA, assertionB],
      makeContext(),
      inference,
    );

    expect(result.resolution).toBe('requires_review');
    expect(result.applied_assertions).toHaveLength(2);
    expect(result.conflicts).toHaveLength(2);
  });

  // -------------------------------------------------------------------------
  // Test 5: Human-reviewed invoice-level override conflicts with inference
  //         → 'requires_review' (rule 4 beats rule 6)
  //
  //         One assertion at invoice scope, one at project scope.
  //         Different scope levels would normally → rule 6 (overridden),
  //         but rule 4 catches the invoice-level conflict first.
  // -------------------------------------------------------------------------

  it('test 5: invoice-level conflict triggers requires_review (rule 4 beats rule 6)', () => {
    const assertionInvoice = makeAssertion({
      id: 'assert-invoice-scope',
      decision_type: 'scope_exception',
      scope_level: 'invoice',
      confidence_binding: {},
    });
    const assertionProject = makeAssertion({
      id: 'assert-project-scope',
      decision_type: 'scope_exception',
      scope_level: 'project',
      confidence_binding: {},
    });
    // scope_exception + non-pass → conflict(type='override') for both
    const inference = makeInference({ conclusion: 'warn', confidence: 0.7 });

    const result = resolveAssertionsForFinding(
      [assertionInvoice, assertionProject],
      makeContext(),
      inference,
    );

    // Rule 4 fires before rule 6 because assertionInvoice is at 'invoice' scope.
    expect(result.resolution).toBe('requires_review');
    expect(result.applied_assertions).toHaveLength(2);
  });

  // -------------------------------------------------------------------------
  // Test 6: Williamson canonical case
  //
  //   assertion: decision_type='rate_interpretation'
  //   condition_json: { match_priority: 'description' }
  //   confidence_binding: { contract_has_codes: false, requires_fields: ['unit'] }
  //   context: contract_has_codes=false, unit='CY'
  //   inference: conclusion='fail'
  //   Expected: resolution='suppressed', applied_assertions contains the assertion,
  //             evidence_chain contains assertion ID
  // -------------------------------------------------------------------------

  it('test 6: Williamson canonical case — rate_interpretation suppresses fail inference at non-high scope', () => {
    const williamsonAssertion = makeAssertion({
      id: 'williamson-assert-1',
      decision_type: 'rate_interpretation',
      scope_level: 'contract_vehicle',
      condition_json: {
        // match_priority is typed as number in ConditionJson but the spec uses
        // a string label here; evaluateAssertionApplies does not read condition_json,
        // so this does not affect evaluation.
        match_priority: undefined,
        rule_domain: 'rate',
      },
      confidence_binding: {
        contract_has_codes: false,
        unit_match_required: true,
        expected_unit: 'CYD',
      },
    });

    // unit='CY' normalizes to 'CYD' — matches expected_unit 'CYD' → assertion applies
    const context = makeContext({
      project_id: 'proj-williamson',
      contract_has_codes: false,
      unit: 'CY',
      finding_type: 'FINANCIAL_RATE_CODE_MISSING',
    });

    const inference = makeInference({
      finding_type: 'FINANCIAL_RATE_CODE_MISSING',
      conclusion: 'fail',
      confidence: 0.85,
    });

    const result = resolveAssertionsForFinding([williamsonAssertion], context, inference);

    expect(result.resolution).toBe('suppressed');
    expect(result.applied_assertions).toContain(williamsonAssertion);
    // evidence_chain must contain the assertion ID
    expect(result.evidence_chain.some((e) => e.includes('williamson-assert-1'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Unit tests for evaluateAssertionApplies and evaluateAssertionConflicts
// ---------------------------------------------------------------------------

describe('evaluateAssertionApplies', () => {
  it('returns true when confidence_binding is empty', () => {
    expect(evaluateAssertionApplies(makeAssertion(), makeContext())).toBe(true);
  });

  it('returns false when contract_has_codes is null and binding specifies false', () => {
    const assertion = makeAssertion({ confidence_binding: { contract_has_codes: false } });
    expect(evaluateAssertionApplies(assertion, makeContext({ contract_has_codes: null }))).toBe(
      false,
    );
  });

  it('returns false when contract_has_codes context value mismatches binding', () => {
    const assertion = makeAssertion({ confidence_binding: { contract_has_codes: true } });
    expect(
      evaluateAssertionApplies(assertion, makeContext({ contract_has_codes: false })),
    ).toBe(false);
  });

  it('returns true when contract_has_codes matches', () => {
    const assertion = makeAssertion({ confidence_binding: { contract_has_codes: false } });
    expect(
      evaluateAssertionApplies(assertion, makeContext({ contract_has_codes: false })),
    ).toBe(true);
  });

  it('returns false when requires_fields lists a null context field', () => {
    const assertion = makeAssertion({ confidence_binding: { requires_fields: ['unit'] } });
    expect(evaluateAssertionApplies(assertion, makeContext({ unit: null }))).toBe(false);
  });

  it('returns true when all requires_fields are non-null', () => {
    const assertion = makeAssertion({
      confidence_binding: { requires_fields: ['unit', 'contract_id'] },
    });
    expect(
      evaluateAssertionApplies(assertion, makeContext({ unit: 'CY', contract_id: 'c-1' })),
    ).toBe(true);
  });

  it('skips contract_has_codes check when binding value is null (dont care)', () => {
    const assertion = makeAssertion({ confidence_binding: { contract_has_codes: null } });
    // context has contract_has_codes=null too — should still apply because binding is null
    expect(
      evaluateAssertionApplies(assertion, makeContext({ contract_has_codes: null })),
    ).toBe(true);
  });
});

describe('evaluateAssertionApplies — unit_match_required', () => {
  // Test 7: exact match
  it('test 7: unit_match_required true, expected_unit CYD, context.unit CYD → true', () => {
    const assertion = makeAssertion({
      confidence_binding: { unit_match_required: true, expected_unit: 'CYD' },
    });
    expect(evaluateAssertionApplies(assertion, makeContext({ unit: 'CYD' }))).toBe(true);
  });

  // Test 8: unit mismatch
  it('test 8: unit_match_required true, expected_unit CYD, context.unit TON → false', () => {
    const assertion = makeAssertion({
      confidence_binding: { unit_match_required: true, expected_unit: 'CYD' },
    });
    expect(evaluateAssertionApplies(assertion, makeContext({ unit: 'TON' }))).toBe(false);
  });

  // Test 9: safe-fail — context.unit is null
  it('test 9: unit_match_required true, expected_unit CYD, context.unit null → false (safe-fail)', () => {
    const assertion = makeAssertion({
      confidence_binding: { unit_match_required: true, expected_unit: 'CYD' },
    });
    expect(evaluateAssertionApplies(assertion, makeContext({ unit: null }))).toBe(false);
  });

  // Test 10: safe-fail — expected_unit is null
  it('test 10: unit_match_required true, expected_unit null, context.unit CYD → false (safe-fail)', () => {
    const assertion = makeAssertion({
      confidence_binding: { unit_match_required: true, expected_unit: null },
    });
    expect(evaluateAssertionApplies(assertion, makeContext({ unit: 'CYD' }))).toBe(false);
  });

  // Test 11: normalization — CY → CYD
  it('test 11: unit_match_required true, expected_unit CY, context.unit CYD → true (CY normalizes to CYD)', () => {
    const assertion = makeAssertion({
      confidence_binding: { unit_match_required: true, expected_unit: 'CY' },
    });
    expect(evaluateAssertionApplies(assertion, makeContext({ unit: 'CYD' }))).toBe(true);
  });

  // Test 12: case-insensitive + normalization
  it('test 12: unit_match_required true, expected_unit cy (lowercase), context.unit CYD → true', () => {
    const assertion = makeAssertion({
      confidence_binding: { unit_match_required: true, expected_unit: 'cy' },
    });
    expect(evaluateAssertionApplies(assertion, makeContext({ unit: 'CYD' }))).toBe(true);
  });

  // Test 13: normalization — TONS → TON
  it('test 13: unit_match_required true, expected_unit TON, context.unit TONS → true (TONS normalizes to TON)', () => {
    const assertion = makeAssertion({
      confidence_binding: { unit_match_required: true, expected_unit: 'TON' },
    });
    expect(evaluateAssertionApplies(assertion, makeContext({ unit: 'TONS' }))).toBe(true);
  });

  // Test 14: cross-type mismatch after normalization
  it('test 14: unit_match_required true, expected_unit CYD, context.unit TONS → false (CYD !== TON after normalize)', () => {
    const assertion = makeAssertion({
      confidence_binding: { unit_match_required: true, expected_unit: 'CYD' },
    });
    expect(evaluateAssertionApplies(assertion, makeContext({ unit: 'TONS' }))).toBe(false);
  });
});

describe('evaluateAssertionConflicts', () => {
  it('returns suppression conflict for rate_interpretation + fail', () => {
    const assertion = makeAssertion({ decision_type: 'rate_interpretation' });
    const inference = makeInference({ conclusion: 'fail' });
    const conflict = evaluateAssertionConflicts(assertion, inference);
    expect(conflict).not.toBeNull();
    expect(conflict!.conflict_type).toBe('suppression');
  });

  it('returns null for rate_interpretation + pass', () => {
    const assertion = makeAssertion({ decision_type: 'rate_interpretation' });
    const inference = makeInference({ conclusion: 'pass', confidence: 0.9 });
    expect(evaluateAssertionConflicts(assertion, inference)).toBeNull();
  });

  it('returns override conflict for scope_exception + warn', () => {
    const assertion = makeAssertion({ decision_type: 'scope_exception' });
    const inference = makeInference({ conclusion: 'warn' });
    const conflict = evaluateAssertionConflicts(assertion, inference);
    expect(conflict).not.toBeNull();
    expect(conflict!.conflict_type).toBe('override');
  });

  it('returns null for scope_exception + pass', () => {
    const assertion = makeAssertion({ decision_type: 'scope_exception' });
    const inference = makeInference({ conclusion: 'pass' });
    expect(evaluateAssertionConflicts(assertion, inference)).toBeNull();
  });

  it('returns escalation conflict when confidence < 0.5', () => {
    const assertion = makeAssertion({ decision_type: 'business_rule' });
    const inference = makeInference({ conclusion: 'pass', confidence: 0.4 });
    const conflict = evaluateAssertionConflicts(assertion, inference);
    expect(conflict).not.toBeNull();
    expect(conflict!.conflict_type).toBe('escalation');
  });

  it('returns null when confidence is exactly 0.5', () => {
    const assertion = makeAssertion({ decision_type: 'business_rule' });
    const inference = makeInference({ conclusion: 'warn', confidence: 0.5 });
    // 0.5 is not < 0.5; business_rule + warn does not match other rules
    expect(evaluateAssertionConflicts(assertion, inference)).toBeNull();
  });

  it('returns null when confidence is null', () => {
    const assertion = makeAssertion({ decision_type: 'business_rule' });
    const inference = makeInference({ conclusion: 'unknown', confidence: null });
    expect(evaluateAssertionConflicts(assertion, inference)).toBeNull();
  });

  it('rate_interpretation + fail takes precedence over low confidence check', () => {
    const assertion = makeAssertion({ decision_type: 'rate_interpretation' });
    const inference = makeInference({ conclusion: 'fail', confidence: 0.3 });
    const conflict = evaluateAssertionConflicts(assertion, inference);
    // Rule 1 fires first
    expect(conflict!.conflict_type).toBe('suppression');
  });
});
