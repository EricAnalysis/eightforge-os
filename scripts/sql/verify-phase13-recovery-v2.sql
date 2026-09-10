\set ON_ERROR_STOP on

-- Phase 13 gets its own document and artifact inside the Phase 12 tenant.
--
-- Reusing Phase 12's source identity put V2 proposals and their approving
-- reviews inside the scope the Phase 12 effective-confirmation verifier
-- resolves, and that verifier asserts an exact confirmation set -- so the V2
-- rows read as Phase 12 regressions. Separate source identity keeps each
-- qualification's assertions about its own rows, while the shared tenant and
-- reviewer still prove that V1 and V2 coexist under one organization.
INSERT INTO public.documents(id, organization_id, name, storage_path) VALUES
  ('a2000000-0000-4000-8000-000000000013', 'a1000000-0000-4000-8000-000000000001',
   'a-thirteen.pdf', 'phase13/a-thirteen.pdf');
INSERT INTO public.extraction_source_artifacts(
  id, organization_id, source_document_id, source_sha256, storage_object_version,
  media_type_sniffed, byte_length, storage_bucket, storage_path, identity_origin)
VALUES
  ('a3000000-0000-4000-8000-000000000013', 'a1000000-0000-4000-8000-000000000001',
   'a2000000-0000-4000-8000-000000000013', repeat('d', 64), 'phase13-a-thirteen:1',
   'application/pdf', 1, 'documents', 'phase13/a-thirteen.pdf', 'upload');

CREATE FUNCTION pg_temp.phase13_candidates()
RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_build_array(
    jsonb_build_object(
      'candidateId', 'recovery-candidate-v2-' || repeat('a', 64),
      'recoveryType', 'pricing_rate_multi_observation_cluster',
      'sourceDocumentId', 'a2000000-0000-4000-8000-000000000013',
      'sourceArtifactId', 'a3000000-0000-4000-8000-000000000013',
      'physicalPageNumber', 7,
      'pageRepresentationDigest', repeat('9', 64),
      'targetRowIdentity', 'row:unit-rate',
      'orderedObservationIds', jsonb_build_array('obs:dollar', 'obs:amount'),
      'rawTexts', jsonb_build_array('$', '8.75'),
      'composedRawText', '$ 8.75',
      'evidence', jsonb_build_array(
        jsonb_build_object('observationId','obs:dollar','sourceLayer','pdf_native_text','rawText','$',
          'boundingBox',jsonb_build_object('xMin',0.10,'xMax',0.12,'yMin',0.30,'yMax',0.40)),
        jsonb_build_object('observationId','obs:amount','sourceLayer','pdf_native_text','rawText','8.75',
          'boundingBox',jsonb_build_object('xMin',0.12,'xMax',0.20,'yMin',0.30,'yMax',0.40))
      )
    ),
    jsonb_build_object(
      'candidateId', 'recovery-candidate-v2-' || repeat('b', 64),
      'recoveryType', 'pricing_rate_multi_observation_cluster',
      'sourceDocumentId', 'a2000000-0000-4000-8000-000000000013',
      'sourceArtifactId', 'a3000000-0000-4000-8000-000000000013',
      'physicalPageNumber', 7,
      'pageRepresentationDigest', repeat('9', 64),
      'targetRowIdentity', 'row:alternate-rate',
      'orderedObservationIds', jsonb_build_array('obs:alt-dollar', 'obs:alt-amount'),
      'rawTexts', jsonb_build_array('$', '9.50'),
      'composedRawText', '$ 9.50',
      'evidence', jsonb_build_array(
        jsonb_build_object('observationId','obs:alt-dollar','sourceLayer','pdf_native_text','rawText','$',
          'boundingBox',jsonb_build_object('xMin',0.50,'xMax',0.52,'yMin',0.30,'yMax',0.40)),
        jsonb_build_object('observationId','obs:alt-amount','sourceLayer','pdf_native_text','rawText','9.50',
          'boundingBox',jsonb_build_object('xMin',0.52,'xMax',0.60,'yMin',0.30,'yMax',0.40))
      )
    )
  )
$$;

CREATE FUNCTION pg_temp.record_phase13_proposal(
  p_key text, p_digest text, p_selected text, p_value text, p_candidates jsonb,
  p_organization uuid DEFAULT 'a1000000-0000-4000-8000-000000000001',
  p_document uuid DEFAULT 'a2000000-0000-4000-8000-000000000013',
  p_artifact uuid DEFAULT 'a3000000-0000-4000-8000-000000000013'
) RETURNS TABLE(proposal_row_id uuid, inserted boolean)
LANGUAGE sql AS $$
  SELECT * FROM public.record_forgewing_recovery_proposal_v2(
    p_organization, p_document, p_artifact, 'phase13-snapshot', 7,
    'forgewing-proposal-recovery-v2-' || repeat(p_key, 64), p_digest,
    'pricing_rate_multi_observation_cluster', p_selected, p_value, repeat('9',64),
    p_candidates, 0.9, 'complete_monetary_cluster', 'no-provider-qualification',
    'forgewing.extraction_recovery_v2', 'v2', NULL)
$$;

CREATE FUNCTION pg_temp.record_phase13_review(
  p_key text, p_digest text, p_request_digest text, p_disposition text, p_candidate text
) RETURNS TABLE(
  review_id uuid, review_version integer, proposal_row_id uuid,
  confirmed_candidate_id text, confirmed_raw_text text, inserted boolean)
LANGUAGE sql AS $$
  SELECT * FROM public.record_forgewing_recovery_proposal_review_v2(
    'a1000000-0000-4000-8000-000000000001',
    'forgewing-proposal-recovery-v2-' || repeat(p_key, 64), p_digest,
    'a6000000-0000-4000-8000-000000000001', p_disposition, p_candidate,
    initcap(p_disposition) || '.', p_request_digest)
$$;

CREATE FUNCTION pg_temp.expect_phase13_error(p_label text, p_statement text, p_state text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE p_statement;
  RAISE EXCEPTION '% did not fail', p_label;
EXCEPTION WHEN OTHERS THEN
  IF SQLSTATE IS DISTINCT FROM p_state THEN
    RAISE EXCEPTION '% returned SQLSTATE %, expected %: %', p_label, SQLSTATE, p_state, SQLERRM;
  END IF;
END $$;

SET request.jwt.claim.role = 'service_role';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.forgewing_recovery_proposals
    WHERE proposal_version = 1
      AND selected_observation_id IS NOT NULL
      AND selected_candidate_id IS NULL
      AND recovery_candidates IS NULL
  ) THEN
    RAISE EXCEPTION 'Phase 12 historical proposal is not V1-compatible';
  END IF;
END $$;

DO $$
DECLARE first_call record; replay record; accepted record; modified record;
BEGIN
  SELECT * INTO STRICT first_call FROM pg_temp.record_phase13_proposal(
    'a', repeat('1',64), 'recovery-candidate-v2-' || repeat('a',64), '$ 8.75',
    pg_temp.phase13_candidates());
  SELECT * INTO STRICT replay FROM pg_temp.record_phase13_proposal(
    'a', repeat('1',64), 'recovery-candidate-v2-' || repeat('a',64), '$ 8.75',
    pg_temp.phase13_candidates());
  IF NOT first_call.inserted OR replay.inserted OR first_call.proposal_row_id <> replay.proposal_row_id THEN
    RAISE EXCEPTION 'V2 proposal exact idempotency failed';
  END IF;
  SELECT * INTO STRICT accepted FROM pg_temp.record_phase13_review(
    'a', repeat('1',64), repeat('a',64), 'accepted',
    'recovery-candidate-v2-' || repeat('a',64));
  IF accepted.confirmed_raw_text <> '$ 8.75' THEN
    RAISE EXCEPTION 'accepted review did not derive the complete candidate text';
  END IF;

  PERFORM * FROM pg_temp.record_phase13_proposal(
    'b', repeat('2',64), 'recovery-candidate-v2-' || repeat('a',64), '$ 8.75',
    pg_temp.phase13_candidates());
  SELECT * INTO STRICT modified FROM pg_temp.record_phase13_review(
    'b', repeat('2',64), repeat('b',64), 'modified',
    'recovery-candidate-v2-' || repeat('b',64));
  IF modified.confirmed_raw_text <> '$ 9.50' THEN
    RAISE EXCEPTION 'modified review did not derive the alternate candidate text';
  END IF;

  PERFORM * FROM pg_temp.record_phase13_proposal(
    'c', repeat('3',64), 'recovery-candidate-v2-' || repeat('a',64), '$ 8.75',
    pg_temp.phase13_candidates());
  PERFORM * FROM pg_temp.record_phase13_review('c', repeat('3',64), repeat('c',64), 'rejected', NULL);
  PERFORM * FROM pg_temp.record_phase13_proposal(
    'd', repeat('4',64), 'recovery-candidate-v2-' || repeat('a',64), '$ 8.75',
    pg_temp.phase13_candidates());
  PERFORM * FROM pg_temp.record_phase13_review('d', repeat('4',64), repeat('d',64), 'deferred', NULL);
END $$;

SELECT pg_temp.expect_phase13_error('provider-authored proposed value',
  $probe$SELECT * FROM pg_temp.record_phase13_proposal(
    'e', repeat('5',64), 'recovery-candidate-v2-' || repeat('a',64), '$ 99.99',
    pg_temp.phase13_candidates())$probe$, '22023');
SELECT pg_temp.expect_phase13_error('unknown confirmed candidate',
  $probe$SELECT * FROM pg_temp.record_phase13_review(
    'a', repeat('1',64), repeat('e',64), 'modified',
    'recovery-candidate-v2-' || repeat('e',64))$probe$, '22023');
SELECT pg_temp.expect_phase13_error('accepted alternate candidate',
  $probe$SELECT * FROM pg_temp.record_phase13_review(
    'a', repeat('1',64), repeat('f',64), 'accepted',
    'recovery-candidate-v2-' || repeat('b',64))$probe$, '22023');
SELECT pg_temp.expect_phase13_error('duplicate ordered observation member',
  $probe$SELECT * FROM pg_temp.record_phase13_proposal(
    'f', repeat('6',64), 'recovery-candidate-v2-' || repeat('a',64), '$ 8.75',
    jsonb_set(jsonb_set(pg_temp.phase13_candidates(), '{0,orderedObservationIds}',
      '["obs:dollar","obs:dollar"]'::jsonb), '{0,rawTexts}', '["$","$"]'::jsonb))$probe$, '22023');
SELECT pg_temp.expect_phase13_error('misaligned candidate evidence',
  $probe$SELECT * FROM pg_temp.record_phase13_proposal(
    'f', repeat('7',64), 'recovery-candidate-v2-' || repeat('a',64), '$ 8.75',
    jsonb_set(pg_temp.phase13_candidates(), '{0,rawTexts,1}', '"8.76"'::jsonb))$probe$, '22023');
SELECT pg_temp.expect_phase13_error('cross-tenant source binding',
  $probe$SELECT * FROM pg_temp.record_phase13_proposal(
    'f', repeat('8',64), 'recovery-candidate-v2-' || repeat('a',64), '$ 8.75',
    pg_temp.phase13_candidates(), p_organization => 'b1000000-0000-4000-8000-000000000001')$probe$, '23514');

DO $$
DECLARE proposal_rpc oid; review_rpc oid;
BEGIN
  SELECT oid INTO STRICT proposal_rpc FROM pg_catalog.pg_proc
    WHERE pronamespace = 'public'::regnamespace AND proname = 'record_forgewing_recovery_proposal_v2';
  SELECT oid INTO STRICT review_rpc FROM pg_catalog.pg_proc
    WHERE pronamespace = 'public'::regnamespace AND proname = 'record_forgewing_recovery_proposal_review_v2';
  IF has_function_privilege('anon', proposal_rpc, 'EXECUTE')
     OR has_function_privilege('authenticated', proposal_rpc, 'EXECUTE')
     OR has_function_privilege('anon', review_rpc, 'EXECUTE')
     OR has_function_privilege('authenticated', review_rpc, 'EXECUTE')
     OR NOT has_function_privilege('service_role', proposal_rpc, 'EXECUTE')
     OR NOT has_function_privilege('service_role', review_rpc, 'EXECUTE') THEN
    RAISE EXCEPTION 'Recovery V2 RPC ACL mismatch';
  END IF;
END $$;

SELECT 'PHASE 13 RECOVERY V2 DATABASE QUALIFICATION: PASS' AS result;
