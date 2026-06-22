-- ============================================================================
-- Completion of the live-schema baseline.
--
-- Exact production catalog capture: 79 constraints, 72 standalone indexes,
-- RLS on 24 tables, 67 policies (61 original plus 4 for public.rules plus
-- 2 transaction_data_rows policies),
-- update_decision_status(uuid, uuid, text), and 10 undocumented triggers.
--
-- Objects use idempotent guards. PostgreSQL 17 does not expose CREATE POLICY
-- IF NOT EXISTS, so policies use pg_policies-backed DO guards. The
-- transaction_data_rows project/organization FK cleanup preserves confirmed
-- live drift after the historical transaction-data migrations run. Triggers use
-- the explicitly required DROP TRIGGER IF EXISTS + CREATE TRIGGER form. The
-- three tr_* validation trigger names intentionally preserve live/history
-- naming drift rather than adopting the committed trg_* convention.
-- ============================================================================

-- Constraints

DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.activity_events'::regclass
      AND conname = 'activity_events_changed_by_fkey'
  ) THEN
    ALTER TABLE ONLY "public"."activity_events"
        ADD CONSTRAINT "activity_events_changed_by_fkey" FOREIGN KEY ("changed_by") REFERENCES "public"."user_profiles"("id") ON DELETE SET NULL;
  END IF;
END
$baseline$;

DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.activity_events'::regclass
      AND conname = 'activity_events_organization_id_fkey'
  ) THEN
    ALTER TABLE ONLY "public"."activity_events"
        ADD CONSTRAINT "activity_events_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;
  END IF;
END
$baseline$;

DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.decision_feedback'::regclass
      AND conname = 'decision_feedback_decision_id_fkey'
  ) THEN
    ALTER TABLE ONLY "public"."decision_feedback"
        ADD CONSTRAINT "decision_feedback_decision_id_fkey" FOREIGN KEY ("decision_id") REFERENCES "public"."decisions"("id") ON DELETE CASCADE;
  END IF;
END
$baseline$;

DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.decision_feedback'::regclass
      AND conname = 'decision_feedback_organization_id_fkey'
  ) THEN
    ALTER TABLE ONLY "public"."decision_feedback"
        ADD CONSTRAINT "decision_feedback_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;
  END IF;
END
$baseline$;

DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.decision_policies'::regclass
      AND conname = 'decision_policies_organization_id_fkey'
  ) THEN
    ALTER TABLE ONLY "public"."decision_policies"
        ADD CONSTRAINT "decision_policies_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id");
  END IF;
END
$baseline$;

DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.decision_rules'::regclass
      AND conname = 'decision_rules_organization_id_fkey'
  ) THEN
    ALTER TABLE ONLY "public"."decision_rules"
        ADD CONSTRAINT "decision_rules_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;
  END IF;
END
$baseline$;

DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.decisions'::regclass
      AND conname = 'decisions_assigned_by_fkey'
  ) THEN
    ALTER TABLE ONLY "public"."decisions"
        ADD CONSTRAINT "decisions_assigned_by_fkey" FOREIGN KEY ("assigned_by") REFERENCES "public"."user_profiles"("id") ON DELETE SET NULL;
  END IF;
END
$baseline$;

DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.decisions'::regclass
      AND conname = 'decisions_assigned_to_fkey'
  ) THEN
    ALTER TABLE ONLY "public"."decisions"
        ADD CONSTRAINT "decisions_assigned_to_fkey" FOREIGN KEY ("assigned_to") REFERENCES "public"."user_profiles"("id") ON DELETE SET NULL;
  END IF;
END
$baseline$;

DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.decisions'::regclass
      AND conname = 'decisions_decision_rule_id_fkey'
  ) THEN
    ALTER TABLE ONLY "public"."decisions"
        ADD CONSTRAINT "decisions_decision_rule_id_fkey" FOREIGN KEY ("decision_rule_id") REFERENCES "public"."decision_rules"("id") ON DELETE SET NULL;
  END IF;
END
$baseline$;

DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.decisions'::regclass
      AND conname = 'decisions_document_id_fkey'
  ) THEN
    ALTER TABLE ONLY "public"."decisions"
        ADD CONSTRAINT "decisions_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE CASCADE;
  END IF;
END
$baseline$;

DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.decisions'::regclass
      AND conname = 'decisions_organization_id_fkey'
  ) THEN
    ALTER TABLE ONLY "public"."decisions"
        ADD CONSTRAINT "decisions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;
  END IF;
END
$baseline$;

DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.decisions'::regclass
      AND conname = 'decisions_project_id_fkey'
  ) THEN
    ALTER TABLE ONLY "public"."decisions"
        ADD CONSTRAINT "decisions_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id");
  END IF;
END
$baseline$;

DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.document_analysis_jobs'::regclass
      AND conname = 'document_analysis_jobs_document_id_fkey'
  ) THEN
    ALTER TABLE ONLY "public"."document_analysis_jobs"
        ADD CONSTRAINT "document_analysis_jobs_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE CASCADE;
  END IF;
END
$baseline$;

DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.document_analysis_jobs'::regclass
      AND conname = 'document_analysis_jobs_organization_id_fkey'
  ) THEN
    ALTER TABLE ONLY "public"."document_analysis_jobs"
        ADD CONSTRAINT "document_analysis_jobs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;
  END IF;
END
$baseline$;

DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.document_analysis_jobs'::regclass
      AND conname = 'document_analysis_jobs_result_extraction_id_fkey'
  ) THEN
    ALTER TABLE ONLY "public"."document_analysis_jobs"
        ADD CONSTRAINT "document_analysis_jobs_result_extraction_id_fkey" FOREIGN KEY ("result_extraction_id") REFERENCES "public"."document_extractions"("id") ON DELETE SET NULL;
  END IF;
END
$baseline$;

DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.document_decisions'::regclass
      AND conname = 'document_decisions_document_id_fkey'
  ) THEN
    ALTER TABLE ONLY "public"."document_decisions"
        ADD CONSTRAINT "document_decisions_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE CASCADE;
  END IF;
END
$baseline$;

DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.document_decisions'::regclass
      AND conname = 'document_decisions_organization_id_fkey'
  ) THEN
    ALTER TABLE ONLY "public"."document_decisions"
        ADD CONSTRAINT "document_decisions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;
  END IF;
END
$baseline$;

DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.document_extractions'::regclass
      AND conname = 'document_extractions_document_id_fkey'
  ) THEN
    ALTER TABLE ONLY "public"."document_extractions"
        ADD CONSTRAINT "document_extractions_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE CASCADE;
  END IF;
END
$baseline$;

DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.document_extractions'::regclass
      AND conname = 'document_extractions_organization_id_fkey'
  ) THEN
    ALTER TABLE ONLY "public"."document_extractions"
        ADD CONSTRAINT "document_extractions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;
  END IF;
END
$baseline$;

DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.documents'::regclass
      AND conname = 'documents_organization_id_fkey'
  ) THEN
    ALTER TABLE ONLY "public"."documents"
        ADD CONSTRAINT "documents_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id");
  END IF;
END
$baseline$;

DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.documents'::regclass
      AND conname = 'documents_project_id_fkey'
  ) THEN
    ALTER TABLE ONLY "public"."documents"
        ADD CONSTRAINT "documents_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE SET NULL;
  END IF;
END
$baseline$;

DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.decisions'::regclass
      AND conname = 'fk_decisions_rule'
  ) THEN
    ALTER TABLE ONLY "public"."decisions"
        ADD CONSTRAINT "fk_decisions_rule" FOREIGN KEY ("decision_rule_id") REFERENCES "public"."rules"("id") ON DELETE SET NULL;
  END IF;
END
$baseline$;

DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.issues'::regclass
      AND conname = 'issues_document_id_fkey'
  ) THEN
    ALTER TABLE ONLY "public"."issues"
        ADD CONSTRAINT "issues_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE SET NULL;
  END IF;
END
$baseline$;

DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.issues'::regclass
      AND conname = 'issues_organization_id_fkey'
  ) THEN
    ALTER TABLE ONLY "public"."issues"
        ADD CONSTRAINT "issues_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;
  END IF;
END
$baseline$;

DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.issues'::regclass
      AND conname = 'issues_project_id_fkey'
  ) THEN
    ALTER TABLE ONLY "public"."issues"
        ADD CONSTRAINT "issues_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE SET NULL;
  END IF;
END
$baseline$;

DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.issues'::regclass
      AND conname = 'issues_review_id_fkey'
  ) THEN
    ALTER TABLE ONLY "public"."issues"
        ADD CONSTRAINT "issues_review_id_fkey" FOREIGN KEY ("review_id") REFERENCES "public"."reviews"("id") ON DELETE SET NULL;
  END IF;
END
$baseline$;

DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.issues'::regclass
      AND conname = 'issues_workflow_id_fkey'
  ) THEN
    ALTER TABLE ONLY "public"."issues"
        ADD CONSTRAINT "issues_workflow_id_fkey" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE SET NULL;
  END IF;
END
$baseline$;

DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.project_rule_overrides'::regclass
      AND conname = 'project_rule_overrides_project_id_fkey'
  ) THEN
    ALTER TABLE ONLY "public"."project_rule_overrides"
        ADD CONSTRAINT "project_rule_overrides_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE CASCADE;
  END IF;
END
$baseline$;

DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.projects'::regclass
      AND conname = 'projects_organization_id_fkey'
  ) THEN
    ALTER TABLE ONLY "public"."projects"
        ADD CONSTRAINT "projects_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;
  END IF;
END
$baseline$;

DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.reviews'::regclass
      AND conname = 'reviews_document_id_fkey'
  ) THEN
    ALTER TABLE ONLY "public"."reviews"
        ADD CONSTRAINT "reviews_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE SET NULL;
  END IF;
END
$baseline$;

DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.reviews'::regclass
      AND conname = 'reviews_organization_id_fkey'
  ) THEN
    ALTER TABLE ONLY "public"."reviews"
        ADD CONSTRAINT "reviews_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;
  END IF;
END
$baseline$;

DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.reviews'::regclass
      AND conname = 'reviews_project_id_fkey'
  ) THEN
    ALTER TABLE ONLY "public"."reviews"
        ADD CONSTRAINT "reviews_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE SET NULL;
  END IF;
END
$baseline$;

DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.reviews'::regclass
      AND conname = 'reviews_reviewer_user_id_fkey'
  ) THEN
    ALTER TABLE ONLY "public"."reviews"
        ADD CONSTRAINT "reviews_reviewer_user_id_fkey" FOREIGN KEY ("reviewer_user_id") REFERENCES "public"."user_profiles"("id") ON DELETE SET NULL;
  END IF;
END
$baseline$;

DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.transaction_data_rows'::regclass
      AND conname = 'transaction_data_rows_document_id_fkey'
  ) THEN
    ALTER TABLE ONLY "public"."transaction_data_rows"
        ADD CONSTRAINT "transaction_data_rows_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE CASCADE;
  END IF;
END
$baseline$;

DO $baseline$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.transaction_data_rows'::regclass
      AND conname = 'transaction_data_rows_project_id_fkey'
  ) THEN
    ALTER TABLE ONLY "public"."transaction_data_rows"
        DROP CONSTRAINT "transaction_data_rows_project_id_fkey";
  END IF;
END
$baseline$;

DO $baseline$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.transaction_data_rows'::regclass
      AND conname = 'transaction_data_rows_organization_id_fkey'
  ) THEN
    ALTER TABLE ONLY "public"."transaction_data_rows"
        DROP CONSTRAINT "transaction_data_rows_organization_id_fkey";
  END IF;
END
$baseline$;

DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.transaction_data_summaries'::regclass
      AND conname = 'transaction_data_summaries_document_id_fkey'
  ) THEN
    ALTER TABLE ONLY "public"."transaction_data_summaries"
        ADD CONSTRAINT "transaction_data_summaries_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE CASCADE;
  END IF;
END
$baseline$;

DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.user_profiles'::regclass
      AND conname = 'user_profiles_id_fkey'
  ) THEN
    ALTER TABLE ONLY "public"."user_profiles"
        ADD CONSTRAINT "user_profiles_id_fkey" FOREIGN KEY ("id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;
  END IF;
END
$baseline$;

DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.user_profiles'::regclass
      AND conname = 'user_profiles_organization_id_fkey'
  ) THEN
    ALTER TABLE ONLY "public"."user_profiles"
        ADD CONSTRAINT "user_profiles_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id");
  END IF;
END
$baseline$;

DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.workflow_events'::regclass
      AND conname = 'workflow_events_document_id_fkey'
  ) THEN
    ALTER TABLE ONLY "public"."workflow_events"
        ADD CONSTRAINT "workflow_events_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE SET NULL;
  END IF;
END
$baseline$;

DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.workflow_events'::regclass
      AND conname = 'workflow_events_organization_id_fkey'
  ) THEN
    ALTER TABLE ONLY "public"."workflow_events"
        ADD CONSTRAINT "workflow_events_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;
  END IF;
END
$baseline$;

DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.workflow_events'::regclass
      AND conname = 'workflow_events_rule_id_fkey'
  ) THEN
    ALTER TABLE ONLY "public"."workflow_events"
        ADD CONSTRAINT "workflow_events_rule_id_fkey" FOREIGN KEY ("rule_id") REFERENCES "public"."workflow_rules"("id") ON DELETE SET NULL;
  END IF;
END
$baseline$;

DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.workflow_rules'::regclass
      AND conname = 'workflow_rules_organization_id_fkey'
  ) THEN
    ALTER TABLE ONLY "public"."workflow_rules"
        ADD CONSTRAINT "workflow_rules_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;
  END IF;
END
$baseline$;

DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.workflow_task_events'::regclass
      AND conname = 'workflow_task_events_organization_id_fkey'
  ) THEN
    ALTER TABLE ONLY "public"."workflow_task_events"
        ADD CONSTRAINT "workflow_task_events_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;
  END IF;
END
$baseline$;

DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.workflow_task_events'::regclass
      AND conname = 'workflow_task_events_workflow_task_id_fkey'
  ) THEN
    ALTER TABLE ONLY "public"."workflow_task_events"
        ADD CONSTRAINT "workflow_task_events_workflow_task_id_fkey" FOREIGN KEY ("workflow_task_id") REFERENCES "public"."workflow_tasks"("id") ON DELETE CASCADE;
  END IF;
END
$baseline$;

DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.workflow_tasks'::regclass
      AND conname = 'workflow_tasks_assigned_by_fkey'
  ) THEN
    ALTER TABLE ONLY "public"."workflow_tasks"
        ADD CONSTRAINT "workflow_tasks_assigned_by_fkey" FOREIGN KEY ("assigned_by") REFERENCES "public"."user_profiles"("id") ON DELETE SET NULL;
  END IF;
END
$baseline$;

DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.workflow_tasks'::regclass
      AND conname = 'workflow_tasks_assigned_to_fkey'
  ) THEN
    ALTER TABLE ONLY "public"."workflow_tasks"
        ADD CONSTRAINT "workflow_tasks_assigned_to_fkey" FOREIGN KEY ("assigned_to") REFERENCES "public"."user_profiles"("id");
  END IF;
END
$baseline$;

DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.workflow_tasks'::regclass
      AND conname = 'workflow_tasks_decision_id_fkey'
  ) THEN
    ALTER TABLE ONLY "public"."workflow_tasks"
        ADD CONSTRAINT "workflow_tasks_decision_id_fkey" FOREIGN KEY ("decision_id") REFERENCES "public"."decisions"("id") ON DELETE SET NULL;
  END IF;
END
$baseline$;

DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.workflow_tasks'::regclass
      AND conname = 'workflow_tasks_document_id_fkey'
  ) THEN
    ALTER TABLE ONLY "public"."workflow_tasks"
        ADD CONSTRAINT "workflow_tasks_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE SET NULL;
  END IF;
END
$baseline$;

DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.workflow_tasks'::regclass
      AND conname = 'workflow_tasks_organization_id_fkey'
  ) THEN
    ALTER TABLE ONLY "public"."workflow_tasks"
        ADD CONSTRAINT "workflow_tasks_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;
  END IF;
END
$baseline$;

DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.workflow_tasks'::regclass
      AND conname = 'workflow_tasks_project_id_fkey'
  ) THEN
    ALTER TABLE ONLY "public"."workflow_tasks"
        ADD CONSTRAINT "workflow_tasks_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id");
  END IF;
END
$baseline$;

DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.workflow_templates'::regclass
      AND conname = 'workflow_templates_default_assignee_fkey'
  ) THEN
    ALTER TABLE ONLY "public"."workflow_templates"
        ADD CONSTRAINT "workflow_templates_default_assignee_fkey" FOREIGN KEY ("default_assignee") REFERENCES "public"."user_profiles"("id");
  END IF;
END
$baseline$;

DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.workflow_templates'::regclass
      AND conname = 'workflow_templates_organization_id_fkey'
  ) THEN
    ALTER TABLE ONLY "public"."workflow_templates"
        ADD CONSTRAINT "workflow_templates_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE;
  END IF;
END
$baseline$;

DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.workflows'::regclass
      AND conname = 'workflows_organization_id_fkey'
  ) THEN
    ALTER TABLE ONLY "public"."workflows"
        ADD CONSTRAINT "workflows_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id");
  END IF;
END
$baseline$;

DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.decision_feedback'::regclass
      AND conname = 'decision_feedback_decision_id_reviewer_id_key'
  ) THEN
    ALTER TABLE ONLY "public"."decision_feedback"
        ADD CONSTRAINT "decision_feedback_decision_id_reviewer_id_key" UNIQUE ("decision_id", "reviewer_id");
  END IF;
END
$baseline$;

DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.document_decisions'::regclass
      AND conname = 'uq_document_decisions_doc_type_value'
  ) THEN
    ALTER TABLE ONLY "public"."document_decisions"
        ADD CONSTRAINT "uq_document_decisions_doc_type_value" UNIQUE ("document_id", "decision_type", "decision_value");
  END IF;
END
$baseline$;

DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.projects'::regclass
      AND conname = 'projects_org_code_unique'
  ) THEN
    ALTER TABLE ONLY "public"."projects"
        ADD CONSTRAINT "projects_org_code_unique" UNIQUE ("organization_id", "code");
  END IF;
END
$baseline$;

DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.transaction_data_summaries'::regclass
      AND conname = 'transaction_data_summaries_document_id_key'
  ) THEN
    ALTER TABLE ONLY "public"."transaction_data_summaries"
        ADD CONSTRAINT "transaction_data_summaries_document_id_key" UNIQUE ("document_id");
  END IF;
END
$baseline$;

-- Standalone indexes

CREATE INDEX IF NOT EXISTS "activity_events_changed_by_idx" ON "public"."activity_events" USING "btree" ("changed_by");

CREATE INDEX IF NOT EXISTS "activity_events_entity_idx" ON "public"."activity_events" USING "btree" ("entity_type", "entity_id", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "activity_events_org_entity_idx" ON "public"."activity_events" USING "btree" ("organization_id", "entity_type", "entity_id", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "activity_events_org_idx" ON "public"."activity_events" USING "btree" ("organization_id");

CREATE INDEX IF NOT EXISTS "idx_activity_events_lookup" ON "public"."activity_events" USING "btree" ("organization_id", "entity_type", "entity_id", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "idx_activity_events_org_created" ON "public"."activity_events" USING "btree" ("organization_id", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "idx_activity_events_validation" ON "public"."activity_events" USING "btree" ("entity_type", "entity_id", "project_id", "created_at");

CREATE UNIQUE INDEX IF NOT EXISTS "decision_rules_org_rule_key_uidx" ON "public"."decision_rules" USING "btree" ("organization_id", "rule_key");

CREATE INDEX IF NOT EXISTS "decisions_assigned_to_idx" ON "public"."decisions" USING "btree" ("assigned_to");

CREATE INDEX IF NOT EXISTS "decisions_document_idx" ON "public"."decisions" USING "btree" ("document_id");

CREATE INDEX IF NOT EXISTS "decisions_due_at_idx" ON "public"."decisions" USING "btree" ("due_at");

CREATE INDEX IF NOT EXISTS "decisions_org_assigned_idx" ON "public"."decisions" USING "btree" ("organization_id", "assigned_to");

CREATE INDEX IF NOT EXISTS "decisions_org_due_at_idx" ON "public"."decisions" USING "btree" ("organization_id", "due_at");

CREATE INDEX IF NOT EXISTS "decisions_org_idx" ON "public"."decisions" USING "btree" ("organization_id");

CREATE INDEX IF NOT EXISTS "idx_decision_feedback_decision_id" ON "public"."decision_feedback" USING "btree" ("decision_id");

CREATE INDEX IF NOT EXISTS "idx_decision_feedback_org_created_at" ON "public"."decision_feedback" USING "btree" ("organization_id", "created_at");

CREATE INDEX IF NOT EXISTS "idx_decision_rules_org" ON "public"."decision_rules" USING "btree" ("organization_id");

CREATE INDEX IF NOT EXISTS "idx_decisions_assigned_to" ON "public"."decisions" USING "btree" ("assigned_to") WHERE ("assigned_to" IS NOT NULL);

CREATE INDEX IF NOT EXISTS "idx_decisions_org_document_status" ON "public"."decisions" USING "btree" ("organization_id", "document_id", "status");

CREATE INDEX IF NOT EXISTS "idx_decisions_org_status_severity" ON "public"."decisions" USING "btree" ("organization_id", "status", "severity");

CREATE INDEX IF NOT EXISTS "idx_decisions_project_id" ON "public"."decisions" USING "btree" ("project_id") WHERE ("project_id" IS NOT NULL);

CREATE INDEX IF NOT EXISTS "idx_decisions_rule_id" ON "public"."decisions" USING "btree" ("decision_rule_id");

CREATE INDEX IF NOT EXISTS "idx_document_decisions_document_id" ON "public"."document_decisions" USING "btree" ("document_id");

CREATE INDEX IF NOT EXISTS "idx_document_decisions_org_type" ON "public"."document_decisions" USING "btree" ("organization_id", "decision_type");

CREATE INDEX IF NOT EXISTS "idx_document_extractions_document_id" ON "public"."document_extractions" USING "btree" ("document_id");

CREATE INDEX IF NOT EXISTS "idx_document_extractions_field_key" ON "public"."document_extractions" USING "btree" ("field_key");

CREATE INDEX IF NOT EXISTS "idx_document_extractions_org_doc" ON "public"."document_extractions" USING "btree" ("organization_id", "document_id", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "idx_document_extractions_organization_id" ON "public"."document_extractions" USING "btree" ("organization_id");

CREATE INDEX IF NOT EXISTS "idx_documents_active_by_organization_created_at" ON "public"."documents" USING "btree" ("organization_id", "created_at" DESC) WHERE ("deleted_at" IS NULL);

CREATE INDEX IF NOT EXISTS "idx_documents_active_by_project_created_at" ON "public"."documents" USING "btree" ("project_id", "created_at" DESC) WHERE (("deleted_at" IS NULL) AND ("project_id" IS NOT NULL));

CREATE INDEX IF NOT EXISTS "idx_documents_org_created" ON "public"."documents" USING "btree" ("organization_id", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "idx_documents_status" ON "public"."documents" USING "btree" ("processing_status");

CREATE INDEX IF NOT EXISTS "idx_extractions_document_created" ON "public"."document_extractions" USING "btree" ("document_id", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "idx_issues_document_id" ON "public"."issues" USING "btree" ("document_id");

CREATE INDEX IF NOT EXISTS "idx_issues_organization_id" ON "public"."issues" USING "btree" ("organization_id");

CREATE INDEX IF NOT EXISTS "idx_issues_project_id" ON "public"."issues" USING "btree" ("project_id");

CREATE INDEX IF NOT EXISTS "idx_issues_review_id" ON "public"."issues" USING "btree" ("review_id");

CREATE INDEX IF NOT EXISTS "idx_issues_workflow_id" ON "public"."issues" USING "btree" ("workflow_id");

CREATE INDEX IF NOT EXISTS "idx_projects_organization_id" ON "public"."projects" USING "btree" ("organization_id");

CREATE INDEX IF NOT EXISTS "idx_reviews_document_id" ON "public"."reviews" USING "btree" ("document_id");

CREATE INDEX IF NOT EXISTS "idx_reviews_organization_id" ON "public"."reviews" USING "btree" ("organization_id");

CREATE INDEX IF NOT EXISTS "idx_reviews_project_id" ON "public"."reviews" USING "btree" ("project_id");

CREATE INDEX IF NOT EXISTS "idx_rules_scope" ON "public"."rules" USING "btree" ("organization_id", "domain", "document_type", "status", "priority");

CREATE INDEX IF NOT EXISTS "idx_transaction_data_summaries_org" ON "public"."transaction_data_summaries" USING "btree" ("organization_id");

CREATE INDEX IF NOT EXISTS "idx_transaction_data_summaries_project" ON "public"."transaction_data_summaries" USING "btree" ("project_id");

CREATE INDEX IF NOT EXISTS "idx_transaction_data_rows_document" ON "public"."transaction_data_rows" USING "btree" ("document_id");

CREATE INDEX IF NOT EXISTS "idx_transaction_data_rows_invoice_number" ON "public"."transaction_data_rows" USING "btree" ("invoice_number");

CREATE INDEX IF NOT EXISTS "idx_transaction_data_rows_org" ON "public"."transaction_data_rows" USING "btree" ("organization_id");

CREATE INDEX IF NOT EXISTS "idx_transaction_data_rows_project" ON "public"."transaction_data_rows" USING "btree" ("project_id");

CREATE INDEX IF NOT EXISTS "idx_transaction_data_rows_rate_code" ON "public"."transaction_data_rows" USING "btree" ("rate_code");

CREATE INDEX IF NOT EXISTS "idx_workflow_tasks_assigned_to" ON "public"."workflow_tasks" USING "btree" ("assigned_to") WHERE ("assigned_to" IS NOT NULL);

CREATE INDEX IF NOT EXISTS "idx_workflow_tasks_decision_status" ON "public"."workflow_tasks" USING "btree" ("decision_id", "status");

CREATE INDEX IF NOT EXISTS "idx_workflow_tasks_org_status" ON "public"."workflow_tasks" USING "btree" ("organization_id", "status");

CREATE INDEX IF NOT EXISTS "idx_workflow_tasks_org_status_priority" ON "public"."workflow_tasks" USING "btree" ("organization_id", "status", "priority", "due_at");

CREATE INDEX IF NOT EXISTS "idx_workflow_tasks_project_id" ON "public"."workflow_tasks" USING "btree" ("project_id") WHERE ("project_id" IS NOT NULL);

CREATE UNIQUE INDEX IF NOT EXISTS "uniq_decisions_doc_rule_open" ON "public"."decisions" USING "btree" ("document_id", "rule_key") WHERE ("status" = 'open'::"text");

CREATE INDEX IF NOT EXISTS "workflow_task_events_created_at_idx" ON "public"."workflow_task_events" USING "btree" ("created_at" DESC);

CREATE INDEX IF NOT EXISTS "workflow_task_events_metadata_gin_idx" ON "public"."workflow_task_events" USING "gin" ("metadata");

CREATE INDEX IF NOT EXISTS "workflow_task_events_org_idx" ON "public"."workflow_task_events" USING "btree" ("organization_id");

CREATE INDEX IF NOT EXISTS "workflow_task_events_task_idx" ON "public"."workflow_task_events" USING "btree" ("workflow_task_id");

CREATE INDEX IF NOT EXISTS "workflow_tasks_assigned_to_idx" ON "public"."workflow_tasks" USING "btree" ("assigned_to");

CREATE INDEX IF NOT EXISTS "workflow_tasks_decision_idx" ON "public"."workflow_tasks" USING "btree" ("decision_id");

CREATE INDEX IF NOT EXISTS "workflow_tasks_details_gin_idx" ON "public"."workflow_tasks" USING "gin" ("details");

CREATE INDEX IF NOT EXISTS "workflow_tasks_document_idx" ON "public"."workflow_tasks" USING "btree" ("document_id");

CREATE INDEX IF NOT EXISTS "workflow_tasks_due_at_idx" ON "public"."workflow_tasks" USING "btree" ("due_at");

CREATE INDEX IF NOT EXISTS "workflow_tasks_org_assigned_idx" ON "public"."workflow_tasks" USING "btree" ("organization_id", "assigned_to");

CREATE INDEX IF NOT EXISTS "workflow_tasks_org_created_at_idx" ON "public"."workflow_tasks" USING "btree" ("organization_id", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "workflow_tasks_org_due_at_idx" ON "public"."workflow_tasks" USING "btree" ("organization_id", "due_at");

CREATE INDEX IF NOT EXISTS "workflow_tasks_org_idx" ON "public"."workflow_tasks" USING "btree" ("organization_id");

CREATE INDEX IF NOT EXISTS "workflow_tasks_org_priority_idx" ON "public"."workflow_tasks" USING "btree" ("organization_id", "priority");

CREATE INDEX IF NOT EXISTS "workflow_tasks_org_status_idx" ON "public"."workflow_tasks" USING "btree" ("organization_id", "status");

CREATE INDEX IF NOT EXISTS "workflow_tasks_source_metadata_gin_idx" ON "public"."workflow_tasks" USING "gin" ("source_metadata");

-- Row-level security

ALTER TABLE "public"."organizations" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."user_profiles" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."activity_events" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."projects" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."documents" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."decision_rules" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."rules" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."decisions" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."decision_feedback" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."decision_policies" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."document_analysis_jobs" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."document_decisions" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."document_extractions" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."issues" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."project_rule_overrides" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."reviews" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."transaction_data_rows" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."transaction_data_summaries" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."workflow_rules" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."workflow_events" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."workflow_tasks" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."workflow_task_events" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."workflow_templates" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."workflows" ENABLE ROW LEVEL SECURITY;

-- Policies

DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'activity_events'
      AND policyname = 'activity_events_select_org'
  ) THEN
    CREATE POLICY "activity_events_select_org" ON "public"."activity_events" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
       FROM "public"."user_profiles" "up"
      WHERE (("up"."id" = "auth"."uid"()) AND ("up"."organization_id" = "activity_events"."organization_id")))));
  END IF;
END
$baseline$;

DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'organizations'
      AND policyname = 'Allow all for now'
  ) THEN
    CREATE POLICY "Allow all for now" ON "public"."organizations" USING (true) WITH CHECK (true);
  END IF;
END
$baseline$;

DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'transaction_data_rows'
      AND policyname = 'Allow all for now'
  ) THEN
    CREATE POLICY "Allow all for now" ON "public"."transaction_data_rows" USING (true) WITH CHECK (true);
  END IF;
END
$baseline$;

DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'transaction_data_rows'
      AND policyname = 'transaction_data_rows_select_authenticated'
  ) THEN
    CREATE POLICY "transaction_data_rows_select_authenticated"
      ON "public"."transaction_data_rows"
      FOR SELECT TO "authenticated"
      USING ((EXISTS ( SELECT 1
       FROM "public"."projects" "p"
      WHERE (("p"."id" = "transaction_data_rows"."project_id") AND ("p"."organization_id" = "public"."get_current_user_org_id"())))));
  END IF;
END
$baseline$;

DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'transaction_data_summaries'
      AND policyname = 'Allow all for now'
  ) THEN
    CREATE POLICY "Allow all for now" ON "public"."transaction_data_summaries" USING (true) WITH CHECK (true);
  END IF;
END
$baseline$;

DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'decision_feedback'
      AND policyname = 'Users can manage their org feedback'
  ) THEN
    CREATE POLICY "Users can manage their org feedback" ON "public"."decision_feedback" USING (("organization_id" IN ( SELECT "user_profiles"."organization_id"
       FROM "public"."user_profiles"
      WHERE ("user_profiles"."id" = "auth"."uid"()))));
  END IF;
END
$baseline$;

DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'document_decisions'
      AND policyname = 'Users can view their org decisions'
  ) THEN
    CREATE POLICY "Users can view their org decisions" ON "public"."document_decisions" FOR SELECT USING (("organization_id" IN ( SELECT "user_profiles"."organization_id"
       FROM "public"."user_profiles"
      WHERE ("user_profiles"."id" = "auth"."uid"()))));
  END IF;
END
$baseline$;

DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'workflow_events'
      AND policyname = 'Users can view their org events'
  ) THEN
    CREATE POLICY "Users can view their org events" ON "public"."workflow_events" FOR SELECT USING (("organization_id" IN ( SELECT "user_profiles"."organization_id"
       FROM "public"."user_profiles"
      WHERE ("user_profiles"."id" = "auth"."uid"()))));
  END IF;
END
$baseline$;

DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'document_analysis_jobs'
      AND policyname = 'Users can view their org jobs'
  ) THEN
    CREATE POLICY "Users can view their org jobs" ON "public"."document_analysis_jobs" FOR SELECT USING (("organization_id" IN ( SELECT "user_profiles"."organization_id"
       FROM "public"."user_profiles"
      WHERE ("user_profiles"."id" = "auth"."uid"()))));
  END IF;
END
$baseline$;

DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'workflow_rules'
      AND policyname = 'Users can view their org rules'
  ) THEN
    CREATE POLICY "Users can view their org rules" ON "public"."workflow_rules" FOR SELECT USING (("organization_id" IN ( SELECT "user_profiles"."organization_id"
       FROM "public"."user_profiles"
      WHERE ("user_profiles"."id" = "auth"."uid"()))));
  END IF;
END
$baseline$;

DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'decision_feedback'
      AND policyname = 'decision_feedback_insert_org'
  ) THEN
    CREATE POLICY "decision_feedback_insert_org" ON "public"."decision_feedback" FOR INSERT TO "authenticated" WITH CHECK ((EXISTS ( SELECT 1
       FROM "public"."user_profiles" "up"
      WHERE (("up"."id" = "auth"."uid"()) AND ("up"."organization_id" = "decision_feedback"."organization_id")))));
  END IF;
END
$baseline$;

DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'decision_policies'
      AND policyname = 'decision_policies_delete_org'
  ) THEN
    CREATE POLICY "decision_policies_delete_org" ON "public"."decision_policies" FOR DELETE TO "authenticated" USING (("organization_id" = ( SELECT "up"."organization_id"
       FROM "public"."user_profiles" "up"
      WHERE ("up"."id" = "auth"."uid"()))));
  END IF;
END
$baseline$;

DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'decision_policies'
      AND policyname = 'decision_policies_insert_org'
  ) THEN
    CREATE POLICY "decision_policies_insert_org" ON "public"."decision_policies" FOR INSERT TO "authenticated" WITH CHECK (("organization_id" = ( SELECT "up"."organization_id"
       FROM "public"."user_profiles" "up"
      WHERE ("up"."id" = "auth"."uid"()))));
  END IF;
END
$baseline$;

DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'decision_policies'
      AND policyname = 'decision_policies_select_org'
  ) THEN
    CREATE POLICY "decision_policies_select_org" ON "public"."decision_policies" FOR SELECT TO "authenticated" USING ((("organization_id" IS NULL) OR ("organization_id" = ( SELECT "up"."organization_id"
       FROM "public"."user_profiles" "up"
      WHERE ("up"."id" = "auth"."uid"())))));
  END IF;
END
$baseline$;

DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'decision_policies'
      AND policyname = 'decision_policies_update_org'
  ) THEN
    CREATE POLICY "decision_policies_update_org" ON "public"."decision_policies" FOR UPDATE TO "authenticated" USING (("organization_id" = ( SELECT "up"."organization_id"
       FROM "public"."user_profiles" "up"
      WHERE ("up"."id" = "auth"."uid"())))) WITH CHECK (("organization_id" = ( SELECT "up"."organization_id"
       FROM "public"."user_profiles" "up"
      WHERE ("up"."id" = "auth"."uid"()))));
  END IF;
END
$baseline$;

DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'decision_rules'
      AND policyname = 'decision_rules_delete_org'
  ) THEN
    CREATE POLICY "decision_rules_delete_org" ON "public"."decision_rules" FOR DELETE TO "authenticated" USING (("organization_id" = ( SELECT "up"."organization_id"
       FROM "public"."user_profiles" "up"
      WHERE ("up"."id" = "auth"."uid"()))));
  END IF;
END
$baseline$;

DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'decision_rules'
      AND policyname = 'decision_rules_insert_org'
  ) THEN
    CREATE POLICY "decision_rules_insert_org" ON "public"."decision_rules" FOR INSERT TO "authenticated" WITH CHECK (("organization_id" = ( SELECT "up"."organization_id"
       FROM "public"."user_profiles" "up"
      WHERE ("up"."id" = "auth"."uid"()))));
  END IF;
END
$baseline$;

DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'decision_rules'
      AND policyname = 'decision_rules_select_org'
  ) THEN
    CREATE POLICY "decision_rules_select_org" ON "public"."decision_rules" FOR SELECT TO "authenticated" USING (("organization_id" = ( SELECT "up"."organization_id"
       FROM "public"."user_profiles" "up"
      WHERE ("up"."id" = "auth"."uid"()))));
  END IF;
END
$baseline$;

DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'decision_rules'
      AND policyname = 'decision_rules_update_org'
  ) THEN
    CREATE POLICY "decision_rules_update_org" ON "public"."decision_rules" FOR UPDATE TO "authenticated" USING (("organization_id" = ( SELECT "up"."organization_id"
       FROM "public"."user_profiles" "up"
      WHERE ("up"."id" = "auth"."uid"())))) WITH CHECK (("organization_id" = ( SELECT "up"."organization_id"
       FROM "public"."user_profiles" "up"
      WHERE ("up"."id" = "auth"."uid"()))));
  END IF;
END
$baseline$;

DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'decisions'
      AND policyname = 'decisions_delete_org'
  ) THEN
    CREATE POLICY "decisions_delete_org" ON "public"."decisions" FOR DELETE USING ((EXISTS ( SELECT 1
       FROM "public"."user_profiles" "up"
      WHERE (("up"."id" = "auth"."uid"()) AND ("up"."organization_id" = "decisions"."organization_id")))));
  END IF;
END
$baseline$;

DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'decisions'
      AND policyname = 'decisions_insert_org'
  ) THEN
    CREATE POLICY "decisions_insert_org" ON "public"."decisions" FOR INSERT TO "authenticated" WITH CHECK ((EXISTS ( SELECT 1
       FROM "public"."user_profiles" "up"
      WHERE (("up"."id" = "auth"."uid"()) AND ("up"."organization_id" = "decisions"."organization_id")))));
  END IF;
END
$baseline$;

DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'decisions'
      AND policyname = 'decisions_select_org'
  ) THEN
    CREATE POLICY "decisions_select_org" ON "public"."decisions" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
       FROM "public"."user_profiles" "up"
      WHERE (("up"."id" = "auth"."uid"()) AND ("up"."organization_id" = "decisions"."organization_id")))));
  END IF;
END
$baseline$;

DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'decisions'
      AND policyname = 'decisions_update_org'
  ) THEN
    CREATE POLICY "decisions_update_org" ON "public"."decisions" FOR UPDATE TO "authenticated" USING ((EXISTS ( SELECT 1
       FROM "public"."user_profiles" "up"
      WHERE (("up"."id" = "auth"."uid"()) AND ("up"."organization_id" = "decisions"."organization_id"))))) WITH CHECK ((EXISTS ( SELECT 1
       FROM "public"."user_profiles" "up"
      WHERE (("up"."id" = "auth"."uid"()) AND ("up"."organization_id" = "decisions"."organization_id")))));
  END IF;
END
$baseline$;

DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'document_extractions'
      AND policyname = 'document_extractions_insert_org'
  ) THEN
    CREATE POLICY "document_extractions_insert_org" ON "public"."document_extractions" FOR INSERT WITH CHECK (("organization_id" = ( SELECT "up"."organization_id"
       FROM "public"."user_profiles" "up"
      WHERE ("up"."id" = "auth"."uid"()))));
  END IF;
END
$baseline$;

DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'document_extractions'
      AND policyname = 'document_extractions_select_org'
  ) THEN
    CREATE POLICY "document_extractions_select_org" ON "public"."document_extractions" FOR SELECT USING ((("organization_id" = ( SELECT "up"."organization_id"
       FROM "public"."user_profiles" "up"
      WHERE ("up"."id" = "auth"."uid"()))) OR (("organization_id" IS NULL) AND (EXISTS ( SELECT 1
       FROM ("public"."documents" "d"
         JOIN "public"."user_profiles" "up" ON (("up"."organization_id" = "d"."organization_id")))
      WHERE (("d"."id" = "document_extractions"."document_id") AND ("up"."id" = "auth"."uid"())))))));
  END IF;
END
$baseline$;

DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'document_extractions'
      AND policyname = 'document_extractions_update_org'
  ) THEN
    CREATE POLICY "document_extractions_update_org" ON "public"."document_extractions" FOR UPDATE USING (("organization_id" = ( SELECT "up"."organization_id"
       FROM "public"."user_profiles" "up"
      WHERE ("up"."id" = "auth"."uid"())))) WITH CHECK (("organization_id" = ( SELECT "up"."organization_id"
       FROM "public"."user_profiles" "up"
      WHERE ("up"."id" = "auth"."uid"()))));
  END IF;
END
$baseline$;

DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'issues'
      AND policyname = 'issues_delete_by_org'
  ) THEN
    CREATE POLICY "issues_delete_by_org" ON "public"."issues" FOR DELETE TO "authenticated" USING (("organization_id" IN ( SELECT "user_profiles"."organization_id"
       FROM "public"."user_profiles"
      WHERE ("user_profiles"."id" = "auth"."uid"()))));
  END IF;
END
$baseline$;

DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'issues'
      AND policyname = 'issues_insert_by_org'
  ) THEN
    CREATE POLICY "issues_insert_by_org" ON "public"."issues" FOR INSERT TO "authenticated" WITH CHECK (("organization_id" IN ( SELECT "user_profiles"."organization_id"
       FROM "public"."user_profiles"
      WHERE ("user_profiles"."id" = "auth"."uid"()))));
  END IF;
END
$baseline$;

DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'issues'
      AND policyname = 'issues_select_by_org'
  ) THEN
    CREATE POLICY "issues_select_by_org" ON "public"."issues" FOR SELECT TO "authenticated" USING (("organization_id" IN ( SELECT "user_profiles"."organization_id"
       FROM "public"."user_profiles"
      WHERE ("user_profiles"."id" = "auth"."uid"()))));
  END IF;
END
$baseline$;

DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'issues'
      AND policyname = 'issues_update_by_org'
  ) THEN
    CREATE POLICY "issues_update_by_org" ON "public"."issues" FOR UPDATE TO "authenticated" USING (("organization_id" IN ( SELECT "user_profiles"."organization_id"
       FROM "public"."user_profiles"
      WHERE ("user_profiles"."id" = "auth"."uid"())))) WITH CHECK (("organization_id" IN ( SELECT "user_profiles"."organization_id"
       FROM "public"."user_profiles"
      WHERE ("user_profiles"."id" = "auth"."uid"()))));
  END IF;
END
$baseline$;

DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'documents'
      AND policyname = 'org_delete_documents'
  ) THEN
    CREATE POLICY "org_delete_documents" ON "public"."documents" FOR DELETE TO "authenticated" USING (("organization_id" = ( SELECT "user_profiles"."organization_id"
       FROM "public"."user_profiles"
      WHERE ("user_profiles"."id" = "auth"."uid"()))));
  END IF;
END
$baseline$;

DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'documents'
      AND policyname = 'org_insert_documents'
  ) THEN
    CREATE POLICY "org_insert_documents" ON "public"."documents" FOR INSERT TO "authenticated" WITH CHECK (("organization_id" = ( SELECT "user_profiles"."organization_id"
       FROM "public"."user_profiles"
      WHERE ("user_profiles"."id" = "auth"."uid"()))));
  END IF;
END
$baseline$;

DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'documents'
      AND policyname = 'org_read_documents'
  ) THEN
    CREATE POLICY "org_read_documents" ON "public"."documents" FOR SELECT TO "authenticated" USING (("organization_id" = ( SELECT "user_profiles"."organization_id"
       FROM "public"."user_profiles"
      WHERE ("user_profiles"."id" = "auth"."uid"()))));
  END IF;
END
$baseline$;

DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'documents'
      AND policyname = 'org_update_documents'
  ) THEN
    CREATE POLICY "org_update_documents" ON "public"."documents" FOR UPDATE TO "authenticated" USING (("organization_id" = ( SELECT "user_profiles"."organization_id"
       FROM "public"."user_profiles"
      WHERE ("user_profiles"."id" = "auth"."uid"())))) WITH CHECK (("organization_id" = ( SELECT "user_profiles"."organization_id"
       FROM "public"."user_profiles"
      WHERE ("user_profiles"."id" = "auth"."uid"()))));
  END IF;
END
$baseline$;

DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'project_rule_overrides'
      AND policyname = 'project_rule_overrides_delete_org'
  ) THEN
    CREATE POLICY "project_rule_overrides_delete_org" ON "public"."project_rule_overrides" FOR DELETE TO "authenticated" USING ((("project_id" IS NOT NULL) AND (EXISTS ( SELECT 1
       FROM ("public"."projects" "p"
         JOIN "public"."user_profiles" "up" ON (("up"."organization_id" = "p"."organization_id")))
      WHERE (("p"."id" = "project_rule_overrides"."project_id") AND ("up"."id" = "auth"."uid"()))))));
  END IF;
END
$baseline$;

DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'project_rule_overrides'
      AND policyname = 'project_rule_overrides_insert_org'
  ) THEN
    CREATE POLICY "project_rule_overrides_insert_org" ON "public"."project_rule_overrides" FOR INSERT TO "authenticated" WITH CHECK ((("project_id" IS NOT NULL) AND (EXISTS ( SELECT 1
       FROM ("public"."projects" "p"
         JOIN "public"."user_profiles" "up" ON (("up"."organization_id" = "p"."organization_id")))
      WHERE (("p"."id" = "project_rule_overrides"."project_id") AND ("up"."id" = "auth"."uid"()))))));
  END IF;
END
$baseline$;

DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'project_rule_overrides'
      AND policyname = 'project_rule_overrides_select_org'
  ) THEN
    CREATE POLICY "project_rule_overrides_select_org" ON "public"."project_rule_overrides" FOR SELECT TO "authenticated" USING ((("project_id" IS NOT NULL) AND (EXISTS ( SELECT 1
       FROM ("public"."projects" "p"
         JOIN "public"."user_profiles" "up" ON (("up"."organization_id" = "p"."organization_id")))
      WHERE (("p"."id" = "project_rule_overrides"."project_id") AND ("up"."id" = "auth"."uid"()))))));
  END IF;
END
$baseline$;

DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'project_rule_overrides'
      AND policyname = 'project_rule_overrides_update_org'
  ) THEN
    CREATE POLICY "project_rule_overrides_update_org" ON "public"."project_rule_overrides" FOR UPDATE TO "authenticated" USING ((("project_id" IS NOT NULL) AND (EXISTS ( SELECT 1
       FROM ("public"."projects" "p"
         JOIN "public"."user_profiles" "up" ON (("up"."organization_id" = "p"."organization_id")))
      WHERE (("p"."id" = "project_rule_overrides"."project_id") AND ("up"."id" = "auth"."uid"())))))) WITH CHECK ((("project_id" IS NOT NULL) AND (EXISTS ( SELECT 1
       FROM ("public"."projects" "p"
         JOIN "public"."user_profiles" "up" ON (("up"."organization_id" = "p"."organization_id")))
      WHERE (("p"."id" = "project_rule_overrides"."project_id") AND ("up"."id" = "auth"."uid"()))))));
  END IF;
END
$baseline$;

DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'projects'
      AND policyname = 'projects_delete_by_org'
  ) THEN
    CREATE POLICY "projects_delete_by_org" ON "public"."projects" FOR DELETE TO "authenticated" USING (("organization_id" IN ( SELECT "user_profiles"."organization_id"
       FROM "public"."user_profiles"
      WHERE ("user_profiles"."id" = "auth"."uid"()))));
  END IF;
END
$baseline$;

DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'projects'
      AND policyname = 'projects_insert_by_org'
  ) THEN
    CREATE POLICY "projects_insert_by_org" ON "public"."projects" FOR INSERT TO "authenticated" WITH CHECK (("organization_id" IN ( SELECT "user_profiles"."organization_id"
       FROM "public"."user_profiles"
      WHERE ("user_profiles"."id" = "auth"."uid"()))));
  END IF;
END
$baseline$;

DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'projects'
      AND policyname = 'projects_select_by_org'
  ) THEN
    CREATE POLICY "projects_select_by_org" ON "public"."projects" FOR SELECT TO "authenticated" USING (("organization_id" IN ( SELECT "user_profiles"."organization_id"
       FROM "public"."user_profiles"
      WHERE ("user_profiles"."id" = "auth"."uid"()))));
  END IF;
END
$baseline$;

DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'projects'
      AND policyname = 'projects_update_by_org'
  ) THEN
    CREATE POLICY "projects_update_by_org" ON "public"."projects" FOR UPDATE TO "authenticated" USING (("organization_id" IN ( SELECT "user_profiles"."organization_id"
       FROM "public"."user_profiles"
      WHERE ("user_profiles"."id" = "auth"."uid"())))) WITH CHECK (("organization_id" IN ( SELECT "user_profiles"."organization_id"
       FROM "public"."user_profiles"
      WHERE ("user_profiles"."id" = "auth"."uid"()))));
  END IF;
END
$baseline$;

DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'reviews'
      AND policyname = 'reviews_delete_by_org'
  ) THEN
    CREATE POLICY "reviews_delete_by_org" ON "public"."reviews" FOR DELETE TO "authenticated" USING (("organization_id" IN ( SELECT "user_profiles"."organization_id"
       FROM "public"."user_profiles"
      WHERE ("user_profiles"."id" = "auth"."uid"()))));
  END IF;
END
$baseline$;

DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'reviews'
      AND policyname = 'reviews_insert_by_org'
  ) THEN
    CREATE POLICY "reviews_insert_by_org" ON "public"."reviews" FOR INSERT TO "authenticated" WITH CHECK (("organization_id" IN ( SELECT "user_profiles"."organization_id"
       FROM "public"."user_profiles"
      WHERE ("user_profiles"."id" = "auth"."uid"()))));
  END IF;
END
$baseline$;

DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'reviews'
      AND policyname = 'reviews_select_by_org'
  ) THEN
    CREATE POLICY "reviews_select_by_org" ON "public"."reviews" FOR SELECT TO "authenticated" USING (("organization_id" IN ( SELECT "user_profiles"."organization_id"
       FROM "public"."user_profiles"
      WHERE ("user_profiles"."id" = "auth"."uid"()))));
  END IF;
END
$baseline$;

DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'reviews'
      AND policyname = 'reviews_update_by_org'
  ) THEN
    CREATE POLICY "reviews_update_by_org" ON "public"."reviews" FOR UPDATE TO "authenticated" USING (("organization_id" IN ( SELECT "user_profiles"."organization_id"
       FROM "public"."user_profiles"
      WHERE ("user_profiles"."id" = "auth"."uid"())))) WITH CHECK (("organization_id" IN ( SELECT "user_profiles"."organization_id"
       FROM "public"."user_profiles"
      WHERE ("user_profiles"."id" = "auth"."uid"()))));
  END IF;
END
$baseline$;

DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'rules'
      AND policyname = 'rules_delete_org'
  ) THEN
    CREATE POLICY "rules_delete_org" ON "public"."rules" FOR DELETE USING (("organization_id" = ( SELECT "up"."organization_id"
       FROM "public"."user_profiles" "up"
      WHERE ("up"."id" = "auth"."uid"()))));
  END IF;
END
$baseline$;

DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'rules'
      AND policyname = 'rules_insert_org'
  ) THEN
    CREATE POLICY "rules_insert_org" ON "public"."rules" FOR INSERT WITH CHECK (("organization_id" = ( SELECT "up"."organization_id"
       FROM "public"."user_profiles" "up"
      WHERE ("up"."id" = "auth"."uid"()))));
  END IF;
END
$baseline$;

DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'rules'
      AND policyname = 'rules_select_org'
  ) THEN
    CREATE POLICY "rules_select_org" ON "public"."rules" FOR SELECT USING ((("organization_id" IS NULL) OR ("organization_id" = ( SELECT "up"."organization_id"
       FROM "public"."user_profiles" "up"
      WHERE ("up"."id" = "auth"."uid"())))));
  END IF;
END
$baseline$;

DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'rules'
      AND policyname = 'rules_update_org'
  ) THEN
    CREATE POLICY "rules_update_org" ON "public"."rules" FOR UPDATE USING (("organization_id" = ( SELECT "up"."organization_id"
       FROM "public"."user_profiles" "up"
      WHERE ("up"."id" = "auth"."uid"())))) WITH CHECK (("organization_id" = ( SELECT "up"."organization_id"
       FROM "public"."user_profiles" "up"
      WHERE ("up"."id" = "auth"."uid"()))));
  END IF;
END
$baseline$;

DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'user_profiles'
      AND policyname = 'user_profiles_select_org'
  ) THEN
    CREATE POLICY "user_profiles_select_org" ON "public"."user_profiles" FOR SELECT USING (("organization_id" = "public"."get_current_user_org_id"()));
  END IF;
END
$baseline$;

DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'user_profiles'
      AND policyname = 'user_profiles_select_own'
  ) THEN
    CREATE POLICY "user_profiles_select_own" ON "public"."user_profiles" FOR SELECT TO "authenticated" USING (("id" = "auth"."uid"()));
  END IF;
END
$baseline$;

DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'user_profiles'
      AND policyname = 'user_profiles_update_own'
  ) THEN
    CREATE POLICY "user_profiles_update_own" ON "public"."user_profiles" FOR UPDATE TO "authenticated" USING (("id" = "auth"."uid"())) WITH CHECK (("id" = "auth"."uid"()));
  END IF;
END
$baseline$;

DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'workflow_task_events'
      AND policyname = 'workflow_task_events_insert_org'
  ) THEN
    CREATE POLICY "workflow_task_events_insert_org" ON "public"."workflow_task_events" FOR INSERT TO "authenticated" WITH CHECK ((EXISTS ( SELECT 1
       FROM "public"."user_profiles" "up"
      WHERE (("up"."id" = "auth"."uid"()) AND ("up"."organization_id" = "workflow_task_events"."organization_id")))));
  END IF;
END
$baseline$;

DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'workflow_task_events'
      AND policyname = 'workflow_task_events_select_org'
  ) THEN
    CREATE POLICY "workflow_task_events_select_org" ON "public"."workflow_task_events" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
       FROM "public"."user_profiles" "up"
      WHERE (("up"."id" = "auth"."uid"()) AND ("up"."organization_id" = "workflow_task_events"."organization_id")))));
  END IF;
END
$baseline$;

DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'workflow_tasks'
      AND policyname = 'workflow_tasks_delete_org'
  ) THEN
    CREATE POLICY "workflow_tasks_delete_org" ON "public"."workflow_tasks" FOR DELETE USING ((EXISTS ( SELECT 1
       FROM "public"."user_profiles" "up"
      WHERE (("up"."id" = "auth"."uid"()) AND ("up"."organization_id" = "workflow_tasks"."organization_id")))));
  END IF;
END
$baseline$;

DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'workflow_tasks'
      AND policyname = 'workflow_tasks_insert_org'
  ) THEN
    CREATE POLICY "workflow_tasks_insert_org" ON "public"."workflow_tasks" FOR INSERT TO "authenticated" WITH CHECK ((EXISTS ( SELECT 1
       FROM "public"."user_profiles" "up"
      WHERE (("up"."id" = "auth"."uid"()) AND ("up"."organization_id" = "workflow_tasks"."organization_id")))));
  END IF;
END
$baseline$;

DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'workflow_tasks'
      AND policyname = 'workflow_tasks_select_org'
  ) THEN
    CREATE POLICY "workflow_tasks_select_org" ON "public"."workflow_tasks" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
       FROM "public"."user_profiles" "up"
      WHERE (("up"."id" = "auth"."uid"()) AND ("up"."organization_id" = "workflow_tasks"."organization_id")))));
  END IF;
END
$baseline$;

DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'workflow_tasks'
      AND policyname = 'workflow_tasks_update_org'
  ) THEN
    CREATE POLICY "workflow_tasks_update_org" ON "public"."workflow_tasks" FOR UPDATE TO "authenticated" USING ((EXISTS ( SELECT 1
       FROM "public"."user_profiles" "up"
      WHERE (("up"."id" = "auth"."uid"()) AND ("up"."organization_id" = "workflow_tasks"."organization_id"))))) WITH CHECK ((EXISTS ( SELECT 1
       FROM "public"."user_profiles" "up"
      WHERE (("up"."id" = "auth"."uid"()) AND ("up"."organization_id" = "workflow_tasks"."organization_id")))));
  END IF;
END
$baseline$;

DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'workflow_templates'
      AND policyname = 'workflow_templates_delete_org'
  ) THEN
    CREATE POLICY "workflow_templates_delete_org" ON "public"."workflow_templates" FOR DELETE TO "authenticated" USING (("organization_id" = ( SELECT "up"."organization_id"
       FROM "public"."user_profiles" "up"
      WHERE ("up"."id" = "auth"."uid"()))));
  END IF;
END
$baseline$;

DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'workflow_templates'
      AND policyname = 'workflow_templates_insert_org'
  ) THEN
    CREATE POLICY "workflow_templates_insert_org" ON "public"."workflow_templates" FOR INSERT TO "authenticated" WITH CHECK (("organization_id" = ( SELECT "up"."organization_id"
       FROM "public"."user_profiles" "up"
      WHERE ("up"."id" = "auth"."uid"()))));
  END IF;
END
$baseline$;

DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'workflow_templates'
      AND policyname = 'workflow_templates_select_org'
  ) THEN
    CREATE POLICY "workflow_templates_select_org" ON "public"."workflow_templates" FOR SELECT TO "authenticated" USING ((("organization_id" IS NULL) OR ("organization_id" = ( SELECT "up"."organization_id"
       FROM "public"."user_profiles" "up"
      WHERE ("up"."id" = "auth"."uid"())))));
  END IF;
END
$baseline$;

DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'workflow_templates'
      AND policyname = 'workflow_templates_update_org'
  ) THEN
    CREATE POLICY "workflow_templates_update_org" ON "public"."workflow_templates" FOR UPDATE TO "authenticated" USING (("organization_id" = ( SELECT "up"."organization_id"
       FROM "public"."user_profiles" "up"
      WHERE ("up"."id" = "auth"."uid"())))) WITH CHECK (("organization_id" = ( SELECT "up"."organization_id"
       FROM "public"."user_profiles" "up"
      WHERE ("up"."id" = "auth"."uid"()))));
  END IF;
END
$baseline$;

DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'workflows'
      AND policyname = 'workflows_delete_org'
  ) THEN
    CREATE POLICY "workflows_delete_org" ON "public"."workflows" FOR DELETE TO "authenticated" USING (("organization_id" = ( SELECT "up"."organization_id"
       FROM "public"."user_profiles" "up"
      WHERE ("up"."id" = "auth"."uid"()))));
  END IF;
END
$baseline$;

DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'workflows'
      AND policyname = 'workflows_insert_org'
  ) THEN
    CREATE POLICY "workflows_insert_org" ON "public"."workflows" FOR INSERT TO "authenticated" WITH CHECK (("organization_id" = ( SELECT "up"."organization_id"
       FROM "public"."user_profiles" "up"
      WHERE ("up"."id" = "auth"."uid"()))));
  END IF;
END
$baseline$;

DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'workflows'
      AND policyname = 'workflows_select_org'
  ) THEN
    CREATE POLICY "workflows_select_org" ON "public"."workflows" FOR SELECT TO "authenticated" USING ((("organization_id" IS NULL) OR ("organization_id" = ( SELECT "up"."organization_id"
       FROM "public"."user_profiles" "up"
      WHERE ("up"."id" = "auth"."uid"())))));
  END IF;
END
$baseline$;

DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'workflows'
      AND policyname = 'workflows_update_org'
  ) THEN
    CREATE POLICY "workflows_update_org" ON "public"."workflows" FOR UPDATE TO "authenticated" USING (("organization_id" = ( SELECT "up"."organization_id"
       FROM "public"."user_profiles" "up"
      WHERE ("up"."id" = "auth"."uid"())))) WITH CHECK (("organization_id" = ( SELECT "up"."organization_id"
       FROM "public"."user_profiles" "up"
      WHERE ("up"."id" = "auth"."uid"()))));
  END IF;
END
$baseline$;

-- Exact live routine

CREATE OR REPLACE FUNCTION "public"."update_decision_status"("p_decision_id" "uuid", "p_organization_id" "uuid", "p_new_status" "text") RETURNS "public"."decisions"
    LANGUAGE "plpgsql"
    AS $$
DECLARE
  v_row public.decisions;
BEGIN
  IF p_new_status NOT IN ('open', 'in_review', 'resolved', 'suppressed') THEN
    RAISE EXCEPTION 'Invalid decision status: %', p_new_status;
  END IF;

  UPDATE public.decisions
  SET
    status = p_new_status,
    resolved_at = CASE
      WHEN p_new_status = 'resolved' THEN now()
      ELSE NULL
    END,
    updated_at = now()
  WHERE id = p_decision_id
    AND organization_id = p_organization_id
  RETURNING * INTO v_row;

  IF v_row IS NULL THEN
    RAISE EXCEPTION 'Decision not found or not in organization';
  END IF;

  RETURN v_row;
END;
$$;

-- Exact live triggers.
-- The tr_project_validation_* names below intentionally preserve confirmed
-- live/history naming drift; this baseline does not rename them.

DROP TRIGGER IF EXISTS "set_transaction_data_summaries_updated_at" ON "public"."transaction_data_summaries";
CREATE TRIGGER "set_transaction_data_summaries_updated_at" BEFORE UPDATE ON "public"."transaction_data_summaries" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();

DROP TRIGGER IF EXISTS "tr_project_validation_findings_updated_at" ON "public"."project_validation_findings";
CREATE TRIGGER "tr_project_validation_findings_updated_at" BEFORE UPDATE ON "public"."project_validation_findings" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();

DROP TRIGGER IF EXISTS "tr_project_validation_rule_state_updated_at" ON "public"."project_validation_rule_state";
CREATE TRIGGER "tr_project_validation_rule_state_updated_at" BEFORE UPDATE ON "public"."project_validation_rule_state" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();

DROP TRIGGER IF EXISTS "tr_project_validation_runs_updated_at" ON "public"."project_validation_runs";
CREATE TRIGGER "tr_project_validation_runs_updated_at" BEFORE UPDATE ON "public"."project_validation_runs" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();

DROP TRIGGER IF EXISTS "trg_decision_feedback_set_updated_at" ON "public"."decision_feedback";
CREATE TRIGGER "trg_decision_feedback_set_updated_at" BEFORE UPDATE ON "public"."decision_feedback" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();

DROP TRIGGER IF EXISTS "trg_issues_updated_at" ON "public"."issues";
CREATE TRIGGER "trg_issues_updated_at" BEFORE UPDATE ON "public"."issues" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();

DROP TRIGGER IF EXISTS "trg_projects_updated_at" ON "public"."projects";
CREATE TRIGGER "trg_projects_updated_at" BEFORE UPDATE ON "public"."projects" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();

DROP TRIGGER IF EXISTS "trg_reviews_updated_at" ON "public"."reviews";
CREATE TRIGGER "trg_reviews_updated_at" BEFORE UPDATE ON "public"."reviews" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();

DROP TRIGGER IF EXISTS "trg_rules_updated_at" ON "public"."rules";
CREATE TRIGGER "trg_rules_updated_at" BEFORE UPDATE ON "public"."rules" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();

DROP TRIGGER IF EXISTS "trg_workflow_tasks_set_updated_at" ON "public"."workflow_tasks";
CREATE TRIGGER "trg_workflow_tasks_set_updated_at" BEFORE UPDATE ON "public"."workflow_tasks" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();
