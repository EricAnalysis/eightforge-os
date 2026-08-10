-- P1 vocabulary only: record that one document row is a duplicate
-- representation of another without changing either document's lifecycle or
-- legal authority status. No source-hash infrastructure or data backfill is
-- introduced here.
ALTER TABLE public.document_relationships
  DROP CONSTRAINT IF EXISTS document_relationships_relationship_type_check;

ALTER TABLE public.document_relationships
  ADD CONSTRAINT document_relationships_relationship_type_check
  CHECK (
    relationship_type IN (
      'duplicate_of',
      'attached_to',
      'supplements',
      'amends',
      'supersedes',
      'governs',
      'replaces',
      'supports',
      'applies_to'
    )
  );
