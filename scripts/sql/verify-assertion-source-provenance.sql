\set ON_ERROR_STOP on

-- B8.4b: manual correction provenance. A reviewed value records the historical
-- producer of the evidence it corrected (source extraction + the revision that
-- extraction recorded), derived from the corrected object, never from the
-- deployment running now. Unprovable provenance stays NULL and the correction
-- still succeeds. Generic, disposable fixtures only; every check raises.
-- Runs after the B3, B4.2 and B8.2 verifications, whose positional calls of
-- the record function (19 and 20 arguments) are the old-caller regression.

INSERT INTO public.organizations (id, name) VALUES
  ('b84c0000-0000-4000-8000-000000000001', 'B8.4b provenance organization'),
  ('b84c0000-0000-4000-8000-000000000002', 'B8.4b other organization');
INSERT INTO auth.users (id) VALUES ('b84c0000-0000-4000-8000-0000000000a1');
INSERT INTO public.user_profiles (id, organization_id) VALUES
  ('b84c0000-0000-4000-8000-0000000000a1', 'b84c0000-0000-4000-8000-000000000001');
INSERT INTO public.projects (id, organization_id, name) VALUES
  ('b84c0000-0000-4000-8000-0000000000e1', 'b84c0000-0000-4000-8000-000000000001', 'B8.4b project');
INSERT INTO public.documents (id, organization_id, project_id, name, storage_path) VALUES
  ('b84c0000-0000-4000-8000-0000000000d1', 'b84c0000-0000-4000-8000-000000000001',
   'b84c0000-0000-4000-8000-0000000000e1', 'generic.pdf', 'b84c/generic.pdf'),
  ('b84c0000-0000-4000-8000-0000000000d2', 'b84c0000-0000-4000-8000-000000000002',
   NULL, 'generic-other.pdf', 'b84c/generic-other.pdf');
INSERT INTO public.extraction_source_artifacts (id, organization_id, source_document_id, source_sha256,
  storage_object_version, media_type_sniffed, byte_length) VALUES
  ('b84c0000-0000-4000-8000-0000000000f1', 'b84c0000-0000-4000-8000-000000000001',
   'b84c0000-0000-4000-8000-0000000000d1', repeat('1', 64), 'b84c:1', 'application/pdf', 1),
  ('b84c0000-0000-4000-8000-0000000000f2', 'b84c0000-0000-4000-8000-000000000001',
   'b84c0000-0000-4000-8000-0000000000d1', repeat('2', 64), 'b84c:2', 'application/pdf', 1);

-- Extractions of document d1:
--   x1  production revision 1111..., artifact f1   (the producer being corrected)
--   x2  production revision 2222..., artifact f1   (a later run: never substituted)
--   x3  no runtime identity (predates it), artifact f1
--   x4  artifact f2: does not bind to evidence on f1
-- and x5 belonging to the other organization's document.
INSERT INTO public.document_extractions (id, organization_id, document_id, data)
SELECT fixture.id::uuid, fixture.org::uuid, fixture.doc::uuid, jsonb_build_object('extraction',
  jsonb_build_object('content_layers_v1', jsonb_build_object('pdf', jsonb_build_object(
    'layout_observations_v1', jsonb_build_object('source_artifact_id', fixture.artifact))))
  || CASE WHEN fixture.revision IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('runtime_identity_v1',
    jsonb_build_object('identity', jsonb_build_object('schema', 'extraction_runtime_identity_v1',
      'deployment_revision', fixture.revision, 'deployment_environment', 'production'))) END)
FROM (VALUES
  ('b84c0000-0000-4000-8000-000000000071', 'b84c0000-0000-4000-8000-000000000001',
   'b84c0000-0000-4000-8000-0000000000d1', 'b84c0000-0000-4000-8000-0000000000f1', repeat('1', 40)),
  ('b84c0000-0000-4000-8000-000000000072', 'b84c0000-0000-4000-8000-000000000001',
   'b84c0000-0000-4000-8000-0000000000d1', 'b84c0000-0000-4000-8000-0000000000f1', repeat('2', 40)),
  ('b84c0000-0000-4000-8000-000000000073', 'b84c0000-0000-4000-8000-000000000001',
   'b84c0000-0000-4000-8000-0000000000d1', 'b84c0000-0000-4000-8000-0000000000f1', NULL),
  ('b84c0000-0000-4000-8000-000000000074', 'b84c0000-0000-4000-8000-000000000001',
   'b84c0000-0000-4000-8000-0000000000d1', 'b84c0000-0000-4000-8000-0000000000f2', repeat('4', 40)),
  ('b84c0000-0000-4000-8000-000000000075', 'b84c0000-0000-4000-8000-000000000002',
   'b84c0000-0000-4000-8000-0000000000d2', 'b84c0000-0000-4000-8000-0000000000f1', repeat('5', 40))
) AS fixture(id, org, doc, artifact, revision);

-- One manual correction per anchor, so each is its own chain head.
CREATE FUNCTION pg_temp.b84c_correct(p_anchor text, p_source uuid, p_named boolean DEFAULT true)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_id uuid;
BEGIN
  IF p_named THEN
    SELECT assertion_id INTO v_id FROM public.record_region_bound_human_fact_assertion(
      p_organization_id => 'b84c0000-0000-4000-8000-000000000001',
      p_actor_id => 'b84c0000-0000-4000-8000-0000000000a1',
      p_source_document_id => 'b84c0000-0000-4000-8000-0000000000d1',
      p_fact_key => 'contract_rate_row', p_asserted_value => '{"rate_amount":15}', p_status => 'active',
      p_reason => 'reviewed generic source', p_source_artifact_id => 'b84c0000-0000-4000-8000-0000000000f1',
      p_physical_page_number => 1, p_source_region => '{"boxes":[{"x_min":1,"x_max":2,"y_min":1,"y_max":2}]}',
      p_page_representation_digest => repeat('b', 64), p_parser_version => 'priced_schedule_reconstruction_v6',
      p_source_observation_ids => ARRAY['obs-1'], p_original_source_text => 'generic', p_anchor_key => p_anchor,
      p_review_origin => 'operator_entered', p_forgewing_proposal_id => NULL, p_supersedes_assertion_id => NULL,
      p_request_digest_sha256 => encode(sha256(convert_to('b84c:' || p_anchor, 'UTF8')), 'hex'),
      p_source_extraction_id => p_source);
  ELSE
    -- The pre-B8.4b positional call: 19 arguments, no mapping evidence, no pin.
    SELECT assertion_id INTO v_id FROM public.record_region_bound_human_fact_assertion(
      'b84c0000-0000-4000-8000-000000000001', 'b84c0000-0000-4000-8000-0000000000a1',
      'b84c0000-0000-4000-8000-0000000000d1', 'contract_rate_row', '{"rate_amount":15}', 'active',
      'reviewed generic source', 'b84c0000-0000-4000-8000-0000000000f1', 1,
      '{"boxes":[{"x_min":1,"x_max":2,"y_min":1,"y_max":2}]}', repeat('b', 64),
      'priced_schedule_reconstruction_v6', ARRAY['obs-1'], 'generic', p_anchor, 'operator_entered', NULL, NULL,
      encode(sha256(convert_to('b84c:' || p_anchor, 'UTF8')), 'hex'));
  END IF;
  RETURN v_id;
END $$;
GRANT EXECUTE ON FUNCTION pg_temp.b84c_correct(text, uuid, boolean) TO service_role;
CREATE TEMP TABLE b84c_ids (anchor text PRIMARY KEY, id uuid);
GRANT ALL ON b84c_ids TO service_role;

SET ROLE service_role;
SELECT set_config('request.jwt.claim.role', 'service_role', false);
INSERT INTO b84c_ids VALUES
  ('pinned',          pg_temp.b84c_correct('pinned', 'b84c0000-0000-4000-8000-000000000071')),
  ('no-identity',     pg_temp.b84c_correct('no-identity', 'b84c0000-0000-4000-8000-000000000073')),
  ('other-artifact',  pg_temp.b84c_correct('other-artifact', 'b84c0000-0000-4000-8000-000000000074')),
  ('other-org',       pg_temp.b84c_correct('other-org', 'b84c0000-0000-4000-8000-000000000075')),
  ('missing',         pg_temp.b84c_correct('missing', 'b84c0000-0000-4000-8000-0000000000ff')),
  ('none',            pg_temp.b84c_correct('none', NULL)),
  ('positional',      pg_temp.b84c_correct('positional', NULL, false));
-- A cited Forgewing proposal: the pin is the proposal's own extraction (x1),
-- even though the server names a newer one (x2).
SELECT 1 FROM public.record_forgewing_value_reading_proposal(
  'b84c0000-0000-4000-8000-000000000001', 'b84c0000-0000-4000-8000-0000000000e1',
  'b84c0000-0000-4000-8000-0000000000d1', 'b84c0000-0000-4000-8000-0000000000f1',
  'b84c0000-0000-4000-8000-000000000071', 'case:unreadable-line:p1:1', 1, repeat('b', 64), 'contract_rate_row',
  'proposal-anchor', ARRAY['obs-1'], '{"coordinate_space":"source","boxes":[{"x_min":1,"x_max":2,"y_min":1,"y_max":2}]}',
  'value', '{"description":"Generic line","unit_type":"CY","rate_amount":15}', 'region_image', NULL,
  'priced_value_reading', 'v1', 'forgewing-value-reading-proposal-v3',
  encode(sha256(convert_to('b84c:request', 'UTF8')), 'hex'), encode(sha256(convert_to('b84c:output', 'UTF8')), 'hex'),
  encode(sha256(convert_to('b84c:proposal', 'UTF8')), 'hex'),
  'forgewing-proposal-value-reading-' || encode(sha256(convert_to('b84c:proposal', 'UTF8')), 'hex'),
  'Generic source reading.');
INSERT INTO b84c_ids SELECT 'proposal', assertion_id FROM public.record_region_bound_human_fact_assertion(
  p_organization_id => 'b84c0000-0000-4000-8000-000000000001',
  p_actor_id => 'b84c0000-0000-4000-8000-0000000000a1',
  p_source_document_id => 'b84c0000-0000-4000-8000-0000000000d1',
  p_fact_key => 'contract_rate_row', p_asserted_value => '{"description":"Generic line","unit_type":"CY","rate_amount":15}',
  p_status => 'active', p_reason => 'reviewed suggestion', p_source_artifact_id => 'b84c0000-0000-4000-8000-0000000000f1',
  p_physical_page_number => 1, p_source_region => '{"boxes":[{"x_min":1,"x_max":2,"y_min":1,"y_max":2}]}',
  p_page_representation_digest => repeat('b', 64), p_parser_version => 'priced_schedule_reconstruction_v6',
  p_source_observation_ids => ARRAY['obs-1'], p_original_source_text => 'generic', p_anchor_key => 'proposal-anchor',
  p_review_origin => 'ai_proposed',
  p_forgewing_proposal_id => 'forgewing-proposal-value-reading-' || encode(sha256(convert_to('b84c:proposal', 'UTF8')), 'hex'),
  p_supersedes_assertion_id => NULL,
  p_request_digest_sha256 => encode(sha256(convert_to('b84c:proposal-assertion', 'UTF8')), 'hex'),
  p_source_extraction_id => 'b84c0000-0000-4000-8000-000000000072');
-- An idempotent retry after a newer extraction exists returns the original
-- row unchanged: the pin is provenance, not request identity.
DO $b84c_replay$
BEGIN
  IF pg_temp.b84c_correct('pinned', 'b84c0000-0000-4000-8000-000000000072')
     IS DISTINCT FROM (SELECT id FROM b84c_ids WHERE anchor = 'pinned') THEN
    RAISE EXCEPTION 'B8.4b FAIL: replay with another extraction created or collided';
  END IF;
END
$b84c_replay$;
RESET ROLE;

DO $b84c_provenance$
DECLARE
  v record;
BEGIN
  -- Every correction succeeded, whatever its provenance.
  IF (SELECT count(*) FROM b84c_ids WHERE id IS NOT NULL) <> 8 THEN
    RAISE EXCEPTION 'B8.4b FAIL: a correction was blocked by provenance';
  END IF;
  FOR v IN SELECT ids.anchor, a.source_extraction_id, a.source_deployment_revision, a.source_deployment_environment
           FROM b84c_ids ids JOIN public.human_fact_assertions a ON a.id = ids.id LOOP
    IF v.anchor = 'proposal' AND (v.source_extraction_id IS DISTINCT FROM 'b84c0000-0000-4000-8000-000000000071'
        OR v.source_deployment_revision IS DISTINCT FROM repeat('1', 40)) THEN
      RAISE EXCEPTION 'B8.4b FAIL: cited correction not pinned to its proposal''s extraction: %', v;
    ELSIF v.anchor = 'pinned' AND (v.source_extraction_id IS DISTINCT FROM 'b84c0000-0000-4000-8000-000000000071'
        OR v.source_deployment_revision IS DISTINCT FROM repeat('1', 40)
        OR v.source_deployment_environment IS DISTINCT FROM 'production') THEN
      RAISE EXCEPTION 'B8.4b FAIL: pinned correction lost its historical producer: %', v;
    ELSIF v.anchor = 'no-identity' AND (v.source_extraction_id IS DISTINCT FROM 'b84c0000-0000-4000-8000-000000000073'
        OR v.source_deployment_revision IS NOT NULL OR v.source_deployment_environment IS NOT NULL) THEN
      RAISE EXCEPTION 'B8.4b FAIL: an unrecorded producer was invented: %', v;
    ELSIF v.anchor IN ('other-artifact', 'other-org', 'missing', 'none', 'positional')
        AND (v.source_extraction_id IS NOT NULL OR v.source_deployment_revision IS NOT NULL) THEN
      RAISE EXCEPTION 'B8.4b FAIL: unproven provenance recorded for %: %', v.anchor, v;
    END IF;
  END LOOP;
  -- A revision never exists without its source extraction (only that
  -- constraint differs from a valid copy of the pinned row).
  BEGIN
    INSERT INTO public.human_fact_assertions (organization_id, source_document_id, fact_key, asserted_value,
      source_binding, actor_id, reason, status, source_artifact_id, physical_page_number, source_region,
      page_representation_digest, parser_version, source_observation_ids, original_source_text, anchor_key,
      review_origin, request_digest_sha256, source_extraction_id, source_deployment_revision,
      source_deployment_environment)
    SELECT organization_id, source_document_id, fact_key, asserted_value, source_binding, actor_id, reason, status,
      source_artifact_id, physical_page_number, source_region, page_representation_digest, parser_version,
      source_observation_ids, original_source_text, 'orphan-revision', review_origin,
      encode(sha256(convert_to('b84c:orphan-revision', 'UTF8')), 'hex'), NULL, source_deployment_revision,
      source_deployment_environment
    FROM public.human_fact_assertions WHERE id = (SELECT id FROM b84c_ids WHERE anchor = 'pinned');
    RAISE EXCEPTION 'B8.4b FAIL: revision without source extraction accepted';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM NOT LIKE '%human_fact_assertions_source_producer_check%' THEN RAISE; END IF;
  END;
  -- The record function exists only in its provenance-aware form.
  IF (SELECT count(*) FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'record_region_bound_human_fact_assertion') <> 1 THEN
    RAISE EXCEPTION 'B8.4b FAIL: an older record function overload survives';
  END IF;
  -- Earlier suites' cited-proposal corrections: the pin is the proposal's own
  -- extraction or nothing, never another extraction.
  IF EXISTS (SELECT 1 FROM public.human_fact_assertions a
      JOIN public.forgewing_recovery_proposals p ON p.proposal_id = a.forgewing_proposal_id
      WHERE a.source_extraction_id IS NOT NULL AND a.source_extraction_id::text IS DISTINCT FROM p.extraction_snapshot_id) THEN
    RAISE EXCEPTION 'B8.4b FAIL: a cited correction was pinned to an extraction other than its proposal''s';
  END IF;
END
$b84c_provenance$;

SELECT 'B8.4B MANUAL CORRECTION PROVENANCE / SERVER-DERIVED SOURCE EXTRACTION / NO INVENTED PRODUCER / OLD CALLERS: PASS' AS result;
