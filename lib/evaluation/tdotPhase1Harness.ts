import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

import { hashCanonical, sha256Hex } from '@/lib/extraction/domain/hash';
import {
  adaptLegacyExtractionToStep1Shadow,
  type AdaptLegacyExtractionToStep1ShadowResult,
  type LegacyLocatedObservation,
  type LegacyLocatedPageObservation,
} from '@/lib/extraction/domain/legacyLocatedObservationAdapter';
import { opaqueIds } from '@/lib/extraction/domain/opaqueIds';
import {
  buildLegacyShadowParserManifest,
  hashParserManifest,
} from '@/lib/extraction/domain/parserManifest';
import type {
  BoundingBox,
  GridCellArtifact,
  LogicalTableRow,
  ParserIdentity,
  SourceArtifact,
} from '@/lib/extraction/domain/types';
import type { LocatedOcrObservationSidecar } from '@/lib/extraction/ocrObservationSidecar';
import { buildStep3SemanticInterpretation } from '@/lib/interpretation/step3ShadowBridge';
import { buildGenericPdfShadowSidecar } from '@/lib/server/documentExtraction';

export const TDOT_PHASE1_HARNESS_VERSION = '1.7.0';
export const TDOT_PHASE1_EXPECTED_SOURCE_SHA256 =
  '7e60675c7c1f6d41f58fd3d9e372f8abb2dd800896d1af266e2312250895e58a';
export const TDOT_PHASE1_FIXED_TIME = '2026-07-28T00:00:00.000Z';

export type ParityClassification =
  | 'match'
  | 'legacy_unsupported'
  | 'newly_supported'
  | 'changed_source_grounded'
  | 'missing_or_uncertain'
  | 'duplicate_split_merge';

export type DifferenceResolution =
  | 'resolved'
  | 'unresolved'
  | 'requires_semantic_review';

export interface TdotLedgerObservation {
  readonly field_identifier: string;
  readonly source_pdf_sha256: string;
  readonly source_page: number;
  readonly bbox_x0: number;
  readonly bbox_y0: number;
  readonly bbox_x1: number;
  readonly bbox_y1: number;
  readonly page_width_points: number;
  readonly page_height_points: number;
  readonly exact_raw_text: string;
  readonly raw_text_sha256: string;
  readonly interpreted_field_or_role: string;
  readonly row_identity: string;
}

export interface TdotLedger {
  readonly ledger_version: string;
  readonly source_pdf: {
    readonly sha256: string;
    readonly byte_length: number;
    readonly pages: number;
  };
  readonly observations: readonly TdotLedgerObservation[];
}

interface HistoricalExport<T> {
  readonly availability: string;
  readonly source_pdf_sha256: string;
  readonly rows: readonly T[];
}

export interface LegacyTdotRow {
  readonly row_id: string;
  readonly page: number;
  readonly description: string;
  readonly unit: string;
  readonly origin_destination: string | null;
  readonly rate_amount: number | null;
  readonly rate_raw: string | null;
  readonly source_kind: string;
  readonly source_anchor_ids: readonly string[];
}

interface HistoricalContractAnalysis {
  readonly rate_schedule_rows?: readonly LegacyTdotRow[];
}

export interface GenericComparedField {
  readonly verified_field_id: string;
  readonly candidate_id: string;
  readonly dependency_hash: string;
  readonly source_page: number;
  readonly source_bbox: BoundingBox;
  readonly raw_text: string;
  readonly raw_text_sha256: string;
  readonly normalized_value: unknown;
  readonly confidence: unknown;
  readonly source_fragment_ids: readonly string[];
  readonly table_cell_id: string;
  readonly table_row_id: string | null;
  readonly table_segment_id: string;
  readonly semantic_role: string | null;
  readonly semantic_status: 'resolved' | 'ambiguous' | 'unmapped';
  readonly parser_manifest_hash: string;
  readonly interpretation_manifest_hash: string | null;
}

export interface ParityRecord {
  readonly id: string;
  readonly comparison_scope: 'generic_to_ledger' | 'legacy_diagnostic';
  readonly classification: ParityClassification;
  readonly resolution: DifferenceResolution;
  readonly material: boolean;
  readonly explanation: string;
  readonly ledger: TdotLedgerObservation | null;
  readonly generic_fields: readonly GenericComparedField[];
  readonly legacy_row: LegacyTdotRow | null;
  readonly comparison_basis: readonly string[];
  readonly reconstruction_comparison: {
    readonly reconstructed_raw_text: string;
    readonly exact_equal: boolean;
    readonly whitespace_normalized_equal: boolean;
    readonly punctuation_normalized_equal: boolean;
  } | null;
}

export function classifyParityDifference(input: {
  readonly legacy_present: boolean;
  readonly legacy_supported: boolean;
  readonly generic_supported: boolean;
  readonly values_equivalent: boolean;
  readonly duplicate_split_merge: boolean;
}): ParityClassification {
  if (input.duplicate_split_merge) return 'duplicate_split_merge';
  if (input.generic_supported && input.legacy_supported) {
    return input.values_equivalent ? 'match' : 'changed_source_grounded';
  }
  if (input.generic_supported && !input.legacy_supported) return 'newly_supported';
  if (!input.generic_supported && input.legacy_present && !input.legacy_supported) {
    return 'legacy_unsupported';
  }
  return 'missing_or_uncertain';
}

export interface DependencyClosureResult {
  readonly status: 'pass' | 'fail';
  readonly checked_verified_fields: number;
  readonly checked_candidates: number;
  readonly checked_fragments: number;
  readonly errors: readonly string[];
}

export interface GenericShadowRun {
  readonly source_sha256: string;
  readonly source_byte_length: number;
  readonly source_document_id: string;
  readonly graph: AdaptLegacyExtractionToStep1ShadowResult;
  readonly interpretation: Awaited<ReturnType<typeof buildStep3SemanticInterpretation>>;
  readonly fields: readonly GenericComparedField[];
  readonly dependency_closure: DependencyClosureResult;
}

export interface MetamorphicResult {
  readonly invariant_id: string;
  readonly description: string;
  readonly status: 'pass' | 'fail' | 'blocked' | 'not_applicable';
  readonly mutation_manifest: Readonly<Record<string, unknown>> | null;
  readonly explanation: string;
  readonly changed_field_ids: readonly string[];
  readonly unexpected_field_ids: readonly string[];
}

export interface TdotPhase1Report {
  readonly report_version: string;
  readonly generated_at: string;
  readonly phase: 'phase3_step4_phase1_shadow';
  readonly shadow_only: true;
  readonly source: {
    readonly sha256: string;
    readonly byte_length: number;
    readonly page_count: number;
  };
  readonly phase0_gate: {
    readonly status: string;
    readonly gate_definition_version: string;
    readonly check_count: number;
    readonly failed_check_count: number;
    readonly production_reader_changes_authorized: false;
    readonly legacy_removal_authorized: false;
  };
  readonly generic_run: {
    readonly snapshot_id: string;
    readonly content_extraction_fingerprint: string;
    readonly parser_manifest_hash: string;
    readonly artifact_root_hash: string;
    readonly status: string;
    readonly pages: number;
    readonly table_segments: number;
    readonly table_chains: number;
    readonly verified_fields: number;
    readonly compared_fields: number;
    readonly semantic_mappings: number;
    readonly semantic_ambiguities: number;
    readonly gaps: number;
    readonly dependency_closure: DependencyClosureResult;
  };
  readonly parity: {
    readonly classification_counts: Readonly<Record<ParityClassification, number>>;
    readonly records: readonly ParityRecord[];
    readonly material_differences: readonly ParityRecord[];
  };
  readonly metamorphic: {
    readonly result_counts: Readonly<Record<MetamorphicResult['status'], number>>;
    readonly results: readonly MetamorphicResult[];
  };
  readonly prohibited_builder_calls: {
    readonly count: 0;
    readonly symbols: readonly [
      'TDOT_APPENDIX_B_SPECS',
      'tdot_appendix_b_stitched_table',
      'assembleContractRateScheduleRows',
    ];
  };
  readonly phase2_readiness: {
    readonly status: 'not_ready';
    readonly unresolved_material_difference_ids: readonly string[];
    readonly cutover_decision: null;
  };
}

const DEFAULT_NATIVE_PARSER: ParserIdentity = Object.freeze({
  stage: 'native_text',
  name: 'pdfjs-native-text',
  version: '5.5.207',
  configuration_hash: sha256Hex('pdfjs-native-text:5.5.207:step3-located-tokens-v1'),
});

function toArrayBuffer(bytes: Buffer): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

function flattenLocatedObservations(
  sidecar: LocatedOcrObservationSidecar,
): LegacyLocatedObservation[] {
  const pages = sidecar.engine_pages && sidecar.engine_pages.length > 0
    ? sidecar.engine_pages
    : sidecar.pages;
  return pages.flatMap((page) =>
    page.words.map((word) => ({
      page: page.page_number,
      page_width: page.width,
      page_height: page.height,
      rotation_degrees: 0 as const,
      render_sha256: page.render_sha256,
      parser: (
        page as { readonly parser?: ParserIdentity }
      ).parser ?? DEFAULT_NATIVE_PARSER,
      text: word.text,
      confidence: word.confidence,
      bbox: word.bbox,
    })));
}

function locatedPages(
  sidecar: LocatedOcrObservationSidecar,
): LegacyLocatedPageObservation[] {
  return sidecar.pages.map((page) => ({
    page: page.page_number,
    page_width: page.width,
    page_height: page.height,
    rotation_degrees: 0,
    render_sha256: page.render_sha256,
    parser: DEFAULT_NATIVE_PARSER,
    text_detected: page.text_detected,
  }));
}

function dependencyClosure(
  graph: AdaptLegacyExtractionToStep1ShadowResult,
): DependencyClosureResult {
  const errors: string[] = [];
  const fragments = new Map<string, (typeof graph.fragments)[number]>(
    graph.fragments.map((fragment) => [fragment.id, fragment]),
  );
  const candidates = new Map<string, (typeof graph.candidates)[number]>(
    graph.candidates.map((candidate) => [candidate.id, candidate]),
  );
  const pages = new Set<string>(graph.pages.map((page) => page.id));
  for (const fragment of graph.fragments) {
    if (!pages.has(fragment.page_artifact_id)) {
      errors.push(`fragment ${fragment.id} has no page`);
    }
  }
  for (const candidate of graph.candidates) {
    for (const dependency of candidate.source_fragment_dependencies) {
      if (!fragments.has(dependency.fragment_artifact_id)) {
        errors.push(`candidate ${candidate.id} has missing fragment ${dependency.fragment_artifact_id}`);
      }
    }
  }
  for (const field of graph.verifiedFields) {
    if (!candidates.has(field.candidate_id)) {
      errors.push(`verified field ${field.id} has no candidate`);
    }
    for (const fragmentId of field.source_fragment_ids) {
      if (!fragments.has(fragmentId)) {
        errors.push(`verified field ${field.id} has missing fragment ${fragmentId}`);
      }
    }
  }
  for (const dependency of graph.fragmentDependencies) {
    if (!fragments.has(dependency.fragment_artifact_id)) {
      errors.push(`fragment dependency owner ${dependency.fragment_artifact_id} is missing`);
    }
    for (const id of dependency.dependency_fragment_ids) {
      if (!fragments.has(id)) errors.push(`fragment dependency ${id} is missing`);
    }
  }
  return {
    status: errors.length === 0 ? 'pass' : 'fail',
    checked_verified_fields: graph.verifiedFields.length,
    checked_candidates: graph.candidates.length,
    checked_fragments: graph.fragments.length,
    errors,
  };
}

function comparedFields(
  graph: AdaptLegacyExtractionToStep1ShadowResult,
  interpretation: Awaited<ReturnType<typeof buildStep3SemanticInterpretation>>,
): GenericComparedField[] {
  const cells = new Map<string, GridCellArtifact>(
    graph.fragments
      .filter((fragment): fragment is GridCellArtifact => fragment.kind === 'cell')
      .map((cell) => [cell.id, cell]),
  );
  const rows = graph.fragments
    .filter((fragment): fragment is LogicalTableRow =>
      fragment.kind === 'region'
      && (fragment as LogicalTableRow).region_role === 'table_row');
  const rowByCell = new Map<string, string>(rows.flatMap((row) =>
    row.cell_ids.map((cellId) => [cellId, row.id] as const)));
  const roleByField = new Map<string, {
    role: string;
    status: 'resolved' | 'ambiguous';
  }>();
  for (const mapping of interpretation.semantic_column_mappings) {
    const record = mapping as {
      domain_role?: string;
      status?: 'resolved' | 'ambiguous';
      cell_verified_field_ids?: readonly string[];
    };
    for (const fieldId of record.cell_verified_field_ids ?? []) {
      roleByField.set(fieldId, {
        role: record.domain_role ?? 'other',
        status: record.status ?? 'ambiguous',
      });
    }
  }
  const interpretationManifestHash = interpretation.interpretation_snapshot
    ? (interpretation.interpretation_snapshot.interpreter_manifest_hash as string)
    : null;
  return graph.verifiedFields.flatMap((field) => {
    const cellId = field.source_fragment_ids.find((id) => cells.has(id));
    const cell = cellId ? cells.get(cellId) : null;
    if (!cell || !cellId) return [];
    const role = roleByField.get(field.id);
    return [{
      verified_field_id: field.id,
      candidate_id: field.candidate_id,
      dependency_hash: hashCanonical({
        verified_field: field,
        source_fragments: field.source_fragment_ids,
      }),
      source_page: cell.page,
      source_bbox: cell.bounding_box,
      raw_text: field.raw_text,
      raw_text_sha256: sha256Hex(field.raw_text),
      normalized_value: field.normalized_value,
      confidence: field.confidence,
      source_fragment_ids: field.source_fragment_ids,
      table_cell_id: cellId,
      table_row_id: rowByCell.get(cellId) ?? null,
      table_segment_id: cell.table_segment_id,
      semantic_role: role?.role ?? null,
      semantic_status: role?.status ?? 'unmapped' as const,
      parser_manifest_hash: field.parser_manifest_hash,
      interpretation_manifest_hash: interpretationManifestHash,
    }];
  }).sort((left, right) =>
    left.source_page - right.source_page
    || left.source_bbox.y0 - right.source_bbox.y0
    || left.source_bbox.x0 - right.source_bbox.x0
    || left.dependency_hash.localeCompare(right.dependency_hash));
}

export async function runGenericShadowFromPdf(input: {
  readonly pdfPath: string;
  readonly expectedSha256?: string;
  readonly sourceDocumentId?: string;
  readonly associationSeed?: string;
}): Promise<GenericShadowRun> {
  const bytes = await readFile(input.pdfPath);
  const sourceSha256 = sha256Hex(bytes);
  const expectedSha256 = input.expectedSha256 ?? TDOT_PHASE1_EXPECTED_SOURCE_SHA256;
  if (sourceSha256 !== expectedSha256) {
    throw new Error(`source SHA-256 mismatch: expected ${expectedSha256}, received ${sourceSha256}`);
  }
  const sidecar = await buildGenericPdfShadowSidecar(
    toArrayBuffer(bytes),
    'application/pdf',
  );
  if (!sidecar) throw new Error('generic PDF shadow sidecar was not produced');
  const parserManifest = buildLegacyShadowParserManifest({
    analysisMode: 'deterministic',
    unstructuredEnabled: false,
    visionEnabled: false,
    typedAiEnabled: false,
    implementationBuild: `tdot-phase1-harness:${TDOT_PHASE1_HARNESS_VERSION}`,
    verificationPolicy: 'step1_span_verified',
  });
  const parserManifestHash = hashParserManifest(parserManifest);
  const sourceDocumentId = input.sourceDocumentId
    ?? opaqueIds.sourceArtifact({
      kind: 'evaluation_source_document_association',
      association_seed: input.associationSeed ?? 'default',
    });
  const sourceArtifact: SourceArtifact = {
    id: opaqueIds.sourceArtifact({
      source_sha256: sourceSha256,
      byte_length: bytes.byteLength,
      media_type_sniffed: 'application/pdf',
    }),
    organization_id: 'phase1-shadow-evaluation',
    source_document_id: sourceDocumentId,
    source_sha256: sourceSha256,
    storage_object_version: `sha256:${sourceSha256}`,
    media_type_sniffed: 'application/pdf',
    byte_length: bytes.byteLength,
    created_at: TDOT_PHASE1_FIXED_TIME,
  };
  const graph = await adaptLegacyExtractionToStep1Shadow({
    sourceArtifact,
    parserManifest,
    parserManifestHash,
    artifactSchemaVersion: parserManifest.artifact_schema_version,
    idempotencyKey: `tdot-phase1:${sourceSha256}:${parserManifestHash}`,
    completedAt: TDOT_PHASE1_FIXED_TIME,
    locatedObservations: flattenLocatedObservations(sidecar),
    locatedPages: locatedPages(sidecar),
    genericContentAnalysis: sidecar.content_analysis,
    genericContentGaps: sidecar.content_gaps,
  });
  const interpretation = await buildStep3SemanticInterpretation({
    extraction_snapshot_id: graph.snapshot.id,
    chains: graph.tableChains,
    segments: graph.tableSegments,
    cells: graph.fragments.filter(
      (fragment): fragment is GridCellArtifact => fragment.kind === 'cell',
    ),
    verified_field_handles: graph.verifiedFieldHandles,
    published_at: TDOT_PHASE1_FIXED_TIME,
  });
  return {
    source_sha256: sourceSha256,
    source_byte_length: bytes.byteLength,
    source_document_id: sourceDocumentId,
    graph,
    interpretation,
    fields: comparedFields(graph, interpretation),
    dependency_closure: dependencyClosure(graph),
  };
}

function normalizedBox(observation: TdotLedgerObservation): BoundingBox {
  return {
    coordinate_space: 'page_normalized',
    origin: 'top_left',
    x0: observation.bbox_x0 / observation.page_width_points,
    y0: observation.bbox_y0 / observation.page_height_points,
    x1: observation.bbox_x1 / observation.page_width_points,
    y1: observation.bbox_y1 / observation.page_height_points,
    rotation: 0,
  };
}

function centerInside(field: GenericComparedField, observation: TdotLedgerObservation): boolean {
  if (field.source_page !== observation.source_page) return false;
  const ledger = normalizedBox(observation);
  const x = (field.source_bbox.x0 + field.source_bbox.x1) / 2;
  const y = (field.source_bbox.y0 + field.source_bbox.y1) / 2;
  return x >= ledger.x0 && x <= ledger.x1 && y >= ledger.y0 && y <= ledger.y1;
}

function normalizedText(value: string): string {
  return value.normalize('NFKC').replace(/\s+/g, ' ').trim();
}

function punctuationNormalizedText(value: string): string {
  return normalizedText(value)
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function reconstruction(fields: readonly GenericComparedField[]): string {
  const bands: GenericComparedField[][] = [];
  for (const field of [...fields].sort((left, right) =>
    left.source_bbox.y0 - right.source_bbox.y0
    || left.source_bbox.x0 - right.source_bbox.x0
    || left.dependency_hash.localeCompare(right.dependency_hash))) {
    const center = (field.source_bbox.y0 + field.source_bbox.y1) / 2;
    const band = bands.find((candidate) => {
      const first = candidate[0];
      if (!first) return false;
      const firstCenter = (first.source_bbox.y0 + first.source_bbox.y1) / 2;
      return Math.abs(center - firstCenter) <= 0.004;
    });
    if (band) band.push(field);
    else bands.push([field]);
  }
  return bands.map((band) =>
    band.sort((left, right) => left.source_bbox.x0 - right.source_bbox.x0)
      .map((field) => field.raw_text).join(' ')).join('\n');
}

function roleForLedger(role: string): string | null {
  if (role === 'cost') return 'rate';
  if (role === 'row_label') return 'row_label';
  if (role === 'origin_destination') return 'origin_destination';
  return role;
}

function classifyLedgerObservation(
  observation: TdotLedgerObservation,
  fields: readonly GenericComparedField[],
): Pick<
  ParityRecord,
  'classification' | 'resolution' | 'material' | 'explanation'
  | 'reconstruction_comparison'
> {
  if (fields.length === 0) {
    return {
      classification: 'missing_or_uncertain',
      resolution: 'unresolved',
      material: true,
      explanation: 'No verified generic table-cell dependency falls inside the source ledger cell.',
      reconstruction_comparison: null,
    };
  }
  const reconstructed = reconstruction(fields);
  const reconstructionComparison = {
    reconstructed_raw_text: reconstructed,
    exact_equal: reconstructed === observation.exact_raw_text,
    whitespace_normalized_equal:
      normalizedText(reconstructed) === normalizedText(observation.exact_raw_text),
    punctuation_normalized_equal:
      punctuationNormalizedText(reconstructed)
        === punctuationNormalizedText(observation.exact_raw_text),
  };
  if (!reconstructionComparison.exact_equal) {
    return {
      classification: fields.length > 1 ? 'duplicate_split_merge' : 'missing_or_uncertain',
      resolution: 'unresolved',
      material: true,
      explanation: `Generic verified fragments do not reconstruct exact ledger raw text `
        + `(whitespace_normalized_equal=${reconstructionComparison.whitespace_normalized_equal}, `
        + `punctuation_normalized_equal=${reconstructionComparison.punctuation_normalized_equal}).`,
      reconstruction_comparison: reconstructionComparison,
    };
  }
  if (fields.length !== 1) {
    return {
      classification: 'duplicate_split_merge',
      resolution: 'unresolved',
      material: true,
      explanation: 'Source text is covered, but the generic graph split one logical ledger cell into multiple verified cells.',
      reconstruction_comparison: reconstructionComparison,
    };
  }
  const expectedRole = roleForLedger(observation.interpreted_field_or_role);
  const field = fields[0];
  if (
    expectedRole == null
    || field.semantic_status !== 'resolved'
    || field.semantic_role !== expectedRole
  ) {
    return {
      classification: 'missing_or_uncertain',
      resolution: 'requires_semantic_review',
      material: true,
      explanation: `Raw source matches, but semantic role is ${field.semantic_status}:${field.semantic_role ?? 'none'} for ledger role ${observation.interpreted_field_or_role}.`,
      reconstruction_comparison: reconstructionComparison,
    };
  }
  return {
    classification: classifyParityDifference({
      legacy_present: false,
      legacy_supported: false,
      generic_supported: true,
      values_equivalent: false,
      duplicate_split_merge: false,
    }),
    resolution: 'resolved',
    material: true,
    explanation: 'The generic field is source-grounded and semantically resolved; no independently supported historical field exists for a legacy match.',
    reconstruction_comparison: reconstructionComparison,
  };
}

function findContractAnalysis(value: unknown): HistoricalContractAnalysis | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (Array.isArray(record.rate_schedule_rows)) {
    return record as unknown as HistoricalContractAnalysis;
  }
  for (const child of Object.values(record)) {
    const found = findContractAnalysis(child);
    if (found) return found;
  }
  return null;
}

export async function loadPhase1Inputs(input: {
  readonly ledgerPath: string;
  readonly historicalContractAnalysisPath: string;
}): Promise<{
  readonly ledger: TdotLedger;
  readonly legacyRows: readonly LegacyTdotRow[];
}> {
  const ledger = JSON.parse(await readFile(input.ledgerPath, 'utf8')) as TdotLedger;
  const historical = JSON.parse(
    await readFile(input.historicalContractAnalysisPath, 'utf8'),
  ) as HistoricalExport<unknown>;
  const analysis = findContractAnalysis(historical);
  const legacyRows = analysis?.rate_schedule_rows?.filter(
    (row) => row.source_kind === 'tdot_appendix_b_stitched_table',
  ) ?? [];
  return { ledger, legacyRows };
}

export function buildParityRecords(input: {
  readonly ledger: TdotLedger;
  readonly legacyRows: readonly LegacyTdotRow[];
  readonly genericFields: readonly GenericComparedField[];
}): ParityRecord[] {
  const genericRecords = input.ledger.observations.map((observation) => {
    const fields = input.genericFields.filter((field) => centerInside(field, observation));
    const classification = classifyLedgerObservation(observation, fields);
    return {
      id: hashCanonical({
        scope: 'generic_to_ledger',
        field_identifier: observation.field_identifier,
        generic_dependencies: fields.map((field) => field.dependency_hash),
      }),
      comparison_scope: 'generic_to_ledger' as const,
      ...classification,
      ledger: observation,
      generic_fields: fields,
      legacy_row: null,
      comparison_basis: [
        'source_pdf_sha256',
        'source_page',
        'source_bbox',
        'raw_text_sha256',
        'verified_dependency_hash',
        'semantic_mapping',
      ],
    };
  });
  const legacyRecords = input.legacyRows.map((row) => ({
    id: hashCanonical({
      scope: 'legacy_diagnostic',
      row_id: row.row_id,
      source_anchor_ids: row.source_anchor_ids,
    }),
    comparison_scope: 'legacy_diagnostic' as const,
    classification: 'legacy_unsupported' as const,
    resolution: 'resolved' as const,
    material: true,
    explanation:
      'Historical TDOT row is authored/quarantined and lacks independent field-level dependency closure; retained only as diagnostic comparison evidence.',
    ledger: null,
    generic_fields: [],
    legacy_row: row,
    comparison_basis: [
      'historical_source_kind',
      'historical_row_id',
      'historical_source_anchor_ids_diagnostic_only',
    ],
    reconstruction_comparison: null,
  }));
  return [...genericRecords, ...legacyRecords];
}

export const REQUIRED_METAMORPHIC_INVARIANTS = Object.freeze([
  ['change_rate', 'Changing one rate changes only that field and descendants.'],
  ['change_quantity', 'Changing one quantity changes only that field and descendants.'],
  ['change_unit', 'Changing one unit changes only that field and descendants.'],
  ['change_description', 'Changing one description changes only that field and descendants.'],
  ['change_extension', 'Changing one extension changes only that field and descendants.'],
  ['remove_row', 'Removing a row removes only that row and dependents.'],
  ['insert_row', 'Inserting a row produces one new source-grounded row.'],
  ['duplicate_row', 'Duplicating a row preserves both source instances.'],
  ['reorder_rows', 'Reordering rows preserves values and changes source positions.'],
  ['move_table_page', 'Moving a table or page preserves values and changes provenance.'],
  ['reorder_columns', 'Reordering columns preserves roles and values.'],
  ['missing_borders', 'Missing borders retain supported values.'],
  ['merged_multiline_cells', 'Merged and multiline cells retain supported values.'],
  ['subtables', 'Subtables retain supported values.'],
  ['repeated_headers', 'Repeated headers retain supported values.'],
  ['cross_page_continuation', 'Cross-page continuation retains supported values.'],
  ['delete_supporting_span', 'Deleting support removes verification and produces a gap.'],
  ['association_invariance', 'Renaming or changing association IDs preserves semantic values and fingerprint.'],
  ['historical_fingerprint_inert', 'Changing a historical fingerprint never restores an old value.'],
  ['native_ocr_arbitration', 'Superior OCR and partial native text remain inspectable.'],
  ['engine_conflict', 'Native/OCR/vision conflicts remain inspectable and unsupported winners do not verify.'],
] as const);

export function blockedMetamorphicResults(reason: string): MetamorphicResult[] {
  return REQUIRED_METAMORPHIC_INVARIANTS.map(([invariantId, description]) => ({
    invariant_id: invariantId,
    description,
    status: 'blocked',
    mutation_manifest: null,
    explanation: reason,
    changed_field_ids: [],
    unexpected_field_ids: [],
  }));
}

function semanticMultiset(run: GenericShadowRun): readonly string[] {
  return run.fields.map((field) => hashCanonical({
    source_page: field.source_page,
    source_bbox: field.source_bbox,
    raw_text: field.raw_text,
    normalized_value: field.normalized_value,
    semantic_role: field.semantic_role,
    semantic_status: field.semantic_status,
    parser_manifest_hash: field.parser_manifest_hash,
    interpretation_manifest_hash: field.interpretation_manifest_hash,
  })).sort();
}

export function evaluateAssociationInvariance(input: {
  readonly baseline: GenericShadowRun;
  readonly reassociated: GenericShadowRun;
}): MetamorphicResult {
  const baselineSignature = semanticMultiset(input.baseline);
  const reassociatedSignature = semanticMultiset(input.reassociated);
  const valuesEqual = hashCanonical(baselineSignature) === hashCanonical(reassociatedSignature);
  const fingerprintEqual =
    input.baseline.graph.snapshot.content_extraction_fingerprint
    === input.reassociated.graph.snapshot.content_extraction_fingerprint;
  const associationChanged =
    input.baseline.source_document_id !== input.reassociated.source_document_id;
  const status = valuesEqual && fingerprintEqual && associationChanged ? 'pass' : 'fail';
  return {
    invariant_id: 'association_invariance',
    description:
      'Renaming or changing association IDs preserves semantic values and fingerprint.',
    status,
    mutation_manifest: {
      mutation_type: 'association_only',
      source_bytes_changed: false,
      source_sha256_before: input.baseline.source_sha256,
      source_sha256_after: input.reassociated.source_sha256,
      source_document_id_before: input.baseline.source_document_id,
      source_document_id_after: input.reassociated.source_document_id,
      semantic_multiset_hash_before: hashCanonical(baselineSignature),
      semantic_multiset_hash_after: hashCanonical(reassociatedSignature),
      content_extraction_fingerprint_before:
        input.baseline.graph.snapshot.content_extraction_fingerprint,
      content_extraction_fingerprint_after:
        input.reassociated.graph.snapshot.content_extraction_fingerprint,
    },
    explanation: status === 'pass'
      ? 'Identical source bytes under a different association ID preserved the semantic multiset and content extraction fingerprint.'
      : 'Association-only replay changed semantic output or the content extraction fingerprint.',
    changed_field_ids: [],
    unexpected_field_ids: status === 'pass'
      ? []
      : input.reassociated.fields.map((field) => field.verified_field_id),
  };
}

export function evaluateHistoricalFingerprintInert(input: {
  readonly baseline: GenericShadowRun;
  readonly historicalFingerprintBefore: string;
  readonly historicalFingerprintAfter: string;
}): MetamorphicResult {
  const serialized = JSON.stringify({
    snapshot: input.baseline.graph.snapshot,
    fields: input.baseline.fields,
    interpretation: input.baseline.interpretation,
  });
  const prohibitedValuesAbsent =
    !serialized.includes(input.historicalFingerprintBefore)
    && !serialized.includes(input.historicalFingerprintAfter);
  return {
    invariant_id: 'historical_fingerprint_inert',
    description:
      'Changing a historical fingerprint never restores an old value.',
    status: prohibitedValuesAbsent ? 'pass' : 'fail',
    mutation_manifest: {
      mutation_type: 'prohibited_legacy_fingerprint_parameter',
      historical_fingerprint_before: input.historicalFingerprintBefore,
      historical_fingerprint_after: input.historicalFingerprintAfter,
      generic_pipeline_parameter_present: false,
      generic_output_contains_either_value: !prohibitedValuesAbsent,
    },
    explanation: prohibitedValuesAbsent
      ? 'The generic evaluation API has no legacy-fingerprint input and neither altered value appears in the graph or interpretation output.'
      : 'A prohibited historical fingerprint value appeared in generic output.',
    changed_field_ids: [],
    unexpected_field_ids: [],
  };
}

export function evaluateObservedEngineArbitration(
  baseline: GenericShadowRun,
): readonly MetamorphicResult[] {
  const multiCandidate = baseline.graph.arbitrationDecisions.filter(
    (decision) => decision.candidate_ids.length > 1,
  );
  const nativeOcr: MetamorphicResult = {
    invariant_id: 'native_ocr_arbitration',
    description: 'Superior OCR and partial native text remain inspectable.',
    status: multiCandidate.length > 0 ? 'pass' : 'blocked',
    mutation_manifest: {
      mutation_type: 'engine_observation_audit',
      multi_candidate_region_count: multiCandidate.length,
    },
    explanation: multiCandidate.length > 0
      ? `${multiCandidate.length} regions retained multiple engine candidates and an explicit arbitration decision.`
      : 'The verified TDOT source did not schedule a competing OCR candidate for any native region, so this source cannot exercise native/OCR arbitration without a source-level raster mutation.',
    changed_field_ids: [],
    unexpected_field_ids: [],
  };
  const hasVision = baseline.graph.fragments.some(
    (fragment) => fragment.parser.stage === 'vision',
  );
  const engineConflict: MetamorphicResult = {
    invariant_id: 'engine_conflict',
    description:
      'Native/OCR/vision conflicts remain inspectable and unsupported winners do not verify.',
    status: hasVision && multiCandidate.length > 0 ? 'pass' : 'blocked',
    mutation_manifest: {
      mutation_type: 'engine_conflict_audit',
      vision_fragment_present: hasVision,
      multi_candidate_region_count: multiCandidate.length,
    },
    explanation: hasVision && multiCandidate.length > 0
      ? 'Native/OCR/vision alternatives and arbitration decisions are retained.'
      : 'The deterministic Phase 1 manifest disables unpinned vision and this source produced no three-engine conflict; the invariant remains blocked rather than fabricating model output.',
    changed_field_ids: [],
    unexpected_field_ids: [],
  };
  return [nativeOcr, engineConflict];
}

export function mergeMetamorphicResults(
  baselineResults: readonly MetamorphicResult[],
  executedResults: readonly MetamorphicResult[],
): MetamorphicResult[] {
  const replacements = new Map(
    executedResults.map((result) => [result.invariant_id, result] as const),
  );
  return baselineResults.map((result) =>
    replacements.get(result.invariant_id) ?? result);
}

function countBy<T extends string>(
  values: readonly T[],
  keys: readonly T[],
): Record<T, number> {
  return Object.fromEntries(keys.map((key) => [
    key,
    values.filter((value) => value === key).length,
  ])) as Record<T, number>;
}

export function buildPhase1Report(input: {
  readonly gateVerification: {
    readonly gate_definition_version: string;
    readonly status: string;
    readonly check_count: number;
    readonly failed_check_count: number;
    readonly authorization: {
      readonly production_reader_changes_authorized: false;
      readonly legacy_removal_authorized: false;
    };
  };
  readonly ledger: TdotLedger;
  readonly run: GenericShadowRun;
  readonly parityRecords: readonly ParityRecord[];
  readonly metamorphicResults: readonly MetamorphicResult[];
}): TdotPhase1Report {
  const classifications: readonly ParityClassification[] = [
    'match',
    'legacy_unsupported',
    'newly_supported',
    'changed_source_grounded',
    'missing_or_uncertain',
    'duplicate_split_merge',
  ];
  const metamorphicStatuses: readonly MetamorphicResult['status'][] = [
    'pass', 'fail', 'blocked', 'not_applicable',
  ];
  const materialDifferences = input.parityRecords.filter((record) => record.material);
  const unresolved = materialDifferences.filter((record) => record.resolution !== 'resolved');
  const ambiguityCount = input.run.interpretation.semantic_column_mappings.filter(
    (mapping) => mapping.status === 'ambiguous',
  ).length;
  return {
    report_version: TDOT_PHASE1_HARNESS_VERSION,
    generated_at: TDOT_PHASE1_FIXED_TIME,
    phase: 'phase3_step4_phase1_shadow',
    shadow_only: true,
    source: {
      sha256: input.run.source_sha256,
      byte_length: input.run.source_byte_length,
      page_count: input.ledger.source_pdf.pages,
    },
    phase0_gate: {
      status: input.gateVerification.status,
      gate_definition_version: input.gateVerification.gate_definition_version,
      check_count: input.gateVerification.check_count,
      failed_check_count: input.gateVerification.failed_check_count,
      production_reader_changes_authorized: false,
      legacy_removal_authorized: false,
    },
    generic_run: {
      snapshot_id: input.run.graph.snapshot.id,
      content_extraction_fingerprint:
        input.run.graph.snapshot.content_extraction_fingerprint,
      parser_manifest_hash: input.run.graph.snapshot.parser_manifest_hash,
      artifact_root_hash: input.run.graph.snapshot.artifact_root_hash,
      status: input.run.graph.snapshot.status,
      pages: input.run.graph.pages.length,
      table_segments: input.run.graph.tableSegments.length,
      table_chains: input.run.graph.tableChains.length,
      verified_fields: input.run.graph.verifiedFields.length,
      compared_fields: input.run.fields.length,
      semantic_mappings: input.run.interpretation.semantic_column_mappings.length,
      semantic_ambiguities: ambiguityCount,
      gaps: input.run.graph.gaps.length,
      dependency_closure: input.run.dependency_closure,
    },
    parity: {
      classification_counts: countBy(
        input.parityRecords.map((record) => record.classification),
        classifications,
      ),
      records: input.parityRecords,
      material_differences: materialDifferences,
    },
    metamorphic: {
      result_counts: countBy(
        input.metamorphicResults.map((result) => result.status),
        metamorphicStatuses,
      ),
      results: input.metamorphicResults,
    },
    prohibited_builder_calls: {
      count: 0,
      symbols: [
        'TDOT_APPENDIX_B_SPECS',
        'tdot_appendix_b_stitched_table',
        'assembleContractRateScheduleRows',
      ],
    },
    phase2_readiness: {
      status: 'not_ready',
      unresolved_material_difference_ids: unresolved.map((record) => record.id),
      cutover_decision: null,
    },
  };
}

export function renderPhase1Markdown(report: TdotPhase1Report): string {
  const counts = report.parity.classification_counts;
  const meta = report.metamorphic.result_counts;
  const materialGroups = new Map<string, number>();
  for (const record of report.parity.material_differences) {
    const key = `${record.classification} / ${record.resolution}`;
    materialGroups.set(key, (materialGroups.get(key) ?? 0) + 1);
  }
  return [
    '# TDOT Phase 3 Step 4 Phase 1 Shadow Report',
    '',
    `Report version: ${report.report_version}`,
    `Source SHA-256: ${report.source.sha256}`,
    `Phase 0 gate: ${report.phase0_gate.status}`,
    `Shadow only: ${report.shadow_only}`,
    `Dependency closure: ${report.generic_run.dependency_closure.status}`,
    '',
    '## Generic execution',
    '',
    `- Pages: ${report.generic_run.pages}`,
    `- Verified fields: ${report.generic_run.verified_fields}`,
    `- Generic compared table fields: ${report.generic_run.compared_fields}`,
    `- Table segments / chains: ${report.generic_run.table_segments} / ${report.generic_run.table_chains}`,
    `- Semantic mappings / ambiguities: ${report.generic_run.semantic_mappings} / ${report.generic_run.semantic_ambiguities}`,
    `- Explicit gaps: ${report.generic_run.gaps}`,
    '',
    '## Parity classifications',
    '',
    ...Object.entries(counts).map(([key, value]) => `- ${key}: ${value}`),
    '',
    '## Material differences',
    '',
    ...[...materialGroups.entries()].map(([key, value]) => `- ${key}: ${value}`),
    '',
    '### Material difference ledger',
    '',
    ...report.parity.material_differences.map((record) => {
      const source = record.ledger
        ? `${record.ledger.field_identifier} p${record.ledger.source_page} bbox(${[
            record.ledger.bbox_x0,
            record.ledger.bbox_y0,
            record.ledger.bbox_x1,
            record.ledger.bbox_y1,
          ].join(',')})`
        : record.legacy_row
          ? `${record.legacy_row.row_id} anchors(${record.legacy_row.source_anchor_ids.join(',')})`
          : 'unidentified';
      const dependencies = record.generic_fields.length > 0
        ? record.generic_fields.map((field) => field.dependency_hash).join(',')
        : 'none';
      return `- ${record.id} | ${record.classification} | ${record.resolution} | ${source} | dependencies: ${dependencies} | ${record.explanation}`;
    }),
    '',
    'The machine-readable report additionally preserves every raw text value/hash, confidence value, parser/interpretation manifest, VerifiedField ID, and dependency reference.',
    '',
    '## Metamorphic execution',
    '',
    ...Object.entries(meta).map(([key, value]) => `- ${key}: ${value}`),
    '',
    ...report.metamorphic.results.map((result) =>
      `- ${result.invariant_id}: ${result.status} - ${result.explanation}`),
    '',
    '## Phase 2 readiness',
    '',
    `Status: ${report.phase2_readiness.status}`,
    `Unresolved material differences: ${report.phase2_readiness.unresolved_material_difference_ids.length}`,
    'Cutover decision: none',
    '',
    'No production reader, validator, legacy builder, or persistence writer was invoked by this report.',
    '',
  ].join('\n');
}

export async function writePhase1Reports(input: {
  readonly outputDirectory: string;
  readonly report: TdotPhase1Report;
}): Promise<{
  readonly jsonPath: string;
  readonly markdownPath: string;
  readonly manifestPath: string;
}> {
  await mkdir(input.outputDirectory, { recursive: true });
  const jsonPath = path.join(
    input.outputDirectory,
    `tdot-phase1-parity-report.v${TDOT_PHASE1_HARNESS_VERSION}.json`,
  );
  const markdownPath = path.join(
    input.outputDirectory,
    `tdot-phase1-parity-report.v${TDOT_PHASE1_HARNESS_VERSION}.md`,
  );
  const manifestPath = path.join(
    input.outputDirectory,
    `tdot-phase1-report-manifest.v${TDOT_PHASE1_HARNESS_VERSION}.json`,
  );
  const json = `${JSON.stringify(input.report, null, 2)}\n`;
  const markdown = renderPhase1Markdown(input.report);
  await writeFile(jsonPath, json, 'utf8');
  await writeFile(markdownPath, markdown, 'utf8');
  await writeFile(manifestPath, `${JSON.stringify({
    manifest_version: TDOT_PHASE1_HARNESS_VERSION,
    generated_at: TDOT_PHASE1_FIXED_TIME,
    source_pdf_sha256: input.report.source.sha256,
    report_files: [
      {
        file: path.basename(jsonPath),
        byte_length: Buffer.byteLength(json),
        sha256: sha256Hex(json),
      },
      {
        file: path.basename(markdownPath),
        byte_length: Buffer.byteLength(markdown),
        sha256: sha256Hex(markdown),
      },
    ],
    production_reader_changes: false,
    legacy_removal: false,
    cutover_decision: null,
  }, null, 2)}\n`, 'utf8');
  return { jsonPath, markdownPath, manifestPath };
}
