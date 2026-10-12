-- ============================================================================
-- Improvement lifecycle and producer identity (B8.4b)
--
-- B8 is complete for a problem only when EightForge can show whether the
-- original friction decreased after deployment. This migration records the two
-- facts that claim rests on, and stamps the producer identity it will be
-- measured against:
--
-- 1. improvement_lifecycle_events (append-only):
--    implemented  a person attests the exact merge commit that ships an
--                 approved, triage-sourced engineering request. Shipping is
--                 never inferred from Linear status or PR titles.
--    deployed     the trusted worker proves, by git ancestry in its verified
--                 checkout, that the attested commit is contained in a
--                 production revision the application itself observed. Both
--                 SHAs, the method, the checkout and the observation persist.
--    The measuring / measurement_completed states arrive with B8.4c.
--    Assessment-sourced requests carry no originating friction and are refused
--    explicitly: they are not measurable for B8 recurrence.
--
-- 2. project_validation_runs gains the producer identity of each run: the
--    deployment revision and environment that ran it, and the rule catalogue
--    fingerprint in force. Written once at insert; history stays NULL, which
--    means "producer not recorded", never an invented revision.
--
-- Nothing here measures, classifies, closes or projects anything.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Validator run producer identity.
-- ----------------------------------------------------------------------------
ALTER TABLE public.project_validation_runs
  ADD COLUMN IF NOT EXISTS deployment_revision text,
  ADD COLUMN IF NOT EXISTS deployment_environment text,
  ADD COLUMN IF NOT EXISTS rule_catalogue_fingerprint text;

DO $b84b_validation_run_identity$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
      WHERE conrelid = 'public.project_validation_runs'::regclass
        AND conname = 'project_validation_runs_deployment_revision_check') THEN
    ALTER TABLE public.project_validation_runs
      ADD CONSTRAINT project_validation_runs_deployment_revision_check
      CHECK (deployment_revision IS NULL OR deployment_revision ~ '^[a-f0-9]{40}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
      WHERE conrelid = 'public.project_validation_runs'::regclass
        AND conname = 'project_validation_runs_deployment_environment_check') THEN
    ALTER TABLE public.project_validation_runs
      ADD CONSTRAINT project_validation_runs_deployment_environment_check
      CHECK (deployment_environment IS NULL
        OR deployment_environment IN ('production', 'preview', 'development'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
      WHERE conrelid = 'public.project_validation_runs'::regclass
        AND conname = 'project_validation_runs_rule_catalogue_fingerprint_check') THEN
    ALTER TABLE public.project_validation_runs
      ADD CONSTRAINT project_validation_runs_rule_catalogue_fingerprint_check
      CHECK (rule_catalogue_fingerprint IS NULL
        OR rule_catalogue_fingerprint ~ '^rule-catalogue-v1:sha256:[a-f0-9]{64}$');
  END IF;
END
$b84b_validation_run_identity$;

-- The producer of a run is a historical fact: set at insert, never rewritten.
CREATE OR REPLACE FUNCTION public.reject_project_validation_run_identity_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.deployment_revision IS DISTINCT FROM OLD.deployment_revision
     OR NEW.deployment_environment IS DISTINCT FROM OLD.deployment_environment
     OR NEW.rule_catalogue_fingerprint IS DISTINCT FROM OLD.rule_catalogue_fingerprint THEN
    RAISE EXCEPTION 'validation run producer identity is immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS project_validation_runs_identity_immutable ON public.project_validation_runs;
CREATE TRIGGER project_validation_runs_identity_immutable
  BEFORE UPDATE ON public.project_validation_runs
  FOR EACH ROW EXECUTE FUNCTION public.reject_project_validation_run_identity_change();

-- First observation of each production revision, for the deployment proof.
CREATE INDEX IF NOT EXISTS project_validation_runs_production_revision_idx
  ON public.project_validation_runs (deployment_revision, created_at, id)
  WHERE deployment_environment = 'production' AND deployment_revision IS NOT NULL;

-- ----------------------------------------------------------------------------
-- 2. Append-only improvement lifecycle events.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.improvement_lifecycle_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_kind text NOT NULL CHECK (event_kind IN ('implemented', 'deployed')),

  -- The approved engineering request this event is about.
  engineering_review_id uuid NOT NULL
    REFERENCES public.workflow_repository_plan_recommendation_reviews(id) ON DELETE RESTRICT,
  engineering_review_version integer NOT NULL CHECK (engineering_review_version > 0),
  engineering_request_digest_sha256 text NOT NULL
    CHECK (engineering_request_digest_sha256 ~ '^[a-f0-9]{64}$'),
  plan_v2_run_id uuid NOT NULL REFERENCES public.workflow_repository_plan_v2_runs(id) ON DELETE RESTRICT,

  -- The originating friction, copied from the run's triage pin.
  organization_id uuid NOT NULL,
  submission_id uuid NOT NULL,
  triage_review_id uuid NOT NULL,
  triage_version integer NOT NULL,

  fix_commit_sha text NOT NULL CHECK (fix_commit_sha ~ '^[a-f0-9]{40}$'),

  -- implemented: the attesting person.
  attested_by uuid REFERENCES public.user_profiles(id) ON DELETE RESTRICT,

  -- deployed: the proof.
  implemented_event_id uuid REFERENCES public.improvement_lifecycle_events(id) ON DELETE RESTRICT,
  production_revision text CHECK (production_revision IS NULL OR production_revision ~ '^[a-f0-9]{40}$'),
  ancestry_method text CHECK (ancestry_method IS NULL OR ancestry_method = 'git_merge_base_is_ancestor'),
  verifier_checkout_commit text
    CHECK (verifier_checkout_commit IS NULL OR verifier_checkout_commit ~ '^[a-f0-9]{40}$'),
  deployment_observation_source text
    CHECK (deployment_observation_source IS NULL OR deployment_observation_source = 'project_validation_run'),
  deployment_observation_id uuid REFERENCES public.project_validation_runs(id) ON DELETE RESTRICT,
  deployment_observed_at timestamptz,

  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT improvement_lifecycle_events_triage_fkey
    FOREIGN KEY (triage_review_id, triage_version)
    REFERENCES public.improvement_signal_triage_reviews(id, triage_version) ON DELETE RESTRICT,
  CONSTRAINT improvement_lifecycle_events_submission_fkey
    FOREIGN KEY (submission_id) REFERENCES public.improvement_signal_submissions(id) ON DELETE RESTRICT,
  CONSTRAINT improvement_lifecycle_events_shape_check CHECK (
    (event_kind = 'implemented'
      AND attested_by IS NOT NULL AND implemented_event_id IS NULL
      AND production_revision IS NULL AND ancestry_method IS NULL AND verifier_checkout_commit IS NULL
      AND deployment_observation_source IS NULL AND deployment_observation_id IS NULL
      AND deployment_observed_at IS NULL)
    OR (event_kind = 'deployed'
      AND attested_by IS NULL AND implemented_event_id IS NOT NULL
      AND production_revision IS NOT NULL AND ancestry_method IS NOT NULL AND verifier_checkout_commit IS NOT NULL
      AND deployment_observation_source IS NOT NULL AND deployment_observation_id IS NOT NULL
      AND deployment_observed_at IS NOT NULL)
  )
);

-- One attestation per approved request; one deployment proof per attestation.
CREATE UNIQUE INDEX IF NOT EXISTS improvement_lifecycle_events_implemented_unique
  ON public.improvement_lifecycle_events (engineering_review_id) WHERE event_kind = 'implemented';
CREATE UNIQUE INDEX IF NOT EXISTS improvement_lifecycle_events_deployed_unique
  ON public.improvement_lifecycle_events (implemented_event_id) WHERE event_kind = 'deployed';
CREATE INDEX IF NOT EXISTS improvement_lifecycle_events_submission_idx
  ON public.improvement_lifecycle_events (submission_id, recorded_at);

CREATE OR REPLACE FUNCTION public.reject_improvement_lifecycle_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'improvement_lifecycle_events is append-only: % rejected', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

DROP TRIGGER IF EXISTS improvement_lifecycle_events_immutable ON public.improvement_lifecycle_events;
CREATE TRIGGER improvement_lifecycle_events_immutable
  BEFORE UPDATE OR DELETE ON public.improvement_lifecycle_events
  FOR EACH ROW EXECUTE FUNCTION public.reject_improvement_lifecycle_event_mutation();
DROP TRIGGER IF EXISTS improvement_lifecycle_events_no_truncate ON public.improvement_lifecycle_events;
CREATE TRIGGER improvement_lifecycle_events_no_truncate
  BEFORE TRUNCATE ON public.improvement_lifecycle_events
  FOR EACH STATEMENT EXECUTE FUNCTION public.reject_improvement_lifecycle_event_mutation();

ALTER TABLE public.improvement_lifecycle_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.improvement_lifecycle_events FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.improvement_lifecycle_events TO service_role;

-- ----------------------------------------------------------------------------
-- 3. Human attestation of the fix commit (trusted server, platform reviewer).
--
-- Error codes: P0002 review or run not found; 22023 malformed input;
-- B8401 request not approved; B8402 review superseded by a later version;
-- B8403 not measurable (assessment-sourced, no originating friction);
-- B8404 a different commit is already attested.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.record_improvement_fix_attestation(
  p_engineering_review_id uuid,
  p_engineering_review_version integer,
  p_engineering_request_digest_sha256 text,
  p_fix_commit_sha text,
  p_attested_by uuid
)
RETURNS TABLE(event_id uuid, inserted boolean, recorded_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_review public.workflow_repository_plan_recommendation_reviews%ROWTYPE;
  v_run public.workflow_repository_plan_v2_runs%ROWTYPE;
  v_triage public.improvement_signal_triage_reviews%ROWTYPE;
  v_existing public.improvement_lifecycle_events%ROWTYPE;
BEGIN
  IF p_engineering_review_id IS NULL OR p_engineering_review_version IS NULL OR p_attested_by IS NULL
     OR p_engineering_request_digest_sha256 IS NULL OR p_engineering_request_digest_sha256 !~ '^[a-f0-9]{64}$'
     OR p_fix_commit_sha IS NULL OR p_fix_commit_sha !~ '^[a-f0-9]{40}$' THEN
    RAISE EXCEPTION 'invalid fix attestation' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('improvement_lifecycle:' || p_engineering_review_id::text, 0));

  SELECT * INTO v_review FROM public.workflow_repository_plan_recommendation_reviews AS review
  WHERE review.id = p_engineering_review_id AND review.review_version = p_engineering_review_version;
  IF v_review.id IS NULL THEN
    RAISE EXCEPTION 'engineering review not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_review.disposition NOT IN ('accepted', 'modified') THEN
    RAISE EXCEPTION 'engineering request not approved' USING ERRCODE = 'B8401';
  END IF;
  IF EXISTS (SELECT 1 FROM public.workflow_repository_plan_recommendation_reviews AS later
      WHERE later.plan_v2_run_id = v_review.plan_v2_run_id
        AND later.recommendation_id = v_review.recommendation_id
        AND later.review_version > v_review.review_version) THEN
    RAISE EXCEPTION 'engineering review superseded' USING ERRCODE = 'B8402';
  END IF;

  SELECT * INTO v_run FROM public.workflow_repository_plan_v2_runs AS run
  WHERE run.id = v_review.plan_v2_run_id AND run.plan_v2_digest_sha256 = v_review.plan_v2_digest_sha256;
  IF v_run.id IS NULL THEN
    RAISE EXCEPTION 'exact Plan V2 not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_run.triage_review_id IS NULL OR v_run.triage_version IS NULL THEN
    RAISE EXCEPTION 'assessment-sourced request has no originating friction' USING ERRCODE = 'B8403';
  END IF;
  SELECT * INTO v_triage FROM public.improvement_signal_triage_reviews AS triage
  WHERE triage.id = v_run.triage_review_id AND triage.triage_version = v_run.triage_version;
  IF v_triage.id IS NULL THEN
    RAISE EXCEPTION 'originating triage not found' USING ERRCODE = 'P0002';
  END IF;

  SELECT * INTO v_existing FROM public.improvement_lifecycle_events AS event
  WHERE event.engineering_review_id = v_review.id AND event.event_kind = 'implemented';
  IF v_existing.id IS NOT NULL THEN
    IF v_existing.fix_commit_sha <> p_fix_commit_sha
       OR v_existing.engineering_request_digest_sha256 <> p_engineering_request_digest_sha256 THEN
      RAISE EXCEPTION 'a different fix commit is already attested' USING ERRCODE = 'B8404';
    END IF;
    RETURN QUERY SELECT v_existing.id, false, v_existing.recorded_at;
    RETURN;
  END IF;

  RETURN QUERY
  INSERT INTO public.improvement_lifecycle_events AS event (
    event_kind, engineering_review_id, engineering_review_version, engineering_request_digest_sha256,
    plan_v2_run_id, organization_id, submission_id, triage_review_id, triage_version,
    fix_commit_sha, attested_by
  ) VALUES (
    'implemented', v_review.id, v_review.review_version, p_engineering_request_digest_sha256,
    v_run.id, v_triage.organization_id, v_triage.submission_id, v_triage.id, v_triage.triage_version,
    p_fix_commit_sha, p_attested_by
  )
  RETURNING event.id, true, event.recorded_at;
END;
$$;

-- ----------------------------------------------------------------------------
-- 4. Deployment proof inputs (trusted worker).
--
-- Attested fixes still awaiting a deployment proof, and the first observation
-- of every production revision, oldest first. The worker proves ancestry in its
-- own verified checkout; the database only ever stores what it proved.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.read_improvement_deployment_work(p_limit integer)
RETURNS TABLE(pending_attestations jsonb, production_observations jsonb, observations_truncated boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_limit integer := least(greatest(coalesce(p_limit, 25), 1), 50);
  v_observation_cap constant integer := 1000;
  v_observations jsonb;
  v_count integer;
BEGIN
  SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'revision', observed.deployment_revision, 'run_id', observed.id, 'observed_at', observed.created_at)
      ORDER BY observed.created_at, observed.id), '[]'::jsonb),
    count(*)
  INTO v_observations, v_count
  FROM (
    SELECT * FROM (
      SELECT DISTINCT ON (run.deployment_revision) run.deployment_revision, run.id, run.created_at
      FROM public.project_validation_runs AS run
      WHERE run.deployment_environment = 'production' AND run.deployment_revision IS NOT NULL
      ORDER BY run.deployment_revision, run.created_at, run.id
    ) AS revisions
    ORDER BY revisions.created_at, revisions.id
    LIMIT v_observation_cap + 1
  ) AS observed;

  RETURN QUERY SELECT
    (SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'event_id', pending.id, 'fix_commit_sha', pending.fix_commit_sha) ORDER BY pending.recorded_at, pending.id),
        '[]'::jsonb)
     FROM (
       SELECT implemented.id, implemented.fix_commit_sha, implemented.recorded_at
       FROM public.improvement_lifecycle_events AS implemented
       WHERE implemented.event_kind = 'implemented'
         AND NOT EXISTS (SELECT 1 FROM public.improvement_lifecycle_events AS deployed
           WHERE deployed.event_kind = 'deployed' AND deployed.implemented_event_id = implemented.id)
       ORDER BY implemented.recorded_at, implemented.id
       LIMIT v_limit
     ) AS pending),
    -- At most cap + 1 were read: drop the sentinel (zero-based index cap) and report truncation.
    CASE WHEN v_count > v_observation_cap
      THEN v_observations - v_observation_cap ELSE v_observations END,
    v_count > v_observation_cap;
END;
$$;

-- ----------------------------------------------------------------------------
-- 5. Record a proven deployment (trusted worker).
--
-- The observation must be the first production validation run that carried
-- the revision, so the recorded time is deterministic and conservative.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.record_improvement_deployment(
  p_implemented_event_id uuid,
  p_production_revision text,
  p_observation_run_id uuid,
  p_verifier_checkout_commit text
)
RETURNS TABLE(event_id uuid, inserted boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_implemented public.improvement_lifecycle_events%ROWTYPE;
  v_existing public.improvement_lifecycle_events%ROWTYPE;
  v_run public.project_validation_runs%ROWTYPE;
BEGIN
  IF p_implemented_event_id IS NULL OR p_observation_run_id IS NULL
     OR p_production_revision IS NULL OR p_production_revision !~ '^[a-f0-9]{40}$'
     OR p_verifier_checkout_commit IS NULL OR p_verifier_checkout_commit !~ '^[a-f0-9]{40}$' THEN
    RAISE EXCEPTION 'invalid deployment proof' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('improvement_deployment:' || p_implemented_event_id::text, 0));

  SELECT * INTO v_implemented FROM public.improvement_lifecycle_events AS event
  WHERE event.id = p_implemented_event_id AND event.event_kind = 'implemented';
  IF v_implemented.id IS NULL THEN
    RAISE EXCEPTION 'attested fix not found' USING ERRCODE = 'P0002';
  END IF;

  SELECT * INTO v_run FROM public.project_validation_runs AS run
  WHERE run.id = p_observation_run_id
    AND run.deployment_environment = 'production' AND run.deployment_revision = p_production_revision;
  IF v_run.id IS NULL OR EXISTS (SELECT 1 FROM public.project_validation_runs AS earlier
      WHERE earlier.deployment_environment = 'production'
        AND earlier.deployment_revision = p_production_revision
        AND (earlier.created_at, earlier.id) < (v_run.created_at, v_run.id)) THEN
    RAISE EXCEPTION 'not the first production observation of the revision' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_existing FROM public.improvement_lifecycle_events AS event
  WHERE event.implemented_event_id = v_implemented.id AND event.event_kind = 'deployed';
  IF v_existing.id IS NOT NULL THEN
    IF v_existing.production_revision <> p_production_revision
       OR v_existing.deployment_observation_id <> p_observation_run_id THEN
      RAISE EXCEPTION 'a different deployment is already proven' USING ERRCODE = 'B8404';
    END IF;
    RETURN QUERY SELECT v_existing.id, false;
    RETURN;
  END IF;

  RETURN QUERY
  INSERT INTO public.improvement_lifecycle_events AS event (
    event_kind, engineering_review_id, engineering_review_version, engineering_request_digest_sha256,
    plan_v2_run_id, organization_id, submission_id, triage_review_id, triage_version, fix_commit_sha,
    implemented_event_id, production_revision, ancestry_method, verifier_checkout_commit,
    deployment_observation_source, deployment_observation_id, deployment_observed_at
  ) VALUES (
    'deployed', v_implemented.engineering_review_id, v_implemented.engineering_review_version,
    v_implemented.engineering_request_digest_sha256, v_implemented.plan_v2_run_id,
    v_implemented.organization_id, v_implemented.submission_id, v_implemented.triage_review_id,
    v_implemented.triage_version, v_implemented.fix_commit_sha,
    v_implemented.id, p_production_revision, 'git_merge_base_is_ancestor', p_verifier_checkout_commit,
    'project_validation_run', v_run.id, v_run.created_at
  )
  RETURNING event.id, true;
END;
$$;

ALTER FUNCTION public.record_improvement_fix_attestation(uuid,integer,text,text,uuid) OWNER TO postgres;
ALTER FUNCTION public.read_improvement_deployment_work(integer) OWNER TO postgres;
ALTER FUNCTION public.record_improvement_deployment(uuid,text,uuid,text) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.record_improvement_fix_attestation(uuid,integer,text,text,uuid)
  FROM PUBLIC, anon, authenticated, service_role, forgewing_engineering_worker;
REVOKE ALL ON FUNCTION public.read_improvement_deployment_work(integer)
  FROM PUBLIC, anon, authenticated, service_role, forgewing_engineering_worker;
REVOKE ALL ON FUNCTION public.record_improvement_deployment(uuid,text,uuid,text)
  FROM PUBLIC, anon, authenticated, service_role, forgewing_engineering_worker;
REVOKE ALL ON FUNCTION public.reject_project_validation_run_identity_change() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reject_improvement_lifecycle_event_mutation() FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.record_improvement_fix_attestation(uuid,integer,text,text,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.read_improvement_deployment_work(integer) TO forgewing_engineering_worker;
GRANT EXECUTE ON FUNCTION public.record_improvement_deployment(uuid,text,uuid,text) TO forgewing_engineering_worker;
