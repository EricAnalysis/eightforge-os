\set ON_ERROR_STOP on

-- Forgewing S7: content-free, append-only provider-call telemetry.
-- Disposable fixtures only; the replay job owns and drops the database.

INSERT INTO public.organizations (id, name) VALUES
  ('95700000-0000-4000-8000-000000000001', 'S7 telemetry organization');

DO $$
DECLARE
  v_columns text[];
BEGIN
  -- Exactly these columns: identity and measurements, nothing that can hold content.
  SELECT array_agg(column_name::text ORDER BY column_name) INTO v_columns
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'forgewing_provider_call_observations';
  IF v_columns IS DISTINCT FROM ARRAY['id','input_tokens','latency_ms','model','observed_at','organization_id',
    'outcome','output_tokens','provider_request_id','request_digest_sha256','reservation_id','returned_model',
    'stop_reason','workflow'] THEN
    RAISE EXCEPTION 'S7: telemetry columns changed: %', v_columns;
  END IF;

  -- The browser can neither read nor write it.
  IF has_table_privilege('anon', 'public.forgewing_provider_call_observations', 'SELECT')
    OR has_table_privilege('authenticated', 'public.forgewing_provider_call_observations', 'SELECT')
    OR has_table_privilege('authenticated', 'public.forgewing_provider_call_observations', 'INSERT')
    OR NOT has_table_privilege('service_role', 'public.forgewing_provider_call_observations', 'INSERT')
    OR has_table_privilege('service_role', 'public.forgewing_provider_call_observations', 'UPDATE')
    OR has_table_privilege('service_role', 'public.forgewing_provider_call_observations', 'DELETE') THEN
    RAISE EXCEPTION 'S7: telemetry grants are wrong';
  END IF;
END $$;

SET ROLE service_role;
INSERT INTO public.forgewing_provider_call_observations
  (workflow, organization_id, request_digest_sha256, model, returned_model, provider_request_id,
   outcome, stop_reason, input_tokens, output_tokens, latency_ms)
VALUES ('project_ask', '95700000-0000-4000-8000-000000000001', repeat('7', 64), 'claude-sonnet-4-6',
        'claude-sonnet-4-6', 'req_s7', 'succeeded', 'end_turn', 900, 120, 2100);
RESET ROLE;

DO $$
BEGIN
  -- Malformed rows are refused.
  BEGIN
    INSERT INTO public.forgewing_provider_call_observations (workflow, model, outcome, latency_ms)
    VALUES ('project_ask', 'm', 'approved', 1);
    RAISE EXCEPTION 'S7: an unknown outcome was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO public.forgewing_provider_call_observations (workflow, model, outcome, latency_ms)
    VALUES ('free_text', 'm', 'succeeded', 1);
    RAISE EXCEPTION 'S7: an unknown workflow was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO public.forgewing_provider_call_observations (workflow, model, outcome, latency_ms, request_digest_sha256)
    VALUES ('project_ask', 'm', 'succeeded', 1, 'not-a-digest');
    RAISE EXCEPTION 'S7: a malformed digest was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO public.forgewing_provider_call_observations (workflow, model, outcome, latency_ms)
    VALUES ('project_ask', 'm', 'succeeded', -1);
    RAISE EXCEPTION 'S7: a negative latency was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO public.forgewing_provider_call_observations (workflow, model, outcome, latency_ms, reservation_id)
    VALUES ('project_ask', 'm', 'succeeded', 1, '95700000-0000-4000-8000-0000000000ff');
    RAISE EXCEPTION 'S7: a phantom reservation was accepted';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;

  -- Append-only, even for the owner.
  BEGIN
    UPDATE public.forgewing_provider_call_observations SET latency_ms = 0;
    RAISE EXCEPTION 'S7: telemetry update accepted';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    DELETE FROM public.forgewing_provider_call_observations;
    RAISE EXCEPTION 'S7: telemetry delete accepted';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  IF (SELECT count(*) FROM public.forgewing_provider_call_observations
      WHERE organization_id = '95700000-0000-4000-8000-000000000001') <> 1 THEN
    RAISE EXCEPTION 'S7: the valid observation was not recorded exactly once';
  END IF;
END $$;

SELECT 'FORGEWING PROVIDER CALL TELEMETRY: PASS' AS result;
