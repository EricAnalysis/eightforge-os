-- Dependency-closure checks are database integrity constraints and therefore
-- must evaluate persisted rows independently of the triggering caller's RLS
-- visibility. Keep the complete effective Step 0 + Step 3 closure semantics
-- explicit here; do not reconstruct shipped function text from pg_proc.
CREATE OR REPLACE FUNCTION public.check_extraction_dependency_closure()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
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

-- The trusted migration owner is explicit so SECURITY DEFINER behavior cannot
-- drift with the role used to replay later migrations. Trigger invocation does
-- not require direct EXECUTE, and this function is not an application RPC.
ALTER FUNCTION public.check_extraction_dependency_closure() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.check_extraction_dependency_closure()
  FROM PUBLIC, anon, authenticated, service_role;
