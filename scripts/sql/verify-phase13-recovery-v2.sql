\set ON_ERROR_STOP on

-- Phase 13 Recovery V2 -- the id-agnostic half of the qualification.
--
-- A V2 candidate id is a digest over the candidate's own source closure. SQL
-- cannot derive one without reimplementing the application's canonical hashing,
-- and a hand-written `repeat('a',64)` placeholder would prove only that the RPC
-- accepts a well-formed *shape* -- exactly the assurance that is not wanted.
--
-- So everything candidate-bearing lives in
-- `scripts/verify-phase13-recovery-v2-from-postgres.ts`, which builds candidates
-- through the real `RecoveryCandidateV2` contract and drives the real RPCs and
-- resolver: accepted, modified, rejected/deferred inert, non-canonical id
-- refused as incoherent, and the RPC negatives.
--
-- What remains here is what SQL can assert more honestly than TypeScript can:
-- that historical V1 rows are untouched by the V2 columns, that the version
-- shape constraint is enforced by the database rather than by the caller, and
-- that the V2 RPCs are reachable only by service_role.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.forgewing_recovery_proposals
    WHERE proposal_version = 1
      AND selected_observation_id IS NOT NULL
      AND selected_candidate_id IS NULL
      AND recovery_candidates IS NULL
  ) THEN
    RAISE EXCEPTION 'Phase 12 historical proposal is not V1-compatible';
  END IF;
  -- No historical row was migrated into the V2 arm.
  IF EXISTS (
    SELECT 1 FROM public.forgewing_recovery_proposals
    WHERE proposal_version = 1 AND recovery_type <> 'pricing_rate_single_observation'
  ) THEN
    RAISE EXCEPTION 'a historical V1 proposal was reinterpreted as a V2 recovery type';
  END IF;
  -- Every V1 review keeps its observation selection and gained no candidate.
  IF EXISTS (
    SELECT 1 FROM public.forgewing_recovery_proposal_reviews review
    JOIN public.forgewing_recovery_proposals proposal ON proposal.id = review.proposal_row_id
    WHERE proposal.proposal_version = 1 AND review.confirmed_candidate_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'a historical V1 review gained a candidate selection';
  END IF;
END $$;

-- The version shape is a database constraint, not a convention the RPC keeps.
-- A direct write that mixes the two arms must fail even for a privileged role.
DO $$
BEGIN
  BEGIN
    INSERT INTO public.forgewing_recovery_proposals(
      organization_id, source_document_id, source_artifact_id, extraction_snapshot_id,
      physical_page_number, proposal_id, proposal_digest_sha256, task_type, schema_version,
      recovery_reason, eligibility_reason, selected_observation_id, proposed_value,
      normalized_value, evidence, alternative_observation_ids, certainty, reason_category,
      provider_model, prompt_template_id, prompt_template_version,
      proposal_version, recovery_type, selected_candidate_id, recovery_candidates)
    VALUES (
      'a1000000-0000-4000-8000-000000000001', 'a2000000-0000-4000-8000-000000000001',
      'a3000000-0000-4000-8000-000000000001', 'phase13-shape', 1,
      'forgewing-proposal-pricing-rate-cluster-' || repeat('0', 32), repeat('7', 64),
      'pricing_rate_cluster_recovery', 'forgewing-pricing-rate-cluster-recovery-v1',
      'ambiguous_rate_clusters', 'ambiguous_relationship', 'obs:mixed', '8.75', '8.75',
      '[]'::jsonb, '[]'::jsonb, 0.5, 'mixed', 'm', 'p', 'v',
      1, 'pricing_rate_single_observation', NULL, '[]'::jsonb);
    RAISE EXCEPTION 'a V1 proposal carrying V2 candidate columns was accepted';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
END $$;

DO $$
DECLARE proposal_rpc oid; review_rpc oid;
BEGIN
  SELECT oid INTO STRICT proposal_rpc FROM pg_catalog.pg_proc
    WHERE pronamespace = 'public'::regnamespace AND proname = 'record_forgewing_recovery_proposal_v2';
  SELECT oid INTO STRICT review_rpc FROM pg_catalog.pg_proc
    WHERE pronamespace = 'public'::regnamespace AND proname = 'record_forgewing_recovery_proposal_review_v2';
  IF has_function_privilege('anon', proposal_rpc, 'EXECUTE')
     OR has_function_privilege('authenticated', proposal_rpc, 'EXECUTE')
     OR has_function_privilege('anon', review_rpc, 'EXECUTE')
     OR has_function_privilege('authenticated', review_rpc, 'EXECUTE')
     OR NOT has_function_privilege('service_role', proposal_rpc, 'EXECUTE')
     OR NOT has_function_privilege('service_role', review_rpc, 'EXECUTE') THEN
    RAISE EXCEPTION 'Recovery V2 RPC ACL mismatch';
  END IF;
END $$;

SELECT 'PHASE 13 RECOVERY V2 SCHEMA / ACL QUALIFICATION: PASS' AS result;
