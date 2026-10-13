\set ON_ERROR_STOP on
-- Disposable tenant fixtures. No live/project documents are inserted.
BEGIN;
INSERT INTO public.organizations(id,name) VALUES
 ('93600000-0000-4000-8000-000000000001','Assessment proof A'),
 ('93600000-0000-4000-8000-000000000002','Assessment proof B');
INSERT INTO auth.users(id,email) VALUES
 ('93600000-0000-4000-8000-000000000011','assessment-a@example.invalid'),
 ('93600000-0000-4000-8000-000000000012','assessment-b@example.invalid');
INSERT INTO public.user_profiles(id,organization_id,role) VALUES
 ('93600000-0000-4000-8000-000000000011','93600000-0000-4000-8000-000000000001','owner'),
 ('93600000-0000-4000-8000-000000000012','93600000-0000-4000-8000-000000000002','owner');
SET ROLE service_role;
INSERT INTO public.workflow_assessment_drafts(id,organization_id,created_by_actor_id) VALUES
 ('93600000-0000-4000-8000-000000000021','93600000-0000-4000-8000-000000000001','93600000-0000-4000-8000-000000000011'),
 ('93600000-0000-4000-8000-000000000022','93600000-0000-4000-8000-000000000002','93600000-0000-4000-8000-000000000012'),
 ('93600000-0000-4000-8000-000000000023','93600000-0000-4000-8000-000000000001','93600000-0000-4000-8000-000000000011');
DO $$ BEGIN
 BEGIN
  INSERT INTO public.workflow_assessment_drafts(id,organization_id,created_by_actor_id)
  VALUES('93600000-0000-4000-8000-000000000024','93600000-0000-4000-8000-000000000002','93600000-0000-4000-8000-000000000011');
  RAISE EXCEPTION 'forged draft organization accepted';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
INSERT INTO public.workflow_assessment_attachments(id,draft_id,organization_id,uploaded_by_actor_id,original_filename,media_type,byte_size,content_sha256,representation_digest_sha256,storage_bucket,storage_path,storage_version,status,error,context,provenance) VALUES
 ('93600000-0000-4000-8000-000000000031','93600000-0000-4000-8000-000000000021','93600000-0000-4000-8000-000000000001','93600000-0000-4000-8000-000000000011','proof.csv','text/csv',20,repeat('a',64),repeat('b',64),'documents','93600000-0000-4000-8000-000000000001/workflow-assessments/93600000-0000-4000-8000-000000000021/93600000-0000-4000-8000-000000000031','sql-proof-version','processed',NULL,'{"rows":[["status"],["open"]]}','{"parserVersion":"local-proof","sourceSha256":"source-pin"}'),
 ('93600000-0000-4000-8000-000000000032','93600000-0000-4000-8000-000000000021','93600000-0000-4000-8000-000000000001','93600000-0000-4000-8000-000000000011','broken.pdf','application/pdf',12,repeat('c',64),NULL,'documents','93600000-0000-4000-8000-000000000001/workflow-assessments/93600000-0000-4000-8000-000000000021/93600000-0000-4000-8000-000000000032','sql-proof-version','failed','Invalid PDF',NULL,'{"parserVersion":"local-proof"}');
DO $$ DECLARE answers jsonb := '{"workflowDescription":"Compare statuses","informationOrSystems":"CRM","manualChecks":"Compare","frequencyAndVolume":"Daily","exceptions":"Queue","humanDecisions":"Manager","successOutcome":"Correct statuses"}'; BEGIN
 BEGIN
  PERFORM public.submit_workflow_assessment_draft('93600000-0000-4000-8000-000000000021','93600000-0000-4000-8000-000000000002','93600000-0000-4000-8000-000000000012',answers);
  RAISE EXCEPTION 'cross-org direct draft ID accepted';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN
  PERFORM public.remove_workflow_assessment_attachment('93600000-0000-4000-8000-000000000021','93600000-0000-4000-8000-000000000031','93600000-0000-4000-8000-000000000002','93600000-0000-4000-8000-000000000012');
  RAISE EXCEPTION 'cross-org attachment removal accepted';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN
  PERFORM public.submit_workflow_assessment_draft('93600000-0000-4000-8000-000000000021','93600000-0000-4000-8000-000000000001','93600000-0000-4000-8000-000000000011',answers);
  RAISE EXCEPTION 'failed attachment silently ignored';
 EXCEPTION WHEN check_violation THEN NULL; END;
 IF NOT public.remove_workflow_assessment_attachment('93600000-0000-4000-8000-000000000021','93600000-0000-4000-8000-000000000032','93600000-0000-4000-8000-000000000001','93600000-0000-4000-8000-000000000011') THEN RAISE EXCEPTION 'failed attachment cannot be removed'; END IF;
 IF public.remove_workflow_assessment_attachment('93600000-0000-4000-8000-000000000022','93600000-0000-4000-8000-000000000031','93600000-0000-4000-8000-000000000002','93600000-0000-4000-8000-000000000012') THEN RAISE EXCEPTION 'foreign attachment direct id removed'; END IF;
 PERFORM public.submit_workflow_assessment_draft('93600000-0000-4000-8000-000000000021','93600000-0000-4000-8000-000000000001','93600000-0000-4000-8000-000000000011',answers);
 PERFORM public.submit_workflow_assessment_draft('93600000-0000-4000-8000-000000000022','93600000-0000-4000-8000-000000000002','93600000-0000-4000-8000-000000000012',answers);
 IF public.read_organization_workflow_assessment('93600000-0000-4000-8000-000000000021','93600000-0000-4000-8000-000000000002') IS NOT NULL THEN RAISE EXCEPTION 'cross-org source read accepted'; END IF;
 IF public.read_organization_workflow_assessment('93600000-0000-4000-8000-000000000021','93600000-0000-4000-8000-000000000001')->'source'->>'submitted_by_actor_id'<>'93600000-0000-4000-8000-000000000011' THEN RAISE EXCEPTION 'actor provenance missing'; END IF;
 IF (SELECT attachment_manifest FROM public.read_workflow_intake_submission('93600000-0000-4000-8000-000000000021')) <> jsonb_build_array(jsonb_build_object('attachmentId','93600000-0000-4000-8000-000000000031','sourceSha256',repeat('a',64),'representationDigestSha256',repeat('b',64))) THEN RAISE EXCEPTION 'source manifest pins changed or detached evidence included'; END IF;
 IF (SELECT attachment_manifest FROM public.read_workflow_intake_submission('93600000-0000-4000-8000-000000000022'))<>'[]'::jsonb THEN RAISE EXCEPTION 'text-only submission changed'; END IF;
 BEGIN
  PERFORM public.remove_workflow_assessment_attachment('93600000-0000-4000-8000-000000000021','93600000-0000-4000-8000-000000000031','93600000-0000-4000-8000-000000000001','93600000-0000-4000-8000-000000000011');
  RAISE EXCEPTION 'submitted evidence detached';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
RESET ROLE;
DO $$ DECLARE n integer; BEGIN
 BEGIN
  INSERT INTO public.workflow_assessment_attachments(id,draft_id,organization_id,uploaded_by_actor_id,original_filename,media_type,byte_size,content_sha256,representation_digest_sha256,storage_bucket,storage_path,storage_version,status,context,provenance)
  VALUES('93600000-0000-4000-8000-000000000041','93600000-0000-4000-8000-000000000023','93600000-0000-4000-8000-000000000002','93600000-0000-4000-8000-000000000012','cross.csv','text/csv',1,repeat('a',64),repeat('b',64),'documents','93600000-0000-4000-8000-000000000002/workflow-assessments/93600000-0000-4000-8000-000000000023/93600000-0000-4000-8000-000000000041','sql-proof-version','processed','{}','{}');
  RAISE EXCEPTION 'foreign organization attachment accepted';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 FOR n IN 1..5 LOOP
  INSERT INTO public.workflow_assessment_attachments(id,draft_id,organization_id,uploaded_by_actor_id,original_filename,media_type,byte_size,content_sha256,representation_digest_sha256,storage_bucket,storage_path,storage_version,status,context,provenance)
  VALUES(('93600000-0000-4000-8000-'||lpad((50+n)::text,12,'0'))::uuid,'93600000-0000-4000-8000-000000000023','93600000-0000-4000-8000-000000000001','93600000-0000-4000-8000-000000000011','limit.csv','text/csv',1,repeat('a',64),repeat('b',64),'documents','93600000-0000-4000-8000-000000000001/workflow-assessments/93600000-0000-4000-8000-000000000023/93600000-0000-4000-8000-'||lpad((50+n)::text,12,'0'),'sql-proof-version','processed','{}','{}');
 END LOOP;
 BEGIN
  INSERT INTO public.workflow_assessment_attachments(id,draft_id,organization_id,uploaded_by_actor_id,original_filename,media_type,byte_size,content_sha256,representation_digest_sha256,storage_bucket,storage_path,storage_version,status,context,provenance)
  VALUES('93600000-0000-4000-8000-000000000056','93600000-0000-4000-8000-000000000023','93600000-0000-4000-8000-000000000001','93600000-0000-4000-8000-000000000011','limit.csv','text/csv',1,repeat('a',64),repeat('b',64),'documents','93600000-0000-4000-8000-000000000001/workflow-assessments/93600000-0000-4000-8000-000000000023/93600000-0000-4000-8000-000000000056','sql-proof-version','processed','{}','{}');
  RAISE EXCEPTION 'sixth attachment accepted';
 EXCEPTION WHEN check_violation THEN NULL; END;
END $$;
INSERT INTO public.workflow_assessments(id,source_submission_id,assessment_version,schema_version,assessment,assessment_digest_sha256,model,prompt_template_id,prompt_template_version)
VALUES('93600000-0000-4000-8000-000000000101','93600000-0000-4000-8000-000000000021',1,'workflow_assessment_v2','{"workflowSteps":[]}',repeat('d',64),'none','local-proof','v2');
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.workflow_assessments WHERE id='93600000-0000-4000-8000-000000000101' AND organization_id='93600000-0000-4000-8000-000000000001') THEN RAISE EXCEPTION 'proposal tenant not inherited'; END IF;
 IF EXISTS(SELECT 1 FROM public.read_workflow_assessment_review_queue(200,'93600000-0000-4000-8000-000000000002') WHERE assessment_id='93600000-0000-4000-8000-000000000101') THEN RAISE EXCEPTION 'review queue leaked tenant'; END IF;
 BEGIN
  INSERT INTO public.workflow_assessment_reviews(id,assessment_id,source_submission_id,assessment_version,review_version,reviewer_actor_id,overall_disposition)
  VALUES('93600000-0000-4000-8000-000000000111','93600000-0000-4000-8000-000000000101','93600000-0000-4000-8000-000000000021',1,1,'93600000-0000-4000-8000-000000000012','accepted');
  RAISE EXCEPTION 'foreign organization review accepted';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
DO $$ BEGIN
 BEGIN
  UPDATE public.workflow_assessment_attachments SET context='{"fabricated":true}' WHERE id='93600000-0000-4000-8000-000000000031';
  RAISE EXCEPTION 'submitted evidence context mutated';
 EXCEPTION WHEN restrict_violation THEN NULL; END;
 BEGIN
  UPDATE public.workflow_intake_submissions SET attachment_manifest='[]' WHERE id='93600000-0000-4000-8000-000000000021';
  RAISE EXCEPTION 'immutable source manifest mutated';
 EXCEPTION WHEN restrict_violation THEN NULL; END;
 IF EXISTS(SELECT 1 FROM public.documents WHERE id IN ('93600000-0000-4000-8000-000000000031','93600000-0000-4000-8000-000000000032')) THEN RAISE EXCEPTION 'assessment files entered canonical inventory'; END IF;
 IF has_table_privilege('anon','public.workflow_assessment_drafts','INSERT') OR has_table_privilege('authenticated','public.workflow_assessment_attachments','SELECT') OR has_table_privilege('service_role','public.workflow_assessment_attachments','UPDATE')
 OR has_function_privilege('anon','public.submit_workflow_assessment_draft(uuid,uuid,uuid,jsonb)','EXECUTE') OR has_function_privilege('authenticated','public.read_organization_workflow_assessment(uuid,uuid)','EXECUTE') THEN RAISE EXCEPTION 'assessment access grants widened'; END IF;
END $$;
DO $$ DECLARE policy_record record; BEGIN
 IF to_regclass('storage.objects') IS NOT NULL THEN
  SELECT * INTO policy_record FROM pg_policies WHERE schemaname='storage' AND tablename='objects' AND policyname='workflow_assessment_evidence_api_only';
  IF NOT FOUND OR policy_record.permissive<>'RESTRICTIVE' OR policy_record.cmd<>'ALL'
   OR NOT (policy_record.roles @> ARRAY['anon','authenticated']::name[])
   OR policy_record.qual IS NULL OR policy_record.with_check IS NULL THEN
   RAISE EXCEPTION 'assessment storage restrictive access boundary missing';
  END IF;
 ELSE
  RAISE NOTICE 'Plain PostgreSQL replay has no storage.objects; Supabase storage policy requires deployed catalog verification';
 END IF;
END $$;
-- Exercise the exact migrated policy, including a deliberately permissive
-- baseline. This fixture is installed only in the disposable default replay.
RESET ROLE;
DO $$ BEGIN
 IF obj_description(to_regclass('storage.objects'),'pg_class') = 'eightforge_disposable_storage_rls_fixture' THEN
  INSERT INTO storage.objects VALUES
   ('93600000-0000-4000-8000-000000000201','documents','93600000-0000-4000-8000-000000000001/workflow-assessments/draft/file'),
   ('93600000-0000-4000-8000-000000000202','documents','93600000-0000-4000-8000-000000000001/ordinary-file');
  SET LOCAL ROLE authenticated;
  IF EXISTS (SELECT 1 FROM storage.objects WHERE id='93600000-0000-4000-8000-000000000201') THEN RAISE EXCEPTION 'direct storage assessment read bypass'; END IF;
  IF NOT EXISTS (SELECT 1 FROM storage.objects WHERE id='93600000-0000-4000-8000-000000000202') THEN RAISE EXCEPTION 'ordinary storage policy changed'; END IF;
  BEGIN
   INSERT INTO storage.objects VALUES ('93600000-0000-4000-8000-000000000203','documents','org/workflow-assessments/draft/forged');
   RAISE EXCEPTION 'direct assessment storage upload bypass';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  RESET ROLE;
 END IF;
END $$;
\echo B8.5 AUTHENTICATED ASSESSMENT EVIDENCE: PASS
ROLLBACK;
