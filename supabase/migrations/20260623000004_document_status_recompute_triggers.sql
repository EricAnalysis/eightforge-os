-- ============================================================
-- Phase B follow-up: cross-table recompute triggers for documents.operational_status
-- ============================================================
-- documents.operational_status was introduced in 20260623000001 and is
-- maintained on documents.processing_status changes by the existing trigger.
-- This migration adds the missing related-table triggers so cross-table
-- state changes cannot leave the persisted status stale.
--
-- Covered dependency graph:
--   document_reviews:
--     document_id, status, reviewed_at, updated_at
--   decisions:
--     document_id, status, severity, details
--   workflow_tasks:
--     document_id, decision_id, status, source_metadata
--   project_validation_findings:
--     project_id, status, severity, linked_decision_id, linked_action_id
--   project_validation_evidence:
--     finding_id, source_document_id
--   execution_items:
--     project_id, source_type, source_id, severity, status, outcome
--
-- Finding and execution-item rows are project-scoped. They resolve to
-- documents through project_validation_evidence.source_document_id when
-- available; otherwise the migration recomputes all documents in the affected
-- project. That fallback is intentionally conservative and acceptable for the
-- current Williamson-scale project document counts.
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_document_reviews_document_reviewed_at
  ON public.document_reviews (document_id, reviewed_at DESC, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_project_validation_evidence_source_document
  ON public.project_validation_evidence (source_document_id, finding_id)
  WHERE source_document_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_project_validation_findings_linked_decision
  ON public.project_validation_findings (linked_decision_id)
  WHERE linked_decision_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_project_validation_findings_linked_action
  ON public.project_validation_findings (linked_action_id)
  WHERE linked_action_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.compute_document_operational_status_full(
  p_processing_status text,
  p_review_status text DEFAULT 'not_reviewed',
  p_reviewed_at timestamptz DEFAULT NULL,
  p_processed_at timestamptz DEFAULT NULL,
  p_unresolved_finding_count integer DEFAULT 0,
  p_pending_action_count integer DEFAULT 0,
  p_blocked_count integer DEFAULT 0,
  p_missing_support_count integer DEFAULT 0,
  p_extraction_follow_up_required boolean DEFAULT false
) RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  WITH normalized AS (
    SELECT
      coalesce(p_processing_status, 'unknown') AS processing_status,
      coalesce(p_review_status, 'not_reviewed') AS review_status,
      greatest(coalesce(p_unresolved_finding_count, 0), 0) AS unresolved_finding_count,
      greatest(coalesce(p_pending_action_count, 0), 0) AS pending_action_count,
      greatest(coalesce(p_blocked_count, 0), 0) AS blocked_count,
      greatest(coalesce(p_missing_support_count, 0), 0) AS missing_support_count,
      coalesce(p_extraction_follow_up_required, false) AS extraction_follow_up_required
  ),
  derived AS (
    SELECT
      *,
      (
        unresolved_finding_count > 0
        OR pending_action_count > 0
        OR missing_support_count > 0
        OR blocked_count > 0
      ) AS unresolved_work_remaining,
      (
        review_status = 'approved'
        AND p_reviewed_at IS NOT NULL
        AND p_processed_at IS NOT NULL
        AND p_processed_at > p_reviewed_at
      ) AS stale_reviewed_extraction
    FROM normalized
  ),
  status_flags AS (
    SELECT
      *,
      (
        review_status IN ('needs_correction', 'in_review')
        OR stale_reviewed_extraction
        OR extraction_follow_up_required
        OR (review_status != 'approved' AND unresolved_work_remaining)
      ) AS needs_ledger_review
    FROM derived
  )
  SELECT CASE
    WHEN processing_status = 'failed' THEN 'Failed'
    WHEN blocked_count > 0 THEN 'Blocked'
    WHEN needs_ledger_review THEN 'Needs review'
    WHEN review_status = 'approved' AND unresolved_work_remaining AND NOT needs_ledger_review THEN 'Warning'
    WHEN review_status = 'approved' THEN 'Reviewed'
    WHEN processing_status = 'processing' THEN 'Processing'
    WHEN processing_status = 'extracted' THEN 'Extracted'
    WHEN processing_status = 'decisioned' THEN 'Operationally clear'
    ELSE initcap(replace(processing_status, '_', ' '))
  END
  FROM status_flags;
$$;

CREATE OR REPLACE FUNCTION public.compute_document_operational_status_simple(
  p_processing_status text,
  p_review_status text DEFAULT 'not_reviewed',
  p_reviewed_at timestamptz DEFAULT NULL,
  p_processed_at timestamptz DEFAULT NULL
) RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT public.compute_document_operational_status_full(
    p_processing_status,
    p_review_status,
    p_reviewed_at,
    p_processed_at,
    0,
    0,
    0,
    0,
    false
  );
$$;

CREATE OR REPLACE FUNCTION public.compute_document_operational_status_for_document(
  p_document_id uuid
) RETURNS text
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_document record;
  v_review_status text := 'not_reviewed';
  v_reviewed_at timestamptz := NULL;
  v_open_decision_count integer := 0;
  v_open_finding_count integer := 0;
  v_pending_task_count integer := 0;
  v_open_execution_item_count integer := 0;
  v_blocked_decision_count integer := 0;
  v_blocked_task_count integer := 0;
  v_blocked_execution_item_count integer := 0;
  v_missing_support_decision_count integer := 0;
  v_trace_decision_count integer := 0;
  v_trace_task_count integer := 0;
  v_trace_blocked_count integer := 0;
  v_trace_missing_support_count integer := 0;
  v_extraction_follow_up_required boolean := false;
  v_trace_decisions jsonb := '[]'::jsonb;
  v_trace_tasks jsonb := '[]'::jsonb;
  v_trace_extraction_gaps jsonb := '[]'::jsonb;
BEGIN
  SELECT id, processing_status, processed_at, intelligence_trace
  INTO v_document
  FROM public.documents
  WHERE id = p_document_id;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT status, reviewed_at
  INTO v_review_status, v_reviewed_at
  FROM public.document_reviews
  WHERE document_id = p_document_id
  ORDER BY reviewed_at DESC NULLS LAST, updated_at DESC NULLS LAST
  LIMIT 1;

  SELECT
    count(*)::integer,
    count(*) FILTER (
      WHERE coalesce(details->>'family', '') = 'mismatch'
        OR severity = 'critical'
    )::integer,
    count(*) FILTER (
      WHERE coalesce(details->>'family', '') = 'missing'
        OR jsonb_typeof(details->'missing_source_context') = 'array'
           AND jsonb_array_length(details->'missing_source_context') > 0
    )::integer
  INTO v_open_decision_count, v_blocked_decision_count, v_missing_support_decision_count
  FROM public.decisions
  WHERE document_id = p_document_id
    AND status IN ('open', 'in_review')
    AND coalesce(details->>'superseded_at', '') = '';

  SELECT count(DISTINCT f.id)::integer
  INTO v_open_finding_count
  FROM public.project_validation_findings f
  JOIN public.project_validation_evidence e ON e.finding_id = f.id
  WHERE e.source_document_id = p_document_id
    AND f.status = 'open';

  SELECT
    count(DISTINCT wt.id)::integer,
    count(DISTINCT wt.id) FILTER (WHERE wt.status = 'blocked')::integer
  INTO v_pending_task_count, v_blocked_task_count
  FROM public.workflow_tasks wt
  LEFT JOIN public.decisions d ON d.id = wt.decision_id
  WHERE coalesce(wt.source_metadata->>'superseded_at', '') = ''
    AND wt.status IN ('open', 'in_progress', 'blocked')
    AND (
      wt.document_id = p_document_id
      OR (wt.document_id IS NULL AND d.document_id = p_document_id)
    );

  SELECT
    count(DISTINCT ei.id)::integer,
    count(DISTINCT ei.id) FILTER (
      WHERE ei.status = 'open'
        OR (ei.status != 'resolved' AND ei.severity = 'critical')
    )::integer
  INTO v_open_execution_item_count, v_blocked_execution_item_count
  FROM public.execution_items ei
  JOIN public.project_validation_findings f
    ON ei.source_type = 'validator_finding'
   AND ei.source_id = f.id
  JOIN public.project_validation_evidence e ON e.finding_id = f.id
  WHERE e.source_document_id = p_document_id
    AND ei.status != 'resolved';

  IF v_document.intelligence_trace IS NOT NULL
     AND jsonb_typeof(v_document.intelligence_trace) = 'object' THEN
    v_trace_decisions := CASE
      WHEN jsonb_typeof(v_document.intelligence_trace->'decisions') = 'array'
      THEN v_document.intelligence_trace->'decisions'
      ELSE '[]'::jsonb
    END;
    v_trace_tasks := CASE
      WHEN jsonb_typeof(v_document.intelligence_trace->'flow_tasks') = 'array'
      THEN v_document.intelligence_trace->'flow_tasks'
      ELSE '[]'::jsonb
    END;
    v_trace_extraction_gaps := CASE
      WHEN jsonb_typeof(v_document.intelligence_trace->'extraction_gaps') = 'array'
      THEN v_document.intelligence_trace->'extraction_gaps'
      ELSE '[]'::jsonb
    END;

    SELECT count(*)::integer
    INTO v_trace_decision_count
    FROM jsonb_array_elements(v_trace_decisions) AS decision(value)
    WHERE coalesce(value->>'family', '') != 'confirmed'
      AND coalesce(value->>'id', '') != ''
      AND NOT EXISTS (
        SELECT 1
        FROM public.decisions d
        WHERE d.id::text = value->>'id'
      );

    SELECT count(*)::integer
    INTO v_trace_task_count
    FROM jsonb_array_elements(v_trace_tasks) AS task(value)
    WHERE coalesce(value->>'id', '') != ''
      AND NOT EXISTS (
        SELECT 1
        FROM public.workflow_tasks wt
        WHERE wt.id::text = value->>'id'
      );

    SELECT count(*)::integer
    INTO v_trace_blocked_count
    FROM jsonb_array_elements(v_trace_decisions) AS decision(value)
    WHERE value->>'family' = 'mismatch'
      AND coalesce(value->>'id', '') != ''
      AND NOT EXISTS (
        SELECT 1
        FROM public.decisions d
        WHERE d.id::text = value->>'id'
      );

    SELECT count(*)::integer
    INTO v_trace_missing_support_count
    FROM jsonb_array_elements(v_trace_decisions) AS decision(value)
    WHERE coalesce(value->>'id', '') != ''
      AND NOT EXISTS (
        SELECT 1
        FROM public.decisions d
        WHERE d.id::text = value->>'id'
      )
      AND (
        value->>'family' = 'missing'
        OR jsonb_typeof(value->'missing_source_context') = 'array'
           AND jsonb_array_length(value->'missing_source_context') > 0
      );

    SELECT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(v_trace_extraction_gaps) AS gap(value)
      WHERE value->>'severity' IN ('warning', 'critical')
    )
    INTO v_extraction_follow_up_required;
  END IF;

  RETURN public.compute_document_operational_status_full(
    v_document.processing_status,
    coalesce(v_review_status, 'not_reviewed'),
    v_reviewed_at,
    v_document.processed_at,
    v_open_finding_count + v_open_decision_count + v_trace_decision_count,
    v_pending_task_count + v_open_execution_item_count + v_trace_task_count,
    v_blocked_decision_count + v_blocked_task_count + v_blocked_execution_item_count + v_trace_blocked_count,
    v_missing_support_decision_count + v_trace_missing_support_count,
    v_extraction_follow_up_required
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.recompute_document_operational_status(
  p_document_id uuid
) RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF p_document_id IS NULL THEN
    RETURN;
  END IF;

  UPDATE public.documents d
  SET operational_status = public.compute_document_operational_status_for_document(p_document_id)
  WHERE d.id = p_document_id
    AND d.operational_status IS DISTINCT FROM public.compute_document_operational_status_for_document(p_document_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.recompute_project_documents_operational_status(
  p_project_id uuid
) RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_document_id uuid;
BEGIN
  IF p_project_id IS NULL THEN
    RETURN;
  END IF;

  FOR v_document_id IN
    SELECT id
    FROM public.documents
    WHERE project_id = p_project_id
      AND deleted_at IS NULL
  LOOP
    PERFORM public.recompute_document_operational_status(v_document_id);
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.recompute_documents_for_validation_finding(
  p_finding_id uuid,
  p_project_id uuid DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_document_id uuid;
  v_recomputed_count integer := 0;
BEGIN
  IF p_finding_id IS NOT NULL THEN
    FOR v_document_id IN
      SELECT DISTINCT source_document_id
      FROM public.project_validation_evidence
      WHERE finding_id = p_finding_id
        AND source_document_id IS NOT NULL
    LOOP
      PERFORM public.recompute_document_operational_status(v_document_id);
      v_recomputed_count := v_recomputed_count + 1;
    END LOOP;

    FOR v_document_id IN
      SELECT DISTINCT d.document_id
      FROM public.project_validation_findings f
      JOIN public.decisions d ON d.id = f.linked_decision_id
      WHERE f.id = p_finding_id
        AND d.document_id IS NOT NULL
    LOOP
      PERFORM public.recompute_document_operational_status(v_document_id);
      v_recomputed_count := v_recomputed_count + 1;
    END LOOP;

    FOR v_document_id IN
      SELECT DISTINCT e.source_document_id
      FROM public.project_validation_findings f
      JOIN public.execution_items ei ON ei.id = f.linked_action_id
      JOIN public.project_validation_findings source_f
        ON ei.source_type = 'validator_finding'
       AND ei.source_id = source_f.id
      JOIN public.project_validation_evidence e ON e.finding_id = source_f.id
      WHERE f.id = p_finding_id
        AND e.source_document_id IS NOT NULL
    LOOP
      PERFORM public.recompute_document_operational_status(v_document_id);
      v_recomputed_count := v_recomputed_count + 1;
    END LOOP;
  END IF;

  IF v_recomputed_count = 0 THEN
    PERFORM public.recompute_project_documents_operational_status(p_project_id);
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.trg_recompute_document_status_from_review()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    PERFORM public.recompute_document_operational_status(OLD.document_id);
  END IF;

  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    PERFORM public.recompute_document_operational_status(NEW.document_id);
  END IF;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS tr_recompute_document_status_from_review ON public.document_reviews;
DROP TRIGGER IF EXISTS tr_recompute_document_status_from_review_delete ON public.document_reviews;
CREATE TRIGGER tr_recompute_document_status_from_review
  AFTER INSERT OR UPDATE OF document_id, status, reviewed_at, updated_at
  ON public.document_reviews
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_recompute_document_status_from_review();
CREATE TRIGGER tr_recompute_document_status_from_review_delete
  AFTER DELETE
  ON public.document_reviews
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_recompute_document_status_from_review();

CREATE OR REPLACE FUNCTION public.trg_recompute_document_status_from_decision()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    PERFORM public.recompute_document_operational_status(OLD.document_id);
  END IF;

  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    PERFORM public.recompute_document_operational_status(NEW.document_id);
  END IF;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS tr_recompute_document_status_from_decision ON public.decisions;
DROP TRIGGER IF EXISTS tr_recompute_document_status_from_decision_delete ON public.decisions;
CREATE TRIGGER tr_recompute_document_status_from_decision
  AFTER INSERT OR UPDATE OF document_id, status, severity, details
  ON public.decisions
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_recompute_document_status_from_decision();
CREATE TRIGGER tr_recompute_document_status_from_decision_delete
  AFTER DELETE
  ON public.decisions
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_recompute_document_status_from_decision();

CREATE OR REPLACE FUNCTION public.trg_recompute_document_status_from_workflow_task()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_old_decision_document_id uuid;
  v_new_decision_document_id uuid;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    PERFORM public.recompute_document_operational_status(OLD.document_id);

    IF OLD.decision_id IS NOT NULL THEN
      SELECT document_id INTO v_old_decision_document_id
      FROM public.decisions
      WHERE id = OLD.decision_id;

      PERFORM public.recompute_document_operational_status(v_old_decision_document_id);
    END IF;
  END IF;

  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    PERFORM public.recompute_document_operational_status(NEW.document_id);

    IF NEW.decision_id IS NOT NULL THEN
      SELECT document_id INTO v_new_decision_document_id
      FROM public.decisions
      WHERE id = NEW.decision_id;

      PERFORM public.recompute_document_operational_status(v_new_decision_document_id);
    END IF;
  END IF;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS tr_recompute_document_status_from_workflow_task ON public.workflow_tasks;
DROP TRIGGER IF EXISTS tr_recompute_document_status_from_workflow_task_delete ON public.workflow_tasks;
CREATE TRIGGER tr_recompute_document_status_from_workflow_task
  AFTER INSERT OR UPDATE OF document_id, decision_id, status, source_metadata
  ON public.workflow_tasks
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_recompute_document_status_from_workflow_task();
CREATE TRIGGER tr_recompute_document_status_from_workflow_task_delete
  AFTER DELETE
  ON public.workflow_tasks
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_recompute_document_status_from_workflow_task();

CREATE OR REPLACE FUNCTION public.trg_recompute_document_status_from_finding()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    PERFORM public.recompute_documents_for_validation_finding(OLD.id, OLD.project_id);
  END IF;

  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    PERFORM public.recompute_documents_for_validation_finding(NEW.id, NEW.project_id);
  END IF;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS tr_recompute_document_status_from_finding ON public.project_validation_findings;
DROP TRIGGER IF EXISTS tr_recompute_document_status_from_finding_delete ON public.project_validation_findings;
CREATE TRIGGER tr_recompute_document_status_from_finding
  AFTER INSERT OR UPDATE OF project_id, status, severity, linked_decision_id, linked_action_id
  ON public.project_validation_findings
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_recompute_document_status_from_finding();
CREATE TRIGGER tr_recompute_document_status_from_finding_delete
  AFTER DELETE
  ON public.project_validation_findings
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_recompute_document_status_from_finding();

CREATE OR REPLACE FUNCTION public.trg_recompute_document_status_from_finding_evidence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_old_project_id uuid;
  v_new_project_id uuid;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    SELECT project_id INTO v_old_project_id
    FROM public.project_validation_findings
    WHERE id = OLD.finding_id;

    PERFORM public.recompute_document_operational_status(OLD.source_document_id);
    PERFORM public.recompute_documents_for_validation_finding(OLD.finding_id, v_old_project_id);
  END IF;

  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    SELECT project_id INTO v_new_project_id
    FROM public.project_validation_findings
    WHERE id = NEW.finding_id;

    PERFORM public.recompute_document_operational_status(NEW.source_document_id);
    PERFORM public.recompute_documents_for_validation_finding(NEW.finding_id, v_new_project_id);
  END IF;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS tr_recompute_document_status_from_finding_evidence ON public.project_validation_evidence;
DROP TRIGGER IF EXISTS tr_recompute_document_status_from_finding_evidence_delete ON public.project_validation_evidence;
CREATE TRIGGER tr_recompute_document_status_from_finding_evidence
  AFTER INSERT OR UPDATE OF finding_id, source_document_id
  ON public.project_validation_evidence
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_recompute_document_status_from_finding_evidence();
CREATE TRIGGER tr_recompute_document_status_from_finding_evidence_delete
  AFTER DELETE
  ON public.project_validation_evidence
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_recompute_document_status_from_finding_evidence();

CREATE OR REPLACE FUNCTION public.trg_recompute_document_status_from_execution_item()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    IF OLD.source_type = 'validator_finding' THEN
      PERFORM public.recompute_documents_for_validation_finding(OLD.source_id, OLD.project_id);
    ELSE
      PERFORM public.recompute_project_documents_operational_status(OLD.project_id);
    END IF;
  END IF;

  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    IF NEW.source_type = 'validator_finding' THEN
      PERFORM public.recompute_documents_for_validation_finding(NEW.source_id, NEW.project_id);
    ELSE
      PERFORM public.recompute_project_documents_operational_status(NEW.project_id);
    END IF;
  END IF;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS tr_recompute_document_status_from_execution_item ON public.execution_items;
DROP TRIGGER IF EXISTS tr_recompute_document_status_from_execution_item_delete ON public.execution_items;
CREATE TRIGGER tr_recompute_document_status_from_execution_item
  AFTER INSERT OR UPDATE OF project_id, source_type, source_id, severity, status, outcome
  ON public.execution_items
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_recompute_document_status_from_execution_item();
CREATE TRIGGER tr_recompute_document_status_from_execution_item_delete
  AFTER DELETE
  ON public.execution_items
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_recompute_document_status_from_execution_item();
