\set ON_ERROR_STOP on

-- Forgewing B4.1 gates: default-deny data policy and the durable call budget.
-- Generic, disposable fixtures only. Every check raises on failure.

INSERT INTO public.organizations (id, name) VALUES
  ('b4100000-0000-4000-8000-000000000001', 'B4.1 regression organization A'),
  ('b4100000-0000-4000-8000-000000000002', 'B4.1 regression organization B');
INSERT INTO auth.users (id) VALUES ('b4100000-0000-4000-8000-0000000000a1');

DO $$
DECLARE
  v_latest boolean;
  v_count integer;
BEGIN
  -- No event: nothing is approved for any class.
  SELECT count(*) INTO v_count FROM public.organization_forgewing_data_policy_events
    WHERE organization_id = 'b4100000-0000-4000-8000-000000000001';
  IF v_count <> 0 THEN RAISE EXCEPTION 'B4.1: fixture organization starts with a data policy'; END IF;

  -- The latest event per (organization, provider, class) wins.
  INSERT INTO public.organization_forgewing_data_policy_events
    (organization_id, provider, content_class, approved, terms_reference, reason, recorded_by)
  VALUES ('b4100000-0000-4000-8000-000000000001', 'anthropic', 'page_region_images', true,
          'generic-terms-1', 'generic grant', 'b4100000-0000-4000-8000-0000000000a1');
  PERFORM pg_sleep(0.001);
  INSERT INTO public.organization_forgewing_data_policy_events
    (organization_id, provider, content_class, approved, terms_reference, reason)
  VALUES ('b4100000-0000-4000-8000-000000000001', 'anthropic', 'page_region_images', false,
          'generic-terms-1', 'generic revocation');
  SELECT approved INTO v_latest FROM public.organization_forgewing_data_policy_events
    WHERE organization_id = 'b4100000-0000-4000-8000-000000000001'
      AND provider = 'anthropic' AND content_class = 'page_region_images'
    ORDER BY recorded_at DESC, id DESC LIMIT 1;
  IF v_latest IS DISTINCT FROM false THEN RAISE EXCEPTION 'B4.1: latest data-policy event did not win'; END IF;

  -- A grant for one class says nothing about another.
  SELECT count(*) INTO v_count FROM public.organization_forgewing_data_policy_events
    WHERE organization_id = 'b4100000-0000-4000-8000-000000000001' AND content_class = 'text_excerpts';
  IF v_count <> 0 THEN RAISE EXCEPTION 'B4.1: content classes are not independent'; END IF;
END $$;

-- Malformed decisions are refused.
DO $$
BEGIN
  BEGIN
    INSERT INTO public.organization_forgewing_data_policy_events
      (organization_id, provider, content_class, approved, terms_reference, reason)
    VALUES ('b4100000-0000-4000-8000-000000000001', 'anthropic', 'page_region_images', true, '  ', 'x');
    RAISE EXCEPTION 'B4.1: blank terms reference accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO public.organization_forgewing_data_policy_events
      (organization_id, provider, content_class, approved, terms_reference, reason)
    VALUES ('b4100000-0000-4000-8000-000000000001', 'anthropic', 'whole_documents', true, 't', 'x');
    RAISE EXCEPTION 'B4.1: unknown content class accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO public.organization_forgewing_data_policy_events
      (organization_id, provider, content_class, approved, terms_reference, reason)
    VALUES ('b4100000-0000-4000-8000-000000000001', 'other_provider', 'text_excerpts', true, 't', 'x');
    RAISE EXCEPTION 'B4.1: unknown provider accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;

-- Both ledgers are append-only, even for the owner.
DO $$
BEGIN
  BEGIN
    UPDATE public.organization_forgewing_data_policy_events SET approved = true;
    RAISE EXCEPTION 'B4.1: data-policy update accepted';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    DELETE FROM public.organization_forgewing_data_policy_events;
    RAISE EXCEPTION 'B4.1: data-policy delete accepted';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;

-- The call budget: service_role only, refuses at the cap, counts per organization.
SET ROLE service_role;
SET request.jwt.claim.role = 'service_role';
DO $$
DECLARE
  v record;
BEGIN
  SELECT * INTO v FROM public.reserve_forgewing_provider_call(
    'b4100000-0000-4000-8000-000000000001', 'priced_value_reading', repeat('a', 64), NULL, 0);
  IF v.reserved THEN RAISE EXCEPTION 'B4.1: a zero cap reserved a call'; END IF;

  SELECT * INTO v FROM public.reserve_forgewing_provider_call(
    'b4100000-0000-4000-8000-000000000001', 'priced_value_reading', repeat('a', 64),
    'b4100000-0000-4000-8000-0000000000a1', 2);
  IF NOT v.reserved OR v.used_in_window <> 1 THEN RAISE EXCEPTION 'B4.1: first reservation refused'; END IF;
  SELECT * INTO v FROM public.reserve_forgewing_provider_call(
    'b4100000-0000-4000-8000-000000000001', 'priced_value_reading', repeat('b', 64), NULL, 2);
  IF NOT v.reserved OR v.used_in_window <> 2 THEN RAISE EXCEPTION 'B4.1: second reservation refused'; END IF;
  SELECT * INTO v FROM public.reserve_forgewing_provider_call(
    'b4100000-0000-4000-8000-000000000001', 'priced_value_reading', repeat('c', 64), NULL, 2);
  IF v.reserved OR v.used_in_window <> 2 THEN RAISE EXCEPTION 'B4.1: cap not enforced'; END IF;

  -- Another organization has its own window.
  SELECT * INTO v FROM public.reserve_forgewing_provider_call(
    'b4100000-0000-4000-8000-000000000002', 'priced_value_reading', repeat('d', 64), NULL, 2);
  IF NOT v.reserved OR v.used_in_window <> 1 THEN RAISE EXCEPTION 'B4.1: organizations share a budget'; END IF;

  BEGIN
    PERFORM * FROM public.reserve_forgewing_provider_call(
      'b4100000-0000-4000-8000-000000000001', 'pricing_rate_single_observation', repeat('e', 64), NULL, 5);
    RAISE EXCEPTION 'B4.1: a reservation for another type was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    PERFORM * FROM public.reserve_forgewing_provider_call(
      'b4100000-0000-4000-8000-000000000001', 'priced_value_reading', 'not-a-digest', NULL, 5);
    RAISE EXCEPTION 'B4.1: malformed request digest accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  BEGIN
    INSERT INTO public.forgewing_provider_call_reservations (organization_id, recovery_type, request_digest_sha256)
    VALUES ('b4100000-0000-4000-8000-000000000001', 'priced_value_reading', repeat('f', 64));
    RAISE EXCEPTION 'B4.1: service_role wrote a reservation directly';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;
RESET ROLE;

-- Browser roles reach neither ledger nor the record function.
SET ROLE authenticated;
DO $$
BEGIN
  BEGIN
    PERFORM count(*) FROM public.organization_forgewing_data_policy_events;
    RAISE EXCEPTION 'B4.1: authenticated read the data policy';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM count(*) FROM public.forgewing_provider_call_reservations;
    RAISE EXCEPTION 'B4.1: authenticated read the call budget';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM * FROM public.reserve_forgewing_provider_call(
      'b4100000-0000-4000-8000-000000000001', 'priced_value_reading', repeat('a', 64), NULL, 5);
    RAISE EXCEPTION 'B4.1: authenticated reserved a call';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;
RESET ROLE;

DO $$
BEGIN
  BEGIN
    DELETE FROM public.forgewing_provider_call_reservations;
    RAISE EXCEPTION 'B4.1: reservation delete accepted';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;

\echo 'B4.1 FORGEWING DATA POLICY DEFAULT-DENY / CALL BUDGET / ACL / IMMUTABILITY: PASS'
