import {
  findEvidenceByValueMatch,
  hasInspectableValue,
} from '@/lib/extraction/evidenceValueMatch';
import { CONTRACT_FAILURE_MODES } from '@/lib/extraction/failureModes/contractFailureModes';
import type { EvidenceObject, ExtractionGap } from '@/lib/extraction/types';
import type {
  ExtractNodeOutput,
  ExtractedNodeDocument,
  FactDerivationDependency,
  DerivationStatus,
  NormalizeNodeOutput,
  PipelineFact,
} from '@/lib/pipeline/types';

function asRecord(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

function tokenizeLabel(value: string): string[] {
  return normalizeText(value)
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0);
}

function labelMatchesCandidate(label: string, candidate: string): boolean {
  const labelTokens = tokenizeLabel(label);
  const candidateTokens = tokenizeLabel(candidate);
  if (labelTokens.length === 0 || candidateTokens.length === 0) return false;
  for (let start = 0; start <= labelTokens.length - candidateTokens.length; start += 1) {
    let matched = true;
    for (let offset = 0; offset < candidateTokens.length; offset += 1) {
      if (labelTokens[start + offset] !== candidateTokens[offset]) {
        matched = false;
        break;
      }
    }
    if (matched) return true;
  }
  return false;
}

function labelMatchesAnyCandidate(label: string, candidates: string[]): boolean {
  return candidates.some((candidate) => labelMatchesCandidate(label, candidate));
}

const CANONICAL_FACT_KEYS = {
  contract: [
    'contractor_name',
    'owner_name',
    'executed_date',
    'term_start_date',
    'term_end_date',
    'expiration_date',
    'contract_ceiling',
    'rate_schedule_present',
    'rate_row_count',
    'rate_schedule_pages',
  ],
  invoice: [
    'invoice_number',
    'billed_amount',
    'contractor_name',
    'invoice_date',
  ],
} as const;

function canonicalFactValueIsMeaningful(key: string, value: unknown): boolean {
  if (value == null) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (typeof value === 'number') return Number.isFinite(value) && value > 0;
  if (typeof value === 'boolean') {
    if (key === 'rate_schedule_present') return value === true;
    return value;
  }
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value as Record<string, unknown>).length > 0;
  return false;
}

function buildCanonicalPersistenceMetadata(
  document: ExtractedNodeDocument,
  facts: PipelineFact[],
): Record<string, unknown> | null {
  const extractionStatus =
    typeof document.extraction_data?.status === 'string'
      ? document.extraction_data.status
      : null;
  if (extractionStatus !== 'completed') return null;

  const canonicalKeys =
    document.family === 'contract'
      ? CANONICAL_FACT_KEYS.contract
      : document.family === 'invoice'
        ? CANONICAL_FACT_KEYS.invoice
        : null;
  if (canonicalKeys == null) return null;

  const extraction = asRecord(document.extraction_data?.extraction);
  const extractionMetadata = asRecord(extraction?.metadata);
  const gateContext = asRecord(extractionMetadata?.gate_context);
  const factMap = new Map(facts.map((fact) => [fact.key, fact.value]));
  const presentCanonicalFacts = canonicalKeys.filter((key) =>
    canonicalFactValueIsMeaningful(key, factMap.get(key)),
  );
  const missingCanonicalFacts = canonicalKeys.filter((key) => !presentCanonicalFacts.includes(key));

  return {
    document_id: document.document_id,
    project_id: null,
    document_family: document.family,
    extraction_mode:
      typeof extractionMetadata?.extraction_mode === 'string'
        ? extractionMetadata.extraction_mode
        : typeof extraction?.mode === 'string'
          ? extraction.mode
          : null,
    ocr_trigger_reason:
      typeof extractionMetadata?.ocr_trigger_reason === 'string'
        ? extractionMetadata.ocr_trigger_reason
        : null,
    ocr_pages_attempted:
      typeof extractionMetadata?.ocr_pages_attempted === 'number'
        ? extractionMetadata.ocr_pages_attempted
        : 0,
    ocr_confidence_avg:
      typeof extractionMetadata?.ocr_confidence_avg === 'number'
        ? extractionMetadata.ocr_confidence_avg
        : null,
    canonical_persisted: presentCanonicalFacts.length > 0,
    gate_context: gateContext ?? null,
    present_canonical_facts: presentCanonicalFacts,
    missing_canonical_facts: missingCanonicalFacts,
  };
}

function attachCanonicalPersistenceMetadata(
  document: ExtractedNodeDocument,
  facts: PipelineFact[],
  extracted: Record<string, unknown>,
): void {
  const metadata = buildCanonicalPersistenceMetadata(document, facts);
  if (metadata == null) return;

  extracted.canonical_persistence = metadata;

  if (metadata.canonical_persisted !== true) {
    console.warn('[normalizeNode] canonical persistence missing', metadata);
  }
}

function parseNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return null;
  const trimmed = value.replace(/[$,]/g, '').trim();
  if (trimmed.length === 0) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function denseText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function stringValues(value: unknown): string[] {
  return asArray<unknown>(value)
    .map((entry) => typeof entry === 'string' ? entry.trim() : '')
    .filter((entry) => entry.length > 0);
}

function tableCellTexts(row: Record<string, unknown>): string[] {
  return asArray<Record<string, unknown>>(row.cells)
    .map((cell) => String(cell.text ?? '').trim())
    .filter((text) => text.length > 0);
}

const RATE_CONTEXT_HINT_PATTERNS = [
  'attachment',
  'exhibit',
  'schedule',
  'rate',
  'rates',
  'price',
  'prices',
  'pricing',
  'compensation',
  'timeandmaterials',
] as const;

const RATE_DESCRIPTION_HEADERS = [
  'description',
  'service',
  'rate description',
  'labor class',
  'classification',
  'item',
  'pay item',
  'work',
  'work activity',
  'activity',
] as const;

const RATE_PRICE_HEADERS = [
  'rate',
  'price',
  'unit price',
  'unit rate',
  'price per unit',
  'unit cost',
  'cost',
] as const;

const RATE_SUPPORT_HEADERS = [
  'quantity',
  'qty',
  'extension',
  'total',
] as const;

const RATE_UNIT_TOKENS = new Set([
  'cy',
  'cubic yard',
  'tn',
  'ton',
  'tons',
  'ea',
  'each',
  'hr',
  'hrs',
  'hour',
  'hours',
  'day',
  'days',
  'ls',
  'lump sum',
  'ac',
  'acre',
  'acres',
  'lf',
  'linear foot',
  'linear feet',
  'tree',
  'trees',
  'site',
  'sites',
  'lot',
  'lots',
  'crew',
  'crews',
  'plan',
  'plans',
  'fee',
  'fees',
  'log',
  'logs',
  'wall',
  'walls',
  'chimney',
  'chimneys',
  'sy',
  'square yard',
  'square yards',
].map(denseText));

function hasDensePattern(values: string[], patterns: readonly string[]): boolean {
  return values.some((value) => patterns.some((pattern) => value.includes(denseText(pattern))));
}

function testRegex(value: string, pattern: RegExp): boolean {
  const flags = pattern.flags.replace(/g/g, '');
  return new RegExp(pattern.source, flags).test(value);
}

function matchesAnyRegex(value: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => testRegex(value, pattern));
}

function findBestHeaderIndexByRegex(
  headers: string[],
  patterns: readonly RegExp[],
): number | null {
  let bestIndex: number | null = null;
  let bestScore = 0;

  headers.forEach((header, index) => {
    for (const pattern of patterns) {
      const flags = pattern.flags.replace(/g/g, '');
      const match = new RegExp(pattern.source, flags).exec(header);
      if (!match) continue;
      const score = (match[0] ?? '').length;
      if (score > bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    }
  });

  return bestIndex;
}

const RATE_CLIN_HEADER_SIGNAL_REGEXES = CONTRACT_FAILURE_MODES.rateSchedules.headerSignals.filter((pattern) =>
  /contract line item number|clin/i.test(pattern.source),
);

const RATE_QUANTITY_HEADER_SIGNAL_REGEXES = CONTRACT_FAILURE_MODES.rateSchedules.headerSignals.filter((pattern) =>
  /\bqty\b|quantity/i.test(pattern.source),
);

const RATE_PRICE_HEADER_SIGNAL_REGEXES = CONTRACT_FAILURE_MODES.rateSchedules.headerSignals.filter((pattern) =>
  /unit price|unit rate|unit cost|rate per|price per|scheduled value/i.test(pattern.source),
);

function hasRateScheduleTitleAlias(values: string[]): boolean {
  return values.some((value) => matchesAnyRegex(value, CONTRACT_FAILURE_MODES.rateSchedules.titleAliases));
}

function hasRateScheduleHeaderSignal(values: string[]): boolean {
  return values.some((value) => matchesAnyRegex(value, CONTRACT_FAILURE_MODES.rateSchedules.headerSignals));
}

function hasRateScheduleClinSignal(values: string[]): boolean {
  return values.some((value) => matchesAnyRegex(value, RATE_CLIN_HEADER_SIGNAL_REGEXES));
}

function hasRateScheduleQuantitySignal(values: string[]): boolean {
  return values.some((value) => matchesAnyRegex(value, RATE_QUANTITY_HEADER_SIGNAL_REGEXES));
}

function hasRateSchedulePriceSignal(values: string[]): boolean {
  return values.some((value) => matchesAnyRegex(value, RATE_PRICE_HEADER_SIGNAL_REGEXES));
}

function bestHeaderIndex(headers: string[], patterns: readonly string[]): number | null {
  let bestIndex: number | null = null;
  let bestScore = 0;

  headers.forEach((header, index) => {
    const dense = denseText(header);
    for (const pattern of patterns) {
      const densePattern = denseText(pattern);
      if (!dense.includes(densePattern)) continue;
      const score = densePattern.length;
      if (score > bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    }
  });

  return bestIndex;
}

function isRateValueText(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0) return false;
  return (
    /^\$?\s*[\d,]+(?:\.\d+)?$/i.test(trimmed) ||
    /^\$?\s*[\d,]+(?:\.\d+)?\s*(?:per|\/)\s*[A-Za-z][A-Za-z .-]*$/i.test(trimmed)
  );
}

function isMoneyLikeValueText(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0) return false;
  return /^\$?\s*[\d,]+(?:\.\d+)+$/i.test(trimmed) || /^\$\s*[\d,]+(?:\.\d+)?$/i.test(trimmed);
}

function isUnitTokenText(value: string): boolean {
  const dense = denseText(value);
  if (RATE_UNIT_TOKENS.has(dense)) return true;
  if (dense.startsWith('per')) {
    const remainder = dense.slice(3);
    return RATE_UNIT_TOKENS.has(remainder) || /^\d+hrday$/.test(remainder);
  }
  return Array.from(RATE_UNIT_TOKENS).some((token) => dense.includes(`per${token}`));
}

function looksDescriptionText(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0) return false;
  if (isRateValueText(trimmed) || isUnitTokenText(trimmed)) return false;
  const letters = (trimmed.match(/[A-Za-z]/g) ?? []).length;
  const digits = (trimmed.match(/\d/g) ?? []).length;
  const words = trimmed.split(/\s+/).filter(Boolean).length;
  return letters >= 4 && (words >= 2 || letters > digits + 4);
}

function consistentRowShape(rows: string[][]): boolean {
  if (rows.length === 0) return false;
  const widths = rows.map((row) => row.length).filter((width) => width > 0);
  if (widths.length === 0) return false;
  return Math.max(...widths) - Math.min(...widths) <= 1;
}

function columnValues(rows: string[][], index: number): string[] {
  return rows
    .map((row) => row[index] ?? null)
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
}

function findColumnIndex(
  rows: string[][],
  predicate: (value: string) => boolean,
  preferredIndex: number | null,
): number | null {
  const columnCount = Math.max(0, ...rows.map((row) => row.length));

  if (preferredIndex != null) {
    const preferredValues = columnValues(rows, preferredIndex);
    const minimumMatches = Math.max(
      2,
      Math.min(preferredValues.length, Math.ceil(preferredValues.length * 0.5)),
    );
    const preferredMatches = preferredValues.filter(predicate).length;
    if (preferredMatches >= minimumMatches) return preferredIndex;
  }

  let bestIndex: number | null = null;
  let bestMatches = 0;
  for (let index = 0; index < columnCount; index += 1) {
    const values = columnValues(rows, index);
    const minimumMatches = Math.max(2, Math.min(values.length, Math.ceil(values.length * 0.5)));
    const matches = values.filter(predicate).length;
    if (matches >= minimumMatches && matches > bestMatches) {
      bestIndex = index;
      bestMatches = matches;
    }
  }
  return bestIndex;
}

function matchingColumnIndices(
  rows: string[][],
  predicate: (value: string) => boolean,
): number[] {
  const columnCount = Math.max(0, ...rows.map((row) => row.length));
  const indexes: number[] = [];

  for (let index = 0; index < columnCount; index += 1) {
    const values = columnValues(rows, index);
    const minimumMatches = Math.max(2, Math.min(values.length, Math.ceil(values.length * 0.5)));
    const matches = values.filter(predicate).length;
    if (matches >= minimumMatches) indexes.push(index);
  }

  return indexes;
}

function hasDescriptionSupport(rows: string[][], preferredIndex: number | null): number | null {
  return findColumnIndex(rows, looksDescriptionText, preferredIndex);
}

function countRateLikeRows(rows: string[][]): number {
  return rows.filter((row) =>
    row.some((cell) => isRateValueText(cell)) &&
    row.some((cell) => looksDescriptionText(cell) || isUnitTokenText(cell)),
  ).length;
}

type RateScheduleQualificationDebug = {
  score: number;
  accepted: boolean;
  schedule_aliases_matched: string[];
  header_aliases_matched: {
    description: string | null;
    price: string | null;
    unit: string | null;
    support: string | null;
  };
  row_shape_consistency: boolean;
  inline_unit_signal_detected: boolean;
  price_column_count: number;
  estimated_rate_row_count: number;
  price_unit_description_signals: {
    price_column_index: number | null;
    unit_column_index: number | null;
    description_column_index: number | null;
    row_count: number;
  };
  clin_detected: boolean;
  money_column_detected: boolean;
  structural_rules_passed: string[];
  title_alias_matches: string[];
  header_signal_matches: string[];
  unit_pattern_matches: string[];
  term_signal_matches: string[];
  detected_failure_modes: string[];
  decision_explanation: string;
  rejected_reasons: string[];
  accepted_reasons: string[];
};

const RATE_SCHEDULE_TITLE_ALIAS_KEYS = [
  'unitPrices',
  'unitRatePrice',
  'scheduleOfValues',
  'SOV',
  'scheduleOfRates',
  'scheduleOfRatesAndPrices',
  'contractPriceSchedule',
  'priceSchedule',
  'priceSheet',
  'pricingSchedule',
  'unitRatePriceForm',
  'itemAndPlacePricing',
  'compensationSchedule',
  'emergencyDebrisRemovalUnitRates',
  'timeAndMaterialsRates',
  'sectionBPricesOrCosts',
] as const;

const RATE_SCHEDULE_HEADER_SIGNAL_KEYS = [
  'unitPrice',
  'unitRate',
  'unitCost',
  'ratePer',
  'pricePerUnit',
  'pricePer',
  'scheduledValue',
  'contractLineItemNumber',
  'CLIN',
  'QTY',
  'quantity',
] as const;

const UNIT_UOM_PATTERN_KEYS = ['EA_LF_SF_CY_LS_HR_MO_DAY_LOT_TN_TON_LB_LBS'] as const;
const TERM_DOT_STYLE_KEYS = ['contractTime', 'periodOfPerformance', 'deliverySchedule', 'calendarOrWorkingDays', 'timeAndMaterials'] as const;

function collectRegistryRegexMatches(
  values: string[],
  regexes: readonly RegExp[],
  keys: readonly string[],
  prefix: string,
): string[] {
  const out: string[] = [];
  regexes.forEach((regex, index) => {
    const key = keys[index];
    if (!key) return;
    const matched = values.some((value) => {
      regex.lastIndex = 0;
      return regex.test(value);
    });
    if (matched) out.push(`${prefix}.${key}`);
  });
  return out;
}

function qualifyRateScheduleTable(table: Record<string, unknown>): RateScheduleQualificationDebug {
  const headers = stringValues(table.headers);
  const headerContext = stringValues(table.header_context);
  const denseHeaderTexts = headers.map(denseText);
  const denseHeaderContext = headerContext.map(denseText);
  const denseSignals = [...denseHeaderTexts, ...denseHeaderContext];
  const rows = asArray<Record<string, unknown>>(table.rows)
    .map(tableCellTexts)
    .filter((row) => row.length > 0);
  const flattenedRows = rows.flat();
  const allTableSignals = [...headers, ...headerContext, ...flattenedRows];

  const scheduleAliasesMatched: string[] = [];
  const headerAliasesMatched: RateScheduleQualificationDebug['header_aliases_matched'] = {
    description: null,
    price: null,
    unit: null,
    support: null,
  };
  const rejected: string[] = [];
  const accepted: string[] = [];

  if (rows.length < 2) {
    rejected.push('too_few_rows');
  }

  const strongTitleHit = hasRateScheduleTitleAlias(headerContext);
  const contextHintHit = hasDensePattern(denseSignals, RATE_CONTEXT_HINT_PATTERNS);
  const headerSignalHit = hasRateScheduleHeaderSignal([...headers, ...headerContext]);
  const clinHeaderHit = hasRateScheduleClinSignal(headers);
  const priceHeaderSignalHit = hasRateSchedulePriceSignal([...headers, ...headerContext]);
  if (strongTitleHit) scheduleAliasesMatched.push('strong_title');
  if (contextHintHit) scheduleAliasesMatched.push('context_hint');

  const descriptionHeaderIndex = bestHeaderIndex(headers, RATE_DESCRIPTION_HEADERS);
  const priceHeaderIndex = bestHeaderIndex(headers, RATE_PRICE_HEADERS);
  const unitHeaderIndex = findBestHeaderIndexByRegex(headers, CONTRACT_FAILURE_MODES.units.headerAliases);
  const supportHeaderIndex = bestHeaderIndex(headers, RATE_SUPPORT_HEADERS);

  headerAliasesMatched.description = descriptionHeaderIndex != null ? (headers[descriptionHeaderIndex] ?? null) : null;
  headerAliasesMatched.price = priceHeaderIndex != null ? (headers[priceHeaderIndex] ?? null) : null;
  headerAliasesMatched.unit = unitHeaderIndex != null ? (headers[unitHeaderIndex] ?? null) : null;
  headerAliasesMatched.support = supportHeaderIndex != null ? (headers[supportHeaderIndex] ?? null) : null;

  const priceColumn = findColumnIndex(rows, isRateValueText, priceHeaderIndex);
  const unitColumn = findColumnIndex(rows, isUnitTokenText, unitHeaderIndex);
  const descriptionColumn = hasDescriptionSupport(rows, descriptionHeaderIndex);
  const priceColumnCount = matchingColumnIndices(rows, isRateValueText).length;
  const inlineUnitSignalDetected = allTableSignals.some((value) => isUnitTokenText(value));
  const estimatedRateRowCount = countRateLikeRows(rows);
  const rowShapeOk = consistentRowShape(rows);
  const moneyColumnDetected = matchingColumnIndices(rows, isMoneyLikeValueText).length > 0;
  const explicitPriceSignalDetected = priceHeaderIndex != null || priceHeaderSignalHit;
  const clinDetected = hasRateScheduleClinSignal(allTableSignals);
  const hasDescriptionQuantityPrice =
    (descriptionColumn != null || descriptionHeaderIndex != null)
    && (hasRateScheduleQuantitySignal(headers) || rows.some((row) => hasRateScheduleQuantitySignal(row)))
    && moneyColumnDetected;
  const hasTotalRow = rows.some((row) => row.some((cell) => /\btotal\b/i.test(cell)));

  const titleAliasMatches = collectRegistryRegexMatches(
    headerContext,
    CONTRACT_FAILURE_MODES.rateSchedules.titleAliases,
    RATE_SCHEDULE_TITLE_ALIAS_KEYS,
    'rateSchedules.titleAliases',
  );
  const headerSignalMatches = collectRegistryRegexMatches(
    [...headers, ...headerContext],
    CONTRACT_FAILURE_MODES.rateSchedules.headerSignals,
    RATE_SCHEDULE_HEADER_SIGNAL_KEYS,
    'rateSchedules.headerSignals',
  );
  const unitPatternMatches = collectRegistryRegexMatches(
    allTableSignals,
    CONTRACT_FAILURE_MODES.units.uomPatterns,
    UNIT_UOM_PATTERN_KEYS,
    'units.uomPatterns',
  );
  const termSignalMatches = collectRegistryRegexMatches(
    allTableSignals,
    CONTRACT_FAILURE_MODES.term.dotStyle,
    TERM_DOT_STYLE_KEYS,
    'term.dotStyle',
  );
  const structuralRulesPassed: string[] = [];
  if (hasDescriptionQuantityPrice) structuralRulesPassed.push('rateSchedules.structuralRules.has_description_quantity_price');
  if (clinDetected && moneyColumnDetected) structuralRulesPassed.push('rateSchedules.structuralRules.clin_with_money_column');
  if (hasTotalRow) structuralRulesPassed.push('rateSchedules.structuralRules.has_total_row');

  const detectedFailureModes = [
    ...titleAliasMatches,
    ...headerSignalMatches,
    ...unitPatternMatches,
    ...termSignalMatches,
    ...structuralRulesPassed,
  ];

  let score = 0;
  if (strongTitleHit) score += 3;
  else if (contextHintHit) score += 1;

  if (headerSignalHit) score += 1;
  if (descriptionHeaderIndex != null) score += 2;
  if (priceHeaderIndex != null) score += 2;
  if (priceHeaderSignalHit && priceHeaderIndex == null) score += 1;
  if (unitHeaderIndex != null) score += 2;
  if (supportHeaderIndex != null) score += 1;
  if (clinHeaderHit) score += 1;
  if (priceColumn != null) score += 2;
  if (unitColumn != null) score += 2;
  if (inlineUnitSignalDetected && unitColumn == null) score += 2;
  if (descriptionColumn != null) score += 1;
  if (priceColumnCount >= 2) score += 1;
  if (estimatedRateRowCount >= 2) score += 2;
  if (rowShapeOk) score += 1;
  if (rows.length >= 3) score += 1;

  if (priceColumn == null && priceColumnCount === 0 && estimatedRateRowCount === 0) rejected.push('missing_price_column');
  if (!moneyColumnDetected && !explicitPriceSignalDetected) rejected.push('missing_money_signal');
  if (unitColumn == null && !strongTitleHit && !inlineUnitSignalDetected && !clinHeaderHit) rejected.push('missing_unit_column');
  if (
    descriptionColumn == null &&
    descriptionHeaderIndex == null &&
    !strongTitleHit &&
    estimatedRateRowCount < 2
  ) {
    rejected.push('missing_description_column');
  }
  if (score < 6) rejected.push('score_below_threshold');

  const acceptedDecision =
    rejected.length === 0 &&
    score >= 6 &&
    (moneyColumnDetected || explicitPriceSignalDetected) &&
    (priceColumn != null || priceColumnCount >= 2 || estimatedRateRowCount >= 2) &&
    (unitColumn != null || strongTitleHit || inlineUnitSignalDetected || clinHeaderHit) &&
    (descriptionColumn != null || descriptionHeaderIndex != null || strongTitleHit || estimatedRateRowCount >= 2);

  if (acceptedDecision) {
    if (strongTitleHit) accepted.push('matched_schedule_alias');
    if (headerSignalHit) accepted.push('matched_rate_schedule_header_signal');
    if (descriptionHeaderIndex != null) accepted.push('matched_description_header_alias');
    if (priceHeaderIndex != null) accepted.push('matched_price_header_alias');
    if (unitHeaderIndex != null) accepted.push('matched_unit_header_alias');
    if (clinHeaderHit) accepted.push('detected_clin_header_signal');
    if (priceColumn != null) accepted.push('detected_price_column');
    if (unitColumn != null) accepted.push('detected_unit_column');
    if (inlineUnitSignalDetected && unitColumn == null) accepted.push('detected_inline_unit_signal');
    if (descriptionColumn != null) accepted.push('detected_description_column');
    if (priceColumnCount >= 2) accepted.push('detected_multiple_price_columns');
    if (estimatedRateRowCount >= 2) accepted.push('detected_rate_like_rows');
    if (rowShapeOk) accepted.push('consistent_row_shape');
  }
  const acceptedBits: string[] = [];
  if (titleAliasMatches.length > 0) acceptedBits.push('contract price schedule title matched');
  if (headerSignalMatches.some((signal) => signal === 'rateSchedules.headerSignals.CLIN')) acceptedBits.push('CLIN header matched');
  if (moneyColumnDetected) acceptedBits.push('money column was present');
  if (unitPatternMatches.length > 0) acceptedBits.push('unit pattern matched');
  if (structuralRulesPassed.length > 0) acceptedBits.push(`structural rules passed (${structuralRulesPassed.map((rule) => rule.split('.').at(-1)).join(', ')})`);
  const decisionExplanation = acceptedDecision
    ? `table detected because ${acceptedBits.length > 0 ? acceptedBits.join(', ') : 'classification score passed threshold'}`
    : `table rejected because ${rejected.length > 0 ? rejected.join(', ') : 'classification threshold was not met'}`;

  return {
    score,
    accepted: acceptedDecision,
    schedule_aliases_matched: scheduleAliasesMatched,
    header_aliases_matched: headerAliasesMatched,
    row_shape_consistency: rowShapeOk,
    inline_unit_signal_detected: inlineUnitSignalDetected,
    price_column_count: priceColumnCount,
    estimated_rate_row_count: estimatedRateRowCount,
    price_unit_description_signals: {
      price_column_index: priceColumn,
      unit_column_index: unitColumn,
      description_column_index: descriptionColumn,
      row_count: rows.length,
    },
    clin_detected: clinDetected,
    money_column_detected: moneyColumnDetected,
    structural_rules_passed: structuralRulesPassed,
    title_alias_matches: titleAliasMatches,
    header_signal_matches: headerSignalMatches,
    unit_pattern_matches: unitPatternMatches,
    term_signal_matches: termSignalMatches,
    detected_failure_modes: detectedFailureModes,
    decision_explanation: decisionExplanation,
    rejected_reasons: rejected,
    accepted_reasons: accepted,
  };
}

function formatPageList(pages: number[]): string | null {
  if (pages.length === 0) return null;
  return pages.length === 1 ? `page ${pages[0]}` : `pages ${pages.join(', ')}`;
}

function uniqueSortedNumbers(values: number[]): number[] {
  return [...new Set(values)].sort((left, right) => left - right);
}

function inferWeakContinuationRatePages(
  document: ExtractedNodeDocument,
  acceptedRateTables: Array<{ page: number | null }>,
  pdfTables: Record<string, unknown>[],
): { pages: number[]; inferred_gap_pages: number[] } {
  const acceptedPages = uniqueSortedNumbers(
    acceptedRateTables
      .map((table) => table.page)
      .filter((page): page is number => page != null),
  );

  // Keep this inference narrow: only supplement when a real multi-page schedule already exists.
  if (acceptedPages.length < 4) {
    return { pages: acceptedPages, inferred_gap_pages: [] };
  }

  const pdf = asRecord(document.content_layers?.pdf);
  const pdfTextPages = asArray<Record<string, unknown>>(asRecord(pdf?.text)?.pages);
  const pdfTextPagesByNumber = new Map<number, Record<string, unknown>>();
  for (const page of pdfTextPages) {
    const pageNumber = typeof page.page_number === 'number' ? page.page_number : null;
    if (pageNumber != null) pdfTextPagesByNumber.set(pageNumber, page);
  }

  const anyExtractedTablePages = new Set(
    pdfTables
      .map((table) => typeof table.page_number === 'number' ? table.page_number : null)
      .filter((page): page is number => page != null),
  );

  const inferredGapPages: number[] = [];

  for (let index = 0; index < acceptedPages.length - 1; index += 1) {
    const currentPage = acceptedPages[index]!;
    const nextPage = acceptedPages[index + 1]!;
    if (nextPage !== currentPage + 2) continue;

    const gapPage = currentPage + 1;
    if (anyExtractedTablePages.has(gapPage)) continue;

    const pdfTextPage = pdfTextPagesByNumber.get(gapPage);
    if (!pdfTextPage) continue;

    const lineCount = typeof pdfTextPage.line_count === 'number' ? pdfTextPage.line_count : 0;
    const plainTextBlocks = asArray<Record<string, unknown>>(pdfTextPage.plain_text_blocks);
    const textLength = plainTextBlocks.reduce((sum, block) => {
      const text = typeof block.text === 'string' ? block.text.trim() : '';
      return sum + text.length;
    }, 0);

    const looksLikeWeakRasterContinuation =
      lineCount > 0 &&
      lineCount <= 12 &&
      plainTextBlocks.length <= 1 &&
      textLength > 0 &&
      textLength <= 160;

    if (looksLikeWeakRasterContinuation) {
      inferredGapPages.push(gapPage);
    }
  }

  // Require a repeated pattern so isolated blank/interstitial pages do not get pulled in.
  if (inferredGapPages.length < 2) {
    return { pages: acceptedPages, inferred_gap_pages: [] };
  }

  return {
    pages: uniqueSortedNumbers([...acceptedPages, ...inferredGapPages]),
    inferred_gap_pages: uniqueSortedNumbers(inferredGapPages),
  };
}

function toDisplayValue(value: unknown): string {
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (Array.isArray(value)) return `${value.length} item${value.length === 1 ? '' : 's'}`;
  if (value == null) return 'Missing';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function evidenceText(evidence: EvidenceObject): string {
  return [evidence.location.label, evidence.text, evidence.value != null ? String(evidence.value) : '']
    .filter(Boolean)
    .join(' | ');
}

function findEvidenceByLabel(
  document: ExtractedNodeDocument,
  labels: string[],
): EvidenceObject[] {
  return document.evidence.filter((evidence) => {
    const label = evidence.location.label ?? '';
    return labelMatchesAnyCandidate(label, labels);
  }).slice(0, 3);
}

function findEvidenceByRegex(
  document: ExtractedNodeDocument,
  regexes: RegExp[],
): { value: string | number | boolean | null; evidence: EvidenceObject[] } | null {
  for (const evidence of document.evidence) {
    const text = evidenceText(evidence);
    if (!text) continue;
    for (const regex of regexes) {
      const candidate = new RegExp(regex.source, regex.flags.includes('i') ? regex.flags : `${regex.flags}i`);
      const match = candidate.exec(text);
      if (!match) continue;
      return {
        value: match[1] ?? match[0] ?? null,
        evidence: [evidence],
      };
    }
  }
  return null;
}

function firstNonEmptyString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return null;
}

const CONTRACT_ANCHOR_MONTH_INDEX: Record<string, number> = {
  january: 0,
  jan: 0,
  february: 1,
  feb: 1,
  march: 2,
  mar: 2,
  april: 3,
  apr: 3,
  may: 4,
  june: 5,
  jun: 5,
  july: 6,
  jul: 6,
  august: 7,
  aug: 7,
  september: 8,
  sep: 8,
  sept: 8,
  october: 9,
  oct: 9,
  november: 10,
  nov: 10,
  december: 11,
  dec: 11,
};

const CONTRACT_FULL_MONTH_PATTERN =
  'January|February|March|April|May|June|July|August|September|October|November|December';
const CONTRACT_DATE_CAPTURE_SOURCE =
  '('
  + `\\d{1,2}[\\/\\-]\\d{1,2}[\\/\\-]\\d{2,4}`
  + `|(?:${CONTRACT_FULL_MONTH_PATTERN})\\s+\\d{1,2},?\\s+\\d{4}`
  + `|\\d{1,2}(?:st|nd|rd|th)?\\s+(?:${CONTRACT_FULL_MONTH_PATTERN})\\s+\\d{2,4}`
  + `|\\d{1,2}(?:st|nd|rd|th)\\s+day\\s+of\\s+(?:${CONTRACT_FULL_MONTH_PATTERN}),?\\s+\\d{2,4}`
  + ')';

function coerceContractYear(rawYear: string): number {
  const year = Number(rawYear);
  if (!Number.isFinite(year)) return Number.NaN;
  return rawYear.length <= 2 ? 2000 + year : year;
}

function buildValidContractLocalDate(
  year: number,
  month: number,
  day: number,
): Date | null {
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;
  if (year < 1900 || year > 2100) return null;
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > 31) return null;
  const d = new Date(year, month - 1, day, 12, 0, 0, 0);
  if (Number.isNaN(d.getTime())) return null;
  if (
    d.getFullYear() !== year ||
    d.getMonth() !== month - 1 ||
    d.getDate() !== day
  ) {
    return null;
  }
  return d;
}

function normalizeContractDateToIso(value: string): string | null {
  const s = value
    .replace(/\b(?:the\s+date\s+of|date\s+of)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return null;

  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (iso) {
    const d = buildValidContractLocalDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
    return d ? formatLocalIsoDate(d) : null;
  }

  const us = /^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/.exec(s);
  if (us) {
    const d = buildValidContractLocalDate(
      coerceContractYear(us[3]),
      Number(us[1]),
      Number(us[2]),
    );
    return d ? formatLocalIsoDate(d) : null;
  }

  const mon = /^([A-Za-z]{3,9})\s+(\d{1,2}),\s*(\d{4})$/.exec(s);
  if (mon) {
    const monthIx = CONTRACT_ANCHOR_MONTH_INDEX[mon[1].toLowerCase()];
    if (monthIx == null) return null;
    const d = buildValidContractLocalDate(Number(mon[3]), monthIx + 1, Number(mon[2]));
    return d ? formatLocalIsoDate(d) : null;
  }

  const ordinalDayOf = /^(\d{1,2})(?:st|nd|rd|th)\s+day\s+of\s+([A-Za-z]{3,9}),?\s+(\d{2,4})$/i.exec(s);
  if (ordinalDayOf) {
    const monthIx = CONTRACT_ANCHOR_MONTH_INDEX[ordinalDayOf[2].toLowerCase()];
    if (monthIx == null) return null;
    const d = buildValidContractLocalDate(
      coerceContractYear(ordinalDayOf[3]),
      monthIx + 1,
      Number(ordinalDayOf[1]),
    );
    return d ? formatLocalIsoDate(d) : null;
  }

  const dayMonth = /^(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\s+(\d{2,4})$/i.exec(s);
  if (dayMonth) {
    const monthIx = CONTRACT_ANCHOR_MONTH_INDEX[dayMonth[2].toLowerCase()];
    if (monthIx == null) return null;
    const d = buildValidContractLocalDate(
      coerceContractYear(dayMonth[3]),
      monthIx + 1,
      Number(dayMonth[1]),
    );
    return d ? formatLocalIsoDate(d) : null;
  }

  return null;
}

function normalizeContractDateCandidate(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.replace(/\s+/g, ' ').trim();
  if (!trimmed) return null;
  const iso = normalizeContractDateToIso(trimmed);
  if (!iso) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return iso;
  if (/^\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4}$/.test(trimmed)) return trimmed;
  if (/^[A-Za-z]{3,9}\s+\d{1,2},\s*\d{4}$/i.test(trimmed)) return trimmed;
  return iso;
}

function firstValidContractDate(...values: unknown[]): string | null {
  for (const value of values) {
    const normalized = normalizeContractDateCandidate(value);
    if (normalized) return normalized;
  }
  return null;
}

function evidenceSearchText(evidence: EvidenceObject): string {
  return [
    evidence.location.label,
    evidence.text,
    evidence.location.nearby_text,
    Array.isArray(evidence.location.header_context) ? evidence.location.header_context.join(' | ') : '',
    evidence.value != null ? String(evidence.value) : '',
  ]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .join(' | ');
}

/** Parse common contract date strings for duration anchor math. */
function parseContractAnchorDate(value: string): Date | null {
  const iso = normalizeContractDateToIso(value);
  if (!iso) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) return null;
  return buildValidContractLocalDate(Number(match[1]), Number(match[2]), Number(match[3]));
}

function formatLocalIsoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

const ENGLISH_TERM_AMOUNT_WORDS: Record<string, number> = {
  zero: 0,
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
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
};

function parseEnglishTermAmountFragment(fragment: string | undefined): number | null {
  if (!fragment) return null;
  const parts = fragment
    .toLowerCase()
    .replace(/-/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length === 0) return null;
  let sum = 0;
  for (const p of parts) {
    const n = ENGLISH_TERM_AMOUNT_WORDS[p];
    if (n == null) return null;
    sum += n;
  }
  return sum > 0 ? sum : null;
}

type TermDurationAnchorKind = 'executed' | 'effective' | 'commencement' | 'ntp';

function detectTermDurationAnchorKind(clause: string): TermDurationAnchorKind {
  const c = clause.toLowerCase();
  if (/\bnotice\s+to\s+proceed\b|\bntp\b/.test(c)) return 'ntp';
  if (/commencement/.test(c)) return 'commencement';
  if (/fully\s+executed|it\s+is\s+fully\s+executed|date\s+it\s+is\s+fully\s+executed/.test(c)) return 'executed';
  if (/\bfrom\s+execution\b|\bafter\s+(?:the\s+)?(?:full\s+)?execution\b/.test(c)) return 'executed';
  if (/effective\s+date/.test(c)) return 'effective';
  if (/\bexecution\b/.test(c)) return 'executed';
  return 'executed';
}

/** Groups: 1 optional words, 2 paren digits, 3 plain digits + space, 4 unit */
function parseTermDurationFromMatch(match: RegExpMatchArray): { amount: number; unit: 'day' | 'month' | 'year' } | null {
  const unitRaw = (match[4] ?? '').toLowerCase();
  let unit: 'day' | 'month' | 'year' = 'day';
  if (unitRaw.startsWith('month')) unit = 'month';
  else if (unitRaw.startsWith('year')) unit = 'year';

  let n: number | null = null;
  if (match[2]) n = parseInt(match[2], 10);
  if ((n == null || Number.isNaN(n)) && match[3]) n = parseInt(String(match[3]).trim(), 10);
  if ((n == null || Number.isNaN(n)) && match[1]) {
    n = parseEnglishTermAmountFragment(match[1].replace(/\s+and\s+/i, ' ').trim());
  }
  if (n == null || Number.isNaN(n) || n < 1 || n > 3660) return null;
  return { amount: n, unit };
}

function paymentAdjacentBeforeTermDurationMatch(textLower: string, matchIndex: number): boolean {
  const slice = textLower.slice(Math.max(0, matchIndex - 130), matchIndex);
  return /\bpayment\b|\binvoice\b|\bpayable\b|\breceipt\b|\bnet\s+[0-9]{1,3}\b|\bdue\s+within\b|\bcure\b|\bliquidated\b|\bdelivery\s+within\b|\bshipping\b/.test(
    slice,
  );
}

function evidenceBlobLooksLikeContractTermContext(blobLower: string): boolean {
  return /\b(?:agreement|contract|term|subscription)\b|\beffective\s+for\b|\bperiod\s+of\b|\bremain\s+in\s+effect\b|\bshall\s+terminate\b|\bexpiration\b|\bnot\s+to\s+exceed\s+\d{1,4}\s+calendar\s+days\b/.test(
    blobLower,
  );
}

function addCalendarTermDuration(base: Date, amount: number, unit: 'day' | 'month' | 'year'): Date {
  if (unit === 'day') {
    return new Date(base.getFullYear(), base.getMonth(), base.getDate() + amount, 12, 0, 0, 0);
  }
  if (unit === 'month') {
    return new Date(base.getFullYear(), base.getMonth() + amount, base.getDate(), 12, 0, 0, 0);
  }
  return new Date(base.getFullYear() + amount, base.getMonth(), base.getDate(), 12, 0, 0, 0);
}

interface TermDurationClauseHit {
  amount: number;
  unit: 'day' | 'month' | 'year';
  anchor: TermDurationAnchorKind;
  score: number;
  evidenceIds: string[];
  clauseSample: string;
}

const TERM_DURATION_CLAUSE_REGEXES: RegExp[] = [
  /period\s+of\s+([a-z]+(?:\s+[a-z]+){0,2}\s+)?(?:\(([0-9]{1,4})\)\s*)?([0-9]{1,4}\s+)?(?:calendar\s+|working\s+)?(days?|months?|years?)\s+(?:from|after|following)\s+(?:the\s+)?(?:date\s+(?:on\s+which\s+it\s+is\s+|it\s+is\s+)?)?(?:fully\s+)?(?:executed|execution)(?:\s+date)?/gi,
  /effective\s+for\s+(?:a\s+)?period\s+of\s+([a-z]+(?:\s+[a-z]+){0,2}\s+)?(?:\(([0-9]{1,4})\)\s*)?([0-9]{1,4}\s+)?(?:calendar\s+|working\s+)?(days?|months?|years?)\s+(?:from|after|following)\s+(?:the\s+)?(?:date\s+(?:on\s+which\s+it\s+is\s+|it\s+is\s+)?)?(?:fully\s+)?(?:executed|execution|effective\s+date|commencement)/gi,
  /(?:shall\s+)?terminate\s+(?:at\s+)?(?:the\s+)?end\s+of\s+([a-z]+(?:\s+[a-z]+){0,2}\s+)?(?:\(([0-9]{1,4})\)\s*)?([0-9]{1,4}\s+)?(?:calendar\s+|working\s+)?(days?|months?|years?)\s+from\s+(?:the\s+)?(?:fully\s+)?(?:executed|execution|effective\s+date|commencement)/gi,
  /(?:term|period)\s+shall\s+be\s+([a-z]+(?:\s+[a-z]+){0,2}\s+)?(?:\(([0-9]{1,4})\)\s*)?([0-9]{1,4}\s+)?(?:calendar\s+|working\s+)?(days?|months?|years?)\s+from\s+(?:the\s+)?(?:execution|effective\s+date|fully\s+executed(?:\s+date)?|commencement|notice\s+to\s+proceed)/gi,
  /not\s+to\s+exceed\s+([a-z]+(?:\s+[a-z]+){0,2}\s+)?(?:\(([0-9]{1,4})\)\s*)?([0-9]{1,4}\s+)?(?:calendar\s+|working\s+)?(days?|months?|years?)\s+(?:after|from)\s+(?:the\s+)?(?:fully\s+)?(?:executed|execution|effective\s+date)/gi,
];

function findBestTermDurationClauseHit(document: ExtractedNodeDocument): TermDurationClauseHit | null {
  let best: TermDurationClauseHit | null = null;

  const consider = (blobLower: string, evidenceIds: string[]) => {
    for (const rx of TERM_DURATION_CLAUSE_REGEXES) {
      const r = new RegExp(rx.source, rx.flags);
      let m: RegExpExecArray | null;
      while ((m = r.exec(blobLower)) != null) {
        if (paymentAdjacentBeforeTermDurationMatch(blobLower, m.index)) continue;
        const parsed = parseTermDurationFromMatch(m);
        if (!parsed) continue;
        const anchor = detectTermDurationAnchorKind(m[0]);
        const clauseSample = m[0].slice(0, 220);
        let score = m[0].length;
        const winStart = Math.max(0, m.index - 80);
        const winEnd = Math.min(blobLower.length, m.index + m[0].length + 40);
        if (/\b(?:agreement|contract)\b/.test(blobLower.slice(winStart, winEnd))) {
          score += 12;
        }
        if (best == null || score > best.score) {
          best = {
            amount: parsed.amount,
            unit: parsed.unit,
            anchor,
            score,
            evidenceIds: [...evidenceIds],
            clauseSample,
          };
        }
      }
    }
  };

  for (const evidence of document.evidence) {
    const blob = evidenceText(evidence);
    if (!blob.trim()) continue;
    const blobLower = blob.toLowerCase();
    if (!evidenceBlobLooksLikeContractTermContext(blobLower)) continue;
    consider(blobLower, [evidence.id]);
  }

  const preview = document.text_preview.trim();
  if (best == null && preview.length > 0) {
    const blobLower = preview.toLowerCase();
    if (evidenceBlobLooksLikeContractTermContext(blobLower)) {
      consider(blobLower, []);
    }
  }

  return best;
}

interface TermDurationDerivation {
  endDateIso: string;
  evidenceIds: string[];
  hit: TermDurationClauseHit;
}

/** Day count: "90", "ninety (90)", optional "period of" / "a" prefix. Case-insensitive. */
const EXECUTED_RELATIVE_DURATION_DAYS_RE_SOURCE =
  '(?:\\bperiod\\s+of\\s+)?(?:a\\s+)?(\\d{1,4}|[a-z]+(?:\\s+[a-z]+){0,2})\\s*(?:\\(([0-9]{1,4})\\)\\s*)?\\s*(day|days)\\b';

/** Must appear in the same clause window as the duration (payment/cure "30 days" lacks this). */
const EXECUTED_RELATIVE_EXECUTION_ANCHOR_RE_SOURCE =
  'from\\s+the\\s+date\\s+(?:it\\s+is\\s+)?(?:fully\\s+)?executed|from\\s+the\\s+date\\s+of\\s+execution';

const EXECUTED_RELATIVE_DURATION_THEN_ANCHOR_RE = new RegExp(
  `${EXECUTED_RELATIVE_DURATION_DAYS_RE_SOURCE}[\\s\\S]{0,180}?(?:${EXECUTED_RELATIVE_EXECUTION_ANCHOR_RE_SOURCE})`,
  'gi',
);

const EXECUTED_RELATIVE_ANCHOR_THEN_DURATION_RE = new RegExp(
  `(?:${EXECUTED_RELATIVE_EXECUTION_ANCHOR_RE_SOURCE})[\\s\\S]{0,180}?${EXECUTED_RELATIVE_DURATION_DAYS_RE_SOURCE}`,
  'gi',
);

/** Full-document PDF text for duration regexes when {@link document.evidence} is sparse. */
function joinPdfPlainTextFromContentLayers(contentLayers: Record<string, unknown> | null): string {
  const pdf = asRecord(contentLayers?.pdf);
  const text = asRecord(pdf?.text);
  const pages = asArray<Record<string, unknown>>(text?.pages);
  const chunks: string[] = [];
  for (const page of pages) {
    const blocks = asArray<Record<string, unknown>>(page.plain_text_blocks);
    for (const block of blocks) {
      const t = typeof block.text === 'string' ? block.text.trim() : '';
      if (t.length > 0) chunks.push(t);
    }
    if (blocks.length === 0) {
      const pageText = typeof page.text === 'string' ? page.text.trim() : '';
      if (pageText.length > 0) chunks.push(pageText);
    }
  }
  return chunks.join('\n');
}

/** Legacy `evidence_v1.page_text` when present (skipped by extractNode when pdf.evidence is non-empty). */
function joinLegacyEvidencePageText(extractionData: Record<string, unknown> | null): string {
  const extraction = asRecord(extractionData?.extraction);
  const ev = asRecord(extraction?.evidence_v1);
  const pageText = asArray<Record<string, unknown>>(ev?.page_text);
  return pageText
    .map((p) => (typeof p.text === 'string' ? p.text.trim() : ''))
    .filter((t) => t.length > 0)
    .join('\n');
}

function joinContractTextForExecutedRelativeDerivation(document: ExtractedNodeDocument): string {
  const parts: string[] = [];
  for (const ev of document.evidence) {
    const blob = evidenceText(ev).trim();
    if (blob.length > 0) parts.push(blob);
  }
  const preview = document.text_preview.trim();
  if (preview.length > 0) parts.push(preview);
  const layerPlain = joinPdfPlainTextFromContentLayers(document.content_layers);
  if (layerPlain.length > 0) parts.push(layerPlain);
  const legacyPageText = joinLegacyEvidencePageText(document.extraction_data);
  if (legacyPageText.length > 0) parts.push(legacyPageText);
  return parts.join('\n');
}

function parseExecutedRelativeDayCountFromGroups(
  amountToken: string,
  parenDigits: string | undefined,
  unitRaw: string,
): number | null {
  if (!unitRaw.toLowerCase().startsWith('day')) return null;
  let n: number | null = null;
  if (parenDigits) n = parseInt(parenDigits, 10);
  if (n == null || Number.isNaN(n)) {
    const t = amountToken.replace(/\s+and\s+/i, ' ').trim();
    if (/^\d+$/.test(t)) n = parseInt(t, 10);
    else n = parseEnglishTermAmountFragment(t);
  }
  if (n == null || Number.isNaN(n) || n < 1 || n > 3660) return null;
  return n;
}

function findExecutedRelativeDurationDaysInText(fullTextLower: string): {
  days: number;
  matchIndex: number;
  clauseSample: string;
} | null {
  type Row = { days: number; matchIndex: number; clauseSample: string; len: number };
  const acc: { current: Row | null } = { current: null };

  const consider = (m: RegExpExecArray) => {
    if (paymentAdjacentBeforeTermDurationMatch(fullTextLower, m.index)) return;
    const days = parseExecutedRelativeDayCountFromGroups(m[1] ?? '', m[2], m[3] ?? '');
    if (days == null) return;
    const clauseSample = (m[0] ?? '').slice(0, 280);
    const len = (m[0] ?? '').length;
    if (acc.current == null || len > acc.current.len) {
      acc.current = { days, matchIndex: m.index, clauseSample, len };
    }
  };

  let m: RegExpExecArray | null;
  const r1 = new RegExp(EXECUTED_RELATIVE_DURATION_THEN_ANCHOR_RE.source, 'gi');
  while ((m = r1.exec(fullTextLower)) != null) consider(m);
  const r2 = new RegExp(EXECUTED_RELATIVE_ANCHOR_THEN_DURATION_RE.source, 'gi');
  while ((m = r2.exec(fullTextLower)) != null) consider(m);

  if (acc.current == null) return null;
  const hit = acc.current;
  return { days: hit.days, matchIndex: hit.matchIndex, clauseSample: hit.clauseSample };
}

function evidenceRefsForExecutedRelativeSample(
  document: ExtractedNodeDocument,
  clauseSampleLower: string,
): string[] {
  const refs: string[] = [];
  const snippet = clauseSampleLower.slice(0, 48).trim();
  for (const ev of document.evidence) {
    const b = evidenceText(ev).toLowerCase();
    if (b.length < 12) continue;
    if (snippet.length >= 16 && b.includes(snippet.slice(0, 16))) refs.push(ev.id);
    else if (
      /\bfrom\s+the\s+date\b/.test(b)
      && (/\b(?:fully\s+)?executed\b/.test(b) || /\bof\s+execution\b/.test(b))
      && /\b(?:day|days)\b/.test(b)
    ) {
      refs.push(ev.id);
    }
  }
  return [...new Set(refs)].slice(0, 12);
}

interface ExecutedRelativeTermDerivation {
  endDateIso: string;
  evidenceIds: string[];
  durationDays: number;
  clauseSample: string;
}

/**
 * Derive term end from "N days … from the date it is fully executed" (or … of execution) using
 * {@link joinContractTextForExecutedRelativeDerivation} so the clause need not sit in one evidence blob.
 * Only calendar days; anchor is always {@link executedDate}.
 */
function tryDeriveTermEndFromExecutedRelativeDuration(
  document: ExtractedNodeDocument,
  executedDate: string | null,
): ExecutedRelativeTermDerivation | null {
  if (!executedDate?.trim()) return null;
  const fullText = joinContractTextForExecutedRelativeDerivation(document);
  if (fullText.length < 24) return null;
  const hit = findExecutedRelativeDurationDaysInText(fullText.toLowerCase());
  if (!hit) return null;
  const base = parseContractAnchorDate(executedDate);
  if (!base) return null;
  const end = addCalendarTermDuration(base, hit.days, 'day');
  return {
    endDateIso: formatLocalIsoDate(end),
    evidenceIds: evidenceRefsForExecutedRelativeSample(document, hit.clauseSample.toLowerCase()),
    durationDays: hit.days,
    clauseSample: hit.clauseSample,
  };
}

function tryDeriveTermEndFromDurationClause(
  document: ExtractedNodeDocument,
  ctx: {
    executedDate: string | null;
    termStartDate: string | null;
    effectiveTyped: string | null;
  },
): TermDurationDerivation | null {
  const hit = findBestTermDurationClauseHit(document);
  if (!hit) return null;

  let anchorString: string | null = null;
  if (hit.anchor === 'executed') {
    anchorString = ctx.executedDate;
  } else if (hit.anchor === 'effective') {
    anchorString = firstNonEmptyString(ctx.effectiveTyped, ctx.termStartDate, ctx.executedDate);
  } else {
    anchorString = firstNonEmptyString(ctx.termStartDate, ctx.executedDate);
  }
  if (!anchorString) return null;

  const base = parseContractAnchorDate(anchorString);
  if (!base) return null;

  const end = addCalendarTermDuration(base, hit.amount, hit.unit);
  return {
    endDateIso: formatLocalIsoDate(end),
    evidenceIds: hit.evidenceIds,
    hit,
  };
}


function resolveDurationClauseAnchorString(
  hit: TermDurationClauseHit,
  ctx: {
    executedDate: string | null;
    termStartDate: string | null;
    effectiveTyped: string | null;
  },
): string | null {
  let anchorString: string | null = null;
  if (hit.anchor === 'executed') {
    anchorString = ctx.executedDate;
  } else if (hit.anchor === 'effective') {
    anchorString = firstNonEmptyString(ctx.effectiveTyped, ctx.termStartDate, ctx.executedDate);
  } else {
    anchorString = firstNonEmptyString(ctx.termStartDate, ctx.executedDate);
  }
  return anchorString?.trim() ? anchorString : null;
}

function primarySourceFieldWhenDurationAnchorMissing(hit: TermDurationClauseHit): string {
  if (hit.anchor === 'executed') return 'executed_date';
  if (hit.anchor === 'effective') return 'effective_date';
  return 'term_start_date';
}

function termEndBlockedByMissingUpstream(
  executedDate: string | null,
  termStartDate: string | null,
  effectiveTyped: string | null,
  termEndDate: string | null,
  executedRelativeHit: ReturnType<typeof findExecutedRelativeDurationDaysInText>,
  durationClauseHit: TermDurationClauseHit | null,
): { dependency: FactDerivationDependency; reason: string } | null {
  if (termEndDate != null) return null;
  const ctx = { executedDate, termStartDate, effectiveTyped };
  if (executedRelativeHit && !executedDate?.trim()) {
    return {
      dependency: {
        source_field: 'executed_date',
        anchor_inheritance: 'executed_relative_duration_clause',
      },
      reason:
        'A term tied to the execution date was detected in the contract text, but executed_date was not extracted, so term end was not calculated.',
    };
  }
  if (durationClauseHit) {
    const anchorString = resolveDurationClauseAnchorString(durationClauseHit, ctx);
    if (!anchorString) {
      const sf = primarySourceFieldWhenDurationAnchorMissing(durationClauseHit);
      return {
        dependency: {
          source_field: sf,
          anchor_inheritance: `duration_clause_anchor:${durationClauseHit.anchor}`,
        },
        reason:
          'A term duration clause was detected, but no calendar anchor date was available to compute term end.',
      };
    }
  }
  return null;
}


/**
 * Heuristic extraction sometimes writes NTE / compensation prose into structured_fields.contractor_name.
 * Skip that so typed_fields / label evidence (actual contractor block) can win.
 */
function structuredContractorValueLooksLikeMoneyProse(value: string): boolean {
  const t = value.trim();
  if (t.length === 0) return false;
  if (/\bin\s+sum\s+of\b/i.test(t)) return true;
  if (/\b(?:not\s+to\s+exceed|shall\s+not\s+exceed|total\s+amount\s+payable|maximum\s+amount\s+payable)\b/i.test(t)) {
    return /\$|dollars?|\bmillion\b|\bbillion\b|\bthousand\b/i.test(t);
  }
  return false;
}

/** Contract / vendor codes and numeric-heavy tokens that are not a contractor legal name (ranking layer only). */
function contractorValueLooksNumericHeavy(value: string): boolean {
  if (contractorHasLegalEntitySuffix(value)) return false;
  const compact = value.replace(/[\s,.]/g, '');
  if (compact.length < 5) return false;
  const digits = (compact.match(/\d/g) ?? []).length;
  return digits / compact.length >= 0.5;
}

function contractorValueLooksLikeContractOrVendorCode(value: string): boolean {
  const v = value.trim();
  if (v.length === 0) return true;
  if (contractorHasLegalEntitySuffix(v)) return false;
  const compact = v.replace(/[\s\-]/g, '');
  if (/^(?:contract|agreement)\s*no\.?\s*:?\s*[A-Z0-9\-]+$/i.test(v)) return true;
  if (/^vendor\s*no\.?\s*:?\s*[A-Z0-9\-]+$/i.test(v)) return true;
  if (/^[A-Z]{1,4}-\d[\dA-Z\-]*$/i.test(v) && v.length <= 32) return true;
  if (/^[A-Z]{2,12}\d{2,8}$/.test(compact) && !/\s/.test(v)) return true;
  if (/^\d{5,}$/.test(compact)) return true;
  if (/\b(?:contract|agreement)\s+no\.?\s*:?\s*[A-Z0-9\-]+\s*$/i.test(v) && v.length <= 64) return true;
  if (/\bvendor\s+no\.?\s*:?\s*[A-Z0-9\-]+\s*$/i.test(v) && v.length <= 64) return true;
  return false;
}

function evidenceHasExplicitContractorOrVendorLine(evidence: EvidenceObject): boolean {
  const t = evidenceText(evidence);
  return /(?:^|[\n\r|])\s*(?:name\s+of\s+)?(?:contractor|vendor(?:\s+name)?)\s*[:#.\-–]\s+/im.test(t);
}

function contractorCandidateTier(source: string, evidence: EvidenceObject | null): 1 | 2 | 3 {
  if (evidence != null && evidenceHasExplicitContractorOrVendorLine(evidence)) return 3;
  if (source === 'structured_fields.contractor_name' || source === 'typed_fields.vendor_name') return 2;
  return 1;
}

/**
 * PDF lines like "Contractor: Stampede Ventures, Inc." are often ingested with the whole line as
 * label + text. Strip the field prefix so the candidate value is the legal name (dedupes with
 * typed vendor_name and fixes display/value match).
 */
function stripContractorLinePrefix(value: string): string {
  let t = value.trim();
  for (let i = 0; i < 3; i++) {
    const stripped = t
      .replace(
        /^(?:(?:name\s+of\s+)?contractor|vendor(?:\s+name)?|company(?:\s+name)?)\s*[:#.\-–]\s+/i,
        '',
      )
      .trim();
    if (stripped === t) break;
    t = stripped;
  }
  return t;
}

/** Cut common trailing field noise when a full PDF line was captured after "Contractor:" / "Vendor:". */
function trimContractorCandidateTail(value: string): string {
  let t = value.trim();
  const cut = /\s+(?:(?:Letting|Contract|Agreement)\s+Date|Contract\s+Execution)\b/i.exec(t);
  if (cut && cut.index != null && cut.index > 0) t = t.slice(0, cut.index).trim();
  return t;
}

function contractorHasLegalEntitySuffix(value: string): boolean {
  return /\b(inc\.?|llc|l\.l\.c\.|corp\.?|corporation|ltd\.?|limited|l\.p\.?|\blp\b|llp|pc|p\.c\.|plc)\b/i.test(value);
}

/** Insurance / ACORD-style form lines that are not the construction contractor legal name. */
function contractorValueLooksLikeInsuranceArtifact(value: string): boolean {
  const v = value.trim();
  if (v.length === 0) return true;
  const n = normalizeText(v);
  if (/^other$|^n\/a$|^na$|^tbd$/.test(n)) return true;
  if (/certificate\s+holder/.test(n)) return true;
  if (/\bholder\b/.test(n) && /\bother\b/.test(n)) return true;
  if (/\bacord\b/.test(n)) return true;
  if (/\bpolicy\s*number\b/.test(n)) return true;
  if (/\bform\s*no\.?\b/.test(n)) return true;
  if (/\bgeneral\s+aggregate\b/.test(n) && !contractorHasLegalEntitySuffix(v)) return true;
  if (/\bproducer\b/.test(n) && !contractorHasLegalEntitySuffix(v)) return true;
  if (/\bbroker\b/.test(n) && !contractorHasLegalEntitySuffix(v)) return true;
  if (/\bapplicant\b/.test(n) && !contractorHasLegalEntitySuffix(v)) return true;
  if (/\binsured\b/.test(n) && !contractorHasLegalEntitySuffix(v)) return true;
  if (/\bnamed\s+insured\b/.test(n) && !contractorHasLegalEntitySuffix(v)) return true;
  // "Vendor No. 12345" style with no company name
  if (/^\s*vendor\s*no\.?\s*:?\s*[\d\-]+\s*$/i.test(v) && !contractorHasLegalEntitySuffix(v)) return true;
  return false;
}

function contractorValueLooksWeakGeneric(value: string): boolean {
  if (contractorHasLegalEntitySuffix(value)) return false;
  const t = value.trim();
  if (t.length >= 120) return true;
  if (/^[\sA-Z0-9.,#\-]+$/.test(t) && t.length <= 48 && /\bOTHER\b/.test(t)) return true;
  return false;
}

function contractorRepeatPageBonus(value: string, allEvidence: EvidenceObject[]): number {
  if (contractorValueLooksLikeContractOrVendorCode(value)) return 0;
  if (contractorValueLooksNumericHeavy(value)) return 0;
  const needle = normalizeText(value);
  if (needle.length < 4) return 0;
  const pages = new Set<number>();
  for (const ev of allEvidence) {
    const blob = normalizeText(evidenceText(ev));
    const val = ev.value != null ? normalizeText(String(ev.value)) : '';
    if (blob.includes(needle) || val === needle) {
      const p = ev.location.page;
      if (typeof p === 'number') pages.add(p);
    }
  }
  return pages.size >= 2 ? 26 : 0;
}

function scoreContractorCandidate(
  value: string,
  evidence: EvidenceObject | null,
  source: 'structured' | 'typed' | 'evidence',
): number {
  let score = 12;
  if (source === 'structured') score += 24;
  if (source === 'typed') score += 20;
  if (contractorHasLegalEntitySuffix(value)) score += 48;

  if (evidence != null && evidenceHasExplicitContractorOrVendorLine(evidence)) {
    score += 22;
  }

  const label = evidence != null ? normalizeText(evidence.location.label ?? '') : '';
  if (/(?:name\s+of\s+)?contractor|vendor(?:\s+name)?|hereinaf.*contractor|between.*contractor/i.test(label)) {
    score += 24;
  } else if (labelMatchesAnyCandidate(label, ['contractor', 'vendor'])) {
    score += 18;
  } else if (labelMatchesCandidate(label, 'company')) {
    score += 5;
  }

  const blob = evidence != null ? normalizeText(evidenceText(evidence)) : '';
  if (
    /(?:entered\s+into|by\s+and\s+between|hereinafter\s+(?:called|referred)|acknowledg|signature|execution|witness\s+whereof)/i.test(
      blob,
    )
  ) {
    score += 20;
  }
  if (
    /(?:certificate\s+of\s+liability|acord|general\s+aggregate|policy\s+number|form\s+no\.|named\s+insured)\b/i.test(blob)
  ) {
    score -= 58;
  }

  if (contractorValueLooksLikeContractOrVendorCode(value)) score -= 72;
  if (contractorValueLooksNumericHeavy(value)) score -= 80;

  return score;
}

function findContractorLabelEvidence(document: ExtractedNodeDocument, max = 48): EvidenceObject[] {
  const labels = ['contractor', 'vendor', 'company'];
  return document.evidence
    .filter((evidence) => {
      const label = evidence.location.label ?? '';
      return labelMatchesAnyCandidate(label, labels);
    })
    .slice(0, max);
}

function findContractorEvidenceForContractorResolution(document: ExtractedNodeDocument, max = 48): EvidenceObject[] {
  const labelBased = findContractorLabelEvidence(document, max);
  const seen = new Set(labelBased.map((e) => e.id));
  const extra: EvidenceObject[] = [];
  for (const ev of document.evidence) {
    if (seen.has(ev.id)) continue;
    if (evidenceHasExplicitContractorOrVendorLine(ev)) {
      extra.push(ev);
      seen.add(ev.id);
    }
  }
  return [...labelBased, ...extra].slice(0, max);
}

interface ContractContractorResolution {
  value: string | null;
  fromStructured: boolean;
  evidenceRefIds: string[];
  chosenSource: string | null;
  scoredCandidates: Array<{
    value: string;
    score: number;
    source: string;
    evidenceId: string | null;
    page: number | null;
  }>;
}

function resolveContractContractor(
  document: ExtractedNodeDocument,
  options: {
    contractorExplicit: boolean;
    rawStructuredContractor: string;
    skipStructuredContractorAsProse: boolean;
    vendorName: string | null | undefined;
  },
): ContractContractorResolution {
  if (options.contractorExplicit) {
    const v = options.rawStructuredContractor.trim();
    return {
      value: v.length > 0 ? v : null,
      fromStructured: true,
      evidenceRefIds: [],
      chosenSource: v.length > 0 ? 'structured_fields.contractor_name.explicit_definition' : null,
      scoredCandidates: [],
    };
  }

  const labeledEvidence = findContractorEvidenceForContractorResolution(document, 48);
  type Cand = {
    value: string;
    score: number;
    tier: 1 | 2 | 3;
    evidence: EvidenceObject | null;
    source: string;
    page: number | null;
  };

  const candidates: Cand[] = [];
  const contractorCandidateStructured =
    options.rawStructuredContractor.length > 0 && !options.skipStructuredContractorAsProse
      ? options.rawStructuredContractor.trim()
      : null;

  if (
    contractorCandidateStructured != null
    && !contractorValueLooksLikeInsuranceArtifact(contractorCandidateStructured)
    && !contractorValueLooksLikeContractOrVendorCode(contractorCandidateStructured)
    && !contractorValueLooksNumericHeavy(contractorCandidateStructured)
  ) {
    candidates.push({
      value: contractorCandidateStructured,
      score: scoreContractorCandidate(contractorCandidateStructured, null, 'structured'),
      tier: contractorCandidateTier('structured_fields.contractor_name', null),
      evidence: null,
      source: 'structured_fields.contractor_name',
      page: null,
    });
  }

  const vendorRaw = typeof options.vendorName === 'string' ? options.vendorName.trim() : '';
  if (
    vendorRaw.length > 0
    && !contractorValueLooksLikeInsuranceArtifact(vendorRaw)
    && !contractorValueLooksLikeContractOrVendorCode(vendorRaw)
    && !contractorValueLooksNumericHeavy(vendorRaw)
  ) {
    candidates.push({
      value: vendorRaw,
      score: scoreContractorCandidate(vendorRaw, null, 'typed'),
      tier: contractorCandidateTier('typed_fields.vendor_name', null),
      evidence: null,
      source: 'typed_fields.vendor_name',
      page: null,
    });
  }

  for (const ev of labeledEvidence) {
    const parts: Array<{ raw: string; field: 'value' | 'text' }> = [];
    if (ev.value != null) {
      const s = String(ev.value).trim();
      if (s.length > 0) parts.push({ raw: s, field: 'value' });
    }
    if (typeof ev.text === 'string' && ev.text.trim().length > 0) {
      parts.push({ raw: ev.text.trim(), field: 'text' });
    }
    for (const { raw, field } of parts) {
      const cleaned = trimContractorCandidateTail(stripContractorLinePrefix(raw));
      if (cleaned.length === 0 || contractorValueLooksLikeInsuranceArtifact(cleaned)) continue;
      if (contractorValueLooksLikeContractOrVendorCode(cleaned) || contractorValueLooksNumericHeavy(cleaned)) continue;
      const source = `evidence.label_match.${field}`;
      candidates.push({
        value: cleaned,
        score: scoreContractorCandidate(cleaned, ev, 'evidence'),
        tier: contractorCandidateTier(source, ev),
        evidence: ev,
        source,
        page: typeof ev.location.page === 'number' ? ev.location.page : null,
      });
    }
  }

  if (candidates.length === 0) {
    return {
      value: null,
      fromStructured: false,
      evidenceRefIds: [],
      chosenSource: null,
      scoredCandidates: [],
    };
  }

  const merged = new Map<string, Cand>();
  for (const c of candidates) {
    const key = normalizeText(c.value);
    const prev = merged.get(key);
    if (!prev) merged.set(key, c);
    else if (c.tier > prev.tier) merged.set(key, c);
    else if (c.tier === prev.tier && c.score > prev.score) merged.set(key, c);
  }

  const pool = [...merged.values()].map((c) => ({
    ...c,
    score: c.score + contractorRepeatPageBonus(c.value, document.evidence),
  }));

  pool.sort((a, b) => {
    const td = b.tier - a.tier;
    if (td !== 0) return td;
    return b.score - a.score;
  });
  let best = pool[0]!;

  const withEntity = pool.filter((c) => contractorHasLegalEntitySuffix(c.value));
  const topHasEntity = contractorHasLegalEntitySuffix(best.value);
  if (!topHasEntity && withEntity.length > 0) {
    const entityBest = withEntity[0]!;
    const topWeak = best.score < 55 || contractorValueLooksWeakGeneric(best.value);
    if (topWeak && entityBest.score >= best.score - 10 && !contractorValueLooksLikeContractOrVendorCode(best.value)) {
      best = entityBest;
    }
  }

  const fromStructured =
    best.source === 'structured_fields.contractor_name'
    && contractorCandidateStructured != null
    && normalizeText(best.value) === normalizeText(contractorCandidateStructured);

  const evidenceRefIds = best.evidence != null ? [best.evidence.id] : [];

  return {
    value: best.value,
    fromStructured,
    evidenceRefIds,
    chosenSource: best.source,
    scoredCandidates: pool.map((c) => ({
      value: c.value,
      score: Math.round(c.score * 10) / 10,
      source: c.source,
      evidenceId: c.evidence?.id ?? null,
      page: c.page,
    })),
  };
}

function ownerValueLooksInvalid(value: string): boolean {
  const trimmed = value
    .replace(/[“”"']/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (trimmed.length < 3) return true;
  if (!/[A-Za-z]/.test(trimmed)) return true;
  if (/^of\b/i.test(trimmed)) return true;
  if (
    /\b(?:acknowledg(?:ment)?|notary|commission expires|subscribed and sworn|before me|vice president|cabinet secretary)\b/i.test(
      trimmed,
    )
  ) {
    return true;
  }
  if (contractorValueLooksLikeContractOrVendorCode(trimmed) || contractorValueLooksNumericHeavy(trimmed)) {
    return true;
  }
  return false;
}

function normalizeOwnerDisplayValue(value: string): string {
  let cleaned = value
    .replace(/[“”"']/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^between\s+(?:the\s+)?/i, '')
    .replace(/^the\s+/i, '')
    .replace(/^[,;:)\]\s]+/, '')
    .replace(/[,;:)\]\s]+$/, '')
    .trim();

  const letters = cleaned.replace(/[^A-Za-z]/g, '');
  const upperLetters = letters.replace(/[^A-Z]/g, '').length;
  if (letters.length >= 6 && upperLetters / letters.length >= 0.8) {
    cleaned = cleaned
      .toLowerCase()
      .replace(/\b([a-z])/g, (match) => match.toUpperCase())
      .replace(/\b(Of|And|The)\b/g, (match) => match.toLowerCase());
  }

  return cleaned;
}

type ContractOwnerResolution = {
  value: string | null;
  evidenceRefIds: string[];
  chosenSource: string | null;
  scoredCandidates: Array<{
    value: string;
    score: number;
    source: string;
    evidenceId: string | null;
    page: number | null;
  }>;
};

const OWNER_DEFINED_ROLE_RE =
  /\b([A-Z][A-Za-z0-9 &.,'()-]{2,160}?)\s*,?\s*\(\s*["'“”‘’]?(?:department|owner|client|agency|authority)["'“”‘’]?\s*\)/i;
const OWNER_LABELED_VALUE_RE =
  /\b(?:owner|client|agency|authority|department)\b\s*[:=\-]\s*([A-Z][A-Za-z0-9 &.,'()-]{2,160})/i;
const OWNER_ORG_FALLBACK_RE =
  /\b([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){0,5}\s+Department of Transportation|City of [A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){0,5}|Town of [A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){0,5}|County of [A-Z][A-Za-z]+(?:\s+[A-Za-z]+){0,5}|[A-Z][A-Za-z]+ County(?:,\s*[A-Z][A-Za-z]+)?)\b/;

function resolveContractOwner(document: ExtractedNodeDocument): ContractOwnerResolution {
  type Cand = {
    value: string;
    score: number;
    source: string;
    evidence: EvidenceObject | null;
    page: number | null;
  };

  const candidates: Cand[] = [];
  const pushCandidate = (
    rawValue: string | null | undefined,
    source: string,
    evidence: EvidenceObject | null,
    baseScore: number,
    contextText?: string,
  ) => {
    if (!rawValue) return;
    const cleaned = normalizeOwnerDisplayValue(rawValue);
    if (ownerValueLooksInvalid(cleaned)) return;
    const context = normalizeText(contextText ?? (evidence ? evidenceSearchText(evidence) : ''));
    let score = baseScore;
    const page = typeof evidence?.location.page === 'number' ? evidence.location.page : null;
    if (page != null) {
      score += page <= 2 ? 24 : page <= 5 ? 12 : -Math.min(24, (page - 5) * 2);
    }
    if (evidence?.kind === 'table' || evidence?.kind === 'table_row') {
      score -= 24;
    }
    if (/\b(?:department of transportation|county|city of|town of|authority|agency)\b/i.test(cleaned)) {
      score += 28;
    }
    if (/\bdepartment of transportation\b/i.test(cleaned) && cleaned.split(/\s+/).length >= 4) {
      score += 24;
    }
    if (/\b(?:this contract|this agreement|between|department)\b/.test(context)) {
      score += 12;
    }
    if (/\b(?:acknowledg(?:ment)?|notary|commission expires|subscribed and sworn|state of|county of)\b/.test(context)) {
      score -= 120;
    }
    candidates.push({
      value: cleaned,
      score,
      source,
      evidence,
      page,
    });
  };

  const structuredOwner =
    typeof document.structured_fields.owner_name === 'string'
      ? document.structured_fields.owner_name.trim()
      : '';
  if (structuredOwner.length > 0 && !ownerValueLooksInvalid(structuredOwner)) {
    pushCandidate(
      structuredOwner,
      'structured_fields.owner_name',
      null,
      60,
      structuredOwner,
    );
  }

  for (const evidence of document.evidence) {
    const search = evidenceSearchText(evidence).replace(/\s+/g, ' ').trim();
    if (!search.trim()) continue;

    const definedMatch = OWNER_DEFINED_ROLE_RE.exec(search);
    if (definedMatch) {
      pushCandidate(definedMatch[1], 'evidence.defined_role', evidence, 120, search);
    }

    const labeledMatch = OWNER_LABELED_VALUE_RE.exec(search);
    if (labeledMatch) {
      pushCandidate(labeledMatch[1], 'evidence.label', evidence, 105, search);
    }

    const fallbackMatch = OWNER_ORG_FALLBACK_RE.exec(search);
    if (fallbackMatch) {
      pushCandidate(fallbackMatch[1], 'evidence.org_phrase', evidence, 84, search);
    }
  }

  if (candidates.length === 0) {
    return {
      value: null,
      evidenceRefIds: [],
      chosenSource: null,
      scoredCandidates: [],
    };
  }

  const merged = new Map<string, Cand>();
  for (const candidate of candidates) {
    const key = normalizeText(candidate.value);
    const prev = merged.get(key);
    if (!prev || candidate.score > prev.score) merged.set(key, candidate);
  }

  const ranked = [...merged.values()].sort((a, b) => b.score - a.score);
  const best = ranked[0]!;

  return {
    value: best.value,
    evidenceRefIds: best.evidence != null ? [best.evidence.id] : [],
    chosenSource: best.source,
    scoredCandidates: ranked.map((candidate) => ({
      value: candidate.value,
      score: Math.round(candidate.score * 10) / 10,
      source: candidate.source,
      evidenceId: candidate.evidence?.id ?? null,
      page: candidate.page,
    })),
  };
}

type ContractDateResolution = {
  value: string | null;
  evidenceRefIds: string[];
  chosenSource: string | null;
  scoredCandidates: Array<{
    value: string;
    score: number;
    source: string;
    evidenceId: string | null;
    page: number | null;
  }>;
};

const EXECUTED_DATE_EXPLICIT_REGEXES: readonly RegExp[] = [
  new RegExp(
    `(?:agreement\\s+date|contract\\s+execution(?:\\s+date)?|executed(?:\\s+on|\\s+this)?|dated\\s+this|made\\s+and\\s+entered(?:\\s+into)?(?:\\s+this)?|entered\\s+into(?:\\s+this)?)\\b[^0-9A-Za-z]{0,40}${CONTRACT_DATE_CAPTURE_SOURCE}`,
    'i',
  ),
  new RegExp(
    `(?:effective\\s+date(?:\\s+of\\s+(?:this|the)\\s+(?:agreement|contract))?|effective\\s+as\\s+of)\\b[^0-9A-Za-z]{0,24}${CONTRACT_DATE_CAPTURE_SOURCE}`,
    'i',
  ),
];
const EXECUTED_DATE_TOP_MATTER_REGEX = new RegExp(`\\b${CONTRACT_DATE_CAPTURE_SOURCE}\\b`, 'i');

function contractDateNoisePenalty(textLower: string): number {
  if (
    /\b(?:trade classification|base rate|fringe rate|policy eff|policy exp|certificate of liability|acord|wage decision|street, highway, utility|notary|commission expires|acknowledg(?:ment)?|subscribed and sworn|before me)\b/.test(
      textLower,
    )
  ) {
    return -140;
  }
  return 0;
}

function resolveContractExecutedDate(document: ExtractedNodeDocument): ContractDateResolution {
  type Cand = {
    value: string;
    score: number;
    source: string;
    evidence: EvidenceObject | null;
    page: number | null;
  };

  const candidates: Cand[] = [];
  const pushCandidate = (
    rawValue: unknown,
    source: string,
    evidence: EvidenceObject | null,
    baseScore: number,
    contextText?: string,
  ) => {
    const normalized = normalizeContractDateCandidate(rawValue);
    if (!normalized) return;
    const context = normalizeText(contextText ?? (evidence ? evidenceSearchText(evidence) : ''));
    let score = baseScore + contractDateNoisePenalty(context);
    const page = typeof evidence?.location.page === 'number' ? evidence.location.page : null;
    if (page != null) {
      score += page <= 2 ? 28 : page <= 5 ? 14 : -Math.min(80, (page - 5) * 2);
    }
    if (/\b(?:agreement date|contract execution|executed|dated this|made and entered|entered into)\b/.test(context)) {
      score += 26;
    }
    if (/\b(?:contract no|vendor no|this contract|this agreement|department)\b/.test(context)) {
      score += 16;
    }
    candidates.push({
      value: normalized,
      score,
      source,
      evidence,
      page,
    });
  };

  pushCandidate(document.structured_fields.executed_date, 'structured_fields.executed_date', null, 132);
  pushCandidate(document.typed_fields.effective_date, 'typed_fields.effective_date', null, 32);
  pushCandidate(document.typed_fields.contract_date, 'typed_fields.contract_date', null, 28);

  for (const evidence of document.evidence) {
    const search = evidenceSearchText(evidence).replace(/\s+/g, ' ').trim();
    if (!search.trim()) continue;

    for (const regex of EXECUTED_DATE_EXPLICIT_REGEXES) {
      const match = regex.exec(search);
      if (match?.[1]) {
        pushCandidate(match[1], 'evidence.executed_or_effective_date', evidence, 92, search);
      }
    }

    const page = typeof evidence.location.page === 'number' ? evidence.location.page : null;
    if (page != null && page <= 2 && /\b(?:contract no|vendor no|this contract|this agreement|department)\b/i.test(search)) {
      const topMatterMatch = EXECUTED_DATE_TOP_MATTER_REGEX.exec(search);
      if (topMatterMatch?.[1]) {
        pushCandidate(topMatterMatch[1], 'evidence.front_matter_date', evidence, 108, search);
      }
    }
  }

  if (candidates.length === 0) {
    return {
      value: null,
      evidenceRefIds: [],
      chosenSource: null,
      scoredCandidates: [],
    };
  }

  const ranked = candidates
    .sort((a, b) => b.score - a.score)
    .filter((candidate, index, list) =>
      list.findIndex((row) =>
        row.value === candidate.value &&
        row.source === candidate.source &&
        row.evidence?.id === candidate.evidence?.id,
      ) === index,
    );
  const best = ranked[0]!;

  return {
    value: best.value,
    evidenceRefIds: best.evidence != null ? [best.evidence.id] : [],
    chosenSource: best.source,
    scoredCandidates: ranked.map((candidate) => ({
      value: candidate.value,
      score: Math.round(candidate.score * 10) / 10,
      source: candidate.source,
      evidenceId: candidate.evidence?.id ?? null,
      page: candidate.page,
    })),
  };
}

const EFFECTIVE_DATE_INHERITS_EXECUTED_RE =
  /\beffective(?:\s+date)?(?:\s+is|\s+shall\s+be|\s+becomes|\s+as\s+of)?\s+(?:as\s+of\s+)?the\s+date\s+(?:the\s+)?last\s+party\s+executes?\s+(?:the\s+)?(?:agreement|contract)\b/i;

function resolveEffectiveDateInheritedFromExecuted(document: ExtractedNodeDocument): string[] {
  const evidenceIds: string[] = [];
  for (const evidence of document.evidence) {
    const search = evidenceSearchText(evidence).replace(/\s+/g, ' ').trim();
    if (!search.trim()) continue;
    if (EFFECTIVE_DATE_INHERITS_EXECUTED_RE.test(search)) {
      evidenceIds.push(evidence.id);
    }
  }
  return [...new Set(evidenceIds)];
}

/** Facts whose missing PDF/XLSX citations should surface as extraction gaps (not derived-only metrics). */
const FACT_KEYS_REQUIRING_CITATION = new Set([
  'contractor_name',
  'owner_name',
  'contract_ceiling',
  'rate_schedule_present',
  'executed_date',
  'term_start_date',
  'term_end_date',
  'expiration_date',
  'invoice_number',
  'billed_amount',
  'contractor_name',
  'invoice_date',
  'approved_amount',
  'invoice_reference',
  'recommendation_date',
]);

function factCitationGaps(document: ExtractedNodeDocument, facts: PipelineFact[]): ExtractionGap[] {
  const gaps: ExtractionGap[] = [];
  for (const fact of facts) {
    if (fact.evidence_refs.length > 0) continue;
    if (!FACT_KEYS_REQUIRING_CITATION.has(fact.key)) continue;
    for (let i = 0; i < fact.missing_source_context.length; i++) {
      const note = fact.missing_source_context[i];
      if (!note) continue;
      gaps.push({
        id: `gap:fact:${document.document_id}:${fact.key}:${i}`,
        category: 'missing_fact_citation',
        severity:
          fact.key.includes('ceiling') || fact.key === 'billed_amount' || fact.key === 'approved_amount'
            ? 'warning'
            : 'info',
        message: `${fact.label}: ${note}`,
        source: 'pipeline',
      });
    }
  }
  return gaps;
}

function ticketRowFieldGaps(document: ExtractedNodeDocument): ExtractionGap[] {
  if (document.family !== 'ticket') return [];
  const spreadsheet = asRecord(document.content_layers?.spreadsheet);
  const ticketExport = asRecord(spreadsheet?.normalized_ticket_export);
  const summary = asRecord(ticketExport?.summary);
  const missingQuantityRows = Number(summary?.missing_quantity_rows ?? 0);
  const missingRateRows = Number(summary?.missing_rate_rows ?? 0);
  const gaps: ExtractionGap[] = [];
  if (missingQuantityRows > 0) {
    gaps.push({
      id: `gap:ticket:quantity:${document.document_id}`,
      category: 'ticket_row_incomplete',
      severity: 'warning',
      message: `${missingQuantityRows} ticket row(s) have no grounded quantity value.`,
      source: 'pipeline',
    });
  }
  if (missingRateRows > 0) {
    gaps.push({
      id: `gap:ticket:rate:${document.document_id}`,
      category: 'ticket_row_incomplete',
      severity: 'warning',
      message: `${missingRateRows} ticket row(s) have no grounded rate value.`,
      source: 'pipeline',
    });
  }
  return gaps;
}

function missingAnchorReason(document: ExtractedNodeDocument, value: unknown): string {
  if (document.evidence.length === 0) {
    return 'No evidence objects were produced for this document (empty parser output).';
  }
  if (!hasInspectableValue(value)) {
    return 'This field has no inspectable value to match against evidence spans.';
  }
  return 'No evidence span matched field labels, regex patterns, or literal field value in the extracted evidence set.';
}

function addFact(
  document: ExtractedNodeDocument,
  facts: PipelineFact[],
  key: string,
  label: string,
  value: unknown,
  evidenceRefs: string[],
  confidence: number,
  options?: {
    machine_classification?: string | null;
    derivation?: {
      status: DerivationStatus;
      dependency?: FactDerivationDependency;
      upstream_missing_reason?: string;
    };
  },
): void {
  let refs = [...new Set(evidenceRefs)];
  let resolution: NonNullable<PipelineFact['evidence_resolution']> =
    refs.length > 0 ? 'primary' : 'none';

  if (refs.length === 0 && hasInspectableValue(value)) {
    const fallback = findEvidenceByValueMatch(document.evidence, value);
    refs = fallback.map((evidence) => evidence.id);
    if (refs.length > 0) resolution = 'value_fallback';
  }

  const deriv = options?.derivation;
  let derivationStatus: DerivationStatus | undefined = deriv?.status;
  const derivationDependency = deriv?.dependency;
  if (derivationStatus === 'calculated' && refs.length === 0) {
    derivationStatus = 'low_confidence';
  }

  let missingSourceContext: string[];
  if (refs.length > 0) {
    missingSourceContext = [];
  } else if (derivationStatus === 'upstream_missing' && deriv?.upstream_missing_reason) {
    missingSourceContext = [deriv.upstream_missing_reason];
  } else {
    missingSourceContext = [missingAnchorReason(document, value)];
  }

  const machineClassification = options?.machine_classification;
  facts.push({
    id: `${document.document_id}:${key}`,
    key,
    label,
    value,
    display_value: toDisplayValue(value),
    confidence,
    evidence_refs: refs,
    gap_refs: [],
    missing_source_context: missingSourceContext,
    source_document_id: document.document_id,
    document_family: document.family,
    evidence_resolution: resolution,
    ...(machineClassification != null ? { machine_classification: machineClassification } : {}),
    ...(derivationStatus != null ? { derivation_status: derivationStatus } : {}),
    ...(derivationDependency != null ? { derivation_dependency: derivationDependency } : {}),
  });
}

/** Document-level phrases for an overall contract $ cap (excludes per-unit / schedule-only caps). */
const GLOBAL_CONTRACT_CEILING_LANGUAGE_RE = /\b(?:total\s+compensation|contract\s+amount|contract\s+sum|aggregate\s+payments|maximum\s+contract\s+amount|total\s+amount\s+of\s+bid(?:\s+for\s+entire\s+project)?|total\s+amount\s+payable|contract\s+ceiling|contract\s+limit|contract\s+cap|ceiling\s+for\s+this\s+contract|maximum\s+amount\s+payable|aggregate\s+cap|contractual\s+limit|ceiling\s+amount)\b/i;

const UNIT_PRICE_OR_SCHEDULE_LANGUAGE_RE = /\b(?:unit\s+prices?|unit\s+pricing|unit[-\s]rate|schedule\s+of\s+(?:values|rates)|lump\s+sum\s+per|price\s+per\s+unit|price\s+schedule|unit\s+rate\s+price|emergency\s+debris\s+removal\s+unit\s+rates)\b/i;

/**
 * NTE followed within a short window by rate-table vocabulary → per-unit / classification cap, not contract ceiling.
 * Mirrors (?i)(not[-\s]to[-\s]exceed).*?(rate|unit|hourly|price|classification) with a bounded window.
 */
const RATE_CAP_NTE_PROXIMITY_RE =
  /(?:\bnot\s+to\s+exceed\b|\bnte\b)[\s\S]{0,200}?\b(?:rate|unit|hourly|price|classification)\b/i;

const EXPLICIT_CEILING_NTE_REGEXES: readonly RegExp[] = [
  /(?:\bnot\s+to\s+exceed\b|\bnte\b)[^$0-9]{0,12}\$\s*([\d,]+(?:\.\d{1,2})?)/i,
  /(?:\bnot\s+to\s+exceed\b|\bnte\b)[^A-Za-z0-9]{0,12}(?:amount|sum|price|value|fee|compensation|contract\s+amount)[^$0-9]{0,20}\$?\s*([\d,]+(?:\.\d{1,2})?)/i,
];

const EXPLICIT_CEILING_MAX_REGEXES: readonly RegExp[] = [
  /(?:\bmaximum\s+amount\b|\bmaximum\s+contract\s+amount\b|\bcontractual\s+limit\b|\bceiling\s+amount\b|\baggregate\s+cap\b)[^$0-9]{0,24}\$?\s*([\d,]+(?:\.\d{1,2})?)/i,
];

function nteCeilingMatchIsRateCapContext(fullText: string, match: RegExpExecArray): boolean {
  const mi = match.index;
  const len = (match[0] ?? '').length;
  const ctx = fullText.slice(Math.max(0, mi - 24), Math.min(fullText.length, mi + len + 200));
  if (!/(?:\bnot\s+to\s+exceed\b|\bnte\b)/i.test(ctx)) return false;
  return RATE_CAP_NTE_PROXIMITY_RE.test(ctx);
}

function findExplicitNteCeilingEvidenceSkippingRateCap(
  document: ExtractedNodeDocument,
  regexes: readonly RegExp[],
): { value: string | number | boolean | null; evidence: EvidenceObject[] } | null {
  for (const evidence of document.evidence) {
    const text = evidenceText(evidence);
    if (!text) continue;
    for (const regex of regexes) {
      const baseFlags = regex.flags.replace(/g/g, '');
      const flags = baseFlags.includes('i') ? baseFlags : `${baseFlags}i`;
      const re = new RegExp(regex.source, `${flags}g`);
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) != null) {
        if (nteCeilingMatchIsRateCapContext(text, m)) continue;
        return {
          value: m[1] ?? m[0] ?? null,
          evidence: [evidence],
        };
      }
    }
  }
  return null;
}

function resolveContractCeilingFacts(params: {
  document: ExtractedNodeDocument;
  rateSchedulePresent: boolean;
}): {
  selectedCeilingEvidence: { value: string | number | boolean | null; evidence: EvidenceObject[] } | null;
  ceiling: number | null;
  ceiling_machine_classification: string | null;
} {
  const haystack = joinContractTextForExecutedRelativeDerivation(params.document);
  const hasGlobalCeilingLanguage = GLOBAL_CONTRACT_CEILING_LANGUAGE_RE.test(haystack);
  const hasUnitPriceLanguageInText =
    UNIT_PRICE_OR_SCHEDULE_LANGUAGE_RE.test(haystack)
    || /\bexhibit\s+[a-z]\b[\s\S]{0,120}\b(?:unit\s+rate|rate\s+schedule|unit\s+rates)\b/i.test(
      haystack,
    );
  const unitPriceNoCeiling =
    (params.rateSchedulePresent || hasUnitPriceLanguageInText) && !hasGlobalCeilingLanguage;

  const explicitNteCeilingEvidence = findExplicitNteCeilingEvidenceSkippingRateCap(
    params.document,
    EXPLICIT_CEILING_NTE_REGEXES,
  );
  const explicitMaxCeilingEvidence = findEvidenceByRegex(params.document, [...EXPLICIT_CEILING_MAX_REGEXES]);
  const labeledCeilingEvidence = findEvidenceByRegex(params.document, [
    /(?:\bcontract\s+ceiling\b|\bcontract\s+limit\b|\bcontract\s+cap\b|\bceiling\s+for\s+this\s+contract\b|\bmaximum\s+payable\b)[^$0-9]{0,24}\$?\s*([\d,]+(?:\.\d{1,2})?)/i,
  ]);
  const totalBidEvidence = findEvidenceByRegex(params.document, [
    /(?:total\s+amount\s+of\s+bid(?:\s+for\s+entire\s+project)?)[^$0-9]{0,20}\$?\s*([\d,]+(?:\.\d{1,2})?)/i,
  ]);

  let selectedCeilingEvidence =
    explicitNteCeilingEvidence ??
    explicitMaxCeilingEvidence ??
    labeledCeilingEvidence ??
    totalBidEvidence;
  let ceiling = parseNumber(
    selectedCeilingEvidence?.value ??
    params.document.typed_fields.nte_amount ??
    params.document.typed_fields.notToExceedAmount ??
    params.document.structured_fields.nte_amount ??
    null,
  );
  let ceiling_machine_classification: string | null = null;

  if (unitPriceNoCeiling) {
    ceiling = null;
    selectedCeilingEvidence = null;
    ceiling_machine_classification = 'rate_price_no_ceiling';
  }

  return { selectedCeilingEvidence, ceiling, ceiling_machine_classification };
}

function normalizeContract(document: ExtractedNodeDocument): { facts: PipelineFact[]; extracted: Record<string, unknown> } {
  const facts: PipelineFact[] = [];
  const contractDebugEnabled = process.env.EIGHTFORGE_DEBUG_CONTRACT === '1';
  const pdf = asRecord(document.content_layers?.pdf);
  const pdfTables = asArray<Record<string, unknown>>(asRecord(pdf?.tables)?.tables);

  const tableQualifications = pdfTables.map((table, index) => {
    const q = qualifyRateScheduleTable(table);
    const id = typeof table.id === 'string' ? table.id : `table:${index + 1}`;
    const page = typeof table.page_number === 'number' ? table.page_number : null;
    const headers = stringValues(table.headers);
    const row_count = asArray<unknown>(table.rows).length;
    return {
      id,
      index,
      page,
      headers,
      row_count,
      estimated_rate_row_count: q.estimated_rate_row_count,
      accepted: q.accepted,
      score: q.score,
      rejected_reasons: q.rejected_reasons,
      accepted_reasons: q.accepted_reasons,
      qualification_signals: q,
      _table: table,
    };
  });
  const acceptedRateTables = tableQualifications.filter((t) => t.accepted);
  const bestRateTableCandidate =
    [...tableQualifications]
      .sort((a, b) =>
        (b.score - a.score) ||
        (b.estimated_rate_row_count - a.estimated_rate_row_count) ||
        (b.row_count - a.row_count) ||
        (a.index - b.index),
      )[0]
    ?? null;
  const selectedRateTable =
    [...acceptedRateTables]
      .sort((a, b) =>
        (b.score - a.score) ||
        (b.estimated_rate_row_count - a.estimated_rate_row_count) ||
        (b.row_count - a.row_count) ||
        (a.index - b.index),
      )[0]
    ?? null;
  const rateTables = acceptedRateTables.map((t) => t._table);
  const rateFromSignals =
    document.section_signals.rate_section_present === true ||
    document.section_signals.unit_price_structure_present === true;
  const rateRowCountFromTables = acceptedRateTables.reduce(
    (sum, table) => sum + (table.estimated_rate_row_count || table.row_count),
    0,
  );
  const rateSchedulePresent = acceptedRateTables.length > 0 || rateFromSignals;
  const rateRowCount = acceptedRateTables.length > 0
    ? rateRowCountFromTables
    : Number(document.section_signals.rate_items_detected ?? 0) || 0;
  const inferredRatePages = acceptedRateTables.length > 0
    ? inferWeakContinuationRatePages(document, acceptedRateTables, pdfTables)
    : { pages: [] as number[], inferred_gap_pages: [] as number[] };
  const ratePagesArray = acceptedRateTables.length > 0
    ? inferredRatePages.pages
    : asArray<number>(document.section_signals.rate_section_pages);
  const ratePages = formatPageList(ratePagesArray);
  const rateTableEvidenceRefs: string[] = [];
  for (const table of rateTables) {
    const rows = asArray<{ id?: string }>(table.rows);
    if (rows.length === 0) continue;
    if (typeof table.id === 'string') rateTableEvidenceRefs.push(table.id);
    for (const row of rows.slice(0, 32)) {
      if (typeof row.id === 'string') rateTableEvidenceRefs.push(row.id);
    }
  }
  const ratePageEvidenceRefs =
    ratePagesArray.length > 0
      ? document.evidence
          .filter(
            (ev) => typeof ev.location.page === 'number' && ratePagesArray.includes(ev.location.page),
          )
          .map((ev) => ev.id)
      : [];
  const rateEvidenceRefs = [...new Set([...ratePageEvidenceRefs, ...rateTableEvidenceRefs])];

  const {
    selectedCeilingEvidence,
    ceiling,
    ceiling_machine_classification,
  } = resolveContractCeilingFacts({ document, rateSchedulePresent });

  const ownerResolution = resolveContractOwner(document);
  const executedDateResolution = resolveContractExecutedDate(document);
  const termStartDateEvidence = findEvidenceByRegex(document, [
    /(?:date\s+of\s+availability(?:\s+for\s+this\s+contract)?\s+is)[^0-9A-Za-z]{0,8}([A-Za-z]+\s+\d{1,2},\s+\d{4}|\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/i,
  ]);
  const termEndDateEvidence = findEvidenceByRegex(document, [
    /(?:completion\s+date(?:\s+for\s+this\s+contract)?\s+is)[^0-9A-Za-z]{0,8}([A-Za-z]+\s+\d{1,2},\s+\d{4}|\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/i,
  ]);

  const contractorExplicit =
    document.structured_fields.contractor_name_source === 'explicit_definition';
  const rawStructuredContractor =
    typeof document.structured_fields.contractor_name === 'string'
      ? document.structured_fields.contractor_name.trim()
      : '';
  const skipStructuredContractorAsProse =
    rawStructuredContractor.length > 0 &&
    !contractorExplicit &&
    (structuredContractorValueLooksLikeMoneyProse(rawStructuredContractor)
      || contractorValueLooksLikeContractOrVendorCode(rawStructuredContractor)
      || contractorValueLooksNumericHeavy(rawStructuredContractor));
  const contractorCandidateStructured =
    rawStructuredContractor.length > 0 && !skipStructuredContractorAsProse
      ? rawStructuredContractor
      : null;
  const contractorResolution = resolveContractContractor(document, {
    contractorExplicit,
    rawStructuredContractor,
    skipStructuredContractorAsProse,
    vendorName: typeof document.typed_fields.vendor_name === 'string' ? document.typed_fields.vendor_name : undefined,
  });
  const contractor = contractorResolution.value;
  const contractorFromStructured = contractorResolution.fromStructured;
  const contractorCandidateTyped = document.typed_fields.vendor_name;
  const owner = ownerResolution.value;
  const executedCandidateStructured = normalizeContractDateCandidate(document.structured_fields.executed_date);
  const executedCandidateRegex = executedDateResolution.value;
  const executedCandidateTypedEffective = normalizeContractDateCandidate(document.typed_fields.effective_date);
  const executedCandidateTypedContract = normalizeContractDateCandidate(document.typed_fields.contract_date);
  const executedDate = executedDateResolution.value;
  const executedDateEvidenceRefs = executedDateResolution.evidenceRefIds;
  const termStartCandidateRegex = normalizeContractDateCandidate(termStartDateEvidence?.value);
  const termStartCandidateStructured = normalizeContractDateCandidate(document.structured_fields.term_start_date);
  let termStartDate = firstValidContractDate(
    termStartCandidateRegex,
    termStartCandidateStructured,
  );
  const termStartFromExtraction = Boolean(termStartDate);
  let termStartDateEvidenceRefs: string[] =
    termStartDateEvidence?.evidence.map((evidence) => evidence.id) ?? [];
  const termEndCandidateRegex = normalizeContractDateCandidate(termEndDateEvidence?.value);
  const termEndCandidateStructured = normalizeContractDateCandidate(document.structured_fields.term_end_date);
  let termEndDate = firstValidContractDate(
    termEndCandidateRegex,
    termEndCandidateStructured,
  );
  let termEndDateEvidenceRefs: string[] =
    termEndDateEvidence?.evidence.map((evidence) => evidence.id) ?? [];

  const termDerivationHaystack = joinContractTextForExecutedRelativeDerivation(document);
  const executedRelativeClauseProbe = findExecutedRelativeDurationDaysInText(
    termDerivationHaystack.toLowerCase(),
  );
  const durationClauseProbe = findBestTermDurationClauseHit(document);
  const effectiveDateInheritedFromExecutedEvidenceRefs =
    resolveEffectiveDateInheritedFromExecuted(document);
  const effectiveDateInheritedFromExecuted =
    effectiveDateInheritedFromExecutedEvidenceRefs.length > 0;
  const effectiveTypedForDuration = firstValidContractDate(
    document.typed_fields.effective_date,
    effectiveDateInheritedFromExecuted && executedDate ? executedDate : null,
  );

  let termDurationDerivation: TermDurationDerivation | null = null;
  let executedRelativeDerivation: ExecutedRelativeTermDerivation | null = null;
  let termStartFilledFromExecutedRelative = false;
  let termStartFilledFromEffectiveExecution = false;
  if (!termEndDate) {
    const executedRel = tryDeriveTermEndFromExecutedRelativeDuration(document, executedDate);
    if (executedRel != null) {
      executedRelativeDerivation = executedRel;
      termEndDate = executedRel.endDateIso;
      termEndDateEvidenceRefs = executedRel.evidenceIds;
    }
  }
  if (executedRelativeDerivation != null && !termStartDate && executedDate) {
    termStartDate = executedDate;
    termStartDateEvidenceRefs = [...executedDateEvidenceRefs];
    termStartFilledFromExecutedRelative = true;
  }
  if (!termStartDate && effectiveDateInheritedFromExecuted && executedDate) {
    termStartDate = executedDate;
    termStartDateEvidenceRefs = [
      ...new Set([...effectiveDateInheritedFromExecutedEvidenceRefs, ...executedDateEvidenceRefs]),
    ];
    termStartFilledFromEffectiveExecution = true;
  }
  if (!termEndDate) {
    const derived = tryDeriveTermEndFromDurationClause(document, {
      executedDate,
      termStartDate,
      effectiveTyped: effectiveTypedForDuration,
    });
    if (derived != null) {
      termDurationDerivation = derived;
      termEndDate = derived.endDateIso;
      termEndDateEvidenceRefs = derived.evidenceIds;
    }
  }

  const termEndUpstreamBlock = termEndBlockedByMissingUpstream(
    executedDate,
    termStartDate,
    effectiveTypedForDuration,
    termEndDate,
    executedRelativeClauseProbe,
    durationClauseProbe,
  );

  let termEndLowConfidenceParse = false;
  if (!termEndDate && durationClauseProbe) {
    const anchorTry = resolveDurationClauseAnchorString(durationClauseProbe, {
      executedDate,
      termStartDate,
      effectiveTyped: effectiveTypedForDuration,
    });
    if (anchorTry?.trim() && !parseContractAnchorDate(anchorTry)) {
      termEndLowConfidenceParse = true;
    }
  }
  if (!termEndDate && executedRelativeClauseProbe && executedDate?.trim() && executedRelativeDerivation == null) {
    if (!parseContractAnchorDate(executedDate)) {
      termEndLowConfidenceParse = true;
    }
  }

  const structuredExpiration = normalizeContractDateCandidate(document.structured_fields.expiration_date);
  const expirationDate = structuredExpiration ?? termEndDate ?? null;
  const expirationEvidenceRefs =
    expirationDate != null
    && termEndDate != null
    && String(expirationDate) === String(termEndDate)
    && termEndDateEvidenceRefs.length > 0
    && structuredExpiration == null
      ? termEndDateEvidenceRefs
      : [];
  const termEndFromDurationDerivation =
    termDurationDerivation != null || executedRelativeDerivation != null;
  const timeAndMaterialsPresent =
    document.section_signals.time_and_materials_present === true ||
    /time\s*(?:and|&)\s*materials|t&m/i.test(document.text_preview);

  // When contractor comes from structured extraction, prefer value-based grounding so we anchor to
  // the exact legal name rather than a generic "contractor" mention later in the document.
  const contractorEvidenceRefs =
    contractorExplicit || contractorFromStructured
      ? []
      : contractorResolution.evidenceRefIds.length > 0
        ? contractorResolution.evidenceRefIds
        : findContractorEvidenceForContractorResolution(document, 48).map((evidence) => evidence.id);
  addFact(document, facts, 'contractor_name', 'Contractor', contractor, contractorEvidenceRefs, contractor ? 0.84 : 0.42);
  addFact(document, facts, 'owner_name', 'Owner', owner, ownerResolution.evidenceRefIds, owner ? 0.8 : 0.38);

  const executedDerivation: {
    status: DerivationStatus;
    dependency?: FactDerivationDependency;
    upstream_missing_reason?: string;
  } = executedDate
    ? { status: 'success' }
    : {
        status: 'upstream_missing',
        upstream_missing_reason:
          'executed_date was not found in structured fields, typed fields, or regex evidence.',
      };

  let termEndDerivation: {
    status: DerivationStatus;
    dependency?: FactDerivationDependency;
    upstream_missing_reason?: string;
  };
  if (termEndDate) {
    if (executedRelativeDerivation != null) {
      termEndDerivation = {
        status: 'calculated',
        dependency: {
          source_field: 'executed_date',
          anchor_inheritance: 'executed_relative_duration_clause',
        },
      };
    } else if (termDurationDerivation != null) {
      const h = termDurationDerivation.hit.anchor;
      const src: 'executed_date' | 'effective_date' | 'term_start_date' =
        h === 'executed' ? 'executed_date' : h === 'effective' ? 'effective_date' : 'term_start_date';
      termEndDerivation = {
        status: 'calculated',
        dependency: {
          source_field: src,
          anchor_inheritance: `duration_clause_anchor:${termDurationDerivation.hit.anchor}`,
        },
      };
    } else {
      termEndDerivation = { status: 'success' };
    }
  } else if (termEndUpstreamBlock != null) {
    termEndDerivation = {
      status: 'upstream_missing',
      dependency: termEndUpstreamBlock.dependency,
      upstream_missing_reason: termEndUpstreamBlock.reason,
    };
  } else if (termEndLowConfidenceParse) {
    termEndDerivation = {
      status: 'low_confidence',
      upstream_missing_reason:
        'Term duration language was detected but the anchor date could not be parsed for calendar math.',
    };
  } else {
    termEndDerivation = {
      status: 'low_confidence',
      upstream_missing_reason:
        'No term end date was extracted and no derivable term clause produced a value.',
    };
  }

  let termStartDerivation: {
    status: DerivationStatus;
    dependency?: FactDerivationDependency;
    upstream_missing_reason?: string;
  };
  if (termStartDate) {
    termStartDerivation = termStartFilledFromExecutedRelative
      ? {
          status: 'calculated',
          dependency: {
            source_field: 'executed_date',
            anchor_inheritance: 'same_as_executed_for_executed_relative_term',
          },
        }
      : termStartFilledFromEffectiveExecution
        ? {
            status: 'calculated',
            dependency: {
              source_field: 'executed_date',
              anchor_inheritance: 'effective_date_inherits_executed_date',
            },
          }
      : { status: 'success' };
  } else if (executedRelativeClauseProbe && !executedDate?.trim() && !termStartFromExtraction) {
    termStartDerivation = {
      status: 'upstream_missing',
      dependency: {
        source_field: 'executed_date',
        anchor_inheritance: 'term_start_not_inferred_without_executed_date',
      },
      upstream_missing_reason:
        'Term language references execution, but executed_date was not extracted, so term start was not inferred.',
    };
  } else {
    termStartDerivation = {
      status: 'low_confidence',
      upstream_missing_reason: 'No term start date was extracted.',
    };
  }

  let expirationDerivation: {
    status: DerivationStatus;
    dependency?: FactDerivationDependency;
    upstream_missing_reason?: string;
  };
  if (structuredExpiration) {
    expirationDerivation = { status: 'success' };
  } else if (expirationDate != null && termEndDate != null && String(expirationDate) === String(termEndDate)) {
    expirationDerivation = {
      status: termEndDerivation.status,
      dependency: { source_field: 'term_end_date', anchor_inheritance: 'mirrors_term_end_date' },
    };
  } else if (!expirationDate) {
    expirationDerivation = {
      status: 'upstream_missing',
      dependency: { source_field: 'term_end_date', anchor_inheritance: 'mirrors_term_end_date' },
      upstream_missing_reason:
        'expiration_date was not extracted and term end is unavailable, so expiration was not set.',
    };
  } else {
    expirationDerivation = { status: 'low_confidence' };
  }

  addFact(document, facts, 'executed_date', 'Executed Date', executedDate, executedDateEvidenceRefs, executedDate ? 0.78 : 0.36, {
    derivation: executedDerivation,
  });
  addFact(document, facts, 'term_start_date', 'Term Start', termStartDate, termStartDateEvidenceRefs, termStartDate ? 0.76 : 0.42, {
    derivation: termStartDerivation,
  });
  addFact(
    document,
    facts,
    'term_end_date',
    'Term End',
    termEndDate,
    termEndDateEvidenceRefs,
    termEndDate ? (termEndFromDurationDerivation ? 0.7 : 0.76) : 0.42,
    { derivation: termEndDerivation },
  );
  addFact(
    document,
    facts,
    'expiration_date',
    'Expiration Date',
    expirationDate,
    expirationEvidenceRefs,
    expirationDate
      ? (expirationEvidenceRefs.length > 0 && termEndFromDurationDerivation ? 0.7 : 0.78)
      : 0.44,
    { derivation: expirationDerivation },
  );
  const ceilingEvidenceRefs =
    ceiling_machine_classification === 'rate_price_no_ceiling'
      ? rateEvidenceRefs.slice(0, 48)
      : (selectedCeilingEvidence?.evidence.map((evidence) => evidence.id) ?? []);
  const ceilingConfidence =
    ceiling != null ? 0.86
    : ceiling_machine_classification === 'rate_price_no_ceiling' ? 0.74
    : 0.44;
  addFact(
    document,
    facts,
    'contract_ceiling',
    'Contract Ceiling',
    ceiling,
    ceilingEvidenceRefs,
    ceilingConfidence,
    ceiling_machine_classification != null ? { machine_classification: ceiling_machine_classification } : undefined,
  );
  addFact(
    document,
    facts,
    'rate_schedule_present',
    'Rate Schedule Present',
    rateSchedulePresent,
    rateEvidenceRefs,
    rateSchedulePresent ? 0.8 : 0.55,
  );
  addFact(
    document,
    facts,
    'rate_row_count',
    'Rate Rows',
    rateRowCount,
    (rateTableEvidenceRefs.length > 0 ? rateTableEvidenceRefs : rateEvidenceRefs).slice(0, 48),
    rateRowCount > 0 ? 0.76 : 0.5,
  );
  addFact(
    document,
    facts,
    'rate_schedule_pages',
    'Rate Schedule Pages',
    ratePages,
    rateEvidenceRefs.slice(0, 48),
    ratePages ? 0.74 : 0.45,
  );
  addFact(document, facts, 'time_and_materials_present', 'T&M Present', timeAndMaterialsPresent, [], timeAndMaterialsPresent ? 0.72 : 0.52);

  const extracted: Record<string, unknown> = {
    contractorName: contractor ?? undefined,
    ownerName: owner ?? undefined,
    executedDate: executedDate ?? undefined,
    notToExceedAmount: ceiling ?? undefined,
    rateSchedulePresent,
    timeAndMaterialsPresent,
  };

  if (contractDebugEnabled) {
    const extraction = asRecord(document.extraction_data?.extraction);
    const extractionDebug = asRecord(extraction?.debug_contract);
    const extractionMode =
      typeof extraction?.mode === 'string' ? extraction.mode : null;
    const pdfTextLen =
      typeof extractionDebug?.pdf_text_length === 'number'
        ? extractionDebug.pdf_text_length
        : (typeof extraction?.text_preview === 'string' ? extraction.text_preview.length : 0);
    const parsedElementsPresent =
      typeof extractionDebug?.parsed_elements_present === 'boolean'
        ? extractionDebug.parsed_elements_present
        : Boolean(asRecord(document.extraction_data?.extraction)?.parsed_elements_v1);

    const ratePresentReason =
      acceptedRateTables.length > 0
        ? 'accepted_rate_tables_present'
        : (rateFromSignals ? 'section_signals_indicate_rates' : 'no_accepted_rate_tables_or_section_signals');
    const rateRowCountReason =
      acceptedRateTables.length > 0
        ? 'sum_estimated_rows_of_qualified_rate_tables'
        : (Number(document.section_signals.rate_items_detected ?? 0) > 0
          ? 'section_signals_rate_items_detected'
          : 'no_accepted_rate_rows');

    const debug_contract = {
      source_mode: extractionDebug?.source_mode ?? extractionMode,
      pdf_text_length: pdfTextLen,
      parsed_elements_present: parsedElementsPresent,
      fallback_path_used: extractionDebug?.fallback_path_used ?? (extractionMode === 'pdf_fallback'),
      fallback_reason: extractionDebug?.fallback_reason ?? null,
      table_candidates: tableQualifications.map((t) => ({
        id: t.id,
        index: t.index,
        page: t.page,
        headers: t.headers,
        row_count: t.row_count,
        estimated_rate_row_count: t.estimated_rate_row_count,
        accepted: t.accepted,
        score: t.score,
        rejected_reasons: t.rejected_reasons,
        accepted_reasons: t.accepted_reasons,
        qualification_signals: {
          schedule_aliases_matched: t.qualification_signals.schedule_aliases_matched,
          header_aliases_matched: t.qualification_signals.header_aliases_matched,
          row_shape_consistency: t.qualification_signals.row_shape_consistency,
          inline_unit_signal_detected: t.qualification_signals.inline_unit_signal_detected,
          price_column_count: t.qualification_signals.price_column_count,
          estimated_rate_row_count: t.qualification_signals.estimated_rate_row_count,
          price_unit_description_signals: t.qualification_signals.price_unit_description_signals,
          clin_detected: t.qualification_signals.clin_detected,
          money_column_detected: t.qualification_signals.money_column_detected,
          structural_rules_passed: t.qualification_signals.structural_rules_passed,
          title_alias_matches: t.qualification_signals.title_alias_matches,
          header_signal_matches: t.qualification_signals.header_signal_matches,
          unit_pattern_matches: t.qualification_signals.unit_pattern_matches,
          term_signal_matches: t.qualification_signals.term_signal_matches,
          detected_failure_modes: t.qualification_signals.detected_failure_modes,
          decision_explanation: t.qualification_signals.decision_explanation,
        },
      })),
      best_rate_table_candidate: bestRateTableCandidate
        ? {
            id: bestRateTableCandidate.id,
            index: bestRateTableCandidate.index,
            page: bestRateTableCandidate.page,
            score: bestRateTableCandidate.score,
            row_count: bestRateTableCandidate.row_count,
            estimated_rate_row_count: bestRateTableCandidate.estimated_rate_row_count,
            accepted: bestRateTableCandidate.accepted,
            rejected_reasons: bestRateTableCandidate.rejected_reasons,
          }
        : null,
      selected_rate_table: selectedRateTable
        ? {
            id: selectedRateTable.id,
            index: selectedRateTable.index,
            page: selectedRateTable.page,
            score: selectedRateTable.score,
            row_count: selectedRateTable.row_count,
            estimated_rate_row_count: selectedRateTable.estimated_rate_row_count,
          }
        : null,
      rate_schedule_qualification: {
        rate_schedule_present: rateSchedulePresent,
        rate_schedule_present_reason: ratePresentReason,
        rate_row_count: rateRowCount,
        rate_row_count_reason: rateRowCountReason,
        rate_schedule_pages: ratePagesArray,
        inferred_weak_continuation_pages: inferredRatePages.inferred_gap_pages,
        candidate_rate_table_count: tableQualifications.length,
        accepted_rate_table_count: acceptedRateTables.length,
        schedule_aliases_matched: selectedRateTable?.qualification_signals.schedule_aliases_matched ?? [],
        header_aliases_matched: selectedRateTable?.qualification_signals.header_aliases_matched ?? null,
        row_shape_consistency: selectedRateTable?.qualification_signals.row_shape_consistency ?? null,
        inline_unit_signal_detected: selectedRateTable?.qualification_signals.inline_unit_signal_detected ?? null,
        price_column_count: selectedRateTable?.qualification_signals.price_column_count ?? null,
        estimated_rate_row_count: selectedRateTable?.qualification_signals.estimated_rate_row_count ?? null,
        price_unit_description_signals: selectedRateTable?.qualification_signals.price_unit_description_signals ?? null,
        clin_detected: selectedRateTable?.qualification_signals.clin_detected ?? null,
        money_column_detected: selectedRateTable?.qualification_signals.money_column_detected ?? null,
        structural_rules_passed: selectedRateTable?.qualification_signals.structural_rules_passed ?? [],
        title_alias_matches: selectedRateTable?.qualification_signals.title_alias_matches ?? [],
        header_signal_matches: selectedRateTable?.qualification_signals.header_signal_matches ?? [],
        unit_pattern_matches: selectedRateTable?.qualification_signals.unit_pattern_matches ?? [],
        term_signal_matches: selectedRateTable?.qualification_signals.term_signal_matches ?? [],
        decision_explanation: selectedRateTable?.qualification_signals.decision_explanation
          ?? (!selectedRateTable && bestRateTableCandidate
            ? bestRateTableCandidate.qualification_signals.decision_explanation
            : null),
        final_qualification_score: selectedRateTable?.score ?? null,
        best_candidate_rejected_reasons:
          !selectedRateTable && bestRateTableCandidate ? bestRateTableCandidate.rejected_reasons : [],
      },
      detected_failure_modes:
        selectedRateTable?.qualification_signals.detected_failure_modes
        ?? (!selectedRateTable && bestRateTableCandidate
          ? bestRateTableCandidate.qualification_signals.detected_failure_modes
          : []),
      key_field_sources: {
        contractor_name: {
          chosen: contractor,
          chosen_source: contractorResolution.chosenSource,
          ranked_candidates: contractorResolution.scoredCandidates,
          candidates: [
            {
              source: 'structured_fields.contractor_name',
              value: rawStructuredContractor.length > 0 ? rawStructuredContractor : null,
              selected:
                contractor != null
                && contractorCandidateStructured != null
                && normalizeText(contractor) === normalizeText(contractorCandidateStructured),
            },
            {
              source: 'typed_fields.vendor_name',
              value: contractorCandidateTyped ?? null,
              selected:
                contractor != null
                && contractorCandidateTyped != null
                && normalizeText(contractor) === normalizeText(String(contractorCandidateTyped)),
            },
          ],
        },
        owner_name: {
          chosen: owner,
          chosen_source: ownerResolution.chosenSource,
          ranked_candidates: ownerResolution.scoredCandidates,
          candidates: [
            {
              source: 'structured_fields.owner_name',
              value:
                typeof document.structured_fields.owner_name === 'string'
                  ? document.structured_fields.owner_name.trim()
                  : null,
              selected:
                owner != null
                && typeof document.structured_fields.owner_name === 'string'
                && normalizeText(owner) === normalizeText(document.structured_fields.owner_name),
            },
          ],
        },
        executed_date: {
          chosen: executedDate,
          chosen_source: executedDateResolution.chosenSource,
          ranked_candidates: executedDateResolution.scoredCandidates,
          candidates: [
            { source: 'structured_fields.executed_date', value: executedCandidateStructured ?? null, selected: executedDate === executedCandidateStructured },
            { source: executedDateResolution.chosenSource ?? 'evidence_or_typed', value: executedCandidateRegex ?? null, selected: executedDate === executedCandidateRegex },
            { source: 'typed_fields.effective_date', value: executedCandidateTypedEffective ?? null, selected: executedDate === executedCandidateTypedEffective },
            { source: 'typed_fields.contract_date', value: executedCandidateTypedContract ?? null, selected: executedDate === executedCandidateTypedContract },
          ],
        },
        term: {
          term_start: termStartDate,
          term_end: termEndDate,
          expiration_date: expirationDate,
          term_start_source: termStartDate === termStartCandidateStructured ? 'structured_fields.term_start_date'
            : termStartDate === termStartCandidateRegex ? 'regex.evidence'
            : termStartFilledFromExecutedRelative ? 'derived.same_as_executed_for_executed_relative_term'
            : termStartFilledFromEffectiveExecution ? 'derived.same_as_executed_for_effective_date_clause'
            : null,
          effective_date_inherits_executed: effectiveDateInheritedFromExecuted,
          effective_date_inherits_executed_evidence_ids: effectiveDateInheritedFromExecutedEvidenceRefs,
          executed_relative_clause_probe: (() => {
            const haystack = termDerivationHaystack;
            const hit = executedRelativeClauseProbe;
            return {
              haystack_char_count: haystack.length,
              evidence_blob_char_count: document.evidence.reduce(
                (sum, ev) => sum + evidenceText(ev).trim().length,
                0,
              ),
              pdf_layer_plain_char_count: joinPdfPlainTextFromContentLayers(document.content_layers).length,
              legacy_page_text_char_count: joinLegacyEvidencePageText(document.extraction_data).length,
              text_preview_char_count: document.text_preview.trim().length,
              duration_match: hit
                ? {
                    days: hit.days,
                    clause_sample: hit.clauseSample,
                  }
                : null,
              anchor_executed_date: executedDate,
              computed_end_if_matched: (() => {
                if (!hit || !executedDate) return null;
                const base = parseContractAnchorDate(executedDate);
                if (!base) return null;
                return formatLocalIsoDate(addCalendarTermDuration(base, hit.days, 'day'));
              })(),
            };
          })(),
          term_end_source: termEndDate === termEndCandidateStructured ? 'structured_fields.term_end_date'
            : termEndDate === termEndCandidateRegex ? 'regex.evidence'
            : executedRelativeDerivation != null ? 'derived.executed_date_plus_duration_clause'
            : termDurationDerivation != null ? 'derived.duration_from_anchor_clause'
            : null,
          term_end_duration_derivation:
            executedRelativeDerivation != null
              ? {
                  derivation: 'executed_relative_duration_clause',
                  anchor_basis_kind: 'executed_date',
                  amount: executedRelativeDerivation.durationDays,
                  unit: 'day',
                  clause_sample: executedRelativeDerivation.clauseSample,
                  derived_end_iso: executedRelativeDerivation.endDateIso,
                  evidence_ids: executedRelativeDerivation.evidenceIds,
                }
              : termDurationDerivation != null
                ? {
                    derivation: 'anchor_clause',
                    anchor_basis_kind: termDurationDerivation.hit.anchor,
                    amount: termDurationDerivation.hit.amount,
                    unit: termDurationDerivation.hit.unit,
                    effective_date_inherits_executed: effectiveDateInheritedFromExecuted && termDurationDerivation.hit.anchor === 'effective',
                    clause_sample: termDurationDerivation.hit.clauseSample,
                    derived_end_iso: termDurationDerivation.endDateIso,
                    evidence_ids: termDurationDerivation.evidenceIds,
                  }
                : null,
        },
        nte_amount: {
          chosen: ceiling,
          ceiling_machine_classification,
          chosen_source:
            selectedCeilingEvidence?.value != null ? 'regex.evidence'
              : document.typed_fields.nte_amount != null ? 'typed_fields.nte_amount'
              : document.typed_fields.notToExceedAmount != null ? 'typed_fields.notToExceedAmount'
              : document.structured_fields.nte_amount != null ? 'structured_fields.nte_amount'
              : null,
          candidates: {
            regex: selectedCeilingEvidence?.value ?? null,
            typed_nte_amount: document.typed_fields.nte_amount ?? null,
            typed_notToExceedAmount: document.typed_fields.notToExceedAmount ?? null,
            structured_nte_amount: document.structured_fields.nte_amount ?? null,
          },
        },
      },
    };

    extracted.debug_contract = debug_contract;
    console.log('[contract-debug]', {
      document_id: document.document_id,
      document_name: document.document_name,
      debug_contract,
    });
  }

  return {
    facts,
    extracted,
  };
}

function normalizeInvoice(document: ExtractedNodeDocument): { facts: PipelineFact[]; extracted: Record<string, unknown> } {
  const facts: PipelineFact[] = [];
  const pdf = asRecord(document.content_layers?.pdf);
  const pdfTables = asArray<Record<string, unknown>>(asRecord(pdf?.tables)?.tables);
  const invoiceEvidence = findEvidenceByLabel(document, ['invoice', 'invoice #', 'invoice number']);
  const amountEvidence = findEvidenceByRegex(document, [
    /(?:current\s+amount\s+due|current\s+payment\s+due|total\s+amount|amount\s+due)[^$0-9]{0,24}\$?\s*([\d,]+(?:\.\d{1,2})?)/i,
  ]);
  const contractorEvidence = findEvidenceByLabel(document, ['vendor', 'contractor', 'payee']);
  const dateEvidence = findEvidenceByRegex(document, [
    /(?:invoice\s+date|date)[^0-9A-Za-z]{0,24}(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/i,
  ]);

  const invoiceNumber = String(
    document.typed_fields.invoice_number ??
    invoiceEvidence[0]?.value ??
    invoiceEvidence[0]?.text ??
    '',
  ).trim() || null;
  const billedAmount = parseNumber(
    document.typed_fields.current_amount_due ??
    document.typed_fields.currentPaymentDue ??
    document.typed_fields.total_amount ??
    amountEvidence?.value ??
    null,
  );
  const contractor = String(
    document.typed_fields.vendor_name ??
    document.typed_fields.contractorName ??
    contractorEvidence[0]?.value ??
    contractorEvidence[0]?.text ??
    '',
  ).trim() || null;
  const invoiceDate = String(
    document.typed_fields.invoice_date ??
    dateEvidence?.value ??
    '',
  ).trim() || null;
  const lineItems = asArray<unknown>(document.typed_fields.line_items);
  const tableRows = pdfTables
    .reduce((sum, table) => sum + asArray<unknown>(table.rows).length, 0);
  const lineItemCount = lineItems.length > 0 ? lineItems.length : tableRows;
  const lineItemSupportPresent = lineItemCount > 0;
  const lineItemEvidenceIds = document.evidence
    .filter((item) => item.kind === 'table_row')
    .slice(0, 24)
    .map((item) => item.id);

  addFact(document, facts, 'invoice_number', 'Invoice Number', invoiceNumber, invoiceEvidence.map((evidence) => evidence.id), invoiceNumber ? 0.86 : 0.42);
  addFact(document, facts, 'billed_amount', 'Billed Amount', billedAmount, amountEvidence?.evidence.map((evidence) => evidence.id) ?? [], billedAmount != null ? 0.88 : 0.4);
  addFact(document, facts, 'contractor_name', 'Contractor', contractor, contractorEvidence.map((evidence) => evidence.id), contractor ? 0.82 : 0.39);
  addFact(document, facts, 'invoice_date', 'Invoice Date', invoiceDate, dateEvidence?.evidence.map((evidence) => evidence.id) ?? [], invoiceDate ? 0.76 : 0.37);
  addFact(
    document,
    facts,
    'line_item_support_present',
    'Line Item Support Present',
    lineItemSupportPresent,
    lineItemEvidenceIds,
    lineItemSupportPresent ? 0.78 : 0.5,
  );
  addFact(
    document,
    facts,
    'line_item_count',
    'Line Item Count',
    lineItemCount,
    lineItemEvidenceIds.slice(0, 8),
    lineItemCount > 0 ? 0.74 : 0.48,
  );

  return {
    facts,
    extracted: {
      invoiceNumber: invoiceNumber ?? undefined,
      contractorName: contractor ?? undefined,
      currentPaymentDue: billedAmount ?? undefined,
      invoiceDate: invoiceDate ?? undefined,
      lineItemCodes: lineItemCount > 0 ? [`${lineItemCount} supported line items`] : undefined,
    },
  };
}

function normalizePaymentRecommendation(document: ExtractedNodeDocument): { facts: PipelineFact[]; extracted: Record<string, unknown> } {
  const facts: PipelineFact[] = [];
  const amountEvidence = findEvidenceByRegex(document, [
    /(?:amount\s+recommended\s+for\s+payment|approved\s+amount|net\s+recommended)[^$0-9]{0,24}\$?\s*([\d,]+(?:\.\d{1,2})?)/i,
  ]);
  const invoiceRefEvidence = findEvidenceByLabel(document, ['invoice', 'invoice #', 'invoice reference']);
  const contractorEvidence = findEvidenceByLabel(document, ['contractor', 'applicant', 'vendor']);
  const dateEvidence = findEvidenceByRegex(document, [
    /(?:recommendation\s+date|date\s+of\s+invoice|date)[^0-9A-Za-z]{0,24}(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/i,
  ]);

  const approvedAmount = parseNumber(
    document.typed_fields.approved_amount ??
    document.typed_fields.amountRecommendedForPayment ??
    document.typed_fields.net_recommended_amount ??
    amountEvidence?.value ??
    null,
  );
  const invoiceReference = String(
    document.typed_fields.invoice_number ??
    document.typed_fields.report_reference ??
    invoiceRefEvidence[0]?.value ??
    invoiceRefEvidence[0]?.text ??
    '',
  ).trim() || null;
  const contractor = String(
    document.typed_fields.contractor ??
    document.typed_fields.vendor_name ??
    contractorEvidence[0]?.value ??
    contractorEvidence[0]?.text ??
    '',
  ).trim() || null;
  const recommendationDate = String(
    document.typed_fields.recommendationDate ??
    document.typed_fields.date_of_invoice ??
    dateEvidence?.value ??
    '',
  ).trim() || null;

  addFact(document, facts, 'approved_amount', 'Approved Amount', approvedAmount, amountEvidence?.evidence.map((evidence) => evidence.id) ?? [], approvedAmount != null ? 0.87 : 0.4);
  addFact(document, facts, 'invoice_reference', 'Invoice Reference', invoiceReference, invoiceRefEvidence.map((evidence) => evidence.id), invoiceReference ? 0.82 : 0.41);
  addFact(document, facts, 'contractor_name', 'Contractor', contractor, contractorEvidence.map((evidence) => evidence.id), contractor ? 0.8 : 0.39);
  addFact(document, facts, 'recommendation_date', 'Recommendation Date', recommendationDate, dateEvidence?.evidence.map((evidence) => evidence.id) ?? [], recommendationDate ? 0.76 : 0.38);

  return {
    facts,
    extracted: {
      invoiceNumber: invoiceReference ?? undefined,
      approvedAmount: approvedAmount ?? undefined,
      contractorName: contractor ?? undefined,
      recommendationDate: recommendationDate ?? undefined,
    },
  };
}

function spreadsheetEvidenceRefFallback(document: ExtractedNodeDocument): string[] {
  return document.evidence
    .filter((item) => item.kind === 'sheet' || item.kind === 'sheet_row' || item.kind === 'sheet_cell')
    .map((item) => item.id)
    .slice(0, 64);
}

function collectTicketRowEvidenceRefs(rows: Record<string, unknown>[], cap = 72): string[] {
  const refs = new Set<string>();
  for (const row of rows) {
    if (typeof row.evidence_ref === 'string') refs.add(row.evidence_ref);
    const fieldIds = row.field_evidence_ids;
    if (fieldIds != null && typeof fieldIds === 'object' && !Array.isArray(fieldIds)) {
      for (const value of Object.values(fieldIds as Record<string, unknown>)) {
        if (typeof value === 'string') refs.add(value);
      }
    }
    if (refs.size >= cap) break;
  }
  return [...refs];
}

function firstTicketRowMissing(rows: Record<string, unknown>[], field: 'quantity' | 'rate'): Record<string, unknown> | null {
  return (
    rows.find((row) => {
      const missing = row.missing_fields;
      return Array.isArray(missing) && missing.includes(field);
    }) ?? null
  );
}

function ticketRowFieldRefs(row: Record<string, unknown> | null, field: 'quantity' | 'rate'): string[] {
  if (!row) return [];
  const out: string[] = [];
  const fieldIds = row.field_evidence_ids;
  if (fieldIds != null && typeof fieldIds === 'object' && !Array.isArray(fieldIds)) {
    const cellId = (fieldIds as Record<string, unknown>)[field];
    if (typeof cellId === 'string') out.push(cellId);
  }
  if (typeof row.evidence_ref === 'string') out.push(row.evidence_ref);
  return [...new Set(out)];
}

function normalizeTicket(document: ExtractedNodeDocument): { facts: PipelineFact[]; extracted: Record<string, unknown> } {
  const facts: PipelineFact[] = [];
  const spreadsheet = asRecord(document.content_layers?.spreadsheet);
  const ticketExport = asRecord(spreadsheet?.normalized_ticket_export);
  const summary = asRecord(ticketExport?.summary);
  const rows = asArray<Record<string, unknown>>(ticketExport?.rows);
  const rowCount = Number(summary?.row_count ?? rows.length ?? 0);
  const missingQuantityRows = Number(summary?.missing_quantity_rows ?? 0);
  const missingRateRows = Number(summary?.missing_rate_rows ?? 0);
  const invoiceRefs = [...new Set(rows.map((row) => row.invoice_number).filter((value): value is string => typeof value === 'string' && value.trim().length > 0))];

  const fromRows = collectTicketRowEvidenceRefs(rows);
  const fallbackRefs = spreadsheetEvidenceRefFallback(document);
  const workbookRefs = fromRows.length > 0 ? fromRows : fallbackRefs;
  const qtyRow = firstTicketRowMissing(rows, 'quantity');
  const rateRow = firstTicketRowMissing(rows, 'rate');
  const qtyRefs = ticketRowFieldRefs(qtyRow, 'quantity');
  const rateRefs = ticketRowFieldRefs(rateRow, 'rate');

  addFact(
    document,
    facts,
    'ticket_row_count',
    'Ticket Rows',
    rowCount,
    workbookRefs,
    rowCount > 0 ? 0.86 : 0.42,
  );
  addFact(
    document,
    facts,
    'missing_quantity_rows',
    'Missing Quantity Rows',
    missingQuantityRows,
    qtyRefs.length > 0 ? qtyRefs : workbookRefs.slice(0, 12),
    0.78,
  );
  addFact(
    document,
    facts,
    'missing_rate_rows',
    'Missing Rate Rows',
    missingRateRows,
    rateRefs.length > 0 ? rateRefs : workbookRefs.slice(0, 12),
    0.78,
  );
  addFact(
    document,
    facts,
    'ticket_rows',
    'Ticket Rows Detail',
    rows,
    workbookRefs,
    rowCount > 0 ? 0.82 : 0.38,
  );
  addFact(document, facts, 'invoice_references', 'Invoice References', invoiceRefs, [], invoiceRefs.length > 0 ? 0.74 : 0.4);

  return {
    facts,
    extracted: {
      rowCount,
      missingQuantityRows,
      missingRateRows,
      invoiceReferences: invoiceRefs.length > 0 ? invoiceRefs : undefined,
    },
  };
}

function normalizeSpreadsheet(document: ExtractedNodeDocument): { facts: PipelineFact[]; extracted: Record<string, unknown> } {
  const facts: PipelineFact[] = [];
  const spreadsheet = asRecord(document.content_layers?.spreadsheet);
  const workbook = asRecord(spreadsheet?.workbook);
  const sheets = asArray<Record<string, unknown>>(workbook?.sheets);
  addFact(document, facts, 'sheet_count', 'Sheet Count', workbook?.sheet_count ?? sheets.length, [], 0.74);
  addFact(document, facts, 'sheet_names', 'Sheet Names', sheets.map((sheet) => sheet.name), [], 0.74);
  return {
    facts,
    extracted: {
      sheetCount: workbook?.sheet_count ?? sheets.length,
      sheetNames: sheets.map((sheet) => sheet.name),
    },
  };
}

function normalizeDocument(document: ExtractedNodeDocument): { facts: PipelineFact[]; extracted: Record<string, unknown> } {
  switch (document.family) {
    case 'contract':
      return normalizeContract(document);
    case 'invoice':
      return normalizeInvoice(document);
    case 'payment_recommendation':
      return normalizePaymentRecommendation(document);
    case 'ticket':
      return normalizeTicket(document);
    case 'spreadsheet':
      return normalizeSpreadsheet(document);
    default:
      return { facts: [], extracted: document.extracted_record };
  }
}

function factMap(facts: PipelineFact[]): Record<string, PipelineFact> {
  return Object.fromEntries(facts.map((fact) => [fact.key, fact]));
}

export function normalizeNode(input: ExtractNodeOutput): NormalizeNodeOutput {
  const primaryNormalized = normalizeDocument(input.primaryDocument);
  attachCanonicalPersistenceMetadata(
    input.primaryDocument,
    primaryNormalized.facts,
    primaryNormalized.extracted,
  );
  const primaryDocument = {
    ...input.primaryDocument,
    facts: primaryNormalized.facts,
    fact_map: factMap(primaryNormalized.facts),
  };
  const relatedDocuments = input.relatedDocuments.map((document) => {
    const normalized = normalizeDocument(document);
    attachCanonicalPersistenceMetadata(document, normalized.facts, normalized.extracted);
    return {
      ...document,
      facts: normalized.facts,
      fact_map: factMap(normalized.facts),
    };
  });

  const facts = Object.fromEntries(
    primaryDocument.facts.map((fact) => [fact.key, fact.value]),
  );

  const mergedGaps = [
    ...input.gaps,
    ...factCitationGaps(primaryDocument, primaryDocument.facts),
    ...relatedDocuments.flatMap((doc) => factCitationGaps(doc, doc.facts)),
    ...ticketRowFieldGaps(primaryDocument),
    ...relatedDocuments.flatMap(ticketRowFieldGaps),
  ];

  return {
    primaryDocument,
    relatedDocuments,
    evidence: input.evidence,
    gaps: mergedGaps,
    confidence: input.confidence,
    facts,
    extracted: primaryNormalized.extracted,
  };
}

export const __test__ = {
  labelMatchesCandidate,
  findEvidenceByLabel,
};
