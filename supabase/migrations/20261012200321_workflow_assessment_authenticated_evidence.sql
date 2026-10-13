-- Organization-owned assessment evidence; no project/document promotion.
BEGIN;
ALTER TABLE public.workflow_intake_submissions
  ADD COLUMN submitted_by_actor_id uuid REFERENCES public.user_profiles(id),
  ADD COLUMN attachment_manifest jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(attachment_manifest) = 'array' AND jsonb_array_length(attachment_manifest) <= 5);

CREATE TABLE public.workflow_assessment_drafts (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  created_by_actor_id uuid NOT NULL REFERENCES public.user_profiles(id),
  state text NOT NULL DEFAULT 'open' CHECK (state IN ('open','submitted')),
  created_at timestamptz NOT NULL DEFAULT now(),
  submitted_at timestamptz,
  CHECK ((state = 'open' AND submitted_at IS NULL) OR (state = 'submitted' AND submitted_at IS NOT NULL))
);
CREATE TABLE public.workflow_assessment_attachments (
  id uuid PRIMARY KEY,
  draft_id uuid NOT NULL REFERENCES public.workflow_assessment_drafts(id),
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  uploaded_by_actor_id uuid NOT NULL REFERENCES public.user_profiles(id),
  original_filename text NOT NULL CHECK (length(original_filename) BETWEEN 1 AND 255),
  media_type text NOT NULL CHECK (media_type IN ('application/pdf','application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document','application/vnd.ms-excel','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','text/csv','application/json')),
  byte_size bigint NOT NULL CHECK (byte_size BETWEEN 1 AND 10485760),
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
  representation_digest_sha256 text CHECK (representation_digest_sha256 ~ '^[a-f0-9]{64}$'),
  storage_bucket text NOT NULL CHECK (storage_bucket = 'documents'),
  storage_path text NOT NULL UNIQUE,
  storage_version text NOT NULL CHECK (length(btrim(storage_version)) > 0),
  status text NOT NULL CHECK (status IN ('processed','failed')),
  error text,
  context jsonb CHECK (jsonb_typeof(context) = 'object' AND octet_length(context::text) <= 65536),
  provenance jsonb NOT NULL CHECK (jsonb_typeof(provenance) = 'object' AND octet_length(provenance::text) <= 65536),
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  removed_at timestamptz,
  CHECK ((status = 'processed' AND error IS NULL) OR (status = 'failed' AND error IS NOT NULL AND length(btrim(error)) > 0)),
  CHECK ((status = 'processed' AND context IS NOT NULL AND representation_digest_sha256 IS NOT NULL)
      OR (status = 'failed' AND context IS NULL AND representation_digest_sha256 IS NULL)),
  CHECK (storage_path = organization_id::text || '/workflow-assessments/' || draft_id::text || '/' || id::text)
);
CREATE INDEX workflow_assessment_attachments_draft_idx ON public.workflow_assessment_attachments(draft_id) WHERE removed_at IS NULL;
CREATE INDEX workflow_assessment_drafts_org_idx ON public.workflow_assessment_drafts(organization_id,created_at DESC);

CREATE FUNCTION public.guard_workflow_assessment_draft() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'assessment drafts are immutable' USING ERRCODE='restrict_violation'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'open' OR NOT EXISTS (SELECT 1 FROM public.user_profiles WHERE id=NEW.created_by_actor_id AND organization_id=NEW.organization_id) THEN
      RAISE EXCEPTION 'invalid assessment ownership' USING ERRCODE='insufficient_privilege';
    END IF;
  ELSE
    IF OLD.state <> 'open' OR NEW.state <> 'submitted'
      OR (to_jsonb(NEW)-'state'-'submitted_at') IS DISTINCT FROM (to_jsonb(OLD)-'state'-'submitted_at')
      OR NOT EXISTS (SELECT 1 FROM public.workflow_intake_submissions WHERE id=OLD.id AND organization_id=OLD.organization_id AND submitted_by_actor_id=OLD.created_by_actor_id) THEN
      RAISE EXCEPTION 'invalid assessment draft transition' USING ERRCODE='restrict_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER workflow_assessment_draft_guard BEFORE INSERT OR UPDATE OR DELETE ON public.workflow_assessment_drafts FOR EACH ROW EXECUTE FUNCTION public.guard_workflow_assessment_draft();

CREATE FUNCTION public.guard_workflow_assessment_attachment() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE d public.workflow_assessment_drafts;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'assessment attachment evidence is immutable' USING ERRCODE='restrict_violation'; END IF;
  SELECT * INTO d FROM public.workflow_assessment_drafts WHERE id=NEW.draft_id FOR UPDATE;
  IF NOT FOUND OR d.state <> 'open' THEN RAISE EXCEPTION 'assessment draft is not open' USING ERRCODE='restrict_violation'; END IF;
  IF d.organization_id <> NEW.organization_id OR d.created_by_actor_id <> NEW.uploaded_by_actor_id
    OR NOT EXISTS (SELECT 1 FROM public.user_profiles WHERE id=NEW.uploaded_by_actor_id AND organization_id=NEW.organization_id) THEN
    RAISE EXCEPTION 'invalid attachment ownership' USING ERRCODE='insufficient_privilege';
  END IF;
  IF TG_OP='UPDATE' THEN
    IF OLD.removed_at IS NOT NULL OR NEW.removed_at IS NULL
      OR (to_jsonb(NEW)-'removed_at') IS DISTINCT FROM (to_jsonb(OLD)-'removed_at') THEN
      RAISE EXCEPTION 'attachment may only be detached before submission' USING ERRCODE='restrict_violation';
    END IF;
  ELSIF NEW.removed_at IS NOT NULL OR (SELECT count(*) FROM public.workflow_assessment_attachments WHERE draft_id=d.id AND removed_at IS NULL)>=5 THEN
    RAISE EXCEPTION 'assessment attachment limit exceeded' USING ERRCODE='check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER workflow_assessment_attachment_guard BEFORE INSERT OR UPDATE OR DELETE ON public.workflow_assessment_attachments FOR EACH ROW EXECUTE FUNCTION public.guard_workflow_assessment_attachment();

CREATE FUNCTION public.submit_workflow_assessment_draft(p_draft_id uuid,p_organization_id uuid,p_actor_id uuid,p_answers jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d public.workflow_assessment_drafts; manifest jsonb;
BEGIN
  SELECT * INTO d FROM public.workflow_assessment_drafts WHERE id=p_draft_id FOR UPDATE;
  IF NOT FOUND OR d.organization_id IS DISTINCT FROM p_organization_id OR d.created_by_actor_id IS DISTINCT FROM p_actor_id
    OR NOT EXISTS (SELECT 1 FROM public.user_profiles WHERE id=p_actor_id AND organization_id=p_organization_id) THEN
    RAISE EXCEPTION 'assessment not found' USING ERRCODE='insufficient_privilege';
  END IF;
  IF d.state <> 'open' THEN RAISE EXCEPTION 'assessment already submitted' USING ERRCODE='restrict_violation'; END IF;
  IF jsonb_typeof(p_answers) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(p_answers))<>7
    OR NOT p_answers ?& ARRAY['workflowDescription','informationOrSystems','manualChecks','frequencyAndVolume','exceptions','humanDecisions','successOutcome']
    OR EXISTS (SELECT 1 FROM jsonb_each(p_answers) WHERE jsonb_typeof(value)<>'string') THEN
    RAISE EXCEPTION 'invalid assessment answers' USING ERRCODE='check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM public.workflow_assessment_attachments WHERE draft_id=d.id AND removed_at IS NULL AND status<>'processed') THEN
    RAISE EXCEPTION 'remove failed attachments before submitting' USING ERRCODE='check_violation';
  END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('attachmentId',a.id,'sourceSha256',a.content_sha256,'representationDigestSha256',a.representation_digest_sha256) ORDER BY a.uploaded_at,a.id),'[]'::jsonb) INTO manifest
    FROM public.workflow_assessment_attachments a WHERE draft_id=d.id AND removed_at IS NULL;
  INSERT INTO public.workflow_intake_submissions(id,schema_version,organization_id,submitted_by_actor_id,attachment_manifest,workflow_description,information_or_systems,manual_checks,frequency_and_volume,exceptions,human_decisions,success_outcome)
  VALUES(d.id,'workflow_intake_v2',d.organization_id,p_actor_id,manifest,btrim(p_answers->>'workflowDescription'),btrim(p_answers->>'informationOrSystems'),btrim(p_answers->>'manualChecks'),btrim(p_answers->>'frequencyAndVolume'),btrim(p_answers->>'exceptions'),btrim(p_answers->>'humanDecisions'),btrim(p_answers->>'successOutcome'));
  UPDATE public.workflow_assessment_drafts SET state='submitted',submitted_at=now() WHERE id=d.id;
  RETURN d.id;
END $$;
CREATE FUNCTION public.remove_workflow_assessment_attachment(p_draft_id uuid,p_attachment_id uuid,p_organization_id uuid,p_actor_id uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d public.workflow_assessment_drafts;
BEGIN
  SELECT * INTO d FROM public.workflow_assessment_drafts WHERE id=p_draft_id FOR UPDATE;
  IF NOT FOUND OR d.state<>'open' OR d.organization_id IS DISTINCT FROM p_organization_id OR d.created_by_actor_id IS DISTINCT FROM p_actor_id
    OR NOT EXISTS (SELECT 1 FROM public.user_profiles WHERE id=p_actor_id AND organization_id=p_organization_id) THEN
    RAISE EXCEPTION 'assessment not found' USING ERRCODE='insufficient_privilege';
  END IF;
  UPDATE public.workflow_assessment_attachments SET removed_at=now() WHERE id=p_attachment_id AND draft_id=d.id AND organization_id=d.organization_id AND removed_at IS NULL;
  RETURN FOUND;
END $$;

DROP FUNCTION public.read_workflow_intake_submission(uuid);
CREATE FUNCTION public.read_workflow_intake_submission(submission_id uuid)
RETURNS TABLE(id uuid,schema_version text,workflow_description text,documents_involved text,manual_checks text,frequency_and_volume text,exceptions text,human_decisions text,submitted_at timestamptz,information_or_systems text,success_outcome text,organization_id uuid,submitted_by_actor_id uuid,attachment_manifest jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT s.id,s.schema_version,s.workflow_description,s.documents_involved,s.manual_checks,s.frequency_and_volume,s.exceptions,s.human_decisions,s.submitted_at,s.information_or_systems,s.success_outcome,s.organization_id,s.submitted_by_actor_id,s.attachment_manifest FROM public.workflow_intake_submissions s WHERE s.id=submission_id;
$$;
CREATE FUNCTION public.read_organization_workflow_assessment(p_submission_id uuid,p_organization_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT jsonb_build_object('source',to_jsonb(s),'assessment',(SELECT to_jsonb(a) FROM public.workflow_assessments a WHERE a.source_submission_id=s.id ORDER BY a.assessment_version DESC LIMIT 1))
 FROM public.workflow_intake_submissions s WHERE s.id=p_submission_id AND s.organization_id=p_organization_id;
$$;
-- New derived proposals inherit their tenant from immutable intake. Historical
-- proposals remain byte-identical and retain their unassigned legacy scope.
ALTER TABLE public.workflow_assessments ADD COLUMN organization_id uuid REFERENCES public.organizations(id);
CREATE FUNCTION public.scope_workflow_assessment_organization() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE source_org uuid;
BEGIN
 SELECT organization_id INTO source_org FROM public.workflow_intake_submissions WHERE id=NEW.source_submission_id;
 IF NEW.organization_id IS NOT NULL AND NEW.organization_id IS DISTINCT FROM source_org THEN
  RAISE EXCEPTION 'assessment organization mismatch' USING ERRCODE='insufficient_privilege';
 END IF;
 NEW.organization_id := source_org;
 RETURN NEW;
END $$;
CREATE TRIGGER workflow_assessment_organization_scope BEFORE INSERT ON public.workflow_assessments FOR EACH ROW EXECUTE FUNCTION public.scope_workflow_assessment_organization();
CREATE FUNCTION public.guard_workflow_assessment_review_organization() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE source_org uuid;
BEGIN
 SELECT s.organization_id INTO source_org FROM public.workflow_assessments a
 JOIN public.workflow_intake_submissions s ON s.id=a.source_submission_id
 WHERE a.id=NEW.assessment_id AND a.assessment_version=NEW.assessment_version AND s.id=NEW.source_submission_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'review source identity mismatch' USING ERRCODE='insufficient_privilege'; END IF;
 IF source_org IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.user_profiles WHERE id=NEW.reviewer_actor_id AND organization_id=source_org) THEN
  RAISE EXCEPTION 'review organization mismatch' USING ERRCODE='insufficient_privilege';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER workflow_assessment_review_organization_guard BEFORE INSERT ON public.workflow_assessment_reviews FOR EACH ROW EXECUTE FUNCTION public.guard_workflow_assessment_review_organization();

DROP FUNCTION public.read_workflow_assessment_review_queue(integer);
CREATE FUNCTION public.read_workflow_assessment_review_queue(p_limit integer DEFAULT 50,p_organization_id uuid DEFAULT NULL)
RETURNS TABLE(assessment_id uuid,assessment_version integer,source_submission_id uuid,created_at timestamptz,summary text,step_count integer,grounded_unverified_count integer,steps_with_gaps_count integer,human_decision_count integer,review_state text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT a.id,a.assessment_version,a.source_submission_id,a.created_at,NULLIF(a.assessment->>'summary',''),COALESCE(jsonb_array_length(a.assessment->'workflowSteps'),0),
 COALESCE((a.assessment->'automationAssessment'->>'groundedUnverifiedSteps')::integer,0),
 COALESCE((a.assessment->'automationAssessment'->>'stepsWithUnresolvedDeterminismGaps')::integer,0),
 COALESCE((a.assessment->'automationAssessment'->'countsByClassification'->>'HUMAN')::integer,0),'pending_review'::text
 FROM public.workflow_assessments a
 WHERE (a.organization_id IS NULL OR a.organization_id=p_organization_id OR p_organization_id IS NULL)
 AND NOT EXISTS (SELECT 1 FROM public.workflow_assessment_reviews r WHERE r.assessment_id=a.id AND r.assessment_version=a.assessment_version)
 ORDER BY a.created_at DESC LIMIT GREATEST(1,LEAST(COALESCE(p_limit,50),200));
$$;
REVOKE ALL ON FUNCTION public.scope_workflow_assessment_organization(),public.guard_workflow_assessment_review_organization(),public.read_workflow_assessment_review_queue(integer,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.read_workflow_assessment_review_queue(integer,uuid) TO service_role;
ALTER TABLE public.workflow_assessment_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workflow_assessment_attachments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.workflow_assessment_drafts,public.workflow_assessment_attachments FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT,INSERT ON public.workflow_assessment_drafts TO service_role;
GRANT SELECT,INSERT ON public.workflow_assessment_attachments TO service_role;
REVOKE ALL ON FUNCTION public.guard_workflow_assessment_draft(),public.guard_workflow_assessment_attachment(),public.submit_workflow_assessment_draft(uuid,uuid,uuid,jsonb),public.remove_workflow_assessment_attachment(uuid,uuid,uuid,uuid),public.read_workflow_intake_submission(uuid),public.read_organization_workflow_assessment(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.submit_workflow_assessment_draft(uuid,uuid,uuid,jsonb),public.remove_workflow_assessment_attachment(uuid,uuid,uuid,uuid),public.read_workflow_intake_submission(uuid),public.read_organization_workflow_assessment(uuid,uuid) TO service_role;
ALTER FUNCTION public.guard_workflow_assessment_draft() OWNER TO postgres;
ALTER FUNCTION public.guard_workflow_assessment_attachment() OWNER TO postgres;
ALTER FUNCTION public.submit_workflow_assessment_draft(uuid,uuid,uuid,jsonb) OWNER TO postgres;
ALTER FUNCTION public.remove_workflow_assessment_attachment(uuid,uuid,uuid,uuid) OWNER TO postgres;
ALTER FUNCTION public.read_workflow_intake_submission(uuid) OWNER TO postgres;
ALTER FUNCTION public.read_organization_workflow_assessment(uuid,uuid) OWNER TO postgres;
ALTER FUNCTION public.scope_workflow_assessment_organization() OWNER TO postgres;
ALTER FUNCTION public.guard_workflow_assessment_review_organization() OWNER TO postgres;
ALTER FUNCTION public.read_workflow_assessment_review_queue(integer,uuid) OWNER TO postgres;
-- Storage authorization must not let existing permissive organization policies
-- bypass the assessment API. Service storage operations remain unchanged.
-- Standalone PostgreSQL replay has no Supabase-managed storage schema.
DO $$ BEGIN
 IF to_regclass('storage.objects') IS NOT NULL THEN
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid='storage.objects'::regclass AND relrowsecurity) THEN
   RAISE EXCEPTION 'assessment storage requires existing storage.objects RLS';
  END IF;
  EXECUTE 'CREATE POLICY workflow_assessment_evidence_api_only ON storage.objects AS RESTRICTIVE FOR ALL TO anon, authenticated USING (bucket_id <> ''documents'' OR split_part(name, ''/'', 2) <> ''workflow-assessments'') WITH CHECK (bucket_id <> ''documents'' OR split_part(name, ''/'', 2) <> ''workflow-assessments'')';
 END IF;
END $$;
COMMIT;
