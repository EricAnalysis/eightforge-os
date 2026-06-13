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
};

export type InvoiceLineMatchable = InvoiceLineBillingSource & {
  billing_rate_key?: string | null;
  description_match_key?: string | null;
  unit_price?: number | null;
};

export type BillingScheduleIndex<T> = {
  byBillingKey: Map<string, T[]>;
  byDescriptionKey: Map<string, T[]>;
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

  return { byBillingKey, byDescriptionKey };
}

export function findRateScheduleCandidatesForInvoiceLine<T extends RateScheduleMatchable>(
  line: InvoiceLineMatchable,
  index: BillingScheduleIndex<T>,
): T[] {
  const billingKey =
    line.billing_rate_key ?? deriveBillingKeysForInvoiceLine(line).billing_rate_key;
  if (billingKey) {
    const candidates = index.byBillingKey.get(billingKey) ?? [];
    if (candidates.length > 0) return candidates;
  }

  const descriptionKey =
    line.description_match_key ?? deriveDescriptionMatchKey(line.description);
  if (descriptionKey) {
    return index.byDescriptionKey.get(descriptionKey) ?? [];
  }

  return [];
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

export function matchRateScheduleItemForInvoiceLine<T extends RateScheduleMatchable>(
  line: InvoiceLineMatchable,
  index: BillingScheduleIndex<T>,
): {
  candidates: T[];
  match: T | null;
} {
  const candidates = findRateScheduleCandidatesForInvoiceLine(line, index);
  return {
    candidates,
    match: selectBestRateScheduleItemForInvoiceLine(candidates, line),
  };
}
