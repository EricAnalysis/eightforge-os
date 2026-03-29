-- ============================================================================
-- MIGRATION: Rate schedule anchor extensions
-- Date: 2026-03-28
-- Purpose: Extend document_fact_anchors to support page-range and table-region
--          schedule definitions without affecting extraction logic.
-- ============================================================================

ALTER TABLE public.document_fact_anchors
  ADD COLUMN IF NOT EXISTS start_page integer,
  ADD COLUMN IF NOT EXISTS end_page integer;

UPDATE public.document_fact_anchors
SET
  start_page = COALESCE(start_page, page_number),
  end_page = COALESCE(end_page, page_number)
WHERE start_page IS NULL OR end_page IS NULL;

ALTER TABLE public.document_fact_anchors
  DROP CONSTRAINT IF EXISTS document_fact_anchors_anchor_type_check;

ALTER TABLE public.document_fact_anchors
  DROP CONSTRAINT IF EXISTS document_fact_anchors_start_end_page_check;

ALTER TABLE public.document_fact_anchors
  ADD CONSTRAINT document_fact_anchors_anchor_type_check
  CHECK (anchor_type IN ('text', 'region', 'page_range', 'table_region'));

ALTER TABLE public.document_fact_anchors
  ADD CONSTRAINT document_fact_anchors_start_end_page_check
  CHECK (
    start_page IS NULL OR
    (start_page >= 1 AND end_page IS NOT NULL AND end_page >= start_page)
  );
