-- ============================================================================
-- Additive live-schema baseline for the 23 tables missing from committed history,
-- plus the byte-faithful live transaction_data_rows shape that predated the
-- committed transaction-data migrations.
--
-- Catalog source: production pg_attribute/pg_attrdef/pg_constraint/pg_index
-- capture on 2026-06-22. Table definitions are intentionally byte-faithful to
-- the live pg_dump representation. This migration only establishes table shape;
-- guarded constraints, indexes, RLS policies, routines, and triggers are applied
-- after the historical migration stream so their dependencies already exist.
--
-- Mechanism A: CREATE TABLE IF NOT EXISTS throughout. Do not use this migration
-- to resolve the rules/decision_rules dual-FK architecture or retire legacy
-- workflow_events, workflow_rules, or workflow_task_events.
-- ============================================================================

-- public.organizations
CREATE TABLE IF NOT EXISTS "public"."organizations" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id"),
    "name" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "analysis_mode" "text" DEFAULT 'deterministic'::"text" NOT NULL,
    "ai_provider" "text" DEFAULT 'claude'::"text" NOT NULL,
    CONSTRAINT "organizations_ai_provider_check" CHECK (("ai_provider" = ANY (ARRAY['none'::"text", 'claude'::"text", 'openai'::"text", 'openai_mini'::"text", 'gemini'::"text"]))),
    CONSTRAINT "organizations_analysis_mode_check" CHECK (("analysis_mode" = ANY (ARRAY['disabled'::"text", 'deterministic'::"text", 'ai_enriched'::"text"])))
);

-- public.user_profiles
CREATE TABLE IF NOT EXISTS "public"."user_profiles" (
    "id" "uuid" NOT NULL,
    CONSTRAINT "user_profiles_pkey" PRIMARY KEY ("id"),
    "organization_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "display_name" "text",
    "role" "text"
);

-- public.activity_events
CREATE TABLE IF NOT EXISTS "public"."activity_events" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    CONSTRAINT "activity_events_pkey" PRIMARY KEY ("id"),
    "organization_id" "uuid" NOT NULL,
    "entity_type" "text" NOT NULL,
    "entity_id" "uuid" NOT NULL,
    "event_type" "text" NOT NULL,
    "old_value" "jsonb",
    "new_value" "jsonb",
    "changed_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "project_id" "uuid",
    CONSTRAINT "activity_events_entity_type_check" CHECK (("entity_type" = ANY (ARRAY['decision'::"text", 'workflow_task'::"text", 'document'::"text", 'project'::"text", 'project_validation_run'::"text", 'project_validation_finding'::"text", 'execution_item'::"text"]))),
    CONSTRAINT "activity_events_event_type_check" CHECK (("event_type" = ANY (ARRAY['created'::"text", 'updated'::"text", 'status_changed'::"text", 'assignment_changed'::"text", 'due_date_changed'::"text", 'document_removed_from_project'::"text", 'document_moved_to_project'::"text", 'project_archived'::"text", 'project_deleted'::"text", 'validation_run_requested'::"text", 'validation_run_completed'::"text", 'validation_finding_generated'::"text", 'override_applied'::"text", 'review_recorded'::"text", 'review_correction_applied'::"text", 'governing_document_changed'::"text", 'document_relationship_created'::"text", 'document_relationship_changed'::"text", 'document_precedence_changed'::"text", 'document_subtype_updated'::"text", 'project_validation_phase_changed'::"text", 'execution_item_created'::"text", 'execution_item_approved'::"text", 'execution_item_corrected'::"text", 'execution_item_overridden'::"text"])) )
);

-- public.projects
CREATE TABLE IF NOT EXISTS "public"."projects" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    CONSTRAINT "projects_pkey" PRIMARY KEY ("id"),
    "organization_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "code" "text",
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "description" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "validation_status" "text" DEFAULT 'NOT_READY'::"text" NOT NULL,
    "validation_summary_json" "jsonb",
    CONSTRAINT "projects_validation_status_check" CHECK (("validation_status" = ANY (ARRAY['NOT_READY'::"text", 'BLOCKED'::"text", 'VALIDATED'::"text", 'FINDINGS_OPEN'::"text"])))
);

-- public.documents
CREATE TABLE IF NOT EXISTS "public"."documents" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    CONSTRAINT "documents_pkey" PRIMARY KEY ("id"),
    "organization_id" "uuid",
    "name" "text" NOT NULL,
    "storage_path" "text" NOT NULL,
    "status" "text" DEFAULT 'uploaded'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "title" "text",
    "document_type" "text",
    "project_id" "uuid",
    "processing_status" "text" DEFAULT 'uploaded'::"text" NOT NULL,
    "processing_error" "text",
    "processed_at" timestamp with time zone,
    "source_type" "text" DEFAULT 'upload'::"text" NOT NULL,
    "mime_type" "text",
    "file_path" "text",
    "domain" "text",
    "intelligence_trace" "jsonb",
    "intelligence_trace_updated_at" timestamp without time zone,
    "operator_override_precedence" integer,
    "precedence_rank" integer,
    "deleted_at" timestamp with time zone,
    CONSTRAINT "documents_processing_status_check" CHECK (("processing_status" = ANY (ARRAY['uploaded'::"text", 'processing'::"text", 'extracted'::"text", 'decisioned'::"text", 'failed'::"text"])))
);

-- public.decision_rules
CREATE TABLE IF NOT EXISTS "public"."decision_rules" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    CONSTRAINT "decision_rules_pkey" PRIMARY KEY ("id"),
    "organization_id" "uuid" NOT NULL,
    "rule_key" "text" NOT NULL,
    "decision_type" "text" NOT NULL,
    "name" "text" NOT NULL,
    "description" "text",
    "severity" "text" DEFAULT 'medium'::"text" NOT NULL,
    "applies_to_document_type" "text",
    "is_active" boolean DEFAULT true NOT NULL,
    "config" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "version" integer DEFAULT 1 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);

-- public.rules
CREATE TABLE IF NOT EXISTS "public"."rules" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    CONSTRAINT "rules_pkey" PRIMARY KEY ("id"),
    "organization_id" "uuid",
    "domain" "text" NOT NULL,
    "document_type" "text" NOT NULL,
    "rule_group" "text",
    "name" "text" NOT NULL,
    "description" "text",
    "decision_type" "text" NOT NULL,
    "severity" "text" DEFAULT 'medium'::"text" NOT NULL,
    "priority" integer DEFAULT 100 NOT NULL,
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "condition_json" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "action_json" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_by" "uuid",
    "updated_by" "uuid",
    CONSTRAINT "rules_severity_check" CHECK (("severity" = ANY (ARRAY['low'::"text", 'medium'::"text", 'high'::"text", 'critical'::"text"]))),
    CONSTRAINT "rules_status_check" CHECK (("status" = ANY (ARRAY['active'::"text", 'inactive'::"text", 'draft'::"text"])))
);

-- public.decisions
CREATE TABLE IF NOT EXISTS "public"."decisions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    CONSTRAINT "decisions_pkey" PRIMARY KEY ("id"),
    "organization_id" "uuid" NOT NULL,
    "document_id" "uuid",
    "decision_rule_id" "uuid",
    "decision_type" "text" NOT NULL,
    "title" "text" NOT NULL,
    "summary" "text",
    "severity" "text" DEFAULT 'medium'::"text" NOT NULL,
    "status" "text" DEFAULT 'open'::"text" NOT NULL,
    "confidence" numeric,
    "details" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "source" "text" DEFAULT 'system'::"text" NOT NULL,
    "first_detected_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "last_detected_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "resolved_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "assigned_to" "uuid",
    "assigned_at" timestamp with time zone,
    "assigned_by" "uuid",
    "due_at" timestamp with time zone,
    "rule_key" "text",
    "project_id" "uuid",
    CONSTRAINT "decisions_severity_check" CHECK (("severity" = ANY (ARRAY['low'::"text", 'medium'::"text", 'high'::"text", 'critical'::"text"]))),
    CONSTRAINT "decisions_source_check" CHECK (("source" = ANY (ARRAY['rule_engine'::"text", 'ai_model'::"text", 'human_review'::"text", 'deterministic'::"text", 'ai_enriched'::"text", 'manual'::"text", 'project_validator'::"text"]))),
    CONSTRAINT "decisions_status_allowed_check" CHECK (("status" = ANY (ARRAY['open'::"text", 'in_review'::"text", 'resolved'::"text", 'suppressed'::"text"]))),
    CONSTRAINT "decisions_status_check" CHECK (("status" = ANY (ARRAY['open'::"text", 'in_review'::"text", 'resolved'::"text", 'dismissed'::"text"])))
);

-- public.decision_feedback
CREATE TABLE IF NOT EXISTS "public"."decision_feedback" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    CONSTRAINT "decision_feedback_pkey" PRIMARY KEY ("id"),
    "decision_id" "uuid" NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "is_correct" boolean NOT NULL,
    "corrected_value" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_by" "uuid",
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "decision_status_at_feedback" "text",
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "disposition" "text",
    "feedback_type" "text",
    "notes" "text",
    "review_error_type" "text",
    "reviewer_id" "uuid",
    CONSTRAINT "decision_feedback_decision_status_at_feedback_check" CHECK ((("decision_status_at_feedback" IS NULL) OR ("decision_status_at_feedback" = ANY (ARRAY['open'::"text", 'in_review'::"text", 'resolved'::"text", 'suppressed'::"text"]))))
);

-- public.decision_policies
CREATE TABLE IF NOT EXISTS "public"."decision_policies" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    CONSTRAINT "decision_policies_pkey" PRIMARY KEY ("id"),
    "organization_id" "uuid",
    "name" "text" NOT NULL,
    "status" "text" DEFAULT 'draft'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"()
);

-- public.document_analysis_jobs
CREATE TABLE IF NOT EXISTS "public"."document_analysis_jobs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    CONSTRAINT "document_analysis_jobs_pkey" PRIMARY KEY ("id"),
    "document_id" "uuid" NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "analysis_mode" "text" DEFAULT 'deterministic'::"text" NOT NULL,
    "status" "text" DEFAULT 'queued'::"text" NOT NULL,
    "triggered_by" "text" DEFAULT 'upload'::"text" NOT NULL,
    "attempt_count" integer DEFAULT 0 NOT NULL,
    "max_attempts" integer DEFAULT 3 NOT NULL,
    "next_retry_at" timestamp with time zone,
    "started_at" timestamp with time zone,
    "completed_at" timestamp with time zone,
    "error_message" "text",
    "result_extraction_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "document_analysis_jobs_analysis_mode_check" CHECK (("analysis_mode" = ANY (ARRAY['disabled'::"text", 'deterministic'::"text", 'ai_enriched'::"text"]))),
    CONSTRAINT "document_analysis_jobs_status_check" CHECK (("status" = ANY (ARRAY['queued'::"text", 'running'::"text", 'completed'::"text", 'failed'::"text"]))),
    CONSTRAINT "document_analysis_jobs_triggered_by_check" CHECK (("triggered_by" = ANY (ARRAY['upload'::"text", 'manual'::"text", 'system'::"text"])))
);

-- public.document_decisions
CREATE TABLE IF NOT EXISTS "public"."document_decisions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    CONSTRAINT "document_decisions_pkey" PRIMARY KEY ("id"),
    "document_id" "uuid" NOT NULL,
    "organization_id" "uuid" NOT NULL,
    "decision_type" "text" NOT NULL,
    "decision_value" "text",
    "confidence" numeric,
    "source" "text" DEFAULT 'deterministic'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "document_decisions_confidence_check" CHECK ((("confidence" >= (0)::numeric) AND ("confidence" <= (1)::numeric))),
    CONSTRAINT "document_decisions_source_check" CHECK (("source" = ANY (ARRAY['deterministic'::"text", 'ai_enriched'::"text", 'manual'::"text"])))
);

-- public.document_extractions
CREATE TABLE IF NOT EXISTS "public"."document_extractions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    CONSTRAINT "document_extractions_pkey" PRIMARY KEY ("id"),
    "document_id" "uuid",
    "data" "jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "extractor_name" "text" DEFAULT 'gpt-4o'::"text" NOT NULL,
    "extractor_version" "text" DEFAULT '1.0'::"text" NOT NULL,
    "confidence" numeric(4,3),
    "status" "text" DEFAULT 'success'::"text" NOT NULL,
    "error_message" "text",
    "payload" "jsonb",
    "organization_id" "uuid",
    "field_key" "text",
    "field_value_text" "text",
    "field_value_number" numeric,
    "field_value_date" "date",
    "field_value_boolean" boolean,
    "field_type" "text",
    "source" "text",
    "created_by" "uuid",
    CONSTRAINT "document_extractions_status_check" CHECK (("status" = ANY (ARRAY['success'::"text", 'failed'::"text", 'partial'::"text"])))
);

-- public.issues
CREATE TABLE IF NOT EXISTS "public"."issues" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    CONSTRAINT "issues_pkey" PRIMARY KEY ("id"),
    "organization_id" "uuid" NOT NULL,
    "project_id" "uuid",
    "document_id" "uuid",
    "review_id" "uuid",
    "workflow_id" "uuid",
    "title" "text" NOT NULL,
    "description" "text",
    "severity" "text" DEFAULT 'medium'::"text" NOT NULL,
    "status" "text" DEFAULT 'open'::"text" NOT NULL,
    "issue_type" "text" DEFAULT 'bug'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);

-- public.project_rule_overrides
CREATE TABLE IF NOT EXISTS "public"."project_rule_overrides" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    CONSTRAINT "project_rule_overrides_pkey" PRIMARY KEY ("id"),
    "project_id" "uuid",
    "rule_key" "text" NOT NULL,
    "is_enabled" boolean DEFAULT true NOT NULL,
    "config" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);

-- public.reviews
CREATE TABLE IF NOT EXISTS "public"."reviews" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    CONSTRAINT "reviews_pkey" PRIMARY KEY ("id"),
    "organization_id" "uuid" NOT NULL,
    "project_id" "uuid",
    "document_id" "uuid",
    "review_type" "text" DEFAULT 'general'::"text" NOT NULL,
    "status" "text" DEFAULT 'open'::"text" NOT NULL,
    "reviewer_user_id" "uuid",
    "summary" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "title" "text",
    "priority" "text" DEFAULT 'normal'::"text" NOT NULL,
    CONSTRAINT "reviews_priority_check" CHECK (("priority" = ANY (ARRAY['low'::"text", 'normal'::"text", 'high'::"text", 'critical'::"text"])))
);

-- public.transaction_data_summaries
-- public.transaction_data_rows
CREATE TABLE IF NOT EXISTS "public"."transaction_data_rows" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    CONSTRAINT "transaction_data_rows_pkey" PRIMARY KEY ("id"),
    "organization_id" "uuid" NOT NULL,
    "project_id" "uuid",
    "document_id" "uuid" NOT NULL,
    "source_sheet_name" "text" DEFAULT 'unknown'::"text" NOT NULL,
    "source_row_number" integer DEFAULT 0 NOT NULL,
    "transaction_number" "text",
    "invoice_number" "text",
    "invoice_date" "date",
    "rate_code" "text",
    "rate_description" "text",
    "transaction_quantity" numeric,
    "transaction_rate" numeric,
    "extended_cost" numeric,
    "net_quantity" numeric,
    "mileage" numeric,
    "cyd" numeric,
    "net_tonnage" numeric,
    "material" "text",
    "service_item" "text",
    "ticket_notes" "text",
    "eligibility" "text",
    "eligibility_internal_comments" "text",
    "eligibility_external_comments" "text",
    "load_latitude" numeric,
    "load_longitude" numeric,
    "disposal_latitude" numeric,
    "disposal_longitude" numeric,
    "project_name" "text",
    "raw_row" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "billing_rate_key" "text",
    "description_match_key" "text",
    "site_material_key" "text",
    "invoice_rate_key" "text",
    "record_json" "jsonb" DEFAULT '{}'::"jsonb",
    "raw_row_json" "jsonb" DEFAULT '{}'::"jsonb"
);

-- public.transaction_data_summaries
CREATE TABLE IF NOT EXISTS "public"."transaction_data_summaries" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    CONSTRAINT "transaction_data_summaries_pkey" PRIMARY KEY ("id"),
    "organization_id" "uuid" NOT NULL,
    "project_id" "uuid",
    "document_id" "uuid" NOT NULL,
    "row_count" integer DEFAULT 0 NOT NULL,
    "distinct_invoice_numbers" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "distinct_rate_codes" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "distinct_service_items" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "distinct_materials" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "total_extended_cost" numeric,
    "total_transaction_quantity" numeric,
    "rows_with_missing_rate_code" integer DEFAULT 0 NOT NULL,
    "rows_with_missing_quantity" integer DEFAULT 0 NOT NULL,
    "rows_with_missing_extended_cost" integer DEFAULT 0 NOT NULL,
    "detected_header_map" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "detected_sheet_names" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "inferred_date_range_start" "date",
    "inferred_date_range_end" "date",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);

-- public.workflow_rules
CREATE TABLE IF NOT EXISTS "public"."workflow_rules" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    CONSTRAINT "workflow_rules_pkey" PRIMARY KEY ("id"),
    "organization_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "description" "text",
    "is_active" boolean DEFAULT true NOT NULL,
    "condition_type" "text" NOT NULL,
    "condition_value" "text" NOT NULL,
    "action_type" "text" NOT NULL,
    "action_payload" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "workflow_rules_action_type_check" CHECK (("action_type" = ANY (ARRAY['create_review'::"text", 'flag_document'::"text", 'assign_project'::"text", 'send_alert'::"text", 'log_event'::"text"])))
);

-- public.workflow_events
CREATE TABLE IF NOT EXISTS "public"."workflow_events" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    CONSTRAINT "workflow_events_pkey" PRIMARY KEY ("id"),
    "organization_id" "uuid" NOT NULL,
    "document_id" "uuid",
    "rule_id" "uuid",
    "event_type" "text" NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "payload" "jsonb",
    "error_message" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "workflow_events_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'completed'::"text", 'failed'::"text", 'skipped'::"text"])))
);

-- public.workflow_tasks
CREATE TABLE IF NOT EXISTS "public"."workflow_tasks" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    CONSTRAINT "workflow_tasks_pkey" PRIMARY KEY ("id"),
    "organization_id" "uuid" NOT NULL,
    "decision_id" "uuid",
    "document_id" "uuid",
    "task_type" "text" NOT NULL,
    "title" "text" NOT NULL,
    "description" "text",
    "status" "text" DEFAULT 'open'::"text" NOT NULL,
    "priority" "text" DEFAULT 'medium'::"text" NOT NULL,
    "assigned_to" "uuid",
    "created_by" "uuid",
    "due_at" timestamp with time zone,
    "started_at" timestamp with time zone,
    "completed_at" timestamp with time zone,
    "source" "text" DEFAULT 'decision_engine'::"text" NOT NULL,
    "source_metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "details" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "assigned_at" timestamp with time zone,
    "assigned_by" "uuid",
    "project_id" "uuid",
    CONSTRAINT "workflow_tasks_priority_check" CHECK (("priority" = ANY (ARRAY['low'::"text", 'medium'::"text", 'high'::"text", 'critical'::"text"]))),
    CONSTRAINT "workflow_tasks_source_check" CHECK (("source" = ANY (ARRAY['decision_engine'::"text", 'manual'::"text", 'system'::"text"]))),
    CONSTRAINT "workflow_tasks_status_check" CHECK (("status" = ANY (ARRAY['open'::"text", 'in_progress'::"text", 'blocked'::"text", 'resolved'::"text", 'cancelled'::"text"]))),
    CONSTRAINT "workflow_tasks_task_type_not_blank" CHECK (("btrim"("task_type") <> ''::"text")),
    CONSTRAINT "workflow_tasks_title_not_blank" CHECK (("btrim"("title") <> ''::"text"))
);

-- public.workflow_task_events
CREATE TABLE IF NOT EXISTS "public"."workflow_task_events" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    CONSTRAINT "workflow_task_events_pkey" PRIMARY KEY ("id"),
    "organization_id" "uuid" NOT NULL,
    "workflow_task_id" "uuid" NOT NULL,
    "event_type" "text" NOT NULL,
    "actor_id" "uuid",
    "old_status" "text",
    "new_status" "text",
    "notes" "text",
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "workflow_task_events_event_type_not_blank" CHECK (("btrim"("event_type") <> ''::"text")),
    CONSTRAINT "workflow_task_events_new_status_check" CHECK ((("new_status" IS NULL) OR ("new_status" = ANY (ARRAY['open'::"text", 'in_progress'::"text", 'blocked'::"text", 'resolved'::"text", 'cancelled'::"text"])))),
    CONSTRAINT "workflow_task_events_old_status_check" CHECK ((("old_status" IS NULL) OR ("old_status" = ANY (ARRAY['open'::"text", 'in_progress'::"text", 'blocked'::"text", 'resolved'::"text", 'cancelled'::"text"]))))
);

-- public.workflow_templates
CREATE TABLE IF NOT EXISTS "public"."workflow_templates" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    CONSTRAINT "workflow_templates_pkey" PRIMARY KEY ("id"),
    "organization_id" "uuid",
    "decision_type" "text" NOT NULL,
    "severity" "text" NOT NULL,
    "task_type" "text" NOT NULL,
    "priority" "text" DEFAULT 'medium'::"text" NOT NULL,
    "default_assignee" "uuid",
    "sla_hours" integer,
    "is_enabled" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);

-- public.workflows
CREATE TABLE IF NOT EXISTS "public"."workflows" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    CONSTRAINT "workflows_pkey" PRIMARY KEY ("id"),
    "organization_id" "uuid",
    "name" "text" NOT NULL,
    "status" "text" DEFAULT 'draft'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"()
);
