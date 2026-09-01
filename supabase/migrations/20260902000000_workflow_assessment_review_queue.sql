-- ============================================================================
-- Workflow Assessment review queue projection
--
-- "What needs review?" answered without reading assessment blobs out of the
-- database. Each assessment payload can carry forty steps with their grounding,
-- and a queue needs none of it -- only enough to decide what to open next. The
-- projection is therefore computed in SQL and only the summary crosses the
-- boundary.
--
-- Reviewability is DERIVED, never stored. There is no mutable `pending` flag on
-- the assessment: a row is reviewable exactly when no review exists for that
-- precise (assessment_id, assessment_version). Both inputs are immutable, so
-- the queue cannot drift from the evidence, and re-assessment at a new version
-- reopens review without anything being toggled.
--
-- Read-only. This function selects; it writes nothing, and nothing it returns
-- is executable.
-- ============================================================================

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
  "qualified_deterministic_count" integer,
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
    -- Summary is operator-facing prose from the validated assessment, not raw
    -- provider output: it passed the strict schema before it was ever stored.
    NULLIF(a.assessment->>'summary', ''),
    COALESCE(jsonb_array_length(a.assessment->'workflowSteps'), 0),
    -- EightForge-derived counts. Only qualified steps count as deterministic
    -- candidates; the provider cannot supply either number.
    COALESCE(
      (a.assessment->'automationAssessment'->>'deterministicCandidateSteps')::integer, 0),
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
