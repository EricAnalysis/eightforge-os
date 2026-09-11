-- Phase 14: optional, target-bound visual evidence for new continuation
-- candidates. Historical Recovery V2 payloads without targetContextEvidence
-- retain the Phase 13 validation and persistence path unchanged.

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
       'priced_schedule_continuation_attribution') THEN
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
      THEN 'ambiguous_row_assignment' ELSE 'ambiguous_rate_clusters' END,
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
