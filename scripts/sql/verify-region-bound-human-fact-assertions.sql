\set ON_ERROR_STOP on

-- Forgewing resolution layer B3: region-bound human-reviewed values on the
-- existing human_fact_assertions ledger. Generic, disposable fixtures only.
-- Every check raises on failure, so ON_ERROR_STOP fails the replay.

INSERT INTO public.organizations (id, name) VALUES
  ('b3000000-0000-4000-8000-000000000001', 'B3 regression organization A'),
  ('b3000000-0000-4000-8000-000000000002', 'B3 regression organization B');
INSERT INTO auth.users (id) VALUES
  ('b3000000-0000-4000-8000-0000000000a1'), ('b3000000-0000-4000-8000-0000000000b1');
INSERT INTO public.user_profiles (id, organization_id) VALUES
  ('b3000000-0000-4000-8000-0000000000a1', 'b3000000-0000-4000-8000-000000000001'),
  ('b3000000-0000-4000-8000-0000000000b1', 'b3000000-0000-4000-8000-000000000002');
INSERT INTO public.documents (id, organization_id, name, storage_path) VALUES
  ('b3000000-0000-4000-8000-0000000000d1', 'b3000000-0000-4000-8000-000000000001',
   'generic-contract.pdf', 'b3/generic-contract.pdf');

-- Rows of the pre-existing bindings still satisfy the replaced constraints.
INSERT INTO public.human_fact_assertions (organization_id, fact_key, asserted_value,
  source_binding, actor_id, reason, status)
VALUES ('b3000000-0000-4000-8000-000000000001', 'legacy_key', '"x"', 'domain_assertion',
  'b3000000-0000-4000-8000-0000000000a1', 'legacy', 'active');

CREATE FUNCTION pg_temp.rec(
  p_value jsonb, p_status text, p_supersedes uuid, p_request text,
  p_org uuid DEFAULT 'b3000000-0000-4000-8000-000000000001',
  p_actor uuid DEFAULT 'b3000000-0000-4000-8000-0000000000a1',
  p_origin text DEFAULT 'operator_entered',
  p_page_digest text DEFAULT repeat('a', 64))
RETURNS TABLE(assertion_id uuid, inserted boolean) LANGUAGE sql AS $$
  SELECT * FROM public.record_region_bound_human_fact_assertion(
    p_org, p_actor, 'b3000000-0000-4000-8000-0000000000d1', 'contract_rate_row', p_value, p_status,
    'Rate cell OCR damaged; value read from source', NULL, 8,
    '{"coordinate_space":"source","boxes":[{"x_min":440,"x_max":520,"y_min":300,"y_max":312}]}',
    p_page_digest, 'priced_schedule_reconstruction_v2', ARRAY['obs-1', 'obs-2'], 'sia 50', 'p8:line:300',
    p_origin, NULL, p_supersedes, p_request) $$;
CREATE FUNCTION pg_temp.req(p_char text) RETURNS uuid LANGUAGE sql AS $$
  SELECT id FROM public.human_fact_assertions WHERE request_digest_sha256 = repeat(p_char, 64) $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pg_temp TO service_role, authenticated;

SET ROLE authenticated;
DO $$ BEGIN
  PERFORM public.record_region_bound_human_fact_assertion(NULL, NULL, NULL, NULL, NULL, NULL, NULL,
    NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL);
  RAISE EXCEPTION 'B3 FAIL: authenticated executed the record function';
EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;
RESET ROLE;

SET ROLE service_role;
SELECT set_config('request.jwt.claim.role', 'service_role', false);
DO $$ DECLARE r record; BEGIN
  SELECT * INTO r FROM pg_temp.rec('{"rate_amount":14.5,"unit_type":"CY","description":"Debris removal"}', 'active', NULL, repeat('1', 64));
  IF NOT r.inserted THEN RAISE EXCEPTION 'B3 FAIL: first insert'; END IF;
  SELECT * INTO r FROM pg_temp.rec('{"rate_amount":14.5,"unit_type":"CY","description":"Debris removal"}', 'active', NULL, repeat('1', 64));
  IF r.inserted THEN RAISE EXCEPTION 'B3 FAIL: idempotent replay inserted'; END IF;
END $$;
DO $$ BEGIN PERFORM pg_temp.rec('{"rate_amount":99}', 'active', NULL, repeat('1', 64));
  RAISE EXCEPTION 'B3 FAIL: request digest collision accepted';
EXCEPTION WHEN unique_violation THEN NULL; END $$;
DO $$ BEGIN PERFORM pg_temp.rec('{"rate_amount":15}', 'active', NULL, repeat('2', 64));
  RAISE EXCEPTION 'B3 FAIL: competing active root accepted';
EXCEPTION WHEN serialization_failure THEN NULL; END $$;
DO $$ BEGIN PERFORM pg_temp.rec('{"rate_amount":15}', 'active', NULL, repeat('3', 64), p_origin => 'ai_proposed_operator_approved');
  RAISE EXCEPTION 'B3 FAIL: AI origin accepted before B4';
EXCEPTION WHEN invalid_parameter_value THEN NULL; END $$;
DO $$ BEGIN PERFORM pg_temp.rec('{"rate_amount":15}', 'active', NULL, repeat('4', 64), p_actor => 'b3000000-0000-4000-8000-0000000000b1');
  RAISE EXCEPTION 'B3 FAIL: cross-organization actor accepted';
EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;
DO $$ BEGIN PERFORM pg_temp.rec('{"rate_amount":15}', 'active', NULL, repeat('5', 64),
    p_org => 'b3000000-0000-4000-8000-000000000002', p_actor => 'b3000000-0000-4000-8000-0000000000b1');
  RAISE EXCEPTION 'B3 FAIL: cross-organization document accepted';
EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;
DO $$ DECLARE r record; BEGIN
  -- Re-review after reprocessing: the correction carries the new page digest.
  SELECT * INTO r FROM pg_temp.rec('{"rate_amount":14.75,"unit_type":"CY","description":"Debris removal"}', 'active',
    pg_temp.req('1'), repeat('6', 64), p_page_digest => repeat('b', 64));
  IF NOT r.inserted THEN RAISE EXCEPTION 'B3 FAIL: correction'; END IF;
END $$;
DO $$ BEGIN PERFORM pg_temp.rec('{"rate_amount":16}', 'active', pg_temp.req('1'), repeat('7', 64));
  RAISE EXCEPTION 'B3 FAIL: superseding a non-head accepted';
EXCEPTION WHEN serialization_failure THEN NULL; END $$;
DO $$ DECLARE r record; BEGIN
  SELECT * INTO r FROM pg_temp.rec(NULL, 'withdrawn', pg_temp.req('6'), repeat('8', 64));
  IF NOT r.inserted THEN RAISE EXCEPTION 'B3 FAIL: withdrawal'; END IF;
END $$;
DO $$ BEGIN PERFORM pg_temp.rec('{"rate_amount":1}', 'withdrawn', pg_temp.req('8'), repeat('9', 64));
  RAISE EXCEPTION 'B3 FAIL: withdrawal carrying a value accepted';
EXCEPTION WHEN invalid_parameter_value THEN NULL; END $$;
DO $$ BEGIN
  INSERT INTO public.human_fact_assertions (organization_id, fact_key, source_binding, actor_id, reason, status)
  VALUES ('b3000000-0000-4000-8000-000000000001', 'k', 'domain_assertion', 'b3000000-0000-4000-8000-0000000000a1', 'r', 'active');
  RAISE EXCEPTION 'B3 FAIL: service_role wrote the ledger directly';
EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;
RESET ROLE;

DO $$ BEGIN
  UPDATE public.human_fact_assertions SET reason = 'rewritten' WHERE request_digest_sha256 = repeat('1', 64);
  RAISE EXCEPTION 'B3 FAIL: history updated';
EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE 'B3 FAIL%' THEN RAISE; END IF; END $$;
DO $$ BEGIN
  DELETE FROM public.human_fact_assertions WHERE request_digest_sha256 = repeat('1', 64);
  RAISE EXCEPTION 'B3 FAIL: history deleted';
EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE 'B3 FAIL%' THEN RAISE; END IF; END $$;
DO $$ BEGIN
  INSERT INTO public.human_fact_assertions (organization_id, source_document_id, fact_key, asserted_value,
    source_binding, actor_id, reason, status)
  VALUES ('b3000000-0000-4000-8000-000000000001', 'b3000000-0000-4000-8000-0000000000d1', 'k', '1',
    'region_bound', 'b3000000-0000-4000-8000-0000000000a1', 'r', 'active');
  RAISE EXCEPTION 'B3 FAIL: incomplete region anchor accepted';
EXCEPTION WHEN check_violation THEN NULL; END $$;
DO $$ BEGIN
  IF (SELECT string_agg(status || ':' || coalesce(asserted_value->>'rate_amount', '-'), ' > ' ORDER BY asserted_at, id)
      FROM public.human_fact_assertions WHERE anchor_key = 'p8:line:300')
     IS DISTINCT FROM 'active:14.5 > active:14.75 > withdrawn:-' THEN
    RAISE EXCEPTION 'B3 FAIL: chain history not preserved';
  END IF;
END $$;

SELECT 'B3 REGION-BOUND HUMAN ASSERTION ACL / IDEMPOTENCY / CHAIN / IMMUTABILITY: PASS' AS result;
