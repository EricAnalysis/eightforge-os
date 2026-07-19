-- Restore documents.document_subtype, the remaining column that drifted from
-- 20260430000000_document_truth_governance_phase (never applied to this database).
--
-- The column is nullable and starts NULL for all existing rows; the check constraint
-- explicitly permits NULL, so this is safe on existing data. No query currently selects
-- document_subtype, so this is behaviour-neutral on its own: it makes the column
-- available so subtype resolution can be wired up, rather than changing it now.
--
-- Scoped deliberately: this does NOT replay the rest of 20260430000000. In particular it
-- leaves activity_events_event_type_check and
-- document_relationships_relationship_type_check untouched, because later migrations
-- expanded those allowed-value lists and replaying the April versions would reject
-- values that are now valid.

ALTER TABLE public.documents
  ADD COLUMN IF NOT EXISTS document_subtype text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE constraint_schema = 'public'
      AND table_name = 'documents'
      AND constraint_name = 'documents_document_subtype_check'
  ) THEN
    ALTER TABLE public.documents
      ADD CONSTRAINT documents_document_subtype_check
      CHECK (
        document_subtype IS NULL OR document_subtype IN (
          'base_contract',
          'pricing_schedule',
          'compliance_requirements',
          'amendment',
          'replacement_contract',
          'supporting_document',
          'invoice',
          'transaction_data',
          'reference'
        )
      );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_documents_project_document_subtype
  ON public.documents (project_id, document_subtype)
  WHERE project_id IS NOT NULL AND document_subtype IS NOT NULL;
