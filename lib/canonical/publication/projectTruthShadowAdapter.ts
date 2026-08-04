import { adaptAssembledPricingRows } from '@/lib/canonical/contract/pricingAdapter';
import { buildCanonicalPricingSchedule, resolveCanonicalPricingRow } from '@/lib/canonical/contract/pricingResolution';
import { adaptCurrentInvoiceRows } from '@/lib/canonical/invoice/invoiceAdapter';
import type { CanonicalInvoice } from '@/lib/canonical/invoice/invoice';
import type { CanonicalInvoiceLine } from '@/lib/canonical/invoice/invoiceLine';
import type { CanonicalShadowComparisonBoundary } from '@/lib/canonical/parity/shadowComparison';
import type { CanonicalExposureReference, CanonicalProjectTruth, CanonicalGoverningDocumentReference } from '@/lib/canonical/project/projectTruth';
import { buildCanonicalProjectTruth } from '@/lib/canonical/project/projectTruthBuilder';
import type { CanonicalInvoiceTransactionReconciliation, CanonicalInvoiceTransactionState } from '@/lib/canonical/reconciliation/invoiceTransaction';
import type { CanonicalPricingMatch, CanonicalPricingMatchStatus } from '@/lib/canonical/reconciliation/pricingMatch';
import { representCanonicalPricingMatch } from '@/lib/canonical/reconciliation/pricingMatch';
import type { CanonicalContractInvoiceReconciliation, CanonicalProjectReconciliation } from '@/lib/canonical/reconciliation/projectReconciliation';
import { canonicalEvidenceRef } from '@/lib/canonical/truth/envelope';
import { mapValidationFindingToCanonicalFacts } from '@/lib/canonical/validation/factImpact';
import type { CrossDocumentRateComparisonStatus, ProjectExposureSummary, ValidatorResult } from '@/types/validator';
import type {
  CanonicalProjectTruthCore,
  ProjectTruthPublicationGap,
  ProjectTruthPublicationSourceDocument,
  SourceArtifactSnapshotEntry,
} from './projectTruthPublication';
import { hashCanonicalJson } from './projectTruthPublicationIdentity';
import type { ProjectTruthPublicationSource } from './projectTruthPublicationSource';
import { adaptCanonicalTransactionRow, prepareCanonicalTransactionStream, type PreparedCanonicalTransactionStream } from './projectTruthTransactionStream';

export type AdaptedProjectTruthPublication = {
  readonly registryWithoutTransactions: CanonicalProjectTruth;
  readonly core: CanonicalProjectTruthCore;
  readonly transactionPlan: PreparedCanonicalTransactionStream;
  readonly sourceDocuments: readonly ProjectTruthPublicationSourceDocument[];
  readonly sourceSnapshotId: string;
  readonly gaps: readonly ProjectTruthPublicationGap[];
  readonly inputCounts: Readonly<Record<string, number>>;
  readonly outputCounts: Readonly<Record<string, number>>;
};

function stringValue(record: Readonly<Record<string, unknown>>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function stableGap(input: Omit<ProjectTruthPublicationGap, 'gapKey' | 'silent'>): ProjectTruthPublicationGap {
  return {
    ...input,
    gapKey: `gap:${hashCanonicalJson({
      boundary: input.boundary,
      reason: input.reason,
      sourceIdentity: input.sourceIdentity,
      detail: input.detail,
      sourceCoordinates: input.sourceCoordinates,
    })}`,
    silent: false,
  };
}

export function publicationAvailabilityGap(input: {
  readonly rulesApplied: readonly string[];
  readonly boundary: CanonicalShadowComparisonBoundary;
  readonly packId: string;
  readonly detail: string;
}): ProjectTruthPublicationGap {
  const failed = input.rulesApplied.includes(`${input.packId}:failed`);
  const executed = input.rulesApplied.includes(input.packId);
  return stableGap({
    boundary: input.boundary,
    reason: failed ? 'pack_failed' : executed ? 'source_unavailable' : 'pack_not_executed',
    sourceIdentity: input.packId,
    rejectingFunction: 'adaptProjectTruthPublicationSource',
    detail: failed
      ? `${input.detail}; ${input.packId} failed`
      : executed
        ? `${input.detail}; ${input.packId} executed without a usable summary`
        : `${input.detail}; ${input.packId} was not executed`,
    rawValues: {},
    sourceCoordinates: {},
    evidenceSurvivesElsewhere: false,
    canonicalRecoveryPossible: true,
  });
}

function familyAndGoverning(
  documentId: string,
  governing: Readonly<Record<string, readonly string[]>>,
): { family: string | null; isGoverning: boolean } {
  const families = Object.entries(governing)
    .filter(([, ids]) => ids.includes(documentId))
    .map(([family]) => family)
    .sort((left, right) => left.localeCompare(right, 'en-US'));
  return { family: families[0] ?? null, isGoverning: families.length > 0 };
}

export function bindPublicationSourceDocuments(input: {
  readonly snapshot: readonly SourceArtifactSnapshotEntry[];
  readonly governingDocumentIds: Readonly<Record<string, readonly string[]>>;
}): { readonly documents: readonly ProjectTruthPublicationSourceDocument[]; readonly gaps: readonly ProjectTruthPublicationGap[]; readonly sourceSnapshotId: string } {
  const documents = [...input.snapshot]
    .sort((left, right) => left.documentId.localeCompare(right.documentId, 'en-US'))
    .map((entry) => ({ ...entry, ...familyAndGoverning(entry.documentId, input.governingDocumentIds) }));
  const gaps = documents.flatMap((entry) => {
    if (
      entry.sourceArtifactId
      && entry.sourceSha256
      && entry.storageObjectVersion
      && entry.exactSourceIdentity
    ) return [];
    const missing = [
      !entry.sourceArtifactId ? 'sourceArtifactId' : null,
      !entry.sourceSha256 ? 'sourceSha256' : null,
      !entry.storageObjectVersion ? 'storageObjectVersion' : null,
    ].filter((value): value is string => value != null);
    return [stableGap({
      boundary: 'manifest',
      reason: 'source_unavailable',
      sourceIdentity: `document:${entry.documentId}`,
      rejectingFunction: 'bindPublicationSourceDocuments',
      missingFields: missing,
      detail: `Exact source identity unavailable: ${missing.join(',')}`,
      rawValues: {
        sourceArtifactId: entry.sourceArtifactId,
        sourceSha256: entry.sourceSha256,
        storageObjectVersion: entry.storageObjectVersion,
        exactSourceIdentity: entry.exactSourceIdentity,
      },
      sourceCoordinates: { documentId: entry.documentId, storagePath: entry.storagePath },
      evidenceSurvivesElsewhere: entry.sourceArtifactId != null,
      canonicalRecoveryPossible: false,
    })];
  });
  return { documents, gaps, sourceSnapshotId: hashCanonicalJson(documents) };
}

function governingDocumentReferences(source: ProjectTruthPublicationSource): readonly CanonicalGoverningDocumentReference[] {
  const byId = new Map(source.documents.map((document) => [document.id, document]));
  return Object.entries(source.governingDocumentIds)
    .flatMap(([family, ids]) => ids.map((documentId) => ({ family, documentId })))
    .sort((left, right) => `${left.documentId}:${left.family}`.localeCompare(`${right.documentId}:${right.family}`, 'en-US'))
    .map(({ family, documentId }) => ({
      documentId,
      family,
      relationship: 'governs' as const,
      // processed_at is not a legal effective date and must not be promoted.
      effectiveAt: null,
      evidence: [canonicalEvidenceRef({ documentId, sourceAnchor: byId.get(documentId)?.id ?? documentId })],
    }));
}

function adaptInvoices(source: ProjectTruthPublicationSource): {
  invoices: readonly CanonicalInvoice[];
  lines: readonly CanonicalInvoiceLine[];
  gaps: readonly ProjectTruthPublicationGap[];
} {
  const invoices: CanonicalInvoice[] = [];
  const lines: CanonicalInvoiceLine[] = [];
  const lineOwners = new Map<Readonly<Record<string, unknown>>, number>();
  const ambiguousLines = new Set<Readonly<Record<string, unknown>>>();
  source.invoiceLines.forEach((line) => {
    const candidates = source.invoices
      .map((invoiceRow, index) => ({ invoiceRow, index }))
      .filter(({ invoiceRow }) => {
        const invoiceId = stringValue(invoiceRow, 'id');
        const invoiceNumber = stringValue(invoiceRow, 'invoice_number');
        return (invoiceId != null && stringValue(line, 'invoice_id') === invoiceId)
          || (invoiceNumber != null && stringValue(line, 'invoice_number') === invoiceNumber);
      });
    if (candidates.length === 1) lineOwners.set(line, candidates[0]!.index);
    else if (candidates.length > 1) ambiguousLines.add(line);
  });
  const governingReferences = Object.values(source.governingDocumentIds).flat();
  source.invoices.forEach((invoiceRow, invoiceIndex) => {
    const invoiceDocumentId = stringValue(invoiceRow, 'source_document_id') ?? stringValue(invoiceRow, 'document_id');
    const matchingLines = source.invoiceLines.filter((line) => lineOwners.get(line) === invoiceIndex);
    const adapted = adaptCurrentInvoiceRows({
      invoiceRow,
      invoiceLines: matchingLines,
      context: {
        projectId: source.project.id,
        documentId: invoiceDocumentId,
        governingContractReferences: governingReferences,
      },
    });
    invoices.push(adapted.invoice);
    lines.push(...adapted.lines);
  });
  const gaps = source.invoiceLines
    .filter((line) => !lineOwners.has(line))
    .map((line, ordinal) => stableGap({
      boundary: 'invoice', reason: 'unresolved_mapping',
      sourceIdentity: stringValue(line, 'id') ?? `invoice-line-ordinal:${ordinal}`,
      rejectingFunction: 'adaptInvoices',
      detail: ambiguousLines.has(line)
        ? 'Invoice line ownership is ambiguous across retained invoices'
        : 'Invoice line cannot be associated with a retained invoice',
      rawValues: {}, sourceCoordinates: { sourceRow: line.source_row_number ?? null },
      evidenceSurvivesElsewhere: true, canonicalRecoveryPossible: true,
    }));
  return { invoices, lines, gaps };
}

function pricingStatus(status: CrossDocumentRateComparisonStatus): CanonicalPricingMatchStatus {
  if (status === 'match') return 'matched';
  if (status === 'rate_mismatch') return 'rate_mismatch';
  if (status === 'needs_review') return 'governing_rate_requires_review';
  if (status === 'missing_contract_rate') return 'unmatched';
  return 'insufficient_evidence';
}

export function projectSourceBackedPricingMatches(input: {
  readonly result: ValidatorResult;
  readonly invoiceLines: readonly CanonicalInvoiceLine[];
  readonly pricingRows: CanonicalProjectTruth['contractPricing'][number]['rows'];
  readonly invoiceLineToRateMap: ProjectTruthPublicationSource['invoiceLineToRateMap'];
  readonly transactionRows: NonNullable<ProjectTruthPublicationSource['transactionData']>['rows'];
  readonly sourceArtifacts: readonly SourceArtifactSnapshotEntry[];
}): { readonly values: readonly CanonicalPricingMatch[]; readonly gaps: readonly ProjectTruthPublicationGap[] } {
  const units = input.result.cross_document_rate_verification?.validation_units
    ?? input.result.summary.cross_document_rate_verification?.validation_units;
  if (!units) return { values: [], gaps: [publicationAvailabilityGap({
    rulesApplied: input.result.rulesApplied,
    boundary: 'cross_document_rate_verification',
    packId: 'cross_document_rate_verification',
    detail: 'Cross-document rate verification is unavailable',
  })] };
  const lineById = new Map(input.invoiceLines.map((line) => [line.lineId, line]));
  const rowById = new Map(input.pricingRows.map((row) => [row.rowId, row]));
  const artifactsByDocument = new Map(input.sourceArtifacts.map((entry) => [entry.documentId, entry]));
  const transactionsByInvoiceNumber = new Map<string, NonNullable<ProjectTruthPublicationSource['transactionData']>['rows'][number][]>();
  for (const row of input.transactionRows) {
    if (!row.invoice_number) continue;
    const existing = transactionsByInvoiceNumber.get(row.invoice_number) ?? [];
    existing.push(row);
    transactionsByInvoiceNumber.set(row.invoice_number, existing);
  }
  const gaps: ProjectTruthPublicationGap[] = [];
  const values = units.flatMap((unit) => {
    const line = lineById.get(unit.invoice_line_id);
    if (!line) {
      gaps.push(stableGap({
        boundary: 'cross_document_rate_verification', reason: 'unresolved_mapping', sourceIdentity: unit.validation_unit_id,
        rejectingFunction: 'projectSourceBackedPricingMatches', detail: 'Validation unit invoice line is absent from canonical invoices',
        rawValues: {}, sourceCoordinates: { invoiceLineId: unit.invoice_line_id }, evidenceSurvivesElsewhere: true, canonicalRecoveryPossible: true,
      }));
      return [];
    }
    const candidateIds = unit.source_rows.contract_record_ids;
    const candidateRows = candidateIds.map((id) => rowById.get(id)).filter((row) => row != null);
    const selectedId = input.invoiceLineToRateMap.get(unit.invoice_line_id)?.record_id ?? null;
    const selected = selectedId ? rowById.get(selectedId) ?? null : null;
    const transactions = (unit.invoice_number ? transactionsByInvoiceNumber.get(unit.invoice_number) ?? [] : [])
      .map((row) => adaptCanonicalTransactionRow(row, artifactsByDocument));
    return [representCanonicalPricingMatch({
      matchId: unit.validation_unit_id,
      invoiceLine: line,
      candidatePricingRows: candidateRows,
      selectedPricingRow: selected,
      transactions,
      status: pricingStatus(unit.comparison_status),
      matching: {
        keysUsed: unit.billing_rate_key ? ['billing_rate_key'] : [],
        normalizedDescriptionKey: line.matchingKeys.descriptionMatchKey,
        descriptionSimilarity: null,
        rateCodeMatch: null,
        categoryMatch: unit.comparison_status === 'category_mismatch' ? false : null,
        unitMatch: null,
        originDestinationMatch: null,
        distanceBandMatch: null,
        materialMatch: null,
      },
      expectedRate: unit.contract_rate,
      variance: unit.invoice_rate != null && unit.contract_rate != null ? unit.invoice_rate - unit.contract_rate : null,
      affectedAmount: null,
      evidence: [canonicalEvidenceRef({
        documentId: unit.source_documents.invoice_document_id,
        sourceAnchor: unit.source_rows.invoice_record_id,
      })],
      unresolvedReasons: unit.comparison_status === 'match' ? [] : [unit.reason],
      approvalImpact: null,
      sourceMatcher: unit.contract_match_source ?? 'current_cross_document_rate_verification',
      sourceMatchStatus: unit.comparison_status,
    })];
  });
  return { values, gaps };
}

function reconciliationState(status: string | null | undefined): 'reconciled' | 'variance' | 'partial' | 'missing' | 'requires_review' {
  const value = status?.toLowerCase() ?? '';
  if (value.includes('reconcil') || value === 'matched') return 'reconciled';
  if (value.includes('mismatch') || value.includes('variance')) return 'variance';
  if (value.includes('missing')) return 'missing';
  if (value.includes('partial')) return 'partial';
  return 'requires_review';
}

function invoiceTransactionState(status: string | null | undefined): CanonicalInvoiceTransactionState {
  const translated = reconciliationState(status);
  if (translated === 'variance') return 'variance';
  if (translated === 'missing') return 'missing_support';
  if (translated === 'partial') return 'partial_support';
  if (translated === 'reconciled') return 'reconciled';
  return 'requires_review';
}

export function projectSourceBackedReconciliations(input: {
  readonly projectId: string;
  readonly result: ValidatorResult;
  readonly invoices: readonly CanonicalInvoice[];
  readonly invoiceLines: readonly CanonicalInvoiceLine[];
  readonly pricingMatches: readonly CanonicalPricingMatch[];
  readonly transactionRows: NonNullable<ProjectTruthPublicationSource['transactionData']>['rows'];
}): {
  readonly contractInvoice: readonly CanonicalContractInvoiceReconciliation[];
  readonly invoiceTransaction: readonly CanonicalInvoiceTransactionReconciliation[];
  readonly project: CanonicalProjectReconciliation | null;
  readonly gaps: readonly ProjectTruthPublicationGap[];
} {
  const exposure = input.result.exposure ?? input.result.summary.exposure;
  const contractSummary = input.result.contract_invoice_reconciliation ?? input.result.summary.contract_invoice_reconciliation;
  const transactionSummary = input.result.invoice_transaction_reconciliation ?? input.result.summary.invoice_transaction_reconciliation;
  const projectSummary = input.result.reconciliation ?? input.result.summary.reconciliation;
  const gaps: ProjectTruthPublicationGap[] = [];
  if (!contractSummary) gaps.push(publicationAvailabilityGap({
    rulesApplied: input.result.rulesApplied, boundary: 'contract_invoice_reconciliation',
    packId: 'contract_invoice_reconciliation', detail: 'Contract-to-invoice reconciliation is unavailable',
  }));
  if (!transactionSummary) gaps.push(publicationAvailabilityGap({
    rulesApplied: input.result.rulesApplied, boundary: 'invoice_transaction_reconciliation',
    packId: 'invoice_transaction_reconciliation', detail: 'Invoice-to-transaction reconciliation is unavailable',
  }));
  const exposureByInvoice = new Map((exposure?.invoices ?? []).map((row) => [row.invoice_number, row]));
  const contractInvoice = contractSummary ? input.invoices.map((invoice) => {
    const number = invoice.invoiceNumber.value;
    const source = exposureByInvoice.get(number) ?? null;
    const invoiceLines = input.invoiceLines.filter((line) => line.invoiceId === invoice.invoiceId);
    const matches = input.pricingMatches.filter((match) => invoiceLines.some((line) => line.lineId === match.invoiceLineId));
    return {
      reconciliationId: `contract-invoice:${invoice.invoiceId}`,
      invoiceId: invoice.invoiceId,
      invoiceLineIds: invoiceLines.map((line) => line.lineId),
      pricingMatchIds: matches.map((match) => match.matchId),
      facts: {
        billedAmount: source?.billed_amount ?? invoice.billedTotal.value,
        contractSupportedAmount: source?.contract_supported_amount ?? null,
        amountVariance: source?.unreconciled_amount ?? null,
        governingPricingStatus: source?.reconciliation_status ?? contractSummary.invoice_total_status,
        supportCompleteness: null,
      },
      conclusion: { state: reconciliationState(source?.reconciliation_status ?? contractSummary.invoice_total_status), reasons: [] },
      evidence: invoice.evidence,
      sourceStatus: source?.reconciliation_status ?? contractSummary.invoice_total_status,
    };
  }) : [];
  const invoiceTransaction = transactionSummary ? input.invoices.map((invoice) => {
    const number = invoice.invoiceNumber.value;
    const source = exposureByInvoice.get(number) ?? null;
    const invoiceLines = input.invoiceLines.filter((line) => line.invoiceId === invoice.invoiceId);
    const transactionIds = input.transactionRows.filter((row) => number != null && row.invoice_number === number).map((row) => row.id ?? '').filter(Boolean);
    const sourceStatus = source?.reconciliation_status ?? input.result.reconciliation?.invoice_transaction_status ?? 'requires_review';
    return {
      reconciliationId: `invoice-transaction:${invoice.invoiceId}`,
      invoiceId: invoice.invoiceId,
      invoiceLineIds: invoiceLines.map((line) => line.lineId),
      transactionIds,
      facts: {
        invoiceBilledQuantity: null,
        transactionSupportedQuantity: null,
        quantityVariance: null,
        invoiceBilledAmount: source?.billed_amount ?? invoice.billedTotal.value,
        transactionExtendedCost: source?.transaction_supported_amount ?? null,
        amountVariance: source?.unreconciled_amount ?? null,
        supportCompleteness: null,
      },
      conclusion: { state: invoiceTransactionState(sourceStatus), reasons: [] },
      evidence: invoice.evidence,
      sourceStatus,
    };
  }) : [];
  const translatedProjectState = projectSummary
    ? reconciliationState(projectSummary.overall_reconciliation_status)
    : null;
  const projectState: CanonicalProjectReconciliation['conclusion']['state'] = translatedProjectState === 'variance'
    ? 'mismatch'
    : translatedProjectState ?? 'requires_review';
  const project = projectSummary ? {
    reconciliationId: `project-reconciliation:${input.projectId}`,
    projectId: input.projectId,
    contractInvoiceReconciliationIds: contractInvoice.map((row) => row.reconciliationId),
    invoiceTransactionReconciliationIds: invoiceTransaction.map((row) => row.reconciliationId),
    facts: {
      totalBilledAmount: exposure?.total_billed_amount ?? null,
      totalContractSupportedAmount: exposure?.total_contract_supported_amount ?? null,
      totalTransactionSupportedAmount: exposure?.total_transaction_supported_amount ?? null,
      totalAtRiskAmount: exposure?.total_at_risk_amount ?? null,
      matchedBillingGroups: projectSummary.matched_billing_groups,
      unmatchedBillingGroups: projectSummary.unmatched_billing_groups,
      rateMismatches: projectSummary.rate_mismatches,
      quantityMismatches: projectSummary.quantity_mismatches,
      orphanInvoiceLines: projectSummary.orphan_invoice_lines,
      orphanTransactions: projectSummary.orphan_transactions,
    },
    conclusion: { state: projectState, reasons: [] },
    evidence: [],
    sourceStatus: projectSummary.overall_reconciliation_status,
  } satisfies CanonicalProjectReconciliation : null;
  return { contractInvoice, invoiceTransaction, project, gaps };
}

export function projectSourceBackedExposureReferences(result: ValidatorResult): {
  readonly values: readonly CanonicalExposureReference[];
  readonly gaps: readonly ProjectTruthPublicationGap[];
} {
  const exposure: ProjectExposureSummary | null | undefined = result.exposure ?? result.summary.exposure;
  if (!exposure) return { values: [], gaps: [publicationAvailabilityGap({
    rulesApplied: result.rulesApplied,
    boundary: 'exposure',
    packId: 'financial_integrity',
    detail: 'Exposure summary is unavailable',
  })] };
  const values: CanonicalExposureReference[] = [
    ['total-billed', exposure.total_billed_amount],
    ['contract-supported', exposure.total_contract_supported_amount],
    ['transaction-supported', exposure.total_transaction_supported_amount],
    ['at-risk', exposure.total_at_risk_amount],
    ['requires-verification', exposure.total_requires_verification_amount ?? null],
  ].map(([key, amount]) => ({
    referenceId: `exposure:${key}`,
    sourceKind: 'exposure_summary',
    amount: amount as number | null,
    state: result.validator_status,
    evidence: [],
  }));
  return { values, gaps: [] };
}

export function adaptProjectTruthPublicationSource(source: ProjectTruthPublicationSource): AdaptedProjectTruthPublication {
  const sourceBinding = bindPublicationSourceDocuments({ snapshot: source.sourceArtifactSnapshot, governingDocumentIds: source.governingDocumentIds });
  const pricingGoverningId = source.pricingContext?.documentId ?? null;
  const pricingCandidates = adaptAssembledPricingRows(source.assembledContractPricingRows, {
    documentId: pricingGoverningId,
    projectId: source.project.id,
    rateSchedule: source.pricingContext ? { scheduleId: source.pricingContext.scheduleId ?? null, scheduleName: source.pricingContext.scheduleName ?? null } : null,
    governingDocument: pricingGoverningId ? {
      documentId: pricingGoverningId,
      family: familyAndGoverning(pricingGoverningId, source.governingDocumentIds).family,
      title: null,
    } : null,
  });
  const pricingRows = pricingCandidates.map((candidate) => resolveCanonicalPricingRow(candidate));
  const contractPricing = pricingRows.length > 0 ? [buildCanonicalPricingSchedule({
    scheduleId: source.pricingContext?.scheduleId ?? null,
    scheduleName: source.pricingContext?.scheduleName ?? null,
    rows: pricingRows,
  })] : [];
  const invoice = adaptInvoices(source);
  const transactions = prepareCanonicalTransactionStream({ rows: source.transactionData?.rows ?? [], sourceArtifacts: source.sourceArtifactSnapshot });
  const matches = projectSourceBackedPricingMatches({
    result: source.effectiveResult, invoiceLines: invoice.lines, pricingRows,
    invoiceLineToRateMap: source.invoiceLineToRateMap, transactionRows: source.transactionData?.rows ?? [],
    sourceArtifacts: source.sourceArtifactSnapshot,
  });
  const reconciliations = projectSourceBackedReconciliations({
    projectId: source.project.id, result: source.effectiveResult, invoices: invoice.invoices,
    invoiceLines: invoice.lines, pricingMatches: matches.values, transactionRows: source.transactionData?.rows ?? [],
  });
  const exposure = projectSourceBackedExposureReferences(source.effectiveResult);
  const validationImpacts = source.persistedFindings.map((finding) => mapValidationFindingToCanonicalFacts({
    finding,
    evidence: finding.evidence ?? [],
    affectedFacts: [{ objectId: finding.subject_id, fieldPath: finding.field ?? finding.check_key }],
  }));
  const registryWithoutTransactions = buildCanonicalProjectTruth({
    projectId: source.project.id,
    governingDocuments: governingDocumentReferences(source),
    contractTermReferences: [...(source.contractTermReferences ?? [])],
    contractPricing,
    invoices: invoice.invoices,
    invoiceLines: invoice.lines,
    transactions: [],
    derived: {
      pricingMatches: matches.values,
      contractInvoiceReconciliations: reconciliations.contractInvoice,
      invoiceTransactionReconciliations: reconciliations.invoiceTransaction,
      projectReconciliation: reconciliations.project,
      validationImpacts,
      exposureReadinessReferences: exposure.values,
    },
    sourceSnapshotId: sourceBinding.sourceSnapshotId,
  });
  const core: CanonicalProjectTruthCore = {
    ...registryWithoutTransactions,
    transactions: { count: transactions.count, digest: transactions.digest, part: 'registry.transactions.ndjson.gz' },
  };
  const contractTermGaps = source.contractTermReferences == null ? [stableGap({
    boundary: 'manifest', reason: 'unsupported_state', sourceIdentity: 'contract-term-references',
    rejectingFunction: 'adaptProjectTruthPublicationSource',
    detail: 'Current validator input does not expose a typed contract-term reference collection',
    rawValues: {}, sourceCoordinates: {}, evidenceSurvivesElsewhere: true, canonicalRecoveryPossible: true,
  })] : [];
  const gaps = [...sourceBinding.gaps, ...contractTermGaps, ...invoice.gaps, ...matches.gaps, ...reconciliations.gaps, ...exposure.gaps]
    .sort((left, right) => left.gapKey.localeCompare(right.gapKey, 'en-US'));
  return {
    registryWithoutTransactions,
    core,
    transactionPlan: transactions,
    sourceDocuments: sourceBinding.documents,
    sourceSnapshotId: sourceBinding.sourceSnapshotId,
    gaps,
    inputCounts: {
      documents: source.documents.length,
      governingDocuments: registryWithoutTransactions.governingDocuments.length,
      assembledPricingRows: source.assembledContractPricingRows.length,
      invoices: source.invoices.length,
      invoiceLines: source.invoiceLines.length,
      transactionDatasets: source.transactionData?.datasets.length ?? 0,
      transactionRows: source.transactionData?.rows.length ?? 0,
      findings: source.persistedFindings.length,
      validationUnits: source.effectiveResult.cross_document_rate_verification?.validation_units.length ?? 0,
    },
    outputCounts: {
      pricingSchedules: contractPricing.length,
      pricingRows: pricingRows.length,
      invoices: invoice.invoices.length,
      invoiceLines: invoice.lines.length,
      transactions: transactions.count,
      pricingMatches: matches.values.length,
      contractInvoiceReconciliations: reconciliations.contractInvoice.length,
      invoiceTransactionReconciliations: reconciliations.invoiceTransaction.length,
      validationImpacts: validationImpacts.length,
      exposureReferences: exposure.values.length,
    },
  };
}
