import type { CanonicalInvoice, CanonicalBillingPeriod } from '@/lib/canonical/invoice/invoice';
import type { CanonicalInvoiceLine } from '@/lib/canonical/invoice/invoiceLine';
import {
  absentFromSource,
  canonicalEvidenceRef,
  requiresReview,
  resolvedValue,
  type CanonicalEvidenceRef,
  type TruthEnvelope,
} from '@/lib/canonical/truth/envelope';
import type {
  InvoiceExtraction,
  InvoiceLineItem,
} from '@/lib/types/extractionSchemas';

export type CanonicalInvoiceAdapterContext = {
  readonly projectId: string | null;
  readonly documentId: string | null;
  readonly invoiceId?: string | null;
  readonly supportedTotal?: number | null;
  readonly atRiskTotal?: number | null;
  readonly governingContractReferences?: readonly string[];
  readonly governingTaskOrderReferences?: readonly string[];
  readonly sourcePage?: number | null;
};

export type CurrentInvoiceRuntimeRow = Readonly<Record<string, unknown>>;

/**
 * Per-line source coordinates, read from the current row when it exposes them.
 * Absent keys stay null; nothing here is inferred.
 */
export type CanonicalInvoiceLineSourceCoordinates = {
  readonly sourceRow?: number | null;
  readonly sourceSheet?: string | null;
  readonly sourcePage?: number | null;
};

/**
 * Existing billing keys carried by the source row. They are READ, never
 * derived — `lib/validator/billingKeys.ts` remains the sole producer.
 */
export type CanonicalInvoiceLineSourceKeys = {
  readonly siteMaterialKey?: string | null;
  readonly invoiceRateKey?: string | null;
};

function nonEmpty(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function finite(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function requiredEnvelope<T>(value: T | null, evidence: readonly CanonicalEvidenceRef[], field: string): TruthEnvelope<T> {
  return value == null
    ? absentFromSource({ supportingEvidence: evidence, stateReason: `${field}_absent_from_source` })
    : resolvedValue(value, { governingSource: evidence[0] ?? null, supportingEvidence: evidence });
}

function unavailableToAdapter<T>(field: string, evidence: readonly CanonicalEvidenceRef[]): TruthEnvelope<T> {
  return requiresReview({
    supportingEvidence: evidence,
    stateReason: `${field}_unavailable_to_adapter`,
  });
}

function optionalEnvelope<T>(value: T | null, evidence: readonly CanonicalEvidenceRef[]): TruthEnvelope<T> | undefined {
  return value == null
    ? undefined
    : resolvedValue(value, { governingSource: evidence[0] ?? null, supportingEvidence: evidence });
}

function stablePart(value: unknown): string {
  return String(value ?? 'null').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'null';
}

function lineEvidence(
  item: InvoiceLineItem,
  context: CanonicalInvoiceAdapterContext,
): readonly CanonicalEvidenceRef[] {
  const refs = (item.evidence_refs ?? []).map((sourceAnchor) => canonicalEvidenceRef({
    documentId: context.documentId,
    page: context.sourcePage,
    sourceAnchor,
    rawSpan: item.raw_text ?? null,
  }));
  if (refs.length > 0) return refs;
  return [canonicalEvidenceRef({
    documentId: context.documentId,
    page: context.sourcePage,
    rawSpan: item.raw_text ?? item.line_description ?? null,
  })];
}

/**
 * Invoice-line identity must survive collision.
 *
 * A source anchor is not guaranteed to be row-level — a table-level anchor is
 * shared by every line under it — and the content fallback (description +
 * amount) collides for genuinely duplicate billed lines. Left alone, two
 * distinct billed lines would carry one `lineId`, and any downstream map keyed
 * by it would silently merge them. Under the grain rules a duplicate physical
 * row must never be collapsed, so a collision is disambiguated deterministically
 * by input ordinal AND announced: identity degrades to `deterministic_fallback`
 * and carries an explicit warning. A unique id is never rewritten.
 */
function disambiguateLineIdentities(
  lines: readonly CanonicalInvoiceLine[],
): readonly CanonicalInvoiceLine[] {
  const occurrences = new Map<string, number>();
  for (const line of lines) {
    occurrences.set(line.lineId, (occurrences.get(line.lineId) ?? 0) + 1);
  }
  if ([...occurrences.values()].every((count) => count === 1)) return lines;

  return lines.map((line, ordinal) => (
    (occurrences.get(line.lineId) ?? 0) > 1
      ? {
        ...line,
        lineId: `${line.lineId}:ordinal:${ordinal}`,
        identityKind: 'deterministic_fallback' as const,
        identityWarning: 'line_id_collision_disambiguated_by_ordinal',
      }
      : line
  ));
}

export function adaptInvoiceExtraction(
  source: InvoiceExtraction,
  context: CanonicalInvoiceAdapterContext,
): { readonly invoice: CanonicalInvoice; readonly lines: readonly CanonicalInvoiceLine[] } {
  const invoiceNumber = nonEmpty(source.invoice_number_normalized ?? source.invoice_number);
  const sourceBackedId = nonEmpty(context.invoiceId);
  const invoiceId = sourceBackedId
    ?? `fallback:invoice:${stablePart(context.documentId)}:${stablePart(invoiceNumber)}`;
  const invoiceEvidence = [canonicalEvidenceRef({
    documentId: context.documentId,
    page: context.sourcePage,
    sourceAnchor: source.evidence_anchors?.invoice_number[0] ?? null,
    rawSpan: source.invoice_number_raw ?? source.raw_sections?.invoice_number_text ?? invoiceNumber,
  })];
  const period: CanonicalBillingPeriod | null = source.period_start || source.period_end || source.period_through
    ? { start: source.period_start, end: source.period_end, through: source.period_through }
    : null;
  const billedTotal = finite(source.current_amount_due ?? source.total_amount);
  const absentFields = [
    ...(context.supportedTotal == null ? ['supportedTotal'] : []),
    ...(context.atRiskTotal == null ? ['atRiskTotal'] : []),
  ];

  const invoice: CanonicalInvoice = {
    invoiceId,
    identityKind: sourceBackedId ? 'source' : 'deterministic_fallback',
    identityWarning: sourceBackedId ? null : 'invoice_id_derived_from_document_and_invoice_number',
    invoiceNumber: requiredEnvelope(invoiceNumber, invoiceEvidence, 'invoice_number'),
    governingProjectId: context.projectId == null
      ? unavailableToAdapter('governing_project', invoiceEvidence)
      : requiredEnvelope(nonEmpty(context.projectId), invoiceEvidence, 'governing_project'),
    contractorVendor: requiredEnvelope(nonEmpty(source.vendor_name), invoiceEvidence, 'contractor_vendor'),
    billingPeriod: requiredEnvelope(period, invoiceEvidence, 'billing_period'),
    invoiceDate: requiredEnvelope(nonEmpty(source.invoice_date), invoiceEvidence, 'invoice_date'),
    billedTotal: requiredEnvelope(billedTotal, invoiceEvidence, 'billed_total'),
    ...(optionalEnvelope(finite(context.supportedTotal), invoiceEvidence) ? { supportedTotal: optionalEnvelope(finite(context.supportedTotal), invoiceEvidence) } : {}),
    ...(optionalEnvelope(finite(context.atRiskTotal), invoiceEvidence) ? { atRiskTotal: optionalEnvelope(finite(context.atRiskTotal), invoiceEvidence) } : {}),
    governingContractReferences: [...(context.governingContractReferences ?? [])],
    governingTaskOrderReferences: [...(context.governingTaskOrderReferences ?? [])],
    sourceDocumentId: context.documentId,
    evidence: invoiceEvidence,
    reviewState: 'none',
    absentFields,
    unresolvedFields: [],
  };

  const lines = disambiguateLineIdentities(
    source.line_items.map((item) => adaptInvoiceLineItem(item, invoiceId, context)),
  );
  return { invoice, lines };
}

export function adaptInvoiceLineItem(
  item: InvoiceLineItem,
  invoiceId: string,
  context: CanonicalInvoiceAdapterContext,
  source: CanonicalInvoiceLineSourceCoordinates & CanonicalInvoiceLineSourceKeys = {},
): CanonicalInvoiceLine {
  const evidence = lineEvidence(item, context);
  const sourceLineIdentifier = item.evidence_refs?.[0] ?? null;
  const lineId = sourceLineIdentifier
    ? `${invoiceId}:line:${stablePart(sourceLineIdentifier)}`
    : `fallback:invoice-line:${stablePart(invoiceId)}:${stablePart(item.line_description)}:${stablePart(item.line_total)}`;
  const normalizedDescription = nonEmpty(item.description_match_key);
  const optionalValues = {
    category: nonEmpty(item.canonical_category),
    rateCode: nonEmpty(item.line_code),
    unit: nonEmpty(item.unit),
    materialType: nonEmpty(item.material),
  };
  const absentFields = Object.entries(optionalValues)
    .filter(([, value]) => value == null)
    .map(([field]) => field);

  return {
    lineId,
    identityKind: sourceLineIdentifier ? 'source' : 'deterministic_fallback',
    identityWarning: sourceLineIdentifier ? null : 'line_id_derived_from_invoice_description_and_amount',
    invoiceId,
    sourceLineIdentifier,
    description: requiredEnvelope(nonEmpty(item.line_description ?? item.description), evidence, 'description'),
    ...(optionalEnvelope(normalizedDescription, evidence) ? { normalizedDescription: optionalEnvelope(normalizedDescription, evidence) } : {}),
    ...(optionalEnvelope(optionalValues.category, evidence) ? { category: optionalEnvelope(optionalValues.category, evidence) } : {}),
    ...(optionalEnvelope(optionalValues.rateCode, evidence) ? { rateCode: optionalEnvelope(optionalValues.rateCode, evidence) } : {}),
    quantity: requiredEnvelope(finite(item.quantity), evidence, 'quantity'),
    ...(optionalEnvelope(optionalValues.unit, evidence) ? { unit: optionalEnvelope(optionalValues.unit, evidence) } : {}),
    billedRate: requiredEnvelope(finite(item.unit_price), evidence, 'billed_rate'),
    extendedAmount: requiredEnvelope(finite(item.line_total ?? item.total), evidence, 'extended_amount'),
    ...(optionalEnvelope(optionalValues.materialType, evidence) ? { materialType: optionalEnvelope(optionalValues.materialType, evidence) } : {}),
    sourceRow: finite(source.sourceRow),
    sourceSheet: nonEmpty(source.sourceSheet),
    sourcePage: finite(source.sourcePage) ?? context.sourcePage ?? null,
    evidence,
    absentFields,
    unresolvedFields: [],
    reviewState: 'none',
    matchingKeys: {
      billingRateKey: nonEmpty(item.billing_rate_key),
      descriptionMatchKey: normalizedDescription,
      siteMaterialKey: nonEmpty(source.siteMaterialKey),
      invoiceRateKey: nonEmpty(source.invoiceRateKey),
    },
  };
}

function recordString(record: CurrentInvoiceRuntimeRow, key: string): string | null {
  return nonEmpty(typeof record[key] === 'string' ? record[key] as string : null);
}

function recordNumber(record: CurrentInvoiceRuntimeRow, key: string): number | null {
  return finite(typeof record[key] === 'number' ? record[key] as number : null);
}

function recordStringArray(record: CurrentInvoiceRuntimeRow, key: string): string[] {
  const value = record[key];
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

/**
 * Adapts the current effective Validator invoice rows after overrides/reviews
 * have already been applied. It reads typed properties only and does not run
 * recovery, normalization, matching, or other business decisions.
 */
export function adaptCurrentInvoiceRows(input: {
  readonly invoiceRow: CurrentInvoiceRuntimeRow;
  readonly invoiceLines: readonly CurrentInvoiceRuntimeRow[];
  readonly context: CanonicalInvoiceAdapterContext;
}): { readonly invoice: CanonicalInvoice; readonly lines: readonly CanonicalInvoiceLine[] } {
  const effectiveContext: CanonicalInvoiceAdapterContext = {
    ...input.context,
    documentId: recordString(input.invoiceRow, 'source_document_id')
      ?? recordString(input.invoiceRow, 'document_id')
      ?? input.context.documentId,
  };
  const source: InvoiceExtraction = {
    schema_type: 'invoice',
    invoice_number: recordString(input.invoiceRow, 'invoice_number'),
    invoice_number_raw: recordString(input.invoiceRow, 'invoice_number_raw'),
    invoice_number_normalized: recordString(input.invoiceRow, 'invoice_number_normalized'),
    invoice_status: recordString(input.invoiceRow, 'invoice_status'),
    invoice_date: recordString(input.invoiceRow, 'invoice_date'),
    period_start: recordString(input.invoiceRow, 'period_start'),
    period_end: recordString(input.invoiceRow, 'period_end'),
    period_through: recordString(input.invoiceRow, 'period_through'),
    vendor_name: recordString(input.invoiceRow, 'vendor_name'),
    client_name: recordString(input.invoiceRow, 'client_name'),
    line_items: [],
    line_item_count: recordNumber(input.invoiceRow, 'line_item_count'),
    subtotal_amount: recordNumber(input.invoiceRow, 'subtotal_amount'),
    total_amount: recordNumber(input.invoiceRow, 'total_amount') ?? recordNumber(input.invoiceRow, 'billed_amount'),
    current_amount_due: recordNumber(input.invoiceRow, 'billed_amount'),
    payment_terms: recordString(input.invoiceRow, 'payment_terms'),
    po_number: recordString(input.invoiceRow, 'po_number'),
  };
  const sourceInvoiceId = recordString(input.invoiceRow, 'id');
  const adapted = adaptInvoiceExtraction(source, {
    ...effectiveContext,
    invoiceId: sourceInvoiceId ?? input.context.invoiceId,
  });
  const lines = input.invoiceLines.map((row) => {
    const item: InvoiceLineItem = {
      line_code: recordString(row, 'line_code') ?? recordString(row, 'rate_code'),
      line_description: recordString(row, 'line_description') ?? recordString(row, 'description'),
      quantity: recordNumber(row, 'quantity'),
      unit: recordString(row, 'unit'),
      unit_price: recordNumber(row, 'unit_price'),
      line_total: recordNumber(row, 'line_total') ?? recordNumber(row, 'total_amount'),
      billing_rate_key: recordString(row, 'billing_rate_key'),
      description_match_key: recordString(row, 'description_match_key'),
      material: recordString(row, 'material'),
      service_item: recordString(row, 'service_item'),
      canonical_category: recordString(row, 'canonical_category'),
      category_confidence: recordNumber(row, 'category_confidence'),
      evidence_refs: recordStringArray(row, 'evidence_refs'),
      raw_text: recordString(row, 'raw_text'),
    };
    const line = adaptInvoiceLineItem(item, adapted.invoice.invoiceId, effectiveContext, {
      // Read only. An absent key stays null; no coordinate is inferred.
      sourceRow: recordNumber(row, 'source_row_number'),
      sourceSheet: recordString(row, 'source_sheet_name'),
      sourcePage: recordNumber(row, 'source_page'),
      siteMaterialKey: recordString(row, 'site_material_key'),
      invoiceRateKey: recordString(row, 'invoice_rate_key'),
    });
    const currentLineId = recordString(row, 'id');
    return currentLineId
      ? { ...line, lineId: currentLineId, identityKind: 'source' as const, identityWarning: null }
      : line;
  });
  return { invoice: adapted.invoice, lines: disambiguateLineIdentities(lines) };
}
