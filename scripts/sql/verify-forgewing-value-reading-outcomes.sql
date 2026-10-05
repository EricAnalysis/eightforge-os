\set ON_ERROR_STOP on

-- Forgewing B4.3: one durable outcome per value-reading request. Reuses the
-- B4.2 fixtures (organizations, operators, document, artifact and the 'p1'
-- value proposal). Every check raises on failure.

CREATE FUNCTION pg_temp.key(p_key text) RETURNS text LANGUAGE sql AS $$
  SELECT encode(sha256(convert_to('b43-request-key:' || p_key, 'UTF8')), 'hex') $$;
CREATE FUNCTION pg_temp.b42(p_kind text, p_key text) RETURNS text LANGUAGE sql AS $$
  SELECT encode(sha256(convert_to(p_kind || ':' || p_key || CASE WHEN p_kind = 'proposal' THEN ':' || p_key ELSE '' END,
    'UTF8')), 'hex') $$;
CREATE FUNCTION pg_temp.outcome(
  p_key text, p_code text, p_reason text, p_invoked boolean,
  p_request text DEFAULT NULL, p_proposal text DEFAULT NULL,
  p_actor uuid DEFAULT 'b4200000-0000-4000-8000-0000000000a1',
  p_anchor text DEFAULT 'p8:line:300')
RETURNS TABLE(outcome_row_id uuid, inserted boolean) LANGUAGE sql AS $$
  SELECT * FROM public.record_forgewing_value_reading_outcome(
    'b4200000-0000-4000-8000-000000000001', 'b4200000-0000-4000-8000-0000000000d1',
    'b4200000-0000-4000-8000-0000000000f1', 'extraction-snapshot-1', 8, repeat('a', 64),
    p_anchor, p_request, p_actor, pg_temp.key(p_key), p_code, p_reason, p_invoked, p_proposal) $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pg_temp TO service_role, authenticated;

SET ROLE authenticated;
DO $$ BEGIN
  PERFORM pg_temp.outcome('browser', 'recovery_disabled', 'kill_switch_off', false);
  RAISE EXCEPTION 'B4.3 FAIL: authenticated recorded an outcome';
EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;
RESET ROLE;

SET ROLE service_role;
SELECT set_config('request.jwt.claim.role', 'service_role', false);

-- Every kind of request result is recordable, once per request key.
DO $$ DECLARE r record; BEGIN
  SELECT * INTO r FROM pg_temp.outcome('off-1', 'recovery_disabled', 'kill_switch_off', false);
  IF NOT r.inserted THEN RAISE EXCEPTION 'B4.3 FAIL: deployment refusal'; END IF;
  SELECT * INTO r FROM pg_temp.outcome('off-1', 'recovery_disabled', 'kill_switch_off', false);
  IF r.inserted THEN RAISE EXCEPTION 'B4.3 FAIL: a retried request recorded twice'; END IF;
  SELECT * INTO r FROM pg_temp.outcome('off-2', 'recovery_disabled', 'kill_switch_off', false);
  IF NOT r.inserted THEN RAISE EXCEPTION 'B4.3 FAIL: a second request was not its own signal'; END IF;
  PERFORM pg_temp.outcome('activation', 'activation_not_allowed', 'activation_disabled', false);
  PERFORM pg_temp.outcome('entitlement', 'entitlement_missing', 'entitlement_revoked', false);
  PERFORM pg_temp.outcome('policy', 'data_policy_not_approved', 'data_policy_revoked', false);
  PERFORM pg_temp.outcome('budget', 'budget_exhausted', 'budget_not_configured', false);
  PERFORM pg_temp.outcome('lookup', 'system_error', 'gate_lookup_failed', false);
  PERFORM pg_temp.outcome('timeout', 'provider_failed', 'provider_timeout', true, pg_temp.b42('request', 'p1'));
  PERFORM pg_temp.outcome('moved', 'evidence_binding_failed', 'binding_changed', true, pg_temp.b42('request', 'p1'));
  PERFORM pg_temp.outcome('generated', 'generated_proposal', 'proposal_recorded', true,
    pg_temp.b42('request', 'p1'), 'forgewing-proposal-value-reading-' || pg_temp.b42('proposal', 'p1'));
  PERFORM pg_temp.outcome('reused', 'existing_result_reused', 'request_already_answered', false,
    pg_temp.b42('request', 'p1'), 'forgewing-proposal-value-reading-' || pg_temp.b42('proposal', 'p1'));
  IF (SELECT count(*) FROM public.forgewing_recovery_generation_outcomes
      WHERE recovery_type = 'priced_value_reading'
        AND diagnostic_id IN (SELECT pg_temp.key(k) FROM unnest(ARRAY['off-1', 'off-2', 'activation', 'entitlement',
          'policy', 'budget', 'lookup', 'timeout', 'moved', 'generated', 'reused']) k)) <> 11 THEN
    RAISE EXCEPTION 'B4.3 FAIL: value-reading outcomes not recorded one per request';
  END IF;
END $$;

-- One request, one outcome.
DO $$ BEGIN
  PERFORM pg_temp.outcome('off-1', 'activation_not_allowed', 'activation_disabled', false);
  RAISE EXCEPTION 'B4.3 FAIL: a request key took a second, different outcome';
EXCEPTION WHEN unique_violation THEN NULL; END $$;

-- A produced or reused proposal must be the one this exact request answered.
DO $$ BEGIN
  PERFORM pg_temp.outcome('wrong-request', 'generated_proposal', 'proposal_recorded', true,
    pg_temp.b42('request', 'other-anchor'), 'forgewing-proposal-value-reading-' || pg_temp.b42('proposal', 'p1'));
  RAISE EXCEPTION 'B4.3 FAIL: a proposal answering another request was cited';
EXCEPTION WHEN check_violation THEN NULL; END $$;
DO $$ BEGIN
  PERFORM pg_temp.outcome('wrong-kind', 'unreadable', 'proposal_recorded', true,
    pg_temp.b42('request', 'p1'), 'forgewing-proposal-value-reading-' || pg_temp.b42('proposal', 'p1'));
  RAISE EXCEPTION 'B4.3 FAIL: a value proposal recorded as unreadable';
EXCEPTION WHEN check_violation THEN NULL; END $$;
DO $$ BEGIN
  PERFORM pg_temp.outcome('no-proposal', 'generated_proposal', 'proposal_recorded', true, pg_temp.b42('request', 'p1'));
  RAISE EXCEPTION 'B4.3 FAIL: a generated outcome without its proposal';
EXCEPTION WHEN check_violation THEN NULL; END $$;
DO $$ BEGIN
  PERFORM pg_temp.outcome('refusal-with-proposal', 'recovery_disabled', 'kill_switch_off', false,
    pg_temp.b42('request', 'p1'), 'forgewing-proposal-value-reading-' || pg_temp.b42('proposal', 'p1'));
  RAISE EXCEPTION 'B4.3 FAIL: a refusal citing a proposal';
EXCEPTION WHEN check_violation THEN NULL; END $$;

-- A refusal never reaches a provider; a generated reading always did; a call needs a built request.
DO $$ BEGIN
  PERFORM pg_temp.outcome('invoked-refusal', 'activation_not_allowed', 'activation_disabled', true);
  RAISE EXCEPTION 'B4.3 FAIL: a provider-invoked refusal';
EXCEPTION WHEN check_violation THEN NULL; END $$;
DO $$ BEGIN
  PERFORM pg_temp.outcome('silent-generation', 'generated_proposal', 'proposal_recorded', false,
    pg_temp.b42('request', 'p1'), 'forgewing-proposal-value-reading-' || pg_temp.b42('proposal', 'p1'));
  RAISE EXCEPTION 'B4.3 FAIL: a generated reading without a provider call';
EXCEPTION WHEN check_violation THEN NULL; END $$;
DO $$ BEGIN
  PERFORM pg_temp.outcome('unbuilt-call', 'provider_failed', 'provider_error', true);
  RAISE EXCEPTION 'B4.3 FAIL: a provider failure without a request digest';
EXCEPTION WHEN check_violation THEN NULL; END $$;

-- The requesting operator belongs to the organization.
DO $$ BEGIN
  PERFORM pg_temp.outcome('foreign-operator', 'recovery_disabled', 'kill_switch_off', false,
    p_actor => 'b4200000-0000-4000-8000-0000000000b1');
  RAISE EXCEPTION 'B4.3 FAIL: an operator from another organization';
EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;

-- The recovery record function cannot write a value-reading outcome, and the
-- new vocabulary is valid for value readings only.
DO $$ BEGIN
  PERFORM public.record_forgewing_recovery_generation_outcome(
    'b4200000-0000-4000-8000-000000000001', 'b4200000-0000-4000-8000-0000000000d1',
    'b4200000-0000-4000-8000-0000000000f1', 'extraction-snapshot-1', 8, repeat('a', 64),
    pg_temp.key('legacy-writer'), 'priced_value_reading', 'recovery_disabled', 'kill_switch_off', false, '[]'::jsonb);
  RAISE EXCEPTION 'B4.3 FAIL: the recovery writer recorded a value-reading outcome';
EXCEPTION WHEN check_violation THEN NULL; END $$;
DO $$ BEGIN
  PERFORM public.record_forgewing_recovery_generation_outcome(
    'b4200000-0000-4000-8000-000000000001', 'b4200000-0000-4000-8000-0000000000d1',
    'b4200000-0000-4000-8000-0000000000f1', 'extraction-snapshot-1', 8, repeat('a', 64),
    pg_temp.key('legacy-new-code'), 'priced_schedule_continuation_attribution', 'activation_not_allowed',
    'activation_disabled', false, '[]'::jsonb);
  RAISE EXCEPTION 'B4.3 FAIL: a new outcome code accepted for a recovery type';
EXCEPTION WHEN check_violation THEN NULL; END $$;
RESET ROLE;

DO $$ BEGIN
  UPDATE public.forgewing_recovery_generation_outcomes SET sanitized_reason = 'provider_error'
    WHERE recovery_type = 'priced_value_reading';
  RAISE EXCEPTION 'B4.3 FAIL: an outcome was updated';
EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;

SELECT 'B4.3 VALUE-READING OUTCOMES: ONE PER REQUEST / TYPED / GATE-COHERENT / SCOPED / IMMUTABLE: PASS' AS result;
