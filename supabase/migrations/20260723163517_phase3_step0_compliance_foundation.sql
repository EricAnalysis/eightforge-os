-- Phase 3 Step 0: additive compliance foundation.
-- No existing table or reader is changed. New records are server-written,
-- organization-scoped, immutable provenance. Legacy shadow snapshots remain
-- partial and ineligible for validation cutover.

CREATE OR REPLACE FUNCTION public.reject_compliance_ledger_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only; % is not permitted', TG_TABLE_NAME, TG_OP
    USING ERRCODE = '55000';
END;
$$;

REVOKE ALL ON FUNCTION public.reject_compliance_ledger_mutation() FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.enforce_extraction_source_document_org()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.documents d
    WHERE d.id = NEW.source_document_id
      AND d.organization_id = NEW.organization_id
  ) THEN
    RAISE EXCEPTION 'source document must belong to the artifact organization'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.enforce_extraction_source_document_org() FROM PUBLIC;

CREATE TABLE IF NOT EXISTS public.extraction_source_artifacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  source_document_id uuid NOT NULL REFERENCES public.documents(id) ON DELETE RESTRICT,
  source_sha256 text NOT NULL CONSTRAINT extraction_source_artifacts_sha256_check
    CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
  storage_object_version text NOT NULL CONSTRAINT extraction_source_artifacts_storage_version_check
    CHECK (btrim(storage_object_version) <> ''),
  media_type_sniffed text NOT NULL CONSTRAINT extraction_source_artifacts_media_type_check
    CHECK (btrim(media_type_sniffed) <> ''),
  byte_length bigint NOT NULL CONSTRAINT extraction_source_artifacts_byte_length_check
    CHECK (byte_length >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT extraction_source_artifacts_org_id_unique UNIQUE (organization_id, id),
  CONSTRAINT extraction_source_artifacts_identity_unique
    UNIQUE (organization_id, source_document_id, source_sha256, storage_object_version)
);

DROP TRIGGER IF EXISTS trg_extraction_source_artifacts_document_org
  ON public.extraction_source_artifacts;
CREATE TRIGGER trg_extraction_source_artifacts_document_org
  BEFORE INSERT ON public.extraction_source_artifacts
  FOR EACH ROW EXECUTE FUNCTION public.enforce_extraction_source_document_org();

CREATE TABLE IF NOT EXISTS public.extraction_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  source_artifact_id uuid NOT NULL,
  semantic_key text NOT NULL CONSTRAINT extraction_runs_semantic_key_check
    CHECK (btrim(semantic_key) <> ''),
  idempotency_key text NOT NULL CONSTRAINT extraction_runs_idempotency_key_check
    CHECK (btrim(idempotency_key) <> ''),
  attempt_number integer NOT NULL CONSTRAINT extraction_runs_attempt_check
    CHECK (attempt_number > 0),
  parser_manifest jsonb NOT NULL CONSTRAINT extraction_runs_manifest_object_check
    CHECK (jsonb_typeof(parser_manifest) = 'object'),
  parser_manifest_hash text NOT NULL CONSTRAINT extraction_runs_manifest_hash_check
    CHECK (parser_manifest_hash ~ '^[0-9a-f]{64}$'),
  artifact_schema_version text NOT NULL CONSTRAINT extraction_runs_schema_version_check
    CHECK (btrim(artifact_schema_version) <> ''),
  initial_status text NOT NULL CONSTRAINT extraction_runs_initial_status_check
    CHECK (initial_status IN ('running', 'complete', 'partial_retryable', 'partial_terminal', 'failed')),
  started_at timestamptz NOT NULL,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT extraction_runs_org_id_unique UNIQUE (organization_id, id),
  CONSTRAINT extraction_runs_org_id_run_id_unique UNIQUE (organization_id, id, source_artifact_id),
  CONSTRAINT extraction_runs_idempotency_unique UNIQUE (organization_id, idempotency_key),
  CONSTRAINT extraction_runs_attempt_unique UNIQUE (organization_id, semantic_key, attempt_number),
  CONSTRAINT extraction_runs_source_fkey
    FOREIGN KEY (organization_id, source_artifact_id)
    REFERENCES public.extraction_source_artifacts(organization_id, id)
    ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS public.extraction_run_states (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  extraction_run_id uuid NOT NULL,
  state text NOT NULL CONSTRAINT extraction_run_states_state_check
    CHECK (state IN ('running', 'complete', 'partial_retryable', 'partial_terminal', 'failed')),
  reason text,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT extraction_run_states_org_id_unique UNIQUE (organization_id, id),
  CONSTRAINT extraction_run_states_idempotency_unique
    UNIQUE (organization_id, extraction_run_id, state, reason),
  CONSTRAINT extraction_run_states_run_fkey
    FOREIGN KEY (organization_id, extraction_run_id)
    REFERENCES public.extraction_runs(organization_id, id)
    ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS public.extraction_page_artifacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  extraction_run_id uuid NOT NULL,
  source_artifact_id uuid NOT NULL,
  source_document_id uuid NOT NULL REFERENCES public.documents(id) ON DELETE RESTRICT,
  source_sha256 text NOT NULL CONSTRAINT extraction_page_artifacts_sha256_check
    CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
  parser_manifest_hash text NOT NULL CONSTRAINT extraction_page_artifacts_manifest_hash_check
    CHECK (parser_manifest_hash ~ '^[0-9a-f]{64}$'),
  page integer NOT NULL CONSTRAINT extraction_page_artifacts_page_check CHECK (page > 0),
  width double precision NOT NULL CONSTRAINT extraction_page_artifacts_width_check CHECK (width > 0),
  height double precision NOT NULL CONSTRAINT extraction_page_artifacts_height_check CHECK (height > 0),
  rotation_degrees integer NOT NULL CONSTRAINT extraction_page_artifacts_rotation_check
    CHECK (rotation_degrees IN (0, 90, 180, 270)),
  render_sha256 text NOT NULL CONSTRAINT extraction_page_artifacts_render_sha256_check
    CHECK (render_sha256 ~ '^[0-9a-f]{64}$'),
  parser jsonb NOT NULL CONSTRAINT extraction_page_artifacts_parser_check
    CHECK (jsonb_typeof(parser) = 'object'),
  status text NOT NULL CONSTRAINT extraction_page_artifacts_status_check
    CHECK (status IN ('processed', 'blank_verified', 'partial', 'failed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT extraction_page_artifacts_org_id_unique UNIQUE (organization_id, id),
  CONSTRAINT extraction_page_artifacts_org_run_id_unique UNIQUE (organization_id, extraction_run_id, id),
  CONSTRAINT extraction_page_artifacts_page_unique UNIQUE (organization_id, extraction_run_id, page),
  CONSTRAINT extraction_page_artifacts_run_source_fkey
    FOREIGN KEY (organization_id, extraction_run_id, source_artifact_id)
    REFERENCES public.extraction_runs(organization_id, id, source_artifact_id)
    ON DELETE RESTRICT,
  CONSTRAINT extraction_page_artifacts_source_fkey
    FOREIGN KEY (organization_id, source_artifact_id)
    REFERENCES public.extraction_source_artifacts(organization_id, id)
    ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS public.extraction_fragment_artifacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  extraction_run_id uuid NOT NULL,
  source_artifact_id uuid NOT NULL,
  page_artifact_id uuid NOT NULL,
  source_document_id uuid NOT NULL REFERENCES public.documents(id) ON DELETE RESTRICT,
  source_sha256 text NOT NULL CONSTRAINT extraction_fragment_artifacts_sha256_check
    CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
  parser_manifest_hash text NOT NULL CONSTRAINT extraction_fragment_artifacts_manifest_hash_check
    CHECK (parser_manifest_hash ~ '^[0-9a-f]{64}$'),
  kind text NOT NULL CONSTRAINT extraction_fragment_artifacts_kind_check
    CHECK (kind IN ('token', 'cell', 'region', 'layout_signal', 'arbitration')),
  page integer NOT NULL CONSTRAINT extraction_fragment_artifacts_page_check CHECK (page > 0),
  bbox_x0 double precision NOT NULL,
  bbox_y0 double precision NOT NULL,
  bbox_x1 double precision NOT NULL,
  bbox_y1 double precision NOT NULL,
  bbox_rotation integer NOT NULL DEFAULT 0,
  raw_text text NOT NULL,
  parser jsonb NOT NULL CONSTRAINT extraction_fragment_artifacts_parser_check
    CHECK (jsonb_typeof(parser) = 'object'),
  recognition_confidence double precision,
  reading_order integer NOT NULL CONSTRAINT extraction_fragment_artifacts_reading_order_check
    CHECK (reading_order >= 0),
  artifact_data jsonb NOT NULL DEFAULT '{}'::jsonb
    CONSTRAINT extraction_fragment_artifacts_data_check CHECK (jsonb_typeof(artifact_data) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT extraction_fragment_artifacts_bbox_check CHECK (
    bbox_x0 >= 0 AND bbox_y0 >= 0 AND bbox_x1 <= 1 AND bbox_y1 <= 1
    AND bbox_x0 < bbox_x1 AND bbox_y0 < bbox_y1
    AND bbox_rotation IN (0, 90, 180, 270)
  ),
  CONSTRAINT extraction_fragment_artifacts_confidence_check
    CHECK (recognition_confidence IS NULL OR recognition_confidence BETWEEN 0 AND 1),
  CONSTRAINT extraction_fragment_artifacts_org_id_unique UNIQUE (organization_id, id),
  CONSTRAINT extraction_fragment_artifacts_org_run_id_unique
    UNIQUE (organization_id, extraction_run_id, id),
  CONSTRAINT extraction_fragment_artifacts_run_source_fkey
    FOREIGN KEY (organization_id, extraction_run_id, source_artifact_id)
    REFERENCES public.extraction_runs(organization_id, id, source_artifact_id)
    ON DELETE RESTRICT,
  CONSTRAINT extraction_fragment_artifacts_page_fkey
    FOREIGN KEY (organization_id, extraction_run_id, page_artifact_id)
    REFERENCES public.extraction_page_artifacts(organization_id, extraction_run_id, id)
    ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS public.extraction_fragment_dependencies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  extraction_run_id uuid NOT NULL,
  fragment_artifact_id uuid NOT NULL,
  dependency_fragment_artifact_id uuid NOT NULL,
  sequence integer NOT NULL CONSTRAINT extraction_fragment_dependencies_sequence_check CHECK (sequence > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT extraction_fragment_dependencies_org_id_unique UNIQUE (organization_id, id),
  CONSTRAINT extraction_fragment_dependencies_sequence_unique
    UNIQUE (organization_id, extraction_run_id, fragment_artifact_id, sequence),
  CONSTRAINT extraction_fragment_dependencies_edge_unique
    UNIQUE (organization_id, extraction_run_id, fragment_artifact_id, dependency_fragment_artifact_id),
  CONSTRAINT extraction_fragment_dependencies_fragment_fkey
    FOREIGN KEY (organization_id, extraction_run_id, fragment_artifact_id)
    REFERENCES public.extraction_fragment_artifacts(organization_id, extraction_run_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT extraction_fragment_dependencies_source_fkey
    FOREIGN KEY (organization_id, extraction_run_id, dependency_fragment_artifact_id)
    REFERENCES public.extraction_fragment_artifacts(organization_id, extraction_run_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT extraction_fragment_dependencies_no_self_check
    CHECK (fragment_artifact_id <> dependency_fragment_artifact_id)
);

CREATE TABLE IF NOT EXISTS public.extraction_field_candidates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  extraction_run_id uuid NOT NULL,
  source_artifact_id uuid NOT NULL,
  source_document_id uuid NOT NULL REFERENCES public.documents(id) ON DELETE RESTRICT,
  source_sha256 text NOT NULL CONSTRAINT extraction_field_candidates_sha256_check
    CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
  parser_manifest_hash text NOT NULL CONSTRAINT extraction_field_candidates_manifest_hash_check
    CHECK (parser_manifest_hash ~ '^[0-9a-f]{64}$'),
  raw_text text NOT NULL,
  primitive_kind text NOT NULL CONSTRAINT extraction_field_candidates_primitive_kind_check
    CHECK (primitive_kind IN ('text', 'decimal', 'date', 'boolean')),
  proposed_value jsonb NOT NULL CONSTRAINT extraction_field_candidates_value_check
    CHECK (
      jsonb_typeof(proposed_value) = 'object'
      AND proposed_value->>'type' = primitive_kind
      AND proposed_value ? 'value'
    ),
  transformations jsonb NOT NULL DEFAULT '[]'::jsonb
    CONSTRAINT extraction_field_candidates_transformations_check
    CHECK (jsonb_typeof(transformations) = 'array'),
  parser jsonb NOT NULL CONSTRAINT extraction_field_candidates_parser_check
    CHECK (jsonb_typeof(parser) = 'object'),
  confidence jsonb NOT NULL CONSTRAINT extraction_field_candidates_confidence_check
    CHECK (jsonb_typeof(confidence) = 'object'),
  status text NOT NULL CONSTRAINT extraction_field_candidates_status_check
    CHECK (status IN ('candidate', 'rejected', 'ambiguous')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT extraction_field_candidates_org_id_unique UNIQUE (organization_id, id),
  CONSTRAINT extraction_field_candidates_org_run_id_unique UNIQUE (organization_id, extraction_run_id, id),
  CONSTRAINT extraction_field_candidates_run_source_fkey
    FOREIGN KEY (organization_id, extraction_run_id, source_artifact_id)
    REFERENCES public.extraction_runs(organization_id, id, source_artifact_id)
    ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS public.extraction_field_candidate_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  extraction_run_id uuid NOT NULL,
  field_candidate_id uuid NOT NULL,
  fragment_artifact_id uuid NOT NULL,
  sequence integer NOT NULL CONSTRAINT extraction_field_candidate_sources_sequence_check CHECK (sequence > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT extraction_field_candidate_sources_org_id_unique UNIQUE (organization_id, id),
  CONSTRAINT extraction_field_candidate_sources_sequence_unique
    UNIQUE (organization_id, extraction_run_id, field_candidate_id, sequence),
  CONSTRAINT extraction_field_candidate_sources_edge_unique
    UNIQUE (organization_id, extraction_run_id, field_candidate_id, fragment_artifact_id),
  CONSTRAINT extraction_field_candidate_sources_candidate_fkey
    FOREIGN KEY (organization_id, extraction_run_id, field_candidate_id)
    REFERENCES public.extraction_field_candidates(organization_id, extraction_run_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT extraction_field_candidate_sources_fragment_fkey
    FOREIGN KEY (organization_id, extraction_run_id, fragment_artifact_id)
    REFERENCES public.extraction_fragment_artifacts(organization_id, extraction_run_id, id)
    ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS public.extraction_verified_fields (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  extraction_run_id uuid NOT NULL,
  source_artifact_id uuid NOT NULL,
  source_document_id uuid NOT NULL REFERENCES public.documents(id) ON DELETE RESTRICT,
  source_sha256 text NOT NULL CONSTRAINT extraction_verified_fields_sha256_check
    CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
  parser_manifest_hash text NOT NULL CONSTRAINT extraction_verified_fields_manifest_hash_check
    CHECK (parser_manifest_hash ~ '^[0-9a-f]{64}$'),
  candidate_id uuid NOT NULL,
  raw_text text NOT NULL,
  normalized_value jsonb NOT NULL CONSTRAINT extraction_verified_fields_value_check
    CHECK (
      jsonb_typeof(normalized_value) = 'object'
      AND normalized_value->>'type' IN ('text', 'decimal', 'date', 'boolean')
      AND normalized_value ? 'value'
    ),
  transformations jsonb NOT NULL DEFAULT '[]'::jsonb
    CONSTRAINT extraction_verified_fields_transformations_check
    CHECK (jsonb_typeof(transformations) = 'array'),
  verifier jsonb NOT NULL CONSTRAINT extraction_verified_fields_verifier_check
    CHECK (jsonb_typeof(verifier) = 'object'),
  confidence jsonb NOT NULL CONSTRAINT extraction_verified_fields_confidence_check
    CHECK (jsonb_typeof(confidence) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT extraction_verified_fields_org_id_unique UNIQUE (organization_id, id),
  CONSTRAINT extraction_verified_fields_org_run_id_unique UNIQUE (organization_id, extraction_run_id, id),
  CONSTRAINT extraction_verified_fields_candidate_unique UNIQUE (organization_id, extraction_run_id, candidate_id),
  CONSTRAINT extraction_verified_fields_run_source_fkey
    FOREIGN KEY (organization_id, extraction_run_id, source_artifact_id)
    REFERENCES public.extraction_runs(organization_id, id, source_artifact_id)
    ON DELETE RESTRICT,
  CONSTRAINT extraction_verified_fields_candidate_fkey
    FOREIGN KEY (organization_id, extraction_run_id, candidate_id)
    REFERENCES public.extraction_field_candidates(organization_id, extraction_run_id, id)
    ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS public.extraction_verified_field_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  extraction_run_id uuid NOT NULL,
  verified_field_id uuid NOT NULL,
  fragment_artifact_id uuid NOT NULL,
  sequence integer NOT NULL CONSTRAINT extraction_verified_field_sources_sequence_check CHECK (sequence > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT extraction_verified_field_sources_org_id_unique UNIQUE (organization_id, id),
  CONSTRAINT extraction_verified_field_sources_sequence_unique
    UNIQUE (organization_id, extraction_run_id, verified_field_id, sequence),
  CONSTRAINT extraction_verified_field_sources_edge_unique
    UNIQUE (organization_id, extraction_run_id, verified_field_id, fragment_artifact_id),
  CONSTRAINT extraction_verified_field_sources_verified_fkey
    FOREIGN KEY (organization_id, extraction_run_id, verified_field_id)
    REFERENCES public.extraction_verified_fields(organization_id, extraction_run_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT extraction_verified_field_sources_fragment_fkey
    FOREIGN KEY (organization_id, extraction_run_id, fragment_artifact_id)
    REFERENCES public.extraction_fragment_artifacts(organization_id, extraction_run_id, id)
    ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS public.extraction_processing_gaps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  extraction_run_id uuid NOT NULL,
  source_artifact_id uuid NOT NULL,
  source_document_id uuid NOT NULL REFERENCES public.documents(id) ON DELETE RESTRICT,
  gap_key text NOT NULL CONSTRAINT extraction_processing_gaps_key_check CHECK (btrim(gap_key) <> ''),
  page integer CONSTRAINT extraction_processing_gaps_page_check CHECK (page IS NULL OR page > 0),
  bbox_x0 double precision,
  bbox_y0 double precision,
  bbox_x1 double precision,
  bbox_y1 double precision,
  bbox_rotation integer,
  stage text NOT NULL CONSTRAINT extraction_processing_gaps_stage_check CHECK (
    stage IN (
      'source_download', 'source_ingest', 'page_render', 'native_text', 'ocr',
      'vision', 'partition', 'layout', 'region_arbitration',
      'table_reconstruction', 'primitive_parse', 'field_verification',
      'interpretation', 'canonical_interpretation', 'persistence'
    )
  ),
  reason text NOT NULL CONSTRAINT extraction_processing_gaps_reason_check CHECK (
    reason IN (
      'timeout', 'engine_failure', 'unsupported_size', 'unprocessed_region',
      'engine_conflict', 'missing_geometry'
    )
  ),
  retryable boolean NOT NULL,
  attempts integer NOT NULL CONSTRAINT extraction_processing_gaps_attempts_check CHECK (attempts >= 0),
  detail text NOT NULL CONSTRAINT extraction_processing_gaps_detail_check CHECK (btrim(detail) <> ''),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT extraction_processing_gaps_bbox_check CHECK (
    (bbox_x0 IS NULL AND bbox_y0 IS NULL AND bbox_x1 IS NULL AND bbox_y1 IS NULL AND bbox_rotation IS NULL)
    OR
    (bbox_x0 >= 0 AND bbox_y0 >= 0 AND bbox_x1 <= 1 AND bbox_y1 <= 1
      AND bbox_x0 < bbox_x1 AND bbox_y0 < bbox_y1
      AND bbox_rotation IN (0, 90, 180, 270))
  ),
  CONSTRAINT extraction_processing_gaps_org_id_unique UNIQUE (organization_id, id),
  CONSTRAINT extraction_processing_gaps_idempotency_unique
    UNIQUE (organization_id, extraction_run_id, gap_key),
  CONSTRAINT extraction_processing_gaps_org_run_id_unique UNIQUE (organization_id, extraction_run_id, id),
  CONSTRAINT extraction_processing_gaps_run_source_fkey
    FOREIGN KEY (organization_id, extraction_run_id, source_artifact_id)
    REFERENCES public.extraction_runs(organization_id, id, source_artifact_id)
    ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS public.extraction_gap_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  extraction_run_id uuid NOT NULL,
  processing_gap_id uuid NOT NULL,
  fragment_artifact_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT extraction_gap_sources_org_id_unique UNIQUE (organization_id, id),
  CONSTRAINT extraction_gap_sources_edge_unique
    UNIQUE (organization_id, extraction_run_id, processing_gap_id, fragment_artifact_id),
  CONSTRAINT extraction_gap_sources_gap_fkey
    FOREIGN KEY (organization_id, extraction_run_id, processing_gap_id)
    REFERENCES public.extraction_processing_gaps(organization_id, extraction_run_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT extraction_gap_sources_fragment_fkey
    FOREIGN KEY (organization_id, extraction_run_id, fragment_artifact_id)
    REFERENCES public.extraction_fragment_artifacts(organization_id, extraction_run_id, id)
    ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS public.extraction_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  source_document_id uuid NOT NULL REFERENCES public.documents(id) ON DELETE RESTRICT,
  source_artifact_id uuid NOT NULL,
  source_sha256 text NOT NULL CONSTRAINT extraction_snapshots_sha256_check
    CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
  parser_manifest_hash text NOT NULL CONSTRAINT extraction_snapshots_manifest_hash_check
    CHECK (parser_manifest_hash ~ '^[0-9a-f]{64}$'),
  artifact_schema_version text NOT NULL CONSTRAINT extraction_snapshots_schema_version_check
    CHECK (btrim(artifact_schema_version) <> ''),
  producing_run_id uuid NOT NULL,
  status text NOT NULL CONSTRAINT extraction_snapshots_status_check CHECK (status IN ('complete', 'partial')),
  content_extraction_fingerprint text NOT NULL
    CONSTRAINT extraction_snapshots_fingerprint_check CHECK (content_extraction_fingerprint ~ '^[0-9a-f]{64}$'),
  artifact_root_hash text NOT NULL
    CONSTRAINT extraction_snapshots_root_hash_check CHECK (artifact_root_hash ~ '^[0-9a-f]{64}$'),
  published_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT extraction_snapshots_org_id_unique UNIQUE (organization_id, id),
  CONSTRAINT extraction_snapshots_semantic_unique UNIQUE (
    organization_id, source_document_id, source_artifact_id,
    parser_manifest_hash, artifact_schema_version
  ),
  CONSTRAINT extraction_snapshots_source_fkey
    FOREIGN KEY (organization_id, source_artifact_id)
    REFERENCES public.extraction_source_artifacts(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT extraction_snapshots_run_source_fkey
    FOREIGN KEY (organization_id, producing_run_id, source_artifact_id)
    REFERENCES public.extraction_runs(organization_id, id, source_artifact_id)
    ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS public.extraction_snapshot_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  extraction_snapshot_id uuid NOT NULL,
  member_kind text NOT NULL CONSTRAINT extraction_snapshot_members_kind_check
    CHECK (member_kind IN ('page', 'fragment', 'candidate', 'verified_field', 'gap')),
  page_artifact_id uuid,
  fragment_artifact_id uuid,
  field_candidate_id uuid,
  verified_field_id uuid,
  processing_gap_id uuid,
  dependency_hash text NOT NULL CONSTRAINT extraction_snapshot_members_hash_check
    CHECK (dependency_hash ~ '^[0-9a-f]{64}$'),
  sequence integer NOT NULL CONSTRAINT extraction_snapshot_members_sequence_check CHECK (sequence > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT extraction_snapshot_members_one_target_check CHECK (
    (member_kind = 'page' AND page_artifact_id IS NOT NULL
      AND num_nonnulls(fragment_artifact_id, field_candidate_id, verified_field_id, processing_gap_id) = 0)
    OR (member_kind = 'fragment' AND fragment_artifact_id IS NOT NULL
      AND num_nonnulls(page_artifact_id, field_candidate_id, verified_field_id, processing_gap_id) = 0)
    OR (member_kind = 'candidate' AND field_candidate_id IS NOT NULL
      AND num_nonnulls(page_artifact_id, fragment_artifact_id, verified_field_id, processing_gap_id) = 0)
    OR (member_kind = 'verified_field' AND verified_field_id IS NOT NULL
      AND num_nonnulls(page_artifact_id, fragment_artifact_id, field_candidate_id, processing_gap_id) = 0)
    OR (member_kind = 'gap' AND processing_gap_id IS NOT NULL
      AND num_nonnulls(page_artifact_id, fragment_artifact_id, field_candidate_id, verified_field_id) = 0)
  ),
  CONSTRAINT extraction_snapshot_members_org_id_unique UNIQUE (organization_id, id),
  CONSTRAINT extraction_snapshot_members_sequence_unique
    UNIQUE (organization_id, extraction_snapshot_id, sequence),
  CONSTRAINT extraction_snapshot_members_snapshot_fkey
    FOREIGN KEY (organization_id, extraction_snapshot_id)
    REFERENCES public.extraction_snapshots(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT extraction_snapshot_members_page_fkey
    FOREIGN KEY (organization_id, page_artifact_id)
    REFERENCES public.extraction_page_artifacts(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT extraction_snapshot_members_fragment_fkey
    FOREIGN KEY (organization_id, fragment_artifact_id)
    REFERENCES public.extraction_fragment_artifacts(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT extraction_snapshot_members_candidate_fkey
    FOREIGN KEY (organization_id, field_candidate_id)
    REFERENCES public.extraction_field_candidates(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT extraction_snapshot_members_verified_fkey
    FOREIGN KEY (organization_id, verified_field_id)
    REFERENCES public.extraction_verified_fields(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT extraction_snapshot_members_gap_fkey
    FOREIGN KEY (organization_id, processing_gap_id)
    REFERENCES public.extraction_processing_gaps(organization_id, id)
    ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS public.canonical_document_facts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  source_document_id uuid NOT NULL REFERENCES public.documents(id) ON DELETE RESTRICT,
  extraction_snapshot_id uuid NOT NULL,
  extraction_run_id uuid NOT NULL,
  fact_key text NOT NULL CONSTRAINT canonical_document_facts_key_check CHECK (btrim(fact_key) <> ''),
  normalized_value jsonb NOT NULL CONSTRAINT canonical_document_facts_value_check
    CHECK (
      jsonb_typeof(normalized_value) = 'object'
      AND normalized_value->>'type' IN ('text', 'decimal', 'date', 'boolean')
      AND normalized_value ? 'value'
    ),
  primary_verified_field_id uuid NOT NULL,
  interpretation_rule_id text NOT NULL CONSTRAINT canonical_document_facts_rule_id_check
    CHECK (btrim(interpretation_rule_id) <> ''),
  interpretation_rule_version text NOT NULL CONSTRAINT canonical_document_facts_rule_version_check
    CHECK (btrim(interpretation_rule_version) <> ''),
  confidence jsonb NOT NULL CONSTRAINT canonical_document_facts_confidence_check
    CHECK (jsonb_typeof(confidence) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT canonical_document_facts_org_id_unique UNIQUE (organization_id, id),
  CONSTRAINT canonical_document_facts_snapshot_fkey
    FOREIGN KEY (organization_id, extraction_snapshot_id)
    REFERENCES public.extraction_snapshots(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT canonical_document_facts_primary_verified_fkey
    FOREIGN KEY (organization_id, extraction_run_id, primary_verified_field_id)
    REFERENCES public.extraction_verified_fields(organization_id, extraction_run_id, id)
    ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS public.canonical_document_fact_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  canonical_fact_id uuid NOT NULL,
  extraction_run_id uuid NOT NULL,
  verified_field_id uuid NOT NULL,
  is_primary boolean NOT NULL DEFAULT false,
  sequence integer NOT NULL CONSTRAINT canonical_document_fact_sources_sequence_check CHECK (sequence > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT canonical_document_fact_sources_org_id_unique UNIQUE (organization_id, id),
  CONSTRAINT canonical_document_fact_sources_sequence_unique
    UNIQUE (organization_id, canonical_fact_id, sequence),
  CONSTRAINT canonical_document_fact_sources_edge_unique
    UNIQUE (organization_id, canonical_fact_id, verified_field_id),
  CONSTRAINT canonical_document_fact_sources_fact_fkey
    FOREIGN KEY (organization_id, canonical_fact_id)
    REFERENCES public.canonical_document_facts(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT canonical_document_fact_sources_verified_fkey
    FOREIGN KEY (organization_id, extraction_run_id, verified_field_id)
    REFERENCES public.extraction_verified_fields(organization_id, extraction_run_id, id)
    ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS public.derived_document_facts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  source_document_id uuid REFERENCES public.documents(id) ON DELETE RESTRICT,
  fact_key text NOT NULL CONSTRAINT derived_document_facts_key_check CHECK (btrim(fact_key) <> ''),
  derived_value jsonb NOT NULL CONSTRAINT derived_document_facts_value_check CHECK (jsonb_typeof(derived_value) = 'object'),
  rule_id text NOT NULL CONSTRAINT derived_document_facts_rule_id_check CHECK (btrim(rule_id) <> ''),
  rule_version text NOT NULL CONSTRAINT derived_document_facts_rule_version_check CHECK (btrim(rule_version) <> ''),
  calculation_trace jsonb NOT NULL DEFAULT '[]'::jsonb
    CONSTRAINT derived_document_facts_trace_check CHECK (jsonb_typeof(calculation_trace) = 'array'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT derived_document_facts_org_id_unique UNIQUE (organization_id, id)
);

CREATE TABLE IF NOT EXISTS public.human_fact_assertions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  source_document_id uuid REFERENCES public.documents(id) ON DELETE RESTRICT,
  fact_key text NOT NULL CONSTRAINT human_fact_assertions_key_check CHECK (btrim(fact_key) <> ''),
  asserted_value jsonb,
  target_machine_fact_id uuid,
  target_verified_field_id uuid,
  source_binding text NOT NULL CONSTRAINT human_fact_assertions_binding_check
    CHECK (source_binding IN ('source_bound', 'domain_assertion')),
  supersedes_assertion_id uuid,
  actor_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  reason text NOT NULL CONSTRAINT human_fact_assertions_reason_check CHECK (btrim(reason) <> ''),
  asserted_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL CONSTRAINT human_fact_assertions_status_check
    CHECK (status IN ('active', 'superseded', 'needs_review')),
  CONSTRAINT human_fact_assertions_source_target_check CHECK (
    source_binding = 'domain_assertion'
    OR num_nonnulls(target_machine_fact_id, target_verified_field_id) >= 1
  ),
  CONSTRAINT human_fact_assertions_org_id_unique UNIQUE (organization_id, id),
  CONSTRAINT human_fact_assertions_machine_fkey
    FOREIGN KEY (organization_id, target_machine_fact_id)
    REFERENCES public.canonical_document_facts(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT human_fact_assertions_verified_fkey
    FOREIGN KEY (organization_id, target_verified_field_id)
    REFERENCES public.extraction_verified_fields(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT human_fact_assertions_supersedes_fkey
    FOREIGN KEY (organization_id, supersedes_assertion_id)
    REFERENCES public.human_fact_assertions(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT human_fact_assertions_no_self_supersede_check
    CHECK (supersedes_assertion_id IS NULL OR supersedes_assertion_id <> id)
);

CREATE TABLE IF NOT EXISTS public.derived_document_fact_dependencies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  derived_fact_id uuid NOT NULL,
  canonical_fact_id uuid,
  input_derived_fact_id uuid,
  human_assertion_id uuid,
  sequence integer NOT NULL CONSTRAINT derived_document_fact_dependencies_sequence_check CHECK (sequence > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT derived_document_fact_dependencies_one_target_check
    CHECK (num_nonnulls(canonical_fact_id, input_derived_fact_id, human_assertion_id) = 1),
  CONSTRAINT derived_document_fact_dependencies_org_id_unique UNIQUE (organization_id, id),
  CONSTRAINT derived_document_fact_dependencies_sequence_unique
    UNIQUE (organization_id, derived_fact_id, sequence),
  CONSTRAINT derived_document_fact_dependencies_derived_fkey
    FOREIGN KEY (organization_id, derived_fact_id)
    REFERENCES public.derived_document_facts(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT derived_document_fact_dependencies_canonical_fkey
    FOREIGN KEY (organization_id, canonical_fact_id)
    REFERENCES public.canonical_document_facts(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT derived_document_fact_dependencies_input_derived_fkey
    FOREIGN KEY (organization_id, input_derived_fact_id)
    REFERENCES public.derived_document_facts(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT derived_document_fact_dependencies_human_fkey
    FOREIGN KEY (organization_id, human_assertion_id)
    REFERENCES public.human_fact_assertions(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT derived_document_fact_dependencies_no_self_check
    CHECK (input_derived_fact_id IS NULL OR input_derived_fact_id <> derived_fact_id)
);

CREATE TABLE IF NOT EXISTS public.document_interpretation_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  source_document_id uuid NOT NULL REFERENCES public.documents(id) ON DELETE RESTRICT,
  extraction_snapshot_id uuid NOT NULL,
  interpreter_manifest_hash text NOT NULL CONSTRAINT document_interpretation_snapshots_manifest_check
    CHECK (interpreter_manifest_hash ~ '^[0-9a-f]{64}$'),
  entity_resolver_version text NOT NULL CONSTRAINT document_interpretation_snapshots_resolver_check
    CHECK (btrim(entity_resolver_version) <> ''),
  effective_truth_set_hash text NOT NULL CONSTRAINT document_interpretation_snapshots_truth_hash_check
    CHECK (effective_truth_set_hash ~ '^[0-9a-f]{64}$'),
  status text NOT NULL CONSTRAINT document_interpretation_snapshots_status_check
    CHECK (status IN ('complete', 'partial', 'blocked')),
  output_root_hash text NOT NULL CONSTRAINT document_interpretation_snapshots_root_hash_check
    CHECK (output_root_hash ~ '^[0-9a-f]{64}$'),
  published_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT document_interpretation_snapshots_org_id_unique UNIQUE (organization_id, id),
  CONSTRAINT document_interpretation_snapshots_identity_unique
    UNIQUE (organization_id, extraction_snapshot_id, interpreter_manifest_hash, entity_resolver_version),
  CONSTRAINT document_interpretation_snapshots_extraction_fkey
    FOREIGN KEY (organization_id, extraction_snapshot_id)
    REFERENCES public.extraction_snapshots(organization_id, id)
    ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS public.document_interpretation_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  interpretation_snapshot_id uuid NOT NULL,
  record_type text NOT NULL CONSTRAINT document_interpretation_records_type_check
    CHECK (record_type IN ('canonical_fact', 'derived_fact', 'human_assertion', 'ambiguity', 'gap')),
  canonical_fact_id uuid,
  derived_fact_id uuid,
  human_assertion_id uuid,
  processing_gap_id uuid,
  record_data jsonb NOT NULL DEFAULT '{}'::jsonb
    CONSTRAINT document_interpretation_records_data_check CHECK (jsonb_typeof(record_data) = 'object'),
  sequence integer NOT NULL CONSTRAINT document_interpretation_records_sequence_check CHECK (sequence > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT document_interpretation_records_target_check CHECK (
    (record_type = 'ambiguity' AND num_nonnulls(canonical_fact_id, derived_fact_id, human_assertion_id, processing_gap_id) = 0)
    OR (record_type = 'canonical_fact' AND canonical_fact_id IS NOT NULL
      AND num_nonnulls(derived_fact_id, human_assertion_id, processing_gap_id) = 0)
    OR (record_type = 'derived_fact' AND derived_fact_id IS NOT NULL
      AND num_nonnulls(canonical_fact_id, human_assertion_id, processing_gap_id) = 0)
    OR (record_type = 'human_assertion' AND human_assertion_id IS NOT NULL
      AND num_nonnulls(canonical_fact_id, derived_fact_id, processing_gap_id) = 0)
    OR (record_type = 'gap' AND processing_gap_id IS NOT NULL
      AND num_nonnulls(canonical_fact_id, derived_fact_id, human_assertion_id) = 0)
  ),
  CONSTRAINT document_interpretation_records_org_id_unique UNIQUE (organization_id, id),
  CONSTRAINT document_interpretation_records_sequence_unique
    UNIQUE (organization_id, interpretation_snapshot_id, sequence),
  CONSTRAINT document_interpretation_records_snapshot_fkey
    FOREIGN KEY (organization_id, interpretation_snapshot_id)
    REFERENCES public.document_interpretation_snapshots(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT document_interpretation_records_canonical_fkey
    FOREIGN KEY (organization_id, canonical_fact_id)
    REFERENCES public.canonical_document_facts(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT document_interpretation_records_derived_fkey
    FOREIGN KEY (organization_id, derived_fact_id)
    REFERENCES public.derived_document_facts(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT document_interpretation_records_human_fkey
    FOREIGN KEY (organization_id, human_assertion_id)
    REFERENCES public.human_fact_assertions(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT document_interpretation_records_gap_fkey
    FOREIGN KEY (organization_id, processing_gap_id)
    REFERENCES public.extraction_processing_gaps(organization_id, id)
    ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS public.entity_resolution_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  interpretation_snapshot_id uuid NOT NULL,
  resolver_version text NOT NULL CONSTRAINT entity_resolution_runs_resolver_check CHECK (btrim(resolver_version) <> ''),
  registry_version text NOT NULL CONSTRAINT entity_resolution_runs_registry_check CHECK (btrim(registry_version) <> ''),
  status text NOT NULL CONSTRAINT entity_resolution_runs_status_check
    CHECK (status IN ('complete', 'partial', 'failed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT entity_resolution_runs_org_id_unique UNIQUE (organization_id, id),
  CONSTRAINT entity_resolution_runs_snapshot_fkey
    FOREIGN KEY (organization_id, interpretation_snapshot_id)
    REFERENCES public.document_interpretation_snapshots(organization_id, id)
    ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS public.entity_resolutions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  entity_resolution_run_id uuid NOT NULL,
  observed_verified_field_id uuid NOT NULL,
  observed_value text NOT NULL,
  entity_type text NOT NULL CONSTRAINT entity_resolutions_type_check CHECK (entity_type IN ('vendor', 'contractor')),
  canonical_entity_id uuid,
  canonical_display_name text,
  candidates jsonb NOT NULL DEFAULT '[]'::jsonb
    CONSTRAINT entity_resolutions_candidates_check CHECK (jsonb_typeof(candidates) = 'array'),
  status text NOT NULL CONSTRAINT entity_resolutions_status_check
    CHECK (status IN ('resolved', 'ambiguous', 'unresolved')),
  confidence jsonb NOT NULL CONSTRAINT entity_resolutions_confidence_check CHECK (jsonb_typeof(confidence) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT entity_resolutions_resolved_target_check CHECK (
    (status = 'resolved' AND canonical_entity_id IS NOT NULL AND canonical_display_name IS NOT NULL)
    OR (status <> 'resolved' AND canonical_entity_id IS NULL)
  ),
  CONSTRAINT entity_resolutions_org_id_unique UNIQUE (organization_id, id),
  CONSTRAINT entity_resolutions_run_fkey
    FOREIGN KEY (organization_id, entity_resolution_run_id)
    REFERENCES public.entity_resolution_runs(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT entity_resolutions_verified_fkey
    FOREIGN KEY (organization_id, observed_verified_field_id)
    REFERENCES public.extraction_verified_fields(organization_id, id)
    ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS public.extraction_snapshot_invalidations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  extraction_snapshot_id uuid NOT NULL,
  reason text NOT NULL CONSTRAINT extraction_snapshot_invalidations_reason_check CHECK (btrim(reason) <> ''),
  invalidated_by uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
  invalidated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT extraction_snapshot_invalidations_org_id_unique UNIQUE (organization_id, id),
  CONSTRAINT extraction_snapshot_invalidations_snapshot_fkey
    FOREIGN KEY (organization_id, extraction_snapshot_id)
    REFERENCES public.extraction_snapshots(organization_id, id)
    ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS public.extraction_replay_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  source_document_id uuid NOT NULL REFERENCES public.documents(id) ON DELETE RESTRICT,
  source_artifact_id uuid NOT NULL,
  desired_parser_manifest_hash text NOT NULL CONSTRAINT extraction_replay_requests_manifest_check
    CHECK (desired_parser_manifest_hash ~ '^[0-9a-f]{64}$'),
  artifact_schema_version text NOT NULL CONSTRAINT extraction_replay_requests_schema_check
    CHECK (btrim(artifact_schema_version) <> ''),
  idempotency_key text NOT NULL CONSTRAINT extraction_replay_requests_key_check CHECK (btrim(idempotency_key) <> ''),
  requested_by uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
  requested_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT extraction_replay_requests_org_id_unique UNIQUE (organization_id, id),
  CONSTRAINT extraction_replay_requests_idempotency_unique UNIQUE (organization_id, idempotency_key),
  CONSTRAINT extraction_replay_requests_source_fkey
    FOREIGN KEY (organization_id, source_artifact_id)
    REFERENCES public.extraction_source_artifacts(organization_id, id)
    ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS public.document_extraction_snapshot_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  source_document_id uuid NOT NULL REFERENCES public.documents(id) ON DELETE RESTRICT,
  source_artifact_id uuid NOT NULL,
  desired_parser_manifest_hash text NOT NULL CONSTRAINT document_extraction_assignments_manifest_check
    CHECK (desired_parser_manifest_hash ~ '^[0-9a-f]{64}$'),
  artifact_schema_version text NOT NULL CONSTRAINT document_extraction_assignments_schema_check
    CHECK (btrim(artifact_schema_version) <> ''),
  extraction_snapshot_id uuid,
  activation_mode text NOT NULL DEFAULT 'shadow' CONSTRAINT document_extraction_assignments_mode_check
    CHECK (activation_mode IN ('shadow', 'fresh_only')),
  assigned_at timestamptz NOT NULL DEFAULT now(),
  assigned_by uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
  CONSTRAINT document_extraction_assignments_org_id_unique UNIQUE (organization_id, id),
  CONSTRAINT document_extraction_assignments_document_unique UNIQUE (organization_id, source_document_id),
  CONSTRAINT document_extraction_assignments_source_fkey
    FOREIGN KEY (organization_id, source_artifact_id)
    REFERENCES public.extraction_source_artifacts(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT document_extraction_assignments_snapshot_fkey
    FOREIGN KEY (organization_id, extraction_snapshot_id)
    REFERENCES public.extraction_snapshots(organization_id, id)
    ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS public.document_projection_stamps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  source_document_id uuid NOT NULL REFERENCES public.documents(id) ON DELETE RESTRICT,
  projection_kind text NOT NULL CONSTRAINT document_projection_stamps_kind_check
    CHECK (projection_kind IN (
      'document_extraction', 'normalized_extraction', 'contract_analysis',
      'intelligence_trace', 'project_summary', 'step0_shadow'
    )),
  projection_record_id text NOT NULL CONSTRAINT document_projection_stamps_record_check
    CHECK (btrim(projection_record_id) <> ''),
  source_artifact_id uuid NOT NULL,
  source_sha256 text NOT NULL CONSTRAINT document_projection_stamps_sha256_check
    CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
  extraction_snapshot_id uuid NOT NULL,
  parser_manifest_hash text NOT NULL CONSTRAINT document_projection_stamps_manifest_check
    CHECK (parser_manifest_hash ~ '^[0-9a-f]{64}$'),
  interpretation_snapshot_id uuid NOT NULL,
  projection_schema_version text NOT NULL CONSTRAINT document_projection_stamps_schema_check
    CHECK (btrim(projection_schema_version) <> ''),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT document_projection_stamps_org_id_unique UNIQUE (organization_id, id),
  CONSTRAINT document_projection_stamps_projection_unique
    UNIQUE (organization_id, projection_kind, projection_record_id),
  CONSTRAINT document_projection_stamps_source_fkey
    FOREIGN KEY (organization_id, source_artifact_id)
    REFERENCES public.extraction_source_artifacts(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT document_projection_stamps_extraction_fkey
    FOREIGN KEY (organization_id, extraction_snapshot_id)
    REFERENCES public.extraction_snapshots(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT document_projection_stamps_interpretation_fkey
    FOREIGN KEY (organization_id, interpretation_snapshot_id)
    REFERENCES public.document_interpretation_snapshots(organization_id, id)
    ON DELETE RESTRICT
);

-- Repeated provenance columns are deliberate query aids, but they are never
-- independent truth. This trigger binds every repeated value to the source/run
-- chain and prevents cross-run snapshot or projection DAGs.
CREATE OR REPLACE FUNCTION public.enforce_extraction_provenance_integrity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  source_row public.extraction_source_artifacts%ROWTYPE;
  run_row public.extraction_runs%ROWTYPE;
  snapshot_row public.extraction_snapshots%ROWTYPE;
  verified_row public.extraction_verified_fields%ROWTYPE;
  candidate_row public.extraction_field_candidates%ROWTYPE;
  interpretation_row public.document_interpretation_snapshots%ROWTYPE;
  target_run_id uuid;
BEGIN
  IF TG_TABLE_NAME IN (
    'extraction_page_artifacts', 'extraction_fragment_artifacts',
    'extraction_field_candidates', 'extraction_verified_fields'
  ) THEN
    SELECT * INTO source_row FROM public.extraction_source_artifacts
      WHERE organization_id = NEW.organization_id AND id = NEW.source_artifact_id;
    SELECT * INTO run_row FROM public.extraction_runs
      WHERE organization_id = NEW.organization_id AND id = NEW.extraction_run_id;
    IF source_row.id IS NULL OR run_row.id IS NULL
      OR run_row.source_artifact_id <> source_row.id
      OR NEW.source_document_id <> source_row.source_document_id
      OR NEW.source_sha256 <> source_row.source_sha256
      OR NEW.parser_manifest_hash <> run_row.parser_manifest_hash THEN
      RAISE EXCEPTION '% provenance does not close to one source/run/manifest', TG_TABLE_NAME
        USING ERRCODE = '23514';
    END IF;
    IF TG_TABLE_NAME = 'extraction_verified_fields' THEN
      SELECT * INTO candidate_row FROM public.extraction_field_candidates
        WHERE organization_id = NEW.organization_id
          AND extraction_run_id = NEW.extraction_run_id
          AND id = NEW.candidate_id;
      IF candidate_row.id IS NULL
        OR NEW.source_artifact_id <> candidate_row.source_artifact_id
        OR NEW.source_document_id <> candidate_row.source_document_id
        OR NEW.source_sha256 <> candidate_row.source_sha256
        OR NEW.parser_manifest_hash <> candidate_row.parser_manifest_hash
        OR NEW.raw_text <> candidate_row.raw_text
        OR NEW.normalized_value <> candidate_row.proposed_value
        OR NEW.transformations <> candidate_row.transformations THEN
        RAISE EXCEPTION 'verified field must be an exact verified projection of its candidate'
          USING ERRCODE = '23514';
      END IF;
    END IF;
  ELSIF TG_TABLE_NAME = 'extraction_processing_gaps' THEN
    SELECT * INTO source_row FROM public.extraction_source_artifacts
      WHERE organization_id = NEW.organization_id AND id = NEW.source_artifact_id;
    SELECT * INTO run_row FROM public.extraction_runs
      WHERE organization_id = NEW.organization_id AND id = NEW.extraction_run_id;
    IF source_row.id IS NULL OR run_row.id IS NULL
      OR run_row.source_artifact_id <> source_row.id
      OR NEW.source_document_id <> source_row.source_document_id THEN
      RAISE EXCEPTION 'processing gap provenance does not close to one source/run'
        USING ERRCODE = '23514';
    END IF;
  ELSIF TG_TABLE_NAME = 'extraction_snapshots' THEN
    SELECT * INTO source_row FROM public.extraction_source_artifacts
      WHERE organization_id = NEW.organization_id AND id = NEW.source_artifact_id;
    SELECT * INTO run_row FROM public.extraction_runs
      WHERE organization_id = NEW.organization_id AND id = NEW.producing_run_id;
    IF source_row.id IS NULL OR run_row.id IS NULL
      OR run_row.source_artifact_id <> source_row.id
      OR NEW.source_document_id <> source_row.source_document_id
      OR NEW.source_sha256 <> source_row.source_sha256
      OR NEW.parser_manifest_hash <> run_row.parser_manifest_hash
      OR NEW.artifact_schema_version <> run_row.artifact_schema_version THEN
      RAISE EXCEPTION 'snapshot provenance does not close to one source/run/manifest'
        USING ERRCODE = '23514';
    END IF;
  ELSIF TG_TABLE_NAME = 'extraction_snapshot_members' THEN
    SELECT * INTO snapshot_row FROM public.extraction_snapshots
      WHERE organization_id = NEW.organization_id AND id = NEW.extraction_snapshot_id;
    IF NEW.member_kind = 'page' THEN
      SELECT extraction_run_id INTO target_run_id FROM public.extraction_page_artifacts
        WHERE organization_id = NEW.organization_id AND id = NEW.page_artifact_id;
    ELSIF NEW.member_kind = 'fragment' THEN
      SELECT extraction_run_id INTO target_run_id FROM public.extraction_fragment_artifacts
        WHERE organization_id = NEW.organization_id AND id = NEW.fragment_artifact_id;
    ELSIF NEW.member_kind = 'candidate' THEN
      SELECT extraction_run_id INTO target_run_id FROM public.extraction_field_candidates
        WHERE organization_id = NEW.organization_id AND id = NEW.field_candidate_id;
    ELSIF NEW.member_kind = 'verified_field' THEN
      SELECT extraction_run_id INTO target_run_id FROM public.extraction_verified_fields
        WHERE organization_id = NEW.organization_id AND id = NEW.verified_field_id;
    ELSE
      SELECT extraction_run_id INTO target_run_id FROM public.extraction_processing_gaps
        WHERE organization_id = NEW.organization_id AND id = NEW.processing_gap_id;
    END IF;
    IF snapshot_row.id IS NULL OR target_run_id IS NULL
      OR target_run_id <> snapshot_row.producing_run_id THEN
      RAISE EXCEPTION 'snapshot member must belong to the snapshot producing run'
        USING ERRCODE = '23514';
    END IF;
  ELSIF TG_TABLE_NAME = 'canonical_document_facts' THEN
    SELECT * INTO snapshot_row FROM public.extraction_snapshots
      WHERE organization_id = NEW.organization_id AND id = NEW.extraction_snapshot_id;
    SELECT * INTO verified_row FROM public.extraction_verified_fields
      WHERE organization_id = NEW.organization_id
        AND extraction_run_id = NEW.extraction_run_id
        AND id = NEW.primary_verified_field_id;
    IF snapshot_row.id IS NULL OR verified_row.id IS NULL
      OR snapshot_row.producing_run_id <> NEW.extraction_run_id
      OR snapshot_row.source_document_id <> NEW.source_document_id
      OR verified_row.source_document_id <> NEW.source_document_id
      OR verified_row.normalized_value <> NEW.normalized_value THEN
      RAISE EXCEPTION 'canonical fact must equal its primary verified field in the snapshot run'
        USING ERRCODE = '23514';
    END IF;
  ELSIF TG_TABLE_NAME = 'document_interpretation_snapshots' THEN
    SELECT * INTO snapshot_row FROM public.extraction_snapshots
      WHERE organization_id = NEW.organization_id AND id = NEW.extraction_snapshot_id;
    IF snapshot_row.id IS NULL OR snapshot_row.source_document_id <> NEW.source_document_id THEN
      RAISE EXCEPTION 'interpretation snapshot must match extraction source document'
        USING ERRCODE = '23514';
    END IF;
  ELSIF TG_TABLE_NAME = 'document_extraction_snapshot_assignments' THEN
    SELECT * INTO source_row FROM public.extraction_source_artifacts
      WHERE organization_id = NEW.organization_id AND id = NEW.source_artifact_id;
    IF source_row.id IS NULL OR source_row.source_document_id <> NEW.source_document_id THEN
      RAISE EXCEPTION 'assignment source artifact must match source document'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.extraction_snapshot_id IS NOT NULL THEN
      SELECT * INTO snapshot_row FROM public.extraction_snapshots
        WHERE organization_id = NEW.organization_id AND id = NEW.extraction_snapshot_id;
      IF snapshot_row.id IS NULL
        OR snapshot_row.source_document_id <> NEW.source_document_id
        OR snapshot_row.source_artifact_id <> NEW.source_artifact_id
        OR snapshot_row.parser_manifest_hash <> NEW.desired_parser_manifest_hash
        OR snapshot_row.artifact_schema_version <> NEW.artifact_schema_version THEN
        RAISE EXCEPTION 'assignment must pin one coherent extraction snapshot'
          USING ERRCODE = '23514';
      END IF;
    END IF;
  ELSIF TG_TABLE_NAME = 'document_projection_stamps' THEN
    SELECT * INTO source_row FROM public.extraction_source_artifacts
      WHERE organization_id = NEW.organization_id AND id = NEW.source_artifact_id;
    SELECT * INTO snapshot_row FROM public.extraction_snapshots
      WHERE organization_id = NEW.organization_id AND id = NEW.extraction_snapshot_id;
    SELECT * INTO interpretation_row FROM public.document_interpretation_snapshots
      WHERE organization_id = NEW.organization_id AND id = NEW.interpretation_snapshot_id;
    IF source_row.id IS NULL OR snapshot_row.id IS NULL OR interpretation_row.id IS NULL
      OR source_row.source_document_id <> NEW.source_document_id
      OR source_row.source_sha256 <> NEW.source_sha256
      OR snapshot_row.source_document_id <> NEW.source_document_id
      OR snapshot_row.source_artifact_id <> NEW.source_artifact_id
      OR snapshot_row.source_sha256 <> NEW.source_sha256
      OR snapshot_row.parser_manifest_hash <> NEW.parser_manifest_hash
      OR interpretation_row.source_document_id <> NEW.source_document_id
      OR interpretation_row.extraction_snapshot_id <> NEW.extraction_snapshot_id THEN
      RAISE EXCEPTION 'projection stamp must close to one source/extraction/interpretation chain'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.enforce_extraction_provenance_integrity() FROM PUBLIC;

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'extraction_page_artifacts', 'extraction_fragment_artifacts',
    'extraction_field_candidates', 'extraction_verified_fields',
    'extraction_processing_gaps', 'extraction_snapshots',
    'extraction_snapshot_members', 'canonical_document_facts',
    'document_interpretation_snapshots',
    'document_extraction_snapshot_assignments', 'document_projection_stamps'
  ]
  LOOP
    EXECUTE format(
      'DROP TRIGGER IF EXISTS %I ON public.%I',
      'trg_' || table_name || '_provenance_integrity',
      table_name
    );
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE INSERT OR UPDATE ON public.%I
       FOR EACH ROW EXECUTE FUNCTION public.enforce_extraction_provenance_integrity()',
      'trg_' || table_name || '_provenance_integrity',
      table_name
    );
  END LOOP;
END;
$$;

-- Closure checks run at transaction commit, allowing repositories to insert a
-- record and its ordered dependencies atomically.
CREATE OR REPLACE FUNCTION public.check_extraction_dependency_closure()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  dependency_count integer;
  primary_count integer;
  valid_dependency_count integer;
  candidate_source_ids uuid[];
  verified_source_ids uuid[];
BEGIN
  IF TG_TABLE_NAME = 'extraction_field_candidates' THEN
    SELECT count(*) INTO dependency_count
    FROM public.extraction_field_candidate_sources s
    WHERE s.organization_id = NEW.organization_id AND s.field_candidate_id = NEW.id;
  ELSIF TG_TABLE_NAME = 'extraction_verified_fields' THEN
    SELECT count(*) INTO dependency_count
    FROM public.extraction_verified_field_sources s
    WHERE s.organization_id = NEW.organization_id AND s.verified_field_id = NEW.id;
    SELECT array_agg(s.fragment_artifact_id ORDER BY s.sequence)
      INTO candidate_source_ids
    FROM public.extraction_field_candidate_sources s
    WHERE s.organization_id = NEW.organization_id
      AND s.extraction_run_id = NEW.extraction_run_id
      AND s.field_candidate_id = NEW.candidate_id;
    SELECT array_agg(s.fragment_artifact_id ORDER BY s.sequence)
      INTO verified_source_ids
    FROM public.extraction_verified_field_sources s
    WHERE s.organization_id = NEW.organization_id
      AND s.extraction_run_id = NEW.extraction_run_id
      AND s.verified_field_id = NEW.id;
    IF candidate_source_ids IS NULL
      OR verified_source_ids IS DISTINCT FROM candidate_source_ids THEN
      RAISE EXCEPTION 'verified field sources must exactly equal ordered candidate sources'
        USING ERRCODE = '23514';
    END IF;
  ELSIF TG_TABLE_NAME = 'canonical_document_facts' THEN
    SELECT
      count(*),
      count(*) FILTER (WHERE s.is_primary),
      count(*) FILTER (
        WHERE vf.extraction_run_id = NEW.extraction_run_id
          AND vf.source_document_id = NEW.source_document_id
      )
    INTO dependency_count, primary_count, valid_dependency_count
    FROM public.canonical_document_fact_sources s
    JOIN public.extraction_verified_fields vf
      ON vf.organization_id = s.organization_id
      AND vf.extraction_run_id = s.extraction_run_id
      AND vf.id = s.verified_field_id
    WHERE s.organization_id = NEW.organization_id AND s.canonical_fact_id = NEW.id;
    IF primary_count <> 1
      OR valid_dependency_count <> dependency_count
      OR NOT EXISTS (
        SELECT 1 FROM public.canonical_document_fact_sources s
        WHERE s.organization_id = NEW.organization_id
          AND s.canonical_fact_id = NEW.id
          AND s.verified_field_id = NEW.primary_verified_field_id
          AND s.is_primary
      ) THEN
      RAISE EXCEPTION 'canonical fact requires exactly one coherent primary verified source'
        USING ERRCODE = '23514';
    END IF;
    IF EXISTS (
      SELECT 1
      FROM public.canonical_document_fact_sources fact_source
      JOIN public.extraction_verified_fields vf
        ON vf.organization_id = fact_source.organization_id
        AND vf.extraction_run_id = fact_source.extraction_run_id
        AND vf.id = fact_source.verified_field_id
      WHERE fact_source.organization_id = NEW.organization_id
        AND fact_source.canonical_fact_id = NEW.id
        AND (
          NOT EXISTS (
            SELECT 1 FROM public.extraction_snapshot_members member
            WHERE member.organization_id = NEW.organization_id
              AND member.extraction_snapshot_id = NEW.extraction_snapshot_id
              AND member.member_kind = 'verified_field'
              AND member.verified_field_id = vf.id
          )
          OR NOT EXISTS (
            SELECT 1 FROM public.extraction_snapshot_members member
            WHERE member.organization_id = NEW.organization_id
              AND member.extraction_snapshot_id = NEW.extraction_snapshot_id
              AND member.member_kind = 'candidate'
              AND member.field_candidate_id = vf.candidate_id
          )
          OR EXISTS (
            SELECT 1
            FROM public.extraction_verified_field_sources verified_source
            JOIN public.extraction_fragment_artifacts fragment
              ON fragment.organization_id = verified_source.organization_id
              AND fragment.extraction_run_id = verified_source.extraction_run_id
              AND fragment.id = verified_source.fragment_artifact_id
            WHERE verified_source.organization_id = vf.organization_id
              AND verified_source.extraction_run_id = vf.extraction_run_id
              AND verified_source.verified_field_id = vf.id
              AND (
                NOT EXISTS (
                  SELECT 1 FROM public.extraction_snapshot_members member
                  WHERE member.organization_id = NEW.organization_id
                    AND member.extraction_snapshot_id = NEW.extraction_snapshot_id
                    AND member.member_kind = 'fragment'
                    AND member.fragment_artifact_id = fragment.id
                )
                OR NOT EXISTS (
                  SELECT 1 FROM public.extraction_snapshot_members member
                  WHERE member.organization_id = NEW.organization_id
                    AND member.extraction_snapshot_id = NEW.extraction_snapshot_id
                    AND member.member_kind = 'page'
                    AND member.page_artifact_id = fragment.page_artifact_id
                )
              )
          )
        )
    ) THEN
      RAISE EXCEPTION 'canonical fact dependencies must be closed into the snapshot root'
        USING ERRCODE = '23514';
    END IF;
  ELSIF TG_TABLE_NAME = 'derived_document_facts' THEN
    SELECT count(*) INTO dependency_count
    FROM public.derived_document_fact_dependencies d
    WHERE d.organization_id = NEW.organization_id AND d.derived_fact_id = NEW.id;
  ELSE
    RAISE EXCEPTION 'unsupported dependency closure table %', TG_TABLE_NAME;
  END IF;

  IF dependency_count = 0 THEN
    RAISE EXCEPTION '% requires a non-empty valid dependency closure', TG_TABLE_NAME
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.check_extraction_dependency_closure() FROM PUBLIC;

DROP TRIGGER IF EXISTS trg_extraction_field_candidates_closure ON public.extraction_field_candidates;
CREATE CONSTRAINT TRIGGER trg_extraction_field_candidates_closure
  AFTER INSERT ON public.extraction_field_candidates
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.check_extraction_dependency_closure();

DROP TRIGGER IF EXISTS trg_extraction_verified_fields_closure ON public.extraction_verified_fields;
CREATE CONSTRAINT TRIGGER trg_extraction_verified_fields_closure
  AFTER INSERT ON public.extraction_verified_fields
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.check_extraction_dependency_closure();

DROP TRIGGER IF EXISTS trg_canonical_document_facts_closure ON public.canonical_document_facts;
CREATE CONSTRAINT TRIGGER trg_canonical_document_facts_closure
  AFTER INSERT ON public.canonical_document_facts
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.check_extraction_dependency_closure();

DROP TRIGGER IF EXISTS trg_derived_document_facts_closure ON public.derived_document_facts;
CREATE CONSTRAINT TRIGGER trg_derived_document_facts_closure
  AFTER INSERT ON public.derived_document_facts
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.check_extraction_dependency_closure();

-- The shadow publisher is one transaction and is resumable by immutable
-- idempotency keys. No partially published run/snapshot chain is observable.
CREATE OR REPLACE FUNCTION public.publish_extraction_compliance_shadow(payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  org_id uuid := (payload->>'organization_id')::uuid;
  document_id uuid := (payload->>'source_document_id')::uuid;
  source_id uuid;
  run_id uuid;
  snapshot_id uuid;
  snapshot_run_id uuid;
  gap_id uuid;
  interpretation_id uuid;
  semantic_key_value text;
  attempt_no integer;
BEGIN
  IF auth.role() <> 'service_role' THEN
    RAISE EXCEPTION 'service_role required' USING ERRCODE = '42501';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      org_id::text || ':' || document_id::text || ':' || (payload->>'idempotency_key'),
      0
    )
  );

  INSERT INTO public.extraction_source_artifacts (
    organization_id, source_document_id, source_sha256, storage_object_version,
    media_type_sniffed, byte_length
  ) VALUES (
    org_id, document_id, payload->>'source_sha256', payload->>'storage_object_version',
    payload->>'media_type_sniffed', (payload->>'byte_length')::bigint
  )
  ON CONFLICT (organization_id, source_document_id, source_sha256, storage_object_version)
  DO NOTHING;

  SELECT id INTO source_id
  FROM public.extraction_source_artifacts
  WHERE organization_id = org_id
    AND source_document_id = document_id
    AND source_sha256 = payload->>'source_sha256'
    AND storage_object_version = payload->>'storage_object_version';

  semantic_key_value :=
    document_id::text || ':' || source_id::text || ':'
    || (payload->>'parser_manifest_hash') || ':' || (payload->>'artifact_schema_version');
  PERFORM pg_advisory_xact_lock(hashtextextended(org_id::text || ':' || semantic_key_value, 0));

  SELECT id INTO run_id
  FROM public.extraction_runs
  WHERE organization_id = org_id AND idempotency_key = payload->>'idempotency_key';

  IF run_id IS NULL THEN
    SELECT COALESCE(max(attempt_number), 0) + 1 INTO attempt_no
    FROM public.extraction_runs
    WHERE organization_id = org_id
      AND extraction_runs.semantic_key = semantic_key_value;

    INSERT INTO public.extraction_runs (
      organization_id, source_artifact_id, semantic_key, idempotency_key,
      attempt_number, parser_manifest, parser_manifest_hash,
      artifact_schema_version, initial_status, started_at, completed_at
    ) VALUES (
      org_id, source_id, semantic_key_value, payload->>'idempotency_key',
      attempt_no, payload->'parser_manifest', payload->>'parser_manifest_hash',
      payload->>'artifact_schema_version', 'running',
      (payload->>'started_at')::timestamptz, (payload->>'completed_at')::timestamptz
    )
    RETURNING id INTO run_id;
  END IF;

  INSERT INTO public.extraction_processing_gaps (
    organization_id, extraction_run_id, source_artifact_id, source_document_id,
    gap_key, page, stage, reason, retryable, attempts, detail
  ) VALUES (
    org_id, run_id, source_id, document_id,
    payload->>'gap_key', NULL, 'field_verification', 'missing_geometry',
    false, 1, payload->>'gap_detail'
  )
  ON CONFLICT (organization_id, extraction_run_id, gap_key) DO NOTHING;

  INSERT INTO public.extraction_run_states (
    organization_id, extraction_run_id, state, reason, recorded_at
  ) VALUES (
    org_id, run_id, 'partial_terminal', 'legacy_payload_missing_geometry',
    (payload->>'completed_at')::timestamptz
  )
  ON CONFLICT (organization_id, extraction_run_id, state, reason) DO NOTHING;

  INSERT INTO public.extraction_snapshots (
    organization_id, source_document_id, source_artifact_id, source_sha256,
    parser_manifest_hash, artifact_schema_version, producing_run_id, status,
    content_extraction_fingerprint, artifact_root_hash
  ) VALUES (
    org_id, document_id, source_id, payload->>'source_sha256',
    payload->>'parser_manifest_hash', payload->>'artifact_schema_version',
    run_id, 'partial', payload->>'content_extraction_fingerprint',
    payload->>'artifact_root_hash'
  )
  ON CONFLICT (
    organization_id, source_document_id, source_artifact_id,
    parser_manifest_hash, artifact_schema_version
  ) DO NOTHING;

  SELECT id, producing_run_id INTO snapshot_id, snapshot_run_id
  FROM public.extraction_snapshots
  WHERE organization_id = org_id
    AND source_document_id = document_id
    AND source_artifact_id = source_id
    AND parser_manifest_hash = payload->>'parser_manifest_hash'
    AND artifact_schema_version = payload->>'artifact_schema_version';

  SELECT id INTO gap_id
  FROM public.extraction_processing_gaps
  WHERE organization_id = org_id
    AND extraction_run_id = snapshot_run_id
    AND gap_key = payload->>'gap_key';

  IF NOT EXISTS (
    SELECT 1 FROM public.extraction_snapshot_members
    WHERE organization_id = org_id
      AND extraction_snapshot_id = snapshot_id
      AND sequence = 1
  ) THEN
    INSERT INTO public.extraction_snapshot_members (
      organization_id, extraction_snapshot_id, member_kind, processing_gap_id,
      dependency_hash, sequence
    ) VALUES (
      org_id, snapshot_id, 'gap', gap_id, payload->>'gap_dependency_hash', 1
    );
  END IF;

  INSERT INTO public.document_interpretation_snapshots (
    organization_id, source_document_id, extraction_snapshot_id,
    interpreter_manifest_hash, entity_resolver_version, effective_truth_set_hash,
    status, output_root_hash
  ) VALUES (
    org_id, document_id, snapshot_id, payload->>'interpreter_manifest_hash',
    payload->>'entity_resolver_version', payload->>'effective_truth_set_hash',
    'blocked', payload->>'interpretation_output_root_hash'
  )
  ON CONFLICT (
    organization_id, extraction_snapshot_id, interpreter_manifest_hash, entity_resolver_version
  ) DO NOTHING;

  SELECT id INTO interpretation_id
  FROM public.document_interpretation_snapshots
  WHERE organization_id = org_id
    AND extraction_snapshot_id = snapshot_id
    AND interpreter_manifest_hash = payload->>'interpreter_manifest_hash'
    AND entity_resolver_version = payload->>'entity_resolver_version';

  IF NOT EXISTS (
    SELECT 1 FROM public.document_interpretation_records
    WHERE organization_id = org_id
      AND interpretation_snapshot_id = interpretation_id
      AND sequence = 1
  ) THEN
    INSERT INTO public.document_interpretation_records (
      organization_id, interpretation_snapshot_id, record_type,
      processing_gap_id, record_data, sequence
    ) VALUES (
      org_id, interpretation_id, 'gap', gap_id,
      '{"shadow_only":true,"live_reader_eligible":false}'::jsonb, 1
    );
  END IF;

  INSERT INTO public.document_extraction_snapshot_assignments (
    organization_id, source_document_id, source_artifact_id,
    desired_parser_manifest_hash, artifact_schema_version,
    extraction_snapshot_id, activation_mode, assigned_at
  ) VALUES (
    org_id, document_id, source_id, payload->>'parser_manifest_hash',
    payload->>'artifact_schema_version', snapshot_id, 'shadow',
    (payload->>'completed_at')::timestamptz
  )
  ON CONFLICT (organization_id, source_document_id) DO UPDATE SET
    source_artifact_id = EXCLUDED.source_artifact_id,
    desired_parser_manifest_hash = EXCLUDED.desired_parser_manifest_hash,
    artifact_schema_version = EXCLUDED.artifact_schema_version,
    extraction_snapshot_id = EXCLUDED.extraction_snapshot_id,
    activation_mode = 'shadow',
    assigned_at = EXCLUDED.assigned_at;

  INSERT INTO public.document_projection_stamps (
    organization_id, source_document_id, projection_kind, projection_record_id,
    source_artifact_id, source_sha256, extraction_snapshot_id,
    parser_manifest_hash, interpretation_snapshot_id, projection_schema_version
  ) VALUES (
    org_id, document_id, 'step0_shadow', payload->>'idempotency_key',
    source_id, payload->>'source_sha256', snapshot_id,
    payload->>'parser_manifest_hash', interpretation_id,
    payload->>'projection_schema_version'
  )
  ON CONFLICT (organization_id, projection_kind, projection_record_id) DO NOTHING;

  RETURN jsonb_build_object(
    'source_artifact_id', source_id,
    'extraction_run_id', run_id,
    'extraction_snapshot_id', snapshot_id,
    'interpretation_snapshot_id', interpretation_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.publish_extraction_compliance_shadow(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.publish_extraction_compliance_shadow(jsonb) TO service_role;

-- Source/run and dependency indexes. The semantic uniqueness indexes above are
-- also used for idempotent publication.
CREATE INDEX IF NOT EXISTS idx_extraction_source_artifacts_document_created
  ON public.extraction_source_artifacts (organization_id, source_document_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_extraction_runs_source_created
  ON public.extraction_runs (organization_id, source_artifact_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_extraction_run_states_run_recorded
  ON public.extraction_run_states (organization_id, extraction_run_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_extraction_page_artifacts_run
  ON public.extraction_page_artifacts (organization_id, extraction_run_id);
CREATE INDEX IF NOT EXISTS idx_extraction_fragment_artifacts_run_source
  ON public.extraction_fragment_artifacts (organization_id, source_artifact_id, extraction_run_id);
CREATE INDEX IF NOT EXISTS idx_extraction_fragment_dependencies_dependency
  ON public.extraction_fragment_dependencies (organization_id, extraction_run_id, dependency_fragment_artifact_id);
CREATE INDEX IF NOT EXISTS idx_extraction_field_candidates_run_source
  ON public.extraction_field_candidates (organization_id, source_artifact_id, extraction_run_id);
CREATE INDEX IF NOT EXISTS idx_extraction_field_candidate_sources_fragment
  ON public.extraction_field_candidate_sources (organization_id, extraction_run_id, fragment_artifact_id);
CREATE INDEX IF NOT EXISTS idx_extraction_verified_fields_run_source
  ON public.extraction_verified_fields (organization_id, source_artifact_id, extraction_run_id);
CREATE INDEX IF NOT EXISTS idx_extraction_verified_field_sources_fragment
  ON public.extraction_verified_field_sources (organization_id, extraction_run_id, fragment_artifact_id);
CREATE INDEX IF NOT EXISTS idx_extraction_processing_gaps_run_source
  ON public.extraction_processing_gaps (organization_id, source_artifact_id, extraction_run_id);
CREATE INDEX IF NOT EXISTS idx_extraction_gap_sources_fragment
  ON public.extraction_gap_sources (organization_id, extraction_run_id, fragment_artifact_id);
CREATE INDEX IF NOT EXISTS idx_extraction_snapshots_document_published
  ON public.extraction_snapshots (organization_id, source_document_id, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_extraction_snapshot_members_target
  ON public.extraction_snapshot_members (organization_id, extraction_snapshot_id, member_kind);
CREATE INDEX IF NOT EXISTS idx_canonical_document_facts_document_created
  ON public.canonical_document_facts (organization_id, source_document_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_canonical_document_fact_sources_verified
  ON public.canonical_document_fact_sources (organization_id, extraction_run_id, verified_field_id);
CREATE INDEX IF NOT EXISTS idx_derived_document_facts_document_created
  ON public.derived_document_facts (organization_id, source_document_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_derived_document_fact_dependencies_inputs
  ON public.derived_document_fact_dependencies
  (organization_id, canonical_fact_id, input_derived_fact_id, human_assertion_id);
CREATE INDEX IF NOT EXISTS idx_human_fact_assertions_document_created
  ON public.human_fact_assertions (organization_id, source_document_id, asserted_at DESC);
CREATE INDEX IF NOT EXISTS idx_document_interpretation_snapshots_document_published
  ON public.document_interpretation_snapshots (organization_id, source_document_id, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_document_interpretation_records_snapshot
  ON public.document_interpretation_records (organization_id, interpretation_snapshot_id, record_type);
CREATE INDEX IF NOT EXISTS idx_entity_resolution_runs_snapshot
  ON public.entity_resolution_runs (organization_id, interpretation_snapshot_id);
CREATE INDEX IF NOT EXISTS idx_entity_resolutions_run
  ON public.entity_resolutions (organization_id, entity_resolution_run_id);
CREATE INDEX IF NOT EXISTS idx_extraction_snapshot_invalidations_snapshot
  ON public.extraction_snapshot_invalidations (organization_id, extraction_snapshot_id, invalidated_at DESC);
CREATE INDEX IF NOT EXISTS idx_extraction_replay_requests_document
  ON public.extraction_replay_requests (organization_id, source_document_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_document_extraction_assignments_snapshot
  ON public.document_extraction_snapshot_assignments (organization_id, extraction_snapshot_id);
CREATE INDEX IF NOT EXISTS idx_document_projection_stamps_document
  ON public.document_projection_stamps (organization_id, source_document_id, created_at DESC);

-- All immutable records reject UPDATE and DELETE even for service_role. The
-- current assignment is the sole mutable pointer and is intentionally excluded.
DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'extraction_source_artifacts',
    'extraction_runs',
    'extraction_run_states',
    'extraction_page_artifacts',
    'extraction_fragment_artifacts',
    'extraction_fragment_dependencies',
    'extraction_field_candidates',
    'extraction_field_candidate_sources',
    'extraction_verified_fields',
    'extraction_verified_field_sources',
    'extraction_processing_gaps',
    'extraction_gap_sources',
    'extraction_snapshots',
    'extraction_snapshot_members',
    'canonical_document_facts',
    'canonical_document_fact_sources',
    'derived_document_facts',
    'derived_document_fact_dependencies',
    'human_fact_assertions',
    'document_interpretation_snapshots',
    'document_interpretation_records',
    'entity_resolution_runs',
    'entity_resolutions',
    'extraction_snapshot_invalidations',
    'extraction_replay_requests',
    'document_projection_stamps'
  ]
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%I_append_only ON public.%I', table_name, table_name);
    EXECUTE format(
      'CREATE TRIGGER trg_%I_append_only BEFORE UPDATE OR DELETE ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION public.reject_compliance_ledger_mutation()',
      table_name,
      table_name
    );
  END LOOP;
END;
$$;

-- New public-schema tables are explicitly exposed as authenticated read-only
-- resources. Server writes use service_role and remain subject to append-only
-- triggers.
DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'extraction_source_artifacts',
    'extraction_runs',
    'extraction_run_states',
    'extraction_page_artifacts',
    'extraction_fragment_artifacts',
    'extraction_fragment_dependencies',
    'extraction_field_candidates',
    'extraction_field_candidate_sources',
    'extraction_verified_fields',
    'extraction_verified_field_sources',
    'extraction_processing_gaps',
    'extraction_gap_sources',
    'extraction_snapshots',
    'extraction_snapshot_members',
    'canonical_document_facts',
    'canonical_document_fact_sources',
    'derived_document_facts',
    'derived_document_fact_dependencies',
    'human_fact_assertions',
    'document_interpretation_snapshots',
    'document_interpretation_records',
    'entity_resolution_runs',
    'entity_resolutions',
    'extraction_snapshot_invalidations',
    'extraction_replay_requests',
    'document_extraction_snapshot_assignments',
    'document_projection_stamps'
  ]
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM anon, authenticated', table_name);
    EXECUTE format('GRANT SELECT ON TABLE public.%I TO authenticated', table_name);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM service_role', table_name);
    IF table_name = 'document_extraction_snapshot_assignments' THEN
      EXECUTE format(
        'GRANT SELECT, INSERT, UPDATE ON TABLE public.%I TO service_role',
        table_name
      );
    ELSE
      EXECUTE format('GRANT SELECT ON TABLE public.%I TO service_role', table_name);
    END IF;
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', table_name || '_select_org', table_name);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR SELECT TO authenticated '
      'USING (organization_id = public.get_current_user_org_id())',
      table_name || '_select_org',
      table_name
    );
  END LOOP;
END;
$$;
