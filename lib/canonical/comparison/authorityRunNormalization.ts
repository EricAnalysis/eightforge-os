/**
 * The single normalization layer for authority comparison.
 *
 * There is exactly one of these modules by design. A second normalizer — even a
 * small test-local one — would let two comparisons of the "same" run disagree,
 * which is the failure mode that makes a shadow phase worthless.
 *
 * What this layer does NOT do is as important as what it does:
 *
 *  - it does not recompute exposure, reconciliation, clearance, or findings. Those
 *    come from the shared builders that already produced the run's result
 *    (`evaluateProjectExposure`, `evaluateApprovalGate`, the rule packs). The
 *    normalizer reshapes their output; it never becomes a second truth path.
 *  - it does not compare raw JSON. Runtime-unstable material — array order,
 *    generated ids, decimal representation — is normalized away here so the delta
 *    layer only ever sees semantic content.
 *  - it does not aggregate ticket-grain quantity by physical row count. Ticket
 *    grain is deduplicated by ticket identity, and repeated rows that DISAGREE on
 *    a ticket-grain value contribute nothing to the total and are counted as
 *    conflicts instead. Summing them would be the exact double-count the grain
 *    rules forbid, and picking a winner would hide a real source disagreement.
 *
 * `rowCount` is preserved alongside `distinctTicketCount` throughout, because the
 * whole point of comparing a row-grain legacy sum against a ticket-grain canonical
 * sum is that an operator can see both numbers and why they differ.
 */

import {
  isCanonicalAuthorityEstablished,
} from '@/lib/canonical/authority/canonicalExecutionContext';
import { blockedTruthDomains } from '@/lib/canonical/authority/canonicalDomainCoverage';
import type { ProjectTruthAuthorityMode } from '@/lib/canonical/authority/projectTruthAuthorityMode';
import { evaluateApprovalGate } from '@/lib/validator/approvalGate';
import { isBlockingFinding, isReviewFinding } from '@/lib/validator/findingSemantics';
import type {
  InvoiceLineRow,
  InvoiceRow,
  ProjectValidatorInput,
  RateScheduleItem,
  ValidatorTransactionDataRow,
} from '@/lib/validator/shared';
import type { ValidationFinding, ValidatorResult } from '@/types/validator';

import {
  type AuthorityRunSummary,
  type ComparisonGrain,
  type NormalizedAmountTotal,
  type NormalizedClearanceSummary,
  type NormalizedExposureSummary,
  type NormalizedFindingReference,
  type NormalizedFindingSummary,
  type NormalizedIdentitySummary,
  type NormalizedInvoiceExposure,
  type NormalizedPricingReference,
  type NormalizedProvenanceReference,
  type NormalizedProvenanceSummary,
  type NormalizedQuantityTotal,
  roundComparisonAmount,
  roundComparisonQuantity,
} from './authorityComparisonModel';
import {
  alignPricingObservations,
  pricingObservationKey,
  toPricingObservation,
  type AlignedPricingIdentity,
  type PricingObservation,
} from './pricingObservationAlignment';

// ---------------------------------------------------------------------------
// Field key conventions
// ---------------------------------------------------------------------------
// Source rows are `Record<string, unknown>` with several historical aliases per
// concept. These lists cover only the keys needed for IDENTITY and GRAIN — never
// for recomputing a monetary total, which always comes from the shared builders.

const DOCUMENT_ID_KEYS = ['source_document_id', 'document_id'] as const;
const INVOICE_NUMBER_KEYS = ['invoice_number', 'invoice_no', 'number'] as const;
const INVOICE_LINE_ID_KEYS = ['id', 'invoice_line_id', 'line_id'] as const;
const INVOICE_LINE_UNIT_KEYS = ['unit_type', 'unit', 'uom', 'unit_of_measure'] as const;

const MISSING = '∅';

function readString(row: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return null;
}

function sortedUnique(values: readonly (string | null)[]): readonly string[] {
  return [...new Set(values.filter((value): value is string => value != null))]
    .sort((left, right) => left.localeCompare(right, 'en-US'));
}

function key(...parts: readonly (string | null)[]): string {
  return parts.map((part) => part ?? MISSING).join('|');
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

function invoiceIdentity(row: InvoiceRow): string {
  return key(readString(row, DOCUMENT_ID_KEYS), readString(row, INVOICE_NUMBER_KEYS));
}

function invoiceLineIdentity(row: InvoiceLineRow): string {
  return key(
    readString(row, DOCUMENT_ID_KEYS),
    readString(row, INVOICE_NUMBER_KEYS),
    readString(row, INVOICE_LINE_ID_KEYS),
  );
}

/**
 * Ticket-grain identity for a transaction row.
 *
 * Prefers the source transaction number and falls back to the row's own id, so a
 * row with no ticket number is never merged with an unrelated one. Identity is
 * never derived from quantity or amount — doing so would make a value
 * disagreement look like two separate tickets, which is precisely how a
 * ticket-grain conflict gets silently summed away.
 */
function transactionIdentity(row: ValidatorTransactionDataRow): string {
  const transactionNumber = typeof row.transaction_number === 'string'
    && row.transaction_number.trim().length > 0
    ? row.transaction_number.trim()
    : null;
  return transactionNumber ?? `row:${String(row.id)}`;
}

function normalizeIdentities(
  input: ProjectValidatorInput,
): NormalizedIdentitySummary {
  const authority = input.projectTruthAuthority ?? null;
  const projection = authority != null && isCanonicalAuthorityEstablished(authority)
    ? authority.validatorProjection
    : null;
  const transactionRows = input.transactionData?.rows ?? [];

  const invoiceIdentities = input.invoices.map(invoiceIdentity);
  const invoiceLineIdentities = input.invoiceLines.map(invoiceLineIdentity);
  const transactionIdentities = transactionRows.map(transactionIdentity);

  // Duplicates are computed from the identity multiset rather than trusted from
  // one authority's own conflict list, so "canonical introduced a duplicate
  // identity" is detectable even when canonical did not report it itself.
  const duplicates = [
    ...duplicateMembers(invoiceIdentities).map((value) => `invoice:${value}`),
    ...duplicateMembers(invoiceLineIdentities).map((value) => `invoice_line:${value}`),
    ...duplicateMembers(transactionIdentities).map((value) => `transaction:${value}`),
  ];

  const unresolved = [
    // Rows whose source identity is not fully determinable. Stated explicitly
    // rather than silently accepted under a generated id.
    ...input.invoices
      .filter((row) => readString(row, INVOICE_NUMBER_KEYS) == null)
      .map((row) => `invoice:${invoiceIdentity(row)}`),
    ...input.invoiceLines
      .filter((row) => readString(row, DOCUMENT_ID_KEYS) == null)
      .map((row) => `invoice_line:${invoiceLineIdentity(row)}`),
    ...transactionRows
      .filter((row) => transactionIdentity(row).startsWith('row:'))
      .map((row) => `transaction:${transactionIdentity(row)}`),
    // Canonical additionally reports identities it could not scope from source
    // truth at all. Those are merged in so both authorities' unresolved sets are
    // expressed in one vocabulary.
    ...(projection?.invoices.identities ?? [])
      .filter((identity) => identity.identityConfidence === 'unresolved')
      .map((identity) => `canonical_invoice:${identity.canonicalInvoiceId}`),
    ...(projection?.invoiceLines.identities ?? [])
      .filter((identity) => identity.identityConfidence === 'unresolved')
      .map((identity) => `canonical_invoice_line:${identity.canonicalLineId}`),
  ];

  return {
    invoiceIdentities: sortedUnique(invoiceIdentities),
    invoiceLineIdentities: sortedUnique(invoiceLineIdentities),
    transactionIdentities: sortedUnique(transactionIdentities),
    duplicateIdentities: sortedUnique(duplicates),
    unresolvedIdentities: sortedUnique(unresolved),
  };
}

function duplicateMembers(values: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const duplicated = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicated.add(value);
    seen.add(value);
  }
  return [...duplicated];
}

// ---------------------------------------------------------------------------
// Ticket-grain quantity and amount
// ---------------------------------------------------------------------------

type TicketGrainBucket = {
  rowCount: number;
  /** Distinct observed ticket-grain values. More than one means a conflict. */
  quantities: Set<number>;
  amounts: Set<number>;
  /** Naive across-rows sums, kept as the double-count diagnostic. */
  rowQuantitySum: number;
  rowAmountSum: number;
};

type GrainAccumulator = {
  rowCount: number;
  distinctTicketCount: number;
  quantityTotal: number;
  amountTotal: number;
  rowGrainQuantityTotal: number;
  rowGrainAmountTotal: number;
  conflictedIdentityCount: number;
};

function emptyAccumulator(): GrainAccumulator {
  return {
    rowCount: 0,
    distinctTicketCount: 0,
    quantityTotal: 0,
    amountTotal: 0,
    rowGrainQuantityTotal: 0,
    rowGrainAmountTotal: 0,
    conflictedIdentityCount: 0,
  };
}

/**
 * Collapses transaction rows to ticket grain within one bucket key.
 *
 * The deterministic conflict rule: when repeated rows for one ticket identity
 * agree, the single agreed value is contributed once; when they disagree, the
 * ticket contributes NOTHING and is counted as conflicted. Neither summing nor
 * choosing a winner is acceptable — the first double-counts, the second discards
 * a real source disagreement without telling anyone.
 */
function accumulateTicketGrain(
  rows: readonly ValidatorTransactionDataRow[],
  bucketKeyOf: (row: ValidatorTransactionDataRow) => string | null,
): Map<string, GrainAccumulator> {
  const buckets = new Map<string, Map<string, TicketGrainBucket>>();
  for (const row of rows) {
    const bucketKey = bucketKeyOf(row);
    if (bucketKey == null) continue;
    const tickets = buckets.get(bucketKey) ?? new Map<string, TicketGrainBucket>();
    buckets.set(bucketKey, tickets);
    const identity = transactionIdentity(row);
    const bucket = tickets.get(identity)
      ?? {
        rowCount: 0,
        quantities: new Set<number>(),
        amounts: new Set<number>(),
        rowQuantitySum: 0,
        rowAmountSum: 0,
      };
    bucket.rowCount += 1;
    if (typeof row.transaction_quantity === 'number' && Number.isFinite(row.transaction_quantity)) {
      bucket.quantities.add(roundComparisonQuantity(row.transaction_quantity));
      bucket.rowQuantitySum += roundComparisonQuantity(row.transaction_quantity);
    }
    if (typeof row.extended_cost === 'number' && Number.isFinite(row.extended_cost)) {
      bucket.amounts.add(roundComparisonAmount(row.extended_cost));
      bucket.rowAmountSum += roundComparisonAmount(row.extended_cost);
    }
    tickets.set(identity, bucket);
  }

  const result = new Map<string, GrainAccumulator>();
  for (const [bucketKey, tickets] of buckets.entries()) {
    const accumulator = emptyAccumulator();
    for (const bucket of tickets.values()) {
      accumulator.rowCount += bucket.rowCount;
      accumulator.distinctTicketCount += 1;
      accumulator.rowGrainQuantityTotal += bucket.rowQuantitySum;
      accumulator.rowGrainAmountTotal += bucket.rowAmountSum;
      const conflicted = bucket.quantities.size > 1 || bucket.amounts.size > 1;
      if (conflicted) {
        accumulator.conflictedIdentityCount += 1;
        continue;
      }
      accumulator.quantityTotal += [...bucket.quantities][0] ?? 0;
      accumulator.amountTotal += [...bucket.amounts][0] ?? 0;
    }
    result.set(bucketKey, accumulator);
  }
  return result;
}

function quantityTotalsFrom(
  grain: ComparisonGrain,
  accumulators: Map<string, GrainAccumulator>,
  unitOf: (bucketKey: string) => string | null = () => null,
): readonly NormalizedQuantityTotal[] {
  return [...accumulators.entries()]
    .map(([bucketKey, accumulator]) => ({
      grain,
      key: bucketKey,
      unit: unitOf(bucketKey),
      distinctTicketCount: accumulator.distinctTicketCount,
      rowCount: accumulator.rowCount,
      quantityTotal: roundComparisonQuantity(accumulator.quantityTotal),
      rowGrainQuantityTotal: roundComparisonQuantity(accumulator.rowGrainQuantityTotal),
      conflictedIdentityCount: accumulator.conflictedIdentityCount,
    }))
    .sort((left, right) => left.key.localeCompare(right.key, 'en-US'));
}

function amountTotalsFrom(
  grain: ComparisonGrain,
  accumulators: Map<string, GrainAccumulator>,
): readonly NormalizedAmountTotal[] {
  return [...accumulators.entries()]
    .map(([bucketKey, accumulator]) => ({
      grain,
      key: bucketKey,
      rowCount: accumulator.rowCount,
      amountTotal: roundComparisonAmount(accumulator.amountTotal),
      rowGrainAmountTotal: roundComparisonAmount(accumulator.rowGrainAmountTotal),
      conflictedIdentityCount: accumulator.conflictedIdentityCount,
    }))
    .sort((left, right) => left.key.localeCompare(right.key, 'en-US'));
}

function normalizeQuantityTotals(
  input: ProjectValidatorInput,
): readonly NormalizedQuantityTotal[] {
  const rows = input.transactionData?.rows ?? [];
  const project = accumulateTicketGrain(rows, () => 'project');
  const byInvoice = accumulateTicketGrain(rows, (row) => row.invoice_number ?? MISSING);
  const byCategory = accumulateTicketGrain(rows, (row) => row.billing_rate_key ?? row.rate_code ?? MISSING);
  const byTicket = accumulateTicketGrain(rows, transactionIdentity);

  // Unit grain comes from invoice lines, the only source in this input that
  // carries a unit of measure. It is row-grain by nature: an invoice line is one
  // billed row, not a physical ticket, so `distinctTicketCount` stays 0 rather
  // than claiming a ticket count the source cannot support.
  const byUnit = new Map<string, GrainAccumulator>();
  for (const line of input.invoiceLines) {
    const unit = readString(line, INVOICE_LINE_UNIT_KEYS) ?? MISSING;
    const accumulator = byUnit.get(unit) ?? emptyAccumulator();
    accumulator.rowCount += 1;
    byUnit.set(unit, accumulator);
  }

  return [
    ...quantityTotalsFrom('project', project),
    ...quantityTotalsFrom('invoice', byInvoice),
    ...quantityTotalsFrom('category', byCategory),
    ...quantityTotalsFrom('ticket', byTicket),
    ...quantityTotalsFrom('unit', byUnit, (unit) => (unit === MISSING ? null : unit)),
  ];
}

function normalizeAmountTotals(
  input: ProjectValidatorInput,
  result: ValidatorResult,
  authorityMode: ProjectTruthAuthorityMode,
): readonly NormalizedAmountTotal[] {
  const rows = input.transactionData?.rows ?? [];
  const project = accumulateTicketGrain(rows, () => 'project');
  const byInvoice = accumulateTicketGrain(rows, (row) => row.invoice_number ?? MISSING);
  const byCategory = accumulateTicketGrain(rows, (row) => row.billing_rate_key ?? row.rate_code ?? MISSING);

  // Governing pricing rates are deliberately NOT aggregated as an amount grain.
  // A rate is a per-contract-line value, not a sum: adding up the observations of
  // one line double-counts exactly the duplicate rows canonical deduplicates, and
  // a per-authority bucket key reintroduces the identity defect this repair
  // removes. Rates are compared in the pricing domain, against the aligned
  // authority-neutral identity, where multiplicity is a first-class field.

  // Invoice-grain billed amounts are taken from the exposure summary the shared
  // exposure builder already produced. They are NOT re-derived from line rows:
  // that would create a second billed-amount authority inside the comparator.
  const byExposureInvoice = new Map<string, GrainAccumulator>();
  for (const invoice of result.exposure?.invoices ?? []) {
    const accumulator = emptyAccumulator();
    accumulator.rowCount = 1;
    accumulator.amountTotal = roundComparisonAmount(invoice.billed_amount ?? 0);
    byExposureInvoice.set(`billed:${invoice.invoice_number ?? MISSING}`, accumulator);
  }

  return [
    ...amountTotalsFrom('project', project),
    ...amountTotalsFrom('invoice', byInvoice),
    ...amountTotalsFrom('invoice', byExposureInvoice),
    ...amountTotalsFrom('category', byCategory),
  ];
}

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

/**
 * Builds the authority-neutral observation view of one run's governing pricing.
 *
 * Identity is NOT computed here. A single per-item identity string cannot express
 * "these two legacy rows and this one canonical row are the same contract line",
 * which is the shape real data takes when one authority deduplicates. Alignment is
 * a collection-level operation performed by `pricingObservationAlignment.ts`.
 */
function pricingObservationsFor(
  input: ProjectValidatorInput,
  authorityMode: ProjectTruthAuthorityMode,
): readonly PricingObservation[] {
  const pageIndex = buildPricingPageIndex(input);
  return input.factLookups.rateScheduleItems.map((item) => toPricingObservation(item, authorityMode, {
    sourceArtifactIdForDocument: (documentId) => sourceArtifactIdForDocument(input, documentId),
    pageFor: (candidate) => readPage(candidate.raw_value) ?? pricingPageFor(pageIndex, candidate),
  }));
}

function retainedPricingRowsFor(
  input: ProjectValidatorInput,
): readonly {
  readonly documentId: string | null;
}[] {
  const schedules = input.projectTruthAuthority?.registry?.contractPricing ?? [];
  return schedules.flatMap((schedule) => schedule.rows.map((row) => ({
    documentId: row.rateSchedule.governingSource?.documentId
      ?? row.governingDocument?.documentId
      ?? schedule.governingDocument?.documentId
      ?? null,
  })));
}

/**
 * Page numbers for the pricing rows this execution assembled, keyed by content.
 *
 * The canonical adapter does not carry a page onto the validator-facing rate row —
 * its `raw_value` retains description and raw text only — so a canonical pricing
 * delta would otherwise reach the operator with no page to open. The assembled
 * pricing rows the execution already loaded DO carry a page, and both authorities
 * derive from them, so this recovers the page for either side without reaching into
 * canonical registry internals.
 *
 * Keyed by description and unit rather than by row id: internal row ids differ
 * between the adapters, which is the same reason `pricingIdentity` excludes them.
 */
function buildPricingPageIndex(
  input: ProjectValidatorInput,
): ReadonlyMap<string, number> {
  const pages = new Map<string, number>();
  for (const row of input.assembledContractPricingRows as readonly Record<string, unknown>[]) {
    const description = readString(row, ['description', 'scope']);
    const unit = readString(row, ['unit', 'unit_type']);
    if (description == null) continue;
    for (const field of ['page', 'source_page', 'page_number']) {
      const value = row[field];
      if (typeof value === 'number' && Number.isFinite(value)) {
        pages.set(key(description.toLowerCase(), unit?.toLowerCase() ?? null), value);
        break;
      }
    }
  }
  return pages;
}

/**
 * Projects one side of an alignment into the comparison's pricing view.
 *
 * Only emits an entry when the authority actually observed the contract line, so
 * an aligned identity present on one side and absent on the other yields exactly
 * one genuine "missing row" signal instead of a matched pair of phantom rows.
 */
export function alignedPricingReferences(
  aligned: readonly AlignedPricingIdentity[],
  authority: ProjectTruthAuthorityMode,
): readonly NormalizedPricingReference[] {
  return aligned
    .filter((identity) => identity[authority].present)
    .map((identity) => {
      const side = identity[authority];
      return {
        pricingKey: identity.pricingKey,
        governingDocumentId: side.governingDocumentIds[0] ?? null,
        // The RAW source category, which both authorities carry unchanged. The
        // resolved taxonomy slug is deliberately absent: it is the field whose
        // per-authority divergence caused the first cohort's false regressions.
        category: identity.rawCategories[0] ?? null,
        description: side.descriptions[0] ?? null,
        unit: side.rawUnits[0] ?? null,
        unitClass: side.unitClasses[0] ?? null,
        rate: side.rates.length === 1 ? side.rates[0]! : (side.rates[0] ?? null),
        sourceArtifactId: side.sourceArtifactIds[0] ?? null,
        sourcePage: side.sourcePages[0] ?? null,
        provenanceReference: side.provenanceReferences[0] ?? null,
        observationCount: side.observationCount,
        distinctSourceCount: side.distinctSourceCount,
        descriptions: side.descriptions,
        billingKeyLost: side.billingKeyLost,
      };
    })
    .sort((left, right) => left.pricingKey.localeCompare(right.pricingKey, 'en-US'));
}

function pricingPageFor(
  pageIndex: ReadonlyMap<string, number>,
  item: RateScheduleItem,
): number | null {
  if (item.description == null) return null;
  return pageIndex.get(
    key(item.description.toLowerCase(), item.unit_type?.toLowerCase() ?? null),
  ) ?? null;
}

function readPage(rawValue: unknown): number | null {
  if (rawValue == null || typeof rawValue !== 'object' || Array.isArray(rawValue)) return null;
  const record = rawValue as Record<string, unknown>;
  for (const field of ['page', 'source_page', 'page_number']) {
    const value = record[field];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return null;
}

function sourceArtifactIdForDocument(
  input: ProjectValidatorInput,
  documentId: string | null,
): string | null {
  if (documentId == null) return null;
  const entry = input.sourceArtifactSnapshot.find(
    (candidate) => candidate.documentId === documentId,
  );
  return entry?.sourceArtifactId ?? null;
}

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

/**
 * Stable semantic identity for a finding.
 *
 * Built from rule code, affected identity, and field. Runtime timestamps, the
 * synthetic run id, and array position are all excluded so the same semantic
 * finding raised by two authorities compares equal.
 */
function findingKey(finding: ValidationFinding): string {
  return key(finding.rule_id, `${finding.subject_type}:${finding.subject_id}`, finding.field);
}

/**
 * Reduces a finding's evidence references to their stable source identity.
 *
 * Evidence refs are `type:documentId:recordId`, and the record-id segment is an
 * internal adapter id: the legacy adapter and the canonical adapter assign
 * different record ids to the SAME source row. Comparing the full string would
 * therefore report evidence loss on every finding whose evidence merely passed
 * through a different adapter — a false alarm that would bury real evidence loss.
 *
 * What matters semantically, and what an operator can verify against a document,
 * is which evidence TYPE points at which source DOCUMENT. That pair is kept; the
 * record id is dropped as equivalent normalization.
 */
function normalizeEvidenceSources(refs: readonly string[]): readonly string[] {
  return sortedUnique(refs.map((ref) => {
    const segments = ref.split(':');
    return segments.length >= 2 ? `${segments[0]}:${segments[1]}` : ref;
  }));
}

function normalizeFindings(
  result: ValidatorResult,
): readonly NormalizedFindingReference[] {
  return result.findings
    .map((finding) => ({
      findingKey: findingKey(finding),
      code: finding.rule_id,
      affectedIdentity: `${finding.subject_type}:${finding.subject_id}`,
      severity: finding.severity,
      status: finding.status,
      blockedReason: finding.blocked_reason ?? null,
      evidenceSources: normalizeEvidenceSources(finding.evidence_refs ?? []),
    }))
    .sort((left, right) => left.findingKey.localeCompare(right.findingKey, 'en-US'));
}

function normalizeFindingSummary(result: ValidatorResult): NormalizedFindingSummary {
  const open = result.findings.filter((finding) => finding.status === 'open');
  const counts = new Map<string, number>();
  for (const finding of result.findings) {
    counts.set(finding.rule_id, (counts.get(finding.rule_id) ?? 0) + 1);
  }
  return {
    total: result.findings.length,
    open: open.length,
    blocking: open.filter((finding) => isBlockingFinding(finding)).length,
    reviewRequired: open.filter((finding) => isReviewFinding(finding)).length,
    informational: open.filter(
      (finding) => !isBlockingFinding(finding) && !isReviewFinding(finding),
    ).length,
    byCode: [...counts.entries()]
      .map(([code, count]) => ({ code, count }))
      .sort((left, right) => left.code.localeCompare(right.code, 'en-US')),
  };
}

// ---------------------------------------------------------------------------
// Exposure
// ---------------------------------------------------------------------------

function normalizeExposure(result: ValidatorResult): NormalizedExposureSummary {
  const exposure = result.exposure ?? null;
  if (exposure == null) {
    return {
      totalBilledAmount: 0,
      totalContractSupportedAmount: 0,
      totalTransactionSupportedAmount: 0,
      totalFullyReconciledAmount: 0,
      totalUnreconciledAmount: 0,
      totalAtRiskAmount: 0,
      totalRequiresVerificationAmount: 0,
      unresolvedExposureAmount: 0,
      blockedExposureAmount: 0,
      // `absent` is not the same claim as "zero exposure". An authority that
      // never produced an exposure summary must not look reconciled.
      readinessState: 'absent',
      invoices: [],
    };
  }

  const invoices: readonly NormalizedInvoiceExposure[] = exposure.invoices
    .map((invoice) => ({
      invoiceNumber: invoice.invoice_number ?? null,
      billedAmount: invoice.billed_amount != null
        ? roundComparisonAmount(invoice.billed_amount)
        : null,
      billedAmountSource: invoice.billed_amount_source,
      supportedAmount: roundComparisonAmount(invoice.supported_amount),
      unreconciledAmount: roundComparisonAmount(invoice.unreconciled_amount ?? 0),
      atRiskAmount: roundComparisonAmount(invoice.at_risk_amount),
      reconciliationStatus: invoice.reconciliation_status,
    }))
    .sort((left, right) => (left.invoiceNumber ?? MISSING).localeCompare(
      right.invoiceNumber ?? MISSING,
      'en-US',
    ));

  const totalAtRisk = roundComparisonAmount(exposure.total_at_risk_amount);
  const totalUnreconciled = roundComparisonAmount(exposure.total_unreconciled_amount);
  // Exposure an authority declined to attribute at all: billed dollars with no
  // billed-amount source are not "reconciled to zero", they are unknown.
  const unresolved = roundComparisonAmount(
    invoices
      .filter((invoice) => invoice.billedAmountSource === 'missing')
      .reduce((total, invoice) => total + (invoice.billedAmount ?? 0), 0),
  );
  // Exposure withheld by a refusal to assert support. A blocked run reports its
  // billed dollars as blocked rather than as reconciled.
  const blocked = result.status === 'BLOCKED'
    ? roundComparisonAmount(exposure.total_billed_amount - exposure.total_fully_reconciled_amount)
    : 0;

  return {
    totalBilledAmount: roundComparisonAmount(exposure.total_billed_amount),
    totalContractSupportedAmount: roundComparisonAmount(exposure.total_contract_supported_amount),
    totalTransactionSupportedAmount: roundComparisonAmount(
      exposure.total_transaction_supported_amount,
    ),
    totalFullyReconciledAmount: roundComparisonAmount(exposure.total_fully_reconciled_amount),
    totalUnreconciledAmount: totalUnreconciled,
    totalAtRiskAmount: totalAtRisk,
    totalRequiresVerificationAmount: roundComparisonAmount(
      exposure.total_requires_verification_amount ?? 0,
    ),
    unresolvedExposureAmount: unresolved,
    blockedExposureAmount: Math.max(0, blocked),
    readinessState: totalAtRisk > 0
      ? 'at_risk'
      : (totalUnreconciled > 0 || unresolved > 0)
        ? 'unresolved'
        : 'ready',
    invoices,
  };
}

// ---------------------------------------------------------------------------
// Clearance
// ---------------------------------------------------------------------------

/**
 * Normalizes clearance using the shared approval gate.
 *
 * `evaluateApprovalGate` is the production clearance authority and is a pure
 * function of the run result, so calling it here reproduces exactly the decision
 * the serving path would reach for that authority — no second gate, no drift.
 */
function normalizeClearance(
  input: ProjectValidatorInput,
  result: ValidatorResult,
): NormalizedClearanceSummary {
  const gate = evaluateApprovalGate(result);
  const open = result.findings.filter((finding) => finding.status === 'open');
  const authority = input.projectTruthAuthority ?? null;
  const coverage = authority?.validatorProjection?.coverage ?? null;

  return {
    outcome: gate.project.approval_status,
    validationStatus: result.status,
    blockingFindingCount: open.filter((finding) => isBlockingFinding(finding)).length,
    reviewFindingCount: open.filter((finding) => isReviewFinding(finding)).length,
    unresolvedTruthDomains: coverage != null ? [...blockedTruthDomains(coverage)].sort(
      (left, right) => left.localeCompare(right, 'en-US'),
    ) : [],
    approvalGateReasons: sortedUnique(gate.project.reasons),
  };
}

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

function normalizeProvenance(
  input: ProjectValidatorInput,
  authorityMode: ProjectTruthAuthorityMode,
): NormalizedProvenanceSummary {
  const authority = input.projectTruthAuthority ?? null;
  const projection = authority != null && isCanonicalAuthorityEstablished(authority)
    ? authority.validatorProjection
    : null;
  const references: NormalizedProvenanceReference[] = [];

  const pageIndex = buildPricingPageIndex(input);
  for (const item of input.factLookups.rateScheduleItems) {
    references.push({
      recordKind: 'pricing',
      recordKey: pricingObservationKey(
        toPricingObservation(item, authorityMode, {
          sourceArtifactIdForDocument: (documentId) => sourceArtifactIdForDocument(input, documentId),
          pageFor: (candidate) => readPage(candidate.raw_value) ?? pricingPageFor(pageIndex, candidate),
        }),
      ),
      sourceArtifactId: sourceArtifactIdForDocument(input, item.source_document_id),
      sourceDocumentId: item.source_document_id ?? null,
      page: readPage(item.raw_value) ?? pricingPageFor(pageIndex, item),
      geometryPresent: hasGeometry(item.raw_value),
      adapterIdentity: item.source_kind ?? null,
      governingRelationshipEvidence: governingEvidenceFor(input, item.source_document_id),
    });
  }

  for (const row of input.invoices) {
    const documentId = readString(row, DOCUMENT_ID_KEYS);
    references.push({
      recordKind: 'invoice',
      recordKey: invoiceIdentity(row),
      sourceArtifactId: sourceArtifactIdForDocument(input, documentId),
      sourceDocumentId: documentId,
      page: null,
      geometryPresent: false,
      adapterIdentity: projection != null ? 'canonical_invoice_adapter' : null,
      governingRelationshipEvidence: governingEvidenceFor(input, documentId),
    });
  }

  for (const row of input.transactionData?.rows ?? []) {
    references.push({
      recordKind: 'transaction',
      recordKey: transactionIdentity(row),
      sourceArtifactId: sourceArtifactIdForDocument(input, row.document_id),
      sourceDocumentId: row.document_id ?? null,
      page: null,
      geometryPresent: false,
      adapterIdentity: projection != null ? 'canonical_transaction_adapter' : null,
      governingRelationshipEvidence: governingEvidenceFor(input, row.document_id),
    });
  }

  const sorted = references.sort((left, right) => (
    `${left.recordKind}:${left.recordKey}`.localeCompare(
      `${right.recordKind}:${right.recordKey}`,
      'en-US',
    )
  ));

  return {
    // Attributability, not geometry, is the provenance requirement: a record that
    // cannot name its source document is unattributed regardless of coordinates.
    attributedRecordCount: sorted.filter((entry) => entry.sourceDocumentId != null).length,
    unattributedRecordCount: sorted.filter((entry) => entry.sourceDocumentId == null).length,
    sourceDocumentIds: sortedUnique(sorted.map((entry) => entry.sourceDocumentId)),
    sourceArtifactIds: sortedUnique(sorted.map((entry) => entry.sourceArtifactId)),
    references: sorted,
  };
}

function hasGeometry(rawValue: unknown): boolean {
  if (rawValue == null || typeof rawValue !== 'object' || Array.isArray(rawValue)) return false;
  const record = rawValue as Record<string, unknown>;
  return record.geometry != null || record.bbox != null || record.bounding_box != null;
}

function governingEvidenceFor(
  input: ProjectValidatorInput,
  documentId: string | null,
): readonly string[] {
  if (documentId == null) return [];
  const authority = input.projectTruthAuthority ?? null;
  const relationships = authority?.validatorProjection?.relationships.all ?? [];
  const canonical = relationships
    .filter((relationship) => relationship.provenance.sourceDocumentId === documentId)
    .map((relationship) => relationship.relationshipId);
  if (canonical.length > 0) return sortedUnique(canonical);
  // Legacy authority has no canonical relationship records, so the governing
  // evidence is the precedence-snapshot edge itself. Both authorities therefore
  // produce comparable evidence strings instead of legacy producing none.
  return sortedUnique(
    input.documentRelationships
      .filter((relationship) => relationship.target_document_id === documentId
        || relationship.source_document_id === documentId)
      .map((relationship) => [
        relationship.source_document_id,
        relationship.relationship_type,
        relationship.target_document_id,
      ].join('->')),
  );
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Normalizes one authority's finalized run into the comparison representation.
 *
 * Pure: identical `(input, result)` pairs always produce an identical summary,
 * with no wall-clock, no random ordering, and no dependence on how the run was
 * scheduled. That determinism is what lets the acceptance gate assert byte-stable
 * comparisons across repeated executions.
 */
export function normalizeAuthorityRun(params: {
  readonly authorityMode: ProjectTruthAuthorityMode;
  readonly input: ProjectValidatorInput;
  readonly result: ValidatorResult;
}): AuthorityRunSummary {
  const { authorityMode, input, result } = params;
  const authority = input.projectTruthAuthority ?? null;
  const projection = authority?.validatorProjection ?? null;
  const coverage = projection?.coverage ?? null;
  const retainedPricingRows = retainedPricingRowsFor(input);

  return {
    authorityMode,
    registryDigest: authority?.registryDigest ?? null,
    registryPresent: authority?.registry != null,
    validatorProjectionState: authorityMode === 'legacy'
      ? 'not_requested'
      : projection != null
        ? 'present'
        : 'withheld',
    sourceSnapshotDigest: authority?.sourceArtifactSnapshotDigest ?? null,
    authorityCoverage: coverage,
    assemblyStatus: authority?.assemblyStatus ?? 'not_requested',
    blockedTruthDomains: coverage != null
      ? [...blockedTruthDomains(coverage)].sort((left, right) => left.localeCompare(right, 'en-US'))
      : [],
    blockReason: authority?.blockReason ?? null,
    authorityBlockSourceGaps: [...(authority?.block?.sourceGaps ?? [])]
      .sort((left, right) => left.localeCompare(right, 'en-US')),
    duplicateAuthorityDiagnostics: [...(authority?.block?.duplicateAuthority ?? [])]
      .sort((left, right) => left.diagnosticId.localeCompare(right.diagnosticId, 'en-US')),
    retainedPricingRowCount: retainedPricingRows.length,
    retainedPricingDocumentIds: sortedUnique(retainedPricingRows.map((row) => row.documentId)),
    // Counts are the DISTINCT identity counts, never the physical row counts.
    invoiceCount: sortedUnique(input.invoices.map(invoiceIdentity)).length,
    invoiceLineCount: sortedUnique(input.invoiceLines.map(invoiceLineIdentity)).length,
    transactionCount: sortedUnique(
      (input.transactionData?.rows ?? []).map(transactionIdentity),
    ).length,
    identities: normalizeIdentities(input),
    quantityTotals: normalizeQuantityTotals(input),
    amountTotals: normalizeAmountTotals(input, result, authorityMode),
    // Left empty here on purpose. Pricing identity is authority-neutral and can
    // only be assigned once both runs are known, so `applyPricingAlignment` fills
    // this in. A per-run key would reintroduce the exact defect this replaces.
    governingPricing: [],
    pricingObservations: pricingObservationsFor(input, authorityMode),
    findingSummary: normalizeFindingSummary(result),
    findings: normalizeFindings(result),
    exposure: normalizeExposure(result),
    clearance: normalizeClearance(input, result),
    provenanceSummary: normalizeProvenance(input, authorityMode),
  };
}
