-- Forgewing B4.1: data-processing authorization and a durable provider-call
-- budget. Gates only. Nothing here calls a provider or stores a proposal.
--
-- Data policy. Whether an organization's document content may be sent to an
-- AI provider is a data-processing decision, separate from the commercial
-- entitlement (organization_forgewing_entitlement_events): different
-- approvers, different evidence. Each approval or revocation is an audited,
-- append-only event per (organization, provider, content class) and must cite
-- the terms it rests on. The latest event wins. No event means NOT APPROVED:
-- the default is deny for every class, and nothing in the product grants one.
--
-- Call budget. A provider call for an organization must first reserve a slot
-- through record function `reserve_forgewing_provider_call`, which counts that
-- organization's reservations in the trailing 24 hours under an advisory lock
-- and refuses at the cap. The ledger is append-only; a reservation is spent
-- whether or not the call then succeeds.

CREATE TABLE public.organization_forgewing_data_policy_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  provider text NOT NULL CHECK (provider IN ('anthropic')),
  content_class text NOT NULL CHECK (content_class IN ('text_excerpts', 'page_region_images')),
  approved boolean NOT NULL,
  -- The customer and provider terms the decision rests on (agreement id, DPA
  -- clause, ticket). Required for grants and revocations alike.
  terms_reference text NOT NULL CHECK (length(btrim(terms_reference)) BETWEEN 1 AND 500),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 2000),
  recorded_by uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX organization_forgewing_data_policy_events_latest_idx
  ON public.organization_forgewing_data_policy_events
  (organization_id, provider, content_class, recorded_at DESC, id DESC);

CREATE TABLE public.forgewing_provider_call_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  recovery_type text NOT NULL CHECK (recovery_type IN ('priced_value_reading')),
  request_digest_sha256 text NOT NULL CHECK (request_digest_sha256 ~ '^[0-9a-f]{64}$'),
  -- The operator whose request spent the slot.
  reserved_by uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
  reserved_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX forgewing_provider_call_reservations_window_idx
  ON public.forgewing_provider_call_reservations (organization_id, recovery_type, reserved_at DESC);

CREATE FUNCTION public.reject_forgewing_gate_ledger_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  RAISE EXCEPTION 'Forgewing gate ledgers are append-only' USING ERRCODE = '42501';
END $$;

CREATE TRIGGER organization_forgewing_data_policy_events_immutable
  BEFORE UPDATE OR DELETE ON public.organization_forgewing_data_policy_events
  FOR EACH ROW EXECUTE FUNCTION public.reject_forgewing_gate_ledger_mutation();
CREATE TRIGGER forgewing_provider_call_reservations_immutable
  BEFORE UPDATE OR DELETE ON public.forgewing_provider_call_reservations
  FOR EACH ROW EXECUTE FUNCTION public.reject_forgewing_gate_ledger_mutation();

ALTER TABLE public.organization_forgewing_data_policy_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.forgewing_provider_call_reservations ENABLE ROW LEVEL SECURITY;

-- Server-side only. The browser never reads, grants or spends either.
REVOKE ALL ON TABLE public.organization_forgewing_data_policy_events
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT ON TABLE public.organization_forgewing_data_policy_events TO service_role;
REVOKE ALL ON TABLE public.forgewing_provider_call_reservations
  FROM PUBLIC, anon, authenticated, service_role;
-- Reservations are written only through the record function, never directly.
GRANT SELECT ON TABLE public.forgewing_provider_call_reservations TO service_role;
REVOKE ALL ON FUNCTION public.reject_forgewing_gate_ledger_mutation()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.reserve_forgewing_provider_call(
  p_organization_id uuid,
  p_recovery_type text,
  p_request_digest_sha256 text,
  p_reserved_by uuid,
  p_daily_cap integer
) RETURNS TABLE(reserved boolean, reservation_id uuid, used_in_window integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_used integer;
  v_id uuid;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service_role required' USING ERRCODE = '42501';
  END IF;
  IF p_daily_cap IS NULL OR p_daily_cap < 0 OR p_daily_cap > 1000 THEN
    RAISE EXCEPTION 'invalid daily cap' USING ERRCODE = '22023';
  END IF;
  IF p_request_digest_sha256 IS NULL OR p_request_digest_sha256 !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid request digest' USING ERRCODE = '22023';
  END IF;
  -- Serialize reservations per organization and type so concurrent requests
  -- cannot both take the last slot.
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'forgewing_call_budget:' || p_organization_id::text || ':' || coalesce(p_recovery_type, ''), 0));
  SELECT count(*)::integer INTO v_used
    FROM public.forgewing_provider_call_reservations r
    WHERE r.organization_id = p_organization_id
      AND r.recovery_type = p_recovery_type
      AND r.reserved_at > clock_timestamp() - interval '24 hours';
  IF v_used >= p_daily_cap THEN
    RETURN QUERY SELECT false, NULL::uuid, v_used;
    RETURN;
  END IF;
  INSERT INTO public.forgewing_provider_call_reservations(
    organization_id, recovery_type, request_digest_sha256, reserved_by)
  VALUES (p_organization_id, p_recovery_type, p_request_digest_sha256, p_reserved_by)
  RETURNING id INTO v_id;
  RETURN QUERY SELECT true, v_id, v_used + 1;
END $$;

REVOKE ALL ON FUNCTION public.reserve_forgewing_provider_call(uuid, text, text, uuid, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_forgewing_provider_call(uuid, text, text, uuid, integer)
  TO service_role;
