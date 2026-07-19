-- CS-17: restore the documents precedence objects that drifted from
-- 20260323000000_document_precedence (never applied to this database).
--
-- Only precedence_rank and operator_override_precedence existed (via the schema
-- baseline); document_role, authority_status and effective_date were absent, which is
-- why the isMissingDocumentPrecedenceColumnError fallback was load-bearing.
--
-- All three restored columns are nullable and start NULL, which is exactly what the
-- fallback path already yields downstream, so this is behaviour-preserving.
--
-- Type correction: the code contract treats operator_override_precedence as boolean
-- (declared `boolean | null`, written via Boolean(...)). All existing rows were NULL,
-- so the cast resolved every row to false with no data loss.
--
-- Scoped deliberately: this does NOT replay 20260430000000's activity_events
-- event-type check rewrite (later migrations expanded that list), and does NOT add
-- documents.document_subtype, which remains a separate scoped decision.

ALTER TABLE public.documents
  ADD COLUMN IF NOT EXISTS document_role text,
  ADD COLUMN IF NOT EXISTS authority_status text,
  ADD COLUMN IF NOT EXISTS effective_date date;

ALTER TABLE public.documents
  ALTER COLUMN operator_override_precedence DROP DEFAULT;

ALTER TABLE public.documents
  ALTER COLUMN operator_override_precedence TYPE boolean
  USING (COALESCE(operator_override_precedence, 0) <> 0);

ALTER TABLE public.documents
  ALTER COLUMN operator_override_precedence SET DEFAULT false;

ALTER TABLE public.documents
  ALTER COLUMN operator_override_precedence SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.check_constraints
    WHERE constraint_name = 'documents_document_role_check'
  ) THEN
    ALTER TABLE public.documents
      ADD CONSTRAINT documents_document_role_check
      CHECK (
        document_role IN (
          'base_contract',
          'contract_amendment',
          'rate_sheet',
          'permit',
          'ticket_export',
          'invoice',
          'invoice_revision',
          'supporting_attachment',
          'other'
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.check_constraints
    WHERE constraint_name = 'documents_authority_status_check'
  ) THEN
    ALTER TABLE public.documents
      ADD CONSTRAINT documents_authority_status_check
      CHECK (
        authority_status IN (
          'active',
          'superseded',
          'draft',
          'archived',
          'reference_only'
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.check_constraints
    WHERE constraint_name = 'documents_precedence_rank_nonnegative_check'
  ) THEN
    ALTER TABLE public.documents
      ADD CONSTRAINT documents_precedence_rank_nonnegative_check
      CHECK (precedence_rank IS NULL OR precedence_rank >= 0);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_documents_project_document_role
  ON public.documents (project_id, document_role)
  WHERE project_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_documents_project_authority_status
  ON public.documents (project_id, authority_status)
  WHERE project_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_documents_project_precedence_rank
  ON public.documents (project_id, precedence_rank)
  WHERE project_id IS NOT NULL AND precedence_rank IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_documents_project_effective_date
  ON public.documents (project_id, effective_date DESC)
  WHERE project_id IS NOT NULL AND effective_date IS NOT NULL;
