import type { CanonicalContractPricingRow } from '@/lib/canonical/contract/pricing';
import type { CanonicalInvoiceLine } from '@/lib/canonical/invoice/invoiceLine';
import type { CanonicalTransaction } from '@/lib/canonical/transaction/transaction';
import type { CanonicalEvidenceRef } from '@/lib/canonical/truth/envelope';
import type { ValidationApprovalGateEffect } from '@/types/validator';

export type CanonicalPricingMatchStatus =
  | 'matched'
  | 'unmatched'
  | 'ambiguous'
  | 'rate_mismatch'
  | 'unit_mismatch'
  | 'applicability_unresolved'
  | 'governing_rate_requires_review'
  | 'insufficient_evidence';

export type CanonicalGoverningSelectionStatus =
  | 'none'
  | 'candidate_only'
  | 'selected'
  | 'ambiguous'
  | 'selected_requires_review'
  | 'rejected';

export type CanonicalPricingMatchingKeys = {
  readonly keysUsed: readonly string[];
  readonly normalizedDescriptionKey: string | null;
  readonly descriptionSimilarity: number | null;
  readonly rateCodeMatch: boolean | null;
  readonly categoryMatch: boolean | null;
  readonly unitMatch: boolean | null;
  readonly originDestinationMatch: boolean | null;
  readonly distanceBandMatch: boolean | null;
  readonly materialMatch: boolean | null;
};

export type CanonicalPricingMatch = {
  readonly matchId: string;
  readonly invoiceLineId: string;
  readonly transactionIds: readonly string[];
  readonly status: CanonicalPricingMatchStatus;
  readonly candidatePricingRowIds: readonly string[];
  readonly selectedPricingRowId: string | null;
  readonly governingSelection: {
    readonly candidatePresent: boolean;
    readonly candidateCount: number;
    readonly selectedGoverningRowId: string | null;
    readonly selectionStatus: CanonicalGoverningSelectionStatus;
    readonly selectedRowApprovalEligible: boolean;
    readonly expectedRateAvailable: boolean;
    readonly unresolvedReason: string | null;
  };
  readonly matching: CanonicalPricingMatchingKeys;
  readonly expectedRate: number | null;
  readonly billedRate: number | null;
  readonly variance: number | null;
  readonly affectedAmount: number | null;
  readonly evidence: readonly CanonicalEvidenceRef[];
  readonly unresolvedReasons: readonly string[];
  readonly approvalImpact: ValidationApprovalGateEffect | null;
  readonly sourceMatcher: string;
  readonly sourceMatchStatus: string;
};

export type CanonicalPricingMatchRepresentationInput = {
  readonly matchId: string;
  readonly invoiceLine: CanonicalInvoiceLine;
  readonly candidatePricingRows: readonly CanonicalContractPricingRow[];
  readonly selectedPricingRow: CanonicalContractPricingRow | null;
  readonly transactions: readonly CanonicalTransaction[];
  readonly status: CanonicalPricingMatchStatus;
  readonly matching: CanonicalPricingMatchingKeys;
  readonly expectedRate: number | null;
  readonly variance: number | null;
  readonly affectedAmount: number | null;
  readonly evidence: readonly CanonicalEvidenceRef[];
  readonly unresolvedReasons: readonly string[];
  readonly approvalImpact: ValidationApprovalGateEffect | null;
  readonly sourceMatcher: string;
  readonly sourceMatchStatus: string;
  readonly selectionStatus?: CanonicalGoverningSelectionStatus;
  readonly selectionUnresolvedReason?: string | null;
};

/** Pure shadow projection. It represents a match already made elsewhere. */
export function representCanonicalPricingMatch(
  input: CanonicalPricingMatchRepresentationInput,
): CanonicalPricingMatch {
  const selectedApprovalEligible = input.selectedPricingRow?.resolution.approval.eligible === true;
  const selectionStatus = input.selectionStatus
    ?? (input.selectedPricingRow
      ? selectedApprovalEligible ? 'selected' : 'selected_requires_review'
      : input.candidatePricingRows.length === 0
        ? 'none'
        : input.status === 'ambiguous' ? 'ambiguous' : 'candidate_only');
  return {
    matchId: input.matchId,
    invoiceLineId: input.invoiceLine.lineId,
    transactionIds: input.transactions.map((row) => row.transactionId).sort(),
    status: input.status,
    candidatePricingRowIds: input.candidatePricingRows.map((row) => row.rowId).sort(),
    selectedPricingRowId: input.selectedPricingRow?.rowId ?? null,
    governingSelection: {
      candidatePresent: input.candidatePricingRows.length > 0,
      candidateCount: input.candidatePricingRows.length,
      selectedGoverningRowId: input.selectedPricingRow?.rowId ?? null,
      selectionStatus,
      selectedRowApprovalEligible: selectedApprovalEligible,
      expectedRateAvailable: input.expectedRate != null && selectedApprovalEligible,
      unresolvedReason: input.selectionUnresolvedReason
        ?? input.unresolvedReasons[0]
        ?? null,
    },
    matching: input.matching,
    expectedRate: input.expectedRate,
    billedRate: input.invoiceLine.billedRate.value,
    variance: input.variance,
    affectedAmount: input.affectedAmount,
    evidence: input.evidence,
    unresolvedReasons: [...input.unresolvedReasons],
    approvalImpact: input.approvalImpact,
    sourceMatcher: input.sourceMatcher,
    sourceMatchStatus: input.sourceMatchStatus,
  };
}
