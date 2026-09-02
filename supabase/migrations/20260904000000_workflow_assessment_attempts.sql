-- ============================================================================
-- Durable execution claim for workflow assessment
--
-- Pending work was derived as "no assessment exists yet". Two sweeps, or a
-- sweep and a manual trigger, could both select the same submission and both
-- call the provider: uniqueness on the assessment row rejects the second
-- INSERT, but only after the money has been spent twice.
--
-- A claim must therefore be acquired BEFORE provider access, atomically.
--
-- This table is operational coordination state, not evidence. Intake,
-- assessment and review remain immutable; attempts have a tightly constrained
-- mutable lifecycle because claim/lease coordination is genuinely simpler that
-- way than as an append-only event log requiring effective-state resolution.
-- It is never canonical truth and never reviewed-specification authority.
--
--   claimed -> succeeded
--   claimed -> failed
--
-- Terminal states are final, enforced by trigger. Only SECURITY DEFINER RPCs
-- may create or transition rows; no role holds direct DML.
-- ============================================================================

CREATE TABLE IF NOT EXISTS "public"."workflow_assessment_attempts" (
  "id" "uuid" NOT NULL DEFAULT gen_random_uuid(),
  "source_submission_id" "uuid" NOT NULL,
  -- Pinned at claim time, so an attempt's ordinal cannot drift.
  "attempt_number" integer NOT NULL,
  "status" "text" NOT NULL DEFAULT 'claimed',
  "claimed_at" timestamp with time zone NOT NULL DEFAULT "now"(),
  "completed_at" timestamp with time zone,
  -- Reason code only. The six intake answers describe a visitor's business
  -- process and never appear here.
  "failure_class" "text",
  "created_at" timestamp with time zone NOT NULL DEFAULT "now"(),
  CONSTRAINT "workflow_assessment_attempts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "workflow_assessment_attempts_status_check"
    CHECK ("status" = ANY (ARRAY['claimed', 'succeeded', 'failed'])),
  CONSTRAINT "workflow_assessment_attempts_number_check"
    CHECK ("attempt_number" >= 1),
  -- Terminal rows carry a completion time; a live claim does not.
  CONSTRAINT "workflow_assessment_attempts_completion_check" CHECK (
    ("status" = 'claimed' AND "completed_at" IS NULL AND "failure_class" IS NULL)
    OR ("status" = 'succeeded' AND "completed_at" IS NOT NULL AND "failure_class" IS NULL)
    OR ("status" = 'failed' AND "completed_at" IS NOT NULL AND "failure_class" IS NOT NULL)
  )
);

DO $workflow_attempt_fk$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.workflow_assessment_attempts'::regclass
      AND conname = 'workflow_assessment_attempts_submission_fkey'
  ) THEN
    ALTER TABLE "public"."workflow_assessment_attempts"
      ADD CONSTRAINT "workflow_assessment_attempts_submission_fkey"
      FOREIGN KEY ("source_submission_id")
      REFERENCES "public"."workflow_intake_submissions"("id") ON DELETE RESTRICT;
  END IF;
END
$workflow_attempt_fk$;

-- One row per (submission, attempt number): a racing claimant loses the insert
-- rather than duplicating an attempt ordinal.
CREATE UNIQUE INDEX IF NOT EXISTS "workflow_assessment_attempts_submission_number_idx"
  ON "public"."workflow_assessment_attempts" ("source_submission_id", "attempt_number");

-- At most ONE live claim per submission, enforced by the database rather than
-- by the caller checking first. This is what makes concurrent claims safe.
CREATE UNIQUE INDEX IF NOT EXISTS "workflow_assessment_attempts_single_active_idx"
  ON "public"."workflow_assessment_attempts" ("source_submission_id")
  WHERE "status" = 'claimed';

-- Terminal means terminal.
CREATE OR REPLACE FUNCTION "public"."reject_workflow_attempt_terminal_change"()
RETURNS "trigger"
LANGUAGE "plpgsql"
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'workflow assessment attempts are not deletable';
  END IF;
  IF OLD.status <> 'claimed' THEN
    RAISE EXCEPTION 'attempt % is already %, and terminal states are final',
      OLD.id, OLD.status;
  END IF;
  -- Identity is pinned: a transition may not repoint an attempt.
  IF NEW.source_submission_id <> OLD.source_submission_id
     OR NEW.attempt_number <> OLD.attempt_number
     OR NEW.id <> OLD.id THEN
    RAISE EXCEPTION 'attempt identity is immutable';
  END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION "public"."reject_workflow_attempt_terminal_change"() OWNER TO "postgres";

DROP TRIGGER IF EXISTS "workflow_assessment_attempts_lifecycle"
  ON "public"."workflow_assessment_attempts";
CREATE TRIGGER "workflow_assessment_attempts_lifecycle"
  BEFORE UPDATE OR DELETE ON "public"."workflow_assessment_attempts"
  FOR EACH ROW EXECUTE FUNCTION "public"."reject_workflow_attempt_terminal_change"();

ALTER TABLE "public"."workflow_assessment_attempts" ENABLE ROW LEVEL SECURITY;

-- No direct DML for anyone. The claim and finalize RPCs are the only writers.
REVOKE ALL ON TABLE "public"."workflow_assessment_attempts"
  FROM PUBLIC, "anon", "authenticated";
REVOKE ALL ON TABLE "public"."workflow_assessment_attempts" FROM "service_role";
GRANT SELECT ON TABLE "public"."workflow_assessment_attempts" TO "service_role";
