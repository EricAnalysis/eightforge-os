-- Durable delivery correlation for the one-way EightForge -> Linear copy.
-- This is operational delivery state only. It is never engineering approval
-- authority and is deliberately absent from Approved Engineering Request reads.

CREATE TABLE public.linear_projection_correlations (
  id uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  engineering_request_digest_sha256 text NOT NULL
    CHECK (engineering_request_digest_sha256 ~ '^[a-f0-9]{64}$'),
  projection_digest_sha256 text NOT NULL
    CHECK (projection_digest_sha256 ~ '^[a-f0-9]{64}$'),
  idempotency_key text NOT NULL
    CHECK (idempotency_key = 'linear-projection:' || engineering_request_digest_sha256),
  plan_v2_run_id uuid NOT NULL REFERENCES public.workflow_repository_plan_v2_runs(id) ON DELETE RESTRICT,
  review_id uuid NOT NULL REFERENCES public.workflow_repository_plan_recommendation_reviews(id) ON DELETE RESTRICT,
  recommendation_id text NOT NULL CHECK (recommendation_id ~ '^rec_[a-f0-9]{64}$'),
  repository_commit_sha text NOT NULL CHECK (repository_commit_sha ~ '^[a-f0-9]{40}$'),
  linear_project_id text NOT NULL CHECK (btrim(linear_project_id) = linear_project_id AND char_length(linear_project_id) BETWEEN 1 AND 200),
  status text NOT NULL CHECK (status IN ('claimed', 'projected', 'failed', 'withdrawn')),
  claim_token uuid NOT NULL,
  claim_generation integer NOT NULL DEFAULT 1 CHECK (claim_generation >= 1),
  claimed_at timestamptz NOT NULL DEFAULT now(),
  linear_issue_id text,
  linear_issue_identifier text,
  last_failure_code text,
  failure_count integer NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
  withdrawal_rationale text,
  projected_at timestamptz,
  withdrawn_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT linear_projection_correlations_state_coherence CHECK (
    (status = 'claimed' AND linear_issue_id IS NULL AND linear_issue_identifier IS NULL
      AND projected_at IS NULL AND withdrawn_at IS NULL AND withdrawal_rationale IS NULL)
    OR (status = 'projected' AND linear_issue_id IS NOT NULL AND btrim(linear_issue_id) <> ''
      AND linear_issue_identifier IS NOT NULL AND btrim(linear_issue_identifier) <> ''
      AND projected_at IS NOT NULL AND withdrawn_at IS NULL AND withdrawal_rationale IS NULL)
    OR (status = 'failed' AND linear_issue_id IS NULL AND linear_issue_identifier IS NULL
      AND projected_at IS NULL AND last_failure_code IS NOT NULL AND btrim(last_failure_code) <> ''
      AND withdrawn_at IS NULL AND withdrawal_rationale IS NULL)
    OR (status = 'withdrawn' AND withdrawn_at IS NOT NULL
      AND withdrawal_rationale IS NOT NULL AND btrim(withdrawal_rationale) <> '')
  ),
  CONSTRAINT linear_projection_correlations_failure_length CHECK (
    last_failure_code IS NULL OR char_length(last_failure_code) <= 120),
  CONSTRAINT linear_projection_correlations_withdrawal_length CHECK (
    withdrawal_rationale IS NULL OR char_length(withdrawal_rationale) <= 4000)
);

CREATE UNIQUE INDEX linear_projection_correlations_one_active_request
  ON public.linear_projection_correlations (engineering_request_digest_sha256)
  WHERE status IN ('claimed', 'projected', 'failed');
CREATE UNIQUE INDEX linear_projection_correlations_issue_id_unique
  ON public.linear_projection_correlations (linear_issue_id)
  WHERE linear_issue_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.guard_linear_projection_correlation_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Linear projection correlations are not deletable';
  END IF;
  IF NEW.id <> OLD.id
    OR NEW.engineering_request_digest_sha256 <> OLD.engineering_request_digest_sha256
    OR NEW.projection_digest_sha256 <> OLD.projection_digest_sha256
    OR NEW.idempotency_key <> OLD.idempotency_key
    OR NEW.plan_v2_run_id <> OLD.plan_v2_run_id
    OR NEW.review_id <> OLD.review_id
    OR NEW.recommendation_id <> OLD.recommendation_id
    OR NEW.repository_commit_sha <> OLD.repository_commit_sha
    OR NEW.linear_project_id <> OLD.linear_project_id
    OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'Linear projection correlation identity is immutable';
  END IF;
  IF OLD.status = 'projected' THEN
    RAISE EXCEPTION 'Projected Linear correlation is terminal';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER linear_projection_correlations_guard
  BEFORE UPDATE OR DELETE ON public.linear_projection_correlations
  FOR EACH ROW EXECUTE FUNCTION public.guard_linear_projection_correlation_mutation();

CREATE OR REPLACE FUNCTION public.claim_linear_projection_delivery(
  p_engineering_request_digest_sha256 text,
  p_projection_digest_sha256 text,
  p_plan_v2_run_id uuid,
  p_review_id uuid,
  p_recommendation_id text,
  p_repository_commit_sha text,
  p_linear_project_id text
)
RETURNS TABLE (
  correlation_id uuid,
  claim_token uuid,
  claim_status text,
  linear_issue_id text,
  linear_issue_identifier text
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_row public.linear_projection_correlations%ROWTYPE;
  v_token uuid := extensions.gen_random_uuid();
BEGIN
  IF p_engineering_request_digest_sha256 !~ '^[a-f0-9]{64}$'
    OR p_projection_digest_sha256 !~ '^[a-f0-9]{64}$'
    OR p_recommendation_id !~ '^rec_[a-f0-9]{64}$'
    OR p_repository_commit_sha !~ '^[a-f0-9]{40}$'
    OR p_linear_project_id IS NULL OR btrim(p_linear_project_id) <> p_linear_project_id
    OR char_length(p_linear_project_id) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'invalid Linear projection claim identity' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_engineering_request_digest_sha256, 0));
  SELECT correlation.* INTO v_row
  FROM public.linear_projection_correlations AS correlation
  WHERE correlation.engineering_request_digest_sha256 = p_engineering_request_digest_sha256
    AND correlation.status IN ('claimed', 'projected', 'failed')
  FOR UPDATE;

  IF v_row.id IS NULL THEN
    INSERT INTO public.linear_projection_correlations (
      engineering_request_digest_sha256, projection_digest_sha256, idempotency_key,
      plan_v2_run_id, review_id, recommendation_id, repository_commit_sha,
      linear_project_id, status, claim_token
    ) VALUES (
      p_engineering_request_digest_sha256, p_projection_digest_sha256,
      'linear-projection:' || p_engineering_request_digest_sha256,
      p_plan_v2_run_id, p_review_id, p_recommendation_id, p_repository_commit_sha,
      p_linear_project_id, 'claimed', v_token
    ) RETURNING * INTO v_row;
    RETURN QUERY SELECT v_row.id, v_row.claim_token, 'acquired'::text, NULL::text, NULL::text;
    RETURN;
  END IF;

  IF v_row.projection_digest_sha256 <> p_projection_digest_sha256
    OR v_row.plan_v2_run_id <> p_plan_v2_run_id OR v_row.review_id <> p_review_id
    OR v_row.recommendation_id <> p_recommendation_id
    OR v_row.repository_commit_sha <> p_repository_commit_sha
    OR v_row.linear_project_id <> p_linear_project_id THEN
    RAISE EXCEPTION 'Linear projection idempotency identity conflict'
      USING ERRCODE = 'unique_violation';
  END IF;
  IF v_row.status = 'projected' THEN
    RETURN QUERY SELECT v_row.id, v_row.claim_token, 'existing_projected'::text,
      v_row.linear_issue_id, v_row.linear_issue_identifier;
    RETURN;
  END IF;
  IF v_row.status = 'claimed' AND v_row.claimed_at > now() - interval '5 minutes' THEN
    RETURN QUERY SELECT v_row.id, v_row.claim_token, 'busy'::text, NULL::text, NULL::text;
    RETURN;
  END IF;

  UPDATE public.linear_projection_correlations AS correlation
  SET status = 'claimed', claim_token = v_token,
      claim_generation = correlation.claim_generation + 1, claimed_at = now()
  WHERE correlation.id = v_row.id
  RETURNING * INTO v_row;
  RETURN QUERY SELECT v_row.id, v_row.claim_token, 'recovered'::text, NULL::text, NULL::text;
END;
$$;

CREATE OR REPLACE FUNCTION public.confirm_linear_projection_delivery(
  p_correlation_id uuid,
  p_claim_token uuid,
  p_linear_issue_id text,
  p_linear_issue_identifier text
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF p_linear_issue_id IS NULL OR btrim(p_linear_issue_id) = ''
    OR p_linear_issue_identifier IS NULL OR btrim(p_linear_issue_identifier) = '' THEN
    RAISE EXCEPTION 'Linear issue identity is required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  UPDATE public.linear_projection_correlations AS correlation
  SET status = 'projected', linear_issue_id = p_linear_issue_id,
      linear_issue_identifier = p_linear_issue_identifier, projected_at = now()
  WHERE correlation.id = p_correlation_id AND correlation.status = 'claimed'
    AND correlation.claim_token = p_claim_token;
  IF NOT FOUND THEN RAISE EXCEPTION 'Linear projection claim lost' USING ERRCODE = 'serialization_failure'; END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.fail_linear_projection_delivery(
  p_correlation_id uuid,
  p_claim_token uuid,
  p_failure_code text
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF p_failure_code IS NULL OR btrim(p_failure_code) = '' OR char_length(p_failure_code) > 120 THEN
    RAISE EXCEPTION 'Linear projection failure code is required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  UPDATE public.linear_projection_correlations AS correlation
  SET status = 'failed', last_failure_code = p_failure_code,
      failure_count = correlation.failure_count + 1
  WHERE correlation.id = p_correlation_id AND correlation.status = 'claimed'
    AND correlation.claim_token = p_claim_token;
  IF NOT FOUND THEN RAISE EXCEPTION 'Linear projection claim lost' USING ERRCODE = 'serialization_failure'; END IF;
END;
$$;

ALTER TABLE public.linear_projection_correlations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.linear_projection_correlations FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.linear_projection_correlations TO service_role;

REVOKE ALL ON FUNCTION public.guard_linear_projection_correlation_mutation() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.claim_linear_projection_delivery(text, text, uuid, uuid, text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.confirm_linear_projection_delivery(uuid, uuid, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fail_linear_projection_delivery(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_linear_projection_delivery(text, text, uuid, uuid, text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.confirm_linear_projection_delivery(uuid, uuid, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.fail_linear_projection_delivery(uuid, uuid, text) TO service_role;
