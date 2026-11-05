-- FDE plan approval records are organization-owned and append-only.
-- A plan decision has no execution, activation, or Project Truth authority.

CREATE TABLE public.fde_plan_supplemental_documents (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  source_submission_id uuid NOT NULL REFERENCES public.workflow_intake_submissions(id) ON DELETE RESTRICT,
  assessment_id uuid NOT NULL REFERENCES public.workflow_assessments(id) ON DELETE RESTRICT,
  base_snapshot_id uuid,
  evidence_revision integer NOT NULL CHECK (evidence_revision > 0),
  uploaded_by_actor_id uuid NOT NULL REFERENCES public.user_profiles(id) ON DELETE RESTRICT,
  upload_request_id uuid NOT NULL UNIQUE,
  upload_request_digest_sha256 text NOT NULL CHECK (upload_request_digest_sha256 ~ '^[a-f0-9]{64}$'),
  need_ids text[] NOT NULL DEFAULT '{}',
  original_filename text NOT NULL CHECK (length(original_filename) BETWEEN 1 AND 255),
  media_type text NOT NULL,
  byte_size bigint NOT NULL CHECK (byte_size BETWEEN 1 AND 10485760),
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
  representation_digest_sha256 text CHECK (representation_digest_sha256 ~ '^[a-f0-9]{64}$'),
  context_digest_sha256 text CHECK (context_digest_sha256 ~ '^[a-f0-9]{64}$'),
  storage_bucket text NOT NULL CHECK (storage_bucket = 'documents'),
  storage_path text NOT NULL UNIQUE,
  storage_version text NOT NULL CHECK (length(btrim(storage_version)) > 0),
  status text NOT NULL CHECK (status IN ('processed','failed')),
  error text,
  context jsonb,
  provenance jsonb NOT NULL,
  uploaded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (source_submission_id, evidence_revision),
  CHECK ((status = 'processed' AND error IS NULL AND context IS NOT NULL AND representation_digest_sha256 IS NOT NULL AND context_digest_sha256 IS NOT NULL)
    OR (status = 'failed' AND error IS NOT NULL AND context IS NULL AND representation_digest_sha256 IS NULL AND context_digest_sha256 IS NULL)),
  CHECK (storage_path = organization_id::text || '/fde-plans/' || source_submission_id::text || '/' || id::text)
);

CREATE TABLE public.fde_plan_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  source_submission_id uuid NOT NULL REFERENCES public.workflow_intake_submissions(id) ON DELETE RESTRICT,
  assessment_id uuid NOT NULL REFERENCES public.workflow_assessments(id) ON DELETE RESTRICT,
  assessment_version integer NOT NULL CHECK (assessment_version > 0),
  evidence_revision integer NOT NULL CHECK (evidence_revision >= 0),
  plan_digest_sha256 text NOT NULL CHECK (plan_digest_sha256 ~ '^[a-f0-9]{64}$'),
  plan_canonical_json text NOT NULL,
  created_by_actor_id uuid NOT NULL REFERENCES public.user_profiles(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (organization_id, source_submission_id, plan_digest_sha256)
);

ALTER TABLE public.fde_plan_supplemental_documents
  ALTER COLUMN base_snapshot_id SET NOT NULL,
  ADD CONSTRAINT fde_plan_supplemental_documents_base_snapshot_fk
    FOREIGN KEY (base_snapshot_id) REFERENCES public.fde_plan_snapshots(id) ON DELETE RESTRICT;
CREATE INDEX fde_plan_supplemental_documents_source_idx
  ON public.fde_plan_supplemental_documents(organization_id,source_submission_id,evidence_revision);
CREATE INDEX fde_plan_snapshots_source_idx
  ON public.fde_plan_snapshots(organization_id,source_submission_id,created_at DESC);

CREATE TABLE public.fde_plan_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  source_submission_id uuid NOT NULL REFERENCES public.workflow_intake_submissions(id) ON DELETE RESTRICT,
  base_snapshot_id uuid NOT NULL REFERENCES public.fde_plan_snapshots(id) ON DELETE RESTRICT,
  base_plan_digest_sha256 text NOT NULL CHECK (base_plan_digest_sha256 ~ '^[a-f0-9]{64}$'),
  resolved_plan_digest_sha256 text NOT NULL CHECK (resolved_plan_digest_sha256 ~ '^[a-f0-9]{64}$'),
  resolved_plan_canonical_json text NOT NULL,
  resolutions_canonical_json text NOT NULL,
  waivers_canonical_json text NOT NULL,
  review_version integer NOT NULL CHECK (review_version > 0),
  reviewer_actor_id uuid NOT NULL REFERENCES public.user_profiles(id) ON DELETE RESTRICT,
  disposition text NOT NULL CHECK (disposition IN ('approved','rejected','changes_requested')),
  rationale text NOT NULL CHECK (length(btrim(rationale)) BETWEEN 1 AND 4000),
  request_digest_sha256 text NOT NULL UNIQUE CHECK (request_digest_sha256 ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (source_submission_id, review_version)
);

CREATE TABLE public.fde_plan_need_resolutions (
  review_id uuid NOT NULL REFERENCES public.fde_plan_reviews(id) ON DELETE RESTRICT,
  need_id text NOT NULL CHECK (need_id ~ '^need_[a-f0-9]{64}$'),
  base_snapshot_id uuid NOT NULL REFERENCES public.fde_plan_snapshots(id) ON DELETE RESTRICT,
  base_plan_digest_sha256 text NOT NULL CHECK (base_plan_digest_sha256 ~ '^[a-f0-9]{64}$'),
  disposition text NOT NULL CHECK (disposition IN ('confirmed','unresolved')),
  conclusion text NOT NULL CHECK (length(btrim(conclusion)) BETWEEN 1 AND 4000),
  rationale text NOT NULL CHECK (length(btrim(rationale)) BETWEEN 1 AND 4000),
  source_refs jsonb NOT NULL CHECK (jsonb_typeof(source_refs) = 'array'),
  reviewer_actor_id uuid NOT NULL REFERENCES public.user_profiles(id) ON DELETE RESTRICT,
  review_version integer NOT NULL CHECK (review_version > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (review_id, need_id)
);

CREATE TABLE public.fde_plan_evidence_waivers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  review_id uuid NOT NULL REFERENCES public.fde_plan_reviews(id) ON DELETE RESTRICT,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  source_submission_id uuid NOT NULL REFERENCES public.workflow_intake_submissions(id) ON DELETE RESTRICT,
  base_snapshot_id uuid NOT NULL REFERENCES public.fde_plan_snapshots(id) ON DELETE RESTRICT,
  base_plan_digest_sha256 text NOT NULL CHECK (base_plan_digest_sha256 ~ '^[a-f0-9]{64}$'),
  resolved_plan_digest_sha256 text NOT NULL CHECK (resolved_plan_digest_sha256 ~ '^[a-f0-9]{64}$'),
  need_id text NOT NULL CHECK (need_id ~ '^need_[a-f0-9]{64}$'),
  requirement text NOT NULL CHECK (length(btrim(requirement)) BETWEEN 1 AND 2000),
  customer_statement text NOT NULL CHECK (length(btrim(customer_statement)) BETWEEN 1 AND 4000),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 4000),
  source_refs jsonb NOT NULL CHECK (jsonb_typeof(source_refs) = 'array'),
  acknowledged_by_actor_id uuid NOT NULL REFERENCES public.user_profiles(id) ON DELETE RESTRICT,
  acknowledgment_text text NOT NULL,
  acknowledgment_version text NOT NULL,
  acknowledged boolean NOT NULL CHECK (acknowledged = true),
  review_version integer NOT NULL CHECK (review_version > 0),
  request_digest_sha256 text NOT NULL CHECK (request_digest_sha256 ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (review_id, need_id)
);
CREATE INDEX fde_plan_reviews_source_idx
  ON public.fde_plan_reviews(organization_id,source_submission_id,review_version DESC);

CREATE FUNCTION public.reject_fde_plan_record_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  RAISE EXCEPTION 'FDE plan evidence and decisions are immutable' USING ERRCODE = '42501';
END $$;

CREATE TRIGGER fde_plan_supplemental_documents_immutable BEFORE UPDATE OR DELETE ON public.fde_plan_supplemental_documents FOR EACH ROW EXECUTE FUNCTION public.reject_fde_plan_record_mutation();
CREATE TRIGGER fde_plan_snapshots_immutable BEFORE UPDATE OR DELETE ON public.fde_plan_snapshots FOR EACH ROW EXECUTE FUNCTION public.reject_fde_plan_record_mutation();
CREATE TRIGGER fde_plan_reviews_immutable BEFORE UPDATE OR DELETE ON public.fde_plan_reviews FOR EACH ROW EXECUTE FUNCTION public.reject_fde_plan_record_mutation();
CREATE TRIGGER fde_plan_need_resolutions_immutable BEFORE UPDATE OR DELETE ON public.fde_plan_need_resolutions FOR EACH ROW EXECUTE FUNCTION public.reject_fde_plan_record_mutation();
CREATE TRIGGER fde_plan_evidence_waivers_immutable BEFORE UPDATE OR DELETE ON public.fde_plan_evidence_waivers FOR EACH ROW EXECUTE FUNCTION public.reject_fde_plan_record_mutation();

CREATE FUNCTION public.assert_fde_plan_document_scope() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.workflow_intake_submissions s WHERE s.id = NEW.source_submission_id AND s.organization_id = NEW.organization_id)
    OR NOT EXISTS (SELECT 1 FROM public.workflow_assessments a WHERE a.id = NEW.assessment_id AND a.source_submission_id = NEW.source_submission_id AND a.organization_id = NEW.organization_id)
    OR NOT EXISTS (SELECT 1 FROM public.user_profiles p WHERE p.id = NEW.uploaded_by_actor_id AND p.organization_id = NEW.organization_id)
    OR NOT EXISTS (SELECT 1 FROM public.fde_plan_snapshots s WHERE s.id = NEW.base_snapshot_id AND s.organization_id = NEW.organization_id AND s.source_submission_id = NEW.source_submission_id AND s.assessment_id = NEW.assessment_id)
    OR cardinality(NEW.need_ids) > 100
    OR EXISTS (SELECT 1 FROM unnest(NEW.need_ids) n WHERE n !~ '^need_[a-f0-9]{64}$')
    OR EXISTS (SELECT 1 FROM unnest(NEW.need_ids) n WHERE NOT EXISTS (
      SELECT 1 FROM public.fde_plan_snapshots s, jsonb_array_elements(s.plan_canonical_json::jsonb->'informationNeeds') j
      WHERE s.id=NEW.base_snapshot_id AND j->>'needId'=n)) THEN
    RAISE EXCEPTION 'FDE document scope mismatch' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fde_plan_document_scope BEFORE INSERT ON public.fde_plan_supplemental_documents FOR EACH ROW EXECUTE FUNCTION public.assert_fde_plan_document_scope();

CREATE FUNCTION public.assert_fde_plan_snapshot_scope() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NEW.plan_digest_sha256 IS DISTINCT FROM encode(extensions.digest(convert_to(NEW.plan_canonical_json,'UTF8'),'sha256'),'hex')
    OR NOT EXISTS (SELECT 1 FROM public.workflow_intake_submissions s WHERE s.id = NEW.source_submission_id AND s.organization_id = NEW.organization_id)
    OR NOT EXISTS (SELECT 1 FROM public.workflow_assessments a WHERE a.id = NEW.assessment_id AND a.source_submission_id = NEW.source_submission_id AND a.organization_id = NEW.organization_id AND a.assessment_version = NEW.assessment_version)
    OR NOT EXISTS (SELECT 1 FROM public.user_profiles p WHERE p.id = NEW.created_by_actor_id AND p.organization_id = NEW.organization_id)
    OR NEW.plan_canonical_json::jsonb #>> '{pinnedInputs,assessmentId}' IS DISTINCT FROM NEW.assessment_id::text
    OR NEW.plan_canonical_json::jsonb #>> '{pinnedInputs,sourceSubmissionId}' IS DISTINCT FROM NEW.source_submission_id::text
    OR (NEW.plan_canonical_json::jsonb #>> '{pinnedInputs,assessmentVersion}')::integer IS DISTINCT FROM NEW.assessment_version
    OR (NEW.plan_canonical_json::jsonb #>> '{pinnedInputs,supplementalEvidence,evidenceRevision}')::integer IS DISTINCT FROM NEW.evidence_revision
    OR NEW.evidence_revision IS DISTINCT FROM (SELECT coalesce(max(d.evidence_revision),0) FROM public.fde_plan_supplemental_documents d WHERE d.source_submission_id=NEW.source_submission_id)
    OR NEW.plan_canonical_json::jsonb #> '{pinnedInputs,supplementalEvidence,documents}' IS DISTINCT FROM
      (SELECT coalesce(jsonb_agg(jsonb_build_object(
        'attachmentId',d.id,'sourceSha256',d.content_sha256,
        'representationDigestSha256',d.representation_digest_sha256,'contextDigest',d.context_digest_sha256,
        'status',d.status,'associatedNeedIds',to_jsonb(d.need_ids)) ORDER BY d.id),'[]'::jsonb)
       FROM public.fde_plan_supplemental_documents d WHERE d.source_submission_id=NEW.source_submission_id)
    OR NEW.plan_canonical_json::jsonb #>> '{authority}' IS DISTINCT FROM 'non_authoritative' THEN
    RAISE EXCEPTION 'FDE plan snapshot identity or scope mismatch' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fde_plan_snapshot_scope BEFORE INSERT ON public.fde_plan_snapshots FOR EACH ROW EXECUTE FUNCTION public.assert_fde_plan_snapshot_scope();

ALTER TABLE public.fde_plan_supplemental_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fde_plan_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fde_plan_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fde_plan_need_resolutions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fde_plan_evidence_waivers ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.fde_plan_supplemental_documents, public.fde_plan_snapshots, public.fde_plan_reviews, public.fde_plan_need_resolutions, public.fde_plan_evidence_waivers FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT ON public.fde_plan_supplemental_documents, public.fde_plan_snapshots TO service_role;
GRANT SELECT ON public.fde_plan_reviews, public.fde_plan_need_resolutions, public.fde_plan_evidence_waivers TO service_role;
REVOKE ALL ON FUNCTION public.reject_fde_plan_record_mutation(), public.assert_fde_plan_document_scope(), public.assert_fde_plan_snapshot_scope() FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.record_fde_plan_supplemental_document(
  p_document jsonb, p_need_ids text[], p_actor_id uuid, p_base_snapshot_id uuid,
  p_upload_request_id uuid, p_upload_request_digest_sha256 text
) RETURNS TABLE(document_id uuid, evidence_revision integer, inserted boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_snapshot public.fde_plan_snapshots%ROWTYPE;
  v_existing public.fde_plan_supplemental_documents%ROWTYPE;
  v_revision integer;
  v_doc_id uuid;
BEGIN
  IF auth.role() <> 'service_role' OR p_upload_request_digest_sha256 !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'unauthorized FDE evidence write' USING ERRCODE='42501';
  END IF;
  SELECT * INTO v_snapshot FROM public.fde_plan_snapshots WHERE id=p_base_snapshot_id;
  IF NOT FOUND OR NOT EXISTS (SELECT 1 FROM public.user_profiles p WHERE p.id=p_actor_id AND p.organization_id=v_snapshot.organization_id) THEN
    RAISE EXCEPTION 'FDE evidence scope mismatch' USING ERRCODE='42501';
  END IF;
  IF jsonb_typeof(p_document) IS DISTINCT FROM 'object' OR jsonb_typeof(p_document->'provenance') IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'invalid FDE document' USING ERRCODE='22023';
  END IF;
  v_doc_id := (p_document->>'id')::uuid;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_snapshot.source_submission_id::text,0));
  SELECT * INTO v_existing FROM public.fde_plan_supplemental_documents WHERE upload_request_id=p_upload_request_id;
  IF FOUND THEN
    IF v_existing.source_submission_id<>v_snapshot.source_submission_id OR v_existing.organization_id<>v_snapshot.organization_id
      OR v_existing.base_snapshot_id<>p_base_snapshot_id OR v_existing.uploaded_by_actor_id<>p_actor_id
      OR v_existing.need_ids IS DISTINCT FROM p_need_ids
      OR v_existing.upload_request_digest_sha256 IS DISTINCT FROM p_upload_request_digest_sha256
      OR v_existing.content_sha256 IS DISTINCT FROM p_document->>'contentSha256'
      OR v_existing.original_filename IS DISTINCT FROM p_document->>'originalFilename' THEN
      RAISE EXCEPTION 'FDE upload idempotency collision' USING ERRCODE='23505';
    END IF;
    RETURN QUERY SELECT v_existing.id,v_existing.evidence_revision,false;
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM public.fde_plan_supplemental_documents d WHERE d.id=v_doc_id) THEN
    RAISE EXCEPTION 'FDE document id collision' USING ERRCODE='23505';
  END IF;
  IF v_snapshot.evidence_revision IS DISTINCT FROM
      (SELECT coalesce(max(d.evidence_revision),0) FROM public.fde_plan_supplemental_documents d
       WHERE d.source_submission_id=v_snapshot.source_submission_id)
    OR v_snapshot.assessment_version IS DISTINCT FROM
      (SELECT max(a.assessment_version) FROM public.workflow_assessments a
       WHERE a.source_submission_id=v_snapshot.source_submission_id) THEN
    RAISE EXCEPTION 'FDE upload base snapshot is stale' USING ERRCODE='40001';
  END IF;
  SELECT coalesce(max(d.evidence_revision),0)+1 INTO v_revision FROM public.fde_plan_supplemental_documents d
    WHERE d.source_submission_id=v_snapshot.source_submission_id;
  INSERT INTO public.fde_plan_supplemental_documents (
    id,organization_id,source_submission_id,assessment_id,base_snapshot_id,evidence_revision,
    uploaded_by_actor_id,upload_request_id,upload_request_digest_sha256,need_ids,original_filename,media_type,
    byte_size,content_sha256,representation_digest_sha256,context_digest_sha256,storage_bucket,
    storage_path,storage_version,status,error,context,provenance
  ) VALUES (
    v_doc_id,v_snapshot.organization_id,v_snapshot.source_submission_id,v_snapshot.assessment_id,
    p_base_snapshot_id,v_revision,p_actor_id,p_upload_request_id,p_upload_request_digest_sha256,p_need_ids,
    p_document->>'originalFilename',p_document->>'mediaType',(p_document->>'byteSize')::bigint,
    p_document->>'contentSha256',p_document->>'representationDigestSha256',p_document->>'contextDigestSha256',
    'documents',p_document->>'storagePath',p_document->>'storageVersion',p_document->>'status',
    p_document->>'error',p_document->'context',p_document->'provenance'
  );
  RETURN QUERY SELECT v_doc_id,v_revision,true;
END $$;
REVOKE ALL ON FUNCTION public.record_fde_plan_supplemental_document(jsonb,text[],uuid,uuid,uuid,text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.record_fde_plan_supplemental_document(jsonb,text[],uuid,uuid,uuid,text) TO service_role;

CREATE FUNCTION public.record_fde_plan_review(
  p_base_snapshot_id uuid,p_base_digest_sha256 text,p_resolved_canonical_json text,p_resolved_digest_sha256 text,
  p_disposition text,p_rationale text,p_request_digest_sha256 text,p_actor_id uuid,
  p_resolutions jsonb,p_waivers jsonb
) RETURNS TABLE(review_id uuid,review_version integer,inserted boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_snapshot public.fde_plan_snapshots%ROWTYPE;
  v_existing public.fde_plan_reviews%ROWTYPE;
  v_version integer;
  v_review_id uuid;
  v_resolution jsonb;
  v_waiver jsonb;
  v_resolved jsonb;
  v_need_ids text[];
  v_ack constant text := 'I acknowledge that this information has not been independently verified. I understand that the proposed recommendation may rely on customer-provided information and that supporting evidence may still be required before implementation or activation.';
BEGIN
  IF auth.role() <> 'service_role' OR p_base_digest_sha256 !~ '^[a-f0-9]{64}$'
    OR p_resolved_digest_sha256 !~ '^[a-f0-9]{64}$' OR p_request_digest_sha256 !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'unauthorized FDE review write' USING ERRCODE='42501';
  END IF;
  IF p_resolved_digest_sha256 IS DISTINCT FROM encode(extensions.digest(convert_to(p_resolved_canonical_json,'UTF8'),'sha256'),'hex') THEN
    RAISE EXCEPTION 'resolved plan digest mismatch' USING ERRCODE='23514';
  END IF;
  v_resolved := p_resolved_canonical_json::jsonb;
  IF jsonb_typeof(p_resolutions) IS DISTINCT FROM 'array' OR jsonb_typeof(p_waivers) IS DISTINCT FROM 'array'
    OR p_disposition NOT IN ('approved','rejected','changes_requested')
    OR length(btrim(p_rationale)) NOT BETWEEN 1 AND 4000 THEN
    RAISE EXCEPTION 'invalid FDE review' USING ERRCODE='22023';
  END IF;
  SELECT * INTO v_snapshot FROM public.fde_plan_snapshots WHERE id=p_base_snapshot_id AND plan_digest_sha256=p_base_digest_sha256;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'FDE review snapshot mismatch' USING ERRCODE='42501';
  END IF;
  -- Serialize currentness and version allocation with supplemental uploads.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_snapshot.source_submission_id::text,0));
  IF NOT EXISTS (SELECT 1 FROM public.user_profiles p WHERE p.id=p_actor_id AND p.organization_id=v_snapshot.organization_id)
    OR v_snapshot.evidence_revision IS DISTINCT FROM (SELECT coalesce(max(d.evidence_revision),0) FROM public.fde_plan_supplemental_documents d WHERE d.source_submission_id=v_snapshot.source_submission_id)
    OR v_snapshot.assessment_version IS DISTINCT FROM (SELECT max(a.assessment_version) FROM public.workflow_assessments a WHERE a.source_submission_id=v_snapshot.source_submission_id)
    OR v_resolved->>'basePlanDigestSha256' IS DISTINCT FROM p_base_digest_sha256
    OR v_resolved->>'sourceSubmissionId' IS DISTINCT FROM v_snapshot.source_submission_id::text
    OR v_resolved->>'assessmentId' IS DISTINCT FROM v_snapshot.assessment_id::text
    OR (v_resolved->>'assessmentVersion')::integer IS DISTINCT FROM v_snapshot.assessment_version
    OR (v_resolved->>'evidenceRevision')::integer IS DISTINCT FROM v_snapshot.evidence_revision
    OR v_resolved->>'authority' IS DISTINCT FROM 'non_authoritative' THEN
    RAISE EXCEPTION 'FDE review source or actor mismatch' USING ERRCODE='42501';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_snapshot.plan_canonical_json::jsonb->'informationNeeds') need
    LEFT JOIN LATERAL (
      SELECT a.id FROM public.workflow_assessment_follow_up_answers a
      WHERE a.source_submission_id=v_snapshot.source_submission_id
        AND a.organization_id=v_snapshot.organization_id
        AND a.follow_up_id=substring(need->>'needKey' from 11) AND a.assessment_version<=v_snapshot.assessment_version
      ORDER BY a.revision DESC,a.id DESC LIMIT 1
    ) latest_answer ON true
    WHERE need->>'needKind'='follow_up'
      AND coalesce((SELECT pin->>'answerId' FROM jsonb_array_elements(v_snapshot.plan_canonical_json::jsonb #> '{pinnedInputs,answers}') pin
                    WHERE pin->>'followUpId'=substring(need->>'needKey' from 11) LIMIT 1),'')
        IS DISTINCT FROM coalesce(latest_answer.id::text,'')
  ) OR coalesce((SELECT r.id::text FROM public.workflow_assessment_reviews r
                  WHERE r.assessment_id=v_snapshot.assessment_id AND r.assessment_version=v_snapshot.assessment_version
                  ORDER BY r.review_version DESC LIMIT 1),'')
       IS DISTINCT FROM coalesce(v_snapshot.plan_canonical_json::jsonb #>> '{pinnedInputs,assessmentReview,reviewId}','') THEN
    RAISE EXCEPTION 'FDE plan source revisions changed' USING ERRCODE='23514';
  END IF;
  IF p_disposition='approved' AND (v_resolved->>'eligible' IS DISTINCT FROM 'true'
    OR v_resolved #>> '{deploymentApproach,state}' IS DISTINCT FROM 'candidate_pending_review'
    OR v_resolved #>> '{deploymentApproach,rung}' IS NULL
    OR jsonb_typeof(v_resolved->'blockers') IS DISTINCT FROM 'array'
    OR jsonb_array_length(v_resolved->'blockers') <> 0) THEN
    RAISE EXCEPTION 'FDE recommendation is not eligible' USING ERRCODE='23514';
  END IF;
  SELECT array_agg(n->>'needId') INTO v_need_ids FROM jsonb_array_elements(v_snapshot.plan_canonical_json::jsonb->'informationNeeds') n;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_resolutions) r WHERE NOT (r->>'needId'=ANY(coalesce(v_need_ids,'{}'::text[]))))
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(p_waivers) w WHERE NOT (w->>'needId'=ANY(coalesce(v_need_ids,'{}'::text[]))))
    OR (SELECT count(*) FROM jsonb_array_elements(p_resolutions) r) <> (SELECT count(DISTINCT r->>'needId') FROM jsonb_array_elements(p_resolutions) r)
    OR (SELECT count(*) FROM jsonb_array_elements(p_waivers) w) <> (SELECT count(DISTINCT w->>'needId') FROM jsonb_array_elements(p_waivers) w) THEN
    RAISE EXCEPTION 'FDE need identity mismatch' USING ERRCODE='23514';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_waivers) w JOIN jsonb_array_elements(v_snapshot.plan_canonical_json::jsonb->'informationNeeds') n ON n->>'needId'=w->>'needId'
    WHERE n->>'needKind' NOT IN ('described_document','follow_up')
      OR w->>'acknowledgmentText' IS DISTINCT FROM v_ack OR w->>'acknowledgmentVersion' IS DISTINCT FROM 'fde_evidence_waiver_v1'
      OR w->>'acknowledged' IS DISTINCT FROM 'true') THEN
    RAISE EXCEPTION 'prohibited or unacknowledged FDE waiver' USING ERRCODE='23514';
  END IF;
  SELECT * INTO v_existing FROM public.fde_plan_reviews WHERE request_digest_sha256=p_request_digest_sha256;
  IF FOUND THEN
    IF v_existing.base_snapshot_id<>p_base_snapshot_id OR v_existing.base_plan_digest_sha256<>p_base_digest_sha256
      OR v_existing.resolved_plan_canonical_json<>p_resolved_canonical_json OR v_existing.disposition<>p_disposition
      OR v_existing.rationale<>p_rationale OR v_existing.reviewer_actor_id<>p_actor_id
      OR v_existing.resolutions_canonical_json<>p_resolutions::text OR v_existing.waivers_canonical_json<>p_waivers::text THEN
      RAISE EXCEPTION 'FDE review idempotency collision' USING ERRCODE='23505';
    END IF;
    RETURN QUERY SELECT v_existing.id,v_existing.review_version,false;
    RETURN;
  END IF;
  SELECT coalesce(max(r.review_version),0)+1 INTO v_version FROM public.fde_plan_reviews r WHERE r.source_submission_id=v_snapshot.source_submission_id;
  INSERT INTO public.fde_plan_reviews (organization_id,source_submission_id,base_snapshot_id,base_plan_digest_sha256,
    resolved_plan_digest_sha256,resolved_plan_canonical_json,resolutions_canonical_json,waivers_canonical_json,
    review_version,reviewer_actor_id,disposition,rationale,request_digest_sha256)
  VALUES (v_snapshot.organization_id,v_snapshot.source_submission_id,p_base_snapshot_id,p_base_digest_sha256,
    p_resolved_digest_sha256,p_resolved_canonical_json,p_resolutions::text,p_waivers::text,
    v_version,p_actor_id,p_disposition,btrim(p_rationale),p_request_digest_sha256) RETURNING id INTO v_review_id;
  FOR v_resolution IN SELECT value FROM jsonb_array_elements(p_resolutions) LOOP
    INSERT INTO public.fde_plan_need_resolutions(review_id,need_id,base_snapshot_id,base_plan_digest_sha256,
      disposition,conclusion,rationale,source_refs,reviewer_actor_id,review_version)
    VALUES(v_review_id,v_resolution->>'needId',p_base_snapshot_id,p_base_digest_sha256,
      v_resolution->>'disposition',v_resolution->>'conclusion',v_resolution->>'rationale',
      coalesce(v_resolution->'sourceRefs','[]'::jsonb),p_actor_id,v_version);
  END LOOP;
  FOR v_waiver IN SELECT value FROM jsonb_array_elements(p_waivers) LOOP
    INSERT INTO public.fde_plan_evidence_waivers(review_id,organization_id,source_submission_id,base_snapshot_id,
      base_plan_digest_sha256,resolved_plan_digest_sha256,need_id,requirement,customer_statement,reason,source_refs,
      acknowledged_by_actor_id,acknowledgment_text,acknowledgment_version,acknowledged,review_version,request_digest_sha256)
    VALUES(v_review_id,v_snapshot.organization_id,v_snapshot.source_submission_id,p_base_snapshot_id,p_base_digest_sha256,
      p_resolved_digest_sha256,v_waiver->>'needId',v_waiver->>'requirement',v_waiver->>'customerStatement',
      v_waiver->>'reason',coalesce(v_waiver->'sourceRefs','[]'::jsonb),p_actor_id,
      v_waiver->>'acknowledgmentText',v_waiver->>'acknowledgmentVersion',true,v_version,p_request_digest_sha256);
  END LOOP;
  RETURN QUERY SELECT v_review_id,v_version,true;
END $$;
REVOKE ALL ON FUNCTION public.record_fde_plan_review(uuid,text,text,text,text,text,text,uuid,jsonb,jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.record_fde_plan_review(uuid,text,text,text,text,text,text,uuid,jsonb,jsonb) TO service_role;
