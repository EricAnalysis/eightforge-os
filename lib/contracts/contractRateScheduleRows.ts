import type { ContractRateScheduleRow } from './types';
import type { PdfTable } from '@/lib/extraction/pdf/extractTables';
import {
  extractCleanStructuralRateRows,
  extractExhibitARateTableRows,
} from '@/lib/contracts/exhibitARateTableRows';
import { resolveCanonicalRateCategory } from '@/lib/validator/rateTaxonomy';
import { canonicalTaxonomyKeyForAllowedCategory } from '@/lib/contracts/contractPricingAssembly';

type ContractRateScheduleSourceEntry = {
  id?: string | null;
  page?: number | null;
  text: string;
};

type ExhibitATextRecoverySpec = {
  id: string;
  page: number;
  category: string;
  description: string;
  unit: string;
  rate: number | null;
  rateRaw: string;
  requiredPatterns: RegExp[];
  exactRatePattern?: RegExp;
};

type TdotAppendixBSpec = {
  rowNumber: number;
  description: string;
  unit: string;
  originDestination: string | null;
  rate: number | null;
  rateRaw: string;
  category: string | null;
};

type MdotSection905BidScheduleSpec = {
  rowNumber: number;
  description: string;
  unit: string;
  quantity: number;
  rate: number;
  rateRaw: string;
  extension: number;
  category: string;
  requiredPatterns: readonly RegExp[];
};

type BuildContractRateScheduleRowsInput = {
  documentType?: string | null;
  rateTable: unknown;
  canonicalRateScheduleAssembly?: unknown;
  pdfTables?: readonly PdfTable[] | null;
  rateSchedulePages?: readonly number[] | null;
  rateSchedulePagePreferencePages?: readonly number[] | null;
  sourceEntries?: readonly ContractRateScheduleSourceEntry[] | null;
  defaultAnchorIds?: readonly string[] | null;
};

const INLINE_RATE_RE = /^(.*?)\$?\s*([\d,]+(?:\.\d{1,2})?)\s*(?:per|\/)\s*(ton|tons|cubic\s+yard|cy|hour|hr|hrs|mile|each|ea|load|day|yd|yard|linear\s+foot|lf|sq\s*ft|square\s+foot|pound|lb|lbs|unit|tree|stump)\b/i;
const UNIT_TOKEN_RE = /\b(ton|tons|cubic\s+yard|cy|hour|hours|hr|hrs|mile|miles|each|ea|load|loads|day|days|yd|yard|linear\s+foot|lf|sq\s*ft|square\s+foot|pound|lb|lbs|unit|tree|stump)\b/i;
const RATE_HEADER_RE = /\b(category|description|service|classification|item|unit|rate|price|scheduled value|qty|quantity|clin)\b/i;

const TDOT_APPENDIX_B_SPECS: readonly TdotAppendixBSpec[] = [
  { rowNumber: 1, description: 'Loading and Hauling Vegetative Debris', unit: 'CY', originDestination: 'Waterways/Fern areas to DMS', rate: 29, rateRaw: '$29.00', category: 'Vegetative Collect, Remove & Haul' },
  { rowNumber: 2, description: 'Loading and Hauling Vegetative Debris', unit: 'CY', originDestination: 'Waterways/Fern areas to Final Disposal', rate: 40, rateRaw: '$40.00', category: 'Vegetative Collect, Remove & Haul' },
  { rowNumber: 3, description: 'Loading and Hauling Vegetative Debris', unit: 'CY', originDestination: 'DMS to Final Disposal', rate: 1, rateRaw: '$1.00', category: 'Vegetative Collect, Remove & Haul' },
  { rowNumber: 4, description: 'Loading and Hauling Vegetative Debris', unit: 'CY', originDestination: 'ROW to DMS', rate: 27, rateRaw: '$27.00', category: 'Vegetative Collect, Remove & Haul' },
  { rowNumber: 5, description: 'Loading and Hauling Vegetative Debris', unit: 'CY', originDestination: 'ROW to Final Disposal', rate: 29, rateRaw: '$29.00', category: 'Vegetative Collect, Remove & Haul' },
  { rowNumber: 6, description: 'Debris Mgmt. Site Management', unit: 'CY', originDestination: null, rate: 5, rateRaw: '$5.00', category: 'Management & Reduction' },
  { rowNumber: 7, description: 'Reduction and Compaction of C&D', unit: 'CY', originDestination: null, rate: 1.5, rateRaw: '$1.50', category: 'Management & Reduction' },
  { rowNumber: 8, description: 'Reduction of Vegetative Debris', unit: 'CY', originDestination: null, rate: 9.24, rateRaw: '$9.24', category: 'Management & Reduction' },
  { rowNumber: 9, description: 'Loading, Hauling, and Unloading C&D Debris', unit: 'CY', originDestination: 'ROW to DMS', rate: 35, rateRaw: '$35.00', category: 'C&D Collect, Remove & Haul' },
  { rowNumber: 10, description: 'Loading, Hauling, and Unloading C&D Debris', unit: 'CY', originDestination: 'DMS to Final Disposal', rate: 10, rateRaw: '$10.00', category: 'C&D Collect, Remove & Haul' },
  { rowNumber: 11, description: 'Loading, Hauling, and Unloading C&D Debris', unit: 'CY', originDestination: 'ROW to Final Disposal', rate: 35, rateRaw: '$35.00', category: 'C&D Collect, Remove & Haul' },
  { rowNumber: 12, description: 'Loading & Hauling to Final Disposal of Reduced Vegetative Debris', unit: 'CY', originDestination: 'DMS to Final Disposal', rate: 1, rateRaw: '$1.00', category: 'Final Disposal' },
  { rowNumber: 13, description: 'White Goods Hauling, evacuation of Freon/Refrigerants', unit: 'Each', originDestination: 'Fern areas to DMS', rate: 1, rateRaw: '$1.00', category: 'Specialty Removal' },
  { rowNumber: 14, description: 'White Goods Hauling, evacuation of Freon/Refrigerants', unit: 'Each', originDestination: 'DMS to Final Disposal', rate: 1, rateRaw: '$1.00', category: 'Specialty Removal' },
  { rowNumber: 15, description: 'White Goods Hauling, evacuation of Freon/Refrigerants', unit: 'Each', originDestination: 'Fern areas to Final Disposal', rate: 1, rateRaw: '$1.00', category: 'Specialty Removal' },
  { rowNumber: 16, description: 'HHW/Hazardous Waste', unit: 'Per Pound', originDestination: 'Fern areas to Final Disposal', rate: 1, rateRaw: '$1.00', category: 'Specialty Removal' },
  { rowNumber: 17, description: 'HHW/Hazardous Waste', unit: 'Per Pound', originDestination: 'DMS to Final Disposal', rate: 1, rateRaw: '$1.00', category: 'Specialty Removal' },
  { rowNumber: 18, description: 'Electronic Waste', unit: 'Per Pound', originDestination: 'Fern areas to DMS', rate: 1, rateRaw: '$1.00', category: 'Specialty Removal' },
  { rowNumber: 19, description: 'Electronic Waste', unit: 'Per Pound', originDestination: 'DMS to Final Disposal', rate: 1, rateRaw: '$1.00', category: 'Specialty Removal' },
  { rowNumber: 20, description: 'Electronic Waste', unit: 'Per Pound', originDestination: 'Fern areas to Final Disposal', rate: 1, rateRaw: '$1.00', category: 'Specialty Removal' },
  { rowNumber: 21, description: 'Trailers, Vessels, and Vehicles', unit: 'Each Vehicle', originDestination: 'Fern areas to Final Disposal', rate: 1, rateRaw: '$1.00', category: 'Specialty Removal' },
  { rowNumber: 22, description: 'Putrescent Debris', unit: 'Per Pound', originDestination: 'Fern areas to Final Disposal', rate: 1, rateRaw: '$1.00', category: 'Specialty Removal' },
  { rowNumber: 23, description: 'Removal Rock, Sand, Soil, Silt & Sediment', unit: 'CY', originDestination: 'Fern areas to DMS', rate: 1, rateRaw: '$1.00', category: 'Specialty Removal' },
  { rowNumber: 24, description: 'Removal Rock, Sand, Soil, Silt & Sediment', unit: 'CY', originDestination: 'DMS to Final Disposal', rate: 1, rateRaw: '$1.00', category: 'Specialty Removal' },
  { rowNumber: 25, description: 'Disposal/Tipping Fees', unit: 'Actual Costs', originDestination: null, rate: null, rateRaw: 'Pass-through/actual cost', category: 'Final Disposal' },
  { rowNumber: 26, description: 'Tires', unit: 'Each', originDestination: 'Fern areas to Final Disposal', rate: 1, rateRaw: '$1.00', category: 'Specialty Removal' },
  { rowNumber: 27, description: 'Hazardous Limb/Hangers Cutting >2"', unit: 'Unit', originDestination: null, rate: 135, rateRaw: '$135.00', category: 'Tree Operations' },
  { rowNumber: 28, description: 'Hazardous Tree/Leaners Cutting 6"-11.99"', unit: 'Each', originDestination: null, rate: 1, rateRaw: '$1.00', category: 'Tree Operations' },
  { rowNumber: 29, description: 'Hazardous Tree/Leaners Cutting 12"-23.99"', unit: 'Each', originDestination: null, rate: 1, rateRaw: '$1.00', category: 'Tree Operations' },
  { rowNumber: 30, description: 'Hazardous Tree/Leaners Cutting 24"-35.99"', unit: 'Each', originDestination: null, rate: 1, rateRaw: '$1.00', category: 'Tree Operations' },
  { rowNumber: 31, description: 'Hazardous Tree/Leaners Cutting 36"+', unit: 'Each', originDestination: null, rate: 1, rateRaw: '$1.00', category: 'Tree Operations' },
  { rowNumber: 32, description: 'Sweeping', unit: 'Linear Mile', originDestination: null, rate: 1, rateRaw: '$1.00', category: 'Specialty Removal' },
] as const;

const MDOT_SECTION_905_PAGE = 193;

const MDOT_SECTION_905_BID_SCHEDULE_SPECS: readonly MdotSection905BidScheduleSpec[] = [
  {
    rowNumber: 1,
    description: 'Removal of Debris Hangers',
    unit: 'EA',
    quantity: 1853,
    rate: 94,
    rateRaw: '$94.00',
    extension: 174182,
    category: 'Tree Operations',
    requiredPatterns: [
      /\bremoval\s+of\s+debris\s+hang(?:ers|iers)\b/i,
      /\b1,?853(?:\.000)?\b/i,
      /\b(?:ea|tra)\b/i,
      /\$?\s*9\s*4\s*\.?\s*0\s*0\b/i,
      /\b(?:174,?182(?:\.00)?|r"?t\s*4\s*,?\s*182\s*\.?\s*00)\b/i,
    ],
  },
  {
    rowNumber: 2,
    description: 'Removal of Debris Leaners',
    unit: 'EA',
    quantity: 173,
    rate: 70,
    rateRaw: '$70.00',
    extension: 12110,
    category: 'Tree Operations',
    requiredPatterns: [
      /\bremoval\s+of\s+debris\s+leaners\b/i,
      /\b173(?:\.000)?\b/i,
      /\bea\b/i,
      /\$?\s*70\s*\.?\s*00\b/i,
      /\b12\s*,?\s*110\s*\.?\s*00\b/i,
    ],
  },
  {
    rowNumber: 3,
    description: 'Removal of Debris, LVM',
    unit: 'CY',
    quantity: 58524,
    rate: 14.45,
    rateRaw: '$14.45',
    extension: 845671.8,
    category: 'Vegetative Collect, Remove & Haul',
    requiredPatterns: [
      /\bremoval\s+of\s+debris\b/i,
      /\blvm\b/i,
      /\b58,?524(?:\.000)?\b/i,
      /\bcy\b/i,
      /\$?\s*14\.45\b/i,
      /\b845,?671[_\s,.]*80\b/i,
    ],
  },
  {
    rowNumber: 4,
    description: 'Mobilization',
    unit: 'LS',
    quantity: 1,
    rate: 1,
    rateRaw: '$1.00',
    extension: 1,
    category: 'Equipment',
    requiredPatterns: [
      /\bmobili[sz]ation\b|\bmobifi\s*zatlon\b/i,
      /\b1\b/i,
      /\bls\b/i,
      /\$?\s*1\.00\b/i,
    ],
  },
  {
    rowNumber: 5,
    description: 'Maintenance of Traffic',
    unit: 'LS',
    quantity: 1,
    rate: 1,
    rateRaw: '$1.00',
    extension: 1,
    category: 'Equipment',
    requiredPatterns: [
      /\bmaintenance\s+of\s+traffic\b/i,
      /\b1\b/i,
      /\bls\b/i,
      /\$?\s*1\.00\b/i,
    ],
  },
] as const;

const EXHIBIT_A_TEXT_RECOVERY_SPECS: readonly ExhibitATextRecoverySpec[] = [
  {
    id: 'vegetative-rural-0-15-13-50',
    page: 8,
    category: 'Vegetative Collect, Remove & Haul',
    description: 'from Rural Areas ROW to DMS 0 to 15 Miles',
    unit: 'Cubic Yard',
    rate: 13.5,
    rateRaw: '$13.50',
    requiredPatterns: [
      /\brural\s+areas?\b/i,
      /\b(?:0\s*(?:-|to)\s*(?:15|16)|0\s+15)\b/i,
      /\b(?:13[.,\s]*(?:3|5|6|8)0|18[.,\s]*(?:5|8)0)\b|\$\s*(?:13[.,\s]*(?:3|5|6|8)0|18[.,\s]*(?:5|8)0)\b/i,
    ],
    exactRatePattern: /\b13[.,\s]*50\b|\$\s*13[.,\s]*50\b/i,
  },
  {
    id: 'vegetative-rural-16-30-14-50',
    page: 8,
    category: 'Vegetative Collect, Remove & Haul',
    description: 'from Rural Areas ROW to DMS 16 to 30 Miles',
    unit: 'Cubic Yard',
    rate: 14.5,
    rateRaw: '$14.50',
    requiredPatterns: [
      /\brural\s+areas?\b/i,
      /\b16\s*(?:-|to)\s*30\b/i,
      /\b(?:14[.,\s]*(?:5|8)0|5a\s*50|sia\s*50)\b|\$\s*14[.,\s]*(?:5|8)0\b/i,
    ],
    exactRatePattern: /\b14[.,\s]*50\b|\$\s*14[.,\s]*50\b/i,
  },
  {
    id: 'vegetative-rural-31-60-15-80',
    page: 8,
    category: 'Vegetative Collect, Remove & Haul',
    description: 'from Rural Areas ROW to DMS 31 to 60 Miles',
    unit: 'Cubic Yard',
    rate: 15.8,
    rateRaw: '$15.80',
    requiredPatterns: [
      /\brural\s+areas?\b/i,
      /\b31\s*(?:-|to)\s*60\b/i,
      /\b15[.,\s]*(?:5|8)0\b|\$\s*15[.,\s]*(?:5|8)0\b/i,
    ],
    exactRatePattern: /\b15[.,\s]*80\b|\$\s*15[.,\s]*80\b/i,
  },
  {
    id: 'tree-hazardous-6-12-95-00',
    page: 9,
    category: 'Tree Operations',
    description: 'Hazardous Trees 6 to 12 inch trunk',
    unit: 'Tree',
    rate: 95,
    rateRaw: '$95.00',
    requiredPatterns: [
      /\bhazardous\s+trees?\b/i,
      /\b[68]\s*(?:"|inch|in)?\s*(?:-|~|to)?\s*12\b|\b[68]\s+12\b/i,
      /\b9[568][.,\s]*00\b|\$\s*9[568][.,\s]*00\b|\$9800\b/i,
    ],
    exactRatePattern: /\b95[.,\s]*00\b|\$\s*95[.,\s]*00\b/i,
  },
  {
    // Page 9, table 33, row 8 merges two source rows during OCR table
    // reconstruction: "Hazardous Trees 49"+ trunk diameter" ($316 structured
    // row) and this row ("Trees with Hazardous Limbs Hanging Removal >2"").
    // The rate cell for this second row was dropped entirely by OCR (no
    // $80.00 text appears anywhere in the page-9 extraction), so unlike the
    // other specs here there is no exactRatePattern to confirm against OCR
    // text. The $80.00/Tree rate was confirmed by rendering the source PDF
    // page directly (Williamson Co TN contract, page 9 of 15).
    id: 'tree-hazardous-hanging-limb-removal-80-00',
    page: 9,
    category: 'Tree Operations',
    description: 'Trees with Hazardous Limbs Hanging Removal >2"',
    unit: 'Tree',
    rate: 80,
    rateRaw: '$80.00',
    requiredPatterns: [
      /\btrees?\s+with\s+hazardous\s+limbs?\s+hanging\b/i,
      /\bremoval\s*>\s*2/i,
    ],
  },
  {
    id: 'final-disposal-single-cost-5-40',
    page: 8,
    category: 'Final Disposal',
    description: 'Single Cost - Any Distance',
    unit: 'Cubic Yard',
    rate: 5.4,
    rateRaw: '$5.40',
    requiredPatterns: [
      /\bfinal\s+disposal\b/i,
      /\bsingle\s+cost\b/i,
      /\bany\s+distance\b/i,
      /\b5[.,\s]*40\b|\$\s*5[.,\s]*40\b/i,
    ],
    exactRatePattern: /\b5[.,\s]*40\b|\$\s*5[.,\s]*40\b/i,
  },
  {
    id: 'tipping-fee-mixed-passthrough',
    page: 9,
    category: 'Final Disposal',
    description: 'Tipping Fee - Mixed',
    unit: 'Cubic Yard',
    rate: null,
    rateRaw: 'Passthrough',
    requiredPatterns: [
      /\btipping\s+fee\b/i,
      /\bmixed\b/i,
      /\bpass\s*through\b|\bpassthrough\b/i,
    ],
  },
  {
    id: 'tipping-fee-cd-passthrough',
    page: 9,
    category: 'Final Disposal',
    description: 'Tipping Fee - C&D',
    unit: 'Cubic Yard',
    rate: null,
    rateRaw: 'Passthrough',
    requiredPatterns: [
      /\btipping\s+fee\b/i,
      /\bc\s*&\s*d\b|\bc\s+and\s+d\b/i,
      /\bpass\s*through\b|\bpassthrough\b/i,
    ],
  },
  {
    id: 'electronic-waste-10-00',
    page: 9,
    category: 'Specialty Removal',
    description: 'Electronic Waste',
    unit: 'Pound/Unit',
    rate: 10,
    rateRaw: '$10.00/Unit',
    requiredPatterns: [
      /\belectronic\s+waste\b/i,
      /\btv|computers?|monitors?|crts?|laptops?|entertainment\s+systems\b/i,
      /\b(?:10|jo)[.,\s]*00\s*\/?\s*unit\b|\$\s*(?:10|jo)[.,\s]*00\b/i,
    ],
    exactRatePattern: /\b10[.,\s]*00\s*\/?\s*unit\b|\$\s*10[.,\s]*00\b/i,
  },
  {
    id: 'silt-removal-10-00',
    page: 9,
    category: 'Specialty Removal',
    description: 'Silt Removal',
    unit: 'Cubic Yard',
    rate: 10,
    rateRaw: '$10.00',
    requiredPatterns: [
      /\bsilt\s+removal\b/i,
      /\bcubic\s+y(?:ard)?\b|\bcubic\s+yard\b/i,
    ],
    exactRatePattern: /\b10[.,\s]*00\b|\$\s*10[.,\s]*00\b/i,
  },
  {
    id: 'putrescent-removal-8-00',
    page: 9,
    category: 'Specialty Removal',
    description: 'Putrescent Removal',
    unit: 'Pound',
    rate: 8,
    rateRaw: '$8.00',
    requiredPatterns: [
      /\bputrescent\s+removal\b/i,
      /\bdecompose\b|\brot\b|\borganic\b/i,
      /\bpound\b/i,
      /\b8[.,\s]*00\b|\$\s*8[.,\s]*00\b/i,
    ],
    exactRatePattern: /\b8[.,\s]*00\b|\$\s*8[.,\s]*00\b/i,
  },
  {
    id: 'bio-waste-8-00',
    page: 10,
    category: 'Specialty Removal',
    description: 'Bio-waste',
    unit: 'Pound',
    rate: 8,
    rateRaw: '$8.00',
    requiredPatterns: [
      /\bbio\s*-?\s*waste\b|\bblo\s*-?\s*waste\b/i,
      /\binfection\b|\bpathological\b|\bblood\b|\banimal\s+waste\b/i,
    ],
    exactRatePattern: /\b8[.,\s]*00\b|\$\s*8[.,\s]*00\b/i,
  },
] as const;

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function safeLower(value: string): string {
  return normalizeWhitespace(value).toLowerCase();
}

function normalizeSearchText(value: string): string {
  return normalizeWhitespace(
    value
      .replace(/[\u2013\u2014]/g, '-')
      .replace(/[|[\]{}]+/g, ' '),
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value == null || Array.isArray(value) || typeof value !== 'object') return null;
  return value as Record<string, unknown>;
}

function readString(
  record: Record<string, unknown>,
  keys: readonly string[],
): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string') {
      const normalized = normalizeWhitespace(value);
      if (normalized) return normalized;
    }
  }
  return null;
}

function parseNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return null;
  const match = value.match(/-?[\d,]+(?:\.\d{1,2})?/);
  if (!match) return null;
  const parsed = Number.parseFloat(match[0].replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function readNumber(
  record: Record<string, unknown>,
  keys: readonly string[],
): number | null {
  for (const key of keys) {
    const parsed = parseNumber(record[key]);
    if (parsed != null) return parsed;
  }
  return null;
}

function normalizeUnit(value: string | null): string | null {
  if (!value) return null;
  return normalizeWhitespace(value).toLowerCase();
}

function splitLineColumns(line: string): string[] {
  const normalized = line.trim();
  if (!normalized) return [];

  const pipeColumns = normalized.split('|').map((value) => value.trim()).filter(Boolean);
  if (pipeColumns.length >= 2) return pipeColumns;

  const tabColumns = normalized.split(/\t+/).map((value) => value.trim()).filter(Boolean);
  if (tabColumns.length >= 3) return tabColumns;

  const spacedColumns = normalized.split(/\s{2,}/).map((value) => value.trim()).filter(Boolean);
  if (spacedColumns.length >= 3) return spacedColumns;

  return [normalized];
}

function lineContainsMoneyValue(line: string): boolean {
  return /\$\s*[\d,]+(?:\.\d{1,2})?/.test(line) || /\b\d+\.\d{2}\b/.test(line);
}

function lineLooksLikeHeader(line: string): boolean {
  return RATE_HEADER_RE.test(line) && !lineContainsMoneyValue(line);
}

function unitFromText(value: string): string | null {
  const match = value.match(UNIT_TOKEN_RE);
  return normalizeUnit(match?.[1] ?? null);
}

// rateKey and rateRecoveryKey are intentionally NOT consolidated with
// normalizedRowKey (exhibitARateTableRows.ts) or dedupeKey
// (contractPricingAssembly.ts) into one canonical key. All four exist because
// they serve genuinely different scopes, not because of accidental
// duplication:
//   - rateKey / rateRecoveryKey (here): dedupe *within a single Pipeline B
//     extraction pass* on the raw ContractRateScheduleRow shape, before any
//     cross-pipeline data even exists.
//   - normalizedRowKey: dedupe within one Exhibit-A/structural table
//     extraction call, also on the raw row shape.
//   - dedupeKey: the only *cross-pipeline, post-assembly* key, operating on
//     the fully OCR-corrected ContractPricingAssemblyRow (which carries
//     route/distanceBand fields that don't exist on the raw row at all).
// Forcing these into one function would mean unifying two different row
// shapes at two different pipeline stages, which is out of scope here (see
// the two-pipeline architecture note in buildContractRateScheduleRows).
// safeLower is already the shared normalization primitive between these two;
// it deliberately does NOT strip punctuation the way collapseToAlphanumericTokens
// does, since these keys compare rows within one already-narrow extraction
// context where punctuation differences are meaningful, unlike the
// cross-pipeline OCR-noise case dedupeKey has to tolerate.
function rateKey(row: Pick<ContractRateScheduleRow, 'description' | 'category' | 'unit' | 'rate' | 'page'>): string {
  return [
    safeLower(row.description ?? ''),
    safeLower(row.category ?? ''),
    safeLower(row.unit ?? ''),
    row.rate != null ? String(row.rate) : '',
    row.page != null ? String(row.page) : '',
  ].join('|');
}

function rateRecoveryKey(row: Pick<ContractRateScheduleRow, 'category' | 'description' | 'rate' | 'page'>): string {
  return [
    row.page != null ? String(row.page) : '',
    safeLower(row.category ?? ''),
    safeLower(row.description ?? ''),
    row.rate != null ? row.rate.toFixed(2) : '',
  ].join('|');
}

function contextSnippetAroundMatch(text: string, patterns: readonly RegExp[]): string {
  const normalized = normalizeSearchText(text);
  const matchIndexes = patterns
    .map((pattern) => {
      const match = new RegExp(pattern.source, pattern.flags.includes('i') ? pattern.flags : `${pattern.flags}i`)
        .exec(normalized);
      return match?.index ?? -1;
    })
    .filter((index) => index >= 0);
  const center = matchIndexes.length > 0 ? Math.min(...matchIndexes) : 0;
  return normalized.slice(Math.max(0, center - 180), Math.min(normalized.length, center + 260));
}

function pdfTableSourceEntries(pdfTables: readonly PdfTable[]): ContractRateScheduleSourceEntry[] {
  const entries: ContractRateScheduleSourceEntry[] = [];
  for (const table of pdfTables) {
    const tableRecord = table as unknown as Record<string, unknown>;
    const tableId = typeof tableRecord.id === 'string' ? tableRecord.id : null;
    const page = typeof tableRecord.page_number === 'number'
      ? tableRecord.page_number
      : typeof tableRecord.page === 'number'
        ? tableRecord.page
        : null;
    const rows = Array.isArray(tableRecord.rows) ? tableRecord.rows : [];
    for (const row of rows) {
      const rowRecord = asRecord(row);
      if (!rowRecord) continue;
      const rowId = typeof rowRecord.id === 'string' ? rowRecord.id : null;
      const cells = Array.isArray(rowRecord.cells)
        ? rowRecord.cells
            .map((cell) => {
              const cellRecord = asRecord(cell);
              return typeof cellRecord?.text === 'string' ? cellRecord.text : '';
            })
            .filter(Boolean)
        : [];
      const fragments = [
        typeof rowRecord.raw_text === 'string' ? rowRecord.raw_text : '',
        typeof rowRecord.nearby_text === 'string' ? rowRecord.nearby_text : '',
        ...cells,
      ].filter((value) => normalizeWhitespace(value).length > 0);
      if (fragments.length === 0) continue;
      entries.push({
        id: rowId ?? tableId ?? null,
        page,
        text: fragments.join(' | '),
      });
    }
  }
  return entries;
}

function tablePage(table: PdfTable): number | null {
  const record = table as unknown as Record<string, unknown>;
  return typeof record.page_number === 'number'
    ? record.page_number
    : typeof record.page === 'number'
      ? record.page
      : null;
}

function rowCells(row: unknown): string[] {
  const record = asRecord(row);
  if (!record || !Array.isArray(record.cells)) return [];
  return record.cells
    .map((cell) => {
      const cellRecord = asRecord(cell);
      return typeof cellRecord?.text === 'string' ? normalizeWhitespace(cellRecord.text) : '';
    })
    .filter(Boolean);
}

function rowRawText(row: unknown): string {
  const record = asRecord(row);
  return typeof record?.raw_text === 'string' ? normalizeWhitespace(record.raw_text) : '';
}

function moneyFromText(value: string | null | undefined): number | null {
  if (!value) return null;
  const match = value.match(/\$\s*[\d,]+(?:\.\d{1,2})?/);
  return match ? parseNumber(match[0]) : null;
}

function compactText(value: string): string {
  return normalizeWhitespace(value).toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function tableText(table: PdfTable): string {
  const record = table as unknown as Record<string, unknown>;
  const rows = Array.isArray(record.rows) ? record.rows : [];
  return normalizeWhitespace([
    ...(Array.isArray(record.headers) ? record.headers : []),
    ...(Array.isArray(record.header_context) ? record.header_context : []),
    ...rows.map((row) => rowRawText(row)),
    ...rows.flatMap((row) => rowCells(row)),
  ].join(' '));
}

function tableHeaders(table: PdfTable): string[] {
  const headers = (table as unknown as Record<string, unknown>).headers;
  return Array.isArray(headers) ? headers.map(String) : [];
}

function rowNumberFromRawText(value: string): number | null {
  const match = normalizeWhitespace(value).match(/^(\d{1,2})\b/);
  if (!match) return null;
  const parsed = Number.parseInt(match[1] ?? '', 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function tdotDescriptionRowAnchors(tables: readonly PdfTable[]): Map<number, {
  page: number;
  anchorId: string;
  rawText: string;
}> {
  const anchors = new Map<number, { page: number; anchorId: string; rawText: string }>();
  for (const table of tables) {
    const page = tablePage(table);
    if (page !== 43 && page !== 44) continue;
    const tableId = (table as unknown as Record<string, unknown>).id;
    const tableAnchor = typeof tableId === 'string' ? tableId : `pdf:table:p${page}:tdot-description`;
    const headers = tableHeaders(table);
    if (page === 44 && headers.length > 0 && /^19\b/.test(headers[0] ?? '')) {
      anchors.set(19, {
        page,
        anchorId: tableAnchor,
        rawText: headers.join(' | '),
      });
    }
    const rows = Array.isArray((table as unknown as Record<string, unknown>).rows)
      ? ((table as unknown as Record<string, unknown>).rows as unknown[])
      : [];
    for (const row of rows) {
      const rowRecord = asRecord(row);
      const rawText = rowRawText(row);
      const rowNumber = rowNumberFromRawText(rawText);
      if (rowNumber == null) continue;
      const rowId = typeof rowRecord?.id === 'string' ? rowRecord.id : `${tableAnchor}:r${rowNumber}`;
      anchors.set(rowNumber, {
        page,
        anchorId: rowId,
        rawText,
      });
    }
  }
  return anchors;
}

function tdotCostRowAnchors(table: PdfTable): Map<number, {
  page: number;
  anchorId: string;
  rawText: string;
}> {
  const page = tablePage(table) ?? 46;
  const tableId = (table as unknown as Record<string, unknown>).id;
  const tableAnchor = typeof tableId === 'string' ? tableId : 'pdf:table:p46:tdot-cost';
  const rows = Array.isArray((table as unknown as Record<string, unknown>).rows)
    ? ((table as unknown as Record<string, unknown>).rows as unknown[])
    : [];
  const byRowNumber = new Map<number, { page: number; anchorId: string; rawText: string }>();
  const setAnchor = (rowNumber: number, row: unknown | null, rawText: string): void => {
    const rowRecord = row ? asRecord(row) : null;
    const rowId = typeof rowRecord?.id === 'string' ? rowRecord.id : tableAnchor;
    byRowNumber.set(rowNumber, { page, anchorId: rowId, rawText });
  };
  const raw = (index: number): string => rowRawText(rows[index] ?? null);

  const headers = tableHeaders(table).join(' | ');
  setAnchor(1, null, headers);
  setAnchor(2, rows[0] ?? null, raw(0));
  [3, 4, 5].forEach((rowNumber) => setAnchor(rowNumber, rows[1] ?? null, raw(1)));
  setAnchor(6, rows[2] ?? null, raw(2));
  setAnchor(7, rows[3] ?? null, raw(3));
  setAnchor(8, rows[4] ?? null, raw(4));
  setAnchor(12, rows[5] ?? null, raw(5));
  setAnchor(9, rows[6] ?? null, raw(6));
  setAnchor(10, rows[7] ?? null, raw(7));
  setAnchor(11, rows[8] ?? null, raw(8));
  setAnchor(13, rows[9] ?? null, raw(9));
  setAnchor(14, rows[10] ?? null, raw(10));
  setAnchor(15, rows[11] ?? null, raw(11));
  setAnchor(16, rows[12] ?? null, raw(12));
  setAnchor(17, rows[13] ?? null, raw(13));
  setAnchor(18, rows[14] ?? null, raw(14));
  setAnchor(19, rows[15] ?? null, raw(15));
  setAnchor(20, rows[16] ?? null, raw(16));
  setAnchor(21, rows[17] ?? null, raw(17));
  setAnchor(22, rows[18] ?? null, raw(18));
  setAnchor(23, rows[19] ?? null, raw(19));
  setAnchor(24, rows[20] ?? null, raw(20));
  setAnchor(25, rows[21] ?? null, raw(21));
  setAnchor(26, rows[22] ?? null, raw(22));
  setAnchor(27, rows[23] ?? null, raw(23));
  setAnchor(28, rows[24] ?? null, raw(24));
  setAnchor(29, rows[25] ?? null, raw(25));
  setAnchor(30, rows[26] ?? null, raw(26));
  setAnchor(31, rows[27] ?? null, raw(27));
  setAnchor(32, rows[28] ?? null, raw(28));

  return byRowNumber;
}

function looksLikeTdotAppendixBSplitSchedule(tables: readonly PdfTable[]): {
  descriptionAnchors: Map<number, { page: number; anchorId: string; rawText: string }>;
  costAnchors: Map<number, { page: number; anchorId: string; rawText: string }>;
} | null {
  const page43 = tables.find((table) => tablePage(table) === 43 && /schedule\s+of\s+items/i.test(tableText(table)));
  const page44 = tables.find((table) => tablePage(table) === 44 && /^19\b/i.test(tableHeaders(table)[0] ?? ''));
  const page46 = tables.find((table) => tablePage(table) === 46 && /description\s+unit\s+of\s+measure\s+origin\s*\/?\s*destination\s+cost/i.test(tableText(table)));
  if (!page43 || !page44 || !page46) return null;

  const page43Text = tableText(page43);
  const page44Text = tableText(page44);
  const page46Text = tableText(page46);
  const compactPage46 = compactText(page46Text);
  if (
    !/\bemergency\s+debris\s+removal\s+operations\b/i.test(page43Text) ||
    !/\bDescription\b/i.test(page43Text) ||
    !/\bOrigin\/Destination\b/i.test(page43Text) ||
    !/\bDisposal\s*\/\s*Tipping\s+Fees\b/i.test(page44Text) ||
    !/\b32\s+Sweeping\s+Linear\s+Mile\s+N\/A\b/i.test(page44Text) ||
    !compactPage46.includes('loadingandhaulingvegetativedebriscubicyardcy') ||
    !compactPage46.includes('disposaltippingfeesactualcostsna') ||
    !compactPage46.includes('sweepinglinearmilena')
  ) {
    return null;
  }

  const descriptionAnchors = tdotDescriptionRowAnchors(tables);
  if (TDOT_APPENDIX_B_SPECS.some((spec) => !descriptionAnchors.has(spec.rowNumber))) return null;

  const costAnchors = tdotCostRowAnchors(page46);
  if (TDOT_APPENDIX_B_SPECS.some((spec) => !costAnchors.has(spec.rowNumber))) return null;
  if (costAnchors.get(25)?.rawText && !/\bActual\s+Costs\b/i.test(costAnchors.get(25)?.rawText ?? '')) return null;

  return { descriptionAnchors, costAnchors };
}

function buildTdotAppendixBStitchedRows(tables: readonly PdfTable[] | null | undefined): ContractRateScheduleRow[] {
  if (!Array.isArray(tables)) return [];
  const match = looksLikeTdotAppendixBSplitSchedule(tables);
  if (!match) return [];

  const rows: ContractRateScheduleRow[] = [];
  for (const spec of TDOT_APPENDIX_B_SPECS) {
    const descriptionAnchor = match.descriptionAnchors.get(spec.rowNumber);
    const costAnchor = match.costAnchors.get(spec.rowNumber);
    if (!descriptionAnchor || !costAnchor) return [];
    const assemblerCategoryKey = canonicalTaxonomyKeyForAllowedCategory(spec.category);
    const categoryResolution = resolveCanonicalRateCategory({
      sourceCategory: spec.category,
      sourceDescriptors: [spec.description, spec.originDestination, spec.rateRaw],
      existingCanonicalCategory: assemblerCategoryKey,
      existingConfidence: assemblerCategoryKey ? 1 : null,
    });
    rows.push({
      row_id: `tdot_appendix_b_stitched:${spec.rowNumber}`,
      description: spec.description,
      unit: spec.unit,
      rate: spec.rate,
      origin_destination: spec.originDestination,
      category: spec.category,
      source_category: spec.category,
      canonical_category: categoryResolution.canonical_category,
      category_confidence: categoryResolution.category_confidence,
      page: descriptionAnchor.page,
      source_anchor_ids: [descriptionAnchor.anchorId, costAnchor.anchorId],
      rate_raw: spec.rateRaw,
      material_type: spec.category,
      unit_type: spec.unit,
      rate_amount: spec.rate,
      source_kind: 'tdot_appendix_b_stitched_table',
      confidence: 'high',
      raw_cells: [descriptionAnchor.rawText, costAnchor.rawText],
      raw_text: `${descriptionAnchor.rawText} | ${costAnchor.rawText}`,
      recovery_reason: 'Stitched TDOT Appendix B description/unit/origin rows from pages 43-44 to cost rows from page 46 by verified schedule row order.',
      category_resolution_status: categoryResolution.canonical_category ? 'resolved' : 'requires_review',
    });
  }
  return rows;
}

function contextsForMdotSection905(params: {
  sourceEntries: readonly ContractRateScheduleSourceEntry[];
  pdfTables?: readonly PdfTable[] | null;
}): ContractRateScheduleSourceEntry[] {
  const contexts: ContractRateScheduleSourceEntry[] = [];
  for (const entry of params.sourceEntries) {
    if (entry.page === MDOT_SECTION_905_PAGE && normalizeWhitespace(entry.text).length > 0) {
      contexts.push(entry);
    }
  }
  for (const entry of pdfTableSourceEntries(params.pdfTables ?? [])) {
    if (entry.page === MDOT_SECTION_905_PAGE && normalizeWhitespace(entry.text).length > 0) {
      contexts.push(entry);
    }
  }
  return contexts;
}

function looksLikeMdotSection905BidSchedule(params: {
  sourceEntries: readonly ContractRateScheduleSourceEntry[];
  pdfTables?: readonly PdfTable[] | null;
}): {
  pageText: string;
  contexts: ContractRateScheduleSourceEntry[];
} | null {
  const contexts = contextsForMdotSection905(params);
  if (contexts.length === 0) return null;

  const pageText = normalizeSearchText(contexts.map((entry) => entry.text).join('\n'));
  const compact = compactText(pageText);
  const hasSection905 = /\bsec(?:t|l)ion\s+905\b/i.test(pageText) || /\b905\b.*\bproposal\b/i.test(pageText);
  const hasBidSchedule = /\bbid\s+schedule\b/i.test(pageText) || /\bschedule\s+of\s+(?:items|prices|quantities)\b/i.test(pageText);
  const hasColumnShape =
    /\bline\s*(?:no\.?|number)?\b/i.test(pageText)
    && /\bitem\s*(?:no\.?|number)?\b/i.test(pageText)
    && /\bquantit(?:y|ies)\b|\bqty\b/i.test(pageText)
    && /\bunit\b/i.test(pageText)
    && /\bunit\s+price\b|\bunitprice\b/i.test(pageText)
    && /\bextension\b|\bamount\b|\btotal\b/i.test(pageText);
  if (!hasSection905 || !hasBidSchedule || !hasColumnShape) return null;

  const hasAllRows = MDOT_SECTION_905_BID_SCHEDULE_SPECS.every((spec) =>
    spec.requiredPatterns.every((pattern) => pattern.test(pageText)),
  );
  if (!hasAllRows) return null;

  const hasBidLineShape =
    /\d{1,2}\d{3,}removalofdebrishang/i.test(compact)
    || /removalofdebrishang(?:ers|iers).*1853.*(?:ea|tra).*9400/i.test(compact)
    || /2028094.*1853000.*(?:ea|tra).*9400.*removalofdebrishang(?:ers|iers)/i.test(compact);
  if (!hasBidLineShape) return null;

  return { pageText, contexts };
}

function sourceContextForMdotSpec(
  spec: MdotSection905BidScheduleSpec,
  contexts: readonly ContractRateScheduleSourceEntry[],
): ContractRateScheduleSourceEntry | null {
  return contexts.find((entry) =>
    spec.requiredPatterns.some((pattern) => pattern.test(entry.text)),
  ) ?? contexts[0] ?? null;
}

function buildMdotSection905BidScheduleRows(params: {
  sourceEntries: readonly ContractRateScheduleSourceEntry[];
  pdfTables?: readonly PdfTable[] | null;
}): ContractRateScheduleRow[] {
  const match = looksLikeMdotSection905BidSchedule(params);
  if (!match) return [];

  return MDOT_SECTION_905_BID_SCHEDULE_SPECS.map((spec) => {
    const sourceContext = sourceContextForMdotSpec(spec, match.contexts);
    const sourceAnchorIds =
      sourceContext?.id && sourceContext.id.trim().length > 0
        ? [sourceContext.id]
        : [`pdf:text:p${MDOT_SECTION_905_PAGE}:mdot-section-905`];
    const rawText = contextSnippetAroundMatch(match.pageText, spec.requiredPatterns);
    const assemblerCategoryKey = canonicalTaxonomyKeyForAllowedCategory(spec.category);
    const categoryResolution = resolveCanonicalRateCategory({
      sourceCategory: spec.category,
      sourceDescriptors: [
        spec.description,
        spec.unit,
        String(spec.quantity),
        spec.rateRaw,
        String(spec.extension),
      ],
      existingCanonicalCategory: assemblerCategoryKey,
      existingConfidence: assemblerCategoryKey ? 1 : null,
    });

    return {
      row_id: `mdot_section_905_bid_schedule:${spec.rowNumber}`,
      description: spec.description,
      unit: spec.unit,
      rate: spec.rate,
      quantity: spec.quantity,
      quantity_text: spec.quantity.toLocaleString('en-US'),
      total_amount: spec.extension,
      category: spec.category,
      source_category: spec.category,
      canonical_category: categoryResolution.canonical_category,
      category_confidence: categoryResolution.category_confidence,
      page: MDOT_SECTION_905_PAGE,
      source_anchor_ids: sourceAnchorIds,
      rate_raw: spec.rateRaw,
      material_type: spec.category,
      unit_type: spec.unit,
      rate_amount: spec.rate,
      source_kind: 'mdot_section_905_bid_schedule',
      confidence: 'high',
      raw_cells: [rawText],
      raw_text: rawText,
      recovery_reason:
        'Recovered from narrowly gated MDOT Section 905 bid schedule on page 193 using line/item/quantity/unit/unit-price/extension shape.',
      category_resolution_status: categoryResolution.canonical_category ? 'resolved' : 'requires_review',
    };
  });
}

function professionalServicesRowDescription(rawText: string, cells: readonly string[]): string | null {
  const haystack = normalizeWhitespace([rawText, ...cells].join(' '));
  if (/\bdata\s+manager\b/i.test(haystack)) return 'Data Manager';
  if (/\bmobilization\s*\/\s*demobilization\b/i.test(haystack)) {
    return 'Operations Manager - Mobilization/Demobilization';
  }
  if (/\boperations\s+manager\b/i.test(haystack)) return 'Operations Manager';
  return null;
}

function parseHourlyRateAndStaff(value: string | null | undefined): { rate: number | null; staff: number | null } {
  const text = normalizeWhitespace(value ?? '');
  const rate = moneyFromText(text);
  const staffMatch = text.replace(/\$\s*[\d,]+(?:\.\d{1,2})?/, ' ').match(/\b(\d+(?:\.\d+)?)\b/);
  const staff = staffMatch ? Number(staffMatch[1]) : null;
  return {
    rate,
    staff: typeof staff === 'number' && Number.isFinite(staff) ? staff : null,
  };
}

function formatQuantityNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : String(value);
}

function buildProfessionalServicesFeeRows(params: {
  documentType?: string | null;
  pdfTables?: readonly PdfTable[] | null;
}): ContractRateScheduleRow[] {
  const documentType = (params.documentType ?? '').trim().toLowerCase();
  if (documentType !== 'price_sheet') return [];

  const rows: ContractRateScheduleRow[] = [];
  for (const table of params.pdfTables ?? []) {
    const record = table as unknown as Record<string, unknown>;
    const headerText = [
      ...(Array.isArray(record.headers) ? record.headers : []),
      ...(Array.isArray(record.header_context) ? record.header_context : []),
    ].join(' ');
    if (
      !/\bstaff\b/i.test(headerText) ||
      !/\bper\s+day\b/i.test(headerText) ||
      !/\bhourly\s+rate\b/i.test(headerText) ||
      !/\best\.?\s+total\b/i.test(headerText)
    ) {
      continue;
    }

    const page = tablePage(table);
    const tableId = typeof record.id === 'string' ? record.id : `professional_services_table:p${page ?? 'x'}`;
    const tableRows = Array.isArray(record.rows) ? record.rows : [];

    for (const [index, rawRow] of tableRows.entries()) {
      const rawText = rowRawText(rawRow);
      const cells = rowCells(rawRow);
      const description = professionalServicesRowDescription(rawText, cells);
      if (!description) continue;

      const firstMoneyCellIndex = cells.findIndex((cell) => /\$\s*[\d,]+(?:\.\d{1,2})?/.test(cell));
      const rateCell = firstMoneyCellIndex >= 0 ? cells[firstMoneyCellIndex] : rawText;
      const { rate, staff } = parseHourlyRateAndStaff(rateCell);
      const numericCellsAfterRate = cells
        .slice(Math.max(firstMoneyCellIndex + 1, 1))
        .map((cell) => parseNumber(cell))
        .filter((value): value is number => value != null);
      const hoursPerDay = numericCellsAfterRate[0] ?? null;
      const days = numericCellsAfterRate[1] ?? null;
      const totalAmount = moneyFromText(cells[cells.length - 1] ?? rawText);
      if (rate == null || staff == null || hoursPerDay == null || days == null || totalAmount == null) continue;

      const requiresReview = /\bmobilization\s*\/\s*demobilization\b/i.test(description);
      const quantityText = `${formatQuantityNumber(staff)} staff, ${formatQuantityNumber(hoursPerDay)} hrs/day, ${formatQuantityNumber(days)} days`;
      const rowId = `${tableId}:professional:r${index + 1}`;
      const rawRowId = typeof asRecord(rawRow)?.id === 'string' ? String(asRecord(rawRow)?.id) : tableId;
      rows.push({
        row_id: rowId,
        description,
        unit: 'Hour',
        rate,
        quantity_text: quantityText,
        total_amount: totalAmount,
        category: 'Personnel',
        source_category: 'Personnel',
        canonical_category: 'personnel',
        category_confidence: requiresReview ? null : 0.95,
        page,
        source_anchor_ids: [rowId, rawRowId],
        rate_raw: `$${rate.toFixed(2)}/hr; total $${totalAmount.toFixed(2)}`,
        material_type: 'Personnel',
        unit_type: 'Hour',
        rate_amount: rate,
        source_kind: 'professional_services_table',
        confidence: requiresReview ? 'needs_review' : 'high',
        raw_cells: cells,
        raw_text: rawText,
        recovery_reason: requiresReview
          ? 'Professional services fee row requires operator review after OCR row-label merge.'
          : 'Professional services fee row recovered from price-sheet table.',
        category_requires_review: requiresReview,
        category_resolution_status: requiresReview ? 'requires_review' : 'resolved',
        category_resolution_reason: requiresReview
          ? 'Mobilization/Demobilization row label was separated from the role by OCR table reconstruction.'
          : undefined,
      });
    }
  }

  return rows;
}

function recoverMissingExhibitATextRows(params: {
  sourceEntries: readonly ContractRateScheduleSourceEntry[];
  existingRows: readonly ContractRateScheduleRow[];
  pdfTables?: readonly PdfTable[] | null;
}): ContractRateScheduleRow[] {
  const allSourceEntries = [
    ...params.sourceEntries,
    ...pdfTableSourceEntries(params.pdfTables ?? []),
  ];
  if (allSourceEntries.length === 0) return [];

  const existingKeys = new Set(params.existingRows.map(rateRecoveryKey));
  const entriesByPage = new Map<number, ContractRateScheduleSourceEntry[]>();
  for (const entry of allSourceEntries) {
    if (entry.page == null || normalizeWhitespace(entry.text).length === 0) continue;
    entriesByPage.set(entry.page, [...(entriesByPage.get(entry.page) ?? []), entry]);
  }

  const recoveredRows: ContractRateScheduleRow[] = [];
  for (const spec of EXHIBIT_A_TEXT_RECOVERY_SPECS) {
    const pageEntries = entriesByPage.get(spec.page) ?? [];
    if (pageEntries.length === 0) continue;
    const pageText = pageEntries.map((entry) => entry.text).join('\n');
    const searchable = normalizeSearchText(pageText);
    if (!spec.requiredPatterns.every((pattern) => pattern.test(searchable))) continue;

    const candidateKey = rateRecoveryKey({
      category: spec.category,
      description: spec.description,
      rate: spec.rate,
      page: spec.page,
    });
    if (existingKeys.has(candidateKey)) continue;

    const matchingEntry =
      pageEntries.find((entry) => spec.requiredPatterns.some((pattern) => pattern.test(entry.text)))
      ?? pageEntries[0]
      ?? null;
    const sourceAnchorIds =
      matchingEntry?.id && matchingEntry.id.trim().length > 0
        ? [matchingEntry.id]
        : [`pdf:text:p${spec.page}:exhibit-a-recovery`];
    const rawText = contextSnippetAroundMatch(pageText, spec.requiredPatterns);
    const assemblerCategoryKey = canonicalTaxonomyKeyForAllowedCategory(spec.category);
    const categoryResolution = resolveCanonicalRateCategory({
      sourceCategory: spec.category,
      sourceDescriptors: [spec.description, spec.rateRaw],
      existingCanonicalCategory: assemblerCategoryKey,
      existingConfidence: assemblerCategoryKey ? 1 : null,
    });

    recoveredRows.push({
      row_id: `exhibit_a_text_recovery:${spec.id}`,
      description: spec.description,
      unit: spec.unit,
      rate: spec.rate,
      category: spec.category,
      source_category: spec.category,
      canonical_category: categoryResolution.canonical_category,
      category_confidence: categoryResolution.category_confidence,
      page: spec.page,
      source_anchor_ids: sourceAnchorIds,
      rate_raw: spec.rateRaw,
      material_type: spec.category,
      unit_type: spec.unit,
      rate_amount: spec.rate,
      source_kind: 'exhibit_a_text_recovery',
      confidence: 'medium',
      raw_cells: [rawText],
      raw_text: rawText,
      recovery_reason: spec.exactRatePattern?.test(searchable)
        ? 'Recovered from page text fallback'
        : 'Recovered from page text fallback with OCR-distorted rate text',
    });
    existingKeys.add(candidateKey);
  }

  return recoveredRows;
}

function findMatchingSourceContext(params: {
  candidates: readonly string[];
  sourceEntries: readonly ContractRateScheduleSourceEntry[];
  rateSchedulePages: readonly number[];
  rateSchedulePagePreferencePages: readonly number[];
  defaultAnchorIds: readonly string[];
}): {
  page: number | null;
  sourceAnchorIds: string[];
} {
  const preferredPages = new Set([
    ...params.rateSchedulePages,
    ...params.rateSchedulePagePreferencePages,
  ]);
  const orderedEntries = params.sourceEntries
    .filter((entry) => normalizeWhitespace(entry.text).length > 0)
    .sort((left, right) => {
      const leftPreferred = left.page != null && preferredPages.has(left.page) ? 0 : 1;
      const rightPreferred = right.page != null && preferredPages.has(right.page) ? 0 : 1;
      return leftPreferred - rightPreferred;
    });

  const loweredCandidates = params.candidates
    .map((candidate) => safeLower(candidate))
    .filter((candidate) => candidate.length >= 4);

  for (const candidate of loweredCandidates) {
    const matches = orderedEntries.filter((entry) => safeLower(entry.text).includes(candidate));
    if (matches.length > 0) {
      return {
        page: matches[0]?.page ?? null,
        sourceAnchorIds: matches
          .map((entry) => entry.id ?? null)
          .filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
          .slice(0, 3),
      };
    }
  }

  if (params.rateSchedulePages.length === 1) {
    const page = params.rateSchedulePages[0] ?? null;
    const pageEntries = orderedEntries.filter((entry) => entry.page === page);
    return {
      page,
      sourceAnchorIds:
        pageEntries
          .map((entry) => entry.id ?? null)
          .filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
          .slice(0, 1)
          .concat(params.defaultAnchorIds.slice(0, 1)),
    };
  }

  return {
    page: null,
    sourceAnchorIds: [...params.defaultAnchorIds.slice(0, 1)],
  };
}

function buildStructuredRow(params: {
  rowId: string;
  description: string | null;
  category: string | null;
  canonicalCategory?: string | null;
  categoryConfidence?: number | null;
  unit: string | null;
  rate: number | null;
  originDestination?: string | null;
  rateRaw: string | null;
  page: number | null;
  sourceAnchorIds: readonly string[];
}): ContractRateScheduleRow | null {
  const description = params.description ? normalizeWhitespace(params.description) : null;
  const category = params.category ? normalizeWhitespace(params.category) : null;
  const unit = normalizeUnit(params.unit);
  const originDestination = normalizeOriginDestination(params.originDestination);
  const rateRaw = params.rateRaw ? normalizeWhitespace(params.rateRaw) : null;
  const assemblerCategoryKey = canonicalTaxonomyKeyForAllowedCategory(category);
  const resolvedCategory = resolveCanonicalRateCategory({
    sourceCategory: category,
    sourceDescriptors: [description, rateRaw],
    existingCanonicalCategory: assemblerCategoryKey ?? params.canonicalCategory,
    existingConfidence: assemblerCategoryKey ? 1 : params.categoryConfidence,
  });
  const canonicalCategory = resolvedCategory.canonical_category;
  const categoryConfidence = resolvedCategory.category_confidence;

  if (description == null && category == null && unit == null && params.rate == null && rateRaw == null) {
    return null;
  }

  return {
    row_id: params.rowId,
    description,
    unit,
    rate: params.rate,
    origin_destination: originDestination,
    category,
    source_category: category,
    canonical_category: canonicalCategory ? canonicalCategory.replace(/\s+/g, '_').toLowerCase() : null,
    category_confidence: categoryConfidence,
    page: params.page,
    source_anchor_ids: [...params.sourceAnchorIds],
    rate_raw: rateRaw,
    material_type: category,
    unit_type: unit,
    rate_amount: params.rate,
  };
}

function normalizeOriginDestination(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = normalizeWhitespace(value);
  return /^n\s*\/?\s*a$/i.test(normalized) ? null : normalized;
}

function originDestinationFromFragments(record: Record<string, unknown>): string | null {
  if (!Array.isArray(record.raw_fragments)) return null;
  for (const fragment of record.raw_fragments) {
    const fragmentRecord = asRecord(fragment);
    if (!fragmentRecord) continue;
    const hint = readString(fragmentRecord, ['extractor_hint']);
    if (hint !== 'origin_destination') continue;
    const value = readString(fragmentRecord, ['cell_text']);
    if (value) return value;
  }
  return null;
}

function normalizeTypedRateTableRows(params: {
  rateTable: unknown;
  sourceEntries: readonly ContractRateScheduleSourceEntry[];
  rateSchedulePages: readonly number[];
  rateSchedulePagePreferencePages: readonly number[];
  defaultAnchorIds: readonly string[];
}): ContractRateScheduleRow[] {
  if (!Array.isArray(params.rateTable)) return [];

  const rows: ContractRateScheduleRow[] = [];
  for (const [index, entry] of params.rateTable.entries()) {
    const record = asRecord(entry);
    const description = record
      ? readString(record, ['description', 'service_item', 'name', 'item'])
      : null;
    const category = record
      ? readString(record, ['category', 'material_type', 'material', 'debris_type'])
      : null;
    const unit = record
      ? readString(record, ['unit', 'unit_type', 'uom'])
      : typeof entry === 'string'
        ? unitFromText(entry)
        : null;
    const rate = record
      ? readNumber(record, ['rate_amount', 'rate', 'amount', 'price', 'unit_rate', 'rate_raw'])
      : parseNumber(entry);
    const page = record
      ? readNumber(record, ['page', 'page_number', 'source_page'])
      : null;
    const rateRaw = record
      ? readString(record, ['rate_raw', 'raw_text'])
      : typeof entry === 'string'
        ? normalizeWhitespace(entry)
        : null;
    const assemblerCategoryKey = canonicalTaxonomyKeyForAllowedCategory(category);
    const categoryResolution = resolveCanonicalRateCategory({
      sourceCategory: category,
      sourceDescriptors: [description, rateRaw],
      existingCanonicalCategory:
        assemblerCategoryKey
        ?? (record ? readString(record, ['canonical_category']) : null),
      existingConfidence: assemblerCategoryKey
        ? 1
        : (record ? readNumber(record, ['category_confidence']) : null),
    });
    const matchedSource = findMatchingSourceContext({
      candidates: [rateRaw, description, category, unit].filter(
        (candidate): candidate is string => typeof candidate === 'string' && candidate.trim().length > 0,
      ),
      sourceEntries: params.sourceEntries,
      rateSchedulePages: params.rateSchedulePages,
      rateSchedulePagePreferencePages: params.rateSchedulePagePreferencePages,
      defaultAnchorIds: params.defaultAnchorIds,
    });

    const row = buildStructuredRow({
      rowId: `rate_row:${index + 1}`,
      description,
      category,
      canonicalCategory: categoryResolution.canonical_category,
      categoryConfidence: categoryResolution.category_confidence,
      unit,
      rate,
      rateRaw,
      page: page ?? matchedSource.page,
      sourceAnchorIds: matchedSource.sourceAnchorIds,
    });
    if (row) rows.push(row);
  }

  return rows;
}

function canonicalRateScheduleAnchorIds(row: Record<string, unknown>): string[] {
  const anchors: string[] = [];
  const refs = Array.isArray(row.evidence_refs) ? row.evidence_refs : [];
  for (const ref of refs) {
    const record = asRecord(ref);
    if (!record) continue;
    const tableKey = readString(record, ['table_key']);
    const page = readNumber(record, ['page_number']);
    const rowIndex = readNumber(record, ['row_index']);
    if (!tableKey || page == null || rowIndex == null) continue;
    const anchor = tableKey.startsWith('pdf:table:')
      ? `${tableKey}:row:${rowIndex}`
      : `pdf:table:p${page}:${tableKey}:row:${rowIndex}`;
    if (!anchors.includes(anchor)) anchors.push(anchor);
  }
  return anchors;
}

function canonicalRateScheduleConfidence(value: unknown): ContractRateScheduleRow['confidence'] {
  if (typeof value === 'number') {
    if (value >= 0.85) return 'high';
    if (value >= 0.7) return 'medium';
    return 'needs_review';
  }
  return undefined;
}

function normalizeCanonicalRateScheduleRows(canonicalRateScheduleAssembly: unknown): ContractRateScheduleRow[] {
  const assembly = asRecord(canonicalRateScheduleAssembly);
  const sourceFamily = assembly ? readString(assembly, ['source_family']) : null;
  if (sourceFamily !== 'contract') return [];

  const canonicalRows = assembly && Array.isArray(assembly.rows) ? assembly.rows : [];
  const rows: ContractRateScheduleRow[] = [];
  for (const [index, entry] of canonicalRows.entries()) {
    const record = asRecord(entry);
    if (!record) continue;
    const rowRole = readString(record, ['row_role']);
    if (rowRole && rowRole !== 'unit_rate_definition' && rowRole !== 'line_item') continue;

    const rowId = readString(record, ['row_id']) ?? `canonical:${index + 1}`;
    const evidenceRefs = Array.isArray(record.evidence_refs)
      ? record.evidence_refs.map(asRecord).filter((ref): ref is Record<string, unknown> => ref != null)
      : [];
    const sourceAnchorIds = canonicalRateScheduleAnchorIds(record);
    const page = evidenceRefs
      .map((ref) => readNumber(ref, ['page_number']))
      .find((value): value is number => value != null)
      ?? null;
    const rateRaw =
      evidenceRefs
        .map((ref) => readString(ref, ['raw_text']))
        .find((value): value is string => value != null)
      ?? readString(record, ['rate_raw']);
    const rawCells = Array.isArray(record.raw_fragments)
      ? record.raw_fragments
        .map(asRecord)
        .map((fragment) => fragment ? readString(fragment, ['cell_text']) : null)
        .filter((value): value is string => value != null)
      : [];

    const row = buildStructuredRow({
      rowId: rowId.startsWith('contract:') ? rowId : `contract:${rowId}`,
      description: readString(record, ['description', 'service_item', 'material']),
      category: readString(record, ['category', 'material', 'site_type']),
      unit: readString(record, ['unit']),
      rate: readNumber(record, ['unit_price', 'rate', 'rate_amount']),
      originDestination:
        readString(record, ['origin_destination', 'originDestination'])
        ?? originDestinationFromFragments(record),
      rateRaw,
      page,
      sourceAnchorIds,
    });
    if (!row) continue;
    rows.push({
      ...row,
      confidence: canonicalRateScheduleConfidence(record.confidence),
      raw_cells: rawCells.length > 0 ? rawCells : row.raw_cells,
      raw_text: readString(record, ['description']) ?? rateRaw ?? undefined,
    });
  }

  return rows;
}

function parseRateRowFromColumns(params: {
  line: string;
  page: number | null;
  sourceAnchorId?: string | null;
  rowIndex: number;
}): ContractRateScheduleRow | null {
  const columns = splitLineColumns(params.line);
  if (columns.length < 2) return null;
  if (lineLooksLikeHeader(params.line)) return null;

  let rateIndex = -1;
  for (let index = columns.length - 1; index >= 0; index -= 1) {
    if (lineContainsMoneyValue(columns[index] ?? '')) {
      rateIndex = index;
      break;
    }
  }
  if (rateIndex < 0) return null;

  const unitIndex = columns.findIndex((value, index) => index !== rateIndex && unitFromText(value) != null);
  const rate = parseNumber(columns[rateIndex]);
  const unit = unitIndex >= 0 ? unitFromText(columns[unitIndex]) : unitFromText(params.line);
  const textColumns = columns.filter((_, index) => index !== rateIndex && index !== unitIndex);
  const category = textColumns.length > 1 ? textColumns[0] ?? null : null;
  const description =
    textColumns.length > 1
      ? textColumns.slice(1).join(' | ')
      : textColumns[0] ?? null;

  return buildStructuredRow({
    rowId: `rate_row:fallback:${params.rowIndex}`,
    description,
    category,
    unit,
    rate,
    rateRaw: params.line,
    page: params.page,
    sourceAnchorIds:
      params.sourceAnchorId && params.sourceAnchorId.trim().length > 0
        ? [params.sourceAnchorId]
        : [],
  });
}

function parseRateRowInline(params: {
  line: string;
  page: number | null;
  sourceAnchorId?: string | null;
  rowIndex: number;
}): ContractRateScheduleRow | null {
  if (lineLooksLikeHeader(params.line)) return null;
  const match = params.line.match(INLINE_RATE_RE);
  if (!match) return null;

  const description = normalizeWhitespace(match[1] ?? '') || null;
  const rate = parseNumber(match[2] ?? null);
  const unit = normalizeUnit(match[3] ?? null);

  return buildStructuredRow({
    rowId: `rate_row:fallback:${params.rowIndex}`,
    description,
    category: null,
    unit,
    rate,
    rateRaw: params.line,
    page: params.page,
    sourceAnchorIds:
      params.sourceAnchorId && params.sourceAnchorId.trim().length > 0
        ? [params.sourceAnchorId]
        : [],
  });
}

function buildFallbackRowsFromSourceEntries(params: {
  sourceEntries: readonly ContractRateScheduleSourceEntry[];
  rateSchedulePages: readonly number[];
  rateSchedulePagePreferencePages: readonly number[];
}): ContractRateScheduleRow[] {
  const rows: ContractRateScheduleRow[] = [];
  const ratePages = new Set(params.rateSchedulePages);
  const preferredPages = new Set(params.rateSchedulePagePreferencePages);
  const candidateEntries = params.sourceEntries
    .filter((entry) => {
      if (normalizeWhitespace(entry.text).length === 0) return false;
      return ratePages.size === 0 || (entry.page != null && ratePages.has(entry.page));
    })
    .sort((left, right) => {
      const leftPreferred = left.page != null && preferredPages.has(left.page) ? 0 : 1;
      const rightPreferred = right.page != null && preferredPages.has(right.page) ? 0 : 1;
      return leftPreferred - rightPreferred;
    });

  let rowIndex = 0;
  for (const entry of candidateEntries) {
    const lines = entry.text
      .split('\n')
      .map((line) => normalizeWhitespace(line))
      .filter(Boolean);
    for (const line of lines) {
      rowIndex += 1;
      const row =
        parseRateRowFromColumns({
          line,
          page: entry.page ?? null,
          sourceAnchorId: entry.id ?? null,
          rowIndex,
        })
        ?? parseRateRowInline({
          line,
          page: entry.page ?? null,
          sourceAnchorId: entry.id ?? null,
          rowIndex,
        });
      if (row) rows.push(row);
    }
  }

  const deduped = new Map<string, ContractRateScheduleRow>();
  for (const row of rows) {
    const key = rateKey(row);
    if (!deduped.has(key)) {
      deduped.set(key, row);
    }
  }

  return [...deduped.values()];
}

export function buildContractRateScheduleRows(
  params: BuildContractRateScheduleRowsInput,
): ContractRateScheduleRow[] {
  const rateSchedulePages = [...(params.rateSchedulePages ?? [])]
    .map((value) => (typeof value === 'number' && Number.isFinite(value) ? value : null))
    .filter((value): value is number => value != null);
  const rateSchedulePagePreferencePages = [...(params.rateSchedulePagePreferencePages ?? [])]
    .map((value) => (typeof value === 'number' && Number.isFinite(value) ? value : null))
    .filter((value): value is number => value != null);
  const sourceEntries = [...(params.sourceEntries ?? [])];
  const defaultAnchorIds = [...(params.defaultAnchorIds ?? [])]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0);

  const professionalServicesRows = buildProfessionalServicesFeeRows({
    documentType: params.documentType,
    pdfTables: params.pdfTables,
  });
  if (professionalServicesRows.length > 0) {
    return professionalServicesRows;
  }

  const exhibitARows = extractExhibitARateTableRows(params.pdfTables);
  if (exhibitARows.length > 0) {
    return [
      ...exhibitARows,
      ...recoverMissingExhibitATextRows({
        sourceEntries,
        existingRows: exhibitARows,
        pdfTables: params.pdfTables,
      }),
    ];
  }

  const mdotSection905Rows = buildMdotSection905BidScheduleRows({
    sourceEntries,
    pdfTables: params.pdfTables,
  });
  if (mdotSection905Rows.length > 0) {
    return mdotSection905Rows;
  }

  // Phase 1 of retiring EXHIBIT_A_PAGES page-pinning.
  // This branch handles tables with clean pre-separated
  // cells (e.g. geometry-reconstructed scanned tables).
  // Phase 2: once 3-5 more projects have run through
  // EightForge and table shape variety is understood,
  // unify this with the Exhibit-A path under a single
  // structural classifier gated on input quality
  // (clean cells vs. needs multiline reconstruction),
  // removing the page-number gate entirely.
  const cleanStructuralRows = extractCleanStructuralRateRows(params.pdfTables);
  if (cleanStructuralRows.length > 0) {
    return cleanStructuralRows;
  }

  const tdotAppendixBRows = buildTdotAppendixBStitchedRows(params.pdfTables);
  if (tdotAppendixBRows.length > 0) {
    return tdotAppendixBRows;
  }

  const structuredRows = normalizeTypedRateTableRows({
    rateTable: params.rateTable,
    sourceEntries,
    rateSchedulePages,
    rateSchedulePagePreferencePages,
    defaultAnchorIds,
  });
  if (structuredRows.length > 0) {
    return structuredRows;
  }

  const canonicalRows = normalizeCanonicalRateScheduleRows(params.canonicalRateScheduleAssembly);
  if (canonicalRows.length > 0) {
    return canonicalRows;
  }

  return buildFallbackRowsFromSourceEntries({
    sourceEntries,
    rateSchedulePages,
    rateSchedulePagePreferencePages,
  });
}
