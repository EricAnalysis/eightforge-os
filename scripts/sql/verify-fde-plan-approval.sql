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
  END LOOP;
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
