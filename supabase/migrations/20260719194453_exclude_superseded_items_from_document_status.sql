-- Keep document operational status on the same terminal interpretation as the
-- execution queue. Preserve the current live function body and surgically
-- extend its two execution-item predicates; fail rather than silently patching
-- an unexpected function definition.
DO $$
DECLARE
  function_definition text;
  updated_definition text;
  old_predicate constant text := 'ei.status != ''resolved''';
  new_predicate constant text := 'ei.status NOT IN (''resolved'', ''superseded'')';
  occurrence_count integer;
BEGIN
  SELECT pg_get_functiondef(
    'public.compute_document_operational_status_for_document(uuid)'::regprocedure
  )
  INTO function_definition;

  occurrence_count :=
    (length(function_definition) - length(replace(function_definition, old_predicate, '')))
    / length(old_predicate);

  IF occurrence_count != 2 THEN
    RAISE EXCEPTION
      'Expected 2 execution-item terminal predicates in compute_document_operational_status_for_document; found %',
      occurrence_count;
  END IF;

  updated_definition := replace(
    function_definition,
    old_predicate,
    new_predicate
  );
  EXECUTE updated_definition;
END $$;
