\set ON_ERROR_STOP on

-- Disposable fixtures only. The migration replay job owns and drops the DB.
INSERT INTO auth.users (id, email) VALUES
  ('93000000-0000-4000-8000-000000000001', 'workflow-db-proof@example.invalid');
INSERT INTO public.user_profiles (id, display_name, role) VALUES
  ('93000000-0000-4000-8000-000000000001', 'Workflow DB proof', 'owner');

INSERT INTO public.workflow_intake_submissions (
  id, workflow_description, documents_involved, manual_checks,
  frequency_and_volume, exceptions, human_decisions, submitted_at
) VALUES
  ('93000000-0000-4000-8000-000000000010','first claim','docs','checks','daily','none','review',now() - interval '10 minutes'),
  ('93000000-0000-4000-8000-000000000011','assessed','docs','checks','daily','none','review',now() - interval '9 minutes'),
  ('93000000-0000-4000-8000-000000000012','active','docs','checks','daily','none','review',now() - interval '8 minutes'),
  ('93000000-0000-4000-8000-000000000013','exhausted','docs','checks','daily','none','review',now() - interval '7 minutes'),
  ('93000000-0000-4000-8000-000000000014','excluded','docs','checks','daily','none','review',now() - interval '6 minutes'),
  ('93000000-0000-4000-8000-000000000015','later eligible','docs','checks','daily','none','review',now() - interval '5 minutes'),
  ('93000000-0000-4000-8000-000000000020','retry race','docs','checks','daily','none','review',now() - interval '4 minutes'),
  ('93000000-0000-4000-8000-000000000021','first race','docs','checks','daily','none','review',now() - interval '3 minutes'),
  ('93000000-0000-4000-8000-000000000022','sweep race','docs','checks','daily','none','review',now() - interval '2 minutes'),
  ('93000000-0000-4000-8000-000000000023','mixed race','docs','checks','daily','none','review',now() - interval '1 minute'),
  ('93000000-0000-4000-8000-000000000030','review source','docs','checks','daily','none','review',now());

-- Exact RPC executes and returns unambiguous committed columns.
SET ROLE service_role;
DO $$
DECLARE claimed record;
BEGIN
  SELECT * INTO claimed FROM public.claim_workflow_assessment_attempt(
    2, '93000000-0000-4000-8000-000000000010', NULL);
  IF claimed.source_submission_id <> '93000000-0000-4000-8000-000000000010'::uuid
    OR claimed.attempt_number <> 1 OR claimed.attempt_id IS NULL THEN
    RAISE EXCEPTION 'first claim returned incorrect values';
  END IF;
  PERFORM public.finalize_workflow_assessment_attempt(claimed.attempt_id, 'succeeded', NULL);
  IF NOT EXISTS (
    SELECT 1 FROM public.workflow_assessment_attempts
    WHERE id = claimed.attempt_id AND status = 'succeeded' AND completed_at IS NOT NULL
  ) THEN RAISE EXCEPTION 'successful finalization was not durable'; END IF;
END $$;
RESET ROLE;

-- A caller cannot widen the database-owned cap.
DO $$ BEGIN
  BEGIN
    PERFORM * FROM public.claim_workflow_assessment_attempt(
      3, '93000000-0000-4000-8000-000000000015', NULL);
    RAISE EXCEPTION 'caller-controlled cap unexpectedly accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
END $$;

-- Invalid immutable intake rows never become eligible coordination rows.
DO $$ BEGIN
  BEGIN
    INSERT INTO public.workflow_intake_submissions (
      id, workflow_description, documents_involved, manual_checks,
      frequency_and_volume, exceptions, human_decisions
    ) VALUES ('93000000-0000-4000-8000-00000000eeee',' ','docs','checks','daily','none','review');
    RAISE EXCEPTION 'blank required intake answer unexpectedly persisted';
  EXCEPTION WHEN check_violation THEN NULL; END;
END $$;
SET ROLE service_role;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.claim_workflow_assessment_attempt(
      2,'93000000-0000-4000-8000-00000000eeee',NULL))
    OR EXISTS (SELECT 1 FROM public.claim_workflow_assessment_attempt(
      2,'93000000-0000-4000-8000-00000000ffff',NULL)) THEN
    RAISE EXCEPTION 'invalid or missing intake unexpectedly claimed';
  END IF;
END $$;
RESET ROLE;

INSERT INTO public.workflow_assessments (
  id, source_submission_id, assessment_version, assessment,
  assessment_digest_sha256, model, prompt_template_id, prompt_template_version
) VALUES (
  '93000000-0000-4000-8000-000000000111',
  '93000000-0000-4000-8000-000000000011', 1, '{}'::jsonb,
  repeat('a',64), 'none', 'proof', '1'
);
INSERT INTO public.workflow_assessment_attempts
  (id, source_submission_id, attempt_number, status)
VALUES ('93000000-0000-4000-8000-000000000112','93000000-0000-4000-8000-000000000012',1,'claimed');
INSERT INTO public.workflow_assessment_attempts
  (id, source_submission_id, attempt_number, status, completed_at, failure_class)
VALUES
  ('93000000-0000-4000-8000-000000000113','93000000-0000-4000-8000-000000000013',1,'failed',now(),'proof'),
  ('93000000-0000-4000-8000-000000000114','93000000-0000-4000-8000-000000000013',2,'failed',now(),'proof');
DO $$
DECLARE cap_rejected boolean := false;
BEGIN
  BEGIN
    INSERT INTO public.workflow_assessment_attempts
      (source_submission_id, attempt_number, status, completed_at, failure_class)
    VALUES ('93000000-0000-4000-8000-000000000013',3,'failed',now(),'proof');
  EXCEPTION WHEN check_violation THEN cap_rejected := true;
  END;
  IF NOT cap_rejected THEN RAISE EXCEPTION 'attempt 3 constraint did not reject'; END IF;
END $$;

DO $$
DECLARE claimed record;
BEGIN
  SELECT * INTO claimed FROM public.claim_workflow_assessment_attempt(
    2, NULL, ARRAY[
      '93000000-0000-4000-8000-000000000010'::uuid,
      '93000000-0000-4000-8000-000000000014'::uuid
    ]);
  IF claimed.source_submission_id <> '93000000-0000-4000-8000-000000000015'::uuid THEN
    RAISE EXCEPTION 'assessed/active/exhausted/excluded selection safety failed: %', claimed;
  END IF;
END $$;

-- Finalization missing-row and terminal-row failures are explicit.
SET ROLE service_role;
DO $$
DECLARE active_id uuid;
  terminal_rejected boolean := false;
BEGIN
  BEGIN
    PERFORM public.finalize_workflow_assessment_attempt(
      '93000000-0000-4000-8000-000000000112', NULL, NULL);
    RAISE EXCEPTION 'null finalization status unexpectedly succeeded';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  BEGIN
    PERFORM public.finalize_workflow_assessment_attempt(
      '93000000-0000-4000-8000-00000000ffff', 'failed', 'proof');
    RAISE EXCEPTION 'missing finalization unexpectedly succeeded';
  EXCEPTION WHEN no_data_found THEN NULL;
  END;
  SELECT attempt_id INTO active_id FROM public.claim_workflow_assessment_attempt(
    2, '93000000-0000-4000-8000-000000000020', NULL);
  PERFORM public.finalize_workflow_assessment_attempt(active_id, 'failed', 'persist_failed');
  BEGIN
    PERFORM public.finalize_workflow_assessment_attempt(active_id, 'failed', 'again');
  EXCEPTION WHEN raise_exception THEN terminal_rejected := true;
  END;
  IF NOT terminal_rejected THEN
    RAISE EXCEPTION 'terminal finalization unexpectedly succeeded';
  END IF;
END $$;
RESET ROLE;

-- Review authority fixture: a complete historical RULE proposal.
INSERT INTO public.workflow_assessments (
  id, source_submission_id, assessment_version, assessment,
  assessment_digest_sha256, model, prompt_template_id, prompt_template_version
) VALUES (
  '93000000-0000-4000-8000-000000000130',
  '93000000-0000-4000-8000-000000000030', 1,
  jsonb_build_object(
    'workflowSteps', jsonb_build_array(jsonb_build_object('stepId','s1','classification','RULE')),
    'deterministicRuleProposals', jsonb_build_array(jsonb_build_object(
      'ruleId','r1','stepId','s1','plainLanguageRule','Compare the facts',
      'requiredFacts',jsonb_build_array('fact'), 'conditionType','comparison',
      'expectedEvidence',jsonb_build_array('evidence'), 'expectedOutcome','match',
      'userDescribedExceptions','[]'::jsonb, 'unresolvedAssumptions','[]'::jsonb
    )),
    'verificationRuleProposals','[]'::jsonb,'extractionRequirements','[]'::jsonb,
    'forgewingRecoveryTasks','[]'::jsonb,'humanDecisionPoints','[]'::jsonb,
    'advisorySteps','[]'::jsonb,'failureConsequences','[]'::jsonb
  ), repeat('b',64), 'none', 'proof', '1'
);

-- Every malformed raw specification must fail before parent/child persistence.
SET ROLE service_role;
DO $$
DECLARE before_parents bigint; before_children bigint;
BEGIN
  SELECT count(*) INTO before_parents FROM public.workflow_assessment_reviews;
  SELECT count(*) INTO before_children FROM public.workflow_assessment_step_reviews;
  BEGIN
    PERFORM * FROM public.record_workflow_assessment_review(
      '93000000-0000-4000-8000-000000000130',1,
      '93000000-0000-4000-8000-000000000001',
      '[{"assessment_step_id":"s1","proposed_classification":"RULE","reviewed_classification":null,"disposition":"rejected","accepted_specification":[]}]'::jsonb,NULL);
    RAISE EXCEPTION 'rejected array unexpectedly accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
  BEGIN
    PERFORM * FROM public.record_workflow_assessment_review(
      '93000000-0000-4000-8000-000000000130',1,
      '93000000-0000-4000-8000-000000000001',
      '[{"assessment_step_id":"s1","proposed_classification":"RULE","reviewed_classification":"RULE","disposition":"accepted","accepted_specification":42}]'::jsonb,NULL);
    RAISE EXCEPTION 'accepted scalar unexpectedly accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
  BEGIN
    PERFORM * FROM public.record_workflow_assessment_review(
      '93000000-0000-4000-8000-000000000130',1,
      '93000000-0000-4000-8000-000000000001',
      '[{"assessment_step_id":"s1","proposed_classification":"RULE","reviewed_classification":"RULE","disposition":"modified","accepted_specification":[]}]'::jsonb,NULL);
    RAISE EXCEPTION 'modified array unexpectedly accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
  BEGIN
    PERFORM * FROM public.record_workflow_assessment_review(
      '93000000-0000-4000-8000-000000000130',1,
      '93000000-0000-4000-8000-000000000001',
      '[{"assessment_step_id":"s1","proposed_classification":"RULE","reviewed_classification":"HUMAN","disposition":"reclassified","accepted_specification":"bad"}]'::jsonb,NULL);
    RAISE EXCEPTION 'reclassified scalar unexpectedly accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
  BEGIN
    PERFORM * FROM public.record_workflow_assessment_review(
      '93000000-0000-4000-8000-000000000130',1,
      '93000000-0000-4000-8000-000000000001',
      '[{"assessment_step_id":"s1","proposed_classification":"RULE","reviewed_classification":"RULE","disposition":"modified","accepted_specification":null}]'::jsonb,NULL);
    RAISE EXCEPTION 'JSON null unexpectedly accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
  IF (SELECT count(*) FROM public.workflow_assessment_reviews) <> before_parents
    OR (SELECT count(*) FROM public.workflow_assessment_step_reviews) <> before_children THEN
    RAISE EXCEPTION 'failed review was not atomic';
  END IF;
END $$;
RESET ROLE;

-- RULE/VERIFY parity and recursive executable-key closure at the DB boundary.
DO $$ BEGIN
  BEGIN
    PERFORM public.assert_workflow_reviewed_specification('s','modified','RULE',
      '{"plainLanguageRule":"r","requiredFacts":["f"],"conditionType":"comparison","expectedEvidence":["e"],"expectedOutcome":"o","unresolvedAssumptions":[]}'::jsonb);
    RAISE EXCEPTION 'RULE omission unexpectedly accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
  BEGIN
    PERFORM public.assert_workflow_reviewed_specification('s','modified','VERIFY',
      '{"plainLanguageRule":"r","requiredFacts":["f"],"conditionType":"comparison","expectedEvidence":["e"],"expectedOutcome":"o","userDescribedExceptions":[]}'::jsonb);
    RAISE EXCEPTION 'VERIFY omission unexpectedly accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
  BEGIN
    PERFORM public.assert_workflow_reviewed_specification('s','modified','HUMAN',
      '{"description":{"sql":"select 1"},"whyHumanControlled":"h"}'::jsonb);
    RAISE EXCEPTION 'recursive executable key unexpectedly accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
END $$;

-- Replace the stored assessment with incomplete historical detail is forbidden
-- by immutability, so use a second append-only row for the compatibility probe.
INSERT INTO public.workflow_intake_submissions (
  id, workflow_description, documents_involved, manual_checks,
  frequency_and_volume, exceptions, human_decisions
) VALUES ('93000000-0000-4000-8000-000000000031','historical','docs','checks','daily','none','review');
INSERT INTO public.workflow_assessments (
  id, source_submission_id, assessment_version, assessment,
  assessment_digest_sha256, model, prompt_template_id, prompt_template_version
) VALUES (
  '93000000-0000-4000-8000-000000000131','93000000-0000-4000-8000-000000000031',1,
  '{"workflowSteps":[{"stepId":"s1","classification":"RULE"}],"deterministicRuleProposals":[{"stepId":"s1","ruleId":"r1"}]}'::jsonb,
  repeat('c',64),'none','proof','1');
DO $$ BEGIN
  BEGIN
    PERFORM * FROM public.record_workflow_assessment_review(
      '93000000-0000-4000-8000-000000000131',1,
      '93000000-0000-4000-8000-000000000001',
      '[{"assessment_step_id":"s1","proposed_classification":"RULE","reviewed_classification":"RULE","disposition":"accepted"}]'::jsonb,NULL);
    RAISE EXCEPTION 'incomplete historical accepted proposal unexpectedly accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
  -- Complete replacement is self-contained and may safely supersede the unused
  -- malformed historical detail.
  PERFORM * FROM public.record_workflow_assessment_review(
    '93000000-0000-4000-8000-000000000131',1,
    '93000000-0000-4000-8000-000000000001',
    '[{"assessment_step_id":"s1","proposed_classification":"RULE","reviewed_classification":"HUMAN","disposition":"reclassified","accepted_specification":{"description":"Human decides","whyHumanControlled":"Authority remains human"}}]'::jsonb,NULL);
  PERFORM * FROM public.record_workflow_assessment_review(
    '93000000-0000-4000-8000-000000000131',1,
    '93000000-0000-4000-8000-000000000001',
    '[{"assessment_step_id":"s1","proposed_classification":"RULE","reviewed_classification":"RULE","disposition":"modified","accepted_specification":{"plainLanguageRule":"Compare replacement facts","requiredFacts":["fact"],"conditionType":"comparison","expectedEvidence":["evidence"],"expectedOutcome":"match","userDescribedExceptions":[],"unresolvedAssumptions":[]}}]'::jsonb,NULL);
END $$;

-- Malformed historical step identity is rejected for every disposition, even
-- where a complete replacement would otherwise be self-contained.
INSERT INTO public.workflow_intake_submissions (
  id, workflow_description, documents_involved, manual_checks,
  frequency_and_volume, exceptions, human_decisions
) VALUES
  ('93000000-0000-4000-8000-000000000032','numeric identity','docs','checks','daily','none','review'),
  ('93000000-0000-4000-8000-000000000033','empty identity','docs','checks','daily','none','review');
INSERT INTO public.workflow_assessments (
  id, source_submission_id, assessment_version, assessment,
  assessment_digest_sha256, model, prompt_template_id, prompt_template_version
) VALUES
  ('93000000-0000-4000-8000-000000000132','93000000-0000-4000-8000-000000000032',1,
    '{"workflowSteps":[{"stepId":42,"classification":"RULE"}]}'::jsonb,
    repeat('d',64),'none','proof','1'),
  ('93000000-0000-4000-8000-000000000133','93000000-0000-4000-8000-000000000033',1,
    '{"workflowSteps":[{"stepId":"","classification":"RULE"}]}'::jsonb,
    repeat('e',64),'none','proof','1');
DO $$
DECLARE assessment_id uuid;
BEGIN
  FOREACH assessment_id IN ARRAY ARRAY[
    '93000000-0000-4000-8000-000000000132'::uuid,
    '93000000-0000-4000-8000-000000000133'::uuid
  ] LOOP
    BEGIN
      PERFORM * FROM public.record_workflow_assessment_review(
        assessment_id,1,'93000000-0000-4000-8000-000000000001',
        '[{"assessment_step_id":"42","proposed_classification":"RULE","reviewed_classification":"HUMAN","disposition":"reclassified","accepted_specification":{"description":"Human decides","whyHumanControlled":"Authority remains human"}}]'::jsonb,NULL);
      RAISE EXCEPTION 'malformed historical step identity unexpectedly accepted';
    EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
  END LOOP;
END $$;

-- Complete specifications with malformed class-detail IDs must still fail the
-- exact review RPC: identity is provenance, not a field composition can omit.
INSERT INTO public.workflow_intake_submissions (
  id, workflow_description, documents_involved, manual_checks,
  frequency_and_volume, exceptions, human_decisions
) VALUES
  ('93000000-0000-4000-8000-000000000034','missing detail id','docs','checks','daily','none','review'),
  ('93000000-0000-4000-8000-000000000035','numeric detail id','docs','checks','daily','none','review'),
  ('93000000-0000-4000-8000-000000000036','empty detail id','docs','checks','daily','none','review'),
  ('93000000-0000-4000-8000-000000000037','null detail id','docs','checks','daily','none','review'),
  ('93000000-0000-4000-8000-000000000038','recover unknown key','docs','checks','daily','none','review');

WITH identity_cases(assessment_id, source_id, rule_id, omit_id) AS (
  VALUES
    ('93000000-0000-4000-8000-000000000134'::uuid,'93000000-0000-4000-8000-000000000034'::uuid,'null'::jsonb,true),
    ('93000000-0000-4000-8000-000000000135'::uuid,'93000000-0000-4000-8000-000000000035'::uuid,'42'::jsonb,false),
    ('93000000-0000-4000-8000-000000000136'::uuid,'93000000-0000-4000-8000-000000000036'::uuid,'""'::jsonb,false),
    ('93000000-0000-4000-8000-000000000137'::uuid,'93000000-0000-4000-8000-000000000037'::uuid,'null'::jsonb,false)
), proposals AS (
  SELECT *, jsonb_build_object(
    'ruleId',rule_id,'stepId','s1','plainLanguageRule','Compare',
    'requiredFacts',jsonb_build_array('fact'),'conditionType','comparison',
    'expectedEvidence',jsonb_build_array('evidence'),'expectedOutcome','match',
    'userDescribedExceptions','[]'::jsonb,'unresolvedAssumptions','[]'::jsonb
  ) AS proposal FROM identity_cases
)
INSERT INTO public.workflow_assessments (
  id, source_submission_id, assessment_version, assessment,
  assessment_digest_sha256, model, prompt_template_id, prompt_template_version
)
SELECT assessment_id, source_id, 1, jsonb_build_object(
  'workflowSteps',jsonb_build_array(jsonb_build_object('stepId','s1','classification','RULE')),
  'deterministicRuleProposals',jsonb_build_array(CASE WHEN omit_id THEN proposal - 'ruleId' ELSE proposal END)
), repeat('f',64), 'none','proof','1' FROM proposals;

DO $$
DECLARE assessment_id uuid;
BEGIN
  FOREACH assessment_id IN ARRAY ARRAY[
    '93000000-0000-4000-8000-000000000134'::uuid,
    '93000000-0000-4000-8000-000000000135'::uuid,
    '93000000-0000-4000-8000-000000000136'::uuid,
    '93000000-0000-4000-8000-000000000137'::uuid
  ] LOOP
    BEGIN
      PERFORM * FROM public.record_workflow_assessment_review(
        assessment_id,1,'93000000-0000-4000-8000-000000000001',
        '[{"assessment_step_id":"s1","proposed_classification":"RULE","reviewed_classification":"RULE","disposition":"accepted"}]'::jsonb,NULL);
      RAISE EXCEPTION 'malformed detail identity unexpectedly accepted';
    EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
  END LOOP;
END $$;

INSERT INTO public.workflow_assessments (
  id, source_submission_id, assessment_version, assessment,
  assessment_digest_sha256, model, prompt_template_id, prompt_template_version
) VALUES (
  '93000000-0000-4000-8000-000000000138','93000000-0000-4000-8000-000000000038',1,
  '{"workflowSteps":[{"stepId":"s1","classification":"RECOVER"}],"extractionRequirements":[{"requirementId":"e1","stepId":"s1","describedFact":"fact","sourceDocument":"doc","deterministicExtractionPlausible":false,"sql":"forbidden"}],"forgewingRecoveryTasks":[{"taskId":"t1","stepId":"s1","description":"recover","deterministicShortfall":"shortfall"}]}'::jsonb,
  repeat('1',64),'none','proof','1');
DO $$ BEGIN
  BEGIN
    PERFORM * FROM public.record_workflow_assessment_review(
      '93000000-0000-4000-8000-000000000138',1,
      '93000000-0000-4000-8000-000000000001',
      '[{"assessment_step_id":"s1","proposed_classification":"RECOVER","reviewed_classification":"RECOVER","disposition":"accepted"}]'::jsonb,NULL);
    RAISE EXCEPTION 'RECOVER unknown source key unexpectedly accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
END $$;

-- Execute every RULE/VERIFY requiredness omission through the privileged RPC,
-- plus both malformed primitive directions and explicit JSON null.
SET ROLE service_role;
DO $$
DECLARE
  rule_spec jsonb;
  classification text;
  missing_key text;
  malformed jsonb;
  entry jsonb;
  before_parents bigint;
  before_children bigint;
BEGIN
  SELECT assessment.assessment -> 'deterministicRuleProposals' -> 0
    INTO rule_spec FROM public.workflow_assessments AS assessment
    WHERE assessment.id = '93000000-0000-4000-8000-000000000130';
  rule_spec := rule_spec - ARRAY['stepId','ruleId'];
  SELECT count(*) INTO before_parents FROM public.workflow_assessment_reviews;
  SELECT count(*) INTO before_children FROM public.workflow_assessment_step_reviews;
  FOREACH classification IN ARRAY ARRAY['RULE','VERIFY'] LOOP
    FOREACH missing_key IN ARRAY ARRAY['userDescribedExceptions','unresolvedAssumptions'] LOOP
      entry := jsonb_build_object(
        'assessment_step_id','s1','proposed_classification','RULE',
        'reviewed_classification',classification,
        'disposition',CASE WHEN classification = 'RULE' THEN 'modified' ELSE 'reclassified' END,
        'accepted_specification',rule_spec - missing_key);
      BEGIN
        PERFORM * FROM public.record_workflow_assessment_review(
          '93000000-0000-4000-8000-000000000130',1,
          '93000000-0000-4000-8000-000000000001',jsonb_build_array(entry),NULL);
        RAISE EXCEPTION '% missing % unexpectedly accepted',classification,missing_key;
      EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
    END LOOP;
  END LOOP;
  FOR malformed IN SELECT value FROM jsonb_array_elements('[
    {"disposition":"modified","reviewed_classification":"RULE","accepted_specification":42},
    {"disposition":"reclassified","reviewed_classification":"HUMAN","accepted_specification":[]},
    {"disposition":"rejected","reviewed_classification":null,"accepted_specification":null},
    {"disposition":"accepted","reviewed_classification":"RULE","accepted_specification":null},
    {"reviewed_classification":"RULE","accepted_specification":{}},
    {"disposition":null,"reviewed_classification":"RULE","accepted_specification":{}}
  ]'::jsonb) LOOP
    entry := malformed || '{"assessment_step_id":"s1","proposed_classification":"RULE"}'::jsonb;
    BEGIN
      PERFORM * FROM public.record_workflow_assessment_review(
        '93000000-0000-4000-8000-000000000130',1,
        '93000000-0000-4000-8000-000000000001',jsonb_build_array(entry),NULL);
      RAISE EXCEPTION 'malformed specification or disposition unexpectedly accepted: %',malformed;
    EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
  END LOOP;
  IF (SELECT count(*) FROM public.workflow_assessment_reviews) <> before_parents
    OR (SELECT count(*) FROM public.workflow_assessment_step_reviews) <> before_children THEN
    RAISE EXCEPTION 'requiredness/malformed matrix left partial review writes';
  END IF;
  -- An absent specification is the actual SQL NULL contract for accepted and
  -- rejected. These positive controls prevent a reject-everything regression.
  PERFORM * FROM public.record_workflow_assessment_review(
    '93000000-0000-4000-8000-000000000130',1,
    '93000000-0000-4000-8000-000000000001',
    '[{"assessment_step_id":"s1","proposed_classification":"RULE","reviewed_classification":"RULE","disposition":"accepted"}]'::jsonb,NULL);
  PERFORM * FROM public.record_workflow_assessment_review(
    '93000000-0000-4000-8000-000000000130',1,
    '93000000-0000-4000-8000-000000000001',
    '[{"assessment_step_id":"s1","proposed_classification":"RULE","reviewed_classification":null,"disposition":"rejected"}]'::jsonb,NULL);
END $$;
RESET ROLE;

SELECT 'WORKFLOW DATABASE AUTHORITY SEQUENTIAL MATRIX: PASS' AS result;
