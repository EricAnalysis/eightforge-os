import type { TableCellGeometry } from '@/lib/extraction/tableGeometry';

export type OperationalTableFragment = {
  cell_text: string;
  cell_index: number;
  row_index: number;
  table_key: string;
  page_number: number;
  bounding_box?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  source?: 'pdfjs' | 'ocr_fallback' | 'vision';
  geometry?: TableCellGeometry;
  extractor_hint?: string;
  candidate_value?: unknown;
  confidence?: number;
};

export type OperationalTableRowRole =
  | 'line_item'
  | 'subtotal'
  | 'header'
  | 'continuation'
  | 'blank'
  | 'unclassified'
  | 'unit_rate_definition'
  | 'passthrough_rate'
  | 'hourly_tm_rate'
  | 'mileage_tier_rate'
  | 'lump_sum_rate'
  | 'section_header'
  | 'category_header'
  | 'explanatory_clause'
  | 'pricing_modifier';

export type AssemblySemanticMode =
  | 'transactional'
  | 'schedule_definition'
  | 'unknown';

export type TableSemanticHints = {
  schedule_kind?: string | null;
  table_key?: string | null;
};

export type OperationalTableRowConfidence = 1.0 | 0.85 | 0.70 | 0.50 | 0.30;

export type OperationalTableRowEvidenceRef = {
  document_id: string;
  page_number: number;
  table_key: string;
  row_index: number;
  cell_index?: number;
  geometry?: TableCellGeometry;
  raw_text: string;
  field_assigned: keyof CanonicalOperationalTableRow;
  confidence: number;
};

export type CanonicalOperationalTableRow = {
  row_id: string;
  canonical_row_signature?: string;
  document_id: string;
  source_family?: string;
  source_table_key: string;
  source_document_family: string;
  assembly_semantic_mode: AssemblySemanticMode;
  row_role: OperationalTableRowRole;
  category?: string;
  rate_code?: string;
  description?: string;
  quantity?: number;
  unit?: string;
  unit_price?: number;
  line_total?: number;
  material?: string;
  service_item?: string;
  mileage_tier?: string;
  site_type?: string;
  effective_date?: string;
  notes?: string;
  warnings: string[];
  confidence: number;
  evidence_refs: OperationalTableRowEvidenceRef[];
  raw_fragments: OperationalTableFragment[];
  confidence_penalties?: string[];
  ocr_normalization_actions?: string[];
  ambiguity_flags?: string[];
  raw_candidate_values?: string[];
};

export type CanonicalOperationalTableRowAssemblyResult = {
  rows: CanonicalOperationalTableRow[];
  rejected_rows: CanonicalOperationalTableRow[];
  unclassified_rows: CanonicalOperationalTableRow[];
  assembly_warnings: string[];
  document_id: string;
  source_family: string;
};

export type AssembleCanonicalOperationalTableRowsInput = {
  document_id: string;
  source_family: string;
  fragments: readonly OperationalTableFragment[];
};

type FragmentGroup = {
  table_key: string;
  row_index: number;
  page_number: number;
  fragments: OperationalTableFragment[];
  text: string;
  role: OperationalTableRowRole;
};

type FieldConfidence = {
  value: unknown;
  confidence: OperationalTableRowConfidence;
  fragments: OperationalTableFragment[];
};

type ScheduleRateGovernance = {
  ambiguous: boolean;
  warnings: string[];
  rawCandidates: string[];
};

const UNIT_VOCAB = new Set([
  'ROW',
  'LH',
  'CYD',
  'CY',
  'EA',
  'EACH',
  'LS',
  'LSUM',
  'TON',
  'MO',
  'MONTH',
  'DAY',
  'DY',
  'HR',
  'HRS',
  'HOUR',
  'LF',
  'SF',
  'TREE',
  'TREES',
  'POUND/UNIT',
]);

const CONTRACT_UNIT_VOCAB = new Set([
  ...UNIT_VOCAB,
  'STUMP',
  'POUND',
  'UNIT',
]);

const HEADER_TERMS = [
  'category',
  'description',
  'type',
  'quantity',
  'qty',
  'rate',
  'unit price',
  'line total',
  'amount',
  'rate code',
  'item',
  'unit',
];

const SUBTOTAL_TERMS = [
  'subtotal',
  'sub total',
  'total',
  'grand total',
  'amount due',
  'current amount due',
];

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function normalizeSignaturePart(value: unknown): string {
  if (value == null) return '';
  return String(value).toLowerCase().replace(/[^a-z0-9.]+/g, ' ').trim();
}

function parseNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return null;
  const match = value.replace(/\((.+)\)/, '-$1').match(/-?\$?\s*[\d,]+(?:\.\d+)?/);
  if (!match) return null;
  const parsed = Number(match[0].replace(/[$,\s]/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function isPlainNumericCell(value: string): boolean {
  return /^\s*\$?\s*-?[\d,]+(?:\.\d+)?\s*$/.test(value.trim());
}

function amountTokens(value: string): Array<{ value: number; raw: string }> {
  const out: Array<{ value: number; raw: string }> = [];
  const re = /\$?\s*[\d,]+(?:\.\d{1,2})?/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(value)) !== null) {
    const raw = match[0] ?? '';
    const parsed = parseNumber(raw);
    if (parsed != null) out.push({ value: parsed, raw });
  }
  return out;
}

function currencyTokens(value: string): Array<{ value: number; raw: string }> {
  const out: Array<{ value: number; raw: string }> = [];
  const re = /[$§]\s*[\d,]+(?:\.\d{1,2})?/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(value)) !== null) {
    const raw = match[0] ?? '';
    const parsed = parseNumber(raw.replace('§', '$'));
    if (parsed != null) out.push({ value: parsed, raw });
  }
  return out;
}

function isOcrFragment(fragment: OperationalTableFragment): boolean {
  return fragment.source === 'ocr_fallback';
}

function scheduleRateGovernance(fragments: readonly OperationalTableFragment[]): ScheduleRateGovernance {
  const rateFragments = fragments.filter((fragment) => fragment.extractor_hint === 'unit_price');
  const rawCandidates = rateFragments.flatMap((fragment) => currencyTokens(fragment.cell_text).map((token) => token.raw));
  const warnings: string[] = [];
  const rateText = normalizeWhitespace(rateFragments.map((fragment) => fragment.cell_text).join(' '));
  const mileageRateCandidates = rateFragments.some((fragment) =>
    /\b\d{1,3}\s*\+\b/.test(fragment.cell_text)
    && parseNumber(fragment.cell_text) != null);
  const ambiguous = rawCandidates.length > 1 || mileageRateCandidates;
  if (ambiguous) {
    warnings.push('multiple candidate rates detected');
    warnings.push('ambiguous OCR rate cell');
  }
  if (mileageRateCandidates) {
    warnings.push('mileage tier value cannot be promoted as unit rate');
  }
  return {
    ambiguous,
    warnings,
    rawCandidates: mileageRateCandidates && !rawCandidates.length ? [rateText] : rawCandidates,
  };
}

function normalizeCollapsedOcrCurrency(params: {
  fragment: OperationalTableFragment;
  fullText: string;
  amount: { value: number; raw: string };
}): { value: number; warning: string; action: string } | null {
  if (!isOcrFragment(params.fragment)) return null;
  const raw = params.amount.raw.trim();
  if (!/^[$§]\s*\d{3}$/.test(raw)) return null;
  if (params.amount.value < 100 || params.amount.value > 999) return null;
  const hasScheduleContext =
    unitFromText(params.fullText, 'schedule_definition') != null ||
    /\b(?:rate|yard|debris|haul|disposal|burning|chipping|grinding|collect|remove)\b/i.test(params.fullText);
  if (!hasScheduleContext) return null;
  return {
    value: Number((params.amount.value / 100).toFixed(2)),
    warning: 'ocr currency normalization applied',
    action: `${raw} -> ${(params.amount.value / 100).toFixed(2)}`,
  };
}

function hasSevereOcrCorruption(value: string): boolean {
  const compactedFlow = /\b(?:Milesfrom|ROWtoDMS|ROW10|DMStoFDS|ROWt6|DMSt6)\b/i.test(value);
  const mojibake = /Â|Ã|�/.test(value);
  const alphaNumericNoise = /\b(?!ROW10\b|ROWt6\b)[A-Z]{2,}\d+[A-Z0-9]*\b|\b\d+[A-Z]{2,}\b/i.test(value);
  const repeatedSymbolNoise = /[$Â§]\s*\d+(?:\.\d+)?\s*[/|]\s*\d+\+/.test(value);
  return [compactedFlow, mojibake, alphaNumericNoise, repeatedSymbolNoise].filter(Boolean).length >= 2;
}

function rateSelectionUnsafe(params: {
  fullText: string;
  unitPriceValue: number | null;
  unitPriceFragment: OperationalTableFragment | undefined;
  unitValue: string | null;
  hasExplicitRateEvidence: boolean;
  hasClearUnitFamily: boolean;
  hasDescriptionFlow: boolean;
  hasEvidenceRefs: boolean;
  scheduleMode: boolean;
}): string[] {
  if (!params.scheduleMode || params.unitPriceValue == null) return [];
  const warnings: string[] = [];
  const rateText = params.unitPriceFragment?.cell_text ?? '';
  const rateCurrencies = currencyTokens(rateText);
  const allCurrencies = currencyTokens(params.fullText);
  const selected = params.unitPriceValue;
  const selectedLooksLikePlusMileage =
    new RegExp(`\\b${String(Math.trunc(selected)).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\+\\b`).test(rateText)
    || (
      rateCurrencies.length === 0
      && new RegExp(`\\b${String(Math.trunc(selected)).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\+\\b`).test(params.fullText)
      && !Number.isInteger(selected * 100)
    );
  const conflictingLowerCurrency = allCurrencies.some((token) =>
    token.value > 0
    && token.value < selected
    && Math.abs(token.value - selected) > 1);
  const ambiguousSource =
    rateCurrencies.length > 1
    || (
      rateCurrencies.length === 0
      && amountTokens(rateText).length > 1
    )
    || /\b\d{1,3}\s*\+\b/.test(rateText);
  const weakMissingUnit = !params.unitValue && (!params.hasExplicitRateEvidence || !params.hasClearUnitFamily);
  const severeOcr = hasSevereOcrCorruption(params.fullText);

  if (selectedLooksLikePlusMileage) warnings.push('selected rate appears to be a mileage tier value');
  if (conflictingLowerCurrency) warnings.push('conflicting lower currency value present in evidence');
  if (ambiguousSource) warnings.push('rate candidate source is ambiguous');
  if (weakMissingUnit) warnings.push('unit missing with weak rate source');
  if (severeOcr) warnings.push('severe OCR corruption detected');
  if (!params.hasEvidenceRefs) warnings.push('rate evidence reference missing');

  const safeRecovery =
    params.hasExplicitRateEvidence
    && params.hasClearUnitFamily
    && params.hasDescriptionFlow
    && params.hasEvidenceRefs
    && !ambiguousSource
    && !selectedLooksLikePlusMileage
    && !conflictingLowerCurrency
    && !severeOcr;

  return safeRecovery ? [] : warnings;
}

function nearlyEqualMoney(left: number, right: number): boolean {
  return Math.abs(left - right) <= Math.max(0.02, Math.abs(right) * 0.002);
}

function hasLetters(value: string): boolean {
  return /[A-Za-z]/.test(value);
}

function dense(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

export function resolveSemanticMode(
  source_family: string,
  hints?: TableSemanticHints,
): AssemblySemanticMode {
  void hints;
  const normalized = source_family.toLowerCase();
  if (normalized === 'invoice') return 'transactional';
  if (normalized === 'contract' || normalized === 'price_sheet') return 'schedule_definition';
  return 'unknown';
}

function normalizeUnit(
  value: string | null | undefined,
  mode: AssemblySemanticMode = 'transactional',
  options?: { explicitCell?: boolean },
): string | null {
  if (!value) return null;
  if (/^\s*pound\s*\/\s*unit\s*$/i.test(value)) return 'Pound/Unit';
  if (mode === 'schedule_definition') {
    if (/^\s*(?:per\s+)?cubic\s+yards?\s*$/i.test(value)) return 'CY';
    if (/^\s*(?:per\s+)?hours?\s*$/i.test(value)) return 'Hour';
    if (/^\s*hrs?\s*$/i.test(value)) return 'Hour';
    if (/^\s*trees?\s*$/i.test(value)) return 'Tree';
    if (/^\s*stumps?\s*$/i.test(value)) return 'Stump';
    if (/^\s*pounds?\s*$/i.test(value)) return 'Pound';
    if (/^\s*units?\s*$/i.test(value)) return 'Unit';
    if (/^\s*tons?\s*$/i.test(value)) return 'Ton';
  }
  const compact = value.toUpperCase().replace(/[^A-Z]/g, '');
  const normalized = compact;
  if (!normalized) return null;
  if (['CUBICYARD', 'CUBICYARDS', 'CYD', 'CY'].includes(normalized)) return 'CY';
  if (['HOUR', 'HOURS', 'HR', 'HRS'].includes(normalized)) return mode === 'schedule_definition' ? 'Hour' : 'HOUR';
  if (['EACH', 'EA'].includes(normalized)) return 'EA';
  if (['TREE', 'TREES'].includes(normalized)) return mode === 'schedule_definition' ? 'Tree' : 'TREE';
  if (normalized === 'STUMP') return mode === 'schedule_definition' ? 'Stump' : null;
  if (normalized === 'POUND') return mode === 'schedule_definition' ? 'Pound' : null;
  if (normalized === 'UNIT') return mode === 'schedule_definition' ? 'Unit' : null;
  if (normalized === 'TON') return mode === 'schedule_definition' ? 'Ton' : 'TON';
  if (normalized === 'MONTH') return mode === 'schedule_definition' ? 'MONTH' : 'MONTH';
  if (normalized === 'ROW' && mode === 'schedule_definition' && !options?.explicitCell) return null;
  const vocab = mode === 'schedule_definition' ? CONTRACT_UNIT_VOCAB : UNIT_VOCAB;
  return vocab.has(normalized) ? normalized : null;
}

function unitFromText(value: string, mode: AssemblySemanticMode = 'transactional'): string | null {
  if (/\bpound\s*\/\s*unit\b/i.test(value)) return 'Pound/Unit';
  if (mode === 'schedule_definition' && /\bcubic\b[^A-Za-z0-9]{0,16}\byards?\b/i.test(value)) return 'CY';
  if (mode === 'schedule_definition' && /c[uy]b[il1]c?[^A-Za-z0-9]{0,16}yards?/i.test(value)) return 'CY';
  const vocab = mode === 'schedule_definition'
    ? Array.from(CONTRACT_UNIT_VOCAB).filter((unit) => unit !== 'ROW')
    : Array.from(UNIT_VOCAB);
  const unitPattern = vocab
    .filter((unit) => !unit.includes('/'))
    .concat(['Cubic\\s+Yards?', 'per\\s+Cubic\\s+Yards?', 'Hours?', 'per\\s+Hours?', 'Trees?', 'Stumps?', 'Pounds?', 'Units?'])
    .sort((left, right) => right.length - left.length)
    .join('|');
  const match = value.match(new RegExp(`\\b(${unitPattern})\\b`, 'i'));
  return normalizeUnit(match?.[1] ?? null, mode);
}

function codeLike(value: string | null | undefined): string | null {
  if (!value) return null;
  const cleaned = normalizeWhitespace(value)
    .replace(/[.:)-]+$/g, '')
    .replace(/\s*-\s*$/g, '')
    .trim();
  const match = cleaned.match(/^\s*(\d{1,4}[A-Z]{1,4}|[A-Z]{1,4}-\d{1,4}|[A-Z]{1,3}\d{1,4})\s*$/i);
  return match ? cleaned.toUpperCase() : null;
}

function leadingCode(value: string): { rate_code: string; rest: string } | null {
  const match = normalizeWhitespace(value).match(/^\s*(\d{1,4}[A-Z]{1,4}|[A-Z]{1,4}-\d{1,4}|[A-Z]{1,3}\d{1,4})\s*(?:[-:.)]\s*)?(.*)$/i);
  const rateCode = codeLike(match?.[1]);
  if (!match || !rateCode) return null;
  return { rate_code: rateCode, rest: normalizeWhitespace(match[2] ?? '') };
}

function containsCandidateText(fragment: OperationalTableFragment, candidate: unknown): boolean {
  if (candidate == null) return false;
  const cell = dense(fragment.cell_text);
  const cand = dense(String(candidate));
  if (!cand) return false;
  if (cell.includes(cand)) return true;
  const parsedCandidate = parseNumber(candidate);
  const parsedCell = parseNumber(fragment.cell_text);
  return parsedCandidate != null && parsedCell != null && nearlyEqualMoney(parsedCandidate, parsedCell);
}

function collapseDuplicateFragments(
  fragments: readonly OperationalTableFragment[],
): OperationalTableFragment[] {
  const seen = new Set<string>();
  const out: OperationalTableFragment[] = [];
  for (const fragment of fragments) {
    const key = [
      fragment.table_key,
      fragment.page_number,
      fragment.row_index,
      fragment.cell_index,
      normalizeWhitespace(fragment.cell_text).toLowerCase(),
    ].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...fragment });
  }
  return out.sort((left, right) =>
    left.page_number - right.page_number
    || left.table_key.localeCompare(right.table_key)
    || left.row_index - right.row_index
    || left.cell_index - right.cell_index);
}

function groupFragments(
  fragments: readonly OperationalTableFragment[],
  mode: AssemblySemanticMode,
): FragmentGroup[] {
  const map = new Map<string, OperationalTableFragment[]>();
  for (const fragment of collapseDuplicateFragments(fragments)) {
    const key = `${fragment.table_key}|${fragment.page_number}|${fragment.row_index}`;
    const current = map.get(key) ?? [];
    current.push(fragment);
    map.set(key, current);
  }

  return [...map.values()].map((group) => {
    const ordered = [...group].sort((left, right) => left.cell_index - right.cell_index);
    const text = normalizeWhitespace(ordered.map((fragment) => fragment.cell_text).join(' '));
    return {
      table_key: ordered[0]?.table_key ?? 'table',
      row_index: ordered[0]?.row_index ?? 0,
      page_number: ordered[0]?.page_number ?? 1,
      fragments: ordered,
      text,
      role: classifyRowRole(ordered, mode),
    };
  }).sort((left, right) =>
    left.page_number - right.page_number
    || left.table_key.localeCompare(right.table_key)
    || left.row_index - right.row_index);
}

function hintedText(
  fragments: readonly OperationalTableFragment[],
  hint: string,
): string | null {
  const text = normalizeWhitespace(
    fragments
      .filter((fragment) => fragment.extractor_hint === hint)
      .map((fragment) => fragment.cell_text)
      .join(' '),
  );
  return text || null;
}

function hasNumericRate(value: string): boolean {
  return /\$?\s*[\d,]+(?:\.\d{1,4})?(?:\s*\/\s*(?:hr|hour|unit))?/i.test(value);
}

function semanticMileageTierFromText(value: string): string | null {
  if (/\b(?:single\s+cost|any\s+distance|lump\s+sum)\b/i.test(value)) return 'any';
  const normalized = value.replace(/([A-Za-z])(\d)/g, '$1 $2').replace(/(\d)([A-Za-z])/g, '$1 $2');
  const explicitMiles = normalized.match(/\b(\d{1,3})\s*(?:-|–|—|â€“|â€”|to)\s*(\d{1,3})\s*(?:mi|mile|miles)\b/i);
  if (explicitMiles) return `${explicitMiles[1]}-${explicitMiles[2]}`;
  const hasFlowContext = /\b(?:ROW|DMS|FDS|Final\s+Disposal)\b/i.test(normalized);
  const compressedFlowRange = hasFlowContext
    ? normalized.match(/\b(\d{1,3})\s*(?:-|–|—|â€“|â€”|to)\s*(\d{1,3})\b/i)
    : null;
  if (compressedFlowRange) return `${compressedFlowRange[1]}-${compressedFlowRange[2]}`;
  const plus = normalized.match(/\b(\d{1,3})\s*\+\b(?:.{0,24}\b(?:mi|mile|miles|dms|fds)\b)?/i);
  return plus ? `${plus[1]}+` : null;
}

function siteTypeFromText(value: string): string | null {
  const normalized = value
    .replace(/0/g, 'O')
    .replace(/1/g, 'I')
    .replace(/\s+/g, ' ');
  if (/\bROW\s*(?:to|t6|IO|I0|10)?\s*(?:DMS|BMS)\b/i.test(normalized)) return 'ROW_to_DMS';
  if (/\bfrom\s*ROW\s*to\b.{0,24}\b(?:DMS|BMS)\b/i.test(normalized)) return 'ROW_to_DMS';
  if (/\bDMS\s*(?:to|t6|IO|I0|10)?\s*(?:Final(?:\s+Disposal)?|FDS)\b/i.test(normalized)) return 'DMS_to_FDS';
  return null;
}

function isSectionLabel(value: string): boolean {
  const text = normalizeWhitespace(value);
  if (!text) return false;
  if (/^\s*section\s+\d+/i.test(text)) return true;
  if (/\$?\d+(?:\.\d+)?/.test(text)) return false;
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length > 12) return false;
  const letters = text.replace(/[^A-Za-z]/g, '');
  if (letters.length < 4) return false;
  const upperRatio = (letters.match(/[A-Z]/g) ?? []).length / letters.length;
  const titleCaseWords = words.filter((word) => /^[A-Z][a-z]+/.test(word)).length;
  return upperRatio > 0.75 || titleCaseWords >= Math.max(1, Math.ceil(words.length * 0.65));
}

function classifyScheduleRowRole(fragments: readonly OperationalTableFragment[]): OperationalTableRowRole {
  const cells = fragments.map((fragment) => normalizeWhitespace(fragment.cell_text)).filter(Boolean);
  const text = normalizeWhitespace(cells.join(' '));
  if (!text) return 'blank';

  const category = hintedText(fragments, 'category');
  const description = hintedText(fragments, 'description');
  const unitText = hintedText(fragments, 'unit');
  const rateText = hintedText(fragments, 'unit_price');
  const hasUnit = unitText != null && normalizeUnit(unitText, 'schedule_definition', { explicitCell: true }) != null;
  const rateGovernance = scheduleRateGovernance(fragments);
  if (rateGovernance.ambiguous) return 'unclassified';
  const rateHasNumeric = hasNumericRate(rateText ?? '') || fragments.some((fragment) =>
    fragment.extractor_hint === 'unit_price' && parseNumber(fragment.cell_text) != null);
  const passthrough = /\bpass[-\s]?through\b/i.test(rateText ?? text);

  if (passthrough) return 'passthrough_rate';
  if (
    normalizeUnit(unitText, 'schedule_definition', { explicitCell: true }) === 'Hour'
    && /\b(?:personnel|equipment|labor)\b/i.test(category ?? text)
  ) {
    return 'hourly_tm_rate';
  }
  if (rateHasNumeric && description && /\b(?:single\s+cost|any\s+distance|lump\s+sum)\b/i.test(description)) return 'lump_sum_rate';
  if (rateHasNumeric && description && semanticMileageTierFromText(description) != null) return 'mileage_tier_rate';
  if (!rateHasNumeric && !hasUnit && isSectionLabel(text)) return 'section_header';
  if (category && !description && !hasUnit && !rateHasNumeric) return 'category_header';
  if (rateHasNumeric) return 'unit_rate_definition';
  return 'unclassified';
}

function classifyRowRole(
  fragments: readonly OperationalTableFragment[],
  mode: AssemblySemanticMode,
): OperationalTableRowRole {
  if (mode === 'schedule_definition') return classifyScheduleRowRole(fragments);
  const cells = fragments.map((fragment) => normalizeWhitespace(fragment.cell_text)).filter(Boolean);
  const text = normalizeWhitespace(cells.join(' '));
  if (!text) return 'blank';

  const normalized = text.toLowerCase();
  const numericCount = cells.filter((cell) => parseNumber(cell) != null).length;
  const moneyCount = (text.match(/\$?\s*[\d,]+(?:\.\d{1,2})/g) ?? []).length;
  const letterCells = cells.filter(hasLetters).length;
  const headerHits = HEADER_TERMS.filter((term) => normalized.includes(term)).length;
  const subtotalHit = SUBTOTAL_TERMS.some((term) => new RegExp(`\\b${term.replace(/\s+/g, '\\s+')}\\b`, 'i').test(text));
  const hasRateCode = cells.some((cell) => codeLike(cell) != null) || leadingCode(text) != null;
  const hasUnit = unitFromText(text, mode) != null;
  const hints = new Set(fragments.map((fragment) => fragment.extractor_hint).filter(Boolean));
  const hasDescriptionHint = hints.has('description') || hints.has('category');
  const hasRateHint = hints.has('unit_price');
  const hasPassthrough = /\bpass[-\s]?through\b/i.test(text);

  if (subtotalHit && moneyCount > 0 && !hasRateCode) return 'subtotal';
  if (headerHits >= 2 && moneyCount === 0) return 'header';
  if (hasRateCode && (numericCount >= 2 || moneyCount >= 2 || hasUnit || cells.length >= 2)) return 'line_item';
  if (hasDescriptionHint && (hasRateHint || hasUnit || moneyCount > 0 || hasPassthrough)) return 'line_item';
  if (!hasRateCode && letterCells > 0 && hasUnit && (moneyCount > 0 || hasPassthrough)) return 'line_item';
  if (!hasRateCode && letterCells > 0 && (numericCount === 0 || cells.length <= 2)) return 'continuation';
  if (moneyCount >= 2 && letterCells > 0) return 'line_item';
  return 'unclassified';
}

function warningRow(params: {
  documentId: string;
  sourceFamily: string;
  semanticMode: AssemblySemanticMode;
  group: FragmentGroup;
  role: OperationalTableRowRole;
  warnings: string[];
}): CanonicalOperationalTableRow {
  const row = emptyRow({
    documentId: params.documentId,
    sourceFamily: params.sourceFamily,
    sourceTableKey: params.group.table_key,
    rowIndex: params.group.row_index,
    pageNumber: params.group.page_number,
    role: params.role,
    semanticMode: params.semanticMode,
    rawFragments: params.group.fragments,
  });
  row.notes = params.group.text;
  row.warnings.push(...params.warnings);
  if (params.semanticMode === 'schedule_definition') {
    const governance = scheduleRateGovernance(params.group.fragments);
    row.warnings.push(...governance.warnings.filter((warning) => !row.warnings.includes(warning)));
    if (governance.ambiguous) row.ambiguity_flags = ['ambiguous OCR rate cell'];
    if (governance.rawCandidates.length > 0) row.raw_candidate_values = governance.rawCandidates;
  }
  row.confidence = 0.3;
  row.evidence_refs.push(...evidenceRefsForField({
    documentId: params.documentId,
    field: 'notes',
    confidence: 0.3,
    fragments: params.group.fragments,
  }));
  row.canonical_row_signature = buildSignature(row);
  return row;
}

function emptyRow(params: {
  documentId: string;
  sourceFamily: string;
  sourceTableKey: string;
  rowIndex: number;
  pageNumber: number;
  role: OperationalTableRowRole;
  semanticMode: AssemblySemanticMode;
  rawFragments: OperationalTableFragment[];
}): CanonicalOperationalTableRow {
  return {
    // Stable lineage id for shadow diffing: do not include timestamps, UUIDs,
    // content hashes, or OCR-dependent text. Same table/page/row => same row_id.
    row_id: [
      params.sourceFamily,
      params.sourceTableKey,
      `p${params.pageNumber}`,
      `r${params.rowIndex}`,
    ].map((part) => String(part).replace(/[^A-Za-z0-9_-]+/g, '_')).join(':'),
    document_id: params.documentId,
    source_family: params.sourceFamily,
    source_table_key: params.sourceTableKey,
    source_document_family: params.sourceFamily,
    assembly_semantic_mode: params.semanticMode,
    row_role: params.role,
    warnings: [],
    confidence: 0.3,
    evidence_refs: [],
    raw_fragments: params.rawFragments.map((fragment) => ({ ...fragment })),
  };
}

function evidenceRefsForField(params: {
  documentId: string;
  field: keyof CanonicalOperationalTableRow;
  confidence: number;
  fragments: readonly OperationalTableFragment[];
}): OperationalTableRowEvidenceRef[] {
  return params.fragments.map((fragment) => ({
    document_id: params.documentId,
    page_number: fragment.page_number,
    table_key: fragment.table_key,
    row_index: fragment.row_index,
    cell_index: fragment.cell_index,
    geometry: fragment.geometry,
    raw_text: fragment.cell_text,
    field_assigned: params.field,
    confidence: params.confidence,
  }));
}

function setField(
  row: CanonicalOperationalTableRow,
  field: keyof CanonicalOperationalTableRow,
  fieldValue: FieldConfidence | null,
): number | null {
  if (!fieldValue || fieldValue.value == null) return null;
  (row as Record<string, unknown>)[field] = fieldValue.value;
  row.evidence_refs.push(...evidenceRefsForField({
    documentId: row.document_id,
    field,
    confidence: fieldValue.confidence,
    fragments: fieldValue.fragments,
  }));
  return fieldValue.confidence;
}

function fragmentForText(group: FragmentGroup, value: string | null | undefined): OperationalTableFragment[] {
  if (!value) return group.fragments;
  const normalizedValue = dense(value);
  const matched = group.fragments.filter((fragment) => dense(fragment.cell_text).includes(normalizedValue));
  return matched.length > 0 ? matched : group.fragments;
}

function firstValidCandidate(
  fragments: readonly OperationalTableFragment[],
  predicate: (value: unknown) => boolean,
): { value: unknown; fragment: OperationalTableFragment } | null {
  for (const fragment of fragments) {
    if (fragment.candidate_value == null) continue;
    if (!containsCandidateText(fragment, fragment.candidate_value)) continue;
    if (!predicate(fragment.candidate_value)) continue;
    return { value: fragment.candidate_value, fragment };
  }
  return null;
}

function stripKnownTails(text: string, fields: {
  rate_code?: string | null;
  quantity?: number | null;
  unit_price?: number | null;
  line_total?: number | null;
}): string {
  let out = normalizeWhitespace(text);
  if (fields.rate_code) {
    out = out.replace(new RegExp(`^\\s*${fields.rate_code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[-:.)]?\\s*`, 'i'), '');
  }
  for (const value of [fields.line_total, fields.unit_price, fields.quantity]) {
    if (value == null) continue;
    const escaped = String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`\\$?\\s*${escaped.replace(/,/g, ',?')}\\s*$`), '');
  }
  out = out
    .replace(/\$?\s*[\d,]+(?:\.\d{1,2})?\s+\$?\s*[\d,]+(?:\.\d{1,2})?\s*$/g, '')
    .replace(/\b(?:EA|EACH|ROW|LH|CYD|CY|LS|LSUM|TON|MO|MONTH|DAY|DY|HR|HOUR|LF|SF|POUND\s*\/\s*UNIT)\b\s*$/i, '');
  return normalizeWhitespace(out);
}

function fragmentsWithHint(
  group: FragmentGroup,
  hints: readonly string[],
): OperationalTableFragment[] {
  return group.fragments.filter((fragment) => fragment.extractor_hint && hints.includes(fragment.extractor_hint));
}

function firstHintText(group: FragmentGroup, hints: readonly string[]): string | null {
  const fragments = fragmentsWithHint(group, hints);
  const text = normalizeWhitespace(fragments.map((fragment) => fragment.cell_text).join(' '));
  return text || null;
}

function mileageTierFromText(value: string): string | null {
  const match = value.match(/\b(\d{1,3})\s*(?:-|–|—|to)\s*(\d{1,3})\s*(?:mi|mile|miles)\b/i);
  if (!match) return null;
  return `${match[1]}-${match[2]} Miles`;
}

function extractFields(group: FragmentGroup, mode: AssemblySemanticMode): {
  category: FieldConfidence | null;
  rateCode: FieldConfidence | null;
  description: FieldConfidence | null;
  quantity: FieldConfidence | null;
  unit: FieldConfidence | null;
  unitPrice: FieldConfidence | null;
  lineTotal: FieldConfidence | null;
  serviceItem: FieldConfidence | null;
  mileageTier: FieldConfidence | null;
  siteType: FieldConfidence | null;
  warnings: string[];
  ocrNormalizationActions: string[];
  ambiguityFlags: string[];
  rawCandidateValues: string[];
} {
  const warnings: string[] = [];
  const cells = group.fragments.map((fragment) => normalizeWhitespace(fragment.cell_text));
  const fullText = normalizeWhitespace(cells.join(' '));
  const categoryText = firstHintText(group, ['category']);
  const hintedDescriptionText = firstHintText(group, ['description']);
  const passthroughRate = /\bpass[-\s]?through\b/i.test(fullText);
  const scheduleMode = mode === 'schedule_definition';
  const rateGovernance = scheduleMode ? scheduleRateGovernance(group.fragments) : null;
  if (rateGovernance?.warnings.length) warnings.push(...rateGovernance.warnings);

  const codeCandidate = firstValidCandidate(group.fragments, (value) => codeLike(String(value)) != null);
  const leading = leadingCode(fullText);
  const codeCell = group.fragments.find((fragment) => codeLike(fragment.cell_text) != null);
  const splitCode = (() => {
    const ordered = [...group.fragments].sort((left, right) => left.cell_index - right.cell_index);
    for (let index = 0; index < ordered.length - 1; index += 1) {
      const left = normalizeWhitespace(ordered[index]?.cell_text ?? '');
      const right = normalizeWhitespace(ordered[index + 1]?.cell_text ?? '');
      const match = right.match(/^([A-Z]{1,4})\b\s*(.*)$/i);
      const combined = codeLike(`${left}${match?.[1] ?? ''}`);
      if (/^\d{1,4}$/.test(left) && match && combined) {
        return {
          code: combined,
          fragments: [ordered[index]!, ordered[index + 1]!],
          rest: normalizeWhitespace(match[2] ?? ''),
        };
      }
    }
    return null;
  })();
  const rateCodeValue =
    codeLike(String(codeCandidate?.value ?? ''))
    ?? codeLike(codeCell?.cell_text)
    ?? splitCode?.code
    ?? leading?.rate_code
    ?? null;
  const rateCode: FieldConfidence | null = rateCodeValue
    ? {
        value: rateCodeValue,
        confidence: codeCandidate ? 0.85 : codeCell ? 1.0 : splitCode ? 0.50 : 0.70,
        fragments: codeCandidate ? [codeCandidate.fragment] : codeCell ? [codeCell] : splitCode ? splitCode.fragments : fragmentForText(group, rateCodeValue),
      }
    : null;

  const amountCandidate = firstValidCandidate(group.fragments, (value) => parseNumber(value) != null);
  const amounts = amountTokens(fullText);
  const hintedUnitPriceFragment = fragmentsWithHint(group, ['unit_price'])
    .find((fragment) => parseNumber(fragment.cell_text) != null);
  const hasContractRateHints = fragmentsWithHint(group, ['unit_price']).length > 0
    && (fragmentsWithHint(group, ['description', 'category']).length > 0);
  const lineTotalValue = scheduleMode || hasContractRateHints
    ? null
    : parseNumber(amountCandidate?.value) ?? amounts.at(-1)?.value ?? null;
  const lineTotalFragment =
    amountCandidate?.fragment
    ?? [...group.fragments].reverse().find((fragment) => parseNumber(fragment.cell_text) === lineTotalValue)
    ?? group.fragments.at(-1);
  const lineTotal: FieldConfidence | null = lineTotalValue != null && lineTotalFragment
    ? {
        value: lineTotalValue,
        confidence: amountCandidate ? 0.85 : 0.70,
        fragments: [lineTotalFragment],
      }
    : null;

  let quantityValue: number | null = null;
  const hintedUnitPriceAmounts = hintedUnitPriceFragment ? currencyTokens(hintedUnitPriceFragment.cell_text) : [];
  const selectedHintedUnitPriceAmount = hintedUnitPriceAmounts.at(-1)
    ?? (hintedUnitPriceFragment ? amountTokens(hintedUnitPriceFragment.cell_text).at(-1) : undefined);
  const normalizedOcrCurrency = scheduleMode && hintedUnitPriceFragment && selectedHintedUnitPriceAmount
    ? normalizeCollapsedOcrCurrency({
        fragment: hintedUnitPriceFragment,
        fullText,
        amount: selectedHintedUnitPriceAmount,
      })
    : null;
  if (normalizedOcrCurrency) warnings.push(normalizedOcrCurrency.warning);
  let unitPriceValue: number | null = normalizedOcrCurrency?.value
    ?? selectedHintedUnitPriceAmount?.value
    ?? (hintedUnitPriceFragment ? parseNumber(hintedUnitPriceFragment.cell_text) : null);
  if (scheduleMode && unitPriceValue == null && amounts.length >= 1) {
    unitPriceValue = amounts.at(-1)?.value ?? null;
  } else if (amounts.length >= 3 && unitPriceValue == null) {
    quantityValue = amounts[amounts.length - 3]?.value ?? null;
    unitPriceValue = amounts[amounts.length - 2]?.value ?? null;
  } else if (amounts.length >= 2 && unitPriceValue == null) {
    unitPriceValue = amounts[amounts.length - 2]?.value ?? null;
  } else if (amounts.length === 1 && hasContractRateHints && unitPriceValue == null) {
    unitPriceValue = amounts[0]?.value ?? null;
  }

  const numericFragments = group.fragments.filter((fragment) => isPlainNumericCell(fragment.cell_text) && parseNumber(fragment.cell_text) != null);
  if (cells.length >= 5) {
    const byIndex = [...group.fragments].sort((left, right) => left.cell_index - right.cell_index);
    const tailNumbers = byIndex
      .map((fragment) => ({ fragment, value: parseNumber(fragment.cell_text) }))
      .filter((entry): entry is { fragment: OperationalTableFragment; value: number } => entry.value != null);
    if (tailNumbers.length >= 3) {
      quantityValue = tailNumbers[tailNumbers.length - 3]?.value ?? quantityValue;
      unitPriceValue = tailNumbers[tailNumbers.length - 2]?.value ?? unitPriceValue;
    }
  }

  if (
    mode === 'transactional'
    && quantityValue != null
    && unitPriceValue != null
    && lineTotalValue != null
    && !nearlyEqualMoney(quantityValue * unitPriceValue, lineTotalValue)
  ) {
    const matchingUnitPrice = amounts
      .map((amount) => amount.value)
      .find((candidate) => candidate !== quantityValue && candidate !== lineTotalValue && nearlyEqualMoney(quantityValue! * candidate, lineTotalValue));
    if (matchingUnitPrice != null) {
      unitPriceValue = matchingUnitPrice;
    } else {
      warnings.push('unit price recovery could not reconcile quantity x unit_price to line_total');
    }
  }

  const quantityFragment =
    numericFragments.find((fragment) => parseNumber(fragment.cell_text) === quantityValue)
    ?? fragmentForText(group, quantityValue != null ? String(quantityValue) : null)[0];
  const unitPriceFragment =
    hintedUnitPriceFragment
    ?? numericFragments.find((fragment) => parseNumber(fragment.cell_text) === unitPriceValue)
    ?? fragmentForText(group, unitPriceValue != null ? String(unitPriceValue) : null)[0];

  const quantity: FieldConfidence | null = quantityValue != null && quantityFragment
    ? { value: quantityValue, confidence: 0.70, fragments: [quantityFragment] }
    : null;

  const hintedUnitCell = fragmentsWithHint(group, ['unit'])
    .find((fragment) => normalizeUnit(fragment.cell_text, mode, { explicitCell: true }) != null);
  const explicitUnitCell = group.fragments.find((fragment) =>
    fragment.extractor_hint !== 'description'
    && fragment.extractor_hint !== 'category'
    && normalizeUnit(fragment.cell_text, mode, { explicitCell: true }) != null);
  const adjacentUnitCell = group.fragments.find((fragment) =>
    fragment.extractor_hint == null
    && normalizeUnit(fragment.cell_text, mode, { explicitCell: true }) != null
    && !hasLetters(fragment.cell_text.replace(/pound\s*\/\s*unit/i, '')));
  const embeddedUnitFromText = unitFromText(fullText, mode);
  const unitCell = hintedUnitCell ?? explicitUnitCell ?? adjacentUnitCell ?? null;
  const unitValue = normalizeUnit(unitCell?.cell_text, mode, { explicitCell: true }) ?? embeddedUnitFromText;
  const unit: FieldConfidence | null = unitValue
    ? {
        value: unitValue,
        confidence: unitCell ? 1.0 : 0.70,
        fragments: unitCell ? [unitCell] : fragmentForText(group, unitValue),
      }
    : null;

  const mileageTierPreview = scheduleMode
    ? semanticMileageTierFromText(hintedDescriptionText || fullText)
    : mileageTierFromText(hintedDescriptionText || fullText);
  const siteTypePreview = scheduleMode ? siteTypeFromText(hintedDescriptionText || fullText) : null;
  const unsafeRateWarnings = rateSelectionUnsafe({
    fullText,
    unitPriceValue,
    unitPriceFragment,
    unitValue,
    hasExplicitRateEvidence: Boolean(
      hintedUnitPriceFragment
      && currencyTokens(hintedUnitPriceFragment.cell_text).length === 1,
    ),
    hasClearUnitFamily: unitValue != null || Boolean(mileageTierPreview && siteTypePreview),
    hasDescriptionFlow: Boolean(hintedDescriptionText && (mileageTierPreview || siteTypePreview || hasLetters(hintedDescriptionText))),
    hasEvidenceRefs: Boolean(unitPriceFragment),
    scheduleMode,
  });
  if (unsafeRateWarnings.length > 0) {
    warnings.push(...unsafeRateWarnings);
    unitPriceValue = null;
  }

  const unitPrice: FieldConfidence | null = unitPriceValue != null && unitPriceFragment
    ? { value: unitPriceValue, confidence: normalizedOcrCurrency ? 0.85 : hintedUnitPriceFragment ? 1.0 : 0.70, fragments: [unitPriceFragment] }
    : null;

  const unknownUnitMatch = fullText.match(/\b([A-Z]{2,6})\b/);
  if (unknownUnitMatch && !unitValue && /(?:unit|uom|qty|quantity|price|total)/i.test(fullText) === false) {
    const maybe = unknownUnitMatch[1] ?? '';
    if (
      maybe.length <= 5
      && maybe !== rateCodeValue
      && !['DMS', 'FDS'].includes(maybe.toUpperCase())
      && !(scheduleMode && maybe.toUpperCase() === 'ROW')
    ) {
      warnings.push(`unknown unit token "${maybe}"`);
    }
  }

  if (passthroughRate && unitPriceValue == null && !scheduleMode) {
    warnings.push('Passthrough rate detected; unit_price left null');
  }

  let descriptionText = hintedDescriptionText || splitCode?.rest || leading?.rest || stripKnownTails(fullText, {
    rate_code: rateCodeValue,
    quantity: quantityValue,
    unit_price: unitPriceValue,
    line_total: lineTotalValue,
  });
  if (cells.length > 1) {
    const descriptionCells = group.fragments.filter((fragment) => {
      if (rateCodeValue && codeLike(fragment.cell_text) === rateCodeValue) return false;
      if (isPlainNumericCell(fragment.cell_text) && parseNumber(fragment.cell_text) != null) return false;
      if (normalizeUnit(fragment.cell_text, mode, { explicitCell: true }) != null) return false;
      if (fragment.extractor_hint === 'category') return false;
      if (fragment.extractor_hint === 'unit') return false;
      if (fragment.extractor_hint === 'unit_price') return false;
      if (fragment.extractor_hint === 'origin_destination') return false;
      return hasLetters(fragment.cell_text);
    });
    if (descriptionCells.length > 0) {
      descriptionText = normalizeWhitespace(descriptionCells.map((fragment) => fragment.cell_text).join(' '));
      if (splitCode?.code) {
        const suffix = splitCode.code.replace(/^\d+/, '');
        if (suffix) {
          descriptionText = descriptionText.replace(new RegExp(`^${suffix}\\b\\s*`, 'i'), '');
        }
      }
      if (rateCodeValue) {
        const lead = leadingCode(descriptionText);
        if (lead?.rate_code === rateCodeValue) descriptionText = lead.rest;
      }
    }
  }
  if (!scheduleMode) {
    descriptionText = descriptionText
      .replace(/\bINVOICE\b[\s\S]*$/i, '')
      .replace(/\bSubtotal\b[\s\S]*$/i, '')
      .replace(/\bTOTAL\b[\s\S]*$/i, '')
      .replace(/\bMake all checks payable to\b[\s\S]*$/i, '')
      .trim();
  }

  const description: FieldConfidence | null = descriptionText && hasLetters(descriptionText)
    ? {
        value: normalizeWhitespace(descriptionText),
        confidence: hintedDescriptionText ? 1.0 : cells.length > 1 ? 1.0 : 0.70,
        fragments: hintedDescriptionText ? fragmentsWithHint(group, ['description']) : fragmentForText(group, descriptionText),
      }
    : null;
  const serviceItemText = firstHintText(group, ['service_item']);
  const serviceItem: FieldConfidence | null = serviceItemText && hasLetters(serviceItemText)
    ? {
        value: normalizeWhitespace(serviceItemText),
        confidence: 1.0,
        fragments: fragmentsWithHint(group, ['service_item']),
      }
    : null;
  const category: FieldConfidence | null = categoryText && hasLetters(categoryText)
    ? {
        value: normalizeWhitespace(categoryText),
        confidence: 1.0,
        fragments: fragmentsWithHint(group, ['category']),
      }
    : null;
  const mileageTierValue = scheduleMode
    ? semanticMileageTierFromText(descriptionText || fullText)
    : mileageTierFromText(descriptionText || fullText);
  const mileageTier: FieldConfidence | null = mileageTierValue
    ? {
        value: mileageTierValue,
        confidence: scheduleMode ? 0.85 : 0.70,
        fragments: description?.fragments.length ? description.fragments : fragmentForText(group, mileageTierValue),
      }
    : null;
  const siteTypeValue = scheduleMode ? siteTypeFromText(descriptionText || fullText) : null;
  const siteType: FieldConfidence | null = siteTypeValue
    ? {
        value: siteTypeValue,
        confidence: 0.85,
        fragments: description?.fragments.length ? description.fragments : fragmentForText(group, siteTypeValue),
      }
    : null;

  return {
    category,
    rateCode,
    description,
    quantity,
    unit,
    unitPrice,
    lineTotal,
    serviceItem,
    mileageTier,
    siteType,
    warnings,
    ocrNormalizationActions: normalizedOcrCurrency ? [normalizedOcrCurrency.action] : [],
    ambiguityFlags: [
      ...(rateGovernance?.ambiguous ? ['ambiguous OCR rate cell'] : []),
      ...(unsafeRateWarnings.length > 0 ? ['unsafe contract rate evidence'] : []),
    ],
    rawCandidateValues: rateGovernance?.rawCandidates ?? [],
  };
}

function mergeContinuation(
  row: CanonicalOperationalTableRow,
  continuation: FragmentGroup,
): void {
  const text = normalizeWhitespace(continuation.text);
  if (!text) return;
  const existing = row.description ?? '';
  row.description = normalizeWhitespace(`${existing} ${text}`);
  row.raw_fragments.push(...continuation.fragments.map((fragment) => ({ ...fragment })));
  row.evidence_refs.push(...evidenceRefsForField({
    documentId: row.document_id,
    field: 'description',
    confidence: 0.5,
    fragments: continuation.fragments,
  }));
  row.confidence = Math.min(row.confidence, 0.5);
  if (!row.warnings.some((warning) => warning.includes('below 0.60'))) {
    row.warnings.push(`row confidence ${row.confidence.toFixed(2)} is below 0.60`);
  }
  row.canonical_row_signature = buildSignature(row);
}

function buildSignature(row: CanonicalOperationalTableRow): string {
  return [
    row.document_id,
    normalizeSignaturePart(row.rate_code),
    normalizeSignaturePart(row.description),
    normalizeSignaturePart(row.quantity),
    normalizeSignaturePart(row.line_total),
  ].join('|');
}

function scheduleConfidence(row: CanonicalOperationalTableRow): number {
  const byField = new Map<keyof CanonicalOperationalTableRow, number>();
  for (const ref of row.evidence_refs) {
    const current = byField.get(ref.field_assigned) ?? 0;
    byField.set(ref.field_assigned, Math.max(current, ref.confidence));
  }
  const weights = new Map<keyof CanonicalOperationalTableRow, number>([
    ['unit_price', 3],
    ['unit', 3],
    ['description', 3],
    ['category', 2],
    ['mileage_tier', 1],
    ['site_type', 1],
    ['service_item', 1],
  ]);
  let weighted = 0;
  let totalWeight = 0;
  for (const [field, confidence] of byField.entries()) {
    const weight = weights.get(field) ?? 1;
    weighted += confidence * weight;
    totalWeight += weight;
  }
  return totalWeight > 0 ? Number((weighted / totalWeight).toFixed(3)) : 0.3;
}

function applyScheduleConfidenceGovernance(row: CanonicalOperationalTableRow): void {
  if (row.assembly_semantic_mode !== 'schedule_definition') return;
  const penalties: string[] = [];
  let confidence = row.confidence;
  const hasOcrFragments = row.raw_fragments.some(isOcrFragment);
  if (hasOcrFragments) {
    penalties.push('ocr-derived row');
    confidence = Math.min(confidence, 0.97);
  }
  if (row.ocr_normalization_actions?.length) {
    penalties.push('ocr currency normalization applied');
    confidence = Math.min(confidence, 0.86);
  }
  if (row.unit == null && row.row_role !== 'passthrough_rate') {
    penalties.push('missing unit');
    confidence = Math.min(confidence, 0.84);
  }
  if (row.warnings.some((warning) => warning.startsWith('unknown unit token'))) {
    penalties.push('unresolved OCR token');
    confidence = Math.min(confidence, 0.78);
  }
  if (row.ambiguity_flags?.length) {
    penalties.push('rate ambiguity');
    confidence = Math.min(confidence, 0.5);
  }
  if (penalties.length > 0) {
    row.confidence_penalties = [...new Set([...(row.confidence_penalties ?? []), ...penalties])];
    row.confidence = Number(confidence.toFixed(3));
  }
}

function finishRow(
  row: CanonicalOperationalTableRow,
  fieldConfidences: number[],
): CanonicalOperationalTableRow {
  const usableConfidences = fieldConfidences.filter((value) => Number.isFinite(value));
  row.confidence = row.assembly_semantic_mode === 'schedule_definition'
    ? scheduleConfidence(row)
    : usableConfidences.length > 0 ? Math.min(...usableConfidences) : 0.3;
  if (row.evidence_refs.length === 0) {
    row.warnings.push('row has no field evidence references');
  }
  const assignedFields = new Set(row.evidence_refs.map((ref) => ref.field_assigned));
  for (const field of ['rate_code', 'description', 'quantity', 'unit', 'unit_price', 'line_total'] as const) {
    if ((row[field] != null) && !assignedFields.has(field)) {
      row.warnings.push(`field ${field} has no evidence ref`);
    }
  }
  if (row.confidence < 0.6) {
    row.warnings.push(`row confidence ${row.confidence.toFixed(2)} is below 0.60`);
  }
  applyScheduleConfidenceGovernance(row);
  if (row.confidence < 0.6 && !row.warnings.some((warning) => warning.includes('below 0.60'))) {
    row.warnings.push(`row confidence ${row.confidence.toFixed(2)} is below 0.60`);
  }
  row.canonical_row_signature = buildSignature(row);
  return row;
}

function assembleLineRow(params: {
  documentId: string;
  sourceFamily: string;
  semanticMode: AssemblySemanticMode;
  group: FragmentGroup;
}): CanonicalOperationalTableRow {
  const row = emptyRow({
    documentId: params.documentId,
    sourceFamily: params.sourceFamily,
    sourceTableKey: params.group.table_key,
    rowIndex: params.group.row_index,
    pageNumber: params.group.page_number,
    role: params.group.role === 'line_item' ? 'line_item' : params.group.role,
    semanticMode: params.semanticMode,
    rawFragments: params.group.fragments,
  });
  const fields = extractFields(params.group, params.semanticMode);
  row.warnings.push(...fields.warnings);
  if (fields.ocrNormalizationActions.length > 0) {
    row.ocr_normalization_actions = fields.ocrNormalizationActions;
  }
  if (fields.ambiguityFlags.length > 0) {
    row.ambiguity_flags = fields.ambiguityFlags;
  }
  if (fields.rawCandidateValues.length > 0) {
    row.raw_candidate_values = fields.rawCandidateValues;
  }
  const passthroughFragments = params.group.role === 'passthrough_rate'
    ? fragmentsWithHint(params.group, ['unit_price']).filter((fragment) => /\bpass[-\s]?through\b/i.test(fragment.cell_text))
    : [];
  if (passthroughFragments.length > 0) {
    row.evidence_refs.push(...evidenceRefsForField({
      documentId: row.document_id,
      field: 'unit_price',
      confidence: 1.0,
      fragments: passthroughFragments,
    }));
  }
  const confidences = [
    setField(row, 'category', fields.category),
    setField(row, 'rate_code', fields.rateCode),
    setField(row, 'description', fields.description),
    setField(row, 'quantity', fields.quantity),
    setField(row, 'unit', fields.unit),
    setField(row, 'unit_price', fields.unitPrice),
    setField(row, 'line_total', fields.lineTotal),
    setField(row, 'service_item', fields.serviceItem),
    setField(row, 'mileage_tier', fields.mileageTier),
    setField(row, 'site_type', fields.siteType),
    passthroughFragments.length > 0 ? 1.0 : null,
  ].filter((value): value is number => value != null);
  const isInvoice = params.sourceFamily === 'invoice';
  if (isInvoice && !row.rate_code) row.warnings.push('rate code not recovered');
  if (!row.description) row.warnings.push('description not recovered');
  if (isInvoice && row.quantity == null) row.warnings.push('quantity not recovered');
  if (params.semanticMode === 'schedule_definition' && row.unit == null && row.row_role !== 'passthrough_rate') {
    row.warnings.push('unit not recovered');
  }
  if (
    row.unit_price == null
    && row.row_role !== 'passthrough_rate'
    && !row.warnings.some((warning) => warning.includes('Passthrough rate'))
  ) {
    row.warnings.push('unit price not recovered');
  }
  if (isInvoice && row.line_total == null) row.warnings.push('line total not recovered');
  return finishRow(row, confidences);
}

function shouldDowngradeScheduleRow(row: CanonicalOperationalTableRow): boolean {
  if (row.assembly_semantic_mode !== 'schedule_definition') return false;
  if (row.row_role === 'passthrough_rate') return false;
  if (row.ambiguity_flags?.length) return true;
  if (!row.description || row.unit_price == null) return true;
  const unresolvedOcrToken = row.warnings.some((warning) => warning.startsWith('unknown unit token'));
  const missingUnit = row.unit == null;
  const hasFlowContext = row.mileage_tier != null || row.site_type != null;
  if (missingUnit && unresolvedOcrToken && !hasFlowContext) return true;
  return false;
}

export function assembleCanonicalOperationalTableRows(
  input: AssembleCanonicalOperationalTableRowsInput,
): CanonicalOperationalTableRowAssemblyResult {
  const assemblyWarnings: string[] = [];
  const semanticMode = resolveSemanticMode(input.source_family);
  const groups = groupFragments(input.fragments, semanticMode);
  const rows: CanonicalOperationalTableRow[] = [];
  const rejectedRows: CanonicalOperationalTableRow[] = [];
  const unclassifiedRows: CanonicalOperationalTableRow[] = [];

  for (const group of groups) {
    if (group.role === 'blank') continue;
    if (
      group.role === 'header'
      || group.role === 'subtotal'
      || group.role === 'section_header'
      || group.role === 'category_header'
      || group.role === 'explanatory_clause'
      || group.role === 'pricing_modifier'
    ) {
      rejectedRows.push(warningRow({
        documentId: input.document_id,
        sourceFamily: input.source_family,
        semanticMode,
        group,
        role: group.role,
        warnings: [`${group.role} row rejected from operational rows`],
      }));
      continue;
    }
    if (group.role === 'continuation') {
      const parent = rows.at(-1);
      if (parent) {
        mergeContinuation(parent, group);
      } else {
        unclassifiedRows.push(warningRow({
          documentId: input.document_id,
          sourceFamily: input.source_family,
          semanticMode,
          group,
          role: 'continuation',
          warnings: ['continuation row had no parent line item'],
        }));
      }
      continue;
    }
    if (group.role === 'unclassified') {
      unclassifiedRows.push(warningRow({
        documentId: input.document_id,
        sourceFamily: input.source_family,
        semanticMode,
        group,
        role: 'unclassified',
        warnings: ['row could not be classified before field extraction'],
      }));
      continue;
    }

    const assembled = assembleLineRow({
      documentId: input.document_id,
      sourceFamily: input.source_family,
      semanticMode,
      group,
    });
    if (shouldDowngradeScheduleRow(assembled)) {
      unclassifiedRows.push(warningRow({
        documentId: input.document_id,
        sourceFamily: input.source_family,
        semanticMode,
        group,
        role: 'unclassified',
        warnings: [
          'row downgraded by contract semantic confidence governance',
          ...assembled.warnings,
        ],
      }));
      continue;
    }
    rows.push(assembled);
  }

  const dedupedRows = new Map<string, CanonicalOperationalTableRow>();
  for (const row of rows) {
    const key = row.canonical_row_signature ?? row.row_id;
    if (!dedupedRows.has(key)) {
      dedupedRows.set(key, row);
      continue;
    }
    assemblyWarnings.push(`duplicate operational row collapsed: ${key}`);
  }

  for (const row of dedupedRows.values()) {
    if (row.evidence_refs.length === 0) {
      assemblyWarnings.push(`assembled row ${row.row_id} has empty evidence_refs`);
    }
    for (const warning of row.warnings) {
      if (warning.includes('below 0.60')) assemblyWarnings.push(`${row.row_id}: ${warning}`);
    }
  }

  return {
    rows: [...dedupedRows.values()],
    rejected_rows: rejectedRows,
    unclassified_rows: unclassifiedRows,
    assembly_warnings: assemblyWarnings,
    document_id: input.document_id,
    source_family: input.source_family,
  };
}


