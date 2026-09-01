-- ============================================================================
-- Workflow Review Contract Hardening V1
--
-- Two corrections to public.record_workflow_assessment_review, both found by
-- an integrity review of the shipped model. Neither was reachable through the
-- application, but the function is the authority boundary for every review
-- write, and a boundary should state its own rules rather than rely on callers
-- upstream or on a constraint failing at a lower layer.
--
--   1. Explicit zero-step rejection. If an assessment somehow carried no
--      workflowSteps, an empty step_reviews array satisfied the count, distinct
--      and membership checks, and bool_and over zero rows yields NULL, so the
--      derived disposition fell through to 'changes_required'. That would have
--      written a parent review with no children -- a completed review of
--      nothing.
--
--   2. A named reviewer failure. Reviewer existence was enforced only by the
--      foreign key, so an unknown reviewer surfaced as an opaque constraint
--      violation while every other validation raised a legible message. Who
--      reviewed something is audit truth; failing to resolve it deserves to be
--      stated, not inferred from a constraint name.
--
-- No schema change: same tables, same grants, same triggers, same signature.
-- The function is replaced in place, so the write path stays exactly as
-- contained as before -- neither table grants INSERT to any role.
--
-- Nothing here makes a review executable. `accepted` remains approved system
-- specification.
-- ============================================================================

CREATE OR REPLACE FUNCTION "public"."record_workflow_assessment_review"(
  "p_assessment_id" "uuid",
  "p_assessment_version" integer,
  "p_reviewer_actor_id" "uuid",
  "p_step_reviews" "jsonb",
  "p_reviewer_summary" "text" DEFAULT NULL
)
RETURNS TABLE (
  "review_id" "uuid",
  "review_version" integer,
  "overall_disposition" "text",
  "step_review_count" integer
)
LANGUAGE "plpgsql"
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_submission_id uuid;
  v_assessment jsonb;
  v_proposed_steps jsonb;
  v_review_id uuid;
  v_review_version integer;
  v_overall text;
  v_count integer;
  v_expected integer;
  v_distinct integer;
BEGIN
  IF "p_step_reviews" IS NULL OR jsonb_typeof("p_step_reviews") <> 'array' THEN
    RAISE EXCEPTION 'step_reviews must be a json array'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Reviewer identity, stated rather than left to the foreign key. The server
  -- derives this from an authenticated session; if it does not resolve to a
  -- real profile here, the review is unattributable and must not be written.
  IF "p_reviewer_actor_id" IS NULL
    OR NOT EXISTS (
      SELECT 1 FROM public.user_profiles AS u WHERE u.id = "p_reviewer_actor_id"
    ) THEN
    RAISE EXCEPTION 'workflow assessment reviewer % is not a known user profile',
      "p_reviewer_actor_id"
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  -- Pin the exact assessment version. A mismatch is a caller bug, not a
  -- fallback: silently reviewing a different version is the failure this whole
  -- design exists to prevent.
  SELECT a.source_submission_id, a.assessment
    INTO v_submission_id, v_assessment
  FROM public.workflow_assessments AS a
  WHERE a.id = "p_assessment_id"
    AND a.assessment_version = "p_assessment_version";

  IF v_submission_id IS NULL THEN
    RAISE EXCEPTION 'no workflow assessment % at version %',
      "p_assessment_id", "p_assessment_version"
      USING ERRCODE = 'no_data_found';
  END IF;

  -- stepId -> classification, as Forgewing actually proposed it.
  SELECT COALESCE(
    jsonb_object_agg(step->>'stepId', step->>'classification'), '{}'::jsonb)
    INTO v_proposed_steps
  FROM jsonb_array_elements(v_assessment->'workflowSteps') AS step;

  v_expected := (SELECT count(*) FROM jsonb_object_keys(v_proposed_steps));

  -- An assessment with no steps cannot be reviewed. Without this, an empty
  -- review satisfied every downstream check and produced a childless parent
  -- row whose derived disposition described nothing.
  IF v_expected = 0 THEN
    RAISE EXCEPTION
      'workflow assessment % version % has no proposed steps to review',
      "p_assessment_id", "p_assessment_version"
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Complete coverage. An overall disposition derived from a partial review
  -- would overstate what the operator actually judged.
  IF jsonb_array_length("p_step_reviews") <> v_expected THEN
    RAISE EXCEPTION
      'review must disposition every proposed step: expected %, received %',
      v_expected, jsonb_array_length("p_step_reviews")
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Exactly once, not merely the right number of times.
  SELECT count(DISTINCT entry->>'assessment_step_id')
    INTO v_distinct
  FROM jsonb_array_elements("p_step_reviews") AS entry;

  IF v_distinct <> v_expected THEN
    RAISE EXCEPTION
      'review must disposition every proposed step exactly once: % distinct of % expected',
      v_distinct, v_expected
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Every referenced step must exist in THIS assessment version, and the
  -- caller's proposed_classification must match what Forgewing proposed.
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements("p_step_reviews") AS entry
    WHERE NOT (v_proposed_steps ? (entry->>'assessment_step_id'))
       OR (v_proposed_steps->>(entry->>'assessment_step_id'))
            IS DISTINCT FROM (entry->>'proposed_classification')
  ) THEN
    RAISE EXCEPTION
      'step review references a step or proposed classification absent from assessment % version %',
      "p_assessment_id", "p_assessment_version"
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  -- Append at the next review version. The unique index is what makes a racing
  -- reviewer lose the insert rather than overwrite an existing judgement.
  SELECT COALESCE(max(r.review_version), 0) + 1
    INTO v_review_version
  FROM public.workflow_assessment_reviews AS r
  WHERE r.assessment_id = "p_assessment_id";

  -- Derived, never asserted.
  SELECT CASE
    WHEN bool_and(entry->>'disposition' = 'accepted') THEN 'accepted'
    WHEN bool_and(entry->>'disposition' = 'rejected') THEN 'rejected'
    ELSE 'changes_required'
  END
    INTO v_overall
  FROM jsonb_array_elements("p_step_reviews") AS entry;

  v_review_id := gen_random_uuid();

  INSERT INTO public.workflow_assessment_reviews (
    id, assessment_id, source_submission_id, assessment_version,
    review_version, reviewer_actor_id, overall_disposition, reviewer_summary
  ) VALUES (
    v_review_id, "p_assessment_id", v_submission_id, "p_assessment_version",
    v_review_version, "p_reviewer_actor_id", v_overall, "p_reviewer_summary"
  );

  INSERT INTO public.workflow_assessment_step_reviews (
    id, review_id, assessment_step_id, proposed_classification,
    reviewed_classification, disposition, reviewer_notes, accepted_specification
  )
  SELECT
    gen_random_uuid(),
    v_review_id,
    entry->>'assessment_step_id',
    entry->>'proposed_classification',
    entry->>'reviewed_classification',
    entry->>'disposition',
    entry->>'reviewer_notes',
    CASE WHEN jsonb_typeof(entry->'accepted_specification') = 'object'
      THEN entry->'accepted_specification' ELSE NULL END
  FROM jsonb_array_elements("p_step_reviews") AS entry;

  GET DIAGNOSTICS v_count = ROW_COUNT;

  RETURN QUERY SELECT v_review_id, v_review_version, v_overall, v_count;
END;
$$;

ALTER FUNCTION "public"."record_workflow_assessment_review"(
  "uuid", integer, "uuid", "jsonb", "text"
) OWNER TO "postgres";

-- Grants are restated because CREATE OR REPLACE does not alter them and a
-- future reader should not have to open the previous migration to know that
-- only the trusted role may execute this.
REVOKE ALL ON FUNCTION "public"."record_workflow_assessment_review"(
  "uuid", integer, "uuid", "jsonb", "text"
) FROM PUBLIC, "anon", "authenticated";
GRANT EXECUTE ON FUNCTION "public"."record_workflow_assessment_review"(
  "uuid", integer, "uuid", "jsonb", "text"
) TO "service_role";
