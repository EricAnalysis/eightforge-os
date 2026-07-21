import type { PdfFormField } from '@/lib/extraction/pdf/extractForms';
import type { PdfTable, PdfTableRow } from '@/lib/extraction/pdf/extractTables';
import type { EvidenceObject } from '@/lib/extraction/types';
import type {
  InvoiceEvidenceAnchors,
  InvoiceExtraction,
  InvoiceLineItem,
} from '@/lib/types/extractionSchemas';
import {
  deriveBillingKeysForInvoiceLine,
  deriveInvoiceRateKey,
} from '@/lib/validator/billingKeys';
import { resolveCanonicalRateCategory } from '@/lib/validator/rateTaxonomy';

type InvoiceContentLayers = {
  pdf?: {
    tables?: {
      tables?: PdfTable[];
    } | null;
    forms?: {
      fields?: PdfFormField[];
    } | null;
    evidence?: EvidenceObject[] | null;
  } | null;
} | null;

type ScalarCandidate<T> = {
  value: T;
  raw_text: string | null;
  evidence_refs: string[];
  score: number;
};

type AmountCandidate = ScalarCandidate<number> & {
  label: string;
};

type AmountSemantic = 'subtotal' | 'total' | 'current_due';

const INVOICE_NUMBER_LABELS = [
  'invoice #',
  'invoice no',
  'invoice number',
  'invoice',
];
const INVOICE_STATUS_LABELS = ['invoice status', 'status'];
const INVOICE_DATE_LABELS = ['invoice date', 'date'];
const VENDOR_LABELS = ['vendor', 'contractor', 'from', 'seller', 'payee', 'supplier'];
const CLIENT_LABELS = [
  'bill to',
  'billed to',
  'client',
  'customer',
  'owner',
  'invoice to',
  'recipient',
];
const PERIOD_RANGE_LABELS = [
  'service period',
  'billing period',
  'period',
  'period covered',
];
const PERIOD_START_LABELS = [
  'period start',
  'service start',
  'service start date',
  'from date',
  'start date',
  'period from',
];
const PERIOD_END_LABELS = [
  'period end',
  'service end',
  'service end date',
  'to date',
  'end date',
  'period ending',
];
const PERIOD_THROUGH_LABELS = ['period through', 'through date', 'period ending', 'through'];
const SUBTOTAL_LABELS = ['subtotal', 'sub total'];
const CURRENT_AMOUNT_DUE_LABELS = [
  'current amount due',
  'current payment due',
  'amount due',
  'total amount due',
  'total due',
  'balance due',
];
const BILLED_TOTAL_LABELS = [
  'invoice total',
  'total this invoice',
  'grand total',
  'total amount',
  'billed total',
  'total billed',
  'total',
];
const HEADER_CODE_ALIASES = ['code', 'line code', 'item code', 'rate code', 'service code', 'clin', 'no', '#'];
const HEADER_DESCRIPTION_ALIASES = [
  'description',
  'line description',
  'item description',
  'service',
  'service item',
  'item',
];
const HEADER_QUANTITY_ALIASES = ['qty', 'quantity', 'units', 'hours', 'tons', 'tonnage', 'cyd'];
const HEADER_UNIT_ALIASES = ['unit', 'uom'];
const HEADER_UNIT_PRICE_ALIASES = ['unit price', 'price', 'rate', 'unit rate', 'billed rate'];
const HEADER_TOTAL_ALIASES = ['line total', 'amount', 'total', 'extended', 'extended amount', 'line amount'];
const LINE_TABLE_SIGNAL_ALIASES = [
  ...HEADER_DESCRIPTION_ALIASES,
  ...HEADER_QUANTITY_ALIASES,
  ...HEADER_UNIT_ALIASES,
  ...HEADER_UNIT_PRICE_ALIASES,
  ...HEADER_TOTAL_ALIASES,
];
const STATUS_VALUES = ['paid', 'open', 'pending', 'draft', 'void', 'unpaid', 'final'] as const;

const MONTHS: Record<string, number> = {
  january: 1,
  jan: 1,
  february: 2,
  feb: 2,
  march: 3,
  mar: 3,
  april: 4,
  apr: 4,
  may: 5,
  june: 6,
  jun: 6,
  july: 7,
  jul: 7,
  august: 8,
  aug: 8,
  september: 9,
  sep: 9,
  sept: 9,
  october: 10,
  oct: 10,
  november: 11,
  nov: 11,
  december: 12,
  dec: 12,
};

const DATE_CAPTURE =
  '(?:\\d{1,2}[\\/\\-]\\d{1,2}[\\/\\-]\\d{2,4}'
  + '|(?:January|February|March|April|May|June|July|August|September|October|November|December)\\s+\\d{1,2},?\\s+\\d{4}'
  + '|\\d{1,2}(?:st|nd|rd|th)?\\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\\s+\\d{4}'
  + '|\\d{1,2}(?:st|nd|rd|th)?\\s+day\\s+of\\s+(?:January|February|March|April|May|June|July|August|September|October|November|December),?\\s+\\d{4})';

const INVOICE_NUMBER_RE =
  /(?:invoice\s*(?:#|no\.?|number)\s*[:=]?\s*)([A-Za-z0-9][A-Za-z0-9\-\/]+)/i;
const DATE_VALUE_RE = new RegExp(DATE_CAPTURE, 'i');
const DATE_RANGE_RE = new RegExp(
  `(?:service|billing|invoice)?\\s*period[^A-Za-z0-9]{0,16}(?:from\\s*)?(${DATE_CAPTURE})\\s*(?:through|to|\\-|–|—)\\s*(${DATE_CAPTURE})`,
  'i',
);
const GENERIC_FROM_TO_RE = new RegExp(
  `\\bfrom\\b\\s*(${DATE_CAPTURE})\\s*(?:through|to|\\-|–|—)\\s*(${DATE_CAPTURE})`,
  'i',
);
const DATE_PAIR_RE = new RegExp(
  `(${DATE_CAPTURE})\\s*(?:through|to|-)\\s*(${DATE_CAPTURE})`,
  'i',
);
const THROUGH_ONLY_RE = new RegExp(
  `\\b(?:period\\s+through|period\\s+ending|through)\\b[^0-9A-Za-z]{0,12}(${DATE_CAPTURE})`,
  'i',
);
const MONEY_RE = /\$?\s*([\d,]+(?:\.\d{1,2})?)/g;
const AMOUNT_CAPTURE = '([\\d,]+(?:\\.\\d{1,2})?)';

function asRecord(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? value as T[] : [];
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function restoreOcrWordSpacing(value: string): string {
  return normalizeWhitespace(
    value
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2'),
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeLabel(value: string | null | undefined): string {
  if (!value) return '';
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return Array.from(new Set(
    values
      .map((value) => typeof value === 'string' ? value.trim() : '')
      .filter((value) => value.length > 0),
  ));
}

function toAmount(value: string | null | undefined): number | null {
  if (!value) return null;
  const cleaned = value.replace(/[$,\s]/g, '').trim();
  if (!cleaned) return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Match extension total within cents / small relative slack. */
function nearlySameInvoiceMoney(a: number, b: number): boolean {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  const tolerance = Math.max(0.02, Math.abs(b) * 0.002);
  return Math.abs(a - b) <= tolerance;
}

/** Unit column (CYD / EA / ROW / LH / …) followed by unit price then line total at end of raw row — Williamson spreadsheet + invoice lines. */
const INVOICE_LINE_UNIT_AMOUNT_PAIR_TAIL_RE =
  /\b(?:CYD|EA|SQ\s*(?:YD|FT)|LF|TN|TON|DAY|DAYS|HRS|HR|WK|YR|YR\.|BU|BUSHEL|LB|UNIT|EACH|ROW|LH)\b\s+\$?\s*([\d,]+(?:\.\d{1,2})?)\s+\$?\s*([\d,]+(?:\.\d{1,2})?)\s*$/i;

function invoiceMoneyAmountsOrdered(text: string): number[] {
  const out: number[] = [];
  const re = new RegExp(MONEY_RE.source, MONEY_RE.flags);
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const parsed = toAmount(match[1] ?? '');
    if (parsed != null && Number.isFinite(parsed) && parsed >= 0) out.push(parsed);
  }
  return out;
}

function deriveUnitAmountPairFromTailUnit(raw: string): { unitPrice: number; extension: number } | null {
  const trimmed = normalizeWhitespace(raw);
  if (!trimmed) return null;
  const tailMatch = trimmed.match(INVOICE_LINE_UNIT_AMOUNT_PAIR_TAIL_RE);
  if (!tailMatch) return null;
  const unitPrice = toAmount(tailMatch[1] ?? '');
  const extension = toAmount(tailMatch[2] ?? '');
  if (unitPrice == null || extension == null) return null;
  return { unitPrice, extension };
}

/**
 * Resolve display/canonical invoice line unit price: trust structured fields only when qty × unit ≈ extension;
 * otherwise prefer the monetary token immediately before the line total near the CYD|EA|ROW|LH tail, or anchored token scan on raw_text.
 *
 * Generic `rate` / quantity-like structured values are superseded when raw pattern + extension check disprove them.
 */
export function resolveInvoiceLineUnitPrice(params: {
  structuredUnitPrice?: number | null | undefined;
  quantity?: number | null | undefined;
  lineTotal?: number | null | undefined;
  rawText?: string | null | undefined;
}): number | null {
  const qty = typeof params.quantity === 'number' && Number.isFinite(params.quantity) ? params.quantity : null;
  const extension =
    typeof params.lineTotal === 'number' && Number.isFinite(params.lineTotal)
      ? params.lineTotal
      : null;
  const structured =
    typeof params.structuredUnitPrice === 'number' && Number.isFinite(params.structuredUnitPrice)
      ? params.structuredUnitPrice
      : null;
  const rawText = typeof params.rawText === 'string' ? params.rawText.trim() : '';

  const structuredConsistent =
    structured != null
    && extension != null
    && qty != null
    && nearlySameInvoiceMoney(qty * structured, extension);

  if (structuredConsistent) {
    return structured;
  }

  const tailDerived = rawText.length > 0 ? deriveUnitAmountPairFromTailUnit(rawText) : null;
  if (tailDerived) {
    const { unitPrice, extension: extensionFromTail } = tailDerived;
    if (!(extension != null && !nearlySameInvoiceMoney(extensionFromTail, extension))) {
      if (qty != null && extension != null) {
        if (nearlySameInvoiceMoney(qty * unitPrice, extension)) return unitPrice;
      } else if (extension != null) {
        if (nearlySameInvoiceMoney(extensionFromTail, extension)) return unitPrice;
      } else {
        /** No structured extension — still trust unit-token ×2 tail when qty proves extension math. */
        if (qty != null && nearlySameInvoiceMoney(qty * unitPrice, extensionFromTail)) return unitPrice;
      }
    }
  }

  const amounts = invoiceMoneyAmountsOrdered(rawText);
  if (qty != null && extension != null && amounts.length >= 2) {
    for (let i = amounts.length - 1; i >= 1; i -= 1) {
      if (nearlySameInvoiceMoney(amounts[i]!, extension)) {
        const candidate = amounts[i - 1]!;
        if (!nearlySameInvoiceMoney(candidate, extension) && nearlySameInvoiceMoney(qty * candidate, extension)) {
          return candidate;
        }
      }
    }
    /** Last resort: last monetary token is extension, preceding is unit price if math holds. */
    const lastAmt = amounts[amounts.length - 1];
    const penultimate = amounts[amounts.length - 2];
    if (
      lastAmt != null
      && penultimate != null
      && nearlySameInvoiceMoney(lastAmt, extension)
      && nearlySameInvoiceMoney(qty * penultimate, extension)
    ) {
      return penultimate;
    }
  }

  /** Reject bogus structured unit price vs extension×quantity when qty is known. */
  if (structured != null && qty != null && extension != null && !nearlySameInvoiceMoney(qty * structured, extension)) {
    return null;
  }

  return structured ?? null;
}

function lastAmountInText(value: string | null | undefined): number | null {
  if (!value) return null;
  let match: RegExpExecArray | null = null;
  let last: string | null = null;
  const regex = new RegExp(MONEY_RE.source, MONEY_RE.flags);
  while ((match = regex.exec(String(value))) !== null) {
    last = match[1] ?? match[0] ?? null;
  }
  return last ? toAmount(last) : null;
}

function trailingAmountLabel(value: string): string {
  return normalizeWhitespace(
    value.replace(/\$?\s*[\d,]+(?:\.\d{1,2})?\s*$/, ''),
  );
}

const TEXT_LINE_ITEM_RE = new RegExp(
  `^(.*?)\\s+(\\d+(?:\\.\\d+)?)\\s+([A-Za-z]{1,12})\\s+\\$?\\s*([\\d,]+(?:\\.\\d{1,2})?)\\s+\\$?\\s*([\\d,]+(?:\\.\\d{1,2})?)$`,
  'i',
);

function looksLikeTextLineItem(value: string): boolean {
  const match = value.match(TEXT_LINE_ITEM_RE);
  return Boolean(match?.[1] && /[A-Za-z]/.test(match[1]));
}

function codeTokenLike(value: string): boolean {
  return /\d/.test(value) || /^[A-Za-z]{1,3}$/i.test(value);
}

function splitTextLinePrefix(prefix: string): {
  line_code: string | null;
  line_description: string | null;
} {
  const normalized = normalizeWhitespace(prefix);
  if (!normalized) {
    return { line_code: null, line_description: null };
  }

  const tokens = normalized.split(' ').filter((token) => token.length > 0);
  let bestTokenCount = 0;
  for (let count = 1; count <= Math.min(3, Math.max(tokens.length - 1, 1)); count += 1) {
    const candidateTokens = tokens.slice(0, count);
    if (!candidateTokens.every((token) => codeTokenLike(token))) continue;
    const candidate = codeLikeValue(candidateTokens.join(' '));
    if (!candidate) continue;
    bestTokenCount = count;
  }

  const line_code = bestTokenCount > 0
    ? codeLikeValue(tokens.slice(0, bestTokenCount).join(' '))
    : null;
  const line_description = normalizeWhitespace(
    tokens.slice(bestTokenCount).join(' '),
  ) || null;

  return {
    line_code,
    line_description,
  };
}

function matchAnyAlias(label: string, aliases: readonly string[]): boolean {
  const normalized = normalizeLabel(label);
  return aliases.some((alias) => {
    const aliasLabel = normalizeLabel(alias);
    return normalized === aliasLabel
      || normalized.startsWith(`${aliasLabel} `)
      || normalized.endsWith(` ${aliasLabel}`)
      || normalized.includes(aliasLabel);
  });
}

function matchAnyPhraseAlias(label: string, aliases: readonly string[]): boolean {
  const normalized = normalizeLabel(label);
  return aliases.some((alias) => {
    const aliasLabel = normalizeLabel(alias);
    return normalized === aliasLabel
      || normalized.startsWith(`${aliasLabel} `)
      || normalized.endsWith(` ${aliasLabel}`)
      || normalized.includes(` ${aliasLabel} `);
  });
}

function cleanPartyName(value: string | null | undefined): string | null {
  if (!value) return null;
  let normalized = restoreOcrWordSpacing(value)
    .replace(/^(?:vendor|contractor|from|bill to|client|customer|owner)\s*[:\-]\s*/i, '')
    .replace(/^(?:make all checks payable to)\s*/i, '')
    .replace(/\b(?:thank you for your business|invoice no|fein|job due date)\b[\s\S]*$/i, '')
    .replace(/\b\d{3}[- ]\d{3}[- ]\d{4}\b/g, ' ')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, ' ')
    .replace(/\b\d{4}-\d{3,4}\b/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (normalized.length < 3) return null;
  if (/^\$?[\d,]+(?:\.\d+)?$/.test(normalized)) return null;
  if (normalized === normalized.toUpperCase()) {
    normalized = normalized
      .split(' ')
      .filter((token) => token.length > 0)
      .map((token) => {
        const bare = token.replace(/[^A-Z]/g, '');
        if (bare === 'LLC' || bare === 'LP' || bare === 'LLP' || bare === 'PLC' || bare === 'PC') {
          return token.toUpperCase();
        }
        if (bare === 'INC') {
          return token.endsWith('.') ? 'Inc.' : 'Inc.';
        }
        return token.charAt(0).toUpperCase() + token.slice(1).toLowerCase();
      })
      .join(' ');
  }
  return normalized.length > 180 ? normalized.slice(0, 180).trim() : normalized;
}

export function normalizeCanonicalInvoiceNumber(
  value: string | null | undefined,
): string | null {
  if (!value) return null;

  const cleaned = restoreOcrWordSpacing(value)
    .toUpperCase()
    .replace(/[–—]/g, '-')
    .replace(/[_/\\]+/g, '-')
    .replace(/\s*-\s*/g, '-')
    .replace(/\s+/g, '-')
    .replace(/[^A-Z0-9-]+/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .trim();

  if (!cleaned) return null;

  const yearDashNumber = cleaned.match(/^(\d{4})-0*(\d{1,3})$/);
  if (yearDashNumber) {
    return `${yearDashNumber[1]}-${yearDashNumber[2].padStart(3, '0')}`;
  }

  const compactYearNumber = cleaned.match(/^(\d{4})0*(\d{1,3})$/);
  if (compactYearNumber) {
    return `${compactYearNumber[1]}-${compactYearNumber[2].padStart(3, '0')}`;
  }

  const alphaNumber = cleaned.match(/^([A-Z]+)-?0*(\d+)$/);
  if (alphaNumber) {
    return `${alphaNumber[1]}-${alphaNumber[2]}`;
  }

  return cleaned;
}

function nonEmptyStringCandidate(
  value: string | null,
  score: number,
  evidence_refs: string[] = [],
): ScalarCandidate<string> | null {
  return value
    ? {
        value,
        raw_text: value,
        evidence_refs,
        score,
      }
    : null;
}

function lineCodeLikeValue(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = restoreOcrWordSpacing(value);
  if (!trimmed) return null;
  if (!/[A-Za-z]/.test(trimmed)) return null;
  return /^[A-Za-z0-9][A-Za-z0-9 .\-\/]{0,20}$/.test(trimmed)
    ? trimmed
    : null;
}

export type InvoiceLineCodeResolution = {
  status: 'resolved' | 'rejected' | 'missing';
  value: string | null;
  sourceField: string | null;
  sourceValue: string | null;
  method: 'structured' | 'embedded_text' | 'billing_key' | null;
  rejectedCandidates: Array<{
    sourceField: string;
    value: string;
    reason: 'matches_quantity' | 'missing_alpha_character' | 'invalid_format';
  }>;
};

const INVOICE_LINE_CODE_STRUCTURED_FIELDS = ['line_code', 'lineCode', 'rate_code', 'code'] as const;
const INVOICE_LINE_CODE_TEXT_FIELDS = [
  'raw_text_for_display',
  'rawTextForDisplay',
  'full_row_text',
  'fullRowText',
  'raw_text',
  'rawText',
  'line_text',
  'lineText',
  'text',
  'line_description',
  'lineDescription',
  'description',
  'desc',
] as const;
const INVOICE_LINE_CODE_ORDINAL_RE = /^\d{1,6}(?:st|nd|rd|th)$/i;

function invoiceLineCodeQuantityToken(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value !== 'string') return null;
  const parsed = toAmount(value);
  return parsed == null ? null : String(parsed);
}

function invoiceLineCodeMatchesQuantity(value: string, quantity: unknown): boolean {
  const candidate = toAmount(value);
  const quantityToken = invoiceLineCodeQuantityToken(quantity);
  return candidate != null && quantityToken != null && String(candidate) === quantityToken;
}

function embeddedInvoiceLineCode(value: string): string | null {
  const restored = restoreOcrWordSpacing(value);
  const pattern = /\b(\d{1,4}[A-Za-z]{1,12})\b/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(restored)) != null) {
    const candidate = match[1] ?? '';
    if (!INVOICE_LINE_CODE_ORDINAL_RE.test(candidate)) return candidate;
  }
  return null;
}

/**
 * Resolves a line code from one invoice row only. The result records whether the
 * value came from a typed field, the row's own evidence text, or a billing key,
 * and retains explicit reasons for rejecting structured candidates.
 */
export function resolveInvoiceLineCode(record: Record<string, unknown>): InvoiceLineCodeResolution {
  const quantity = record.quantity ?? record.qty;
  const rejectedCandidates: InvoiceLineCodeResolution['rejectedCandidates'] = [];

  for (const sourceField of INVOICE_LINE_CODE_STRUCTURED_FIELDS) {
    const raw = record[sourceField];
    if (raw == null) continue;
    const value = restoreOcrWordSpacing(String(raw));
    if (!value) continue;
    if (invoiceLineCodeMatchesQuantity(value, quantity)) {
      rejectedCandidates.push({ sourceField, value, reason: 'matches_quantity' });
      continue;
    }
    const resolved = lineCodeLikeValue(value);
    if (resolved) {
      return {
        status: 'resolved',
        value: resolved,
        sourceField,
        sourceValue: value,
        method: 'structured',
        rejectedCandidates,
      };
    }
    rejectedCandidates.push({
      sourceField,
      value,
      reason: /[A-Za-z]/.test(value) ? 'invalid_format' : 'missing_alpha_character',
    });
  }

  for (const sourceField of INVOICE_LINE_CODE_TEXT_FIELDS) {
    const raw = record[sourceField];
    if (typeof raw !== 'string' || raw.trim().length === 0) continue;
    const resolved = embeddedInvoiceLineCode(raw);
    if (resolved) {
      return {
        status: 'resolved',
        value: resolved,
        sourceField,
        sourceValue: restoreOcrWordSpacing(raw),
        method: 'embedded_text',
        rejectedCandidates,
      };
    }
  }

  for (const sourceField of ['billing_rate_key', 'billingRateKey'] as const) {
    const raw = record[sourceField];
    if (raw == null) continue;
    const value = restoreOcrWordSpacing(String(raw));
    if (!value) continue;
    const resolved = embeddedInvoiceLineCode(value);
    if (resolved === value) {
      return {
        status: 'resolved',
        value: resolved,
        sourceField,
        sourceValue: value,
        method: 'billing_key',
        rejectedCandidates,
      };
    }
  }

  return {
    status: rejectedCandidates.length > 0 ? 'rejected' : 'missing',
    value: null,
    sourceField: null,
    sourceValue: null,
    method: null,
    rejectedCandidates,
  };
}

function cleanFlattenedLineDescription(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = restoreOcrWordSpacing(value)
    .replace(/^[\s\S]*?\bQ\s+Quantity\s+Description\s+Unit\s+Price\s+Line\s+Total\b/i, ' ')
    .replace(/\bINVOICE\s+Description\b[\s\S]*$/i, '')
    .replace(/\bSubtotal\b[\s\S]*$/i, '')
    .replace(/\bTOTAL\b[\s\S]*$/i, '')
    .replace(/\bMake all checks payable to\b[\s\S]*$/i, '')
    .replace(/\bTHANK YOU FOR YOUR BUSINESS!?[\s\S]*$/i, '')
    .replace(/\b\d[\d,]*(?:\.\d{1,2})\s+\$?\d[\d,]*(?:\.\d{1,2})\s+\$?\d[\d,]*(?:\.\d{1,2})\b/g, ' ')
    .replace(/\b\d[\d,]*\s+\$\s*\d[\d,]*(?:\.\d{1,2})\s+\$\s*\d[\d,]*(?:\.\d{1,2})\b/g, ' ')
    .replace(/\s+\$?\d[\d,]*(?:\.\d{1,2})\s+\$?\d[\d,]*(?:\.\d{1,2})(?=\s|$)/g, ' ')
    .replace(/\b\d{3}[- ]\d{3}[- ]\d{4}\b/g, ' ')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, ' ')
    .replace(/\b\d{4}-\d{3,4}\b/g, ' ')
    .replace(/[“”]+/g, '"')
    .replace(/\s{2,}/g, ' ')
    .trim();

  if (!normalized || !/[A-Za-z]/.test(normalized)) return null;
  return normalized.length > 220 ? normalized.slice(0, 220).trim() : normalized;
}

function invoiceLineCodeStartFromText(value: string): {
  line_code: string;
  description: string;
  leadingQuantity: number | null;
} | null {
  const normalized = restoreOcrWordSpacing(value);
  const leadingQuantityMatch = normalized.match(
    /^\s*(\d[\d,]*(?:\.\d{1,2})?)\s+(\d{1,4}[A-Z]{1,12})\s*(?:[-:]\s*)?(.*)$/i,
  );
  if (leadingQuantityMatch) {
    const line_code = lineCodeLikeValue(leadingQuantityMatch[2] ?? null);
    const leadingQuantity = toAmount(leadingQuantityMatch[1]);
    if (line_code && leadingQuantity != null) {
      return {
        line_code,
        description: leadingQuantityMatch[3] ?? '',
        leadingQuantity,
      };
    }
  }

  const standardMatch = normalized.match(/^\s*(\d{1,4}[A-Z]{1,12})\s*(?:[-:]\s*)?(.*)$/i);
  const line_code = lineCodeLikeValue(standardMatch?.[1] ?? null);
  if (!line_code || !standardMatch) return null;
  return {
    line_code,
    description: standardMatch[2] ?? '',
    leadingQuantity: null,
  };
}

function validInvoiceAmountTriple(
  quantity: number | null,
  unit_price: number | null,
  line_total: number | null,
  raw_text: string,
): { quantity: number; unit_price: number; line_total: number; raw_text: string } | null {
  if (quantity == null || unit_price == null || line_total == null) return null;
  if (quantity <= 0 || unit_price <= 0 || line_total <= 0) return null;
  const expectedTotal = quantity * unit_price;
  if (Math.abs(expectedTotal - line_total) > Math.max(1, line_total * 0.01)) {
    return null;
  }
  return {
    quantity,
    unit_price,
    line_total,
    raw_text: normalizeWhitespace(raw_text),
  };
}

function extractValidInvoiceAmountTriple(
  value: string,
): { quantity: number; unit_price: number; line_total: number; raw_text: string } | null {
  const text = restoreOcrWordSpacing(value);
  const codeMiddlePattern =
    /(?:^|[^$\d,.])(\d[\d,]*(?:\.\d{1,2})?)\s+\d{1,4}[A-Z]{1,12}\b[\s\S]*?\$\s*([\d,]+(?:\.\d{1,2})?)\s+\$\s*([\d,]+(?:\.\d{1,2})?)(?=\s|$)/gi;
  let codeMiddleMatch: RegExpExecArray | null;
  while ((codeMiddleMatch = codeMiddlePattern.exec(text)) != null) {
    const triple = validInvoiceAmountTriple(
      toAmount(codeMiddleMatch[1]),
      toAmount(codeMiddleMatch[2]),
      toAmount(codeMiddleMatch[3]),
      codeMiddleMatch[0] ?? '',
    );
    if (triple) return triple;
    codeMiddlePattern.lastIndex = (codeMiddleMatch.index ?? 0) + 1;
  }

  const triplePattern =
    /\b(\d[\d,]*(?:\.\d{1,2})?)\s+\$?\s*([\d,]+(?:\.\d{1,2})?)\s+\$?\s*([\d,]+(?:\.\d{1,2})?)(?=\s|$)/g;
  let match: RegExpExecArray | null;
  while ((match = triplePattern.exec(text)) != null) {
    const triple = validInvoiceAmountTriple(
      toAmount(match[1]),
      toAmount(match[2]),
      toAmount(match[3]),
      match[0] ?? '',
    );
    if (triple) return triple;
    triplePattern.lastIndex = (match.index ?? 0) + 1;
  }

  return null;
}

function extractLineOrientedFlattenedLineItemsFromText(text: string): InvoiceLineItem[] {
  if (!/\r?\n/.test(text)) return [];
  const amountRegion = text.split(/subtotal/i)[0] ?? text;
  const blocks: Array<{
    line_code: string;
    leadingQuantity: number | null;
    lines: string[];
  }> = [];
  let current: { line_code: string; leadingQuantity: number | null; lines: string[] } | null = null;

  for (const rawLine of amountRegion.split(/\r?\n/)) {
    const line = normalizeWhitespace(rawLine);
    if (!line) continue;
    if (/^(?:Q\s+)?Quantity\s+Description\s+Unit\s+Price\s+Line\s+Total$/i.test(line)) continue;
    if (/^(?:INVOICE|Bill To|Due Date|Invoice Number|Invoice Date|Emergency Agmt)\b/i.test(line)) continue;

    const start = invoiceLineCodeStartFromText(line);
    if (start) {
      if (current) blocks.push(current);
      current = {
        line_code: start.line_code,
        leadingQuantity: start.leadingQuantity,
        lines: [start.description],
      };
      continue;
    }

    if (current) current.lines.push(line);
  }
  if (current) blocks.push(current);

  const rows = blocks.flatMap((block) => {
    const raw_text = normalizeWhitespace(`${block.line_code} ${block.lines.join(' ')}`);
    const line_description = cleanFlattenedLineDescription(block.lines.join(' '));
    if (!line_description) return [];
    const amount = extractValidInvoiceAmountTriple(
      block.leadingQuantity == null
        ? block.lines.join(' ')
        : `${block.leadingQuantity} ${block.line_code} ${block.lines.join(' ')}`,
    );
    const billingKeys = deriveBillingKeysForInvoiceLine({
      rate_code: block.line_code,
      description: line_description,
      service_item: line_description,
      material: null,
    });

    return [{
      line_code: block.line_code,
      line_description,
      quantity: amount?.quantity ?? block.leadingQuantity,
      unit: null,
      unit_price: amount?.unit_price ?? null,
      line_total: amount?.line_total ?? null,
      billing_rate_key: billingKeys.billing_rate_key,
      description_match_key: billingKeys.description_match_key,
      description: line_description,
      total: amount?.line_total ?? null,
      evidence_refs: [],
      raw_text: normalizeWhitespace(`${raw_text} ${amount?.raw_text ?? ''}`),
    }];
  });

  const unique = new Map<string, InvoiceLineItem>();
  for (const row of rows) {
    if (!row.line_code || unique.has(row.line_code)) continue;
    unique.set(row.line_code, row);
  }
  return [...unique.values()].sort((left, right) =>
    compareInvoiceLineCodes(String(left.line_code ?? ''), String(right.line_code ?? '')),
  );
}

function compareInvoiceLineCodes(left: string, right: string): number {
  const leftMatch = left.match(/^(\d+)([A-Z]+)$/i);
  const rightMatch = right.match(/^(\d+)([A-Z]+)$/i);
  if (leftMatch && rightMatch) {
    const leftNumber = Number(leftMatch[1]);
    const rightNumber = Number(rightMatch[1]);
    if (leftNumber !== rightNumber) return leftNumber - rightNumber;
    return leftMatch[2].localeCompare(rightMatch[2]);
  }
  return left.localeCompare(right, undefined, { numeric: true });
}

function extractClientFromUnlabeledText(text: string): string | null {
  const agencyMatches = Array.from(
    text.matchAll(
      /\b([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+)*\s+(?:County|City|Town|Village)\s+[A-Za-z][A-Za-z &]+(?:Dept|Department|Office|Authority|District|Public Works))\b/g,
    ),
  )
    .map((match) => cleanPartyName(match[1] ?? null))
    .filter((value): value is string => value != null);

  if (agencyMatches.length > 0) {
    return agencyMatches.sort((left, right) => right.length - left.length)[0] ?? null;
  }

  const fallbackMatches = Array.from(
    text.matchAll(
      /\b([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+)*\s+(?:County|City|Town|Village)(?:,\s*[A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+)*)?)\b/g,
    ),
  )
    .map((match) => cleanPartyName(match[1] ?? null))
    .filter((value): value is string => value != null);

  return fallbackMatches[0] ?? null;
}

function extractFlattenedLineItemsFromText(text: string): InvoiceLineItem[] {
  const lineOrientedRows = extractLineOrientedFlattenedLineItemsFromText(text);
  if (lineOrientedRows.length > 0) return lineOrientedRows;

  const amountRegion = text.split(/subtotal/i)[0] ?? text;
  const amountMatches: Array<{ quantity: number; unit_price: number; line_total: number; raw_text: string }> = [];
  const amountPattern =
    /(\d[\d,]*(?:\.\d{1,2})?)\s*\$?\s*([\d,]+(?:\.\d{1,2})?)\s*\$?\s*([\d,]+(?:\.\d{1,2})?)(?=\s|$)/g;
  let amountMatch: RegExpExecArray | null;
  while ((amountMatch = amountPattern.exec(amountRegion)) != null) {
    const amount = validInvoiceAmountTriple(
      toAmount(amountMatch[1]),
      toAmount(amountMatch[2]),
      toAmount(amountMatch[3]),
      amountMatch[0] ?? '',
    );
    if (amount && !amountMatches.some((existing) => existing.raw_text === amount.raw_text)) {
      amountMatches.push(amount);
    }
    amountPattern.lastIndex = (amountMatch.index ?? 0) + 1;
  }

  const descriptionRegionMatch = text.match(
    /(?:Emergency\s+Agmt[\s\S]*?)((?:\b\d+[A-Z]\s*-\s*[\s\S]+))(?:Make all checks payable to|THANK YOU FOR YOUR BUSINESS|$)/i,
  );
  const descriptionRegion = descriptionRegionMatch?.[1] ?? text;
  const descriptionMatches = Array.from(
    descriptionRegion.matchAll(
      /\b(\d+[A-Z])\s*-\s*([\s\S]*?)(?=(?:\b(?:\d[\d,]*(?:\.\d{1,2})?[ \t]+)?\d+[A-Z]\s*-\s*)|Make all checks payable to|THANK YOU FOR YOUR BUSINESS|$)/gi,
    ),
  ).flatMap((match) => {
    const line_code = lineCodeLikeValue(match[1] ?? null);
    const line_description = cleanFlattenedLineDescription(match[2] ?? null);
    if (!line_code || !line_description) return [];
    return [{
      line_code,
      line_description,
      raw_text: normalizeWhitespace(match[0] ?? ''),
      start: match.index ?? 0,
    }];
  });

  const uniqueDescriptions = Array.from(
    descriptionMatches.reduce((map, item) => {
      if (!map.has(item.line_code)) {
        map.set(item.line_code, item);
      }
      return map;
    }, new Map<string, { line_code: string; line_description: string; raw_text: string; start: number }>()),
  )
    .map(([, item]) => item)
    .sort((left, right) => compareInvoiceLineCodes(left.line_code, right.line_code));

  if (uniqueDescriptions.length === 0) return [];

  if (amountMatches.length < uniqueDescriptions.length) {
    const descriptionsBySourceOrder = [...uniqueDescriptions].sort((left, right) => left.start - right.start);
    const nextStartByCode = new Map<string, number>();
    descriptionsBySourceOrder.forEach((description, index) => {
      nextStartByCode.set(description.line_code, descriptionsBySourceOrder[index + 1]?.start ?? descriptionRegion.length);
    });

    return uniqueDescriptions.map((description) => {
      const amount = extractAmountsNearFlattenedDescription(
        descriptionRegion,
        description.line_code,
        description.start,
        nextStartByCode.get(description.line_code) ?? descriptionRegion.length,
      );
      const billingKeys = deriveBillingKeysForInvoiceLine({
        rate_code: description.line_code,
        description: description.line_description,
        service_item: description.line_description,
        material: null,
      });

      return {
        line_code: description.line_code,
        line_description: description.line_description,
        quantity: amount?.quantity ?? null,
        unit: null,
        unit_price: amount?.unit_price ?? null,
        line_total: amount?.line_total ?? null,
        billing_rate_key: billingKeys.billing_rate_key,
        description_match_key: billingKeys.description_match_key,
        description: description.line_description,
        total: amount?.line_total ?? null,
        evidence_refs: [],
        raw_text: normalizeWhitespace(`${description.raw_text} ${amount?.raw_text ?? ''}`),
      };
    });
  }

  return uniqueDescriptions.map((description, index) => {
    const amount = amountMatches[index]!;
    const billingKeys = deriveBillingKeysForInvoiceLine({
      rate_code: description.line_code,
      description: description.line_description,
      service_item: description.line_description,
      material: null,
    });

    return {
      line_code: description.line_code,
      line_description: description.line_description,
      quantity: amount.quantity,
      unit: null,
      unit_price: amount.unit_price,
      line_total: amount.line_total,
      billing_rate_key: billingKeys.billing_rate_key,
      description_match_key: billingKeys.description_match_key,
      description: description.line_description,
      total: amount.line_total,
      evidence_refs: [],
      raw_text: `${description.raw_text} ${amount.raw_text}`.trim(),
    };
  });
}

function extractAmountsNearFlattenedDescription(
  descriptionRegion: string,
  lineCode: string,
  start: number,
  nextStart: number,
): { quantity: number; unit_price: number; line_total: number; raw_text: string } | null {
  const windowStart = Math.max(0, start - 48);
  const prefixBlock = descriptionRegion.slice(windowStart, Math.max(nextStart, start));
  const block = descriptionRegion.slice(start, Math.max(nextStart, start));
  const codeEsc = escapeRegExp(lineCode);
  const codeMiddle = prefixBlock.match(
    new RegExp(`(?:^|[^$\\d,.])(\\d[\\d,]*(?:\\.\\d{1,2})?)[ \\t]+${codeEsc}\\b[\\s\\S]*?\\$?\\s*([\\d,]+(?:\\.\\d{1,2})?)\\s+\\$?\\s*([\\d,]+(?:\\.\\d{1,2})?)(?=\\s|$)`, 'i'),
  );
  const decimalQuantityTriple = block.match(
    /\b(\d[\d,]*(?:\.\d{1,2}))\s+\$?\s*([\d,]+(?:\.\d{1,2})?)\s+\$?\s*([\d,]+(?:\.\d{1,2})?)(?=\s|$)/,
  );
  const integerQuantityDollarTriple = block.match(
    /\b(\d[\d,]*)\s+\$\s*([\d,]+(?:\.\d{1,2})?)\s+\$\s*([\d,]+(?:\.\d{1,2})?)(?=\s|$)/,
  );
  const triple =
    codeMiddle
    ?? decimalQuantityTriple
    ?? integerQuantityDollarTriple;
  if (!triple) return null;
  return validInvoiceAmountTriple(
    toAmount(triple[1]),
    toAmount(triple[2]),
    toAmount(triple[3]),
    triple[0] ?? '',
  );
}

function invoiceRateCodeToken(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = restoreOcrWordSpacing(value).match(/^\s*(\d{1,4}[A-Za-z]{1,12})\b/);
  return match?.[1] ?? null;
}

function invoiceLineCodeToken(value: unknown): string | null {
  const record = asRecord(value);
  if (!record) return null;
  return (
    invoiceRateCodeToken(record.line_code)
    ?? invoiceRateCodeToken(record.lineCode)
    ?? invoiceRateCodeToken(record.rate_code)
    ?? invoiceRateCodeToken(record.code)
  );
}

function invoiceLineText(value: unknown): string {
  const record = asRecord(value);
  if (!record) return '';
  return normalizeWhitespace(
    [
      record.line_description,
      record.lineDescription,
      record.description,
      record.desc,
      record.raw_text_for_display,
      record.rawTextForDisplay,
      record.full_row_text,
      record.fullRowText,
      record.raw_text,
      record.rawText,
      record.line_text,
      record.lineText,
      record.text,
    ]
      .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      .join(' '),
  );
}

function invoiceLineHasCompleteAmounts(value: unknown): boolean {
  const record = asRecord(value);
  if (!record) return false;
  return (
    recordNumber(record.quantity ?? record.qty) != null
    && recordNumber(record.unit_price ?? record.unitPrice ?? record.price ?? record.unitRate ?? record.unit_rate) != null
    && recordNumber(record.line_total ?? record.lineTotal ?? record.total ?? record.amount) != null
  );
}

type InvoiceLineQualitySummary = {
  count: number;
  codeCount: number;
  completeAmountCount: number;
  proseCount: number;
};

function invoiceLineQuality(lines: readonly unknown[]): InvoiceLineQualitySummary {
  return lines.reduce<InvoiceLineQualitySummary>(
    (summary, line) => {
      summary.count += 1;
      if (invoiceLineCodeToken(line)) summary.codeCount += 1;
      if (invoiceLineHasCompleteAmounts(line)) summary.completeAmountCount += 1;
      if (/[A-Za-z]/.test(invoiceLineText(line))) summary.proseCount += 1;
      return summary;
    },
    { count: 0, codeCount: 0, completeAmountCount: 0, proseCount: 0 },
  );
}

function shouldPreferRecoveredInvoiceLines(
  currentLines: readonly unknown[],
  recoveredLines: readonly InvoiceLineItem[],
): boolean {
  if (recoveredLines.length === 0) return false;
  const current = invoiceLineQuality(currentLines);
  const recovered = invoiceLineQuality(recoveredLines);
  if (recovered.codeCount <= current.codeCount) return false;
  if (current.count > 0 && recovered.count < current.count) return false;
  if (recovered.codeCount < Math.max(1, Math.ceil(recovered.count * 0.6))) return false;
  if (
    current.completeAmountCount > 0
    && recovered.completeAmountCount < Math.min(current.completeAmountCount, recovered.count)
  ) {
    return false;
  }
  return true;
}

function uniqueInvoiceRecoveryTextParts(parts: Array<string | null | undefined>): string {
  return uniqueStrings(parts).join('\n');
}

export function invoiceRecoveryTextFromExtractionData(extractionData: unknown): string {
  const payload = asRecord(extractionData);
  const extraction = asRecord(payload?.extraction);
  const evidenceV1 = asRecord(extraction?.evidence_v1);
  const contentLayers = asRecord(extraction?.content_layers_v1);
  const pdf = asRecord(contentLayers?.pdf);
  const pdfText = asRecord(pdf?.text);
  const pdfTables = asRecord(pdf?.tables);

  const pageTextParts: Array<string | null | undefined> = [];
  for (const page of asArray<Record<string, unknown>>(evidenceV1?.page_text)) {
    if (typeof page.text === 'string') pageTextParts.push(page.text);
  }
  if (uniqueStrings(pageTextParts).length > 0) return uniqueInvoiceRecoveryTextParts(pageTextParts);

  if (typeof pdfText?.combined_text === 'string' && pdfText.combined_text.trim().length > 0) {
    return pdfText.combined_text;
  }

  const blockParts: Array<string | null | undefined> = [];
  for (const page of asArray<Record<string, unknown>>(pdfText?.pages)) {
    for (const block of asArray<Record<string, unknown>>(page.plain_text_blocks)) {
      if (typeof block.text === 'string') blockParts.push(block.text);
      if (typeof block.nearby_text === 'string') blockParts.push(block.nearby_text);
    }
  }
  if (uniqueStrings(blockParts).length > 0) return uniqueInvoiceRecoveryTextParts(blockParts);

  const tableParts: Array<string | null | undefined> = [];
  for (const table of asArray<Record<string, unknown>>(pdfTables?.tables)) {
    tableParts.push(...asArray<string>(table.header_context));
    for (const row of asArray<Record<string, unknown>>(table.rows)) {
      if (typeof row.raw_text === 'string') tableParts.push(row.raw_text);
      if (typeof row.nearby_text === 'string') tableParts.push(row.nearby_text);
      for (const cell of asArray<Record<string, unknown>>(row.cells)) {
        if (typeof cell.text === 'string') tableParts.push(cell.text);
      }
    }
  }
  if (uniqueStrings(tableParts).length > 0) return uniqueInvoiceRecoveryTextParts(tableParts);

  const evidenceParts: Array<string | null | undefined> = [];
  for (const evidence of asArray<Record<string, unknown>>(pdf?.evidence)) {
    if (typeof evidence.text === 'string') evidenceParts.push(evidence.text);
    const location = asRecord(evidence.location);
    if (typeof location?.nearby_text === 'string') evidenceParts.push(location.nearby_text);
  }
  if (uniqueStrings(evidenceParts).length > 0) return uniqueInvoiceRecoveryTextParts(evidenceParts);

  return typeof extraction?.text_preview === 'string' ? extraction.text_preview : '';
}

export function recoverInvoiceLineItemsFromRichText(text: string | null | undefined): InvoiceLineItem[] {
  return typeof text === 'string' && text.trim().length > 0
    ? extractFlattenedLineItemsFromText(text)
    : [];
}

export function recoverInvoiceLineItemsFromExtractionData(params: {
  lineItems: unknown;
  extractionData?: unknown;
  fallbackText?: string | null;
}): unknown[] {
  const currentLines = asArray<unknown>(params.lineItems);
  const richText = uniqueInvoiceRecoveryTextParts([
    params.fallbackText ?? null,
    invoiceRecoveryTextFromExtractionData(params.extractionData),
  ]);
  const recoveredLines = recoverInvoiceLineItemsFromRichText(richText);
  return shouldPreferRecoveredInvoiceLines(currentLines, recoveredLines)
    ? recoveredLines
    : currentLines;
}

function formatIsoDate(year: number, month: number, day: number): string | null {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (!Number.isFinite(date.getTime())) return null;
  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
  ) {
    return null;
  }
  return [
    String(year).padStart(4, '0'),
    String(month).padStart(2, '0'),
    String(day).padStart(2, '0'),
  ].join('-');
}

function normalizeYear(yearText: string): number | null {
  const parsed = Number(yearText);
  if (!Number.isFinite(parsed)) return null;
  if (yearText.length <= 2) return 2000 + parsed;
  return parsed;
}

function normalizeDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = normalizeWhitespace(value)
    .replace(/\bthe\s+date\s+of\b/gi, '')
    .replace(/,\s*/g, ' ')
    .trim();
  const slashMatch = normalized.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (slashMatch) {
    const month = Number(slashMatch[1]);
    const day = Number(slashMatch[2]);
    const year = normalizeYear(slashMatch[3]);
    return year != null ? formatIsoDate(year, month, day) : null;
  }

  const ordinalDayOfMonth = normalized.match(
    /^(\d{1,2})(?:st|nd|rd|th)?\s+day\s+of\s+([A-Za-z]+)\s+(\d{4})$/i,
  );
  if (ordinalDayOfMonth) {
    const day = Number(ordinalDayOfMonth[1]);
    const month = MONTHS[ordinalDayOfMonth[2].toLowerCase()];
    const year = Number(ordinalDayOfMonth[3]);
    return month ? formatIsoDate(year, month, day) : null;
  }

  const dayMonthYear = normalized.match(
    /^(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+)\s+(\d{4})$/i,
  );
  if (dayMonthYear) {
    const day = Number(dayMonthYear[1]);
    const month = MONTHS[dayMonthYear[2].toLowerCase()];
    const year = Number(dayMonthYear[3]);
    return month ? formatIsoDate(year, month, day) : null;
  }

  const monthDayYear = normalized.match(
    /^([A-Za-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?\s+(\d{4})$/i,
  );
  if (monthDayYear) {
    const month = MONTHS[monthDayYear[1].toLowerCase()];
    const day = Number(monthDayYear[2]);
    const year = Number(monthDayYear[3]);
    return month ? formatIsoDate(year, month, day) : null;
  }

  const inlineMatch = normalized.match(DATE_VALUE_RE);
  if (inlineMatch) {
    return normalizeDate(inlineMatch[0]);
  }

  return null;
}

function extractInlineDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const match = String(value).match(DATE_VALUE_RE);
  return match ? normalizeDate(match[0]) : null;
}

function bestStringCandidate(
  candidates: Array<ScalarCandidate<string> | null>,
): ScalarCandidate<string> | null {
  return candidates
    .filter((candidate): candidate is ScalarCandidate<string> => candidate != null)
    .sort((left, right) => right.score - left.score)[0] ?? null;
}

function bestAmountCandidate(candidates: AmountCandidate[]): AmountCandidate | null {
  const sorted = [...candidates].sort((left, right) =>
    right.score - left.score
    || right.value - left.value
    || right.evidence_refs.length - left.evidence_refs.length,
  );
  const best = sorted[0] ?? null;
  if (!best) return null;

  const largerClearlyLabeled = sorted.find((candidate) =>
    candidate !== best
    && candidate.value >= best.value * 1.5
    && candidate.score >= best.score - 18
  );
  return largerClearlyLabeled ?? best;
}

function invoicePdfContext(contentLayers: InvoiceContentLayers): {
  tables: PdfTable[];
  forms: PdfFormField[];
  evidence: EvidenceObject[];
} {
  const pdf = contentLayers?.pdf;
  return {
    tables: asArray<PdfTable>(pdf?.tables?.tables),
    forms: asArray<PdfFormField>(pdf?.forms?.fields),
    evidence: asArray<EvidenceObject>(pdf?.evidence),
  };
}

function formCandidate(
  forms: PdfFormField[],
  aliases: readonly string[],
  transform?: (value: string) => string | null,
  score = 100,
): ScalarCandidate<string> | null {
  for (const field of forms) {
    if (!matchAnyAlias(field.label, aliases)) continue;
    const rawValue = normalizeWhitespace(field.value);
    const value = transform ? transform(rawValue) : rawValue;
    if (!value) continue;
    return {
      value,
      raw_text: rawValue,
      evidence_refs: [field.id],
      score,
    };
  }
  return null;
}

function evidenceCandidateByRegex(
  evidence: EvidenceObject[],
  regex: RegExp,
  score: number,
  transform?: (value: string) => string | null,
): ScalarCandidate<string> | null {
  for (const item of evidence) {
    const haystack = evidenceHaystack(item);
    if (!haystack) continue;
    const match = haystack.match(regex);
    if (!match) continue;
    const captured = normalizeWhitespace(match[1] ?? match[0] ?? '');
    const value = transform ? transform(captured) : captured;
    if (!value) continue;
    return {
      value,
      raw_text: haystack,
      evidence_refs: [item.id],
      score,
    };
  }
  return null;
}

function subtotalLabelScore(label: string): number {
  const normalized = normalizeLabel(label);
  if (normalized.includes('subtotal')) return 112;
  if (normalized.includes('sub total')) return 110;
  return 100;
}

function billedTotalLabelScore(label: string): number {
  const normalized = normalizeLabel(label);
  if (normalized.includes('invoice total')) return 122;
  if (normalized.includes('total this invoice')) return 120;
  if (normalized.includes('grand total')) return 118;
  if (normalized.includes('total amount')) return 116;
  if (normalized.includes('billed total')) return 114;
  if (normalized.includes('total billed')) return 112;
  if (normalized === 'total') return 108;
  return 96;
}

function currentAmountDueLabelScore(label: string): number {
  const normalized = normalizeLabel(label);
  if (normalized.includes('current amount due')) return 126;
  if (normalized.includes('current payment due')) return 124;
  if (normalized.includes('total amount due')) return 122;
  if (normalized.includes('amount due')) return 120;
  if (normalized.includes('total due')) return 118;
  if (normalized.includes('balance due')) return 116;
  return 110;
}

function hasDisqualifyingTotalContext(label: string): boolean {
  const normalized = normalizeLabel(label);
  if (normalized.includes('line total')) return true;
  if (normalized.includes('line amount')) return true;
  if (normalized.includes('extended amount')) return true;
  if (normalized.includes('extended total')) return true;
  if (normalized.includes('unit price') && normalized.includes('total')) return true;
  if (normalized.includes('quantity') && normalized.includes('total')) return true;
  if (normalized.includes('qty') && normalized.includes('total')) return true;
  if (normalized.includes('page') && normalized.includes('total')) return true;
  return false;
}

function isCurrentAmountDueLabel(label: string): boolean {
  return !hasDisqualifyingTotalContext(label)
    && matchAnyPhraseAlias(label, CURRENT_AMOUNT_DUE_LABELS);
}

function isBilledTotalLabel(label: string): boolean {
  return !hasDisqualifyingTotalContext(label)
    && matchAnyPhraseAlias(label, BILLED_TOTAL_LABELS);
}

function isTotalsLabel(label: string): boolean {
  return isCurrentAmountDueLabel(label) || isBilledTotalLabel(label);
}

function isSubtotalLabel(label: string): boolean {
  return matchAnyPhraseAlias(label, SUBTOTAL_LABELS);
}

function looksLikeTotalsText(text: string): boolean {
  const normalized = normalizeLabel(text);
  return isTotalsLabel(normalized) || isSubtotalLabel(normalized);
}

function evidenceHaystack(item: Pick<EvidenceObject, 'location' | 'text' | 'value'>): string {
  return normalizeWhitespace([
    item.location.label,
    item.text,
    typeof item.value === 'string' ? item.value : null,
    item.location.nearby_text,
  ].filter(Boolean).join(' | '));
}

function amountSemanticScore(kind: AmountSemantic, label: string): number {
  if (kind === 'subtotal') return subtotalLabelScore(label);
  if (kind === 'current_due') return currentAmountDueLabelScore(label);
  return billedTotalLabelScore(label);
}

function addAmountCandidate(
  buckets: {
    subtotalCandidates: AmountCandidate[];
    totalCandidates: AmountCandidate[];
    currentDueCandidates: AmountCandidate[];
  },
  kind: AmountSemantic,
  candidate: AmountCandidate,
): void {
  if (kind === 'subtotal') {
    buckets.subtotalCandidates.push(candidate);
    return;
  }
  if (kind === 'current_due') {
    buckets.currentDueCandidates.push(candidate);
    return;
  }
  buckets.totalCandidates.push(candidate);
}

function genericTotalContextDisqualifies(text: string, matchIndex: number): boolean {
  const prefix = normalizeLabel(text.slice(Math.max(0, matchIndex - 24), matchIndex));
  return prefix.endsWith('line')
    || prefix.endsWith('unit price line')
    || prefix.endsWith('quantity line')
    || prefix.endsWith('qty line')
    || prefix.endsWith('page');
}

function collectLabeledAmounts(value: string): Array<{
  kind: AmountSemantic;
  label: string;
  raw_text: string;
  amount: number;
}> {
  const source = String(value ?? '');
  if (!source.trim()) return [];

  const specs: Array<{ kind: AmountSemantic; labels: readonly string[] }> = [
    { kind: 'subtotal', labels: SUBTOTAL_LABELS },
    { kind: 'current_due', labels: CURRENT_AMOUNT_DUE_LABELS },
    { kind: 'total', labels: BILLED_TOTAL_LABELS },
  ];
  const matches: Array<{
    kind: AmountSemantic;
    label: string;
    raw_text: string;
    amount: number;
  }> = [];

  for (const spec of specs) {
    for (const label of spec.labels) {
      const labelPattern = label
        .split(/\s+/)
        .filter((part) => part.length > 0)
        .map((part) => escapeRegExp(part))
        .join('\\s*');
      const regex = new RegExp(
        `(${labelPattern})(?=[\\s:\\-=]*\\$?\\s*[\\d,])\\s*[:\\-=]?\\s*\\$?\\s*${AMOUNT_CAPTURE}\\$?`,
        'ig',
      );
      let match: RegExpExecArray | null = null;
      while ((match = regex.exec(source)) !== null) {
        const previousChar = match.index > 0 ? source[match.index - 1] : '';
        if (/[A-Za-z0-9]/.test(previousChar)) continue;
        const matchedLabel = normalizeWhitespace(match[1] ?? label);
        const amount = toAmount(match[2]);
        if (amount == null) continue;
        if (
          spec.kind === 'total'
          && normalizeLabel(matchedLabel) === 'total'
          && genericTotalContextDisqualifies(source, match.index)
        ) {
          continue;
        }
        matches.push({
          kind: spec.kind,
          label: matchedLabel,
          raw_text: normalizeWhitespace(match[0] ?? `${matchedLabel} ${match[2] ?? ''}`),
          amount,
        });
      }
    }
  }

  return matches;
}

function addRegexAmountCandidates(params: {
  text: string;
  evidence_refs: string[];
  source_bonus: number;
  buckets: {
    subtotalCandidates: AmountCandidate[];
    totalCandidates: AmountCandidate[];
    currentDueCandidates: AmountCandidate[];
  };
}): void {
  for (const match of collectLabeledAmounts(params.text)) {
    addAmountCandidate(params.buckets, match.kind, {
      value: match.amount,
      label: match.label,
      raw_text: match.raw_text,
      evidence_refs: params.evidence_refs,
      score: amountSemanticScore(match.kind, match.label) + params.source_bonus,
    });
  }
}

function headerIndex(headers: readonly string[], aliases: readonly string[]): number | null {
  let bestIndex: number | null = null;
  let bestLength = 0;
  headers.forEach((header, index) => {
    const normalized = normalizeLabel(header);
    aliases.forEach((alias) => {
      const aliasLabel = normalizeLabel(alias);
      if (
        normalized === aliasLabel
        || normalized.startsWith(`${aliasLabel} `)
        || normalized.endsWith(` ${aliasLabel}`)
        || normalized.includes(aliasLabel)
      ) {
        if (aliasLabel.length > bestLength) {
          bestIndex = index;
          bestLength = aliasLabel.length;
        }
      }
    });
  });
  return bestIndex;
}

function moneyLikeCellCount(row: PdfTableRow): number {
  return row.cells.filter((cell) => toAmount(cell.text) != null).length;
}

function looksLikeLineItemRow(row: PdfTableRow, table: PdfTable | null): boolean {
  const raw = normalizeWhitespace(row.raw_text);
  if (!raw) return false;
  if (looksLikeTotalsText(raw)) return false;
  const moneyCells = moneyLikeCellCount(row);
  if (moneyCells >= 2) return true;
  const headers = table ? table.headers : [];
  const quantityIdx = table ? headerIndex(headers, HEADER_QUANTITY_ALIASES) : null;
  const unitPriceIdx = table ? headerIndex(headers, HEADER_UNIT_PRICE_ALIASES) : null;
  const totalIdx = table ? headerIndex(headers, HEADER_TOTAL_ALIASES) : null;
  if (quantityIdx != null || unitPriceIdx != null || totalIdx != null) {
    return true;
  }
  return /(?:qty|quantity|unit price|line total|amount)/i.test(raw);
}

function looksLikeLineItemTable(table: PdfTable): boolean {
  const headers = [...table.headers, ...table.header_context]
    .map((value) => normalizeLabel(value))
    .filter((value) => value.length > 0);
  const headerHits = LINE_TABLE_SIGNAL_ALIASES.filter((alias) =>
    headers.some((header) => header.includes(normalizeLabel(alias))),
  ).length;
  if (headerHits >= 2) return true;
  return table.rows.some((row) => looksLikeLineItemRow(row, table));
}

function codeLikeValue(value: string | null | undefined): string | null {
  return lineCodeLikeValue(value);
}

function cellText(row: PdfTableRow, index: number | null): string | null {
  if (index == null) return null;
  const value = row.cells[index]?.text;
  return typeof value === 'string' ? normalizeWhitespace(value) : null;
}

function fallbackLineDescription(row: PdfTableRow, usedIndexes: Set<number>): string | null {
  const textCells = row.cells
    .map((cell, index) => ({ index, text: normalizeWhitespace(cell.text) }))
    .filter((cell) => cell.text.length > 0 && !usedIndexes.has(cell.index));
  const textCell = textCells.find((cell) => /[A-Za-z]/.test(cell.text) && toAmount(cell.text) == null);
  return textCell?.text ?? null;
}

function parseInvoiceLineRow(row: PdfTableRow, table: PdfTable): InvoiceLineItem | null {
  if (!looksLikeLineItemRow(row, table)) return null;
  const headers = table.headers;
  const codeIdx = headerIndex(headers, HEADER_CODE_ALIASES);
  const descriptionIdx = headerIndex(headers, HEADER_DESCRIPTION_ALIASES);
  const quantityIdx = headerIndex(headers, HEADER_QUANTITY_ALIASES);
  const unitIdx = headerIndex(headers, HEADER_UNIT_ALIASES);
  const unitPriceIdx = headerIndex(headers, HEADER_UNIT_PRICE_ALIASES);
  const totalIdx = headerIndex(headers, HEADER_TOTAL_ALIASES);

  const usedIndexes = new Set<number>(
    [codeIdx, descriptionIdx, quantityIdx, unitIdx, unitPriceIdx, totalIdx]
      .filter((value): value is number => typeof value === 'number'),
  );

  const line_code = codeLikeValue(cellText(row, codeIdx) ?? row.cells[0]?.text ?? null);
  const line_description =
    cellText(row, descriptionIdx)
    ?? fallbackLineDescription(row, usedIndexes)
    ?? null;
  const quantity =
    toAmount(cellText(row, quantityIdx))
    ?? row.cells
      .map((cell, index) => ({ index, value: toAmount(cell.text) }))
      .find((cell) => cell.value != null && !usedIndexes.has(cell.index))
      ?.value
    ?? null;
  const unit = cellText(row, unitIdx);

  const amountCells = row.cells
    .map((cell) => toAmount(cell.text))
    .filter((value): value is number => value != null);

  const explicitUnitPrice = toAmount(cellText(row, unitPriceIdx));
  const explicitLineTotal = toAmount(cellText(row, totalIdx));
  const unit_price = explicitUnitPrice ?? (
    amountCells.length >= 2
      ? amountCells[amountCells.length - 2] ?? null
      : null
  );
  const line_total = explicitLineTotal ?? (
    amountCells.length >= 1
      ? amountCells[amountCells.length - 1] ?? null
      : null
  );

  if (!line_code && !line_description) return null;
  if (line_description && looksLikeTotalsText(line_description)) return null;
  if (line_total == null && unit_price == null && quantity == null) return null;

  const billingKeys = deriveBillingKeysForInvoiceLine({
    rate_code: line_code,
    description: line_description,
    service_item: line_description,
    material: null,
  });

  return {
    line_code,
    line_description,
    quantity,
    unit,
    unit_price,
    line_total,
    billing_rate_key: billingKeys.billing_rate_key,
    description_match_key: billingKeys.description_match_key,
    description: line_description,
    total: line_total,
    evidence_refs: [row.id],
    raw_text: normalizeWhitespace(row.raw_text),
  };
}

function extractLineItemsFromTables(tables: PdfTable[]): InvoiceLineItem[] {
  const lineItems: InvoiceLineItem[] = [];
  for (const table of tables) {
    if (!looksLikeLineItemTable(table)) continue;
    for (const row of table.rows) {
      const line = parseInvoiceLineRow(row, table);
      if (!line) continue;
      lineItems.push(line);
    }
  }
  return lineItems;
}

function extractLineItemsFromText(text: string): InvoiceLineItem[] {
  const lines = text.split(/\r?\n/).map((line) => normalizeWhitespace(line)).filter(Boolean);
  const out: InvoiceLineItem[] = [];

  for (const line of lines) {
    const match = line.match(TEXT_LINE_ITEM_RE);
    if (!match) continue;
    const { line_code, line_description } = splitTextLinePrefix(match[1] ?? '');
    const quantity = toAmount(match[2]);
    const unit = normalizeWhitespace(match[3] ?? '');
    const unit_price = toAmount(match[4]);
    const line_total = toAmount(match[5]);
    if (!line_description) continue;
    const billingKeys = deriveBillingKeysForInvoiceLine({
      rate_code: line_code,
      description: line_description,
      service_item: line_description,
      material: null,
    });
    out.push({
      line_code,
      line_description,
      quantity,
      unit,
      unit_price,
      line_total,
      billing_rate_key: billingKeys.billing_rate_key,
      description_match_key: billingKeys.description_match_key,
      description: line_description,
      total: line_total,
      evidence_refs: [],
      raw_text: line,
    });
  }

  return out;
}

function extractAmountCandidates(params: {
  text: string;
  forms: PdfFormField[];
  tables: PdfTable[];
  evidence: EvidenceObject[];
}): {
  subtotalCandidates: AmountCandidate[];
  totalCandidates: AmountCandidate[];
  currentDueCandidates: AmountCandidate[];
} {
  const subtotalCandidates: AmountCandidate[] = [];
  const totalCandidates: AmountCandidate[] = [];
  const currentDueCandidates: AmountCandidate[] = [];
  const buckets = { subtotalCandidates, totalCandidates, currentDueCandidates };

  for (const field of params.forms) {
    const label = field.label;
    const amount = toAmount(field.value) ?? lastAmountInText(field.value);
    if (amount != null && isSubtotalLabel(label)) {
      addAmountCandidate(buckets, 'subtotal', {
        value: amount,
        label,
        raw_text: field.value,
        evidence_refs: [field.id],
        score: subtotalLabelScore(label) + 18,
      });
    }
    if (amount != null && isCurrentAmountDueLabel(label)) {
      addAmountCandidate(buckets, 'current_due', {
        value: amount,
        label,
        raw_text: field.value,
        evidence_refs: [field.id],
        score: currentAmountDueLabelScore(label) + 18,
      });
    }
    if (amount != null && isBilledTotalLabel(label)) {
      addAmountCandidate(buckets, 'total', {
        value: amount,
        label,
        raw_text: field.value,
        evidence_refs: [field.id],
        score: billedTotalLabelScore(label) + 18,
      });
    }
    addRegexAmountCandidates({
      text: `${field.label} ${field.value}`,
      evidence_refs: [field.id],
      source_bonus: 18,
      buckets,
    });
  }

  for (const table of params.tables) {
    for (const row of table.rows) {
      const raw = normalizeWhitespace(row.raw_text);
      if (looksLikeLineItemRow(row, table)) continue;
      const amount = lastAmountInText(raw);
      const rowLabel = normalizeWhitespace([
        row.cells[0]?.text,
        row.cells[1]?.text,
      ].filter(Boolean).join(' '));
      const resolvedLabel = rowLabel || raw;
      if (amount != null && (isSubtotalLabel(rowLabel) || isSubtotalLabel(raw))) {
        addAmountCandidate(buckets, 'subtotal', {
          value: amount,
          label: resolvedLabel,
          raw_text: raw,
          evidence_refs: [row.id],
          score: subtotalLabelScore(resolvedLabel) + 12,
        });
      }
      if (amount != null && (isCurrentAmountDueLabel(rowLabel) || isCurrentAmountDueLabel(raw))) {
        addAmountCandidate(buckets, 'current_due', {
          value: amount,
          label: resolvedLabel,
          raw_text: raw,
          evidence_refs: [row.id],
          score: currentAmountDueLabelScore(resolvedLabel) + 12,
        });
      }
      if (amount != null && (isBilledTotalLabel(rowLabel) || isBilledTotalLabel(raw))) {
        addAmountCandidate(buckets, 'total', {
          value: amount,
          label: resolvedLabel,
          raw_text: raw,
          evidence_refs: [row.id],
          score: billedTotalLabelScore(resolvedLabel) + 12,
        });
      }
      addRegexAmountCandidates({
        text: resolvedLabel,
        evidence_refs: [row.id],
        source_bonus: 12,
        buckets,
      });
    }
  }

  for (const item of params.evidence) {
    const haystack = evidenceHaystack(item);
    if (!haystack || !/\$?\s*[\d,]+(?:\.\d{1,2})?/.test(haystack)) continue;
    if (item.kind === 'table_row' && !looksLikeTotalsText(haystack)) continue;
    const amount = lastAmountInText(haystack);
    if (amount != null && isSubtotalLabel(haystack)) {
      addAmountCandidate(buckets, 'subtotal', {
        value: amount,
        label: haystack,
        raw_text: haystack,
        evidence_refs: [item.id],
        score: subtotalLabelScore(haystack) + 8,
      });
    }
    if (amount != null && isCurrentAmountDueLabel(haystack)) {
      addAmountCandidate(buckets, 'current_due', {
        value: amount,
        label: haystack,
        raw_text: haystack,
        evidence_refs: [item.id],
        score: currentAmountDueLabelScore(haystack) + 8,
      });
    }
    if (amount != null && isBilledTotalLabel(haystack)) {
      addAmountCandidate(buckets, 'total', {
        value: amount,
        label: haystack,
        raw_text: haystack,
        evidence_refs: [item.id],
        score: billedTotalLabelScore(haystack) + 8,
      });
    }
    addRegexAmountCandidates({
      text: haystack,
      evidence_refs: [item.id],
      source_bonus: 8,
      buckets,
    });
  }

  addRegexAmountCandidates({
    text: params.text,
    evidence_refs: [],
    source_bonus: 0,
    buckets,
  });

  const textLines = params.text
    .split(/\r?\n/)
    .map((line) => normalizeWhitespace(line))
    .filter((line) => line.length > 0);
  for (const line of textLines) {
    const amount = lastAmountInText(line);
    if (amount == null) continue;
    if (looksLikeTextLineItem(line)) continue;
    const label = trailingAmountLabel(line);
    if (!label) continue;
    if (isSubtotalLabel(label)) {
      addAmountCandidate(buckets, 'subtotal', {
        value: amount,
        label,
        raw_text: line,
        evidence_refs: [],
        score: subtotalLabelScore(label),
      });
    }
    if (isCurrentAmountDueLabel(label)) {
      addAmountCandidate(buckets, 'current_due', {
        value: amount,
        label,
        raw_text: line,
        evidence_refs: [],
        score: currentAmountDueLabelScore(label),
      });
    }
    if (isBilledTotalLabel(label)) {
      addAmountCandidate(buckets, 'total', {
        value: amount,
        label,
        raw_text: line,
        evidence_refs: [],
        score: billedTotalLabelScore(label),
      });
    }
  }

  return { subtotalCandidates, totalCandidates, currentDueCandidates };
}

function extractServicePeriod(params: {
  text: string;
  forms: PdfFormField[];
  evidence: EvidenceObject[];
}): {
  period_start: string | null;
  period_end: string | null;
  period_through: string | null;
  raw_text: string | null;
  evidence_refs: string[];
} {
  let period_start: string | null = null;
  let period_end: string | null = null;
  let period_through: string | null = null;
  let raw_text: string | null = null;
  let evidence_refs: string[] = [];

  for (const field of params.forms) {
    const label = field.label;
    const value = normalizeWhitespace(field.value);
    const rangeMatch =
      value.match(DATE_RANGE_RE)
      ?? value.match(GENERIC_FROM_TO_RE)
      ?? value.match(DATE_PAIR_RE);
    if (matchAnyAlias(label, PERIOD_RANGE_LABELS) && rangeMatch) {
      period_start = normalizeDate(rangeMatch[1]);
      period_end = normalizeDate(rangeMatch[2]);
      period_through = period_end;
      raw_text = value;
      evidence_refs = [field.id];
      break;
    }
    if (matchAnyAlias(label, PERIOD_START_LABELS)) {
      period_start = extractInlineDate(value);
      raw_text = raw_text ?? value;
      evidence_refs = uniqueStrings([...evidence_refs, field.id]);
    }
    if (matchAnyAlias(label, PERIOD_END_LABELS)) {
      period_end = extractInlineDate(value);
      raw_text = raw_text ?? value;
      evidence_refs = uniqueStrings([...evidence_refs, field.id]);
    }
    if (matchAnyAlias(label, PERIOD_THROUGH_LABELS)) {
      period_through = extractInlineDate(value);
      period_end = period_end ?? period_through;
      raw_text = raw_text ?? value;
      evidence_refs = uniqueStrings([...evidence_refs, field.id]);
    }
  }

  if (!period_start || !period_end) {
    for (const item of params.evidence) {
      const haystack = evidenceHaystack(item);
      if (!haystack) continue;
      const rangeMatch =
        haystack.match(DATE_RANGE_RE)
        ?? haystack.match(GENERIC_FROM_TO_RE)
        ?? haystack.match(DATE_PAIR_RE);
      if (rangeMatch) {
        period_start = period_start ?? normalizeDate(rangeMatch[1]);
        period_end = period_end ?? normalizeDate(rangeMatch[2]);
        period_through = period_through ?? period_end;
        raw_text = raw_text ?? haystack;
        evidence_refs = uniqueStrings([...evidence_refs, item.id]);
        break;
      }
      if (matchAnyAlias(haystack, PERIOD_THROUGH_LABELS)) {
        const throughDate = extractInlineDate(haystack);
        if (throughDate) {
          period_through = period_through ?? throughDate;
          period_end = period_end ?? throughDate;
          raw_text = raw_text ?? haystack;
          evidence_refs = uniqueStrings([...evidence_refs, item.id]);
        }
      }
    }
  }

  if (!period_start || !period_end) {
    const rangeMatch =
      params.text.match(DATE_RANGE_RE)
      ?? params.text.match(GENERIC_FROM_TO_RE)
      ?? params.text.match(DATE_PAIR_RE);
    if (rangeMatch) {
      period_start = period_start ?? normalizeDate(rangeMatch[1]);
      period_end = period_end ?? normalizeDate(rangeMatch[2]);
      period_through = period_through ?? period_end;
      raw_text = raw_text ?? normalizeWhitespace(rangeMatch[0]);
    }
    if (!period_through) {
      const throughMatch = params.text.match(THROUGH_ONLY_RE);
      if (throughMatch) {
        period_through = normalizeDate(throughMatch[1]);
        period_end = period_end ?? period_through;
        raw_text = raw_text ?? normalizeWhitespace(throughMatch[0]);
      }
    }
  }

  if (!period_end && period_through) {
    period_end = period_through;
  }

  return {
    period_start,
    period_end,
    period_through,
    raw_text,
    evidence_refs,
  };
}

function extractInvoiceStatus(params: {
  text: string;
  forms: PdfFormField[];
  evidence: EvidenceObject[];
}): ScalarCandidate<string> | null {
  const form = formCandidate(params.forms, INVOICE_STATUS_LABELS, (value) => {
    const normalized = normalizeLabel(value);
    const status = STATUS_VALUES.find((candidate) => normalized.includes(candidate));
    return status ? status.toUpperCase() : null;
  }, 100);
  if (form) return form;

  for (const item of params.evidence) {
    const haystack = evidenceHaystack(item);
    if (!haystack) continue;
    const normalized = normalizeLabel(haystack);
    const status = STATUS_VALUES.find((candidate) => normalized.includes(candidate));
    if (!status) continue;
    return {
      value: status.toUpperCase(),
      raw_text: haystack,
      evidence_refs: [item.id],
      score: 75,
    };
  }

  const normalizedText = normalizeLabel(params.text);
  const textStatus = STATUS_VALUES.find((candidate) => normalizedText.includes(candidate));
  return textStatus
    ? {
        value: textStatus.toUpperCase(),
        raw_text: textStatus,
        evidence_refs: [],
        score: 60,
      }
    : null;
}

export function extractInvoiceTypedFields(params: {
  text: string;
  contentLayers?: InvoiceContentLayers;
}): InvoiceExtraction {
  const text = params.text ?? '';
  const context = invoicePdfContext(params.contentLayers ?? null);

  const invoiceNumberCandidate = bestStringCandidate([
    formCandidate(context.forms, INVOICE_NUMBER_LABELS, (value) => {
      const match = value.match(/[A-Za-z0-9][A-Za-z0-9\-\/]+/);
      return match?.[0] ?? null;
    }, 110),
    evidenceCandidateByRegex(context.evidence, INVOICE_NUMBER_RE, 92),
    (() => {
      const match = text.match(INVOICE_NUMBER_RE);
      const value = match?.[1] ?? null;
      return value
        ? { value, raw_text: match?.[0] ?? value, evidence_refs: [], score: 70 }
        : null;
    })(),
  ]);

  const invoiceDateCandidate = bestStringCandidate([
    formCandidate(context.forms, INVOICE_DATE_LABELS, extractInlineDate, 104),
    evidenceCandidateByRegex(
      context.evidence,
      new RegExp(`invoice\\s+date[^0-9A-Za-z]{0,16}(${DATE_CAPTURE})`, 'i'),
      88,
      normalizeDate,
    ),
    (() => {
      const value = extractInlineDate(text);
      return value
        ? { value, raw_text: value, evidence_refs: [], score: 50 }
        : null;
    })(),
  ]);

  const vendorCandidate = bestStringCandidate([
    formCandidate(context.forms, VENDOR_LABELS, cleanPartyName, 102),
    evidenceCandidateByRegex(
      context.evidence,
      /(?:vendor|contractor|from|seller|payee)\s*[:\-]?\s*([A-Z][A-Za-z0-9 &.,'()\/\-]{2,180})/i,
      86,
      cleanPartyName,
    ),
    evidenceCandidateByRegex(
      context.evidence,
      /make all checks payable to\s+([A-Z][A-Za-z0-9 &.,'()\/\-]{2,180})/i,
      84,
      cleanPartyName,
    ),
    (() => {
      const match = text.match(
        /(?:vendor|contractor|from|seller|payee)\s*[:\-]?\s*([A-Z][A-Za-z0-9 &.,'()\/\-]{2,180})/i,
      );
      const value = cleanPartyName(match?.[1] ?? null);
      return value
        ? { value, raw_text: match?.[0] ?? value, evidence_refs: [], score: 68 }
        : null;
    })(),
    (() => {
      const match = text.match(/make all checks payable to\s+([A-Z][A-Za-z0-9 &.,'()\/\-]{2,180})/i);
      const value = cleanPartyName(match?.[1] ?? null);
      return value
        ? { value, raw_text: match?.[0] ?? value, evidence_refs: [], score: 66 }
        : null;
    })(),
  ]);

  const clientCandidate = bestStringCandidate([
    formCandidate(context.forms, CLIENT_LABELS, cleanPartyName, 102),
    evidenceCandidateByRegex(
      context.evidence,
      /(?:bill\s+to|client|customer|owner|invoice\s+to)\s*[:\-]?\s*([A-Z][A-Za-z0-9 &.,'()\/\-]{2,180})/i,
      86,
      cleanPartyName,
    ),
    (() => {
      const match = text.match(
        /(?:bill\s+to|client|customer|owner|invoice\s+to)\s*[:\-]?\s*([A-Z][A-Za-z0-9 &.,'()\/\-]{2,180})/i,
      );
      const value = cleanPartyName(match?.[1] ?? null);
      return value
        ? { value, raw_text: match?.[0] ?? value, evidence_refs: [], score: 68 }
        : null;
    })(),
    nonEmptyStringCandidate(extractClientFromUnlabeledText(text), 62),
  ]);

  const servicePeriod = extractServicePeriod({
    text,
    forms: context.forms,
    evidence: context.evidence,
  });

  const tableLineItems = extractLineItemsFromTables(context.tables);
  const fallbackTextLineItems = extractLineItemsFromText(text);
  const flattenedTextLineItems = extractFlattenedLineItemsFromText(text);
  const textRecoveredLineItems = shouldPreferRecoveredInvoiceLines(fallbackTextLineItems, flattenedTextLineItems)
    ? flattenedTextLineItems
    : fallbackTextLineItems;
  const resolvedLineItems = shouldPreferRecoveredInvoiceLines(tableLineItems, textRecoveredLineItems)
    ? textRecoveredLineItems
    : tableLineItems.length > 0
      ? tableLineItems
      : textRecoveredLineItems;

  const { subtotalCandidates, totalCandidates, currentDueCandidates } = extractAmountCandidates({
    text,
    forms: context.forms,
    tables: context.tables,
    evidence: context.evidence,
  });
  const subtotalCandidate = bestAmountCandidate(subtotalCandidates);
  const totalCandidate = bestAmountCandidate(totalCandidates);
  const currentDueCandidate = bestAmountCandidate(currentDueCandidates);
  const resolvedTotalCandidate = totalCandidate ?? currentDueCandidate ?? subtotalCandidate;
  const resolvedCurrentDueCandidate = currentDueCandidate ?? totalCandidate ?? null;
  const invoiceStatusCandidate = extractInvoiceStatus({
    text,
    forms: context.forms,
    evidence: context.evidence,
  });

  const anchors: InvoiceEvidenceAnchors = {
    invoice_totals_section: uniqueStrings([
      ...(subtotalCandidate?.evidence_refs ?? []),
      ...(totalCandidate?.evidence_refs ?? []),
      ...(currentDueCandidate?.evidence_refs ?? []),
    ]),
    invoice_number: uniqueStrings(invoiceNumberCandidate?.evidence_refs ?? []),
    service_period: uniqueStrings(servicePeriod.evidence_refs),
    line_item_groups: resolvedLineItems.map((line, index) => ({
      group_index: index + 1,
      line_code: line.line_code,
      description_match_key: line.description_match_key,
      evidence_refs: uniqueStrings(line.evidence_refs ?? []),
      raw_text: line.raw_text ?? null,
    })),
  };

  return {
    schema_type: 'invoice',
    invoice_number: normalizeCanonicalInvoiceNumber(invoiceNumberCandidate?.value ?? null),
    invoice_number_raw: invoiceNumberCandidate?.value ?? null,
    invoice_number_normalized: normalizeCanonicalInvoiceNumber(invoiceNumberCandidate?.value ?? null),
    invoice_status: invoiceStatusCandidate?.value ?? null,
    invoice_date: invoiceDateCandidate?.value ?? null,
    period_start: servicePeriod.period_start,
    period_end: servicePeriod.period_end,
    period_through: servicePeriod.period_through,
    service_period_start: servicePeriod.period_start,
    service_period_end: servicePeriod.period_end ?? servicePeriod.period_through,
    vendor_name: vendorCandidate?.value ?? null,
    client_name: clientCandidate?.value ?? null,
    line_items: resolvedLineItems,
    line_item_count: resolvedLineItems.length,
    subtotal_amount: subtotalCandidate?.value ?? null,
    total_amount: resolvedTotalCandidate?.value ?? null,
    current_amount_due: resolvedCurrentDueCandidate?.value ?? resolvedTotalCandidate?.value ?? null,
    payment_terms: null,
    po_number: null,
    evidence_anchors: anchors,
    raw_sections: {
      invoice_number_text: invoiceNumberCandidate?.raw_text ?? null,
      service_period_text: servicePeriod.raw_text,
      invoice_totals_text:
        resolvedCurrentDueCandidate?.raw_text
        ?? resolvedTotalCandidate?.raw_text
        ?? subtotalCandidate?.raw_text
        ?? null,
    },
  };
}

function recordString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0
    ? normalizeWhitespace(value)
    : null;
}

function recordNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') return toAmount(value);
  return null;
}

function normalizeTypedInvoiceLine(
  value: unknown,
  invoiceNumber: string | null,
  sourceDocumentId: string,
  invoiceId: string,
  index: number,
): Record<string, unknown> | null {
  const record = asRecord(value);
  if (!record) return null;

  const lineCodeResolution = resolveInvoiceLineCode(record);
  const line_code = lineCodeResolution.value;
  const line_description =
    recordString(record.line_description)
    ?? recordString(record.description)
    ?? recordString(record.item_description);
  const material =
    recordString(record.material)
    ?? recordString(record.material_type)
    ?? recordString(record.debris_type);
  const service_item =
    recordString(record.service_item)
    ?? recordString(record.service_item_code)
    ?? line_description;
  const quantity = recordNumber(record.quantity ?? record.qty);
  const unit = recordString(record.unit ?? record.uom);
  const line_total = recordNumber(record.line_total ?? record.total ?? record.amount);
  const structuredUnitPrice = recordNumber(
    record.unit_price
    ?? record.unitPrice
    ?? record.price
    ?? record.unitRate
    ?? record.unit_rate,
  );
  const unit_price = resolveInvoiceLineUnitPrice({
    structuredUnitPrice,
    quantity,
    lineTotal: line_total,
    rawText: recordString(record.raw_text),
  });

  if (!line_code && !line_description && line_total == null && quantity == null && unit_price == null) {
    return null;
  }

  const billingKeys = deriveBillingKeysForInvoiceLine({
    rate_code: line_code,
    description: line_description,
    service_item,
    material,
  });
  const categoryResolution = resolveCanonicalRateCategory({
    sourceCategory: material,
    sourceDescriptors: [service_item, line_description, line_code],
    existingCanonicalCategory:
      recordString(record.canonical_category)
      ?? recordString(record.canonicalCategory),
    existingConfidence:
      recordNumber(record.category_confidence)
      ?? recordNumber(record.categoryConfidence),
  });

  return {
    id: `${invoiceId}:line:${index + 1}`,
    source_document_id: sourceDocumentId,
    document_id: sourceDocumentId,
    invoice_id: invoiceId,
    invoice_number: invoiceNumber,
    line_code,
    rate_code: line_code,
    description: line_description,
    line_description,
    material,
    service_item,
    quantity,
    unit,
    unit_price,
    line_total,
    total_amount: line_total,
    billing_rate_key: recordString(record.billing_rate_key) ?? billingKeys.billing_rate_key,
    description_match_key:
      recordString(record.description_match_key) ?? billingKeys.description_match_key,
    invoice_rate_key: deriveInvoiceRateKey(
      invoiceNumber,
      recordString(record.billing_rate_key) ?? billingKeys.billing_rate_key,
    ),
    canonical_category: categoryResolution.canonical_category,
    category_confidence: categoryResolution.category_confidence,
    evidence_refs: asArray<string>(record.evidence_refs),
    raw_text: recordString(record.raw_text),
    line_code_resolution: {
      status: lineCodeResolution.status,
      value: lineCodeResolution.value,
      source_field: lineCodeResolution.sourceField,
      source_value: lineCodeResolution.sourceValue,
      method: lineCodeResolution.method,
      rejected_candidates: lineCodeResolution.rejectedCandidates.map((candidate) => ({
        source_field: candidate.sourceField,
        value: candidate.value,
        reason: candidate.reason,
      })),
      evidence_refs: asArray<string>(record.evidence_refs),
    },
  };
}

export function buildCanonicalInvoiceRowsFromTypedFields(params: {
  documentId: string;
  typedFields: Record<string, unknown> | null | undefined;
  extractionData?: unknown;
  fallbackText?: string | null;
}): {
  invoiceRow: Record<string, unknown> | null;
  invoiceLines: Record<string, unknown>[];
} {
  const typed = params.typedFields ?? {};
  const invoice_number_raw =
    recordString(typed.invoice_number_raw)
    ?? recordString(typed.invoice_number)
    ?? recordString(typed.invoiceNumber);
  const invoice_number = normalizeCanonicalInvoiceNumber(invoice_number_raw) ?? invoice_number_raw;
  const invoice_date =
    normalizeDate(recordString(typed.invoice_date))
    ?? normalizeDate(recordString(typed.invoiceDate))
    ?? recordString(typed.invoice_date)
    ?? recordString(typed.invoiceDate);
  const period_start =
    normalizeDate(recordString(typed.service_period_start))
    ?? normalizeDate(recordString(typed.period_start))
    ?? normalizeDate(recordString(typed.periodFrom))
    ?? recordString(typed.service_period_start)
    ?? recordString(typed.period_start)
    ?? recordString(typed.periodFrom);
  const period_end =
    normalizeDate(recordString(typed.service_period_end))
    ?? normalizeDate(recordString(typed.period_end))
    ?? normalizeDate(recordString(typed.periodTo))
    ?? recordString(typed.service_period_end)
    ?? recordString(typed.period_end)
    ?? recordString(typed.periodTo);
  const period_through =
    normalizeDate(recordString(typed.period_through))
    ?? recordString(typed.period_through);
  const vendor_name =
    recordString(typed.vendor_name)
    ?? recordString(typed.contractorName);
  const client_name =
    recordString(typed.client_name)
    ?? recordString(typed.ownerName)
    ?? recordString(typed.bill_to_name);
  const subtotal_amount = recordNumber(typed.subtotal_amount) ?? recordNumber(typed.subtotal);
  const total_amount =
    recordNumber(typed.total_amount)
    ?? recordNumber(typed.current_amount_due)
    ?? recordNumber(typed.currentPaymentDue);
  const invoice_status = recordString(typed.invoice_status);
  const lineItems = recoverInvoiceLineItemsFromExtractionData({
    lineItems: typed.line_items,
    extractionData: params.extractionData,
    fallbackText: params.fallbackText,
  });
  const invoiceId = `typed:${params.documentId}:invoice`;
  const invoiceLines = lineItems
    .map((line, index) =>
      normalizeTypedInvoiceLine(line, invoice_number, params.documentId, invoiceId, index))
    .filter((line): line is Record<string, unknown> => line != null);

  const line_item_count = recordNumber(typed.line_item_count) ?? invoiceLines.length;

  const invoiceRow = (
    invoice_number
    || vendor_name
    || client_name
    || total_amount != null
    || invoiceLines.length > 0
  ) ? {
    id: invoiceId,
    source_document_id: params.documentId,
    document_id: params.documentId,
    invoice_number,
    invoice_number_raw,
    invoice_number_normalized: invoice_number,
    invoice_status,
    invoice_date,
    period_start,
    period_end,
    period_through,
    service_period_start: period_start,
    service_period_end: period_end ?? period_through,
    vendor_name,
    client_name,
    subtotal_amount,
    total_amount,
    billed_amount: total_amount,
    line_item_count,
    line_items: invoiceLines,
    raw_sections: asRecord(typed.raw_sections),
    evidence_anchors: asRecord(typed.evidence_anchors),
  } : null;

  return {
    invoiceRow,
    invoiceLines,
  };
}
