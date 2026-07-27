-- Phase 3 Step 3: immutable generic table-structure and semantic-column artifacts.
-- This migration is shadow-only. It does not alter any live reader or canonical fact.

ALTER TABLE public.extraction_processing_gaps
  DROP CONSTRAINT extraction_processing_gaps_reason_check;
ALTER TABLE public.extraction_processing_gaps
  ADD CONSTRAINT extraction_processing_gaps_reason_check CHECK (
    reason IN (
      'timeout', 'engine_failure', 'unsupported_size', 'unprocessed_region',
      'engine_conflict', 'missing_geometry', 'no_source_span', 'ambiguous_parse',
      'content_quality_skip', 'decode_failure', 'ocr_region_failure',
      'table_structure_unresolved', 'arbitration_unresolved'
    )
  );

CREATE TABLE public.extraction_table_continuation_links (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  extraction_run_id uuid NOT NULL,
  source_artifact_id uuid NOT NULL,
  source_document_id uuid NOT NULL REFERENCES public.documents(id) ON DELETE RESTRICT,
  source_sha256 text NOT NULL CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
  parser_manifest_hash text NOT NULL CHECK (parser_manifest_hash ~ '^[0-9a-f]{64}$'),
  parser jsonb NOT NULL CHECK (jsonb_typeof(parser) = 'object'),
  from_segment_id uuid NOT NULL,
  to_segment_id uuid NOT NULL,
  basis jsonb NOT NULL CHECK (jsonb_typeof(basis) = 'object'),
  score jsonb NOT NULL CHECK (jsonb_typeof(score) = 'object'),
  decision text NOT NULL CHECK (decision IN ('linked', 'ambiguous', 'rejected')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, extraction_run_id, id),
  FOREIGN KEY (organization_id, extraction_run_id, source_artifact_id)
    REFERENCES public.extraction_runs(organization_id, id, source_artifact_id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, extraction_run_id, from_segment_id)
    REFERENCES public.extraction_fragment_artifacts(organization_id, extraction_run_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, extraction_run_id, to_segment_id)
    REFERENCES public.extraction_fragment_artifacts(organization_id, extraction_run_id, id) ON DELETE RESTRICT,
  CHECK (from_segment_id <> to_segment_id)
);

CREATE TABLE public.extraction_table_continuation_link_basis_fragments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  extraction_run_id uuid NOT NULL,
  continuation_link_id uuid NOT NULL,
  basis_kind text NOT NULL CHECK (basis_kind IN (
    'column_band_similarity', 'header_similarity', 'edge_proximity',
    'typography_similarity', 'row_continuation_score', 'overall'
  )),
  fragment_artifact_id uuid NOT NULL,
  sequence integer NOT NULL CHECK (sequence > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, extraction_run_id, continuation_link_id, basis_kind, sequence),
  UNIQUE (organization_id, extraction_run_id, continuation_link_id, basis_kind, fragment_artifact_id),
  FOREIGN KEY (organization_id, extraction_run_id, continuation_link_id)
    REFERENCES public.extraction_table_continuation_links(organization_id, extraction_run_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, extraction_run_id, fragment_artifact_id)
    REFERENCES public.extraction_fragment_artifacts(organization_id, extraction_run_id, id) ON DELETE RESTRICT
);

CREATE TABLE public.extraction_table_chains (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  extraction_run_id uuid NOT NULL,
  source_artifact_id uuid NOT NULL,
  source_document_id uuid NOT NULL REFERENCES public.documents(id) ON DELETE RESTRICT,
  source_sha256 text NOT NULL CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
  parser_manifest_hash text NOT NULL CHECK (parser_manifest_hash ~ '^[0-9a-f]{64}$'),
  parser jsonb NOT NULL CHECK (jsonb_typeof(parser) = 'object'),
  completeness text NOT NULL CHECK (completeness IN ('complete', 'partial', 'ambiguous')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, extraction_run_id, id),
  FOREIGN KEY (organization_id, extraction_run_id, source_artifact_id)
    REFERENCES public.extraction_runs(organization_id, id, source_artifact_id) ON DELETE RESTRICT
);

CREATE TABLE public.extraction_table_chain_segments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  extraction_run_id uuid NOT NULL,
  table_chain_id uuid NOT NULL,
  segment_id uuid NOT NULL,
  sequence integer NOT NULL CHECK (sequence > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, extraction_run_id, table_chain_id, sequence),
  UNIQUE (organization_id, extraction_run_id, table_chain_id, segment_id),
  FOREIGN KEY (organization_id, extraction_run_id, table_chain_id)
    REFERENCES public.extraction_table_chains(organization_id, extraction_run_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, extraction_run_id, segment_id)
    REFERENCES public.extraction_fragment_artifacts(organization_id, extraction_run_id, id) ON DELETE RESTRICT
);

CREATE TABLE public.extraction_table_chain_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  extraction_run_id uuid NOT NULL,
  table_chain_id uuid NOT NULL,
  continuation_link_id uuid NOT NULL,
  sequence integer NOT NULL CHECK (sequence > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, extraction_run_id, table_chain_id, sequence),
  UNIQUE (organization_id, extraction_run_id, table_chain_id, continuation_link_id),
  FOREIGN KEY (organization_id, extraction_run_id, table_chain_id)
    REFERENCES public.extraction_table_chains(organization_id, extraction_run_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, extraction_run_id, continuation_link_id)
    REFERENCES public.extraction_table_continuation_links(organization_id, extraction_run_id, id) ON DELETE RESTRICT
);

CREATE TABLE public.extraction_table_chain_gaps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  extraction_run_id uuid NOT NULL,
  table_chain_id uuid NOT NULL,
  processing_gap_id uuid NOT NULL,
  sequence integer NOT NULL CHECK (sequence > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, extraction_run_id, table_chain_id, sequence),
  UNIQUE (organization_id, extraction_run_id, table_chain_id, processing_gap_id),
  FOREIGN KEY (organization_id, extraction_run_id, table_chain_id)
    REFERENCES public.extraction_table_chains(organization_id, extraction_run_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, extraction_run_id, processing_gap_id)
    REFERENCES public.extraction_processing_gaps(organization_id, extraction_run_id, id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE public.extraction_table_sections (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  extraction_run_id uuid NOT NULL,
  source_artifact_id uuid NOT NULL,
  source_document_id uuid NOT NULL REFERENCES public.documents(id) ON DELETE RESTRICT,
  source_sha256 text NOT NULL CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
  parser_manifest_hash text NOT NULL CHECK (parser_manifest_hash ~ '^[0-9a-f]{64}$'),
  parser jsonb NOT NULL CHECK (jsonb_typeof(parser) = 'object'),
  table_chain_id uuid NOT NULL,
  header_row_id uuid,
  sequence integer NOT NULL CHECK (sequence > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, extraction_run_id, id),
  UNIQUE (organization_id, extraction_run_id, table_chain_id, sequence),
  FOREIGN KEY (organization_id, extraction_run_id, source_artifact_id)
    REFERENCES public.extraction_runs(organization_id, id, source_artifact_id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, extraction_run_id, table_chain_id)
    REFERENCES public.extraction_table_chains(organization_id, extraction_run_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, extraction_run_id, header_row_id)
    REFERENCES public.extraction_fragment_artifacts(organization_id, extraction_run_id, id) ON DELETE RESTRICT
);

CREATE TABLE public.extraction_table_section_rows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  extraction_run_id uuid NOT NULL,
  table_section_id uuid NOT NULL,
  row_id uuid NOT NULL,
  sequence integer NOT NULL CHECK (sequence > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, extraction_run_id, table_section_id, sequence),
  UNIQUE (organization_id, extraction_run_id, table_section_id, row_id),
  FOREIGN KEY (organization_id, extraction_run_id, table_section_id)
    REFERENCES public.extraction_table_sections(organization_id, extraction_run_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, extraction_run_id, row_id)
    REFERENCES public.extraction_fragment_artifacts(organization_id, extraction_run_id, id) ON DELETE RESTRICT
);

CREATE TABLE public.extraction_table_section_child_chains (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  extraction_run_id uuid NOT NULL,
  table_section_id uuid NOT NULL,
  child_table_chain_id uuid NOT NULL,
  sequence integer NOT NULL CHECK (sequence > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, extraction_run_id, table_section_id, sequence),
  UNIQUE (organization_id, extraction_run_id, table_section_id, child_table_chain_id),
  FOREIGN KEY (organization_id, extraction_run_id, table_section_id)
    REFERENCES public.extraction_table_sections(organization_id, extraction_run_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, extraction_run_id, child_table_chain_id)
    REFERENCES public.extraction_table_chains(organization_id, extraction_run_id, id) ON DELETE RESTRICT
);

CREATE TABLE public.extraction_arbitration_decisions (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  extraction_run_id uuid NOT NULL,
  source_artifact_id uuid NOT NULL,
  source_document_id uuid NOT NULL REFERENCES public.documents(id) ON DELETE RESTRICT,
  source_sha256 text NOT NULL CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
  parser_manifest_hash text NOT NULL CHECK (parser_manifest_hash ~ '^[0-9a-f]{64}$'),
  parser jsonb NOT NULL CHECK (jsonb_typeof(parser) = 'object'),
  page_artifact_id uuid NOT NULL,
  physical_region_id uuid NOT NULL,
  processing_gap_id uuid,
  agreement jsonb CHECK (agreement IS NULL OR jsonb_typeof(agreement) = 'object'),
  decision text NOT NULL CHECK (decision IN ('consensus', 'single_source', 'conflict', 'unresolved')),
  diagnostics jsonb NOT NULL CHECK (jsonb_typeof(diagnostics) = 'array'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, extraction_run_id, id),
  FOREIGN KEY (organization_id, extraction_run_id, source_artifact_id)
    REFERENCES public.extraction_runs(organization_id, id, source_artifact_id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, extraction_run_id, page_artifact_id)
    REFERENCES public.extraction_page_artifacts(organization_id, extraction_run_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, extraction_run_id, physical_region_id)
    REFERENCES public.extraction_fragment_artifacts(organization_id, extraction_run_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, extraction_run_id, processing_gap_id)
    REFERENCES public.extraction_processing_gaps(organization_id, extraction_run_id, id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CHECK (
    (decision IN ('conflict', 'unresolved') AND processing_gap_id IS NOT NULL)
    OR (decision IN ('consensus', 'single_source') AND processing_gap_id IS NULL)
  )
);

CREATE TABLE public.extraction_arbitration_decision_candidates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  extraction_run_id uuid NOT NULL,
  arbitration_decision_id uuid NOT NULL,
  candidate_fragment_id uuid NOT NULL,
  disposition text NOT NULL CHECK (disposition IN ('accepted', 'rejected')),
  sequence integer NOT NULL CHECK (sequence > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, extraction_run_id, arbitration_decision_id, sequence),
  UNIQUE (organization_id, extraction_run_id, arbitration_decision_id, candidate_fragment_id),
  FOREIGN KEY (organization_id, extraction_run_id, arbitration_decision_id)
    REFERENCES public.extraction_arbitration_decisions(organization_id, extraction_run_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, extraction_run_id, candidate_fragment_id)
    REFERENCES public.extraction_fragment_artifacts(organization_id, extraction_run_id, id) ON DELETE RESTRICT
);

CREATE TABLE public.semantic_column_mappings (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  interpretation_snapshot_id uuid NOT NULL,
  table_chain_id uuid NOT NULL,
  column_index integer NOT NULL CHECK (column_index >= 0),
  domain_role text NOT NULL CHECK (domain_role IN (
    'description', 'quantity', 'unit', 'rate', 'extension', 'identifier', 'other'
  )),
  assessment jsonb NOT NULL CHECK (jsonb_typeof(assessment) = 'object'),
  status text NOT NULL CHECK (status IN ('resolved', 'ambiguous')),
  interpretation_rule_id text NOT NULL CHECK (btrim(interpretation_rule_id) <> ''),
  interpretation_rule_version text NOT NULL CHECK (btrim(interpretation_rule_version) <> ''),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, interpretation_snapshot_id, id),
  UNIQUE (organization_id, interpretation_snapshot_id, table_chain_id, column_index),
  FOREIGN KEY (organization_id, interpretation_snapshot_id)
    REFERENCES public.document_interpretation_snapshots(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, table_chain_id)
    REFERENCES public.extraction_table_chains(organization_id, id) ON DELETE RESTRICT
);

CREATE TABLE public.semantic_column_mapping_fields (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  interpretation_snapshot_id uuid NOT NULL,
  semantic_column_mapping_id uuid NOT NULL,
  verified_field_id uuid NOT NULL,
  field_role text NOT NULL CHECK (field_role IN ('header', 'cell')),
  sequence integer NOT NULL CHECK (sequence > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, interpretation_snapshot_id, semantic_column_mapping_id, field_role, sequence),
  UNIQUE (organization_id, interpretation_snapshot_id, semantic_column_mapping_id, field_role, verified_field_id),
  FOREIGN KEY (organization_id, interpretation_snapshot_id, semantic_column_mapping_id)
    REFERENCES public.semantic_column_mappings(organization_id, interpretation_snapshot_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, verified_field_id)
    REFERENCES public.extraction_verified_fields(organization_id, id) ON DELETE RESTRICT
);

CREATE TABLE public.extraction_step3_publication_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  extraction_run_id uuid NOT NULL,
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, extraction_run_id),
  FOREIGN KEY (organization_id, extraction_run_id)
    REFERENCES public.extraction_runs(organization_id, id) ON DELETE RESTRICT
);

INSERT INTO public.extraction_step3_publication_receipts (
  organization_id, extraction_run_id, content_hash
)
SELECT
  run.organization_id,
  run.id,
  encode(sha256(convert_to(jsonb_build_object(
    'fragment_dependencies', '[]'::jsonb,
    'structure_fragments', '[]'::jsonb,
    'structure_snapshot_members', '[]'::jsonb,
    'continuation_links', '[]'::jsonb,
    'table_chains', '[]'::jsonb,
    'table_sections', '[]'::jsonb,
    'arbitration_decisions', '[]'::jsonb,
    'interpretation_snapshot', 'null'::jsonb,
    'semantic_column_mappings', '[]'::jsonb,
    'interpretation_records', '[]'::jsonb
  )::text, 'UTF8')), 'hex')
FROM public.extraction_runs run
WHERE EXISTS (
  SELECT 1
  FROM public.extraction_snapshots snapshot
  WHERE snapshot.organization_id = run.organization_id
    AND snapshot.producing_run_id = run.id
);

ALTER TABLE public.document_interpretation_records
  ADD COLUMN semantic_column_mapping_id uuid;
ALTER TABLE public.document_interpretation_records
  DROP CONSTRAINT document_interpretation_records_type_check;
ALTER TABLE public.document_interpretation_records
  ADD CONSTRAINT document_interpretation_records_type_check CHECK (
    record_type IN (
      'canonical_fact', 'derived_fact', 'human_assertion', 'ambiguity', 'gap',
      'semantic_column_mapping'
    )
  );
ALTER TABLE public.document_interpretation_records
  DROP CONSTRAINT document_interpretation_records_target_check;
ALTER TABLE public.document_interpretation_records
  ADD CONSTRAINT document_interpretation_records_target_check CHECK (
    (record_type = 'ambiguity'
      AND num_nonnulls(canonical_fact_id, derived_fact_id, human_assertion_id,
        processing_gap_id, semantic_column_mapping_id) = 0)
    OR (record_type = 'canonical_fact' AND canonical_fact_id IS NOT NULL
      AND num_nonnulls(derived_fact_id, human_assertion_id, processing_gap_id,
        semantic_column_mapping_id) = 0)
    OR (record_type = 'derived_fact' AND derived_fact_id IS NOT NULL
      AND num_nonnulls(canonical_fact_id, human_assertion_id, processing_gap_id,
        semantic_column_mapping_id) = 0)
    OR (record_type = 'human_assertion' AND human_assertion_id IS NOT NULL
      AND num_nonnulls(canonical_fact_id, derived_fact_id, processing_gap_id,
        semantic_column_mapping_id) = 0)
    OR (record_type = 'gap' AND processing_gap_id IS NOT NULL
      AND num_nonnulls(canonical_fact_id, derived_fact_id, human_assertion_id,
        semantic_column_mapping_id) = 0)
    OR (record_type = 'semantic_column_mapping' AND semantic_column_mapping_id IS NOT NULL
      AND num_nonnulls(canonical_fact_id, derived_fact_id, human_assertion_id,
        processing_gap_id) = 0)
  );
ALTER TABLE public.document_interpretation_records
  ADD CONSTRAINT document_interpretation_records_mapping_fkey
  FOREIGN KEY (organization_id, interpretation_snapshot_id, semantic_column_mapping_id)
  REFERENCES public.semantic_column_mappings(
    organization_id, interpretation_snapshot_id, id
  ) ON DELETE RESTRICT;

ALTER TABLE public.extraction_snapshot_members
  ADD COLUMN continuation_link_id uuid,
  ADD COLUMN table_chain_id uuid,
  ADD COLUMN table_section_id uuid,
  ADD COLUMN arbitration_decision_id uuid;
ALTER TABLE public.extraction_snapshot_members
  DROP CONSTRAINT extraction_snapshot_members_kind_check;
ALTER TABLE public.extraction_snapshot_members
  ADD CONSTRAINT extraction_snapshot_members_kind_check CHECK (
    member_kind IN (
      'page', 'fragment', 'candidate', 'verified_field', 'gap',
      'continuation_link', 'table_chain', 'table_section', 'arbitration_decision'
    )
  );
ALTER TABLE public.extraction_snapshot_members
  DROP CONSTRAINT extraction_snapshot_members_one_target_check;
ALTER TABLE public.extraction_snapshot_members
  ADD CONSTRAINT extraction_snapshot_members_one_target_check CHECK (
    num_nonnulls(
      page_artifact_id, fragment_artifact_id, field_candidate_id, verified_field_id,
      processing_gap_id, continuation_link_id, table_chain_id, table_section_id,
      arbitration_decision_id
    ) = 1
    AND (
      (member_kind = 'page' AND page_artifact_id IS NOT NULL)
      OR (member_kind = 'fragment' AND fragment_artifact_id IS NOT NULL)
      OR (member_kind = 'candidate' AND field_candidate_id IS NOT NULL)
      OR (member_kind = 'verified_field' AND verified_field_id IS NOT NULL)
      OR (member_kind = 'gap' AND processing_gap_id IS NOT NULL)
      OR (member_kind = 'continuation_link' AND continuation_link_id IS NOT NULL)
      OR (member_kind = 'table_chain' AND table_chain_id IS NOT NULL)
      OR (member_kind = 'table_section' AND table_section_id IS NOT NULL)
      OR (member_kind = 'arbitration_decision' AND arbitration_decision_id IS NOT NULL)
    )
  );
ALTER TABLE public.extraction_snapshot_members
  ADD CONSTRAINT extraction_snapshot_members_link_fkey
    FOREIGN KEY (organization_id, continuation_link_id)
    REFERENCES public.extraction_table_continuation_links(organization_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT extraction_snapshot_members_chain_fkey
    FOREIGN KEY (organization_id, table_chain_id)
    REFERENCES public.extraction_table_chains(organization_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT extraction_snapshot_members_section_fkey
    FOREIGN KEY (organization_id, table_section_id)
    REFERENCES public.extraction_table_sections(organization_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT extraction_snapshot_members_arbitration_fkey
    FOREIGN KEY (organization_id, arbitration_decision_id)
    REFERENCES public.extraction_arbitration_decisions(organization_id, id) ON DELETE RESTRICT;

-- Fail-closed patch of the reviewed provenance trigger. Composite foreign keys
-- enforce edge identity; this branch independently verifies repeated identity.
DO $migration$
DECLARE
  function_body text;
  replaced_body text;
  old_branch constant text := $old$
  ELSIF TG_TABLE_NAME = 'extraction_processing_gaps' THEN
$old$;
  new_branch constant text := $new$
  ELSIF TG_TABLE_NAME IN (
    'extraction_table_continuation_links', 'extraction_table_chains',
    'extraction_table_sections', 'extraction_arbitration_decisions'
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
      RAISE EXCEPTION '% provenance does not close to one source/run/manifest/attempt',
        TG_TABLE_NAME USING ERRCODE = '23514';
    END IF;
  ELSIF TG_TABLE_NAME = 'extraction_processing_gaps' THEN
$new$;
BEGIN
  SELECT prosrc INTO function_body
  FROM pg_proc
  WHERE oid = 'public.enforce_extraction_provenance_integrity()'::regprocedure;
  replaced_body := replace(function_body, old_branch, new_branch);
  IF replaced_body = function_body THEN
    RAISE EXCEPTION 'expected provenance trigger branch was not found'
      USING ERRCODE = '23514';
  END IF;
  EXECUTE format(
    'CREATE OR REPLACE FUNCTION public.enforce_extraction_provenance_integrity()
       RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = ''''
       AS %L', replaced_body
  );
END;
$migration$;

REVOKE ALL ON FUNCTION public.enforce_extraction_provenance_integrity() FROM PUBLIC;

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'extraction_table_continuation_links', 'extraction_table_chains',
    'extraction_table_sections', 'extraction_arbitration_decisions'
  ] LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE INSERT OR UPDATE ON public.%I
       FOR EACH ROW EXECUTE FUNCTION public.enforce_extraction_provenance_integrity()',
      'trg_' || table_name || '_provenance_integrity', table_name
    );
  END LOOP;
END;
$$;

-- Extend the reviewed deferred-closure trigger via an exact, fail-closed body
-- replacement. New normalized edges close each artifact to same-run inputs.
DO $migration$
DECLARE
  function_body text;
  replaced_body text;
  old_branch constant text := $old$
  ELSIF TG_TABLE_NAME = 'derived_document_facts' THEN
$old$;
  new_branch constant text := $new$
  ELSIF TG_TABLE_NAME = 'extraction_fragment_artifacts' THEN
    IF NEW.kind NOT IN ('cell', 'region') THEN
      RETURN NULL;
    END IF;
    SELECT count(*) INTO dependency_count
    FROM public.extraction_fragment_dependencies
    WHERE organization_id = NEW.organization_id
      AND extraction_run_id = NEW.extraction_run_id
      AND fragment_artifact_id = NEW.id;
  ELSIF TG_TABLE_NAME = 'extraction_table_continuation_links' THEN
    SELECT count(*) INTO dependency_count
    FROM public.extraction_table_continuation_link_basis_fragments
    WHERE organization_id = NEW.organization_id
      AND extraction_run_id = NEW.extraction_run_id
      AND continuation_link_id = NEW.id;
  ELSIF TG_TABLE_NAME = 'extraction_table_chains' THEN
    SELECT count(*) INTO dependency_count
    FROM public.extraction_table_chain_segments
    WHERE organization_id = NEW.organization_id
      AND extraction_run_id = NEW.extraction_run_id
      AND table_chain_id = NEW.id;
    IF NEW.completeness <> 'complete' AND NOT EXISTS (
      SELECT 1
      FROM public.extraction_table_chain_gaps gap
      WHERE gap.organization_id = NEW.organization_id
        AND gap.extraction_run_id = NEW.extraction_run_id
        AND gap.table_chain_id = NEW.id
    ) THEN
      RAISE EXCEPTION 'partial or ambiguous table chains require an explicit gap'
        USING ERRCODE = '23514';
    END IF;
  ELSIF TG_TABLE_NAME = 'extraction_table_sections' THEN
    SELECT count(*) INTO dependency_count
    FROM public.extraction_table_section_rows
    WHERE organization_id = NEW.organization_id
      AND extraction_run_id = NEW.extraction_run_id
      AND table_section_id = NEW.id;
  ELSIF TG_TABLE_NAME = 'extraction_arbitration_decisions' THEN
    SELECT count(*) INTO dependency_count
    FROM public.extraction_arbitration_decision_candidates
    WHERE organization_id = NEW.organization_id
      AND extraction_run_id = NEW.extraction_run_id
      AND arbitration_decision_id = NEW.id;
    SELECT count(*) FILTER (WHERE disposition = 'accepted')
      INTO primary_count
    FROM public.extraction_arbitration_decision_candidates
    WHERE organization_id = NEW.organization_id
      AND extraction_run_id = NEW.extraction_run_id
      AND arbitration_decision_id = NEW.id;
    IF (NEW.decision = 'consensus' AND primary_count < 2)
      OR (NEW.decision = 'single_source' AND primary_count <> 1)
      OR (NEW.decision IN ('conflict', 'unresolved') AND primary_count <> 0) THEN
      RAISE EXCEPTION 'arbitration decision has an invalid accepted-candidate partition'
        USING ERRCODE = '23514';
    END IF;
  ELSIF TG_TABLE_NAME = 'semantic_column_mappings' THEN
    SELECT count(*) FILTER (WHERE field_role = 'cell') INTO dependency_count
    FROM public.semantic_column_mapping_fields
    WHERE organization_id = NEW.organization_id
      AND interpretation_snapshot_id = NEW.interpretation_snapshot_id
      AND semantic_column_mapping_id = NEW.id;
    IF NOT EXISTS (
      SELECT 1
      FROM public.document_interpretation_snapshots interpretation
      JOIN public.extraction_snapshots snapshot
        ON snapshot.organization_id = interpretation.organization_id
       AND snapshot.id = interpretation.extraction_snapshot_id
      JOIN public.extraction_table_chains chain
        ON chain.organization_id = interpretation.organization_id
       AND chain.id = NEW.table_chain_id
       AND chain.extraction_run_id = snapshot.producing_run_id
      WHERE interpretation.organization_id = NEW.organization_id
        AND interpretation.id = NEW.interpretation_snapshot_id
    ) THEN
      RAISE EXCEPTION 'semantic column mapping chain must belong to its extraction snapshot'
        USING ERRCODE = '23514';
    END IF;
    IF EXISTS (
      SELECT 1
      FROM public.semantic_column_mapping_fields mf
      JOIN public.document_interpretation_snapshots interpretation
        ON interpretation.organization_id = mf.organization_id
       AND interpretation.id = mf.interpretation_snapshot_id
      JOIN public.extraction_snapshots snapshot
        ON snapshot.organization_id = interpretation.organization_id
       AND snapshot.id = interpretation.extraction_snapshot_id
      JOIN public.extraction_verified_fields vf
        ON vf.organization_id = mf.organization_id
       AND vf.id = mf.verified_field_id
      WHERE mf.organization_id = NEW.organization_id
        AND mf.interpretation_snapshot_id = NEW.interpretation_snapshot_id
        AND mf.semantic_column_mapping_id = NEW.id
        AND (
          vf.extraction_run_id <> snapshot.producing_run_id
          OR NOT EXISTS (
            SELECT 1 FROM public.extraction_snapshot_members member
            WHERE member.organization_id = vf.organization_id
              AND member.extraction_snapshot_id = snapshot.id
              AND member.member_kind = 'verified_field'
              AND member.verified_field_id = vf.id
          )
        )
    ) THEN
      RAISE EXCEPTION 'semantic column mapping fields must close to verified snapshot members'
        USING ERRCODE = '23514';
    END IF;
  ELSIF TG_TABLE_NAME = 'derived_document_facts' THEN
$new$;
BEGIN
  SELECT prosrc INTO function_body
  FROM pg_proc
  WHERE oid = 'public.check_extraction_dependency_closure()'::regprocedure;
  replaced_body := replace(function_body, old_branch, new_branch);
  IF replaced_body = function_body THEN
    RAISE EXCEPTION 'expected dependency-closure trigger branch was not found'
      USING ERRCODE = '23514';
  END IF;
  EXECUTE format(
    'CREATE OR REPLACE FUNCTION public.check_extraction_dependency_closure()
       RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = ''''
       AS %L', replaced_body
  );
END;
$migration$;

REVOKE ALL ON FUNCTION public.check_extraction_dependency_closure() FROM PUBLIC;

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'extraction_fragment_artifacts',
    'extraction_table_continuation_links', 'extraction_table_chains',
    'extraction_table_sections', 'extraction_arbitration_decisions',
    'semantic_column_mappings'
  ] LOOP
    EXECUTE format(
      'CREATE CONSTRAINT TRIGGER %I AFTER INSERT ON public.%I
       DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
       EXECUTE FUNCTION public.check_extraction_dependency_closure()',
      'trg_' || table_name || '_closure', table_name
    );
  END LOOP;
END;
$$;

-- Extend the reviewed snapshot-member branch with the new immutable targets.
DO $migration$
DECLARE
  function_body text;
  replaced_body text;
  old_else constant text := $old$
    ELSE
      SELECT extraction_run_id INTO target_run_id FROM public.extraction_processing_gaps
        WHERE organization_id = NEW.organization_id AND id = NEW.processing_gap_id;
    END IF;
$old$;
  new_else constant text := $new$
    ELSIF NEW.member_kind = 'gap' THEN
      SELECT extraction_run_id INTO target_run_id FROM public.extraction_processing_gaps
        WHERE organization_id = NEW.organization_id AND id = NEW.processing_gap_id;
    ELSIF NEW.member_kind = 'continuation_link' THEN
      SELECT extraction_run_id INTO target_run_id FROM public.extraction_table_continuation_links
        WHERE organization_id = NEW.organization_id AND id = NEW.continuation_link_id;
    ELSIF NEW.member_kind = 'table_chain' THEN
      SELECT extraction_run_id INTO target_run_id FROM public.extraction_table_chains
        WHERE organization_id = NEW.organization_id AND id = NEW.table_chain_id;
    ELSIF NEW.member_kind = 'table_section' THEN
      SELECT extraction_run_id INTO target_run_id FROM public.extraction_table_sections
        WHERE organization_id = NEW.organization_id AND id = NEW.table_section_id;
    ELSE
      SELECT extraction_run_id INTO target_run_id FROM public.extraction_arbitration_decisions
        WHERE organization_id = NEW.organization_id AND id = NEW.arbitration_decision_id;
    END IF;
$new$;
BEGIN
  SELECT prosrc INTO function_body
  FROM pg_proc
  WHERE oid = 'public.enforce_extraction_provenance_integrity()'::regprocedure;
  replaced_body := replace(function_body, old_else, new_else);
  IF replaced_body = function_body THEN
    RAISE EXCEPTION 'expected snapshot-member provenance branch was not found'
      USING ERRCODE = '23514';
  END IF;
  EXECUTE format(
    'CREATE OR REPLACE FUNCTION public.enforce_extraction_provenance_integrity()
       RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = ''''
       AS %L', replaced_body
  );
END;
$migration$;

-- Interpretation gap records must close to the same producing run as their
-- interpretation snapshot. Patch the reviewed provenance function exactly.
DO $migration$
DECLARE
  function_body text;
  replaced_body text;
  old_branch constant text := $old$
  ELSIF TG_TABLE_NAME = 'document_projection_stamps' THEN
$old$;
  new_branch constant text := $new$
  ELSIF TG_TABLE_NAME = 'document_interpretation_records' THEN
    IF NEW.record_type = 'gap' AND NOT EXISTS (
      SELECT 1
      FROM public.document_interpretation_snapshots interpretation
      JOIN public.extraction_snapshots snapshot
        ON snapshot.organization_id = interpretation.organization_id
       AND snapshot.id = interpretation.extraction_snapshot_id
      JOIN public.extraction_processing_gaps gap
        ON gap.organization_id = interpretation.organization_id
       AND gap.id = NEW.processing_gap_id
       AND gap.extraction_run_id = snapshot.producing_run_id
      WHERE interpretation.organization_id = NEW.organization_id
        AND interpretation.id = NEW.interpretation_snapshot_id
    ) THEN
      RAISE EXCEPTION 'interpretation gap must belong to its extraction snapshot run'
        USING ERRCODE = '23514';
    END IF;
  ELSIF TG_TABLE_NAME = 'document_projection_stamps' THEN
$new$;
BEGIN
  SELECT prosrc INTO function_body
  FROM pg_proc
  WHERE oid = 'public.enforce_extraction_provenance_integrity()'::regprocedure;
  replaced_body := replace(function_body, old_branch, new_branch);
  IF replaced_body = function_body THEN
    RAISE EXCEPTION 'expected interpretation provenance insertion point was not found'
      USING ERRCODE = '23514';
  END IF;
  EXECUTE format(
    'CREATE OR REPLACE FUNCTION public.enforce_extraction_provenance_integrity()
       RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = ''''
       AS %L', replaced_body
  );
END;
$migration$;

REVOKE ALL ON FUNCTION public.enforce_extraction_provenance_integrity() FROM PUBLIC;

CREATE TRIGGER trg_document_interpretation_records_provenance_integrity
  BEFORE INSERT OR UPDATE ON public.document_interpretation_records
  FOR EACH ROW EXECUTE FUNCTION public.enforce_extraction_provenance_integrity();

-- Extend the transactional Step 1 publisher because extraction snapshots are
-- immutable and cannot be augmented safely by a second publication RPC.
DO $migration$
DECLARE
  function_body text;
  replaced_body text;
  old_declare constant text := $old$
  assignment_updated boolean := false;
BEGIN
$old$;
  new_declare constant text := $new$
  assignment_updated boolean := false;
  step3_content_hash text;
  interpretation_id uuid;
  mapping jsonb;
  step3_dependency jsonb;
BEGIN
  step3_content_hash := encode(sha256(convert_to(jsonb_build_object(
    'fragment_dependencies', COALESCE(payload->'fragment_dependencies', '[]'::jsonb),
    'structure_fragments', COALESCE((
      SELECT jsonb_agg(fragment ORDER BY fragment->>'id')
      FROM jsonb_array_elements(COALESCE(payload->'fragments', '[]'::jsonb))
        AS source(fragment)
      WHERE fragment->>'kind' IN ('cell', 'region')
    ), '[]'::jsonb),
    'structure_snapshot_members', COALESCE((
      SELECT jsonb_agg(member ORDER BY (member->>'sequence')::integer)
      FROM jsonb_array_elements(COALESCE(payload->'snapshot_members', '[]'::jsonb))
        AS source(member)
      WHERE member->>'member_kind' IN (
        'continuation_link', 'table_chain', 'table_section',
        'arbitration_decision'
      )
      OR (
        member->>'member_kind' = 'fragment'
        AND member->>'fragment_artifact_id' IN (
          SELECT fragment->>'id'
          FROM jsonb_array_elements(COALESCE(payload->'fragments', '[]'::jsonb))
            AS fragments(fragment)
          WHERE fragment->>'kind' IN ('cell', 'region')
        )
      )
    ), '[]'::jsonb),
    'continuation_links', COALESCE(payload->'continuation_links', '[]'::jsonb),
    'table_chains', COALESCE(payload->'table_chains', '[]'::jsonb),
    'table_sections', COALESCE(payload->'table_sections', '[]'::jsonb),
    'arbitration_decisions', COALESCE(payload->'arbitration_decisions', '[]'::jsonb),
    'interpretation_snapshot', COALESCE(payload->'interpretation_snapshot', 'null'::jsonb),
    'semantic_column_mappings', COALESCE(payload->'semantic_column_mappings', '[]'::jsonb),
    'interpretation_records', COALESCE(payload->'interpretation_records', '[]'::jsonb)
  )::text, 'UTF8')), 'hex');
$new$;
  old_reuse constant text := $old$
  IF run_row.id IS NOT NULL THEN
    IF run_row.source_artifact_id <> source_id
$old$;
  new_reuse constant text := $new$
  IF run_row.id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.extraction_step3_publication_receipts receipt
      WHERE receipt.organization_id = org_id
        AND receipt.extraction_run_id = run_row.id
        AND receipt.content_hash = step3_content_hash
    ) THEN
      RAISE EXCEPTION 'Step 3 idempotency key was reused with divergent table content'
        USING ERRCODE = '23514';
    END IF;
    IF run_row.source_artifact_id <> source_id
$new$;
  old_semantic_reuse constant text := $old$
  IF snapshot_row.id IS NOT NULL THEN
    IF snapshot_row.id <> snapshot_id
$old$;
  new_semantic_reuse constant text := $new$
  IF snapshot_row.id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.extraction_step3_publication_receipts receipt
      WHERE receipt.organization_id = org_id
        AND receipt.extraction_run_id = snapshot_row.producing_run_id
        AND receipt.content_hash = step3_content_hash
    ) THEN
      RAISE EXCEPTION 'deterministic Step 3 semantic snapshot diverged'
        USING ERRCODE = '23514';
    END IF;
    IF snapshot_row.id <> snapshot_id
$new$;
  old_after_run constant text := $old$
  );

  FOR item IN SELECT value FROM jsonb_array_elements(payload->'pages')
$old$;
  new_after_run constant text := $new$
  );

  INSERT INTO public.extraction_step3_publication_receipts (
    organization_id, extraction_run_id, content_hash
  ) VALUES (org_id, run_id, step3_content_hash);

  FOR item IN SELECT value FROM jsonb_array_elements(payload->'pages')
$new$;
  old_before_run_state constant text := $old$
  FOR item IN SELECT value FROM jsonb_array_elements(payload->'gaps')
$old$;
  new_before_run_state constant text := $new$
  FOR item IN SELECT value FROM jsonb_array_elements(payload->'fragment_dependencies')
  LOOP
    INSERT INTO public.extraction_fragment_dependencies (
      organization_id, extraction_run_id, fragment_artifact_id,
      dependency_fragment_artifact_id, sequence
    )
    SELECT org_id, run_id, (item->>'fragment_artifact_id')::uuid,
      value::text::uuid, ordinality
    FROM jsonb_array_elements_text(item->'dependency_fragment_ids')
      WITH ORDINALITY AS source(value, ordinality);
  END LOOP;

  FOR item IN SELECT value FROM jsonb_array_elements(payload->'continuation_links')
  LOOP
    INSERT INTO public.extraction_table_continuation_links (
      id, organization_id, extraction_run_id, source_artifact_id,
      source_document_id, source_sha256, parser_manifest_hash, parser,
      from_segment_id, to_segment_id, basis, score, decision
    ) VALUES (
      (item->>'id')::uuid, org_id, run_id, source_id, document_id,
      payload->>'source_sha256', payload->>'parser_manifest_hash', item->'parser',
      (item->>'from_segment_id')::uuid, (item->>'to_segment_id')::uuid,
      item->'basis', item->'score', item->>'decision'
    );
    FOR step3_dependency IN SELECT value FROM jsonb_array_elements(item->'basis_fragments')
    LOOP
      INSERT INTO public.extraction_table_continuation_link_basis_fragments (
        organization_id, extraction_run_id, continuation_link_id, basis_kind,
        fragment_artifact_id, sequence
      ) VALUES (
        org_id, run_id, (item->>'id')::uuid, step3_dependency->>'basis_kind',
        (step3_dependency->>'fragment_artifact_id')::uuid,
        (step3_dependency->>'sequence')::integer
      );
    END LOOP;
  END LOOP;

  FOR item IN SELECT value FROM jsonb_array_elements(payload->'table_chains')
  LOOP
    INSERT INTO public.extraction_table_chains (
      id, organization_id, extraction_run_id, source_artifact_id,
      source_document_id, source_sha256, parser_manifest_hash, parser, completeness
    ) VALUES (
      (item->>'id')::uuid, org_id, run_id, source_id, document_id,
      payload->>'source_sha256', payload->>'parser_manifest_hash',
      item->'parser', item->>'completeness'
    );
    INSERT INTO public.extraction_table_chain_segments (
      organization_id, extraction_run_id, table_chain_id, segment_id, sequence
    )
    SELECT org_id, run_id, (item->>'id')::uuid, value::text::uuid, ordinality
    FROM jsonb_array_elements_text(item->'segment_ids')
      WITH ORDINALITY AS source(value, ordinality);
    INSERT INTO public.extraction_table_chain_links (
      organization_id, extraction_run_id, table_chain_id, continuation_link_id, sequence
    )
    SELECT org_id, run_id, (item->>'id')::uuid, value::text::uuid, ordinality
    FROM jsonb_array_elements_text(item->'continuation_link_ids')
      WITH ORDINALITY AS source(value, ordinality);
    INSERT INTO public.extraction_table_chain_gaps (
      organization_id, extraction_run_id, table_chain_id, processing_gap_id, sequence
    )
    SELECT org_id, run_id, (item->>'id')::uuid, value::text::uuid, ordinality
    FROM jsonb_array_elements_text(item->'gap_ids')
      WITH ORDINALITY AS source(value, ordinality);
  END LOOP;

  FOR item IN SELECT value FROM jsonb_array_elements(payload->'table_sections')
  LOOP
    INSERT INTO public.extraction_table_sections (
      id, organization_id, extraction_run_id, source_artifact_id,
      source_document_id, source_sha256, parser_manifest_hash, parser,
      table_chain_id, header_row_id, sequence
    ) VALUES (
      (item->>'id')::uuid, org_id, run_id, source_id, document_id,
      payload->>'source_sha256', payload->>'parser_manifest_hash', item->'parser',
      (item->>'table_chain_id')::uuid, (item->>'header_row_id')::uuid,
      (item->>'sequence')::integer
    );
    INSERT INTO public.extraction_table_section_rows (
      organization_id, extraction_run_id, table_section_id, row_id, sequence
    )
    SELECT org_id, run_id, (item->>'id')::uuid, value::text::uuid, ordinality
    FROM jsonb_array_elements_text(item->'member_row_ids')
      WITH ORDINALITY AS source(value, ordinality);
    INSERT INTO public.extraction_table_section_child_chains (
      organization_id, extraction_run_id, table_section_id, child_table_chain_id, sequence
    )
    SELECT org_id, run_id, (item->>'id')::uuid, value::text::uuid, ordinality
    FROM jsonb_array_elements_text(item->'child_table_chain_ids')
      WITH ORDINALITY AS source(value, ordinality);
  END LOOP;

  FOR item IN SELECT value FROM jsonb_array_elements(payload->'arbitration_decisions')
  LOOP
    INSERT INTO public.extraction_arbitration_decisions (
      id, organization_id, extraction_run_id, source_artifact_id,
      source_document_id, source_sha256, parser_manifest_hash, parser,
      page_artifact_id, physical_region_id, processing_gap_id,
      agreement, decision, diagnostics
    ) VALUES (
      (item->>'id')::uuid, org_id, run_id, source_id, document_id,
      payload->>'source_sha256', payload->>'parser_manifest_hash', item->'parser',
      (item->>'page_artifact_id')::uuid, (item->>'physical_region_id')::uuid,
      (item->>'processing_gap_id')::uuid,
      NULLIF(item->'agreement', 'null'::jsonb),
      item->>'decision', item->'diagnostics'
    );
    FOR step3_dependency IN SELECT value FROM jsonb_array_elements(item->'candidates')
    LOOP
      INSERT INTO public.extraction_arbitration_decision_candidates (
        organization_id, extraction_run_id, arbitration_decision_id,
        candidate_fragment_id, disposition, sequence
      ) VALUES (
        org_id, run_id, (item->>'id')::uuid,
        (step3_dependency->>'candidate_fragment_id')::uuid,
        step3_dependency->>'disposition', (step3_dependency->>'sequence')::integer
      );
    END LOOP;
  END LOOP;

  FOR item IN SELECT value FROM jsonb_array_elements(payload->'gaps')
$new$;
BEGIN
  SELECT prosrc INTO function_body
  FROM pg_proc
  WHERE oid = 'public.publish_extraction_step1_shadow(jsonb)'::regprocedure;

  replaced_body := replace(function_body, old_declare, new_declare);
  IF replaced_body = function_body THEN
    RAISE EXCEPTION 'expected Step 1 publisher declaration was not found' USING ERRCODE = '23514';
  END IF;
  function_body := replaced_body;
  replaced_body := replace(function_body, old_reuse, new_reuse);
  IF replaced_body = function_body THEN
    RAISE EXCEPTION 'expected Step 1 idempotency branch was not found' USING ERRCODE = '23514';
  END IF;
  function_body := replaced_body;
  replaced_body := replace(function_body, old_semantic_reuse, new_semantic_reuse);
  IF replaced_body = function_body THEN
    RAISE EXCEPTION 'expected Step 1 semantic-reuse branch was not found' USING ERRCODE = '23514';
  END IF;
  function_body := replaced_body;
  replaced_body := replace(function_body, old_after_run, new_after_run);
  IF replaced_body = function_body THEN
    RAISE EXCEPTION 'expected Step 1 post-run insertion point was not found' USING ERRCODE = '23514';
  END IF;
  function_body := replaced_body;
  replaced_body := replace(function_body, old_before_run_state, new_before_run_state);
  IF replaced_body = function_body THEN
    RAISE EXCEPTION 'expected Step 1 gap loop was not found' USING ERRCODE = '23514';
  END IF;

  EXECUTE format(
    'CREATE OR REPLACE FUNCTION public.publish_extraction_step1_shadow(payload jsonb)
       RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''''
       AS %L', replaced_body
  );
END;
$migration$;

DO $migration$
DECLARE
  function_body text;
  replaced_body text;
  old_validation constant text := $old$
    OR jsonb_typeof(COALESCE(payload->'snapshot_members', 'null'::jsonb)) <> 'array' THEN
$old$;
  new_validation constant text := $new$
    OR jsonb_typeof(COALESCE(payload->'snapshot_members', 'null'::jsonb)) <> 'array'
    OR jsonb_typeof(COALESCE(payload->'fragment_dependencies', '[]'::jsonb)) <> 'array'
    OR jsonb_typeof(COALESCE(payload->'continuation_links', '[]'::jsonb)) <> 'array'
    OR jsonb_typeof(COALESCE(payload->'table_chains', '[]'::jsonb)) <> 'array'
    OR jsonb_typeof(COALESCE(payload->'table_sections', '[]'::jsonb)) <> 'array'
    OR jsonb_typeof(COALESCE(payload->'arbitration_decisions', '[]'::jsonb)) <> 'array'
    OR jsonb_typeof(COALESCE(payload->'semantic_column_mappings', '[]'::jsonb)) <> 'array'
    OR jsonb_typeof(COALESCE(payload->'interpretation_records', '[]'::jsonb)) <> 'array'
    OR (
      payload->'interpretation_snapshot' IS NOT NULL
      AND jsonb_typeof(payload->'interpretation_snapshot') <> 'object'
    ) THEN
$new$;
  old_member_columns constant text := $old$
      verified_field_id, processing_gap_id, dependency_hash, sequence
    ) VALUES (
      org_id, snapshot_id, item->>'member_kind',
      (item->>'page_artifact_id')::uuid,
      (item->>'fragment_artifact_id')::uuid,
      (item->>'field_candidate_id')::uuid,
      (item->>'verified_field_id')::uuid,
      (item->>'processing_gap_id')::uuid,
      item->>'dependency_hash', (item->>'sequence')::integer
$old$;
  new_member_columns constant text := $new$
      verified_field_id, processing_gap_id, continuation_link_id,
      table_chain_id, table_section_id, arbitration_decision_id,
      dependency_hash, sequence
    ) VALUES (
      org_id, snapshot_id, item->>'member_kind',
      (item->>'page_artifact_id')::uuid,
      (item->>'fragment_artifact_id')::uuid,
      (item->>'field_candidate_id')::uuid,
      (item->>'verified_field_id')::uuid,
      (item->>'processing_gap_id')::uuid,
      (item->>'continuation_link_id')::uuid,
      (item->>'table_chain_id')::uuid,
      (item->>'table_section_id')::uuid,
      (item->>'arbitration_decision_id')::uuid,
      item->>'dependency_hash', (item->>'sequence')::integer
$new$;
  old_count constant text := $old$
    + (SELECT count(*) FROM public.extraction_processing_gaps
      WHERE organization_id = org_id AND extraction_run_id = run_id)
$old$;
  new_count constant text := $new$
    + (SELECT count(*) FROM public.extraction_processing_gaps
      WHERE organization_id = org_id AND extraction_run_id = run_id)
    + (SELECT count(*) FROM public.extraction_table_continuation_links
      WHERE organization_id = org_id AND extraction_run_id = run_id)
    + (SELECT count(*) FROM public.extraction_table_chains
      WHERE organization_id = org_id AND extraction_run_id = run_id)
    + (SELECT count(*) FROM public.extraction_table_sections
      WHERE organization_id = org_id AND extraction_run_id = run_id)
    + (SELECT count(*) FROM public.extraction_arbitration_decisions
      WHERE organization_id = org_id AND extraction_run_id = run_id)
$new$;
  old_first_union constant text := $old$
      SELECT 'gap', id FROM public.extraction_processing_gaps
      WHERE organization_id = org_id AND extraction_run_id = run_id
$old$;
  new_first_union constant text := $new$
      SELECT 'gap', id FROM public.extraction_processing_gaps
      WHERE organization_id = org_id AND extraction_run_id = run_id
      UNION ALL
      SELECT 'continuation_link', id FROM public.extraction_table_continuation_links
      WHERE organization_id = org_id AND extraction_run_id = run_id
      UNION ALL
      SELECT 'table_chain', id FROM public.extraction_table_chains
      WHERE organization_id = org_id AND extraction_run_id = run_id
      UNION ALL
      SELECT 'table_section', id FROM public.extraction_table_sections
      WHERE organization_id = org_id AND extraction_run_id = run_id
      UNION ALL
      SELECT 'arbitration_decision', id FROM public.extraction_arbitration_decisions
      WHERE organization_id = org_id AND extraction_run_id = run_id
$new$;
  old_member_coalesce constant text := $old$
      member.processing_gap_id
    )
$old$;
  new_member_coalesce constant text := $new$
      member.processing_gap_id, member.continuation_link_id, member.table_chain_id,
      member.table_section_id, member.arbitration_decision_id
    )
$new$;
  old_member_coalesce_second constant text := $old$
        member.processing_gap_id
      ) AS artifact_id
$old$;
  new_member_coalesce_second constant text := $new$
        member.processing_gap_id, member.continuation_link_id, member.table_chain_id,
        member.table_section_id, member.arbitration_decision_id
      ) AS artifact_id
$new$;
  old_before_assignment constant text := $old$
  ) THEN
    RAISE EXCEPTION 'Step 1 snapshot members do not exactly close the published artifact graph'
      USING ERRCODE = '23514';
  END IF;

  INSERT INTO public.document_extraction_snapshot_assignments (
$old$;
  new_before_assignment constant text := $new$
  ) THEN
    RAISE EXCEPTION 'Step 1 snapshot members do not exactly close the published artifact graph'
      USING ERRCODE = '23514';
  END IF;

  IF payload->'interpretation_snapshot' IS NOT NULL THEN
    interpretation_id := (payload#>>'{interpretation_snapshot,id}')::uuid;
    INSERT INTO public.document_interpretation_snapshots (
      id, organization_id, source_document_id, extraction_snapshot_id,
      interpreter_manifest_hash, entity_resolver_version, effective_truth_set_hash,
      status, output_root_hash, published_at
    ) VALUES (
      interpretation_id, org_id, document_id, snapshot_id,
      payload#>>'{interpretation_snapshot,interpreter_manifest_hash}',
      payload#>>'{interpretation_snapshot,entity_resolver_version}',
      payload#>>'{interpretation_snapshot,effective_truth_set_hash}',
      payload#>>'{interpretation_snapshot,status}',
      payload#>>'{interpretation_snapshot,output_root_hash}',
      (payload#>>'{interpretation_snapshot,published_at}')::timestamptz
    );
    FOR mapping IN SELECT value FROM jsonb_array_elements(payload->'semantic_column_mappings')
    LOOP
      INSERT INTO public.semantic_column_mappings (
        id, organization_id, interpretation_snapshot_id, table_chain_id,
        column_index, domain_role, assessment, status,
        interpretation_rule_id, interpretation_rule_version
      ) VALUES (
        (mapping->>'id')::uuid, org_id, interpretation_id,
        (mapping->>'table_chain_id')::uuid, (mapping->>'column_index')::integer,
        mapping->>'domain_role', mapping->'assessment', mapping->>'status',
        mapping->>'interpretation_rule_id', mapping->>'interpretation_rule_version'
      );
      INSERT INTO public.semantic_column_mapping_fields (
        organization_id, interpretation_snapshot_id, semantic_column_mapping_id,
        verified_field_id, field_role, sequence
      )
      SELECT org_id, interpretation_id, (mapping->>'id')::uuid,
        value::text::uuid, 'header', ordinality
      FROM jsonb_array_elements_text(mapping->'header_verified_field_ids')
        WITH ORDINALITY AS source(value, ordinality);
      INSERT INTO public.semantic_column_mapping_fields (
        organization_id, interpretation_snapshot_id, semantic_column_mapping_id,
        verified_field_id, field_role, sequence
      )
      SELECT org_id, interpretation_id, (mapping->>'id')::uuid,
        value::text::uuid, 'cell', ordinality
      FROM jsonb_array_elements_text(mapping->'cell_verified_field_ids')
        WITH ORDINALITY AS source(value, ordinality);
    END LOOP;
    FOR item IN SELECT value FROM jsonb_array_elements(payload->'interpretation_records')
    LOOP
      INSERT INTO public.document_interpretation_records (
        id, organization_id, interpretation_snapshot_id, record_type,
        canonical_fact_id, derived_fact_id, human_assertion_id, processing_gap_id,
        semantic_column_mapping_id, record_data, sequence
      ) VALUES (
        (item->>'id')::uuid, org_id, interpretation_id, item->>'record_type',
        (item->>'canonical_fact_id')::uuid, (item->>'derived_fact_id')::uuid,
        (item->>'human_assertion_id')::uuid, (item->>'processing_gap_id')::uuid,
        (item->>'semantic_column_mapping_id')::uuid,
        COALESCE(item->'record_data', '{}'::jsonb), (item->>'sequence')::integer
      );
    END LOOP;
    IF EXISTS (
      (SELECT id FROM public.semantic_column_mappings
       WHERE organization_id = org_id AND interpretation_snapshot_id = interpretation_id
       EXCEPT
       SELECT semantic_column_mapping_id FROM public.document_interpretation_records
       WHERE organization_id = org_id AND interpretation_snapshot_id = interpretation_id
         AND record_type = 'semantic_column_mapping')
      UNION ALL
      (SELECT semantic_column_mapping_id FROM public.document_interpretation_records
       WHERE organization_id = org_id AND interpretation_snapshot_id = interpretation_id
         AND record_type = 'semantic_column_mapping'
       EXCEPT
       SELECT id FROM public.semantic_column_mappings
       WHERE organization_id = org_id AND interpretation_snapshot_id = interpretation_id)
    ) THEN
      RAISE EXCEPTION 'Step 3 interpretation records do not exactly close mappings'
        USING ERRCODE = '23514';
    END IF;
  ELSIF jsonb_array_length(payload->'semantic_column_mappings') <> 0
    OR jsonb_array_length(payload->'interpretation_records') <> 0 THEN
    RAISE EXCEPTION 'Step 3 mappings require an interpretation snapshot'
      USING ERRCODE = '23514';
  END IF;

  INSERT INTO public.document_extraction_snapshot_assignments (
$new$;
BEGIN
  SELECT prosrc INTO function_body
  FROM pg_proc
  WHERE oid = 'public.publish_extraction_step1_shadow(jsonb)'::regprocedure;
  replaced_body := replace(function_body, old_validation, new_validation);
  IF replaced_body = function_body THEN
    RAISE EXCEPTION 'expected Step 1 collection validation was not found' USING ERRCODE = '23514';
  END IF;
  function_body := replaced_body;
  replaced_body := replace(function_body, old_member_columns, new_member_columns);
  IF replaced_body = function_body THEN
    RAISE EXCEPTION 'expected Step 1 snapshot-member insert was not found' USING ERRCODE = '23514';
  END IF;
  function_body := replaced_body;
  replaced_body := replace(function_body, old_count, new_count);
  IF replaced_body = function_body THEN
    RAISE EXCEPTION 'expected Step 1 snapshot count closure was not found' USING ERRCODE = '23514';
  END IF;
  function_body := replaced_body;
  replaced_body := replace(function_body, old_first_union, new_first_union);
  IF replaced_body = function_body THEN
    RAISE EXCEPTION 'expected Step 1 artifact union was not found' USING ERRCODE = '23514';
  END IF;
  function_body := replaced_body;
  replaced_body := replace(function_body, old_member_coalesce, new_member_coalesce);
  IF replaced_body = function_body THEN
    RAISE EXCEPTION 'expected Step 1 member target coalesce was not found' USING ERRCODE = '23514';
  END IF;
  function_body := replaced_body;
  replaced_body := replace(
    function_body,
    old_member_coalesce_second,
    new_member_coalesce_second
  );
  IF replaced_body = function_body THEN
    RAISE EXCEPTION 'expected Step 1 reverse member target coalesce was not found'
      USING ERRCODE = '23514';
  END IF;
  function_body := replaced_body;
  replaced_body := replace(function_body, old_before_assignment, new_before_assignment);
  IF replaced_body = function_body THEN
    RAISE EXCEPTION 'expected Step 1 assignment insertion point was not found' USING ERRCODE = '23514';
  END IF;
  EXECUTE format(
    'CREATE OR REPLACE FUNCTION public.publish_extraction_step1_shadow(payload jsonb)
       RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''''
       AS %L', replaced_body
  );
END;
$migration$;

REVOKE ALL ON FUNCTION public.publish_extraction_step1_shadow(jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.publish_extraction_step1_shadow(jsonb)
  TO service_role;

-- RLS, read-only grants, and append-only enforcement exactly mirror Step 0.
DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'extraction_table_continuation_links',
    'extraction_table_continuation_link_basis_fragments',
    'extraction_table_chains', 'extraction_table_chain_segments',
    'extraction_table_chain_links', 'extraction_table_chain_gaps',
    'extraction_table_sections', 'extraction_table_section_rows',
    'extraction_table_section_child_chains',
    'extraction_arbitration_decisions',
    'extraction_arbitration_decision_candidates',
    'semantic_column_mappings', 'semantic_column_mapping_fields',
    'extraction_step3_publication_receipts'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM anon, authenticated', table_name);
    EXECUTE format('GRANT SELECT ON TABLE public.%I TO authenticated', table_name);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM service_role', table_name);
    EXECUTE format('GRANT SELECT ON TABLE public.%I TO service_role', table_name);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR SELECT TO authenticated
       USING (organization_id = public.get_current_user_org_id())',
      table_name || '_select_org', table_name
    );
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON public.%I
       FOR EACH ROW EXECUTE FUNCTION public.reject_compliance_ledger_mutation()',
      'trg_' || table_name || '_append_only', table_name
    );
  END LOOP;
END;
$$;

CREATE INDEX idx_extraction_table_links_run
  ON public.extraction_table_continuation_links(organization_id, extraction_run_id);
CREATE INDEX idx_extraction_table_chains_run
  ON public.extraction_table_chains(organization_id, extraction_run_id);
CREATE INDEX idx_extraction_table_sections_chain
  ON public.extraction_table_sections(organization_id, extraction_run_id, table_chain_id);
CREATE INDEX idx_extraction_arbitration_page
  ON public.extraction_arbitration_decisions(organization_id, extraction_run_id, page_artifact_id);
CREATE INDEX idx_semantic_column_mappings_snapshot
  ON public.semantic_column_mappings(organization_id, interpretation_snapshot_id, table_chain_id);
