import type { CanonicalContractPricingSchedule } from '@/lib/canonical/contract/pricing';
import type { CanonicalInvoice } from '@/lib/canonical/invoice/invoice';
import type { CanonicalInvoiceLine } from '@/lib/canonical/invoice/invoiceLine';
import type { CanonicalInvoiceTransactionReconciliation } from '@/lib/canonical/reconciliation/invoiceTransaction';
import type { CanonicalPricingMatch } from '@/lib/canonical/reconciliation/pricingMatch';
import type {
  CanonicalContractInvoiceReconciliation,
  CanonicalProjectReconciliation,
} from '@/lib/canonical/reconciliation/projectReconciliation';
import type { CanonicalTransaction } from '@/lib/canonical/transaction/transaction';
import type { CanonicalEvidenceRef } from '@/lib/canonical/truth/envelope';
import type { CanonicalValidationFactImpact } from '@/lib/canonical/validation/factImpact';

export type CanonicalGoverningDocumentReference = {
  readonly documentId: string;
  readonly family: string | null;
  readonly relationship: 'governs' | 'attached_to' | 'supplements' | 'modifies' | 'replaces' | 'supports';
  readonly effectiveAt: string | null;
  readonly evidence: readonly CanonicalEvidenceRef[];
};

export type CanonicalExposureReference = {
  readonly referenceId: string;
  readonly sourceKind: 'validator_summary' | 'exposure_summary' | 'readiness_summary';
  readonly amount: number | null;
  readonly state: string | null;
  readonly evidence: readonly CanonicalEvidenceRef[];
};

/** In-memory registry only. Derived sections never become independent sources. */
export type CanonicalProjectTruth = {
  readonly projectId: string;
  readonly governingDocuments: readonly CanonicalGoverningDocumentReference[];
  readonly contractTermReferences: readonly string[];
  readonly contractPricing: readonly CanonicalContractPricingSchedule[];
  readonly invoices: readonly CanonicalInvoice[];
  readonly invoiceLines: readonly CanonicalInvoiceLine[];
  readonly transactions: readonly CanonicalTransaction[];
  readonly derived: {
    readonly pricingMatches: readonly CanonicalPricingMatch[];
    readonly contractInvoiceReconciliations: readonly CanonicalContractInvoiceReconciliation[];
    readonly invoiceTransactionReconciliations: readonly CanonicalInvoiceTransactionReconciliation[];
    readonly projectReconciliation: CanonicalProjectReconciliation | null;
    readonly validationImpacts: readonly CanonicalValidationFactImpact[];
    readonly exposureReadinessReferences: readonly CanonicalExposureReference[];
  };
  readonly construction: {
    readonly mode: 'shadow_only';
    readonly persisted: false;
    readonly sourceSnapshotId: string | null;
  };
};
