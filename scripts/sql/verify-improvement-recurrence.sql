\set ON_ERROR_STOP on

-- B8.4d: a confirmed recurrence creates a linked successor submission and
-- never edits history. Generic, disposable fixtures only. Runs after the B8.4b
-- and B8.4c verifications and reuses their triage-sourced plan, reviewer and
-- production observations. Every check raises on failure.

CREATE TEMP TABLE b84r_state (name text PRIMARY KEY, value text);
GRANT ALL ON b84r_state TO service_role, forgewing_engineering_worker;
INSERT INTO b84r_state
SELECT 'triage_run', id::text FROM public.workflow_repository_plan_v2_runs
WHERE triage_review_id IS NOT NULL ORDER BY created_at LIMIT 1;
INSERT INTO b84r_state
SELECT 'observation', id::text FROM public.project_validation_runs
WHERE deployment_environment = 'production' AND deployment_revision = repeat('c', 40)
ORDER BY created_at, id LIMIT 1;

-- A second approved request on the same triage-sourced plan.
INSERT INTO public.workflow_repository_plan_recommendation_reviews (
  id, plan_v2_run_id, plan_v2_digest_sha256, recommendation_id, review_version, reviewer_actor_id,
  disposition, capability_scope, reviewer_rationale, modified_scope, review_request_digest_sha256, repository_commit_sha)
SELECT 'b84f0000-0000-4000-8000-000000000101', run.id, run.plan_v2_digest_sha256,
  'rec_' || encode(sha256(convert_to('b84r-recommendation', 'UTF8')), 'hex'), 1,
  'b84b0000-0000-4000-8000-0000000000a1', 'accepted', 'reusable_platform_capability', 'B8.4d fixture review', NULL,
  encode(sha256(convert_to('b84r-review', 'UTF8')), 'hex'), run.repository_commit_sha
FROM public.workflow_repository_plan_v2_runs AS run WHERE run.id = (SELECT value::uuid FROM b84r_state WHERE name = 'triage_run');

SET ROLE service_role;
SELECT set_config('request.jwt.claim.role', 'service_role', false);
INSERT INTO b84r_state SELECT 'implemented', event_id::text FROM public.record_improvement_fix_attestation(
  'b84f0000-0000-4000-8000-000000000101', 1, repeat('a', 64), repeat('c', 40), 'b84b0000-0000-4000-8000-0000000000a1');
RESET ROLE;
SET ROLE forgewing_engineering_worker;
INSERT INTO b84r_state SELECT 'deployed', event_id::text FROM public.record_improvement_deployment(
  (SELECT value::uuid FROM b84r_state WHERE name = 'implemented'), repeat('c', 40),
  (SELECT value::uuid FROM b84r_state WHERE name = 'observation'), repeat('7', 40));
RESET ROLE;

INSERT INTO b84r_state
SELECT 'origin', submission_id::text FROM public.improvement_lifecycle_events
WHERE id = (SELECT value::uuid FROM b84r_state WHERE name = 'deployed');
INSERT INTO b84r_state
SELECT 'origin_digest', payload_digest_sha256 FROM public.improvement_signal_submissions
WHERE id = (SELECT value::uuid FROM b84r_state WHERE name = 'origin');

SET ROLE service_role;
DO $b84r_recurrence$
DECLARE
  v_event public.improvement_lifecycle_events%ROWTYPE;
  v_origin public.improvement_signal_submissions%ROWTYPE;
  v_snapshot uuid;
  v_first uuid;
  v_deferred uuid;
  v_current uuid;
  v_receipt record;
  v_payload jsonb;
BEGIN
  SELECT * INTO v_event FROM public.improvement_lifecycle_events
  WHERE id = (SELECT value::uuid FROM b84r_state WHERE name = 'deployed');
  SELECT * INTO v_origin FROM public.improvement_signal_submissions WHERE id = v_event.submission_id;
  -- Friction recurred: 20/40 after the fix against 4/20 before.
  SELECT snapshot_id INTO v_snapshot FROM public.record_improvement_measurement_snapshot(
    v_event.id, 'improvement_problem_v1:sha256:' || repeat('3', 64), v_origin.signal_kind, v_origin.signal_code,
    'friction_measurement_v1', 'friction_measurement_windows_v1',
    v_event.deployment_observed_at - interval '90 days', date_trunc('milliseconds', v_event.deployment_observed_at),
    date_trunc('milliseconds', v_event.deployment_observed_at), v_event.deployment_observed_at + interval '20 days',
    20, 4, 40, 20, 'recurred', ARRAY['post_rate_above_reduction_threshold'], '{"fixture":true}', repeat('4', 64),
    '{"readTruncated":false}', 'b84e0000-0000-4000-8000-0000000000a1');
  SELECT decision_id INTO v_first FROM public.record_improvement_measurement_decision(
    v_snapshot, 0, 'recurred_confirmed', 'Friction is back', 'b84e0000-0000-4000-8000-0000000000a1');
  SELECT decision_id INTO v_deferred FROM public.record_improvement_measurement_decision(
    v_snapshot, 1, 'deferred', 'Second look', 'b84e0000-0000-4000-8000-0000000000a1');
  v_payload := v_origin.payload || jsonb_build_object('counts', jsonb_build_object('occurrences', 9, 'documents', 3, 'projects', 1));

  -- A superseded recurrence decision, or a deferral, creates nothing.
  BEGIN
    PERFORM public.record_improvement_recurrence_successor(v_first, 'b84f0000-0000-4000-8000-000000000201',
      'improvement_signal_submission_v1', v_payload, repeat('5', 64), '{}', 'b84e0000-0000-4000-8000-0000000000a1');
    RAISE EXCEPTION 'B8.4d FAIL: superseded decision created a successor';
  EXCEPTION WHEN SQLSTATE 'B8409' THEN NULL;
  END;
  BEGIN
    PERFORM public.record_improvement_recurrence_successor(v_deferred, 'b84f0000-0000-4000-8000-000000000201',
      'improvement_signal_submission_v1', v_payload, repeat('5', 64), '{}', 'b84e0000-0000-4000-8000-0000000000a1');
    RAISE EXCEPTION 'B8.4d FAIL: deferral created a successor';
  EXCEPTION WHEN SQLSTATE 'B8409' THEN NULL;
  END;
  SELECT decision_id INTO v_current FROM public.record_improvement_measurement_decision(
    v_snapshot, 2, 'recurred_confirmed', 'Confirmed after second look', 'b84e0000-0000-4000-8000-0000000000a1');
  INSERT INTO b84r_state VALUES ('decision', v_current::text);
  -- Another problem, or the original submission again, is refused.
  BEGIN
    PERFORM public.record_improvement_recurrence_successor(v_current, 'b84f0000-0000-4000-8000-000000000201',
      'improvement_signal_submission_v1', v_payload || '{"code":"other_code"}', repeat('5', 64), '{}',
      'b84e0000-0000-4000-8000-0000000000a1');
    RAISE EXCEPTION 'B8.4d FAIL: successor for another problem accepted';
  EXCEPTION WHEN SQLSTATE 'B8406' THEN NULL;
  END;
  BEGIN
    PERFORM public.record_improvement_recurrence_successor(v_current, 'b84f0000-0000-4000-8000-000000000201',
      'improvement_signal_submission_v1', v_origin.payload, v_origin.payload_digest_sha256, '{}',
      'b84e0000-0000-4000-8000-0000000000a1');
    RAISE EXCEPTION 'B8.4d FAIL: successor repeating the original accepted';
  EXCEPTION WHEN SQLSTATE 'B8410' THEN NULL;
  END;
  SELECT * INTO v_receipt FROM public.record_improvement_recurrence_successor(v_current,
    'b84f0000-0000-4000-8000-000000000201', 'improvement_signal_submission_v1', v_payload, repeat('5', 64),
    '{"projectsRead":1}', 'b84e0000-0000-4000-8000-0000000000a1');
  IF NOT v_receipt.inserted OR v_receipt.successor_submission_id <> 'b84f0000-0000-4000-8000-000000000201' THEN
    RAISE EXCEPTION 'B8.4d FAIL: successor not recorded';
  END IF;
  INSERT INTO b84r_state VALUES ('link', v_receipt.successor_id::text);
  -- Idempotent per decision.
  SELECT * INTO v_receipt FROM public.record_improvement_recurrence_successor(v_current,
    'b84f0000-0000-4000-8000-000000000299', 'improvement_signal_submission_v1', v_payload, repeat('6', 64),
    '{}', 'b84e0000-0000-4000-8000-0000000000a1');
  IF v_receipt.inserted OR v_receipt.successor_id::text <> (SELECT value FROM b84r_state WHERE name = 'link') THEN
    RAISE EXCEPTION 'B8.4d FAIL: successor replay not idempotent';
  END IF;
  -- The trusted server cannot write links directly.
  BEGIN
    INSERT INTO public.improvement_recurrence_successors (originating_submission_id, successor_submission_id,
      engineering_review_id, deployed_event_id, snapshot_id, decision_id, recorded_by)
    SELECT originating_submission_id, originating_submission_id, engineering_review_id, deployed_event_id, snapshot_id,
      decision_id, recorded_by FROM public.improvement_recurrence_successors LIMIT 1;
    RAISE EXCEPTION 'B8.4d FAIL: direct link insert';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END
$b84r_recurrence$;
RESET ROLE;

DO $b84r_history$
DECLARE
  v_link public.improvement_recurrence_successors%ROWTYPE;
  v_successor public.improvement_signal_submissions%ROWTYPE;
BEGIN
  SELECT * INTO v_link FROM public.improvement_recurrence_successors
  WHERE id = (SELECT value::uuid FROM b84r_state WHERE name = 'link');
  SELECT * INTO v_successor FROM public.improvement_signal_submissions WHERE id = v_link.successor_submission_id;
  IF v_link.originating_submission_id::text <> (SELECT value FROM b84r_state WHERE name = 'origin')
     OR v_link.engineering_review_id <> 'b84f0000-0000-4000-8000-000000000101'
     OR v_link.deployed_event_id::text <> (SELECT value FROM b84r_state WHERE name = 'deployed')
     OR v_link.decision_id::text <> (SELECT value FROM b84r_state WHERE name = 'decision')
     OR v_link.snapshot_id IS NULL THEN
    RAISE EXCEPTION 'B8.4d FAIL: successor link incomplete';
  END IF;
  IF v_successor.signal_kind IS DISTINCT FROM (SELECT signal_kind FROM public.improvement_signal_submissions
        WHERE id = v_link.originating_submission_id)
     OR v_successor.organization_id IS DISTINCT FROM (SELECT organization_id FROM public.improvement_signal_submissions
        WHERE id = v_link.originating_submission_id)
     OR v_successor.payload_digest_sha256 <> repeat('5', 64) THEN
    RAISE EXCEPTION 'B8.4d FAIL: successor submission wrong';
  END IF;
  -- The original submission is untouched and the successor awaits triage.
  IF (SELECT payload_digest_sha256 FROM public.improvement_signal_submissions WHERE id = v_link.originating_submission_id)
       <> (SELECT value FROM b84r_state WHERE name = 'origin_digest')
     OR EXISTS (SELECT 1 FROM public.improvement_signal_triage_reviews WHERE submission_id = v_successor.id) THEN
    RAISE EXCEPTION 'B8.4d FAIL: history changed or successor pre-triaged';
  END IF;
  BEGIN
    UPDATE public.improvement_recurrence_successors SET recorded_at = recorded_at WHERE id = v_link.id;
    RAISE EXCEPTION 'B8.4d FAIL: link updated';
  EXCEPTION WHEN restrict_violation THEN NULL;
  END;
  BEGIN
    DELETE FROM public.improvement_recurrence_successors WHERE id = v_link.id;
    RAISE EXCEPTION 'B8.4d FAIL: link deleted';
  EXCEPTION WHEN restrict_violation THEN NULL;
  END;
  IF has_table_privilege('authenticated', 'public.improvement_recurrence_successors', 'SELECT') THEN
    RAISE EXCEPTION 'B8.4d FAIL: tenant users can read recurrence links';
  END IF;
END
$b84r_history$;

SELECT 'B8.4D RECURRENCE SUCCESSOR / CURRENT DECISION ONLY / LINKED / HISTORY UNCHANGED / APPEND-ONLY: PASS' AS result;
