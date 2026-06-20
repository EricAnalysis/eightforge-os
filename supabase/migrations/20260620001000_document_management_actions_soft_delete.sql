-- ============================================================================
-- MIGRATION: Document management actions soft delete support
-- Date: 2026-06-20
-- Purpose: Add scoped soft-delete marker for operator document removal.
-- Safety: Additive only. Does not modify existing rows.
-- ============================================================================

ALTER TABLE public.documents
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_documents_active_by_organization_created_at
  ON public.documents (organization_id, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_documents_active_by_project_created_at
  ON public.documents (project_id, created_at DESC)
  WHERE deleted_at IS NULL AND project_id IS NOT NULL;
