-- Project intelligence: durable, content-free records.
--
-- Until now one guidance answer left only a structured log line, and a product
-- signal was computed on request and thrown away. This adds three append-only
-- tables:
--
--   project_intelligence_guidance_events: one row per guidance answer, with closed
--     vocabularies, counts and measurements.
--   project_intelligence_signals: one row per distinct product signal, internal and
--     non-authoritative.
--   project_intelligence_signal_reviews: a person's disposition of a signal, versioned.
--     Reviewing routes nothing and executes nothing. A signal reaches the existing
--     improvement path only if a person takes it there.
--
-- Nothing here holds a question, an answer, an excerpt, a title, model prose or any
-- customer text. Record references are UUIDs or SHA-256 digests. No truth, Validator,
-- pricing or configuration path reads these tables, and they grant and gate nothing.
--
-- Tenancy: RLS is on with no policies and only service_role may read or insert. A row
-- can name a project only inside its own organization, enforced below. project_id has
-- no foreign key on purpose: a key would block project deletion, because these rows
-- cannot be deleted. The rows then stay as content-free history.
--
-- Compatibility: purely additive, and no existing table or function changes. Writers
-- are best effort, so code running before this applies only logs a warning.
--
-- Rollback: revert the code first, then drop the three tables and the two functions.
-- That discards the history, which nothing depends on.

CREATE TABLE public.project_intelligence_guidance_events (
  -- The request's identity, minted by the server for this answer.
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  project_id uuid NOT NULL,
  intent text NOT NULL CHECK (intent IN ('whats_missing', 'need_document', 'why_flagged', 'what_to_do')),
  intent_basis text NOT NULL CHECK (intent_basis IN ('operator_phrase', 'ask_classifier', 'focus_finding')),
  -- The deterministic reading and recommendation behind the answer.
  evidence_state text NOT NULL CHECK (evidence_state IN (
    'source_missing', 'source_present', 'source_present_unread', 'source_present_relationship_unresolved',
    'likely_system_issue', 'not_a_source_gap', 'evidence_unavailable', 'no_open_findings', 'validation_not_run')),
  next_step text NOT NULL CHECK (next_step IN (
    'no_action_needed', 'review_existing_document', 'link_existing_document', 'upload_or_request_document',
    'correct_source_data', 'review_ticket_or_transaction', 'operator_judgment_required', 'likely_system_issue')),
  confidence text NOT NULL CHECK (confidence IN ('high', 'medium', 'low')),
  -- What the plan asked for, what was read and what left EightForge, by section kind.
  sections_planned text[] NOT NULL CHECK (sections_planned <@ ARRAY[
    'project_identity', 'validator_findings', 'documents', 'document_relationships', 'canonical_facts',
    'reviewed_truth', 'operator_decisions', 'transaction_context']::text[]),
  sections_read text[] NOT NULL CHECK (sections_read <@ sections_planned),
  sections_transmitted text[] NOT NULL CHECK (sections_transmitted <@ sections_read),
  sections_not_available text[] NOT NULL CHECK (sections_not_available <@ sections_planned),
  sections_read_failed text[] NOT NULL CHECK (sections_read_failed <@ sections_planned),
  sections_not_approved text[] NOT NULL CHECK (sections_not_approved <@ sections_planned),
  sections_over_budget text[] NOT NULL CHECK (sections_over_budget <@ sections_planned),
  record_count integer NOT NULL CHECK (record_count >= 0),
  citation_count integer NOT NULL CHECK (citation_count >= 0),
  -- Whether a model was tried, and what became of it.
  provider_status text NOT NULL CHECK (provider_status IN (
    'not_attempted', 'switch_off', 'gate_closed', 'not_configured', 'model_unqualified', 'budget_exhausted',
    'reservation_failed', 'provider_failed', 'rejected', 'accepted')),
  model_attempted boolean NOT NULL,
  answer_source text NOT NULL CHECK (answer_source IN ('deterministic', 'model_accepted', 'deterministic_fallback')),
  validation_failure_code text CHECK (validation_failure_code IN (
    'truncated', 'refused', 'output_not_json', 'output_schema', 'next_step_not_offered', 'citation_unresolved',
    'unsupported_number', 'internal_vocabulary', 'authority_claim')),
  -- Measurements, only when a provider answered. Cost is tokens at the price of the day.
  model text CHECK (model IS NULL OR length(btrim(model)) BETWEEN 1 AND 200),
  input_tokens integer CHECK (input_tokens IS NULL OR input_tokens >= 0),
  output_tokens integer CHECK (output_tokens IS NULL OR output_tokens >= 0),
  latency_ms integer CHECK (latency_ms IS NULL OR latency_ms >= 0),
  stop_reason text CHECK (stop_reason IS NULL OR length(stop_reason) BETWEEN 1 AND 64),
  -- Identity of what ran.
  request_contract text CHECK (request_contract IS NULL OR request_contract ~ '^[a-z0-9_]{1,80}$'),
  request_digest_sha256 text CHECK (request_digest_sha256 ~ '^[0-9a-f]{64}$'),
  reservation_id uuid REFERENCES public.forgewing_provider_call_reservations(id) ON DELETE RESTRICT,
  context_read_digest_sha256 text NOT NULL CHECK (context_read_digest_sha256 ~ '^[0-9a-f]{64}$'),
  runtime_commit text CHECK (runtime_commit ~ '^[0-9a-f]{7,64}$'),
  signal_categories text[] NOT NULL CHECK (signal_categories <@ ARRAY[
    'extraction', 'relationship_precedence', 'missing_source', 'validator_logic', 'mapping_configuration',
    'project_data_quality', 'unresolved_other']::text[]),
  signal_codes text[] NOT NULL CHECK (signal_codes <@ ARRAY[
    'source_absent_from_project', 'source_present_not_read', 'source_present_relationship_may_block_validator',
    'source_present_linked_still_flagged', 'billing_code_not_mapped_to_schedule', 'source_data_needs_correction',
    'finding_without_catalogue_explanation']::text[]),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT project_intelligence_guidance_events_attempted_check
    CHECK (model_attempted = (provider_status IN ('provider_failed', 'rejected', 'accepted'))),
  CONSTRAINT project_intelligence_guidance_events_source_check
    CHECK ((answer_source = 'model_accepted') = (provider_status = 'accepted')
      AND (answer_source = 'deterministic_fallback') = (provider_status IN ('provider_failed', 'rejected'))),
  CONSTRAINT project_intelligence_guidance_events_failure_check
    CHECK ((validation_failure_code IS NOT NULL) = (provider_status = 'rejected'))
);

CREATE INDEX project_intelligence_guidance_events_org_time_idx
  ON public.project_intelligence_guidance_events (organization_id, recorded_at DESC);
CREATE INDEX project_intelligence_guidance_events_project_time_idx
  ON public.project_intelligence_guidance_events (project_id, recorded_at DESC);

CREATE TABLE public.project_intelligence_signals (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  project_id uuid NOT NULL,
  schema_version text NOT NULL CHECK (schema_version = 'product_improvement_signal_v1'),
  -- Pinned here too: no row can claim authority or skip review.
  authority text NOT NULL CHECK (authority = 'non_authoritative'),
  review_required boolean NOT NULL CHECK (review_required),
  category text NOT NULL CHECK (category IN (
    'extraction', 'relationship_precedence', 'missing_source', 'validator_logic', 'mapping_configuration',
    'project_data_quality', 'unresolved_other')),
  signal_code text NOT NULL CHECK (signal_code IN (
    'source_absent_from_project', 'source_present_not_read', 'source_present_relationship_may_block_validator',
    'source_present_linked_still_flagged', 'billing_code_not_mapped_to_schedule', 'source_data_needs_correction',
    'finding_without_catalogue_explanation')),
  orchestrator_root_cause text CHECK (orchestrator_root_cause IN (
    'extraction_issue', 'relationship_governance_issue', 'validation_rule_issue', 'mapping_issue')),
  rule_id text NOT NULL CHECK (rule_id ~ '^[A-Za-z0-9_]{1,160}$'),
  evidence_state text NOT NULL CHECK (evidence_state IN (
    'source_missing', 'source_present', 'source_present_unread', 'source_present_relationship_unresolved',
    'likely_system_issue', 'not_a_source_gap', 'evidence_unavailable')),
  source_intent text NOT NULL CHECK (source_intent IN ('whats_missing', 'need_document', 'why_flagged', 'what_to_do')),
  finding_ref text NOT NULL CHECK (finding_ref ~ '^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|sha256:[0-9a-f]{64})$'),
  -- A UUID, or the digest of anything else, and never free text.
  record_refs text[] NOT NULL CHECK (
    cardinality(record_refs) <= 10
    AND (cardinality(record_refs) = 0 OR array_to_string(record_refs, ',') ~
      '^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|sha256:[0-9a-f]{64})(,([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|sha256:[0-9a-f]{64}))*$')),
  signal_digest_sha256 text NOT NULL CHECK (signal_digest_sha256 ~ '^[0-9a-f]{64}$'),
  -- The answer that first observed it, if that answer's own record was written.
  guidance_event_id uuid REFERENCES public.project_intelligence_guidance_events(id) ON DELETE RESTRICT,
  first_observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  -- The same observation repeats as one row, however many people ask.
  CONSTRAINT project_intelligence_signals_observation_unique
    UNIQUE (organization_id, project_id, signal_digest_sha256),
  CONSTRAINT project_intelligence_signals_id_org_unique UNIQUE (id, organization_id)
);

CREATE INDEX project_intelligence_signals_project_time_idx
  ON public.project_intelligence_signals (organization_id, project_id, first_observed_at DESC);

CREATE TABLE public.project_intelligence_signal_reviews (
  id uuid PRIMARY KEY,
  signal_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  review_version integer NOT NULL CHECK (review_version >= 1),
  disposition text NOT NULL CHECK (disposition IN ('accepted_for_triage', 'rejected', 'deferred')),
  reviewer_actor_id uuid NOT NULL REFERENCES public.user_profiles(id) ON DELETE RESTRICT,
  reviewed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT project_intelligence_signal_reviews_signal_fkey
    FOREIGN KEY (signal_id, organization_id)
    REFERENCES public.project_intelligence_signals(id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT project_intelligence_signal_reviews_version_unique UNIQUE (signal_id, review_version)
);

CREATE FUNCTION public.reject_project_intelligence_record_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  RAISE EXCEPTION 'Project intelligence records are append-only'
    USING ERRCODE = '42501';
END $$;

CREATE TRIGGER project_intelligence_guidance_events_immutable
  BEFORE UPDATE OR DELETE ON public.project_intelligence_guidance_events
  FOR EACH ROW EXECUTE FUNCTION public.reject_project_intelligence_record_mutation();
CREATE TRIGGER project_intelligence_signals_immutable
  BEFORE UPDATE OR DELETE ON public.project_intelligence_signals
  FOR EACH ROW EXECUTE FUNCTION public.reject_project_intelligence_record_mutation();
CREATE TRIGGER project_intelligence_signal_reviews_immutable
  BEFORE UPDATE OR DELETE ON public.project_intelligence_signal_reviews
  FOR EACH ROW EXECUTE FUNCTION public.reject_project_intelligence_record_mutation();

CREATE FUNCTION public.assert_project_intelligence_record_scope()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.projects AS project
    WHERE project.id = NEW.project_id AND project.organization_id = NEW.organization_id
  ) THEN
    RAISE EXCEPTION 'Project intelligence record names a project outside its organization'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER project_intelligence_guidance_events_scope
  BEFORE INSERT ON public.project_intelligence_guidance_events
  FOR EACH ROW EXECUTE FUNCTION public.assert_project_intelligence_record_scope();
CREATE TRIGGER project_intelligence_signals_scope
  BEFORE INSERT ON public.project_intelligence_signals
  FOR EACH ROW EXECUTE FUNCTION public.assert_project_intelligence_record_scope();

ALTER TABLE public.project_intelligence_guidance_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_intelligence_signals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_intelligence_signal_reviews ENABLE ROW LEVEL SECURITY;

-- Server-side only. The browser never reads or writes these.
REVOKE ALL ON TABLE public.project_intelligence_guidance_events
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT ON TABLE public.project_intelligence_guidance_events TO service_role;
REVOKE ALL ON TABLE public.project_intelligence_signals
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT ON TABLE public.project_intelligence_signals TO service_role;
REVOKE ALL ON TABLE public.project_intelligence_signal_reviews
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT ON TABLE public.project_intelligence_signal_reviews TO service_role;

REVOKE ALL ON FUNCTION public.reject_project_intelligence_record_mutation()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.assert_project_intelligence_record_scope()
  FROM PUBLIC, anon, authenticated, service_role;
