-- Recovery type 3: selection among preserved v2 header role assignments.
-- Additive widening only: historical rows and every existing-type predicate,
-- review RPC, immutable trigger, source/tenant pin, and ACL stay unchanged.

ALTER TABLE public.forgewing_recovery_proposals
  DROP CONSTRAINT forgewing_recovery_proposals_version_shape_check,
  ADD CONSTRAINT forgewing_recovery_proposals_version_shape_check CHECK (
    (proposal_version = 1
      AND recovery_type = 'pricing_rate_single_observation'
      AND selected_observation_id IS NOT NULL
      AND selected_candidate_id IS NULL
      AND recovery_candidates IS NULL)
    OR
    (proposal_version = 2
      AND recovery_type IN (
        'pricing_rate_multi_observation_cluster',
        'priced_schedule_continuation_attribution',
        'priced_schedule_header_role_selection')
      AND selected_observation_id IS NULL
      AND selected_candidate_id ~ '^recovery-candidate-v2-[0-9a-f]{64}$'
      AND jsonb_typeof(recovery_candidates) = 'array'
      AND jsonb_array_length(recovery_candidates) BETWEEN 1 AND 32)
  ),
  DROP CONSTRAINT forgewing_recovery_proposals_recovery_reason_check,
  ADD CONSTRAINT forgewing_recovery_proposals_recovery_reason_check CHECK (
    recovery_reason IN ('ambiguous_rate_clusters', 'ambiguous_row_assignment')
    OR (recovery_type = 'priced_schedule_header_role_selection'
      AND recovery_reason = 'unresolved_header_semantics'));

-- Header source lines retain the candidate contract's 4000-character bound.
-- Historical rate/continuation proposal limits are preserved verbatim.
ALTER TABLE public.forgewing_recovery_proposals
  DROP CONSTRAINT forgewing_recovery_proposals_proposed_value_check,
  ADD CONSTRAINT forgewing_recovery_proposals_proposed_value_check CHECK (
    length(proposed_value) BETWEEN 1 AND 200
    OR (recovery_type = 'priced_schedule_header_role_selection'
      AND length(proposed_value) BETWEEN 1 AND 4000)),
  DROP CONSTRAINT forgewing_recovery_proposals_normalized_value_check,
  ADD CONSTRAINT forgewing_recovery_proposals_normalized_value_check CHECK (
    length(normalized_value) BETWEEN 1 AND 200
    OR (recovery_type = 'priced_schedule_header_role_selection'
      AND length(normalized_value) BETWEEN 1 AND 4000));

ALTER TABLE public.forgewing_recovery_generation_outcomes
  DROP CONSTRAINT forgewing_recovery_generation_outcomes_recovery_type_check,
  ADD CONSTRAINT forgewing_recovery_generation_outcomes_recovery_type_check CHECK (
    recovery_type IN ('pricing_rate_single_observation',
      'pricing_rate_multi_observation_cluster',
      'priced_schedule_continuation_attribution',
      'priced_schedule_header_role_selection'));

-- The existing RPC checks the common source and ordered evidence closure.
-- This helper adds strict validation only for the new header payload. Candidate
-- digest reproduction remains in the application schema and re-entry seam,
-- exactly as for the two historical candidate types.
CREATE FUNCTION public.is_valid_header_role_recovery_candidate(candidate jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE header jsonb; label jsonb; flattened_ids jsonb := '[]'::jsonb;
BEGIN
  header := candidate->'headerRoleSelection';
  IF jsonb_typeof(header) IS DISTINCT FROM 'object'
    OR header->>'parserVersion' IS DISTINCT FROM 'priced_schedule_reconstruction_v2'
    OR jsonb_typeof(header->'headerInterpretationVersion') IS DISTINCT FROM 'string'
    OR length(btrim(header->>'headerInterpretationVersion')) NOT BETWEEN 1 AND 240
    OR jsonb_typeof(header->'optionId') IS DISTINCT FROM 'string'
    OR length(btrim(header->>'optionId')) NOT BETWEEN 1 AND 240
    OR jsonb_typeof(header->'labels') IS DISTINCT FROM 'array'
    OR jsonb_typeof(header->'structuralRowCount') IS DISTINCT FROM 'number'
    OR header->>'structuralRowCount' !~ '^[0-9]+$'
    OR candidate ? 'targetContextEvidence'
    OR candidate->>'targetRowIdentity' IS DISTINCT FROM
      'page_priced_schedule:p' || (candidate->>'physicalPageNumber') || ':header'
    OR EXISTS (SELECT 1 FROM jsonb_object_keys(header) key
      WHERE key NOT IN ('parserVersion', 'headerInterpretationVersion', 'optionId',
        'labels', 'structuralRowCount')) THEN RETURN false; END IF;
  IF jsonb_array_length(header->'labels') NOT BETWEEN 1 AND 32 THEN RETURN false; END IF;
  FOR label IN SELECT value FROM jsonb_array_elements(header->'labels') LOOP
    IF jsonb_typeof(label) IS DISTINCT FROM 'object'
      OR jsonb_typeof(label->'text') IS DISTINCT FROM 'string'
      OR length(btrim(label->>'text')) NOT BETWEEN 1 AND 500
      OR NOT (label ? 'role')
      OR (label->'role' <> 'null'::jsonb AND
        (jsonb_typeof(label->'role') IS DISTINCT FROM 'string'
          OR label->>'role' NOT IN ('description','unit','origin_destination','rate')))
      OR jsonb_typeof(label->'orderedObservationIds') IS DISTINCT FROM 'array'
      OR EXISTS (SELECT 1 FROM jsonb_object_keys(label) key
        WHERE key NOT IN ('text','role','orderedObservationIds')) THEN RETURN false; END IF;
    IF jsonb_array_length(label->'orderedObservationIds') NOT BETWEEN 1 AND 32
      OR EXISTS (SELECT 1 FROM jsonb_array_elements(label->'orderedObservationIds') id
        WHERE jsonb_typeof(id) IS DISTINCT FROM 'string'
          OR length(btrim(id #>> '{}')) NOT BETWEEN 1 AND 240) THEN RETURN false; END IF;
    IF label->>'text' IS DISTINCT FROM (
      SELECT string_agg(btrim(evidence.value->>'rawText'), ' ' ORDER BY member.member_index)
      FROM jsonb_array_elements_text(label->'orderedObservationIds')
        WITH ORDINALITY member(observation_id, member_index)
      JOIN jsonb_array_elements(candidate->'evidence') evidence(value)
        ON evidence.value->>'observationId' = member.observation_id
    ) THEN RETURN false; END IF;
    -- Parenthesized: || and -> share precedence, so the bare form would apply
    -- -> to the concatenated array and yield NULL.
    flattened_ids := flattened_ids || (label->'orderedObservationIds');
  END LOOP;
  IF flattened_ids IS DISTINCT FROM candidate->'orderedObservationIds'
    OR (SELECT count(*) FROM jsonb_array_elements(header->'labels') entry
      WHERE entry->>'role' IS NOT NULL) < 3
    OR (SELECT count(*) FROM jsonb_array_elements(header->'labels') entry
      WHERE entry->>'role' = 'description') <> 1
    OR (SELECT count(*) FROM jsonb_array_elements(header->'labels') entry
      WHERE entry->>'role' = 'rate') <> 1
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(header->'labels') entry
      WHERE entry->>'role' IS NOT NULL GROUP BY entry->>'role' HAVING count(*) > 1)
    THEN RETURN false; END IF;
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.is_valid_header_role_recovery_candidate(jsonb)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.record_forgewing_recovery_proposal_v2(
  p_organization_id uuid, p_source_document_id uuid, p_source_artifact_id uuid,
  p_extraction_snapshot_id text, p_physical_page_number integer, p_proposal_id text,
  p_proposal_digest_sha256 text, p_recovery_type text, p_selected_candidate_id text,
  p_proposed_value text, p_page_representation_digest text, p_recovery_candidates jsonb,
  p_certainty numeric, p_reason_category text, p_provider_model text,
  p_prompt_template_id text, p_prompt_template_version text, p_shadow_artifact_path text
) RETURNS TABLE(proposal_row_id uuid, inserted boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_existing record;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service_role required' USING ERRCODE = '42501';
  END IF;
  IF p_proposal_id !~ '^forgewing-proposal-recovery-v2-[0-9a-f]{64}$'
     OR p_proposal_digest_sha256 !~ '^[0-9a-f]{64}$'
     OR p_page_representation_digest !~ '^[0-9a-f]{64}$'
     OR p_recovery_type NOT IN (
       'pricing_rate_multi_observation_cluster',
       'priced_schedule_continuation_attribution',
       'priced_schedule_header_role_selection') THEN
    RAISE EXCEPTION 'invalid recovery v2 identity' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.extraction_source_artifacts artifact
    JOIN public.documents document ON document.id = artifact.source_document_id
    WHERE artifact.id = p_source_artifact_id
      AND artifact.source_document_id = p_source_document_id
      AND artifact.organization_id = p_organization_id
      AND document.organization_id = p_organization_id
  ) THEN
    RAISE EXCEPTION 'recovery proposal source binding mismatch' USING ERRCODE = '23514';
  END IF;
  IF jsonb_typeof(p_recovery_candidates) IS DISTINCT FROM 'array'
     OR jsonb_array_length(p_recovery_candidates) NOT BETWEEN 1 AND 32
     OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(p_recovery_candidates) candidate
       WHERE jsonb_typeof(candidate) IS DISTINCT FROM 'object'
         OR candidate->>'candidateId' !~ '^recovery-candidate-v2-[0-9a-f]{64}$'
         OR candidate->>'recoveryType' IS DISTINCT FROM p_recovery_type
         OR candidate->>'sourceDocumentId' IS DISTINCT FROM p_source_document_id::text
         OR candidate->>'sourceArtifactId' IS DISTINCT FROM p_source_artifact_id::text
         OR candidate->>'physicalPageNumber' IS DISTINCT FROM p_physical_page_number::text
         OR candidate->>'pageRepresentationDigest' IS DISTINCT FROM p_page_representation_digest
         OR length(btrim(candidate->>'targetRowIdentity')) < 1
         OR length(btrim(candidate->>'composedRawText')) < 1
         OR jsonb_typeof(candidate->'orderedObservationIds') IS DISTINCT FROM 'array'
         OR jsonb_array_length(candidate->'orderedObservationIds') < 1
         OR jsonb_typeof(candidate->'rawTexts') IS DISTINCT FROM 'array'
         OR jsonb_array_length(candidate->'rawTexts')
              IS DISTINCT FROM jsonb_array_length(candidate->'orderedObservationIds')
         OR jsonb_typeof(candidate->'evidence') IS DISTINCT FROM 'array'
         OR jsonb_array_length(candidate->'evidence')
              IS DISTINCT FROM jsonb_array_length(candidate->'orderedObservationIds')
         OR (SELECT count(*) IS DISTINCT FROM count(DISTINCT value)
             FROM jsonb_array_elements_text(candidate->'orderedObservationIds'))
         OR EXISTS (
           SELECT 1
           FROM jsonb_array_elements_text(candidate->'orderedObservationIds')
                WITH ORDINALITY observation(observation_id, member_index)
           JOIN jsonb_array_elements_text(candidate->'rawTexts')
                WITH ORDINALITY raw_text(raw_value, member_index)
             USING (member_index)
           JOIN jsonb_array_elements(candidate->'evidence')
                WITH ORDINALITY evidence(value, member_index)
             USING (member_index)
           WHERE evidence.value->>'observationId' IS DISTINCT FROM observation.observation_id
              OR evidence.value->>'rawText' IS DISTINCT FROM raw_text.raw_value
         )
         OR CASE WHEN p_recovery_type = 'priced_schedule_header_role_selection'
           THEN NOT public.is_valid_header_role_recovery_candidate(candidate)
           ELSE candidate ? 'headerRoleSelection' END
         OR CASE WHEN candidate ? 'targetContextEvidence' THEN
           CASE WHEN
             candidate->>'recoveryType' IS DISTINCT FROM
               'priced_schedule_continuation_attribution'
             OR
             jsonb_typeof(candidate->'targetContextEvidence') IS DISTINCT FROM 'object'
             OR jsonb_typeof(candidate->'targetContextEvidence'->'targetRowIdentity')
                  IS DISTINCT FROM 'string'
             OR jsonb_typeof(candidate->'targetContextEvidence'->'composedRawText')
                  IS DISTINCT FROM 'string'
             OR jsonb_typeof(candidate->'targetContextEvidence'->'orderedObservationIds')
                  IS DISTINCT FROM 'array'
             OR jsonb_typeof(candidate->'targetContextEvidence'->'rawTexts')
                  IS DISTINCT FROM 'array'
             OR jsonb_typeof(candidate->'targetContextEvidence'->'evidence')
                  IS DISTINCT FROM 'array'
           THEN true
           ELSE
             candidate->'targetContextEvidence'->>'targetRowIdentity'
               IS DISTINCT FROM candidate->>'targetRowIdentity'
             OR length(btrim(candidate->'targetContextEvidence'->>'composedRawText')) < 1
             OR jsonb_array_length(
                  candidate->'targetContextEvidence'->'orderedObservationIds') NOT BETWEEN 1 AND 32
             OR jsonb_array_length(candidate->'targetContextEvidence'->'rawTexts')
                  IS DISTINCT FROM jsonb_array_length(
                    candidate->'targetContextEvidence'->'orderedObservationIds')
             OR jsonb_array_length(candidate->'targetContextEvidence'->'evidence')
                  IS DISTINCT FROM jsonb_array_length(
                    candidate->'targetContextEvidence'->'orderedObservationIds')
             OR EXISTS (
               SELECT 1
               FROM jsonb_array_elements(
                 candidate->'targetContextEvidence'->'orderedObservationIds') target_id
               WHERE jsonb_typeof(target_id) IS DISTINCT FROM 'string'
                  OR length(btrim(target_id #>> '{}')) < 1
             )
             OR EXISTS (
               SELECT 1
               FROM jsonb_array_elements(candidate->'targetContextEvidence'->'rawTexts') raw_text
               WHERE jsonb_typeof(raw_text) IS DISTINCT FROM 'string'
             )
             OR (SELECT count(*) IS DISTINCT FROM count(DISTINCT value)
                 FROM jsonb_array_elements_text(
                   candidate->'targetContextEvidence'->'orderedObservationIds'))
             OR EXISTS (
               SELECT 1
               FROM jsonb_array_elements_text(
                      candidate->'targetContextEvidence'->'orderedObservationIds') target_id
               JOIN jsonb_array_elements_text(candidate->'orderedObservationIds') fragment_id
                 ON fragment_id = target_id
             )
             OR EXISTS (
               SELECT 1
               FROM jsonb_array_elements_text(
                      candidate->'targetContextEvidence'->'orderedObservationIds')
                    WITH ORDINALITY observation(observation_id, member_index)
               JOIN jsonb_array_elements_text(candidate->'targetContextEvidence'->'rawTexts')
                    WITH ORDINALITY raw_text(raw_value, member_index)
                 USING (member_index)
               JOIN jsonb_array_elements(candidate->'targetContextEvidence'->'evidence')
                    WITH ORDINALITY evidence(value, member_index)
                 USING (member_index)
               WHERE jsonb_typeof(evidence.value) IS DISTINCT FROM 'object'
                  OR evidence.value->>'observationId'
                       IS DISTINCT FROM observation.observation_id
                  OR evidence.value->>'rawText' IS DISTINCT FROM raw_text.raw_value
             )
           END
         ELSE false END
     )
     OR (SELECT count(*) IS DISTINCT FROM count(DISTINCT candidate->>'candidateId')
         FROM jsonb_array_elements(p_recovery_candidates) candidate)
     OR NOT EXISTS (
       SELECT 1 FROM jsonb_array_elements(p_recovery_candidates) candidate
       WHERE candidate->>'candidateId' = p_selected_candidate_id
         AND candidate->>'composedRawText' = p_proposed_value) THEN
    RAISE EXCEPTION 'invalid recovery v2 candidate closure' USING ERRCODE = '22023';
  END IF;

  -- A deterministic envelope carries no provider recommendation and offers
  -- exactly one preserved option; the review still supplies the authority.
  IF p_provider_model = 'deterministic_header_options' AND (
    p_recovery_type IS DISTINCT FROM 'priced_schedule_header_role_selection'
    OR jsonb_array_length(p_recovery_candidates) <> 1
    OR p_certainty IS DISTINCT FROM 0
    OR p_reason_category IS DISTINCT FROM 'preserved_single_header_option'
    OR p_prompt_template_id IS DISTINCT FROM 'preserved_header_options'
    OR p_prompt_template_version IS DISTINCT FROM '1') THEN
    RAISE EXCEPTION 'invalid deterministic header review envelope' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_proposal_digest_sha256, 0));
  SELECT * INTO v_existing FROM public.forgewing_recovery_proposals
    WHERE proposal_digest_sha256 = p_proposal_digest_sha256;
  IF FOUND THEN
    IF v_existing.organization_id IS DISTINCT FROM p_organization_id
       OR v_existing.source_document_id IS DISTINCT FROM p_source_document_id
       OR v_existing.source_artifact_id IS DISTINCT FROM p_source_artifact_id
       OR v_existing.extraction_snapshot_id IS DISTINCT FROM p_extraction_snapshot_id
       OR v_existing.physical_page_number IS DISTINCT FROM p_physical_page_number
       OR v_existing.proposal_id IS DISTINCT FROM p_proposal_id
       OR v_existing.recovery_type IS DISTINCT FROM p_recovery_type
       OR v_existing.selected_candidate_id IS DISTINCT FROM p_selected_candidate_id
       OR v_existing.recovery_candidates IS DISTINCT FROM p_recovery_candidates
       OR v_existing.proposed_value IS DISTINCT FROM p_proposed_value
       OR v_existing.page_representation_digest IS DISTINCT FROM p_page_representation_digest
       OR v_existing.certainty IS DISTINCT FROM p_certainty
       OR v_existing.reason_category IS DISTINCT FROM p_reason_category
       OR v_existing.provider_model IS DISTINCT FROM p_provider_model
       OR v_existing.prompt_template_id IS DISTINCT FROM p_prompt_template_id
       OR v_existing.prompt_template_version IS DISTINCT FROM p_prompt_template_version
       OR v_existing.shadow_artifact_path IS DISTINCT FROM p_shadow_artifact_path THEN
      RAISE EXCEPTION 'recovery proposal digest collision' USING ERRCODE = '23505';
    END IF;
    RETURN QUERY SELECT v_existing.id, false;
    RETURN;
  END IF;

  INSERT INTO public.forgewing_recovery_proposals(
    organization_id, source_document_id, source_artifact_id, extraction_snapshot_id,
    physical_page_number, proposal_id, proposal_digest_sha256, task_type, schema_version,
    recovery_reason, eligibility_reason, selected_observation_id, proposed_value,
    normalized_value, page_representation_digest, evidence, alternative_observation_ids,
    certainty, reason_category, provider_model, prompt_template_id, prompt_template_version,
    shadow_artifact_path, proposal_version, recovery_type, selected_candidate_id,
    recovery_candidates)
  VALUES (
    p_organization_id, p_source_document_id, p_source_artifact_id, p_extraction_snapshot_id,
    p_physical_page_number, p_proposal_id, p_proposal_digest_sha256,
    'extraction_recovery_v2', 'forgewing-recovery-proposal-v2',
    CASE WHEN p_recovery_type = 'priced_schedule_continuation_attribution'
      THEN 'ambiguous_row_assignment'
      WHEN p_recovery_type = 'priced_schedule_header_role_selection'
      THEN 'unresolved_header_semantics' ELSE 'ambiguous_rate_clusters' END,
    'deterministic_candidate_set', NULL, p_proposed_value, p_proposed_value,
    p_page_representation_digest, '[]'::jsonb, '[]'::jsonb, p_certainty,
    p_reason_category, p_provider_model, p_prompt_template_id, p_prompt_template_version,
    p_shadow_artifact_path, 2, p_recovery_type, p_selected_candidate_id,
    p_recovery_candidates)
  RETURNING id INTO proposal_row_id;
  inserted := true;
  RETURN NEXT;
END $$;

REVOKE ALL ON FUNCTION public.record_forgewing_recovery_proposal_v2(
  uuid,uuid,uuid,text,integer,text,text,text,text,text,text,jsonb,numeric,text,text,text,text,text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.record_forgewing_recovery_proposal_v2(
  uuid,uuid,uuid,text,integer,text,text,text,text,text,text,jsonb,numeric,text,text,text,text,text)
  TO service_role;
