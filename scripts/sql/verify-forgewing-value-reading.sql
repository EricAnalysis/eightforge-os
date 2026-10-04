\set ON_ERROR_STOP on

-- Forgewing B4.2: immutable value-reading proposals and database-verified
-- human promotion. Generic, disposable fixtures only. Every check raises on
-- failure, so ON_ERROR_STOP fails the replay.

INSERT INTO public.organizations (id, name) VALUES
  ('b4200000-0000-4000-8000-000000000001', 'B4.2 regression organization A'),
  ('b4200000-0000-4000-8000-000000000002', 'B4.2 regression organization B');
INSERT INTO auth.users (id) VALUES
  ('b4200000-0000-4000-8000-0000000000a1'), ('b4200000-0000-4000-8000-0000000000b1');
INSERT INTO public.user_profiles (id, organization_id) VALUES
  ('b4200000-0000-4000-8000-0000000000a1', 'b4200000-0000-4000-8000-000000000001'),
  ('b4200000-0000-4000-8000-0000000000b1', 'b4200000-0000-4000-8000-000000000002');
INSERT INTO public.projects (id, organization_id, name) VALUES
  ('b4200000-0000-4000-8000-0000000000e1', 'b4200000-0000-4000-8000-000000000001', 'B4.2 project A'),
  ('b4200000-0000-4000-8000-0000000000e2', 'b4200000-0000-4000-8000-000000000001', 'B4.2 project A2'),
  ('b4200000-0000-4000-8000-0000000000e3', 'b4200000-0000-4000-8000-000000000002', 'B4.2 project B');
INSERT INTO public.documents (id, organization_id, project_id, name, storage_path) VALUES
  ('b4200000-0000-4000-8000-0000000000d1', 'b4200000-0000-4000-8000-000000000001',
   'b4200000-0000-4000-8000-0000000000e1', 'generic-contract.pdf', 'b42/generic-contract.pdf'),
  ('b4200000-0000-4000-8000-0000000000d2', 'b4200000-0000-4000-8000-000000000001',
   'b4200000-0000-4000-8000-0000000000e1', 'generic-amendment.pdf', 'b42/generic-amendment.pdf'),
  ('b4200000-0000-4000-8000-0000000000d3', 'b4200000-0000-4000-8000-000000000002',
   'b4200000-0000-4000-8000-0000000000e3', 'generic-other.pdf', 'b42/generic-other.pdf');
INSERT INTO public.extraction_source_artifacts (id, organization_id, source_document_id, source_sha256,
  storage_object_version, media_type_sniffed, byte_length) VALUES
  ('b4200000-0000-4000-8000-0000000000f1', 'b4200000-0000-4000-8000-000000000001',
   'b4200000-0000-4000-8000-0000000000d1', repeat('1', 64), 'b42-d1:1', 'application/pdf', 1),
  ('b4200000-0000-4000-8000-0000000000f2', 'b4200000-0000-4000-8000-000000000001',
   'b4200000-0000-4000-8000-0000000000d2', repeat('2', 64), 'b42-d2:1', 'application/pdf', 1),
  ('b4200000-0000-4000-8000-0000000000f3', 'b4200000-0000-4000-8000-000000000002',
   'b4200000-0000-4000-8000-0000000000d3', repeat('3', 64), 'b42-d3:1', 'application/pdf', 1);

-- A proposal for document 1, page 8, anchor p8:line:300. p_key names the
-- request and output digests; the proposal digest is derived from both.
CREATE FUNCTION pg_temp.propose(
  p_key text, p_outcome text, p_rate_row jsonb,
  p_org uuid DEFAULT 'b4200000-0000-4000-8000-000000000001',
  p_project uuid DEFAULT 'b4200000-0000-4000-8000-0000000000e1',
  p_document uuid DEFAULT 'b4200000-0000-4000-8000-0000000000d1',
  p_artifact uuid DEFAULT 'b4200000-0000-4000-8000-0000000000f1',
  p_anchor text DEFAULT 'p8:line:300',
  p_output text DEFAULT NULL)
RETURNS TABLE(proposal_row_id uuid, inserted boolean) LANGUAGE sql AS $$
  SELECT * FROM public.record_forgewing_value_reading_proposal(
    p_org, p_project, p_document, p_artifact, 'extraction-snapshot-1', 'case:unreadable-line:p8:300',
    8, repeat('a', 64), 'contract_rate_row', p_anchor, ARRAY['obs-1', 'obs-2'],
    '{"coordinate_space":"source","boxes":[{"x_min":440,"x_max":520,"y_min":300,"y_max":312}]}',
    p_outcome, p_rate_row, 'region_image', NULL, 'priced_value_reading', 'v1',
    'forgewing-value-reading-proposal-v3',
    encode(sha256(convert_to('request:' || p_key, 'UTF8')), 'hex'),
    encode(sha256(convert_to('output:' || coalesce(p_output, p_key), 'UTF8')), 'hex'),
    encode(sha256(convert_to('proposal:' || p_key || ':' || coalesce(p_output, p_key), 'UTF8')), 'hex'),
    'forgewing-proposal-value-reading-'
      || encode(sha256(convert_to('proposal:' || p_key || ':' || coalesce(p_output, p_key), 'UTF8')), 'hex'),
    '  Rate cell reads $14.50 in the source image.  ') $$;
CREATE FUNCTION pg_temp.proposal_id(p_key text) RETURNS text LANGUAGE sql AS $$
  SELECT 'forgewing-proposal-value-reading-'
    || encode(sha256(convert_to('proposal:' || p_key || ':' || p_key, 'UTF8')), 'hex') $$;
CREATE FUNCTION pg_temp.proposal_digest(p_key text) RETURNS text LANGUAGE sql AS $$
  SELECT encode(sha256(convert_to('proposal:' || p_key || ':' || p_key, 'UTF8')), 'hex') $$;

-- An assertion on the B3 record function. Defaults bind to proposal 'p1'.
CREATE FUNCTION pg_temp.assert_value(
  p_value jsonb, p_proposal text, p_request text,
  p_supersedes uuid DEFAULT NULL,
  p_origin text DEFAULT 'ai_proposed',
  p_status text DEFAULT 'active',
  p_org uuid DEFAULT 'b4200000-0000-4000-8000-000000000001',
  p_actor uuid DEFAULT 'b4200000-0000-4000-8000-0000000000a1',
  p_document uuid DEFAULT 'b4200000-0000-4000-8000-0000000000d1',
  p_artifact uuid DEFAULT 'b4200000-0000-4000-8000-0000000000f1',
  p_anchor text DEFAULT 'p8:line:300',
  p_page_digest text DEFAULT repeat('a', 64),
  p_observations text[] DEFAULT ARRAY['obs-1', 'obs-2'])
RETURNS TABLE(assertion_id uuid, inserted boolean) LANGUAGE sql AS $$
  SELECT * FROM public.record_region_bound_human_fact_assertion(
    p_org, p_actor, p_document, 'contract_rate_row', p_value, p_status,
    'Rate cell OCR damaged; value read from source', p_artifact, 8,
    '{"coordinate_space":"source","boxes":[{"x_min":440,"x_max":520,"y_min":300,"y_max":312}]}',
    p_page_digest, 'priced_schedule_reconstruction_v2', p_observations, 'sia 50', p_anchor,
    p_origin, p_proposal, p_supersedes, p_request) $$;
-- Request and review digests are unique across each whole table, so these
-- fixtures use their own namespace rather than ones other suites may hold.
CREATE FUNCTION pg_temp.rq(p_key text) RETURNS text LANGUAGE sql AS $$
  SELECT encode(sha256(convert_to('b42-request:' || p_key, 'UTF8')), 'hex') $$;
CREATE FUNCTION pg_temp.assertion(p_request text) RETURNS uuid LANGUAGE sql AS $$
  SELECT id FROM public.human_fact_assertions WHERE request_digest_sha256 = p_request $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pg_temp TO service_role, authenticated;

-- Browser roles reach neither record function.
SET ROLE authenticated;
DO $$ BEGIN
  PERFORM pg_temp.propose('p1', 'value', '{"description":"Debris removal","unit_type":"CY","rate_amount":14.5}');
  RAISE EXCEPTION 'B4.2 FAIL: authenticated recorded a proposal';
EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;
DO $$ BEGIN
  PERFORM public.record_forgewing_value_reading_review(NULL, NULL, NULL, NULL, NULL, NULL, NULL);
  RAISE EXCEPTION 'B4.2 FAIL: authenticated recorded a review';
EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;
RESET ROLE;

SET ROLE service_role;
SELECT set_config('request.jwt.claim.role', 'service_role', false);

-- 1. Proposals: recorded once, idempotent, collision-checked, bound, non-authoritative.
DO $$ DECLARE r record; v record; BEGIN
  SELECT * INTO r FROM pg_temp.propose('p1', 'value',
    '{"description":"  Debris removal ","unit_type":"CY","rate_amount":14.50,"category":" "}');
  IF NOT r.inserted THEN RAISE EXCEPTION 'B4.2 FAIL: first proposal'; END IF;
  SELECT * INTO r FROM pg_temp.propose('p1', 'value',
    '{"description":"  Debris removal ","unit_type":"CY","rate_amount":14.50,"category":" "}');
  IF r.inserted THEN RAISE EXCEPTION 'B4.2 FAIL: idempotent proposal replay inserted'; END IF;
  SELECT * INTO v FROM public.forgewing_recovery_proposals WHERE proposal_id = pg_temp.proposal_id('p1');
  IF v.authority <> 'non_authoritative' OR NOT v.requires_human_review OR v.proposal_version <> 3
     OR v.proposed_rate_row <> '{"description":"Debris removal","unit_type":"CY","rate_amount":14.5,"category":null}'
     OR v.rationale <> 'Rate cell reads $14.50 in the source image.'
     OR v.project_id <> 'b4200000-0000-4000-8000-0000000000e1' OR v.certainty IS NOT NULL
     OR v.provider_model IS NOT NULL THEN
    RAISE EXCEPTION 'B4.2 FAIL: proposal stored wrongly: %', row_to_json(v);
  END IF;
  SELECT * INTO r FROM pg_temp.propose('unreadable', 'unreadable', NULL);
  IF NOT r.inserted THEN RAISE EXCEPTION 'B4.2 FAIL: unreadable proposal'; END IF;
  SELECT * INTO r FROM pg_temp.propose('other-anchor', 'value',
    '{"description":"Debris removal","unit_type":"CY","rate_amount":14.5}', p_anchor => 'p8:line:420');
  SELECT * INTO r FROM pg_temp.propose('org-b', 'value',
    '{"description":"Debris removal","unit_type":"CY","rate_amount":14.5}',
    p_org => 'b4200000-0000-4000-8000-000000000002', p_project => 'b4200000-0000-4000-8000-0000000000e3',
    p_document => 'b4200000-0000-4000-8000-0000000000d3', p_artifact => 'b4200000-0000-4000-8000-0000000000f3');
  IF NOT r.inserted THEN RAISE EXCEPTION 'B4.2 FAIL: organization B proposal'; END IF;
END $$;
DO $$ BEGIN
  PERFORM pg_temp.propose('p1', 'value', '{"description":"Debris removal","unit_type":"CY","rate_amount":99}',
    p_output => 'a different answer');
  RAISE EXCEPTION 'B4.2 FAIL: a second answer to the same request was accepted';
EXCEPTION WHEN unique_violation THEN NULL; END $$;
DO $$ BEGIN
  PERFORM pg_temp.propose('bad-row', 'value', '{"description":"Debris removal","unit_type":"CY","rate_amount":"14.5"}');
  RAISE EXCEPTION 'B4.2 FAIL: a non-numeric rate was accepted';
EXCEPTION WHEN invalid_parameter_value THEN NULL; END $$;
DO $$ BEGIN
  PERFORM pg_temp.propose('bad-unreadable', 'unreadable', '{"description":"x","unit_type":"CY","rate_amount":1}');
  RAISE EXCEPTION 'B4.2 FAIL: an unreadable reading carrying a value was accepted';
EXCEPTION WHEN invalid_parameter_value THEN NULL; END $$;
DO $$ BEGIN
  PERFORM pg_temp.propose('wrong-project', 'value', '{"description":"x","unit_type":"CY","rate_amount":1}',
    p_project => 'b4200000-0000-4000-8000-0000000000e2');
  RAISE EXCEPTION 'B4.2 FAIL: a proposal bound to another project was accepted';
EXCEPTION WHEN check_violation THEN NULL; END $$;
DO $$ BEGIN
  PERFORM pg_temp.propose('wrong-artifact', 'value', '{"description":"x","unit_type":"CY","rate_amount":1}',
    p_artifact => 'b4200000-0000-4000-8000-0000000000f2');
  RAISE EXCEPTION 'B4.2 FAIL: a proposal bound to another document artifact was accepted';
EXCEPTION WHEN check_violation THEN NULL; END $$;
DO $$ BEGIN
  INSERT INTO public.forgewing_recovery_proposals (organization_id) VALUES ('b4200000-0000-4000-8000-000000000001');
  RAISE EXCEPTION 'B4.2 FAIL: service_role wrote a proposal directly';
EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;

-- 2 and 10. Proposals and their reviews alone never create truth.
DO $$ DECLARE r record; BEGIN
  SELECT * INTO r FROM public.record_forgewing_value_reading_review(
    'b4200000-0000-4000-8000-000000000001', pg_temp.proposal_id('other-anchor'),
    pg_temp.proposal_digest('other-anchor'), 'b4200000-0000-4000-8000-0000000000a1', 'rejected',
    'Reads the wrong row', pg_temp.rq('c'));
  IF NOT r.inserted OR r.review_version <> 1 THEN RAISE EXCEPTION 'B4.2 FAIL: rejection'; END IF;
  SELECT * INTO r FROM public.record_forgewing_value_reading_review(
    'b4200000-0000-4000-8000-000000000001', pg_temp.proposal_id('other-anchor'),
    pg_temp.proposal_digest('other-anchor'), 'b4200000-0000-4000-8000-0000000000a1', 'rejected',
    'Reads the wrong row', pg_temp.rq('c'));
  IF r.inserted THEN RAISE EXCEPTION 'B4.2 FAIL: idempotent review replay inserted'; END IF;
  SELECT * INTO r FROM public.record_forgewing_value_reading_review(
    'b4200000-0000-4000-8000-000000000001', pg_temp.proposal_id('p1'), pg_temp.proposal_digest('p1'),
    'b4200000-0000-4000-8000-0000000000a1', 'deferred', 'Check the original first', pg_temp.rq('d'));
  IF NOT r.inserted THEN RAISE EXCEPTION 'B4.2 FAIL: deferral'; END IF;
END $$;
DO $$ BEGIN
  PERFORM public.record_forgewing_value_reading_review(
    'b4200000-0000-4000-8000-000000000001', pg_temp.proposal_id('p1'), pg_temp.proposal_digest('p1'),
    'b4200000-0000-4000-8000-0000000000a1', 'accepted', 'Looks right', pg_temp.rq('e'));
  RAISE EXCEPTION 'B4.2 FAIL: an accepting value-reading review was recorded';
EXCEPTION WHEN invalid_parameter_value THEN NULL; END $$;
DO $$ BEGIN
  -- The phase 12 review function confirms observations; on a value reading it must refuse.
  PERFORM public.record_forgewing_recovery_proposal_review(
    'b4200000-0000-4000-8000-000000000001', pg_temp.proposal_id('p1'), pg_temp.proposal_digest('p1'),
    'b4200000-0000-4000-8000-0000000000a1', 'accepted', 'obs-1', 'Looks right', pg_temp.rq('f'));
  RAISE EXCEPTION 'B4.2 FAIL: the phase 12 review function accepted a value reading';
EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE 'B4.2 FAIL%' THEN RAISE; END IF; END $$;
DO $$ BEGIN
  PERFORM public.record_forgewing_recovery_proposal_review_v2(
    'b4200000-0000-4000-8000-000000000001', pg_temp.proposal_id('p1'), pg_temp.proposal_digest('p1'),
    'b4200000-0000-4000-8000-0000000000a1', 'accepted', 'recovery-candidate-v2-' || repeat('0', 64),
    'Looks right', pg_temp.rq('9'));
  RAISE EXCEPTION 'B4.2 FAIL: the v2 review function accepted a value reading';
EXCEPTION WHEN no_data_found THEN NULL; END $$;
DO $$ BEGIN
  PERFORM public.record_forgewing_value_reading_review(
    'b4200000-0000-4000-8000-000000000002', pg_temp.proposal_id('p1'), pg_temp.proposal_digest('p1'),
    'b4200000-0000-4000-8000-0000000000b1', 'rejected', 'Not ours', pg_temp.rq('8'));
  RAISE EXCEPTION 'B4.2 FAIL: another organization reviewed the proposal';
EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.human_fact_assertions
             WHERE source_document_id = 'b4200000-0000-4000-8000-0000000000d1') THEN
    RAISE EXCEPTION 'B4.2 FAIL: proposals or reviews created truth';
  END IF;
END $$;

-- 11. Core operator entry is unchanged, and the caller never chooses an AI origin.
DO $$ DECLARE r record; BEGIN
  SELECT * INTO r FROM pg_temp.assert_value('{"description":"Hauling","unit_type":"TON","rate_amount":9}',
    NULL, pg_temp.rq('0'), p_origin => 'operator_entered', p_anchor => 'p8:line:500');
  IF NOT r.inserted THEN RAISE EXCEPTION 'B4.2 FAIL: operator_entered'; END IF;
  IF (SELECT review_origin FROM public.human_fact_assertions WHERE id = r.assertion_id) <> 'operator_entered'
     OR (SELECT forgewing_proposal_id FROM public.human_fact_assertions WHERE id = r.assertion_id) IS NOT NULL THEN
    RAISE EXCEPTION 'B4.2 FAIL: operator_entered stored wrongly';
  END IF;
END $$;
DO $$ BEGIN PERFORM pg_temp.assert_value('{"description":"Debris removal","unit_type":"CY","rate_amount":14.5}',
    NULL, pg_temp.rq('1'));
  RAISE EXCEPTION 'B4.2 FAIL: ai_proposed without a proposal accepted';
EXCEPTION WHEN invalid_parameter_value THEN NULL; END $$;
DO $$ BEGIN PERFORM pg_temp.assert_value('{"description":"Debris removal","unit_type":"CY","rate_amount":14.5}',
    pg_temp.proposal_id('p1'), pg_temp.rq('1'), p_origin => 'operator_entered');
  RAISE EXCEPTION 'B4.2 FAIL: operator_entered citing a proposal accepted';
EXCEPTION WHEN invalid_parameter_value THEN NULL; END $$;
DO $$ BEGIN PERFORM pg_temp.assert_value('{"description":"Debris removal","unit_type":"CY","rate_amount":99}',
    pg_temp.proposal_id('p1'), pg_temp.rq('1'), p_origin => 'ai_proposed_operator_approved');
  RAISE EXCEPTION 'B4.2 FAIL: a caller-chosen AI origin accepted';
EXCEPTION WHEN invalid_parameter_value THEN NULL; END $$;

-- 5-9. The binding must equal the assertion's verified binding exactly.
DO $$ BEGIN PERFORM pg_temp.assert_value('{"description":"Debris removal","unit_type":"CY","rate_amount":14.5}',
    pg_temp.proposal_id('p1'), pg_temp.rq('2'), p_org => 'b4200000-0000-4000-8000-000000000002',
    p_actor => 'b4200000-0000-4000-8000-0000000000b1', p_document => 'b4200000-0000-4000-8000-0000000000d3',
    p_artifact => 'b4200000-0000-4000-8000-0000000000f3');
  RAISE EXCEPTION 'B4.2 FAIL: wrong organization accepted';
EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;
DO $$ BEGIN PERFORM pg_temp.assert_value('{"description":"Debris removal","unit_type":"CY","rate_amount":14.5}',
    pg_temp.proposal_id('p1'), pg_temp.rq('2'), p_document => 'b4200000-0000-4000-8000-0000000000d2',
    p_artifact => 'b4200000-0000-4000-8000-0000000000f2');
  RAISE EXCEPTION 'B4.2 FAIL: wrong document accepted';
EXCEPTION WHEN check_violation THEN NULL; END $$;
DO $$ BEGIN PERFORM pg_temp.assert_value('{"description":"Debris removal","unit_type":"CY","rate_amount":14.5}',
    pg_temp.proposal_id('p1'), pg_temp.rq('2'), p_anchor => 'p8:line:420');
  RAISE EXCEPTION 'B4.2 FAIL: wrong anchor accepted';
EXCEPTION WHEN check_violation THEN NULL; END $$;
DO $$ BEGIN PERFORM pg_temp.assert_value('{"description":"Debris removal","unit_type":"CY","rate_amount":14.5}',
    pg_temp.proposal_id('p1'), pg_temp.rq('2'), p_page_digest => repeat('b', 64));
  RAISE EXCEPTION 'B4.2 FAIL: stale page digest accepted';
EXCEPTION WHEN check_violation THEN NULL; END $$;
DO $$ BEGIN PERFORM pg_temp.assert_value('{"description":"Debris removal","unit_type":"CY","rate_amount":14.5}',
    pg_temp.proposal_id('p1'), pg_temp.rq('2'), p_observations => ARRAY['obs-1', 'obs-3']);
  RAISE EXCEPTION 'B4.2 FAIL: mismatched observations accepted';
EXCEPTION WHEN check_violation THEN NULL; END $$;
DO $$ BEGIN PERFORM pg_temp.assert_value('{"description":"Debris removal","unit_type":"CY","rate_amount":14.5}',
    pg_temp.proposal_id('p1'), pg_temp.rq('2'), p_observations => ARRAY['obs-1']);
  RAISE EXCEPTION 'B4.2 FAIL: a subset of the observations accepted';
EXCEPTION WHEN check_violation THEN NULL; END $$;
DO $$ BEGIN PERFORM pg_temp.assert_value('{"description":"Debris removal","unit_type":"CY","rate_amount":14.5}',
    pg_temp.proposal_id('unreadable'), pg_temp.rq('2'));
  RAISE EXCEPTION 'B4.2 FAIL: an unreadable reading was promoted';
EXCEPTION WHEN check_violation THEN NULL; END $$;
DO $$ BEGIN PERFORM pg_temp.assert_value('{"description":"Debris removal","unit_type":"CY","rate_amount":14.5}',
    'forgewing-proposal-recovery-v2-' || repeat('0', 64), pg_temp.rq('2'));
  RAISE EXCEPTION 'B4.2 FAIL: a non-value-reading proposal id accepted';
EXCEPTION WHEN check_violation THEN NULL; END $$;
DO $$ BEGIN PERFORM pg_temp.assert_value('"14.5"', pg_temp.proposal_id('p1'), pg_temp.rq('2'));
  RAISE EXCEPTION 'B4.2 FAIL: a non-rate-row value citing a proposal accepted';
EXCEPTION WHEN invalid_parameter_value THEN NULL; END $$;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.human_fact_assertions WHERE anchor_key = 'p8:line:300' AND source_document_id = 'b4200000-0000-4000-8000-0000000000d1') THEN
    RAISE EXCEPTION 'B4.2 FAIL: a refused write left a row';
  END IF;
END $$;

-- 3, 4 and 12. Approved, modified and withdrawn: one append-only chain.
DO $$ DECLARE r record; BEGIN
  -- Same value in another key order, with surrounding spaces and 14.50 for 14.5.
  SELECT * INTO r FROM pg_temp.assert_value(
    '{"rate_amount":14.50,"unit_type":" CY","description":"Debris removal "}',
    pg_temp.proposal_id('p1'), pg_temp.rq('3'), p_observations => ARRAY['obs-2', 'obs-1']);
  IF NOT r.inserted OR (SELECT review_origin FROM public.human_fact_assertions WHERE id = r.assertion_id)
     <> 'ai_proposed_operator_approved' THEN
    RAISE EXCEPTION 'B4.2 FAIL: exact value not recorded as approved';
  END IF;
  SELECT * INTO r FROM pg_temp.assert_value(
    '{"rate_amount":14.50,"unit_type":" CY","description":"Debris removal "}',
    pg_temp.proposal_id('p1'), pg_temp.rq('3'), p_observations => ARRAY['obs-2', 'obs-1']);
  IF r.inserted THEN RAISE EXCEPTION 'B4.2 FAIL: idempotent AI-origin replay inserted'; END IF;
END $$;
DO $$ BEGIN PERFORM pg_temp.assert_value('{"rate_amount":14.50,"unit_type":" CY","description":"Debris removal "}',
    NULL, pg_temp.rq('3'), p_origin => 'operator_entered', p_observations => ARRAY['obs-2', 'obs-1']);
  RAISE EXCEPTION 'B4.2 FAIL: replay without the proposal accepted';
EXCEPTION WHEN unique_violation THEN NULL; END $$;
DO $$ DECLARE r record; BEGIN
  SELECT * INTO r FROM pg_temp.assert_value(
    '{"description":"Debris removal","unit_type":"CY","rate_amount":14.75}',
    pg_temp.proposal_id('p1'), pg_temp.rq('4'), pg_temp.assertion(pg_temp.rq('3')));
  IF NOT r.inserted OR (SELECT review_origin FROM public.human_fact_assertions WHERE id = r.assertion_id)
     <> 'ai_proposed_operator_modified' THEN
    RAISE EXCEPTION 'B4.2 FAIL: edited value not recorded as modified';
  END IF;
  SELECT * INTO r FROM pg_temp.assert_value(
    '{"description":"Debris removal","unit_type":"CY","rate_amount":14.5,"category":"Debris"}',
    pg_temp.proposal_id('p1'), pg_temp.rq('5'), pg_temp.assertion(pg_temp.rq('4')));
  IF (SELECT review_origin FROM public.human_fact_assertions WHERE id = r.assertion_id)
     <> 'ai_proposed_operator_modified' THEN
    RAISE EXCEPTION 'B4.2 FAIL: an added category not recorded as modified';
  END IF;
END $$;
DO $$ BEGIN PERFORM pg_temp.assert_value(NULL, pg_temp.proposal_id('p1'), pg_temp.rq('6'),
    pg_temp.assertion(pg_temp.rq('5')), p_status => 'withdrawn');
  RAISE EXCEPTION 'B4.2 FAIL: a withdrawal citing a proposal accepted';
EXCEPTION WHEN invalid_parameter_value THEN NULL; END $$;
DO $$ DECLARE r record; BEGIN
  SELECT * INTO r FROM pg_temp.assert_value(NULL, NULL, pg_temp.rq('6'), pg_temp.assertion(pg_temp.rq('5')),
    p_origin => 'operator_entered', p_status => 'withdrawn');
  IF NOT r.inserted THEN RAISE EXCEPTION 'B4.2 FAIL: withdrawal'; END IF;
END $$;
DO $$ BEGIN PERFORM pg_temp.assert_value('{"description":"Debris removal","unit_type":"CY","rate_amount":14.5}',
    pg_temp.proposal_id('p1'), pg_temp.rq('7'), pg_temp.assertion(pg_temp.rq('3')));
  RAISE EXCEPTION 'B4.2 FAIL: superseding a non-head accepted';
EXCEPTION WHEN serialization_failure THEN NULL; END $$;
RESET ROLE;

-- 1 and 12. Proposals, reviews and assertions stay append-only, even for the owner.
DO $$ BEGIN
  UPDATE public.forgewing_recovery_proposals SET rationale = 'rewritten' WHERE proposal_version = 3;
  RAISE EXCEPTION 'B4.2 FAIL: proposal updated';
EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;
DO $$ BEGIN
  DELETE FROM public.forgewing_recovery_proposals WHERE proposal_version = 3;
  RAISE EXCEPTION 'B4.2 FAIL: proposal deleted';
EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;
DO $$ BEGIN
  UPDATE public.forgewing_recovery_proposal_reviews SET disposition = 'accepted';
  RAISE EXCEPTION 'B4.2 FAIL: review updated';
EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;
DO $$ BEGIN
  -- Even a direct owner insert cannot make the review table authorize a value reading.
  INSERT INTO public.forgewing_recovery_proposal_reviews (organization_id, proposal_row_id,
    proposal_digest_sha256, review_version, reviewer_actor_id, disposition, confirmed_observation_id,
    confirmed_raw_text, reviewer_rationale, review_request_digest_sha256)
  SELECT organization_id, id, proposal_digest_sha256, 99, 'b4200000-0000-4000-8000-0000000000a1', 'accepted',
    'obs-1', 'sia 50', 'forced', pg_temp.rq('7')
  FROM public.forgewing_recovery_proposals WHERE proposal_id = pg_temp.proposal_id('p1');
  RAISE EXCEPTION 'B4.2 FAIL: an approving review row on a value reading was stored';
EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;
DO $$ BEGIN
  UPDATE public.human_fact_assertions SET review_origin = 'ai_proposed_operator_approved'
    WHERE request_digest_sha256 = pg_temp.rq('4');
  RAISE EXCEPTION 'B4.2 FAIL: assertion history updated';
EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE 'B4.2 FAIL%' THEN RAISE; END IF; END $$;
DO $$ BEGIN
  INSERT INTO public.forgewing_recovery_proposals (organization_id, source_document_id, source_artifact_id,
    extraction_snapshot_id, physical_page_number, proposal_id, proposal_digest_sha256, task_type, schema_version,
    recovery_reason, eligibility_reason, proposed_value, normalized_value, page_representation_digest, evidence,
    alternative_observation_ids, reason_category, prompt_template_id, prompt_template_version, proposal_version,
    recovery_type)
  VALUES ('b4200000-0000-4000-8000-000000000001', 'b4200000-0000-4000-8000-0000000000d1',
    'b4200000-0000-4000-8000-0000000000f1', 's', 8, 'forgewing-proposal-value-reading-' || repeat('5', 64),
    repeat('5', 64), 'priced_value_reading', 'v3', 'unresolved_priced_line', 'operator_requested_reading',
    '1', '1', repeat('a', 64), '[]', '[]', 'value_reading', 't', 'v', 3, 'priced_value_reading');
  RAISE EXCEPTION 'B4.2 FAIL: an unbound version 3 row was stored';
EXCEPTION WHEN check_violation THEN NULL; END $$;
DO $$ BEGIN
  IF (SELECT string_agg(status || ':' || review_origin || ':' || coalesce(asserted_value->>'rate_amount', '-'),
        ' > ' ORDER BY asserted_at,
          array_position(ARRAY[pg_temp.rq('3'), pg_temp.rq('4'), pg_temp.rq('5'), pg_temp.rq('6')], request_digest_sha256))
      FROM public.human_fact_assertions WHERE anchor_key = 'p8:line:300' AND source_document_id = 'b4200000-0000-4000-8000-0000000000d1')
     IS DISTINCT FROM 'active:ai_proposed_operator_approved:14.50 > active:ai_proposed_operator_modified:14.75'
       || ' > active:ai_proposed_operator_modified:14.5 > withdrawn:operator_entered:-' THEN
    RAISE EXCEPTION 'B4.2 FAIL: chain history not preserved';
  END IF;
  IF (SELECT count(*) FROM public.forgewing_recovery_proposal_reviews review
      JOIN public.forgewing_recovery_proposals proposal ON proposal.id = review.proposal_row_id
      WHERE proposal.proposal_version = 3 AND review.disposition NOT IN ('rejected', 'deferred')) <> 0 THEN
    RAISE EXCEPTION 'B4.2 FAIL: a value reading carries an approving review';
  END IF;
END $$;

SELECT 'B4.2 VALUE-READING PROPOSAL IMMUTABILITY / VERIFIED HUMAN PROMOTION / ONE ROAD TO TRUTH: PASS' AS result;
