/** Storage-envelope keys and raw observation identities are separate contracts. */
export const LEGACY_PRICED_SCHEDULE_RECONSTRUCTION_VERSION = 'priced_schedule_reconstruction_v1';
export const PAGE_PRICED_SCHEDULE_RECONSTRUCTION_VERSION = 'priced_schedule_reconstruction_v2';
export type PricedScheduleReconstructionVersion =
  | typeof LEGACY_PRICED_SCHEDULE_RECONSTRUCTION_VERSION
  | typeof PAGE_PRICED_SCHEDULE_RECONSTRUCTION_VERSION;

export function isSupportedPricedScheduleVersion(value: unknown): value is PricedScheduleReconstructionVersion {
  return value === LEGACY_PRICED_SCHEDULE_RECONSTRUCTION_VERSION
    || value === PAGE_PRICED_SCHEDULE_RECONSTRUCTION_VERSION;
}
