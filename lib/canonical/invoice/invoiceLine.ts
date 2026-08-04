import type { CanonicalIdentityKind } from '@/lib/canonical/invoice/invoice';
import type {
  CanonicalEvidenceRef,
  CanonicalReviewStatus,
  TruthEnvelope,
} from '@/lib/canonical/truth/envelope';

export type CanonicalInvoiceLine = {
  readonly lineId: string;
  readonly identityKind: CanonicalIdentityKind;
  readonly identityWarning: string | null;
  readonly invoiceId: string;
  readonly sourceLineIdentifier: string | null;
  readonly description: TruthEnvelope<string>;
  readonly normalizedDescription?: TruthEnvelope<string>;
  readonly category?: TruthEnvelope<string>;
  readonly rateCode?: TruthEnvelope<string>;
  readonly quantity: TruthEnvelope<number>;
  readonly unit?: TruthEnvelope<string>;
  readonly billedRate: TruthEnvelope<number>;
  readonly extendedAmount: TruthEnvelope<number>;
  readonly materialType?: TruthEnvelope<string>;
  readonly origin?: TruthEnvelope<string>;
  readonly destination?: TruthEnvelope<string>;
  readonly route?: TruthEnvelope<string>;
  readonly distanceBand?: TruthEnvelope<string>;
  readonly sourceRow: number | null;
  readonly sourceSheet: string | null;
  readonly sourcePage: number | null;
  readonly evidence: readonly CanonicalEvidenceRef[];
  readonly absentFields: readonly string[];
  readonly unresolvedFields: readonly string[];
  readonly reviewState: CanonicalReviewStatus;
  /** Existing billing keys are preserved as match inputs, not re-derived here. */
  readonly matchingKeys: {
    readonly billingRateKey: string | null;
    readonly descriptionMatchKey: string | null;
    readonly siteMaterialKey: string | null;
    readonly invoiceRateKey: string | null;
  };
};
