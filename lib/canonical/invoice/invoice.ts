import type {
  CanonicalEvidenceRef,
  CanonicalReviewStatus,
  TruthEnvelope,
} from '@/lib/canonical/truth/envelope';

export type CanonicalIdentityKind = 'source' | 'deterministic_fallback';

export type CanonicalBillingPeriod = {
  readonly start: string | null;
  readonly end: string | null;
  readonly through: string | null;
};

/**
 * Shadow-only invoice truth. Core fields always carry an envelope; conditional
 * fields are sparse and are omitted when the source does not expose them.
 */
export type CanonicalInvoice = {
  readonly invoiceId: string;
  readonly identityKind: CanonicalIdentityKind;
  readonly identityWarning: string | null;
  readonly invoiceNumber: TruthEnvelope<string>;
  readonly governingProjectId: TruthEnvelope<string>;
  readonly contractorVendor: TruthEnvelope<string>;
  readonly billingPeriod: TruthEnvelope<CanonicalBillingPeriod>;
  readonly invoiceDate: TruthEnvelope<string>;
  readonly billedTotal: TruthEnvelope<number>;
  readonly supportedTotal?: TruthEnvelope<number>;
  readonly atRiskTotal?: TruthEnvelope<number>;
  readonly governingContractReferences: readonly string[];
  readonly governingTaskOrderReferences: readonly string[];
  readonly sourceDocumentId: string | null;
  readonly evidence: readonly CanonicalEvidenceRef[];
  readonly reviewState: CanonicalReviewStatus;
  readonly absentFields: readonly string[];
  readonly unresolvedFields: readonly string[];
};
