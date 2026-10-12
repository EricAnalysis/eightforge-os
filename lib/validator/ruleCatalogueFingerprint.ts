import { createHash } from 'node:crypto';

import { validatorRuleExplanation } from '@/lib/validator/ruleExplanations';

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
