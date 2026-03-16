// lib/ruleEvaluation.ts
// Pure deterministic rule evaluation — no I/O. Safe to use in browser for rule test panel.
// Server ruleEngine uses these same functions for document evaluation.

import type {
  Facts,
  RuleRow,
  Condition,
  ConditionOperator,
  ConditionJson,
  ConditionResult,
  RuleEvalResult,
} from '@/lib/types/rules';

export type { Facts, RuleRow, ConditionResult, RuleEvalResult };

function applyOperator(
  op: ConditionOperator,
  actual: unknown,
  expected: unknown,
): boolean {
  if (op === 'exists') {
    return actual !== null && actual !== undefined;
  }
  if (op === 'not_exists') {
    return actual === null || actual === undefined;
  }

  if (actual === null || actual === undefined) {
    if (op === 'not_equals') return expected !== null && expected !== undefined;
    if (op === 'not_contains') return true;
    if (op === 'not_in') return true;
    return false;
  }

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

function coerceEquals(a: unknown, b: unknown): boolean {
  if (typeof a === 'number' || typeof b === 'number') {
    return toNumber(a) === toNumber(b);
  }
  if (typeof a === 'boolean' || typeof b === 'boolean') {
    return Boolean(a) === Boolean(b);
  }
  return String(a).toLowerCase() === String(b).toLowerCase();
}

function toNumber(v: unknown): number {
  if (typeof v === 'number') return v;
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'boolean') return v ? 1 : 0;
  const n = Number(v);
  return Number.isNaN(n) ? 0 : n;
}

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
 * Evaluate a single rule against a facts map.
 * Uses match_type = 'all' (AND) or 'any' (OR).
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
