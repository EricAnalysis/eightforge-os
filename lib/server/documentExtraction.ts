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
    mode: 'text' | 'pdf_text' | 'pdf_fallback' | 'binary_fallback';
    text_preview: string | null;
    detected_document_type: string | null;
    evidence_v1?: ReturnType<typeof buildEvidenceV1>;
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

function isWeakExtractedText(text: string | null): boolean {
  if (text == null) return true;
  const trimmed = text.trim();
  if (!trimmed) return true;
  if (trimmed.length < 500) return true;
  if (isMostlyWhitespace(trimmed)) return true;
  return false;
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
 */
async function extractPdfText(bytes: ArrayBuffer): Promise<string | null> {
  try {
    const { createRequire } = await import('node:module');
    const require = createRequire(import.meta.url);
    const pdf = require('pdf-parse') as
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

async function extractPdfPageTextNative(bytes: ArrayBuffer): Promise<string[] | null> {
  try {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const data = new Uint8Array(bytes);
    const pdfDoc = await pdfjs.getDocument({ data }).promise;
    const numPages = Math.min(pdfDoc.numPages, MAX_EVIDENCE_PAGES);
    const pages: string[] = [];

    for (let pageNum = 1; pageNum <= numPages; pageNum++) {
      const page = await pdfDoc.getPage(pageNum);
      const tc = await page.getTextContent();
      const items = (tc.items ?? []) as Array<{ str?: string; transform?: number[] }>;
      // Best-effort “line” reconstruction using y-coordinates from transforms.
      // This keeps the layer deterministic + lightweight without requiring layout OCR.
      const rows = items
        .map((it) => ({
          str: (it.str ?? '').trim(),
          x: Array.isArray(it.transform) ? (it.transform[4] ?? 0) : 0,
          y: Array.isArray(it.transform) ? (it.transform[5] ?? 0) : 0,
        }))
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

    // If everything is empty, treat as null.
    const totalLen = pages.reduce((sum, t) => sum + (t?.length ?? 0), 0);
    return totalLen > 0 ? pages : null;
  } catch (error) {
    if (process.env.EIGHTFORGE_OCR_DEBUG === '1') {
      console.error('[extractContractTextViaOcr] failed', error);
    }
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
    const pdf = require('pdf-parse') as
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
    const text = normalizeWhitespace(raw);
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

/**
 * Very narrow OCR fallback for contract PDFs:
 * - Only triggers when PDF text extraction returns effectively empty.
 * - OCRs a small set of pages (page 1 + pages 8–11) to recover key contract signals.
 *
 * This avoids building a general OCR platform while unblocking scanned PDFs
 * that have no extractable text layer.
 */
async function extractContractTextViaOcr(bytes: ArrayBuffer): Promise<string | null> {
  try {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const { createCanvas } = await import('@napi-rs/canvas');
    const { createWorker } = await import('tesseract.js');

    const data = new Uint8Array(bytes);
    const pdfDoc = await pdfjs.getDocument({ data }).promise;

    const requestedPages = [1, 8, 9, 10, 11];
    const pagesToRender = requestedPages.filter((p) => p >= 1 && p <= pdfDoc.numPages);
    if (pagesToRender.length === 0) return null;

    // Provide local language data to avoid runtime downloads.
    // Use a runtime filesystem path so Next does not try to bundle-resolve it.
    const langPath = getLocalTesseractLangPath();

    const worker = await createWorker('eng', undefined, { langPath });
    try {
      await worker.setParameters({ tessedit_pageseg_mode: 6 });

      const parts: string[] = [];
      for (const pageNum of pagesToRender) {
        const page = await pdfDoc.getPage(pageNum);
        const viewport = page.getViewport({ scale: 2 });
        const canvas = createCanvas(Math.floor(viewport.width), Math.floor(viewport.height));
        const ctx = canvas.getContext('2d');

        await page.render({ canvasContext: ctx, viewport }).promise;
        const pngBuffer = canvas.toBuffer('image/png');

        const result = await worker.recognize(pngBuffer);
        const text = result?.data?.text;
        if (typeof text === 'string' && text.trim().length > 0) {
          parts.push(text);
        }
      }

      const combined = normalizeWhitespace(parts.join('\n'));
      return combined.length > 0 ? combined : null;
    } finally {
      await worker.terminate();
    }
  } catch (error) {
    if (process.env.EIGHTFORGE_OCR_DEBUG === '1') {
      console.error('[extractContractTextViaOcr] failed', error);
    }
    return null;
  }
}

async function extractContractPageTextViaOcr(bytes: ArrayBuffer): Promise<PageTextEvidence[] | null> {
  try {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const { createCanvas } = await import('@napi-rs/canvas');
    const { createWorker } = await import('tesseract.js');

    const data = new Uint8Array(bytes);
    const pdfDoc = await pdfjs.getDocument({ data }).promise;

    const requestedPages = [1, 8, 9, 10, 11];
    const pagesToRender = requestedPages.filter((p) => p >= 1 && p <= pdfDoc.numPages);
    if (pagesToRender.length === 0) return null;

    const langPath = getLocalTesseractLangPath();

    const worker = await createWorker('eng', undefined, { langPath });
    try {
      await worker.setParameters({ tessedit_pageseg_mode: 6 });
      const out: PageTextEvidence[] = [];

      for (const pageNum of pagesToRender) {
        const page = await pdfDoc.getPage(pageNum);
        const viewport = page.getViewport({ scale: 2 });
        const canvas = createCanvas(Math.floor(viewport.width), Math.floor(viewport.height));
        const ctx = canvas.getContext('2d');

        await page.render({ canvasContext: ctx, viewport }).promise;
        const pngBuffer = canvas.toBuffer('image/png');
        const result = await worker.recognize(pngBuffer);
        const text = result?.data?.text;
        if (typeof text === 'string' && text.trim().length > 0) {
          out.push({
            page_number: pageNum,
            text: normalizeWhitespace(text),
            source_method: 'ocr' as EvidenceSourceMethod,
          });
        }
      }

      return out.length > 0 ? out : null;
    } finally {
      await worker.terminate();
    }
  } catch (error) {
    if (process.env.EIGHTFORGE_OCR_DEBUG === '1') {
      console.error('[extractContractPageTextViaOcr] failed', error);
    }
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
    const [extractedTextFull, nativePageTexts] = await Promise.all([
      extractPdfText(cloneArrayBuffer(fileBytes)),
      extractPdfPageTextNative(cloneArrayBuffer(fileBytes)),
    ]);

    const contractLike =
      (metadata.document_type ?? '').toLowerCase().includes('contract') ||
      fileName.toLowerCase().includes('contract');

    if (ocrDebug) {
      console.log('[extractDocument][pdf] pdf-parse full', {
        fileName,
        contractLike,
        textLength: extractedTextFull?.length ?? null,
      });
    }

    // Always evaluate text quality. If it is too short/weak, run fallback OCR.
    const fullWeak = isWeakExtractedText(extractedTextFull);

    let extractedText: string | null = null;
    let extractionMode: 'pdf_text' | 'pdf_fallback' = 'pdf_text';
    let didAttemptOcr = false;
    let evidencePageText: PageTextEvidence[] = [];

    if (nativePageTexts && nativePageTexts.length > 0) {
      evidencePageText = nativePageTexts.map((t, idx) => ({
        page_number: idx + 1,
        text: t,
        source_method: 'pdf_text' as EvidenceSourceMethod,
      }));
    }

    if (!fullWeak) {
      extractedText = extractedTextFull;
      extractionMode = 'pdf_text';
    } else if (contractLike) {
      // First try contract-scoped “partial pages” extraction to reduce OCR load.
      const extractedTextPartial = await extractPdfTextWithOptions(cloneArrayBuffer(fileBytes), { maxPages: 15 });
      if (ocrDebug) {
        console.log('[extractDocument][pdf] pdf-parse partial', {
          fileName,
          textLength: extractedTextPartial?.length ?? null,
        });
      }

      const partialWeak = isWeakExtractedText(extractedTextPartial);
      if (!partialWeak && extractedTextPartial != null) {
        extractedText = extractedTextPartial;
        // Keep `pdf_fallback` when we only extracted a shallow/limited slice.
        extractionMode = 'pdf_fallback';
      } else {
        // OCR MUST RUN when parsed extraction is null/weak (<500 or whitespace).
        didAttemptOcr = true;
        const textLengthForLog = extractedTextPartial?.length ?? extractedTextFull?.length ?? null;
        if (ocrDebug) {
          console.log('OCR fallback triggered for contract', { textLength: textLengthForLog });
        }
        const extractedTextOcr = await extractContractTextViaOcr(cloneArrayBuffer(fileBytes));
        const ocrLen = extractedTextOcr?.length ?? 0;
        if (ocrDebug) {
          console.log('OCR result length', ocrLen);
        }

        // Guarantee text_preview is populated when OCR runs.
        extractedText = extractedTextOcr ?? '';
        extractionMode = 'pdf_fallback';

        // OCR is page-scoped; persist minimal page evidence (requested pages only).
        // Note: we don't know which pages had text reliably, so store as “ocr” on page 1.
        const ocrText = extractedTextOcr ?? '';
        if (ocrText.trim().length > 0) {
          evidencePageText = [
            { page_number: 1, text: ocrText, source_method: 'ocr' as EvidenceSourceMethod },
          ];
        }
      }
    }

    // If this is contract-like, we may have strong body text but image-only rate pages.
    // Deterministic targeted OCR: if evidence_v1 does NOT detect a rate section and
    // the likely attachment pages are nearly empty, OCR only those pages.
    if (contractLike && !didAttemptOcr) {
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
        const ocrPages = await extractContractPageTextViaOcr(cloneArrayBuffer(fileBytes));
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

    // If OCR ran, we must not return `text_preview: null` even if OCR was imperfect.
    if (textPreview != null && (textPreview.length > 0 || didAttemptOcr)) {
      const payload = buildBase(metadata, extractionMode, textPreview);
      payload.file.mime_type = mimeType ?? 'application/pdf';
      payload.file.size_bytes = size;
      applyDerivedFields(payload, extractedText ?? '');
      payload.extraction.evidence_v1 = buildEvidenceV1({
        pageText: evidencePageText.length > 0
          ? evidencePageText
          : (textPreview
            ? [{ page_number: 1, text: textPreview, source_method: extractionMode === 'pdf_text' ? 'pdf_text' : 'ocr' } as PageTextEvidence]
            : []),
        documentTypeHint: payload.fields.detected_document_type ?? null,
      });
      if (extractionMode === 'pdf_fallback') {
        payload.summary = 'File received; PDF extraction is not yet deeply parsed server-side.';
      }
      return payload;
    }

    const payload = buildBase(metadata, 'pdf_fallback', null);
    payload.file.mime_type = mimeType ?? 'application/pdf';
    payload.file.size_bytes = size;
    payload.summary =
      'File received; PDF extraction is not yet deeply parsed server-side.';
    payload.extraction.evidence_v1 = buildEvidenceV1({
      pageText: evidencePageText,
      documentTypeHint: payload.fields.detected_document_type ?? null,
    });
    return payload;
  }

  const payload = buildBase(metadata, 'binary_fallback', null);
  payload.file.mime_type = mimeType;
  payload.file.size_bytes = size;
  return payload;
}
