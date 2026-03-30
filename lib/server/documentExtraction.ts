// lib/server/documentExtraction.ts
// Server-side document extraction: text decoding, PDF text extraction, and fallbacks.

import { join as joinPath } from 'node:path';
import type {
  TypedExtraction,
  ContractExtraction,
  InvoiceExtraction,
  ReportExtraction,
  RateTableEntry,
  LineItem,
  Finding,
} from '@/lib/types/extractionSchemas';
import {
  buildEvidenceV1,
  type PageTextEvidence,
  type EvidenceSourceMethod,
} from '@/lib/server/documentEvidencePipelineV1';
import type { EvidenceObject, ExtractionGap } from '@/lib/extraction/types';
import {
  classifyDocumentFamily,
} from '@/lib/ai/instructor/classifyDocumentFamily';
import {
  maybeAssistTypedExtraction,
} from '@/lib/ai/instructor/extractionAssist';
import type {
  InstructorAssistSnapshot,
  InstructorClassificationSnapshot,
} from '@/lib/ai/instructor/types';
import {
  loadPdfLayout,
  buildPdfTextExtraction,
  computeLayoutPlainCombinedText,
} from '@/lib/extraction/pdf/extractText';
import { buildPdfTableExtraction } from '@/lib/extraction/pdf/extractTables';
import { buildPdfFormExtraction } from '@/lib/extraction/pdf/extractForms';
import { buildEvidenceMap as buildPdfEvidenceMap } from '@/lib/extraction/pdf/buildEvidenceMap';
import { buildElementEvidence } from '@/lib/extraction/pdf/buildElementEvidence';
import { mapUnstructuredElements } from '@/lib/extraction/pdf/mapUnstructuredElements';
import { partitionWithUnstructured } from '@/lib/extraction/pdf/partitionWithUnstructured';
import type { ParsedElementsV1 } from '@/lib/extraction/pdf/types';
import { parseWorkbook } from '@/lib/extraction/xlsx/parseWorkbook';
import { detectSheets } from '@/lib/extraction/xlsx/detectSheets';
import { normalizeTicketExport } from '@/lib/extraction/xlsx/normalizeTicketExport';
import { buildSpreadsheetEvidence } from '@/lib/extraction/xlsx/buildSpreadsheetEvidence';
import {
  countUnsafeTextControls,
  stripUnsafeTextControls,
} from '@/lib/extraction/textSanitization';

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
const SPREADSHEET_EXTENSIONS = new Set(['xlsx', 'xlsm', 'xls']);
const SPREADSHEET_MIMES = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'application/vnd.ms-excel.sheet.macroenabled.12',
]);

const MAX_PREVIEW_CHARS = 12000;
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
// Contract party language varies a lot across PDF generators.
// Keep these deterministic + keyword-scoped (no OCR; no broad “named entity” logic).
const CONTRACT_PARTY_CAPTURE = `([A-Z][A-Za-z0-9 &.,'-]{2,120})`;
const CONTRACT_PARTY_PATTERNS = [
  new RegExp(`entered\\s+into\\s+by\\s+and\\s+between[\\s\\S]{0,250}?and[\\s|,:;()"'\\-]*${CONTRACT_PARTY_CAPTURE}`, 'i'),
  new RegExp(`by\\s+and\\s+between[\\s\\S]{0,250}?and[\\s|,:;()"'\\-]*${CONTRACT_PARTY_CAPTURE}`, 'i'),
  new RegExp(`agreement\\s+between[\\s\\S]{0,250}?and[\\s|,:;()"'\\-]*${CONTRACT_PARTY_CAPTURE}`, 'i'),
  new RegExp(`contract\\s+between[\\s\\S]{0,250}?and[\\s|,:;()"'\\-]*${CONTRACT_PARTY_CAPTURE}`, 'i'),
];
const CONTRACTOR_LABEL_RE = /(?:contractor)\s*[:=\-]?\s*([A-Z][A-Za-z0-9 &.,'-]{2,80})/gi;
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
    mode: ExtractionMode;
    text_preview: string | null;
    detected_document_type: string | null;
    evidence_v1?: ReturnType<typeof buildEvidenceV1>;
    content_layers_v1?: Record<string, unknown>;
    parsed_elements_v1?: ParsedElementsV1;
    ai_assist_v1?: InstructorAssistSnapshot;
    metadata?: Record<string, unknown>;
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

type ExtractionMode =
  | 'text'
  | 'pdf_text'
  | 'pdf_fallback'
  | 'ocr_recovery'
  | 'spreadsheet'
  | 'binary_fallback';

type PdfExtractionMode = 'pdf_text' | 'pdf_fallback' | 'ocr_recovery';

const MAX_EVIDENCE_PAGES = 200;

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

function isSpreadsheet(fileName: string, mimeType: string | null): boolean {
  const ext = getExtension(fileName);
  if (SPREADSHEET_EXTENSIONS.has(ext)) return true;
  if (mimeType && SPREADSHEET_MIMES.has(mimeType.toLowerCase())) return true;
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
  return stripUnsafeTextControls(s).trim().replace(/\s+/g, ' ').trim();
}

function normalizePageLikeText(s: string): string {
  return stripUnsafeTextControls(s)
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function cloneArrayBuffer(bytes: ArrayBuffer): ArrayBuffer {
  return bytes.slice(0);
}

function getLocalTesseractLangPath(): string {
  return joinPath(
    process.cwd(),
    'node_modules',
    '@tesseract.js-data',
    'eng',
    '4.0.0',
  );
}

function isMostlyWhitespace(s: string): boolean {
  // Assumes `s` is already a string; treat empty as weak/whitespace.
  const trimmed = s.trim();
  if (!trimmed) return true;
  // If fewer than ~10% of characters are non-whitespace after trimming, treat as weak.
  const nonWs = trimmed.replace(/\s/g, '').length;
  return nonWs / Math.max(1, trimmed.length) < 0.1;
}

function countReadableWords(text: string | null): number {
  if (!text) return 0;
  const matches = text.match(/[A-Za-z0-9][A-Za-z0-9'/-]*/g);
  return matches?.length ?? 0;
}

const SHORT_VALID_TEXT_MIN_CHARS = 120;
const SHORT_VALID_TEXT_MIN_WORDS = 24;

function isWeakExtractedText(text: string | null): boolean {
  if (text == null) return true;
  const trimmed = text.trim();
  if (!trimmed) return true;
  if (isMostlyWhitespace(trimmed)) return true;
  if (trimmed.length < 500) {
    const wordCount = countReadableWords(trimmed);
    if (trimmed.length >= SHORT_VALID_TEXT_MIN_CHARS && wordCount >= SHORT_VALID_TEXT_MIN_WORDS) {
      return false;
    }
    return true;
  }
  return false;
}

/** Below pdf-parse “weak” threshold but still meaningful when native/layout text exists. */
const MEANINGFUL_LAYOUT_PLAIN_MIN_CHARS = 200;
const MEANINGFUL_LAYOUT_PLAIN_MIN_WORDS = 24;
const MEANINGFUL_NATIVE_TOTAL_MIN_CHARS = 200;
const MEANINGFUL_NATIVE_TOTAL_MIN_WORDS = 24;
const MEANINGFUL_NATIVE_PAGE_MIN_CHARS = 80;
const MEANINGFUL_NATIVE_PAGE_MIN_WORDS = 12;

/**
 * True when the PDF has extractable meaning: structured plain-text blocks from pdf.js layout,
 * enough layout-derived plain text, or enough native page text. Used to block OCR/pdf_fallback
 * when pdf-parse alone looks weak.
 */
function hasMeaningfulPdfTextSignals(params: {
  hasStructuredPlainBlocks: boolean;
  layoutPlainCombinedText: string;
  nativePageTexts: string[] | null;
}): boolean {
  if (params.hasStructuredPlainBlocks) return true;
  if (params.layoutPlainCombinedText.length >= MEANINGFUL_LAYOUT_PLAIN_MIN_CHARS) return true;
  if (countReadableWords(params.layoutPlainCombinedText) >= MEANINGFUL_LAYOUT_PLAIN_MIN_WORDS) return true;
  const pages = params.nativePageTexts ?? [];
  const total = pages.reduce((sum, t) => sum + (t?.length ?? 0), 0);
  if (total >= MEANINGFUL_NATIVE_TOTAL_MIN_CHARS) return true;
  const totalWords = pages.reduce((sum, t) => sum + countReadableWords(t), 0);
  if (totalWords >= MEANINGFUL_NATIVE_TOTAL_MIN_WORDS) return true;
  const maxPage = pages.reduce((max, t) => Math.max(max, t?.length ?? 0), 0);
  if (maxPage >= MEANINGFUL_NATIVE_PAGE_MIN_CHARS) return true;
  const maxPageWords = pages.reduce((max, t) => Math.max(max, countReadableWords(t)), 0);
  if (maxPageWords >= MEANINGFUL_NATIVE_PAGE_MIN_WORDS) return true;
  return false;
}

function countPdfLayoutLinesByKind(
  layout: Awaited<ReturnType<typeof loadPdfLayout>>,
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const page of layout.pages) {
    for (const line of page.lines) {
      counts[line.kind] = (counts[line.kind] ?? 0) + 1;
    }
  }
  return counts;
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

function cleanContractPartyName(value: string | null): string | null {
  if (!value) return null;

  let cleaned = normalizeWhitespace(value)
    .replace(/\|/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  cleaned = cleaned.replace(/^[,;:()"'`\-]+/, '').trim();
  cleaned = cleaned
    .replace(/\s*\(?hereinafter\b[\s\S]*$/i, '')
    .replace(/\s+THIS\s+CONTRACT\b[\s\S]*$/i, '')
    .replace(/\s+on\s+this\b[\s\S]*$/i, '')
    .trim();
  cleaned = cleaned.replace(/[|,;:()\-"'\s]+$/g, '').trim();

  return cleaned.length >= 3 ? cleaned : null;
}

function extractContractPartyName(text: string): string | null {
  for (const pattern of CONTRACT_PARTY_PATTERNS) {
    const candidate = cleanContractPartyName(firstMatch(text, pattern));
    if (candidate) return candidate;
  }

  return cleanContractPartyName(
    firstMatch(text, CONTRACTOR_LABEL_RE) ?? firstMatch(text, VENDOR_NAME_RE),
  );
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
  const vendor_name = extractContractPartyName(text);

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
 *
 * Uses 'pdf-parse/lib/pdf-parse.js' directly to bypass index.js, which contains a
 * module.parent debug guard that fires when loaded via createRequire in ESM contexts
 * and tries to synchronously read a test file from CWD — causing an ENOENT throw.
 */
async function extractPdfText(bytes: ArrayBuffer): Promise<string | null> {
  try {
    const { createRequire } = await import('node:module');
    const require = createRequire(import.meta.url);
    const pdf = require('pdf-parse/lib/pdf-parse.js') as
      | ((buffer: Buffer) => Promise<{ text?: string }>)
      | undefined;
    if (typeof pdf !== 'function') {
      if (process.env.EIGHTFORGE_OCR_DEBUG === '1') {
        console.warn('[extractPdfText] pdf-parse/lib/pdf-parse.js did not resolve to a function');
      }
      return null;
    }
    const buffer = Buffer.from(bytes);
    const result = await pdf(buffer);
    const raw = result?.text;
    if (typeof raw !== 'string') return null;
    const strippedControlCount = countUnsafeTextControls(raw);
    if (
      strippedControlCount > 0 &&
      (process.env.EIGHTFORGE_PDF_EXTRACT_DEBUG === '1' || process.env.EIGHTFORGE_OCR_DEBUG === '1')
    ) {
      console.log('[pdf-extract][sanitize-pdf-parse]', {
        mode: 'full',
        stripped_control_count: strippedControlCount,
      });
    }
    const text = normalizeWhitespace(raw);
    return text.length > 0 ? text : null;
  } catch (err) {
    console.error(
      '[pdf-extract][extractPdfText] pdf-parse threw',
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

async function extractPdfPageTextNative(bytes: ArrayBuffer): Promise<string[] | null> {
  try {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const data = new Uint8Array(bytes);
    const pdfDoc = await pdfjs.getDocument({ data }).promise;
    const numPages = Math.min(pdfDoc.numPages, MAX_EVIDENCE_PAGES);
    const pages: string[] = [];
    const sanitizedPages = new Map<number, number>();

    for (let pageNum = 1; pageNum <= numPages; pageNum++) {
      const page = await pdfDoc.getPage(pageNum);
      const tc = await page.getTextContent();
      const items = (tc.items ?? []) as Array<{ str?: string; transform?: number[] }>;
      // Best-effort “line” reconstruction using y-coordinates from transforms.
      // This keeps the layer deterministic + lightweight without requiring layout OCR.
      const rows = items
        .map((it) => {
          const rawText = it.str ?? '';
          const strippedControlCount = countUnsafeTextControls(rawText);
          const sanitizedText = stripUnsafeTextControls(rawText).trim();
          if (strippedControlCount > 0) {
            sanitizedPages.set(
              pageNum,
              (sanitizedPages.get(pageNum) ?? 0) + strippedControlCount,
            );
          }
          return {
            str: sanitizedText,
            x: Array.isArray(it.transform) ? (it.transform[4] ?? 0) : 0,
            y: Array.isArray(it.transform) ? (it.transform[5] ?? 0) : 0,
          };
        })
        .filter((it) => it.str.length > 0);

      rows.sort((a, b) => (b.y - a.y) || (a.x - b.x));

      const lineBuckets: Array<{ y: number; parts: Array<{ x: number; str: string }> }> = [];
      const Y_TOL = 2; // points
      for (const r of rows) {
        const bucket = lineBuckets.find((b) => Math.abs(b.y - r.y) <= Y_TOL);
        if (bucket) {
          bucket.parts.push({ x: r.x, str: r.str });
        } else {
          lineBuckets.push({ y: r.y, parts: [{ x: r.x, str: r.str }] });
        }
      }

      // Re-sort buckets by y (top to bottom), then x inside.
      lineBuckets.sort((a, b) => b.y - a.y);
      const lines = lineBuckets.map((b) => {
        b.parts.sort((p1, p2) => p1.x - p2.x);
        return b.parts.map((p) => p.str).join(' ').trim();
      });

      const text = lines.join('\n').trim();
      pages.push(text);
    }

    if (
      sanitizedPages.size > 0 &&
      (process.env.EIGHTFORGE_PDF_EXTRACT_DEBUG === '1' || process.env.EIGHTFORGE_OCR_DEBUG === '1')
    ) {
      console.log('[pdf-extract][sanitize-native-page-text]', {
        sanitized_page_count: sanitizedPages.size,
        pages: Array.from(sanitizedPages.entries()).map(([page_number, stripped_control_count]) => ({
          page_number,
          stripped_control_count,
        })),
      });
    }

    // If everything is empty, treat as null.
    const totalLen = pages.reduce((sum, t) => sum + (t?.length ?? 0), 0);
    return totalLen > 0 ? pages : null;
  } catch (error) {
    console.error('[pdf-extract][extractPdfPageTextNative] pdfjs page text failed', error);
    return null;
  }
}

async function extractPdfTextWithOptions(
  bytes: ArrayBuffer,
  opts: { maxPages?: number },
): Promise<string | null> {
  try {
    const { createRequire } = await import('node:module');
    const require = createRequire(import.meta.url);
    // Use the lib entry directly — same reason as extractPdfText above.
    const pdf = require('pdf-parse/lib/pdf-parse.js') as
      | ((buffer: Buffer, options?: Record<string, unknown>) => Promise<{ text?: string }>)
      | undefined;
    if (typeof pdf !== 'function') return null;
    const buffer = Buffer.from(bytes);
    const pdfOpts: Record<string, unknown> = {};
    if (typeof opts.maxPages === 'number' && opts.maxPages > 0) {
      // pdf-parse supports `max` (max number of pages).
      pdfOpts.max = opts.maxPages;
    }
    const result = await pdf(buffer, pdfOpts);
    const raw = result?.text;
    if (typeof raw !== 'string') return null;
    const strippedControlCount = countUnsafeTextControls(raw);
    if (
      strippedControlCount > 0 &&
      (process.env.EIGHTFORGE_PDF_EXTRACT_DEBUG === '1' || process.env.EIGHTFORGE_OCR_DEBUG === '1')
    ) {
      console.log('[pdf-extract][sanitize-pdf-parse]', {
        mode: 'partial',
        stripped_control_count: strippedControlCount,
        max_pages: opts.maxPages ?? null,
      });
    }
    const text = normalizeWhitespace(raw);
    return text.length > 0 ? text : null;
  } catch (err) {
    console.error(
      '[pdf-extract][extractPdfTextWithOptions] pdf-parse threw',
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

function combinePageTextEvidence(
  pages: PageTextEvidence[] | null,
): string | null {
  if (!pages || pages.length === 0) return null;
  const combined = normalizeWhitespace(
    pages
      .map((page) => page.text)
      .filter((text): text is string => typeof text === 'string' && text.trim().length > 0)
      .join('\n\n'),
  );
  return combined.length > 0 ? combined : null;
}

/**
 * Minimal OCR recovery for weak contract-like PDFs.
 * Runs whole-page OCR only after the existing weak PDF gate has fired so
 * downstream normalization can keep using the shared text/evidence path.
 */
type PdfOcrExtractionResult = {
  pages: PageTextEvidence[] | null;
  pagesAttempted: number;
  confidenceAvg: number | null;
};

async function extractPdfPageTextViaOcr(
  bytes: ArrayBuffer,
  opts?: { pageNumbers?: number[] | null },
): Promise<PdfOcrExtractionResult> {
  const fallbackResult: PdfOcrExtractionResult = {
    pages: null,
    pagesAttempted: 0,
    confidenceAvg: null,
  };

  try {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const { createCanvas } = await import('@napi-rs/canvas');
    const { createWorker } = await import('tesseract.js');

    const data = new Uint8Array(bytes);
    const pdfDoc = await pdfjs.getDocument({ data }).promise;

    const requestedPages =
      opts?.pageNumbers?.filter((pageNum) => Number.isInteger(pageNum) && pageNum > 0)
      ?? Array.from({ length: pdfDoc.numPages }, (_, index) => index + 1);
    const pagesToRender = requestedPages.filter((p) => p >= 1 && p <= pdfDoc.numPages);
    if (pagesToRender.length === 0) return fallbackResult;

    const langPath = getLocalTesseractLangPath();
    const worker = await createWorker('eng', undefined, { langPath });
    try {
      await worker.setParameters({ tessedit_pageseg_mode: 6 as unknown as never });
      const out: PageTextEvidence[] = [];
      const confidences: number[] = [];

      for (const pageNum of pagesToRender) {
        const page = await pdfDoc.getPage(pageNum);
        const viewport = page.getViewport({ scale: 2 });
        const canvas = createCanvas(Math.floor(viewport.width), Math.floor(viewport.height));
        const ctx = canvas.getContext('2d') as unknown as CanvasRenderingContext2D;

        const renderContext: Parameters<typeof page.render>[0] = {
          canvas: canvas as unknown as HTMLCanvasElement,
          canvasContext: ctx,
          viewport,
        };
        await page.render(renderContext).promise;
        const pngBuffer = canvas.toBuffer('image/png');
        const result = await worker.recognize(pngBuffer);
        const text = result?.data?.text;
        const confidence = result?.data?.confidence;

        if (typeof confidence === 'number' && Number.isFinite(confidence)) {
          confidences.push(confidence);
        }
        if (typeof text === 'string' && text.trim().length > 0) {
          out.push({
            page_number: pageNum,
            text: normalizePageLikeText(text),
            source_method: 'ocr' as EvidenceSourceMethod,
          });
        }
      }

      return {
        pages: out.length > 0 ? out : null,
        pagesAttempted: pagesToRender.length,
        confidenceAvg:
          confidences.length > 0
            ? Number((confidences.reduce((sum, value) => sum + value, 0) / confidences.length).toFixed(2))
            : null,
      };
    } finally {
      await worker.terminate();
    }
  } catch (error) {
    if (process.env.EIGHTFORGE_OCR_DEBUG === '1') {
      console.error('[extractPdfPageTextViaOcr] failed', error);
    }
    return fallbackResult;
  }
}

async function extractContractTextViaOcr(bytes: ArrayBuffer): Promise<string | null> {
  const result = await extractPdfPageTextViaOcr(bytes);
  return combinePageTextEvidence(result.pages);
}

function buildBase(
  metadata: DocumentMetadata,
  mode: ExtractionMode,
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

function applyPdfExtractionMetadata(
  payload: ExtractionPayload,
  metadata: {
    extraction_mode: PdfExtractionMode;
    ocr_trigger_reason: string | null;
    ocr_pages_attempted: number;
    ocr_confidence_avg: number | null;
    canonical_persisted: boolean;
    gate_context: {
      contract_like: boolean;
      full_weak: boolean;
      meaningful_pdf_text: boolean;
      fallback_allowed: boolean;
      fallback_reason: string | null;
    };
  },
): void {
  payload.extraction.metadata = metadata;
}

function dedupeEvidence(evidence: EvidenceObject[]): EvidenceObject[] {
  const seen = new Set<string>();
  return evidence.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

function dedupeGaps(gaps: ExtractionGap[]): ExtractionGap[] {
  const seen = new Set<string>();
  return gaps.filter((gap) => {
    const key = `${gap.category}:${gap.page ?? gap.sheet ?? 'global'}:${gap.row ?? '0'}:${gap.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function applyPdfContentLayers(
  payload: ExtractionPayload,
  params: {
    text: ReturnType<typeof buildPdfTextExtraction>;
    tables: ReturnType<typeof buildPdfTableExtraction>;
    forms: ReturnType<typeof buildPdfFormExtraction>;
    pdfEvidenceLayer: ReturnType<typeof buildPdfEvidenceMap>;
    parsedElementsLayer?: ParsedElementsV1 | null;
  },
): void {
  const parsedElementEvidence =
    params.parsedElementsLayer?.status === 'available'
      ? buildElementEvidence({
          sourceDocumentId: payload.document_id,
          elements: params.parsedElementsLayer.elements,
        })
      : [];

  const evidence = dedupeEvidence([
    ...params.pdfEvidenceLayer.evidence,
    ...parsedElementEvidence,
  ]);
  const gaps = dedupeGaps([
    ...params.pdfEvidenceLayer.gaps,
    ...(params.parsedElementsLayer?.gaps ?? []),
  ]);

  if (params.parsedElementsLayer) {
    payload.extraction.parsed_elements_v1 = params.parsedElementsLayer;
  }

  payload.extraction.content_layers_v1 = {
    parser_version: 'content_layers_v1',
    source_kind: 'pdf',
    pdf: {
      text: params.text,
      tables: params.tables,
      forms: params.forms,
      evidence,
      confidence: params.pdfEvidenceLayer.confidence,
      gaps,
    },
  };
}

function estimatedTextConfidence(text: string | null): number {
  if (!text) return 0;
  const normalized = normalizeWhitespace(text);
  if (normalized.length >= 6000) return 0.96;
  if (normalized.length >= 2500) return 0.88;
  if (normalized.length >= 1000) return 0.78;
  if (normalized.length >= 300) return 0.62;
  return 0.45;
}

function resolvedDetectedDocumentType(
  classification: InstructorClassificationSnapshot,
  current: string | null,
): string | null {
  if (classification.detected_document_type) return classification.detected_document_type;
  return current;
}

function applyDetectedDocumentType(
  payload: ExtractionPayload,
  classification: InstructorClassificationSnapshot,
): void {
  const detectedType = resolvedDetectedDocumentType(
    classification,
    payload.fields.detected_document_type ?? payload.extraction.detected_document_type ?? null,
  );
  payload.fields.detected_document_type = detectedType;
  payload.extraction.detected_document_type = detectedType;
}

function ensureAiAssist(payload: ExtractionPayload): InstructorAssistSnapshot {
  if (!payload.extraction.ai_assist_v1) {
    payload.extraction.ai_assist_v1 = {
      parser_version: 'instructor_ai_assist_v1',
      provider: 'openai_instructor',
      classification: {
        parser_version: 'instructor_classification_v1',
        status: 'skipped',
        source: 'fallback',
        family: 'generic',
        detected_document_type: null,
        confidence: 0,
        reasons: [],
        warnings: [],
        attempts: 0,
        model: null,
      },
    };
  }

  return payload.extraction.ai_assist_v1;
}

function applyInstructorClassification(
  payload: ExtractionPayload,
  classification: InstructorClassificationSnapshot,
): void {
  const aiAssist = ensureAiAssist(payload);
  aiAssist.classification = classification;
  applyDetectedDocumentType(payload, classification);
}

function uniqueStrings(values: Array<string | null | undefined>, maxItems = 12): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = typeof value === 'string' ? normalizeWhitespace(value) : '';
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
    if (out.length >= maxItems) break;
  }
  return out;
}

function extractPdfSectionLabels(params: {
  text: ReturnType<typeof buildPdfTextExtraction>;
  tables: ReturnType<typeof buildPdfTableExtraction>;
}): string[] {
  return uniqueStrings([
    ...params.tables.tables.flatMap((table) => table.header_context),
    ...params.text.pages.flatMap((page) =>
      page.plain_text_blocks
        .map((block) => block.text.split('\n')[0]?.trim() ?? '')
        .filter((line) =>
          line.length >= 4
          && line.length <= 140
          && (/^(section|exhibit|attachment|appendix)\b/i.test(line)
            || line === line.toUpperCase()),
        ),
    ),
  ]);
}

function extractPdfTableHeaders(
  tables: ReturnType<typeof buildPdfTableExtraction>,
): string[] {
  return uniqueStrings(tables.tables.flatMap((table) => table.headers));
}

function extractPdfFormLabels(
  forms: ReturnType<typeof buildPdfFormExtraction>,
): string[] {
  return uniqueStrings(forms.fields.map((field) => field.label));
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
  const contractDebugEnabled = process.env.EIGHTFORGE_DEBUG_CONTRACT === '1';

  if (isTextLike(fileName, mimeType)) {
    const fullDecoded = decodeTextPreview(fileBytes);
    const textPreview =
      fullDecoded != null && fullDecoded.length > MAX_PREVIEW_CHARS
        ? fullDecoded.slice(0, MAX_PREVIEW_CHARS)
        : fullDecoded;
    const payload = buildBase(metadata, 'text', textPreview);
    payload.file.mime_type = mimeType;
    payload.file.size_bytes = size;
    const classification = await classifyDocumentFamily({
      documentType: metadata.document_type ?? null,
      fileName,
      title: metadata.title ?? null,
      mimeType,
      textPreview: fullDecoded,
    });
    applyInstructorClassification(payload, classification);
    if (fullDecoded && fullDecoded.length > 0) {
      applyDerivedFields(payload, fullDecoded);
    }
    const extractionAssist = await maybeAssistTypedExtraction({
      detectedDocumentType: payload.fields.detected_document_type ?? null,
      currentTypedFields: payload.fields.typed_fields ?? null,
      extractionConfidence: estimatedTextConfidence(fullDecoded),
      gaps: [],
      textPreview: fullDecoded,
    });
    if (extractionAssist.snapshot) {
      ensureAiAssist(payload).extraction_assist = extractionAssist.snapshot;
    }
    if (extractionAssist.mergedTypedFields) {
      payload.fields.typed_fields = extractionAssist.mergedTypedFields;
    }

    const pageText: PageTextEvidence[] = fullDecoded
      ? [{ page_number: 1, text: fullDecoded, source_method: 'text' as EvidenceSourceMethod }]
      : [];
    payload.extraction.evidence_v1 = buildEvidenceV1({
      pageText,
      documentTypeHint: payload.fields.detected_document_type ?? null,
    });
    return payload;
  }

  if (isPdf(fileName, mimeType)) {
    const ocrDebug = process.env.EIGHTFORGE_OCR_DEBUG === '1';
    const pdfDebug = ocrDebug || process.env.EIGHTFORGE_PDF_EXTRACT_DEBUG === '1';
    const logPdf = (message: string, data?: Record<string, unknown>) => {
      if (!pdfDebug) return;
      // Keep logs structured for single-rerun diagnosis.
      console.log('[pdf-extract]', message, data ?? {});
    };
    const [extractedTextFull, nativePageTexts] = await Promise.all([
      extractPdfText(cloneArrayBuffer(fileBytes)),
      extractPdfPageTextNative(cloneArrayBuffer(fileBytes)),
    ]);

    const contractLike =
      (metadata.document_type ?? '').toLowerCase().includes('contract') ||
      fileName.toLowerCase().includes('contract');

    logPdf('pdf-parse full complete', {
      fileName,
      contractLike,
      did_pdf_parse_full: true,
      extracted_text_length: extractedTextFull?.length ?? 0,
      native_page_text_count: nativePageTexts?.length ?? 0,
      native_page_text_total_length: (nativePageTexts ?? []).reduce((sum, t) => sum + (t?.length ?? 0), 0),
    });

    // Always evaluate text quality. OCR/pdf_fallback only when pdf-parse is weak AND
    // there is no meaningful native/layout text (length or structured blocks).
    const fullWeak = isWeakExtractedText(extractedTextFull);
    let extractedText: string | null = null;
    let extractionMode: PdfExtractionMode = 'pdf_text';
    let didAttemptOcr = false;
    let didAttemptOcrPrimary = false;
    let didAttemptOcrTargeted = false;
    let ocrCombinedTextLength = 0;
    let ocrEvidencePageCount = 0;
    let ocrPagesAttempted = 0;
    let ocrConfidenceAvg: number | null = null;
    let ocrTriggerReason: string | null = null;
    const pdfParsePartialLength: number | null = null;
    const partialWeak: boolean | null = null;
    let fallbackReason: string | null = null;
    let evidencePageText: PageTextEvidence[] = [];

    if (nativePageTexts && nativePageTexts.length > 0) {
      evidencePageText = nativePageTexts.map((t, idx) => ({
        page_number: idx + 1,
        text: t,
        source_method: 'pdf_text' as EvidenceSourceMethod,
      }));
    }

    const pdfLayout = await loadPdfLayout(cloneArrayBuffer(fileBytes), {
      maxPages: MAX_EVIDENCE_PAGES,
    });
    const pdfGateTextLayer = buildPdfTextExtraction({
      layout: pdfLayout,
      fallbackText: null,
      fallbackPages: null,
    });
    const layoutPlainCombinedForGate = computeLayoutPlainCombinedText(pdfLayout);
    const nativePageWordCounts = (nativePageTexts ?? []).map((text) => countReadableWords(text));
    const hasStructuredPlainBlocks = pdfGateTextLayer.pages.some(
      (p) => p.plain_text_blocks.length > 0,
    );
    const meaningfulPdfText = hasMeaningfulPdfTextSignals({
      hasStructuredPlainBlocks,
      layoutPlainCombinedText: layoutPlainCombinedForGate,
      nativePageTexts,
    });
    const fallbackAllowed = fullWeak && !meaningfulPdfText;
    logPdf('pdf fallback gate evaluated', {
      fileName,
      contractLike,
      page_count: pdfLayout.page_count,
      extracted_text_length: extractedTextFull?.length ?? 0,
      native_page_text_lengths: nativePageTexts
        ? nativePageTexts.slice(0, MAX_EVIDENCE_PAGES).map((t, idx) => ({
            page_number: idx + 1,
            text_length: t?.length ?? 0,
            word_count: nativePageWordCounts[idx] ?? 0,
          }))
        : [],
      has_structured_plain_blocks: hasStructuredPlainBlocks,
      layout_plain_combined_length: layoutPlainCombinedForGate.length,
      layout_plain_combined_word_count: countReadableWords(layoutPlainCombinedForGate),
      fullWeak,
      meaningful_pdf_text: meaningfulPdfText,
      fallback_allowed: fallbackAllowed,
      fallback_reason:
        meaningfulPdfText
          ? 'blocked_meaningful_native_or_layout_text'
          : fallbackAllowed
            ? 'allowed_pdf_parse_insufficient_no_structured_blocks'
            : 'skipped_pdf_parse_not_weak',
    });

    if (!fullWeak) {
      extractedText = extractedTextFull;
      extractionMode = 'pdf_text';
      fallbackReason = null;
    } else if (meaningfulPdfText) {
      const nativeAgg = combinePageTextEvidence(evidencePageText);
      const layoutCombined = pdfGateTextLayer.combined_text.trim();
      if (nativeAgg && nativeAgg.length > 0) {
        extractedText = nativeAgg;
      } else if (layoutCombined.length > 0) {
        extractedText = layoutCombined;
      } else {
        extractedText = extractedTextFull ?? '';
      }
      extractionMode = 'pdf_text';
      fallbackReason = null;
    } else if (contractLike && fallbackAllowed) {
      didAttemptOcr = true;
      didAttemptOcrPrimary = true;
      extractionMode = 'ocr_recovery';
      ocrTriggerReason = 'pdf_parse_full_weak_contract_like';
      fallbackReason = ocrTriggerReason;

      logPdf('ocr recovery triggered for weak contract pdf', {
        fileName,
        page_count: pdfLayout.page_count,
        extracted_text_length: extractedTextFull?.length ?? 0,
        fallback_allowed: fallbackAllowed,
        ocr_trigger_reason: ocrTriggerReason,
      });

      const ocrResult = await extractPdfPageTextViaOcr(cloneArrayBuffer(fileBytes));
      const ocrPages = ocrResult.pages;
      const extractedTextOcr = combinePageTextEvidence(ocrPages);
      const ocrLen = extractedTextOcr?.length ?? 0;
      ocrCombinedTextLength = ocrLen;
      ocrEvidencePageCount = ocrPages?.length ?? 0;
      ocrPagesAttempted = ocrResult.pagesAttempted;
      ocrConfidenceAvg = ocrResult.confidenceAvg;

      logPdf('ocr recovery complete', {
        ocr_text_length: ocrLen,
        ocr_pages_attempted: ocrPagesAttempted,
        ocr_confidence_avg: ocrConfidenceAvg,
      });

      extractedText = extractedTextOcr ?? '';
      fallbackReason = extractedTextOcr && extractedTextOcr.trim().length > 0
        ? 'ocr_recovery_used_full_document'
        : 'ocr_recovery_attempted_but_empty';

      if (ocrPages && ocrPages.length > 0) {
        evidencePageText = ocrPages;
      }
    }

    // If this is contract-like, we may have strong later-page body text but image-only agreement
    // front matter. OCR only the weak front/signature pages so canonical contractor/date facts can
    // see the introductory paragraph, commencement clause, and signature block.
    if (contractLike && !didAttemptOcr && meaningfulPdfText) {
      const preliminary = buildEvidenceV1({
        pageText: evidencePageText,
        documentTypeHint: metadata.document_type ?? null,
      });
      const structured = (preliminary.structured_fields ?? {}) as Record<string, unknown>;
      const frontPages = evidencePageText
        .filter((page) => page.page_number >= 1 && page.page_number <= 10);
      const weakFrontPages = frontPages
        .filter((page) => {
          const text = page.text ?? '';
          return text.trim().length < 80 || countReadableWords(text) < 12;
        })
        .map((page) => page.page_number);
      const missingExecutedDate =
        !(typeof structured.executed_date === 'string' && structured.executed_date.trim().length > 0);
      const weakStructuredContractor =
        !(typeof structured.contractor_name === 'string' && structured.contractor_name.trim().length > 5) ||
        /^[a-z]/.test(String(structured.contractor_name).trim());

      if (frontPages.length >= 4 && weakFrontPages.length >= 4 && (missingExecutedDate || weakStructuredContractor)) {
        didAttemptOcr = true;
        didAttemptOcrTargeted = true;
        const ocrResult = await extractPdfPageTextViaOcr(cloneArrayBuffer(fileBytes), {
          pageNumbers: weakFrontPages,
        });
        const ocrPages = ocrResult.pages;
        const targetedOcrLen = combinePageTextEvidence(ocrPages)?.length ?? 0;
        if (targetedOcrLen > ocrCombinedTextLength) {
          ocrCombinedTextLength = targetedOcrLen;
        }
        ocrEvidencePageCount = Math.max(ocrEvidencePageCount, ocrPages?.length ?? 0);
        ocrPagesAttempted = Math.max(ocrPagesAttempted, ocrResult.pagesAttempted);
        if (typeof ocrResult.confidenceAvg === 'number' && Number.isFinite(ocrResult.confidenceAvg)) {
          ocrConfidenceAvg = ocrResult.confidenceAvg;
        }
        if (ocrPages && ocrPages.length > 0) {
          const byPage = new Map<number, PageTextEvidence>();
          for (const p of evidencePageText) byPage.set(p.page_number, p);
          for (const p of ocrPages) byPage.set(p.page_number, p);
          evidencePageText = Array.from(byPage.values()).sort((a, b) => a.page_number - b.page_number);
          extractedText = combinePageTextEvidence(evidencePageText) ?? extractedText;
        }
      }
    }

    // If this is contract-like, we may have strong body text but image-only rate pages.
    // Deterministic targeted OCR: if evidence_v1 does NOT detect a rate section and
    // the likely attachment pages are nearly empty, OCR only those pages.
    // Skip when native/layout already yielded meaningful text (no OCR in that case).
    if (contractLike && !didAttemptOcr && !meaningfulPdfText) {
      const preliminary = buildEvidenceV1({
        pageText: evidencePageText,
        documentTypeHint: metadata.document_type ?? null,
      });
      const signals = (preliminary.section_signals ?? {}) as Record<string, unknown>;
      const ratePresent = signals.rate_section_present === true || signals.unit_price_structure_present === true;

      const weakAttachmentPages = evidencePageText.filter((p) => p.page_number >= 8 && p.page_number <= 11)
        .every((p) => (p.text ?? '').trim().length < 40);

      if (!ratePresent && weakAttachmentPages) {
        didAttemptOcr = true;
        didAttemptOcrTargeted = true;
        const ocrResult = await extractPdfPageTextViaOcr(cloneArrayBuffer(fileBytes), {
          pageNumbers: [1, 2, 8, 9, 10, 11],
        });
        const ocrPages = ocrResult.pages;
        const targetedOcrLen = combinePageTextEvidence(ocrPages)?.length ?? 0;
        if (targetedOcrLen > ocrCombinedTextLength) {
          ocrCombinedTextLength = targetedOcrLen;
        }
        ocrEvidencePageCount = Math.max(ocrEvidencePageCount, ocrPages?.length ?? 0);
        ocrPagesAttempted = Math.max(ocrPagesAttempted, ocrResult.pagesAttempted);
        if (typeof ocrResult.confidenceAvg === 'number' && Number.isFinite(ocrResult.confidenceAvg)) {
          ocrConfidenceAvg = ocrResult.confidenceAvg;
        }
        if (ocrPages && ocrPages.length > 0) {
          const byPage = new Map<number, PageTextEvidence>();
          for (const p of evidencePageText) byPage.set(p.page_number, p);
          for (const p of ocrPages) byPage.set(p.page_number, p);
          evidencePageText = Array.from(byPage.values()).sort((a, b) => a.page_number - b.page_number);

          // Do not change extractionMode; we still have pdf text, but now have OCR evidence for weak pages.
        }
      }
    }

    const textPreview: string | null =
      extractedText != null
        ? extractedText.length > MAX_PREVIEW_CHARS
          ? extractedText.slice(0, MAX_PREVIEW_CHARS)
          : extractedText
        : null;

    const unstructuredPartitionPromise = partitionWithUnstructured({
      bytes: cloneArrayBuffer(fileBytes),
      fileName,
      mimeType,
    });
    logPdf('pdfjs layout complete', {
      did_pdfjs_layout_run: true,
      layout_page_count: pdfLayout.page_count,
      layout_pages_parsed: pdfLayout.pages.length,
      layout_gaps: pdfLayout.gaps.map((g) => ({ id: g.id, category: g.category, severity: g.severity })),
    });
    const pdfTextLayer = buildPdfTextExtraction({
      layout: pdfLayout,
      fallbackText: extractedText ?? textPreview ?? null,
      fallbackPages: evidencePageText,
    });
    const layoutLineKindCounts = countPdfLayoutLinesByKind(pdfLayout);
    const layoutPlainCombinedLength = computeLayoutPlainCombinedText(pdfLayout).length;
    const textLayerUsedFallbackTextOnlyGap = pdfTextLayer.gaps.some(
      (g) => g.category === 'fallback_text_only',
    );
    const pdfTableLayer = buildPdfTableExtraction({
      layout: pdfLayout,
    });
    logPdf('pdf text layer built', {
      extracted_text_length: extractedText?.length ?? 0,
      text_preview_length: textPreview?.length ?? 0,
      pdf_text_page_count: pdfTextLayer.page_count,
      pdf_text_combined_length: pdfTextLayer.combined_text.length,
      layout_plain_combined_length: layoutPlainCombinedLength,
      layout_line_kind_counts: layoutLineKindCounts,
      layout_table_candidate_lines: layoutLineKindCounts.table_candidate ?? 0,
      text_layer_fallback_text_only_gap: textLayerUsedFallbackTextOnlyGap,
      pdf_table_count: pdfTableLayer.tables.length,
      pdf_text_gaps: pdfTextLayer.gaps.map((g) => ({ id: g.id, category: g.category, severity: g.severity })),
    });
    const pdfFormLayer = buildPdfFormExtraction({
      layout: pdfLayout,
    });
    const pdfEvidenceLayer = buildPdfEvidenceMap({
      sourceDocumentId: metadata.id,
      text: pdfTextLayer,
      tables: pdfTableLayer,
      forms: pdfFormLayer,
    });
    const unstructuredPartition = await unstructuredPartitionPromise;
    const parsedElementsLayer = unstructuredPartition
      ? mapUnstructuredElements({
          partition: unstructuredPartition,
          tables: pdfTableLayer,
        })
      : null;
    // If pdfjs layout produced strong text, do not label this run as "pdf_fallback" just because pdf-parse was weak.
    const layoutTextStrong = pdfTextLayer.combined_text.trim().length >= 500 && !isMostlyWhitespace(pdfTextLayer.combined_text);
    if (extractionMode === 'pdf_fallback' && layoutTextStrong) {
      logPdf('overriding pdf_fallback due to strong layout text', {
        prior_fallback_reason: fallbackReason,
        combined_text_length: pdfTextLayer.combined_text.length,
      });
      extractionMode = 'pdf_text';
      fallbackReason = 'layout_text_strong_overrode_fallback';
    }
    const fallbackPathUsed =
      extractionMode === 'pdf_fallback' || extractionMode === 'ocr_recovery';
    const combinedPdfGaps = dedupeGaps([
      ...pdfEvidenceLayer.gaps,
      ...(parsedElementsLayer?.gaps ?? []),
    ]);

    const nativeTextTotalLength = (nativePageTexts ?? []).reduce(
      (sum, t) => sum + (t?.length ?? 0),
      0,
    );
    const layoutTotalLineCount = pdfLayout.pages.reduce((n, p) => n + p.lines.length, 0);
    const syntheticEvidencePageCollapsed =
      evidencePageText.length === 0
      && textPreview != null
      && textPreview.trim().length > 0;

    let upstreamDiagnosticNote: string | null = null;
    if (layoutTotalLineCount > 0 && layoutPlainCombinedLength === 0) {
      upstreamDiagnosticNote =
        'layout_has_lines_but_plain_text_blocks_empty_fell_back_to_pdf_parse_or_ocr_string';
    }
    if (
      pdfTableLayer.tables.length === 0
      && (layoutLineKindCounts.table_candidate ?? 0) >= 4
    ) {
      upstreamDiagnosticNote = upstreamDiagnosticNote
        ? `${upstreamDiagnosticNote};table_candidate_lines_but_no_extracted_tables`
        : 'table_candidate_lines_present_but_zero_extracted_tables';
    }

    const upstreamExtractionDebug: Record<string, unknown> | null = contractDebugEnabled
      ? {
          source_mode: extractionMode,
          contract_like: contractLike,
          pdf_parse_full_length: extractedTextFull?.length ?? 0,
          pdf_parse_full_weak: fullWeak,
          pdf_parse_partial_length: pdfParsePartialLength,
          pdf_parse_partial_weak: partialWeak,
          pdf_text_length: extractedText?.length ?? 0,
          pdf_text_preview_length: textPreview?.length ?? 0,
          native_page_text_page_count: nativePageTexts?.length ?? 0,
          native_text_total_length: nativeTextTotalLength,
          native_page_text_available: Boolean(nativePageTexts && nativePageTexts.length > 0),
          ocr_text_length: ocrCombinedTextLength,
          ocr_evidence_page_count: ocrEvidencePageCount,
          ocr_pages_attempted: ocrPagesAttempted,
          ocr_confidence_avg: ocrConfidenceAvg,
          ocr_trigger_reason: ocrTriggerReason,
          did_attempt_ocr: didAttemptOcr,
          did_attempt_ocr_primary: didAttemptOcrPrimary,
          did_attempt_ocr_targeted: didAttemptOcrTargeted,
          pdfjs_page_count: pdfLayout.page_count,
          layout_pages_parsed: pdfLayout.pages.length,
          layout_total_line_count: layoutTotalLineCount,
          layout_line_kind_counts: layoutLineKindCounts,
          layout_plain_combined_length: layoutPlainCombinedLength,
          pdf_text_layer_combined_length: pdfTextLayer.combined_text.length,
          text_layer_fallback_text_only_gap: textLayerUsedFallbackTextOnlyGap,
          parsed_elements_present: Boolean(parsedElementsLayer),
          parsed_elements_count: parsedElementsLayer?.element_count ?? 0,
          parsed_elements_status: parsedElementsLayer?.status ?? null,
          table_count: pdfTableLayer.tables.length,
          table_candidate_line_count: layoutLineKindCounts.table_candidate ?? 0,
          synthetic_evidence_page_collapsed: syntheticEvidencePageCollapsed,
          fallback_path_used: fallbackPathUsed,
          fallback_reason: fallbackPathUsed ? fallbackReason : null,
          upstream_diagnostic_note: upstreamDiagnosticNote,
          table_candidates: pdfTableLayer.tables.map((t) => ({
            id: t.id,
            page: t.page_number,
            headers: t.headers,
            row_count: t.rows.length,
          })),
          native_page_text_lengths: nativePageTexts
            ? nativePageTexts.slice(0, 25).map((t, idx) => ({
                page_number: idx + 1,
                text_length: t?.length ?? 0,
              }))
            : null,
        }
      : null;

    // If OCR ran, we must not return `text_preview: null` even if OCR was imperfect.
    if (textPreview != null && (textPreview.length > 0 || didAttemptOcr)) {
      logPdf('building extraction payload (primary pdf path)', {
        extraction_mode: extractionMode,
        fallback_reason: fallbackPathUsed ? fallbackReason : null,
        evidence_page_text_count: evidencePageText.length,
        synthetic_evidence_page_collapsed: syntheticEvidencePageCollapsed,
        will_persist_parsed_elements_v1: Boolean(parsedElementsLayer),
        will_persist_content_layers_v1: true,
        pdf_evidence_object_count: pdfEvidenceLayer.evidence.length,
      });
      const payload = buildBase(metadata, extractionMode, textPreview);
      payload.file.mime_type = mimeType ?? 'application/pdf';
      payload.file.size_bytes = size;
      applyPdfExtractionMetadata(payload, {
        extraction_mode: extractionMode,
        ocr_trigger_reason: ocrTriggerReason,
        ocr_pages_attempted: ocrPagesAttempted,
        ocr_confidence_avg: ocrConfidenceAvg,
        canonical_persisted: false,
        gate_context: {
          contract_like: contractLike,
          full_weak: fullWeak,
          meaningful_pdf_text: meaningfulPdfText,
          fallback_allowed: fallbackAllowed,
          fallback_reason: fallbackPathUsed ? fallbackReason : null,
        },
      });
      if (upstreamExtractionDebug) {
        (payload.extraction as Record<string, unknown>).debug_contract = upstreamExtractionDebug;
      }
      const classification = await classifyDocumentFamily({
        documentType: metadata.document_type ?? null,
        fileName,
        title: metadata.title ?? null,
        mimeType,
        textPreview: extractedText ?? textPreview,
        tableHeaders: extractPdfTableHeaders(pdfTableLayer),
        sectionLabels: extractPdfSectionLabels({
          text: pdfTextLayer,
          tables: pdfTableLayer,
        }),
      });
      applyInstructorClassification(payload, classification);
      applyDerivedFields(payload, extractedText ?? '');
      const extractionAssist = await maybeAssistTypedExtraction({
        detectedDocumentType: payload.fields.detected_document_type ?? null,
        currentTypedFields: payload.fields.typed_fields ?? null,
        extractionConfidence: pdfEvidenceLayer.confidence,
        gaps: combinedPdfGaps,
        textPreview: extractedText ?? textPreview,
        sectionLabels: extractPdfSectionLabels({
          text: pdfTextLayer,
          tables: pdfTableLayer,
        }),
        tableHeaders: extractPdfTableHeaders(pdfTableLayer),
        formLabels: extractPdfFormLabels(pdfFormLayer),
      });
      if (extractionAssist.snapshot) {
        ensureAiAssist(payload).extraction_assist = extractionAssist.snapshot;
      }
      if (extractionAssist.mergedTypedFields) {
        payload.fields.typed_fields = extractionAssist.mergedTypedFields;
      }
      const fallbackPageText: PageTextEvidence[] =
        evidencePageText.length > 0
          ? evidencePageText
          : (textPreview != null && textPreview.trim().length > 0)
            ? [{
                page_number: 1,
                text: textPreview,
                source_method: extractionMode === 'pdf_text' ? 'pdf_text' : 'ocr',
              } as PageTextEvidence]
            : [];
      payload.extraction.evidence_v1 = buildEvidenceV1({
        pageText: fallbackPageText,
        documentTypeHint: payload.fields.detected_document_type ?? null,
        layoutCombinedText: pdfTextLayer.combined_text,
      });
      applyPdfContentLayers(payload, {
        text: pdfTextLayer,
        tables: pdfTableLayer,
        forms: pdfFormLayer,
        pdfEvidenceLayer,
        parsedElementsLayer,
      });
      // Always log fallback selection reason at least once, even if debug is off.
      if (!pdfDebug && fallbackPathUsed) {
        const contentLayers = payload.extraction.content_layers_v1 as
          | { pdf?: { evidence?: unknown } }
          | undefined;
        const pdfEvidence = contentLayers?.pdf?.evidence;
        const pdfEvidenceCount = Array.isArray(pdfEvidence) ? pdfEvidence.length : null;
        console.warn(`[pdf-extract] selected ${extractionMode}`, {
          fileName,
          extraction_mode: extractionMode,
          fallback_reason: fallbackReason,
          extracted_text_length: extractedText?.length ?? 0,
          page_count: pdfLayout.page_count,
          ocr_trigger_reason: ocrTriggerReason,
          ocr_pages_attempted: ocrPagesAttempted,
          ocr_confidence_avg: ocrConfidenceAvg,
          native_page_text_lengths: nativePageTexts
            ? nativePageTexts.slice(0, 25).map((t, idx) => ({
                page_number: idx + 1,
                text_length: t?.length ?? 0,
              }))
            : [],
          native_page_text_count: nativePageTexts?.length ?? 0,
          layout_pages_parsed: pdfLayout.pages.length,
          pdf_text_combined_length: pdfTextLayer.combined_text.length,
          pdf_evidence_object_count: pdfEvidenceCount,
          evidence_v1_page_text_count: fallbackPageText.length,
          parsed_elements_v1_present: Boolean(payload.extraction.parsed_elements_v1),
          content_layers_v1_present: Boolean(payload.extraction.content_layers_v1),
        });
      }
      if (fallbackPathUsed) {
        payload.summary =
          extractionMode === 'ocr_recovery'
            ? 'File received; weak native PDF text triggered recovery OCR.'
            : 'File received; PDF extraction is not yet deeply parsed server-side.';
      }
      return payload;
    }

    const payload = buildBase(metadata, 'pdf_fallback', null);
    payload.file.mime_type = mimeType ?? 'application/pdf';
    payload.file.size_bytes = size;
    applyPdfExtractionMetadata(payload, {
      extraction_mode: 'pdf_fallback',
      ocr_trigger_reason: ocrTriggerReason,
      ocr_pages_attempted: ocrPagesAttempted,
      ocr_confidence_avg: ocrConfidenceAvg,
      canonical_persisted: false,
      gate_context: {
        contract_like: contractLike,
        full_weak: fullWeak,
        meaningful_pdf_text: meaningfulPdfText,
        fallback_allowed: fallbackAllowed,
        fallback_reason: fallbackReason,
      },
    });
    if (upstreamExtractionDebug) {
      (payload.extraction as Record<string, unknown>).debug_contract = {
        ...upstreamExtractionDebug,
        null_text_preview_path: true,
        synthetic_evidence_page_collapsed: false,
      };
    }
    payload.summary =
      'File received; PDF extraction is not yet deeply parsed server-side.';
    const classification = await classifyDocumentFamily({
      documentType: metadata.document_type ?? null,
      fileName,
      title: metadata.title ?? null,
      mimeType,
      textPreview: extractedText ?? textPreview,
      tableHeaders: extractPdfTableHeaders(pdfTableLayer),
      sectionLabels: extractPdfSectionLabels({
        text: pdfTextLayer,
        tables: pdfTableLayer,
      }),
    });
    applyInstructorClassification(payload, classification);
    applyDerivedFields(payload, extractedText ?? textPreview ?? '');
    const extractionAssist = await maybeAssistTypedExtraction({
      detectedDocumentType: payload.fields.detected_document_type ?? null,
      currentTypedFields: payload.fields.typed_fields ?? null,
      extractionConfidence: pdfEvidenceLayer.confidence,
      gaps: combinedPdfGaps,
      textPreview: extractedText ?? textPreview,
      sectionLabels: extractPdfSectionLabels({
        text: pdfTextLayer,
        tables: pdfTableLayer,
      }),
      tableHeaders: extractPdfTableHeaders(pdfTableLayer),
      formLabels: extractPdfFormLabels(pdfFormLayer),
    });
    if (extractionAssist.snapshot) {
      ensureAiAssist(payload).extraction_assist = extractionAssist.snapshot;
    }
    if (extractionAssist.mergedTypedFields) {
      payload.fields.typed_fields = extractionAssist.mergedTypedFields;
    }
    payload.extraction.evidence_v1 = buildEvidenceV1({
      pageText: evidencePageText,
      documentTypeHint: payload.fields.detected_document_type ?? null,
      layoutCombinedText: pdfTextLayer.combined_text,
    });
    applyPdfContentLayers(payload, {
      text: pdfTextLayer,
      tables: pdfTableLayer,
      forms: pdfFormLayer,
      pdfEvidenceLayer,
      parsedElementsLayer,
    });
    if (pdfDebug) {
      const contentLayers = payload.extraction.content_layers_v1 as
        | { pdf?: { evidence?: unknown } }
        | undefined;
      const pdfEvidence = contentLayers?.pdf?.evidence;
      const evidenceCount = Array.isArray(pdfEvidence) ? pdfEvidence.length : 0;
      logPdf('building extraction payload (null text preview path)', {
        extraction_mode: payload.extraction.mode,
        fallback_reason:
          payload.extraction.mode === 'pdf_fallback' || payload.extraction.mode === 'ocr_recovery'
            ? (fallbackReason ?? 'missing_text_preview')
            : null,
        evidence_page_text_count: evidencePageText.length,
        evidence_v1_page_text_count: evidencePageText.length,
        pdf_evidence_object_count: evidenceCount,
        will_persist_parsed_elements_v1: Boolean(payload.extraction.parsed_elements_v1),
        will_persist_content_layers_v1: Boolean(payload.extraction.content_layers_v1),
      });
    }
    return payload;
  }

  if (isSpreadsheet(fileName, mimeType)) {
    const workbook = await parseWorkbook(cloneArrayBuffer(fileBytes));
    const detectedSheets = detectSheets(workbook);
    const ticketExport = normalizeTicketExport({
      workbook,
      detectedSheets,
    });
    const spreadsheetEvidence = buildSpreadsheetEvidence({
      sourceDocumentId: metadata.id,
      workbook,
      detectedSheets,
      ticketExport,
    });
    const textPreview = workbook.workbook_text_preview || null;
    const payload = buildBase(metadata, 'spreadsheet', textPreview);
    payload.file.mime_type = mimeType;
    payload.file.size_bytes = size;
    if (!payload.fields.detected_document_type && ticketExport) {
      payload.fields.detected_document_type = 'ticket';
      payload.extraction.detected_document_type = 'ticket';
    }
    const classification = await classifyDocumentFamily({
      documentType: payload.fields.detected_document_type ?? metadata.document_type ?? null,
      fileName,
      title: metadata.title ?? null,
      mimeType,
      textPreview,
      tableHeaders: detectedSheets.sheets.map((sheet) => sheet.sheet_name),
    });
    applyInstructorClassification(payload, classification);
    if (textPreview) {
      applyDerivedFields(payload, textPreview);
    }
    payload.extraction.content_layers_v1 = {
      parser_version: 'content_layers_v1',
      source_kind: 'xlsx',
      spreadsheet: {
        workbook,
        detected_sheets: detectedSheets,
        normalized_ticket_export: ticketExport,
        evidence: spreadsheetEvidence.evidence,
        confidence: spreadsheetEvidence.confidence,
        gaps: spreadsheetEvidence.gaps,
      },
    };
    payload.summary = ticketExport
      ? 'Workbook parsed with ticket-export normalization.'
      : 'Workbook parsed into structured sheet evidence.';
    return payload;
  }

  const payload = buildBase(metadata, 'binary_fallback', null);
  payload.file.mime_type = mimeType;
  payload.file.size_bytes = size;
  return payload;
}
