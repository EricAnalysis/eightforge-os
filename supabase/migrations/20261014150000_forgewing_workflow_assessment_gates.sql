-- Forgewing S3: Workflow Assessment behind the shared Forgewing gate chain.
--
-- Workflow Assessment sends an organization's intake answers and bounded
-- attachment excerpts to a provider. Until now it was gated only by deployment
-- flags. It now passes the same gates as every other customer-content
-- Forgewing workflow: commercial entitlement and data-processing authorization
-- (resolved in the application by the shared gate module, which stays the one
-- place those ledgers are interpreted), and the durable per-organization
-- provider-call budget (spent here, atomically with the claim).
--
-- 1. The budget ledger gains the type `workflow_assessment`. Additive only:
--    every existing row already satisfies the widened check.
-- 2. `list_workflow_assessment_candidate_organizations` names the organizations
--    that own claimable submissions (ids only), so eligibility can be resolved
--    before any claim. A submission without an organization (historical public
--    intake) has no entitlement or data policy to consult and is never a
--    candidate: it fails closed.
-- 3. `claim_workflow_assessment_attempt` is narrowed to organizations the
--    caller has found eligible, and reserves that organization's budget slot in
--    the same transaction as the attempt row. A budget refusal excludes the
--    organization and creates no attempt, so a denied submission never spends
--    one of its two lifetime attempts, and a reservation never exists without
--    its attempt. The previous three-argument signature is dropped rather than
--    left beside this one: an overload without the narrowing would be a way
--    around the gates (the pattern of 20260904000200).
--
-- Nothing here writes or changes intake, assessment, review, entitlement or
-- data-policy rows.

ALTER TABLE public.forgewing_provider_call_reservations
  DROP CONSTRAINT forgewing_provider_call_reservations_recovery_type_check;

ALTER TABLE public.forgewing_provider_call_reservations
  ADD CONSTRAINT forgewing_provider_call_reservations_recovery_type_check
  CHECK (recovery_type IN ('priced_value_reading', 'project_ask', 'case_investigation', 'workflow_assessment'));

CREATE FUNCTION public.list_workflow_assessment_candidate_organizations()
RETURNS TABLE (organization_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT DISTINCT intake.organization_id
  FROM public.workflow_intake_submissions AS intake
  WHERE intake.organization_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM public.workflow_assessments AS assessment
      WHERE assessment.source_submission_id = intake.id
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.workflow_assessment_attempts AS active_attempt
      WHERE active_attempt.source_submission_id = intake.id
        AND active_attempt.status = 'claimed'
    )
    AND (
      SELECT count(*) FROM public.workflow_assessment_attempts AS lifetime_attempt
      WHERE lifetime_attempt.source_submission_id = intake.id
    ) < 2
  ORDER BY intake.organization_id;
$$;

ALTER FUNCTION public.list_workflow_assessment_candidate_organizations() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.list_workflow_assessment_candidate_organizations()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_workflow_assessment_candidate_organizations()
  TO service_role;

DROP FUNCTION public.claim_workflow_assessment_attempt(integer, uuid, uuid[]);

CREATE FUNCTION public.claim_workflow_assessment_attempt(
  p_max_attempts integer,
  p_submission_id uuid,
  p_exclude_submission_ids uuid[],
  p_eligible_organization_ids uuid[],
  p_daily_cap integer
)
RETURNS TABLE (
  attempt_id uuid,
  source_submission_id uuid,
  attempt_number integer,
  organization_id uuid,
  reservation_id uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_submission uuid;
  v_organization uuid;
  v_attempts integer;
  v_excluded uuid[] := COALESCE(p_exclude_submission_ids, ARRAY[]::uuid[]);
  v_excluded_organizations uuid[] := ARRAY[]::uuid[];
  v_reserved boolean;
  v_reservation uuid;
  v_attempt uuid;
BEGIN
  -- The database-owned lifetime cap stays non-negotiable.
  IF p_max_attempts IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION 'workflow assessment lifetime attempt cap is 2'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- No eligible organization means nothing may be claimed. Fail closed.
  IF p_eligible_organization_ids IS NULL OR cardinality(p_eligible_organization_ids) = 0 THEN
    RETURN;
  END IF;

  LOOP
    SELECT intake.id, intake.organization_id INTO v_submission, v_organization
    FROM public.workflow_intake_submissions AS intake
    WHERE (p_submission_id IS NULL OR intake.id = p_submission_id)
      AND intake.organization_id = ANY (p_eligible_organization_ids)
      AND NOT (intake.organization_id = ANY (v_excluded_organizations))
      AND NOT (intake.id = ANY (v_excluded))
      AND NOT EXISTS (
        SELECT 1 FROM public.workflow_assessments AS assessment
        WHERE assessment.source_submission_id = intake.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.workflow_assessment_attempts AS active_attempt
        WHERE active_attempt.source_submission_id = intake.id
          AND active_attempt.status = 'claimed'
      )
      AND (
        SELECT count(*) FROM public.workflow_assessment_attempts AS lifetime_attempt
        WHERE lifetime_attempt.source_submission_id = intake.id
      ) < 2
    ORDER BY intake.submitted_at ASC, intake.id ASC
    FOR UPDATE OF intake SKIP LOCKED
    LIMIT 1;

    IF v_submission IS NULL THEN RETURN; END IF;

    SELECT count(*) INTO v_attempts
    FROM public.workflow_assessment_attempts AS lifetime_attempt
    WHERE lifetime_attempt.source_submission_id = v_submission;

    -- Recheck under the serialization boundary before inserting.
    IF v_attempts >= 2
      OR EXISTS (SELECT 1 FROM public.workflow_assessments AS assessment
        WHERE assessment.source_submission_id = v_submission)
      OR EXISTS (SELECT 1 FROM public.workflow_assessment_attempts AS active_attempt
        WHERE active_attempt.source_submission_id = v_submission
          AND active_attempt.status = 'claimed') THEN
      IF p_submission_id IS NOT NULL THEN RETURN; END IF;
      v_excluded := array_append(v_excluded, v_submission);
      CONTINUE;
    END IF;

    -- Reservation and attempt commit together or not at all: a lost race on
    -- the attempt rolls back this block, reservation included.
    BEGIN
      SELECT budget.reserved, budget.reservation_id INTO v_reserved, v_reservation
      FROM public.reserve_forgewing_provider_call(
        v_organization,
        'workflow_assessment',
        encode(sha256(convert_to(
          'workflow_assessment:' || v_submission::text || ':' || (v_attempts + 1)::text, 'UTF8')), 'hex'),
        NULL,
        p_daily_cap
      ) AS budget;

      IF v_reserved IS DISTINCT FROM true THEN
        -- This organization's budget is spent: skip all of its submissions
        -- without creating an attempt.
        IF p_submission_id IS NOT NULL THEN RETURN; END IF;
        v_excluded_organizations := array_append(v_excluded_organizations, v_organization);
        CONTINUE;
      END IF;

      INSERT INTO public.workflow_assessment_attempts AS inserted (
        source_submission_id, attempt_number, status
      )
      VALUES (v_submission, v_attempts + 1, 'claimed')
      RETURNING inserted.id INTO v_attempt;
    EXCEPTION WHEN unique_violation THEN
      IF p_submission_id IS NOT NULL THEN RETURN; END IF;
      v_excluded := array_append(v_excluded, v_submission);
      CONTINUE;
    END;

    RETURN QUERY SELECT v_attempt, v_submission, v_attempts + 1, v_organization, v_reservation;
    RETURN;
  END LOOP;
END;
$$;

ALTER FUNCTION public.claim_workflow_assessment_attempt(integer, uuid, uuid[], uuid[], integer)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.claim_workflow_assessment_attempt(integer, uuid, uuid[], uuid[], integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_workflow_assessment_attempt(integer, uuid, uuid[], uuid[], integer)
  TO service_role;
