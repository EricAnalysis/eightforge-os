-- Run against an isolated migrated test database with psql -v ON_ERROR_STOP=1.
-- Introspection and privilege probes are read-only; fixture-based write tests
-- belong in a rolled-back integration transaction.
DO $$
DECLARE
  v_table text;
  v_count integer;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'fde_plan_supplemental_documents','fde_plan_snapshots','fde_plan_reviews',
    'fde_plan_need_resolutions','fde_plan_evidence_waivers'
  ] LOOP
    IF to_regclass('public.'||v_table) IS NULL THEN
      RAISE EXCEPTION 'missing FDE table: %',v_table;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname=v_table AND c.relrowsecurity) THEN
      RAISE EXCEPTION 'RLS missing: %',v_table;
    END IF;
    IF has_table_privilege('anon','public.'||v_table,'SELECT')
      OR has_table_privilege('anon','public.'||v_table,'INSERT')
      OR has_table_privilege('authenticated','public.'||v_table,'SELECT')
      OR has_table_privilege('authenticated','public.'||v_table,'INSERT')
      OR has_table_privilege('service_role','public.'||v_table,'UPDATE')
      OR has_table_privilege('service_role','public.'||v_table,'DELETE') THEN
      RAISE EXCEPTION 'direct FDE table privilege widened: %',v_table;
    END IF;
    SELECT count(*) INTO v_count FROM pg_trigger t
      WHERE t.tgrelid=to_regclass('public.'||v_table) AND NOT t.tgisinternal
        AND t.tgname=v_table||'_immutable';
    IF v_count<>1 THEN RAISE EXCEPTION 'immutable trigger missing: %',v_table; END IF;
    -- 20261118120000: TRUNCATE bypasses row triggers, so each table carries a statement guard.
    SELECT count(*) INTO v_count FROM pg_trigger t
      WHERE t.tgrelid=to_regclass('public.'||v_table) AND NOT t.tgisinternal
        AND t.tgname=v_table||'_no_truncate' AND (t.tgtype & 32)<>0 AND (t.tgtype & 2)<>0
        AND t.tgenabled='O' AND t.tgfoid='public.reject_fde_plan_record_mutation()'::regprocedure;
    IF v_count<>1 THEN RAISE EXCEPTION 'truncate guard missing: %',v_table; END IF;
  END LOOP;
  -- Supplemental documents are written only through the SECURITY DEFINER RPC.
  IF has_table_privilege('service_role','public.fde_plan_supplemental_documents','INSERT')
    OR NOT has_table_privilege('service_role','public.fde_plan_supplemental_documents','SELECT')
    OR NOT has_table_privilege('service_role','public.fde_plan_snapshots','INSERT')
    OR has_table_privilege('service_role','public.fde_plan_reviews','INSERT')
    OR has_table_privilege('service_role','public.fde_plan_need_resolutions','INSERT')
    OR has_table_privilege('service_role','public.fde_plan_evidence_waivers','INSERT') THEN
    RAISE EXCEPTION 'FDE direct insert privilege mismatch';
  END IF;
  IF has_function_privilege('authenticated','public.record_fde_plan_review(uuid,text,text,text,text,text,text,uuid,jsonb,jsonb,integer)','EXECUTE')
    OR has_function_privilege('anon','public.record_fde_plan_review(uuid,text,text,text,text,text,text,uuid,jsonb,jsonb,integer)','EXECUTE')
    OR NOT has_function_privilege('service_role','public.record_fde_plan_review(uuid,text,text,text,text,text,text,uuid,jsonb,jsonb,integer)','EXECUTE') THEN
    RAISE EXCEPTION 'FDE review RPC privilege mismatch';
  END IF;
  IF has_function_privilege('authenticated','public.record_fde_plan_supplemental_document(jsonb,text[],uuid,uuid,uuid,text)','EXECUTE')
    OR has_function_privilege('anon','public.record_fde_plan_supplemental_document(jsonb,text[],uuid,uuid,uuid,text)','EXECUTE') THEN
    RAISE EXCEPTION 'FDE upload RPC privilege mismatch';
  END IF;
END $$;

-- Fixture-backed checks run in a single rolled-back transaction. These rows
-- never become application evidence, even in the disposable replay database.
BEGIN;
INSERT INTO public.organizations(id,name) VALUES
  ('f1000000-0000-4000-8000-000000000001','FDE replay A'),
  ('f1000000-0000-4000-8000-000000000002','FDE replay B');
INSERT INTO auth.users(id,email) VALUES
  ('f2000000-0000-4000-8000-000000000001','fde-a@example.invalid'),
  ('f2000000-0000-4000-8000-000000000002','fde-b@example.invalid');
INSERT INTO public.user_profiles(id,organization_id) VALUES
  ('f2000000-0000-4000-8000-000000000001','f1000000-0000-4000-8000-000000000001'),
  ('f2000000-0000-4000-8000-000000000002','f1000000-0000-4000-8000-000000000002');
INSERT INTO public.workflow_intake_submissions
  (id,schema_version,organization_id,submitted_by_actor_id,workflow_description,
   manual_checks,frequency_and_volume,exceptions,human_decisions,information_or_systems,success_outcome)
VALUES ('f3000000-0000-4000-8000-000000000001','workflow_intake_v2',
  'f1000000-0000-4000-8000-000000000001','f2000000-0000-4000-8000-000000000001',
  'Test workflow','Test checks','Weekly','Exceptions reviewed','Human approval','Test systems','Reviewed outcome');
INSERT INTO public.workflow_assessments
  (id,source_submission_id,assessment_version,schema_version,assessment,
   assessment_digest_sha256,model,prompt_template_id,prompt_template_version)
VALUES ('f4000000-0000-4000-8000-000000000001','f3000000-0000-4000-8000-000000000001',
  1,'workflow_assessment_v2','{}'::jsonb,repeat('a',64),'test-model','test-prompt','v1');
WITH payload AS (
  SELECT jsonb_build_object('schemaVersion','fde_intake_plan_v1','authority','non_authoritative',
    'informationNeeds','[]'::jsonb,
    'pinnedInputs',jsonb_build_object('assessmentId','f4000000-0000-4000-8000-000000000001',
      'assessmentVersion',1,'sourceSubmissionId','f3000000-0000-4000-8000-000000000001',
      'supplementalEvidence',jsonb_build_object('evidenceRevision',0,'documents','[]'::jsonb)))::text AS body
)
INSERT INTO public.fde_plan_snapshots
  (id,organization_id,source_submission_id,assessment_id,assessment_version,evidence_revision,
   plan_digest_sha256,plan_canonical_json,created_by_actor_id)
SELECT 'f5000000-0000-4000-8000-000000000001','f1000000-0000-4000-8000-000000000001',
  'f3000000-0000-4000-8000-000000000001','f4000000-0000-4000-8000-000000000001',
  1,0,encode(extensions.digest(convert_to(body,'UTF8'),'sha256'),'hex'),body,
  'f2000000-0000-4000-8000-000000000001' FROM payload;

DO $$
BEGIN
  BEGIN
    UPDATE public.fde_plan_snapshots SET created_at=clock_timestamp()
      WHERE id='f5000000-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'immutable FDE snapshot accepted update';
  EXCEPTION WHEN SQLSTATE '42501' THEN NULL;
  END;
END $$;

-- A decision binds the decision history its reviewer saw. The snapshot is still current here.
SET request.jwt.claim.role='service_role';
DO $$
DECLARE v_base text; v_body text; v_digest text; v_version integer;
BEGIN
  SELECT plan_digest_sha256 INTO STRICT v_base FROM public.fde_plan_snapshots
    WHERE id='f5000000-0000-4000-8000-000000000001';
  v_body:=jsonb_build_object('authority','non_authoritative','basePlanDigestSha256',v_base,
    'sourceSubmissionId','f3000000-0000-4000-8000-000000000001','assessmentId','f4000000-0000-4000-8000-000000000001',
    'assessmentVersion',1,'evidenceRevision',0,'eligible',false,'blockers',jsonb_build_array('test'),
    'deploymentApproach',jsonb_build_object('state','undetermined','rung',null))::text;
  v_digest:=encode(extensions.digest(convert_to(v_body,'UTF8'),'sha256'),'hex');
  BEGIN
    PERFORM * FROM public.record_fde_plan_review('f5000000-0000-4000-8000-000000000001',v_base,v_body,v_digest,
      'rejected','History probe one.',repeat('a',64),'f2000000-0000-4000-8000-000000000001','[]'::jsonb,'[]'::jsonb,1);
    RAISE EXCEPTION 'expected history ahead of the record accepted';
  EXCEPTION WHEN SQLSTATE '40001' THEN NULL;
  END;
  SELECT r.review_version INTO STRICT v_version FROM public.record_fde_plan_review('f5000000-0000-4000-8000-000000000001',v_base,v_body,v_digest,
    'rejected','History probe two.',repeat('9',64),'f2000000-0000-4000-8000-000000000001','[]'::jsonb,'[]'::jsonb,0) r;
  IF v_version<>1 THEN RAISE EXCEPTION 'decision version not allocated from the seen history'; END IF;
  BEGIN
    PERFORM * FROM public.record_fde_plan_review('f5000000-0000-4000-8000-000000000001',v_base,v_body,v_digest,
      'rejected','Unseen decision probe.',repeat('8',64),'f2000000-0000-4000-8000-000000000001','[]'::jsonb,'[]'::jsonb,0);
    RAISE EXCEPTION 'unseen decision history accepted';
  EXCEPTION WHEN SQLSTATE '40001' THEN NULL;
  END;
END $$;
RESET request.jwt.claim.role;

INSERT INTO public.fde_plan_supplemental_documents
  (id,organization_id,source_submission_id,assessment_id,base_snapshot_id,evidence_revision,
   uploaded_by_actor_id,upload_request_id,upload_request_digest_sha256,need_ids,original_filename,
   media_type,byte_size,content_sha256,storage_bucket,storage_path,storage_version,status,error,provenance)
VALUES
  ('f6000000-0000-4000-8000-000000000001','f1000000-0000-4000-8000-000000000001',
   'f3000000-0000-4000-8000-000000000001','f4000000-0000-4000-8000-000000000001',
   'f5000000-0000-4000-8000-000000000001',1,'f2000000-0000-4000-8000-000000000001',
   'f7000000-0000-4000-8000-000000000001',repeat('d',64),'{}','failed-evidence.pdf',
   'application/pdf',1,repeat('e',64),'documents',
   'f1000000-0000-4000-8000-000000000001/fde-plans/f3000000-0000-4000-8000-000000000001/f6000000-0000-4000-8000-000000000001',
   'fixture-version','failed','Processing unavailable','{}'::jsonb);

SET request.jwt.claim.role='service_role';
DO $$
DECLARE v_base text; v_body text; v_digest text;
BEGIN
  SELECT plan_digest_sha256 INTO STRICT v_base FROM public.fde_plan_snapshots
    WHERE id='f5000000-0000-4000-8000-000000000001';
  v_body:=jsonb_build_object('schemaVersion','fde_resolved_plan_v1','authority','non_authoritative',
    'basePlanDigestSha256',v_base,'sourceSubmissionId','f3000000-0000-4000-8000-000000000001',
    'assessmentId','f4000000-0000-4000-8000-000000000001','assessmentVersion',1,
    'evidenceRevision',0,'eligible',false,'blockers',jsonb_build_array('test'),
    'deploymentApproach',jsonb_build_object('state','undetermined','rung',null))::text;
  v_digest:=encode(extensions.digest(convert_to(v_body,'UTF8'),'sha256'),'hex');
  BEGIN
    PERFORM * FROM public.record_fde_plan_supplemental_document(
      jsonb_build_object('id','f6000000-0000-4000-8000-000000000002','provenance','{}'::jsonb),
      '{}'::text[],'f2000000-0000-4000-8000-000000000001',
      'f5000000-0000-4000-8000-000000000001',
      'f7000000-0000-4000-8000-000000000002',repeat('f',64));
    RAISE EXCEPTION 'stale FDE upload base accepted';
  EXCEPTION WHEN SQLSTATE '40001' THEN NULL;
  END;
  BEGIN
    PERFORM * FROM public.record_fde_plan_review(
      'f5000000-0000-4000-8000-000000000001',v_base,v_body,v_digest,
      'rejected','Cross-tenant probe.',repeat('b',64),
      'f2000000-0000-4000-8000-000000000002','[]'::jsonb,'[]'::jsonb,0);
    RAISE EXCEPTION 'cross-tenant FDE reviewer accepted';
  EXCEPTION WHEN SQLSTATE '42501' THEN NULL;
  END;
  BEGIN
    PERFORM * FROM public.record_fde_plan_review(
      'f5000000-0000-4000-8000-000000000001',v_base,v_body,repeat('0',64),
      'rejected','Digest probe.',repeat('c',64),
      'f2000000-0000-4000-8000-000000000001','[]'::jsonb,'[]'::jsonb,0);
    RAISE EXCEPTION 'wrong resolved digest accepted';
  EXCEPTION WHEN SQLSTATE '23514' THEN NULL;
  END;
END $$;
RESET request.jwt.claim.role;
ROLLBACK;

-- 20261118120000 hardening. The database enforces need coverage itself; it does
-- not rely on the caller's eligible flag. Plans, the parsed CSV, and resolved
-- plans are real builder/parser/resolver output (see the generated fixture).
-- Every approved probe below carries the genuinely eligible resolved plan, so a
-- refusal can only come from the database's own check of the judgment rows.
BEGIN;
\ir fixtures/fde-plan-approval-hardening.sql
CREATE FUNCTION pg_temp.fde_fixture(p_key text) RETURNS text LANGUAGE sql STABLE
  AS $$ SELECT value FROM fde_hardening_fixture WHERE key=p_key $$;
CREATE FUNCTION pg_temp.fde_review(p_submission uuid,p_resolved text,p_digest text,p_disposition text,
  p_resolutions jsonb,p_waivers jsonb,p_expected integer,p_label text) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE v_snapshot public.fde_plan_snapshots%ROWTYPE; v_version integer;
BEGIN
  SELECT * INTO STRICT v_snapshot FROM public.fde_plan_snapshots WHERE source_submission_id=p_submission
    ORDER BY evidence_revision DESC LIMIT 1;
  SELECT r.review_version INTO STRICT v_version FROM public.record_fde_plan_review(v_snapshot.id,v_snapshot.plan_digest_sha256,
    p_resolved,p_digest,p_disposition,'Hardening probe: '||p_label,repeat(md5(p_label),2),
    'fa100000-0000-4000-8000-000000000001',p_resolutions,p_waivers,p_expected) r;
  RETURN v_version;
END $$;
CREATE FUNCTION pg_temp.fde_expect_refusal(p_submission uuid,p_resolved text,p_digest text,p_disposition text,
  p_resolutions jsonb,p_waivers jsonb,p_label text,p_message text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    PERFORM pg_temp.fde_review(p_submission,p_resolved,p_digest,p_disposition,p_resolutions,p_waivers,0,p_label);
  EXCEPTION WHEN SQLSTATE '23514' THEN
    IF SQLERRM IS DISTINCT FROM p_message THEN RAISE EXCEPTION '% refused by the wrong check: %',p_label,SQLERRM; END IF;
    RETURN;
  END;
  RAISE EXCEPTION 'FDE hardening probe accepted: %',p_label;
END $$;
GRANT EXECUTE ON FUNCTION pg_temp.fde_fixture(text) TO service_role;

INSERT INTO public.organizations(id,name) VALUES ('fa000000-0000-4000-8000-000000000001','FDE hardening replay');
INSERT INTO auth.users(id,email) VALUES ('fa100000-0000-4000-8000-000000000001','fde-hardening@example.invalid');
INSERT INTO public.user_profiles(id,organization_id) VALUES ('fa100000-0000-4000-8000-000000000001','fa000000-0000-4000-8000-000000000001');
INSERT INTO public.workflow_intake_submissions
  (id,schema_version,organization_id,submitted_by_actor_id,workflow_description,
   manual_checks,frequency_and_volume,exceptions,human_decisions,information_or_systems,success_outcome)
SELECT s.id,'workflow_intake_v2','fa000000-0000-4000-8000-000000000001','fa100000-0000-4000-8000-000000000001',
  'Reconcile haul tickets against the rate schedule','Manual check','Weekly','Reviewed','Supervisor','Haul log','Reconciled haul rows'
FROM (VALUES ('fa200000-0000-4000-8000-000000000001'::uuid),('fa200000-0000-4000-8000-000000000002'::uuid)) s(id);
INSERT INTO public.workflow_assessments
  (id,source_submission_id,assessment_version,schema_version,assessment,
   assessment_digest_sha256,model,prompt_template_id,prompt_template_version)
VALUES ('fa300000-0000-4000-8000-000000000001','fa200000-0000-4000-8000-000000000001',1,'workflow_assessment_v2','{}'::jsonb,repeat('a',64),'test-model','test-prompt','v1'),
       ('fa300000-0000-4000-8000-000000000002','fa200000-0000-4000-8000-000000000002',1,'workflow_assessment_v2','{}'::jsonb,repeat('a',64),'test-model','test-prompt','v1');
INSERT INTO public.workflow_assessment_reviews(id,assessment_id,source_submission_id,assessment_version,review_version,reviewer_actor_id,overall_disposition)
VALUES ('fa400000-0000-4000-8000-000000000001','fa300000-0000-4000-8000-000000000001','fa200000-0000-4000-8000-000000000001',1,1,'fa100000-0000-4000-8000-000000000001','accepted');

-- The application's own write paths, as service_role: snapshot insert and the
-- supplemental-document RPC (which must still work with direct INSERT revoked).
SET LOCAL ROLE service_role;
SET LOCAL request.jwt.claim.role='service_role';
DO $$ BEGIN
  BEGIN
    INSERT INTO public.fde_plan_supplemental_documents(id) VALUES ('fa500000-0000-4000-8000-0000000000ff');
    RAISE EXCEPTION 'direct FDE supplemental document insert accepted';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;
INSERT INTO public.fde_plan_snapshots(organization_id,source_submission_id,assessment_id,assessment_version,evidence_revision,
  plan_digest_sha256,plan_canonical_json,created_by_actor_id)
VALUES ('fa000000-0000-4000-8000-000000000001','fa200000-0000-4000-8000-000000000001','fa300000-0000-4000-8000-000000000001',1,0,
  pg_temp.fde_fixture('base_plan_digest'),pg_temp.fde_fixture('base_plan'),'fa100000-0000-4000-8000-000000000001');
DO $$ DECLARE v_revision integer; v_inserted boolean; BEGIN
  SELECT d.evidence_revision,d.inserted INTO STRICT v_revision,v_inserted FROM public.record_fde_plan_supplemental_document(
    pg_temp.fde_fixture('upload_document')::jsonb,'{}'::text[],'fa100000-0000-4000-8000-000000000001',
    (SELECT id FROM public.fde_plan_snapshots WHERE source_submission_id='fa200000-0000-4000-8000-000000000001' AND evidence_revision=0),
    'fa600000-0000-4000-8000-000000000001',pg_temp.fde_fixture('upload_digest')) d;
  IF v_revision<>1 OR NOT v_inserted THEN RAISE EXCEPTION 'FDE supplemental document RPC did not record revision 1'; END IF;
END $$;
INSERT INTO public.fde_plan_snapshots(organization_id,source_submission_id,assessment_id,assessment_version,evidence_revision,
  plan_digest_sha256,plan_canonical_json,created_by_actor_id)
VALUES ('fa000000-0000-4000-8000-000000000001','fa200000-0000-4000-8000-000000000001','fa300000-0000-4000-8000-000000000001',1,1,
  pg_temp.fde_fixture('plan_digest'),pg_temp.fde_fixture('plan'),'fa100000-0000-4000-8000-000000000001'),
  ('fa000000-0000-4000-8000-000000000001','fa200000-0000-4000-8000-000000000002','fa300000-0000-4000-8000-000000000002',1,0,
  pg_temp.fde_fixture('structural_plan_digest'),pg_temp.fde_fixture('structural_plan'),'fa100000-0000-4000-8000-000000000001');

DO $$
DECLARE
  c_message constant text := 'FDE approval does not resolve every need exactly once';
  v_sub constant uuid := 'fa200000-0000-4000-8000-000000000001';
  v_resolved text := pg_temp.fde_fixture('approval_resolved');
  v_digest text := pg_temp.fde_fixture('approval_resolved_digest');
  v_waiver jsonb := pg_temp.fde_fixture('waiver')::jsonb;
  v_file jsonb := pg_temp.fde_fixture('confirmed')::jsonb;
  v_limited jsonb := pg_temp.fde_fixture('limited_confirmed')::jsonb;
  v_version integer;
BEGIN
  PERFORM pg_temp.fde_expect_refusal(v_sub,v_resolved,v_digest,'approved',jsonb_build_array(v_file,v_limited),'[]'::jsonb,
    'approval omits the waived need',c_message);
  PERFORM pg_temp.fde_expect_refusal(v_sub,v_resolved,v_digest,'approved',jsonb_build_array(v_file),jsonb_build_array(v_waiver),
    'approval omits a confirmed need',c_message);
  PERFORM pg_temp.fde_expect_refusal(v_sub,v_resolved,v_digest,'approved',
    jsonb_build_array(v_file,v_limited || '{"disposition":"unresolved"}'),jsonb_build_array(v_waiver),
    'approval carries an unresolved need',c_message);
  PERFORM pg_temp.fde_expect_refusal(v_sub,v_resolved,v_digest,'approved',
    jsonb_build_array(v_file,v_limited,v_file || jsonb_build_object('needId',pg_temp.fde_fixture('described_need_id'))),jsonb_build_array(v_waiver),
    'approval both waives and confirms one need',c_message);
  PERFORM pg_temp.fde_expect_refusal(v_sub,v_resolved,v_digest,'approved',
    jsonb_build_array(v_file || jsonb_build_object('sourceRefs',v_waiver->'sourceRefs'),v_limited),jsonb_build_array(v_waiver),
    'confirmation cites no source of its need',c_message);
  PERFORM pg_temp.fde_expect_refusal(v_sub,v_resolved,v_digest,'approved',
    jsonb_build_array(v_file || '{"sourceRefs":[{"kind":"attachment","id":"fa500000-0000-4000-8000-0000000000ee","digest":"0000000000000000000000000000000000000000000000000000000000000000"}]}',v_limited),
    jsonb_build_array(v_waiver),'confirmation cites an unpinned attachment',c_message);
  PERFORM pg_temp.fde_expect_refusal(v_sub,v_resolved,v_digest,'approved',jsonb_build_array(v_file,v_limited),
    jsonb_build_array(v_waiver || '{"requirement":"A different requirement"}'),'waiver restates the requirement',c_message);
  PERFORM pg_temp.fde_expect_refusal(v_sub,v_resolved,v_digest,'approved',jsonb_build_array(v_file,v_limited),
    jsonb_build_array(v_waiver || '{"sourceRefs":[]}'),'waiver cites no customer statement source',c_message);
  -- Positive control: the exact judgments the service resolver accepted.
  v_version := pg_temp.fde_review(v_sub,v_resolved,v_digest,'approved',jsonb_build_array(v_file,v_limited),jsonb_build_array(v_waiver),0,'valid approval');
  IF v_version<>1
    OR (SELECT count(*) FROM public.fde_plan_need_resolutions n JOIN public.fde_plan_reviews r ON r.id=n.review_id
        WHERE r.source_submission_id=v_sub AND n.disposition='confirmed')<>2
    OR (SELECT count(*) FROM public.fde_plan_evidence_waivers w WHERE w.source_submission_id=v_sub)<>1 THEN
    RAISE EXCEPTION 'valid FDE approval was not recorded exactly';
  END IF;
END $$;

DO $$
DECLARE
  c_message constant text := 'structural FDE need cannot be confirmed';
  v_sub constant uuid := 'fa200000-0000-4000-8000-000000000002';
  v_confirmed jsonb := jsonb_build_array(pg_temp.fde_fixture('human_confirmed')::jsonb);
BEGIN
  PERFORM pg_temp.fde_expect_refusal(v_sub,pg_temp.fde_fixture('structural_confirmed_resolved'),
    pg_temp.fde_fixture('structural_confirmed_resolved_digest'),'rejected',v_confirmed,'[]'::jsonb,'rejected confirms a human step',c_message);
  PERFORM pg_temp.fde_expect_refusal(v_sub,pg_temp.fde_fixture('structural_confirmed_resolved'),
    pg_temp.fde_fixture('structural_confirmed_resolved_digest'),'changes_requested',v_confirmed,'[]'::jsonb,'changes_requested confirms a human step',c_message);
  PERFORM pg_temp.fde_expect_refusal(v_sub,pg_temp.fde_fixture('structural_confirmed_resolved'),
    pg_temp.fde_fixture('structural_confirmed_resolved_digest'),'approved',v_confirmed,'[]'::jsonb,'approved confirms a human step',
    'FDE recommendation is not eligible');
  -- Recording a structural need as unresolved is still a legitimate decision.
  IF pg_temp.fde_review(v_sub,pg_temp.fde_fixture('structural_unresolved_resolved'),pg_temp.fde_fixture('structural_unresolved_resolved_digest'),
      'rejected',jsonb_build_array(pg_temp.fde_fixture('human_unresolved')::jsonb),'[]'::jsonb,0,'unresolved structural need')<>1 THEN
    RAISE EXCEPTION 'unresolved structural need was not recorded';
  END IF;
END $$;
RESET ROLE;
RESET request.jwt.claim.role;

-- TRUNCATE skips row triggers; the statement guard refuses it even for the owner.
DO $$
DECLARE v_table text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY['fde_plan_need_resolutions','fde_plan_evidence_waivers'] LOOP
    BEGIN
      EXECUTE format('TRUNCATE public.%I',v_table);
      RAISE EXCEPTION 'FDE TRUNCATE accepted: %',v_table;
    EXCEPTION WHEN SQLSTATE '42501' THEN NULL;
    END;
  END LOOP;
  FOREACH v_table IN ARRAY ARRAY['fde_plan_supplemental_documents','fde_plan_snapshots','fde_plan_reviews',
    'fde_plan_need_resolutions','fde_plan_evidence_waivers'] LOOP
    BEGIN
      EXECUTE format('TRUNCATE public.%I CASCADE',v_table);
      RAISE EXCEPTION 'FDE TRUNCATE CASCADE accepted: %',v_table;
    EXCEPTION WHEN SQLSTATE '42501' THEN NULL;
    END;
  END LOOP;
  IF (SELECT count(*) FROM public.fde_plan_reviews WHERE organization_id='fa000000-0000-4000-8000-000000000001')<>2
    OR (SELECT count(*) FROM public.fde_plan_supplemental_documents WHERE organization_id='fa000000-0000-4000-8000-000000000001')<>1 THEN
    RAISE EXCEPTION 'FDE records lost to TRUNCATE';
  END IF;
END $$;
ROLLBACK;

-- Reject a non-service call even if no fixture exists.
DO $$
BEGIN
  BEGIN
    PERFORM * FROM public.record_fde_plan_review(NULL,'invalid','{}','invalid','approved','x','invalid',NULL,'[]'::jsonb,'[]'::jsonb,0);
    RAISE EXCEPTION 'invalid FDE identity unexpectedly accepted';
  EXCEPTION WHEN SQLSTATE '42501' THEN NULL;
  END;
END $$;

-- Direct browser Storage access must not reach FDE evidence.
DO $$ DECLARE policy_record record; BEGIN
  IF to_regclass('storage.objects') IS NOT NULL THEN
    SELECT * INTO policy_record FROM pg_policies WHERE schemaname='storage' AND tablename='objects' AND policyname='fde_plan_evidence_api_only';
    IF NOT FOUND OR policy_record.permissive<>'RESTRICTIVE' OR policy_record.cmd<>'ALL'
      OR NOT (policy_record.roles @> ARRAY['anon','authenticated']::name[])
      OR policy_record.qual IS NULL OR policy_record.with_check IS NULL THEN
      RAISE EXCEPTION 'FDE storage restrictive access boundary missing';
    END IF;
  END IF;
END $$;
BEGIN;
DO $$ DECLARE v_deleted integer; BEGIN
  IF obj_description(to_regclass('storage.objects'),'pg_class') = 'eightforge_disposable_storage_rls_fixture' THEN
    INSERT INTO storage.objects VALUES ('f8000000-0000-4000-8000-000000000001','documents','f1000000-0000-4000-8000-000000000001/fde-plans/submission/file');
    SET LOCAL ROLE authenticated;
    IF EXISTS (SELECT 1 FROM storage.objects WHERE id='f8000000-0000-4000-8000-000000000001') THEN RAISE EXCEPTION 'direct FDE storage read bypass'; END IF;
    DELETE FROM storage.objects WHERE id='f8000000-0000-4000-8000-000000000001';
    GET DIAGNOSTICS v_deleted = ROW_COUNT;
    IF v_deleted<>0 THEN RAISE EXCEPTION 'direct FDE storage delete bypass'; END IF;
    BEGIN
      INSERT INTO storage.objects VALUES ('f8000000-0000-4000-8000-000000000002','documents','org/fde-plans/submission/forged');
      RAISE EXCEPTION 'direct FDE storage upload bypass';
    EXCEPTION WHEN insufficient_privilege THEN NULL; END;
    RESET ROLE;
  END IF;
END $$;
ROLLBACK;
\echo FDE PLAN APPROVAL DATABASE BOUNDARY: PASS
