import type { CanonicalEvidenceRef } from '@/lib/canonical/truth/envelope';

export type CanonicalInvoiceTransactionState =
  | 'reconciled'
  | 'variance'
  | 'partial_support'
  | 'missing_support'
  | 'requires_review';

export type CanonicalInvoiceTransactionFacts = {
  readonly invoiceBilledQuantity: number | null;
  readonly transactionSupportedQuantity: number | null;
  readonly quantityVariance: number | null;
  readonly invoiceBilledAmount: number | null;
  readonly transactionExtendedCost: number | null;
  readonly amountVariance: number | null;
  readonly supportCompleteness: number | null;
};

export type CanonicalInvoiceTransactionReconciliation = {
  readonly reconciliationId: string;
  readonly invoiceId: string;
  readonly invoiceLineIds: readonly string[];
  readonly transactionIds: readonly string[];
  readonly facts: CanonicalInvoiceTransactionFacts;
  readonly conclusion: {
    readonly state: CanonicalInvoiceTransactionState;
    readonly reasons: readonly string[];
  };
  readonly evidence: readonly CanonicalEvidenceRef[];
  readonly sourceStatus: string;
};
