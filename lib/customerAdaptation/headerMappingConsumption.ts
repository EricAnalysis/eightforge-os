import { z } from 'zod';
import { hashCanonical } from '@/lib/extraction/domain/hash';
import { customerHeaderSchemaIdentity } from './headerEvidence';
import { ReviewedCustomerHeaderMappingRevisionSchema, resolveCustomerHeaderMapping,
  type CustomerHeaderMappingContext } from './headerMapping';
import { resolvePdfLayoutSourceRefEvidence, type PdfLayoutObservationsLayer } from '@/lib/extraction/pdf/layoutObservationEvidence';
import { pricedScheduleHeaderRoles } from '@/lib/extraction/pdf/pagePricedScheduleReconstruction';
import { pricedScheduleAssemblyRole } from '@/lib/extraction/pdf/pricedScheduleRoles';
import { isPagePricedScheduleVersion } from '@/lib/extraction/pdf/pricedScheduleVersion';
import type { PagePricedScheduleReconstruction, PricedScheduleColumnRole } from '@/lib/extraction/pdf/pagePricedScheduleReconstruction';

/** Closed snapshots supplied only by the authenticated lifecycle loader. No lookup
 * or default/global fallback is performed by interpretation. */
export type { CustomerHeaderMappingContext } from './headerMapping';

export { CustomerHeaderMappingPinSchema } from './headerMappingPins';
export type { CustomerHeaderMappingPin, CustomerHeaderMappingAssignment } from './headerMappingPins';
import { CustomerHeaderMappingPinSchema, type CustomerHeaderMappingPin, type CustomerHeaderMappingAssignment } from './headerMappingPins';

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}

/** Fresh parser-owned structural evidence, checked against its exact observation
 * layer. Approval evidence remains the historical source binding in each revision. */
export function prepareCustomerHeaderMappingAssignments(input: Readonly<{
  mappingContext: CustomerHeaderMappingContext;
  reconstruction: PagePricedScheduleReconstruction;
  observations: PdfLayoutObservationsLayer;
  sourceDocumentId: string; sourceArtifactId: string;
  currentPageEvidence: Readonly<Record<number, { pageRepresentationDigest: string | null; recoveryAllowed: boolean }>>;
}>): readonly CustomerHeaderMappingAssignment[] {
  const context = input.mappingContext;
  if (!z.string().uuid().safeParse(context.organizationId).success || !context.documentType || !context.revisions.length) return [];
  const revisions = context.revisions.map(revision => ReviewedCustomerHeaderMappingRevisionSchema.safeParse(revision));
  if (revisions.some(result => !result.success || result.data.organizationId !== context.organizationId
    || result.data.scope.documentType !== context.documentType)) return [];
  const snapshots = revisions.flatMap(result => result.success ? [result.data] : []);
  if (new Set(snapshots.map(revision => revision.revisionId)).size !== snapshots.length) return [];
  const assignments: CustomerHeaderMappingAssignment[] = [];
  for (const page of input.reconstruction.pages) {
    if (page.semantic_status !== 'unresolved' || page.inherited_header || page.header_semantics || page.table_segment
      || page.customer_header_mapping_pins || page.columns.length < 2
      || input.reconstruction.pages.filter(other => other.physical_page_number === page.physical_page_number).length !== 1) continue;
    const interpretation = page.header_interpretation;
    if (!interpretation || interpretation.grouping_basis.clear !== true || interpretation.reason === 'ambiguous_label_grouping'
      || interpretation.labels.length !== page.columns.length) continue;
    const refs = page.columns.flatMap(column => column.header_source_refs ?? []);
    if (!refs.length || refs.some(ref => !ref.observation_id)
      || new Set(refs.map(ref => ref.observation_id)).size !== refs.length
      || hashCanonical(refs) !== hashCanonical(interpretation.source_refs)
      || page.columns.some((column, index) => column.header_text !== interpretation.labels[index]!.text
        || hashCanonical(column.header_source_refs) !== hashCanonical(interpretation.labels[index]!.source_refs)
        || column.header_text !== (column.header_source_refs ?? []).map(ref => ref.text).join(' '))
      || Math.max(...refs.map(ref => ref.y_min)) >= Math.min(...refs.map(ref => ref.y_max))
      || refs.some((ref, index) => index > 0 && ref.x_min < refs[index - 1]!.x_max)
      || new Set(refs.map(ref => ref.source)).size !== 1) continue;
    const sourceMethod = refs[0]!.source;
    if (sourceMethod !== 'pdfjs' && sourceMethod !== 'ocr_fallback') continue;
    const current = input.currentPageEvidence[page.physical_page_number];
    if (!current?.recoveryAllowed || !current.pageRepresentationDigest) continue;
    const verified = resolvePdfLayoutSourceRefEvidence({ sourceRefs: refs, physicalPageNumber: page.physical_page_number,
      persistedLayer: input.observations, context: { sourceDocumentId: input.sourceDocumentId,
        sourceArtifactId: input.sourceArtifactId, totalPhysicalPages: input.observations.total_physical_pages } });
    if (!verified || verified.some(observation => observation.metadata?.page_representation_digest !== current.pageRepresentationDigest)) continue;
    let sourceSchemaIdentity: string;
    try {
      sourceSchemaIdentity = customerHeaderSchemaIdentity({ sourceKind: 'pdf', sourceMethod,
        interpretationFamily: 'priced_schedule_assembly_header', headerRows: 1,
        columns: page.columns.map((column, columnIndex) => ({ columnIndex, label: column.header_text, columnSpan: 1 })) });
    } catch { continue; }
    const matching = snapshots.filter(revision => revision.scope.sourceSchemaIdentity === sourceSchemaIdentity);
    const pins: CustomerHeaderMappingPin[] = [];
    let blocked = false;
    const columns = page.columns.map((column, columnIndex) => {
      const orderedObservationIds = (column.header_source_refs ?? []).map(ref => ref.observation_id!);
      const candidates = matching.filter(revision => revision.mappings.some(mapping => mapping.sourceLabel === column.header_text));
      if (candidates.length > 1) { blocked = true; return { text: column.header_text, orderedObservationIds, role: column.role }; }
      if (!candidates.length) return { text: column.header_text, orderedObservationIds, role: column.role };
      const revision = candidates[0]!;
      const result = resolveCustomerHeaderMapping({ organizationId: context.organizationId,
        scope: revision.scope, mappingRevision: revision, observedHeaderLabel: column.header_text,
        existingRecognition: pricedScheduleHeaderRoles(column.header_text) });
      if (result.status !== 'mapped') { blocked = true; return { text: column.header_text, orderedObservationIds, role: column.role }; }
      if (column.role !== result.role) {
        const pin = CustomerHeaderMappingPinSchema.safeParse({ version: 'customer_header_mapping_pin_v1',
          organizationId: context.organizationId, documentType: context.documentType, revisionId: revision.revisionId,
          digest: revision.digest, sourceSchemaIdentity, physicalPageNumber: page.physical_page_number, columnIndex,
          sourceLabel: column.header_text, orderedObservationIds, pageRepresentationDigest: current.pageRepresentationDigest });
        if (!pin.success) blocked = true;
        else pins.push(pin.data);
      }
      return { text: column.header_text, orderedObservationIds, role: result.role as PricedScheduleColumnRole };
    });
    if (!blocked && pins.length) assignments.push(freeze({ physicalPageNumber: page.physical_page_number,
      pageRepresentationDigest: current.pageRepresentationDigest, columns, pins }));
  }
  return Object.freeze(assignments);
}

/** Pins describe applied interpretation, never today's active configuration. */
export function readCustomerHeaderMappingPinsFromExtractionData(data: unknown): readonly CustomerHeaderMappingPin[] {
  if (!data || typeof data !== 'object') return [];
  // This view supplies types only; persisted input still passes every runtime
  // shape, source-scope and pin-schema check below.
  type PersistedColumn = { header_text?: string; role?: PricedScheduleColumnRole | null;
    header_source_refs?: { source?: string; observation_id?: string }[] };
  type PersistedPage = { columns?: PersistedColumn[]; customer_header_mapping_pins?: unknown;
    physical_page_number?: number; inherited_header?: unknown; header_semantics?: unknown;
    table_segment?: unknown; semantic_status?: string };
  const reconstruction = (data as { extraction?: { content_layers_v1?: { pdf?: {
    priced_schedule_reconstruction_v1?: { parser_version?: string; pages?: PersistedPage[] }
  } } } }).extraction?.content_layers_v1?.pdf?.priced_schedule_reconstruction_v1;
  if (!isPagePricedScheduleVersion(reconstruction?.parser_version)) return [];
  const pages = reconstruction?.pages;
  if (!Array.isArray(pages)) return [];
  const pins: CustomerHeaderMappingPin[] = [];
  for (const page of pages) {
    if (!page || typeof page !== 'object') return [];
    if (page.customer_header_mapping_pins === undefined) continue;
    if (!Array.isArray(page.columns)) return [];
    const columns = page.columns;
    const methods = new Set(columns.flatMap(column =>
      Array.isArray(column?.header_source_refs) ? column.header_source_refs.map(ref => ref?.source) : [undefined]));
    const method = [...methods][0];
    if (methods.size !== 1 || (method !== 'pdfjs' && method !== 'ocr_fallback')) return [];
    let expectedSchema: string;
    try {
      expectedSchema = customerHeaderSchemaIdentity({ sourceKind: 'pdf', sourceMethod: method,
        interpretationFamily: 'priced_schedule_assembly_header', headerRows: 1,
        columns: columns.map((column, columnIndex) => ({ columnIndex, label: column?.header_text as string, columnSpan: 1 })) });
    } catch { return []; }
    const parsed = z.array(CustomerHeaderMappingPinSchema).min(1).safeParse(page.customer_header_mapping_pins);
    if (!parsed.success || page.inherited_header || page.header_semantics || page.table_segment || page.semantic_status === 'unresolved'
      || pages.filter(candidate => candidate?.physical_page_number === page.physical_page_number).length !== 1
      || new Set(parsed.data.map(pin => pin.columnIndex)).size !== parsed.data.length
      || parsed.data.some(pin => pin.organizationId !== parsed.data[0]!.organizationId
        || pin.documentType !== parsed.data[0]!.documentType || pin.sourceSchemaIdentity !== parsed.data[0]!.sourceSchemaIdentity
        || pin.sourceSchemaIdentity !== expectedSchema
        || pin.pageRepresentationDigest !== parsed.data[0]!.pageRepresentationDigest
        || pin.physicalPageNumber !== page.physical_page_number
      || !Array.isArray(page.columns) || columns[pin.columnIndex]?.header_text !== pin.sourceLabel
      || pricedScheduleAssemblyRole(columns[pin.columnIndex]?.role ?? null) === null
      || hashCanonical((columns[pin.columnIndex]?.header_source_refs ?? []).map(ref => ref.observation_id)) !== hashCanonical(pin.orderedObservationIds))) return [];
    pins.push(...parsed.data);
  }
  return freeze(pins);
}
