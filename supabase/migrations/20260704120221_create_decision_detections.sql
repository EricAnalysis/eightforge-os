-- ============================================================================
-- Create decision_detections
--
-- Purpose: restore the runtime table used by AI enrichment persistence and
-- portfolio command-center issue rollups. This is additive and idempotent so it
-- can safely close the live gap documented in the 2026-07-01 full-system audit.
-- ============================================================================

CREATE TABLE IF NOT EXISTS "public"."decision_detections" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    CONSTRAINT "decision_detections_pkey" PRIMARY KEY ("id"),
    "organization_id" "uuid" NOT NULL,
    "document_id" "uuid" NOT NULL,
    "project_id" "uuid",
    "decision_type" "text" NOT NULL,
    "decision_value" "text",
    "confidence" numeric,
    "source" "text" DEFAULT 'deterministic'::"text" NOT NULL,
    "reason" "text",
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "resolved_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "decision_detections_confidence_check" CHECK ((("confidence" IS NULL) OR (("confidence" >= (0)::numeric) AND ("confidence" <= (1)::numeric)))),
    CONSTRAINT "decision_detections_decision_type_not_blank" CHECK (("btrim"("decision_type") <> ''::"text")),
    CONSTRAINT "decision_detections_source_check" CHECK (("source" = ANY (ARRAY['deterministic'::"text", 'ai_enriched'::"text", 'manual'::"text"])))
);

DO $decision_detections$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.decision_detections'::regclass
      AND conname = 'decision_detections_organization_id_fkey'
  ) THEN
    ALTER TABLE ONLY "public"."decision_detections"
      ADD CONSTRAINT "decision_detections_organization_id_fkey"
      FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;
  END IF;
END
$decision_detections$;

DO $decision_detections$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.decision_detections'::regclass
      AND conname = 'decision_detections_document_id_fkey'
  ) THEN
    ALTER TABLE ONLY "public"."decision_detections"
      ADD CONSTRAINT "decision_detections_document_id_fkey"
      FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE CASCADE;
  END IF;
END
$decision_detections$;

DO $decision_detections$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.decision_detections'::regclass
      AND conname = 'decision_detections_project_id_fkey'
  ) THEN
    ALTER TABLE ONLY "public"."decision_detections"
      ADD CONSTRAINT "decision_detections_project_id_fkey"
      FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE SET NULL;
  END IF;
END
$decision_detections$;

CREATE INDEX IF NOT EXISTS "idx_decision_detections_document_id"
  ON "public"."decision_detections" USING "btree" ("document_id");

CREATE INDEX IF NOT EXISTS "idx_decision_detections_org_type"
  ON "public"."decision_detections" USING "btree" ("organization_id", "decision_type");

CREATE INDEX IF NOT EXISTS "idx_decision_detections_project_id"
  ON "public"."decision_detections" USING "btree" ("project_id")
  WHERE "project_id" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "idx_decision_detections_project_resolved"
  ON "public"."decision_detections" USING "btree" ("project_id", "resolved_at")
  WHERE "project_id" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "idx_decision_detections_document_source_job"
  ON "public"."decision_detections" USING "btree" ("document_id", "source", ("metadata" ->> 'job_id'));

CREATE OR REPLACE FUNCTION "public"."set_decision_detection_project_id"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.project_id IS NULL THEN
    NEW.project_id := (
      SELECT d.project_id
      FROM public.documents d
      WHERE d.id = NEW.document_id
    );
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "trg_decision_detections_set_project_id" ON "public"."decision_detections";
CREATE TRIGGER "trg_decision_detections_set_project_id"
  BEFORE INSERT OR UPDATE OF "document_id", "project_id"
  ON "public"."decision_detections"
  FOR EACH ROW
  EXECUTE FUNCTION "public"."set_decision_detection_project_id"();

DROP TRIGGER IF EXISTS "trg_decision_detections_set_updated_at" ON "public"."decision_detections";
CREATE TRIGGER "trg_decision_detections_set_updated_at"
  BEFORE UPDATE ON "public"."decision_detections"
  FOR EACH ROW
  EXECUTE FUNCTION "public"."set_updated_at"();

ALTER TABLE "public"."decision_detections" ENABLE ROW LEVEL SECURITY;

DO $decision_detections$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'decision_detections'
      AND policyname = 'decision_detections_select_org'
  ) THEN
    CREATE POLICY "decision_detections_select_org"
      ON "public"."decision_detections"
      FOR SELECT TO "authenticated"
      USING ((EXISTS (
        SELECT 1
        FROM "public"."user_profiles" "up"
        WHERE (("up"."id" = "auth"."uid"()) AND ("up"."organization_id" = "decision_detections"."organization_id"))
      )));
  END IF;
END
$decision_detections$;

DO $decision_detections$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'decision_detections'
      AND policyname = 'decision_detections_insert_org'
  ) THEN
    CREATE POLICY "decision_detections_insert_org"
      ON "public"."decision_detections"
      FOR INSERT TO "authenticated"
      WITH CHECK ((EXISTS (
        SELECT 1
        FROM "public"."user_profiles" "up"
        WHERE (("up"."id" = "auth"."uid"()) AND ("up"."organization_id" = "decision_detections"."organization_id"))
      )));
  END IF;
END
$decision_detections$;

DO $decision_detections$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'decision_detections'
      AND policyname = 'decision_detections_update_org'
  ) THEN
    CREATE POLICY "decision_detections_update_org"
      ON "public"."decision_detections"
      FOR UPDATE TO "authenticated"
      USING ((EXISTS (
        SELECT 1
        FROM "public"."user_profiles" "up"
        WHERE (("up"."id" = "auth"."uid"()) AND ("up"."organization_id" = "decision_detections"."organization_id"))
      )))
      WITH CHECK ((EXISTS (
        SELECT 1
        FROM "public"."user_profiles" "up"
        WHERE (("up"."id" = "auth"."uid"()) AND ("up"."organization_id" = "decision_detections"."organization_id"))
      )));
  END IF;
END
$decision_detections$;

DO $decision_detections$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'decision_detections'
      AND policyname = 'decision_detections_delete_org'
  ) THEN
    CREATE POLICY "decision_detections_delete_org"
      ON "public"."decision_detections"
      FOR DELETE TO "authenticated"
      USING ((EXISTS (
        SELECT 1
        FROM "public"."user_profiles" "up"
        WHERE (("up"."id" = "auth"."uid"()) AND ("up"."organization_id" = "decision_detections"."organization_id"))
      )));
  END IF;
END
$decision_detections$;
