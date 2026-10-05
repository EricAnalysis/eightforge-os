-- Forgewing B4.5: the value-reading request digest binds the exact rendered
-- image bytes, so no request exists until the region has been rendered.
-- A region that cannot be proven or rendered (geometry not provable, source
-- bytes no longer hashing to their artifact, renderer failure) is an evidence
-- failure that happens before any request is built, and before any budget or
-- provider is touched. This allows exactly that outcome, and only without a
-- provider call, to be recorded without a request digest.
--
-- Forward-only, one predicate widened. Every existing row already satisfies
-- the stricter rule. No table, column, function, grant or data change.
ALTER TABLE public.forgewing_recovery_generation_outcomes
  DROP CONSTRAINT forgewing_generation_outcomes_value_reading_shape,
  ADD CONSTRAINT forgewing_generation_outcomes_value_reading_shape CHECK (
    CASE WHEN recovery_type = 'priced_value_reading' THEN
      candidate_ids = '[]'::jsonb
      AND length(btrim(anchor_key)) BETWEEN 1 AND 500
      AND requested_by IS NOT NULL
      AND (request_digest_sha256 IS NULL OR request_digest_sha256 ~ '^[0-9a-f]{64}$')
      -- A request that reached the provider, or was answered, was built.
      AND (request_digest_sha256 IS NOT NULL OR outcome_code IN (
        'recovery_disabled', 'activation_not_allowed', 'entitlement_missing',
        'data_policy_not_approved', 'budget_exhausted', 'system_error')
        -- B4.5: the region could not be rendered, so no request was built.
        OR (outcome_code = 'evidence_binding_failed' AND NOT provider_invoked))
      AND (proposal_id IS NOT NULL)
        = (outcome_code IN ('generated_proposal', 'unreadable', 'existing_result_reused'))
      AND (proposal_id IS NULL OR proposal_id ~ '^forgewing-proposal-value-reading-[0-9a-f]{64}$')
    ELSE
      num_nonnulls(anchor_key, request_digest_sha256, requested_by, proposal_id) = 0
    END);
