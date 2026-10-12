import { z } from 'zod';
import { CustomerHeaderMappingPinSchema, readCustomerHeaderMappingPinsFromExtractionData } from './headerMappingConsumption';

/** Tenant-local provenance over the interpretation actually used, never active configuration. */
export const CustomerMappingEvidenceSchema = z.object({
  extractionSnapshotId: z.string().uuid(),
  mappingPins: z.array(CustomerHeaderMappingPinSchema).min(1).max(100),
}).strict();
export type CustomerMappingEvidence = Readonly<z.infer<typeof CustomerMappingEvidenceSchema>>;

export function customerMappingEvidenceFromExtraction(input: Readonly<{
  extractionData: unknown; extractionSnapshotId: string; organizationId: string;
  physicalPageNumber: number; pageRepresentationDigest: string | null;
  sourceObservationIds?: readonly string[];
}>): CustomerMappingEvidence | undefined {
  const mappingPins = readCustomerHeaderMappingPinsFromExtractionData(input.extractionData)
    .filter(pin => pin.physicalPageNumber === input.physicalPageNumber);
  if (mappingPins.length === 0 || mappingPins.some(pin => pin.organizationId !== input.organizationId
    || pin.pageRepresentationDigest !== input.pageRepresentationDigest)) return undefined;
  if (input.sourceObservationIds) {
    const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object'
      && !Array.isArray(value) ? value as Record<string, unknown> : null;
    const content = record(record(input.extractionData)?.extraction);
    const reconstruction = record(record(record(content?.content_layers_v1)?.pdf)?.priced_schedule_reconstruction_v1);
    const pages = Array.isArray(reconstruction?.pages) ? reconstruction.pages.map(record) : [];
    const matchingPages = pages.filter(value => value?.physical_page_number === input.physicalPageNumber);
    if (matchingPages.length !== 1) return undefined;
    const page = matchingPages[0];
    const rows = Array.isArray(page?.rows) ? page.rows.map(record) : [];
    const contained = input.sourceObservationIds.length > 0 && rows.some(row => {
      const cells = [...(Array.isArray(row?.cells) ? row.cells : []),
        ...(Array.isArray(row?.unresolved_role_cells) ? row.unresolved_role_cells : [])].map(record);
      const ids = new Set(cells.flatMap(cell => Array.isArray(cell?.source_refs)
        ? cell.source_refs.map(record).flatMap(ref => typeof ref?.observation_id === 'string' ? [ref.observation_id] : []) : []));
      return input.sourceObservationIds!.every(id => ids.has(id));
    });
    if (!contained) return undefined;
  }
  const parsed = CustomerMappingEvidenceSchema.safeParse({ extractionSnapshotId: input.extractionSnapshotId, mappingPins });
  return parsed.success ? parsed.data : undefined;
}
