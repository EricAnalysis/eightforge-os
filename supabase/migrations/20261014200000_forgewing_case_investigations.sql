-- Forgewing P3c: durable, immutable Case Investigation records.
--
-- Each row is one accepted (runner-validated) Forgewing investigation of one
-- Validator-finding case: a non-authoritative explanation, the case's own
-- rankable actions in suggested order, and the context records it cites. It is
-- evidence / proposal history only. It never clears a finding, writes truth,
-- approves a relationship or ranks an approve / correct / override decision,
-- and no truth, Validator or precedence path reads it.
--
-- Append-only and immutable (trigger), RLS-enabled with no policies, readable
-- by service_role only, writable only through the SECURITY DEFINER record
-- function, which pins organization, project, requester and the spent budget
-- reservation inside the database. No retention expiry: this is audit history.

CREATE TABLE public.forgewing_case_investigations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE RESTRICT,
  case_id text NOT NULL CHECK (length(btrim(case_id)) BETWEEN 1 AND 500),
  -- V1: Validator findings (including the conflict rules) only.
  case_kind text NOT NULL CHECK (case_kind = 'validator_finding'),
  finding_check_key text CHECK (finding_check_key IS NULL OR length(finding_check_key) BETWEEN 1 AND 500),
  rule_id text CHECK (rule_id IS NULL OR length(rule_id) BETWEEN 1 AND 200),
  -- Identity of exactly what was sent and asked.
  context_transmitted_digest text NOT NULL CHECK (context_transmitted_digest ~ '^[0-9a-f]{64}$'),
  request_digest_sha256 text NOT NULL CHECK (request_digest_sha256 ~ '^[0-9a-f]{64}$'),
  reservation_id uuid NOT NULL REFERENCES public.forgewing_provider_call_reservations(id) ON DELETE RESTRICT,
  model text NOT NULL CHECK (length(btrim(model)) BETWEEN 1 AND 200),
  prompt_version text NOT NULL CHECK (length(btrim(prompt_version)) BETWEEN 1 AND 100),
  diagnosis text NOT NULL CHECK (length(btrim(diagnosis)) BETWEEN 1 AND 1200),
  -- Only navigation / typed-path kinds; never the decision, the Validator or a value entry.
  ranked_action_kinds text[] NOT NULL CHECK (
    cardinality(ranked_action_kinds) <= 4
    AND ranked_action_kinds <@ ARRAY['open_document', 'link_invoice_line_rate', 'upload_document', 'open_linked_documents']::text[]),
  rationale text NOT NULL CHECK (length(btrim(rationale)) BETWEEN 1 AND 2000),
  -- [{sliceKind, recordId}], 1..12: records actually transmitted (runner-verified).
  evidence_refs jsonb NOT NULL CHECK (
    jsonb_typeof(evidence_refs) = 'array' AND jsonb_array_length(evidence_refs) BETWEEN 1 AND 12),
  authority text NOT NULL DEFAULT 'non_authoritative' CHECK (authority = 'non_authoritative'),
  requires_human_review boolean NOT NULL DEFAULT true CHECK (requires_human_review),
  requested_by uuid NOT NULL REFERENCES public.user_profiles(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  -- One record per spent provider call.
  CONSTRAINT forgewing_case_investigations_reservation_unique UNIQUE (reservation_id)
);

CREATE INDEX forgewing_case_investigations_case_idx
  ON public.forgewing_case_investigations (organization_id, project_id, case_id, created_at DESC);

CREATE FUNCTION public.reject_forgewing_case_investigation_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  RAISE EXCEPTION 'Forgewing case investigations are append-only'
    USING ERRCODE = '42501';
END $$;

CREATE TRIGGER forgewing_case_investigations_immutable
  BEFORE UPDATE OR DELETE ON public.forgewing_case_investigations
  FOR EACH ROW EXECUTE FUNCTION public.reject_forgewing_case_investigation_mutation();

ALTER TABLE public.forgewing_case_investigations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.forgewing_case_investigations FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.forgewing_case_investigations TO service_role;
REVOKE ALL ON FUNCTION public.reject_forgewing_case_investigation_mutation() FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.record_forgewing_case_investigation(
  p_organization_id uuid,
  p_project_id uuid,
  p_case_id text,
  p_case_kind text,
  p_finding_check_key text,
  p_rule_id text,
  p_context_transmitted_digest text,
  p_request_digest_sha256 text,
  p_reservation_id uuid,
  p_model text,
  p_prompt_version text,
  p_diagnosis text,
  p_ranked_action_kinds text[],
  p_rationale text,
  p_evidence_refs jsonb,
  p_requested_by uuid
) RETURNS TABLE (investigation_id uuid, inserted boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_id uuid;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service_role required' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.projects WHERE id = p_project_id AND organization_id = p_organization_id) THEN
    RAISE EXCEPTION 'project not in organization' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.user_profiles WHERE id = p_requested_by AND organization_id = p_organization_id) THEN
    RAISE EXCEPTION 'requester not in organization' USING ERRCODE = '23514';
  END IF;
  -- The record must rest on the exact budget slot this request spent.
  IF NOT EXISTS (SELECT 1 FROM public.forgewing_provider_call_reservations
      WHERE id = p_reservation_id AND organization_id = p_organization_id
        AND recovery_type = 'case_investigation' AND request_digest_sha256 = p_request_digest_sha256) THEN
    RAISE EXCEPTION 'investigation does not rest on its case_investigation reservation' USING ERRCODE = '23514';
  END IF;

  -- Idempotent only for the identical record; a reservation is never reused
  -- for a different investigation.
  SELECT i.id INTO v_id FROM public.forgewing_case_investigations AS i
  WHERE i.reservation_id = p_reservation_id;
  IF v_id IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM public.forgewing_case_investigations AS i
        WHERE i.id = v_id AND i.organization_id = p_organization_id AND i.project_id = p_project_id
          AND i.case_id = p_case_id AND i.diagnosis = p_diagnosis AND i.rationale = p_rationale
          AND i.ranked_action_kinds = p_ranked_action_kinds AND i.evidence_refs = p_evidence_refs) THEN
      RETURN QUERY SELECT v_id, false;
      RETURN;
    END IF;
    RAISE EXCEPTION 'reservation already recorded for a different investigation' USING ERRCODE = '23505';
  END IF;

  INSERT INTO public.forgewing_case_investigations (
    organization_id, project_id, case_id, case_kind, finding_check_key, rule_id, context_transmitted_digest,
    request_digest_sha256, reservation_id, model, prompt_version, diagnosis, ranked_action_kinds, rationale,
    evidence_refs, requested_by)
  VALUES (
    p_organization_id, p_project_id, p_case_id, p_case_kind, p_finding_check_key, p_rule_id,
    p_context_transmitted_digest, p_request_digest_sha256, p_reservation_id, p_model, p_prompt_version,
    p_diagnosis, p_ranked_action_kinds, p_rationale, p_evidence_refs, p_requested_by)
  RETURNING id INTO v_id;
  RETURN QUERY SELECT v_id, true;
END $$;

REVOKE ALL ON FUNCTION public.record_forgewing_case_investigation(
  uuid, uuid, text, text, text, text, text, text, uuid, text, text, text, text[], text, jsonb, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_forgewing_case_investigation(
  uuid, uuid, text, text, text, text, text, text, uuid, text, text, text, text[], text, jsonb, uuid)
  TO service_role;
