import type { ValidatorFinding } from '@/lib/ask/types';

/**
 * The bounded ticket and transaction view a question about tickets may read. It
 * carries aggregates the extraction already persisted and counts of findings the
 * Validator already raised, and it decides nothing about them.
 *
 * Ticket-grain quantities are shown per upload and are never added across uploads:
 * two uploads can hold the same physical tickets, so a sum would double-count them.
 * Row-grain amounts stay labelled as such. Pure and client-safe.
 */

export const TRANSACTION_CONTEXT_BOUNDS = Object.freeze({
  maxDatasets: 5,
  maxFlaggedRecords: 20,
  maxFindingRecords: 10,
});

/** Grouped for reading only. The rule catalogue stays the source of each rule's meaning. */
export const TRANSACTION_FINDING_GROUPS = Object.freeze({
  duplicate_or_conflicting_tickets: ['IDENTITY_DUPLICATE_TICKET', 'TRANSACTION_TICKET_GRAIN_CONFLICT'],
  quantity_mismatch: ['TICKET_QTY_CYD_MISMATCH', 'TICKET_QTY_TONNAGE_MISMATCH', 'TRANSACTION_QUANTITY_MATCHES_INVOICE', 'TRANSACTION_TOTAL_MATCHES_INVOICE_LINE'],
  material_or_site_mismatch: ['TICKET_MATERIAL_MISMATCH', 'TICKET_DISPOSAL_SITE_MISMATCH', 'SITE_MATERIAL_ANOMALIES'],
  orphaned_load: ['TICKET_ORPHANED_LOAD'],
  rate_outlier: ['TRANSACTION_RATE_OUTLIERS'],
  invoice_support: ['TRANSACTION_GROUP_EXISTS_FOR_INVOICE_LINE', 'TRANSACTION_MISSING_INVOICE_LINK', 'CROSS_DOCUMENT_TICKET_SUPPORT_EXISTS', 'CROSS_DOCUMENT_INVOICE_WORK_SUPPORTED'],
  no_ticket_data: ['SOURCES_NO_TICKET_DATA'],
} as const);
export type TransactionFindingGroup = keyof typeof TRANSACTION_FINDING_GROUPS;

const GROUP_BY_RULE: ReadonlyMap<string, TransactionFindingGroup> = new Map(
  (Object.entries(TRANSACTION_FINDING_GROUPS) as [TransactionFindingGroup, readonly string[]][])
    .flatMap(([group, rules]) => rules.map((rule) => [rule, group] as const)),
);

export type TransactionReviewBucketSummary = Readonly<{
  reviewKey: string;
  label: string;
  status: string | null;
  reviewedRowCount: number | null;
  flaggedRowCount: number;
  /** What the extraction wrote about this review, including truck and trailer checks. */
  summary: string | null;
  flaggedRecordIds: readonly string[];
}>;

export type TransactionDatasetSummary = Readonly<{
  id: string;
  documentId: string;
  projectId: string;
  /** Row grain. */
  rowCount: number | null;
  totalExtendedCost: number | null;
  /** Ticket grain: each physical ticket once. `all` counts every ticket, `invoiced` only those linked to an invoice. */
  tickets: Readonly<{
    count: number | null;
    cyd: Readonly<{ invoiced: number | null; all: number | null }>;
    mileage: Readonly<{ invoiced: number | null; all: number | null }>;
    netTonnage: Readonly<{ invoiced: number | null; all: number | null }>;
    diameter: Readonly<{ invoiced: number | null; all: number | null }>;
  }>;
  dateRangeStart: string | null;
  dateRangeEnd: string | null;
  distinctInvoiceCount: number | null;
  uninvoicedLineCount: number | null;
  /** Rows with no such value. Null means the upload does not record the count. */
  missingFields: Readonly<{
    rateCode: number | null;
    invoiceNumber: number | null;
    quantity: number | null;
    extendedCost: number | null;
  }>;
  zeroCostRowCount: number | null;
  extremeUnitRateRowCount: number | null;
  /** Only reviews that ran and flagged something. */
  flaggedReviews: readonly TransactionReviewBucketSummary[];
  createdAt: string | null;
}>;

export type ProjectTransactionSummaries = Readonly<{
  totalDatasetCount: number;
  datasets: readonly TransactionDatasetSummary[];
}>;

export type TransactionFindingCount = Readonly<{
  group: TransactionFindingGroup;
  count: number;
  findingIds: readonly string[];
}>;

/** Open findings about tickets or transactions, by group, in the catalogue's order. */
export function transactionFindingCounts(findings: readonly ValidatorFinding[]): readonly TransactionFindingCount[] {
  const byGroup = new Map<TransactionFindingGroup, string[]>();
  for (const finding of findings) {
    const group = finding.ruleId ? GROUP_BY_RULE.get(finding.ruleId) : undefined;
    if (group) byGroup.set(group, [...(byGroup.get(group) ?? []), finding.id]);
  }
  return (Object.keys(TRANSACTION_FINDING_GROUPS) as TransactionFindingGroup[]).flatMap((group) => {
    const ids = byGroup.get(group);
    return ids ? [{ group, count: ids.length, findingIds: [...ids].sort((left, right) => left.localeCompare(right, 'en-US')) }] : [];
  });
}

export type TransactionContextPayload = Readonly<{
  totalDatasetCount: number;
  datasets: readonly TransactionDatasetSummary[];
  openFindings: readonly Omit<TransactionFindingCount, 'findingIds'>[];
}>;

function count(value: number, singular: string, plural = `${singular}s`): string {
  return `${value.toLocaleString('en-US')} ${value === 1 ? singular : plural}`;
}

/** One plain sentence about the newest upload, for the answer an operator reads. */
export function transactionContextNote(payload: TransactionContextPayload): string | null {
  const latest = payload.datasets[0];
  if (!latest) return null;
  const size = [
    latest.rowCount != null ? count(latest.rowCount, 'row') : null,
    latest.tickets.count != null ? count(latest.tickets.count, 'ticket') : null,
  ].filter((part): part is string => part != null).join(' and ');
  const range = latest.dateRangeStart && latest.dateRangeEnd ? ` from ${latest.dateRangeStart} to ${latest.dateRangeEnd}` : '';
  const missing = [
    latest.missingFields.rateCode ? `${count(latest.missingFields.rateCode, 'row')} with no rate code` : null,
    latest.missingFields.invoiceNumber ? `${count(latest.missingFields.invoiceNumber, 'row')} with no invoice number` : null,
    latest.missingFields.quantity ? `${count(latest.missingFields.quantity, 'row')} with no quantity` : null,
    latest.missingFields.extendedCost ? `${count(latest.missingFields.extendedCost, 'row')} with no cost` : null,
  ].filter((part): part is string => part != null);
  const parts = [
    size ? `The latest ticket data on file has ${size}${range}.` : null,
    missing.length > 0 ? `It includes ${missing.join(', ')}.` : null,
    payload.totalDatasetCount > 1 ? `${count(payload.totalDatasetCount, 'ticket data upload')} are on file, and their totals are not added together.` : null,
  ].filter((part): part is string => part != null);
  return parts.length > 0 ? parts.join(' ') : null;
}
