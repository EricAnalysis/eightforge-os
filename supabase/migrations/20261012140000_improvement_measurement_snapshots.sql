-- ============================================================================
-- Improvement measurement (B8.4c)
--
-- Whether the friction that started an improvement materially decreased after
-- its proven deployment, under policy friction_measurement_v1, recorded as
-- immutable evidence. Nothing here closes work: a person decides.
--
-- 1. improvement_producer_classifications (append-only, worker only): for one
--    deployed fix, whether each observed production revision contains the
--    attested commit, proven by git ancestry in the worker's checkout. The
--    worker reads revision SHAs only, never tenant content.
-- 2. improvement_measurement_snapshots (append-only, trusted server): one
--    before/after measurement: numerators, denominators, time bounds, producer
--    and configuration identity, policy version and read bounds. The database
--    re-derives the two decisive outcomes from the stored counts, so a stored
--    resolution_candidate / recurred always satisfies the policy arithmetic.
-- 3. Lifecycle: `measuring` on the first snapshot that is not conclusive;
--    `measurement_completed` on the first conclusive one (resolution_candidate,
--    recurred, confounded). After completion no further snapshot is accepted.
-- 4. improvement_measurement_decisions (append-only, versioned, platform
--    reviewer): resolved (only on a resolution_candidate), recurred_confirmed
--    (only on recurred) or deferred. `resolved` exists only as a human decision.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Producer classifications.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.improvement_producer_classifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deployed_event_id uuid NOT NULL REFERENCES public.improvement_lifecycle_events(id) ON DELETE RESTRICT,
  producer_revision text NOT NULL CHECK (producer_revision ~ '^[a-f0-9]{40}$'),
  contains_fix boolean NOT NULL,
  method text NOT NULL CHECK (method = 'git_merge_base_is_ancestor'),
  verifier_checkout_commit text NOT NULL CHECK (verifier_checkout_commit ~ '^[a-f0-9]{40}$'),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT improvement_producer_classifications_unique UNIQUE (deployed_event_id, producer_revision)
);

-- ----------------------------------------------------------------------------
-- 2. Measurement snapshots.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.improvement_measurement_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deployed_event_id uuid NOT NULL REFERENCES public.improvement_lifecycle_events(id) ON DELETE RESTRICT,
  organization_id uuid NOT NULL,
  submission_id uuid NOT NULL REFERENCES public.improvement_signal_submissions(id) ON DELETE RESTRICT,
  problem_key text NOT NULL CHECK (problem_key ~ '^improvement_problem_v1:sha256:[a-f0-9]{64}$'),
  signal_kind text NOT NULL,
  signal_code text NOT NULL,
  policy_version text NOT NULL CHECK (policy_version = 'friction_measurement_v1'),
  window_policy_version text NOT NULL CHECK (window_policy_version = 'friction_measurement_windows_v1'),
  baseline_from timestamptz NOT NULL,
  baseline_to timestamptz NOT NULL,
  post_from timestamptz NOT NULL,
  post_to timestamptz NOT NULL,
  baseline_exposure integer NOT NULL CHECK (baseline_exposure >= 0),
  baseline_occurrences integer NOT NULL CHECK (baseline_occurrences >= 0),
  post_exposure integer NOT NULL CHECK (post_exposure >= 0),
  post_occurrences integer NOT NULL CHECK (post_occurrences >= 0),
  outcome text NOT NULL CHECK (outcome IN (
    'resolution_candidate', 'recurred', 'insufficient_exposure', 'confounded', 'unmeasurable')),
  reasons text[] NOT NULL,
  measurement jsonb NOT NULL CHECK (jsonb_typeof(measurement) = 'object'),
  measurement_digest_sha256 text NOT NULL CHECK (measurement_digest_sha256 ~ '^[a-f0-9]{64}$'),
  read_bounds jsonb NOT NULL CHECK (jsonb_typeof(read_bounds) = 'object'),
  measured_by uuid NOT NULL REFERENCES public.user_profiles(id) ON DELETE RESTRICT,
  measured_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT improvement_measurement_snapshots_windows_check
    CHECK (baseline_from < baseline_to AND baseline_to <= post_from AND post_from < post_to),
  CONSTRAINT improvement_measurement_snapshots_counts_check
    CHECK (baseline_occurrences <= baseline_exposure AND post_occurrences <= post_exposure),
  CONSTRAINT improvement_measurement_snapshots_reasons_check
    CHECK (cardinality(reasons) BETWEEN 1 AND 32)
);
CREATE INDEX IF NOT EXISTS improvement_measurement_snapshots_event_idx
  ON public.improvement_measurement_snapshots (deployed_event_id, measured_at);

-- ----------------------------------------------------------------------------
-- 3. Lifecycle: measuring / measurement_completed, each bound to a snapshot.
-- ----------------------------------------------------------------------------
ALTER TABLE public.improvement_lifecycle_events
  ADD COLUMN IF NOT EXISTS deployed_event_id uuid REFERENCES public.improvement_lifecycle_events(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS measurement_snapshot_id uuid
    REFERENCES public.improvement_measurement_snapshots(id) ON DELETE RESTRICT;
ALTER TABLE public.improvement_lifecycle_events DROP CONSTRAINT IF EXISTS improvement_lifecycle_events_event_kind_check;
ALTER TABLE public.improvement_lifecycle_events ADD CONSTRAINT improvement_lifecycle_events_event_kind_check
  CHECK (event_kind IN ('implemented', 'deployed', 'measuring', 'measurement_completed'));
ALTER TABLE public.improvement_lifecycle_events DROP CONSTRAINT IF EXISTS improvement_lifecycle_events_shape_check;
ALTER TABLE public.improvement_lifecycle_events ADD CONSTRAINT improvement_lifecycle_events_shape_check CHECK (
  (event_kind = 'implemented'
    AND attested_by IS NOT NULL AND implemented_event_id IS NULL
    AND production_revision IS NULL AND ancestry_method IS NULL AND verifier_checkout_commit IS NULL
    AND deployment_observation_source IS NULL AND deployment_observation_id IS NULL
    AND deployment_observed_at IS NULL AND deployed_event_id IS NULL AND measurement_snapshot_id IS NULL)
  OR (event_kind = 'deployed'
    AND attested_by IS NULL AND implemented_event_id IS NOT NULL
    AND production_revision IS NOT NULL AND ancestry_method IS NOT NULL AND verifier_checkout_commit IS NOT NULL
    AND deployment_observation_source IS NOT NULL AND deployment_observation_id IS NOT NULL
    AND deployment_observed_at IS NOT NULL AND deployed_event_id IS NULL AND measurement_snapshot_id IS NULL)
  OR (event_kind IN ('measuring', 'measurement_completed')
    AND attested_by IS NULL AND implemented_event_id IS NULL
    AND production_revision IS NULL AND ancestry_method IS NULL AND verifier_checkout_commit IS NULL
    AND deployment_observation_source IS NULL AND deployment_observation_id IS NULL
    AND deployment_observed_at IS NULL AND deployed_event_id IS NOT NULL AND measurement_snapshot_id IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS improvement_lifecycle_events_measuring_unique
  ON public.improvement_lifecycle_events (deployed_event_id) WHERE event_kind = 'measuring';
CREATE UNIQUE INDEX IF NOT EXISTS improvement_lifecycle_events_completed_unique
  ON public.improvement_lifecycle_events (deployed_event_id) WHERE event_kind = 'measurement_completed';

-- ----------------------------------------------------------------------------
-- 4. Human decisions on a completed measurement.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.improvement_measurement_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deployed_event_id uuid NOT NULL REFERENCES public.improvement_lifecycle_events(id) ON DELETE RESTRICT,
  snapshot_id uuid NOT NULL REFERENCES public.improvement_measurement_snapshots(id) ON DELETE RESTRICT,
  decision_version integer NOT NULL CHECK (decision_version >= 1),
  decision text NOT NULL CHECK (decision IN ('resolved', 'recurred_confirmed', 'deferred')),
  rationale text NOT NULL CHECK (char_length(btrim(rationale)) BETWEEN 1 AND 4000),
  reviewer_actor_id uuid NOT NULL REFERENCES public.user_profiles(id) ON DELETE RESTRICT,
  decided_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT improvement_measurement_decisions_version_unique UNIQUE (deployed_event_id, decision_version)
);

-- ----------------------------------------------------------------------------
-- Append-only, RLS on, no direct writes.
-- ----------------------------------------------------------------------------
DO $b84c_append_only$
DECLARE
  v_table text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY['improvement_producer_classifications', 'improvement_measurement_snapshots',
      'improvement_measurement_decisions'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I', v_table || '_immutable', v_table);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW '
      || 'EXECUTE FUNCTION public.reject_improvement_lifecycle_event_mutation()', v_table || '_immutable', v_table);
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I', v_table || '_no_truncate', v_table);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT '
      || 'EXECUTE FUNCTION public.reject_improvement_lifecycle_event_mutation()', v_table || '_no_truncate', v_table);
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', v_table);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC, anon, authenticated, service_role', v_table);
    EXECUTE format('GRANT SELECT ON TABLE public.%I TO service_role', v_table);
  END LOOP;
END
$b84c_append_only$;

-- The shared rejection names the table it guards.
CREATE OR REPLACE FUNCTION public.reject_improvement_lifecycle_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % rejected', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

-- ----------------------------------------------------------------------------
-- 5. Worker: which production revisions still need classifying.
--
-- For each deployed fix whose measurement is not completed: the production
-- revisions that produced this organization's measured units (Validator runs
-- of its projects, its extractions' recorded runtime identity, its pinned
-- corrections) and are not yet classified. SHAs only.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.read_improvement_classification_work(p_limit integer)
RETURNS TABLE(deployed_event_id uuid, fix_commit_sha text, revisions jsonb, revisions_truncated boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_limit integer := least(greatest(coalesce(p_limit, 10), 1), 25);
  v_cap constant integer := 500;
  v_event record;
  v_revisions text[];
BEGIN
  FOR v_event IN
    SELECT deployed.id, deployed.fix_commit_sha, deployed.organization_id
    FROM public.improvement_lifecycle_events AS deployed
    WHERE deployed.event_kind = 'deployed'
      AND NOT EXISTS (SELECT 1 FROM public.improvement_lifecycle_events AS completed
        WHERE completed.event_kind = 'measurement_completed' AND completed.deployed_event_id = deployed.id)
    ORDER BY deployed.recorded_at, deployed.id
    LIMIT v_limit
  LOOP
    SELECT array_agg(candidate.revision ORDER BY candidate.revision) INTO v_revisions
    FROM (
      SELECT DISTINCT source.revision FROM (
        SELECT run.deployment_revision AS revision
        FROM public.project_validation_runs AS run
        JOIN public.projects AS project ON project.id = run.project_id
        WHERE project.organization_id = v_event.organization_id
          AND run.deployment_environment = 'production' AND run.deployment_revision IS NOT NULL
        UNION
        SELECT extraction.data #>> '{extraction,runtime_identity_v1,identity,deployment_revision}'
        FROM public.document_extractions AS extraction
        WHERE extraction.organization_id = v_event.organization_id AND extraction.field_key IS NULL
          AND extraction.data #>> '{extraction,runtime_identity_v1,identity,deployment_environment}' = 'production'
        UNION
        SELECT assertion.source_deployment_revision
        FROM public.human_fact_assertions AS assertion
        WHERE assertion.organization_id = v_event.organization_id
          AND assertion.source_deployment_environment = 'production'
      ) AS source
      WHERE source.revision ~ '^[a-f0-9]{40}$'
        AND NOT EXISTS (SELECT 1 FROM public.improvement_producer_classifications AS known
          WHERE known.deployed_event_id = v_event.id AND known.producer_revision = source.revision)
      ORDER BY source.revision
      LIMIT v_cap + 1
    ) AS candidate;
    deployed_event_id := v_event.id;
    fix_commit_sha := v_event.fix_commit_sha;
    revisions_truncated := coalesce(cardinality(v_revisions), 0) > v_cap;
    revisions := to_jsonb(coalesce(v_revisions[1:v_cap], ARRAY[]::text[]));
    RETURN NEXT;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.record_improvement_producer_classification(
  p_deployed_event_id uuid, p_producer_revision text, p_contains_fix boolean, p_verifier_checkout_commit text
)
RETURNS TABLE(classification_id uuid, inserted boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_existing public.improvement_producer_classifications%ROWTYPE;
BEGIN
  IF p_deployed_event_id IS NULL OR p_contains_fix IS NULL
     OR p_producer_revision IS NULL OR p_producer_revision !~ '^[a-f0-9]{40}$'
     OR p_verifier_checkout_commit IS NULL OR p_verifier_checkout_commit !~ '^[a-f0-9]{40}$' THEN
    RAISE EXCEPTION 'invalid producer classification' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.improvement_lifecycle_events AS event
      WHERE event.id = p_deployed_event_id AND event.event_kind = 'deployed') THEN
    RAISE EXCEPTION 'deployed fix not found' USING ERRCODE = 'P0002';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'improvement_classification:' || p_deployed_event_id::text || ':' || p_producer_revision, 0));
  SELECT * INTO v_existing FROM public.improvement_producer_classifications AS known
  WHERE known.deployed_event_id = p_deployed_event_id AND known.producer_revision = p_producer_revision;
  IF v_existing.id IS NOT NULL THEN
    IF v_existing.contains_fix <> p_contains_fix THEN
      RAISE EXCEPTION 'a different classification is already proven' USING ERRCODE = 'B8404';
    END IF;
    RETURN QUERY SELECT v_existing.id, false;
    RETURN;
  END IF;
  RETURN QUERY
  INSERT INTO public.improvement_producer_classifications AS known (
    deployed_event_id, producer_revision, contains_fix, method, verifier_checkout_commit)
  VALUES (p_deployed_event_id, p_producer_revision, p_contains_fix, 'git_merge_base_is_ancestor',
    p_verifier_checkout_commit)
  RETURNING known.id, true;
END;
$$;

-- ----------------------------------------------------------------------------
-- 6. Trusted server: record one snapshot.
--
-- Error codes: P0002 deployed fix not found; 22023 malformed or incoherent
-- snapshot; B8405 measurement already completed; B8406 problem does not match
-- the originating submission.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.record_improvement_measurement_snapshot(
  p_deployed_event_id uuid,
  p_problem_key text,
  p_signal_kind text,
  p_signal_code text,
  p_policy_version text,
  p_window_policy_version text,
  p_baseline_from timestamptz, p_baseline_to timestamptz,
  p_post_from timestamptz, p_post_to timestamptz,
  p_baseline_exposure integer, p_baseline_occurrences integer,
  p_post_exposure integer, p_post_occurrences integer,
  p_outcome text,
  p_reasons text[],
  p_measurement jsonb,
  p_measurement_digest_sha256 text,
  p_read_bounds jsonb,
  p_measured_by uuid
)
RETURNS TABLE(snapshot_id uuid, lifecycle_event_kind text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_deployed public.improvement_lifecycle_events%ROWTYPE;
  v_submission public.improvement_signal_submissions%ROWTYPE;
  v_snapshot uuid;
  v_kind text;
  v_meets_minimums boolean;
  v_within_threshold boolean;
BEGIN
  IF p_deployed_event_id IS NULL OR p_measured_by IS NULL OR p_outcome IS NULL OR p_reasons IS NULL
     OR p_baseline_exposure IS NULL OR p_baseline_occurrences IS NULL
     OR p_post_exposure IS NULL OR p_post_occurrences IS NULL THEN
    RAISE EXCEPTION 'invalid measurement snapshot' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('improvement_measurement:' || p_deployed_event_id::text, 0));

  SELECT * INTO v_deployed FROM public.improvement_lifecycle_events AS event
  WHERE event.id = p_deployed_event_id AND event.event_kind = 'deployed';
  IF v_deployed.id IS NULL THEN
    RAISE EXCEPTION 'deployed fix not found' USING ERRCODE = 'P0002';
  END IF;
  IF EXISTS (SELECT 1 FROM public.improvement_lifecycle_events AS completed
      WHERE completed.event_kind = 'measurement_completed' AND completed.deployed_event_id = v_deployed.id) THEN
    RAISE EXCEPTION 'measurement already completed' USING ERRCODE = 'B8405';
  END IF;
  SELECT * INTO v_submission FROM public.improvement_signal_submissions AS submission
  WHERE submission.id = v_deployed.submission_id;
  IF v_submission.id IS NULL OR v_submission.organization_id <> v_deployed.organization_id
     OR v_submission.signal_kind IS DISTINCT FROM p_signal_kind
     OR v_submission.signal_code IS DISTINCT FROM p_signal_code THEN
    RAISE EXCEPTION 'measured problem does not match the originating submission' USING ERRCODE = 'B8406';
  END IF;
  -- The post-deployment window never starts before the proven deployment
  -- (compared at the millisecond precision the server's windows carry).
  IF p_post_from < pg_catalog.date_trunc('milliseconds', v_deployed.deployment_observed_at)
     OR p_baseline_to > p_post_from THEN
    RAISE EXCEPTION 'measurement windows precede the proven deployment' USING ERRCODE = '22023';
  END IF;

  -- friction_measurement_v1, re-derived from the stored counts.
  v_meets_minimums := p_baseline_exposure >= 20 AND p_post_exposure >= 20 AND p_baseline_occurrences >= 2;
  v_within_threshold := p_post_occurrences::bigint * p_baseline_exposure * 2
    <= p_baseline_occurrences::bigint * p_post_exposure;
  IF (p_outcome = 'resolution_candidate' AND NOT (v_meets_minimums AND v_within_threshold))
     OR (p_outcome = 'recurred' AND NOT (v_meets_minimums AND NOT v_within_threshold))
     OR (p_outcome = 'insufficient_exposure' AND v_meets_minimums) THEN
    RAISE EXCEPTION 'measurement outcome does not follow friction_measurement_v1' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.improvement_measurement_snapshots AS snapshot (
    deployed_event_id, organization_id, submission_id, problem_key, signal_kind, signal_code,
    policy_version, window_policy_version, baseline_from, baseline_to, post_from, post_to,
    baseline_exposure, baseline_occurrences, post_exposure, post_occurrences,
    outcome, reasons, measurement, measurement_digest_sha256, read_bounds, measured_by
  ) VALUES (
    v_deployed.id, v_deployed.organization_id, v_deployed.submission_id, p_problem_key, p_signal_kind, p_signal_code,
    p_policy_version, p_window_policy_version, p_baseline_from, p_baseline_to, p_post_from, p_post_to,
    p_baseline_exposure, p_baseline_occurrences, p_post_exposure, p_post_occurrences,
    p_outcome, p_reasons, p_measurement, p_measurement_digest_sha256, p_read_bounds, p_measured_by
  ) RETURNING snapshot.id INTO v_snapshot;

  v_kind := NULL;
  IF p_outcome IN ('resolution_candidate', 'recurred', 'confounded') THEN
    v_kind := 'measurement_completed';
  ELSIF NOT EXISTS (SELECT 1 FROM public.improvement_lifecycle_events AS measuring
      WHERE measuring.event_kind = 'measuring' AND measuring.deployed_event_id = v_deployed.id) THEN
    v_kind := 'measuring';
  END IF;
  IF v_kind IS NOT NULL THEN
    INSERT INTO public.improvement_lifecycle_events (
      event_kind, engineering_review_id, engineering_review_version, engineering_request_digest_sha256,
      plan_v2_run_id, organization_id, submission_id, triage_review_id, triage_version, fix_commit_sha,
      deployed_event_id, measurement_snapshot_id
    ) VALUES (
      v_kind, v_deployed.engineering_review_id, v_deployed.engineering_review_version,
      v_deployed.engineering_request_digest_sha256, v_deployed.plan_v2_run_id, v_deployed.organization_id,
      v_deployed.submission_id, v_deployed.triage_review_id, v_deployed.triage_version, v_deployed.fix_commit_sha,
      v_deployed.id, v_snapshot
    );
  END IF;
  snapshot_id := v_snapshot;
  lifecycle_event_kind := v_kind;
  RETURN NEXT;
END;
$$;

-- ----------------------------------------------------------------------------
-- 7. Trusted server: a person's decision on the completed measurement.
--
-- Error codes: P0002 snapshot not found; 22023 malformed; B8407 not the
-- completed measurement; B8408 decision not allowed for this outcome;
-- 40001 version conflict (another decision was recorded meanwhile).
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.record_improvement_measurement_decision(
  p_snapshot_id uuid,
  p_expected_decision_version integer,
  p_decision text,
  p_rationale text,
  p_reviewer_actor_id uuid
)
RETURNS TABLE(decision_id uuid, decision_version integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_snapshot public.improvement_measurement_snapshots%ROWTYPE;
  v_current integer;
BEGIN
  IF p_snapshot_id IS NULL OR p_expected_decision_version IS NULL OR p_expected_decision_version < 0
     OR p_reviewer_actor_id IS NULL OR p_decision NOT IN ('resolved', 'recurred_confirmed', 'deferred')
     OR p_rationale IS NULL OR char_length(btrim(p_rationale)) NOT BETWEEN 1 AND 4000 THEN
    RAISE EXCEPTION 'invalid measurement decision' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_snapshot FROM public.improvement_measurement_snapshots AS snapshot WHERE snapshot.id = p_snapshot_id;
  IF v_snapshot.id IS NULL THEN
    RAISE EXCEPTION 'measurement snapshot not found' USING ERRCODE = 'P0002';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('improvement_decision:' || v_snapshot.deployed_event_id::text, 0));
  IF NOT EXISTS (SELECT 1 FROM public.improvement_lifecycle_events AS completed
      WHERE completed.event_kind = 'measurement_completed'
        AND completed.deployed_event_id = v_snapshot.deployed_event_id
        AND completed.measurement_snapshot_id = v_snapshot.id) THEN
    RAISE EXCEPTION 'only the completed measurement can be decided' USING ERRCODE = 'B8407';
  END IF;
  IF (p_decision = 'resolved' AND v_snapshot.outcome <> 'resolution_candidate')
     OR (p_decision = 'recurred_confirmed' AND v_snapshot.outcome <> 'recurred') THEN
    RAISE EXCEPTION 'decision % is not allowed for outcome %', p_decision, v_snapshot.outcome USING ERRCODE = 'B8408';
  END IF;
  SELECT coalesce(max(decision.decision_version), 0) INTO v_current
  FROM public.improvement_measurement_decisions AS decision
  WHERE decision.deployed_event_id = v_snapshot.deployed_event_id;
  IF v_current <> p_expected_decision_version THEN
    RAISE EXCEPTION 'decision version conflict' USING ERRCODE = '40001';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.user_profiles AS profile WHERE profile.id = p_reviewer_actor_id) THEN
    RAISE EXCEPTION 'reviewer not found' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  INSERT INTO public.improvement_measurement_decisions AS decision (
    deployed_event_id, snapshot_id, decision_version, decision, rationale, reviewer_actor_id)
  VALUES (v_snapshot.deployed_event_id, v_snapshot.id, v_current + 1, p_decision, btrim(p_rationale),
    p_reviewer_actor_id)
  RETURNING decision.id, decision.decision_version;
END;
$$;

-- ----------------------------------------------------------------------------
-- 8. Extraction measurement identity (trusted server): small rows only.
--
-- The producer identity and the exact B8.2 mapping revisions an extraction
-- recorded, without shipping its blob. Bounded; one row beyond the limit
-- signals truncation.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.read_improvement_extraction_units(
  p_organization_id uuid, p_document_ids uuid[], p_from timestamptz, p_to timestamptz, p_limit integer
)
RETURNS TABLE(extraction_id uuid, document_id uuid, created_at timestamptz,
  deployment_revision text, deployment_environment text, mapping_revisions text[])
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT extraction.id, extraction.document_id, extraction.created_at,
    extraction.data #>> '{extraction,runtime_identity_v1,identity,deployment_revision}',
    extraction.data #>> '{extraction,runtime_identity_v1,identity,deployment_environment}',
    coalesce((SELECT array_agg(DISTINCT (pin->>'revisionId') || ':' || (pin->>'digest')
        ORDER BY (pin->>'revisionId') || ':' || (pin->>'digest'))
      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(extraction.data
          #> '{extraction,content_layers_v1,pdf,priced_schedule_reconstruction_v1,pages}') = 'array'
        THEN extraction.data #> '{extraction,content_layers_v1,pdf,priced_schedule_reconstruction_v1,pages}'
        ELSE '[]'::jsonb END) AS page,
        jsonb_array_elements(CASE WHEN jsonb_typeof(page->'customer_header_mapping_pins') = 'array'
          THEN page->'customer_header_mapping_pins' ELSE '[]'::jsonb END) AS pin
      WHERE pin->>'revisionId' IS NOT NULL AND pin->>'digest' IS NOT NULL), ARRAY[]::text[])
  FROM public.document_extractions AS extraction
  WHERE extraction.organization_id = p_organization_id AND extraction.field_key IS NULL
    AND extraction.document_id = ANY (p_document_ids)
    AND extraction.created_at >= p_from AND extraction.created_at < p_to
  ORDER BY extraction.created_at, extraction.id
  LIMIT least(greatest(coalesce(p_limit, 500), 1), 2000) + 1
$$;

ALTER FUNCTION public.read_improvement_classification_work(integer) OWNER TO postgres;
ALTER FUNCTION public.record_improvement_producer_classification(uuid,text,boolean,text) OWNER TO postgres;
ALTER FUNCTION public.record_improvement_measurement_snapshot(uuid,text,text,text,text,text,timestamptz,timestamptz,timestamptz,timestamptz,integer,integer,integer,integer,text,text[],jsonb,text,jsonb,uuid) OWNER TO postgres;
ALTER FUNCTION public.record_improvement_measurement_decision(uuid,integer,text,text,uuid) OWNER TO postgres;
ALTER FUNCTION public.read_improvement_extraction_units(uuid,uuid[],timestamptz,timestamptz,integer) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.read_improvement_classification_work(integer)
  FROM PUBLIC, anon, authenticated, service_role, forgewing_engineering_worker;
REVOKE ALL ON FUNCTION public.record_improvement_producer_classification(uuid,text,boolean,text)
  FROM PUBLIC, anon, authenticated, service_role, forgewing_engineering_worker;
REVOKE ALL ON FUNCTION public.record_improvement_measurement_snapshot(uuid,text,text,text,text,text,timestamptz,timestamptz,timestamptz,timestamptz,integer,integer,integer,integer,text,text[],jsonb,text,jsonb,uuid)
  FROM PUBLIC, anon, authenticated, service_role, forgewing_engineering_worker;
REVOKE ALL ON FUNCTION public.record_improvement_measurement_decision(uuid,integer,text,text,uuid)
  FROM PUBLIC, anon, authenticated, service_role, forgewing_engineering_worker;
REVOKE ALL ON FUNCTION public.read_improvement_extraction_units(uuid,uuid[],timestamptz,timestamptz,integer)
  FROM PUBLIC, anon, authenticated, service_role, forgewing_engineering_worker;

GRANT EXECUTE ON FUNCTION public.read_improvement_classification_work(integer) TO forgewing_engineering_worker;
GRANT EXECUTE ON FUNCTION public.record_improvement_producer_classification(uuid,text,boolean,text)
  TO forgewing_engineering_worker;
GRANT EXECUTE ON FUNCTION public.record_improvement_measurement_snapshot(uuid,text,text,text,text,text,timestamptz,timestamptz,timestamptz,timestamptz,integer,integer,integer,integer,text,text[],jsonb,text,jsonb,uuid)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.record_improvement_measurement_decision(uuid,integer,text,text,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.read_improvement_extraction_units(uuid,uuid[],timestamptz,timestamptz,integer)
  TO service_role;
