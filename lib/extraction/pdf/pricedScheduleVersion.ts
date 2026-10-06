/** Storage-envelope keys and raw observation identities are separate contracts. */
export const LEGACY_PRICED_SCHEDULE_RECONSTRUCTION_VERSION = 'priced_schedule_reconstruction_v1';
/** v2: page reconstruction under the original four-role header vocabulary. Stored extractions keep it. */
export const PAGE_PRICED_SCHEDULE_RECONSTRUCTION_V2 = 'priced_schedule_reconstruction_v2';
/**
 * v3: the canonical header-role vocabulary. Supporting pricing-table roles
 * (category, quantity, amount, item_code) count toward header qualification;
 * "amount" and "total cost" no longer read as the unit rate; a lone "item" is
 * unknown; a later unqualified table header bounds the page. Row assembly is
 * unchanged.
 */
export const PAGE_PRICED_SCHEDULE_RECONSTRUCTION_V3 = 'priced_schedule_reconstruction_v3';
/**
 * v4 (current): v3, plus same-page table segments. A page printing more than
 * one independently qualifying priced-table header is read as one table per
 * header, each segment only against its own header, instead of failing whole.
 */
export const PAGE_PRICED_SCHEDULE_RECONSTRUCTION_VERSION = 'priced_schedule_reconstruction_v4';
export type PricedScheduleReconstructionVersion =
  | typeof LEGACY_PRICED_SCHEDULE_RECONSTRUCTION_VERSION
  | typeof PAGE_PRICED_SCHEDULE_RECONSTRUCTION_V2
  | typeof PAGE_PRICED_SCHEDULE_RECONSTRUCTION_V3
  | typeof PAGE_PRICED_SCHEDULE_RECONSTRUCTION_VERSION;

export function isSupportedPricedScheduleVersion(value: unknown): value is PricedScheduleReconstructionVersion {
  return value === LEGACY_PRICED_SCHEDULE_RECONSTRUCTION_VERSION || isPagePricedScheduleVersion(value);
}

/** A page reconstruction (v2, v3 or v4), as opposed to the legacy spacing-only one. */
export function isPagePricedScheduleVersion(value: unknown): value is
  typeof PAGE_PRICED_SCHEDULE_RECONSTRUCTION_V2 | typeof PAGE_PRICED_SCHEDULE_RECONSTRUCTION_V3
  | typeof PAGE_PRICED_SCHEDULE_RECONSTRUCTION_VERSION {
  return value === PAGE_PRICED_SCHEDULE_RECONSTRUCTION_V2 || value === PAGE_PRICED_SCHEDULE_RECONSTRUCTION_V3
    || value === PAGE_PRICED_SCHEDULE_RECONSTRUCTION_VERSION;
}
