-- ============================================================================
-- Pending assessment work, derived from immutable evidence
--
-- Public intake persisted submissions that nothing in production ever assessed:
-- the trigger route existed but had no caller, so the chain stopped one step
-- after the visitor pressed submit.
--
-- Pending state is DERIVED, never stored. A submission is pending exactly when
-- no assessment row references it. There is no mutable status column to fall
-- out of sync with the evidence, and re-running an assessment cannot be faked
-- by flipping a flag.
--
-- This is a read projection only. It selects; it triggers nothing, and it
-- cannot cause a provider call. Anonymous submission still cannot spend
-- provider budget: something authorized has to come and ask.
-- ============================================================================

CREATE OR REPLACE FUNCTION "public"."read_pending_workflow_assessments"(
  "p_limit" integer DEFAULT 25
)
RETURNS TABLE (
  "submission_id" "uuid",
  "schema_version" "text",
  "submitted_at" timestamp with time zone
)
LANGUAGE "sql"
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT s.id, s.schema_version, s.submitted_at
  FROM public.workflow_intake_submissions AS s
  WHERE NOT EXISTS (
    SELECT 1
    FROM public.workflow_assessments AS a
    WHERE a.source_submission_id = s.id
  )
  -- Oldest first: the visitor who waited longest is assessed first.
  ORDER BY s.submitted_at ASC
  LIMIT GREATEST(1, LEAST(COALESCE("p_limit", 25), 100));
$$;

ALTER FUNCTION "public"."read_pending_workflow_assessments"(integer)
  OWNER TO "postgres";

-- The intake answers are deliberately NOT returned. Discovering that work
-- exists requires no access to what a visitor described; only the assessment
-- runner reads the answers, through its own SECURITY DEFINER seam.
REVOKE ALL ON FUNCTION "public"."read_pending_workflow_assessments"(integer)
  FROM PUBLIC, "anon", "authenticated";
GRANT EXECUTE ON FUNCTION "public"."read_pending_workflow_assessments"(integer)
  TO "service_role";
