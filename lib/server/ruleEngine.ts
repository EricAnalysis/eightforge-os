// lib/server/ruleEngine.ts
// Deterministic rule evaluator for the EightForge decision backbone.
//
// Responsibilities:
//   1. Load normalized facts from document_extractions (delegates to documentExtractions)
//   2. Load applicable rules by organization_id, domain, document_type
//   3. Evaluate each rule against facts using the constrained v1 condition grammar
//
// All evaluation functions (evaluateCondition, evaluateRule) are pure — no I/O,
// no side effects — and can be called from both server and client code for
// testing and preview purposes.

import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';
import { loadFactsFromExtractions } from '@/lib/server/documentExtractions';
import type {
  Facts,
  RuleRow,
  Condition,
  ConditionOperator,
  ConditionJson,
  ConditionResult,
  RuleEvalResult,
} from '@/lib/types/rules';

// Re-export the pure evaluation functions so consumers don't need to know
// about the internal split between I/O and pure logic.
export type { Facts, RuleRow, RuleEvalResult, ConditionResult };

// ---------------------------------------------------------------------------
// 1. Fact Loading (delegates to documentExtractions — single source of truth)
// ---------------------------------------------------------------------------

/**
 * Load normalized facts from document_extractions for a given document.
 * Only loads rows that have a field_key set (normalized fact rows) and
 * status = 'active'. Returns a flat key→typed-value map.
 *
 * This is a thin wrapper around documentExtractions.loadFactsFromExtractions
 * so callers don't need to import from two modules.
 */
export async function loadFacts(documentId: string): Promise<Facts> {
  return loadFactsFromExtractions(documentId);
}

// ---------------------------------------------------------------------------
// 2. Rule Loading
// ---------------------------------------------------------------------------

/**
 * Load applicable rules for a document based on domain and document_type.
 * Merges organization-specific rules with global rules (organization_id IS NULL).
 * Returns rules ordered by priority ASC (lowest number = highest priority).
 */
export async function loadRules(params: {
  organizationId: string;
  domain: string;
  documentType: string;
}): Promise<RuleRow[]> {
  const admin = getSupabaseAdmin();
  if (!admin) return [];

  const { data, error } = await admin
    .from('rules')
    .select('*')
    .eq('domain', params.domain)
    .eq('document_type', params.documentType)
    .eq('status', 'active')
    .or(
      `organization_id.eq.${params.organizationId},organization_id.is.null`,
    )
    .order('priority', { ascending: true });

  if (error) {
    console.error('[ruleEngine] loadRules error:', error);
    return [];
  }

  return (data ?? []) as RuleRow[];
}

// ---------------------------------------------------------------------------
// 3. Condition Evaluation (pure — no I/O, no side effects)
// ---------------------------------------------------------------------------

/**
 * Evaluate a single condition against a facts map.
 */
export function evaluateCondition(
  condition: Condition,
  facts: Facts,
): ConditionResult {
  const { field_key, operator, value: expected } = condition;
  const actual = Object.prototype.hasOwnProperty.call(facts, field_key)
    ? facts[field_key]
    : null;

  return {
    field_key,
    operator,
    expected,
    actual,
    passed: applyOperator(operator, actual, expected),
  };
}

/**
 * Core operator implementation. Every branch is null-safe.
 *
 * Operator semantics:
 *   exists       — fact key is present and value is not null
 *   not_exists   — fact key is absent or value is null
 *   equals       — coerced equality (number-aware, case-insensitive strings)
 *   not_equals   — negation of equals; returns true when fact is null
 *   greater_than — numeric comparison (dates coerced to epoch ms)
 *   less_than    — numeric comparison
 *   contains     — case-insensitive substring match
 *   not_contains — negation of contains; returns true when fact is null
 *   in           — value is in the expected array (case-insensitive)
 *   not_in       — value is not in the expected array; returns true when fact is null
 */
function applyOperator(
  op: ConditionOperator,
  actual: unknown,
  expected: unknown,
): boolean {
  // ── Existence operators ──────────────────────────────────────────────
  if (op === 'exists') {
    return actual !== null && actual !== undefined;
  }
  if (op === 'not_exists') {
    return actual === null || actual === undefined;
  }

  // ── Null actual handling for comparison operators ────────────────────
  // When the fact is missing, most comparisons fail. The exceptions are
  // negation operators where "absent" logically means "not equal to X".
  if (actual === null || actual === undefined) {
    if (op === 'not_equals') return expected !== null && expected !== undefined;
    if (op === 'not_contains') return true;
    if (op === 'not_in') return true;
    return false;
  }

  // ── Value comparison operators ───────────────────────────────────────
  switch (op) {
    case 'equals':
      return coerceEquals(actual, expected);

    case 'not_equals':
      return !coerceEquals(actual, expected);

    case 'greater_than':
      return toNumber(actual) > toNumber(expected);

    case 'greater_than_or_equal':
      return toNumber(actual) >= toNumber(expected);

    case 'less_than':
      return toNumber(actual) < toNumber(expected);

    case 'less_than_or_equal':
      return toNumber(actual) <= toNumber(expected);

    case 'contains':
      return String(actual).toLowerCase().includes(String(expected).toLowerCase());

    case 'not_contains':
      return !String(actual).toLowerCase().includes(String(expected).toLowerCase());

    case 'in': {
      const list = Array.isArray(expected) ? expected : [];
      const actualLower = String(actual).toLowerCase();
      return list.some((item) => String(item).toLowerCase() === actualLower);
    }

    case 'not_in': {
      const list = Array.isArray(expected) ? expected : [];
      const actualLower = String(actual).toLowerCase();
      return !list.some((item) => String(item).toLowerCase() === actualLower);
    }

    default:
      return false;
  }
}

/** Coerce two values to a common type for equality comparison. */
function coerceEquals(a: unknown, b: unknown): boolean {
  if (typeof a === 'number' || typeof b === 'number') {
    return toNumber(a) === toNumber(b);
  }
  if (typeof a === 'boolean' || typeof b === 'boolean') {
    return Boolean(a) === Boolean(b);
  }
  return String(a).toLowerCase() === String(b).toLowerCase();
}

/** Safely coerce any value to a number. */
function toNumber(v: unknown): number {
  if (typeof v === 'number') return v;
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'boolean') return v ? 1 : 0;
  const n = Number(v);
  return Number.isNaN(n) ? 0 : n;
}

// ---------------------------------------------------------------------------
// 4. Rule Evaluation (pure — no I/O, no side effects)
// ---------------------------------------------------------------------------

/**
 * Evaluate a single rule against a facts map.
 * Uses match_type = 'all' (AND) or 'any' (OR).
 * Returns the full condition-by-condition breakdown for audit/preview.
 */
export function evaluateRule(rule: RuleRow, facts: Facts): RuleEvalResult {
  const cj = rule.condition_json as ConditionJson | null;

  if (
    !cj ||
    !Array.isArray(cj.conditions) ||
    cj.conditions.length === 0
  ) {
    return { rule, matched: false, condition_results: [] };
  }

  const conditionResults = cj.conditions.map((c) =>
    evaluateCondition(c, facts),
  );

  const matchType = cj.match_type ?? 'all';
  const matched =
    matchType === 'all'
      ? conditionResults.every((r) => r.passed)
      : conditionResults.some((r) => r.passed);

  return { rule, matched, condition_results: conditionResults };
}

// ---------------------------------------------------------------------------
// 5. Full Document Evaluation (I/O: loads facts + rules, then evaluates)
// ---------------------------------------------------------------------------

/**
 * Evaluate all applicable rules for a document.
 * Loads facts and rules in parallel, then evaluates each rule.
 * Returns every evaluation result (matched and unmatched) for full transparency.
 */
export async function evaluateDocument(params: {
  documentId: string;
  organizationId: string;
  domain: string;
  documentType: string;
}): Promise<{
  facts: Facts;
  results: RuleEvalResult[];
  matched: RuleEvalResult[];
}> {
  const [facts, rules] = await Promise.all([
    loadFacts(params.documentId),
    loadRules({
      organizationId: params.organizationId,
      domain: params.domain,
      documentType: params.documentType,
    }),
  ]);

  const results = rules.map((rule) => evaluateRule(rule, facts));
  const matched = results.filter((r) => r.matched);

  return { facts, results, matched };
}

// ---------------------------------------------------------------------------
// Test Examples (pure function verification — no I/O needed)
// ---------------------------------------------------------------------------
//
// import { evaluateCondition, evaluateRule } from '@/lib/server/ruleEngine';
// import type { Facts, RuleRow } from '@/lib/types/rules';
//
// const facts: Facts = {
//   invoice_number: 'INV-2025-001',
//   vendor_name: 'Acme Debris Hauling',
//   amount: 75000,
//   rate_amount: 125,
//   disposal_site: 'Approved Site Alpha',
// };
//
// // exists → true (invoice_number has a value)
// evaluateCondition({ field_key: 'invoice_number', operator: 'exists', value: null }, facts);
//
// // not_exists → true (po_number is not in facts)
// evaluateCondition({ field_key: 'po_number', operator: 'not_exists', value: null }, facts);
//
// // greater_than → true (75000 > 50000)
// evaluateCondition({ field_key: 'amount', operator: 'greater_than', value: 50000 }, facts);
//
// // contains → true ('approved site alpha' includes 'alpha')
// evaluateCondition({ field_key: 'disposal_site', operator: 'contains', value: 'alpha' }, facts);
//
// // in → true ('acme debris hauling' is in the list)
// evaluateCondition({ field_key: 'vendor_name', operator: 'in', value: ['Acme Debris Hauling', 'Beta Corp'] }, facts);
//
// // Full rule evaluation with match_type = 'all':
// const rule = {
//   condition_json: {
//     match_type: 'all' as const,
//     conditions: [
//       { field_key: 'amount', operator: 'greater_than' as const, value: 50000 },
//       { field_key: 'po_number', operator: 'not_exists' as const, value: null },
//     ],
//   },
// } as RuleRow;
// evaluateRule(rule, facts);
// // → { matched: true, condition_results: [{ passed: true }, { passed: true }] }
