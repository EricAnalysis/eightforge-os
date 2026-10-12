\set ON_ERROR_STOP on

-- B8.4c: producer classification, immutable measurement snapshots, the
-- measuring / measurement_completed lifecycle events and a person's decision.
-- Generic, disposable fixtures only. Runs after the B8.4b lifecycle
-- verification and reuses its deployed fix. Every check raises on failure.

CREATE TEMP TABLE b84m_state (name text PRIMARY KEY, value text);
GRANT ALL ON b84m_state TO service_role, forgewing_engineering_worker;
INSERT INTO b84m_state
SELECT 'deployed', id::text FROM public.improvement_lifecycle_events WHERE event_kind = 'deployed' LIMIT 1;
INSERT INTO b84m_state
SELECT 'organization', organization_id::text FROM public.improvement_lifecycle_events WHERE event_kind = 'deployed' LIMIT 1;
INSERT INTO b84m_state
SELECT 'signal_kind', s.signal_kind FROM public.improvement_lifecycle_events e
JOIN public.improvement_signal_submissions s ON s.id = e.submission_id WHERE e.event_kind = 'deployed' LIMIT 1;
INSERT INTO b84m_state
SELECT 'signal_code', s.signal_code FROM public.improvement_lifecycle_events e
JOIN public.improvement_signal_submissions s ON s.id = e.submission_id WHERE e.event_kind = 'deployed' LIMIT 1;
INSERT INTO b84m_state
SELECT 'observed_at', to_char(deployment_observed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
FROM public.improvement_lifecycle_events WHERE event_kind = 'deployed' LIMIT 1;
DO $b84m_fixture$
BEGIN
  IF (SELECT count(*) FROM b84m_state) <> 5 THEN
    RAISE EXCEPTION 'B8.4c needs the B8.4b deployed fix';
  END IF;
END
$b84m_fixture$;

INSERT INTO auth.users (id) VALUES ('b84e0000-0000-4000-8000-0000000000a1');
INSERT INTO public.user_profiles (id, organization_id)
SELECT 'b84e0000-0000-4000-8000-0000000000a1', value::uuid FROM b84m_state WHERE name = 'organization';
INSERT INTO public.projects (id, organization_id, name)
SELECT 'b84e0000-0000-4000-8000-000000000021', value::uuid, 'B8.4c project' FROM b84m_state WHERE name = 'organization';
INSERT INTO public.documents (id, organization_id, project_id, name, storage_path)
SELECT 'b84e0000-0000-4000-8000-0000000000d1', value::uuid, 'b84e0000-0000-4000-8000-000000000021',
  'generic.pdf', 'b84e/generic.pdf' FROM b84m_state WHERE name = 'organization';
-- Production revisions this organization's units came from: two Validator
-- runs, one extraction with a mapping pin; one preview run is not production.
INSERT INTO public.project_validation_runs (project_id, triggered_by, rule_version, status, deployment_revision,
  deployment_environment)
VALUES ('b84e0000-0000-4000-8000-000000000021', 'manual', '1.0.0', 'complete', repeat('c', 40), 'production'),
       ('b84e0000-0000-4000-8000-000000000021', 'manual', '1.0.0', 'complete', repeat('d', 40), 'production'),
       ('b84e0000-0000-4000-8000-000000000021', 'manual', '1.0.0', 'complete', repeat('f', 40), 'preview');
INSERT INTO public.document_extractions (id, organization_id, document_id, data, created_at)
SELECT 'b84e0000-0000-4000-8000-000000000071', value::uuid, 'b84e0000-0000-4000-8000-0000000000d1',
  jsonb_build_object('extraction', jsonb_build_object(
    'runtime_identity_v1', jsonb_build_object('identity', jsonb_build_object(
      'deployment_revision', repeat('e', 40), 'deployment_environment', 'production')),
    'content_layers_v1', jsonb_build_object('pdf', jsonb_build_object('priced_schedule_reconstruction_v1',
      jsonb_build_object('pages', jsonb_build_array(jsonb_build_object('physical_page_number', 1,
        'customer_header_mapping_pins', jsonb_build_array(
          jsonb_build_object('revisionId', 'b84e0000-0000-4000-8000-000000000081', 'digest', repeat('9', 64)),
          jsonb_build_object('revisionId', 'b84e0000-0000-4000-8000-000000000081', 'digest', repeat('9', 64)))))))))),
  '2026-09-15T00:00:00Z'
FROM b84m_state WHERE name = 'organization';

-- 1. Worker: revisions to classify (SHAs only), then proven classifications.
SET ROLE forgewing_engineering_worker;
DO $b84m_classification$
DECLARE
  v_work record;
  v_receipt record;
BEGIN
  SELECT * INTO v_work FROM public.read_improvement_classification_work(10)
  WHERE deployed_event_id = (SELECT value::uuid FROM b84m_state WHERE name = 'deployed');
  IF v_work.revisions IS DISTINCT FROM jsonb_build_array(repeat('c', 40), repeat('d', 40), repeat('e', 40))
     OR v_work.revisions_truncated THEN
    RAISE EXCEPTION 'B8.4c FAIL: classification work wrong: %', v_work.revisions;
  END IF;
  SELECT * INTO v_receipt FROM public.record_improvement_producer_classification(
    (SELECT value::uuid FROM b84m_state WHERE name = 'deployed'), repeat('c', 40), false, repeat('7', 40));
  IF NOT v_receipt.inserted THEN RAISE EXCEPTION 'B8.4c FAIL: classification not inserted'; END IF;
  SELECT * INTO v_receipt FROM public.record_improvement_producer_classification(
    (SELECT value::uuid FROM b84m_state WHERE name = 'deployed'), repeat('c', 40), false, repeat('7', 40));
  IF v_receipt.inserted THEN RAISE EXCEPTION 'B8.4c FAIL: classification replay not idempotent'; END IF;
  BEGIN
    PERFORM public.record_improvement_producer_classification(
      (SELECT value::uuid FROM b84m_state WHERE name = 'deployed'), repeat('c', 40), true, repeat('7', 40));
    RAISE EXCEPTION 'B8.4c FAIL: contradictory classification accepted';
  EXCEPTION WHEN SQLSTATE 'B8404' THEN NULL;
  END;
  PERFORM public.record_improvement_producer_classification(
    (SELECT value::uuid FROM b84m_state WHERE name = 'deployed'), repeat('d', 40), true, repeat('7', 40));
  SELECT * INTO v_work FROM public.read_improvement_classification_work(10)
  WHERE deployed_event_id = (SELECT value::uuid FROM b84m_state WHERE name = 'deployed');
  IF v_work.revisions IS DISTINCT FROM jsonb_build_array(repeat('e', 40)) THEN
    RAISE EXCEPTION 'B8.4c FAIL: classified revisions offered again: %', v_work.revisions;
  END IF;
  -- The worker cannot record a measurement.
  BEGIN
    PERFORM public.record_improvement_measurement_snapshot((SELECT value::uuid FROM b84m_state WHERE name = 'deployed'),
      'improvement_problem_v1:sha256:' || repeat('0', 64), 'x', 'x', 'friction_measurement_v1',
      'friction_measurement_windows_v1', now(), now(), now(), now(), 0, 0, 0, 0, 'unmeasurable', ARRAY['x'],
      '{}', repeat('0', 64), '{}', 'b84e0000-0000-4000-8000-0000000000a1');
    RAISE EXCEPTION 'B8.4c FAIL: worker recorded a measurement';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END
$b84m_classification$;
RESET ROLE;

-- 2. Snapshots: problem-bound, deployment-bound, policy-coherent.
CREATE FUNCTION pg_temp.b84m_snapshot(p_kind text, p_code text, p_post_from timestamptz,
  p_be integer, p_bo integer, p_pe integer, p_po integer, p_outcome text)
RETURNS TABLE(snapshot_id uuid, lifecycle_event_kind text) LANGUAGE sql AS $$
  SELECT * FROM public.record_improvement_measurement_snapshot(
    (SELECT value::uuid FROM b84m_state WHERE name = 'deployed'), 'improvement_problem_v1:sha256:' || repeat('1', 64),
    p_kind, p_code, 'friction_measurement_v1', 'friction_measurement_windows_v1',
    p_post_from - interval '90 days', p_post_from, p_post_from, p_post_from + interval '20 days',
    p_be, p_bo, p_pe, p_po, p_outcome, ARRAY['fixture_reason'], '{"fixture":true}'::jsonb, repeat('2', 64),
    '{"readTruncated":false}'::jsonb, 'b84e0000-0000-4000-8000-0000000000a1') $$;
GRANT EXECUTE ON FUNCTION pg_temp.b84m_snapshot(text, text, timestamptz, integer, integer, integer, integer, text)
  TO service_role;

SET ROLE service_role;
DO $b84m_snapshots$
DECLARE
  v_kind text := (SELECT value FROM b84m_state WHERE name = 'signal_kind');
  v_code text := (SELECT value FROM b84m_state WHERE name = 'signal_code');
  v_at timestamptz := (SELECT value::timestamptz FROM b84m_state WHERE name = 'observed_at');
  v_receipt record;
BEGIN
  BEGIN
    PERFORM pg_temp.b84m_snapshot('forgewing_rejected', v_code, v_at, 20, 4, 40, 1, 'resolution_candidate');
    RAISE EXCEPTION 'B8.4c FAIL: snapshot for another problem accepted';
  EXCEPTION WHEN SQLSTATE 'B8406' THEN NULL;
  END;
  BEGIN
    PERFORM pg_temp.b84m_snapshot(v_kind, v_code, v_at - interval '1 day', 20, 4, 40, 1, 'resolution_candidate');
    RAISE EXCEPTION 'B8.4c FAIL: post window before the proven deployment accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  -- The decisive outcomes are re-derived from the counts.
  BEGIN
    PERFORM pg_temp.b84m_snapshot(v_kind, v_code, v_at, 19, 4, 40, 1, 'resolution_candidate');
    RAISE EXCEPTION 'B8.4c FAIL: candidate below minimum exposure accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  BEGIN
    PERFORM pg_temp.b84m_snapshot(v_kind, v_code, v_at, 20, 4, 40, 5, 'resolution_candidate');
    RAISE EXCEPTION 'B8.4c FAIL: candidate above the reduction threshold accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  BEGIN
    PERFORM pg_temp.b84m_snapshot(v_kind, v_code, v_at, 20, 4, 40, 4, 'recurred');
    RAISE EXCEPTION 'B8.4c FAIL: recurred at exactly half the baseline rate accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  BEGIN
    PERFORM pg_temp.b84m_snapshot(v_kind, v_code, v_at, 20, 4, 40, 1, 'insufficient_exposure');
    RAISE EXCEPTION 'B8.4c FAIL: insufficient exposure with sufficient exposure accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  -- Accumulating: measuring once, then nothing more until conclusive.
  SELECT * INTO v_receipt FROM pg_temp.b84m_snapshot(v_kind, v_code, v_at, 20, 4, 10, 0, 'insufficient_exposure');
  IF v_receipt.lifecycle_event_kind IS DISTINCT FROM 'measuring' THEN RAISE EXCEPTION 'B8.4c FAIL: no measuring event'; END IF;
  INSERT INTO b84m_state VALUES ('first_snapshot', v_receipt.snapshot_id::text);
  SELECT * INTO v_receipt FROM pg_temp.b84m_snapshot(v_kind, v_code, v_at, 20, 4, 15, 0, 'insufficient_exposure');
  IF v_receipt.lifecycle_event_kind IS NOT NULL THEN RAISE EXCEPTION 'B8.4c FAIL: second measuring event'; END IF;
  -- The decision path refuses an inconclusive snapshot.
  BEGIN
    PERFORM public.record_improvement_measurement_decision((SELECT value::uuid FROM b84m_state WHERE name = 'first_snapshot'),
      0, 'deferred', 'Too early', 'b84e0000-0000-4000-8000-0000000000a1');
    RAISE EXCEPTION 'B8.4c FAIL: decision on an inconclusive snapshot accepted';
  EXCEPTION WHEN SQLSTATE 'B8407' THEN NULL;
  END;
  -- Exactly half the baseline rate: a resolution candidate, completing measurement.
  SELECT * INTO v_receipt FROM pg_temp.b84m_snapshot(v_kind, v_code, v_at, 20, 4, 40, 4, 'resolution_candidate');
  IF v_receipt.lifecycle_event_kind IS DISTINCT FROM 'measurement_completed' THEN
    RAISE EXCEPTION 'B8.4c FAIL: no measurement_completed event';
  END IF;
  INSERT INTO b84m_state VALUES ('completed_snapshot', v_receipt.snapshot_id::text);
  BEGIN
    PERFORM pg_temp.b84m_snapshot(v_kind, v_code, v_at, 20, 4, 40, 9, 'recurred');
    RAISE EXCEPTION 'B8.4c FAIL: snapshot after completion accepted';
  EXCEPTION WHEN SQLSTATE 'B8405' THEN NULL;
  END;
  -- 3. A person's decision, never automatic.
  BEGIN
    PERFORM public.record_improvement_measurement_decision((SELECT value::uuid FROM b84m_state WHERE name = 'completed_snapshot'),
      0, 'recurred_confirmed', 'Disagree', 'b84e0000-0000-4000-8000-0000000000a1');
    RAISE EXCEPTION 'B8.4c FAIL: recurred_confirmed on a resolution candidate accepted';
  EXCEPTION WHEN SQLSTATE 'B8408' THEN NULL;
  END;
  SELECT * INTO v_receipt FROM public.record_improvement_measurement_decision(
    (SELECT value::uuid FROM b84m_state WHERE name = 'completed_snapshot'), 0, 'resolved', 'Friction halved',
    'b84e0000-0000-4000-8000-0000000000a1');
  IF v_receipt.decision_version <> 1 THEN RAISE EXCEPTION 'B8.4c FAIL: first decision version'; END IF;
  BEGIN
    PERFORM public.record_improvement_measurement_decision((SELECT value::uuid FROM b84m_state WHERE name = 'completed_snapshot'),
      0, 'deferred', 'Stale view', 'b84e0000-0000-4000-8000-0000000000a1');
    RAISE EXCEPTION 'B8.4c FAIL: stale decision version accepted';
  EXCEPTION WHEN serialization_failure THEN NULL;
  END;
  SELECT * INTO v_receipt FROM public.record_improvement_measurement_decision(
    (SELECT value::uuid FROM b84m_state WHERE name = 'completed_snapshot'), 1, 'deferred', 'Reopened for review',
    'b84e0000-0000-4000-8000-0000000000a1');
  IF v_receipt.decision_version <> 2 THEN RAISE EXCEPTION 'B8.4c FAIL: superseding decision version'; END IF;
  -- The trusted server cannot write evidence directly, nor act as the worker.
  BEGIN
    INSERT INTO public.improvement_measurement_decisions (deployed_event_id, snapshot_id, decision_version, decision,
      rationale, reviewer_actor_id)
    SELECT deployed_event_id, snapshot_id, 9, 'resolved', 'x', reviewer_actor_id
    FROM public.improvement_measurement_decisions LIMIT 1;
    RAISE EXCEPTION 'B8.4c FAIL: direct decision insert';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM public.record_improvement_producer_classification(
      (SELECT value::uuid FROM b84m_state WHERE name = 'deployed'), repeat('e', 40), true, repeat('7', 40));
    RAISE EXCEPTION 'B8.4c FAIL: server classified a producer';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END
$b84m_snapshots$;

-- 4. Extraction identity reads stay small: revision and exact mapping revisions.
DO $b84m_extraction_units$
DECLARE
  v_row record;
BEGIN
  SELECT * INTO v_row FROM public.read_improvement_extraction_units(
    (SELECT value::uuid FROM b84m_state WHERE name = 'organization'), ARRAY['b84e0000-0000-4000-8000-0000000000d1'::uuid],
    '2026-09-01T00:00:00Z', '2026-10-01T00:00:00Z', 10);
  IF v_row.extraction_id IS DISTINCT FROM 'b84e0000-0000-4000-8000-000000000071'
     OR v_row.deployment_revision IS DISTINCT FROM repeat('e', 40)
     OR v_row.deployment_environment IS DISTINCT FROM 'production'
     OR v_row.mapping_revisions IS DISTINCT FROM ARRAY['b84e0000-0000-4000-8000-000000000081:' || repeat('9', 64)] THEN
    RAISE EXCEPTION 'B8.4c FAIL: extraction measurement identity wrong: %', v_row;
  END IF;
END
$b84m_extraction_units$;
RESET ROLE;

-- 5. Lifecycle and evidence integrity.
DO $b84m_integrity$
DECLARE
  v_table text;
BEGIN
  IF (SELECT array_agg(event_kind ORDER BY recorded_at, id) FROM public.improvement_lifecycle_events
      WHERE id = (SELECT value::uuid FROM b84m_state WHERE name = 'deployed')
         OR deployed_event_id = (SELECT value::uuid FROM b84m_state WHERE name = 'deployed'))
     IS DISTINCT FROM ARRAY['deployed', 'measuring', 'measurement_completed'] THEN
    RAISE EXCEPTION 'B8.4c FAIL: lifecycle sequence wrong';
  END IF;
  IF EXISTS (SELECT 1 FROM public.read_improvement_classification_work(25)
      WHERE deployed_event_id = (SELECT value::uuid FROM b84m_state WHERE name = 'deployed')) THEN
    RAISE EXCEPTION 'B8.4c FAIL: a completed fix is still offered for classification';
  END IF;
  FOREACH v_table IN ARRAY ARRAY['improvement_producer_classifications', 'improvement_measurement_snapshots',
      'improvement_measurement_decisions'] LOOP
    BEGIN
      EXECUTE format('UPDATE public.%I SET id = id', v_table);
      RAISE EXCEPTION 'B8.4c FAIL: % updated', v_table;
    EXCEPTION WHEN restrict_violation THEN NULL;
    END;
    BEGIN
      EXECUTE format('DELETE FROM public.%I', v_table);
      RAISE EXCEPTION 'B8.4c FAIL: % deleted', v_table;
    EXCEPTION WHEN restrict_violation THEN NULL;
    END;
    BEGIN
      EXECUTE format('TRUNCATE public.%I CASCADE', v_table);
      RAISE EXCEPTION 'B8.4c FAIL: % truncated', v_table;
    EXCEPTION WHEN restrict_violation THEN NULL;
    END;
    IF has_table_privilege('authenticated', format('public.%I', v_table), 'SELECT') THEN
      RAISE EXCEPTION 'B8.4c FAIL: tenant users can read %', v_table;
    END IF;
  END LOOP;
  -- A measuring event without its snapshot cannot exist.
  BEGIN
    INSERT INTO public.improvement_lifecycle_events (event_kind, engineering_review_id, engineering_review_version,
      engineering_request_digest_sha256, plan_v2_run_id, organization_id, submission_id, triage_review_id,
      triage_version, fix_commit_sha, deployed_event_id)
    SELECT 'measuring', engineering_review_id, engineering_review_version, engineering_request_digest_sha256,
      plan_v2_run_id, organization_id, submission_id, triage_review_id, triage_version, fix_commit_sha, id
    FROM public.improvement_lifecycle_events WHERE id = (SELECT value::uuid FROM b84m_state WHERE name = 'deployed');
    RAISE EXCEPTION 'B8.4c FAIL: measuring event without a snapshot accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END
$b84m_integrity$;

SELECT 'B8.4C PRODUCER CLASSIFICATION / POLICY-COHERENT SNAPSHOTS / MEASURING-COMPLETED / HUMAN DECISION / APPEND-ONLY: PASS' AS result;
