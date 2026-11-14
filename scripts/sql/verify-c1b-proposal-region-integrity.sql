\set ON_ERROR_STOP on

-- Run after verify-forgewing-value-reading.sql in a disposable, migrated database.
-- B4.2 supplies fictional organization, document, artifact, actor and extraction
-- identities. The outer rollback leaves no proposal or assertion history.
BEGIN;

CREATE FUNCTION pg_temp.c1b_region_assert(p_region jsonb, p_request_key text, p_supersedes uuid)
RETURNS TABLE(assertion_id uuid, inserted boolean) LANGUAGE sql AS $$
  SELECT * FROM public.record_region_bound_human_fact_assertion(
    'b4200000-0000-4000-8000-000000000001',
    'b4200000-0000-4000-8000-0000000000a1',
    'b4200000-0000-4000-8000-0000000000d1',
    'contract_rate_row',
    '{"description":"Debris removal","unit_type":"CY","rate_amount":14.5}'::jsonb,
    'active', 'Operator verified source row',
    'b4200000-0000-4000-8000-0000000000f1', 8, p_region, repeat('a', 64),
    'priced_schedule_reconstruction_v2', ARRAY['obs-1', 'obs-2'], 'sia 50',
    'p8:c1b-region-guard-sql', 'ai_proposed',
    'forgewing-proposal-value-reading-' || encode(sha256(convert_to('c1b-region-sql-proposal', 'UTF8')), 'hex'), p_supersedes,
    encode(sha256(convert_to('c1b-region-guard:' || p_request_key, 'UTF8')), 'hex'),
    NULL, 'b4200000-0000-4000-8000-0000000000c1');
$$;
GRANT EXECUTE ON FUNCTION pg_temp.c1b_region_assert(jsonb,text,uuid) TO service_role;

SET ROLE service_role;
SELECT set_config('request.jwt.claim.role', 'service_role', false);

SELECT 1 FROM public.record_forgewing_value_reading_proposal(
  'b4200000-0000-4000-8000-000000000001',
  'b4200000-0000-4000-8000-0000000000e1',
  'b4200000-0000-4000-8000-0000000000d1',
  'b4200000-0000-4000-8000-0000000000f1',
  'b4200000-0000-4000-8000-0000000000c1',
  'case:c1b-region-guard', 8, repeat('a', 64), 'contract_rate_row',
  'p8:c1b-region-guard-sql', ARRAY['obs-1', 'obs-2'],
  '{"coordinate_space":"source","boxes":[{"x_min":440,"x_max":460,"y_min":300,"y_max":312},{"x_min":460,"x_max":520,"y_min":300,"y_max":312}]}'::jsonb,
  'value', '{"description":"Debris removal","unit_type":"CY","rate_amount":14.5}'::jsonb,
  'region_image', NULL, 'priced_value_reading', 'v1',
  'forgewing-value-reading-proposal-v3', encode(sha256(convert_to('c1b-region-sql-request', 'UTF8')), 'hex'), repeat('d', 64),
  encode(sha256(convert_to('c1b-region-sql-proposal', 'UTF8')), 'hex'), 'forgewing-proposal-value-reading-' || encode(sha256(convert_to('c1b-region-sql-proposal', 'UTF8')), 'hex'),
  'Source region integrity fixture');

DO $c1b_region$
DECLARE
  v_first uuid;
  v_second uuid;
  v_replayed uuid;
  v_inserted boolean;
  v_region jsonb := '{"coordinate_space":"source","boxes":[{"x_min":440,"x_max":460,"y_min":300,"y_max":312},{"x_min":460,"x_max":520,"y_min":300,"y_max":312}]}'::jsonb;
  v_variant text;
  v_tampered jsonb;
BEGIN
  SELECT assertion_id, inserted INTO v_first, v_inserted
    FROM pg_temp.c1b_region_assert(v_region, 'matching', NULL);
  IF NOT v_inserted OR v_first IS NULL THEN
    RAISE EXCEPTION 'C1B region FAIL: matching proposal region rejected';
  END IF;

  -- Object-key order and unrelated metadata are discarded by the existing
  -- SourceRegion parser; both represent the same coordinate space and boxes.
  SELECT assertion_id, inserted INTO v_second, v_inserted
    FROM pg_temp.c1b_region_assert(
      '{"metadata":"ignored","boxes":[{"y_max":312,"x_max":460,"x_min":440,"y_min":300,"metadata":1},{"y_min":300,"x_min":460,"x_max":520,"y_max":312}],"coordinate_space":"source"}'::jsonb,
      'equivalent', v_first);
  IF NOT v_inserted OR v_second IS NULL OR v_second = v_first THEN
    RAISE EXCEPTION 'C1B region FAIL: semantically equivalent JSON rejected';
  END IF;

  FOR v_variant IN SELECT unnest(ARRAY['coordinate', 'coordinate_space', 'box_order']) LOOP
    v_tampered := CASE v_variant
      WHEN 'coordinate' THEN jsonb_set(v_region, '{boxes,0,x_min}', '441'::jsonb)
      WHEN 'coordinate_space' THEN jsonb_set(v_region, '{coordinate_space}', '"other"'::jsonb)
      ELSE jsonb_set(v_region, '{boxes}',
        jsonb_build_array(v_region #> '{boxes,1}', v_region #> '{boxes,0}'))
    END;
    BEGIN
      PERFORM pg_temp.c1b_region_assert(v_tampered, 'tampered-' || v_variant, v_second);
      RAISE EXCEPTION 'C1B region FAIL: % tampering accepted', v_variant;
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    IF EXISTS (SELECT 1 FROM public.human_fact_assertions
        WHERE request_digest_sha256 = encode(sha256(convert_to(
          'c1b-region-guard:tampered-' || v_variant, 'UTF8')), 'hex')) THEN
      RAISE EXCEPTION 'C1B region FAIL: rejected % left assertion', v_variant;
    END IF;
  END LOOP;

  -- Replay is checked against the original immutable assertion, before any
  -- new-insert proposal-region guard or current chain-head check.
  SELECT assertion_id, inserted INTO v_replayed, v_inserted
    FROM pg_temp.c1b_region_assert(v_region, 'matching', NULL);
  IF v_inserted OR v_replayed IS DISTINCT FROM v_first THEN
    RAISE EXCEPTION 'C1B region FAIL: historical exact replay changed';
  END IF;
  BEGIN
    PERFORM pg_temp.c1b_region_assert(
      jsonb_set(v_region, '{boxes,0,x_min}', '441'::jsonb), 'matching', NULL);
    RAISE EXCEPTION 'C1B region FAIL: changed-payload replay accepted';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;

END
$c1b_region$;

-- Model a pre-guard assertion as the migration owner, since service_role has
-- RPC-only write authority. Its old mismatch must remain replayable.
RESET ROLE;
INSERT INTO public.human_fact_assertions(
  organization_id, source_document_id, fact_key, asserted_value, source_binding,
  supersedes_assertion_id, actor_id, reason, status, source_artifact_id,
  physical_page_number, source_region, page_representation_digest, parser_version,
  source_observation_ids, original_source_text, anchor_key, review_origin,
  forgewing_proposal_id, request_digest_sha256, customer_mapping_evidence,
  source_extraction_id, source_deployment_revision, source_deployment_environment)
SELECT organization_id, source_document_id, fact_key, asserted_value, source_binding,
  id, actor_id, reason, status, source_artifact_id,
  physical_page_number,
  jsonb_set('{"coordinate_space":"source","boxes":[{"x_min":440,"x_max":460,"y_min":300,"y_max":312},{"x_min":460,"x_max":520,"y_min":300,"y_max":312}]}'::jsonb,
    '{boxes,0,x_min}', '441'::jsonb),
  page_representation_digest, parser_version, source_observation_ids,
  original_source_text, anchor_key, review_origin, forgewing_proposal_id,
  encode(sha256(convert_to('c1b-region-guard:historical', 'UTF8')), 'hex'),
  customer_mapping_evidence, source_extraction_id,
  source_deployment_revision, source_deployment_environment
FROM public.human_fact_assertions
WHERE request_digest_sha256 = encode(sha256(convert_to('c1b-region-guard:equivalent', 'UTF8')), 'hex');
SET ROLE service_role;
SELECT set_config('request.jwt.claim.role', 'service_role', false);
DO $c1b_legacy_replay$
DECLARE v_historical uuid; v_parent uuid; v_replayed uuid; v_inserted boolean;
BEGIN
  SELECT id, supersedes_assertion_id INTO STRICT v_historical, v_parent
  FROM public.human_fact_assertions
  WHERE request_digest_sha256 = encode(sha256(convert_to('c1b-region-guard:historical', 'UTF8')), 'hex');
  SELECT assertion_id, inserted INTO v_replayed, v_inserted
  FROM pg_temp.c1b_region_assert(
    '{"coordinate_space":"source","boxes":[{"x_min":441,"x_max":460,"y_min":300,"y_max":312},{"x_min":460,"x_max":520,"y_min":300,"y_max":312}]}'::jsonb,
    'historical', v_parent);
  IF v_inserted OR v_replayed IS DISTINCT FROM v_historical THEN
    RAISE EXCEPTION 'C1B region FAIL: legacy mismatched-region replay changed';
  END IF;
END $c1b_legacy_replay$;

ROLLBACK;
