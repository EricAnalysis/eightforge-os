-- ============================================================================
-- Workflow intake submissions (Forgewing public intake, V1)
--
-- Purpose: durable, immutable storage for the six plain-English answers a
-- public visitor gives in the Forgewing workflow assessment dialog.
--
-- This table is IMMUTABLE SOURCE MATERIAL, not a contact form and not derived
-- data. It holds exactly what the submitter typed, a server-generated identity,
-- and nothing else. A future Forgewing Workflow Assessment phase will translate
-- these answers into a candidate EightForge system specification
-- (WorkflowDefinition: documents, extraction requirements, deterministic rules,
-- evidence relationships, verification rules, recovery tasks, human decision
-- points, advisory steps, failure consequences, automation assessment).
--
-- That derived layer MUST live in its own table(s) referencing
-- workflow_intake_submissions.id as source_submission_id. Nothing derived,
-- classified, scored, or provider-generated may ever be written back here:
-- the row is append-only so the original description survives unchanged for
-- audit, replay, and re-interpretation under a newer assessment version.
--
-- organization_id is deliberately left NULL. Public intake has no actor and no
-- tenant at submission time. The nullable FK exists so a submission can later
-- be claimed by an organization without reshaping the table.
--
-- Access model (mirrors the Phase 3 compliance foundation pattern):
--   * RLS enabled with NO policies -> deny-all for anon and authenticated.
--   * REVOKE ALL from anon, authenticated -> the browser can never reach the
--     table directly, with or without a session.
--   * REVOKE ALL from service_role, then GRANT INSERT only -> even the trusted
--     server/admin seam cannot read, update, or delete. Writes are one-way.
--   * An immutability trigger rejects UPDATE and DELETE outright, so a future
--     grant change cannot silently make submissions editable.
-- ============================================================================

CREATE TABLE IF NOT EXISTS "public"."workflow_intake_submissions" (
    "id" "uuid" NOT NULL,
    CONSTRAINT "workflow_intake_submissions_pkey" PRIMARY KEY ("id"),

    -- Frozen contract version for the answer set below. A future intake shape
    -- gets a new version value, never a rewrite of existing rows.
    "schema_version" "text" DEFAULT 'workflow_intake_v1'::"text" NOT NULL,

    -- The six intake answers, exactly as submitted (trimmed only).
    "workflow_description" "text" NOT NULL,
    "documents_involved" "text" NOT NULL,
    "manual_checks" "text" NOT NULL,
    "frequency_and_volume" "text" NOT NULL,
    "exceptions" "text" NOT NULL,
    "human_decisions" "text" NOT NULL,

    -- Unassigned at submission time. Present so a later claim needs no reshape.
    "organization_id" "uuid",

    "submitted_at" timestamp with time zone DEFAULT "now"() NOT NULL,

    CONSTRAINT "workflow_intake_submissions_schema_version_check"
      CHECK (("schema_version" = 'workflow_intake_v1'::"text")),
    CONSTRAINT "workflow_intake_submissions_workflow_description_check"
      CHECK ((("btrim"("workflow_description") <> ''::"text") AND ("length"("workflow_description") <= 5000))),
    CONSTRAINT "workflow_intake_submissions_documents_involved_check"
      CHECK ((("btrim"("documents_involved") <> ''::"text") AND ("length"("documents_involved") <= 5000))),
    CONSTRAINT "workflow_intake_submissions_manual_checks_check"
      CHECK ((("btrim"("manual_checks") <> ''::"text") AND ("length"("manual_checks") <= 5000))),
    CONSTRAINT "workflow_intake_submissions_frequency_and_volume_check"
      CHECK ((("btrim"("frequency_and_volume") <> ''::"text") AND ("length"("frequency_and_volume") <= 5000))),
    CONSTRAINT "workflow_intake_submissions_exceptions_check"
      CHECK ((("btrim"("exceptions") <> ''::"text") AND ("length"("exceptions") <= 5000))),
    CONSTRAINT "workflow_intake_submissions_human_decisions_check"
      CHECK ((("btrim"("human_decisions") <> ''::"text") AND ("length"("human_decisions") <= 5000)))
);

DO $workflow_intake_submissions$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.workflow_intake_submissions'::regclass
      AND conname = 'workflow_intake_submissions_organization_id_fkey'
  ) THEN
    ALTER TABLE ONLY "public"."workflow_intake_submissions"
      ADD CONSTRAINT "workflow_intake_submissions_organization_id_fkey"
      FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE SET NULL;
  END IF;
END
$workflow_intake_submissions$;

CREATE INDEX IF NOT EXISTS "workflow_intake_submissions_submitted_at_idx"
  ON "public"."workflow_intake_submissions" USING "btree" ("submitted_at" DESC);

-- ----------------------------------------------------------------------------
-- Immutability: a submission is the submitter's own words. Rewriting one would
-- destroy the source material a later assessment is meant to be replayable
-- against, so UPDATE and DELETE fail loudly rather than being merely ungranted.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "public"."reject_workflow_intake_submission_mutation"()
RETURNS "trigger"
LANGUAGE "plpgsql"
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION
    'workflow_intake_submissions is append-only immutable source intake: % rejected',
    TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

DROP TRIGGER IF EXISTS "workflow_intake_submissions_immutable"
  ON "public"."workflow_intake_submissions";

CREATE TRIGGER "workflow_intake_submissions_immutable"
  BEFORE UPDATE OR DELETE ON "public"."workflow_intake_submissions"
  FOR EACH ROW
  EXECUTE FUNCTION "public"."reject_workflow_intake_submission_mutation"();

-- ----------------------------------------------------------------------------
-- Access control.
-- ----------------------------------------------------------------------------
ALTER TABLE "public"."workflow_intake_submissions" ENABLE ROW LEVEL SECURITY;

-- No policies are created: RLS with zero policies denies every anon and
-- authenticated request even if a GRANT is later added by mistake.
REVOKE ALL ON TABLE "public"."workflow_intake_submissions" FROM "anon", "authenticated";

-- The trusted server seam may append and nothing else. No SELECT: V1 has no
-- read path of any kind, public or operator-facing.
REVOKE ALL ON TABLE "public"."workflow_intake_submissions" FROM "service_role";
GRANT INSERT ON TABLE "public"."workflow_intake_submissions" TO "service_role";

REVOKE ALL ON FUNCTION "public"."reject_workflow_intake_submission_mutation"()
  FROM "public", "anon", "authenticated";
