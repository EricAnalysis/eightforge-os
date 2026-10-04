-- Per-organization Forgewing entitlement (EightForge Core vs Core + Forgewing).
--
-- EightForge ships in two tiers that share ONE canonical truth model. An
-- organization without the entitlement runs EightForge Core only: deterministic
-- extraction, canonical truth, the Validator and operator review are unchanged.
-- Only Forgewing (AI) work is withheld: shadow tasks, recovery generation and
-- provider calls.
--
-- The entitlement is ANDed with the deployment-wide kill switch
-- FORGEWING_SHADOW_ENABLED; neither alone enables Forgewing.
--
-- The table is append-only. Every grant and revocation is an audited event, and
-- the latest event per organization is the effective state. No event means not
-- entitled. On revocation, reviewed values stay valid, because a human decided
-- them; pending AI proposals simply stop being generated. Nothing is deleted.

CREATE TABLE public.organization_forgewing_entitlement_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  enabled boolean NOT NULL,
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 2000),
  recorded_by uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX organization_forgewing_entitlement_events_latest_idx
  ON public.organization_forgewing_entitlement_events (organization_id, recorded_at DESC, id DESC);

CREATE FUNCTION public.reject_organization_forgewing_entitlement_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  RAISE EXCEPTION 'organization Forgewing entitlement events are append-only'
    USING ERRCODE = '42501';
END $$;

CREATE TRIGGER organization_forgewing_entitlement_events_immutable
  BEFORE UPDATE OR DELETE ON public.organization_forgewing_entitlement_events
  FOR EACH ROW EXECUTE FUNCTION public.reject_organization_forgewing_entitlement_mutation();

ALTER TABLE public.organization_forgewing_entitlement_events ENABLE ROW LEVEL SECURITY;

-- Server-side only. The browser never reads or grants an entitlement.
REVOKE ALL ON TABLE public.organization_forgewing_entitlement_events
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT ON TABLE public.organization_forgewing_entitlement_events TO service_role;

REVOKE ALL ON FUNCTION public.reject_organization_forgewing_entitlement_mutation()
  FROM PUBLIC, anon, authenticated, service_role;
