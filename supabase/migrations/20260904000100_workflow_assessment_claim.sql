-- ============================================================================
-- Atomic claim acquisition and finalization
--
-- claim_workflow_assessment_attempt() selects one eligible submission and
-- creates its attempt row in a single statement. The partial unique index on
-- (source_submission_id) WHERE status = 'claimed' is what makes it safe: two
-- concurrent callers both try to insert, one wins, the loser gets no claim and
-- therefore never reaches the provider.
--
-- Eligibility is derived from immutable evidence plus attempt history:
--
--   * no assessment exists for the submission;
--   * no live claim exists;
--   * fewer than WORKFLOW_ASSESSMENT_MAX_ATTEMPTS attempts have been made.
--
-- The attempt cap is passed in by the single server-side constant rather than
-- duplicated here, so there is one place it can be changed.
--
-- A submission that exhausts its attempts is excluded from selection forever,
-- so a permanently failing row cannot starve later work. Resetting that is
-- deliberately not possible here: it would be an explicit operator action.
-- ============================================================================

CREATE OR REPLACE FUNCTION "public"."claim_workflow_assessment_attempt"(
  "p_max_attempts" integer,
  "p_submission_id" "uuid" DEFAULT NULL
)
RETURNS TABLE (
  "attempt_id" "uuid",
  "source_submission_id" "uuid",
  "attempt_number" integer
)
LANGUAGE "plpgsql"
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_submission uuid;
  v_attempts integer;
BEGIN
  IF "p_max_attempts" IS NULL OR "p_max_attempts" < 1 THEN
    RAISE EXCEPTION 'max attempts must be a positive integer'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- One eligible submission. When p_submission_id is supplied (the manual
  -- trigger) the same eligibility rules still apply, so a manual caller cannot
  -- bypass exhaustion or steal a live claim.
  SELECT s.id INTO v_submission
  FROM public.workflow_intake_submissions AS s
  WHERE ("p_submission_id" IS NULL OR s.id = "p_submission_id")
    AND NOT EXISTS (
      SELECT 1 FROM public.workflow_assessments AS a
      WHERE a.source_submission_id = s.id
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.workflow_assessment_attempts AS t
      WHERE t.source_submission_id = s.id AND t.status = 'claimed'
    )
    AND (
      SELECT count(*) FROM public.workflow_assessment_attempts AS t
      WHERE t.source_submission_id = s.id
    ) < "p_max_attempts"
  ORDER BY s.submitted_at ASC
  LIMIT 1;

  IF v_submission IS NULL THEN
    RETURN;
  END IF;

  SELECT count(*) INTO v_attempts
  FROM public.workflow_assessment_attempts AS t
  WHERE t.source_submission_id = v_submission;

  -- The insert is the claim. A concurrent caller that selected the same
  -- submission loses here on the partial unique index and returns empty, so
  -- exactly one caller may proceed to the provider.
  BEGIN
    RETURN QUERY
    INSERT INTO public.workflow_assessment_attempts (
      source_submission_id, attempt_number, status
    )
    VALUES (v_submission, v_attempts + 1, 'claimed')
    RETURNING id, source_submission_id, attempt_number;
  EXCEPTION WHEN unique_violation THEN
    -- Lost the race. No claim, no provider access.
    RETURN;
  END;
END;
$$;

ALTER FUNCTION "public"."claim_workflow_assessment_attempt"(integer, "uuid")
  OWNER TO "postgres";

/**
 * Moves a live claim to a terminal state.
 *
 * Separate from claiming so the provider call happens strictly between the two,
 * while the claim is held. The lifecycle trigger refuses a second transition.
 */
CREATE OR REPLACE FUNCTION "public"."finalize_workflow_assessment_attempt"(
  "p_attempt_id" "uuid",
  "p_status" "text",
  "p_failure_class" "text" DEFAULT NULL
)
RETURNS "void"
LANGUAGE "plpgsql"
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF "p_status" NOT IN ('succeeded', 'failed') THEN
    RAISE EXCEPTION 'attempt may only be finalized as succeeded or failed'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  UPDATE public.workflow_assessment_attempts
  SET status = "p_status",
      completed_at = now(),
      -- A failure always carries a reason code; a success never does.
      failure_class = CASE WHEN "p_status" = 'failed'
        THEN COALESCE("p_failure_class", 'unspecified') ELSE NULL END
  WHERE id = "p_attempt_id";

  IF NOT FOUND THEN
    RAISE EXCEPTION 'no workflow assessment attempt %', "p_attempt_id"
      USING ERRCODE = 'no_data_found';
  END IF;
END;
$$;

ALTER FUNCTION "public"."finalize_workflow_assessment_attempt"("uuid", "text", "text")
  OWNER TO "postgres";

REVOKE ALL ON FUNCTION "public"."claim_workflow_assessment_attempt"(integer, "uuid")
  FROM PUBLIC, "anon", "authenticated";
GRANT EXECUTE ON FUNCTION "public"."claim_workflow_assessment_attempt"(integer, "uuid")
  TO "service_role";

REVOKE ALL ON FUNCTION "public"."finalize_workflow_assessment_attempt"("uuid", "text", "text")
  FROM PUBLIC, "anon", "authenticated";
GRANT EXECUTE ON FUNCTION "public"."finalize_workflow_assessment_attempt"("uuid", "text", "text")
  TO "service_role";
