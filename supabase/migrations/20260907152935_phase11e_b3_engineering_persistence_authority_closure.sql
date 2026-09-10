-- Phase 11E B3 qualification closure. These checks enforce existing frozen
-- contracts at the database boundary; they add no execution or operator-decision
-- authority.

ALTER TABLE public.workflow_repository_plan_v2_runs
  ADD CONSTRAINT workflow_repository_plan_v2_plan_v1_source_binding_check
  CHECK (
    implementation_plan_v1_digest_sha256
      IS NOT DISTINCT FROM plan_v2_canonical_json::jsonb #>> '{source,implementationPlanV1DigestSha256}'
    AND implementation_plan_v1_digest_sha256
      IS NOT DISTINCT FROM plan_v2_canonical_json::jsonb #>> '{guidance,sourceImplementationPlanV1DigestSha256}'
  );

CREATE FUNCTION public.is_valid_workflow_engineering_modified_scope(p_scope jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
STRICT
SET search_path = ''
AS $$
DECLARE
  v_value jsonb;
  v_gate jsonb;
BEGIN
  IF pg_catalog.jsonb_typeof(p_scope) <> 'object'
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(p_scope)) <> 7
    OR NOT p_scope ?& ARRAY[
      'capabilitySummary', 'summary', 'evidenceRefs', 'architectureRisks',
      'regressionGates', 'stopConditions', 'unresolvedQuestions'
    ] THEN
    RETURN false;
  END IF;

  IF pg_catalog.jsonb_typeof(p_scope->'capabilitySummary') <> 'string'
    OR pg_catalog.length(pg_catalog.btrim(p_scope->>'capabilitySummary')) NOT BETWEEN 1 AND 120
    OR p_scope->>'capabilitySummary' ~ E'[\r\n]'
    OR pg_catalog.jsonb_typeof(p_scope->'summary') <> 'string'
    OR pg_catalog.length(pg_catalog.btrim(p_scope->>'summary')) NOT BETWEEN 1 AND 2000 THEN
    RETURN false;
  END IF;

  IF pg_catalog.jsonb_typeof(p_scope->'evidenceRefs') <> 'array'
    OR pg_catalog.jsonb_array_length(p_scope->'evidenceRefs') > 20
    OR pg_catalog.jsonb_typeof(p_scope->'architectureRisks') <> 'array'
    OR pg_catalog.jsonb_array_length(p_scope->'architectureRisks') > 12
    OR pg_catalog.jsonb_typeof(p_scope->'regressionGates') <> 'array'
    OR pg_catalog.jsonb_array_length(p_scope->'regressionGates') > 20
    OR pg_catalog.jsonb_typeof(p_scope->'stopConditions') <> 'array'
    OR pg_catalog.jsonb_array_length(p_scope->'stopConditions') > 12
    OR pg_catalog.jsonb_typeof(p_scope->'unresolvedQuestions') <> 'array'
    OR pg_catalog.jsonb_array_length(p_scope->'unresolvedQuestions') > 12 THEN
    RETURN false;
  END IF;

  FOR v_value IN SELECT value FROM pg_catalog.jsonb_array_elements(p_scope->'evidenceRefs') LOOP
    IF pg_catalog.jsonb_typeof(v_value) <> 'string' OR v_value #>> '{}' !~ '^ev_[0-9a-f]{64}$' THEN RETURN false; END IF;
  END LOOP;
  FOR v_value IN SELECT value FROM pg_catalog.jsonb_array_elements(p_scope->'architectureRisks') LOOP
    IF pg_catalog.jsonb_typeof(v_value) <> 'string'
      OR pg_catalog.length(pg_catalog.btrim(v_value #>> '{}')) NOT BETWEEN 1 AND 500 THEN RETURN false; END IF;
  END LOOP;
  FOR v_value IN SELECT value FROM pg_catalog.jsonb_array_elements(p_scope->'unresolvedQuestions') LOOP
    IF pg_catalog.jsonb_typeof(v_value) <> 'string'
      OR pg_catalog.length(pg_catalog.btrim(v_value #>> '{}')) NOT BETWEEN 1 AND 500 THEN RETURN false; END IF;
  END LOOP;
  FOR v_value IN SELECT value FROM pg_catalog.jsonb_array_elements(p_scope->'stopConditions') LOOP
    IF pg_catalog.jsonb_typeof(v_value) <> 'string' OR v_value #>> '{}' NOT IN (
      'authority_boundary_unclear', 'canonical_truth_owner_unclear', 'operator_decision_required',
      'evidence_scope_insufficient', 'repository_context_stale', 'migration_required',
      'execution_authority_required'
    ) THEN RETURN false; END IF;
  END LOOP;
  FOR v_gate IN SELECT value FROM pg_catalog.jsonb_array_elements(p_scope->'regressionGates') LOOP
    IF pg_catalog.jsonb_typeof(v_gate) <> 'object'
      OR NOT (
        ((SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(v_gate)) = 1
          AND v_gate->>'gate' IN ('typecheck', 'build'))
        OR ((SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(v_gate)) = 3
          AND v_gate ?& ARRAY['gate','evidenceRef','testPath']
          AND v_gate->>'gate' = 'evidence_test'
          AND pg_catalog.jsonb_typeof(v_gate->'evidenceRef') = 'string'
          AND v_gate->>'evidenceRef' ~ '^ev_[0-9a-f]{64}$'
          AND pg_catalog.jsonb_typeof(v_gate->'testPath') = 'string'
          AND pg_catalog.length(v_gate->>'testPath') BETWEEN 1 AND 500)
      ) THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
END;
$$;

ALTER FUNCTION public.is_valid_workflow_engineering_modified_scope(jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.is_valid_workflow_engineering_modified_scope(jsonb)
  FROM PUBLIC, anon, authenticated, service_role;

ALTER TABLE public.workflow_repository_plan_recommendation_reviews
  ADD CONSTRAINT workflow_repository_plan_review_modified_scope_shape_check
  CHECK (
    modified_scope IS NULL
    OR public.is_valid_workflow_engineering_modified_scope(modified_scope)
  );
