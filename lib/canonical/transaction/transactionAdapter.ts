import type { CanonicalTransaction, CanonicalTransactionSupportState } from '@/lib/canonical/transaction/transaction';
import {
  absentFromSource,
  canonicalEvidenceRef,
  resolvedValue,
  type CanonicalEvidenceRef,
  type TruthEnvelope,
} from '@/lib/canonical/truth/envelope';
import type { NormalizedTransactionDataRecord } from '@/lib/extraction/xlsx/normalizeTransactionData';

/** Structural persisted-row boundary; avoids importing Project Facts projections. */
export type PersistedCanonicalTransactionRowInput = {
  readonly id?: string | null;
  readonly document_id?: string | null;
  readonly invoice_number?: string | null;
  readonly transaction_number?: string | null;
  readonly rate_code?: string | null;
  readonly billing_rate_key?: string | null;
  readonly description_match_key?: string | null;
  readonly site_material_key?: string | null;
  readonly invoice_rate_key?: string | null;
  readonly transaction_quantity?: number | null;
  readonly extended_cost?: number | null;
  readonly invoice_date?: string | null;
  readonly source_sheet_name?: string | null;
  readonly source_row_number?: number | null;
  readonly record_json?: Record<string, unknown> | null;
  readonly raw_row_json?: Record<string, unknown> | null;
};

export type CanonicalTransactionAdapterContext = {
  readonly documentId: string | null;
  readonly sourceWorkbook: string | null;
};

function nonEmpty(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function sourceSheet(value: string | null | undefined): string | null {
  const normalized = nonEmpty(value);
  return normalized?.toLowerCase() === 'unknown' ? null : normalized;
}

function sourceRow(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function requiredEnvelope<T>(value: T | null, evidence: readonly CanonicalEvidenceRef[], field: string): TruthEnvelope<T> {
  return value == null
    ? absentFromSource({ supportingEvidence: evidence, stateReason: `${field}_absent_from_source` })
    : resolvedValue(value, { governingSource: evidence[0] ?? null, supportingEvidence: evidence });
}

function optionalEnvelope<T>(value: T | null, evidence: readonly CanonicalEvidenceRef[]): TruthEnvelope<T> | undefined {
  return value == null ? undefined : resolvedValue(value, {
    governingSource: evidence[0] ?? null,
    supportingEvidence: evidence,
  });
}

function stablePart(value: unknown): string {
  return String(value ?? 'null').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'null';
}

function readRecordString(record: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = nonEmpty(record[key]);
    if (value) return value;
  }
  return null;
}

function readRecordNumber(record: Record<string, unknown>, keys: readonly string[]): number | null {
  for (const key of keys) {
    const value = finite(record[key]);
    if (value != null) return value;
  }
  return null;
}

/** Explicit translation; eligibility is a business state, not a second truth vocabulary. */
export function translateTransactionEligibility(value: string | null): CanonicalTransactionSupportState {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return 'unknown';
  if (['eligible', 'approved', 'supported', 'yes', 'true'].includes(normalized)) return 'eligible';
  if (['ineligible', 'rejected', 'unsupported', 'no', 'false'].includes(normalized)) return 'ineligible';
  return 'unknown';
}

export function adaptNormalizedTransaction(
  source: NormalizedTransactionDataRecord,
  context: CanonicalTransactionAdapterContext,
): CanonicalTransaction {
  return buildCanonicalTransaction({
    sourceId: source.id,
    transactionNumber: source.transaction_number,
    invoiceNumber: source.invoice_number,
    occurredAt: source.invoice_date,
    material: source.material,
    quantity: source.transaction_quantity,
    unit: null,
    rateCode: source.rate_code,
    appliedRate: source.transaction_rate,
    extendedCost: source.extended_cost,
    originSite: null,
    destinationSite: null,
    route: null,
    distanceBand: null,
    loadIdentity: source.transaction_number,
    sourceSheet: sourceSheet(source.source_sheet_name),
    sourceRow: sourceRow(source.source_row_number),
    rawRow: source.raw_row,
    evidenceRef: source.evidence_ref,
    fieldEvidenceRefs: Object.values(source.field_evidence_ids),
    eligibility: source.eligibility,
    billingRateKey: source.billing_rate_key,
    descriptionMatchKey: source.description_match_key,
    siteMaterialKey: source.site_material_key,
    invoiceRateKey: source.invoice_rate_key,
  }, context);
}

export function adaptProjectTransactionRow(
  source: PersistedCanonicalTransactionRowInput,
  context: CanonicalTransactionAdapterContext,
): CanonicalTransaction {
  const record = source.record_json ?? {};
  return buildCanonicalTransaction({
    sourceId: source.id ?? null,
    transactionNumber: source.transaction_number ?? readRecordString(record, ['transaction_number', 'ticket_number']),
    invoiceNumber: source.invoice_number ?? null,
    occurredAt: source.invoice_date ?? readRecordString(record, ['transaction_datetime', 'transaction_date']),
    material: readRecordString(record, ['material', 'material_type']),
    quantity: source.transaction_quantity ?? null,
    unit: readRecordString(record, ['unit', 'unit_type']),
    rateCode: source.rate_code ?? null,
    appliedRate: readRecordNumber(record, ['transaction_rate', 'applied_rate', 'unit_rate']),
    extendedCost: source.extended_cost ?? null,
    originSite: readRecordString(record, ['origin', 'origin_site', 'load_site']),
    destinationSite: readRecordString(record, ['destination', 'disposal_site']),
    route: readRecordString(record, ['route']),
    distanceBand: readRecordString(record, ['distance_band']),
    loadIdentity: readRecordString(record, ['load_identity', 'load_id']),
    sourceSheet: sourceSheet(source.source_sheet_name),
    sourceRow: sourceRow(source.source_row_number),
    rawRow: source.raw_row_json ?? record,
    evidenceRef: source.id ?? null,
    fieldEvidenceRefs: [],
    eligibility: readRecordString(record, ['eligibility']),
    billingRateKey: source.billing_rate_key ?? null,
    descriptionMatchKey: source.description_match_key ?? null,
    siteMaterialKey: source.site_material_key ?? null,
    invoiceRateKey: source.invoice_rate_key ?? null,
  }, { ...context, documentId: source.document_id ?? context.documentId });
}

type TransactionSource = {
  readonly sourceId: string | null;
  readonly transactionNumber: string | null;
  readonly invoiceNumber: string | null;
  readonly occurredAt: string | null;
  readonly material: string | null;
  readonly quantity: number | null;
  readonly unit: string | null;
  readonly rateCode: string | null;
  readonly appliedRate: number | null;
  readonly extendedCost: number | null;
  readonly originSite: string | null;
  readonly destinationSite: string | null;
  readonly route: string | null;
  readonly distanceBand: string | null;
  readonly loadIdentity: string | null;
  readonly sourceSheet: string | null;
  readonly sourceRow: number | null;
  readonly rawRow: Readonly<Record<string, unknown>>;
  readonly evidenceRef: string | null;
  readonly fieldEvidenceRefs: readonly (string | undefined)[];
  readonly eligibility: string | null;
  readonly billingRateKey: string | null;
  readonly descriptionMatchKey: string | null;
  readonly siteMaterialKey: string | null;
  readonly invoiceRateKey: string | null;
};

function buildCanonicalTransaction(
  source: TransactionSource,
  context: CanonicalTransactionAdapterContext,
): CanonicalTransaction {
  const evidence = [canonicalEvidenceRef({
    documentId: context.documentId,
    sourceAnchor: source.evidenceRef,
    extractionArtifactId: source.sourceId,
    tableKey: source.sourceSheet,
    rowIndex: source.sourceRow,
    rawSpan: Object.keys(source.rawRow).length > 0 ? JSON.stringify(source.rawRow) : null,
    extractor: 'xlsx',
  }), ...source.fieldEvidenceRefs
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .map((extractionArtifactId) => canonicalEvidenceRef({
      documentId: context.documentId,
      extractionArtifactId,
      tableKey: source.sourceSheet,
      rowIndex: source.sourceRow,
      extractor: 'xlsx',
    }))];
  const sourceId = nonEmpty(source.sourceId);
  const transactionId = sourceId
    ?? `fallback:transaction:${stablePart(context.documentId)}:${stablePart(source.sourceSheet)}:${stablePart(source.sourceRow)}:${stablePart(source.transactionNumber)}`;
  const optionals = {
    invoiceNumber: nonEmpty(source.invoiceNumber), material: nonEmpty(source.material), unit: nonEmpty(source.unit),
    rateCode: nonEmpty(source.rateCode), originSite: nonEmpty(source.originSite), destinationSite: nonEmpty(source.destinationSite),
    route: nonEmpty(source.route), distanceBand: nonEmpty(source.distanceBand), loadIdentity: nonEmpty(source.loadIdentity),
  };
  const optionalEnvelopes = Object.fromEntries(
    Object.entries(optionals).map(([key, value]) => [key, optionalEnvelope(value, evidence)]),
  ) as Record<keyof typeof optionals, TruthEnvelope<string> | undefined>;

  return {
    transactionId,
    identityKind: sourceId ? 'source' : 'deterministic_fallback',
    identityWarning: sourceId ? null : 'transaction_id_derived_from_source_coordinates_and_transaction_number',
    transactionNumber: requiredEnvelope(nonEmpty(source.transactionNumber), evidence, 'transaction_number'),
    ...(optionalEnvelopes.invoiceNumber ? { invoiceNumber: optionalEnvelopes.invoiceNumber } : {}),
    occurredAt: requiredEnvelope(nonEmpty(source.occurredAt), evidence, 'occurred_at'),
    ...(optionalEnvelopes.material ? { material: optionalEnvelopes.material } : {}),
    quantity: requiredEnvelope(finite(source.quantity), evidence, 'quantity'),
    ...(optionalEnvelopes.unit ? { unit: optionalEnvelopes.unit } : {}),
    ...(optionalEnvelopes.rateCode ? { rateCode: optionalEnvelopes.rateCode } : {}),
    appliedRate: requiredEnvelope(finite(source.appliedRate), evidence, 'applied_rate'),
    extendedCost: requiredEnvelope(finite(source.extendedCost), evidence, 'extended_cost'),
    ...(optionalEnvelopes.originSite ? { originSite: optionalEnvelopes.originSite } : {}),
    ...(optionalEnvelopes.destinationSite ? { destinationSite: optionalEnvelopes.destinationSite } : {}),
    ...(optionalEnvelopes.route ? { route: optionalEnvelopes.route } : {}),
    ...(optionalEnvelopes.distanceBand ? { distanceBand: optionalEnvelopes.distanceBand } : {}),
    ...(optionalEnvelopes.loadIdentity ? { loadIdentity: optionalEnvelopes.loadIdentity } : {}),
    sourceWorkbook: context.sourceWorkbook,
    sourceDocumentId: context.documentId,
    sourceSheet: source.sourceSheet,
    sourceRow: source.sourceRow,
    rawRowEvidence: source.rawRow,
    evidence,
    supportState: translateTransactionEligibility(source.eligibility),
    eligibilityRaw: source.eligibility,
    reviewState: 'none',
    absentFields: Object.entries(optionals).filter(([, value]) => value == null).map(([key]) => key),
    unresolvedFields: [],
    matchingKeys: {
      billingRateKey: source.billingRateKey,
      descriptionMatchKey: source.descriptionMatchKey,
      siteMaterialKey: source.siteMaterialKey,
      invoiceRateKey: source.invoiceRateKey,
    },
  };
}
