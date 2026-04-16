// lib/server/documentEvidencePipelineV1.ts
// Deterministic, inspectable evidence layer for contracts (v1).
// No AI. Pure functions. Designed to be persisted inside extraction blobs.

import { CONTRACT_FAILURE_MODES } from '@/lib/extraction/failureModes/contractFailureModes';

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
  term_start_date?: string | null;
  term_end_date?: string | null;
  nte_amount: number | null;
  contractor_name_source?: 'explicit_definition' | 'heuristic' | null;
};

export type ContractSectionSignalsV1 = {
  // Pricing / compensation section signals
  // `rate_section_present` / `rate_section_pages` / `rate_items_detected`
  // are reserved for actual table-like schedule pages with structured pricing rows.
  // `unit_price_structure_present` stays broad enough to preserve narrative
  // schedule references for downstream pricing logic.
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
  if (
    /\b(?:contract|vendor)\s+no\.?\b/i.test(cleaned) ||
    /^no\.?\s*[A-Za-z0-9-]+$/i.test(cleaned) ||
    /\b(?:acknowledg(?:ment)?|notary|subscribed and sworn|my commission expires|docusign envelope id)\b/i.test(cleaned)
  ) {
    return null;
  }
  // Avoid capturing long clause text; cap to a reasonable org name length.
  return cleaned.length > 120 ? cleaned.slice(0, 120).trim() : cleaned;
}

function partySearchText(text: string): string {
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  let insideAcknowledgment = false;
  const kept: string[] = [];

  for (const line of lines) {
    if (/\b(?:acknowledg(?:ment)?|notary)\b/i.test(line)) {
      insideAcknowledgment = true;
      continue;
    }
    if (/\b(?:contract|vendor)\s+no\.?\b/i.test(line)) continue;
    if (
      insideAcknowledgment &&
      /^(?:state of\b(?!.*\bdepartment\b)|county of\b|subscribed and sworn\b|before me\b|my commission expires\b|\)\s*ss\b)/i.test(line)
    ) {
      continue;
    }
    kept.push(line);
  }

  return normalizeWhitespace(kept.join('\n'));
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

function testRegex(value: string, pattern: RegExp): boolean {
  const flags = pattern.flags.replace(/g/g, '');
  return new RegExp(pattern.source, flags).test(value);
}

function matchesAnyRegex(value: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => testRegex(value, pattern));
}

function matchesRateScheduleTitleAlias(value: string): boolean {
  return matchesAnyRegex(value, CONTRACT_FAILURE_MODES.rateSchedules.titleAliases);
}

function matchesRateScheduleHeaderSignal(value: string): boolean {
  return matchesAnyRegex(value, CONTRACT_FAILURE_MODES.rateSchedules.headerSignals);
}

const PARTY_OWNER_RE = /\b(?:owner|client|county|city|town|authority|agency)\b\s*[:=\-]?\s*([A-Z][A-Za-z0-9 &.,'()-]{2,120})/mi;
const PARTY_CONTRACTOR_RE = /\b(?:contractor|vendor|consultant|company|firm)\b\s*[:=\-]?\s*([A-Z][A-Za-z0-9 &.,'()-]{2,120})/mi;
// Matches the common government contract pattern: "[NAME] ("Contractor")" anywhere in the intro/signature text.
// This is more reliable than "between ..." because owner clauses often include "by and through" which confuses simple BETWEEN patterns.
const QUOTE = `["'“”‘’]`;
const DEFINED_CONTRACTOR_RE = new RegExp(
  `\\b([A-Z][A-Za-z0-9 &.,'\\-]{2,160}?)\\s*,?\\s*\\(\\s*${QUOTE}?[Cc]ontractor${QUOTE}?\\s*\\)`,
);
// Matches "between ... and [NAME] ("Contractor")" (contractor appears after the conjunction).
const AND_DEFINED_CONTRACTOR_RE = new RegExp(
  `\\bbetween\\b[\\s\\S]{0,260}?\\band\\b\\s+([A-Z][A-Za-z0-9 &.,'\\-]{2,160}?)\\s*,?\\s*\\(\\s*${QUOTE}?[Cc]ontractor${QUOTE}?\\s*\\)`,
  'i',
);
const BETWEEN_RE = /\b(?:by\s+and\s+between|contract\s+between)\b[\s\S]{0,200}?\band\b\s+([A-Z][A-Za-z0-9 &.,'()-]{2,120})/i;
const EXECUTED_DATE_RE = /\b(?:executed\s+(?:on|this)?|dated\s+this|effective\s+as\s+of|effective\s+date)\b[^0-9A-Za-z]{0,30}(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}|\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4})/i;
// Matches "this 28th day of August, 2025" — common government contract date format.
// \s+ intentionally matches newlines so it works when "of" and the month are on adjacent lines.
const ORDINAL_EXECUTED_DATE_RE = /\bthis\s+(\d{1,2}(?:st|nd|rd|th)\s+day\s+of\s+(?:January|February|March|April|May|June|July|August|September|October|November|December),?\s+\d{4})/i;
const EXPIRATION_DATE_RE = /\b(?:expires?\s+on|expiration\s+date|term\s+ends?\s+on)\b[^0-9A-Za-z]{0,30}(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}|\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4})/i;
// Allow hyphens in "not-to-exceed" (government contracts use the hyphenated form).
const NTE_RE = /\b(?:not[\s\-]+(?:to[\s\-]+)?exceed|nte|maximum\s+(?:amount|contract|price))\b[\s\S]{0,120}?\$\s*([\d,]+(?:\.\d{1,2})?)/i;

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const;
const MONTH_MAP: Record<string, number> = Object.fromEntries(
  MONTHS.map((name, idx) => [name.toLowerCase(), idx + 1]),
) as Record<string, number>;

const DATE_CAPTURE = `(` +
  `\\d{1,2}[\\/\\-]\\d{1,2}[\\/\\-]\\d{2,4}` +
  `|(?:${MONTHS.join('|')})\\s+\\d{1,2},?\\s+\\d{4}` +
  `|\\d{1,2}(?:st|nd|rd|th)\\s+day\\s+of\\s+(?:${MONTHS.join('|')}),?\\s+\\d{4}` +
`)`;

const OPENING_PARTY_PAIR_RE = new RegExp(
  `\\bbetween\\b[\\s\\S]{0,40}?(?:the\\s+)?([A-Z][A-Za-z0-9 &.,'()-]{2,160}?)\\s+\\band\\b\\s+([A-Z][A-Za-z0-9 &.,'()-]{2,160}?)(?=[.;]|\\s+(?:agreement\\s+date|effective\\s+date|hereinafter\\b|for\\b)|$)`,
  'i',
);
const AGREEMENT_DATE_RE = new RegExp(`\\bagreement\\s+date\\b[^0-9A-Za-z]{0,24}${DATE_CAPTURE}`, 'i');
const MADE_ENTERED_DATE_RE = new RegExp(`\\b(?:made\\s+and\\s+entered\\s+into|entered\\s+into)\\b[^0-9A-Za-z]{0,24}(?:this\\s+)?${DATE_CAPTURE}`, 'i');
const EFFECTIVE_DATE_ONLY_RE = new RegExp(
  `\\beffective\\s+date(?:\\s+of\\s+(?:this|the)\\s+(?:agreement|contract))?(?:\\s+is|\\s*:|\\s+shall\\s+be)?[^0-9A-Za-z]{0,24}${DATE_CAPTURE}`,
  'i',
);
const RELATIVE_TERM_FROM_EFFECTIVE_RE = /\bnot\s+to\s+exceed\s+(?:(\d+)|([A-Za-z]+))\s+(day|month|year)s?\s+from\s+(?:the\s+)?effective\s+date\b/i;
const SMALL_NUMBER_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
};

function monthDayYearToIso(value: string): string | null {
  const normalized = value.replace(/\s+/g, ' ').trim();
  const m = /^(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+(\d{4})$/i.exec(normalized);
  if (!m) return null;
  const month = MONTH_MAP[m[1].toLowerCase()] ?? 0;
  const day = Number(m[2]);
  const year = Number(m[3]);
  if (!month || day < 1 || day > 31 || year < 1900 || year > 2100) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function numericDateToIso(value: string): string | null {
  const normalized = value.trim();
  const m = /^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/.exec(normalized);
  if (!m) return null;
  const month = Number(m[1]);
  const day = Number(m[2]);
  const yearRaw = Number(m[3]);
  const year = yearRaw < 100 ? 2000 + yearRaw : yearRaw;
  if (month < 1 || month > 12 || day < 1 || day > 31 || year < 1900 || year > 2100) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function anyDateToIso(value: string): string | null {
  const cleaned = value
    .replace(/\b(?:the\s+date\s+of|date\s+of)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  return (
    ordinalDayMonthYearToIso(cleaned) ??
    monthDayYearToIso(cleaned) ??
    numericDateToIso(cleaned) ??
    null
  );
}

function extractOpeningPartyPair(text: string): { owner: string | null; contractor: string | null } | null {
  const match = OPENING_PARTY_PAIR_RE.exec(text);
  if (!match) return null;
  return {
    owner: takeBestNameCandidate(match[1] ?? null),
    contractor: takeBestNameCandidate(match[2] ?? null),
  };
}

function parseSmallInt(rawDigits: string | undefined, rawWord: string | undefined): number | null {
  if (rawDigits) {
    const value = Number(rawDigits);
    return Number.isFinite(value) && value > 0 ? value : null;
  }
  if (!rawWord) return null;
  return SMALL_NUMBER_WORDS[rawWord.toLowerCase()] ?? null;
}

function addRelativeDurationToIsoDate(
  isoDate: string,
  amount: number,
  unit: 'day' | 'month' | 'year',
): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!match) return null;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (unit === 'day') {
    date.setUTCDate(date.getUTCDate() + amount);
  } else if (unit === 'month') {
    date.setUTCMonth(date.getUTCMonth() + amount);
  } else {
    date.setUTCFullYear(date.getUTCFullYear() + amount);
  }
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

const TERM_RANGE_RE = new RegExp(
  `\\b(?:from|beginning|effective\\s+from)\\s+` +
    `(?:the\\s+date\\s+of\\s+(?:the\\s+)?|date\\s+of\\s+(?:the\\s+)?)?(` +
    `\\d{1,2}[\\/\\-]\\d{1,2}[\\/\\-]\\d{2,4}` +
    `|(?:${MONTHS.join('|')})\\s+\\d{1,2},?\\s+\\d{4}` +
  `)\\s*,?\\s*(?:to|through|thru|until)\\s+(` +
    `\\d{1,2}[\\/\\-]\\d{1,2}[\\/\\-]\\d{2,4}` +
    `|(?:${MONTHS.join('|')})\\s+\\d{1,2},?\\s+\\d{4}` +
  `)\\b`,
  'i',
);
const BETWEEN_RANGE_RE = new RegExp(
  `\\bbetween\\s+(` +
    `\\d{1,2}[\\/\\-]\\d{1,2}[\\/\\-]\\d{2,4}` +
    `|(?:${MONTHS.join('|')})\\s+\\d{1,2},?\\s+\\d{4}` +
  `)\\s+and\\s+(` +
    `\\d{1,2}[\\/\\-]\\d{1,2}[\\/\\-]\\d{2,4}` +
    `|(?:${MONTHS.join('|')})\\s+\\d{1,2},?\\s+\\d{4}` +
  `)\\b`,
  'i',
);
const THROUGH_UNTIL_RE = new RegExp(
  `\\b(?:through|thru|until)\\s+(` +
    `\\d{1,2}[\\/\\-]\\d{1,2}[\\/\\-]\\d{2,4}` +
    `|(?:${MONTHS.join('|')})\\s+\\d{1,2},?\\s+\\d{4}` +
  `)\\b`,
  'i',
);

type TermRangePatternId = 'TERM_RANGE' | 'BETWEEN';

function findTermRangeInHaystacks(
  haystacks: Array<{ label: string; text: string }>,
): { match: RegExpExecArray; pattern: TermRangePatternId; haystackLabel: string; sourceText: string } | null {
  for (const { label, text } of haystacks) {
    const t = text.trim();
    if (!t) continue;
    let m = TERM_RANGE_RE.exec(t);
    if (m) return { match: m, pattern: 'TERM_RANGE', haystackLabel: label, sourceText: t };
    m = BETWEEN_RANGE_RE.exec(t);
    if (m) return { match: m, pattern: 'BETWEEN', haystackLabel: label, sourceText: t };
  }
  return null;
}

function termClauseDebugWindow(sourceText: string, rawMatch: string | null | undefined): string {
  if (rawMatch && sourceText.includes(rawMatch)) {
    const i = sourceText.indexOf(rawMatch);
    return sourceText.slice(Math.max(0, i - 50), Math.min(sourceText.length, i + rawMatch.length + 140));
  }
  return (
    sourceText.match(/\bterm of this agreement\b[\s\S]{0,220}/i)?.[0] ??
    sourceText.match(/\bfrom the date of\b[\s\S]{0,160}/i)?.[0] ??
    sourceText.slice(0, 320)
  );
}

function ordinalDayMonthYearToIso(value: string): string | null {
  // Input shape (from ORDINAL_EXECUTED_DATE_RE capture):
  // "28th day of August, 2025"
  const normalized = value.replace(/\s+/g, ' ').trim();
  const m = /^(\d{1,2})(?:st|nd|rd|th)\s+day\s+of\s+(January|February|March|April|May|June|July|August|September|October|November|December),?\s+(\d{4})$/i.exec(normalized);
  if (!m) return null;
  const day = Number(m[1]);
  const year = Number(m[3]);
  if (!Number.isFinite(day) || day < 1 || day > 31) return null;
  if (!Number.isFinite(year) || year < 1900 || year > 2100) return null;
  const monthName = m[2].toLowerCase();
  const monthMap: Record<string, number> = {
    january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
    july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  };
  const month = monthMap[monthName];
  if (!month) return null;
  const mm = String(month).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  return `${year}-${mm}-${dd}`;
}

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

const RATE_PRICE_STRUCTURE_HEADER_SIGNAL_REGEXES = CONTRACT_FAILURE_MODES.rateSchedules.headerSignals.filter((pattern) =>
  /unit price|unit rate|unit cost|rate per|price per|scheduled value/i.test(pattern.source),
);

const TIME_AND_MATERIALS_RE = /\btime(?:\s+|-)?(?:and|&)(?:\s+|-)?materials\b/i;

const UNIT_TOKENS = [
  'cubic yard', 'cy', 'ton', 'tons', 'hour', 'hours', 'hr', 'hrs',
  'mile', 'miles', 'each', 'ea', 'load', 'loads', 'day', 'days',
  'lf', 'linear foot', 'sq ft', 'square foot', 'yard', 'yd',
  'pound', 'lb', 'lbs', 'unit', 'tree', 'stump',
];

const RATE_ROW_RE = /(\$?\s*[\d,]+(?:\.\d{1,2})?)\s*(?:per|\/)\s*(ton|tons|cubic\s+yard|cy|hour|hr|hrs|mile|each|ea|load|day|yd|yard|linear\s+foot|lf|sq\s*ft|square\s+foot|pound|lb|lbs|unit|tree|stump)/gi;
const RATE_REFERENCE_LINE_RE = /\b(?:fee schedule|price schedule|pricing schedule|rate schedule|unit prices?|time\s*(?:and|&)\s*materials(?:\s+rates?)?)\b/i;

type PricingReferencePageDetection = {
  present: boolean;
  score: number;
  labelCandidate: string | null;
};

type StrictRateSchedulePageDetection = {
  qualifies: boolean;
  score: number;
  labelCandidate: string | null;
  rateRows: number;
  units: string[];
};

function unitMatchesForLine(line: string): string[] {
  const lower = safeLower(line);
  return UNIT_TOKENS.filter((unit) => lower.includes(unit));
}

function lineContainsMoneyValue(line: string): boolean {
  const normalized = normalizeWhitespace(line);
  return (
    /\$\s*[\d,]+(?:\.\d+)?/.test(normalized) ||
    /\b\d{1,3}(?:,\d{3})+(?:\.\d{2})?\b/.test(normalized) ||
    /\b\d+\.\d{2}\b/.test(normalized)
  );
}

function lineLooksLikeInlineRateRow(line: string): boolean {
  const normalized = normalizeWhitespace(line);
  if (!lineContainsMoneyValue(normalized)) return false;
  if ((normalized.match(/[A-Za-z]/g) ?? []).length < 4) return false;
  if (/[.!?]$/.test(normalized)) return false;
  return normalized.split(/\s+/).filter(Boolean).length >= 3;
}

function splitLineColumns(line: string): string[] {
  const trimmed = line.trim();
  if (!trimmed) return [];

  const pipeColumns = trimmed.split('|').map((value) => value.trim()).filter(Boolean);
  if (pipeColumns.length >= 2) return pipeColumns;

  const tabColumns = trimmed.split(/\t+/).map((value) => value.trim()).filter(Boolean);
  if (tabColumns.length >= 3) return tabColumns;

  const spacedColumns = trimmed.split(/\s{2,}/).map((value) => value.trim()).filter(Boolean);
  if (spacedColumns.length >= 3) return spacedColumns;

  return [trimmed];
}

function looksLikeDescriptionSegment(value: string): boolean {
  const normalized = normalizeWhitespace(value);
  if (!normalized) return false;
  if (lineContainsMoneyValue(normalized)) return false;
  if (unitMatchesForLine(normalized).length > 0) return false;
  const letters = (normalized.match(/[A-Za-z]/g) ?? []).length;
  return letters >= 4;
}

function lineContainsRateValue(line: string): boolean {
  return lineContainsMoneyValue(line) || /pass[\s-]?through/i.test(line);
}

function detectHeaderCategories(line: string): {
  description: boolean;
  price: boolean;
  unit: boolean;
  support: boolean;
  score: number;
} {
  const description =
    /\b(?:category|description|service|classification|work activity|labor class|item|pay item)\b/i.test(line);
  const price =
    matchesRateScheduleHeaderSignal(line) ||
    /\b(?:rate|price|cost|scheduled value)\b/i.test(line);
  const unit =
    CONTRACT_FAILURE_MODES.units.headerAliases.some((pattern) => testRegex(line, pattern)) ||
    /\bunit\b/i.test(line);
  const support =
    /\b(?:qty|quantity|total|clin|contract line item number)\b/i.test(line);
  const score = [description, price, unit, support].filter(Boolean).length;
  return { description, price, unit, support, score };
}

function scorePricingReferencePage(pageText: string): PricingReferencePageDetection {
  const normalized = normalizeWhitespace(pageText);
  const lower = safeLower(normalized);
  const lines = pageText.split('\n').map((line) => line.trim()).filter(Boolean);
  const headings = collectHeadings(pageText);

  const titleHeadingHit = headings.find((heading) => matchesRateScheduleTitleAlias(heading)) ?? null;
  const headerSignalHeadingHit = headings.find((heading) => matchesRateScheduleHeaderSignal(heading)) ?? null;
  const headingKeywordHit =
    headings.find((heading) => RATE_HEADING_KEYWORDS.some((keyword) => safeLower(heading).includes(keyword))) ?? null;
  const explicitReferenceLine =
    lines.find((line) => RATE_REFERENCE_LINE_RE.test(line)) ?? null;
  const phraseHits = RATE_PHRASES.filter((phrase) => lower.includes(phrase));

  let score = 0;
  if (titleHeadingHit) score += 5;
  if (headerSignalHeadingHit) score += 3;
  if (headingKeywordHit) score += 2;
  if (explicitReferenceLine) score += 3;
  score += Math.min(4, phraseHits.length * 2);

  return {
    present: score >= 3,
    score,
    labelCandidate: titleHeadingHit ?? headerSignalHeadingHit ?? headingKeywordHit ?? explicitReferenceLine,
  };
}

function scoreStrictRateSchedulePage(pageText: string): StrictRateSchedulePageDetection {
  const normalized = normalizeWhitespace(pageText);
  const lines = pageText.split('\n').map((line) => line.trim()).filter(Boolean);
  const headings = collectHeadings(pageText);

  const titleHeadingHit = headings.find((heading) => matchesRateScheduleTitleAlias(heading)) ?? null;
  const headerLines = lines
    .map((line) => ({ line, categories: detectHeaderCategories(line) }))
    .filter(({ categories }) => categories.score >= 2 && (categories.price || categories.unit));
  const hasHeaderLine = headerLines.length > 0;
  const hasSupportHeader = headerLines.some(({ categories }) => categories.support);
  const hasDescriptionHeader = headerLines.some(({ categories }) => categories.description);

  const inlineMatchUnits: string[] = [];
  let inlineRateRows = 0;
  const inlineRegex = new RegExp(RATE_ROW_RE.source, RATE_ROW_RE.flags);
  let inlineMatch: RegExpExecArray | null;
  while ((inlineMatch = inlineRegex.exec(normalized)) !== null && inlineRateRows < 200) {
    inlineRateRows += 1;
    if (inlineMatch[2]) inlineMatchUnits.push(inlineMatch[2].toLowerCase());
  }

  const inlineHeaderRows = lines.filter((line) => {
    const headerCategories = detectHeaderCategories(line);
    if (headerCategories.score >= 2 && (headerCategories.price || headerCategories.unit)) {
      return false;
    }
    return hasHeaderLine && lineLooksLikeInlineRateRow(line);
  }).length;

  const candidateRows = lines
    .map((line) => {
      const headerCategories = detectHeaderCategories(line);
      if (headerCategories.score >= 2 && (headerCategories.price || headerCategories.unit)) {
        return null;
      }

      const columns = splitLineColumns(line);
      const usesColumns = columns.length >= 3;
      const numericPrice = usesColumns
        ? columns.some((value) => lineContainsMoneyValue(value))
        : lineContainsMoneyValue(line);
      const hasRateValue = usesColumns
        ? columns.some((value) => lineContainsRateValue(value))
        : hasHeaderLine && lineLooksLikeInlineRateRow(line);
      const units = usesColumns
        ? uniqStrings(columns.flatMap((value) => unitMatchesForLine(value)))
        : uniqStrings(unitMatchesForLine(line));
      const hasUnit = units.length > 0;
      const hasDescription = usesColumns
        ? columns.some((value) => looksLikeDescriptionSegment(value))
        : looksLikeDescriptionSegment(line);
      const isStructured =
        hasRateValue &&
        hasDescription &&
        (
          (usesColumns && (hasUnit || hasHeaderLine || titleHeadingHit != null)) ||
          (!usesColumns && hasHeaderLine)
        );

      if (!isStructured) return null;
      return {
        columns,
        numericPrice,
        hasUnit,
        units,
      };
    })
    .filter((row): row is { columns: string[]; numericPrice: boolean; hasUnit: boolean; units: string[] } => row != null);

  const columnRows = candidateRows.filter((row) => row.columns.length >= 3);
  const columnWidths = columnRows.map((row) => row.columns.length);
  const consistentColumns =
    columnWidths.length >= 2 &&
    Math.max(...columnWidths) - Math.min(...columnWidths) <= 1;
  const structuredRowCount = candidateRows.length;
  const numericPriceRowCount = candidateRows.filter((row) => row.numericPrice).length;
  const unitRowCount = candidateRows.filter((row) => row.hasUnit).length;
  const inferredRowCount = Math.max(structuredRowCount, inlineHeaderRows, inlineRateRows);
  const rowUnits = uniqStrings([
    ...candidateRows.flatMap((row) => row.units),
    ...inlineMatchUnits,
  ]);

  const qualifiesInlineRatePage =
    titleHeadingHit != null &&
    inlineRateRows >= 2;
  const qualifiesUnitRatePage =
    (structuredRowCount >= 2 || inlineRateRows >= 2) &&
    (numericPriceRowCount >= 1 || inlineRateRows >= 2) &&
    unitRowCount >= 1 &&
    (hasHeaderLine || titleHeadingHit != null || consistentColumns);
  const qualifiesStructuredPricePage =
    hasHeaderLine &&
    hasDescriptionHeader &&
    (structuredRowCount >= 2 || inlineHeaderRows >= 2) &&
    (numericPriceRowCount >= 2 || inlineHeaderRows >= 2) &&
    (unitRowCount >= 1 || hasSupportHeader || titleHeadingHit != null);
  const qualifiesContinuationPage =
    consistentColumns &&
    structuredRowCount >= 3 &&
    numericPriceRowCount >= 1 &&
    (unitRowCount >= 1 || hasSupportHeader);

  const qualifies =
    qualifiesInlineRatePage ||
    qualifiesUnitRatePage ||
    qualifiesStructuredPricePage ||
    qualifiesContinuationPage;

  let score = 0;
  if (titleHeadingHit) score += 4;
  if (hasHeaderLine) score += 3;
  if (consistentColumns) score += 2;
  score += Math.min(6, inferredRowCount);
  if (numericPriceRowCount >= 2) score += 2;
  if (unitRowCount >= 1) score += 1;
  if (inlineRateRows >= 2) score += 1;

  return {
    qualifies,
    score,
    labelCandidate: titleHeadingHit ?? headerLines[0]?.line ?? null,
    rateRows: inferredRowCount,
    units: rowUnits,
  };
}

function scoreRateBearingPage(pageText: string): {
  score: number;
  labelCandidate: string | null;
  rateRows: number;
  units: string[];
} {
  const reference = scorePricingReferencePage(pageText);
  const strict = scoreStrictRateSchedulePage(pageText);

  return {
    score: strict.qualifies ? Math.max(10, strict.score) : (reference.present ? reference.score : 0),
    labelCandidate: strict.labelCandidate ?? (reference.present ? reference.labelCandidate : null),
    rateRows: strict.qualifies ? strict.rateRows : 0,
    units: strict.qualifies ? strict.units : [],
  };
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
  /** Pdf.js / layout combined text (may differ from native per-page strings). Used only for term-range search. */
  layoutCombinedText?: string | null;
}): DocumentEvidenceV1 {
  const docType = (params.documentTypeHint ?? '').toLowerCase();
  const isContractLike = docType.includes('contract');

  const structured_fields: Record<string, unknown> = {};
  const section_signals: Record<string, unknown> = {};

  if (isContractLike) {
    const contract = parseContractEvidenceV1({
      pages: params.pageText,
      layoutCombinedText: params.layoutCombinedText ?? null,
    });
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
  layoutCombinedText?: string | null;
}): {
  structured_fields: ContractStructuredFieldsV1;
  section_signals: ContractSectionSignalsV1;
} {
  const pages = [...(params.pages ?? [])].sort((a, b) => a.page_number - b.page_number);
  const combined = normalizeWhitespace(pages.map((p) => p.text).join('\n\n'));
  const lower = safeLower(combined);

  // Parties: bias toward first 2 pages (cover page / signature / intro).
  const firstPages = pages.filter((p) => p.page_number <= 2).map((p) => p.text).join('\n\n');
  const firstNormalized = normalizeWhitespace(firstPages);
  const firstPartySearch = partySearchText(firstPages);
  const firstLower = safeLower(firstNormalized);
  const openingPartyPair =
    extractOpeningPartyPair(firstPartySearch) ??
    extractOpeningPartyPair(firstNormalized);

  const explicitContractorRaw =
    firstGroup(firstPartySearch, AND_DEFINED_CONTRACTOR_RE) ??
    firstGroup(firstPartySearch, DEFINED_CONTRACTOR_RE) ??
    firstGroup(firstNormalized, AND_DEFINED_CONTRACTOR_RE) ??
    firstGroup(firstNormalized, DEFINED_CONTRACTOR_RE) ??
    firstGroup(combined, AND_DEFINED_CONTRACTOR_RE) ??
    firstGroup(combined, DEFINED_CONTRACTOR_RE);
  const contractor =
    // Highest precision: explicit ("Contractor") definition, preferring the "and [Name]" side.
    takeBestNameCandidate(explicitContractorRaw) ??
    openingPartyPair?.contractor ??
    takeBestNameCandidate(firstGroup(firstPartySearch, PARTY_CONTRACTOR_RE)) ??
    takeBestNameCandidate(firstGroup(firstPartySearch, BETWEEN_RE)) ??
    takeBestNameCandidate(firstGroup(firstNormalized, PARTY_CONTRACTOR_RE)) ??
    takeBestNameCandidate(firstGroup(firstNormalized, BETWEEN_RE)) ??
    takeBestNameCandidate(firstGroup(combined, PARTY_CONTRACTOR_RE));

  const owner =
    openingPartyPair?.owner ??
    takeBestNameCandidate(firstGroup(firstPartySearch, PARTY_OWNER_RE)) ??
    takeBestNameCandidate(firstGroup(firstNormalized, PARTY_OWNER_RE)) ??
    takeBestNameCandidate(firstGroup(combined, PARTY_OWNER_RE));

  // Term range extraction (explicit ranges win; do not allow unrelated later dates to override once found).
  // Haystacks: native page text first, then optional pdf.js layout combined (often closer to on-screen reading order).
  const layoutNorm = params.layoutCombinedText ? normalizeWhitespace(params.layoutCombinedText) : '';
  const termHaystacks: Array<{ label: string; text: string }> = [
    { label: 'first_pages', text: firstNormalized },
    { label: 'all_pages', text: combined },
  ];
  if (layoutNorm.trim().length > 0 && !termHaystacks.some((h) => h.text === layoutNorm)) {
    termHaystacks.push({ label: 'layout_combined', text: layoutNorm });
  }
  const termRangeHit = findTermRangeInHaystacks(termHaystacks);
  const termRange = termRangeHit?.match ?? null;
  const explicitTermStartDate = termRange?.[1] ? (anyDateToIso(termRange[1]) ?? termRange[1].replace(/\s+/g, ' ').trim()) : null;
  const explicitTermEndDate = termRange?.[2] ? (anyDateToIso(termRange[2]) ?? termRange[2].replace(/\s+/g, ' ').trim()) : null;
  const termDebug = process.env.EIGHTFORGE_PDF_EXTRACT_DEBUG === '1' || process.env.EIGHTFORGE_OCR_DEBUG === '1';
  if (termDebug) {
    const dbgSource =
      termRangeHit?.sourceText ??
      (layoutNorm.trim().length > 0 ? layoutNorm : firstNormalized || combined);
    console.log('[pdf-extract][term-range]', {
      matched: Boolean(termRange),
      pattern: termRangeHit?.pattern ?? null,
      haystack: termRangeHit?.haystackLabel ?? null,
      raw_match: termRange?.[0] ?? null,
      raw_start: termRange?.[1] ?? null,
      raw_end: termRange?.[2] ?? null,
      normalized_start: explicitTermStartDate,
      normalized_end: explicitTermEndDate,
      text_window: termClauseDebugWindow(dbgSource, termRange?.[0]),
    });
  }

  // Normalize captured date value to collapse any mid-value newlines (e.g. "28th day of\nAugust").
  const rawExecutedDate =
    firstGroup(firstPartySearch, AGREEMENT_DATE_RE) ??
    firstGroup(firstPartySearch, MADE_ENTERED_DATE_RE) ??
    firstGroup(firstNormalized, EXECUTED_DATE_RE) ??
    firstGroup(firstNormalized, ORDINAL_EXECUTED_DATE_RE) ??
    firstGroup(firstNormalized, AGREEMENT_DATE_RE) ??
    firstGroup(firstNormalized, MADE_ENTERED_DATE_RE) ??
    firstGroup(combined, EXECUTED_DATE_RE) ??
    firstGroup(combined, ORDINAL_EXECUTED_DATE_RE);
  const executed_date = rawExecutedDate
    ? (ordinalDayMonthYearToIso(rawExecutedDate) ?? rawExecutedDate.replace(/\s+/g, ' ').trim())
    : null;

  const effectiveDateRaw =
    firstGroup(firstNormalized, EFFECTIVE_DATE_ONLY_RE) ??
    firstGroup(combined, EFFECTIVE_DATE_ONLY_RE);
  const effective_date = effectiveDateRaw
    ? (anyDateToIso(effectiveDateRaw) ?? effectiveDateRaw.replace(/\s+/g, ' ').trim())
    : null;
  const relativeTermMatch = effective_date && termRange == null
    ? (
        RELATIVE_TERM_FROM_EFFECTIVE_RE.exec(firstNormalized) ??
        RELATIVE_TERM_FROM_EFFECTIVE_RE.exec(combined)
      )
    : null;
  const derivedTermEndDate =
    effective_date && relativeTermMatch
      ? addRelativeDurationToIsoDate(
          effective_date,
          parseSmallInt(relativeTermMatch[1], relativeTermMatch[2]) ?? 0,
          (relativeTermMatch[3]?.toLowerCase() as 'day' | 'month' | 'year') ?? 'day',
        )
      : null;
  const term_start_date = explicitTermStartDate ?? effective_date;
  const term_end_date = explicitTermEndDate ?? derivedTermEndDate;

  // Expiration: prefer explicit term end when present; otherwise fall back to explicit expiry language.
  const expirationRaw =
    term_end_date ??
    firstGroup(combined, EXPIRATION_DATE_RE) ??
    (termRange == null ? firstGroup(firstNormalized, THROUGH_UNTIL_RE) : null) ??
    null;
  const expiration_date = expirationRaw
    ? (anyDateToIso(expirationRaw) ?? expirationRaw.replace(/\s+/g, ' ').trim())
    : null;

  const nteRaw =
    firstGroup(firstNormalized, NTE_RE) ??
    firstGroup(combined, NTE_RE);
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
    TIME_AND_MATERIALS_RE.test(firstLower) ||
    /\bt\s*&\s*m\b/.test(firstLower) ||
    /\bt&m\b/.test(firstLower) ||
    TIME_AND_MATERIALS_RE.test(lower) ||
    /\bt\s*&\s*m\b/.test(lower) ||
    /\bt&m\b/.test(lower);

  const unit_price_structure_present =
    rate_section_pages.length > 0 ||
    bestLabelScore >= 3 ||
    matchesAnyRegex(combined, RATE_PRICE_STRUCTURE_HEADER_SIGNAL_REGEXES);

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
    expiration_date: (term_end_date ?? expiration_date) ?? null,
    term_start_date: term_start_date ?? null,
    term_end_date: term_end_date ?? null,
    nte_amount,
    contractor_name_source: explicitContractorRaw ? 'explicit_definition' : (contractor ? 'heuristic' : null),
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

