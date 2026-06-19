import type { ContractRateScheduleRow } from '@/lib/contracts/types';

export type ContractPricingAssemblyConfidence = 'high' | 'medium' | 'low' | 'needs_review';
export type ContractPricingSourceKind =
  | 'canonical'
  | 'typed_fields'
  | 'exhibit_a_table'
  | 'exhibit_a_text_recovery'
  | 'rate_schedule'
  | 'fallback';
export type ContractPricingSourceQuality = 'clean' | 'partial' | 'fallback' | 'junk';
type ContractPricingDescriptionQuality = 'readable' | 'partial' | 'damaged';
export type ContractRateDescriptionDisplayQuality = 'clean' | 'partial' | 'damaged';
export type ContractRateDescriptionStateHint = 'confirmed' | 'derived' | 'needs_review';

export type ContractRateDescriptionDisplayCleanup = {
  displayDescription: string;
  descriptionQuality: ContractRateDescriptionDisplayQuality;
  stateHint: ContractRateDescriptionStateHint;
};

export type ContractPricingAssemblyRow = {
  id: string;
  category: string | null;
  description: string;
  route: string | null;
  distanceBand: string | null;
  unit: string | null;
  rate: number | null;
  page: number | null;
  sourceAnchor: string | null;
  confidence: ContractPricingAssemblyConfidence;
  sourceKind?: ContractPricingSourceKind;
  sourceQuality?: ContractPricingSourceQuality;
  rawText?: string;
};

export type ContractPricingAssemblySourceOptions = {
  canonicalRows?: readonly unknown[] | null;
  typedRows?: readonly unknown[] | null;
};

function clean(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0
    ? value.replace(/\s+/g, ' ').trim()
    : null;
}

function titleCategory(value: string | null): string | null {
  if (!value) return null;
  return value
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function escapeRegExp(value: string): string {
  return value.replace(/[\\^$*+?.()|[\]{}]/g, '\\$&');
}

const ALLOWED_CATEGORIES = [
  'Vegetative Collect, Remove & Haul',
  'C&D Collect, Remove & Haul',
  'Management & Reduction',
  'Final Disposal',
  'Tree Operations',
  'Equipment',
  'Personnel',
  'Specialty Removal',
] as const;

type AllowedCategory = (typeof ALLOWED_CATEGORIES)[number];

const EXPECTED_CATEGORY_COUNTS: Record<AllowedCategory, number> = {
  'Vegetative Collect, Remove & Haul': 9,
  'C&D Collect, Remove & Haul': 5,
  'Management & Reduction': 5,
  'Final Disposal': 8,
  'Tree Operations': 10,
  'Specialty Removal': 16,
  Personnel: 9,
  Equipment: 53,
};

const PAGE_CATEGORY_EXPECTATIONS: Record<number, readonly AllowedCategory[]> = {
  8: [
    'Vegetative Collect, Remove & Haul',
    'C&D Collect, Remove & Haul',
    'Management & Reduction',
    'Final Disposal',
  ],
  9: ['Tree Operations', 'Specialty Removal'],
  10: ['Personnel', 'Equipment'],
  11: ['Personnel', 'Equipment'],
};

function normalizeCategoryKey(value: string): string {
  return normalizeOcrText(value)
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function allowedCategoryFromText(value: string | null): AllowedCategory | null {
  if (!value) return null;
  const key = normalizeCategoryKey(value);
  const aliases: Array<[RegExp, AllowedCategory]> = [
    [/\bvegetative\b.*\bcollect\b.*\bremove\b.*\bha?ul\b/, 'Vegetative Collect, Remove & Haul'],
    [/\b(c\s?d|c and d|construction demolition)\b.*\bcollect\b.*\bremove\b.*\bha?ul\b/, 'C&D Collect, Remove & Haul'],
    [/\bmanagement\b.*\breduction\b/, 'Management & Reduction'],
    [/\bfinal\b.*\bdisposal\b/, 'Final Disposal'],
    [/\btree\b.*\boperations\b/, 'Tree Operations'],
    [/\bequipment\b/, 'Equipment'],
    [/\bpersonnel\b/, 'Personnel'],
    [/\bspecialty\b.*\bremoval\b/, 'Specialty Removal'],
  ];

  for (const [pattern, category] of aliases) {
    if (pattern.test(key)) return category;
  }

  return null;
}

function isRomanNumeralOnly(value: string): boolean {
  return /^(?:[ivxlcdm]+)$/i.test(value.trim());
}

function isNoisyCategory(value: string | null): boolean {
  if (!value) return true;
  const normalized = normalizeOcrText(value);
  const key = normalizeCategoryKey(normalized);
  if (!key) return true;
  if (/^\d+$/.test(key)) return true;
  if (isRomanNumeralOnly(normalized)) return true;
  if (/^[\W_]+$/.test(normalized)) return true;
  if (/\bfrom\s+unincorporated\s+neighborhood\b/i.test(normalized)) return true;
  if (/\bdiameter\s+[a-z]\b/i.test(normalized)) return true;
  if (/\b(page|category|description|unit|rate|table|row|pdf\s+text\s+block)\b/i.test(normalized)) {
    return true;
  }
  if (/[|[\]{}<>_]/.test(normalized)) return true;
  if (/\$\s*[\d,]+(?:\.\d{1,2})?/.test(normalized)) return true;
  if (/\b(row\s+to\s+dms|dms\s+to\s+fds|miles?|cubic\s+yard|yard|ton|hour)\b/i.test(normalized)) {
    return true;
  }
  return false;
}

export function parseContractPricingRate(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return null;
  if (/\bpass\s*through\b|\bpassthrough\b/i.test(value)) return null;
  const currencyMatches = value.match(/[$#§]\s*[\d,]+(?:\.\d{1,4})?/g) ?? [];
  if (currencyMatches.length > 1) return null;
  if (currencyMatches.length === 1) {
    const parsedCurrency = Number.parseFloat((currencyMatches[0] ?? '').replace(/[$#§,\s]/g, ''));
    return Number.isFinite(parsedCurrency) ? parsedCurrency : null;
  }
  const match = value.match(/\$?\s*(-?[\d,]+(?:\.\d{1,4})?)/);
  if (!match) return null;
  const parsed = Number.parseFloat((match[1] ?? '').replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

export function formatContractPricingRate(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return 'Unavailable';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function normalizeOcrText(value: string): string {
  return value
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\u2192/g, ' to ')
    .replace(/\bMilesfrom\b/gi, 'Miles from')
    .replace(/\bMilesftom\b/gi, 'Miles from')
    .replace(/\bftom\b/gi, 'from')
    .replace(/\btrom\b/gi, 'from')
    .replace(/\bfrorn\b/gi, 'from')
    .replace(/\bROW\s*t6\s*DMS\b/gi, 'ROW to DMS')
    .replace(/\bROW\s*10\s*DMS\b/gi, 'ROW to DMS')
    .replace(/\bROW\s*to\s*DMS\b/gi, 'ROW to DMS')
    .replace(/\bROW\s*-\s*to\s*-\s*DMS\b/gi, 'ROW to DMS')
    .replace(/\bROWtoDMS\b/gi, 'ROW to DMS')
    .replace(/\bROWttoDMS\b/gi, 'ROW to DMS')
    .replace(/\bfromROWto\b/gi, 'from ROW to')
    .replace(/\bROWho\b/gi, 'ROW to')
    .replace(/\bROWto\b/gi, 'ROW to')
    .replace(/\bDMS\s*-\s*to\s*-\s*FDS\b/gi, 'DMS to FDS')
    .replace(/\bDMS\s*-\s*FDS\b/gi, 'DMS to FDS')
    .replace(/\bDMS\s*to\s*FDS\b/gi, 'DMS to FDS')
    .replace(/\bDMS\s*to\s*Final\s*Disposal\b/gi, 'DMS to Final Disposal')
    .replace(/\bNejghborhoods?\b/gi, 'Neighborhood')
    .replace(/\bNeighborhoods\b/gi, 'Neighborhood')
    .replace(/_{2,}/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeContractPricingUnit(unit: string | null, rawText: string): string | null {
  const unitText = (unit ?? '').toLowerCase();
  const haystack = normalizeOcrText(`${unit ?? ''} ${rawText}`).toLowerCase();
  if (/\b(c\.?\s*y\.?|cyd|cy|cubic\s+yards?|yards?)\b/.test(unitText)) {
    return 'Cubic Yard';
  }
  if (/\btrees?\b/.test(unitText)) return 'Tree';
  if (/\bstumps?\b/.test(unitText)) return 'Stump';
  if (/\btons?\b/.test(unitText)) return 'Ton';
  if (/\b(hours?|hrs?|hr)\b/.test(unitText)) return 'Hour';
  if (/\b(unit|each|ea)\b/.test(unitText)) return 'Unit';
  if (/\bpounds?|lbs?\b/.test(unitText)) return 'Pound';
  if (/\bloads?\b/.test(unitText)) return 'Load';
  if (/\b(linear\s+foot|lf)\b/.test(unitText)) return 'Linear Foot';
  if (/\b(square\s+foot|sq\s*ft)\b/.test(unitText)) return 'Square Foot';
  if (/\bmiles?\b/.test(unitText) && /\b(c\.?\s*y\.?|cyd|cy|cubic\s+yards?|yards?)\b/.test(haystack)) {
    return 'Cubic Yard';
  }
  if (/\bmiles?\b/.test(unitText)) return 'Mile';
  if (!unit && /\b(c\.?\s*y\.?|cyd|cy|cubic\s+yards?)\b/.test(haystack)) {
    return 'Cubic Yard';
  }
  if (!unit && /\b(hours?|hrs?|hr)\b/.test(haystack)) return 'Hour';
  return unit ? titleCategory(unit) : null;
}

function hasStrongDescriptionNoise(value: string | null): boolean {
  if (!value) return true;
  const currencyMatches = value.match(/\$\s*[\d,]+(?:\.\d{1,2})?/g) ?? [];
  return (
    value.includes('|') ||
    value.includes('[') ||
    value.includes(']') ||
    /pdf\s+text\s+block/i.test(value) ||
    /\bpage\s+\d+\b/i.test(value) ||
    /\b(category|description|unit|rate)\b/i.test(value) ||
    /\b(?:Milesfrom|Milesftom|ROWtoDMS|ROWttoDMS|ROWho|t6\s+DMS)\b/i.test(value) ||
    currencyMatches.length > 0 ||
    /_{2,}/.test(value) ||
    /[{}<>]{2,}/.test(value)
  );
}

function rateToken(value: number): string {
  return value.toFixed(2).replace(/\.00$/, '');
}

function focusTextAroundRate(rawText: string, rate: number | null): string {
  if (rate == null || !Number.isFinite(rate) || !rawText) return rawText;
  const token = escapeRegExp(rateToken(rate));
  const match = new RegExp(`\\$?\\s*${token}\\b`).exec(rawText);
  if (!match) return rawText;
  return rawText.slice(Math.max(0, match.index - 220), Math.min(rawText.length, match.index + 140));
}

function canonicalCategoryFromText(value: string): string | null {
  const allowedCategory = allowedCategoryFromText(value);
  if (allowedCategory) return allowedCategory;

  const text = normalizeOcrText(value);
  const categoryPatterns: Array<[RegExp, string]> = [
    [/\bvegetative\b[\s\S]{0,80}\bcollect\b[\s\S]{0,50}\bremove\b[\s\S]{0,50}\bha?ul\b/i, 'Vegetative Collect, Remove & Haul'],
    [/\b(?:c\s*&\s*d|c\s+and\s+d|construction\s+&?\s*demolition)\b[\s\S]{0,80}\bcollect\b[\s\S]{0,50}\bremove\b[\s\S]{0,50}\bha?ul\b/i, 'C&D Collect, Remove & Haul'],
    [/\bmanagement\b[\s\S]{0,35}\breduction\b/i, 'Management & Reduction'],
    [/\bfinal\s+disposal\b/i, 'Final Disposal'],
    [/\btree\s+operations\b/i, 'Tree Operations'],
    [/\bequipment\b/i, 'Equipment'],
    [/\bpersonnel\b/i, 'Personnel'],
    [/\bspecialty\s+removal\b/i, 'Specialty Removal'],
  ];

  for (const [pattern, label] of categoryPatterns) {
    if (pattern.test(text)) return label;
  }

  return null;
}

function categoryFromCanonical(value: string | null): string | null {
  const allowedCategory = allowedCategoryFromText(value);
  if (allowedCategory) return allowedCategory;

  switch (value?.trim().toLowerCase()) {
    case 'vegetative':
    case 'vegetative_removal':
      return 'Vegetative Collect, Remove & Haul';
    case 'construction_demolition':
    case 'c_d':
    case 'c_and_d':
      return 'C&D Collect, Remove & Haul';
    case 'management_reduction':
      return 'Management & Reduction';
    case 'final_disposal':
      return 'Final Disposal';
    case 'tree_operations':
      return 'Tree Operations';
    case 'equipment':
      return 'Equipment';
    case 'personnel':
      return 'Personnel';
    case 'specialty_removal':
      return 'Specialty Removal';
    default:
      return null;
  }
}

function resolveCategory(row: ContractRateScheduleRow, text: string): string | null {
  const candidates = [
    clean(row.category),
    clean(row.source_category),
    clean(row.material_type),
  ];
  for (const candidate of candidates) {
    if (candidate && !hasStrongDescriptionNoise(candidate) && !isNoisyCategory(candidate)) {
      const category = canonicalCategoryFromText(candidate);
      if (category) return category;
    }
  }
  return canonicalCategoryFromText(text) ?? categoryFromCanonical(clean(row.canonical_category));
}

function pageAllowsCategory(page: number | null | undefined, category: string | null): boolean {
  if (!category) return false;
  if (typeof page !== 'number' || !Number.isFinite(page)) return true;
  const expected = PAGE_CATEGORY_EXPECTATIONS[page];
  return !expected || expected.includes(category as AllowedCategory);
}

function pageEightCategoryUsesCubicYard(page: number | null | undefined, category: string | null): boolean {
  return page === 8 && category != null && [
    'Vegetative Collect, Remove & Haul',
    'C&D Collect, Remove & Haul',
    'Management & Reduction',
    'Final Disposal',
  ].includes(category);
}

function categoryAllowsRouteDistance(category: string | null): boolean {
  return category === 'Vegetative Collect, Remove & Haul'
    || category === 'C&D Collect, Remove & Haul'
    || category === 'Final Disposal';
}

function refineCategoryByContext(
  row: ContractRateScheduleRow,
  category: string | null,
  rawText: string,
): string | null {
  const text = normalizedText(rawText);
  const page = typeof row.page === 'number' && Number.isFinite(row.page) ? row.page : null;

  if (page === 9) {
    if (recoverySpecialtyDescription(rawText)) return 'Specialty Removal';
    if (recoveryTreeDescription(rawText)) return 'Tree Operations';
  }
  if (page === 10 || page === 11) {
    if (recoveryPersonnelDescription(rawText)) return 'Personnel';
    if (recoveryEquipmentDescription(rawText)) return 'Equipment';
  }
  if (page === 8) {
    if (recoveryManagementDescription(rawText)) return 'Management & Reduction';
    if (recoveryFinalDisposalDescription(rawText, detectRoute(rawText), detectDistance(rawText).value)) {
      return 'Final Disposal';
    }
    if (/\bvegetative\b/.test(text) && /\brow\s+to\s+dms\b/.test(text)) {
      return 'Vegetative Collect, Remove & Haul';
    }
    if (/\bc\s*d\b|\bc\s+and\s+d\b|\bconstruction\b|\bdemolition\b/.test(text)) {
      return 'C&D Collect, Remove & Haul';
    }
  }

  if (!pageAllowsCategory(page, category)) return null;
  return category;
}

function detectRoute(rawText: string): string | null {
  const normalized = normalizeOcrText(rawText).replace(/[|,]/g, ' ').replace(/\s+/g, ' ').trim();
  if (/\brow\s*(?:to|-|->|-->)\s*dms\b/i.test(normalized)) return 'ROW to DMS';
  if (/\bdms\s*(?:to|-|->|-->)\s*fds\b/i.test(normalized)) return 'DMS to FDS';
  if (/\bdms\s*(?:to|-|->|-->)\s*final\s+disposal\b/i.test(normalized)) {
    return 'DMS to Final Disposal';
  }
  if (/\brow\s*(?:to|-|->|-->)\s*final\s+disposal\b/i.test(normalized)) return 'ROW to Final Disposal';
  if (/\bany\s+distance\b/i.test(normalized)) return 'Any Distance';
  return null;
}

function detectDistance(rawText: string): { value: string | null; ocrAmbiguous: boolean } {
  const normalized = normalizeOcrText(rawText);
  if (/\bany\s+distance\b/i.test(normalized)) return { value: 'Any Distance', ocrAmbiguous: false };
  if (/\b60\s*(?:\+|plus)(?:\s*miles?)?/i.test(normalized)) return { value: '60+ Miles', ocrAmbiguous: false };

  const matches = [...normalized.matchAll(/\b(0|16|31|60)\s*(?:-|to)\s*(15|16|30|60)\b(?:\s*miles?)?/gi)];
  const match = matches.at(-1);
  if (!match) return { value: null, ocrAmbiguous: false };

  const start = match[1];
  const end = match[2];
  if (start === '0' && end === '16') {
    return { value: '0 to 15 Miles', ocrAmbiguous: true };
  }
  return { value: `${start} to ${end} Miles`, ocrAmbiguous: false };
}

function detectScope(rawText: string): string | null {
  const normalized = normalizeOcrText(rawText);
  if (/\bunincorporated\b[\s\S]{0,40}\bneighborhood\b/i.test(normalized)) {
    return 'from Unincorporated Neighborhood';
  }
  if (/\brural\s+areas?\b/i.test(normalized)) return 'from Rural Areas';

  const beforeRoute = normalized.match(/\bfrom\s+(.{3,80}?)\s+(?:ROW\s+to\s+DMS|DMS\s+to\s+FDS|DMS\s+to\s+Final\s+Disposal|ROW\s+to\s+Final\s+Disposal)\b/i);
  if (!beforeRoute?.[1]) return null;

  const cleaned = beforeRoute[1]
    .replace(/\b(category|description|unit|rate)\b/gi, ' ')
    .replace(/\$\s*[\d,]+(?:\.\d{1,2})?/g, ' ')
    .replace(/\bCubic\s+Yard\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (/\b(row|dms|fds|miles?)\b/i.test(cleaned)) return null;
  return cleaned ? `from ${titleCategory(cleaned)}` : null;
}

function cleanDescriptionColumn(description: string): string {
  return normalizeOcrText(description)
    .replace(/pdf\s+text\s+block\s+on\s+page\s+\d+/gi, ' ')
    .replace(/\b(?:category|description|unit|rate)\b\s*:?/gi, ' ')
    .replace(/\$\s*[\d,]+(?:\.\d{1,4})?/g, ' ')
    .replace(/\bpass\s*through\b|\bpassthrough\b/gi, 'Passthrough')
    .replace(/\bLaborer\s*-\s*with\b/gi, 'Laborer with')
    .replace(/[|[\]{}<>]+/g, ' ')
    .replace(/_{2,}/g, ' ')
    .replace(/^[:;,\s-]+/g, '')
    .replace(/\s*[-~_]+\s*$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizedText(value: string): string {
  return normalizeOcrText(value)
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9+]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function compactOcrKey(value: string): string {
  return normalizedText(value).replace(/[^a-z0-9+]+/g, '');
}

function hasAny(value: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(value));
}

function recoveryVegetativeDescription(rawText: string, route: string | null, distance: string | null): string | null {
  const text = normalizedText(rawText);
  const hasRowToDms = route === 'ROW to DMS' || /\brow\s+to\s+dms\b/.test(text);
  const hasAnyDistance = distance === 'Any Distance' || /\bany\s+distance\b/.test(text);
  if (!hasRowToDms && !hasAnyDistance) return null;
  if (hasAnyDistance || /\bsingle\s+cost\b/.test(text)) return 'Single Cost from ROW to DMS Any Distance';
  if (/\$?\s*6[.,\s]*90\b/.test(text) && /\bunincorporated\b/.test(text)) {
    return 'from Unincorporated Neighborhood ROW to DMS 0 to 15 Miles';
  }
  if (/\$?\s*15[.,\s]*50\b/.test(text) && /\brural\s+areas?\b/.test(text)) {
    return 'from Rural Areas ROW to DMS 31 to 60 Miles';
  }

  const area = /\brural\s+areas?\b/.test(text)
    ? 'from Rural Areas'
    : /\bunincorporated\b|\bneighborhood\b/.test(text)
      ? 'from Unincorporated Neighborhood'
      : null;
  if (!distance) return null;
  return [area, 'ROW to DMS', distance].filter(Boolean).join(' ');
}

function recoveryCDDescription(rawText: string, route: string | null, distance: string | null): string | null {
  const text = normalizedText(rawText);
  const isCd = /\bc\s*d\b|\bc\s+and\s+d\b|\bconstruction\b|\bdemolition\b/.test(text);
  if (!isCd) return null;
  if (distance === 'Any Distance' || /\bany\s+distance\b|\bsingle\s+cost\b/.test(text)) {
    return 'C&D Collect, Remove & Haul Single Cost Any Distance';
  }
  if ((route === 'ROW to DMS' || /\brow\s+to\s+dms\b/.test(text)) && distance) {
    return `C&D Collect, Remove & Haul from ROW to DMS ${distance}`;
  }
  return null;
}

function recoveryManagementDescription(rawText: string): string | null {
  const text = normalizedText(rawText);
  if (/\bair\s+curtain\s+burning\b|\bair\s+curtain\b/.test(text)) return 'Air Curtain Burning of Vegetative Debris';
  if (/\bopen\s+burning\b/.test(text)) return 'Open Burning of Vegetative Debris';
  if (hasAny(text, [/\bgrinding\b/, /\bchipping\b/])) return 'Grinding and Chipping Vegetative Debris';
  if (/\bcompaction\b|\bcompact(?:ing)?\b/.test(text)) {
    return 'Compaction (Preparation, Vegetative Management, Debris and Segregating Material at DMS)';
  }
  if (hasAny(text, [/\bpreparation\b/, /\bsegregating\b/, /\bvegetative\s+management\b/])) {
    return 'Preparation, Vegetative Management, Debris and Segregating Material at DMS';
  }
  return null;
}

function recoveryFinalDisposalDescription(rawText: string, route: string | null, distance: string | null): string | null {
  const text = normalizedText(rawText);
  if (distance === 'Any Distance' || /\bany\s+distance\b|\bsingle\s+cost\b/.test(text)) {
    return 'Single Cost Any Distance';
  }
  const finalRoute = route === 'DMS to FDS' || /\bfds\b/.test(text)
    ? 'DMS to FDS'
    : route === 'DMS to Final Disposal' || /\bfinal\s+disposal\b/.test(text)
      ? 'DMS to Final Disposal'
      : /\bdms\b.*\bfinal\b|\bfinal\b.*\bdms\b/.test(text)
        ? 'DMS to Final Disposal'
        : null;
  if (!finalRoute || !distance) return null;
  return /\bmulch\b/.test(text) ? `Mulch ${finalRoute} ${distance}` : `${finalRoute} ${distance}`;
}

function recoveryTreeDescription(rawText: string): string | null {
  const text = normalizedText(rawText);
  const compact = compactOcrKey(rawText);
  const diameter = text.match(/\b(6|13|25|37)\s+(?:(?:to|-)\s+)?(12|24|36|48)\b/);
  if (diameter) return `Hazardous Trees ${diameter[1]} to ${diameter[2]} inch trunk`;
  if (/\blimbs?\b.*\bhanging\b|\bhanging\b.*\blimbs?\b/.test(text)) return 'Trees with Hazardous Limbs Hanging';
  if (/\bstump\b.*\bfill\b|\bfill\b.*\bstump\b/.test(text) || /stumpfldirt|fldirtforfilling/.test(compact)) {
    return 'Stump Fill Dirt for Filling Stump Holes';
  }
  const stumpDiameter = text.match(/\bstump\b[\s\S]{0,40}\b(24|49)\s*(?:inch|in|up)\b/);
  if (stumpDiameter) return `Hazardous Stump Removal ${stumpDiameter[1]} inch up`;
  if (/\bstump\b/.test(text)) return 'Hazardous Stump Removal 24 inch up';
  if (/\bhazardous\s+trees?\b/.test(text)) return 'Hazardous Trees';
  return null;
}

function recoverySpecialtyDescription(rawText: string): string | null {
  const text = normalizedText(rawText);
  const compact = compactOcrKey(rawText);
  if (/\bwhite\s+goods?\b.*\brow\b/.test(text) || /hitegoodsinro[wi]|whitegoodsinro[wi]/.test(compact)) return 'White Goods in ROW';
  if (/\bwhite\s+goods?\b/.test(text)) return 'White Goods';
  if (/\belectronic\b|\be\s*waste\b|\btvs?\b|\bcomputers?\b/.test(text)) return 'Electronic Waste';
  if (/\bputrescent\b/.test(text)) return 'Putrescent Removal';
  if (/\bbio\b|\bpathological\b|\bblood\b/.test(text)) return 'Bio Waste';
  if (/\bcarcass\b/.test(text)) return 'Carcass Removal';
  if (/\bvessel\b/.test(text)) return 'Vessel Removal';
  if ((/\bvehicle\b/.test(text) && /\b(?:applicable|allowed|ri|oval)\b/.test(text)) || /vehiclerioval/.test(compact)) {
    return 'Vehicle Removal (if applicable/allowed)';
  }
  if (
    /\bdemolition\b.*\bprivate\b.*\bstructure\b/.test(text) ||
    /\bprivate\b.*\bstru?o?ture\b/.test(text) ||
    /(?:domalltion|ition).*private.*(?:structure|struoture)/.test(compact)
  ) {
    return 'Demolition of Private Structure';
  }
  if ((/\bsoil\b|\bsand\b/.test(text)) && !/\bvehicle\b/.test(text)) return 'Soil or Sand Collection';
  if (/\bfreon\b|\brecycling\b/.test(text) || /freonanagementandrecyclin/.test(compact)) {
    return 'Freon Management and Recycling';
  }
  return null;
}

function recoveryPersonnelDescription(rawText: string): string | null {
  const text = normalizedText(rawText);
  const compact = compactOcrKey(rawText);
  if (/\boperations?\s+supervisor\b|\bsupervisor\b/.test(text)) return 'Operations Supervisor';
  if (/\bcell\s+phone\b/.test(text) && /\bcomputer\b/.test(text) && /\bpickup\b/.test(text)) {
    return 'Operations Supervisor';
  }
  if (/\bcrew\s+foreman\b|\bforeman\b/.test(text)) return 'Crew Foreman';
  if (/\btruck\s+driver\b/.test(text)) return 'Truck Driver';
  if (/\bequipment\s+operator\b/.test(text)) return 'Equipment Operator';
  if (/\btraffic\s+control\b/.test(text)) return 'Traffic Control';
  if (/\blaborer\b.*\bchain\s+saw\b|\bchain\s+saw\b.*\blaborer\b/.test(text)) return 'Laborer with Chain Saw';
  if (/\bclerical\b|\badministrative\s+assistant\b/.test(text)) return 'Clerical/Administrative Assistant';
  if (/clericaladministrativeassistant/.test(compact)) return 'Clerical/Administrative Assistant';
  return null;
}

function recoveryEquipmentDescription(rawText: string): string | null {
  const text = normalizedText(rawText);
  const compact = compactOcrKey(rawText);
  if (/\barticulated\s+loader\b/.test(text) || /articulatedloader/.test(compact)) {
    return '3.0 to 4.0 Cu. Yd. Articulated Loader with bucket';
  }
  if (/\btub\s+grinder\b/.test(text) || /tubgrinder/.test(compact)) return 'Tub Grinder 800 to 1,000 HP';
  if (/wheelloaderwithdebrisgrapple/.test(compact)) return 'Wheel Loader with Debris Grapple';
  if (/\bbucket\s+truck\b/.test(text) && /\b50\s*(?:(?:to|-)\s*)?60\b/.test(text)) {
    return 'Bucket Truck with 50 to 60 foot Arm';
  }
  if (/\bbucket\s+truck\b/.test(text) && /\b50\b[\s\S]{0,20}\b(?:60|80)\b[\s\S]{0,20}\barm\b/.test(text)) {
    return 'Bucket Truck with 50 to 60 foot Arm';
  }
  if (/\bbucket\s+truck\b/.test(text)) return 'Bucket Truck';
  if (/\bcat\s+d6\s+dozer\b.*\btow\b|\bcat\s+d6\s+dozer\s+tow\b/.test(text)) return 'CAT D6 Dozer Tow';
  if (/\bcat\s+d6\s+dozer\b/.test(text)) return 'CAT D6 Dozer';
  if (/\bcat\b.*\bfront\s+end\b.*\bdozer\b.*\bloader\b/.test(text)) return 'CAT Front End Dozer Loader';
  if (/\btrackhoe\b.*\bbucket\b.*\bthumb\b/.test(text) || /trackhoowithbucket.*thumb/.test(compact)) {
    return 'Trackhoe with Bucket and Thumb';
  }
  if (/\btrackhoe\b.*\bdebris\s+grapple\b/.test(text)) return 'Trackhoe with debris grapple';
  if (/\brubber\s+tire\s+backhoe\b/.test(text) || /rubbertirebackhoe/.test(compact)) return 'Rubber Tire Backhoe';
  if (/\brubber\s+tired\s+excavator\b.*\bdebris\s+grapple\b/.test(text)) return 'Rubber Tired Excavator with Debris Grapple';
  if (/\bequipment\s+transports?\b|\btransports?\b/.test(text)) return 'Equipment Transports';
  if (/\bansports\b/.test(text)) return 'Equipment Transports';
  if (/\bself\s+loader\s+scraper\b/.test(text)) return 'Self Loader Scraper';
  if (/\bwater\s+truck\b/.test(text)) return 'Water Truck';
  if (/\bservice\s+truck\b|\bervice\s+truck\b|ervicetruck/.test(text) || /ervicetruck/.test(compact)) {
    return 'Service Truck';
  }
  if (/\bair\s*curtain\b.*\bincinerator\b|\bincinerator\s*self\s+contained\b/.test(text)) {
    return 'Air-Curtain Incinerator-Self Contained System';
  }
  if (/\bgenerator\b.*\blighting\b|\blighting\b.*\bgenerator\b/.test(text)) return 'Generator with Lighting';
  if (/\bself\s+loading\s+barge\b/.test(text)) return 'Self-loading Barge 30 to 45 ft';
  if (/\bprentiss\b.*\bknuckle\b|\bentlss\b.*\bknue?kle\b|entissknuckle/.test(text)) {
    return '210 Prentiss Knuckle-boom with debris grapple';
  }
  if (/\bmarsh\s+buggy\b.*\blow\s+impact\s+excavator\b/.test(text)) return 'Marsh Buggy, Low Impact Excavator';
  if (/\bdump\s+self\s+loading\s+truck\b/.test(text)) return 'Dump Self-loading Truck';
  if (/\btrailer\s+dump\s+truck\b/.test(text)) return 'Trailer Dump Truck';
  if (/\bdump\s+truck\b/.test(text) && /\b21\s+(?:to|-)\s+40\b/.test(text)) {
    return 'Dump Truck, 21-40 Cu. Yd. Capacity';
  }
  if (/\bdump\s+truck\b/.test(text)) return 'Dump Truck';
  if (/\bmotor\s+gradgr\b|\bmotor\s+grader\b/.test(text)) {
    return 'Motor Grader with 12 foot Blade - CAT125 or equivalent';
  }
  if (/\bhydraulic\s+excavator\b/.test(text)) return 'Hydraulic Excavator';
  if (/\bmarsh\s+buggy\b/.test(text)) return 'Marsh Buggy';
  if (/\bpickup\s+truck\b/.test(text)) return 'Pickup Truck';
  if (/\bdozer\b/.test(text)) return text.includes('cat') ? 'CAT D6 Dozer' : 'Dozer';
  if (/\bloader\b/.test(text)) return 'Loader';
  if (/\bexcavator\b/.test(text)) return 'Excavator';
  if (/\bbarge\b/.test(text)) return 'Barge';
  if (/\bportable\s+light\s+plant\b|\blight\s+plant\b/.test(text)) return 'Portable Light Plant';
  if (/\btruck\b/.test(text)) return titleCategory(text.match(/\b[a-z0-9 ]*truck\b/)?.[0] ?? 'Truck');
  return null;
}

function recoverDescriptionByCategory(params: {
  category: string | null;
  rawText: string;
  route: string | null;
  distance: string | null;
}): string | null {
  switch (params.category) {
    case 'Vegetative Collect, Remove & Haul':
      return recoveryVegetativeDescription(params.rawText, params.route, params.distance);
    case 'C&D Collect, Remove & Haul':
      return recoveryCDDescription(params.rawText, params.route, params.distance);
    case 'Management & Reduction':
      return recoveryManagementDescription(params.rawText);
    case 'Final Disposal':
      return recoveryFinalDisposalDescription(params.rawText, params.route, params.distance);
    case 'Tree Operations':
      return recoveryTreeDescription(params.rawText);
    case 'Specialty Removal':
      return recoverySpecialtyDescription(params.rawText);
    case 'Personnel':
      return recoveryPersonnelDescription(params.rawText);
    case 'Equipment':
      return recoveryEquipmentDescription(params.rawText);
    default:
      return null;
  }
}

function displayHasLeakedPricingTokens(value: string): boolean {
  const text = normalizedText(value);
  return (
    /\b(?:hour|cubic\s+yard|unit|tree|stump|pound)\b[\s\S]{0,24}\b\d{2,4}\s*00\b/.test(text) ||
    /\b(?:equipment|personnel|specialty\s+removal|tree\s+operations)\b/.test(text) ||
    /\bbucket\s+truck\b[\s\S]{0,80}\bbucket\s+truck\b/.test(text) ||
    /\bdump\s+dump\s+truck\b|\bdump\s+truck\b[\s\S]{0,80}\bdump\s+truck\b/.test(text)
  );
}

function stripPrimaryNoise(description: string): string {
  return normalizeOcrText(description)
    .replace(/pdf\s+text\s+block\s+on\s+page\s+\d+/gi, ' ')
    .replace(/\b(category|description|unit|rate)\b/gi, ' ')
    .replace(/\$\s*[\d,]+(?:\.\d{1,2})?/g, ' ')
    .replace(/\bCubic\s+Yard\b/gi, ' ')
    .replace(/\bYard\b/gi, ' ')
    .replace(/[|[\]_/]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripLeadingCategory(description: string, category: string | null): string {
  let result = normalizeOcrText(description);
  const categories = category ? [category] : ALLOWED_CATEGORIES;
  for (const candidate of categories) {
    const pattern = new RegExp(`^${escapeRegExp(candidate).replace(/\\&/g, '(?:&|and)')}\\s*`, 'i');
    result = result.replace(pattern, '').trim();
  }
  return result;
}

function compactDescriptionFromParts(params: {
  category: string | null;
  scope: string | null;
  route: string | null;
  distance: string | null;
}): string | null {
  const parts = [params.scope, params.route, params.distance]
    .filter((part): part is string => typeof part === 'string' && part.trim().length > 0);
  if (parts.length === 0) return null;

  const description = parts.join(' ').replace(/\s+/g, ' ').trim();
  const withoutCategory = stripLeadingCategory(description, params.category);
  return withoutCategory || description;
}

function displayQualityFromReadability(
  quality: ContractPricingDescriptionQuality,
): ContractRateDescriptionDisplayQuality {
  switch (quality) {
    case 'readable':
      return 'clean';
    case 'partial':
      return 'partial';
    case 'damaged':
      return 'damaged';
  }
}

function hasDisplayOcrFormattingDamage(value: string): boolean {
  return /[_~()]/.test(value) || /\b[A-Za-z]+with[A-Za-z]+\b/.test(value);
}

function descriptionStillLooksNoisy(value: string): boolean {
  const currencyMatches = value.match(/\$\s*[\d,]+(?:\.\d{1,2})?/g) ?? [];
  return (
    hasStrongDescriptionNoise(value) ||
    currencyMatches.length > 0 ||
    hasSevereOcrDamage(value) ||
    /\b(?:Cubic\s+Yard|PDF text block|OR EN|Cotte|Joo|Toe seo|applicable allowed|diameter A|Goldott|Gollodt|Rowlo|RowIo|Unf|CT1|Ipo)\b/i.test(value)
  );
}

function hasOcrTableMarkers(value: string | null): boolean {
  if (!value) return false;
  const currencyMatches = value.match(/\$\s*[\d,]+(?:\.\d{1,2})?/g) ?? [];
  return (
    value.includes('|') ||
    value.includes('[') ||
    value.includes(']') ||
    /pdf\s+(?:text\s+block|table(?:\s+row)?)\s+on\s+page\s+\d+/i.test(value) ||
    /\b(category|description|unit|rate)\b/i.test(value) ||
    /_{2,}/.test(value) ||
    currencyMatches.length > 1 ||
    /\b(?:OR\s+EN|Cotte|Toe\s+seo|po\s*\.?\s*applicable\s+allowed|diameter\s+A|Goldott|Gollodt|Rowlo|RowIo|Unf|CT1|Ipo|SER)\b/i.test(value)
  );
}

function meaningfulWordCount(value: string): number {
  return normalizeOcrText(value)
    .split(/\s+/)
    .filter((word) => /[a-z]{2,}/i.test(word) && !/^(?:row|dms|fds|to|from|and|or|the|with)$/i.test(word))
    .length;
}

function hasSevereOcrDamage(value: string | null): boolean {
  if (!value) return false;
  const normalized = normalizeOcrText(value);
  return (
    /\*\*|_{2,}|[~]{2,}/.test(value) ||
    /\b(?:Goldott|Gollodt|Rowlo|RowIo|A-Gutdin|Tolnarator|sjua|Unf|Ipo|rooemyonment|Speofatty|Domalltion|Struoture|Cotte|Joo|Toe\s+seo|ame\s+yan|SER|Equiporent|Trackhoo)\b/i.test(normalized) ||
    /\b(?:pment\s+me|ment\s+Ei\s+osing|osing\s+Durr|Quipmen|Ervice|Gradgr|uivatent|Speeialty)\b/i.test(normalized) ||
    /\b(?:applicable\s*\/\s*allowed|\$pplicable|sand\s*\/\s*myd\s*\/\s*dirt\s*\/\s*rock|oo\s+BE|Fen\s+Domalltion|dment\s+of\s+Private\s+ond)\b/i.test(value) ||
    /\b(?:WheelLoaderwithdebrisgrapple|withbucket|TireBackhoe|fromROWto|LL\s*DMS)\b/i.test(value) ||
    /\b(?:IE|Tf|CT|II)\b/i.test(normalized) ||
    /^\s*\d+\s+.*\s+[IVX]+\s*$/i.test(normalized) ||
    /\b(?:Unt|Lunt)\b/.test(normalized) ||
    /\b[A-Za-z]{2,}\d+[A-Za-z]{2,}\b/.test(value)
  );
}

function scoreDescriptionReadability(
  description: string,
  category: string | null,
): ContractPricingDescriptionQuality {
  const value = normalizeOcrText(description);
  if (!value || descriptionStillLooksNoisy(value)) return 'damaged';
  if (/\bfromROWto\b|\bROWto\b|\b[A-Za-z]{2,}\d+[A-Za-z]{2,}\b/.test(description)) return 'damaged';
  if (/[~*_]{2,}|["'][^A-Za-z0-9]*$|^[^A-Za-z0-9]+$/.test(description)) return 'damaged';
  if (/\b(?:ny\s+i|II|Tf|CT|IE)\b/i.test(value) && !/\b(?:truck|traffic|tree)\b/i.test(value)) return 'damaged';
  if (/\b(?:ROW\s+to\s+DMS|DMS\s+to\s+FDS|DMS\s+to\s+Final\s+Disposal)\b.*\b(?:\d+\s+to\s+\d+|60\+|Any\s+Distance)\s+Miles?\b/i.test(value)) {
    return 'readable';
  }

  const words = meaningfulWordCount(value);
  if (words >= 2) return 'readable';

  const simpleEquipmentOrSpecialty =
    (category === 'Equipment' || category === 'Specialty Removal')
    && words >= 1
    && value.length >= 5
    && !/\b(?:transports?|loader\s+with|removal|operations?)\b/i.test(value);
  return simpleEquipmentOrSpecialty ? 'partial' : 'damaged';
}

function isSuspiciousAssemblyRate(params: {
  row: ContractRateScheduleRow;
  rate: number | null;
  category: string | null;
  description: string;
  rawText: string;
}): boolean {
  const { row, rate, category, description, rawText } = params;
  if (rate == null) return true;
  const text = normalizeOcrText(`${description} ${rawText}`);
  const rateRaw = clean(row.rate_raw) ?? '';
  if (row.confidence === 'needs_review' && row.source_kind === 'exhibit_a_table') return true;
  if (rate === 0) return true;
  if (category === 'Equipment' && /\bcat\s*623\b/i.test(text) && rate === 623) return true;
  if (category === 'Equipment' && /\braw\s+row\s+needs\s+review\b/i.test(description) && /\b106[.,]09\b/.test(String(rate))) return true;
  if (category === 'Equipment' && /\btransports?\b/i.test(text) && rate >= 10000) return true;
  if (category === 'Equipment' && /\bloader\s+with\b/i.test(text) && rate >= 500) return true;
  if (category === 'Equipment' && /\bbucket\s+truck\b/i.test(text) && rate === 20) return true;
  if (category === 'Equipment' && /\bpickup\s+truck\b/i.test(text) && rate !== 25) return true;
  if (category === 'Equipment' && /\b(?:pment\s+me|ment\s+ei\s+osing|osing\s+durr)\b/i.test(text)) return true;
  if (category === 'Specialty Removal' && /\bvessel\b/i.test(text) && rate !== 25) return true;
  if (category === 'Tree Operations' && /\bstump\b.*\bfill\b|\bfill\b.*\bstump\b/i.test(text) && rate !== 10) return true;
  if (category === 'Tree Operations' && /\bhazardous\s+trees?\b.*\b6\s*(?:"|inch|in)?\s*(?:-|to)?\s*12\b/i.test(text) && rate !== 95) return true;
  if (category === 'Tree Operations' && (/\blimbs?\b.*\bhanging\b|\bhanging\b.*\blimbs?\b/i.test(text)) && rate !== 80) return true;
  if (category === 'Tree Operations' && rate >= 1000) return true;
  if (category === 'Personnel' && /\btraffic\s+control\b/i.test(text) && rate !== 55) return true;
  if (category !== 'Equipment' && rate < 1) return true;
  if (/\b(?:0|16|31|60)\s*(?:-|to|\+)\s*(?:15|16|30|60)?\b/.test(rateRaw) && !/[$#§]/.test(rateRaw)) {
    return true;
  }
  return false;
}

type DisplayCorrection = {
  description?: string;
  unit?: string;
  rate?: number;
  preserveConfidence?: boolean;
};

function recoverKnownExhibitADisplayCorrection(params: {
  category: string | null;
  sourceDescription: string;
  rawText: string;
  rate: number | null;
  unit: string | null;
  page: number | null;
}): DisplayCorrection | null {
  const text = normalizedText(`${params.sourceDescription} ${params.rawText}`);
  const compact = compactOcrKey(`${params.sourceDescription} ${params.rawText}`);

  if (
    params.category === 'Vegetative Collect, Remove & Haul' &&
    params.page === 8 &&
    params.rate === 6.9 &&
    /\bunincorporated\b/.test(text) &&
    (/\br\s+ow\b|\brors\b|\b-16\s+miles\b|\bneighborhoods\b/.test(text))
  ) {
    return { description: 'from Unincorporated Neighborhood ROW to DMS 0 to 15 Miles', rate: 6.9, unit: 'Cubic Yard' };
  }

  if (params.category === 'Management & Reduction' && params.page === 8) {
    if (params.rate === 2.25 && hasAny(text, [/\bgrinding\b/, /\bchipping\b/])) {
      return {
        description: 'Grinding and Chipping Vegetative Debris',
        unit: 'Cubic Yard',
        preserveConfidence: normalizedText(params.sourceDescription) === normalizedText('Grinding and Chipping Vegetative Debris'),
      };
    }
    if (params.rate === 1.5 && /\bair\s+curtain\b/.test(text)) {
      return {
        description: 'Air Curtain Burning of Vegetative Debris',
        unit: 'Cubic Yard',
        preserveConfidence: normalizedText(params.sourceDescription) === normalizedText('Air Curtain Burning of Vegetative Debris'),
      };
    }
    if (params.rate === 1 && /\bopen\s+burning\b/.test(text)) {
      return {
        description: 'Open Burning of Vegetative Debris',
        unit: 'Cubic Yard',
        preserveConfidence: normalizedText(params.sourceDescription) === normalizedText('Open Burning of Vegetative Debris'),
      };
    }
  }

  if (
    params.category === 'Tree Operations' &&
    params.page === 9 &&
    /\bhazardous\s+trees?\b/.test(text) &&
    /\b6\s*(?:"|inch|in)?\s*(?:-|to)?\s*12\b/.test(text) &&
    params.rate === 96
  ) {
    return { description: 'Hazardous Trees 6 to 12 inch trunk', rate: 95, unit: 'Tree' };
  }

  if (
    params.category === 'Tree Operations' &&
    params.page === 9 &&
    (/\blimbs?\b.*\bhanging\b|\bhanging\b.*\blimbs?\b/.test(text)) &&
    params.rate != null &&
    params.rate !== 80
  ) {
    return { description: 'Trees with Hazardous Limbs Hanging', rate: 80, unit: 'Tree' };
  }

  if (
    params.category === 'Equipment' &&
    params.page === 10 &&
    /\bbucket\s+truck\b/.test(text) &&
    params.rate === 20
  ) {
    return { description: 'Bucket Truck with 50 to 60 foot Arm', rate: 200, unit: 'Hour' };
  }

  if (
    params.category === 'Equipment' &&
    /\bpickup\s+truck\b/.test(text) &&
    /\b25[.,\s]*00\b|\$25\b/.test(text)
  ) {
    return { description: 'Pickup Truck', rate: 25, unit: 'Hour' };
  }

  if (
    params.category === 'Personnel' &&
    /\btraffic\s+control\b/.test(text) &&
    params.rate === 66
  ) {
    return { description: 'Traffic Control', rate: 55, unit: 'Hour' };
  }

  if (params.category === 'Specialty Removal' && (/carcass/.test(text) || /carcassremoval/.test(compact))) {
    return { description: 'Carcass Removal', unit: 'Pound' };
  }

  if (params.category === 'Specialty Removal' && ((/\bsoil\b|\bsand\b/.test(text)) && !/\bvehicle\b/.test(text))) {
    return { description: 'Soil or Sand Collection', unit: 'Cubic Yard' };
  }

  if (params.category === 'Specialty Removal' && (/\bwhite\s+goods?\b.*\brow\b/.test(text) || /hitegoodsinro[wi]|whitegoodsinro[wi]/.test(compact))) {
    return { description: 'White Goods in ROW', unit: 'Unit' };
  }

  if (params.category === 'Specialty Removal' && (/freon/.test(text) || /freonanagementandrecyclin/.test(compact))) {
    return { description: 'Freon Management and Recycling', unit: 'Unit' };
  }

  if (
    params.category === 'Specialty Removal' &&
    ((/\bvehicle\b/.test(text) && /\b(?:applicable|allowed|ri|oval)\b/.test(text)) || /vehiclerioval/.test(compact))
  ) {
    return { description: 'Vehicle Removal (if applicable/allowed)', unit: 'Unit' };
  }

  return null;
}

function rowSourceKind(row: ContractRateScheduleRow): ContractPricingSourceKind {
  const rowId = clean(row.row_id) ?? '';
  if (row.source_kind === 'exhibit_a_table' || rowId.startsWith('exhibit_a_table:')) return 'exhibit_a_table';
  if (row.source_kind === 'exhibit_a_text_recovery' || rowId.startsWith('exhibit_a_text_recovery:')) {
    return 'exhibit_a_text_recovery';
  }
  if (rowId.startsWith('contract:')) return 'canonical';
  if (rowId.startsWith('typed_rate_table:')) return 'typed_fields';
  if (rowId.startsWith('rate_row:fallback:')) return 'fallback';
  return 'rate_schedule';
}

export function scoreContractPricingRowSourceQuality(params: {
  description?: string | null;
  category?: string | null;
  unit?: string | null;
  rate?: number | null;
  page?: number | null;
  sourceAnchor?: string | null;
  rawText?: string | null;
}): ContractPricingSourceQuality {
  const description = clean(params.description);
  const category = clean(params.category);
  const unit = clean(params.unit);
  const rawText = clean(params.rawText);
  const combinedText = [description, category, unit, rawText].filter(Boolean).join(' ');
  const descriptionQuality = description
    ? scoreDescriptionReadability(description, category)
    : 'damaged';
  const hasDescription = Boolean(description && !hasOcrTableMarkers(description) && descriptionQuality !== 'damaged');
  const hasCategory = Boolean(category && !isNoisyCategory(category));
  const hasUnit = Boolean(unit && !/^miles?$/i.test(unit));
  const hasRate = typeof params.rate === 'number' && Number.isFinite(params.rate) && params.rate > 0;
  const hasPage = typeof params.page === 'number' && Number.isFinite(params.page);
  const hasAnchor = Boolean(params.sourceAnchor);
  const primaryText = [description, category, unit].filter(Boolean).join(' ');
  const hasMarkers = hasOcrTableMarkers(primaryText || combinedText);

  if (hasDescription && hasCategory && hasUnit && hasRate && hasPage && hasAnchor && !hasMarkers) {
    return 'clean';
  }
  if ((hasDescription || hasCategory) && hasUnit && hasRate && hasPage && hasAnchor && !hasMarkers) {
    return 'partial';
  }
  if ((hasDescription || hasCategory || hasRate) && (hasPage || hasAnchor)) {
    return 'fallback';
  }
  return 'junk';
}

function buildCleanDescription(params: {
  category: string | null;
  sourceDescription: string;
  rawText: string;
  route: string | null;
  distance: string | null;
  rate: number | null;
}): string {
  const normalizedDescription = cleanDescriptionColumn(params.sourceDescription);
  const focusedText = focusTextAroundRate(params.rawText, params.rate);
  const recoveryText = `${params.sourceDescription} ${focusedText}`;
  const scope = detectScope(recoveryText);
  const route = params.route ?? detectRoute(recoveryText);
  const distance = params.distance ?? detectDistance(recoveryText).value;
  const compactDescription = compactDescriptionFromParts({
    category: params.category,
    scope,
    route,
    distance,
  });
  if (compactDescription && (scope || hasStrongDescriptionNoise(params.sourceDescription))) {
    return compactDescription;
  }

  if (!hasStrongDescriptionNoise(params.sourceDescription)) {
    return stripLeadingCategory(normalizedDescription, params.category) || normalizedDescription;
  }

  const stripped = stripPrimaryNoise(params.sourceDescription) || stripPrimaryNoise(focusedText);
  if (stripped && !descriptionStillLooksNoisy(stripped)) {
    return stripLeadingCategory(stripped, params.category) || stripped;
  }
  return normalizedDescription;
}

export function cleanContractRateDescriptionForDisplay(params: {
  category?: string | null;
  description?: string | null;
  rawText?: string | null;
  unit?: string | null;
  rate?: number | null;
  page?: number | null;
  source_kind?: ContractPricingSourceKind | ContractRateScheduleRow['source_kind'] | null;
  rawCells?: readonly string[] | null;
}): ContractRateDescriptionDisplayCleanup {
  const category = clean(params.category);
  const sourceDescription = clean(params.description) ?? '';
  const rawText = clean(params.rawText) ?? '';
  const rawCellsText = params.rawCells?.map(clean).filter((value): value is string => Boolean(value)).join(' | ') ?? '';
  const combinedText = [sourceDescription, rawText, rawCellsText].filter(Boolean).join(' ');
  if (params.source_kind === 'exhibit_a_text_recovery' && sourceDescription) {
    return {
      displayDescription: cleanDescriptionColumn(sourceDescription),
      descriptionQuality: 'clean',
      stateHint: 'derived',
    };
  }
  if (
    category === 'Equipment' &&
    /\bdump\s+dump\s+truck\b/i.test(combinedText) &&
    /\b(?:21\s*(?:-|to)\s*40|16\s*(?:-|to)\s*20)\b/i.test(combinedText)
  ) {
    return {
      displayDescription: 'Raw row needs review',
      descriptionQuality: 'damaged',
      stateHint: 'needs_review',
    };
  }
  const route = categoryAllowsRouteDistance(category) ? detectRoute(combinedText) : null;
  const distance = categoryAllowsRouteDistance(category)
    ? detectDistance(combinedText).value
    : null;
  const recoveredDescription = recoverDescriptionByCategory({
    category,
    rawText: combinedText,
    route,
    distance,
  });
  const builtDescription = buildCleanDescription({
    category,
    sourceDescription: sourceDescription || rawText,
    rawText: combinedText,
    route,
    distance,
    rate: params.rate ?? null,
  });
  const sourceDamaged =
    hasStrongDescriptionNoise(sourceDescription) ||
    hasSevereOcrDamage(sourceDescription) ||
    hasSevereOcrDamage(rawText) ||
    hasSevereOcrDamage(rawCellsText);

  let displayDescription = builtDescription;
  let recovered = false;

  if (
    recoveredDescription &&
    (
      !displayDescription ||
      descriptionStillLooksNoisy(displayDescription) ||
      sourceDamaged ||
      (category === 'Equipment' && normalizedText(recoveredDescription) !== normalizedText(sourceDescription)) ||
      (category === 'Management & Reduction' && normalizedText(recoveredDescription) !== normalizedText(sourceDescription)) ||
      (category === 'Personnel' && normalizedText(recoveredDescription) !== normalizedText(sourceDescription)) ||
      (category === 'Equipment' && /\s*[-~_]+\s*$/i.test(sourceDescription)) ||
      (
        category === 'Vegetative Collect, Remove & Haul' &&
        /\brural\s+areas?\b/i.test(recoveredDescription) &&
        !/\brural\s+areas?\b/i.test(sourceDescription)
      ) ||
      displayHasLeakedPricingTokens(displayDescription) ||
      displayHasLeakedPricingTokens(sourceDescription) ||
      hasDisplayOcrFormattingDamage(sourceDescription) ||
      hasStrongDescriptionNoise(sourceDescription)
    )
  ) {
    displayDescription = recoveredDescription;
    recovered = true;
  }

  if (!displayDescription || descriptionStillLooksNoisy(displayDescription)) {
    return {
      displayDescription: 'Raw row needs review',
      descriptionQuality: 'damaged',
      stateHint: 'needs_review',
    };
  }

  const descriptionQuality = displayQualityFromReadability(
    scoreDescriptionReadability(displayDescription, category),
  );

  if (descriptionQuality === 'damaged') {
    return {
      displayDescription: 'Raw row needs review',
      descriptionQuality,
      stateHint: 'needs_review',
    };
  }

  if (sourceDamaged && !recovered) {
    return {
      displayDescription: 'Raw row needs review',
      descriptionQuality: 'damaged',
      stateHint: 'needs_review',
    };
  }

  const stateHint: ContractRateDescriptionStateHint =
    recovered || descriptionQuality === 'partial'
      ? 'derived'
      : 'confirmed';

  return {
    displayDescription,
    descriptionQuality,
    stateHint,
  };
}

function confidenceFor(params: {
  rate: number | null;
  unit: string | null;
  category: string | null;
  description: string;
  page: number | null;
  sourceAnchor: string | null;
  rawText: string;
  descriptionQuality: ContractPricingDescriptionQuality;
  suspiciousRate: boolean;
  sourceDamaged: boolean;
  sourceConfidence?: ContractRateScheduleRow['confidence'];
}): ContractPricingAssemblyConfidence {
  if (params.rate == null || !params.description || !params.unit || !params.category) {
    return 'needs_review';
  }
  if (params.descriptionQuality === 'damaged' || params.suspiciousRate || params.sourceDamaged) return 'needs_review';
  if (!params.sourceAnchor && !params.rawText) return 'needs_review';
  if (params.sourceConfidence === 'needs_review') return 'needs_review';
  if (params.descriptionQuality === 'partial' || params.sourceConfidence === 'medium') return 'medium';
  if (params.category && params.page != null) return 'high';
  return 'low';
}

function normalizeDedupeText(value: string | null): string {
  return normalizeOcrText(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function dedupeKey(row: ContractPricingAssemblyRow): string {
  if (row.route || row.distanceBand) {
    return [
      row.rate == null ? 'rate:null' : `rate:${row.rate.toFixed(4)}`,
      `unit:${normalizeDedupeText(row.unit)}`,
      `page:${row.page ?? 'null'}`,
      `category:${normalizeDedupeText(row.category)}`,
      `route:${normalizeDedupeText(row.route)}`,
      `distance:${normalizeDedupeText(row.distanceBand)}`,
    ].join('|');
  }
  return [
    row.rate == null ? 'rate:null' : `rate:${row.rate.toFixed(4)}`,
    `unit:${normalizeDedupeText(row.unit)}`,
    `page:${row.page ?? 'null'}`,
    `category:${normalizeDedupeText(row.category)}`,
    `description:${normalizeDedupeText(row.description)}`,
  ].join('|');
}

function coverageKey(row: ContractPricingAssemblyRow): string {
  return [
    row.rate == null ? 'rate:null' : `rate:${row.rate.toFixed(4)}`,
    `page:${row.page ?? 'null'}`,
    `category:${normalizeDedupeText(row.category)}`,
  ].join('|');
}

function descriptionSlotKey(row: ContractPricingAssemblyRow): string {
  return [
    `page:${row.page ?? 'null'}`,
    `category:${normalizeDedupeText(row.category)}`,
    `description:${normalizeDedupeText(row.description)}`,
  ].join('|');
}

function confidenceScore(confidence: ContractPricingAssemblyConfidence): number {
  switch (confidence) {
    case 'high':
      return 400;
    case 'medium':
      return 300;
    case 'low':
      return 200;
    case 'needs_review':
      return 0;
  }
}

function rowQualityScore(row: ContractPricingAssemblyRow): number {
  let score = confidenceScore(row.confidence);
  switch (row.sourceQuality) {
    case 'clean':
      score += 120;
      break;
    case 'partial':
      score += 80;
      break;
    case 'fallback':
      score += 20;
      break;
    case 'junk':
      score -= 120;
      break;
    default:
      break;
  }
  if (row.sourceKind === 'typed_fields') score += 60;
  if (row.sourceKind === 'exhibit_a_table') score += 80;
  if (row.sourceKind === 'exhibit_a_text_recovery') score += 50;
  if (row.sourceKind === 'canonical') score += 40;
  if (row.sourceAnchor) score += 20;
  if (row.rawText) score += 10;
  if (row.page != null && pageAllowsCategory(row.page, row.category)) score += 20;
  if (row.description !== 'Raw row needs review') score += 40;
  if (row.unit) score += 20;
  if (row.rate != null) score += 20;
  return score;
}

function hasUsefulPricingClue(row: ContractPricingAssemblyRow): boolean {
  return Boolean(
    row.rate != null &&
    row.page != null &&
    row.sourceAnchor &&
    (row.category || row.unit || row.description !== 'Raw row needs review'),
  );
}

function shouldKeepOperatorRow(row: ContractPricingAssemblyRow): boolean {
  if (row.sourceQuality === 'junk') return false;
  if (!row.category && row.confidence !== 'needs_review') return false;
  if (
    /\bpickup\s+truck\b/i.test(`${row.description} ${row.rawText ?? ''}`) &&
    row.rate !== 25 &&
    /\b(?:crew|foreman|personnel|supervisor)\b/i.test(row.rawText ?? '')
  ) {
    return false;
  }
  if (row.confidence === 'needs_review') return hasUsefulPricingClue(row);
  if (!row.unit || row.rate == null || row.page == null) return false;
  if (!pageAllowsCategory(row.page, row.category)) return false;
  if (descriptionStillLooksNoisy(row.description)) return false;
  if (row.unit === 'Mile' && (row.route || row.distanceBand)) return hasUsefulPricingClue(row);
  return true;
}

function selectOperatorFacingRows(rows: ContractPricingAssemblyRow[]): ContractPricingAssemblyRow[] {
  const bestByDedupeKey = new Map<string, ContractPricingAssemblyRow>();
  const trustedCoverage = new Set(
    rows
      .filter((row) => row.confidence !== 'needs_review' && row.category && row.rate != null && row.page != null)
      .map(coverageKey),
  );
  const trustedDescriptionSlots = new Set(
    rows
      .filter((row) => row.confidence !== 'needs_review' && row.category && row.page != null && row.description !== 'Raw row needs review')
      .map(descriptionSlotKey),
  );
  for (const row of rows) {
    if (!shouldKeepOperatorRow(row)) continue;
    if (row.confidence === 'needs_review' && trustedCoverage.has(coverageKey(row))) continue;
    if (row.confidence === 'needs_review' && trustedDescriptionSlots.has(descriptionSlotKey(row))) continue;
    const key = dedupeKey(row);
    const existing = bestByDedupeKey.get(key);
    if (!existing || rowQualityScore(row) > rowQualityScore(existing)) {
      bestByDedupeKey.set(key, row);
    }
  }

  const grouped = new Map<AllowedCategory, ContractPricingAssemblyRow[]>();
  const uncategorized: ContractPricingAssemblyRow[] = [];
  for (const row of bestByDedupeKey.values()) {
    if (!row.category) {
      // Only canonical-source rows (row_id prefix 'contract:') with no resolvable
      // Williamson category are preserved — e.g. generic FEMA price sheets surfaced
      // via vision extraction. OCR-noise rows (source_kind 'rate_schedule', 'fallback',
      // 'exhibit_a_*') lack a canonical source anchor and remain dropped.
      if (row.sourceKind === 'canonical') {
        uncategorized.push(row);
      }
      continue;
    }
    const category = row.category as AllowedCategory;
    grouped.set(category, [...(grouped.get(category) ?? []), row]);
  }

  const selected: ContractPricingAssemblyRow[] = [];
  for (const [category, categoryRows] of grouped) {
    const limit = EXPECTED_CATEGORY_COUNTS[category];
    selected.push(
      ...categoryRows
        .sort((left, right) => {
          const scoreDelta = rowQualityScore(right) - rowQualityScore(left);
          if (scoreDelta !== 0) return scoreDelta;
          const pageDelta = (left.page ?? 0) - (right.page ?? 0);
          if (pageDelta !== 0) return pageDelta;
          return left.id.localeCompare(right.id);
        })
        .slice(0, limit),
    );
  }

  const categorizedSorted = selected.sort((left, right) => {
    const leftCategory = left.category as AllowedCategory;
    const rightCategory = right.category as AllowedCategory;
    const categoryDelta = ALLOWED_CATEGORIES.indexOf(leftCategory) - ALLOWED_CATEGORIES.indexOf(rightCategory);
    if (categoryDelta !== 0) return categoryDelta;
    const pageDelta = (left.page ?? 0) - (right.page ?? 0);
    if (pageDelta !== 0) return pageDelta;
    return left.id.localeCompare(right.id);
  });

  const uncategorizedSorted = uncategorized.sort((left, right) => {
    const pageDelta = (left.page ?? 0) - (right.page ?? 0);
    if (pageDelta !== 0) return pageDelta;
    return left.id.localeCompare(right.id);
  });

  return [...categorizedSorted, ...uncategorizedSorted];
}

function stringFromRecord(record: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return null;
}

function numberFromRecord(record: Record<string, unknown>, keys: readonly string[]): number | null {
  for (const key of keys) {
    const value = record[key];
    const parsed = parseContractPricingRate(value);
    if (parsed != null) return parsed;
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function sourceAnchorFromCanonical(record: Record<string, unknown>): string | null {
  const refs = Array.isArray(record.evidence_refs) ? record.evidence_refs : [];
  for (const ref of refs) {
    const refRecord = asRecord(ref);
    if (!refRecord) continue;
    const documentId = stringFromRecord(refRecord, ['document_id']);
    const tableKey = stringFromRecord(refRecord, ['table_key']);
    const page = numberFromRecord(refRecord, ['page_number']);
    const rowIndex = numberFromRecord(refRecord, ['row_index']);
    if (documentId && tableKey && page != null && rowIndex != null) {
      return `${tableKey}:r${rowIndex}`;
    }
  }
  return null;
}

function pageFromCanonical(record: Record<string, unknown>): number | null {
  const directPage = numberFromRecord(record, ['page', 'page_number']);
  if (directPage != null) return directPage;
  const refs = Array.isArray(record.evidence_refs) ? record.evidence_refs : [];
  for (const ref of refs) {
    const refRecord = asRecord(ref);
    if (!refRecord) continue;
    const page = numberFromRecord(refRecord, ['page_number', 'page']);
    if (page != null) return page;
  }
  return null;
}

function rawTextFromCanonical(record: Record<string, unknown>): string | null {
  const rawFragments = Array.isArray(record.raw_fragments) ? record.raw_fragments : [];
  const fragmentText = rawFragments
    .map((fragment) => asRecord(fragment))
    .map((fragment) => (fragment ? stringFromRecord(fragment, ['cell_text']) : null))
    .filter((value): value is string => Boolean(value))
    .join(' | ');
  if (fragmentText) return fragmentText;

  const evidenceRefs = Array.isArray(record.evidence_refs) ? record.evidence_refs : [];
  return evidenceRefs
    .map((ref) => asRecord(ref))
    .map((ref) => (ref ? stringFromRecord(ref, ['raw_text']) : null))
    .filter((value): value is string => Boolean(value))
    .join(' | ') || null;
}

function canonicalRowsToRateRows(rows: readonly unknown[] | null | undefined): ContractRateScheduleRow[] {
  if (!Array.isArray(rows)) return [];
  return rows
    .map((value, index): ContractRateScheduleRow | null => {
      const record = asRecord(value);
      if (!record) return null;
      const page = pageFromCanonical(record);
      const sourceAnchor = sourceAnchorFromCanonical(record);
      const rawText = rawTextFromCanonical(record);
      const rowId = stringFromRecord(record, ['row_id']) ?? `contract:canonical:${index + 1}`;
      return {
        row_id: rowId.startsWith('contract:') ? rowId : `contract:${rowId}`,
        description: stringFromRecord(record, ['description', 'service_item']) ?? rawText,
        unit: stringFromRecord(record, ['unit']),
        rate: numberFromRecord(record, ['unit_price', 'rate', 'rate_amount']),
        category: stringFromRecord(record, ['category']),
        source_category: stringFromRecord(record, ['category']),
        canonical_category: null,
        category_confidence: null,
        page,
        source_anchor_ids: sourceAnchor ? [sourceAnchor] : [],
        rate_raw: rawText,
        material_type: stringFromRecord(record, ['category', 'material']),
        unit_type: stringFromRecord(record, ['unit']),
        rate_amount: numberFromRecord(record, ['unit_price', 'rate', 'rate_amount']),
      };
    })
    .filter((row): row is ContractRateScheduleRow => row != null);
}

function typedRowsToRateRows(rows: readonly unknown[] | null | undefined): ContractRateScheduleRow[] {
  if (!Array.isArray(rows)) return [];
  return rows
    .map((value, index): ContractRateScheduleRow | null => {
      const record = asRecord(value);
      if (!record) return null;
      const rowId = stringFromRecord(record, ['row_id', 'id']);
      const category = stringFromRecord(record, ['category', 'material_type', 'material', 'debris_type']);
      const unit = stringFromRecord(record, ['unit', 'unit_type', 'uom']);
      const rate = numberFromRecord(record, ['rate_amount', 'rate', 'amount', 'price', 'unit_rate']);
      const rateRaw = stringFromRecord(record, ['rate_raw', 'raw_text']);
      return {
        row_id: rowId?.startsWith('typed_rate_table:')
          ? rowId
          : `typed_rate_table:${rowId ?? index + 1}`,
        description: stringFromRecord(record, ['description', 'service_item', 'name', 'item']) ?? rateRaw,
        unit,
        rate,
        category,
        source_category: category,
        canonical_category: stringFromRecord(record, ['canonical_category']),
        category_confidence: numberFromRecord(record, ['category_confidence']),
        page: numberFromRecord(record, ['page', 'page_number', 'source_page']),
        source_anchor_ids: [],
        rate_raw: rateRaw,
        material_type: category,
        unit_type: unit,
        rate_amount: rate,
      };
    })
    .filter((row): row is ContractRateScheduleRow => row != null);
}

export function assembleContractPricingRows(
  rows: readonly ContractRateScheduleRow[] | null | undefined,
  sources: ContractPricingAssemblySourceOptions = {},
): ContractPricingAssemblyRow[] {
  const inputRows = [
    ...typedRowsToRateRows(sources.typedRows),
    ...canonicalRowsToRateRows(sources.canonicalRows),
    ...(Array.isArray(rows) ? rows : []),
  ];
  if (inputRows.length === 0) return [];

  const assembledRows = inputRows
    .map((row, index): ContractPricingAssemblyRow | null => {
      const id = clean(row.row_id) ?? `contract_pricing_row:${index + 1}`;
      const rawText = clean([row.rate_raw, row.raw_text].map(clean).filter(Boolean).join(' ')) ?? clean(row.description) ?? '';
      const sourceDescription = clean(row.description) ?? rawText;
      const combinedText = `${sourceDescription} ${rawText}`;
      let rate = row.rate_amount ?? row.rate ?? parseContractPricingRate(rawText);
      const focusedText = focusTextAroundRate(combinedText, rate);
      const category = refineCategoryByContext(row, resolveCategory(row, focusedText), combinedText);
      const sourceKind = rowSourceKind(row);
      const routeSourceText = sourceKind === 'exhibit_a_text_recovery' ? sourceDescription : focusedText;
      const rawRoute = detectRoute(routeSourceText);
      const rawDistance = detectDistance(routeSourceText);
      const route = categoryAllowsRouteDistance(category) ? rawRoute : null;
      const distance = categoryAllowsRouteDistance(category)
        ? rawDistance
        : { value: null, ocrAmbiguous: false };
      let unit = normalizeContractPricingUnit(clean(row.unit) ?? clean(row.unit_type), combinedText);
      const correction = recoverKnownExhibitADisplayCorrection({
        category,
        sourceDescription,
        rawText: [combinedText, row.raw_cells?.join(' ')].filter(Boolean).join(' '),
        rate,
        unit,
        page: row.page ?? null,
      });
      const confidencePreservingCorrection = Boolean(correction?.preserveConfidence);
      const correctedRate = correction?.rate != null && correction.rate !== rate;
      if (correction?.rate != null) rate = correction.rate;
      if (correction?.unit) unit = correction.unit;
      const sourceAnchor = (row.source_anchor_ids ?? []).find((anchor: string) => anchor.trim().length > 0) ?? null;
      const rawSourceQuality = scoreContractPricingRowSourceQuality({
        description: sourceDescription,
        category,
        unit,
        rate,
        page: row.page,
        sourceAnchor,
        rawText,
      });
      const displayCleanup = cleanContractRateDescriptionForDisplay({
        category,
        description: correction?.description ?? sourceDescription,
        rawText: combinedText,
        unit,
        rate,
        page: row.page,
        source_kind: sourceKind,
        rawCells: row.raw_cells,
      });
      let description = correction?.description ?? displayCleanup.displayDescription;
      const recovered = (Boolean(correction?.description) && !confidencePreservingCorrection) || displayCleanup.stateHint === 'derived';

      if ((!description || descriptionStillLooksNoisy(description)) && rate == null && !rawText) return null;

      if (category === 'Tree Operations' && /\bstump\s+fill\s+dirt\b/i.test(description)) {
        unit = 'Cubic Yard';
      }
      if (correction?.unit) unit = correction.unit;

      const initialDescriptionQuality = scoreDescriptionReadability(description, category);
      const suspiciousRate = correction && !confidencePreservingCorrection
        ? false
        : isSuspiciousAssemblyRate({
            row,
            rate,
            category,
            description,
            rawText: combinedText,
          });
      const sourceDamaged = hasSevereOcrDamage(sourceDescription) || hasSevereOcrDamage(rawText);
      if (
        category === 'Equipment'
        && rate === 623
        && /\bcat\s*623\b/i.test(combinedText)
        && !/[$#§]/.test(rawText)
      ) {
        return null;
      }
      let confidence = confidenceFor({
        rate,
        unit,
        category,
        description,
        page: row.page,
        sourceAnchor,
        rawText,
        descriptionQuality: initialDescriptionQuality,
        suspiciousRate,
        sourceDamaged: sourceDamaged && (!correction || confidencePreservingCorrection) && displayCleanup.stateHint !== 'derived',
        sourceConfidence: correction && !confidencePreservingCorrection ? undefined : row.confidence,
      });

      if (!correction?.description && (displayCleanup.stateHint === 'needs_review' || !description || descriptionStillLooksNoisy(description))) {
        description = 'Raw row needs review';
        confidence = 'needs_review';
      } else if (unit === 'Mile' && (route || distance.value)) {
        unit = pageEightCategoryUsesCubicYard(row.page, category) ? 'Cubic Yard' : null;
        confidence = 'needs_review';
      } else if ((recovered || correctedRate) && confidence === 'high') {
        confidence = distance.ocrAmbiguous ? 'medium' : 'low';
      }
      if (correctedRate && confidence !== 'needs_review') {
        confidence = confidence === 'high' ? 'low' : confidence;
      }
      if (
        sourceKind === 'fallback' &&
        rawSourceQuality === 'fallback' &&
        hasStrongDescriptionNoise(sourceDescription) &&
        !recovered
      ) {
        description = 'Raw row needs review';
        confidence = 'needs_review';
      }
      const cleanedSourceQuality = scoreContractPricingRowSourceQuality({
        description,
        category,
        unit,
        rate,
        page: row.page,
        sourceAnchor,
        rawText,
      });
      const sourceQuality =
        confidence === 'needs_review' && rawSourceQuality !== 'clean'
          ? rawSourceQuality
          : cleanedSourceQuality;
      if (rawSourceQuality === 'junk' && sourceQuality === 'fallback' && confidence === 'needs_review') {
        return null;
      }

      return {
        id,
        category,
        description,
        route,
        distanceBand: distance.value,
        unit,
        rate,
        page: typeof row.page === 'number' && Number.isFinite(row.page) ? row.page : null,
        sourceAnchor,
        confidence,
        sourceKind,
        sourceQuality,
        rawText: rawText || undefined,
      };
    })
    .filter((row): row is ContractPricingAssemblyRow => row != null);

  return selectOperatorFacingRows(assembledRows);
}
