-- ============================================================================
-- Workflow Assessment Review / Approval Model V1
--
-- An operator judges what Forgewing proposed. That judgement is a first-class
-- audit record, not a status flag on the proposal.
--
--   workflow_intake_submissions      what the user described (immutable)
--     └── workflow_assessments vN    what Forgewing proposed (immutable)
--           └── workflow_assessment_reviews          what an operator decided
--                 └── workflow_assessment_step_reviews   ... about each step
--
-- Two tables rather than one JSONB blob, because the questions this data exists
-- to answer are relational: which RULE proposals get downgraded to HUMAN, which
-- RECOVER proposals are rejected most often, which determinism qualifications
-- operators consistently agree with, which Forgewing assumptions are repeatedly
-- overridden.
--
-- Nothing here mutates `workflow_assessments`. A review pins one exact
-- immutable assessment version and records a judgement *about* it; the proposal
-- itself stays byte-identical to what Forgewing produced, which is the whole
-- reason a reviewer can be trusted to have reviewed it.
--
-- `accepted` means accepted as SYSTEM SPECIFICATION. It is not deployment, not
-- a runtime rule, and not an executable artifact. No production reader consumes
-- these tables, and approving a RULE step changes no production behavior.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Parent review: one operator's judgement of one assessment version.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "public"."workflow_assessment_reviews" (
    "id" "uuid" NOT NULL,
    CONSTRAINT "workflow_assessment_reviews_pkey" PRIMARY KEY ("id"),

    -- The exact proposal under review. assessment_version is stored alongside
    -- the id so the pinned version is legible without joining, and so a review
    -- can never be silently re-pointed at a newer interpretation.
    "assessment_id" "uuid" NOT NULL,
    "source_submission_id" "uuid" NOT NULL,
    "assessment_version" integer NOT NULL,

    -- Monotonic per assessment. Re-review appends; it never overwrites.
    "review_version" integer NOT NULL,

    "reviewer_actor_id" "uuid" NOT NULL,

    -- DERIVED from the child dispositions by
    -- public.record_workflow_assessment_review. It is never accepted from a
    -- caller, so "approved overall" while three steps are rejected is not a
    -- state this schema can represent.
    "overall_disposition" "text" NOT NULL,

    "reviewer_summary" "text",

    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,

    CONSTRAINT "workflow_assessment_reviews_overall_disposition_check"
      CHECK (("overall_disposition" = ANY (ARRAY[
        'accepted'::"text", 'changes_required'::"text", 'rejected'::"text"
      ]))),
    CONSTRAINT "workflow_assessment_reviews_version_check"
      CHECK (("review_version" >= 1)),
    CONSTRAINT "workflow_assessment_reviews_assessment_version_check"
      CHECK (("assessment_version" >= 1)),
    CONSTRAINT "workflow_assessment_reviews_summary_length_check"
      CHECK (("reviewer_summary" IS NULL OR "char_length"("reviewer_summary") <= 4000))
);

DO $workflow_assessment_reviews_fk$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.workflow_assessment_reviews'::regclass
      AND conname = 'workflow_assessment_reviews_assessment_id_fkey'
  ) THEN
    -- RESTRICT, not CASCADE: an assessment that has been reviewed cannot be
    -- deleted out from under its own audit trail.
    ALTER TABLE ONLY "public"."workflow_assessment_reviews"
      ADD CONSTRAINT "workflow_assessment_reviews_assessment_id_fkey"
      FOREIGN KEY ("assessment_id")
      REFERENCES "public"."workflow_assessments"("id") ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.workflow_assessment_reviews'::regclass
      AND conname = 'workflow_assessment_reviews_source_submission_id_fkey'
  ) THEN
    ALTER TABLE ONLY "public"."workflow_assessment_reviews"
      ADD CONSTRAINT "workflow_assessment_reviews_source_submission_id_fkey"
      FOREIGN KEY ("source_submission_id")
      REFERENCES "public"."workflow_intake_submissions"("id") ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.workflow_assessment_reviews'::regclass
      AND conname = 'workflow_assessment_reviews_reviewer_actor_id_fkey'
  ) THEN
    -- RESTRICT preserves attribution: an operator who has reviewed something
    -- cannot be deleted without first dealing with the record they created.
    ALTER TABLE ONLY "public"."workflow_assessment_reviews"
      ADD CONSTRAINT "workflow_assessment_reviews_reviewer_actor_id_fkey"
      FOREIGN KEY ("reviewer_actor_id")
      REFERENCES "public"."user_profiles"("id") ON DELETE RESTRICT;
  END IF;
END
$workflow_assessment_reviews_fk$;

-- One row per (assessment, review_version): the database, not the writer, is
-- what makes concurrent re-review append rather than collide.
CREATE UNIQUE INDEX IF NOT EXISTS "workflow_assessment_reviews_assessment_version_key"
  ON "public"."workflow_assessment_reviews" USING "btree"
  ("assessment_id", "review_version");

CREATE INDEX IF NOT EXISTS "workflow_assessment_reviews_submission_idx"
  ON "public"."workflow_assessment_reviews" USING "btree"
  ("source_submission_id", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "workflow_assessment_reviews_reviewer_idx"
  ON "public"."workflow_assessment_reviews" USING "btree"
  ("reviewer_actor_id", "created_at" DESC);

-- ----------------------------------------------------------------------------
-- 2. Child step reviews: one disposition per proposed workflow step.
--
-- proposed_classification and reviewed_classification are stored separately and
-- both retained. A RULE downgraded to HUMAN keeps the RULE on the record --
-- overwriting it would destroy the disagreement the table exists to measure.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "public"."workflow_assessment_step_reviews" (
    "id" "uuid" NOT NULL,
    CONSTRAINT "workflow_assessment_step_reviews_pkey" PRIMARY KEY ("id"),

    "review_id" "uuid" NOT NULL,

    -- The stepId as it appears inside the pinned assessment payload. This
    -- cannot be a foreign key -- workflow steps live inside the assessment
    -- jsonb -- so referential integrity is enforced by
    -- public.record_workflow_assessment_review, which rejects any step id that
    -- does not appear in the exact assessment version being reviewed.
    "assessment_step_id" "text" NOT NULL,

    "proposed_classification" "text" NOT NULL,
    "reviewed_classification" "text",

    "disposition" "text" NOT NULL,
    "reviewer_notes" "text",

    -- The operator's refined specification, when they changed something. NULL
    -- means "as proposed" -- the Forgewing original is never copied in, because
    -- it already exists immutably in workflow_assessments.
    "accepted_specification" "jsonb",

    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,

    CONSTRAINT "workflow_assessment_step_reviews_disposition_check"
      CHECK (("disposition" = ANY (ARRAY[
        'accepted'::"text", 'reclassified'::"text",
        'modified'::"text", 'rejected'::"text"
      ]))),
    CONSTRAINT "workflow_assessment_step_reviews_proposed_classification_check"
      CHECK (("proposed_classification" = ANY (ARRAY[
        'RULE'::"text", 'VERIFY'::"text", 'EXTRACT'::"text",
        'RECOVER'::"text", 'HUMAN'::"text", 'ADVISORY'::"text"
      ]))),
    CONSTRAINT "workflow_assessment_step_reviews_reviewed_classification_check"
      CHECK (("reviewed_classification" IS NULL OR "reviewed_classification" = ANY (ARRAY[
        'RULE'::"text", 'VERIFY'::"text", 'EXTRACT'::"text",
        'RECOVER'::"text", 'HUMAN'::"text", 'ADVISORY'::"text"
      ]))),

    -- Disposition and the classification pair cannot contradict each other.
    --   accepted    -> reviewed classification equals the proposal
    --   reclassified-> reviewed classification differs from the proposal
    --   modified    -> classification unchanged, specification refined
    --   rejected    -> nothing accepted, so no reviewed classification
    CONSTRAINT "workflow_assessment_step_reviews_disposition_coherence_check"
      CHECK ((
        ("disposition" = 'accepted'
          AND "reviewed_classification" = "proposed_classification"
          AND "accepted_specification" IS NULL)
        OR ("disposition" = 'reclassified'
          AND "reviewed_classification" IS NOT NULL
          AND "reviewed_classification" <> "proposed_classification")
        OR ("disposition" = 'modified'
          AND "reviewed_classification" = "proposed_classification"
          AND "accepted_specification" IS NOT NULL)
        OR ("disposition" = 'rejected'
          AND "reviewed_classification" IS NULL
          AND "accepted_specification" IS NULL)
      )),
    CONSTRAINT "workflow_assessment_step_reviews_specification_is_object_check"
      CHECK (("accepted_specification" IS NULL
        OR "jsonb_typeof"("accepted_specification") = 'object'::"text")),
    CONSTRAINT "workflow_assessment_step_reviews_notes_length_check"
      CHECK (("reviewer_notes" IS NULL OR "char_length"("reviewer_notes") <= 4000)),
    CONSTRAINT "workflow_assessment_step_reviews_step_id_length_check"
      CHECK (("char_length"("assessment_step_id") BETWEEN 1 AND 120))
);

DO $workflow_assessment_step_reviews_fk$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.workflow_assessment_step_reviews'::regclass
      AND conname = 'workflow_assessment_step_reviews_review_id_fkey'
  ) THEN
    ALTER TABLE ONLY "public"."workflow_assessment_step_reviews"
      ADD CONSTRAINT "workflow_assessment_step_reviews_review_id_fkey"
      FOREIGN KEY ("review_id")
      REFERENCES "public"."workflow_assessment_reviews"("id") ON DELETE RESTRICT;
  END IF;
END
$workflow_assessment_step_reviews_fk$;

-- One disposition per step per review.
CREATE UNIQUE INDEX IF NOT EXISTS "workflow_assessment_step_reviews_review_step_key"
  ON "public"."workflow_assessment_step_reviews" USING "btree"
  ("review_id", "assessment_step_id");

-- Supports the relational questions this split exists for: "which proposed
-- classification is most often overridden, and to what?"
CREATE INDEX IF NOT EXISTS "workflow_assessment_step_reviews_classification_idx"
  ON "public"."workflow_assessment_step_reviews" USING "btree"
  ("proposed_classification", "reviewed_classification", "disposition");

CREATE INDEX IF NOT EXISTS "workflow_assessment_step_reviews_disposition_idx"
  ON "public"."workflow_assessment_step_reviews" USING "btree"
  ("disposition", "created_at" DESC);

-- ----------------------------------------------------------------------------
-- 3. Immutability. A review records what an operator judged at a point in time.
-- Editing one would destroy the audit trail; a new review_version is the only
-- way forward.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "public"."reject_workflow_assessment_review_mutation"()
RETURNS "trigger"
LANGUAGE "plpgsql"
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION
    'workflow assessment reviews are append-only: % rejected, record a new review_version instead',
    TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

DROP TRIGGER IF EXISTS "workflow_assessment_reviews_immutable"
  ON "public"."workflow_assessment_reviews";

CREATE TRIGGER "workflow_assessment_reviews_immutable"
  BEFORE UPDATE OR DELETE ON "public"."workflow_assessment_reviews"
  FOR EACH ROW
  EXECUTE FUNCTION "public"."reject_workflow_assessment_review_mutation"();

DROP TRIGGER IF EXISTS "workflow_assessment_step_reviews_immutable"
  ON "public"."workflow_assessment_step_reviews";

CREATE TRIGGER "workflow_assessment_step_reviews_immutable"
  BEFORE UPDATE OR DELETE ON "public"."workflow_assessment_step_reviews"
  FOR EACH ROW
  EXECUTE FUNCTION "public"."reject_workflow_assessment_review_mutation"();

-- ----------------------------------------------------------------------------
-- 4. The single validated write path.
--
-- Parent and children must land atomically, the overall disposition must be
-- derived rather than asserted, and every step id must exist in the exact
-- assessment version being reviewed. None of that is expressible as a per-row
-- constraint, so this function is the only writer -- the tables themselves
-- grant no INSERT to anyone.
-- ----------------------------------------------------------------------------
-- Parameters are p_-prefixed deliberately: PL/pgSQL raises an ambiguity error
-- when an identifier resolves to both a parameter and an in-scope column, and
-- every name here collides with a column it is compared against.
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
BEGIN
  IF "p_step_reviews" IS NULL OR jsonb_typeof("p_step_reviews") <> 'array' THEN
    RAISE EXCEPTION 'step_reviews must be a json array'
      USING ERRCODE = 'invalid_parameter_value';
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
  -- COALESCE so an assessment with no steps fails on the coverage check below
  -- with a legible message, rather than inside jsonb_object_keys(NULL).
  SELECT COALESCE(
    jsonb_object_agg(step->>'stepId', step->>'classification'), '{}'::jsonb)
    INTO v_proposed_steps
  FROM jsonb_array_elements(v_assessment->'workflowSteps') AS step;

  v_expected := (SELECT count(*) FROM jsonb_object_keys(v_proposed_steps));

  -- Complete coverage. An overall disposition derived from a partial review
  -- would overstate what the operator actually judged.
  IF jsonb_array_length("p_step_reviews") <> v_expected THEN
    RAISE EXCEPTION
      'review must disposition every proposed step: expected %, received %',
      v_expected, jsonb_array_length("p_step_reviews")
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

-- ----------------------------------------------------------------------------
-- 5. Access control.
--
-- Reviews describe a visitor's business process and an operator's judgement of
-- it. Neither is public. No role holds INSERT on either table: the SECURITY
-- DEFINER function above is the only writer, which makes "every review was
-- validated and every overall disposition was derived" a structural property
-- rather than a convention the next writer has to remember.
-- ----------------------------------------------------------------------------
ALTER TABLE "public"."workflow_assessment_reviews" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."workflow_assessment_step_reviews" ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE "public"."workflow_assessment_reviews"
  FROM "anon", "authenticated";
REVOKE ALL ON TABLE "public"."workflow_assessment_step_reviews"
  FROM "anon", "authenticated";

REVOKE ALL ON TABLE "public"."workflow_assessment_reviews" FROM "service_role";
REVOKE ALL ON TABLE "public"."workflow_assessment_step_reviews" FROM "service_role";
GRANT SELECT ON TABLE "public"."workflow_assessment_reviews" TO "service_role";
GRANT SELECT ON TABLE "public"."workflow_assessment_step_reviews" TO "service_role";

REVOKE ALL ON FUNCTION "public"."record_workflow_assessment_review"(
  "uuid", integer, "uuid", "jsonb", "text"
) FROM PUBLIC, "anon", "authenticated";
GRANT EXECUTE ON FUNCTION "public"."record_workflow_assessment_review"(
  "uuid", integer, "uuid", "jsonb", "text"
) TO "service_role";

REVOKE ALL ON FUNCTION "public"."reject_workflow_assessment_review_mutation"()
  FROM PUBLIC, "anon", "authenticated";
