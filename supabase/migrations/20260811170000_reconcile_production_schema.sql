-- Reconcile the migration-built schema with the production schema.
--
-- Production (project jpzeckefppmiujwajgvk) was built partly by hand. 49 repo
-- migrations dated before 2026-08-12 are not recorded there under their own
-- versions, and production has 24 history entries with no repo file. A fresh
-- build of the migrations up to 20260811160000 therefore differs from
-- production on 21 tables (column types and nullability, constraints, indexes,
-- policies, RLS, triggers) and in the text of two functions.
--
-- Production is the reference. This migration turns the state left by
-- migrations <= 20260811160000 into production's state, item by item, so that
-- every later migration runs against the same schema in a fresh build as in
-- production. Every definition below was taken from production's catalog
-- (pg_get_constraintdef, pg_indexes, pg_policies, pg_get_functiondef) on
-- 2026-10-03. The result was verified against production by comparing catalog
-- fingerprints.
--
-- Production records this migration as applied without running it, because
-- on production it is a no-op.
--
-- Application code still writes some repo-only objects. They are dropped here
-- so that both paths stay identical, then re-added by a later forward
-- migration that production also runs
-- (20261003120100_project_approval_snapshot_attribution_columns):
--   project_approval_snapshots.run_id, triggering_decision_id and created_by,
--   and their two partial indexes (written by lib/server/approvalSnapshots.ts).
--
-- Production also differs from this repo in ways this migration reproduces
-- rather than corrects: it has no foreign keys on document_fact_overrides or
-- document_relationships, and it has duplicate document_fact_overrides
-- indexes and policies. Fixing those is a separate change that touches
-- production.

-- ---------------------------------------------------------------------------
-- Functions: production text (only whitespace and keyword case differ; behaviour is the same)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.compute_execution_item_queue_state(p_status text, p_outcome text, p_severity text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  SELECT CASE
    WHEN p_status IN ('resolved', 'superseded')               THEN 'resolved'
    WHEN p_outcome = 'overridden'                             THEN 'needs_verification'
    WHEN p_status = 'open'                                    THEN 'blocked'
    WHEN p_status = 'resolvable' AND p_severity = 'critical' THEN 'blocked'
    WHEN p_status = 'resolvable' AND p_severity = 'high'     THEN 'needs_review'
    WHEN p_status = 'resolvable'                              THEN 'needs_verification'
    ELSE                                                           'needs_review'
  END;
$function$;

CREATE OR REPLACE FUNCTION public.set_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  new.updated_at = now();
  return new;
end;
$function$;

-- ---------------------------------------------------------------------------
-- Columns
-- ---------------------------------------------------------------------------

ALTER TABLE public.approval_action_log
  DROP CONSTRAINT IF EXISTS approval_action_log_task_id_fkey,
  DROP CONSTRAINT IF EXISTS approval_action_log_task_outcome_check,
  ALTER COLUMN amount TYPE numeric,
  DROP COLUMN IF EXISTS created_at;

ALTER TABLE public.decision_feedback
  DROP CONSTRAINT IF EXISTS decision_feedback_review_error_type_check,
  DROP COLUMN IF EXISTS correction_type;

ALTER TABLE public.decisions
  DROP CONSTRAINT IF EXISTS decisions_rule_id_fkey,
  DROP COLUMN IF EXISTS rule_id,
  DROP COLUMN IF EXISTS evidence,
  DROP COLUMN IF EXISTS resolved_by;

ALTER TABLE public.document_relationships
  ALTER COLUMN created_at DROP NOT NULL,
  ALTER COLUMN organization_id DROP NOT NULL;

ALTER TABLE public.project_approval_snapshots
  DROP COLUMN IF EXISTS run_id,
  DROP COLUMN IF EXISTS triggering_decision_id,
  DROP COLUMN IF EXISTS created_by;

ALTER TABLE public.workflow_trigger_rules
  ALTER COLUMN conditions SET DEFAULT '{}'::jsonb,
  ALTER COLUMN description_template DROP NOT NULL,
  ALTER COLUMN priority SET DEFAULT 'medium'::text;
UPDATE public.workflow_trigger_rules SET conditions = '{}'::jsonb WHERE conditions IS NULL;
ALTER TABLE public.workflow_trigger_rules
  ALTER COLUMN conditions SET NOT NULL;

-- ---------------------------------------------------------------------------
-- Constraints
-- ---------------------------------------------------------------------------

ALTER TABLE public.activity_events
  DROP CONSTRAINT IF EXISTS activity_events_event_type_check,
  ADD CONSTRAINT activity_events_event_type_check CHECK (event_type = ANY (ARRAY[
    'created'::text, 'updated'::text, 'status_changed'::text, 'assignment_changed'::text,
    'due_date_changed'::text, 'document_removed_from_project'::text, 'document_moved_to_project'::text,
    'project_archived'::text, 'project_deleted'::text, 'validation_run_requested'::text,
    'validation_run_completed'::text, 'validation_finding_generated'::text, 'override_applied'::text,
    'review_recorded'::text, 'review_correction_applied'::text, 'governing_document_changed'::text,
    'document_relationship_created'::text, 'document_relationship_changed'::text,
    'document_precedence_changed'::text, 'document_subtype_updated'::text,
    'project_validation_phase_changed'::text, 'execution_item_created'::text,
    'execution_item_approved'::text, 'execution_item_corrected'::text, 'execution_item_overridden'::text
  ]));

ALTER TABLE public.decision_feedback
  DROP CONSTRAINT IF EXISTS decision_feedback_decision_status_at_feedback_check,
  ADD CONSTRAINT decision_feedback_decision_status_at_feedback_check CHECK (
    decision_status_at_feedback IS NULL
    OR decision_status_at_feedback = ANY (ARRAY['open'::text, 'in_review'::text, 'resolved'::text, 'suppressed'::text, 'dismissed'::text])
  );

ALTER TABLE public.decisions
  DROP CONSTRAINT IF EXISTS decisions_status_allowed_check,
  DROP CONSTRAINT IF EXISTS decisions_assigned_by_fkey,
  DROP CONSTRAINT IF EXISTS decisions_assigned_to_fkey,
  ADD CONSTRAINT decisions_assigned_by_fkey FOREIGN KEY (assigned_by) REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  ADD CONSTRAINT decisions_assigned_to_fkey FOREIGN KEY (assigned_to) REFERENCES public.user_profiles(id) ON DELETE SET NULL;

ALTER TABLE public.document_extractions
  DROP CONSTRAINT IF EXISTS document_extractions_document_id_fkey,
  ADD CONSTRAINT document_extractions_document_id_fkey FOREIGN KEY (document_id) REFERENCES public.documents(id) ON DELETE CASCADE;

ALTER TABLE public.document_fact_overrides
  DROP CONSTRAINT IF EXISTS document_fact_overrides_document_id_fkey,
  DROP CONSTRAINT IF EXISTS document_fact_overrides_organization_id_fkey,
  DROP CONSTRAINT IF EXISTS document_fact_overrides_supersedes_override_id_fkey;

DROP INDEX IF EXISTS public.idx_document_relationships_unique_edge;
ALTER TABLE public.document_relationships
  DROP CONSTRAINT IF EXISTS document_relationships_project_id_fkey,
  DROP CONSTRAINT IF EXISTS document_relationships_source_document_id_fkey,
  DROP CONSTRAINT IF EXISTS document_relationships_target_document_id_fkey,
  DROP CONSTRAINT IF EXISTS document_relationships_source_target_check,
  DROP CONSTRAINT IF EXISTS document_relationships_unique_link,
  ADD CONSTRAINT document_relationships_unique_link UNIQUE (project_id, source_document_id, target_document_id, relationship_type);

ALTER TABLE public.documents
  DROP CONSTRAINT IF EXISTS documents_document_type_known_values_check,
  ADD CONSTRAINT documents_document_type_known_values_check CHECK (
    document_type IS NULL
    OR document_type = ANY (ARRAY[
      'contract'::text, 'williamson_contract'::text, 'price_sheet'::text, 'invoice'::text, 'report'::text,
      'policy'::text, 'procedure'::text, 'specification'::text, 'transaction_data'::text, 'other'::text,
      'payment_rec'::text, 'payment_recommendation'::text, 'ticket'::text, 'debris_ticket'::text,
      'spreadsheet'::text, 'rate_sheet'::text, 'rate_schedule'::text, 'attachment'::text, 'permit'::text,
      'disposal_checklist'::text, 'dms_checklist'::text, 'kickoff'::text, 'daily_ops'::text, 'ops_report'::text
    ])
  );

ALTER TABLE public.project_validation_findings
  DROP CONSTRAINT IF EXISTS fk_validation_decision,
  ADD CONSTRAINT fk_validation_decision FOREIGN KEY (linked_decision_id) REFERENCES public.decisions(id) ON DELETE SET NULL;

ALTER TABLE public.project_validation_runs
  DROP CONSTRAINT IF EXISTS project_validation_runs_triggered_by_check;

ALTER TABLE public.projects
  DROP CONSTRAINT IF EXISTS projects_status_check;

ALTER TABLE public.workflow_tasks
  DROP CONSTRAINT IF EXISTS workflow_tasks_assigned_by_fkey,
  DROP CONSTRAINT IF EXISTS workflow_tasks_decision_id_fkey,
  ADD CONSTRAINT workflow_tasks_assigned_by_fkey FOREIGN KEY (assigned_by) REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  ADD CONSTRAINT workflow_tasks_decision_id_fkey FOREIGN KEY (decision_id) REFERENCES public.decisions(id) ON DELETE SET NULL;

ALTER TABLE public.workflow_trigger_rules
  DROP CONSTRAINT IF EXISTS workflow_trigger_rules_decision_status_check,
  DROP CONSTRAINT IF EXISTS workflow_trigger_rules_priority_check,
  DROP CONSTRAINT IF EXISTS workflow_trigger_rules_severity_check,
  DROP CONSTRAINT IF EXISTS workflow_trigger_rules_task_type_not_blank,
  DROP CONSTRAINT IF EXISTS workflow_trigger_rules_title_template_not_blank,
  ADD CONSTRAINT workflow_trigger_rules_decision_status_check CHECK (
    decision_status IS NULL
    OR decision_status = ANY (ARRAY['open'::text, 'in_review'::text, 'resolved'::text, 'suppressed'::text])
  ),
  ADD CONSTRAINT workflow_trigger_rules_priority_check CHECK (priority = ANY (ARRAY['low'::text, 'medium'::text, 'high'::text, 'critical'::text])),
  ADD CONSTRAINT workflow_trigger_rules_severity_check CHECK (
    severity IS NULL
    OR severity = ANY (ARRAY['low'::text, 'medium'::text, 'high'::text, 'critical'::text])
  ),
  ADD CONSTRAINT workflow_trigger_rules_task_type_not_blank CHECK (btrim(task_type) <> ''::text),
  ADD CONSTRAINT workflow_trigger_rules_title_template_not_blank CHECK (btrim(title_template) <> ''::text);

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------

DROP INDEX IF EXISTS public.idx_approval_action_log_failed;
DROP INDEX IF EXISTS public.idx_approval_action_log_org;
DROP INDEX IF EXISTS public.idx_approval_action_log_project;
DROP INDEX IF EXISTS public.idx_contract_upload_guidance_organization_id;
DROP INDEX IF EXISTS public.idx_contract_upload_guidance_project_id;
DROP INDEX IF EXISTS public.idx_decision_feedback_created_at;
DROP INDEX IF EXISTS public.idx_decision_feedback_organization_id;
DROP INDEX IF EXISTS public.idx_decision_feedback_review_error_type;
DROP INDEX IF EXISTS public.idx_decisions_created_at;
DROP INDEX IF EXISTS public.idx_decisions_decision_type;
DROP INDEX IF EXISTS public.idx_decisions_doc_rule_status;
DROP INDEX IF EXISTS public.idx_decisions_document_id;
DROP INDEX IF EXISTS public.idx_decisions_organization_id;
DROP INDEX IF EXISTS public.idx_decisions_status;
DROP INDEX IF EXISTS public.idx_document_extractions_doc_field;
DROP INDEX IF EXISTS public.idx_document_extractions_field_key;
DROP INDEX IF EXISTS public.idx_document_extractions_organization_id;
DROP INDEX IF EXISTS public.idx_document_fields_domain_type_key;
DROP INDEX IF EXISTS public.idx_document_relationships_organization_id;
DROP INDEX IF EXISTS public.idx_document_relationships_project_id;
DROP INDEX IF EXISTS public.idx_document_relationships_relationship_type;
DROP INDEX IF EXISTS public.idx_document_relationships_source_document_id;
DROP INDEX IF EXISTS public.idx_document_relationships_target_document_id;
DROP INDEX IF EXISTS public.idx_document_relationships_unique_edge;
DROP INDEX IF EXISTS public.idx_documents_domain_type;
DROP INDEX IF EXISTS public.idx_documents_processing_status;
DROP INDEX IF EXISTS public.idx_project_approval_snapshots_run_id;
DROP INDEX IF EXISTS public.idx_project_approval_snapshots_triggering_decision;
DROP INDEX IF EXISTS public.idx_project_validation_evidence_finding_id;
DROP INDEX IF EXISTS public.idx_project_validation_findings_open_dedupe;
DROP INDEX IF EXISTS public.idx_project_validation_findings_project_status_severity;
DROP INDEX IF EXISTS public.idx_project_validation_findings_run_id;
DROP INDEX IF EXISTS public.idx_project_validation_runs_project_run_at;
DROP INDEX IF EXISTS public.idx_rules_document_type;
DROP INDEX IF EXISTS public.idx_rules_domain_type_status;
DROP INDEX IF EXISTS public.idx_rules_domain;
DROP INDEX IF EXISTS public.idx_rules_organization_id;
DROP INDEX IF EXISTS public.idx_rules_priority;
DROP INDEX IF EXISTS public.idx_rules_status;
DROP INDEX IF EXISTS public.idx_signals_created_at;
DROP INDEX IF EXISTS public.idx_signals_organization_id;
DROP INDEX IF EXISTS public.idx_signals_signal_type;
DROP INDEX IF EXISTS public.idx_signals_status;
DROP INDEX IF EXISTS public.idx_state_projection_shadow_mismatches_natural_key;
DROP INDEX IF EXISTS public.idx_workflow_tasks_created_at;
DROP INDEX IF EXISTS public.idx_workflow_tasks_decision_id;
DROP INDEX IF EXISTS public.idx_workflow_tasks_decision_type_status;
DROP INDEX IF EXISTS public.idx_workflow_tasks_organization_id;
DROP INDEX IF EXISTS public.idx_workflow_tasks_status;
DROP INDEX IF EXISTS public.idx_workflow_trigger_rules_org_active;

CREATE INDEX IF NOT EXISTS idx_approval_action_log_project_executed ON public.approval_action_log USING btree (project_id, executed_at DESC);
CREATE INDEX IF NOT EXISTS idx_document_extractions_field_key ON public.document_extractions USING btree (field_key);
CREATE INDEX IF NOT EXISTS idx_document_extractions_organization_id ON public.document_extractions USING btree (organization_id);
CREATE INDEX IF NOT EXISTS idx_dfo_document_id ON public.document_fact_overrides USING btree (document_id);
CREATE INDEX IF NOT EXISTS idx_dfo_field_key ON public.document_fact_overrides USING btree (field_key);
CREATE INDEX IF NOT EXISTS idx_dfo_org_doc_field_active ON public.document_fact_overrides USING btree (organization_id, document_id, field_key, is_active);
CREATE INDEX IF NOT EXISTS idx_document_fact_overrides_document_id ON public.document_fact_overrides USING btree (document_id);
CREATE INDEX IF NOT EXISTS idx_document_fact_overrides_org_doc_field_active ON public.document_fact_overrides USING btree (organization_id, document_id, field_key, is_active);
CREATE UNIQUE INDEX IF NOT EXISTS idx_document_fields_unique ON public.document_fields USING btree (domain, document_type, field_key);
CREATE INDEX IF NOT EXISTS idx_doc_relationships_project ON public.document_relationships USING btree (project_id);
CREATE INDEX IF NOT EXISTS project_validation_evidence_finding_id_idx ON public.project_validation_evidence USING btree (finding_id);
CREATE INDEX IF NOT EXISTS idx_validation_linked_action ON public.project_validation_findings USING btree (linked_action_id);
CREATE INDEX IF NOT EXISTS idx_validation_linked_decision ON public.project_validation_findings USING btree (linked_decision_id);
CREATE UNIQUE INDEX IF NOT EXISTS project_validation_findings_open_dedup_uniq ON public.project_validation_findings USING btree (project_id, check_key, status) WHERE (status = 'open'::text);
CREATE INDEX IF NOT EXISTS project_validation_findings_project_id_status_severity_idx ON public.project_validation_findings USING btree (project_id, status, severity);
CREATE INDEX IF NOT EXISTS project_validation_findings_run_id_idx ON public.project_validation_findings USING btree (run_id);
CREATE INDEX IF NOT EXISTS project_validation_runs_project_id_run_at_desc_idx ON public.project_validation_runs USING btree (project_id, run_at DESC);
CREATE INDEX IF NOT EXISTS idx_signals_scope ON public.signals USING btree (organization_id, signal_type, status, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS uq_shadow_mismatch_shape ON public.state_projection_shadow_mismatches USING btree (record_type, record_id, surface, legacy_value, persisted_value);
CREATE INDEX IF NOT EXISTS workflow_trigger_rules_org_active_idx ON public.workflow_trigger_rules USING btree (organization_id, is_active) WHERE (is_active = true);
CREATE INDEX IF NOT EXISTS workflow_trigger_rules_org_decision_type_idx ON public.workflow_trigger_rules USING btree (organization_id, decision_type);
CREATE INDEX IF NOT EXISTS workflow_trigger_rules_org_severity_idx ON public.workflow_trigger_rules USING btree (organization_id, severity);

-- ---------------------------------------------------------------------------
-- Row-level security and policies
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS approval_action_log_select_own_org ON public.approval_action_log;
DROP POLICY IF EXISTS approval_action_log_select_authenticated ON public.approval_action_log;
CREATE POLICY approval_action_log_select_authenticated ON public.approval_action_log FOR SELECT TO public
  USING (EXISTS (
    SELECT 1 FROM public.projects p
    WHERE p.id = approval_action_log.project_id AND p.organization_id = public.get_current_user_org_id()
  ));

-- Production has RLS enabled on document_relationships with no policies.
DROP POLICY IF EXISTS document_relationships_insert_authenticated ON public.document_relationships;
DROP POLICY IF EXISTS document_relationships_select_authenticated ON public.document_relationships;
DROP POLICY IF EXISTS document_relationships_update_authenticated ON public.document_relationships;

-- Production carries two identically-scoped policy sets on document_fact_overrides
-- (alongside the *_authenticated set); reproduced as-is.
DROP POLICY IF EXISTS dfo_insert_org_scope ON public.document_fact_overrides;
CREATE POLICY dfo_insert_org_scope ON public.document_fact_overrides FOR INSERT TO authenticated
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.user_profiles up
    WHERE up.id = auth.uid() AND up.organization_id = document_fact_overrides.organization_id
  ));
DROP POLICY IF EXISTS dfo_select_org_scope ON public.document_fact_overrides;
CREATE POLICY dfo_select_org_scope ON public.document_fact_overrides FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.user_profiles up
    WHERE up.id = auth.uid() AND up.organization_id = document_fact_overrides.organization_id
  ));
DROP POLICY IF EXISTS dfo_update_org_scope ON public.document_fact_overrides;
CREATE POLICY dfo_update_org_scope ON public.document_fact_overrides FOR UPDATE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.user_profiles up
    WHERE up.id = auth.uid() AND up.organization_id = document_fact_overrides.organization_id
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.user_profiles up
    WHERE up.id = auth.uid() AND up.organization_id = document_fact_overrides.organization_id
  ));
DROP POLICY IF EXISTS document_fact_overrides_insert_org_scope ON public.document_fact_overrides;
CREATE POLICY document_fact_overrides_insert_org_scope ON public.document_fact_overrides FOR INSERT TO authenticated
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.user_profiles up
    WHERE up.id = auth.uid() AND up.organization_id = document_fact_overrides.organization_id
  ));
DROP POLICY IF EXISTS document_fact_overrides_select_org_scope ON public.document_fact_overrides;
CREATE POLICY document_fact_overrides_select_org_scope ON public.document_fact_overrides FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.user_profiles up
    WHERE up.id = auth.uid() AND up.organization_id = document_fact_overrides.organization_id
  ));
DROP POLICY IF EXISTS document_fact_overrides_update_org_scope ON public.document_fact_overrides;
CREATE POLICY document_fact_overrides_update_org_scope ON public.document_fact_overrides FOR UPDATE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.user_profiles up
    WHERE up.id = auth.uid() AND up.organization_id = document_fact_overrides.organization_id
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.user_profiles up
    WHERE up.id = auth.uid() AND up.organization_id = document_fact_overrides.organization_id
  ));

DROP POLICY IF EXISTS project_validation_evidence_insert_authenticated ON public.project_validation_evidence;
DROP POLICY IF EXISTS project_validation_evidence_select_authenticated ON public.project_validation_evidence;
DROP POLICY IF EXISTS pve_evidence_delete_org ON public.project_validation_evidence;
CREATE POLICY pve_evidence_delete_org ON public.project_validation_evidence FOR DELETE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.user_profiles up
    WHERE up.id = auth.uid()
      AND up.organization_id = (
        SELECT p.organization_id FROM public.projects p
        WHERE p.id = (SELECT pvf.project_id FROM public.project_validation_findings pvf
                      WHERE pvf.id = project_validation_evidence.finding_id)
      )
  ));
DROP POLICY IF EXISTS pve_evidence_insert_org ON public.project_validation_evidence;
CREATE POLICY pve_evidence_insert_org ON public.project_validation_evidence FOR INSERT TO authenticated
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.user_profiles up
    WHERE up.id = auth.uid()
      AND up.organization_id = (
        SELECT p.organization_id FROM public.projects p
        WHERE p.id = (SELECT pvf.project_id FROM public.project_validation_findings pvf
                      WHERE pvf.id = project_validation_evidence.finding_id)
      )
  ));
DROP POLICY IF EXISTS pve_evidence_select_org ON public.project_validation_evidence;
CREATE POLICY pve_evidence_select_org ON public.project_validation_evidence FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.user_profiles up
    WHERE up.id = auth.uid()
      AND up.organization_id = (
        SELECT p.organization_id FROM public.projects p
        WHERE p.id = (SELECT pvf.project_id FROM public.project_validation_findings pvf
                      WHERE pvf.id = project_validation_evidence.finding_id)
      )
  ));
DROP POLICY IF EXISTS pve_evidence_update_org ON public.project_validation_evidence;
CREATE POLICY pve_evidence_update_org ON public.project_validation_evidence FOR UPDATE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.user_profiles up
    WHERE up.id = auth.uid()
      AND up.organization_id = (
        SELECT p.organization_id FROM public.projects p
        WHERE p.id = (SELECT pvf.project_id FROM public.project_validation_findings pvf
                      WHERE pvf.id = project_validation_evidence.finding_id)
      )
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.user_profiles up
    WHERE up.id = auth.uid()
      AND up.organization_id = (
        SELECT p.organization_id FROM public.projects p
        WHERE p.id = (SELECT pvf.project_id FROM public.project_validation_findings pvf
                      WHERE pvf.id = project_validation_evidence.finding_id)
      )
  ));

DROP POLICY IF EXISTS project_validation_findings_insert_authenticated ON public.project_validation_findings;
DROP POLICY IF EXISTS project_validation_findings_select_authenticated ON public.project_validation_findings;
DROP POLICY IF EXISTS project_validation_findings_update_authenticated ON public.project_validation_findings;
DROP POLICY IF EXISTS pvf_findings_delete_org ON public.project_validation_findings;
CREATE POLICY pvf_findings_delete_org ON public.project_validation_findings FOR DELETE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.user_profiles up
    WHERE up.id = auth.uid()
      AND up.organization_id = (SELECT p.organization_id FROM public.projects p WHERE p.id = project_validation_findings.project_id)
  ));
DROP POLICY IF EXISTS pvf_findings_insert_org ON public.project_validation_findings;
CREATE POLICY pvf_findings_insert_org ON public.project_validation_findings FOR INSERT TO authenticated
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.user_profiles up
    WHERE up.id = auth.uid()
      AND up.organization_id = (SELECT p.organization_id FROM public.projects p WHERE p.id = project_validation_findings.project_id)
  ));
DROP POLICY IF EXISTS pvf_findings_select_org ON public.project_validation_findings;
CREATE POLICY pvf_findings_select_org ON public.project_validation_findings FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.user_profiles up
    WHERE up.id = auth.uid()
      AND up.organization_id = (SELECT p.organization_id FROM public.projects p WHERE p.id = project_validation_findings.project_id)
  ));
DROP POLICY IF EXISTS pvf_findings_update_org ON public.project_validation_findings;
CREATE POLICY pvf_findings_update_org ON public.project_validation_findings FOR UPDATE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.user_profiles up
    WHERE up.id = auth.uid()
      AND up.organization_id = (SELECT p.organization_id FROM public.projects p WHERE p.id = project_validation_findings.project_id)
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.user_profiles up
    WHERE up.id = auth.uid()
      AND up.organization_id = (SELECT p.organization_id FROM public.projects p WHERE p.id = project_validation_findings.project_id)
  ));

DROP POLICY IF EXISTS project_validation_rule_state_insert_authenticated ON public.project_validation_rule_state;
DROP POLICY IF EXISTS project_validation_rule_state_select_authenticated ON public.project_validation_rule_state;
DROP POLICY IF EXISTS project_validation_rule_state_update_authenticated ON public.project_validation_rule_state;
DROP POLICY IF EXISTS pvr_state_delete_org ON public.project_validation_rule_state;
CREATE POLICY pvr_state_delete_org ON public.project_validation_rule_state FOR DELETE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.user_profiles up
    WHERE up.id = auth.uid()
      AND up.organization_id = (SELECT p.organization_id FROM public.projects p WHERE p.id = project_validation_rule_state.project_id)
  ));
DROP POLICY IF EXISTS pvr_state_insert_org ON public.project_validation_rule_state;
CREATE POLICY pvr_state_insert_org ON public.project_validation_rule_state FOR INSERT TO authenticated
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.user_profiles up
    WHERE up.id = auth.uid()
      AND up.organization_id = (SELECT p.organization_id FROM public.projects p WHERE p.id = project_validation_rule_state.project_id)
  ));
DROP POLICY IF EXISTS pvr_state_select_org ON public.project_validation_rule_state;
CREATE POLICY pvr_state_select_org ON public.project_validation_rule_state FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.user_profiles up
    WHERE up.id = auth.uid()
      AND up.organization_id = (SELECT p.organization_id FROM public.projects p WHERE p.id = project_validation_rule_state.project_id)
  ));
DROP POLICY IF EXISTS pvr_state_update_org ON public.project_validation_rule_state;
CREATE POLICY pvr_state_update_org ON public.project_validation_rule_state FOR UPDATE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.user_profiles up
    WHERE up.id = auth.uid()
      AND up.organization_id = (SELECT p.organization_id FROM public.projects p WHERE p.id = project_validation_rule_state.project_id)
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.user_profiles up
    WHERE up.id = auth.uid()
      AND up.organization_id = (SELECT p.organization_id FROM public.projects p WHERE p.id = project_validation_rule_state.project_id)
  ));

DROP POLICY IF EXISTS project_validation_runs_insert_authenticated ON public.project_validation_runs;
DROP POLICY IF EXISTS project_validation_runs_select_authenticated ON public.project_validation_runs;
DROP POLICY IF EXISTS project_validation_runs_update_authenticated ON public.project_validation_runs;
DROP POLICY IF EXISTS pvr_runs_delete_org ON public.project_validation_runs;
CREATE POLICY pvr_runs_delete_org ON public.project_validation_runs FOR DELETE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.user_profiles up
    WHERE up.id = auth.uid()
      AND up.organization_id = (SELECT p.organization_id FROM public.projects p WHERE p.id = project_validation_runs.project_id)
  ));
DROP POLICY IF EXISTS pvr_runs_insert_org ON public.project_validation_runs;
CREATE POLICY pvr_runs_insert_org ON public.project_validation_runs FOR INSERT TO authenticated
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.user_profiles up
    WHERE up.id = auth.uid()
      AND up.organization_id = (SELECT p.organization_id FROM public.projects p WHERE p.id = project_validation_runs.project_id)
  ));
DROP POLICY IF EXISTS pvr_runs_select_org ON public.project_validation_runs;
CREATE POLICY pvr_runs_select_org ON public.project_validation_runs FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.user_profiles up
    WHERE up.id = auth.uid()
      AND up.organization_id = (SELECT p.organization_id FROM public.projects p WHERE p.id = project_validation_runs.project_id)
  ));
DROP POLICY IF EXISTS pvr_runs_update_org ON public.project_validation_runs;
CREATE POLICY pvr_runs_update_org ON public.project_validation_runs FOR UPDATE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.user_profiles up
    WHERE up.id = auth.uid()
      AND up.organization_id = (SELECT p.organization_id FROM public.projects p WHERE p.id = project_validation_runs.project_id)
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.user_profiles up
    WHERE up.id = auth.uid()
      AND up.organization_id = (SELECT p.organization_id FROM public.projects p WHERE p.id = project_validation_runs.project_id)
  ));

ALTER TABLE public.workflow_trigger_rules ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workflow_trigger_rules_insert_org ON public.workflow_trigger_rules;
CREATE POLICY workflow_trigger_rules_insert_org ON public.workflow_trigger_rules FOR INSERT TO authenticated
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.user_profiles up
    WHERE up.id = auth.uid() AND up.organization_id = workflow_trigger_rules.organization_id
  ));
DROP POLICY IF EXISTS workflow_trigger_rules_select_org ON public.workflow_trigger_rules;
CREATE POLICY workflow_trigger_rules_select_org ON public.workflow_trigger_rules FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.user_profiles up
    WHERE up.id = auth.uid() AND up.organization_id = workflow_trigger_rules.organization_id
  ));
DROP POLICY IF EXISTS workflow_trigger_rules_update_org ON public.workflow_trigger_rules;
CREATE POLICY workflow_trigger_rules_update_org ON public.workflow_trigger_rules FOR UPDATE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.user_profiles up
    WHERE up.id = auth.uid() AND up.organization_id = workflow_trigger_rules.organization_id
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.user_profiles up
    WHERE up.id = auth.uid() AND up.organization_id = workflow_trigger_rules.organization_id
  ));

-- ---------------------------------------------------------------------------
-- Triggers (production keeps only the tr_project_validation_*_updated_at set)
-- ---------------------------------------------------------------------------

DROP TRIGGER IF EXISTS trg_contract_upload_guidance_updated_at ON public.contract_upload_guidance;
DROP TRIGGER IF EXISTS trg_project_validation_findings_updated_at ON public.project_validation_findings;
DROP TRIGGER IF EXISTS trg_project_validation_rule_state_updated_at ON public.project_validation_rule_state;
DROP TRIGGER IF EXISTS trg_project_validation_runs_updated_at ON public.project_validation_runs;

DROP TRIGGER IF EXISTS trg_workflow_trigger_rules_set_updated_at ON public.workflow_trigger_rules;
CREATE TRIGGER trg_workflow_trigger_rules_set_updated_at
  BEFORE UPDATE ON public.workflow_trigger_rules
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
