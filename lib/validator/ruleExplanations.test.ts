import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { getIssueDisplayLabel } from '@/lib/issueDisplayFormatter';
import { normalizeValidationFinding } from '@/lib/validator/findingSemantics';
import { VALIDATOR_RULE_EXPLANATIONS } from '@/lib/validator/ruleExplanations';
import type { ValidationFinding } from '@/types/validator';

/** Still read by routing for findings recorded before the rule was renamed; never emitted now. */
const LEGACY_RULE_IDS = new Set(['FINANCIAL_RATE_NOT_IN_SCHEDULE']);

function validatorSources(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const full = path.join(directory, name);
    if (statSync(full).isDirectory()) return validatorSources(full);
    return name.endsWith('.ts') && !name.endsWith('.test.ts') ? [full] : [];
  });
}

/** Every rule ID the Validator can emit: `ruleId: '<ID>'` literals and `RULE_*` / `*_RULE_ID` constants. */
function emittedRuleIds(): Set<string> {
  const ids = new Set<string>();
  for (const file of validatorSources(path.join(process.cwd(), 'lib/validator'))) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/ruleId:\s*'([A-Z][A-Z0-9_]+)'/g)) ids.add(match[1]);
    for (const match of source.matchAll(/\b(?:RULE_[A-Z0-9_]+|[A-Z0-9_]+_RULE_ID)\s*=\s*'([A-Z][A-Z0-9_]+)'/g)) ids.add(match[1]);
  }
  return ids;
}

describe('Validator rule explanations', () => {
  const emitted = emittedRuleIds();

  it('finds the emitted rules (guards the scan itself)', () => {
    expect(emitted.size).toBeGreaterThanOrEqual(55);
    expect(emitted.has('SOURCES_NO_CONTRACT')).toBe(true);
    expect(emitted.has('CANONICAL_INVOICE_IDENTITY_CONFLICT')).toBe(true);
    expect(emitted.has('INVOICE_EXPOSURE_AT_RISK_AMOUNT_ZERO')).toBe(true);
  });

  it('explains every rule the Validator can emit', () => {
    const missing = [...emitted].filter((ruleId) => !VALIDATOR_RULE_EXPLANATIONS[ruleId]).sort();
    expect(missing).toEqual([]);
  });

  it('has no entry for a rule that is neither emitted nor a known legacy rule', () => {
    const orphans = Object.keys(VALIDATOR_RULE_EXPLANATIONS)
      .filter((ruleId) => !emitted.has(ruleId) && !LEGACY_RULE_IDS.has(ruleId)).sort();
    expect(orphans).toEqual([]);
  });

  it('gives every rule a short title, a category, an explanation and an action', () => {
    for (const [ruleId, entry] of Object.entries(VALIDATOR_RULE_EXPLANATIONS)) {
      expect(entry.title.length, ruleId).toBeGreaterThan(0);
      expect(entry.title.length, ruleId).toBeLessThanOrEqual(60);
      expect(entry.title, ruleId).not.toMatch(/[A-Z]{2,}_[A-Z]/);
      expect(entry.category.trim(), ruleId).not.toBe('');
      expect(entry.explanation, ruleId).toMatch(/\.$/);
      expect(entry.requiredAction, ruleId).toMatch(/\.$/);
    }
  });

  it('labels a finding by its rule even when the key carries its subject', () => {
    const label = getIssueDisplayLabel('TRANSACTION_GROUP_EXISTS_FOR_INVOICE_LINE:GODH03::UNIT', 'raw title');
    const rule = VALIDATOR_RULE_EXPLANATIONS.TRANSACTION_GROUP_EXISTS_FOR_INVOICE_LINE;
    expect(label).toEqual({
      title: rule.title,
      explanation: rule.explanation,
      recommended_action: rule.requiredAction,
      category: rule.category,
      raw_key: 'TRANSACTION_GROUP_EXISTS_FOR_INVOICE_LINE:GODH03::UNIT',
    });
  });

  it('keeps non-rule keys on their own templates and the generic fallback', () => {
    expect(getIssueDisplayLabel('validator_project_approval').title).toBe('Project approval status');
    expect(getIssueDisplayLabel('SOMETHING_UNKNOWN_HERE', 'Fallback title').title).toBe('Fallback title');
  });

  it('gives the finding the same recommended action as its display label', () => {
    const finding = {
      id: 'f1', run_id: 'r1', project_id: 'p1', rule_id: 'CANONICAL_INVOICE_IDENTITY_CONFLICT',
      check_key: 'CANONICAL_INVOICE_IDENTITY_CONFLICT:inv-1', category: 'financial_integrity', severity: 'critical',
      status: 'open', subject_type: 'invoice', subject_id: 'inv-1', field: 'invoice_number',
      expected: null, actual: null, variance: null, variance_unit: null, blocked_reason: null,
    } as unknown as ValidationFinding;
    const normalized = normalizeValidationFinding(finding);
    expect(normalized.required_action).toBe(VALIDATOR_RULE_EXPLANATIONS.CANONICAL_INVOICE_IDENTITY_CONFLICT.requiredAction);
    expect(getIssueDisplayLabel(finding.check_key).recommended_action).toBe(normalized.required_action);
    // A finding that already carries its own action keeps it.
    expect(normalizeValidationFinding({ ...finding, required_action: 'Specific action.' }).required_action).toBe('Specific action.');
  });
});
