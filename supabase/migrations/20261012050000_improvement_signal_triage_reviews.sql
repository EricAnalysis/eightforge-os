-- ============================================================================
-- Improvement signal triage reviews (B8.3c)
--
-- Purpose: a platform reviewer's human triage of one improvement signal
-- submission (B8.3b). Append-only and versioned: re-triage is a new version,
-- never an edit, so every decision stays auditable.
--
-- Authority: the existing platform-review allowlist
-- (lib/server/workflowPlatformReviewAccess.ts). No new role. The reviewer
-- identity is derived from the authenticated session by the trusted server.
--
-- A triage decides where a signal goes; it executes nothing and approves no
-- engineering work:
--   route_to_engineering        -> eligible for the existing Plan V2 path (B8.3d)
--   customer_config_or_mapping  -> belongs in customer configuration / mapping
--   reject | defer
-- capability_scope reuses the engineering-review vocabulary. A rule semantics
-- review routed onward also carries the human classification of the defect
-- (wording_defect | rule_logic_defect); nothing else may carry one.
--
-- rationale is the reviewer's own text. It stays platform-local: it is not
-- part of the allowlisted structured metadata that B8.3d may send to a
-- provider.
-- ============================================================================

-- Composite keys on the submission table so a triage row can bind the
-- organization and signal kind it was decided against, not just the id.
DO $improvement_signal_submission_keys$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.improvement_signal_submissions'::regclass
      AND conname = 'improvement_signal_submissions_id_org_kind_unique'
  ) THEN
    ALTER TABLE ONLY "public"."improvement_signal_submissions"
      ADD CONSTRAINT "improvement_signal_submissions_id_org_kind_unique"
      UNIQUE ("id", "organization_id", "signal_kind");
  END IF;
END
$improvement_signal_submission_keys$;

CREATE TABLE IF NOT EXISTS "public"."improvement_signal_triage_reviews" (
    "id" "uuid" NOT NULL,
    CONSTRAINT "improvement_signal_triage_reviews_pkey" PRIMARY KEY ("id"),

    "submission_id" "uuid" NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "signal_kind" "text" NOT NULL,

    "triage_version" integer NOT NULL,

    "disposition" "text" NOT NULL,
    "capability_scope" "text",
    "semantics_defect_class" "text",
    "rationale" "text" NOT NULL,

    "reviewer_actor_id" "uuid" NOT NULL,
    "reviewed_at" timestamp with time zone DEFAULT "now"() NOT NULL,

    CONSTRAINT "improvement_signal_triage_reviews_version_check"
      CHECK (("triage_version" >= 1)),
    CONSTRAINT "improvement_signal_triage_reviews_disposition_check"
      CHECK (("disposition" = ANY (ARRAY[
        'route_to_engineering'::"text", 'customer_config_or_mapping'::"text", 'reject'::"text", 'defer'::"text"
      ]))),
    CONSTRAINT "improvement_signal_triage_reviews_scope_check"
      CHECK (("capability_scope" IS NULL OR "capability_scope" = ANY (ARRAY[
        'client_specific'::"text", 'workflow_specific'::"text", 'reusable_platform_capability'::"text"
      ]))),
    -- A routed signal names its scope; a rejected or deferred one does not.
    CONSTRAINT "improvement_signal_triage_reviews_scope_required_check"
      CHECK ((("capability_scope" IS NOT NULL)
        = ("disposition" = ANY (ARRAY['route_to_engineering'::"text", 'customer_config_or_mapping'::"text"])))),
    CONSTRAINT "improvement_signal_triage_reviews_defect_class_check"
      CHECK (("semantics_defect_class" IS NULL OR "semantics_defect_class" = ANY (ARRAY[
        'wording_defect'::"text", 'rule_logic_defect'::"text"
      ]))),
    -- Exactly a routed rule semantics review carries the human defect classification.
    CONSTRAINT "improvement_signal_triage_reviews_defect_class_required_check"
      CHECK ((("semantics_defect_class" IS NOT NULL)
        = ("signal_kind" = 'rule_semantics_review'::"text"
          AND "disposition" = ANY (ARRAY['route_to_engineering'::"text", 'customer_config_or_mapping'::"text"])))),
    CONSTRAINT "improvement_signal_triage_reviews_rationale_check"
      CHECK (("char_length"("btrim"("rationale")) BETWEEN 1 AND 4000)),
    CONSTRAINT "improvement_signal_triage_reviews_submission_version_unique"
      UNIQUE ("submission_id", "triage_version")
);

DO $improvement_signal_triage_reviews$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.improvement_signal_triage_reviews'::regclass
      AND conname = 'improvement_signal_triage_reviews_submission_fkey'
  ) THEN
    ALTER TABLE ONLY "public"."improvement_signal_triage_reviews"
      ADD CONSTRAINT "improvement_signal_triage_reviews_submission_fkey"
      FOREIGN KEY ("submission_id", "organization_id", "signal_kind")
      REFERENCES "public"."improvement_signal_submissions"("id", "organization_id", "signal_kind") ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.improvement_signal_triage_reviews'::regclass
      AND conname = 'improvement_signal_triage_reviews_reviewer_fkey'
  ) THEN
    ALTER TABLE ONLY "public"."improvement_signal_triage_reviews"
      ADD CONSTRAINT "improvement_signal_triage_reviews_reviewer_fkey"
      FOREIGN KEY ("reviewer_actor_id") REFERENCES "public"."user_profiles"("id") ON DELETE RESTRICT;
  END IF;
END
$improvement_signal_triage_reviews$;

CREATE INDEX IF NOT EXISTS "improvement_signal_triage_reviews_submission_idx"
  ON "public"."improvement_signal_triage_reviews" USING "btree" ("submission_id", "triage_version" DESC);

-- ----------------------------------------------------------------------------
-- Immutability: a triage decision is audit truth.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "public"."reject_improvement_signal_triage_review_mutation"()
RETURNS "trigger"
LANGUAGE "plpgsql"
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION
    'improvement_signal_triage_reviews is append-only: % rejected',
    TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

DROP TRIGGER IF EXISTS "improvement_signal_triage_reviews_immutable"
  ON "public"."improvement_signal_triage_reviews";

CREATE TRIGGER "improvement_signal_triage_reviews_immutable"
  BEFORE UPDATE OR DELETE ON "public"."improvement_signal_triage_reviews"
  FOR EACH ROW
  EXECUTE FUNCTION "public"."reject_improvement_signal_triage_review_mutation"();

-- ----------------------------------------------------------------------------
-- Access control.
-- ----------------------------------------------------------------------------
ALTER TABLE "public"."improvement_signal_triage_reviews" ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE "public"."improvement_signal_triage_reviews" FROM "anon", "authenticated";

REVOKE ALL ON TABLE "public"."improvement_signal_triage_reviews" FROM "service_role";
GRANT SELECT, INSERT ON TABLE "public"."improvement_signal_triage_reviews" TO "service_role";

REVOKE ALL ON FUNCTION "public"."reject_improvement_signal_triage_review_mutation"()
  FROM "public", "anon", "authenticated";
