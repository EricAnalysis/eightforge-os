-- ============================================================================
-- Recurrence successors (B8.4d)
--
-- When a person confirms that friction recurred after a deployed fix, the
-- problem re-enters the improvement loop as a NEW submission: the current,
-- allowlisted friction signal for the same problem. History is never mutated:
-- the originating submission, its triage, engineering request, lifecycle,
-- measurement and decision all stay as recorded. One append-only link names
-- the successor and everything it came from.
--
-- Only the latest decision of a deployed fix may create a successor, and
-- only when that decision is recurred_confirmed. One successor per decision.
-- Linear stays an outbound projection only: nothing here reads it.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.improvement_recurrence_successors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  originating_submission_id uuid NOT NULL REFERENCES public.improvement_signal_submissions(id) ON DELETE RESTRICT,
  successor_submission_id uuid NOT NULL REFERENCES public.improvement_signal_submissions(id) ON DELETE RESTRICT,
  engineering_review_id uuid NOT NULL
    REFERENCES public.workflow_repository_plan_recommendation_reviews(id) ON DELETE RESTRICT,
  deployed_event_id uuid NOT NULL REFERENCES public.improvement_lifecycle_events(id) ON DELETE RESTRICT,
  snapshot_id uuid NOT NULL REFERENCES public.improvement_measurement_snapshots(id) ON DELETE RESTRICT,
  decision_id uuid NOT NULL REFERENCES public.improvement_measurement_decisions(id) ON DELETE RESTRICT,
  recorded_by uuid NOT NULL REFERENCES public.user_profiles(id) ON DELETE RESTRICT,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT improvement_recurrence_successors_distinct CHECK (successor_submission_id <> originating_submission_id),
  CONSTRAINT improvement_recurrence_successors_decision_unique UNIQUE (decision_id),
  CONSTRAINT improvement_recurrence_successors_successor_unique UNIQUE (successor_submission_id)
);
CREATE INDEX IF NOT EXISTS improvement_recurrence_successors_origin_idx
  ON public.improvement_recurrence_successors (originating_submission_id, recorded_at);

DROP TRIGGER IF EXISTS improvement_recurrence_successors_immutable ON public.improvement_recurrence_successors;
CREATE TRIGGER improvement_recurrence_successors_immutable
  BEFORE UPDATE OR DELETE ON public.improvement_recurrence_successors
  FOR EACH ROW EXECUTE FUNCTION public.reject_improvement_lifecycle_event_mutation();
DROP TRIGGER IF EXISTS improvement_recurrence_successors_no_truncate ON public.improvement_recurrence_successors;
CREATE TRIGGER improvement_recurrence_successors_no_truncate
  BEFORE TRUNCATE ON public.improvement_recurrence_successors
  FOR EACH STATEMENT EXECUTE FUNCTION public.reject_improvement_lifecycle_event_mutation();

ALTER TABLE public.improvement_recurrence_successors ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.improvement_recurrence_successors FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.improvement_recurrence_successors TO service_role;

-- ----------------------------------------------------------------------------
-- Record the successor and its link atomically (trusted server).
--
-- The payload is the current allowlisted friction signal, validated by the
-- trusted server's shared allowlist; here it must name the same problem.
-- Error codes: P0002 decision not found; 22023 malformed; B8406 another
-- problem; B8409 not the current recurred_confirmed decision; B8410 the
-- successor would repeat the originating submission or an existing successor.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.record_improvement_recurrence_successor(
  p_decision_id uuid,
  p_successor_submission_id uuid,
  p_schema_version text,
  p_payload jsonb,
  p_payload_digest_sha256 text,
  p_read_bounds jsonb,
  p_recorded_by uuid
)
RETURNS TABLE(successor_id uuid, successor_submission_id uuid, inserted boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_decision public.improvement_measurement_decisions%ROWTYPE;
  v_deployed public.improvement_lifecycle_events%ROWTYPE;
  v_origin public.improvement_signal_submissions%ROWTYPE;
  v_existing public.improvement_recurrence_successors%ROWTYPE;
  v_submission uuid;
BEGIN
  IF p_decision_id IS NULL OR p_successor_submission_id IS NULL OR p_recorded_by IS NULL
     OR p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object'
     OR p_payload_digest_sha256 IS NULL OR p_payload_digest_sha256 !~ '^[a-f0-9]{64}$'
     OR p_read_bounds IS NULL OR jsonb_typeof(p_read_bounds) <> 'object' THEN
    RAISE EXCEPTION 'invalid recurrence successor' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_decision FROM public.improvement_measurement_decisions AS decision WHERE decision.id = p_decision_id;
  IF v_decision.id IS NULL THEN
    RAISE EXCEPTION 'measurement decision not found' USING ERRCODE = 'P0002';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('improvement_recurrence:' || v_decision.deployed_event_id::text, 0));

  SELECT * INTO v_existing FROM public.improvement_recurrence_successors AS link WHERE link.decision_id = v_decision.id;
  IF v_existing.id IS NOT NULL THEN
    RETURN QUERY SELECT v_existing.id, v_existing.successor_submission_id, false;
    RETURN;
  END IF;
  IF v_decision.decision <> 'recurred_confirmed' OR EXISTS (
      SELECT 1 FROM public.improvement_measurement_decisions AS later
      WHERE later.deployed_event_id = v_decision.deployed_event_id
        AND later.decision_version > v_decision.decision_version) THEN
    RAISE EXCEPTION 'not the current recurrence decision' USING ERRCODE = 'B8409';
  END IF;

  SELECT * INTO v_deployed FROM public.improvement_lifecycle_events AS event
  WHERE event.id = v_decision.deployed_event_id AND event.event_kind = 'deployed';
  SELECT * INTO v_origin FROM public.improvement_signal_submissions AS submission
  WHERE submission.id = v_deployed.submission_id;
  IF v_origin.id IS NULL
     OR p_payload->>'signalKind' IS DISTINCT FROM v_origin.signal_kind
     OR p_payload->>'code' IS DISTINCT FROM v_origin.signal_code THEN
    RAISE EXCEPTION 'successor names another problem' USING ERRCODE = 'B8406';
  END IF;

  -- The same signal already submitted: it is the successor only if it is
  -- neither the original nor another recurrence's successor.
  SELECT submission.id INTO v_submission FROM public.improvement_signal_submissions AS submission
  WHERE submission.organization_id = v_origin.organization_id
    AND submission.payload_digest_sha256 = p_payload_digest_sha256;
  IF v_submission IS NOT NULL AND (v_submission = v_origin.id OR EXISTS (
      SELECT 1 FROM public.improvement_recurrence_successors AS link WHERE link.successor_submission_id = v_submission)) THEN
    RAISE EXCEPTION 'successor would repeat an earlier submission' USING ERRCODE = 'B8410';
  END IF;
  IF v_submission IS NULL THEN
    INSERT INTO public.improvement_signal_submissions (
      id, organization_id, schema_version, signal_kind, signal_code, payload, payload_digest_sha256,
      read_bounds, submitted_by)
    VALUES (p_successor_submission_id, v_origin.organization_id, p_schema_version, v_origin.signal_kind,
      v_origin.signal_code, p_payload, p_payload_digest_sha256, p_read_bounds, p_recorded_by)
    RETURNING id INTO v_submission;
  END IF;

  RETURN QUERY
  INSERT INTO public.improvement_recurrence_successors AS link (
    originating_submission_id, successor_submission_id, engineering_review_id, deployed_event_id,
    snapshot_id, decision_id, recorded_by)
  VALUES (v_origin.id, v_submission, v_deployed.engineering_review_id, v_deployed.id,
    v_decision.snapshot_id, v_decision.id, p_recorded_by)
  RETURNING link.id, link.successor_submission_id, true;
END;
$$;

ALTER FUNCTION public.record_improvement_recurrence_successor(uuid,uuid,text,jsonb,text,jsonb,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.record_improvement_recurrence_successor(uuid,uuid,text,jsonb,text,jsonb,uuid)
  FROM PUBLIC, anon, authenticated, service_role, forgewing_engineering_worker;
GRANT EXECUTE ON FUNCTION public.record_improvement_recurrence_successor(uuid,uuid,text,jsonb,text,jsonb,uuid)
  TO service_role;
