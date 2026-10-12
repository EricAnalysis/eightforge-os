import { createHash } from 'node:crypto';

import { VALIDATOR_RULE_EXPLANATIONS, validatorRuleExplanation } from '@/lib/validator/ruleExplanations';

/**
 * A stable fingerprint of one rule's catalogue entry (B6.4), so a semantics
 * review names exactly which wording and action list was in force when it was
 * raised. Server-only (node:crypto); the catalogue itself stays client-safe.
 *
 * Changes whenever the entry's title, category, explanation, required action
 * or actions change. Null for a rule the catalogue does not know.
 */
export const RULE_CATALOGUE_FINGERPRINT_VERSION = 'rule-explanation-v1';

export function ruleCatalogueFingerprint(ruleId: string): string | null {
  const entry = validatorRuleExplanation(ruleId);
  if (!entry) return null;
  const canonical = JSON.stringify([
    ruleId, entry.title, entry.category, entry.explanation, entry.requiredAction, [...entry.actions],
  ]);
  return `${RULE_CATALOGUE_FINGERPRINT_VERSION}:sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}

/**
 * B8.4b: the fingerprint of the whole rule catalogue a Validator run executed
 * under, stamped on the run so a later measurement can tell whether rule
 * wording or actions changed between its windows. Every catalogued rule's
 * entry fingerprint, in rule-id order.
 */
export const VALIDATOR_RULE_CATALOGUE_FINGERPRINT_VERSION = 'rule-catalogue-v1';

export function validatorRuleCatalogueFingerprint(): string {
  const entries = Object.keys(VALIDATOR_RULE_EXPLANATIONS).sort()
    .map((ruleId) => [ruleId, ruleCatalogueFingerprint(ruleId)]);
  return `${VALIDATOR_RULE_CATALOGUE_FINGERPRINT_VERSION}:sha256:${
    createHash('sha256').update(JSON.stringify(entries)).digest('hex')}`;
}
