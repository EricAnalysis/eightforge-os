export type NonEmpty<T> = readonly [T, ...T[]];

import type { PhysicalPageCoordinate } from '@/lib/extraction/provenance/physicalPageCoordinate';

declare const sourceArtifactIdBrand: unique symbol;
declare const extractionRunIdBrand: unique symbol;
declare const pageArtifactIdBrand: unique symbol;
declare const fragmentArtifactIdBrand: unique symbol;
declare const fieldCandidateIdBrand: unique symbol;
declare const verifiedFieldIdBrand: unique symbol;
declare const extractionSnapshotIdBrand: unique symbol;
declare const canonicalFactIdBrand: unique symbol;

export type SourceArtifactId = string & { readonly [sourceArtifactIdBrand]: true };
export type ExtractionRunId = string & { readonly [extractionRunIdBrand]: true };
export type PageArtifactId = string & { readonly [pageArtifactIdBrand]: true };
export type FragmentArtifactId = string & { readonly [fragmentArtifactIdBrand]: true };
export type FieldCandidateId = string & { readonly [fieldCandidateIdBrand]: true };
export type VerifiedFieldId = string & { readonly [verifiedFieldIdBrand]: true };
export type ExtractionSnapshotId = string & { readonly [extractionSnapshotIdBrand]: true };
export type CanonicalFactId = string & { readonly [canonicalFactIdBrand]: true };

export type ProcessingStage =
  | 'source_download'
  | 'source_ingest'
  | 'page_render'
  | 'native_text'
  | 'ocr'
  | 'vision'
  | 'partition'
  | 'layout'
  | 'region_arbitration'
  | 'table_reconstruction'
  | 'primitive_parse'
  | 'field_verification'
  | 'interpretation'
  | 'canonical_interpretation'
  | 'persistence';

export interface ParserIdentity {
  readonly stage: ProcessingStage;
  readonly name: string;
  readonly version: string;
  readonly configuration_hash: string;
}

export interface BoundingBox {
  readonly coordinate_space: 'page_normalized';
  readonly origin: 'top_left';
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
  readonly rotation: 0 | 90 | 180 | 270;
}

export interface SourceArtifact {
  readonly id: SourceArtifactId;
  readonly organization_id: string;
  readonly source_document_id: string;
  readonly source_sha256: string;
  readonly storage_object_version: string;
  readonly media_type_sniffed: string;
  readonly byte_length: number;
  readonly created_at: string;
}

export interface ExtractionRun {
  readonly id: ExtractionRunId;
  readonly organization_id: string;
  readonly semantic_key: string;
  readonly attempt_number: number;
  readonly source_artifact_id: SourceArtifactId;
  readonly parser_manifest_hash: string;
  readonly artifact_schema_version: string;
  readonly status: ExtractionRunStatus;
}

export interface PageArtifact {
  readonly id: PageArtifactId;
  readonly organization_id: string;
  readonly extraction_run_id: ExtractionRunId;
  readonly source_artifact_id: SourceArtifactId;
  readonly source_document_id: string;
  readonly source_sha256: string;
  readonly page: number;
  readonly width: number;
  readonly height: number;
  readonly rotation_degrees: 0 | 90 | 180 | 270;
  readonly render_sha256: string;
  readonly parser_manifest_hash: string;
  readonly parser: ParserIdentity;
  readonly status: 'processed' | 'blank_verified' | 'partial' | 'failed';
  readonly physical_page_coordinate?: PhysicalPageCoordinate;
}

export type FragmentKind = 'token' | 'cell' | 'region' | 'layout_signal';

export interface SourceFragmentArtifact {
  readonly id: FragmentArtifactId;
  readonly organization_id: string;
  readonly kind: FragmentKind;
  readonly extraction_run_id: ExtractionRunId;
  readonly source_artifact_id: SourceArtifactId;
  readonly page_artifact_id: PageArtifactId;
  readonly source_document_id: string;
  readonly source_sha256: string;
  readonly parser_manifest_hash: string;
  readonly page: number;
  readonly bounding_box: BoundingBox;
  readonly raw_text: string;
  readonly parser: ParserIdentity;
  readonly recognition_confidence: number | null;
  readonly reading_order: number;
  readonly artifact_data?: Readonly<Record<string, unknown>>;
  readonly corroboration_kind?: 'independent_engine' | 'source_pixel_classifier';
  readonly physical_page_coordinate?: PhysicalPageCoordinate;
}

/** Historical rows may predate provenance; every newly written v2 page must carry it. */
export type ProvenanceRequiredPageArtifact = PageArtifact & Readonly<{
  physical_page_coordinate: PhysicalPageCoordinate;
}>;

/** Historical rows may predate provenance; every newly written v2 fragment must carry it. */
export type ProvenanceRequiredSourceFragmentArtifact<
  T extends SourceFragmentArtifact = SourceFragmentArtifact,
> = T & Readonly<{
  physical_page_coordinate: PhysicalPageCoordinate;
}>;

export type TableValueKind =
  | 'free_text'
  | 'identifier'
  | 'integer'
  | 'decimal'
  | 'currency'
  | 'date_like'
  | 'unit_token'
  | 'boolean_like'
  | 'unknown';

export type BorderSignal = 'ruling' | 'whitespace' | 'alignment' | 'none';

export interface MeasuredScore {
  readonly value: number;
  readonly calculator: ParserIdentity;
  readonly basis_artifact_ids: NonEmpty<FragmentArtifactId>;
  readonly diagnostics: readonly string[];
  readonly measurements?: Readonly<Record<string, number | boolean | string | null>>;
}

export interface GridCellArtifact extends SourceFragmentArtifact {
  readonly kind: 'cell';
  readonly content_token_ids: readonly FragmentArtifactId[];
  readonly structural_evidence_ids: NonEmpty<FragmentArtifactId>;
  readonly table_segment_id: FragmentArtifactId;
  readonly row_start: number;
  readonly row_span: number;
  readonly column_start: number;
  readonly column_span: number;
  readonly line_break_offsets: readonly number[];
  readonly structure:
    | 'ordinary'
    | 'merged'
    | 'row_spanning'
    | 'column_spanning'
    | 'continuation'
    | 'empty_observed';
  readonly border_evidence: {
    readonly top: BorderSignal;
    readonly right: BorderSignal;
    readonly bottom: BorderSignal;
    readonly left: BorderSignal;
  };
}

export type HeaderObservation =
  | {
      readonly observed_text: string;
      readonly normalized_label: string;
      readonly fragment_ids: NonEmpty<FragmentArtifactId>;
      readonly transformations: readonly TransformationStep[];
    }
  | {
      readonly observed_text: null;
      readonly normalized_label: null;
      readonly fragment_ids: readonly [];
      readonly transformations: readonly [];
    };

export interface LogicalTableRow extends SourceFragmentArtifact {
  readonly kind: 'region';
  readonly region_role: 'table_row';
  readonly child_fragment_ids: NonEmpty<FragmentArtifactId>;
  readonly cell_ids: readonly FragmentArtifactId[];
  readonly row_kind:
    | 'header'
    | 'data'
    | 'section_header'
    | 'continuation'
    | 'footer'
    | 'unknown';
  readonly continued_from_row_id: FragmentArtifactId | null;
  readonly fragment_ids: NonEmpty<FragmentArtifactId>;
}

export interface ColumnStructureHypothesis {
  readonly index: number;
  readonly x0: number;
  readonly x1: number;
  readonly header: HeaderObservation;
  readonly value_kind_hypotheses: NonEmpty<{
    readonly kind: TableValueKind;
    readonly measurement: MeasuredScore;
  }>;
}

export interface TableSegmentArtifact extends SourceFragmentArtifact {
  readonly kind: 'region';
  readonly region_role: 'table';
  readonly child_fragment_ids: NonEmpty<FragmentArtifactId>;
  readonly column_hypotheses: readonly ColumnStructureHypothesis[];
  readonly row_ids: NonEmpty<FragmentArtifactId>;
  readonly repeated_header_row_ids: readonly FragmentArtifactId[];
  readonly parent_segment_id: FragmentArtifactId | null;
  readonly detection_evidence: NonEmpty<{
    readonly kind:
      | 'ruling_lines'
      | 'x_alignment'
      | 'whitespace_gutters'
      | 'repeated_headers'
      | 'typographic_grouping';
    readonly basis_artifact_ids: NonEmpty<FragmentArtifactId>;
    readonly calculator: ParserIdentity;
  }>;
}

export interface TableContinuationLink {
  readonly id: string;
  readonly organization_id: string;
  readonly extraction_run_id: ExtractionRunId;
  readonly source_artifact_id: SourceArtifactId;
  readonly source_document_id: string;
  readonly source_sha256: string;
  readonly parser_manifest_hash: string;
  readonly parser: ParserIdentity;
  readonly from_segment_id: FragmentArtifactId;
  readonly to_segment_id: FragmentArtifactId;
  readonly basis: {
    readonly column_band_similarity: MeasuredScore;
    readonly header_similarity: MeasuredScore | null;
    readonly edge_proximity: MeasuredScore;
    readonly typography_similarity: MeasuredScore;
    readonly row_continuation_score: MeasuredScore;
    readonly page_distance_penalty: MeasuredScore;
  };
  readonly score: MeasuredScore;
  readonly decision: 'linked' | 'ambiguous' | 'rejected';
}

export interface TableChainArtifact {
  readonly id: string;
  readonly organization_id: string;
  readonly extraction_run_id: ExtractionRunId;
  readonly source_artifact_id: SourceArtifactId;
  readonly source_document_id: string;
  readonly source_sha256: string;
  readonly parser_manifest_hash: string;
  readonly parser: ParserIdentity;
  readonly segment_ids: NonEmpty<FragmentArtifactId>;
  readonly continuation_links: readonly TableContinuationLink[];
  readonly section_ids: readonly string[];
  readonly completeness: 'complete' | 'partial' | 'ambiguous';
  readonly gap_ids: readonly string[];
}

export interface TableSectionArtifact {
  readonly id: string;
  readonly organization_id: string;
  readonly extraction_run_id: ExtractionRunId;
  readonly source_artifact_id: SourceArtifactId;
  readonly source_document_id: string;
  readonly source_sha256: string;
  readonly parser_manifest_hash: string;
  readonly parser: ParserIdentity;
  readonly table_chain_id: string;
  readonly header_row_id: FragmentArtifactId | null;
  readonly member_row_ids: NonEmpty<FragmentArtifactId>;
  readonly child_table_chain_ids: readonly string[];
}

export interface RegionCandidate extends SourceFragmentArtifact {
  readonly kind: 'region';
  readonly region_role: 'unknown' | 'text_block' | 'table' | 'image_text';
  readonly child_fragment_ids: NonEmpty<FragmentArtifactId>;
  readonly ordered_token_ids: NonEmpty<FragmentArtifactId>;
  readonly engine_reported_confidence: number | null;
  readonly quality_signals: {
    readonly glyph_validity: MeasuredScore;
    readonly geometry_coverage: MeasuredScore;
    readonly reading_order_consistency: MeasuredScore;
    readonly image_text_coverage: MeasuredScore | null;
  };
}

export interface ArbitrationDecision {
  readonly id: string;
  readonly organization_id: string;
  readonly extraction_run_id: ExtractionRunId;
  readonly source_artifact_id: SourceArtifactId;
  readonly source_document_id: string;
  readonly source_sha256: string;
  readonly parser_manifest_hash: string;
  readonly page_artifact_id: PageArtifactId;
  readonly parser: ParserIdentity;
  readonly physical_region_id: FragmentArtifactId;
  readonly candidate_ids: NonEmpty<FragmentArtifactId>;
  readonly accepted_candidate_ids: readonly FragmentArtifactId[];
  readonly rejected_candidate_ids: readonly FragmentArtifactId[];
  readonly agreement: MeasuredScore | null;
  readonly decision: 'consensus' | 'single_source' | 'conflict' | 'unresolved';
  readonly diagnostics: readonly string[];
}

export type FragmentDependencyRole = 'content' | 'corroboration';

export interface CandidateFragmentDependency {
  readonly fragment_artifact_id: FragmentArtifactId;
  readonly dependency_role: FragmentDependencyRole;
}

export type NormalizedPrimitive =
  | { readonly type: 'text'; readonly value: string }
  | { readonly type: 'decimal'; readonly value: string }
  | { readonly type: 'date'; readonly value: string }
  | { readonly type: 'boolean'; readonly value: boolean };

export type TransformationOperation =
  | 'unicode_nfkc'
  | 'collapse_whitespace'
  | 'normalize_line_breaks'
  | 'join_ordered_fragments'
  | 'strip_currency_symbol'
  | 'remove_group_separator'
  | 'decimal_parse'
  | 'date_parse'
  | 'ocr_glyph_substitution';

export interface TransformationStep {
  readonly sequence: number;
  readonly operation: TransformationOperation;
  readonly implementation_version: string;
  readonly input_sha256: string;
  readonly output_sha256: string;
  readonly input_text: string;
  readonly output_text: string;
  readonly lossless: boolean;
  readonly rationale: string;
}

export interface ConfidenceComponentObserved {
  readonly state: 'observed';
  readonly score: number;
  readonly basis_artifact_ids: NonEmpty<FragmentArtifactId>;
  readonly diagnostics: readonly string[];
}

export interface ConfidenceComponentUnavailable {
  readonly state: 'not_available' | 'not_applicable';
  readonly score: null;
  readonly basis_artifact_ids: readonly [];
  readonly diagnostics: readonly string[];
}

export type ConfidenceComponent =
  | ConfidenceComponentObserved
  | ConfidenceComponentUnavailable;

export interface ExtractionConfidence {
  readonly version: 'extraction-confidence-v1';
  readonly recognition: ConfidenceComponent;
  readonly geometry_alignment: ConfidenceComponent;
  readonly parse_normalization: ConfidenceComponent;
  readonly cross_engine_agreement: ConfidenceComponent;
  readonly overall: number;
  readonly grade: 'high' | 'medium' | 'low';
  readonly uncertainties: readonly string[];
}

export interface FieldCandidate {
  readonly id: FieldCandidateId;
  readonly organization_id: string;
  readonly extraction_run_id: ExtractionRunId;
  readonly source_artifact_id: SourceArtifactId;
  readonly source_document_id: string;
  readonly source_sha256: string;
  readonly parser_manifest_hash: string;
  readonly source_fragment_ids: NonEmpty<FragmentArtifactId>;
  readonly source_fragment_dependencies: NonEmpty<CandidateFragmentDependency>;
  readonly raw_text: string;
  readonly primitive_kind: NormalizedPrimitive['type'];
  readonly proposed_value: NormalizedPrimitive;
  readonly transformations: readonly TransformationStep[];
  readonly parser: ParserIdentity;
  readonly confidence: ExtractionConfidence;
  readonly status: 'candidate' | 'rejected' | 'ambiguous';
}

export type ExtractionRunStatus =
  | 'complete'
  | 'partial_retryable'
  | 'partial_terminal'
  | 'failed';

export interface ProcessingGap {
  readonly id: string;
  readonly gap_key: string;
  readonly organization_id: string;
  readonly source_document_id: string;
  readonly extraction_run_id: ExtractionRunId;
  readonly page: number | null;
  readonly bounding_box: BoundingBox | null;
  readonly stage: ProcessingStage;
  readonly reason:
    | 'timeout'
    | 'engine_failure'
    | 'unsupported_size'
    | 'unprocessed_region'
    | 'engine_conflict'
    | 'missing_geometry'
    | 'no_source_span'
    | 'content_quality_skip'
    | 'decode_failure'
    | 'ocr_region_failure'
    | 'table_structure_unresolved'
    | 'arbitration_unresolved';
  readonly retryable: boolean;
  readonly attempts: number;
  readonly detail: string;
  readonly upstream_artifact_ids: readonly FragmentArtifactId[];
}

export interface ExtractionSnapshot {
  readonly id: ExtractionSnapshotId;
  readonly organization_id: string;
  readonly source_document_id: string;
  readonly source_artifact_id: SourceArtifactId;
  readonly source_sha256: string;
  readonly parser_manifest_hash: string;
  readonly artifact_schema_version: string;
  readonly producing_run_id: ExtractionRunId;
  readonly status: 'complete' | 'partial';
  readonly content_extraction_fingerprint: string;
  readonly artifact_root_hash: string;
  readonly gap_ids: readonly string[];
  readonly published_at: string;
}

export interface ProjectionStamp {
  readonly source_artifact_id: SourceArtifactId;
  readonly source_sha256: string;
  readonly extraction_snapshot_id: ExtractionSnapshotId;
  readonly parser_manifest_hash: string;
  readonly interpretation_snapshot_id: string;
  readonly projection_schema_version: string;
}
