/**
 * The single canonical-to-validator projection.
 *
 * Rule packs keep consuming the existing `RateScheduleItem` interface. In
 * canonical mode those items are derived here, once, from the frozen canonical
 * Project Truth registry instead of from legacy fact rows. No rule pack knows
 * which authority produced its input, and this mapping exists in exactly one
 * place so it cannot drift per pack (see the authority cutover amendment).
 *
 * Only value-bearing canonical states project a value. A canonical row whose
 * rate never resolved projects `rate_amount: null` rather than reaching back
 * into legacy truth for a rescue — canonical mode has no fallback.
 */

import type { CanonicalContractPricingSchedule } from '@/lib/canonical/contract/pricing';
import type { CanonicalContractPricingRow } from '@/lib/canonical/contract/pricing';
import { isValueBearingState } from '@/lib/canonical/truth/envelope';
import type { TruthEnvelope } from '@/lib/canonical/truth/envelope';
import { authoredRateRowQuarantine } from '@/lib/contracts/authoredRowQuarantine';
import { deriveBillingKeysForRateScheduleItem } from '@/lib/validator/billingKeys';
import type { RateScheduleItem } from '@/lib/validator/shared';

/**
 * Reads a canonical envelope as an authoritative value.
 *
 * Non-value-bearing states (absent, not applicable, unresolved conflict)
 * project `null`. `observedRaw` is deliberately NOT substituted: a raw
 * observation that canonical interpretation declined to resolve is evidence,
 * not truth.
 */
function authoritativeValue<T>(envelope: TruthEnvelope<T> | null | undefined): T | null {
  if (envelope == null) return null;
  if (!isValueBearingState(envelope.state)) return null;
  return envelope.value;
}

function authoritativeString(envelope: TruthEnvelope<string> | null | undefined): string | null {
  const value = authoritativeValue(envelope);
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function authoritativeNumber(envelope: TruthEnvelope<number> | null | undefined): number | null {
  const value = authoritativeValue(envelope);
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * True when a canonical row carries no operator-meaningful dimension.
 *
 * Mirrors the legacy emptiness gate in `normalizeRateScheduleItem` so canonical
 * mode does not introduce phantom rate rows that legacy mode would have
 * dropped, which would change Golden finding counts for a non-truth reason.
 */
function isProjectableRow(item: {
  readonly rate_code: string | null;
  readonly unit_type: string | null;
  readonly rate_amount: number | null;
  readonly material_type: string | null;
  readonly description: string | null;
}): boolean {
  return !(
    item.rate_code == null &&
    item.unit_type == null &&
    item.rate_amount == null &&
    item.material_type == null &&
    item.description == null
  );
}

function projectRow(
  row: CanonicalContractPricingRow,
  fallbackDocumentId: string | null,
): RateScheduleItem | null {
  const sourceDocumentId =
    row.governingDocument?.documentId
    ?? row.rateSchedule.governingSource?.documentId
    ?? fallbackDocumentId;

  // A rate row with no attributable source document is not authoritative
  // truth; provenance is mandatory, never inferred.
  if (sourceDocumentId == null) return null;

  const rateCode = authoritativeString(row.rateCode);
  const unitType = authoritativeString(row.unit);
  const rateAmount = authoritativeNumber(row.rate);
  const materialType = authoritativeString(row.materialType);
  const description = authoritativeString(row.description);
  const serviceItem = authoritativeString(row.serviceType);
  const sourceCategory = authoritativeString(row.category);

  const core = {
    rate_code: rateCode,
    unit_type: unitType,
    rate_amount: rateAmount,
    material_type: materialType,
    description,
  };
  if (!isProjectableRow(core)) return null;

  const keys = deriveBillingKeysForRateScheduleItem({
    rate_code: rateCode,
    description,
    material_type: materialType,
    unit_type: unitType,
    service_item: serviceItem,
  });

  const authoredQuarantine = authoredRateRowQuarantine({
    row_id: row.rowId,
    source_kind: row.sourceFamily.adapterId,
    authoredValueCorrection: row.authoredCorrection,
  });

  return {
    source_document_id: sourceDocumentId,
    // Canonical row identity is the authoritative record id so evidence
    // anchors and downstream matching stay traceable to the registry.
    record_id: row.rowId,
    rate_code: rateCode,
    unit_type: unitType,
    rate_amount: rateAmount,
    material_type: materialType,
    description,
    service_item: serviceItem,
    source_category: sourceCategory,
    canonical_category: sourceCategory,
    category_confidence: row.category.confidence,
    source_kind: row.sourceFamily.adapterId,
    source_quality: row.resolution.state,
    confidence: row.rate.state,
    authoredValueCorrection: row.authoredCorrection,
    authored_unverified: authoredQuarantine?.authoredUnverified ?? false,
    authored_quarantine: authoredQuarantine,
    raw_value: row.rawValues,
    ...keys,
  } satisfies RateScheduleItem;
}

/**
 * Projects canonical pricing schedules into validator rate schedule items.
 *
 * Ordering is deterministic: schedule order, then canonical row ordinal, then
 * row id. Two runs over the same frozen registry produce an identical array.
 */
export function projectCanonicalRateScheduleItems(
  schedules: readonly CanonicalContractPricingSchedule[],
): RateScheduleItem[] {
  const items: RateScheduleItem[] = [];
  for (const schedule of schedules) {
    const fallbackDocumentId = schedule.governingDocument?.documentId ?? null;
    const ordered = [...schedule.rows].sort((left, right) => {
      if (left.ordinal !== right.ordinal) return left.ordinal - right.ordinal;
      return left.rowId.localeCompare(right.rowId, 'en-US');
    });
    for (const row of ordered) {
      const projected = projectRow(row, fallbackDocumentId);
      if (projected != null) items.push(projected);
    }
  }
  return items;
}
