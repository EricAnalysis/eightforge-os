export type NonEmpty<T> = readonly [T, ...T[]];

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
  readonly dependency_role?: 'content' | 'corroboration';
  readonly corroboration_kind?: 'independent_engine' | 'source_pixel_classifier';
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
    | 'ocr_region_failure';
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
