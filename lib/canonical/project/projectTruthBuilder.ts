import type { CanonicalProjectTruth } from '@/lib/canonical/project/projectTruth';

export type CanonicalProjectTruthInput = Omit<CanonicalProjectTruth, 'construction'> & {
  readonly sourceSnapshotId?: string | null;
  /**
   * Defaults to `shadow_only`. Callers promoting the registry to governing
   * truth for one execution must opt in explicitly, so a diagnostic assembly
   * can never be mistaken for an authoritative one.
   */
  readonly mode?: CanonicalProjectTruth['construction']['mode'];
};

function byId<T>(getId: (value: T) => string): (left: T, right: T) => number {
  return (left, right) => getId(left).localeCompare(getId(right), 'en-US');
}

/** Deterministic, pure, in-memory assembly. No persistence and no reader cutover. */
export function buildCanonicalProjectTruth(input: CanonicalProjectTruthInput): CanonicalProjectTruth {
  return {
    projectId: input.projectId,
    governingDocuments: [...input.governingDocuments].sort(byId((value) => `${value.documentId}:${value.relationship}`)),
    contractTermReferences: [...input.contractTermReferences].sort(),
    contractPricing: [...input.contractPricing].sort(byId((value) => value.scheduleId ?? '')),
    invoices: [...input.invoices].sort(byId((value) => value.invoiceId)),
    invoiceLines: [...input.invoiceLines].sort(byId((value) => value.lineId)),
    transactions: [...input.transactions].sort(byId((value) => value.transactionId)),
    derived: {
      pricingMatches: [...input.derived.pricingMatches].sort(byId((value) => value.matchId)),
      contractInvoiceReconciliations: [...input.derived.contractInvoiceReconciliations]
        .sort(byId((value) => value.reconciliationId)),
      invoiceTransactionReconciliations: [...input.derived.invoiceTransactionReconciliations]
        .sort(byId((value) => value.reconciliationId)),
      projectReconciliation: input.derived.projectReconciliation,
      validationImpacts: [...input.derived.validationImpacts].sort(byId((value) => value.impactId)),
      exposureReadinessReferences: [...input.derived.exposureReadinessReferences]
        .sort(byId((value) => value.referenceId)),
    },
    construction: {
      mode: input.mode ?? 'shadow_only',
      persisted: false,
      sourceSnapshotId: input.sourceSnapshotId ?? null,
    },
  };
}
