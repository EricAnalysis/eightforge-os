\set ON_ERROR_STOP on

-- Forgewing P3c: durable, immutable Case Investigation records.
-- Disposable fixtures; the replay job drops the database.

INSERT INTO public.organizations (id, name) VALUES
  ('953c0000-0000-4000-8000-000000000001', 'P3c org A'),
  ('953c0000-0000-4000-8000-000000000002', 'P3c org B');
INSERT INTO auth.users (id) VALUES ('953c0000-0000-4000-8000-000000000011'), ('953c0000-0000-4000-8000-000000000012');
INSERT INTO public.user_profiles (id, organization_id, role) VALUES
  ('953c0000-0000-4000-8000-000000000011', '953c0000-0000-4000-8000-000000000001', 'member'),
  ('953c0000-0000-4000-8000-000000000012', '953c0000-0000-4000-8000-000000000002', 'member');
INSERT INTO public.projects (id, organization_id, name) VALUES
  ('953c0000-0000-4000-8000-000000000021', '953c0000-0000-4000-8000-000000000001', 'P3c project A');

DO $$ BEGIN
  IF has_table_privilege('authenticated', 'public.forgewing_case_investigations', 'SELECT')
    OR has_table_privilege('service_role', 'public.forgewing_case_investigations', 'INSERT')
    OR has_function_privilege('authenticated', 'public.record_forgewing_case_investigation(uuid, uuid, text, text, text, text, text, text, uuid, text, text, text, text[], text, jsonb, uuid)', 'EXECUTE')
    OR NOT has_function_privilege('service_role', 'public.record_forgewing_case_investigation(uuid, uuid, text, text, text, text, text, text, uuid, text, text, text, text[], text, jsonb, uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'P3c: case investigation grants are wrong';
  END IF;
END $$;

SET request.jwt.claim.role = 'service_role';
SET ROLE service_role;
DO $$
DECLARE
  v_reservation uuid;
  v_other uuid;
  v record;
  v_again record;
BEGIN
  SELECT reservation_id INTO v_reservation FROM public.reserve_forgewing_provider_call(
    '953c0000-0000-4000-8000-000000000001', 'case_investigation', repeat('c', 64),
    '953c0000-0000-4000-8000-000000000011', 5);
  IF v_reservation IS NULL THEN RAISE EXCEPTION 'P3c: fixture reservation failed'; END IF;

  SELECT * INTO v FROM public.record_forgewing_case_investigation(
    '953c0000-0000-4000-8000-000000000001', '953c0000-0000-4000-8000-000000000021', 'finding:check-1',
    'validator_finding', 'check-1', 'FINANCIAL_X', repeat('d', 64), repeat('c', 64), v_reservation,
    'claude-sonnet-4-6', 'case_investigation_prompt_v2', 'The cited totals differ.', ARRAY['open_document'],
    'Open the cited page.', '[{"sliceKind":"validator_findings","recordId":"check-1"}]'::jsonb,
    '953c0000-0000-4000-8000-000000000011');
  IF v.investigation_id IS NULL OR v.inserted IS NOT TRUE THEN RAISE EXCEPTION 'P3c: record not written'; END IF;
  SELECT * INTO v_again FROM public.record_forgewing_case_investigation(
    '953c0000-0000-4000-8000-000000000001', '953c0000-0000-4000-8000-000000000021', 'finding:check-1',
    'validator_finding', 'check-1', 'FINANCIAL_X', repeat('d', 64), repeat('c', 64), v_reservation,
    'claude-sonnet-4-6', 'case_investigation_prompt_v2', 'The cited totals differ.', ARRAY['open_document'],
    'Open the cited page.', '[{"sliceKind":"validator_findings","recordId":"check-1"}]'::jsonb,
    '953c0000-0000-4000-8000-000000000011');
  IF v_again.investigation_id <> v.investigation_id OR v_again.inserted THEN
    RAISE EXCEPTION 'P3c: one record per reservation not enforced';
  END IF;
  -- A reservation is never reused for a different investigation.
  BEGIN
    PERFORM * FROM public.record_forgewing_case_investigation(
      '953c0000-0000-4000-8000-000000000001', '953c0000-0000-4000-8000-000000000021', 'finding:check-1',
      'validator_finding', 'check-1', 'FINANCIAL_X', repeat('d', 64), repeat('c', 64), v_reservation,
      'claude-sonnet-4-6', 'case_investigation_prompt_v2', 'A different diagnosis.', ARRAY['open_document'],
      'Open the cited page.', '[{"sliceKind":"validator_findings","recordId":"check-1"}]'::jsonb,
      '953c0000-0000-4000-8000-000000000011');
    RAISE EXCEPTION 'P3c: a reservation was reused for a different investigation';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  SELECT reservation_id INTO v_other FROM public.reserve_forgewing_provider_call(
    '953c0000-0000-4000-8000-000000000001', 'case_investigation', repeat('e', 64),
    '953c0000-0000-4000-8000-000000000011', 5);

  -- The decision action, the Validator and value entry can never be ranked.
  BEGIN
    PERFORM * FROM public.record_forgewing_case_investigation(
      '953c0000-0000-4000-8000-000000000001', '953c0000-0000-4000-8000-000000000021', 'finding:check-2',
      'validator_finding', 'check-2', 'R', repeat('d', 64), repeat('e', 64), v_other,
      'm', 'v', 'd', ARRAY['resolve_execution_item'], 'r', '[{"sliceKind":"a","recordId":"b"}]'::jsonb,
      '953c0000-0000-4000-8000-000000000011');
    RAISE EXCEPTION 'P3c: a decision action was rankable';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  -- Only Validator findings; only on a matching case_investigation reservation; only in-org requesters.
  BEGIN
    PERFORM * FROM public.record_forgewing_case_investigation(
      '953c0000-0000-4000-8000-000000000001', '953c0000-0000-4000-8000-000000000021', 'withheld:x',
      'withheld_priced_line', NULL, NULL, repeat('d', 64), repeat('e', 64), v_other,
      'm', 'v', 'd', ARRAY['open_document'], 'r', '[{"sliceKind":"a","recordId":"b"}]'::jsonb,
      '953c0000-0000-4000-8000-000000000011');
    RAISE EXCEPTION 'P3c: a non-Validator case was recorded';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    PERFORM * FROM public.record_forgewing_case_investigation(
      '953c0000-0000-4000-8000-000000000001', '953c0000-0000-4000-8000-000000000021', 'finding:check-3',
      'validator_finding', 'check-3', 'R', repeat('d', 64), repeat('f', 64), v_other,
      'm', 'v', 'd', ARRAY['open_document'], 'r', '[{"sliceKind":"a","recordId":"b"}]'::jsonb,
      '953c0000-0000-4000-8000-000000000011');
    RAISE EXCEPTION 'P3c: a record not matching its reservation digest was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    PERFORM * FROM public.record_forgewing_case_investigation(
      '953c0000-0000-4000-8000-000000000001', '953c0000-0000-4000-8000-000000000021', 'finding:check-1',
      'validator_finding', 'check-4', 'R', repeat('d', 64), repeat('e', 64), v_other,
      'm', 'v', 'd', ARRAY['open_document'], 'r', '[{"sliceKind":"a","recordId":"b"}]'::jsonb,
      '953c0000-0000-4000-8000-000000000012');
    RAISE EXCEPTION 'P3c: a cross-organization requester was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;
RESET ROLE;
RESET request.jwt.claim.role;

-- Append-only, even for the owner.
DO $$ BEGIN
  BEGIN
    UPDATE public.forgewing_case_investigations SET diagnosis = 'x';
    RAISE EXCEPTION 'P3c: record update accepted';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    DELETE FROM public.forgewing_case_investigations;
    RAISE EXCEPTION 'P3c: record delete accepted';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  IF (SELECT count(*) FROM public.forgewing_case_investigations
      WHERE organization_id = '953c0000-0000-4000-8000-000000000001') <> 1 THEN
    RAISE EXCEPTION 'P3c: exactly one record expected';
  END IF;
END $$;

SELECT 'FORGEWING CASE INVESTIGATION RECORDS: PASS' AS result;
