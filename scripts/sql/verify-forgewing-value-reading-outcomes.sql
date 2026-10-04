\set ON_ERROR_STOP on

-- Forgewing B4.3: value-reading failure outcomes on the existing generation
-- outcome ledger. Reuses the B4.2 fixtures. Every check raises on failure.

CREATE FUNCTION pg_temp.outcome(
  p_key text, p_type text, p_code text, p_reason text, p_invoked boolean,
  p_candidates jsonb DEFAULT '[]'::jsonb)
RETURNS TABLE(outcome_row_id uuid, inserted boolean) LANGUAGE sql AS $$
  SELECT * FROM public.record_forgewing_recovery_generation_outcome(
    'b4200000-0000-4000-8000-000000000001', 'b4200000-0000-4000-8000-0000000000d1',
    'b4200000-0000-4000-8000-0000000000f1', 'extraction-snapshot-1', 8, repeat('a', 64),
    encode(sha256(convert_to('b43-outcome:' || p_key, 'UTF8')), 'hex'),
    p_type, p_code, p_reason, p_invoked, p_candidates) $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pg_temp TO service_role;

SET ROLE service_role;
SELECT set_config('request.jwt.claim.role', 'service_role', false);

DO $$ DECLARE r record; BEGIN
  SELECT * INTO r FROM pg_temp.outcome('policy', 'priced_value_reading', 'data_policy_not_approved',
    'data_policy_not_approved', false);
  IF NOT r.inserted THEN RAISE EXCEPTION 'B4.3 FAIL: data-policy refusal'; END IF;
  SELECT * INTO r FROM pg_temp.outcome('policy', 'priced_value_reading', 'data_policy_not_approved',
    'data_policy_not_approved', false);
  IF r.inserted THEN RAISE EXCEPTION 'B4.3 FAIL: idempotent refusal replay inserted'; END IF;
  SELECT * INTO r FROM pg_temp.outcome('entitlement', 'priced_value_reading', 'entitlement_missing', 'entitlement_revoked', false);
  SELECT * INTO r FROM pg_temp.outcome('budget', 'priced_value_reading', 'budget_exhausted', 'budget_not_configured', false);
  SELECT * INTO r FROM pg_temp.outcome('timeout', 'priced_value_reading', 'provider_failed', 'provider_timeout', true);
  SELECT * INTO r FROM pg_temp.outcome('moved', 'priced_value_reading', 'evidence_binding_failed', 'binding_changed', true);
  SELECT * INTO r FROM pg_temp.outcome('image', 'priced_value_reading', 'evidence_binding_failed', 'region_image_unavailable', false);
  IF (SELECT count(*) FROM public.forgewing_recovery_generation_outcomes
      WHERE recovery_type = 'priced_value_reading'
        AND diagnostic_id IN (SELECT encode(sha256(convert_to('b43-outcome:' || key, 'UTF8')), 'hex')
          FROM unnest(ARRAY['policy', 'entitlement', 'budget', 'timeout', 'moved', 'image']) key)) <> 6 THEN
    RAISE EXCEPTION 'B4.3 FAIL: value-reading outcomes not recorded';
  END IF;
END $$;

-- A refused gate never reaches a provider.
DO $$ BEGIN
  PERFORM pg_temp.outcome('invoked-policy', 'priced_value_reading', 'data_policy_not_approved', 'data_policy_not_approved', true);
  RAISE EXCEPTION 'B4.3 FAIL: a provider-invoked data-policy refusal was accepted';
EXCEPTION WHEN check_violation THEN NULL; END $$;
DO $$ BEGIN
  PERFORM pg_temp.outcome('invoked-entitlement', 'priced_value_reading', 'entitlement_missing', 'no_entitlement', true);
  RAISE EXCEPTION 'B4.3 FAIL: a provider-invoked entitlement refusal was accepted';
EXCEPTION WHEN check_violation THEN NULL; END $$;
-- The new vocabulary belongs to value readings only; every recovery type is constrained as before.
DO $$ BEGIN
  PERFORM pg_temp.outcome('old-type-new-code', 'priced_schedule_continuation_attribution',
    'data_policy_not_approved', 'data_policy_not_approved', false);
  RAISE EXCEPTION 'B4.3 FAIL: a new outcome code accepted for a recovery type';
EXCEPTION WHEN check_violation THEN NULL; END $$;
DO $$ BEGIN
  PERFORM pg_temp.outcome('old-type-new-reason', 'priced_schedule_continuation_attribution',
    'evidence_binding_failed', 'binding_changed', false);
  RAISE EXCEPTION 'B4.3 FAIL: a new reason accepted for a recovery type';
EXCEPTION WHEN check_violation THEN NULL; END $$;
-- A value reading cites no recovery candidates.
DO $$ BEGIN
  PERFORM pg_temp.outcome('candidates', 'priced_value_reading', 'provider_failed', 'provider_error', true,
    jsonb_build_array('recovery-candidate-v2-' || repeat('0', 64)));
  RAISE EXCEPTION 'B4.3 FAIL: a value-reading outcome citing candidates was accepted';
EXCEPTION WHEN check_violation THEN NULL; END $$;
DO $$ BEGIN
  PERFORM pg_temp.outcome('unknown-reason', 'priced_value_reading', 'provider_failed', 'model_was_unsure', true);
  RAISE EXCEPTION 'B4.3 FAIL: an unknown reason was accepted';
EXCEPTION WHEN check_violation THEN NULL; END $$;
RESET ROLE;

DO $$ BEGIN
  UPDATE public.forgewing_recovery_generation_outcomes SET sanitized_reason = 'provider_error'
    WHERE recovery_type = 'priced_value_reading';
  RAISE EXCEPTION 'B4.3 FAIL: an outcome was updated';
EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;

SELECT 'B4.3 VALUE-READING OUTCOMES: TYPED / GATE-COHERENT / SCOPED / IMMUTABLE: PASS' AS result;
