-- ============================================================================
-- Forgewing Workflow Assessment V1
--
-- Two things, both derived-side only:
--
--   1. A read seam for the immutable intake. `workflow_intake_submissions`
--      grants INSERT and nothing else, deliberately, so even the trusted admin
--      seam cannot read it. Rather than weaken that grant, this migration adds
--      one SECURITY DEFINER function that returns exactly one submission by id.
--      It cannot enumerate (a known id is required), it cannot mutate, and it
--      is the single auditable read path. The intake table's grants are left
--      exactly as they are.
--
--   2. `workflow_assessments`: the derived, non-authoritative candidate system
--      specification produced by Forgewing from one submission.
--
-- The assessment is a PROPOSAL. Forgewing is interpreting prose; it is not
-- authoritative enough to decide that a business process may safely execute
-- deterministically. Every row is therefore non-authoritative, requires human
-- review, and carries no executable rule. A RULE classification inside the
-- structured assessment is a candidate specification in plain language, never
-- runtime code and never a production rule definition.
--
-- Assessments are append-only and versioned per submission: re-running the
-- assessment writes a new row at the next version rather than mutating the
-- previous one, so an earlier interpretation stays auditable against a newer
-- prompt or schema.
--
-- Nothing here touches canonical truth, Validator, Project Truth, extraction
-- authority, decisions, actions, or production rule execution.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Single-row read seam for the immutable intake.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "public"."read_workflow_intake_submission"(
  "submission_id" "uuid"
)
RETURNS TABLE (
  "id" "uuid",
  "schema_version" "text",
  "workflow_description" "text",
  "documents_involved" "text",
  "manual_checks" "text",
  "frequency_and_volume" "text",
  "exceptions" "text",
  "human_decisions" "text",
  "submitted_at" timestamp with time zone
)
LANGUAGE "sql"
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT
    s.id, s.schema_version, s.workflow_description, s.documents_involved,
    s.manual_checks, s.frequency_and_volume, s.exceptions, s.human_decisions,
    s.submitted_at
  FROM public.workflow_intake_submissions AS s
  WHERE s.id = submission_id;
$$;

ALTER FUNCTION "public"."read_workflow_intake_submission"("uuid") OWNER TO "postgres";
REVOKE ALL ON FUNCTION "public"."read_workflow_intake_submission"("uuid")
  FROM PUBLIC, "anon", "authenticated";
GRANT EXECUTE ON FUNCTION "public"."read_workflow_intake_submission"("uuid")
  TO "service_role";

-- ----------------------------------------------------------------------------
-- 2. Derived assessments.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "public"."workflow_assessments" (
    "id" "uuid" NOT NULL,
    CONSTRAINT "workflow_assessments_pkey" PRIMARY KEY ("id"),

    "source_submission_id" "uuid" NOT NULL,

    -- Monotonic per submission. Re-assessment appends; it never overwrites.
    "assessment_version" integer NOT NULL,

    "schema_version" "text" DEFAULT 'workflow_assessment_v1'::"text" NOT NULL,

    -- Frozen non-authority markers. These are CHECK-pinned rather than defaulted
    -- so a later writer cannot quietly persist an authoritative assessment.
    "authority" "text" DEFAULT 'non_authoritative'::"text" NOT NULL,
    "requires_human_review" boolean DEFAULT true NOT NULL,
    "review_status" "text" DEFAULT 'pending_human_review'::"text" NOT NULL,

    -- The structured assessment, validated against the strict Zod schema in
    -- lib/forgewing/tasks/workflowAssessment.ts before it ever reaches here.
    "assessment" "jsonb" NOT NULL,

    -- Canonical digest of the validated assessment, for later tamper checks.
    "assessment_digest_sha256" "text" NOT NULL,

    -- Provenance of the interpretation that produced this row.
    "model" "text" NOT NULL,
    "prompt_template_id" "text" NOT NULL,
    "prompt_template_version" "text" NOT NULL,

    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,

    CONSTRAINT "workflow_assessments_schema_version_check"
      CHECK (("schema_version" = 'workflow_assessment_v1'::"text")),
    CONSTRAINT "workflow_assessments_authority_check"
      CHECK (("authority" = 'non_authoritative'::"text")),
    CONSTRAINT "workflow_assessments_requires_human_review_check"
      CHECK (("requires_human_review" = true)),
    CONSTRAINT "workflow_assessments_review_status_check"
      CHECK (("review_status" = ANY (ARRAY['pending_human_review'::"text"]))),
    CONSTRAINT "workflow_assessments_version_check"
      CHECK (("assessment_version" >= 1)),
    CONSTRAINT "workflow_assessments_digest_check"
      CHECK (("assessment_digest_sha256" ~ '^[a-f0-9]{64}$'::"text")),
    CONSTRAINT "workflow_assessments_assessment_is_object_check"
      CHECK (("jsonb_typeof"("assessment") = 'object'::"text"))
);

DO $workflow_assessments$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.workflow_assessments'::regclass
      AND conname = 'workflow_assessments_source_submission_id_fkey'
  ) THEN
    ALTER TABLE ONLY "public"."workflow_assessments"
      ADD CONSTRAINT "workflow_assessments_source_submission_id_fkey"
      FOREIGN KEY ("source_submission_id")
      REFERENCES "public"."workflow_intake_submissions"("id") ON DELETE RESTRICT;
  END IF;
END
$workflow_assessments$;

-- One row per (submission, version): the database, not the writer, is what
-- makes re-assessment append rather than collide.
CREATE UNIQUE INDEX IF NOT EXISTS "workflow_assessments_submission_version_key"
  ON "public"."workflow_assessments" USING "btree"
  ("source_submission_id", "assessment_version");

CREATE INDEX IF NOT EXISTS "workflow_assessments_created_at_idx"
  ON "public"."workflow_assessments" USING "btree" ("created_at" DESC);

-- ----------------------------------------------------------------------------
-- Immutability: an assessment records what Forgewing proposed at a point in
-- time. Editing one would destroy the record a reviewer is meant to judge, so
-- a new version is the only way forward.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "public"."reject_workflow_assessment_mutation"()
RETURNS "trigger"
LANGUAGE "plpgsql"
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION
    'workflow_assessments is append-only: % rejected, write a new assessment_version instead',
    TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

DROP TRIGGER IF EXISTS "workflow_assessments_immutable"
  ON "public"."workflow_assessments";

CREATE TRIGGER "workflow_assessments_immutable"
  BEFORE UPDATE OR DELETE ON "public"."workflow_assessments"
  FOR EACH ROW
  EXECUTE FUNCTION "public"."reject_workflow_assessment_mutation"();

-- ----------------------------------------------------------------------------
-- Access control. Assessments describe a visitor's business process and are
-- never public: RLS denies anon and authenticated outright, and only the
-- trusted server seam may append or read.
-- ----------------------------------------------------------------------------
ALTER TABLE "public"."workflow_assessments" ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE "public"."workflow_assessments" FROM "anon", "authenticated";

REVOKE ALL ON TABLE "public"."workflow_assessments" FROM "service_role";
GRANT SELECT, INSERT ON TABLE "public"."workflow_assessments" TO "service_role";

REVOKE ALL ON FUNCTION "public"."reject_workflow_assessment_mutation"()
  FROM PUBLIC, "anon", "authenticated";
