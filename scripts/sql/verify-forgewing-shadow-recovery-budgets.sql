\set ON_ERROR_STOP on

-- Census D2: extraction shadow and recovery durable daily budgets.
-- Disposable fixtures; the replay job drops the database.

INSERT INTO public.organizations (id, name) VALUES ('95d20000-0000-4000-8000-000000000001', 'D2 org');

SET request.jwt.claim.role = 'service_role';
SET ROLE service_role;
DO $$
DECLARE
  v record;
BEGIN
  -- System-initiated: no human actor. Cap 2 on the shared shadow budget.
  SELECT * INTO v FROM public.reserve_forgewing_provider_call(
    '95d20000-0000-4000-8000-000000000001', 'extraction_shadow', repeat('a', 64), NULL, 2);
  IF v.reserved IS NOT TRUE OR v.reservation_id IS NULL OR v.used_in_window <> 1 THEN
    RAISE EXCEPTION 'D2: first shadow reservation not granted';
  END IF;
  SELECT * INTO v FROM public.reserve_forgewing_provider_call(
    '95d20000-0000-4000-8000-000000000001', 'extraction_shadow', repeat('b', 64), NULL, 2);
  IF v.reserved IS NOT TRUE OR v.used_in_window <> 2 THEN RAISE EXCEPTION 'D2: second shadow reservation not granted'; END IF;
  SELECT * INTO v FROM public.reserve_forgewing_provider_call(
    '95d20000-0000-4000-8000-000000000001', 'extraction_shadow', repeat('c', 64), NULL, 2);
  IF v.reserved IS NOT FALSE OR v.reservation_id IS NOT NULL OR v.used_in_window <> 2 THEN
    RAISE EXCEPTION 'D2: the shadow daily cap was not enforced';
  END IF;
  -- The recovery budget is its own: not consumed by the shadow budget.
  SELECT * INTO v FROM public.reserve_forgewing_provider_call(
    '95d20000-0000-4000-8000-000000000001', 'extraction_recovery', repeat('d', 64), NULL, 1);
  IF v.reserved IS NOT TRUE OR v.used_in_window <> 1 THEN RAISE EXCEPTION 'D2: recovery budget not independent'; END IF;
  -- Cap 0 means no calls.
  SELECT * INTO v FROM public.reserve_forgewing_provider_call(
    '95d20000-0000-4000-8000-000000000001', 'extraction_recovery', repeat('e', 64), NULL, 0);
  IF v.reserved IS NOT FALSE THEN RAISE EXCEPTION 'D2: a zero cap granted a call'; END IF;
  -- Existing budget types are unchanged.
  SELECT * INTO v FROM public.reserve_forgewing_provider_call(
    '95d20000-0000-4000-8000-000000000001', 'project_ask', repeat('f', 64), NULL, 1);
  IF v.reserved IS NOT TRUE THEN RAISE EXCEPTION 'D2: an existing budget type stopped working'; END IF;
  -- An unknown type is still rejected by the ledger.
  BEGIN
    PERFORM * FROM public.reserve_forgewing_provider_call(
      '95d20000-0000-4000-8000-000000000001', 'extraction_anything', repeat('a', 64), NULL, 5);
    RAISE EXCEPTION 'D2: an unknown budget type was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;
RESET ROLE;
RESET request.jwt.claim.role;

-- Still append-only and service_role-read-only.
DO $$ BEGIN
  IF has_table_privilege('service_role', 'public.forgewing_provider_call_reservations', 'INSERT')
    OR has_table_privilege('authenticated', 'public.forgewing_provider_call_reservations', 'SELECT') THEN
    RAISE EXCEPTION 'D2: reservation ledger grants changed';
  END IF;
  BEGIN
    UPDATE public.forgewing_provider_call_reservations SET recovery_type = 'extraction_recovery'
      WHERE organization_id = '95d20000-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'D2: reservation update accepted';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    DELETE FROM public.forgewing_provider_call_reservations WHERE organization_id = '95d20000-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'D2: reservation delete accepted';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  IF (SELECT count(*) FROM public.forgewing_provider_call_reservations
      WHERE organization_id = '95d20000-0000-4000-8000-000000000001') <> 4 THEN
    RAISE EXCEPTION 'D2: exactly four granted reservations expected';
  END IF;
END $$;

SELECT 'FORGEWING SHADOW / RECOVERY DURABLE BUDGETS: PASS' AS result;
