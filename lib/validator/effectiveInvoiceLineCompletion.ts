import {
  resolveInvoiceLineCode,
  type InvoiceLineCodeResolution,
} from '@/lib/invoices/invoiceParser';
import type { EffectiveFactSource } from '@/lib/effectiveFacts';
import {
  deriveBillingKeysForInvoiceLine,
  deriveInvoiceRateKey,
} from '@/lib/validator/billingKeys';
import { resolveCanonicalRateCategory } from '@/lib/validator/rateTaxonomy';
import {
  readRowNumber,
  readRowString,
  type InvoiceLineRow,
} from '@/lib/validator/shared';

export type EffectiveInvoiceLineRateCodeOrigin =
  | 'operator_asserted'
  | 'source_asserted'
  | 'system_derived'
  | 'system_unresolved';

export type EffectiveInvoiceLineCodeResolution = {
  status: InvoiceLineCodeResolution['status'];
  value: string | null;
  source_field: string | null;
  source_value: string | null;
  method: InvoiceLineCodeResolution['method'];
  rejected_candidates: Array<{
    source_field: string;
    value: string;
    reason: 'matches_quantity' | 'missing_alpha_character' | 'invalid_format';
  }>;
  evidence_refs: unknown[];
  rate_code_origin: EffectiveInvoiceLineRateCodeOrigin;
  effective_fact_source: EffectiveFactSource;
};

function isOperatorFactSource(source: EffectiveFactSource): boolean {
  return source === 'human_override' || source === 'human_review';
}

function codeResolutionForCompletedLine(params: {
  row: InvoiceLineRow;
  resolved: InvoiceLineCodeResolution;
  effectiveFactSource: EffectiveFactSource;
  rateCodeWasPresent: boolean;
  existingRateCode: string | null;
}): EffectiveInvoiceLineCodeResolution {
  const assertedRateCode = params.rateCodeWasPresent ? params.existingRateCode : null;
  const value = params.rateCodeWasPresent ? assertedRateCode : params.resolved.value;
  const rateCodeOrigin: EffectiveInvoiceLineRateCodeOrigin = params.rateCodeWasPresent
    ? isOperatorFactSource(params.effectiveFactSource)
      ? 'operator_asserted'
      : 'source_asserted'
    : params.resolved.value != null
      ? 'system_derived'
      : 'system_unresolved';

  return {
    status: params.rateCodeWasPresent
      ? assertedRateCode != null
        ? 'resolved'
        : 'missing'
      : params.resolved.status,
    value,
    source_field: params.rateCodeWasPresent ? 'rate_code' : params.resolved.sourceField,
    source_value: params.rateCodeWasPresent ? assertedRateCode : params.resolved.sourceValue,
    method: params.rateCodeWasPresent && assertedRateCode != null
      ? 'structured'
      : params.resolved.method,
    rejected_candidates: params.resolved.rejectedCandidates.map((candidate) => ({
      source_field: candidate.sourceField,
      value: candidate.value,
      reason: candidate.reason,
    })),
    evidence_refs: Array.isArray(params.row.evidence_refs)
      ? params.row.evidence_refs
      : [],
    rate_code_origin: rateCodeOrigin,
    effective_fact_source: params.effectiveFactSource,
  };
}

/**
 * Completes the canonical Validator invoice-line contract without reparsing or
 * replacing asserted values. Only absent/null canonical fields are added.
 */
export function completeEffectiveInvoiceLineCanonicalFields(params: {
  row: InvoiceLineRow;
  effectiveFactSource: EffectiveFactSource;
}): InvoiceLineRow {
  const { row } = params;
  const resolvedLineCode = resolveInvoiceLineCode(row);
  const rateCodeWasPresent = row.rate_code != null;
  const existingRateCode = readRowString(row, ['rate_code']);
  const effectiveRateCode = rateCodeWasPresent
    ? existingRateCode
    : resolvedLineCode.value;
  const description = readRowString(row, [
    'line_description',
    'description',
    'item_description',
  ]);
  const material = readRowString(row, ['material', 'material_type', 'debris_type']);
  const serviceItem = readRowString(row, [
    'service_item',
    'service_item_code',
  ]) ?? description;
  const billingKeys = deriveBillingKeysForInvoiceLine({
    rate_code: effectiveRateCode,
    description,
    service_item: serviceItem,
    material,
  });
  const billingRateKey = row.billing_rate_key != null
    ? readRowString(row, ['billing_rate_key'])
    : billingKeys.billing_rate_key;
  const categoryResolution = resolveCanonicalRateCategory({
    sourceCategory: material,
    sourceDescriptors: [
      serviceItem,
      description,
      readRowString(row, ['line_code', 'lineCode']) ?? effectiveRateCode,
    ],
    existingCanonicalCategory: readRowString(row, [
      'canonical_category',
      'canonicalCategory',
    ]),
    existingConfidence: readRowNumber(row, [
      'category_confidence',
      'categoryConfidence',
    ]),
  });
  const additions: InvoiceLineRow = {};

  if (row.rate_code == null) additions.rate_code = resolvedLineCode.value;
  if (row.billing_rate_key == null) {
    additions.billing_rate_key = billingKeys.billing_rate_key;
  }
  if (row.description_match_key == null) {
    additions.description_match_key = billingKeys.description_match_key;
  }
  if (row.invoice_rate_key == null) {
    additions.invoice_rate_key = deriveInvoiceRateKey(
      readRowString(row, ['invoice_number', 'invoice_no', 'number']),
      billingRateKey,
    );
  }
  if (row.canonical_category == null) {
    additions.canonical_category = categoryResolution.canonical_category;
  }
  if (row.category_confidence == null) {
    additions.category_confidence = categoryResolution.category_confidence;
  }
  if (row.line_code_resolution == null) {
    additions.line_code_resolution = codeResolutionForCompletedLine({
      row,
      resolved: resolvedLineCode,
      effectiveFactSource: params.effectiveFactSource,
      rateCodeWasPresent,
      existingRateCode,
    });
  }

  return { ...row, ...additions };
}
