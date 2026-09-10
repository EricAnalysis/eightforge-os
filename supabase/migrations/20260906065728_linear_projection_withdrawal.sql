CREATE OR REPLACE FUNCTION public.guard_linear_projection_correlation_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Linear projection correlations are not deletable'; END IF;
  IF NEW.id <> OLD.id OR NEW.engineering_request_digest_sha256 <> OLD.engineering_request_digest_sha256
    OR NEW.projection_digest_sha256 <> OLD.projection_digest_sha256 OR NEW.idempotency_key <> OLD.idempotency_key
    OR NEW.plan_v2_run_id <> OLD.plan_v2_run_id OR NEW.review_id <> OLD.review_id
    OR NEW.recommendation_id <> OLD.recommendation_id OR NEW.repository_commit_sha <> OLD.repository_commit_sha
    OR NEW.linear_project_id <> OLD.linear_project_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'Linear projection correlation identity is immutable';
  END IF;
  IF OLD.status = 'projected' AND NEW.status <> 'withdrawn' THEN
    RAISE EXCEPTION 'Projected Linear correlation permits withdrawal only';
  END IF;
  IF OLD.status = 'withdrawn' THEN RAISE EXCEPTION 'Withdrawn Linear correlation is terminal'; END IF;
  NEW.updated_at := now(); RETURN NEW;
END $$;

CREATE FUNCTION public.withdraw_linear_projection_delivery(
  p_correlation_id uuid, p_engineering_request_digest_sha256 text, p_withdrawal_rationale text
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF p_engineering_request_digest_sha256 !~ '^[a-f0-9]{64}$' OR p_withdrawal_rationale IS NULL
    OR char_length(btrim(p_withdrawal_rationale)) NOT BETWEEN 1 AND 4000 THEN
    RAISE EXCEPTION 'invalid withdrawal request' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  UPDATE public.linear_projection_correlations AS correlation
    SET status='withdrawn', withdrawal_rationale=btrim(p_withdrawal_rationale), withdrawn_at=now()
    WHERE correlation.id=p_correlation_id
      AND correlation.engineering_request_digest_sha256=p_engineering_request_digest_sha256
      AND correlation.status IN ('claimed','projected','failed');
  IF NOT FOUND THEN RAISE EXCEPTION 'active projection correlation not found' USING ERRCODE='no_data_found'; END IF;
END $$;
REVOKE ALL ON FUNCTION public.withdraw_linear_projection_delivery(uuid,text,text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.withdraw_linear_projection_delivery(uuid,text,text) TO service_role;
