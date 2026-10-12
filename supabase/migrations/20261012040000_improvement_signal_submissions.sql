-- ============================================================================
-- Improvement signal submissions (B8.3b)
--
-- Purpose: durable, append-only record of one organization's Forgewing friction
-- signal, submitted by an organization owner/admin for platform triage (B8.3c)
-- and, once a person has triaged it, the existing repository-plan path (B8.3d).
--
-- This is the beginning of a tenant -> platform boundary crossing, so the row
-- holds ONLY the allowlisted signal payload (B8.3a, friction_signal_v1):
-- signal kind, a code from a controlled vocabulary, the rule catalogue
-- fingerprint, counts, at most ten typed record references (UUIDs or SHA-256
-- digests), the root-cause category and the undetermined defect class. It never
-- holds customer text, override reasons, operator notes, document labels or
-- names. The trusted server validates the payload against the allowlist schema
-- before insert; the CHECKs below re-assert its shape so a future writer cannot
-- silently widen it.
--
-- It sits beside workflow_intake_submissions, not inside it: workflow intake is
-- anonymous free-text onboarding with no tenant, which is the wrong contract.
--
-- Access model (mirrors workflow_intake_submissions):
--   * RLS enabled with NO policies -> deny-all for anon and authenticated.
--   * REVOKE ALL from anon, authenticated -> never reachable from a browser.
--   * service_role may INSERT and SELECT (idempotent resubmission, triage read)
--     and nothing else.
--   * An immutability trigger rejects UPDATE and DELETE outright.
-- ============================================================================

CREATE TABLE IF NOT EXISTS "public"."improvement_signal_submissions" (
    "id" "uuid" NOT NULL,
    CONSTRAINT "improvement_signal_submissions_pkey" PRIMARY KEY ("id"),

    "organization_id" "uuid" NOT NULL,

    "schema_version" "text" DEFAULT 'improvement_signal_submission_v1'::"text" NOT NULL,

    "signal_kind" "text" NOT NULL,
    "signal_code" "text" NOT NULL,

    -- The allowlisted friction signal payload, exactly as validated.
    "payload" "jsonb" NOT NULL,
    -- SHA-256 of the canonical (recursive key-sorted) payload JSON.
    "payload_digest_sha256" "text" NOT NULL,

    -- The bounds of the friction read that produced the signal (projects and
    -- overrides read, their limits, and whether either was truncated).
    "read_bounds" "jsonb" NOT NULL,

    "submitted_by" "uuid" NOT NULL,
    "submitted_at" timestamp with time zone DEFAULT "now"() NOT NULL,

    CONSTRAINT "improvement_signal_submissions_schema_version_check"
      CHECK (("schema_version" = 'improvement_signal_submission_v1'::"text")),
    CONSTRAINT "improvement_signal_submissions_signal_kind_check"
      CHECK (("signal_kind" = ANY (ARRAY[
        'recurring_deterministic_failure'::"text",
        'recurring_manual_correction'::"text",
        'forgewing_rejected'::"text",
        'qualification_demand'::"text",
        'rule_semantics_review'::"text"
      ]))),
    CONSTRAINT "improvement_signal_submissions_signal_code_check"
      CHECK (("char_length"("signal_code") BETWEEN 1 AND 160)),
    CONSTRAINT "improvement_signal_submissions_payload_shape_check"
      CHECK ((
        "jsonb_typeof"("payload") = 'object'
        AND "payload" ?& ARRAY['schemaVersion', 'signalKind', 'code', 'catalogueFingerprint', 'counts',
          'recordRefs', 'rootCauseCategory', 'defectClass']
        AND ("payload" - ARRAY['schemaVersion', 'signalKind', 'code', 'catalogueFingerprint', 'counts',
          'recordRefs', 'rootCauseCategory', 'defectClass']) = '{}'::"jsonb"
        AND "payload"->>'schemaVersion' = 'friction_signal_v1'
        AND "payload"->>'signalKind' = "signal_kind"
        AND "payload"->>'code' = "signal_code"
        AND "jsonb_typeof"("payload"->'counts') = 'object'
        AND "jsonb_typeof"("payload"->'recordRefs') = 'array'
        AND "jsonb_array_length"("payload"->'recordRefs') <= 10
      )),
    CONSTRAINT "improvement_signal_submissions_payload_digest_check"
      CHECK (("payload_digest_sha256" ~ '^[a-f0-9]{64}$'::"text")),
    CONSTRAINT "improvement_signal_submissions_read_bounds_check"
      CHECK (("jsonb_typeof"("read_bounds") = 'object')),
    -- Resubmitting the identical payload for the same organization is idempotent.
    CONSTRAINT "improvement_signal_submissions_org_payload_unique"
      UNIQUE ("organization_id", "payload_digest_sha256")
);

DO $improvement_signal_submissions$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.improvement_signal_submissions'::regclass
      AND conname = 'improvement_signal_submissions_organization_id_fkey'
  ) THEN
    ALTER TABLE ONLY "public"."improvement_signal_submissions"
      ADD CONSTRAINT "improvement_signal_submissions_organization_id_fkey"
      FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.improvement_signal_submissions'::regclass
      AND conname = 'improvement_signal_submissions_submitted_by_fkey'
  ) THEN
    ALTER TABLE ONLY "public"."improvement_signal_submissions"
      ADD CONSTRAINT "improvement_signal_submissions_submitted_by_fkey"
      FOREIGN KEY ("submitted_by") REFERENCES "public"."user_profiles"("id") ON DELETE RESTRICT;
  END IF;
END
$improvement_signal_submissions$;

CREATE INDEX IF NOT EXISTS "improvement_signal_submissions_submitted_at_idx"
  ON "public"."improvement_signal_submissions" USING "btree" ("submitted_at" DESC);
CREATE INDEX IF NOT EXISTS "improvement_signal_submissions_org_submitted_at_idx"
  ON "public"."improvement_signal_submissions" USING "btree" ("organization_id", "submitted_at" DESC);

-- ----------------------------------------------------------------------------
-- Immutability: a submission is the evidence a later triage and plan rest on.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "public"."reject_improvement_signal_submission_mutation"()
RETURNS "trigger"
LANGUAGE "plpgsql"
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION
    'improvement_signal_submissions is append-only: % rejected',
    TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

DROP TRIGGER IF EXISTS "improvement_signal_submissions_immutable"
  ON "public"."improvement_signal_submissions";

CREATE TRIGGER "improvement_signal_submissions_immutable"
  BEFORE UPDATE OR DELETE ON "public"."improvement_signal_submissions"
  FOR EACH ROW
  EXECUTE FUNCTION "public"."reject_improvement_signal_submission_mutation"();

-- ----------------------------------------------------------------------------
-- Access control.
-- ----------------------------------------------------------------------------
ALTER TABLE "public"."improvement_signal_submissions" ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE "public"."improvement_signal_submissions" FROM "anon", "authenticated";

REVOKE ALL ON TABLE "public"."improvement_signal_submissions" FROM "service_role";
GRANT SELECT, INSERT ON TABLE "public"."improvement_signal_submissions" TO "service_role";

REVOKE ALL ON FUNCTION "public"."reject_improvement_signal_submission_mutation"()
  FROM "public", "anon", "authenticated";
