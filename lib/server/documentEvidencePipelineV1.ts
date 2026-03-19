// lib/server/documentEvidencePipelineV1.ts
// Deterministic, inspectable evidence layer for contracts (v1).
// No AI. Pure functions. Designed to be persisted inside extraction blobs.

export type EvidenceSourceMethod = 'pdf_text' | 'ocr' | 'text';

export type PageTextEvidence = {
  page_number: number; // 1-indexed
  text: string;
  source_method: EvidenceSourceMethod;
};

export type ContractStructuredFieldsV1 = {
  contractor_name: string | null;
  owner_name: string | null;
  executed_date: string | null;
  expiration_date: string | null;
  nte_amount: number | null;
};

export type ContractSectionSignalsV1 = {
  // Pricing / compensation section signals
  rate_section_present: boolean;
  rate_section_label: string | null;
  rate_section_pages: number[];
  rate_items_detected: number;
  rate_units_detected: string[];
  time_and_materials_present: boolean;
  unit_price_structure_present: boolean;

  // Compliance / clause signals
  fema_reference_present: boolean;
  federal_clause_signals: string[];
  insurance_requirements_present: boolean;
  permit_or_tdec_reference_present: boolean;
};

export type DocumentEvidenceV1 = {
  parser_version: 'evidence_v1';
  page_text: PageTextEvidence[];
  structured_fields: Record<string, unknown>;
  section_signals: Record<string, unknown>;
};

function normalizeWhitespace(s: string): string {
  return s.replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

function safeLower(s: string): string {
  return s.toLowerCase();
}

function parseMoney(raw: string): number | null {
  const cleaned = raw.replace(/[$,\s]/g, '');
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

function uniqStrings(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of values) {
    const key = v.trim().toLowerCase();
    if (!key) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v.trim());
  }
  return out;
}

function takeBestNameCandidate(raw: string | null): string | null {
  if (!raw) return null;
  const cleaned = raw
    .replace(/\s{2,}/g, ' ')
    .replace(/\b(the)\b/gi, '')
    .replace(/[“”"]/g, '')
    .trim();
  if (cleaned.length < 3) return null;
  // Avoid capturing long clause text; cap to a reasonable org name length.
  return cleaned.length > 120 ? cleaned.slice(0, 120).trim() : cleaned;
}

function firstGroup(text: string, re: RegExp): string | null {
  const copy = new RegExp(re.source, re.flags);
  const m = copy.exec(text);
  return m?.[1]?.trim() ?? null;
}

function collectHeadings(pageText: string): string[] {
  const lines = pageText.split('\n').map((l) => l.trim()).filter(Boolean);
  // Prefer early and uppercase-ish headings; keep deterministic.
  return lines.slice(0, 40).filter((l) => {
    if (l.length < 4 || l.length > 120) return false;
    const letters = l.replace(/[^A-Za-z]/g, '');
    if (letters.length < 4) return false;
    const upper = letters.replace(/[^A-Z]/g, '').length;
    return upper / Math.max(1, letters.length) >= 0.6 || /^[0-9]+\./.test(l);
  });
}

const PARTY_OWNER_RE = /\b(?:owner|client|county|city|town|authority|agency)\b\s*[:=\-]?\s*([A-Z][A-Za-z0-9 &.,'()-]{2,120})/mi;
const PARTY_CONTRACTOR_RE = /\b(?:contractor|vendor|consultant|company|firm)\b\s*[:=\-]?\s*([A-Z][A-Za-z0-9 &.,'()-]{2,120})/mi;
const BETWEEN_RE = /\b(?:by\s+and\s+between|contract\s+between)\b[\s\S]{0,200}?\band\b\s+([A-Z][A-Za-z0-9 &.,'()-]{2,120})/i;
const EXECUTED_DATE_RE = /\b(?:executed\s+(?:on|this)?|dated\s+this|effective\s+as\s+of|effective\s+date)\b[^0-9A-Za-z]{0,30}(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}|\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4})/i;
const EXPIRATION_DATE_RE = /\b(?:expires?\s+on|expiration\s+date|term\s+ends?\s+on)\b[^0-9A-Za-z]{0,30}(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}|\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4})/i;
const NTE_RE = /\b(?:not\s+to\s+exceed|nte|maximum\s+(?:amount|contract|price))\b[\s\S]{0,80}?\$?\s*([\d,]+(?:\.\d{1,2})?)/i;

const RATE_HEADING_KEYWORDS = [
  'exhibit',
  'attachment',
  'appendix',
  'schedule',
  'pricing',
  'price',
  'rates',
  'rate',
  'compensation',
  'fee',
  'fees',
  'fee schedule',
  'rate table',
  'rate schedule',
  'unit prices',
  'bid schedule',
  'cost schedule',
  'time and materials',
  'time-and-materials',
  't&m',
];

const RATE_PHRASES = [
  'compensation shall be based on',
  'rates set forth',
  'rates set out',
  'unit price',
  'hourly rate',
  'time and materials',
  'time-and-materials',
  't&m',
  'cost per',
  'pass through',
  'pass-through',
];

const UNIT_TOKENS = [
  'cubic yard', 'cy', 'ton', 'tons', 'hour', 'hours', 'hr', 'hrs',
  'mile', 'miles', 'each', 'ea', 'load', 'loads', 'day', 'days',
  'lf', 'linear foot', 'sq ft', 'square foot', 'yard', 'yd',
];

const RATE_ROW_RE = /(\$?\s*[\d,]+(?:\.\d{1,2})?)\s*(?:per|\/)\s*(ton|tons|cubic\s+yard|cy|hour|hr|hrs|mile|each|ea|load|day|yd|yard|linear\s+foot|lf|sq\s*ft|square\s+foot)/gi;

function scoreRateBearingPage(pageText: string): {
  score: number;
  labelCandidate: string | null;
  rateRows: number;
  units: string[];
} {
  const normalized = normalizeWhitespace(pageText);
  const lower = safeLower(normalized);

  let score = 0;
  let labelCandidate: string | null = null;

  const headings = collectHeadings(pageText);
  const headingHit = headings.find((h) => RATE_HEADING_KEYWORDS.some((kw) => safeLower(h).includes(kw)));
  if (headingHit) {
    score += 6;
    labelCandidate = headingHit;
  }

  const phraseHits = RATE_PHRASES.filter((p) => lower.includes(p));
  score += Math.min(9, phraseHits.length * 3);

  const dollarSigns = (normalized.match(/\$/g) ?? []).length;
  const moneyLike = (normalized.match(/\b\d{1,3}(?:,\d{3})+(?:\.\d{2})?\b/g) ?? []).length;
  score += Math.min(6, dollarSigns + moneyLike);

  const unitHits = UNIT_TOKENS.filter((u) => lower.includes(u)).length;
  score += Math.min(6, unitHits);

  // Table-ish: many short lines with numbers or repeated row structure.
  const lines = pageText.split('\n').map((l) => l.trim()).filter(Boolean);
  const numericLines = lines.filter((l) => /(\$?\d[\d,]*(?:\.\d{1,2})?)/.test(l)).length;
  if (numericLines >= 8) score += 4;
  if (lines.length >= 25 && numericLines / Math.max(1, lines.length) >= 0.35) score += 2;

  // Count rate rows + units.
  let rateRows = 0;
  const units: string[] = [];
  const re = new RegExp(RATE_ROW_RE.source, RATE_ROW_RE.flags);
  let m: RegExpExecArray | null;
  while ((m = re.exec(normalized)) !== null && rateRows < 200) {
    rateRows += 1;
    if (m[2]) units.push(m[2].toLowerCase());
  }
  if (rateRows >= 3) score += 6;
  else if (rateRows >= 1) score += 2;

  return { score, labelCandidate, rateRows, units: uniqStrings(units) };
}

function detectFederalSignals(textLower: string): string[] {
  const signals: string[] = [];
  const pushIf = (id: string, cond: boolean) => { if (cond) signals.push(id); };
  pushIf('far', /\bfar\b|\bfederal acquisition regulation\b/.test(textLower));
  pushIf('2_cfr_200', /\b2\s*cfr\s*200\b|\buniform guidance\b/.test(textLower));
  pushIf('davis_bacon', /\bdavis[-\s]?bacon\b|\bprevailing wage\b/.test(textLower));
  pushIf('buy_america', /\bbuy america\b|\bbuild america\b/.test(textLower));
  pushIf('e_verify', /\be-verify\b|\beverify\b/.test(textLower));
  pushIf('eo_11246', /\b11246\b|\bequal opportunity\b/.test(textLower));
  return uniqStrings(signals);
}

export function buildEvidenceV1(params: {
  pageText: PageTextEvidence[];
  documentTypeHint: string | null;
}): DocumentEvidenceV1 {
  const docType = (params.documentTypeHint ?? '').toLowerCase();
  const isContractLike = docType.includes('contract');

  const structured_fields: Record<string, unknown> = {};
  const section_signals: Record<string, unknown> = {};

  if (isContractLike) {
    const contract = parseContractEvidenceV1({ pages: params.pageText });
    Object.assign(structured_fields, contract.structured_fields);
    Object.assign(section_signals, contract.section_signals);
  }

  return {
    parser_version: 'evidence_v1',
    page_text: params.pageText,
    structured_fields,
    section_signals,
  };
}

export function parseContractEvidenceV1(params: {
  pages: PageTextEvidence[];
}): {
  structured_fields: ContractStructuredFieldsV1;
  section_signals: ContractSectionSignalsV1;
} {
  const pages = params.pages ?? [];
  const combined = normalizeWhitespace(pages.map((p) => p.text).join('\n\n'));
  const lower = safeLower(combined);

  // Parties: bias toward first 2 pages (cover page / signature / intro).
  const firstPages = pages.filter((p) => p.page_number <= 2).map((p) => p.text).join('\n\n');
  const firstNormalized = normalizeWhitespace(firstPages);
  const firstLower = safeLower(firstNormalized);

  const contractor =
    takeBestNameCandidate(firstGroup(firstNormalized, PARTY_CONTRACTOR_RE)) ??
    takeBestNameCandidate(firstGroup(firstNormalized, BETWEEN_RE)) ??
    takeBestNameCandidate(firstGroup(combined, PARTY_CONTRACTOR_RE));

  const owner =
    takeBestNameCandidate(firstGroup(firstNormalized, PARTY_OWNER_RE)) ??
    takeBestNameCandidate(firstGroup(combined, PARTY_OWNER_RE));

  const executed_date =
    firstGroup(firstNormalized, EXECUTED_DATE_RE) ??
    firstGroup(combined, EXECUTED_DATE_RE);

  const expiration_date =
    firstGroup(combined, EXPIRATION_DATE_RE);

  const nteRaw = firstGroup(combined, NTE_RE);
  const nte_amount = nteRaw ? parseMoney(nteRaw) : null;

  // Pricing / rate-bearing section detection (operational meaning, not literal label).
  const ratePages: Array<{ page: number; score: number; label: string | null; rateRows: number; units: string[] }> = [];
  let bestLabel: string | null = null;
  let bestLabelScore = -1;
  let totalRateRows = 0;
  const allUnits: string[] = [];

  for (const p of pages) {
    const r = scoreRateBearingPage(p.text);
    if (r.labelCandidate && r.score > bestLabelScore) {
      bestLabelScore = r.score;
      bestLabel = r.labelCandidate;
    }
    totalRateRows += r.rateRows;
    allUnits.push(...r.units);
    // Threshold chosen to avoid “Exhibit A” dependency while still requiring multiple signals.
    if (r.score >= 10) {
      ratePages.push({ page: p.page_number, score: r.score, label: r.labelCandidate, rateRows: r.rateRows, units: r.units });
    }
  }

  const rate_section_pages = ratePages
    .sort((a, b) => a.page - b.page)
    .map((r) => r.page);

  const time_and_materials_present =
    /\btime\s*(?:and|&)\s*materials\b/.test(firstLower) ||
    /\bt\s*&\s*m\b/.test(firstLower) ||
    /\bt&m\b/.test(firstLower) ||
    /\btime\s*(?:and|&)\s*materials\b/.test(lower) ||
    /\bt\s*&\s*m\b/.test(lower) ||
    /\bt&m\b/.test(lower);

  const unit_price_structure_present =
    rate_section_pages.length > 0 ||
    lower.includes('unit price') ||
    lower.includes('unit prices');

  const fema_reference_present =
    /\bfema\b/.test(lower) ||
    /\bdr-\d{4}\b/i.test(combined) ||
    lower.includes('federal emergency management');

  const insurance_requirements_present =
    /\binsurance\b/.test(lower) ||
    /\bliability\b/.test(lower) ||
    /\bworkers\s+comp\b/.test(lower) ||
    /\bindemnif/.test(lower);

  const permit_or_tdec_reference_present =
    /\btdec\b/.test(lower) ||
    /\bpermit\b/.test(lower);

  const federal_clause_signals = detectFederalSignals(lower);

  const structured_fields: ContractStructuredFieldsV1 = {
    contractor_name: contractor,
    owner_name: owner,
    executed_date: executed_date ?? null,
    expiration_date: expiration_date ?? null,
    nte_amount,
  };

  const section_signals: ContractSectionSignalsV1 = {
    rate_section_present: rate_section_pages.length > 0,
    rate_section_label: bestLabel,
    rate_section_pages,
    rate_items_detected: totalRateRows,
    rate_units_detected: uniqStrings(allUnits),
    time_and_materials_present,
    unit_price_structure_present,
    fema_reference_present,
    federal_clause_signals,
    insurance_requirements_present,
    permit_or_tdec_reference_present,
  };

  return { structured_fields, section_signals };
}

