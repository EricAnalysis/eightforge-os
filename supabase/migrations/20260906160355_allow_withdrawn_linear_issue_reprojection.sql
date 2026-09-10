-- Withdrawn rows retain their Linear issue identity as immutable delivery history.
-- Uniqueness applies only to the currently projected correlation so a later
-- controlled projection can reconcile the original issue on a new active row.
DROP INDEX public.linear_projection_correlations_issue_id_unique;

CREATE UNIQUE INDEX linear_projection_correlations_issue_id_unique
  ON public.linear_projection_correlations (linear_issue_id)
  WHERE status = 'projected' AND linear_issue_id IS NOT NULL;

-- A withdrawal releases delivery state, not the immutable request identity.
-- Re-claiming the same request may create a new correlation only when every
-- identity component is identical to its retained history.
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

  IF NOT EXISTS (
    SELECT 1
    FROM public.workflow_repository_plan_recommendation_reviews AS review
    JOIN public.workflow_repository_plan_v2_runs AS plan
      ON plan.id = review.plan_v2_run_id
      AND plan.plan_v2_digest_sha256 = review.plan_v2_digest_sha256
    WHERE review.id = p_review_id
      AND review.plan_v2_run_id = p_plan_v2_run_id
      AND review.recommendation_id = p_recommendation_id
      AND review.repository_commit_sha = p_repository_commit_sha
      AND review.disposition IN ('accepted', 'modified')
      AND plan.repository_commit_sha = p_repository_commit_sha
  ) THEN
    RAISE EXCEPTION 'approved Linear projection source not found'
      USING ERRCODE = 'no_data_found';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_engineering_request_digest_sha256, 0));

  IF EXISTS (
    SELECT 1
    FROM public.linear_projection_correlations AS historical
    WHERE historical.engineering_request_digest_sha256 = p_engineering_request_digest_sha256
      AND (historical.projection_digest_sha256 <> p_projection_digest_sha256
        OR historical.plan_v2_run_id <> p_plan_v2_run_id
        OR historical.review_id <> p_review_id
        OR historical.recommendation_id <> p_recommendation_id
        OR historical.repository_commit_sha <> p_repository_commit_sha
        OR historical.linear_project_id <> p_linear_project_id)
  ) THEN
    RAISE EXCEPTION 'Linear projection idempotency identity conflict'
      USING ERRCODE = 'unique_violation';
  END IF;

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

  IF v_row.status = 'projected' THEN
    RETURN QUERY SELECT v_row.id, NULL::uuid, 'existing_projected'::text,
      v_row.linear_issue_id, v_row.linear_issue_identifier;
    RETURN;
  END IF;
  IF v_row.status = 'claimed' AND v_row.claimed_at > now() - interval '5 minutes' THEN
    RETURN QUERY SELECT v_row.id, NULL::uuid, 'busy'::text, NULL::text, NULL::text;
    RETURN;
  END IF;

  UPDATE public.linear_projection_correlations AS correlation
  SET status = 'claimed', claim_token = v_token,
      claim_generation = correlation.claim_generation + 1, claimed_at = now(),
      last_failure_code = NULL
  WHERE correlation.id = v_row.id
  RETURNING * INTO v_row;
  RETURN QUERY SELECT v_row.id, v_row.claim_token, 'recovered'::text, NULL::text, NULL::text;
END;
$$;
