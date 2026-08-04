import { buildCanonicalProjectTruthShadowComparison, type CanonicalShadowComparisonInput } from '@/lib/canonical/parity/shadowComparison';
import type { ProjectTruthParityReport } from './projectTruthPublication';
import type { ProjectTruthPublicationSource } from './projectTruthPublicationSource';
import type { AdaptedProjectTruthPublication } from './projectTruthShadowAdapter';

function ids(values: readonly (string | null | undefined)[]): readonly string[] {
  return values.filter((value): value is string => typeof value === 'string' && value.length > 0);
}

function amountDelta(current: number | null, canonical: number | null) {
  return { current, canonical, delta: current != null && canonical != null ? canonical - current : null };
}

/** Pure comparison of retained production outputs to their canonical projection. */
export function buildProjectTruthParityReport(input: {
  readonly source: ProjectTruthPublicationSource;
  readonly adapted: AdaptedProjectTruthPublication;
}): ProjectTruthParityReport {
  const registry = input.adapted.registryWithoutTransactions;
  const result = input.source.effectiveResult;
  const crossDocument = result.cross_document_rate_verification ?? result.summary.cross_document_rate_verification;
  const contractInvoice = result.contract_invoice_reconciliation ?? result.summary.contract_invoice_reconciliation;
  const invoiceTransaction = result.invoice_transaction_reconciliation ?? result.summary.invoice_transaction_reconciliation;
  const exposure = result.exposure ?? result.summary.exposure;
  const comparisons: CanonicalShadowComparisonInput[] = [
    {
      boundary: 'contract_pricing',
      currentSemanticKeys: input.source.assembledContractPricingRows.map((row) => row.id),
      canonicalSemanticKeys: registry.contractPricing.flatMap((schedule) => schedule.rows.map((row) => row.rowId)),
      currentSourceAvailable: true, canonicalRepresentable: true,
      richerTyping: true,
      requiresReview: registry.contractPricing.some((schedule) => schedule.coverage.needsReviewCount > 0),
      conflictingCurrentTruthPath: false,
    },
    {
      boundary: 'invoice',
      currentSemanticKeys: ids(input.source.invoices.map((row) => typeof row.id === 'string' ? row.id : null)),
      canonicalSemanticKeys: registry.invoices.map((invoice) => invoice.invoiceId),
      currentSourceAvailable: true, canonicalRepresentable: true, richerTyping: true,
      requiresReview: registry.invoices.some((invoice) => invoice.reviewState !== 'none'), conflictingCurrentTruthPath: false,
    },
    {
      boundary: 'transaction',
      currentSemanticKeys: ids((input.source.transactionData?.rows ?? []).map((row) => row.id)),
      canonicalSemanticKeys: ids((input.source.transactionData?.rows ?? []).map((row) => row.id)),
      currentSourceAvailable: input.source.transactionData != null, canonicalRepresentable: true, richerTyping: true,
      requiresReview: false, conflictingCurrentTruthPath: false,
    },
    {
      boundary: 'contract_invoice_reconciliation',
      currentSemanticKeys: contractInvoice ? registry.invoices.map((invoice) => invoice.invoiceId) : [],
      canonicalSemanticKeys: registry.derived.contractInvoiceReconciliations.map((row) => row.invoiceId),
      currentSourceAvailable: contractInvoice != null, canonicalRepresentable: contractInvoice != null, richerTyping: true,
      requiresReview: registry.derived.contractInvoiceReconciliations.some((row) => row.conclusion.state === 'requires_review'),
      conflictingCurrentTruthPath: false,
    },
    {
      boundary: 'invoice_transaction_reconciliation',
      currentSemanticKeys: invoiceTransaction ? registry.invoices.map((invoice) => invoice.invoiceId) : [],
      canonicalSemanticKeys: registry.derived.invoiceTransactionReconciliations.map((row) => row.invoiceId),
      currentSourceAvailable: invoiceTransaction != null, canonicalRepresentable: invoiceTransaction != null, richerTyping: true,
      requiresReview: registry.derived.invoiceTransactionReconciliations.some((row) => row.conclusion.state === 'requires_review'),
      conflictingCurrentTruthPath: false,
    },
    {
      boundary: 'cross_document_rate_verification',
      currentSemanticKeys: crossDocument?.validation_units.map((unit) => unit.validation_unit_id) ?? [],
      canonicalSemanticKeys: registry.derived.pricingMatches.map((match) => match.matchId),
      currentSourceAvailable: crossDocument != null, canonicalRepresentable: crossDocument != null, richerTyping: true,
      requiresReview: registry.derived.pricingMatches.some((match) => match.status !== 'matched'), conflictingCurrentTruthPath: false,
    },
    {
      boundary: 'findings',
      currentSemanticKeys: input.source.persistedFindings.map((finding) => finding.id),
      canonicalSemanticKeys: registry.derived.validationImpacts.map((impact) => impact.findingId),
      currentSourceAvailable: true, canonicalRepresentable: true, richerTyping: true,
      requiresReview: input.source.persistedFindings.some((finding) => finding.status === 'open'), conflictingCurrentTruthPath: false,
    },
    {
      boundary: 'exposure',
      currentSemanticKeys: exposure ? ['total-billed', 'contract-supported', 'transaction-supported', 'at-risk', 'requires-verification'].map((key) => `exposure:${key}`) : [],
      canonicalSemanticKeys: registry.derived.exposureReadinessReferences.map((reference) => reference.referenceId),
      currentSourceAvailable: exposure != null, canonicalRepresentable: exposure != null, richerTyping: true,
      requiresReview: exposure != null && exposure.total_at_risk_amount > 0, conflictingCurrentTruthPath: false,
    },
  ];
  const canonicalAmounts = new Map(registry.derived.exposureReadinessReferences.map((reference) => [reference.referenceId, reference.amount]));
  return {
    comparisons: buildCanonicalProjectTruthShadowComparison(comparisons),
    amountDeltas: {
      totalBilled: amountDelta(exposure?.total_billed_amount ?? null, canonicalAmounts.get('exposure:total-billed') ?? null),
      contractSupported: amountDelta(exposure?.total_contract_supported_amount ?? null, canonicalAmounts.get('exposure:contract-supported') ?? null),
      transactionSupported: amountDelta(exposure?.total_transaction_supported_amount ?? null, canonicalAmounts.get('exposure:transaction-supported') ?? null),
      atRisk: amountDelta(exposure?.total_at_risk_amount ?? null, canonicalAmounts.get('exposure:at-risk') ?? null),
      requiresVerification: amountDelta(exposure?.total_requires_verification_amount ?? null, canonicalAmounts.get('exposure:requires-verification') ?? null),
    },
    // Dataset quantities remain ticket-grain source facts. The publisher never
    // derives them by summing transaction rows.
    quantityDeltas: Object.fromEntries([...(input.source.transactionData?.datasets ?? [])]
      .sort((left, right) => left.id.localeCompare(right.id, 'en-US'))
      .map((dataset) => [dataset.id, amountDelta(dataset.total_transaction_quantity, null)])),
  };
}
