CREATE TABLE public.workflow_repository_plan_recommendation_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_v2_run_id uuid NOT NULL REFERENCES public.workflow_repository_plan_v2_runs(id) ON DELETE RESTRICT,
  plan_v2_digest_sha256 text NOT NULL CHECK (plan_v2_digest_sha256 ~ '^[0-9a-f]{64}$'),
  recommendation_id text NOT NULL CHECK (recommendation_id ~ '^rec_[0-9a-f]{64}$'),
  review_version integer NOT NULL CHECK (review_version > 0),
  reviewer_actor_id uuid NOT NULL REFERENCES public.user_profiles(id) ON DELETE RESTRICT,
  disposition text NOT NULL CHECK (disposition IN ('accepted','modified','rejected','deferred')),
  capability_scope text CHECK (capability_scope IN ('client_specific','workflow_specific','reusable_platform_capability')),
  reviewer_rationale text NOT NULL CHECK (length(btrim(reviewer_rationale)) BETWEEN 1 AND 4000),
  modified_scope jsonb,
  review_request_digest_sha256 text NOT NULL UNIQUE CHECK (review_request_digest_sha256 ~ '^[0-9a-f]{64}$'),
  repository_commit_sha text NOT NULL CHECK (repository_commit_sha ~ '^[0-9a-f]{40}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (plan_v2_run_id, recommendation_id, review_version),
  CHECK ((disposition IN ('accepted','modified')) = (capability_scope IS NOT NULL)),
  CHECK ((disposition = 'modified') = (modified_scope IS NOT NULL))
);

ALTER TABLE public.workflow_repository_plan_recommendation_reviews ENABLE ROW LEVEL SECURITY;
CREATE TRIGGER workflow_repository_plan_recommendation_reviews_immutable
  BEFORE UPDATE OR DELETE ON public.workflow_repository_plan_recommendation_reviews
  FOR EACH ROW EXECUTE FUNCTION public.reject_workflow_repository_plan_mutation();
REVOKE ALL ON TABLE public.workflow_repository_plan_recommendation_reviews FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.workflow_repository_plan_recommendation_reviews TO service_role;

CREATE FUNCTION public.record_workflow_repository_plan_recommendation_review(
  p_plan_v2_run_id uuid, p_plan_v2_digest_sha256 text, p_recommendation_id text,
  p_reviewer_actor_id uuid, p_disposition text, p_capability_scope text,
  p_reviewer_rationale text, p_modified_scope jsonb, p_review_request_digest_sha256 text
) RETURNS TABLE(review_id uuid, review_version integer, repository_commit_sha text, inserted boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_plan record;
  v_existing record;
  v_version integer;
  v_commit text;
BEGIN
  IF auth.role() <> 'service_role' THEN
    RAISE EXCEPTION 'service_role required' USING ERRCODE = '42501';
  END IF;
  IF p_plan_v2_digest_sha256 !~ '^[0-9a-f]{64}$' OR p_recommendation_id !~ '^rec_[0-9a-f]{64}$'
     OR p_review_request_digest_sha256 !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid engineering review identity' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_plan_v2_run_id::text || ':' || p_recommendation_id, 0));
  SELECT * INTO v_existing FROM public.workflow_repository_plan_recommendation_reviews
    WHERE review_request_digest_sha256 = p_review_request_digest_sha256;
  IF FOUND THEN
    IF v_existing.plan_v2_run_id <> p_plan_v2_run_id OR v_existing.plan_v2_digest_sha256 <> p_plan_v2_digest_sha256
       OR v_existing.recommendation_id <> p_recommendation_id OR v_existing.reviewer_actor_id <> p_reviewer_actor_id
       OR v_existing.disposition <> p_disposition OR v_existing.capability_scope IS DISTINCT FROM p_capability_scope
       OR v_existing.reviewer_rationale <> p_reviewer_rationale OR v_existing.modified_scope IS DISTINCT FROM p_modified_scope THEN
      RAISE EXCEPTION 'review request digest collision' USING ERRCODE = '23505';
    END IF;
    RETURN QUERY SELECT v_existing.id, v_existing.review_version, v_existing.repository_commit_sha, false;
    RETURN;
  END IF;

  SELECT id, plan_v2_digest_sha256, plan_v2_canonical_json INTO v_plan
    FROM public.workflow_repository_plan_v2_runs WHERE id = p_plan_v2_run_id AND plan_v2_digest_sha256 = p_plan_v2_digest_sha256;
  IF NOT FOUND THEN RAISE EXCEPTION 'exact Plan V2 not found' USING ERRCODE = 'P0002'; END IF;
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements((v_plan.plan_v2_canonical_json::jsonb #> '{guidance,recommendations}')) r
                 WHERE r->>'recommendationId' = p_recommendation_id) THEN
    RAISE EXCEPTION 'recommendation not found' USING ERRCODE = 'P0002';
  END IF;
  v_commit := v_plan.plan_v2_canonical_json::jsonb #>> '{source,repositorySnapshot,commitSha}';
  IF v_commit !~ '^[0-9a-f]{40}$' THEN RAISE EXCEPTION 'invalid repository commit' USING ERRCODE = '22023'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.user_profiles WHERE id = p_reviewer_actor_id) THEN
    RAISE EXCEPTION 'reviewer not found' USING ERRCODE = '42501';
  END IF;
  IF p_disposition NOT IN ('accepted','modified','rejected','deferred')
     OR ((p_disposition IN ('accepted','modified')) <> (p_capability_scope IS NOT NULL))
     OR ((p_disposition = 'modified') <> (p_modified_scope IS NOT NULL)) THEN
    RAISE EXCEPTION 'review disposition incoherent' USING ERRCODE = '22023';
  END IF;
  SELECT coalesce(max(r.review_version),0)+1 INTO v_version
    FROM public.workflow_repository_plan_recommendation_reviews r
    WHERE r.plan_v2_run_id = p_plan_v2_run_id AND r.recommendation_id = p_recommendation_id;
  INSERT INTO public.workflow_repository_plan_recommendation_reviews(
    plan_v2_run_id, plan_v2_digest_sha256, recommendation_id, review_version, reviewer_actor_id,
    disposition, capability_scope, reviewer_rationale, modified_scope, review_request_digest_sha256, repository_commit_sha)
  VALUES (p_plan_v2_run_id,p_plan_v2_digest_sha256,p_recommendation_id,v_version,p_reviewer_actor_id,
    p_disposition,p_capability_scope,btrim(p_reviewer_rationale),p_modified_scope,p_review_request_digest_sha256,v_commit)
  RETURNING id INTO review_id;
  review_version := v_version; repository_commit_sha := v_commit; inserted := true;
  RETURN NEXT;
END $$;

REVOKE ALL ON FUNCTION public.record_workflow_repository_plan_recommendation_review(uuid,text,text,uuid,text,text,text,jsonb,text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.record_workflow_repository_plan_recommendation_review(uuid,text,text,uuid,text,text,text,jsonb,text)
  TO service_role;
