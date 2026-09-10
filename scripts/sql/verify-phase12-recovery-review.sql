\set ON_ERROR_STOP on

INSERT INTO public.organizations(id, name) VALUES
  ('a1000000-0000-4000-8000-000000000001', 'Phase 12 tenant A'),
  ('b1000000-0000-4000-8000-000000000001', 'Phase 12 tenant B');
INSERT INTO auth.users(id, email) VALUES
  ('a6000000-0000-4000-8000-000000000001', 'phase12-a@example.invalid'),
  ('b6000000-0000-4000-8000-000000000001', 'phase12-b@example.invalid');
INSERT INTO public.user_profiles(id, organization_id, display_name) VALUES
  ('a6000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001', 'Phase 12 A'),
  ('b6000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000001', 'Phase 12 B');
INSERT INTO public.documents(id, organization_id, name, storage_path) VALUES
  ('a2000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001', 'a-one.pdf', 'phase12/a-one.pdf'),
  ('a2000000-0000-4000-8000-000000000002', 'a1000000-0000-4000-8000-000000000001', 'a-two.pdf', 'phase12/a-two.pdf'),
  ('b2000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000001', 'b-one.pdf', 'phase12/b-one.pdf');
INSERT INTO public.extraction_source_artifacts(
  id, organization_id, source_document_id, source_sha256, storage_object_version,
  media_type_sniffed, byte_length, storage_bucket, storage_path, identity_origin)
VALUES
  ('a3000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001',
   'a2000000-0000-4000-8000-000000000001', repeat('1', 64), 'phase12-a-one:1',
   'application/pdf', 1, 'documents', 'phase12/a-one.pdf', 'upload'),
  ('a3000000-0000-4000-8000-000000000002', 'a1000000-0000-4000-8000-000000000001',
   'a2000000-0000-4000-8000-000000000002', repeat('2', 64), 'phase12-a-two:1',
   'application/pdf', 1, 'documents', 'phase12/a-two.pdf', 'upload'),
  ('b3000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000001',
   'b2000000-0000-4000-8000-000000000001', repeat('3', 64), 'phase12-b-one:1',
   'application/pdf', 1, 'documents', 'phase12/b-one.pdf', 'upload');

CREATE FUNCTION pg_temp.phase12_evidence()
RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT '[
    {"observationId":"obs:selected","sourceLayer":"pdf_native_text","rawText":"8.75","boundingBox":{"xMin":0.1,"xMax":0.2,"yMin":0.3,"yMax":0.4},"eligible":true},
    {"observationId":"obs:alternate","sourceLayer":"ocr","rawText":"52.50","boundingBox":{"xMin":0.5,"xMax":0.6,"yMin":0.3,"yMax":0.4},"eligible":true},
    {"observationId":"obs:description","sourceLayer":"pdf_native_text","rawText":"Service","boundingBox":{"xMin":0.0,"xMax":0.1,"yMin":0.3,"yMax":0.4},"eligible":false},
    {"observationId":"obs:other","sourceLayer":"ocr","rawText":"17.25","boundingBox":{"xMin":0.7,"xMax":0.8,"yMin":0.3,"yMax":0.4},"eligible":true}
  ]'::jsonb
$$;

CREATE FUNCTION pg_temp.record_phase12_proposal(
  p_key text,
  p_digest text,
  p_organization uuid DEFAULT 'a1000000-0000-4000-8000-000000000001',
  p_document uuid DEFAULT 'a2000000-0000-4000-8000-000000000001',
  p_artifact uuid DEFAULT 'a3000000-0000-4000-8000-000000000001',
  p_selected text DEFAULT 'obs:selected',
  p_proposed text DEFAULT '8.75',
  p_evidence jsonb DEFAULT NULL,
  p_alternatives jsonb DEFAULT '["obs:alternate"]'::jsonb,
  p_snapshot text DEFAULT 'phase12-snapshot',
  p_provider text DEFAULT 'no-provider-qualification',
  p_page integer DEFAULT 7,
  p_schema text DEFAULT 'forgewing-pricing-rate-cluster-recovery-v1',
  p_normalized text DEFAULT NULL,
  p_page_digest text DEFAULT NULL,
  p_certainty numeric DEFAULT 0.9,
  p_reason text DEFAULT 'explicit_currency_marker',
  p_prompt_id text DEFAULT 'forgewing.pricing_rate_cluster_recovery',
  p_prompt_version text DEFAULT 'v1',
  p_shadow_path text DEFAULT NULL
) RETURNS TABLE(proposal_row_id uuid, inserted boolean)
LANGUAGE plpgsql AS $$
BEGIN
  RETURN QUERY SELECT * FROM public.record_forgewing_recovery_proposal(
    p_organization, p_document, p_artifact, p_snapshot, p_page,
    'forgewing-proposal-pricing-rate-cluster-' || pg_catalog.md5(p_key),
    p_digest, p_schema, p_selected,
    p_proposed, coalesce(p_normalized, p_proposed), coalesce(p_page_digest, repeat('9', 64)),
    coalesce(p_evidence, pg_temp.phase12_evidence()), p_alternatives,
    p_certainty, p_reason, p_provider,
    p_prompt_id, p_prompt_version, p_shadow_path);
END $$;

CREATE FUNCTION pg_temp.record_phase12_review(
  p_key text, p_proposal_digest text, p_request_digest text, p_disposition text,
  p_observation text, p_rationale text,
  p_organization uuid DEFAULT 'a1000000-0000-4000-8000-000000000001',
  p_reviewer uuid DEFAULT 'a6000000-0000-4000-8000-000000000001'
) RETURNS TABLE(
  review_id uuid, review_version integer, proposal_row_id uuid,
  confirmed_observation_id text, confirmed_raw_text text, inserted boolean)
LANGUAGE sql AS $$
  SELECT * FROM public.record_forgewing_recovery_proposal_review(
    p_organization,
    'forgewing-proposal-pricing-rate-cluster-' || pg_catalog.md5(p_key),
    p_proposal_digest, p_reviewer, p_disposition, p_observation, p_rationale,
    p_request_digest)
$$;

CREATE FUNCTION pg_temp.expect_error(p_label text, p_statement text, p_state text)
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
DECLARE first_call record; replay record;
BEGIN
  SELECT * INTO STRICT first_call FROM pg_temp.record_phase12_proposal('accepted', repeat('a', 64));
  SELECT * INTO STRICT replay FROM pg_temp.record_phase12_proposal('accepted', repeat('a', 64));
  IF NOT first_call.inserted OR replay.inserted OR first_call.proposal_row_id <> replay.proposal_row_id THEN
    RAISE EXCEPTION 'proposal exact idempotency failed';
  END IF;
END $$;

SELECT pg_temp.expect_error('cross-tenant document',
  $probe$SELECT * FROM pg_temp.record_phase12_proposal(
    'cross-tenant-document', repeat('1',64),
    p_document => 'b2000000-0000-4000-8000-000000000001')$probe$, '23514');
SELECT pg_temp.expect_error('cross-document artifact',
  $probe$SELECT * FROM pg_temp.record_phase12_proposal(
    'cross-document-artifact', repeat('2',64),
    p_artifact => 'a3000000-0000-4000-8000-000000000002')$probe$, '23514');
SELECT pg_temp.expect_error('wrong organization',
  $probe$SELECT * FROM pg_temp.record_phase12_proposal(
    'wrong-organization', repeat('3',64),
    p_organization => 'b1000000-0000-4000-8000-000000000001')$probe$, '23514');
SELECT pg_temp.expect_error('selected observation ineligible',
  $probe$SELECT * FROM pg_temp.record_phase12_proposal(
    'selected-ineligible', repeat('4',64), p_selected => 'obs:description',
    p_proposed => 'Service')$probe$, '22023');
SELECT pg_temp.expect_error('selected raw text mismatch',
  $probe$SELECT * FROM pg_temp.record_phase12_proposal(
    'selected-mismatch', repeat('5',64), p_proposed => '9.99')$probe$, '22023');
SELECT pg_temp.expect_error('alternative observation ineligible',
  $probe$SELECT * FROM pg_temp.record_phase12_proposal(
    'alternative-ineligible', repeat('6',64),
    p_alternatives => '["obs:description"]'::jsonb)$probe$, '22023');
SELECT pg_temp.expect_error('duplicate evidence',
  $probe$SELECT * FROM pg_temp.record_phase12_proposal(
    'duplicate-evidence', repeat('7',64),
    p_evidence => (pg_temp.phase12_evidence() || (pg_temp.phase12_evidence()->0)))$probe$, '22023');
SELECT pg_temp.expect_error('proposal digest collision',
  $probe$SELECT * FROM pg_temp.record_phase12_proposal(
    'accepted', repeat('a',64), p_snapshot => 'divergent-snapshot')$probe$, '23505');
SELECT pg_temp.expect_error('proposal collision coherent foreign source tuple',
  $probe$SELECT * FROM pg_temp.record_phase12_proposal(
    'accepted', repeat('a',64),
    p_organization => 'b1000000-0000-4000-8000-000000000001',
    p_document => 'b2000000-0000-4000-8000-000000000001',
    p_artifact => 'b3000000-0000-4000-8000-000000000001')$probe$, '23505');
SELECT pg_temp.expect_error('proposal collision physical page',
  $probe$SELECT * FROM pg_temp.record_phase12_proposal(
    'accepted', repeat('a',64), p_page => 8)$probe$, '23505');
SELECT pg_temp.expect_error('proposal collision proposal id',
  $probe$SELECT * FROM pg_temp.record_phase12_proposal(
    'accepted-divergent-id', repeat('a',64))$probe$, '23505');
SELECT pg_temp.expect_error('proposal collision schema version',
  $probe$SELECT * FROM pg_temp.record_phase12_proposal(
    'accepted', repeat('a',64), p_schema => 'forgewing-pricing-rate-cluster-recovery-v2')$probe$, '23505');
SELECT pg_temp.expect_error('proposal collision coherent selected observation bundle',
  $probe$SELECT * FROM pg_temp.record_phase12_proposal(
    'accepted', repeat('a',64), p_selected => 'obs:alternate', p_proposed => '52.50',
    p_normalized => '52.50', p_alternatives => '["obs:selected","obs:other"]'::jsonb)$probe$, '23505');
SELECT pg_temp.expect_error('proposal collision coherent proposed value bundle',
  $probe$SELECT * FROM pg_temp.record_phase12_proposal(
    'accepted', repeat('a',64), p_proposed => '9.99', p_normalized => '9.99',
    p_evidence => jsonb_set(pg_temp.phase12_evidence(), '{0,rawText}', '"9.99"'::jsonb))$probe$, '23505');
SELECT pg_temp.expect_error('proposal collision normalized value',
  $probe$SELECT * FROM pg_temp.record_phase12_proposal(
    'accepted', repeat('a',64), p_normalized => '8.750')$probe$, '23505');
SELECT pg_temp.expect_error('proposal collision page representation digest',
  $probe$SELECT * FROM pg_temp.record_phase12_proposal(
    'accepted', repeat('a',64), p_page_digest => repeat('8',64))$probe$, '23505');
SELECT pg_temp.expect_error('proposal collision evidence',
  $probe$SELECT * FROM pg_temp.record_phase12_proposal(
    'accepted', repeat('a',64),
    p_evidence => jsonb_set(pg_temp.phase12_evidence(), '{2,rawText}', '"Changed service"'::jsonb))$probe$, '23505');
SELECT pg_temp.expect_error('proposal collision alternatives',
  $probe$SELECT * FROM pg_temp.record_phase12_proposal(
    'accepted', repeat('a',64),
    p_alternatives => '["obs:alternate","obs:other"]'::jsonb)$probe$, '23505');
SELECT pg_temp.expect_error('proposal collision certainty',
  $probe$SELECT * FROM pg_temp.record_phase12_proposal(
    'accepted', repeat('a',64), p_certainty => 0.8)$probe$, '23505');
SELECT pg_temp.expect_error('proposal collision reason category',
  $probe$SELECT * FROM pg_temp.record_phase12_proposal(
    'accepted', repeat('a',64), p_reason => 'different_reason')$probe$, '23505');
SELECT pg_temp.expect_error('proposal collision provider model',
  $probe$SELECT * FROM pg_temp.record_phase12_proposal(
    'accepted', repeat('a',64), p_provider => 'different-provider')$probe$, '23505');
SELECT pg_temp.expect_error('proposal collision prompt template id',
  $probe$SELECT * FROM pg_temp.record_phase12_proposal(
    'accepted', repeat('a',64), p_prompt_id => 'different.prompt')$probe$, '23505');
SELECT pg_temp.expect_error('proposal collision prompt template version',
  $probe$SELECT * FROM pg_temp.record_phase12_proposal(
    'accepted', repeat('a',64), p_prompt_version => 'v2')$probe$, '23505');
SELECT pg_temp.expect_error('proposal collision shadow artifact path',
  $probe$SELECT * FROM pg_temp.record_phase12_proposal(
    'accepted', repeat('a',64), p_shadow_path => 'phase12/shadow.json')$probe$, '23505');

SELECT * FROM pg_temp.record_phase12_proposal('modified', repeat('b', 64));
SELECT * FROM pg_temp.record_phase12_proposal('rejected', repeat('c', 64));
SELECT * FROM pg_temp.record_phase12_proposal('deferred', repeat('d', 64));
SELECT * FROM pg_temp.record_phase12_proposal('ambiguous', repeat('e', 64));
SELECT * FROM pg_temp.record_phase12_proposal('typescript', repeat('f', 64));
SELECT * FROM pg_temp.record_phase12_proposal('concurrency', repeat('0', 64));

DO $$
DECLARE accepted record; replay record; modified record; rejected record; deferred record;
BEGIN
  SELECT * INTO STRICT accepted FROM pg_temp.record_phase12_review(
    'accepted', repeat('a',64), repeat('1',64), 'accepted', 'obs:selected', 'Accepted.');
  SELECT * INTO STRICT replay FROM pg_temp.record_phase12_review(
    'accepted', repeat('a',64), repeat('1',64), 'accepted', 'obs:selected', 'Accepted.');
  IF NOT accepted.inserted OR replay.inserted OR accepted.review_id <> replay.review_id
     OR accepted.review_version <> replay.review_version OR accepted.confirmed_raw_text <> '8.75' THEN
    RAISE EXCEPTION 'review exact idempotency or confirmed text derivation failed';
  END IF;
  SELECT * INTO STRICT modified FROM pg_temp.record_phase12_review(
    'modified', repeat('b',64), repeat('2',64), 'modified', 'obs:alternate', 'Modified.');
  SELECT * INTO STRICT rejected FROM pg_temp.record_phase12_review(
    'rejected', repeat('c',64), repeat('3',64), 'rejected', NULL, 'Rejected.');
  SELECT * INTO STRICT deferred FROM pg_temp.record_phase12_review(
    'deferred', repeat('d',64), repeat('4',64), 'deferred', NULL, 'Deferred.');
  IF modified.confirmed_raw_text <> '52.50'
     OR rejected.confirmed_observation_id IS NOT NULL OR rejected.confirmed_raw_text IS NOT NULL
     OR deferred.confirmed_observation_id IS NOT NULL OR deferred.confirmed_raw_text IS NOT NULL THEN
    RAISE EXCEPTION 'review disposition matrix failed';
  END IF;
  PERFORM * FROM pg_temp.record_phase12_review(
    'ambiguous', repeat('e',64), repeat('5',64), 'accepted', 'obs:selected', 'First approval.');
  PERFORM * FROM pg_temp.record_phase12_review(
    'ambiguous', repeat('e',64), repeat('6',64), 'modified', 'obs:alternate', 'Second approval.');
END $$;

SELECT pg_temp.expect_error('review wrong organization idempotency replay',
  $probe$SELECT * FROM pg_temp.record_phase12_review(
    'accepted', repeat('a',64), repeat('1',64), 'accepted', 'obs:selected', 'Accepted.',
    p_organization => 'b1000000-0000-4000-8000-000000000001')$probe$, '42501');
SELECT pg_temp.expect_error('review wrong proposal id idempotency replay',
  $probe$SELECT * FROM pg_temp.record_phase12_review(
    'missing', repeat('a',64), repeat('1',64), 'accepted', 'obs:selected', 'Accepted.')$probe$, 'P0002');
SELECT pg_temp.expect_error('review foreign actor',
  $probe$SELECT * FROM pg_temp.record_phase12_review(
    'accepted', repeat('a',64), repeat('7',64), 'accepted', 'obs:selected', 'Foreign actor.',
    p_reviewer => 'b6000000-0000-4000-8000-000000000001')$probe$, '42501');
SELECT pg_temp.expect_error('cross-proposal digest pin',
  $probe$SELECT * FROM pg_temp.record_phase12_review(
    'modified', repeat('a',64), repeat('8',64), 'accepted', 'obs:selected', 'Wrong pin.')$probe$, 'P0002');
SELECT pg_temp.expect_error('invalid disposition',
  $probe$SELECT * FROM pg_temp.record_phase12_review(
    'accepted', repeat('a',64), repeat('9',64), 'approved', NULL, 'Invalid.')$probe$, '22023');
SELECT pg_temp.expect_error('accepted wrong observation',
  $probe$SELECT * FROM pg_temp.record_phase12_review(
    'accepted', repeat('a',64), repeat('8',64), 'accepted', 'obs:alternate', 'Wrong selection.')$probe$, '22023');
SELECT pg_temp.expect_error('modified selected observation',
  $probe$SELECT * FROM pg_temp.record_phase12_review(
    'modified', repeat('b',64), repeat('9',64), 'modified', 'obs:selected', 'Not modified.')$probe$, '22023');
SELECT pg_temp.expect_error('ineligible confirmation',
  $probe$SELECT * FROM pg_temp.record_phase12_review(
    'accepted', repeat('a',64), repeat('7',64), 'accepted', 'obs:description', 'Ineligible.')$probe$, '22023');

DO $$
DECLARE proposal_fn regprocedure := 'public.record_forgewing_recovery_proposal(uuid,uuid,uuid,text,integer,text,text,text,text,text,text,text,jsonb,jsonb,numeric,text,text,text,text,text)'::regprocedure;
DECLARE review_fn regprocedure := 'public.record_forgewing_recovery_proposal_review(uuid,text,text,uuid,text,text,text,text)'::regprocedure;
DECLARE mutation_fn regprocedure := 'public.reject_forgewing_recovery_mutation()'::regprocedure;
BEGIN
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.forgewing_recovery_proposals'::regclass)
     OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.forgewing_recovery_proposal_reviews'::regclass) THEN
    RAISE EXCEPTION 'recovery RLS is not enabled';
  END IF;
  IF has_function_privilege('anon', proposal_fn, 'EXECUTE')
     OR has_function_privilege('authenticated', proposal_fn, 'EXECUTE')
     OR has_function_privilege('anon', review_fn, 'EXECUTE')
     OR has_function_privilege('authenticated', review_fn, 'EXECUTE')
     OR NOT has_function_privilege('service_role', proposal_fn, 'EXECUTE')
     OR NOT has_function_privilege('service_role', review_fn, 'EXECUTE')
     OR has_function_privilege('anon', mutation_fn, 'EXECUTE')
     OR has_function_privilege('authenticated', mutation_fn, 'EXECUTE')
     OR has_function_privilege('service_role', mutation_fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'recovery function ACL mismatch';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_proc function
    CROSS JOIN LATERAL aclexplode(coalesce(
      function.proacl, acldefault('f', function.proowner))) privilege
    WHERE function.oid IN (proposal_fn, review_fn, mutation_fn)
      AND privilege.grantee = 0
      AND privilege.privilege_type = 'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'PUBLIC recovery function execute privilege leaked';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_proc function
    JOIN pg_roles owner ON owner.oid = function.proowner
    WHERE function.oid IN (proposal_fn, review_fn, mutation_fn)
      AND (NOT function.prosecdef OR owner.rolname <> 'postgres'
        OR function.proconfig IS DISTINCT FROM ARRAY['search_path=""']::text[])
  ) THEN
    RAISE EXCEPTION 'recovery function security posture mismatch';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM (VALUES ('anon'), ('authenticated'), ('service_role')) role(role_name)
    CROSS JOIN (VALUES
      ('public.forgewing_recovery_proposals'),
      ('public.forgewing_recovery_proposal_reviews')) target(table_name)
    WHERE has_table_privilege(role.role_name, target.table_name, 'INSERT')
       OR has_table_privilege(role.role_name, target.table_name, 'UPDATE')
       OR has_table_privilege(role.role_name, target.table_name, 'DELETE')
       OR has_table_privilege(role.role_name, target.table_name, 'TRUNCATE')
       OR has_table_privilege(role.role_name, target.table_name, 'SELECT')
          IS DISTINCT FROM (role.role_name = 'service_role')
  ) THEN
    RAISE EXCEPTION 'recovery table role privilege mismatch';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_class relation
    CROSS JOIN LATERAL aclexplode(coalesce(
      relation.relacl, acldefault('r', relation.relowner))) privilege
    WHERE relation.oid IN (
      'public.forgewing_recovery_proposals'::regclass,
      'public.forgewing_recovery_proposal_reviews'::regclass)
      AND privilege.grantee = 0
  ) THEN
    RAISE EXCEPTION 'PUBLIC recovery table privilege leaked';
  END IF;
END $$;

SET ROLE service_role;
SELECT pg_temp.expect_error('proposal direct insert',
  $probe$INSERT INTO public.forgewing_recovery_proposals DEFAULT VALUES$probe$, '42501');
SELECT pg_temp.expect_error('review direct insert',
  $probe$INSERT INTO public.forgewing_recovery_proposal_reviews DEFAULT VALUES$probe$, '42501');
RESET ROLE;
SELECT pg_temp.expect_error('proposal immutable update',
  $probe$UPDATE public.forgewing_recovery_proposals SET proposed_value = 'changed'
    WHERE proposal_digest_sha256 = repeat('a',64)$probe$, '42501');
SELECT pg_temp.expect_error('review immutable delete',
  $probe$DELETE FROM public.forgewing_recovery_proposal_reviews
    WHERE review_request_digest_sha256 = repeat('1',64)$probe$, '42501');

SELECT 'PHASE 12 RECOVERY PROPOSAL / REVIEW / ACL QUALIFICATION: PASS' AS result;
