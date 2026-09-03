-- Round 3 database-authority closure. Additive because the preceding PR
-- migrations have already run in Supabase Preview.

DO $attempt_cap_constraint$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.workflow_assessment_attempts'::regclass
      AND conname = 'workflow_assessment_attempts_lifetime_cap_check'
  ) THEN
    ALTER TABLE public.workflow_assessment_attempts
      ADD CONSTRAINT workflow_assessment_attempts_lifetime_cap_check
      CHECK (attempt_number <= 2);
  END IF;
END
$attempt_cap_constraint$;

CREATE OR REPLACE FUNCTION public.claim_workflow_assessment_attempt(
  p_max_attempts integer,
  p_submission_id uuid DEFAULT NULL,
  p_exclude_submission_ids uuid[] DEFAULT NULL
)
RETURNS TABLE (attempt_id uuid, source_submission_id uuid, attempt_number integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_submission uuid;
  v_attempts integer;
  v_excluded uuid[] := COALESCE(p_exclude_submission_ids, ARRAY[]::uuid[]);
BEGIN
  -- Preserve the deployed signature, but make the database-owned lifetime cap
  -- non-negotiable. A service-role caller cannot widen it.
  IF p_max_attempts IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION 'workflow assessment lifetime attempt cap is 2'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- The intake row is the durable per-submission coordination row. Its lock is
  -- held through recount and insert. SKIP LOCKED lets a sweep continue to later
  -- eligible work rather than allowing the oldest busy row to starve the queue.
  LOOP
  SELECT intake.id INTO v_submission
  FROM public.workflow_intake_submissions AS intake
  WHERE (p_submission_id IS NULL OR intake.id = p_submission_id)
    AND NOT (intake.id = ANY (v_excluded))
    AND NOT EXISTS (
      SELECT 1 FROM public.workflow_assessments AS assessment
      WHERE assessment.source_submission_id = intake.id
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.workflow_assessment_attempts AS active_attempt
      WHERE active_attempt.source_submission_id = intake.id
        AND active_attempt.status = 'claimed'
    )
    AND (
      SELECT count(*) FROM public.workflow_assessment_attempts AS lifetime_attempt
      WHERE lifetime_attempt.source_submission_id = intake.id
    ) < 2
  ORDER BY intake.submitted_at ASC, intake.id ASC
  FOR UPDATE OF intake SKIP LOCKED
  LIMIT 1;

  IF v_submission IS NULL THEN RETURN; END IF;

  SELECT count(*) INTO v_attempts
  FROM public.workflow_assessment_attempts AS lifetime_attempt
  WHERE lifetime_attempt.source_submission_id = v_submission;

  -- Recheck under the serialization boundary before inserting. The table
  -- constraint is an independent last line of defense against attempt 3.
  IF v_attempts >= 2
    OR EXISTS (SELECT 1 FROM public.workflow_assessments AS assessment
      WHERE assessment.source_submission_id = v_submission)
    OR EXISTS (SELECT 1 FROM public.workflow_assessment_attempts AS active_attempt
      WHERE active_attempt.source_submission_id = v_submission
        AND active_attempt.status = 'claimed') THEN
    IF p_submission_id IS NOT NULL THEN RETURN; END IF;
    v_excluded := array_append(v_excluded, v_submission);
    CONTINUE;
  END IF;

  BEGIN
    RETURN QUERY
    INSERT INTO public.workflow_assessment_attempts AS inserted (
      source_submission_id, attempt_number, status
    )
    VALUES (v_submission, v_attempts + 1, 'claimed')
    RETURNING inserted.id, inserted.source_submission_id, inserted.attempt_number;
  EXCEPTION WHEN unique_violation THEN
    IF p_submission_id IS NOT NULL THEN RETURN; END IF;
    v_excluded := array_append(v_excluded, v_submission);
    CONTINUE;
  END;
  RETURN;
  END LOOP;
END;
$$;

ALTER FUNCTION public.claim_workflow_assessment_attempt(integer, uuid, uuid[])
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.claim_workflow_assessment_attempt(integer, uuid, uuid[])
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_workflow_assessment_attempt(integer, uuid, uuid[])
  TO service_role;

CREATE OR REPLACE FUNCTION public.finalize_workflow_assessment_attempt(
  p_attempt_id uuid,
  p_status text,
  p_failure_class text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_status IS NULL OR p_status NOT IN ('succeeded', 'failed') THEN
    RAISE EXCEPTION 'attempt may only be finalized as succeeded or failed'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- The existing lifecycle trigger rejects any update of an already terminal
  -- attempt, including concurrent finalizers that arrive after the winner.
  UPDATE public.workflow_assessment_attempts AS attempt
  SET status = p_status, completed_at = now(),
      failure_class = CASE WHEN p_status = 'failed'
        THEN COALESCE(p_failure_class, 'unspecified') ELSE NULL END
  WHERE attempt.id = p_attempt_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no workflow assessment attempt %', p_attempt_id
      USING ERRCODE = 'no_data_found';
  END IF;
END;
$$;

ALTER FUNCTION public.finalize_workflow_assessment_attempt(uuid, text, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.finalize_workflow_assessment_attempt(uuid, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_workflow_assessment_attempt(uuid, text, text)
  TO service_role;

CREATE OR REPLACE FUNCTION public.workflow_reviewed_specification_keys(
  p_classification text
)
RETURNS TABLE (required_keys text[], allowed_keys text[])
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT
    CASE p_classification
      WHEN 'RULE' THEN ARRAY['plainLanguageRule','requiredFacts','conditionType',
        'expectedEvidence','expectedOutcome','userDescribedExceptions','unresolvedAssumptions']
      WHEN 'VERIFY' THEN ARRAY['plainLanguageRule','requiredFacts','conditionType',
        'expectedEvidence','expectedOutcome','userDescribedExceptions','unresolvedAssumptions']
      WHEN 'EXTRACT' THEN ARRAY['describedFact','sourceDocument','deterministicExtractionPlausible']
      WHEN 'RECOVER' THEN ARRAY['describedFact','sourceDocument','description','deterministicShortfall']
      WHEN 'HUMAN' THEN ARRAY['description','whyHumanControlled']
      WHEN 'ADVISORY' THEN ARRAY['description']
      ELSE NULL
    END,
    CASE p_classification
      WHEN 'RULE' THEN ARRAY['plainLanguageRule','requiredFacts','conditionType',
        'expectedEvidence','expectedOutcome','userDescribedExceptions','unresolvedAssumptions']
      WHEN 'VERIFY' THEN ARRAY['plainLanguageRule','requiredFacts','conditionType',
        'expectedEvidence','expectedOutcome','userDescribedExceptions','unresolvedAssumptions']
      WHEN 'EXTRACT' THEN ARRAY['describedFact','sourceDocument','deterministicExtractionPlausible']
      WHEN 'RECOVER' THEN ARRAY['describedFact','sourceDocument','description','deterministicShortfall']
      WHEN 'HUMAN' THEN ARRAY['description','whyHumanControlled']
      WHEN 'ADVISORY' THEN ARRAY['description']
      ELSE NULL
    END;
$$;

ALTER FUNCTION public.workflow_reviewed_specification_keys(text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.workflow_reviewed_specification_keys(text)
  FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.assert_workflow_reviewed_specification(
  p_step_id text,
  p_disposition text,
  p_reviewed_classification text,
  p_specification jsonb
)
RETURNS void
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
DECLARE
  v_required text[];
  v_allowed text[];
  v_keys text[];
  v_offending text;
  v_key text;
  v_expected text;
  v_actual text;
BEGIN
  -- Absent JSON object keys arrive as SQL NULL. Explicit JSON null is a value,
  -- and is rejected rather than silently normalized.
  IF p_disposition IN ('rejected', 'accepted') THEN
    IF p_specification IS NOT NULL THEN
      RAISE EXCEPTION 'step % disposition % must not carry a reviewed specification',
        p_step_id, p_disposition USING ERRCODE = 'invalid_parameter_value';
    END IF;
    RETURN;
  END IF;

  IF p_disposition IS NULL OR p_disposition NOT IN ('modified', 'reclassified') THEN
    RAISE EXCEPTION 'step % has unknown disposition %', p_step_id, p_disposition
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF p_specification IS NULL OR jsonb_typeof(p_specification) <> 'object' THEN
    RAISE EXCEPTION 'step % (%) requires a reviewed specification object, got %',
      p_step_id, p_disposition, COALESCE(jsonb_typeof(p_specification), 'sql-null')
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF public.workflow_specification_has_executable_key(p_specification) THEN
    RAISE EXCEPTION 'step % specification carries an executable-shaped key', p_step_id
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT keys.required_keys, keys.allowed_keys INTO v_required, v_allowed
  FROM public.workflow_reviewed_specification_keys(p_reviewed_classification) AS keys;
  IF v_allowed IS NULL THEN
    RAISE EXCEPTION 'step % has an unknown reviewed classification %',
      p_step_id, p_reviewed_classification USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT array_agg(object_key) INTO v_keys
  FROM jsonb_object_keys(p_specification) AS object_key;
  v_keys := COALESCE(v_keys, ARRAY[]::text[]);

  SELECT object_key INTO v_offending FROM unnest(v_keys) AS object_key
  WHERE NOT (object_key = ANY (v_allowed)) LIMIT 1;
  IF v_offending IS NOT NULL THEN
    RAISE EXCEPTION 'step % specification has unknown key % for %',
      p_step_id, v_offending, p_reviewed_classification
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT required_key INTO v_offending FROM unnest(v_required) AS required_key
  WHERE NOT (required_key = ANY (v_keys)) LIMIT 1;
  IF v_offending IS NOT NULL THEN
    RAISE EXCEPTION 'step % specification is missing required key % for %',
      p_step_id, v_offending, p_reviewed_classification
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  FOREACH v_key IN ARRAY v_keys LOOP
    v_expected := public.workflow_reviewed_specification_field_type(v_key);
    v_actual := jsonb_typeof(p_specification -> v_key);
    IF v_actual = 'null' THEN
      RAISE EXCEPTION 'step % specification field % is null', p_step_id, v_key
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
    IF v_expected = 'string_array' THEN
      IF v_actual <> 'array' OR EXISTS (
        SELECT 1 FROM jsonb_array_elements(p_specification -> v_key) AS item
        WHERE jsonb_typeof(item) <> 'string'
          OR btrim(item #>> '{}') = ''
      ) THEN
        RAISE EXCEPTION 'step % specification field % must contain nonempty strings',
          p_step_id, v_key USING ERRCODE = 'invalid_parameter_value';
      END IF;
      IF v_key IN ('requiredFacts', 'expectedEvidence')
        AND jsonb_array_length(p_specification -> v_key) = 0 THEN
        RAISE EXCEPTION 'step % specification field % must not be empty', p_step_id, v_key
          USING ERRCODE = 'invalid_parameter_value';
      END IF;
    ELSIF v_expected IS NOT NULL AND v_actual <> v_expected THEN
      RAISE EXCEPTION 'step % specification field % must be %, got %',
        p_step_id, v_key, v_expected, v_actual
        USING ERRCODE = 'invalid_parameter_value';
    ELSIF v_expected = 'string' AND btrim(p_specification ->> v_key) = '' THEN
      RAISE EXCEPTION 'step % specification field % must not be empty', p_step_id, v_key
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
  END LOOP;
END;
$$;

ALTER FUNCTION public.assert_workflow_reviewed_specification(text, text, text, jsonb)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.assert_workflow_reviewed_specification(text, text, text, jsonb)
  FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.workflow_json_identifier_is_valid(p_value jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE(jsonb_typeof(p_value) = 'string'
    AND length(p_value #>> '{}') BETWEEN 1 AND 120
    AND btrim(p_value #>> '{}') = (p_value #>> '{}'), false);
$$;

ALTER FUNCTION public.workflow_json_identifier_is_valid(jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.workflow_json_identifier_is_valid(jsonb)
  FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.workflow_accepted_proposal_specification(
  p_assessment jsonb,
  p_step_id text,
  p_classification text
)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
DECLARE
  v_collection text;
  v_id_key text;
  v_detail jsonb;
  v_secondary jsonb;
  v_count integer;
  v_specification jsonb;
BEGIN
  CASE p_classification
    WHEN 'RULE' THEN v_collection := 'deterministicRuleProposals'; v_id_key := 'ruleId';
    WHEN 'VERIFY' THEN v_collection := 'verificationRuleProposals'; v_id_key := 'ruleId';
    WHEN 'EXTRACT', 'RECOVER' THEN v_collection := 'extractionRequirements'; v_id_key := 'requirementId';
    WHEN 'HUMAN' THEN v_collection := 'humanDecisionPoints'; v_id_key := 'decisionId';
    WHEN 'ADVISORY' THEN v_collection := 'advisorySteps'; v_id_key := 'advisoryId';
    ELSE RAISE EXCEPTION 'step % has unknown proposed classification %', p_step_id, p_classification
      USING ERRCODE = 'invalid_parameter_value';
  END CASE;

  IF jsonb_typeof(p_assessment -> v_collection) <> 'array' THEN
    RAISE EXCEPTION 'step % proposal collection % is missing or malformed', p_step_id, v_collection
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT count(*), (jsonb_agg(detail))->0 INTO v_count, v_detail
  FROM jsonb_array_elements(p_assessment -> v_collection) AS detail
  WHERE detail ->> 'stepId' = p_step_id;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'step % requires exactly one % proposal, found %',
      p_step_id, p_classification, v_count USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF NOT public.workflow_json_identifier_is_valid(v_detail -> 'stepId')
    OR v_detail ->> 'stepId' <> p_step_id
    OR NOT public.workflow_json_identifier_is_valid(v_detail -> v_id_key) THEN
    RAISE EXCEPTION 'step % has malformed proposal identity', p_step_id
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF p_classification = 'RECOVER' THEN
    IF jsonb_typeof(p_assessment -> 'forgewingRecoveryTasks') <> 'array' THEN
      RAISE EXCEPTION 'step % recovery task collection is missing or malformed', p_step_id
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
    SELECT count(*), (jsonb_agg(detail))->0 INTO v_count, v_secondary
    FROM jsonb_array_elements(p_assessment -> 'forgewingRecoveryTasks') AS detail
    WHERE detail ->> 'stepId' = p_step_id;
    IF v_count <> 1
      OR NOT public.workflow_json_identifier_is_valid(v_secondary -> 'stepId')
      OR NOT public.workflow_json_identifier_is_valid(v_secondary -> 'taskId')
      OR v_detail -> 'deterministicExtractionPlausible' IS DISTINCT FROM 'false'::jsonb THEN
      RAISE EXCEPTION 'step % has incomplete or incompatible recovery proposal', p_step_id
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
    -- RECOVER composes from two historical objects. Validate their raw closed
    -- shapes before composition so unknown or executable fields cannot be
    -- normalized away by jsonb_build_object.
    IF (v_detail - ARRAY[
        'requirementId','stepId','describedFact','sourceDocument',
        'deterministicExtractionPlausible'
      ]) <> '{}'::jsonb
      OR (v_secondary - ARRAY[
        'taskId','stepId','description','deterministicShortfall'
      ]) <> '{}'::jsonb THEN
      RAISE EXCEPTION 'step % recovery proposal contains unknown fields', p_step_id
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
    v_specification := jsonb_build_object(
      'describedFact', v_detail -> 'describedFact',
      'sourceDocument', v_detail -> 'sourceDocument',
      'description', v_secondary -> 'description',
      'deterministicShortfall', v_secondary -> 'deterministicShortfall'
    );
  ELSE
    v_specification := v_detail - ARRAY[v_id_key, 'stepId'];
  END IF;

  PERFORM public.assert_workflow_reviewed_specification(
    p_step_id, 'modified', p_classification, v_specification);
  RETURN v_specification;
END;
$$;

ALTER FUNCTION public.workflow_accepted_proposal_specification(jsonb, text, text)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.workflow_accepted_proposal_specification(jsonb, text, text)
  FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.record_workflow_assessment_review(
  p_assessment_id uuid,
  p_assessment_version integer,
  p_reviewer_actor_id uuid,
  p_step_reviews jsonb,
  p_reviewer_summary text DEFAULT NULL
)
RETURNS TABLE (review_id uuid, review_version integer, overall_disposition text, step_review_count integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_submission_id uuid;
  v_assessment jsonb;
  v_proposed_steps jsonb;
  v_review_id uuid;
  v_review_version integer;
  v_overall text;
  v_count integer;
  v_expected integer;
  v_distinct integer;
  v_entry jsonb;
  v_classification text;
  v_accepted_detail_ids text[] := ARRAY[]::text[];
BEGIN
  IF p_step_reviews IS NULL OR jsonb_typeof(p_step_reviews) <> 'array' THEN
    RAISE EXCEPTION 'step_reviews must be a json array' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_reviewer_actor_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.user_profiles AS profile WHERE profile.id = p_reviewer_actor_id
  ) THEN
    RAISE EXCEPTION 'workflow assessment reviewer % is not a known user profile', p_reviewer_actor_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  SELECT assessment.source_submission_id, assessment.assessment
    INTO v_submission_id, v_assessment
  FROM public.workflow_assessments AS assessment
  WHERE assessment.id = p_assessment_id
    AND assessment.assessment_version = p_assessment_version;
  IF v_submission_id IS NULL THEN
    RAISE EXCEPTION 'no workflow assessment % at version %', p_assessment_id, p_assessment_version
      USING ERRCODE = 'no_data_found';
  END IF;

  IF jsonb_typeof(v_assessment -> 'workflowSteps') IS DISTINCT FROM 'array'
    OR jsonb_array_length(v_assessment -> 'workflowSteps') = 0
    OR EXISTS (
      SELECT 1 FROM jsonb_array_elements(v_assessment -> 'workflowSteps') AS step
      WHERE jsonb_typeof(step) <> 'object'
        OR NOT public.workflow_json_identifier_is_valid(step -> 'stepId')
        OR jsonb_typeof(step -> 'classification') IS DISTINCT FROM 'string'
        OR step ->> 'classification' NOT IN ('RULE','VERIFY','EXTRACT','RECOVER','HUMAN','ADVISORY')
    ) THEN
    RAISE EXCEPTION 'workflow assessment has malformed step identity or classification'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT jsonb_object_agg(step->>'stepId', step->>'classification') INTO v_proposed_steps
  FROM jsonb_array_elements(v_assessment -> 'workflowSteps') AS step;
  v_expected := jsonb_array_length(v_assessment -> 'workflowSteps');
  IF (SELECT count(*) FROM jsonb_object_keys(v_proposed_steps)) <> v_expected THEN
    RAISE EXCEPTION 'workflow assessment has duplicate step identity'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF jsonb_array_length(p_step_reviews) <> v_expected THEN
    RAISE EXCEPTION 'review must disposition every proposed step: expected %, received %',
      v_expected, jsonb_array_length(p_step_reviews) USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_step_reviews) AS entry
    WHERE jsonb_typeof(entry) <> 'object'
      OR NOT public.workflow_json_identifier_is_valid(entry -> 'assessment_step_id')
      OR jsonb_typeof(entry -> 'proposed_classification') <> 'string'
      OR NOT (v_proposed_steps ? (entry ->> 'assessment_step_id'))
      OR v_proposed_steps ->> (entry ->> 'assessment_step_id')
        IS DISTINCT FROM entry ->> 'proposed_classification'
  ) THEN
    RAISE EXCEPTION 'step review identity or proposed classification is invalid'
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  SELECT count(DISTINCT entry ->> 'assessment_step_id') INTO v_distinct
  FROM jsonb_array_elements(p_step_reviews) AS entry;
  IF v_distinct <> v_expected THEN
    RAISE EXCEPTION 'review must disposition every proposed step exactly once'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Validate all child payloads and historical accepted proposals before either
  -- parent or child row is written. Modified/reclassified steps depend only on
  -- their complete immutable replacement, but step identity is always pinned.
  FOR v_entry IN SELECT * FROM jsonb_array_elements(p_step_reviews) LOOP
    PERFORM public.assert_workflow_reviewed_specification(
      v_entry ->> 'assessment_step_id',
      v_entry ->> 'disposition',
      v_entry ->> 'reviewed_classification',
      v_entry -> 'accepted_specification'
    );
    IF v_entry ->> 'disposition' = 'accepted' THEN
      v_classification := v_entry ->> 'proposed_classification';
      PERFORM public.workflow_accepted_proposal_specification(
        v_assessment,
        v_entry ->> 'assessment_step_id',
        v_classification
      );
      CASE v_classification
        WHEN 'RULE' THEN
          SELECT v_accepted_detail_ids || ARRAY[detail ->> 'ruleId']
            INTO v_accepted_detail_ids
          FROM jsonb_array_elements(v_assessment -> 'deterministicRuleProposals') AS detail
          WHERE detail ->> 'stepId' = v_entry ->> 'assessment_step_id';
        WHEN 'VERIFY' THEN
          SELECT v_accepted_detail_ids || ARRAY[detail ->> 'ruleId']
            INTO v_accepted_detail_ids
          FROM jsonb_array_elements(v_assessment -> 'verificationRuleProposals') AS detail
          WHERE detail ->> 'stepId' = v_entry ->> 'assessment_step_id';
        WHEN 'EXTRACT' THEN
          SELECT v_accepted_detail_ids || ARRAY[detail ->> 'requirementId']
            INTO v_accepted_detail_ids
          FROM jsonb_array_elements(v_assessment -> 'extractionRequirements') AS detail
          WHERE detail ->> 'stepId' = v_entry ->> 'assessment_step_id';
        WHEN 'RECOVER' THEN
          SELECT v_accepted_detail_ids || ARRAY[requirement ->> 'requirementId', task ->> 'taskId']
            INTO v_accepted_detail_ids
          FROM jsonb_array_elements(v_assessment -> 'extractionRequirements') AS requirement,
               jsonb_array_elements(v_assessment -> 'forgewingRecoveryTasks') AS task
          WHERE requirement ->> 'stepId' = v_entry ->> 'assessment_step_id'
            AND task ->> 'stepId' = v_entry ->> 'assessment_step_id';
        WHEN 'HUMAN' THEN
          SELECT v_accepted_detail_ids || ARRAY[detail ->> 'decisionId']
            INTO v_accepted_detail_ids
          FROM jsonb_array_elements(v_assessment -> 'humanDecisionPoints') AS detail
          WHERE detail ->> 'stepId' = v_entry ->> 'assessment_step_id';
        WHEN 'ADVISORY' THEN
          SELECT v_accepted_detail_ids || ARRAY[detail ->> 'advisoryId']
            INTO v_accepted_detail_ids
          FROM jsonb_array_elements(v_assessment -> 'advisorySteps') AS detail
          WHERE detail ->> 'stepId' = v_entry ->> 'assessment_step_id';
      END CASE;
    END IF;
  END LOOP;
  IF cardinality(v_accepted_detail_ids) <> (
    SELECT count(DISTINCT detail_id) FROM unnest(v_accepted_detail_ids) AS detail_id
  ) THEN
    RAISE EXCEPTION 'accepted proposal detail identities are not globally unique'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT COALESCE(max(review.review_version), 0) + 1 INTO v_review_version
  FROM public.workflow_assessment_reviews AS review
  WHERE review.assessment_id = p_assessment_id;
  SELECT CASE
    WHEN bool_and(entry ->> 'disposition' = 'accepted') THEN 'accepted'
    WHEN bool_and(entry ->> 'disposition' = 'rejected') THEN 'rejected'
    ELSE 'changes_required'
  END INTO v_overall FROM jsonb_array_elements(p_step_reviews) AS entry;

  v_review_id := gen_random_uuid();
  INSERT INTO public.workflow_assessment_reviews (
    id, assessment_id, source_submission_id, assessment_version,
    review_version, reviewer_actor_id, overall_disposition, reviewer_summary
  ) VALUES (
    v_review_id, p_assessment_id, v_submission_id, p_assessment_version,
    v_review_version, p_reviewer_actor_id, v_overall, p_reviewer_summary
  );

  INSERT INTO public.workflow_assessment_step_reviews (
    id, review_id, assessment_step_id, proposed_classification,
    reviewed_classification, disposition, reviewer_notes, accepted_specification
  )
  SELECT gen_random_uuid(), v_review_id, entry ->> 'assessment_step_id',
    entry ->> 'proposed_classification', entry ->> 'reviewed_classification',
    entry ->> 'disposition', entry ->> 'reviewer_notes',
    entry -> 'accepted_specification'
  FROM jsonb_array_elements(p_step_reviews) AS entry;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN QUERY SELECT v_review_id, v_review_version, v_overall, v_count;
END;
$$;

ALTER FUNCTION public.record_workflow_assessment_review(uuid, integer, uuid, jsonb, text)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.record_workflow_assessment_review(uuid, integer, uuid, jsonb, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_workflow_assessment_review(uuid, integer, uuid, jsonb, text)
  TO service_role;
