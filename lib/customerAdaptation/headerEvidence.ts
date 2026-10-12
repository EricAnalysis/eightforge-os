import { z } from 'zod';
import { hashCanonical } from '@/lib/extraction/domain/hash';
import { PRICED_SCHEDULE_HEADER_INTERPRETATION_VERSION } from '@/lib/extraction/pdf/pagePricedScheduleReconstruction';
import type { PricedScheduleCellSourceRef } from '@/lib/extraction/pdf/pagePricedScheduleReconstruction';
import { isPagePricedScheduleVersion } from '@/lib/extraction/pdf/pricedScheduleVersion';
import { resolvePdfLayoutSourceRefEvidence } from '@/lib/extraction/pdf/layoutObservationEvidence';

export const CUSTOMER_HEADER_SCHEMA_VERSION = 'customer-header-schema-v1' as const;
export const CustomerHeaderSchemaIdentitySchema = z.string().regex(/^customer-header-schema-v1:[a-f0-9]{64}$/);
const uuid = z.string().uuid();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const exactLabel = z.string().min(1).max(512).refine((value) => value.trim().length > 0);
export const CustomerHeaderEvidenceBindingSchema = z.object({
  organizationId: uuid, projectId: uuid, documentId: uuid, extractionId: uuid,
  sourceArtifactId: uuid, sourceSha256: digest,
  physicalPageNumber: z.number().int().positive(), pageRepresentationDigest: digest,
  headerIndex: z.number().int().nonnegative(), columnIndex: z.number().int().nonnegative(),
  documentType: exactLabel, observedHeaderLabel: exactLabel,
  orderedObservationIds: z.array(z.string().regex(/^pdf:layout-token:v1:[a-f0-9]{64}$/)).min(1).max(200)
    .refine((ids) => new Set(ids).size === ids.length),
  sourceSchemaIdentity: CustomerHeaderSchemaIdentitySchema,
}).strict();
export type CustomerHeaderEvidenceBinding = Readonly<Omit<z.infer<typeof CustomerHeaderEvidenceBindingSchema>, 'orderedObservationIds'>
  & { orderedObservationIds: readonly string[] }>;

const SourceHeaderSchema = z.object({
  sourceKind: z.literal('pdf'), sourceMethod: z.enum(['pdfjs', 'ocr_fallback']),
  interpretationFamily: z.literal('priced_schedule_assembly_header'),
  headerRows: z.literal(1),
  columns: z.array(z.object({ columnIndex: z.number().int().nonnegative(), label: exactLabel,
    columnSpan: z.literal(1) }).strict()).min(2).max(100),
}).strict().refine((value) => value.columns.every((column, index) => column.columnIndex === index));

/** Pure structural producer. Only trusted pipeline/header verification may supply
 * the observed structure. No filename, IDs, coordinates, roles or parser version. */
export function customerHeaderSchemaIdentity(observedStructure: z.input<typeof SourceHeaderSchema>): string {
  const structure = SourceHeaderSchema.parse(observedStructure);
  return `${CUSTOMER_HEADER_SCHEMA_VERSION}:${hashCanonical({ version: CUSTOMER_HEADER_SCHEMA_VERSION, ...structure })}`;
}

export type HeaderEvidenceContext = Readonly<{
  actorOrganizationId: string;
  document: { id: string; organization_id: string; project_id: string; document_type: string };
  project: { id: string; organization_id: string };
  /** The server must load its preferred current full extraction, never client JSON. */
  extraction: { id: string; organization_id: string; document_id: string; data: unknown };
  artifact: { id: string; organization_id: string; source_document_id: string; source_sha256: string };
}>;
type Rejection = 'invalid_context' | 'tenant_mismatch' | 'ownership_mismatch' | 'unsupported_header'
  | 'ambiguous_header' | 'invalid_header_structure' | 'page_digest_unproven' | 'header_observations_unproven'
  | 'invalid_binding' | 'binding_mismatch';
type Produced = { status: 'verified'; sourceSchemaIdentity: string; bindings: readonly CustomerHeaderEvidenceBinding[] }
  | { status: 'rejected'; reason: Rejection };
const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const refsSchema = z.array(z.object({ observation_id: z.string(), text: exactLabel,
  x_min: z.number().finite(), x_max: z.number().finite(), y_min: z.number().finite(), y_max: z.number().finite(),
  source: z.enum(['pdfjs', 'ocr_fallback']), confidence: z.number().nullable().optional(),
}).passthrough()).min(1).max(200);
const labelsSchema = z.array(z.object({ text: exactLabel, source_refs: refsSchema }).passthrough()).min(2).max(100);

/** Derives source scope and bindings from owned, persisted evidence. Does not
 * accept applicant-provided schema labels or choose unresolved structural options. */
export function produceCustomerHeaderEvidence(context: HeaderEvidenceContext, headerIndex: number): Produced {
  const reject = (reason: Rejection): Produced => ({ status: 'rejected', reason });
  const { document, project, extraction, artifact } = context;
  if (![context.actorOrganizationId, document.id, document.organization_id, document.project_id,
    project.id, project.organization_id, extraction.id, extraction.organization_id, extraction.document_id,
    artifact.id, artifact.organization_id, artifact.source_document_id].every((id) => uuid.safeParse(id).success)
    || !digest.safeParse(artifact.source_sha256).success || !exactLabel.safeParse(document.document_type).success
    || !Number.isSafeInteger(headerIndex) || headerIndex < 0) return reject('invalid_context');
  if ([document.organization_id, project.organization_id, extraction.organization_id, artifact.organization_id]
    .some((org) => org !== context.actorOrganizationId)) return reject('tenant_mismatch');
  if (document.project_id !== project.id || extraction.document_id !== document.id
    || artifact.source_document_id !== document.id) return reject('ownership_mismatch');
  const content = record(record(extraction.data)?.extraction);
  const layers = record(content?.content_layers_v1);
  const pdf = record(layers?.pdf);
  const reconstruction = record(pdf?.priced_schedule_reconstruction_v1);
  const layer = record(pdf?.layout_observations_v1);
  if (layers?.source_kind !== 'pdf' || !isPagePricedScheduleVersion(reconstruction?.parser_version)
    || !Array.isArray(reconstruction?.pages) || !layer) return reject('unsupported_header');
  const page = record(reconstruction.pages[headerIndex]);
  if (!page || page.inherited_header || page.header_semantics || page.table_segment) return reject('unsupported_header');
  const physicalPage = page.physical_page_number;
  if (!Number.isSafeInteger(physicalPage) || (physicalPage as number) < 1
    || reconstruction.pages.filter((entry) => record(entry)?.physical_page_number === physicalPage).length !== 1) {
    return reject('ambiguous_header');
  }
  const interpretation = record(page.header_interpretation);
  const columns = Array.isArray(page.columns) ? page.columns.map(record) : [];
  const columnLabels = labelsSchema.safeParse(columns.map((column) => ({ text: column?.header_text,
    source_refs: column?.header_source_refs })));
  if (!columnLabels.success) return reject('invalid_header_structure');
  let labels: z.infer<typeof labelsSchema>;
  if (interpretation) {
    if (interpretation.version !== PRICED_SCHEDULE_HEADER_INTERPRETATION_VERSION
      || !['unresolved', 'resolved_deterministically'].includes(String(interpretation.status))
      || record(interpretation.grouping_basis)?.clear !== true
      || interpretation.reason === 'ambiguous_label_grouping') return reject('invalid_header_structure');
    const parsed = labelsSchema.safeParse(interpretation.labels);
    const headerRefs = refsSchema.safeParse(interpretation.source_refs);
    if (!parsed.success || !headerRefs.success
      || hashCanonical(parsed.data.flatMap((label) => label.source_refs)) !== hashCanonical(headerRefs.data)) {
      return reject('invalid_header_structure');
    }
    labels = parsed.data;
    if (hashCanonical(labels.map(({ text, source_refs }) => ({ text, source_refs }))) !== hashCanonical(columnLabels.data)) {
      return reject('invalid_header_structure');
    }
  } else {
    labels = columnLabels.data;
  }
  if (columns.some((column, index) => !column
    || (column.column_index !== undefined && column.column_index !== index)
    || (index === 0 ? column.x_min !== null : !Number.isFinite(column.x_min))
    || (index === columns.length - 1 ? column.x_max !== null : !Number.isFinite(column.x_max))
    || (index > 0 && column.x_min !== columns[index - 1]!.x_max)
    || (column.x_min !== null && column.x_max !== null && (column.x_min as number) >= (column.x_max as number))
    || labels[index]!.source_refs.some((ref) => (column.x_min !== null && ref.x_min < (column.x_min as number))
      || (column.x_max !== null && ref.x_max > (column.x_max as number))))) return reject('invalid_header_structure');
  const allRefs = labels.flatMap((label) => label.source_refs);
  const ids = allRefs.map((ref) => ref.observation_id);
  if (new Set(ids).size !== ids.length || new Set(labels.map((label) => label.text)).size !== labels.length
    || labels.some((label) => label.text !== label.source_refs.map((ref) => ref.text).join(' '))
    || allRefs.some((ref, index) => index > 0 && ref.x_min < allRefs[index - 1]!.x_max)
    || Math.max(...allRefs.map((ref) => ref.y_min)) >= Math.min(...allRefs.map((ref) => ref.y_max))) {
    return reject('invalid_header_structure');
  }
  const sourceMethods = new Set(allRefs.map((ref) => ref.source));
  if (sourceMethods.size !== 1) return reject('unsupported_header');
  const coverage = record(pdf?.page_extraction_coverage_v1);
  const coveragePages = Array.isArray(coverage?.pages)
    ? coverage.pages.filter((entry) => record(entry)?.page_number === physicalPage) : [];
  const pageDigest = record(coveragePages[0])?.page_representation_digest;
  if (coveragePages.length !== 1 || !digest.safeParse(pageDigest).success) return reject('page_digest_unproven');
  const observations = resolvePdfLayoutSourceRefEvidence({
    sourceRefs: allRefs as PricedScheduleCellSourceRef[], physicalPageNumber: physicalPage as number,
    persistedLayer: layer, context: { sourceDocumentId: document.id, sourceArtifactId: artifact.id,
      totalPhysicalPages: layer.total_physical_pages as number },
  });
  if (!observations || observations.some((observation) => observation.metadata?.page_representation_digest !== pageDigest)) {
    return reject('header_observations_unproven');
  }
  const sourceSchemaIdentity = customerHeaderSchemaIdentity({ sourceKind: 'pdf', sourceMethod: allRefs[0]!.source,
    interpretationFamily: 'priced_schedule_assembly_header', headerRows: 1,
    columns: labels.map((label, columnIndex) => ({ columnIndex, label: label.text, columnSpan: 1 })),
  });
  const bindings = labels.map((label, columnIndex) => CustomerHeaderEvidenceBindingSchema.parse({
    organizationId: context.actorOrganizationId, projectId: project.id, documentId: document.id,
    extractionId: extraction.id, sourceArtifactId: artifact.id, sourceSha256: artifact.source_sha256,
    physicalPageNumber: physicalPage, pageRepresentationDigest: pageDigest, headerIndex, columnIndex,
    documentType: document.document_type, observedHeaderLabel: label.text,
    orderedObservationIds: label.source_refs.map((ref) => ref.observation_id), sourceSchemaIdentity,
  }));
  for (const binding of bindings) { Object.freeze(binding.orderedObservationIds); Object.freeze(binding); }
  return Object.freeze({ status: 'verified', sourceSchemaIdentity, bindings: Object.freeze(bindings) });
}

export function verifyCustomerHeaderEvidence(binding: unknown, context: HeaderEvidenceContext):
  { status: 'verified'; binding: CustomerHeaderEvidenceBinding } | { status: 'rejected'; reason: Rejection } {
  const parsed = CustomerHeaderEvidenceBindingSchema.safeParse(binding);
  if (!parsed.success) return { status: 'rejected', reason: 'invalid_binding' };
  const produced = produceCustomerHeaderEvidence(context, parsed.data.headerIndex);
  if (produced.status === 'rejected') return produced;
  const exact = produced.bindings[parsed.data.columnIndex];
  return exact && hashCanonical(exact) === hashCanonical(parsed.data)
    ? { status: 'verified', binding: exact } : { status: 'rejected', reason: 'binding_mismatch' };
}
