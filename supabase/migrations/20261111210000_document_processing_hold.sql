-- Document processing hold: a durable, platform-wide admission fence.
--
-- Every route that can create an analysis job or write extraction output asks
-- public.admit_document_processing() for an admission before its first write.
-- An operator can hold processing; a held control refuses new admissions, and a
-- trigger refuses unadmitted job creation and job claims, so an application
-- build that predates this migration cannot start processing either.
--
-- Default state: processing allowed. Holding and releasing are explicit,
-- service-role-only, audited transitions. Nothing here deletes, rewrites or
-- completes a job, a document status, or any extraction output.
--
-- Drain is time-bounded, never status-based. A request admitted before the
-- hold may keep writing (including after() work) until its lease expires; the
-- lease is longer than any platform function duration. See
-- docs/runbooks/document-processing-hold.md.

SET lock_timeout = '10s';

-- ---------------------------------------------------------------------------
-- 1. Control (singleton)
-- ---------------------------------------------------------------------------
CREATE TABLE public.document_processing_control (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  held boolean NOT NULL DEFAULT false,
  hold_version bigint NOT NULL DEFAULT 0 CHECK (hold_version >= 0),
  held_since timestamptz,
  admission_lease_seconds integer NOT NULL DEFAULT 900
    CHECK (admission_lease_seconds BETWEEN 900 AND 3600),
  changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_transition_id uuid,
  CHECK ((held AND held_since IS NOT NULL) OR (NOT held AND held_since IS NULL))
);

INSERT INTO public.document_processing_control (singleton) VALUES (true);

COMMENT ON TABLE public.document_processing_control IS
  'Singleton processing hold. Changed only by set_document_processing_hold(); a missing row refuses all admission.';

-- ---------------------------------------------------------------------------
-- 2. Transition audit (append-only)
-- ---------------------------------------------------------------------------
CREATE TABLE public.document_processing_hold_transitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_key uuid NOT NULL UNIQUE,
  request_digest_sha256 text NOT NULL CHECK (request_digest_sha256 ~ '^[a-f0-9]{64}$'),
  action text NOT NULL CHECK (action IN ('hold', 'release')),
  outcome text NOT NULL CHECK (outcome IN ('applied', 'already_held', 'already_released')),
  actor_id uuid NOT NULL REFERENCES public.user_profiles(id) ON DELETE RESTRICT,
  actor_email text,
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 1000),
  held_before boolean NOT NULL,
  held_after boolean NOT NULL,
  hold_version_after bigint NOT NULL CHECK (hold_version_after >= 0),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((outcome = 'applied' AND held_before <> held_after)
    OR (outcome <> 'applied' AND held_before = held_after)),
  CHECK (held_after = (action = 'hold'))
);

ALTER TABLE public.document_processing_control
  ADD CONSTRAINT document_processing_control_last_transition_fk
  FOREIGN KEY (last_transition_id)
  REFERENCES public.document_processing_hold_transitions(id) ON DELETE RESTRICT;

-- ---------------------------------------------------------------------------
-- 3. Admission ledger
-- ---------------------------------------------------------------------------
-- One row per admitted request. Not a job system: no retries, no queue, no
-- status machine. It records that a request which may write was admitted, at
-- which hold version, and until when it may still be writing.
CREATE TABLE public.document_processing_admissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_point text NOT NULL CHECK (entry_point IN (
    'documents_process', 'document_analyze', 'job_process', 'document_evaluate'
  )),
  organization_id uuid NOT NULL,
  document_id uuid NOT NULL,
  job_id uuid,
  admitted_hold_version bigint NOT NULL CHECK (admitted_hold_version >= 0),
  admitted_at timestamptz NOT NULL,
  lease_expires_at timestamptz NOT NULL,
  closed_at timestamptz,
  outcome text CHECK (outcome IN ('completed', 'failed')),
  CHECK (lease_expires_at > admitted_at),
  CHECK ((closed_at IS NULL) = (outcome IS NULL)),
  CHECK ((entry_point = 'job_process') = (job_id IS NOT NULL))
);

CREATE INDEX document_processing_admissions_lease_idx
  ON public.document_processing_admissions (lease_expires_at);
CREATE INDEX document_processing_admissions_open_idx
  ON public.document_processing_admissions (lease_expires_at)
  WHERE closed_at IS NULL;

-- ---------------------------------------------------------------------------
-- 4. Job linkage (nullable: rows written by older builds stay valid)
-- ---------------------------------------------------------------------------
ALTER TABLE public.document_analysis_jobs
  ADD COLUMN admission_id uuid
    REFERENCES public.document_processing_admissions(id) ON DELETE RESTRICT,
  ADD COLUMN claim_admission_id uuid
    REFERENCES public.document_processing_admissions(id) ON DELETE RESTRICT;

CREATE INDEX document_analysis_jobs_nonterminal_idx
  ON public.document_analysis_jobs (status, created_at)
  WHERE status IN ('queued', 'running');

-- ---------------------------------------------------------------------------
-- 5. Immutability guards
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.document_processing_hold_refuse_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME
    USING ERRCODE = '55000', DETAIL = 'document_processing_hold_immutable';
END;
$$;

CREATE TRIGGER document_processing_hold_transitions_immutable
  BEFORE UPDATE OR DELETE ON public.document_processing_hold_transitions
  FOR EACH ROW EXECUTE FUNCTION public.document_processing_hold_refuse_mutation();
CREATE TRIGGER document_processing_hold_transitions_no_truncate
  BEFORE TRUNCATE ON public.document_processing_hold_transitions
  FOR EACH STATEMENT EXECUTE FUNCTION public.document_processing_hold_refuse_mutation();

CREATE TRIGGER document_processing_control_no_delete
  BEFORE DELETE ON public.document_processing_control
  FOR EACH ROW EXECUTE FUNCTION public.document_processing_hold_refuse_mutation();
CREATE TRIGGER document_processing_control_no_truncate
  BEFORE TRUNCATE ON public.document_processing_control
  FOR EACH STATEMENT EXECUTE FUNCTION public.document_processing_hold_refuse_mutation();

CREATE TRIGGER document_processing_admissions_no_delete
  BEFORE DELETE ON public.document_processing_admissions
  FOR EACH ROW EXECUTE FUNCTION public.document_processing_hold_refuse_mutation();
CREATE TRIGGER document_processing_admissions_no_truncate
  BEFORE TRUNCATE ON public.document_processing_admissions
  FOR EACH STATEMENT EXECUTE FUNCTION public.document_processing_hold_refuse_mutation();

-- An admission may only be closed, once. Its identity, fence version and lease
-- never change, so closing can never shorten the drain.
CREATE FUNCTION public.document_processing_admissions_close_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF OLD.closed_at IS NOT NULL
     OR NEW.closed_at IS NULL
     OR NEW.id IS DISTINCT FROM OLD.id
     OR NEW.entry_point IS DISTINCT FROM OLD.entry_point
     OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.document_id IS DISTINCT FROM OLD.document_id
     OR NEW.job_id IS DISTINCT FROM OLD.job_id
     OR NEW.admitted_hold_version IS DISTINCT FROM OLD.admitted_hold_version
     OR NEW.admitted_at IS DISTINCT FROM OLD.admitted_at
     OR NEW.lease_expires_at IS DISTINCT FROM OLD.lease_expires_at THEN
    RAISE EXCEPTION 'an admission can only be closed once'
      USING ERRCODE = '55000', DETAIL = 'document_processing_hold_immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER document_processing_admissions_close_only
  BEFORE UPDATE ON public.document_processing_admissions
  FOR EACH ROW EXECUTE FUNCTION public.document_processing_admissions_close_only();

-- ---------------------------------------------------------------------------
-- 6. Job fence: job creation and queued -> running claims
-- ---------------------------------------------------------------------------
-- While held, a job row can be created only under a live admission, and a
-- queued job can be claimed only under a live claim admission. Older builds
-- never set either column, so they are refused while held and unaffected
-- otherwise. Terminal status writes (completed / failed) are never fenced:
-- in-flight work must always be able to record its outcome.
CREATE FUNCTION public.document_analysis_jobs_hold_fence()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_held boolean;
  v_admission uuid;
BEGIN
  IF TG_OP = 'UPDATE' AND NOT (OLD.status = 'queued' AND NEW.status = 'running') THEN
    RETURN NEW;
  END IF;

  -- Shared hold lock: a fence decision is made wholly before or wholly after
  -- a hold transition commits (see section 7).
  PERFORM pg_catalog.pg_advisory_xact_lock_shared(
    pg_catalog.hashtextextended('eightforge:document_processing_hold', 0));
  SELECT c.held INTO v_held
  FROM public.document_processing_control c
  WHERE c.singleton;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'document processing control is missing'
      USING ERRCODE = '55000', DETAIL = 'document_processing_hold_unverified';
  END IF;
  IF NOT v_held THEN
    RETURN NEW;
  END IF;

  v_admission := CASE WHEN TG_OP = 'INSERT' THEN NEW.admission_id ELSE NEW.claim_admission_id END;
  IF v_admission IS NOT NULL AND (TG_OP = 'INSERT' OR v_admission IS DISTINCT FROM OLD.claim_admission_id)
     AND EXISTS (
       SELECT 1 FROM public.document_processing_admissions a
       WHERE a.id = v_admission
         AND a.document_id = NEW.document_id
         AND a.closed_at IS NULL
         AND a.lease_expires_at > clock_timestamp()
     ) THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'document processing is held'
    USING ERRCODE = '55000', DETAIL = 'document_processing_hold_active';
END;
$$;

CREATE TRIGGER document_analysis_jobs_hold_fence
  BEFORE INSERT OR UPDATE OF status ON public.document_analysis_jobs
  FOR EACH ROW EXECUTE FUNCTION public.document_analysis_jobs_hold_fence();

-- ---------------------------------------------------------------------------
-- 7. Admission
-- ---------------------------------------------------------------------------
-- Ordering: admission and the job fence take the hold advisory lock SHARED; a
-- hold transition takes it EXCLUSIVE. Heavyweight lock queues are fair (a
-- waiting exclusive request blocks later shared requests), so a stream of
-- admissions cannot starve a hold, which row-level FOR SHARE / FOR UPDATE
-- would allow. Each reads the control row after acquiring the lock, so it
-- sees every transition committed before it.
CREATE FUNCTION public.admit_document_processing(
  p_entry_point text,
  p_organization_id uuid,
  p_document_id uuid,
  p_job_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_control public.document_processing_control%ROWTYPE;
  v_now timestamptz;
  v_id uuid;
  v_lease timestamptz;
BEGIN
  IF p_entry_point IS NULL OR p_organization_id IS NULL OR p_document_id IS NULL THEN
    RAISE EXCEPTION 'entry point, organization and document are required'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock_shared(
    pg_catalog.hashtextextended('eightforge:document_processing_hold', 0));
  SELECT * INTO v_control
  FROM public.document_processing_control
  WHERE singleton;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'document processing control is missing'
      USING ERRCODE = '55000', DETAIL = 'document_processing_hold_unverified';
  END IF;

  -- Stamped after the lock: every admission of a hold version is ordered
  -- before the transition that ends it (admitted_at < held_since).
  v_now := clock_timestamp();

  IF v_control.held THEN
    RETURN jsonb_build_object(
      'admitted', false,
      'reason', 'held',
      'hold_version', v_control.hold_version
    );
  END IF;

  INSERT INTO public.document_processing_admissions (
    entry_point, organization_id, document_id, job_id,
    admitted_hold_version, admitted_at, lease_expires_at
  ) VALUES (
    p_entry_point, p_organization_id, p_document_id, p_job_id,
    v_control.hold_version, v_now,
    v_now + make_interval(secs => v_control.admission_lease_seconds)
  )
  RETURNING id, lease_expires_at INTO v_id, v_lease;

  RETURN jsonb_build_object(
    'admitted', true,
    'admission_id', v_id,
    'hold_version', v_control.hold_version,
    'lease_expires_at', v_lease
  );
END;
$$;

CREATE FUNCTION public.close_document_processing_admission(
  p_admission_id uuid,
  p_outcome text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_row public.document_processing_admissions%ROWTYPE;
BEGIN
  IF p_admission_id IS NULL OR p_outcome IS NULL OR p_outcome NOT IN ('completed', 'failed') THEN
    RAISE EXCEPTION 'admission id and outcome (completed | failed) are required'
      USING ERRCODE = '22023';
  END IF;

  UPDATE public.document_processing_admissions
  SET closed_at = clock_timestamp(), outcome = p_outcome
  WHERE id = p_admission_id AND closed_at IS NULL
  RETURNING * INTO v_row;
  IF FOUND THEN
    RETURN jsonb_build_object('closed', true, 'outcome', v_row.outcome);
  END IF;

  SELECT * INTO v_row FROM public.document_processing_admissions WHERE id = p_admission_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'admission not found' USING ERRCODE = '22023';
  END IF;
  RETURN jsonb_build_object('closed', false, 'outcome', v_row.outcome);
END;
$$;

-- ---------------------------------------------------------------------------
-- 8. Operator transition (hold / release)
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.set_document_processing_hold(
  p_request_key uuid,
  p_action text,
  p_reason text,
  p_actor_id uuid,
  p_actor_email text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_control public.document_processing_control%ROWTYPE;
  v_existing public.document_processing_hold_transitions%ROWTYPE;
  v_reason text := btrim(coalesce(p_reason, ''));
  v_digest text;
  v_outcome text;
  v_now timestamptz;
  v_transition public.document_processing_hold_transitions%ROWTYPE;
BEGIN
  IF p_request_key IS NULL OR p_actor_id IS NULL
     OR p_action IS NULL OR p_action NOT IN ('hold', 'release')
     OR length(v_reason) NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'request key, actor, action (hold | release) and reason are required'
      USING ERRCODE = '22023';
  END IF;

  v_digest := encode(sha256(convert_to(jsonb_build_object(
    'action', p_action,
    'actor_id', p_actor_id,
    'reason', v_reason
  )::text, 'UTF8')), 'hex');

  -- Every transition and every replay serializes on the exclusive hold lock,
  -- after all admissions already holding it shared have committed.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('eightforge:document_processing_hold', 0));
  SELECT * INTO v_control
  FROM public.document_processing_control
  WHERE singleton
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'document processing control is missing'
      USING ERRCODE = '55000', DETAIL = 'document_processing_hold_unverified';
  END IF;
  v_now := clock_timestamp();

  SELECT * INTO v_existing
  FROM public.document_processing_hold_transitions
  WHERE request_key = p_request_key;
  IF FOUND THEN
    IF v_existing.request_digest_sha256 <> v_digest THEN
      RAISE EXCEPTION 'request key was already used for a different request'
        USING ERRCODE = '22023', DETAIL = 'document_processing_hold_replay_conflict';
    END IF;
    RETURN jsonb_build_object(
      'replayed', true,
      'transition_id', v_existing.id,
      'action', v_existing.action,
      'outcome', v_existing.outcome,
      'held', v_control.held,
      'hold_version', v_control.hold_version,
      'recorded_at', v_existing.recorded_at
    );
  END IF;

  IF p_action = 'hold' THEN
    v_outcome := CASE WHEN v_control.held THEN 'already_held' ELSE 'applied' END;
  ELSE
    v_outcome := CASE WHEN v_control.held THEN 'applied' ELSE 'already_released' END;
  END IF;

  INSERT INTO public.document_processing_hold_transitions (
    request_key, request_digest_sha256, action, outcome, actor_id, actor_email,
    reason, held_before, held_after, hold_version_after, recorded_at
  ) VALUES (
    p_request_key, v_digest, p_action, v_outcome, p_actor_id, p_actor_email,
    v_reason, v_control.held, p_action = 'hold',
    v_control.hold_version + CASE WHEN v_outcome = 'applied' THEN 1 ELSE 0 END,
    v_now
  )
  RETURNING * INTO v_transition;

  IF v_outcome = 'applied' THEN
    UPDATE public.document_processing_control
    SET held = (p_action = 'hold'),
        hold_version = v_transition.hold_version_after,
        held_since = CASE WHEN p_action = 'hold' THEN v_now ELSE NULL END,
        changed_at = v_now,
        last_transition_id = v_transition.id
    WHERE singleton
    RETURNING * INTO v_control;
  END IF;

  RETURN jsonb_build_object(
    'replayed', false,
    'transition_id', v_transition.id,
    'action', v_transition.action,
    'outcome', v_transition.outcome,
    'held', v_control.held,
    'hold_version', v_control.hold_version,
    'recorded_at', v_transition.recorded_at
  );
END;
$$;

-- ---------------------------------------------------------------------------
-- 9. Hold and drain state (read-only)
-- ---------------------------------------------------------------------------
-- 'drained' requires: held, at least one full lease elapsed since the hold
-- (covering any request a pre-migration build started before the hold), and
-- no admission whose lease is still running, closed or not. A closed
-- admission's after() work may still be writing, so closing never ends a lease
-- early. Job and document statuses are reported, never used as proof.
CREATE FUNCTION public.read_document_processing_hold_state()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_control public.document_processing_control%ROWTYPE;
  v_now timestamptz := clock_timestamp();
  v_open_in_lease bigint;
  v_closed_in_lease bigint;
  v_abandoned bigint;
  v_queued bigint;
  v_running bigint;
  v_running_unadmitted bigint;
  v_drain_not_before timestamptz;
  v_latest_lease timestamptz;
  v_state text;
BEGIN
  SELECT * INTO v_control FROM public.document_processing_control WHERE singleton;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'document processing control is missing'
      USING ERRCODE = '55000', DETAIL = 'document_processing_hold_unverified';
  END IF;

  SELECT count(*) FILTER (WHERE closed_at IS NULL),
         count(*) FILTER (WHERE closed_at IS NOT NULL),
         max(lease_expires_at)
    INTO v_open_in_lease, v_closed_in_lease, v_latest_lease
  FROM public.document_processing_admissions
  WHERE lease_expires_at > v_now;

  SELECT count(*) INTO v_abandoned
  FROM public.document_processing_admissions
  WHERE closed_at IS NULL AND lease_expires_at <= v_now;

  SELECT count(*) FILTER (WHERE status = 'queued'),
         count(*) FILTER (WHERE status = 'running'),
         count(*) FILTER (WHERE status = 'running' AND claim_admission_id IS NULL)
    INTO v_queued, v_running, v_running_unadmitted
  FROM public.document_analysis_jobs
  WHERE status IN ('queued', 'running');

  IF v_control.held THEN
    v_drain_not_before := greatest(
      v_control.held_since + make_interval(secs => v_control.admission_lease_seconds),
      coalesce(v_latest_lease, v_control.held_since)
    );
    v_state := CASE
      WHEN v_now >= v_drain_not_before AND v_open_in_lease = 0 AND v_closed_in_lease = 0
        THEN 'drained'
      ELSE 'draining'
    END;
  ELSE
    v_state := 'not_held';
  END IF;

  RETURN jsonb_build_object(
    'observed_at', v_now,
    'held', v_control.held,
    'hold_version', v_control.hold_version,
    'held_since', v_control.held_since,
    'changed_at', v_control.changed_at,
    'last_transition_id', v_control.last_transition_id,
    'admission_lease_seconds', v_control.admission_lease_seconds,
    'drain_state', v_state,
    'drain_not_before', v_drain_not_before,
    'admissions_open_in_lease', v_open_in_lease,
    'admissions_closed_in_lease', v_closed_in_lease,
    'admissions_abandoned', v_abandoned,
    'jobs_queued', v_queued,
    'jobs_running', v_running,
    'jobs_running_without_claim_admission', v_running_unadmitted
  );
END;
$$;

-- ---------------------------------------------------------------------------
-- 10. Privileges: service role reads; every write goes through a function.
-- ---------------------------------------------------------------------------
ALTER TABLE public.document_processing_control ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.document_processing_hold_transitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.document_processing_admissions ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE
  public.document_processing_control,
  public.document_processing_hold_transitions,
  public.document_processing_admissions
FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE
  public.document_processing_control,
  public.document_processing_hold_transitions,
  public.document_processing_admissions
TO service_role;

REVOKE ALL ON FUNCTION
  public.document_processing_hold_refuse_mutation(),
  public.document_processing_admissions_close_only(),
  public.document_analysis_jobs_hold_fence(),
  public.admit_document_processing(text, uuid, uuid, uuid),
  public.close_document_processing_admission(uuid, text),
  public.set_document_processing_hold(uuid, text, text, uuid, text),
  public.read_document_processing_hold_state()
FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION
  public.admit_document_processing(text, uuid, uuid, uuid),
  public.close_document_processing_admission(uuid, text),
  public.set_document_processing_hold(uuid, text, text, uuid, text),
  public.read_document_processing_hold_state()
TO service_role;

RESET lock_timeout;
