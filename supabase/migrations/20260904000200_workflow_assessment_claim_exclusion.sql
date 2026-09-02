-- ============================================================================
-- Claim exclusion, so one sweep cannot attempt the same submission twice
--
-- A daily sweep now processes up to three attempts per invocation, claiming
-- each one atomically in turn. That creates a subtlety the single-claim version
-- did not have: when submission A fails, its attempt reaches a terminal state
-- and A still has an attempt remaining, so the very next claim in the same
-- sweep could select A again and spend a second provider call on it
-- immediately.
--
-- The caller therefore passes the submissions it has already attempted during
-- this invocation, and they are excluded from selection. Per-submission
-- lifetime attempts remain capped independently, so this narrows selection and
-- never widens it.
--
-- The previous two-argument function is dropped rather than left beside this
-- one: an overload that skips exclusion would be a way around the rule.
-- ============================================================================

DROP FUNCTION IF EXISTS "public"."claim_workflow_assessment_attempt"(integer, "uuid");

CREATE OR REPLACE FUNCTION "public"."claim_workflow_assessment_attempt"(
  "p_max_attempts" integer,
  "p_submission_id" "uuid" DEFAULT NULL,
  "p_exclude_submission_ids" "uuid"[] DEFAULT NULL
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
  v_excluded uuid[] := COALESCE("p_exclude_submission_ids", ARRAY[]::uuid[]);
BEGIN
  IF "p_max_attempts" IS NULL OR "p_max_attempts" < 1 THEN
    RAISE EXCEPTION 'max attempts must be a positive integer'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Oldest eligible submission. Eligibility is derived entirely from immutable
  -- evidence plus attempt history, so a stale projection can never authorize a
  -- provider call: this select and the insert below are the authority.
  SELECT s.id INTO v_submission
  FROM public.workflow_intake_submissions AS s
  WHERE ("p_submission_id" IS NULL OR s.id = "p_submission_id")
    AND NOT (s.id = ANY (v_excluded))
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

  -- The insert IS the claim. A concurrent sweep that selected the same
  -- submission loses on the partial unique index and returns empty, so exactly
  -- one caller may proceed to the provider.
  BEGIN
    RETURN QUERY
    INSERT INTO public.workflow_assessment_attempts (
      source_submission_id, attempt_number, status
    )
    VALUES (v_submission, v_attempts + 1, 'claimed')
    RETURNING id, source_submission_id, attempt_number;
  EXCEPTION WHEN unique_violation THEN
    RETURN;
  END;
END;
$$;

ALTER FUNCTION "public"."claim_workflow_assessment_attempt"(integer, "uuid", "uuid"[])
  OWNER TO "postgres";

REVOKE ALL ON FUNCTION "public"."claim_workflow_assessment_attempt"(integer, "uuid", "uuid"[])
  FROM PUBLIC, "anon", "authenticated";
GRANT EXECUTE ON FUNCTION "public"."claim_workflow_assessment_attempt"(integer, "uuid", "uuid"[])
  TO "service_role";
