-- ============================================================
-- Phase B Step 2: Persist operational_status on documents
-- ============================================================
-- Codifies the output of resolveDocumentOperationalStatus()
-- (lib/documentOperationalStatus.ts) as a persisted column.
--
-- STOP CONDITION — Step 2c:
-- ProjectDocumentsForge.tsx uses an independent 4-state derivation:
--   failed        → 'Blocked'         (vs canonical 'Failed')
--   decisioned    → 'Governed'        (vs canonical 'Operationally clear')
--   has processed → 'Needs Review'    (vs canonical 'Extracted' / 'Needs review')
--   otherwise     → 'In Intake'       (vs canonical titleize(processingStatus))
-- These labels differ from the canonical resolver's output.
-- ProjectDocumentsForge.tsx is NOT switched to read from this column here.
-- It is flagged as a known divergence pending explicit operator approval.
--
-- BACKFILL STRATEGY:
-- The canonical resolver needs cross-table counts (decisions, workflow_tasks,
-- intelligence_trace) not available in a pure documents-table function.
-- The SQL function below captures the processing_status and review_status
-- dimensions accurately; the count-dependent states (blocked, needs_review
-- due to pending actions) require an application-side recompute.
-- After applying this migration, run the application backfill:
--   GET /api/admin/reset-stuck-documents  (or a dedicated backfill endpoint)
-- Then verify with the comparison query in docs/runbooks/phase-b-backfill.sql.
-- ============================================================

-- Add the column
ALTER TABLE public.documents
  ADD COLUMN IF NOT EXISTS operational_status text;

-- Simplified backfill function (processing_status + review dims only)
-- Captures: Failed, Processing, Extracted, Operationally clear, Reviewed, In Intake
-- Does NOT capture: Blocked (requires decision/task counts), Needs review (full)
CREATE OR REPLACE FUNCTION public.compute_document_operational_status_simple(
  p_processing_status text,
  p_review_status text DEFAULT 'not_reviewed',
  p_reviewed_at timestamptz DEFAULT NULL,
  p_processed_at timestamptz DEFAULT NULL
) RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN p_processing_status = 'failed'      THEN 'Failed'
    WHEN p_processing_status = 'decisioned'  THEN 'Operationally clear'
    WHEN p_review_status IN ('needs_correction', 'in_review') THEN 'Needs review'
    WHEN p_review_status = 'approved'
      AND p_reviewed_at IS NOT NULL
      AND p_processed_at IS NOT NULL
      AND p_processed_at > p_reviewed_at     THEN 'Needs review'  -- stale reviewed
    WHEN p_review_status = 'approved'        THEN 'Reviewed'
    WHEN p_processing_status = 'extracted'   THEN 'Extracted'
    WHEN p_processing_status = 'processing'  THEN 'Processing'
    ELSE initcap(replace(coalesce(p_processing_status, 'unknown'), '_', ' '))
  END;
$$;

-- Initial backfill using processing_status + most recent document_review
-- Count-dependent states (Blocked, Needs review from pending actions) require
-- application-side recompute after this seed pass.
UPDATE public.documents d
SET operational_status = public.compute_document_operational_status_simple(
  d.processing_status,
  COALESCE(
    (SELECT r.status
     FROM public.document_reviews r
     WHERE r.document_id = d.id
     ORDER BY r.reviewed_at DESC NULLS LAST, r.updated_at DESC
     LIMIT 1),
    'not_reviewed'
  ),
  (SELECT r.reviewed_at
   FROM public.document_reviews r
   WHERE r.document_id = d.id
   ORDER BY r.reviewed_at DESC NULLS LAST, r.updated_at DESC
   LIMIT 1),
  d.processed_at
)
WHERE operational_status IS NULL;

-- Trigger: keep operational_status current on processing_status changes.
-- Count-based inputs (blockedCount etc.) are still updated application-side.
CREATE OR REPLACE FUNCTION public.trg_documents_operational_status()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.operational_status := public.compute_document_operational_status_simple(
    NEW.processing_status,
    COALESCE(
      (SELECT r.status
       FROM public.document_reviews r
       WHERE r.document_id = NEW.id
       ORDER BY r.reviewed_at DESC NULLS LAST, r.updated_at DESC
       LIMIT 1),
      'not_reviewed'
    ),
    (SELECT r.reviewed_at
     FROM public.document_reviews r
     WHERE r.document_id = NEW.id
     ORDER BY r.reviewed_at DESC NULLS LAST, r.updated_at DESC
     LIMIT 1),
    NEW.processed_at
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tr_documents_operational_status ON public.documents;
CREATE TRIGGER tr_documents_operational_status
  BEFORE INSERT OR UPDATE OF processing_status, processed_at
  ON public.documents
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_documents_operational_status();
