\set ON_ERROR_STOP on

-- B8.4b: append-only improvement lifecycle (human-attested fix commit, worker
-- deployment proof) and Validator run producer identity. Generic, disposable
-- fixtures only. Every check raises on failure, so ON_ERROR_STOP fails the
-- replay. Runs after the B8.3d verification, whose triage-sourced Plan V2 run
-- it reuses, beside the Phase 11E assessment-sourced run.

INSERT INTO public.organizations (id, name) VALUES
  ('b84b0000-0000-4000-8000-000000000001', 'B8.4b regression organization');
INSERT INTO auth.users (id) VALUES ('b84b0000-0000-4000-8000-0000000000a1');
INSERT INTO public.user_profiles (id, organization_id) VALUES
  ('b84b0000-0000-4000-8000-0000000000a1', 'b84b0000-0000-4000-8000-000000000001');
INSERT INTO public.projects (id, organization_id, name) VALUES
  ('b84b0000-0000-4000-8000-000000000021', 'b84b0000-0000-4000-8000-000000000001', 'B8.4b project');

CREATE TEMP TABLE b84b_state (name text PRIMARY KEY, value text);
GRANT ALL ON b84b_state TO service_role, forgewing_engineering_worker;
INSERT INTO b84b_state
SELECT 'triage_run', id::text FROM public.workflow_repository_plan_v2_runs
WHERE triage_review_id IS NOT NULL ORDER BY created_at LIMIT 1;
INSERT INTO b84b_state
SELECT 'assessment_run', id::text FROM public.workflow_repository_plan_v2_runs
WHERE triage_review_id IS NULL ORDER BY created_at LIMIT 1;

DO $b84b_fixture_runs$
BEGIN
  IF (SELECT count(*) FROM b84b_state) <> 2 THEN
    RAISE EXCEPTION 'B8.4b needs one triage-sourced and one assessment-sourced Plan V2 run';
  END IF;
END
$b84b_fixture_runs$;

-- Engineering reviews: approved, approved-then-rejected (superseded), rejected,
-- and an approved assessment-sourced request.
INSERT INTO public.workflow_repository_plan_recommendation_reviews (
  id, plan_v2_run_id, plan_v2_digest_sha256, recommendation_id, review_version, reviewer_actor_id,
  disposition, capability_scope, reviewer_rationale, modified_scope, review_request_digest_sha256, repository_commit_sha
)
SELECT fixture.id::uuid, run.id, run.plan_v2_digest_sha256,
  'rec_' || encode(sha256(convert_to('b84b-recommendation:' || fixture.rec, 'UTF8')), 'hex'), fixture.version,
  'b84b0000-0000-4000-8000-0000000000a1', fixture.disposition,
  CASE WHEN fixture.disposition IN ('accepted', 'modified') THEN 'reusable_platform_capability' END,
  'B8.4b fixture review', NULL, encode(sha256(convert_to('b84b-review:' || fixture.id, 'UTF8')), 'hex'),
  run.repository_commit_sha
FROM (VALUES
  ('b84b0000-0000-4000-8000-000000000101', 'triage_run', '1', 1, 'accepted'),
  ('b84b0000-0000-4000-8000-000000000102', 'triage_run', '2', 1, 'accepted'),
  ('b84b0000-0000-4000-8000-000000000103', 'triage_run', '2', 2, 'rejected'),
  ('b84b0000-0000-4000-8000-000000000104', 'triage_run', '3', 1, 'rejected'),
  ('b84b0000-0000-4000-8000-000000000105', 'assessment_run', '4', 1, 'accepted')
) AS fixture(id, run_name, rec, version, disposition)
JOIN b84b_state AS state ON state.name = fixture.run_name
JOIN public.workflow_repository_plan_v2_runs AS run ON run.id = state.value::uuid;

-- 1. Validator run producer identity: shape enforced, written once.
DO $b84b_run_identity$
BEGIN
  BEGIN
    INSERT INTO public.project_validation_runs (project_id, triggered_by, rule_version, deployment_revision)
    VALUES ('b84b0000-0000-4000-8000-000000000021', 'manual', '1.0.0', 'HEAD');
    RAISE EXCEPTION 'malformed deployment revision accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO public.project_validation_runs (project_id, triggered_by, rule_version, rule_catalogue_fingerprint)
    VALUES ('b84b0000-0000-4000-8000-000000000021', 'manual', '1.0.0', 'rule-explanation-v1:sha256:' || repeat('0', 64));
    RAISE EXCEPTION 'malformed catalogue fingerprint accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  -- Production observations: before the fix, first with the fix (twice), and a preview run.
  INSERT INTO public.project_validation_runs (id, project_id, triggered_by, rule_version, status,
    deployment_revision, deployment_environment, rule_catalogue_fingerprint, created_at)
  VALUES
    ('b84b0000-0000-4000-8000-000000000201', 'b84b0000-0000-4000-8000-000000000021', 'manual', '1.0.0', 'complete',
      repeat('1', 40), 'production', 'rule-catalogue-v1:sha256:' || repeat('a', 64), '2026-10-01T00:00:00Z'),
    ('b84b0000-0000-4000-8000-000000000202', 'b84b0000-0000-4000-8000-000000000021', 'manual', '1.0.0', 'complete',
      repeat('2', 40), 'production', 'rule-catalogue-v1:sha256:' || repeat('a', 64), '2026-10-02T00:00:00Z'),
    ('b84b0000-0000-4000-8000-000000000203', 'b84b0000-0000-4000-8000-000000000021', 'manual', '1.0.0', 'complete',
      repeat('2', 40), 'production', 'rule-catalogue-v1:sha256:' || repeat('a', 64), '2026-10-03T00:00:00Z'),
    ('b84b0000-0000-4000-8000-000000000204', 'b84b0000-0000-4000-8000-000000000021', 'manual', '1.0.0', 'complete',
      repeat('3', 40), 'preview', NULL, '2026-10-01T12:00:00Z');
  -- Ordinary run updates still work; the producer cannot be rewritten.
  UPDATE public.project_validation_runs SET findings_count = 1 WHERE id = 'b84b0000-0000-4000-8000-000000000201';
  BEGIN
    UPDATE public.project_validation_runs SET deployment_revision = repeat('9', 40)
    WHERE id = 'b84b0000-0000-4000-8000-000000000201';
    RAISE EXCEPTION 'run producer identity rewritten';
  EXCEPTION WHEN restrict_violation THEN NULL;
  END;
  BEGIN
    UPDATE public.project_validation_runs SET deployment_environment = NULL
    WHERE id = 'b84b0000-0000-4000-8000-000000000201';
    RAISE EXCEPTION 'run producer environment erased';
  EXCEPTION WHEN restrict_violation THEN NULL;
  END;
END
$b84b_run_identity$;

-- 2. Fix attestation: approved, current, triage-sourced requests only.
SET ROLE service_role;
DO $b84b_attestation$
DECLARE
  v_receipt record;
  v_again record;
BEGIN
  SELECT * INTO v_receipt FROM public.record_improvement_fix_attestation(
    'b84b0000-0000-4000-8000-000000000101', 1, repeat('f', 64), repeat('4', 40), 'b84b0000-0000-4000-8000-0000000000a1');
  IF NOT v_receipt.inserted THEN RAISE EXCEPTION 'attestation not inserted'; END IF;
  INSERT INTO b84b_state VALUES ('implemented', v_receipt.event_id::text);
  -- Idempotent for the same commit; a different commit is refused.
  SELECT * INTO v_again FROM public.record_improvement_fix_attestation(
    'b84b0000-0000-4000-8000-000000000101', 1, repeat('f', 64), repeat('4', 40), 'b84b0000-0000-4000-8000-0000000000a1');
  IF v_again.inserted OR v_again.event_id <> v_receipt.event_id THEN RAISE EXCEPTION 'attestation replay not idempotent'; END IF;
  BEGIN
    PERFORM public.record_improvement_fix_attestation(
      'b84b0000-0000-4000-8000-000000000101', 1, repeat('f', 64), repeat('5', 40), 'b84b0000-0000-4000-8000-0000000000a1');
    RAISE EXCEPTION 'conflicting attestation accepted';
  EXCEPTION WHEN SQLSTATE 'B8404' THEN NULL;
  END;
  BEGIN
    PERFORM public.record_improvement_fix_attestation(
      'b84b0000-0000-4000-8000-000000000102', 1, repeat('f', 64), repeat('4', 40), 'b84b0000-0000-4000-8000-0000000000a1');
    RAISE EXCEPTION 'superseded review attested';
  EXCEPTION WHEN SQLSTATE 'B8402' THEN NULL;
  END;
  BEGIN
    PERFORM public.record_improvement_fix_attestation(
      'b84b0000-0000-4000-8000-000000000103', 2, repeat('f', 64), repeat('4', 40), 'b84b0000-0000-4000-8000-0000000000a1');
    RAISE EXCEPTION 'rejected request attested';
  EXCEPTION WHEN SQLSTATE 'B8401' THEN NULL;
  END;
  BEGIN
    PERFORM public.record_improvement_fix_attestation(
      'b84b0000-0000-4000-8000-000000000105', 1, repeat('f', 64), repeat('4', 40), 'b84b0000-0000-4000-8000-0000000000a1');
    RAISE EXCEPTION 'assessment-sourced request attested as measurable';
  EXCEPTION WHEN SQLSTATE 'B8403' THEN NULL;
  END;
  BEGIN
    PERFORM public.record_improvement_fix_attestation(
      'b84b0000-0000-4000-8000-000000000101', 1, repeat('f', 64), 'abc1234', 'b84b0000-0000-4000-8000-0000000000a1');
    RAISE EXCEPTION 'abbreviated SHA accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  -- The trusted server reads lifecycle evidence; it cannot write it directly.
  BEGIN
    INSERT INTO public.improvement_lifecycle_events (event_kind, engineering_review_id, engineering_review_version,
      engineering_request_digest_sha256, plan_v2_run_id, organization_id, submission_id, triage_review_id,
      triage_version, fix_commit_sha, attested_by)
    SELECT 'implemented', engineering_review_id, 1, repeat('f', 64), plan_v2_run_id, organization_id, submission_id,
      triage_review_id, triage_version, repeat('6', 40), attested_by
    FROM public.improvement_lifecycle_events LIMIT 1;
    RAISE EXCEPTION 'service_role wrote lifecycle evidence directly';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  -- The worker functions are not the server's.
  BEGIN
    PERFORM public.read_improvement_deployment_work(10);
    RAISE EXCEPTION 'service_role read worker deployment work';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END
$b84b_attestation$;
RESET ROLE;

DO $b84b_attested_row$
DECLARE
  v_event public.improvement_lifecycle_events%ROWTYPE;
BEGIN
  SELECT * INTO v_event FROM public.improvement_lifecycle_events
  WHERE id = (SELECT value::uuid FROM b84b_state WHERE name = 'implemented');
  IF v_event.event_kind <> 'implemented' OR v_event.fix_commit_sha <> repeat('4', 40)
     OR v_event.attested_by <> 'b84b0000-0000-4000-8000-0000000000a1'
     OR v_event.engineering_request_digest_sha256 <> repeat('f', 64)
     OR v_event.plan_v2_run_id <> (SELECT value::uuid FROM b84b_state WHERE name = 'triage_run')
     OR v_event.triage_review_id IS NULL OR v_event.submission_id IS NULL OR v_event.organization_id IS NULL
     OR v_event.production_revision IS NOT NULL THEN
    RAISE EXCEPTION 'attestation row does not carry who, when, the exact commit and its originating friction';
  END IF;
  IF (SELECT count(*) FROM public.improvement_lifecycle_events) <> 1 THEN
    RAISE EXCEPTION 'refused attestations left rows';
  END IF;
END
$b84b_attested_row$;

-- 3. Deployment proof: worker only, first production observation only.
SET ROLE forgewing_engineering_worker;
DO $b84b_deployment$
DECLARE
  v_work record;
  v_receipt record;
  v_again record;
BEGIN
  SELECT * INTO v_work FROM public.read_improvement_deployment_work(10);
  IF jsonb_array_length(v_work.pending_attestations) <> 1
     OR v_work.pending_attestations->0->>'fix_commit_sha' <> repeat('4', 40)
     OR v_work.observations_truncated THEN
    RAISE EXCEPTION 'pending attestation not offered to the worker';
  END IF;
  -- Production revisions only, each at its first observation, oldest first.
  IF jsonb_array_length(v_work.production_observations) <> 2
     OR v_work.production_observations->0->>'revision' <> repeat('1', 40)
     OR v_work.production_observations->1->>'revision' <> repeat('2', 40)
     OR v_work.production_observations->1->>'run_id' <> 'b84b0000-0000-4000-8000-000000000202' THEN
    RAISE EXCEPTION 'production observations wrong: %', v_work.production_observations;
  END IF;
  -- A later observation of the revision, a preview run, or a mismatched revision is refused.
  BEGIN
    PERFORM public.record_improvement_deployment((SELECT value::uuid FROM b84b_state WHERE name = 'implemented'),
      repeat('2', 40), 'b84b0000-0000-4000-8000-000000000203', repeat('7', 40));
    RAISE EXCEPTION 'later observation recorded as the deployment';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  BEGIN
    PERFORM public.record_improvement_deployment((SELECT value::uuid FROM b84b_state WHERE name = 'implemented'),
      repeat('3', 40), 'b84b0000-0000-4000-8000-000000000204', repeat('7', 40));
    RAISE EXCEPTION 'preview run recorded as a production deployment';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  BEGIN
    PERFORM public.record_improvement_deployment((SELECT value::uuid FROM b84b_state WHERE name = 'implemented'),
      repeat('1', 40), 'b84b0000-0000-4000-8000-000000000202', repeat('7', 40));
    RAISE EXCEPTION 'observation of another revision accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  SELECT * INTO v_receipt FROM public.record_improvement_deployment(
    (SELECT value::uuid FROM b84b_state WHERE name = 'implemented'),
    repeat('2', 40), 'b84b0000-0000-4000-8000-000000000202', repeat('7', 40));
  IF NOT v_receipt.inserted THEN RAISE EXCEPTION 'deployment proof not inserted'; END IF;
  SELECT * INTO v_again FROM public.record_improvement_deployment(
    (SELECT value::uuid FROM b84b_state WHERE name = 'implemented'),
    repeat('2', 40), 'b84b0000-0000-4000-8000-000000000202', repeat('7', 40));
  IF v_again.inserted OR v_again.event_id <> v_receipt.event_id THEN RAISE EXCEPTION 'deployment replay not idempotent'; END IF;
  INSERT INTO b84b_state VALUES ('deployed', v_receipt.event_id::text);
  SELECT * INTO v_work FROM public.read_improvement_deployment_work(10);
  IF jsonb_array_length(v_work.pending_attestations) <> 0 THEN
    RAISE EXCEPTION 'deployed fix still offered as pending';
  END IF;
  -- The worker cannot attest fixes.
  BEGIN
    PERFORM public.record_improvement_fix_attestation(
      'b84b0000-0000-4000-8000-000000000101', 1, repeat('f', 64), repeat('4', 40), 'b84b0000-0000-4000-8000-0000000000a1');
    RAISE EXCEPTION 'worker attested a fix';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END
$b84b_deployment$;
RESET ROLE;

-- 4. The proof persists both SHAs, the method, the checkout and the observation;
--    nothing can be edited, deleted or truncated.
DO $b84b_deployed_row$
DECLARE
  v_event public.improvement_lifecycle_events%ROWTYPE;
BEGIN
  SELECT * INTO v_event FROM public.improvement_lifecycle_events
  WHERE id = (SELECT value::uuid FROM b84b_state WHERE name = 'deployed');
  IF v_event.event_kind <> 'deployed' OR v_event.fix_commit_sha <> repeat('4', 40)
     OR v_event.production_revision <> repeat('2', 40) OR v_event.ancestry_method <> 'git_merge_base_is_ancestor'
     OR v_event.verifier_checkout_commit <> repeat('7', 40)
     OR v_event.deployment_observation_source <> 'project_validation_run'
     OR v_event.deployment_observation_id <> 'b84b0000-0000-4000-8000-000000000202'
     OR v_event.deployment_observed_at <> '2026-10-02T00:00:00Z'::timestamptz
     OR v_event.implemented_event_id <> (SELECT value::uuid FROM b84b_state WHERE name = 'implemented')
     OR v_event.attested_by IS NOT NULL THEN
    RAISE EXCEPTION 'deployment proof row incomplete';
  END IF;
  BEGIN
    UPDATE public.improvement_lifecycle_events SET fix_commit_sha = repeat('8', 40) WHERE id = v_event.id;
    RAISE EXCEPTION 'lifecycle event updated';
  EXCEPTION WHEN restrict_violation THEN NULL;
  END;
  BEGIN
    DELETE FROM public.improvement_lifecycle_events WHERE id = v_event.id;
    RAISE EXCEPTION 'lifecycle event deleted';
  EXCEPTION WHEN restrict_violation THEN NULL;
  END;
  BEGIN
    TRUNCATE public.improvement_lifecycle_events CASCADE;
    RAISE EXCEPTION 'lifecycle events truncated';
  EXCEPTION WHEN restrict_violation THEN NULL;
  END;
  -- A malformed shape cannot exist even for the owner.
  BEGIN
    INSERT INTO public.improvement_lifecycle_events (event_kind, engineering_review_id, engineering_review_version,
      engineering_request_digest_sha256, plan_v2_run_id, organization_id, submission_id, triage_review_id,
      triage_version, fix_commit_sha, attested_by, production_revision)
    SELECT 'implemented', engineering_review_id, engineering_review_version, engineering_request_digest_sha256,
      plan_v2_run_id, organization_id, submission_id, triage_review_id, triage_version, fix_commit_sha,
      'b84b0000-0000-4000-8000-0000000000a1', repeat('2', 40)
    FROM public.improvement_lifecycle_events WHERE id = v_event.id;
    RAISE EXCEPTION 'attestation carrying a deployment proof accepted';
  EXCEPTION WHEN check_violation OR unique_violation THEN NULL;
  END;
  IF EXISTS (SELECT 1 FROM pg_catalog.has_table_privilege('authenticated', 'public.improvement_lifecycle_events', 'SELECT') AS granted
      WHERE granted) THEN
    RAISE EXCEPTION 'tenant users can read lifecycle evidence';
  END IF;
END
$b84b_deployed_row$;

SELECT 'B8.4B LIFECYCLE ATTESTATION / ANCESTRY PROOF RECORD / RUN PRODUCER IDENTITY / APPEND-ONLY: PASS' AS result;
