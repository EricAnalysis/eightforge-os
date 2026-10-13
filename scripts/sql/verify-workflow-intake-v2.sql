\set ON_ERROR_STOP on
-- Disposable source fixtures; rollback keeps queue/race proofs independent.
BEGIN;
INSERT INTO public.workflow_intake_submissions (
  id, workflow_description, documents_involved, manual_checks,
  frequency_and_volume, exceptions, human_decisions
) VALUES ('93500000-0000-4000-8000-000000000001', 'Original invoice review',
  'Original contracts', 'Original checks', 'Weekly', 'Escalate', 'Approve');
INSERT INTO public.workflow_intake_submissions (
  id, schema_version, workflow_description, information_or_systems, manual_checks,
  frequency_and_volume, exceptions, human_decisions, success_outcome
) VALUES ('93500000-0000-4000-8000-000000000002', 'workflow_intake_v2',
  'Compare customer statuses', 'CRM and scheduling API', 'Compare statuses',
  'Every morning', 'Manager queue', 'Resolve ambiguous statuses', 'Correct system updated');

DO $$ DECLARE source record; BEGIN
  SELECT * INTO source FROM public.read_workflow_intake_submission('93500000-0000-4000-8000-000000000001');
  IF source.schema_version <> 'workflow_intake_v1' OR source.documents_involved <> 'Original contracts'
    OR source.information_or_systems IS NOT NULL OR source.success_outcome IS NOT NULL THEN
    RAISE EXCEPTION 'v1 evidence or default changed';
  END IF;
  SELECT * INTO source FROM public.read_workflow_intake_submission('93500000-0000-4000-8000-000000000002');
  IF source.schema_version <> 'workflow_intake_v2' OR source.documents_involved IS NOT NULL
    OR source.information_or_systems <> 'CRM and scheduling API' OR source.success_outcome <> 'Correct system updated' THEN
    RAISE EXCEPTION 'v2 source did not round trip';
  END IF;
  BEGIN
    INSERT INTO public.workflow_intake_submissions (id, workflow_description, manual_checks, frequency_and_volume, exceptions, human_decisions)
    VALUES ('93500000-0000-4000-8000-000000000003', 'x', 'x', 'x', 'x', 'x');
    RAISE EXCEPTION 'v1 document requirement weakened';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    INSERT INTO public.workflow_intake_submissions (id, schema_version, workflow_description, information_or_systems, manual_checks, frequency_and_volume, exceptions, human_decisions)
    VALUES ('93500000-0000-4000-8000-000000000004', 'workflow_intake_v2', 'x', 'CRM', 'x', 'x', 'x', 'x');
    RAISE EXCEPTION 'v2 missing outcome accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    INSERT INTO public.workflow_intake_submissions (id, schema_version, workflow_description, information_or_systems, manual_checks, frequency_and_volume, exceptions, human_decisions, success_outcome)
    VALUES ('93500000-0000-4000-8000-000000000005', 'workflow_intake_v2', 'x', ' ', 'x', 'x', 'x', 'x', 'x');
    RAISE EXCEPTION 'v2 blank information accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    INSERT INTO public.workflow_intake_submissions (id, schema_version, workflow_description, information_or_systems, manual_checks, frequency_and_volume, exceptions, human_decisions, success_outcome)
    VALUES ('93500000-0000-4000-8000-000000000006', 'workflow_intake_v2', 'x', 'CRM', 'x', 'x', 'x', 'x', repeat('x',5001));
    RAISE EXCEPTION 'v2 oversized outcome accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    UPDATE public.workflow_intake_submissions SET documents_involved = 'changed' WHERE id = '93500000-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'v1 history mutated';
  EXCEPTION WHEN restrict_violation THEN NULL; END;
  BEGIN
    DELETE FROM public.workflow_intake_submissions WHERE id = '93500000-0000-4000-8000-000000000002';
    RAISE EXCEPTION 'v2 source deleted';
  EXCEPTION WHEN restrict_violation THEN NULL; END;
  IF has_function_privilege('anon', 'public.read_workflow_intake_submission(uuid)', 'EXECUTE')
    OR has_function_privilege('authenticated', 'public.read_workflow_intake_submission(uuid)', 'EXECUTE')
    OR NOT has_function_privilege('service_role', 'public.read_workflow_intake_submission(uuid)', 'EXECUTE')
    OR has_table_privilege('service_role', 'public.workflow_intake_submissions', 'SELECT')
    OR has_table_privilege('service_role', 'public.workflow_intake_submissions', 'UPDATE') THEN
    RAISE EXCEPTION 'intake access boundary changed';
  END IF;
END $$;
SET ROLE service_role;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.read_workflow_intake_submission('93500000-0000-4000-8000-000000000002') WHERE success_outcome = 'Correct system updated') THEN
    RAISE EXCEPTION 'service read cannot access v2';
  END IF;
  IF EXISTS (SELECT 1 FROM public.read_workflow_intake_submission('93500000-0000-4000-8000-000000000099')) THEN
    RAISE EXCEPTION 'known-id read returned unrelated rows';
  END IF;
END $$;
RESET ROLE;

-- A generalized proposal remains append-only and passes through the same human
-- review RPC. Operational context is a reviewable ADVISORY specification.
INSERT INTO public.workflow_assessments (
  id, source_submission_id, assessment_version, schema_version, assessment,
  assessment_digest_sha256, model, prompt_template_id, prompt_template_version
) VALUES (
  '93500000-0000-4000-8000-000000000102', '93500000-0000-4000-8000-000000000002',
  1, 'workflow_assessment_v2',
  '{"schemaVersion":"workflow_assessment_v2","sourceSubmissionSchemaVersion":"workflow_intake_v2","authority":"non_authoritative","requiresHumanReview":true,"workflowSteps":[{"stepId":"context","classification":"ADVISORY"}],"advisorySteps":[{"advisoryId":"operating-context","stepId":"context","description":"Reconcile CRM and scheduling each morning; success is correct customer statuses."}]}'::jsonb,
  repeat('d',64), 'none', 'b85-local-proof', 'v2'
);
SET ROLE service_role;
DO $$ DECLARE reviewed record; BEGIN
  SELECT * INTO reviewed FROM public.record_workflow_assessment_review(
    '93500000-0000-4000-8000-000000000102', 1,
    '93000000-0000-4000-8000-000000000001',
    '[{"assessment_step_id":"context","proposed_classification":"ADVISORY","reviewed_classification":"ADVISORY","disposition":"modified","reviewer_notes":"Human corrected frequency","accepted_specification":{"description":"Reconcile CRM and scheduling weekly; managers resolve ambiguity; success is correct statuses."}}]'::jsonb,
    'Reviewed operational context; no activation');
  IF NOT EXISTS (
    SELECT 1 FROM public.workflow_assessment_step_reviews
    WHERE review_id = reviewed.review_id AND disposition = 'modified'
      AND accepted_specification->>'description' = 'Reconcile CRM and scheduling weekly; managers resolve ambiguity; success is correct statuses.'
  ) THEN RAISE EXCEPTION 'v2 human-reviewed context did not persist'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.workflow_assessments
    WHERE id = '93500000-0000-4000-8000-000000000102'
      AND authority = 'non_authoritative' AND requires_human_review
      AND assessment->'advisorySteps'->0->>'description' = 'Reconcile CRM and scheduling each morning; success is correct customer statuses.'
  ) THEN RAISE EXCEPTION 'v2 review mutated provider proposal or authority'; END IF;
END $$;
RESET ROLE;
\echo B8.5 VERSIONED INTAKE AND REVIEW AUTHORITY: PASS
ROLLBACK;
