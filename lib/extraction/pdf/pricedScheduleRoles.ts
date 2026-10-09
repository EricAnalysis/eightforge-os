import type { PricedScheduleAssemblyRole, PricedScheduleColumnRole } from '@/lib/extraction/pdf/pagePricedScheduleReconstruction';

/** Roles that take part in row assembly. Supporting pricing-table roles never do. */
export const PRICED_SCHEDULE_ASSEMBLY_ROLES: readonly PricedScheduleAssemblyRole[] = [
  'description', 'unit', 'origin_destination', 'rate',
];

/** The column's role when it takes part in row assembly; null for supporting and unrecognized columns. */
export function pricedScheduleAssemblyRole(role: PricedScheduleColumnRole | null): PricedScheduleAssemblyRole | null {
  return role != null && (PRICED_SCHEDULE_ASSEMBLY_ROLES as readonly string[]).includes(role)
    ? role as PricedScheduleAssemblyRole : null;
}
