import { normalizeCode, readRowString } from '@/lib/validator/shared';

/**
 * Canonical billing key normalization for contract rate schedules, invoice lines,
 * and transaction rows. Raw source fields remain unchanged; derived keys are
 * computed additively and deterministically.
 *
 * Keys:
 * - `billing_rate_key`: primary reconciliation key. Prefer normalized `rate_code`;
 *   else short code-shaped description text; else `desc:<normalized description>`;
 *   else `sm:<service>|<material>`.
 * - `description_match_key`: normalized description only.
 * - `site_material_key`: normalized disposal site or site type plus material.
 * - `invoice_rate_key`: normalized invoice number + `::` + `billing_rate_key`.
 *
 * Match priority:
 * 1. exact rate code
 * 2. normalized description
 * 3. service item + material fallback
 *
 * The code-shaped description branch exists so values like "1 A" can reconcile
 * with sources that store the same concept as `rate_code=1A`.
 */

/** Alphanumeric rate/item code, for example "1 A" or "1-a" -> "1A". */
export function normalizeRateCode(value: string | null | undefined): string | null {
  return normalizeCode(value);
}

/** Normalized free text for description matching. */
export function normalizeRateDescription(value: string | null | undefined): string | null {
  if (value == null) return null;
  const cleaned = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length > 0 ? cleaned : null;
}

export function normalizeMaterial(value: string | null | undefined): string | null {
  return normalizeRateDescription(value);
}

export function normalizeServiceItem(value: string | null | undefined): string | null {
  return normalizeRateDescription(value);
}

export function normalizeSiteType(value: string | null | undefined): string | null {
  return normalizeRateDescription(value);
}

export function normalizeDisposalSite(value: string | null | undefined): string | null {
  return normalizeRateDescription(value);
}

/** Invoice/document numbers normalized into a join-safe alphanumeric key. */
export function normalizeInvoiceNumber(value: string | null | undefined): string | null {
  return normalizeCode(value);
}

/** Description-only fallback key. */
export function deriveDescriptionMatchKey(description: string | null | undefined): string | null {
  return normalizeRateDescription(description);
}

export type BillingRateKeyInput = {
  rate_code?: string | null;
  rate_description?: string | null;
  description?: string | null;
  service_item?: string | null;
  material?: string | null;
};

/**
 * True when description text likely holds a rate code (for example "1 A", "5B")
 * rather than a sentence.
 */
export function rateDescriptionProbablyCode(value: string | null | undefined): boolean {
  if (value == null) return false;
  const text = value.trim();
  if (text.length === 0 || text.length > 24) return false;
  const segments = text.split(/[\s\-\u2013\u2014]+/).filter((segment) => segment.length > 0);
  if (segments.length > 2) return false;
  return segments.every((segment) => /^[A-Za-z0-9]+$/i.test(segment));
}

/**
 * Primary reconciliation key for pricing rows.
 * Priority: normalized rate_code -> code-shaped description ->
 * normalized description -> service_item + material.
 */
export function deriveBillingRateKey(input: BillingRateKeyInput): string | null {
  const fromCode = normalizeRateCode(input.rate_code);
  if (fromCode) return fromCode;

  const textSource = input.rate_description ?? input.description;
  const fromDescriptionAsCode =
    rateDescriptionProbablyCode(textSource) ? normalizeRateCode(textSource) : null;
  if (fromDescriptionAsCode) return fromDescriptionAsCode;

  const fromDescription = normalizeRateDescription(textSource);
  if (fromDescription) return `desc:${fromDescription}`;

  const serviceItem = normalizeServiceItem(input.service_item);
  const material = normalizeMaterial(input.material);
  if (serviceItem || material) {
    return `sm:${[serviceItem, material].filter(Boolean).join('|')}`;
  }

  return null;
}

export type SiteMaterialKeyInput = {
  site_type?: string | null;
  disposal_site?: string | null;
  material?: string | null;
};

/** Site/facility context plus material. Either part may be omitted. */
export function deriveSiteMaterialKey(input: SiteMaterialKeyInput): string | null {
  const site =
    normalizeDisposalSite(input.disposal_site)
    ?? normalizeSiteType(input.site_type);
  const material = normalizeMaterial(input.material);

  if (!site && !material) return null;
  if (!site && material) return `m:${material}`;
  if (site && !material) return `s:${site}`;
  return `s:${site}|m:${material}`;
}

/** Invoice-scoped rate identity. */
export function deriveInvoiceRateKey(
  invoiceNumber: string | null | undefined,
  billingRateKey: string | null | undefined,
): string | null {
  if (!billingRateKey) return null;
  const normalizedInvoiceNumber = normalizeInvoiceNumber(invoiceNumber);
  if (!normalizedInvoiceNumber) return null;
  return `${normalizedInvoiceNumber}::${billingRateKey}`;
}

export type RateScheduleBillingSource = {
  rate_code: string | null;
  description: string | null;
  material_type: string | null;
  unit_type: string | null;
  service_item?: string | null;
};

export function deriveBillingKeysForRateScheduleItem(
  item: RateScheduleBillingSource,
): {
  billing_rate_key: string | null;
  description_match_key: string | null;
  site_material_key: string | null;
} {
  const billing_rate_key = deriveBillingRateKey({
    rate_code: item.rate_code,
    rate_description: item.description,
    service_item: item.service_item ?? null,
    material: item.material_type,
  });
  const description_match_key = deriveDescriptionMatchKey(item.description);
  // `unit_type` is UOM, not site context, so only material participates here
  // unless a dedicated site column is added later.
  const site_material_key = deriveSiteMaterialKey({
    material: item.material_type,
  });

  return { billing_rate_key, description_match_key, site_material_key };
}

export type InvoiceLineBillingSource = {
  rate_code: string | null;
  description: string | null;
  service_item?: string | null;
  material?: string | null;
};

export function deriveBillingKeysForInvoiceLine(
  line: InvoiceLineBillingSource,
): {
  billing_rate_key: string | null;
  description_match_key: string | null;
  site_material_key: string | null;
} {
  const billing_rate_key = deriveBillingRateKey({
    rate_code: line.rate_code,
    rate_description: line.description,
    description: line.description,
    service_item: line.service_item ?? null,
    material: line.material ?? null,
  });
  const description_match_key = deriveDescriptionMatchKey(line.description);
  const site_material_key = deriveSiteMaterialKey({
    material: line.material ?? null,
  });

  return { billing_rate_key, description_match_key, site_material_key };
}

export type TransactionBillingSource = {
  invoice_number?: string | null;
  rate_code?: string | null;
  rate_description?: string | null;
  service_item?: string | null;
  material?: string | null;
  disposal_site?: string | null;
  site_type?: string | null;
};

export function deriveBillingKeysForTransactionRecord(
  source: TransactionBillingSource,
): {
  billing_rate_key: string | null;
  description_match_key: string | null;
  site_material_key: string | null;
  invoice_rate_key: string | null;
} {
  const billing_rate_key = deriveBillingRateKey({
    rate_code: source.rate_code,
    rate_description: source.rate_description,
    service_item: source.service_item ?? null,
    material: source.material ?? null,
  });
  const description_match_key = deriveDescriptionMatchKey(source.rate_description);
  const site_material_key = deriveSiteMaterialKey({
    disposal_site: source.disposal_site,
    site_type: source.site_type,
    material: source.material ?? null,
  });
  const invoice_rate_key = deriveInvoiceRateKey(source.invoice_number, billing_rate_key);

  return { billing_rate_key, description_match_key, site_material_key, invoice_rate_key };
}

export function billingRateKeyForScheduleItem(
  item: RateScheduleBillingSource & { billing_rate_key?: string | null },
): string | null {
  return item.billing_rate_key ?? deriveBillingKeysForRateScheduleItem(item).billing_rate_key;
}

export function billingRateKeyForInvoiceLine(
  line: InvoiceLineBillingSource & { billing_rate_key?: string | null },
): string | null {
  return line.billing_rate_key ?? deriveBillingKeysForInvoiceLine(line).billing_rate_key;
}

/** Optional raw schedule row: pick service-item style columns when present. */
export function readServiceItemFromScheduleRow(row: Record<string, unknown>): string | null {
  return readRowString(row, [
    'service_item',
    'service_item_code',
    'service_code',
    'item_service',
  ]);
}

export type RateScheduleMatchable = RateScheduleBillingSource & {
  record_id: string;
  rate_amount?: number | null;
  billing_rate_key?: string | null;
  description_match_key?: string | null;
  canonical_category?: string | null;
  source_category?: string | null;
  source_kind?: string | null;
  source_quality?: string | null;
  confidence?: string | null;
  raw_value?: unknown;
};

export type InvoiceLineMatchable = InvoiceLineBillingSource & {
  billing_rate_key?: string | null;
  description_match_key?: string | null;
  unit_price?: number | null;
  unit_type?: string | null;
  unit?: string | null;
  canonical_category?: string | null;
  line_total?: number | null;
  quantity?: number | null;
};

export type BillingScheduleIndex<T> = {
  byBillingKey: Map<string, T[]>;
  byDescriptionKey: Map<string, T[]>;
  items: readonly T[];
};

export function indexRateScheduleItemsByCanonicalKeys<T extends RateScheduleMatchable>(
  items: readonly T[],
): BillingScheduleIndex<T> {
  const byBillingKey = new Map<string, T[]>();
  const byDescriptionKey = new Map<string, T[]>();

  for (const item of items) {
    const billingKey = billingRateKeyForScheduleItem(item);
    if (billingKey) {
      const existing = byBillingKey.get(billingKey) ?? [];
      existing.push(item);
      byBillingKey.set(billingKey, existing);
    }

    const descriptionKey =
      item.description_match_key ?? deriveDescriptionMatchKey(item.description);
    if (descriptionKey) {
      const existing = byDescriptionKey.get(descriptionKey) ?? [];
      existing.push(item);
      byDescriptionKey.set(descriptionKey, existing);
    }
  }

  return { byBillingKey, byDescriptionKey, items };
}

type ExactCandidateReason = 'exact_billing_key' | 'exact_description_key';
type RateScheduleMatchReason = ExactCandidateReason | 'operational_fallback';

function findExactRateScheduleCandidatesForInvoiceLine<T extends RateScheduleMatchable>(
  line: InvoiceLineMatchable,
  index: BillingScheduleIndex<T>,
): {
  candidates: T[];
  reason: ExactCandidateReason | null;
} {
  const billingKey =
    line.billing_rate_key ?? deriveBillingKeysForInvoiceLine(line).billing_rate_key;
  if (billingKey) {
    const candidates = index.byBillingKey.get(billingKey) ?? [];
    if (candidates.length > 0) {
      return { candidates, reason: 'exact_billing_key' };
    }
  }

  const descriptionKey =
    line.description_match_key ?? deriveDescriptionMatchKey(line.description);
  if (descriptionKey) {
    const candidates = index.byDescriptionKey.get(descriptionKey) ?? [];
    if (candidates.length > 0) {
      return { candidates, reason: 'exact_description_key' };
    }
  }

  return { candidates: [], reason: null };
}

export function findRateScheduleCandidatesForInvoiceLine<T extends RateScheduleMatchable>(
  line: InvoiceLineMatchable,
  index: BillingScheduleIndex<T>,
): T[] {
  return findExactRateScheduleCandidatesForInvoiceLine(line, index).candidates;
}

export function selectBestRateScheduleItemForInvoiceLine<T extends RateScheduleMatchable>(
  rawCandidates: readonly T[],
  line: InvoiceLineMatchable,
): T | null {
  if (rawCandidates.length === 0) return null;
  if (rawCandidates.length === 1) return rawCandidates[0] ?? null;

  let candidates = [...rawCandidates];
  const billedRate = line.unit_price;
  if (billedRate != null) {
    const exactRateMatches = candidates.filter((candidate) => (
      candidate.rate_amount != null
      && Math.abs(candidate.rate_amount - billedRate) <= 0.01
    ));
    if (exactRateMatches.length === 1) {
      return exactRateMatches[0] ?? null;
    }
    if (exactRateMatches.length > 1) {
      candidates = exactRateMatches;
    }
  }

  const lineDescriptionKey =
    line.description_match_key ?? deriveDescriptionMatchKey(line.description);
  if (lineDescriptionKey) {
    const descriptionKeyMatches = candidates.filter((candidate) => {
      const candidateKey =
        candidate.description_match_key
        ?? deriveDescriptionMatchKey(candidate.description);
      return candidateKey != null && candidateKey === lineDescriptionKey;
    });
    if (descriptionKeyMatches.length === 1) {
      return descriptionKeyMatches[0] ?? null;
    }
    if (descriptionKeyMatches.length > 1) {
      candidates = descriptionKeyMatches;
    }
  }

  const normalizedDescription = normalizeRateDescription(line.description);
  if (normalizedDescription) {
    const descriptionMatches = candidates.filter((candidate) => {
      const candidateDescription = normalizeRateDescription(candidate.description);
      if (!candidateDescription) return false;
      return candidateDescription === normalizedDescription
        || candidateDescription.includes(normalizedDescription)
        || normalizedDescription.includes(candidateDescription);
    });
    if (descriptionMatches.length === 1) {
      return descriptionMatches[0] ?? null;
    }
    if (descriptionMatches.length > 1) {
      candidates = descriptionMatches;
    }
  }

  return candidates.sort((left, right) => (
    left.record_id.localeCompare(right.record_id, 'en-US')
  ))[0] ?? null;
}

const OPERATIONAL_RATE_TOLERANCE = 0.01;
const MIN_OPERATIONAL_DESCRIPTION_SCORE = 0.45;
const MIN_NEEDS_REVIEW_DESCRIPTION_SCORE = 0.75;
const AMBIGUOUS_SCORE_TOLERANCE = 0.0001;

const DESCRIPTION_STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'from',
  'for',
  'in',
  'of',
  'on',
  'or',
  'the',
  'to',
  'with',
]);

type OperationalScoredCandidate<T> = {
  item: T;
  score: number;
  descriptionScore: number;
  rateMatches: boolean;
  rateDelta: number | null;
};

export type OperationalRateScheduleCandidateResult<T> = {
  candidates: T[];
  candidate_count: number;
  ambiguous: boolean;
  match: T | null;
};

function primitiveRawText(value: unknown): string[] {
  if (value == null) return [];
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return [String(value)];
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry) => primitiveRawText(entry));
  }
  if (typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).flatMap((entry) =>
      primitiveRawText(entry));
  }
  return [];
}

function candidateSearchText(item: RateScheduleMatchable): string {
  return [
    item.description,
    item.service_item,
    item.material_type,
    item.source_category,
    item.canonical_category,
    item.unit_type,
    ...primitiveRawText(item.raw_value),
  ]
    .filter((value): value is string => value != null && value.length > 0)
    .join(' ');
}

function normalizeOperationalText(value: string | null | undefined): string {
  return (value ?? '')
    .toLowerCase()
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/&/g, ' and ')
    .replace(/\bfds\b/g, 'final disposal')
    .replace(/\bmiles?from\b/g, 'miles from')
    .replace(/\bt6\b/g, 'to')
    .replace(/[^a-z0-9-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function operationalTokens(value: string | null | undefined): string[] {
  const text = normalizeOperationalText(value);
  if (!text) return [];
  return text
    .replace(/-/g, ' ')
    .split(' ')
    .map((token) => token.trim())
    .filter((token) => token.length > 0 && !DESCRIPTION_STOP_WORDS.has(token));
}

function editDistance(left: string, right: string): number {
  if (left === right) return 0;
  if (left.length === 0) return right.length;
  if (right.length === 0) return left.length;

  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  const current = Array.from({ length: right.length + 1 }, () => 0);

  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    current[0] = leftIndex;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const cost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
      current[rightIndex] = Math.min(
        previous[rightIndex] + 1,
        current[rightIndex - 1] + 1,
        previous[rightIndex - 1] + cost,
      );
    }
    for (let index = 0; index < previous.length; index += 1) {
      previous[index] = current[index] ?? 0;
    }
  }

  return previous[right.length] ?? Math.max(left.length, right.length);
}

function tokensCompatible(left: string, right: string): boolean {
  if (left === right) return true;
  if (/^\d+$/.test(left) || /^\d+$/.test(right)) return false;
  if (left.length < 5 || right.length < 5) return false;
  return editDistance(left, right) <= (Math.max(left.length, right.length) >= 10 ? 2 : 1);
}

function descriptionTokenScore(
  invoiceDescription: string | null | undefined,
  contractText: string,
): number {
  const invoiceTokens = operationalTokens(invoiceDescription);
  if (invoiceTokens.length === 0) return 0;
  const contractTokens = operationalTokens(contractText);
  if (contractTokens.length === 0) return 0;

  let matched = 0;
  for (const invoiceToken of invoiceTokens) {
    if (contractTokens.some((contractToken) => tokensCompatible(invoiceToken, contractToken))) {
      matched += 1;
    }
  }

  return matched / invoiceTokens.length;
}

function detectRoute(value: string | null | undefined): string | null {
  const text = normalizeOperationalText(value);
  if (/\brow\b/.test(text) && /\bdms\b/.test(text)) return 'row_to_dms';
  return null;
}

function detectDistanceBand(value: string | null | undefined): { start: number; end: number } | null {
  const text = normalizeOperationalText(value);
  const match = text.match(/\b(\d+)\s*(?:to|-)\s*(\d+)\b/);
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return { start: Math.min(start, end), end: Math.max(start, end) };
}

function distanceBandsOverlap(
  left: { start: number; end: number } | null,
  right: { start: number; end: number } | null,
): boolean {
  if (!left || !right) return false;
  return left.start <= right.end && right.start <= left.end;
}

function operationalDescriptionScore(line: InvoiceLineMatchable, item: RateScheduleMatchable): number {
  const contractText = candidateSearchText(item);
  let score = descriptionTokenScore(line.description, contractText);
  const lineRoute = detectRoute(line.description);
  const contractRoute = detectRoute(contractText);
  if (lineRoute != null && contractRoute === lineRoute) {
    score += 0.05;
  }

  const lineDistance = detectDistanceBand(line.description);
  const contractDistance = detectDistanceBand(contractText);
  if (distanceBandsOverlap(lineDistance, contractDistance)) {
    score += 0.05;
  }

  return Math.min(1, score);
}

function inferOperationalCategory(value: string | null | undefined): string | null {
  const text = normalizeOperationalText(value);
  if (!text) return null;

  if (
    /\bfinal\s+disposal\b/.test(text)
    || (/\bdms\b/.test(text) && /\bfinal\b/.test(text) && /\bdisposal\b/.test(text))
  ) {
    return 'final_disposal';
  }
  if (
    /\bmanagement\b/.test(text)
    || /\breduction\b/.test(text)
    || /\bgrinding\b/.test(text)
    || /\bchipping\b/.test(text)
    || /\bair\s+curtain\b/.test(text)
    || /\bopen\s+burning\b/.test(text)
  ) {
    return 'management_reduction';
  }
  if (/\btree\b/.test(text) || /\btrees\b/.test(text) || /\bhazardous\b/.test(text) || /\blimb/.test(text)) {
    return 'tree_operations';
  }
  if (/\bc\s+and\s+d\b/.test(text) || /\bc\s+d\b/.test(text) || /\bconstruction\b/.test(text)) {
    return 'construction_demolition';
  }
  if (
    /\bvegetative\b/.test(text)
    || /\brural\b/.test(text)
    || /\bunincorporated\b/.test(text)
    || (/\brow\b/.test(text) && /\bdms\b/.test(text))
  ) {
    return 'vegetative_removal';
  }

  return null;
}

function categoriesCompatible(line: InvoiceLineMatchable, item: RateScheduleMatchable): boolean {
  const invoiceCategory = normalizeRateDescription(line.canonical_category ?? line.material);
  const contractCategory = normalizeRateDescription(
    item.canonical_category ?? item.source_category ?? item.material_type,
  );
  const inferredInvoiceCategory = inferOperationalCategory(line.description);
  const inferredContractCategory = inferOperationalCategory(candidateSearchText(item));
  if (
    inferredInvoiceCategory != null
    && inferredContractCategory != null
    && inferredInvoiceCategory === inferredContractCategory
  ) {
    return true;
  }
  if (!invoiceCategory || !contractCategory) return true;
  return invoiceCategory === contractCategory
    || invoiceCategory.includes(contractCategory)
    || contractCategory.includes(invoiceCategory);
}

function normalizeOperationalUnit(
  unit: string | null | undefined,
  context: string | null | undefined,
): string | null {
  const rawUnit = normalizeRateDescription(unit);
  const rawContext = normalizeOperationalText(context);
  const combined = `${rawUnit ?? ''} ${rawContext}`;
  const hasCubicYard =
    /\bc\s*y\b/.test(combined)
    || /\bcyd\b/.test(combined)
    || /\bcubic\s+yards?\b/.test(combined)
    || /\byards?\b/.test(combined);
  const hasMiles = /\bmiles?\b/.test(combined);

  if (rawUnit === 'miles' && hasCubicYard && hasMiles) return null;
  if (hasCubicYard) return 'cubic_yard';
  if (rawUnit && hasMiles) return 'mile';
  if (!rawUnit) return null;
  return rawUnit;
}

function unitsCompatible(line: InvoiceLineMatchable, item: RateScheduleMatchable): boolean {
  const lineUnit = normalizeOperationalUnit(line.unit_type ?? line.unit, line.description);
  const itemUnit = normalizeOperationalUnit(item.unit_type, candidateSearchText(item));
  if (!lineUnit || !itemUnit) return true;
  return lineUnit === itemUnit;
}

function scoreOperationalCandidate<T extends RateScheduleMatchable>(
  line: InvoiceLineMatchable,
  item: T,
): OperationalScoredCandidate<T> | null {
  const descriptionScore = operationalDescriptionScore(line, item);
  if (!categoriesCompatible(line, item)) return null;
  if (!unitsCompatible(line, item)) return null;

  const rateDelta =
    line.unit_price != null && item.rate_amount != null
      ? Math.abs(line.unit_price - item.rate_amount)
      : null;
  const rateMatches = rateDelta != null && rateDelta <= OPERATIONAL_RATE_TOLERANCE;
  if (!rateMatches) return null;

  if (item.source_quality === 'junk') return null;
  const minimumDescriptionScore =
    item.confidence === 'needs_review'
      ? MIN_NEEDS_REVIEW_DESCRIPTION_SCORE
      : MIN_OPERATIONAL_DESCRIPTION_SCORE;
  if (descriptionScore < minimumDescriptionScore) return null;

  const score =
    descriptionScore
    + (rateMatches ? 0.2 : 0)
    + (rateDelta != null ? Math.max(0, 0.05 - Math.min(rateDelta, 0.05)) : 0);

  return {
    item,
    score,
    descriptionScore,
    rateMatches,
    rateDelta,
  };
}

function selectOperationalCandidate<T extends RateScheduleMatchable>(
  scored: readonly OperationalScoredCandidate<T>[],
): {
  match: T | null;
  ambiguous: boolean;
} {
  if (scored.length === 0) return { match: null, ambiguous: false };
  const sorted = [...scored].sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    return left.item.record_id.localeCompare(right.item.record_id, 'en-US');
  });
  const best = sorted[0];
  if (!best) return { match: null, ambiguous: false };

  const equallyPlausible = sorted.filter((candidate) =>
    Math.abs(candidate.score - best.score) <= AMBIGUOUS_SCORE_TOLERANCE);
  if (equallyPlausible.length > 1) {
    const sameContractSlot = new Set(equallyPlausible.map((candidate) => [
      normalizeRateDescription(candidate.item.description) ?? '',
      inferOperationalCategory(candidateSearchText(candidate.item))
        ?? normalizeRateDescription(candidate.item.canonical_category ?? candidate.item.source_category ?? candidate.item.material_type)
        ?? '',
      normalizeRateDescription(candidate.item.unit_type) ?? '',
      candidate.item.rate_amount != null ? candidate.item.rate_amount.toFixed(2) : '',
    ].join('|')));
    if (sameContractSlot.size === 1) {
      const preferred = [...equallyPlausible].sort((left, right) => {
        const sourceQualityScore = (candidate: OperationalScoredCandidate<T>) =>
          candidate.item.source_quality === 'clean' ? 0 : 1;
        const sourceKindScore = (candidate: OperationalScoredCandidate<T>) =>
          candidate.item.source_kind === 'exhibit_a_table'
            || candidate.item.source_kind === 'exhibit_a_text_recovery'
            || candidate.item.record_id.startsWith('exhibit_a_')
            ? 0
            : 1;
        const qualityDelta = sourceQualityScore(left) - sourceQualityScore(right);
        if (qualityDelta !== 0) return qualityDelta;
        const kindDelta = sourceKindScore(left) - sourceKindScore(right);
        if (kindDelta !== 0) return kindDelta;
        return left.item.record_id.localeCompare(right.item.record_id, 'en-US');
      })[0];
      return { match: preferred?.item ?? null, ambiguous: false };
    }
    return { match: null, ambiguous: true };
  }

  return { match: best.item, ambiguous: false };
}

function exactDescriptionCandidateStillFitsInvoiceLine(
  line: InvoiceLineMatchable,
  item: RateScheduleMatchable,
): boolean {
  if (item.source_quality === 'junk') return false;
  if (!categoriesCompatible(line, item)) return false;
  if (!unitsCompatible(line, item)) return false;

  if (line.unit_price != null && item.rate_amount != null) {
    return Math.abs(line.unit_price - item.rate_amount) <= OPERATIONAL_RATE_TOLERANCE;
  }

  return true;
}

export function findOperationalRateScheduleCandidatesForInvoiceLine<T extends RateScheduleMatchable>(
  line: InvoiceLineMatchable,
  index: BillingScheduleIndex<T>,
): OperationalRateScheduleCandidateResult<T> {
  const scored = index.items
    .map((item) => scoreOperationalCandidate(line, item))
    .filter((candidate): candidate is OperationalScoredCandidate<T> => candidate != null)
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      return left.item.record_id.localeCompare(right.item.record_id, 'en-US');
    });
  const selection = selectOperationalCandidate(scored);
  const candidates = scored.map((candidate) => candidate.item);

  return {
    candidates,
    candidate_count: candidates.length,
    ambiguous: selection.ambiguous,
    match: selection.match,
  };
}

export function matchRateScheduleItemForInvoiceLine<T extends RateScheduleMatchable>(
  line: InvoiceLineMatchable,
  index: BillingScheduleIndex<T>,
): {
  candidates: T[];
  match: T | null;
  candidate_count: number;
  ambiguous: boolean;
  match_reason: RateScheduleMatchReason | null;
} {
  const exact = findExactRateScheduleCandidatesForInvoiceLine(line, index);
  if (exact.candidates.length > 0) {
    const exactMatch = selectBestRateScheduleItemForInvoiceLine(exact.candidates, line);
    if (
      (exact.reason === 'exact_description_key' || line.rate_code == null)
      && (
        exactMatch == null
        || !exactDescriptionCandidateStillFitsInvoiceLine(line, exactMatch)
      )
    ) {
      return {
        candidates: exact.candidates,
        match: null,
        candidate_count: exact.candidates.length,
        ambiguous: false,
        match_reason: exact.reason,
      };
    }

    return {
      candidates: exact.candidates,
      match: exactMatch,
      candidate_count: exact.candidates.length,
      ambiguous: false,
      match_reason: exact.reason,
    };
  }

  const operational = findOperationalRateScheduleCandidatesForInvoiceLine(line, index);
  if (operational.candidate_count > 0) {
    return {
      candidates: operational.candidates,
      match: operational.match,
      candidate_count: operational.candidate_count,
      ambiguous: operational.ambiguous,
      match_reason: 'operational_fallback',
    };
  }

  return {
    candidates: exact.candidates,
    match: null,
    candidate_count: exact.candidates.length,
    ambiguous: false,
    match_reason: exact.reason,
  };
}

export type InvoiceGroupedTransactionMatchInput = {
  invoice_rate_key?: string | null;
  billing_rate_key?: string | null;
  normalized_invoice_number?: string | null;
};

export type TransactionRowMatchIndex<T> = {
  byInvoiceRateKey: Map<string, T[]>;
  byBillingRateKey: Map<string, T[]>;
};

type TransactionRowInvoiceScope = {
  meaningful_data?: boolean;
  normalized_invoice_number?: string | null;
};

/**
 * Match persisted transaction support rows for an invoice line group.
 * Invoice number scope is enforced before project-wide billing-rate fallback.
 */
export function matchTransactionRowsForInvoiceGroup<T extends TransactionRowInvoiceScope>(
  group: InvoiceGroupedTransactionMatchInput,
  indexes: TransactionRowMatchIndex<T>,
): T[] {
  const isMeaningful = (row: T) => row.meaningful_data !== false;

  if (group.invoice_rate_key) {
    const invoiceRateRows = indexes.byInvoiceRateKey.get(group.invoice_rate_key) ?? [];
    if (invoiceRateRows.length > 0) {
      return invoiceRateRows.filter(isMeaningful);
    }
  }

  if (group.billing_rate_key && group.normalized_invoice_number) {
    const rateScoped = indexes.byBillingRateKey.get(group.billing_rate_key) ?? [];
    return rateScoped.filter(
      (row) =>
        isMeaningful(row)
        && row.normalized_invoice_number === group.normalized_invoice_number,
    );
  }

  return [];
}
