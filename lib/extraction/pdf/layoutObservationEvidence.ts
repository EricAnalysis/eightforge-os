import type { EvidenceObject } from '@/lib/extraction/types';
import { opaqueIds } from '@/lib/extraction/domain/opaqueIds';
import {
  physicalPageFromExtractorIteration,
  rehydratePhysicalPageCoordinate,
} from '@/lib/extraction/provenance/physicalPageCoordinate';
import type { PdfLayout, PdfToken } from '@/lib/extraction/pdf/extractText';
import {
  PDF_LAYOUT_OBSERVATION_VERSION,
  createPdfLayoutObservationIdentity,
  type PdfLayoutObservationIdentityContext,
} from '@/lib/extraction/pdf/layoutObservationIdentity';
import type {
  PagePricedScheduleReconstruction,
  PricedScheduleCellSourceRef,
} from '@/lib/extraction/pdf/pagePricedScheduleReconstruction';

export const PDF_LAYOUT_OBSERVATIONS_LAYER_VERSION = 'pdf_layout_observations_v1' as const;

export type PdfLayoutTokenObservation = EvidenceObject & Readonly<{
  kind: 'pdf_layout_token';
  evidence_object_id: string;
  source_artifact_id: string;
  physical_page_number: number;
  source_method: 'pdfjs' | 'ocr_fallback';
  raw_text: string;
}>;

export type PdfLayoutObservationClosureStatus =
  | 'complete'
  | 'incomplete'
  | 'legacy_unidentified'
  | 'not_applicable';

export type PdfLayoutObservationClosure = Readonly<{
  status: PdfLayoutObservationClosureStatus;
  accepted_ref_count: number;
  accepted_identified_ref_count: number;
  diagnostic_identified_ref_count: number;
  persisted_observation_count: number;
  unidentified_accepted_ref_count: number;
  missing_observation_ids: readonly string[];
  duplicate_observation_ids: readonly string[];
  mismatched_observation_ids: readonly string[];
}>;

export type PdfLayoutObservationsLayer = Readonly<{
  parser_version: typeof PDF_LAYOUT_OBSERVATIONS_LAYER_VERSION;
  observation_version: typeof PDF_LAYOUT_OBSERVATION_VERSION;
  source_kind: 'pdf';
  materialization_scope: 'priced_schedule_reconstruction_refs';
  source_document_id: string | null;
  source_artifact_id: string | null;
  total_physical_pages: number;
  observations: readonly PdfLayoutTokenObservation[];
  closure: PdfLayoutObservationClosure;
}>;

export type PdfLayoutObservationBindingContext = Readonly<{
  sourceDocumentId: string;
  sourceArtifactId: string;
  totalPhysicalPages: number;
}>;

type LocatedRef = Readonly<{
  page: number;
  ref: PricedScheduleCellSourceRef;
}>;

function acceptedRefs(reconstruction: PagePricedScheduleReconstruction): LocatedRef[] {
  return reconstruction.pages.flatMap((page) => page.rows.flatMap((row) =>
    row.cells.flatMap((cell) => cell.source_refs.map((ref) => ({
      page: page.physical_page_number,
      ref,
    })))));
}

function diagnosticRefs(reconstruction: PagePricedScheduleReconstruction): LocatedRef[] {
  return reconstruction.pages.flatMap((page) => [
    ...page.rejected_spines.flatMap((entry) => entry.source_refs.map((ref) => ({
      page: page.physical_page_number,
      ref,
    }))),
    ...page.unassigned_lines.flatMap((entry) => entry.source_refs.map((ref) => ({
      page: page.physical_page_number,
      ref,
    }))),
  ]);
}

function tokenObservation(params: {
  token: PdfToken;
  page: number;
  context: PdfLayoutObservationIdentityContext;
  totalPhysicalPages: number;
}): PdfLayoutTokenObservation | null {
  const identity = params.token.observation_identity;
  if (!identity || params.token.observation_id !== identity.id || !params.token.source) return null;
  const expectedParser = params.token.source === 'pdfjs' ? 'pdfjs_text_content' : 'tesseract_blocks';
  if (identity.parser !== expectedParser) return null;
  const expectedIdentity = createPdfLayoutObservationIdentity({
    context: params.context,
    physicalPageNumber: params.page,
    sourceMethod: params.token.source,
    parser: expectedParser,
    parserObservationKey: identity.parser_observation_key,
    pageRepresentationDigest: identity.page_representation_digest,
  });
  if (expectedIdentity.id !== identity.id) return null;
  const boundingBox = {
    x_min: params.token.x,
    x_max: params.token.x + params.token.width,
    y_min: params.token.y,
    y_max: params.token.y + params.token.height,
  };
  const confidence = params.token.confidence == null
    ? (params.token.source === 'pdfjs' ? 0.95 : 0.5)
    : params.token.confidence;
  return Object.freeze({
    id: identity.id,
    evidence_object_id: identity.id,
    kind: 'pdf_layout_token',
    source_type: 'pdf',
    source_document_id: params.context.sourceDocumentId,
    source_artifact_id: params.context.sourceArtifactId,
    physical_page_coordinate: physicalPageFromExtractorIteration({
      sourceArtifact: {
        id: opaqueIds.existingSourceArtifact(params.context.sourceArtifactId),
        source_document_id: params.context.sourceDocumentId,
      },
      physicalPageNumber: params.page,
      totalPhysicalPages: params.totalPhysicalPages,
      sourceLayer: params.token.source === 'pdfjs' ? 'pdf_native_text' : 'ocr',
      artifactLocalIndex: params.page - 1,
    }),
    description: `PDF layout token on page ${params.page}`,
    text: params.token.text,
    raw_text: params.token.text,
    physical_page_number: params.page,
    source_method: params.token.source,
    location: { page: params.page, bounding_box: boundingBox },
    confidence,
    weak: confidence < 0.5,
    metadata: {
      source_document_id: params.context.sourceDocumentId,
      source_artifact_id: params.context.sourceArtifactId,
      source_extraction_path: PDF_LAYOUT_OBSERVATIONS_LAYER_VERSION,
      observation_version: identity.version,
      parser: identity.parser,
      parser_observation_key: identity.parser_observation_key,
      page_representation_digest: identity.page_representation_digest,
      source_method: params.token.source,
      bounding_box: boundingBox,
    },
  });
}

function observationIntegrityKey(observation: PdfLayoutTokenObservation): string {
  return JSON.stringify({
    id: observation.id,
    document: observation.source_document_id,
    artifact: observation.source_artifact_id,
    page: observation.physical_page_number,
    source: observation.source_method,
    text: observation.raw_text,
    bbox: observation.location.bounding_box,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function isPdfLayoutTokenObservation(value: unknown): value is PdfLayoutTokenObservation {
  if (
    !isRecord(value)
    || !isRecord(value.location)
    || !isRecord(value.location.bounding_box)
    || !isRecord(value.metadata)
  ) return false;
  const bbox = value.location.bounding_box;
  return typeof value.id === 'string'
    && value.evidence_object_id === value.id
    && value.kind === 'pdf_layout_token'
    && value.source_type === 'pdf'
    && typeof value.source_document_id === 'string'
    && typeof value.source_artifact_id === 'string'
    && Number.isSafeInteger(value.physical_page_number)
    && (value.source_method === 'pdfjs' || value.source_method === 'ocr_fallback')
    && typeof value.raw_text === 'string'
    && typeof value.location.page === 'number'
    && typeof bbox.x_min === 'number'
    && typeof bbox.x_max === 'number'
    && typeof bbox.y_min === 'number'
    && typeof bbox.y_max === 'number';
}

function persistedIdentityMatches(
  observation: PdfLayoutTokenObservation,
  context: PdfLayoutObservationIdentityContext,
  page: number,
): boolean {
  const metadata = observation.metadata;
  if (!metadata) return false;
  const expectedParser = observation.source_method === 'pdfjs'
    ? 'pdfjs_text_content'
    : 'tesseract_blocks';
  if (
    metadata.source_document_id !== context.sourceDocumentId
    || metadata.source_artifact_id !== context.sourceArtifactId
    || metadata.observation_version !== PDF_LAYOUT_OBSERVATION_VERSION
    || metadata.parser !== expectedParser
    || metadata.source_method !== observation.source_method
    || typeof metadata.parser_observation_key !== 'string'
    || typeof metadata.page_representation_digest !== 'string'
  ) return false;
  return createPdfLayoutObservationIdentity({
    context,
    physicalPageNumber: page,
    sourceMethod: observation.source_method,
    parser: expectedParser,
    parserObservationKey: metadata.parser_observation_key,
    pageRepresentationDigest: metadata.page_representation_digest,
  }).id === observation.id;
}

function refMatchesObservation(
  located: LocatedRef,
  observation: PdfLayoutTokenObservation,
  context: PdfLayoutObservationIdentityContext,
  totalPhysicalPages: number,
): boolean {
  const bbox = observation.location.bounding_box;
  const expectedLayer = observation.source_method === 'pdfjs' ? 'pdf_native_text' : 'ocr';
  const rehydrated = rehydratePhysicalPageCoordinate(observation.physical_page_coordinate, {
    sourceDocumentId: context.sourceDocumentId,
    sourceArtifactId: context.sourceArtifactId,
    page: located.page,
    requiresProvenance: true,
    expectedSourceLayer: expectedLayer,
    fallbackSourceLayer: expectedLayer,
    artifactLocalIndex: located.page - 1,
  });
  const coordinate = rehydrated.coordinate;
  return observation.id === located.ref.observation_id
    && persistedIdentityMatches(observation, context, located.page)
    && observation.physical_page_number === located.page
    && observation.location.page === located.page
    && rehydrated.status === 'rehydrated'
    && coordinate.mappingState === 'resolved_physical_page'
    && coordinate.sourceDocumentId === observation.source_document_id
    && coordinate.sourceArtifactId === observation.source_artifact_id
    && coordinate.physicalPageNumber === located.page
    && coordinate.artifactLocalIndex === located.page - 1
    && coordinate.totalPhysicalPages === totalPhysicalPages
    && observation.source_method === located.ref.source
    && observation.raw_text === located.ref.text
    && bbox?.x_min === located.ref.x_min
    && bbox.x_max === located.ref.x_max
    && bbox.y_min === located.ref.y_min
    && bbox.y_max === located.ref.y_max;
}

export function validatePdfLayoutObservationClosure(params: {
  reconstruction: PagePricedScheduleReconstruction;
  /** Persisted input is treated as untrusted JSON and closure is always recomputed. */
  observations: readonly unknown[];
  context: PdfLayoutObservationIdentityContext | null;
  totalPhysicalPages: number;
}): PdfLayoutObservationClosure {
  const accepted = acceptedRefs(params.reconstruction);
  const diagnostics = diagnosticRefs(params.reconstruction);
  if (accepted.length === 0 && diagnostics.length === 0) {
    return Object.freeze({
      status: 'not_applicable', accepted_ref_count: 0, accepted_identified_ref_count: 0,
      diagnostic_identified_ref_count: 0, persisted_observation_count: params.observations.length,
      unidentified_accepted_ref_count: 0,
      missing_observation_ids: [], duplicate_observation_ids: [], mismatched_observation_ids: [],
    });
  }
  const acceptedIdentified = accepted.filter((entry) => entry.ref.observation_id);
  const diagnosticIdentified = diagnostics.filter((entry) => entry.ref.observation_id);
  const unidentifiedAcceptedRefCount = accepted.length - acceptedIdentified.length;
  if (acceptedIdentified.length === 0) {
    return Object.freeze({
      status: 'legacy_unidentified',
      accepted_ref_count: accepted.length,
      accepted_identified_ref_count: acceptedIdentified.length,
      diagnostic_identified_ref_count: diagnosticIdentified.length,
      persisted_observation_count: params.observations.length,
      unidentified_accepted_ref_count: unidentifiedAcceptedRefCount,
      missing_observation_ids: [], duplicate_observation_ids: [], mismatched_observation_ids: [],
    });
  }
  if (!params.context || unidentifiedAcceptedRefCount > 0) {
    return Object.freeze({
      status: 'incomplete',
      accepted_ref_count: accepted.length,
      accepted_identified_ref_count: acceptedIdentified.length,
      diagnostic_identified_ref_count: diagnosticIdentified.length,
      persisted_observation_count: params.observations.length,
      unidentified_accepted_ref_count: unidentifiedAcceptedRefCount,
      missing_observation_ids: [],
      duplicate_observation_ids: [],
      mismatched_observation_ids: params.context
        ? []
        : [...new Set(acceptedIdentified.map((entry) => entry.ref.observation_id!))].sort(),
    });
  }
  const byId = new Map<string, unknown[]>();
  for (const observation of params.observations) {
    const id = isRecord(observation) && typeof observation.id === 'string' ? observation.id : null;
    if (!id) continue;
    byId.set(id, [...(byId.get(id) ?? []), observation]);
  }
  const duplicateIds = [...byId.entries()]
    .filter(([, definitions]) => definitions.length !== 1)
    .map(([id]) => id)
    .sort();
  const missingIds = [...new Set(acceptedIdentified
    .map((entry) => entry.ref.observation_id!)
    .filter((id) => !byId.has(id)))]
    .sort();
  const mismatchedIds = [...new Set(acceptedIdentified.flatMap((entry) => {
    const definitions = byId.get(entry.ref.observation_id!) ?? [];
    const observation = definitions[0];
    return definitions.length === 1
      && isPdfLayoutTokenObservation(observation)
      && observation.source_document_id === params.context!.sourceDocumentId
      && observation.source_artifact_id === params.context!.sourceArtifactId
      && refMatchesObservation(entry, observation, params.context!, params.totalPhysicalPages)
      ? []
      : [entry.ref.observation_id!];
  }))].sort();
  return Object.freeze({
    status: duplicateIds.length === 0 && missingIds.length === 0 && mismatchedIds.length === 0
      ? 'complete'
      : 'incomplete',
    accepted_ref_count: accepted.length,
    accepted_identified_ref_count: acceptedIdentified.length,
    diagnostic_identified_ref_count: diagnosticIdentified.length,
    persisted_observation_count: params.observations.length,
    unidentified_accepted_ref_count: unidentifiedAcceptedRefCount,
    missing_observation_ids: missingIds,
    duplicate_observation_ids: duplicateIds,
    mismatched_observation_ids: mismatchedIds,
  });
}

/**
 * Resolves accepted reconstruction refs to their exact persisted EvidenceObjects.
 * The persisted layer is untrusted: its envelope and closure are independently
 * validated against caller-owned source context before any object is returned.
 */
export function resolvePdfLayoutObservationEvidence(params: {
  reconstruction: PagePricedScheduleReconstruction;
  persistedLayer: unknown;
  context: PdfLayoutObservationBindingContext | null;
}): readonly PdfLayoutTokenObservation[] | null {
  if (params.reconstruction.pages.some((page) =>
    page.rows.some((row) => row.physical_page_number !== page.physical_page_number))) {
    return null;
  }
  if (!params.context || !isRecord(params.persistedLayer)) return null;
  const layer = params.persistedLayer;
  if (
    layer.parser_version !== PDF_LAYOUT_OBSERVATIONS_LAYER_VERSION
    || layer.observation_version !== PDF_LAYOUT_OBSERVATION_VERSION
    || layer.source_kind !== 'pdf'
    || layer.materialization_scope !== 'priced_schedule_reconstruction_refs'
    || layer.source_document_id !== params.context.sourceDocumentId
    || layer.source_artifact_id !== params.context.sourceArtifactId
    || layer.total_physical_pages !== params.context.totalPhysicalPages
    || !Array.isArray(layer.observations)
  ) return null;

  const identityContext: PdfLayoutObservationIdentityContext = {
    sourceDocumentId: params.context.sourceDocumentId,
    sourceArtifactId: params.context.sourceArtifactId,
  };
  const closure = validatePdfLayoutObservationClosure({
    reconstruction: params.reconstruction,
    observations: layer.observations,
    context: identityContext,
    totalPhysicalPages: params.context.totalPhysicalPages,
  });
  if (closure.status !== 'complete') return null;

  const acceptedIds = [...new Set(acceptedRefs(params.reconstruction)
    .flatMap((entry) => entry.ref.observation_id
      ? [String(entry.ref.observation_id)]
      : []))]
    .sort((left, right) => left.localeCompare(right, 'en-US'));
  const byId = new Map<string, PdfLayoutTokenObservation>();
  for (const observation of layer.observations) {
    if (isPdfLayoutTokenObservation(observation) && acceptedIds.includes(observation.id)) {
      byId.set(observation.id, observation);
    }
  }
  if (byId.size !== acceptedIds.length) return null;
  return Object.freeze(acceptedIds.map((id) => byId.get(id)!));
}

/**
 * Resolves each reconstructed row atomically and unions only complete rows.
 * A malformed neighboring row must not suppress evidence for an independently
 * complete row, while no row can ever publish a partial anchor set.
 */
export function resolvePdfLayoutObservationEvidenceByRow(params: {
  reconstruction: PagePricedScheduleReconstruction;
  persistedLayer: unknown;
  context: PdfLayoutObservationBindingContext | null;
}): readonly PdfLayoutTokenObservation[] {
  const byId = new Map<string, PdfLayoutTokenObservation>();
  for (const page of params.reconstruction.pages) {
    for (const row of page.rows) {
      const resolved = resolvePdfLayoutObservationEvidence({
        reconstruction: {
          parser_version: params.reconstruction.parser_version,
          pages: [{ ...page, rows: [row], rejected_spines: [], unassigned_lines: [] }],
        },
        persistedLayer: params.persistedLayer,
        context: params.context,
      });
      for (const observation of resolved ?? []) byId.set(observation.id, observation);
    }
  }
  return Object.freeze([...byId.values()].sort((left, right) =>
    left.id.localeCompare(right.id, 'en-US')));
}

export function buildPdfLayoutObservationsLayer(params: {
  layout: PdfLayout;
  reconstruction: PagePricedScheduleReconstruction;
  context: PdfLayoutObservationIdentityContext | null;
}): PdfLayoutObservationsLayer {
  const durableIds = new Set([
    ...acceptedRefs(params.reconstruction),
    ...diagnosticRefs(params.reconstruction),
  ].flatMap((entry) => entry.ref.observation_id ? [entry.ref.observation_id] : []));
  const definitions = new Map<string, PdfLayoutTokenObservation[]>();
  if (params.context) {
    for (const page of params.layout.pages) {
      for (const line of page.lines) {
        for (const token of line.tokens) {
          if (!token.observation_id || !durableIds.has(token.observation_id)) continue;
          const observation = tokenObservation({
            token,
            page: page.page_number,
            context: params.context,
            totalPhysicalPages: params.layout.page_count,
          });
          if (!observation) continue;
          definitions.set(observation.id, [...(definitions.get(observation.id) ?? []), observation]);
        }
      }
    }
  }
  const observations = [...definitions.values()].flat().sort((left, right) => {
    if (left.id !== right.id) return left.id < right.id ? -1 : 1;
    const leftIntegrity = observationIntegrityKey(left);
    const rightIntegrity = observationIntegrityKey(right);
    return leftIntegrity === rightIntegrity ? 0 : leftIntegrity < rightIntegrity ? -1 : 1;
  });
  const closure = validatePdfLayoutObservationClosure({
    reconstruction: params.reconstruction,
    observations,
    context: params.context,
    totalPhysicalPages: params.layout.page_count,
  });
  return Object.freeze({
    parser_version: PDF_LAYOUT_OBSERVATIONS_LAYER_VERSION,
    observation_version: PDF_LAYOUT_OBSERVATION_VERSION,
    source_kind: 'pdf',
    materialization_scope: 'priced_schedule_reconstruction_refs',
    source_document_id: params.context?.sourceDocumentId ?? null,
    source_artifact_id: params.context?.sourceArtifactId ?? null,
    total_physical_pages: params.layout.page_count,
    observations: Object.freeze(observations),
    closure,
  });
}
