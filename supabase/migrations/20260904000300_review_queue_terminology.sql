-- ============================================================================
-- Correct the review queue projection's deterministic terminology
--
-- The queue read `automationAssessment.deterministicCandidateSteps`, a property
-- that no longer exists: the assessment task now emits groundedUnverifiedSteps,
-- because no pre-review state may imply trusted determinism. The projection
-- therefore returned 0 for every row while presenting the number as a
-- "qualified deterministic" count -- both silently wrong and semantically
-- false.
--
-- The output column is renamed rather than kept for compatibility. A name that
-- claims trusted qualification is exactly what the qualification remediation
-- removed, and preserving it would reintroduce the claim at the read layer.
--
-- DROP then CREATE because a RETURNS TABLE column rename changes the function
-- signature; CREATE OR REPLACE cannot do it.
-- ============================================================================

DROP FUNCTION IF EXISTS "public"."read_workflow_assessment_review_queue"(integer);

CREATE OR REPLACE FUNCTION "public"."read_workflow_assessment_review_queue"(
  "p_limit" integer DEFAULT 50
)
RETURNS TABLE (
  "assessment_id" "uuid",
  "assessment_version" integer,
  "source_submission_id" "uuid",
  "created_at" timestamp with time zone,
  "summary" "text",
  "step_count" integer,
  "grounded_unverified_count" integer,
  "steps_with_gaps_count" integer,
  "human_decision_count" integer,
  "review_state" "text"
)
LANGUAGE "sql"
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT
    a.id,
    a.assessment_version,
    a.source_submission_id,
    a.created_at,
    NULLIF(a.assessment->>'summary', ''),
    COALESCE(jsonb_array_length(a.assessment->'workflowSteps'), 0),
    -- Grounding traced to the persisted intake, entailment NOT confirmed. Only
    -- an operator review can establish that, so this is not a trusted count.
    COALESCE(
      (a.assessment->'automationAssessment'->>'groundedUnverifiedSteps')::integer, 0),
    COALESCE(
      (a.assessment->'automationAssessment'->>'stepsWithUnresolvedDeterminismGaps')::integer, 0),
    COALESCE(
      (a.assessment->'automationAssessment'->'countsByClassification'->>'HUMAN')::integer, 0),
    'pending_review'::text
  FROM public.workflow_assessments AS a
  WHERE NOT EXISTS (
    SELECT 1
    FROM public.workflow_assessment_reviews AS r
    WHERE r.assessment_id = a.id
      AND r.assessment_version = a.assessment_version
  )
  ORDER BY a.created_at DESC
  LIMIT GREATEST(1, LEAST(COALESCE("p_limit", 50), 200));
$$;

ALTER FUNCTION "public"."read_workflow_assessment_review_queue"(integer)
  OWNER TO "postgres";

REVOKE ALL ON FUNCTION "public"."read_workflow_assessment_review_queue"(integer)
  FROM PUBLIC, "anon", "authenticated";
GRANT EXECUTE ON FUNCTION "public"."read_workflow_assessment_review_queue"(integer)
  TO "service_role";
