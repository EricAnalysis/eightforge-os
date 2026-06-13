-- Migration: add_project_id_to_decisions_and_tasks
-- Adds a direct project_id FK to decisions and workflow_tasks, backfills from
-- the existing document→project link, and creates partial indexes for direct
-- project-scoped reads.
--
-- Before this migration, decisions/tasks were scoped to a project via a
-- two-hop join: decisions.document_id → documents.id → documents.project_id.
-- After this migration, project-scoped queries can filter by project_id
-- directly without joining through documents.
--
-- Backfill assumptions:
--   - decisions with document_id IS NOT NULL get project_id from documents.project_id.
--   - decisions with document_id IS NULL (no document link) are left with project_id NULL.
--     These are handled by the existing fallback query path in useProjectWorkspaceData.
--   - workflow_tasks are backfilled first from document_id, then from decision_id
--     (for tasks linked to decisions but not directly to documents).
--   - Tasks or decisions where the linked document has project_id NULL remain
--     unscoped (project_id NULL). These are an edge case: documents without a
--     project assignment at time of backfill.
--
-- This migration is idempotent: ADD COLUMN IF NOT EXISTS and CREATE INDEX IF NOT EXISTS.

-- ── decisions ─────────────────────────────────────────────────────────────────

ALTER TABLE public.decisions
  ADD COLUMN IF NOT EXISTS project_id uuid REFERENCES public.projects(id);

-- Backfill: resolve project_id from the linked document.
UPDATE public.decisions dec
SET project_id = d.project_id
FROM public.documents d
WHERE dec.document_id = d.id
  AND dec.project_id IS NULL
  AND d.project_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_decisions_project_id
  ON public.decisions (project_id)
  WHERE project_id IS NOT NULL;

-- ── workflow_tasks ─────────────────────────────────────────────────────────────

ALTER TABLE public.workflow_tasks
  ADD COLUMN IF NOT EXISTS project_id uuid REFERENCES public.projects(id);

-- Backfill pass 1: from document link.
UPDATE public.workflow_tasks wt
SET project_id = d.project_id
FROM public.documents d
WHERE wt.document_id = d.id
  AND wt.project_id IS NULL
  AND d.project_id IS NOT NULL;

-- Backfill pass 2: from decision link (tasks linked to a decision but not
-- directly to a document, or where the document had no project_id).
UPDATE public.workflow_tasks wt
SET project_id = dec.project_id
FROM public.decisions dec
WHERE wt.decision_id = dec.id
  AND wt.project_id IS NULL
  AND dec.project_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_workflow_tasks_project_id
  ON public.workflow_tasks (project_id)
  WHERE project_id IS NOT NULL;
