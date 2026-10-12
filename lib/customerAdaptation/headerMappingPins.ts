import { z } from 'zod';
import type { PricedScheduleColumnRole } from '@/lib/extraction/pdf/pagePricedScheduleReconstruction';

export const CustomerHeaderMappingPinSchema = z.object({
  version: z.literal('customer_header_mapping_pin_v1'),
  organizationId: z.string().uuid(), documentType: z.string().min(1).max(512).refine(value => value.trim().length > 0),
  revisionId: z.string().uuid(), digest: z.string().regex(/^[a-f0-9]{64}$/),
  sourceSchemaIdentity: z.string().regex(/^customer-header-schema-v1:[a-f0-9]{64}$/),
  physicalPageNumber: z.number().int().positive(), columnIndex: z.number().int().nonnegative(),
  sourceLabel: z.string().min(1).max(512).refine(value => value.trim().length > 0),
  orderedObservationIds: z.array(z.string().regex(/^pdf:layout-token:v1:[a-f0-9]{64}$/)).min(1).max(200)
    .refine(ids => new Set(ids).size === ids.length),
  pageRepresentationDigest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type CustomerHeaderMappingPin = Readonly<Omit<z.infer<typeof CustomerHeaderMappingPinSchema>, 'orderedObservationIds'>
  & { orderedObservationIds: readonly string[] }>;
export type CustomerHeaderMappingAssignment = Readonly<{
  physicalPageNumber: number;
  pageRepresentationDigest: string;
  columns: readonly Readonly<{ text: string; orderedObservationIds: readonly string[]; role: PricedScheduleColumnRole | null }>[];
  pins: readonly CustomerHeaderMappingPin[];
}>;
