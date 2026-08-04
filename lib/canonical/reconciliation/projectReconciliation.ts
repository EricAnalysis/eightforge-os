import type { CanonicalEvidenceRef } from '@/lib/canonical/truth/envelope';

export type CanonicalContractInvoiceReconciliation = {
  readonly reconciliationId: string;
  readonly invoiceId: string;
  readonly invoiceLineIds: readonly string[];
  readonly pricingMatchIds: readonly string[];
  readonly facts: {
    readonly billedAmount: number | null;
    readonly contractSupportedAmount: number | null;
    readonly amountVariance: number | null;
    readonly governingPricingStatus: string;
    readonly supportCompleteness: number | null;
  };
  readonly conclusion: {
    readonly state: 'reconciled' | 'variance' | 'partial' | 'missing' | 'requires_review';
    readonly reasons: readonly string[];
  };
  readonly evidence: readonly CanonicalEvidenceRef[];
  readonly sourceStatus: string;
};

export type CanonicalProjectReconciliation = {
  readonly reconciliationId: string;
  readonly projectId: string;
  readonly contractInvoiceReconciliationIds: readonly string[];
  readonly invoiceTransactionReconciliationIds: readonly string[];
  readonly facts: {
    readonly totalBilledAmount: number | null;
    readonly totalContractSupportedAmount: number | null;
    readonly totalTransactionSupportedAmount: number | null;
    readonly totalAtRiskAmount: number | null;
    readonly matchedBillingGroups: number;
    readonly unmatchedBillingGroups: number;
    readonly rateMismatches: number;
    readonly quantityMismatches: number;
    readonly orphanInvoiceLines: number;
    readonly orphanTransactions: number;
  };
  readonly conclusion: {
    readonly state: 'reconciled' | 'partial' | 'mismatch' | 'missing' | 'requires_review';
    readonly reasons: readonly string[];
  };
  readonly evidence: readonly CanonicalEvidenceRef[];
  readonly sourceStatus: string;
};
