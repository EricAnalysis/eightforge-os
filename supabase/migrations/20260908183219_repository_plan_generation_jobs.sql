-- Phase 11E trusted Forgewing worker coordination.
-- This is operational queue state only. It is not canonical truth, engineering
-- approval, a workflow decision, or execution authority.

DO $forgewing_worker_role$
BEGIN
  CREATE ROLE forgewing_engineering_worker NOLOGIN NOBYPASSRLS;
EXCEPTION WHEN duplicate_object THEN
  ALTER ROLE forgewing_engineering_worker NOLOGIN NOBYPASSRLS;
END
$forgewing_worker_role$;

-- Hosted PostgREST assumes database roles from signed JWT role claims through
-- authenticator. The disposable replay intentionally has no authenticator role.
DO $forgewing_worker_authenticator$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'authenticator') THEN
    GRANT forgewing_engineering_worker TO authenticator;
  END IF;
END
$forgewing_worker_authenticator$;

GRANT USAGE ON SCHEMA public TO forgewing_engineering_worker;

CREATE TABLE public.workflow_repository_plan_generation_jobs (
  id uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  assessment_id uuid NOT NULL REFERENCES public.workflow_assessments(id) ON DELETE RESTRICT,
  assessment_version integer NOT NULL CHECK (assessment_version > 0),
  review_id uuid NOT NULL REFERENCES public.workflow_assessment_reviews(id) ON DELETE RESTRICT,
  review_version integer NOT NULL CHECK (review_version > 0),
  classification text NOT NULL
    CHECK (classification IN ('RULE','VERIFY','EXTRACT','RECOVER','HUMAN','ADVISORY')),
  requested_by_actor_id uuid NOT NULL REFERENCES public.user_profiles(id) ON DELETE RESTRICT,
  implementation_plan_v1_digest_sha256 text NOT NULL
    CHECK (implementation_plan_v1_digest_sha256 ~ '^[a-f0-9]{64}$'),
  authority text NOT NULL DEFAULT 'non_authoritative'
    CHECK (authority = 'non_authoritative'),
  purpose text NOT NULL DEFAULT 'repository_plan_generation'
    CHECK (purpose = 'repository_plan_generation'),
  requires_human_review boolean NOT NULL DEFAULT true
    CHECK (requires_human_review),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','claimed','succeeded','failed')),
  claim_token uuid,
  claim_generation integer NOT NULL DEFAULT 0 CHECK (claim_generation >= 0),
  claimed_at timestamptz,
  provider_call_started_at timestamptz,
  provider_call_count integer NOT NULL DEFAULT 0 CHECK (provider_call_count BETWEEN 0 AND 1),
  plan_v2_run_id uuid REFERENCES public.workflow_repository_plan_v2_runs(id) ON DELETE RESTRICT,
  plan_v2_digest_sha256 text CHECK (
    plan_v2_digest_sha256 IS NULL OR plan_v2_digest_sha256 ~ '^[a-f0-9]{64}$'),
  failure_code text CHECK (
    failure_code IS NULL OR failure_code ~ '^[a-z0-9_]{1,120}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  CONSTRAINT workflow_repository_plan_generation_jobs_state_coherence CHECK (
    (status = 'pending'
      AND claim_token IS NULL AND claim_generation = 0 AND claimed_at IS NULL
      AND provider_call_started_at IS NULL AND provider_call_count = 0
      AND plan_v2_run_id IS NULL AND plan_v2_digest_sha256 IS NULL
      AND failure_code IS NULL AND completed_at IS NULL)
    OR (status = 'claimed'
      AND claim_token IS NOT NULL AND claim_generation >= 1 AND claimed_at IS NOT NULL
      AND ((provider_call_count = 0 AND provider_call_started_at IS NULL)
        OR (provider_call_count = 1 AND provider_call_started_at IS NOT NULL))
      AND plan_v2_run_id IS NULL AND plan_v2_digest_sha256 IS NULL
      AND failure_code IS NULL AND completed_at IS NULL)
    OR (status = 'succeeded'
      AND claim_token IS NOT NULL AND claim_generation >= 1 AND claimed_at IS NOT NULL
      AND ((provider_call_count = 0 AND provider_call_started_at IS NULL)
        OR (provider_call_count = 1 AND provider_call_started_at IS NOT NULL))
      AND plan_v2_run_id IS NOT NULL AND plan_v2_digest_sha256 IS NOT NULL
      AND failure_code IS NULL AND completed_at IS NOT NULL)
    OR (status = 'failed'
      AND claim_generation >= 1 AND claimed_at IS NOT NULL
      AND ((provider_call_count = 0 AND provider_call_started_at IS NULL)
        OR (provider_call_count = 1 AND provider_call_started_at IS NOT NULL))
      AND plan_v2_run_id IS NULL AND plan_v2_digest_sha256 IS NULL
      AND failure_code IS NOT NULL AND completed_at IS NOT NULL)
  )
);

CREATE INDEX workflow_repository_plan_generation_jobs_pending_idx
  ON public.workflow_repository_plan_generation_jobs (created_at, id)
  WHERE status = 'pending';
CREATE INDEX workflow_repository_plan_generation_jobs_claimed_idx
  ON public.workflow_repository_plan_generation_jobs (claimed_at, id)
  WHERE status = 'claimed';

ALTER TABLE public.workflow_repository_plan_generation_jobs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.workflow_repository_plan_generation_jobs
  FROM PUBLIC, anon, authenticated, service_role, forgewing_engineering_worker;

CREATE OR REPLACE FUNCTION public.guard_workflow_repository_plan_generation_job_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'repository plan generation jobs are not deletable';
  END IF;
  IF NEW.id <> OLD.id
    OR NEW.assessment_id <> OLD.assessment_id
    OR NEW.assessment_version <> OLD.assessment_version
    OR NEW.review_id <> OLD.review_id
    OR NEW.review_version <> OLD.review_version
    OR NEW.classification <> OLD.classification
    OR NEW.requested_by_actor_id <> OLD.requested_by_actor_id
    OR NEW.implementation_plan_v1_digest_sha256 <> OLD.implementation_plan_v1_digest_sha256
    OR NEW.authority <> OLD.authority OR NEW.purpose <> OLD.purpose
    OR NEW.requires_human_review <> OLD.requires_human_review
    OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'repository plan generation job identity is immutable';
  END IF;
  IF OLD.status IN ('succeeded','failed') THEN
    RAISE EXCEPTION 'repository plan generation job is terminal';
  END IF;
  IF OLD.status = 'pending' AND NEW.status <> 'claimed' THEN
    RAISE EXCEPTION 'invalid repository plan generation job transition';
  END IF;
  IF OLD.status = 'claimed' AND NEW.status = 'pending' THEN
    RAISE EXCEPTION 'repository plan generation jobs cannot reset to pending';
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER workflow_repository_plan_generation_jobs_guard
  BEFORE UPDATE OR DELETE ON public.workflow_repository_plan_generation_jobs
  FOR EACH ROW EXECUTE FUNCTION public.guard_workflow_repository_plan_generation_job_mutation();

CREATE FUNCTION public.create_workflow_repository_plan_generation_job(
  p_assessment_id uuid, p_assessment_version integer,
  p_review_id uuid, p_review_version integer,
  p_classification text, p_requested_by_actor_id uuid,
  p_implementation_plan_v1_digest_sha256 text
)
RETURNS TABLE(job_id uuid, job_status text, created_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_row public.workflow_repository_plan_generation_jobs%ROWTYPE;
BEGIN
  IF p_assessment_version <= 0 OR p_review_version <= 0
    OR p_classification NOT IN ('RULE','VERIFY','EXTRACT','RECOVER','HUMAN','ADVISORY')
    OR p_implementation_plan_v1_digest_sha256 !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'invalid repository plan generation job identity'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.user_profiles WHERE id = p_requested_by_actor_id) THEN
    RAISE EXCEPTION 'repository plan generation actor not found' USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM public.workflow_assessment_reviews AS review
    JOIN public.workflow_assessments AS assessment
      ON assessment.id = review.assessment_id
      AND assessment.assessment_version = review.assessment_version
    WHERE assessment.id = p_assessment_id
      AND assessment.assessment_version = p_assessment_version
      AND review.id = p_review_id
      AND review.review_version = p_review_version
  ) THEN
    RAISE EXCEPTION 'exact reviewed workflow identity not found' USING ERRCODE = 'no_data_found';
  END IF;
  INSERT INTO public.workflow_repository_plan_generation_jobs (
    assessment_id, assessment_version, review_id, review_version, classification,
    requested_by_actor_id, implementation_plan_v1_digest_sha256
  ) VALUES (
    p_assessment_id, p_assessment_version, p_review_id, p_review_version, p_classification,
    p_requested_by_actor_id, p_implementation_plan_v1_digest_sha256
  ) RETURNING * INTO v_row;
  RETURN QUERY SELECT v_row.id, v_row.status, v_row.created_at;
END;
$$;

CREATE FUNCTION public.read_workflow_repository_plan_generation_job(p_job_id uuid)
RETURNS TABLE(
  job_id uuid, assessment_id uuid, assessment_version integer,
  review_id uuid, review_version integer, classification text,
  implementation_plan_v1_digest_sha256 text, authority text, purpose text,
  requires_human_review boolean, job_status text, provider_call_count integer,
  plan_v2_run_id uuid, plan_v2_digest_sha256 text, repository_commit_sha text,
  failure_code text, created_at timestamptz, updated_at timestamptz, completed_at timestamptz
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT job.id, job.assessment_id, job.assessment_version,
    job.review_id, job.review_version, job.classification,
    job.implementation_plan_v1_digest_sha256, job.authority, job.purpose,
    job.requires_human_review, job.status, job.provider_call_count,
    job.plan_v2_run_id, job.plan_v2_digest_sha256, plan.repository_commit_sha,
    job.failure_code, job.created_at, job.updated_at, job.completed_at
  FROM public.workflow_repository_plan_generation_jobs AS job
  LEFT JOIN public.workflow_repository_plan_v2_runs AS plan ON plan.id = job.plan_v2_run_id
  WHERE job.id = p_job_id;
$$;

CREATE FUNCTION public.claim_workflow_repository_plan_generation_job()
RETURNS TABLE(
  job_id uuid, claim_token uuid, claim_status text,
  assessment_id uuid, assessment_version integer,
  review_id uuid, review_version integer, classification text,
  implementation_plan_v1_digest_sha256 text
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_row public.workflow_repository_plan_generation_jobs%ROWTYPE;
  v_token uuid := extensions.gen_random_uuid();
BEGIN
  -- Once a provider call may have started, ambiguity is terminal. A later
  -- operator request is a new job; this worker never retries the call.
  UPDATE public.workflow_repository_plan_generation_jobs AS job
  SET status = 'failed', claim_token = NULL,
      failure_code = 'provider_claim_expired', completed_at = clock_timestamp()
  WHERE job.status = 'claimed' AND job.provider_call_count = 1
    AND job.provider_call_started_at < clock_timestamp() - interval '10 minutes';

  SELECT job.* INTO v_row
  FROM public.workflow_repository_plan_generation_jobs AS job
  WHERE job.status = 'claimed' AND job.provider_call_count = 0
    AND job.claimed_at < clock_timestamp() - interval '10 minutes'
  ORDER BY job.claimed_at, job.id
  FOR UPDATE SKIP LOCKED LIMIT 1;

  IF v_row.id IS NOT NULL THEN
    UPDATE public.workflow_repository_plan_generation_jobs AS job
    SET claim_token = v_token, claim_generation = job.claim_generation + 1,
        claimed_at = clock_timestamp()
    WHERE job.id = v_row.id
    RETURNING * INTO v_row;
    RETURN QUERY SELECT v_row.id, v_row.claim_token, 'recovered_pre_provider'::text,
      v_row.assessment_id, v_row.assessment_version, v_row.review_id,
      v_row.review_version, v_row.classification,
      v_row.implementation_plan_v1_digest_sha256;
    RETURN;
  END IF;

  SELECT job.* INTO v_row
  FROM public.workflow_repository_plan_generation_jobs AS job
  WHERE job.status = 'pending'
  ORDER BY job.created_at, job.id
  FOR UPDATE SKIP LOCKED LIMIT 1;
  IF v_row.id IS NULL THEN RETURN; END IF;

  UPDATE public.workflow_repository_plan_generation_jobs AS job
  SET status = 'claimed', claim_token = v_token, claim_generation = 1,
      claimed_at = clock_timestamp()
  WHERE job.id = v_row.id
  RETURNING * INTO v_row;
  RETURN QUERY SELECT v_row.id, v_row.claim_token, 'acquired'::text,
    v_row.assessment_id, v_row.assessment_version, v_row.review_id,
    v_row.review_version, v_row.classification,
    v_row.implementation_plan_v1_digest_sha256;
END;
$$;

CREATE FUNCTION public.read_workflow_repository_plan_generation_source(
  p_job_id uuid, p_claim_token uuid
)
RETURNS TABLE(assessment_row jsonb, review_row jsonb, step_review_rows jsonb)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_job public.workflow_repository_plan_generation_jobs%ROWTYPE;
BEGIN
  SELECT * INTO v_job
  FROM public.workflow_repository_plan_generation_jobs AS job
  WHERE job.id = p_job_id AND job.status = 'claimed' AND job.claim_token = p_claim_token;
  IF v_job.id IS NULL THEN
    RAISE EXCEPTION 'repository plan generation claim lost' USING ERRCODE = 'serialization_failure';
  END IF;
  RETURN QUERY
  SELECT
    pg_catalog.jsonb_build_object(
      'id', assessment.id, 'assessment_version', assessment.assessment_version,
      'source_submission_id', assessment.source_submission_id, 'assessment', assessment.assessment,
      'authority', assessment.authority, 'requires_human_review', assessment.requires_human_review,
      'created_at', assessment.created_at),
    pg_catalog.jsonb_build_object(
      'id', review.id, 'assessment_id', review.assessment_id,
      'assessment_version', review.assessment_version,
      'source_submission_id', review.source_submission_id, 'review_version', review.review_version,
      'reviewer_actor_id', review.reviewer_actor_id,
      'overall_disposition', review.overall_disposition,
      'reviewer_summary', review.reviewer_summary, 'created_at', review.created_at),
    (SELECT coalesce(pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'id', step.id, 'review_id', step.review_id,
        'assessment_step_id', step.assessment_step_id,
        'proposed_classification', step.proposed_classification,
        'reviewed_classification', step.reviewed_classification,
        'disposition', step.disposition, 'reviewer_notes', step.reviewer_notes,
        'accepted_specification', step.accepted_specification, 'created_at', step.created_at)
      ORDER BY step.id), '[]'::jsonb)
     FROM public.workflow_assessment_step_reviews AS step WHERE step.review_id = review.id)
  FROM public.workflow_assessments AS assessment
  JOIN public.workflow_assessment_reviews AS review
    ON review.assessment_id = assessment.id
    AND review.assessment_version = assessment.assessment_version
  WHERE assessment.id = v_job.assessment_id
    AND assessment.assessment_version = v_job.assessment_version
    AND review.id = v_job.review_id AND review.review_version = v_job.review_version;
END;
$$;

CREATE FUNCTION public.begin_workflow_repository_plan_provider_call(
  p_job_id uuid, p_claim_token uuid
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  UPDATE public.workflow_repository_plan_generation_jobs AS job
  SET provider_call_count = 1, provider_call_started_at = clock_timestamp()
  WHERE job.id = p_job_id AND job.status = 'claimed'
    AND job.claim_token = p_claim_token AND job.provider_call_count = 0;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'repository plan generation claim lost or provider already started'
      USING ERRCODE = 'serialization_failure';
  END IF;
END;
$$;

CREATE FUNCTION public.succeed_workflow_repository_plan_generation_job(
  p_job_id uuid, p_claim_token uuid,
  p_plan_v2_run_id uuid
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_job public.workflow_repository_plan_generation_jobs%ROWTYPE;
  v_plan public.workflow_repository_plan_v2_runs%ROWTYPE;
BEGIN
  SELECT * INTO v_job FROM public.workflow_repository_plan_generation_jobs AS job
  WHERE job.id = p_job_id AND job.status = 'claimed' AND job.claim_token = p_claim_token
  FOR UPDATE;
  IF v_job.id IS NULL THEN
    RAISE EXCEPTION 'repository plan generation claim lost' USING ERRCODE = 'serialization_failure';
  END IF;
  SELECT * INTO v_plan FROM public.workflow_repository_plan_v2_runs AS plan
  WHERE plan.id = p_plan_v2_run_id;
  IF v_plan.id IS NULL
    OR v_plan.assessment_id <> v_job.assessment_id
    OR v_plan.assessment_version <> v_job.assessment_version
    OR v_plan.review_id <> v_job.review_id OR v_plan.review_version <> v_job.review_version
    OR v_plan.implementation_plan_v1_digest_sha256 <> v_job.implementation_plan_v1_digest_sha256
    OR v_plan.plan_v2_canonical_json::jsonb #>> '{guidance,classification}' <> v_job.classification
    OR (v_plan.plan_v2_canonical_json::jsonb #>> '{providerProvenance,callCount}')::integer <> v_job.provider_call_count
    OR ((v_plan.raw_evidence_id IS NOT NULL) <> (v_job.provider_call_count = 1)) THEN
    RAISE EXCEPTION 'repository plan generation result identity mismatch'
      USING ERRCODE = 'check_violation';
  END IF;
  UPDATE public.workflow_repository_plan_generation_jobs AS job
  SET status = 'succeeded', plan_v2_run_id = v_plan.id,
      plan_v2_digest_sha256 = v_plan.plan_v2_digest_sha256,
      completed_at = clock_timestamp()
  WHERE job.id = v_job.id;
END;
$$;

CREATE FUNCTION public.fail_workflow_repository_plan_generation_job(
  p_job_id uuid, p_claim_token uuid, p_failure_code text
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF p_failure_code IS NULL OR p_failure_code !~ '^[a-z0-9_]{1,120}$' THEN
    RAISE EXCEPTION 'invalid repository plan generation failure code'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  UPDATE public.workflow_repository_plan_generation_jobs AS job
  SET status = 'failed', failure_code = p_failure_code, completed_at = clock_timestamp()
  WHERE job.id = p_job_id AND job.status = 'claimed' AND job.claim_token = p_claim_token;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'repository plan generation claim lost' USING ERRCODE = 'serialization_failure';
  END IF;
END;
$$;

ALTER FUNCTION public.create_workflow_repository_plan_generation_job(uuid,integer,uuid,integer,text,uuid,text) OWNER TO postgres;
ALTER FUNCTION public.read_workflow_repository_plan_generation_job(uuid) OWNER TO postgres;
ALTER FUNCTION public.claim_workflow_repository_plan_generation_job() OWNER TO postgres;
ALTER FUNCTION public.read_workflow_repository_plan_generation_source(uuid,uuid) OWNER TO postgres;
ALTER FUNCTION public.begin_workflow_repository_plan_provider_call(uuid,uuid) OWNER TO postgres;
ALTER FUNCTION public.succeed_workflow_repository_plan_generation_job(uuid,uuid,uuid) OWNER TO postgres;
ALTER FUNCTION public.fail_workflow_repository_plan_generation_job(uuid,uuid,text) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.guard_workflow_repository_plan_generation_job_mutation()
  FROM PUBLIC, anon, authenticated, service_role, forgewing_engineering_worker;
REVOKE ALL ON FUNCTION public.create_workflow_repository_plan_generation_job(uuid,integer,uuid,integer,text,uuid,text)
  FROM PUBLIC, anon, authenticated, service_role, forgewing_engineering_worker;
REVOKE ALL ON FUNCTION public.read_workflow_repository_plan_generation_job(uuid)
  FROM PUBLIC, anon, authenticated, service_role, forgewing_engineering_worker;
REVOKE ALL ON FUNCTION public.claim_workflow_repository_plan_generation_job()
  FROM PUBLIC, anon, authenticated, service_role, forgewing_engineering_worker;
REVOKE ALL ON FUNCTION public.read_workflow_repository_plan_generation_source(uuid,uuid)
  FROM PUBLIC, anon, authenticated, service_role, forgewing_engineering_worker;
REVOKE ALL ON FUNCTION public.begin_workflow_repository_plan_provider_call(uuid,uuid)
  FROM PUBLIC, anon, authenticated, service_role, forgewing_engineering_worker;
REVOKE ALL ON FUNCTION public.succeed_workflow_repository_plan_generation_job(uuid,uuid,uuid)
  FROM PUBLIC, anon, authenticated, service_role, forgewing_engineering_worker;
REVOKE ALL ON FUNCTION public.fail_workflow_repository_plan_generation_job(uuid,uuid,text)
  FROM PUBLIC, anon, authenticated, service_role, forgewing_engineering_worker;

GRANT EXECUTE ON FUNCTION public.create_workflow_repository_plan_generation_job(uuid,integer,uuid,integer,text,uuid,text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.read_workflow_repository_plan_generation_job(uuid)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_workflow_repository_plan_generation_job()
  TO forgewing_engineering_worker;
GRANT EXECUTE ON FUNCTION public.read_workflow_repository_plan_generation_source(uuid,uuid)
  TO forgewing_engineering_worker;
GRANT EXECUTE ON FUNCTION public.begin_workflow_repository_plan_provider_call(uuid,uuid)
  TO forgewing_engineering_worker;
GRANT EXECUTE ON FUNCTION public.succeed_workflow_repository_plan_generation_job(uuid,uuid,uuid)
  TO forgewing_engineering_worker;
GRANT EXECUTE ON FUNCTION public.fail_workflow_repository_plan_generation_job(uuid,uuid,text)
  TO forgewing_engineering_worker;

-- Preserve B3's existing service-role grant and add only the trusted worker.
GRANT EXECUTE ON FUNCTION public.record_workflow_repository_plan_v2_run(text,text,text,text)
  TO forgewing_engineering_worker;
