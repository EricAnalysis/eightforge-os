export type CanonicalShadowParityClassification =
  | 'exact_semantic_parity'
  | 'represented_with_richer_typing'
  | 'represented_but_requires_review'
  | 'not_yet_representable'
  | 'current_source_unavailable'
  | 'conflicting_current_truth_path';

export type CanonicalShadowComparisonBoundary =
  | 'contract_pricing'
  | 'invoice'
  | 'transaction'
  | 'contract_invoice_reconciliation'
  | 'invoice_transaction_reconciliation'
  | 'cross_document_rate_verification'
  | 'findings'
  | 'exposure';

export type CanonicalShadowComparisonInput = {
  readonly boundary: CanonicalShadowComparisonBoundary;
  /** Stable ids or typed semantic fingerprints; never formatted display text. */
  readonly currentSemanticKeys: readonly string[];
  readonly canonicalSemanticKeys: readonly string[];
  readonly currentSourceAvailable: boolean;
  readonly canonicalRepresentable: boolean;
  readonly richerTyping: boolean;
  readonly requiresReview: boolean;
  readonly conflictingCurrentTruthPath: boolean;
  readonly notes?: readonly string[];
};

export type CanonicalShadowComparison = {
  readonly boundary: CanonicalShadowComparisonBoundary;
  readonly classification: CanonicalShadowParityClassification;
  readonly currentCount: number;
  readonly canonicalCount: number;
  readonly missingCanonicalKeys: readonly string[];
  readonly additionalCanonicalKeys: readonly string[];
  readonly notes: readonly string[];
};

function orderedUnique(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right, 'en-US'));
}

export function compareCanonicalShadowBoundary(
  input: CanonicalShadowComparisonInput,
): CanonicalShadowComparison {
  const current = orderedUnique(input.currentSemanticKeys);
  const canonical = orderedUnique(input.canonicalSemanticKeys);
  const canonicalSet = new Set(canonical);
  const currentSet = new Set(current);
  const missingCanonicalKeys = current.filter((key) => !canonicalSet.has(key));
  const additionalCanonicalKeys = canonical.filter((key) => !currentSet.has(key));

  let classification: CanonicalShadowParityClassification;
  if (!input.currentSourceAvailable) classification = 'current_source_unavailable';
  else if (input.conflictingCurrentTruthPath) classification = 'conflicting_current_truth_path';
  else if (!input.canonicalRepresentable || missingCanonicalKeys.length > 0) classification = 'not_yet_representable';
  else if (input.requiresReview) classification = 'represented_but_requires_review';
  else if (input.richerTyping || additionalCanonicalKeys.length > 0) classification = 'represented_with_richer_typing';
  else classification = 'exact_semantic_parity';

  return {
    boundary: input.boundary,
    classification,
    currentCount: current.length,
    canonicalCount: canonical.length,
    missingCanonicalKeys,
    additionalCanonicalKeys,
    notes: [...(input.notes ?? [])],
  };
}

export function buildCanonicalProjectTruthShadowComparison(
  inputs: readonly CanonicalShadowComparisonInput[],
): readonly CanonicalShadowComparison[] {
  return inputs
    .map(compareCanonicalShadowBoundary)
    .sort((left, right) => left.boundary.localeCompare(right.boundary, 'en-US'));
}
