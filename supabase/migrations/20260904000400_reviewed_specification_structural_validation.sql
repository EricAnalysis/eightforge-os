-- ============================================================================
-- Structural validation for reviewed specifications
--
-- The previous version checked only which top-level keys existed. That left
-- three gaps at the final persistence authority:
--
--   * a scalar or array acceptedSpecification normalized quietly to NULL
--     instead of being rejected;
--   * field values could be any JSON type, so requiredFacts could be a number
--     and plainLanguageRule could be an object;
--   * executable-shaped keys were refused only at the top level, so nesting one
--     inside an object or an array walked straight through.
--
-- This closes all three, and deliberately stops there. SQL enforces STRUCTURE:
-- shape, type, and the absence of executable-shaped keys anywhere in the tree.
-- It does not judge whether a rule reads sensibly or whether a human-control
-- rationale is adequate -- that is TypeScript and operator territory, and
-- encoding it here would be a second semantic engine that drifts from the
-- first.
-- ============================================================================

/**
 * True when an executable-shaped key appears anywhere in the JSON tree.
 *
 * Recursive because nesting is the obvious way around a top-level check:
 * {"expectedOutcome": {"sql": "..."}} passed the previous version untouched.
 */
CREATE OR REPLACE FUNCTION "public"."workflow_specification_has_executable_key"(
  "p_value" "jsonb"
)
RETURNS boolean
LANGUAGE "plpgsql"
IMMUTABLE
SET search_path = public, pg_temp
AS $$
DECLARE
  v_forbidden text[] := ARRAY['code','sql','query','expression','script',
                              'command','runtime','deploy','executable'];
  v_key text;
  v_child jsonb;
BEGIN
  IF "p_value" IS NULL THEN RETURN false; END IF;

  IF jsonb_typeof("p_value") = 'object' THEN
    FOR v_key IN SELECT jsonb_object_keys("p_value") LOOP
      IF lower(v_key) = ANY (v_forbidden) THEN RETURN true; END IF;
      IF public.workflow_specification_has_executable_key("p_value" -> v_key) THEN
        RETURN true;
      END IF;
    END LOOP;
    RETURN false;
  END IF;

  IF jsonb_typeof("p_value") = 'array' THEN
    FOR v_child IN SELECT jsonb_array_elements("p_value") LOOP
      IF public.workflow_specification_has_executable_key(v_child) THEN
        RETURN true;
      END IF;
    END LOOP;
    RETURN false;
  END IF;

  RETURN false;
END;
$$;

ALTER FUNCTION "public"."workflow_specification_has_executable_key"("jsonb")
  OWNER TO "postgres";

-- The JSON type each field must hold. Structure only: "string" says the value
-- is text, never what the text should say.
CREATE OR REPLACE FUNCTION "public"."workflow_reviewed_specification_field_type"(
  "p_field" "text"
)
RETURNS "text"
LANGUAGE "sql"
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT CASE "p_field"
    WHEN 'plainLanguageRule' THEN 'string'
    WHEN 'conditionType' THEN 'string'
    WHEN 'expectedOutcome' THEN 'string'
    WHEN 'describedFact' THEN 'string'
    WHEN 'sourceDocument' THEN 'string'
    WHEN 'description' THEN 'string'
    WHEN 'deterministicShortfall' THEN 'string'
    WHEN 'whyHumanControlled' THEN 'string'
    WHEN 'deterministicExtractionPlausible' THEN 'boolean'
    WHEN 'requiredFacts' THEN 'string_array'
    WHEN 'expectedEvidence' THEN 'string_array'
    WHEN 'userDescribedExceptions' THEN 'string_array'
    WHEN 'unresolvedAssumptions' THEN 'string_array'
    ELSE NULL
  END;
$$;

ALTER FUNCTION "public"."workflow_reviewed_specification_field_type"("text")
  OWNER TO "postgres";

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
  v_offending text;
  v_key text;
  v_expected text;
  v_actual text;
BEGIN
  IF "p_disposition" = 'rejected' THEN
    IF "p_specification" IS NOT NULL AND jsonb_typeof("p_specification") <> 'null' THEN
      RAISE EXCEPTION 'step % rejected but carries a reviewed specification', "p_step_id"
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
    RETURN;
  END IF;

  IF "p_disposition" = 'accepted' THEN
    RETURN;
  END IF;

  -- Explicitly an object. A scalar or array must fail rather than normalize to
  -- NULL, which is how a malformed specification previously became "no
  -- specification" and slipped past the required-field checks entirely.
  IF "p_specification" IS NULL OR jsonb_typeof("p_specification") <> 'object' THEN
    RAISE EXCEPTION 'step % (%) requires a reviewed specification object, got %',
      "p_step_id", "p_disposition",
      COALESCE(jsonb_typeof("p_specification"), 'null')
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF public.workflow_specification_has_executable_key("p_specification") THEN
    RAISE EXCEPTION 'step % specification carries an executable-shaped key', "p_step_id"
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT k.required_keys, k.allowed_keys INTO v_required, v_allowed
  FROM public.workflow_reviewed_specification_keys("p_reviewed_classification") AS k;

  IF v_allowed IS NULL THEN
    RAISE EXCEPTION 'step % has an unknown reviewed classification %',
      "p_step_id", "p_reviewed_classification"
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT array_agg(key) INTO v_keys FROM jsonb_object_keys("p_specification") AS key;
  v_keys := COALESCE(v_keys, ARRAY[]::text[]);

  SELECT key INTO v_offending FROM unnest(v_keys) AS key
  WHERE NOT (key = ANY (v_allowed)) LIMIT 1;
  IF v_offending IS NOT NULL THEN
    RAISE EXCEPTION 'step % specification has key % which % does not define',
      "p_step_id", v_offending, "p_reviewed_classification"
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT key INTO v_offending FROM unnest(v_required) AS key
  WHERE NOT (key = ANY (v_keys)) LIMIT 1;
  IF v_offending IS NOT NULL THEN
    RAISE EXCEPTION 'step % specification is missing required key % for %',
      "p_step_id", v_offending, "p_reviewed_classification"
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Value shapes. Null is refused everywhere: TypeScript requires each declared
  -- field to hold a value, so a null would persist a field that reads as
  -- present but says nothing.
  FOREACH v_key IN ARRAY v_keys LOOP
    v_expected := public.workflow_reviewed_specification_field_type(v_key);
    v_actual := jsonb_typeof("p_specification" -> v_key);

    IF v_actual = 'null' THEN
      RAISE EXCEPTION 'step % specification field % is null', "p_step_id", v_key
        USING ERRCODE = 'invalid_parameter_value';
    END IF;

    IF v_expected = 'string_array' THEN
      IF v_actual <> 'array' THEN
        RAISE EXCEPTION 'step % specification field % must be an array, got %',
          "p_step_id", v_key, v_actual
          USING ERRCODE = 'invalid_parameter_value';
      END IF;
      -- Every element a string: a nested object inside a string array is the
      -- other obvious way to smuggle structure past a top-level type check.
      IF EXISTS (
        SELECT 1 FROM jsonb_array_elements("p_specification" -> v_key) AS element
        WHERE jsonb_typeof(element) <> 'string'
      ) THEN
        RAISE EXCEPTION 'step % specification field % must contain only strings',
          "p_step_id", v_key
          USING ERRCODE = 'invalid_parameter_value';
      END IF;
    ELSIF v_expected IS NOT NULL AND v_actual <> v_expected THEN
      RAISE EXCEPTION 'step % specification field % must be %, got %',
        "p_step_id", v_key, v_expected, v_actual
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
  END LOOP;
END;
$$;

ALTER FUNCTION "public"."assert_workflow_reviewed_specification"(
  "text", "text", "text", "jsonb") OWNER TO "postgres";

REVOKE ALL ON FUNCTION "public"."workflow_specification_has_executable_key"("jsonb")
  FROM PUBLIC, "anon", "authenticated";
REVOKE ALL ON FUNCTION "public"."workflow_reviewed_specification_field_type"("text")
  FROM PUBLIC, "anon", "authenticated";
REVOKE ALL ON FUNCTION "public"."assert_workflow_reviewed_specification"(
  "text", "text", "text", "jsonb") FROM PUBLIC, "anon", "authenticated";
