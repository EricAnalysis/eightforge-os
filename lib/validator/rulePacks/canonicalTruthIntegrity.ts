/**
 * Surfaces canonical identity and relationship integrity as operator findings.
 *
 * Canonical assembly can establish that an invoice number is claimed by two
 * source documents, that a governing contract has competing candidates, or that
 * a required relationship could not be established at all. None of those may
 * stay registry-only diagnostics: an operator has to see why a project cannot
 * clear, and a downstream total must not quietly consume ambiguous truth.
 *
 * This pack renders. It makes no authority decision — whether a signal blocks
 * was decided once, in the authority layer, during the single assembly. The
 * pack does not read the authority mode, does not read the environment, and
 * contributes nothing in legacy mode, where no signals exist. Both conflicting
 * observations reach the finding as separate evidence entries; nothing is
 * merged and no winner is chosen here or upstream.
 */

import { makeFinding, type ProjectValidatorInput, type ValidatorFindingResult } from '@/lib/validator/shared';

export const PACK_CANONICAL_TRUTH_INTEGRITY = 'canonical_truth_integrity';

export const RULE_CANONICAL_INVOICE_IDENTITY_CONFLICT = 'CANONICAL_INVOICE_IDENTITY_CONFLICT';
export const RULE_CANONICAL_INVOICE_LINE_IDENTITY_UNRESOLVED = 'CANONICAL_INVOICE_LINE_IDENTITY_UNRESOLVED';
export const RULE_CANONICAL_RELATIONSHIP_UNRESOLVED = 'CANONICAL_GOVERNING_RELATIONSHIP_UNRESOLVED';
export const RULE_CANONICAL_RELATIONSHIP_CONFLICTING = 'CANONICAL_GOVERNING_RELATIONSHIP_CONFLICTING';

function ruleIdFor(kind: string): string {
  switch (kind) {
    case 'invoice_identity_conflict':
      return RULE_CANONICAL_INVOICE_IDENTITY_CONFLICT;
    case 'invoice_line_identity_unresolved':
      return RULE_CANONICAL_INVOICE_LINE_IDENTITY_UNRESOLVED;
    case 'relationship_conflicting':
      return RULE_CANONICAL_RELATIONSHIP_CONFLICTING;
    default:
      return RULE_CANONICAL_RELATIONSHIP_UNRESOLVED;
  }
}

export function runCanonicalTruthIntegrityRules(
  input: ProjectValidatorInput,
): ValidatorFindingResult[] {
  const projection = input.projectTruthAuthority?.validatorProjection;
  // Legacy mode produces no canonical signals, so legacy behavior is unchanged.
  if (projection == null) return [];

  return projection.integritySignals.map((signal) => makeFinding({
    projectId: input.project.id,
    ruleId: ruleIdFor(signal.kind),
    category: 'financial_integrity',
    severity: signal.blocking ? 'critical' : 'warning',
    subjectType: signal.subjectType,
    // Deterministic finding identity from the stable signal key, so repeated
    // runs update one finding rather than creating a new one each time.
    subjectId: signal.subjectId,
    field: signal.field,
    expected: signal.expected,
    actual: signal.actual,
    blockedReason: signal.blocking ? signal.detail : undefined,
    decisionEligible: true,
    actionEligible: true,
    evidence: signal.evidence.map((entry) => ({ ...entry })),
  }));
}
