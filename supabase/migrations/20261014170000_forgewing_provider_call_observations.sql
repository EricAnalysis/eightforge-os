-- Forgewing S7: durable, content-free telemetry for production provider calls.
--
-- Until now token usage, latency and the provider's own request id were
-- captured only by evaluation harnesses. This append-only ledger records one
-- row per production provider call so cost, latency and failure can be read
-- from the database instead of from logs.
--
-- It holds identity and measurements only: never a prompt, an answer, an
-- excerpt, a question, a rationale or any customer text. It grants nothing,
-- gates nothing and is read by no truth, Validator or pricing path.
-- Writes come only from the trusted server (service_role), through a direct
-- INSERT like the other Forgewing ledgers; rows are immutable.

CREATE TABLE public.forgewing_provider_call_observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow text NOT NULL CHECK (workflow IN (
    'project_ask', 'workflow_assessment', 'case_investigation', 'priced_value_reading',
    'repository_plan_guidance', 'region_classification', 'table_continuation', 'column_mapping',
    'observation_arbitration', 'pricing_interpretation', 'recovery_candidate_v2')),
  organization_id uuid REFERENCES public.organizations(id) ON DELETE RESTRICT,
  -- The durable budget slot this call spent, when the workflow has one.
  reservation_id uuid REFERENCES public.forgewing_provider_call_reservations(id) ON DELETE RESTRICT,
  request_digest_sha256 text CHECK (request_digest_sha256 ~ '^[0-9a-f]{64}$'),
  model text NOT NULL CHECK (length(btrim(model)) BETWEEN 1 AND 200),
  returned_model text CHECK (returned_model IS NULL OR length(returned_model) BETWEEN 1 AND 200),
  provider_request_id text CHECK (provider_request_id IS NULL OR length(provider_request_id) BETWEEN 1 AND 200),
  outcome text NOT NULL CHECK (outcome IN (
    'succeeded', 'provider_failed', 'provider_timeout', 'output_truncated', 'output_invalid')),
  stop_reason text CHECK (stop_reason IS NULL OR length(stop_reason) BETWEEN 1 AND 64),
  input_tokens integer CHECK (input_tokens IS NULL OR input_tokens >= 0),
  output_tokens integer CHECK (output_tokens IS NULL OR output_tokens >= 0),
  latency_ms integer NOT NULL CHECK (latency_ms >= 0),
  observed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX forgewing_provider_call_observations_org_time_idx
  ON public.forgewing_provider_call_observations (organization_id, workflow, observed_at DESC);

CREATE FUNCTION public.reject_forgewing_provider_call_observation_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  RAISE EXCEPTION 'Forgewing provider call observations are append-only'
    USING ERRCODE = '42501';
END $$;

CREATE TRIGGER forgewing_provider_call_observations_immutable
  BEFORE UPDATE OR DELETE ON public.forgewing_provider_call_observations
  FOR EACH ROW EXECUTE FUNCTION public.reject_forgewing_provider_call_observation_mutation();

ALTER TABLE public.forgewing_provider_call_observations ENABLE ROW LEVEL SECURITY;

-- Server-side only. The browser never reads or writes provider telemetry.
REVOKE ALL ON TABLE public.forgewing_provider_call_observations
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT ON TABLE public.forgewing_provider_call_observations TO service_role;

REVOKE ALL ON FUNCTION public.reject_forgewing_provider_call_observation_mutation()
  FROM PUBLIC, anon, authenticated, service_role;
