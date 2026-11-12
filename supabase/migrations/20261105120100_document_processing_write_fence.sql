-- Document processing write fence.
--
-- Builds on 20261105120000_document_processing_hold. The hold refuses new
-- admissions; this migration makes the database refuse protected writes
-- (document_extractions INSERT/UPDATE: blobs and normalized facts) from any
-- application request that does not hold a currently valid admission:
--
--   * no admission while held             -> refused   (5a7fb05 included)
--   * expired / closed / revoked          -> refused
--   * superseded by a newer SOURCE-processing admission (documents_process,
--     document_analyze, job_process) for the same document -> refused.
--     Derived refreshes (document_evaluate, project_rerun) never supersede.
--   * another document or organization    -> refused
--   * an admission presented by any role other than service_role -> refused
--
-- The admission travels as the PostgREST request header
-- x-eightforge-processing-admission. The database decides validity from the
-- immutable admission row; a caller cannot supply a lease or timestamp.
--
-- Requires PostgreSQL 16+ (pg_input_is_valid). Asserted below, because
-- PL/pgSQL resolves functions at run time: on an older server the migration
-- would apply and every application extraction write would then fail.
--
-- Validity is checked when each row is written AND again at commit (deferred
-- constraint trigger), so a transaction that started under a valid admission
-- cannot commit after the admission expires, is closed, revoked or superseded.
-- Every check holds the shared hold lock until commit; hold, revoke and the
-- drain read take it exclusively, so they are ordered after every in-flight
-- protected write.
--
-- Writes with no PostgREST request context (direct database sessions:
-- migrations, backfills, the SQL editor) are not application writes and are
-- not fenced. All application traffic reaches the database through PostgREST.

DO $$
BEGIN
  IF current_setting('server_version_num')::integer < 160000 THEN
    RAISE EXCEPTION 'document processing write fence requires PostgreSQL 16 or later (found %)',
      current_setting('server_version');
  END IF;
END;
$$;

SET lock_timeout = '10s';

-- ---------------------------------------------------------------------------
-- 1. Admission ordering, revocation, project reruns
-- ---------------------------------------------------------------------------
ALTER TABLE public.document_processing_admissions
  ADD COLUMN admission_seq bigint GENERATED ALWAYS AS IDENTITY;
ALTER TABLE public.document_processing_admissions
  ADD CONSTRAINT document_processing_admissions_seq_key UNIQUE (admission_seq);
CREATE INDEX document_processing_admissions_document_seq_idx
  ON public.document_processing_admissions (document_id, admission_seq);

ALTER TABLE public.document_processing_admissions
  DROP CONSTRAINT document_processing_admissions_outcome_check,
  ADD CONSTRAINT document_processing_admissions_outcome_check
    CHECK (outcome IN ('completed', 'failed', 'revoked')),
  DROP CONSTRAINT document_processing_admissions_entry_point_check,
  ADD CONSTRAINT document_processing_admissions_entry_point_check
    CHECK (entry_point IN (
      'documents_process', 'document_analyze', 'job_process', 'document_evaluate', 'project_rerun'
    ));

CREATE OR REPLACE FUNCTION public.document_processing_admissions_close_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF OLD.closed_at IS NOT NULL
     OR NEW.closed_at IS NULL
     OR NEW.id IS DISTINCT FROM OLD.id
     OR NEW.admission_seq IS DISTINCT FROM OLD.admission_seq
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

-- ---------------------------------------------------------------------------
-- 2. Transition audit: revoke
-- ---------------------------------------------------------------------------
ALTER TABLE public.document_processing_hold_transitions
  DROP CONSTRAINT document_processing_hold_transitions_action_check,
  DROP CONSTRAINT document_processing_hold_transitions_outcome_check,
  DROP CONSTRAINT document_processing_hold_transitions_check,
  DROP CONSTRAINT document_processing_hold_transitions_check1,
  ADD COLUMN revoked_admissions integer NOT NULL DEFAULT 0 CHECK (revoked_admissions >= 0),
  ADD CONSTRAINT document_processing_hold_transitions_action_check
    CHECK (action IN ('hold', 'release', 'revoke')),
  ADD CONSTRAINT document_processing_hold_transitions_outcome_check
    CHECK (outcome IN ('applied', 'already_held', 'already_released', 'revoked')),
  ADD CONSTRAINT document_processing_hold_transitions_shape_check CHECK (
    (action = 'hold' AND held_after AND revoked_admissions = 0
      AND ((outcome = 'applied' AND NOT held_before) OR (outcome = 'already_held' AND held_before)))
    OR (action = 'release' AND NOT held_after AND revoked_admissions = 0
      AND ((outcome = 'applied' AND held_before) OR (outcome = 'already_released' AND NOT held_before)))
    OR (action = 'revoke' AND outcome = 'revoked' AND held_before AND held_after)
  );

-- ---------------------------------------------------------------------------
-- 3. Operator transition: hold / release / revoke
-- ---------------------------------------------------------------------------
-- revoke closes every write-valid admission (open, lease running) while held.
-- Open admissions whose lease already expired are left as they are: they can
-- no longer write, and they remain visible as abandoned.
CREATE OR REPLACE FUNCTION public.set_document_processing_hold(
  p_request_key uuid,
  p_action text,
  p_reason text,
  p_actor_id uuid,
  p_actor_email text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
-- Bounds how long a transition queues behind in-flight protected writes (and
-- so how long it can hold up the admissions queued behind it). On timeout it
-- fails with 55P03 and nothing changes; the operator retries.
SET lock_timeout = '5s'
AS $$
DECLARE
  v_control public.document_processing_control%ROWTYPE;
  v_existing public.document_processing_hold_transitions%ROWTYPE;
  v_reason text := btrim(coalesce(p_reason, ''));
  v_digest text;
  v_outcome text;
  v_revoked integer := 0;
  v_now timestamptz;
  v_transition public.document_processing_hold_transitions%ROWTYPE;
BEGIN
  IF p_request_key IS NULL OR p_actor_id IS NULL
     OR p_action IS NULL OR p_action NOT IN ('hold', 'release', 'revoke')
     OR length(v_reason) NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'request key, actor, action (hold | release | revoke) and reason are required'
      USING ERRCODE = '22023';
  END IF;

  v_digest := encode(sha256(convert_to(jsonb_build_object(
    'action', p_action,
    'actor_id', p_actor_id,
    'reason', v_reason
  )::text, 'UTF8')), 'hex');

  -- Exclusive hold lock: ordered after every admission and protected write
  -- already holding it shared.
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
      'revoked_admissions', v_existing.revoked_admissions,
      'held', v_control.held,
      'hold_version', v_control.hold_version,
      'recorded_at', v_existing.recorded_at
    );
  END IF;

  IF p_action = 'hold' THEN
    v_outcome := CASE WHEN v_control.held THEN 'already_held' ELSE 'applied' END;
  ELSIF p_action = 'release' THEN
    v_outcome := CASE WHEN v_control.held THEN 'applied' ELSE 'already_released' END;
  ELSE
    IF NOT v_control.held THEN
      RAISE EXCEPTION 'revoking admissions requires an active hold'
        USING ERRCODE = '55000', DETAIL = 'document_processing_hold_not_held';
    END IF;
    WITH revoked AS (
      UPDATE public.document_processing_admissions
      SET closed_at = v_now, outcome = 'revoked'
      WHERE closed_at IS NULL AND lease_expires_at > v_now
      RETURNING 1
    )
    SELECT count(*) INTO v_revoked FROM revoked;
    v_outcome := 'revoked';
  END IF;

  INSERT INTO public.document_processing_hold_transitions (
    request_key, request_digest_sha256, action, outcome, actor_id, actor_email,
    reason, held_before, held_after, hold_version_after, revoked_admissions, recorded_at
  ) VALUES (
    p_request_key, v_digest, p_action, v_outcome, p_actor_id, p_actor_email,
    v_reason, v_control.held,
    CASE p_action WHEN 'hold' THEN true WHEN 'release' THEN false ELSE v_control.held END,
    v_control.hold_version + CASE WHEN v_outcome = 'applied' THEN 1 ELSE 0 END,
    v_revoked, v_now
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
    'revoked_admissions', v_transition.revoked_admissions,
    'held', v_control.held,
    'hold_version', v_control.hold_version,
    'recorded_at', v_transition.recorded_at
  );
END;
$$;

-- ---------------------------------------------------------------------------
-- 4. Protected-write fence
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.document_processing_write_fence()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_headers text := nullif(current_setting('request.headers', true), '');
  v_claims text := nullif(current_setting('request.jwt.claims', true), '');
  v_header text;
  v_held boolean;
  v_admission public.document_processing_admissions%ROWTYPE;
  v_reason text;
  v_cache_key text;
  v_cache_value text;
BEGIN
  -- No PostgREST request context: a direct database session (migration,
  -- backfill, SQL editor), not an application write.
  IF v_headers IS NULL AND v_claims IS NULL THEN
    RETURN CASE WHEN TG_WHEN = 'BEFORE' THEN NEW ELSE NULL END;
  END IF;

  -- Per-transaction fast path for multi-row statements. A row with the same
  -- request context, document and organization as one already accepted in
  -- this phase of this transaction gets the same answer. This is safe because
  -- the first accepted row took the shared hold lock, held to commit, so no
  -- hold, revoke or drain read can commit in between; the commit phase keeps
  -- its own cache, so the statement-phase answer never satisfies the commit
  -- re-check.
  v_cache_key := CASE WHEN TG_WHEN = 'BEFORE'
    THEN 'eightforge.write_fence_statement' ELSE 'eightforge.write_fence_commit' END;
  -- The key covers every input the full check reads from the row: the
  -- operation, and for UPDATE the old document AND old organization, so an
  -- accepted row can never vouch for a later row that moves document or
  -- tenant (or for an UPDATE that looks like an earlier INSERT).
  v_cache_value := md5(coalesce(v_headers, '') || '|' || coalesce(v_claims, '') || '|' || TG_OP || '|'
    || coalesce(CASE WHEN TG_OP = 'UPDATE' THEN OLD.document_id::text END, '') || '|'
    || coalesce(CASE WHEN TG_OP = 'UPDATE' THEN OLD.organization_id::text END, '') || '|'
    || coalesce(NEW.document_id::text, '') || '|' || coalesce(NEW.organization_id::text, ''));
  IF current_setting(v_cache_key, true) = v_cache_value THEN
    RETURN CASE WHEN TG_WHEN = 'BEFORE' THEN NEW ELSE NULL END;
  END IF;

  -- Held until commit: hold, revoke and the drain read wait for this write.
  PERFORM pg_catalog.pg_advisory_xact_lock_shared(
    pg_catalog.hashtextextended('eightforge:document_processing_hold', 0));

  IF v_headers IS NOT NULL THEN
    IF pg_catalog.pg_input_is_valid(v_headers, 'jsonb') THEN
      v_header := nullif(btrim(v_headers::jsonb ->> 'x-eightforge-processing-admission'), '');
    ELSE
      v_reason := 'malformed_request_headers';
    END IF;
  END IF;

  IF v_reason IS NULL AND v_header IS NULL THEN
    SELECT c.held INTO v_held FROM public.document_processing_control c WHERE c.singleton;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'document processing control is missing'
        USING ERRCODE = '55000', DETAIL = 'document_processing_hold_unverified';
    END IF;
    IF NOT v_held THEN
      PERFORM set_config(v_cache_key, v_cache_value, true);
      RETURN CASE WHEN TG_WHEN = 'BEFORE' THEN NEW ELSE NULL END;
    END IF;
    v_reason := 'held_unadmitted';
  ELSIF v_reason IS NULL AND NOT pg_catalog.pg_input_is_valid(v_header, 'uuid') THEN
    v_reason := 'malformed_admission';
  ELSIF v_reason IS NULL
        AND (v_claims IS NULL OR NOT pg_catalog.pg_input_is_valid(v_claims, 'jsonb')
             OR (v_claims::jsonb ->> 'role') IS DISTINCT FROM 'service_role') THEN
    -- Admissions are issued to the server only. Their ids are readable by
    -- organization members (document_analysis_jobs RLS), so a browser session
    -- presenting one is refused rather than allowed to borrow it.
    v_reason := 'admission_role_mismatch';
  ELSIF v_reason IS NULL THEN
    IF TG_OP = 'UPDATE' AND (OLD.document_id IS DISTINCT FROM NEW.document_id
                             OR OLD.organization_id IS DISTINCT FROM NEW.organization_id) THEN
      -- An admitted write may not move a row to another document or tenant.
      v_reason := CASE WHEN OLD.document_id IS DISTINCT FROM NEW.document_id
        THEN 'document_mismatch' ELSE 'organization_mismatch' END;
    ELSE
      SELECT * INTO v_admission
      FROM public.document_processing_admissions
      WHERE id = v_header::uuid;
      v_reason := CASE
        WHEN v_admission.id IS NULL THEN 'unknown_admission'
        -- NULL-safe: a row without a document is never covered by an admission.
        WHEN v_admission.document_id IS DISTINCT FROM NEW.document_id THEN 'document_mismatch'
        -- New rows must name the admission's organization. Updates keep the
        -- row's organization (checked above); legacy rows with no organization
        -- may still be updated inside the admitted document.
        WHEN TG_OP = 'INSERT'
             AND NEW.organization_id IS DISTINCT FROM v_admission.organization_id THEN 'organization_mismatch'
        WHEN TG_OP = 'UPDATE' AND NEW.organization_id IS NOT NULL
             AND NEW.organization_id <> v_admission.organization_id THEN 'organization_mismatch'
        WHEN v_admission.outcome = 'revoked' THEN 'revoked'
        WHEN v_admission.closed_at IS NOT NULL THEN 'closed'
        WHEN v_admission.lease_expires_at <= clock_timestamp() THEN 'expired'
        -- Only a newer SOURCE-processing attempt makes this one stale. Derived
        -- refreshes (evaluate, project reruns) read existing extraction output
        -- and must never knock out the run that is producing new output.
        WHEN EXISTS (
          SELECT 1 FROM public.document_processing_admissions b
          WHERE b.document_id = v_admission.document_id
            AND b.admission_seq > v_admission.admission_seq
            AND b.entry_point IN ('documents_process', 'document_analyze', 'job_process')
        ) THEN 'superseded'
      END;
      IF v_reason IS NULL THEN
        PERFORM set_config(v_cache_key, v_cache_value, true);
        RETURN CASE WHEN TG_WHEN = 'BEFORE' THEN NEW ELSE NULL END;
      END IF;
    END IF;
  END IF;

  RAISE EXCEPTION 'protected processing write refused: %', v_reason
    USING ERRCODE = '55000',
          DETAIL = 'document_processing_write_fenced:' || v_reason,
          HINT = 'document_extractions writes need a valid processing admission (or no active hold).';
END;
$$;

CREATE TRIGGER document_extractions_processing_write_fence
  BEFORE INSERT OR UPDATE ON public.document_extractions
  FOR EACH ROW EXECUTE FUNCTION public.document_processing_write_fence();

CREATE CONSTRAINT TRIGGER document_extractions_processing_write_fence_commit
  AFTER INSERT OR UPDATE ON public.document_extractions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.document_processing_write_fence();

-- ---------------------------------------------------------------------------
-- 5. Drain state, by writer authority
-- ---------------------------------------------------------------------------
-- 'drained' = held, and no admission can still commit a protected write:
-- none is open with a running lease. While held, the read is taken under the
-- exclusive hold lock, so every protected write that passed its checks has
-- committed and is visible, and every later one re-checks against the state
-- read here. Nothing in the database can reopen, extend or create an
-- admission while held, so drained is stable until release.
--
-- When not held the read takes no exclusive lock, so polling never stalls
-- normal processing. lock_timeout bounds how long an exclusive request can
-- queue (and so how long it can hold up the shared requests queued behind
-- it); on timeout the read fails with 55P03 and can simply be retried.
-- Volatile: each statement reads a fresh snapshot.
CREATE OR REPLACE FUNCTION public.read_document_processing_hold_state()
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
SET lock_timeout = '5s'
AS $$
DECLARE
  v_control public.document_processing_control%ROWTYPE;
  v_now timestamptz;
  v_valid bigint;
  v_natural_drain timestamptz;
  v_abandoned bigint;
  v_queued bigint;
  v_running bigint;
  v_running_unadmitted bigint;
BEGIN
  SELECT * INTO v_control FROM public.document_processing_control WHERE singleton;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'document processing control is missing'
      USING ERRCODE = '55000', DETAIL = 'document_processing_hold_unverified';
  END IF;
  IF v_control.held THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('eightforge:document_processing_hold', 0));
    -- Fresh snapshot after the lock: a release may have committed meanwhile.
    SELECT * INTO v_control FROM public.document_processing_control WHERE singleton;
  END IF;
  v_now := clock_timestamp();

  SELECT count(*), max(lease_expires_at) INTO v_valid, v_natural_drain
  FROM public.document_processing_admissions
  WHERE closed_at IS NULL AND lease_expires_at > v_now;

  SELECT count(*) INTO v_abandoned
  FROM public.document_processing_admissions
  WHERE closed_at IS NULL AND lease_expires_at <= v_now;

  SELECT count(*) FILTER (WHERE status = 'queued'),
         count(*) FILTER (WHERE status = 'running'),
         count(*) FILTER (WHERE status = 'running' AND claim_admission_id IS NULL)
    INTO v_queued, v_running, v_running_unadmitted
  FROM public.document_analysis_jobs
  WHERE status IN ('queued', 'running');

  RETURN jsonb_build_object(
    'observed_at', v_now,
    'held', v_control.held,
    'hold_version', v_control.hold_version,
    'held_since', v_control.held_since,
    'changed_at', v_control.changed_at,
    'last_transition_id', v_control.last_transition_id,
    'admission_lease_seconds', v_control.admission_lease_seconds,
    'drain_state', CASE
      WHEN NOT v_control.held THEN 'not_held'
      WHEN v_valid > 0 THEN 'draining'
      ELSE 'drained'
    END,
    'admissions_write_valid', v_valid,
    'natural_drain_at', v_natural_drain,
    'admissions_abandoned', v_abandoned,
    'jobs_queued', v_queued,
    'jobs_running', v_running,
    'jobs_running_without_claim_admission', v_running_unadmitted
  );
END;
$$;

REVOKE ALL ON FUNCTION public.document_processing_write_fence() FROM PUBLIC, anon, authenticated, service_role;

RESET lock_timeout;
