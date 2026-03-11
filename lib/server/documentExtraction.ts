// lib/server/documentExtraction.ts
// Server-side document extraction: text decoding, PDF text extraction, and fallbacks.

import type {
  TypedExtraction,
  ContractExtraction,
  InvoiceExtraction,
  ReportExtraction,
  RateTableEntry,
  LineItem,
  Finding,
} from '@/lib/types/extractionSchemas';

const TEXT_EXTENSIONS = new Set([
  'txt',
  'json',
  'csv',
  'md',
  'html',
  'htm',
  'xml',
]);
const TEXT_MIMES = new Set([
  'text/plain',
  'application/json',
  'text/csv',
  'text/markdown',
  'text/html',
  'application/xml',
  'text/xml',
]);

const MAX_PREVIEW_CHARS = 4000;
const MAX_MENTIONS = 15;

// Keyword lists for heuristic field extraction (case-insensitive match)
const RATE_KEYWORDS = [
  'rate', 'price', 'per ton', 'per cubic yard', 'per mile', 'hourly',
  'unit price', 'tipping fee', 'haul rate',
];
const MATERIAL_KEYWORDS = [
  'debris', 'vegetative', 'c&d', 'ash', 'stump', 'soil', 'sand', 'mulch',
  'metal', 'hazardous', 'white goods',
];
const SCOPE_KEYWORDS = [
  'scope', 'collection', 'removal', 'hauling', 'reduction', 'monitoring',
  'disposal', 'pickup', 'loading',
];
const COMPLIANCE_KEYWORDS = [
  'termination', 'remedies', 'equal opportunity', 'breach', 'compliance',
  'fema', 'eligibility', 'ineligible',
];

// ── Typed extraction patterns ────────────────────────────────────────────────

// Contract patterns
const VENDOR_NAME_RE = /(?:contractor|vendor|company|firm|consultant)\s*[:=]\s*([A-Z][A-Za-z0-9 &.,'-]{2,60})/gi;
const DATE_RE = /(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}|\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4})/gi;
const RATE_AMOUNT_RE = /\$\s?([\d,]+(?:\.\d{1,2})?)\s*(?:per|\/)\s*(ton|cubic yard|cy|mile|hour|load|each)/gi;
const INSURANCE_KEYWORDS = ['insurance', 'liability', 'coverage', 'indemnification', 'general liability', 'workers compensation'];
const BONDING_KEYWORDS = ['bond', 'bonding', 'surety', 'performance bond', 'payment bond'];
const TERMINATION_CLAUSE_KEYWORDS = ['termination for convenience', 'termination for cause', 'right to terminate', 'termination clause'];
const TIPPING_FEE_RE = /(?:tipping\s+fee|disposal\s+fee|landfill\s+fee)\s*[:=]?\s*\$?\s*([\d,]+(?:\.\d{1,2})?)/gi;
const HAULING_RATE_RE = /(?:haul(?:ing)?\s+rate|transport(?:ation)?\s+rate)\s*[:=]?\s*\$?\s*([\d,]+(?:\.\d{1,2})?)/gi;

// Invoice patterns
const INVOICE_NUMBER_RE = /(?:invoice\s*(?:#|no\.?|number)\s*[:=]?\s*)([A-Za-z0-9\-]+)/gi;
const PO_NUMBER_RE = /(?:p\.?o\.?\s*(?:#|no\.?|number)?\s*[:=]?\s*)([A-Za-z0-9\-]+)/gi;
const TOTAL_AMOUNT_RE = /(?:total\s*(?:amount|due|balance)?)\s*[:=]?\s*\$\s?([\d,]+(?:\.\d{1,2})?)/gi;
const PAYMENT_TERMS_KEYWORDS = ['net 30', 'net 60', 'net 90', 'due upon receipt', 'payment terms', 'net 15', 'net 45'];
const LINE_ITEM_RE = /^(.{5,60}?)\s+(\d+(?:\.\d+)?)\s+(ton|cy|ea|hr|load|lf|mile|each|ls|day)s?\s+\$?\s?([\d,]+(?:\.\d{1,2})?)\s+\$?\s?([\d,]+(?:\.\d{1,2})?)$/gim;

// Report patterns
const REPORT_TYPE_KEYWORDS = ['daily report', 'weekly report', 'monthly report', 'final report', 'compliance report', 'progress report', 'monitoring report', 'status report'];
const COMPLIANCE_STATUS_KEYWORDS_REPORT = ['compliant', 'non-compliant', 'non compliant', 'partial compliance', 'in compliance', 'out of compliance'];
const FINDING_RE = /(?:finding|observation|issue|deficiency|violation)\s*(?:#?\d+)?\s*[:=\-]\s*(.{10,200})/gi;
const REPORTING_PERIOD_RE = /(?:reporting\s+period|period\s+(?:of|from)|date\s+range)\s*[:=]?\s*(.{5,80})/gi;
const AUTHOR_RE = /(?:prepared\s+by|author|inspector|monitor)\s*[:=]?\s*([A-Z][A-Za-z .,'-]{2,50})/gi;

export type DocumentMetadata = {
  id: string;
  title: string | null;
  name: string;
  document_type: string | null;
  storage_path: string;
};

export type ExtractionPayload = {
  status: string;
  source: string;
  summary: string;
  document_id: string;
  document_title: string;
  analyzed_at: string;
  file: {
    name: string;
    path: string;
    mime_type: string | null;
    size_bytes: number | null;
  };
  extraction: {
    mode: 'text' | 'pdf_text' | 'pdf_fallback' | 'binary_fallback';
    text_preview: string | null;
    detected_document_type: string | null;
  };
  fields: {
    detected_document_type: string | null;
    file_name: string;
    title: string | null;
    rate_mentions?: string[];
    material_mentions?: string[];
    scope_mentions?: string[];
    compliance_mentions?: string[];
    detected_keywords?: string[];
    typed_fields?: TypedExtraction | null;
  };
};

function getExtension(fileName: string): string {
  const last = fileName.split('.').pop();
  return last ? last.toLowerCase() : '';
}

function isTextLike(fileName: string, mimeType: string | null): boolean {
  const ext = getExtension(fileName);
  if (TEXT_EXTENSIONS.has(ext)) return true;
  if (mimeType && TEXT_MIMES.has(mimeType.toLowerCase())) return true;
  return false;
}

function isPdf(fileName: string, mimeType: string | null): boolean {
  const ext = getExtension(fileName);
  if (ext === 'pdf') return true;
  if (mimeType && mimeType.toLowerCase() === 'application/pdf') return true;
  return false;
}

function decodeTextPreview(bytes: ArrayBuffer): string | null {
  try {
    const decoder = new TextDecoder('utf-8', { fatal: false });
    const full = decoder.decode(bytes);
    return full.length > MAX_PREVIEW_CHARS
      ? full.slice(0, MAX_PREVIEW_CHARS)
      : full;
  } catch {
    return null;
  }
}

function normalizeWhitespace(s: string): string {
  return s.trim().replace(/\s+/g, ' ').trim();
}

/**
 * Splits normalized text into sentence- or line-like chunks for heuristic search.
 */
function splitIntoChunks(text: string): string[] {
  const normalized = normalizeWhitespace(text);
  const chunks = normalized
    .split(/\n|(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 10);
  return [...new Set(chunks)];
}

function chunkContainsAnyKeyword(chunkLower: string, keywords: readonly string[]): boolean {
  return keywords.some((kw) => chunkLower.includes(kw.toLowerCase()));
}

/**
 * Finds unique chunks that contain any of the given keywords, limited to maxItems.
 */
function findMentions(
  chunks: string[],
  keywords: readonly string[],
  maxItems: number
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const chunk of chunks) {
    if (out.length >= maxItems) break;
    const lower = chunk.toLowerCase();
    if (!chunkContainsAnyKeyword(lower, keywords)) continue;
    const key = normalizeWhitespace(chunk).slice(0, 200);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalizeWhitespace(chunk).slice(0, 500));
  }
  return out;
}

export type DerivedFields = {
  rate_mentions: string[];
  material_mentions: string[];
  scope_mentions: string[];
  compliance_mentions: string[];
  detected_keywords: string[];
};

/**
 * First-pass heuristic extraction from extracted text. No AI; regex and keyword lists only.
 */
function deriveHeuristicFields(text: string): DerivedFields {
  const normalized = normalizeWhitespace(text);
  if (normalized.length === 0) {
    return {
      rate_mentions: [],
      material_mentions: [],
      scope_mentions: [],
      compliance_mentions: [],
      detected_keywords: [],
    };
  }
  const chunks = splitIntoChunks(normalized);
  const rate_mentions = findMentions(chunks, RATE_KEYWORDS, MAX_MENTIONS);
  const material_mentions = findMentions(chunks, MATERIAL_KEYWORDS, MAX_MENTIONS);
  const scope_mentions = findMentions(chunks, SCOPE_KEYWORDS, MAX_MENTIONS);
  const compliance_mentions = findMentions(chunks, COMPLIANCE_KEYWORDS, MAX_MENTIONS);

  const keywordSet = new Set<string>();
  const textLower = normalized.toLowerCase();
  [...RATE_KEYWORDS, ...MATERIAL_KEYWORDS, ...SCOPE_KEYWORDS, ...COMPLIANCE_KEYWORDS].forEach(
    (kw) => {
      if (textLower.includes(kw.toLowerCase())) keywordSet.add(kw);
    }
  );
  const detected_keywords = [...keywordSet].slice(0, MAX_MENTIONS);

  return {
    rate_mentions,
    material_mentions,
    scope_mentions,
    compliance_mentions,
    detected_keywords,
  };
}

// ── Typed extraction functions ────────────────────────────────────────────────

function firstMatch(text: string, re: RegExp, group = 1): string | null {
  const copy = new RegExp(re.source, re.flags);
  const m = copy.exec(text);
  return m?.[group]?.trim() ?? null;
}

function allMatches(text: string, re: RegExp, group = 1, max = 15): string[] {
  const copy = new RegExp(re.source, re.flags);
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = copy.exec(text)) !== null && out.length < max) {
    const val = m[group]?.trim();
    if (val) out.push(val);
  }
  return out;
}

function textIncludesAny(textLower: string, keywords: string[]): boolean {
  return keywords.some((kw) => textLower.includes(kw.toLowerCase()));
}

function firstKeywordMention(textLower: string, keywords: string[]): string | null {
  for (const kw of keywords) {
    if (textLower.includes(kw.toLowerCase())) return kw;
  }
  return null;
}

function parseAmount(raw: string): number | null {
  const cleaned = raw.replace(/,/g, '');
  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
}

function extractContractFields(text: string): ContractExtraction {
  const lower = text.toLowerCase();

  // Vendor name
  const vendor_name = firstMatch(text, VENDOR_NAME_RE);

  // Dates
  const dates = allMatches(text, DATE_RE, 1, 10);
  const contract_date = dates[0] ?? null;
  const effective_date = dates.length > 1 ? dates[1] : null;
  const expiration_date = dates.length > 2 ? dates[2] : null;

  // Termination clause
  let termination_clause: string | null = null;
  for (const kw of TERMINATION_CLAUSE_KEYWORDS) {
    const idx = lower.indexOf(kw.toLowerCase());
    if (idx !== -1) {
      termination_clause = text.slice(idx, idx + 200).trim();
      break;
    }
  }

  // Rate table
  const rate_table: RateTableEntry[] = [];
  const rateRe = new RegExp(RATE_AMOUNT_RE.source, RATE_AMOUNT_RE.flags);
  let rm: RegExpExecArray | null;
  while ((rm = rateRe.exec(text)) !== null && rate_table.length < 15) {
    const amount = parseAmount(rm[1]);
    const unit = rm[2]?.toLowerCase() ?? null;
    rate_table.push({
      material_type: null,
      unit: unit ? `per ${unit}` : null,
      rate_amount: amount,
      rate_raw: rm[0].trim(),
    });
  }

  // Material types from MATERIAL_KEYWORDS
  const material_types: string[] = [];
  for (const kw of MATERIAL_KEYWORDS) {
    if (lower.includes(kw.toLowerCase()) && !material_types.includes(kw)) {
      material_types.push(kw);
    }
  }

  // Hauling rates & tipping fees
  const hauling_rates = allMatches(text, HAULING_RATE_RE, 0, 10);
  const tipping_fees = allMatches(text, TIPPING_FEE_RE, 0, 10);

  // FEMA reference
  const fema_reference = textIncludesAny(lower, ['fema', 'federal emergency management']);

  // Insurance & bonding
  let insurance_requirements: string | null = null;
  for (const kw of INSURANCE_KEYWORDS) {
    const idx = lower.indexOf(kw.toLowerCase());
    if (idx !== -1) {
      insurance_requirements = text.slice(idx, idx + 150).trim();
      break;
    }
  }

  let bonding_requirements: string | null = null;
  for (const kw of BONDING_KEYWORDS) {
    const idx = lower.indexOf(kw.toLowerCase());
    if (idx !== -1) {
      bonding_requirements = text.slice(idx, idx + 150).trim();
      break;
    }
  }

  return {
    schema_type: 'contract',
    vendor_name,
    contract_date,
    effective_date,
    expiration_date,
    termination_clause,
    rate_table,
    material_types,
    hauling_rates,
    tipping_fees,
    fema_reference,
    insurance_requirements,
    bonding_requirements,
  };
}

function extractInvoiceFields(text: string): InvoiceExtraction {
  const lower = text.toLowerCase();

  const invoice_number = firstMatch(text, INVOICE_NUMBER_RE);
  const invoice_date = firstMatch(text, DATE_RE);
  const vendor_name = firstMatch(text, VENDOR_NAME_RE);
  const po_number = firstMatch(text, PO_NUMBER_RE);

  // Total amount
  const totalRaw = firstMatch(text, TOTAL_AMOUNT_RE);
  const total_amount = totalRaw ? parseAmount(totalRaw) : null;

  // Payment terms
  const payment_terms = firstKeywordMention(lower, PAYMENT_TERMS_KEYWORDS);

  // Line items
  const line_items: LineItem[] = [];
  const lineRe = new RegExp(LINE_ITEM_RE.source, LINE_ITEM_RE.flags);
  let lm: RegExpExecArray | null;
  while ((lm = lineRe.exec(text)) !== null && line_items.length < 30) {
    line_items.push({
      description: lm[1]?.trim() ?? '',
      quantity: parseAmount(lm[2] ?? ''),
      unit: lm[3]?.trim() ?? null,
      unit_price: parseAmount(lm[4] ?? ''),
      total: parseAmount(lm[5] ?? ''),
    });
  }

  return {
    schema_type: 'invoice',
    invoice_number,
    invoice_date,
    vendor_name,
    line_items,
    total_amount,
    payment_terms,
    po_number,
  };
}

function extractReportFields(text: string): ReportExtraction {
  const lower = text.toLowerCase();

  // Report type
  const report_type = firstKeywordMention(lower, REPORT_TYPE_KEYWORDS);

  // Reporting period
  const reporting_period = firstMatch(text, REPORTING_PERIOD_RE);

  // Author
  const author = firstMatch(text, AUTHOR_RE);

  // Date
  const date = firstMatch(text, DATE_RE);

  // Compliance status
  let compliance_status: string | null = null;
  for (const kw of COMPLIANCE_STATUS_KEYWORDS_REPORT) {
    if (lower.includes(kw.toLowerCase())) {
      compliance_status = kw.includes('non') ? 'non_compliant'
        : kw.includes('partial') ? 'partial'
        : 'compliant';
      break;
    }
  }

  // Findings
  const findings: Finding[] = [];
  const findingTexts = allMatches(text, FINDING_RE, 1, 20);
  for (const ft of findingTexts) {
    const ftLower = ft.toLowerCase();
    const severity: Finding['severity'] =
      textIncludesAny(ftLower, ['critical', 'severe', 'violation', 'major']) ? 'critical'
      : textIncludesAny(ftLower, ['warning', 'caution', 'minor', 'deficiency']) ? 'warning'
      : 'info';
    findings.push({ finding_text: ft.slice(0, 200), severity });
  }

  return {
    schema_type: 'report',
    report_type,
    reporting_period,
    findings,
    metrics: null,
    compliance_status,
    author,
    date,
  };
}

function deriveTypedFields(
  documentType: string | null,
  text: string
): TypedExtraction | null {
  if (!text || text.length === 0) return null;
  switch (documentType) {
    case 'contract': return extractContractFields(text);
    case 'invoice':  return extractInvoiceFields(text);
    case 'report':   return extractReportFields(text);
    default:         return null;
  }
}

// ── Apply derived fields ─────────────────────────────────────────────────────

function applyDerivedFields(
  payload: ExtractionPayload,
  fullText: string
): void {
  const derived = deriveHeuristicFields(fullText);
  payload.fields.rate_mentions = derived.rate_mentions;
  payload.fields.material_mentions = derived.material_mentions;
  payload.fields.scope_mentions = derived.scope_mentions;
  payload.fields.compliance_mentions = derived.compliance_mentions;
  payload.fields.detected_keywords = derived.detected_keywords;

  // Typed extraction based on document_type
  const docType = payload.fields.detected_document_type ?? null;
  payload.fields.typed_fields = deriveTypedFields(docType, fullText);
}

/**
 * Extracts text from PDF bytes using pdf-parse. Returns null on failure or empty result.
 */
async function extractPdfText(bytes: ArrayBuffer): Promise<string | null> {
  try {
    const pdf = (await import('pdf-parse')).default as
      | ((buffer: Buffer) => Promise<{ text?: string }>)
      | undefined;
    if (typeof pdf !== 'function') return null;
    const buffer = Buffer.from(bytes);
    const result = await pdf(buffer);
    const raw = result?.text;
    if (typeof raw !== 'string') return null;
    const text = normalizeWhitespace(raw);
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

function buildBase(
  metadata: DocumentMetadata,
  mode: 'text' | 'pdf_text' | 'pdf_fallback' | 'binary_fallback',
  textPreview: string | null
): ExtractionPayload {
  const title = metadata.title ?? metadata.name;
  return {
    status: 'completed',
    source: 'server_analysis',
    summary: 'Server-side extraction completed',
    document_id: metadata.id,
    document_title: title,
    analyzed_at: new Date().toISOString(),
    file: {
      name: metadata.name,
      path: metadata.storage_path,
      mime_type: null,
      size_bytes: null,
    },
    extraction: {
      mode,
      text_preview: textPreview,
      detected_document_type: metadata.document_type ?? null,
    },
    fields: {
      detected_document_type: metadata.document_type ?? null,
      file_name: metadata.name,
      title: metadata.title ?? null,
    },
  };
}

/**
 * Extracts structured information from file bytes. Text-like files get a preview;
 * PDFs attempt real text extraction, then fall back to metadata-only; other binary get fallback.
 */
export async function extractDocument(
  metadata: DocumentMetadata,
  fileBytes: ArrayBuffer,
  mimeType: string | null,
  fileName: string
): Promise<ExtractionPayload> {
  const size = fileBytes.byteLength;
  const ext = getExtension(fileName);

  if (isTextLike(fileName, mimeType)) {
    const fullDecoded = decodeTextPreview(fileBytes);
    const textPreview =
      fullDecoded != null && fullDecoded.length > MAX_PREVIEW_CHARS
        ? fullDecoded.slice(0, MAX_PREVIEW_CHARS)
        : fullDecoded;
    const payload = buildBase(metadata, 'text', textPreview);
    payload.file.mime_type = mimeType;
    payload.file.size_bytes = size;
    if (fullDecoded && fullDecoded.length > 0) {
      applyDerivedFields(payload, fullDecoded);
    }
    return payload;
  }

  if (isPdf(fileName, mimeType)) {
    const extractedText = await extractPdfText(fileBytes);
    const textPreview =
      extractedText != null && extractedText.length > 0
        ? extractedText.length > MAX_PREVIEW_CHARS
          ? extractedText.slice(0, MAX_PREVIEW_CHARS)
          : extractedText
        : null;

    if (textPreview != null && textPreview.length > 0) {
      const payload = buildBase(metadata, 'pdf_text', textPreview);
      payload.file.mime_type = mimeType ?? 'application/pdf';
      payload.file.size_bytes = size;
      applyDerivedFields(payload, extractedText ?? '');
      return payload;
    }

    const payload = buildBase(metadata, 'pdf_fallback', null);
    payload.file.mime_type = mimeType ?? 'application/pdf';
    payload.file.size_bytes = size;
    payload.summary =
      'File received; PDF extraction is not yet deeply parsed server-side.';
    return payload;
  }

  const payload = buildBase(metadata, 'binary_fallback', null);
  payload.file.mime_type = mimeType;
  payload.file.size_bytes = size;
  return payload;
}
