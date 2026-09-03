-- ============================================================================
-- Database defense for the reviewed specification
--
-- The seam rebuilds reviewed specifications from typed schemas, but the
-- SECURITY DEFINER function accepted any JSON object at all. The final
-- persistence authority must not depend on a caller having gone through the
-- TypeScript path: the function is granted to service_role, and anything
-- holding that role could write an arbitrary object -- including one shaped
-- like executable content -- into immutable audit evidence.
--
-- This is deliberately NOT a second copy of the Zod contract. Reimplementing
-- per-field types in SQL would create two business-rule engines that drift.
-- What the database enforces is the closure the TypeScript cannot guarantee
-- once bypassed: which keys may exist, which must exist, and that nothing
-- executable-shaped is present. Value-level validation stays in one place.
-- ============================================================================

-- Required and allowed keys per reviewed classification. Mirrors
-- REVIEWED_SPECIFICATION_FIELDS; the companion test asserts they agree.
CREATE OR REPLACE FUNCTION "public"."workflow_reviewed_specification_keys"(
  "p_classification" "text"
)
RETURNS TABLE ("required_keys" "text"[], "allowed_keys" "text"[])
LANGUAGE "sql"
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT
    CASE "p_classification"
      WHEN 'RULE' THEN ARRAY['plainLanguageRule','requiredFacts','conditionType',
                             'expectedEvidence','expectedOutcome']
      WHEN 'VERIFY' THEN ARRAY['plainLanguageRule','requiredFacts','conditionType',
                               'expectedEvidence','expectedOutcome']
      WHEN 'EXTRACT' THEN ARRAY['describedFact','sourceDocument',
                                'deterministicExtractionPlausible']
      WHEN 'RECOVER' THEN ARRAY['describedFact','sourceDocument','description',
                                'deterministicShortfall']
      WHEN 'HUMAN' THEN ARRAY['description','whyHumanControlled']
      WHEN 'ADVISORY' THEN ARRAY['description']
      ELSE NULL
    END,
    CASE "p_classification"
      WHEN 'RULE' THEN ARRAY['plainLanguageRule','requiredFacts','conditionType',
                             'expectedEvidence','expectedOutcome',
                             'userDescribedExceptions','unresolvedAssumptions']
      WHEN 'VERIFY' THEN ARRAY['plainLanguageRule','requiredFacts','conditionType',
                               'expectedEvidence','expectedOutcome',
                               'userDescribedExceptions','unresolvedAssumptions']
      WHEN 'EXTRACT' THEN ARRAY['describedFact','sourceDocument',
                                'deterministicExtractionPlausible']
      WHEN 'RECOVER' THEN ARRAY['describedFact','sourceDocument','description',
                                'deterministicShortfall']
      WHEN 'HUMAN' THEN ARRAY['description','whyHumanControlled']
      WHEN 'ADVISORY' THEN ARRAY['description']
      ELSE NULL
    END;
$$;

ALTER FUNCTION "public"."workflow_reviewed_specification_keys"("text")
  OWNER TO "postgres";

/**
 * Raises unless the specification is a closed, non-executable object for the
 * reviewed classification.
 *
 * Executable-shaped keys are refused outright. V1 records approved system
 * SPECIFICATION; a key named code, sql, query, expression, script, command,
 * runtime, deploy or executable would mean something was smuggled in that the
 * chain promises does not exist.
 */
CREATE OR REPLACE FUNCTION "public"."assert_workflow_reviewed_specification"(
  "p_step_id" "text",
  "p_disposition" "text",
  "p_reviewed_classification" "text",
  "p_specification" "jsonb"
)
RETURNS "void"
LANGUAGE "plpgsql"
IMMUTABLE
SET search_path = public, pg_temp
AS $$
DECLARE
  v_required text[];
  v_allowed text[];
  v_keys text[];
  v_forbidden text[] := ARRAY['code','sql','query','expression','script',
                              'command','runtime','deploy','executable'];
  v_offending text;
BEGIN
  -- Rejected steps record no specification at all.
  IF "p_disposition" = 'rejected' THEN
    IF "p_specification" IS NOT NULL AND jsonb_typeof("p_specification") <> 'null' THEN
      RAISE EXCEPTION 'step % rejected but carries a reviewed specification', "p_step_id"
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
    RETURN;
  END IF;

  -- Accepted-as-proposed derives its effective specification from the original
  -- proposal, so it stores none of its own.
  IF "p_disposition" = 'accepted' THEN
    RETURN;
  END IF;

  -- Everything below is modified or reclassified, which must record one.
  IF "p_specification" IS NULL OR jsonb_typeof("p_specification") <> 'object' THEN
    RAISE EXCEPTION 'step % (%) requires a reviewed specification object',
      "p_step_id", "p_disposition"
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT k.required_keys, k.allowed_keys INTO v_required, v_allowed
  FROM public.workflow_reviewed_specification_keys("p_reviewed_classification") AS k;

  IF v_allowed IS NULL THEN
    RAISE EXCEPTION 'step % has an unknown reviewed classification %',
      "p_step_id", "p_reviewed_classification"
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT array_agg(key) INTO v_keys
  FROM jsonb_object_keys("p_specification") AS key;
  v_keys := COALESCE(v_keys, ARRAY[]::text[]);

  -- Executable-shaped keys, checked case-insensitively.
  SELECT key INTO v_offending
  FROM unnest(v_keys) AS key
  WHERE lower(key) = ANY (v_forbidden)
  LIMIT 1;
  IF v_offending IS NOT NULL THEN
    RAISE EXCEPTION 'step % specification carries an executable-shaped key %',
      "p_step_id", v_offending
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Closed key set: nothing outside the contract for this classification.
  SELECT key INTO v_offending
  FROM unnest(v_keys) AS key
  WHERE NOT (key = ANY (v_allowed))
  LIMIT 1;
  IF v_offending IS NOT NULL THEN
    RAISE EXCEPTION 'step % specification has key % which % does not define',
      "p_step_id", v_offending, "p_reviewed_classification"
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Every required key present.
  SELECT key INTO v_offending
  FROM unnest(v_required) AS key
  WHERE NOT (key = ANY (v_keys))
  LIMIT 1;
  IF v_offending IS NOT NULL THEN
    RAISE EXCEPTION 'step % specification is missing required key % for %',
      "p_step_id", v_offending, "p_reviewed_classification"
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
END;
$$;

ALTER FUNCTION "public"."assert_workflow_reviewed_specification"(
  "text", "text", "text", "jsonb") OWNER TO "postgres";

REVOKE ALL ON FUNCTION "public"."workflow_reviewed_specification_keys"("text")
  FROM PUBLIC, "anon", "authenticated";
REVOKE ALL ON FUNCTION "public"."assert_workflow_reviewed_specification"(
  "text", "text", "text", "jsonb") FROM PUBLIC, "anon", "authenticated";
