import type { CanonicalIdentityKind } from '@/lib/canonical/invoice/invoice';
import type {
  CanonicalEvidenceRef,
  CanonicalReviewStatus,
  TruthEnvelope,
} from '@/lib/canonical/truth/envelope';

export type CanonicalTransactionSupportState = 'eligible' | 'ineligible' | 'unknown';

export type CanonicalTransaction = {
  readonly transactionId: string;
  readonly identityKind: CanonicalIdentityKind;
  readonly identityWarning: string | null;
  readonly transactionNumber: TruthEnvelope<string>;
  readonly invoiceNumber?: TruthEnvelope<string>;
  readonly occurredAt: TruthEnvelope<string>;
  readonly material?: TruthEnvelope<string>;
  readonly quantity: TruthEnvelope<number>;
  readonly unit?: TruthEnvelope<string>;
  readonly rateCode?: TruthEnvelope<string>;
  readonly appliedRate: TruthEnvelope<number>;
  readonly extendedCost: TruthEnvelope<number>;
  readonly originSite?: TruthEnvelope<string>;
  readonly destinationSite?: TruthEnvelope<string>;
  readonly route?: TruthEnvelope<string>;
  readonly distanceBand?: TruthEnvelope<string>;
  readonly loadIdentity?: TruthEnvelope<string>;
  readonly sourceWorkbook: string | null;
  readonly sourceDocumentId: string | null;
  readonly sourceSheet: string | null;
  readonly sourceRow: number | null;
  readonly rawRowEvidence: Readonly<Record<string, unknown>>;
  readonly evidence: readonly CanonicalEvidenceRef[];
  readonly supportState: CanonicalTransactionSupportState;
  readonly eligibilityRaw: string | null;
  readonly reviewState: CanonicalReviewStatus;
  readonly absentFields: readonly string[];
  readonly unresolvedFields: readonly string[];
  readonly matchingKeys: {
    readonly billingRateKey: string | null;
    readonly descriptionMatchKey: string | null;
    readonly siteMaterialKey: string | null;
    readonly invoiceRateKey: string | null;
  };
};
