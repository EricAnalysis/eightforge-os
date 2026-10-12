-- ============================================================================
-- Triaged improvement signal as a Plan V2 source (B8.3d)
--
-- Generalizes the reviewed-specification input of the existing repository-plan
-- path in place. A Plan V2 job and run now have exactly one source:
--   reviewed_workflow_assessment : assessment_id/version + review_id/version
--   triaged_improvement_signal   : triage_review_id/version
-- Everything downstream (engineering review, approved request, Linear
-- projection) pins only to the Plan V2 run and is unchanged. Existing
-- assessment-sourced jobs and runs keep their columns and remain valid.
--
-- The Plan V2 classification of a signal is a human triage decision
-- (plan_classification), required exactly when the disposition is
-- route_to_engineering. It is never derived from the signal kind or from the
-- signal's root-cause category. The triage itself is not the approved
-- engineering item: it is only the planning pin.
--
-- The signal source read for the worker returns the allowlisted submission
-- payload and the triage classification only. It never returns the triage
-- rationale or the reviewer, so neither can reach the provider.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Human-selected Plan V2 classification on triage.
--    The table is append-only and empty in production when this ships, so the
--    invariant is enforced for every row from the start.
-- ----------------------------------------------------------------------------
ALTER TABLE public.improvement_signal_triage_reviews
  ADD COLUMN IF NOT EXISTS plan_classification text;

DO $b83d_triage_plan_classification$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.improvement_signal_triage_reviews'::regclass
      AND conname = 'improvement_signal_triage_reviews_plan_classification_check'
  ) THEN
    ALTER TABLE ONLY public.improvement_signal_triage_reviews
      ADD CONSTRAINT improvement_signal_triage_reviews_plan_classification_check
      CHECK (plan_classification IS NULL OR plan_classification IN ('RULE','VERIFY','EXTRACT','RECOVER','HUMAN','ADVISORY'));
  END IF;
  -- Routed to engineering <=> a human chose the Plan V2 classification.
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.improvement_signal_triage_reviews'::regclass
      AND conname = 'improvement_signal_triage_reviews_plan_classification_required_check'
  ) THEN
    ALTER TABLE ONLY public.improvement_signal_triage_reviews
      ADD CONSTRAINT improvement_signal_triage_reviews_plan_classification_required_check
      CHECK ((plan_classification IS NOT NULL) = (disposition = 'route_to_engineering'));
  END IF;
  -- Lets a planning pin reference the exact triage version.
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.improvement_signal_triage_reviews'::regclass
      AND conname = 'improvement_signal_triage_reviews_id_version_unique'
  ) THEN
    ALTER TABLE ONLY public.improvement_signal_triage_reviews
      ADD CONSTRAINT improvement_signal_triage_reviews_id_version_unique UNIQUE (id, triage_version);
  END IF;
END
$b83d_triage_plan_classification$;

-- ----------------------------------------------------------------------------
-- 2. Source kind on Plan V2 runs and generation jobs: assessment XOR triage.
-- ----------------------------------------------------------------------------
ALTER TABLE public.workflow_repository_plan_v2_runs
  ALTER COLUMN assessment_id DROP NOT NULL,
  ALTER COLUMN assessment_version DROP NOT NULL,
  ALTER COLUMN review_id DROP NOT NULL,
  ALTER COLUMN review_version DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS triage_review_id uuid,
  ADD COLUMN IF NOT EXISTS triage_version integer;

ALTER TABLE public.workflow_repository_plan_generation_jobs
  ALTER COLUMN assessment_id DROP NOT NULL,
  ALTER COLUMN assessment_version DROP NOT NULL,
  ALTER COLUMN review_id DROP NOT NULL,
  ALTER COLUMN review_version DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS triage_review_id uuid,
  ADD COLUMN IF NOT EXISTS triage_version integer;

DO $b83d_plan_source_kind$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.workflow_repository_plan_v2_runs'::regclass AND conname = 'workflow_repository_plan_v2_source_kind_check'
  ) THEN
    ALTER TABLE ONLY public.workflow_repository_plan_v2_runs
      ADD CONSTRAINT workflow_repository_plan_v2_source_kind_check CHECK (
        (assessment_id IS NOT NULL AND assessment_version IS NOT NULL
          AND review_id IS NOT NULL AND review_version IS NOT NULL
          AND triage_review_id IS NULL AND triage_version IS NULL)
        OR (assessment_id IS NULL AND assessment_version IS NULL
          AND review_id IS NULL AND review_version IS NULL
          AND triage_review_id IS NOT NULL AND triage_version IS NOT NULL)
      );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.workflow_repository_plan_v2_runs'::regclass AND conname = 'workflow_repository_plan_v2_triage_fkey'
  ) THEN
    ALTER TABLE ONLY public.workflow_repository_plan_v2_runs
      ADD CONSTRAINT workflow_repository_plan_v2_triage_fkey
      FOREIGN KEY (triage_review_id, triage_version)
      REFERENCES public.improvement_signal_triage_reviews (id, triage_version) ON DELETE RESTRICT;
  END IF;
  -- A run's triage columns are exactly the pin inside its immutable plan JSON;
  -- an assessment run's pin never names a source kind.
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.workflow_repository_plan_v2_runs'::regclass
      AND conname = 'workflow_repository_plan_v2_triage_pin_binding_check'
  ) THEN
    ALTER TABLE ONLY public.workflow_repository_plan_v2_runs
      ADD CONSTRAINT workflow_repository_plan_v2_triage_pin_binding_check CHECK (
        (triage_review_id IS NOT NULL)
          = coalesce((plan_v2_canonical_json::jsonb #> '{source,reviewPin}') ? 'sourceKind', false)
        AND (triage_review_id IS NULL OR (
          plan_v2_canonical_json::jsonb #>> '{source,reviewPin,sourceKind}'
            IS NOT DISTINCT FROM 'triaged_improvement_signal'
          AND plan_v2_canonical_json::jsonb #>> '{source,reviewPin,triageReviewId}'
            IS NOT DISTINCT FROM triage_review_id::text
          AND plan_v2_canonical_json::jsonb #>> '{source,reviewPin,triageVersion}'
            IS NOT DISTINCT FROM triage_version::text))
      );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.workflow_repository_plan_generation_jobs'::regclass AND conname = 'workflow_repository_plan_generation_jobs_source_kind_check'
  ) THEN
    ALTER TABLE ONLY public.workflow_repository_plan_generation_jobs
      ADD CONSTRAINT workflow_repository_plan_generation_jobs_source_kind_check CHECK (
        (assessment_id IS NOT NULL AND assessment_version IS NOT NULL
          AND review_id IS NOT NULL AND review_version IS NOT NULL
          AND triage_review_id IS NULL AND triage_version IS NULL)
        OR (assessment_id IS NULL AND assessment_version IS NULL
          AND review_id IS NULL AND review_version IS NULL
          AND triage_review_id IS NOT NULL AND triage_version IS NOT NULL)
      );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.workflow_repository_plan_generation_jobs'::regclass AND conname = 'workflow_repository_plan_generation_jobs_triage_fkey'
  ) THEN
    ALTER TABLE ONLY public.workflow_repository_plan_generation_jobs
      ADD CONSTRAINT workflow_repository_plan_generation_jobs_triage_fkey
      FOREIGN KEY (triage_review_id, triage_version)
      REFERENCES public.improvement_signal_triage_reviews (id, triage_version) ON DELETE RESTRICT;
  END IF;
END
$b83d_plan_source_kind$;

-- ----------------------------------------------------------------------------
-- 3. Job identity guard: NULL-safe, and covering the triage pin.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.guard_workflow_repository_plan_generation_job_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'repository plan generation jobs are not deletable';
  END IF;
  IF NEW.id <> OLD.id
    OR NEW.assessment_id IS DISTINCT FROM OLD.assessment_id
    OR NEW.assessment_version IS DISTINCT FROM OLD.assessment_version
    OR NEW.review_id IS DISTINCT FROM OLD.review_id
    OR NEW.review_version IS DISTINCT FROM OLD.review_version
    OR NEW.triage_review_id IS DISTINCT FROM OLD.triage_review_id
    OR NEW.triage_version IS DISTINCT FROM OLD.triage_version
    OR NEW.classification <> OLD.classification
    OR NEW.requested_by_actor_id <> OLD.requested_by_actor_id
    OR NEW.implementation_plan_v1_digest_sha256 <> OLD.implementation_plan_v1_digest_sha256
    OR NEW.authority <> OLD.authority OR NEW.purpose <> OLD.purpose
    OR NEW.requires_human_review <> OLD.requires_human_review
    OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'repository plan generation job identity is immutable';
  END IF;
  IF OLD.status IN ('succeeded','failed') THEN
    RAISE EXCEPTION 'repository plan generation job is terminal';
  END IF;
  IF OLD.status = 'pending' AND NEW.status <> 'claimed' THEN
    RAISE EXCEPTION 'invalid repository plan generation job transition';
  END IF;
  IF OLD.status = 'claimed' AND NEW.status = 'pending' THEN
    RAISE EXCEPTION 'repository plan generation jobs cannot reset to pending';
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;

-- ----------------------------------------------------------------------------
-- 4. Plan V2 writer: a triaged-signal pin must match a routed triage row whose
--    human classification equals the plan's classification. The assessment
--    path is unchanged.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.record_workflow_repository_plan_v2_run(
  p_raw_artifact_canonical_json text,
  p_raw_envelope_canonical_json text,
  p_plan_v2_canonical_json text,
  p_plan_v2_envelope_canonical_json text
)
RETURNS TABLE (plan_v2_run_id uuid, raw_evidence_id uuid, inserted boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_plan jsonb;
  v_plan_envelope jsonb;
  v_raw jsonb;
  v_raw_envelope jsonb;
  v_plan_digest text;
  v_raw_digest text;
  v_raw_id uuid;
  v_existing public.workflow_repository_plan_v2_runs%ROWTYPE;
  v_existing_raw text;
  v_pin jsonb;
  v_triage public.improvement_signal_triage_reviews%ROWTYPE;
BEGIN
  IF p_plan_v2_canonical_json IS NULL OR p_plan_v2_envelope_canonical_json IS NULL THEN
    RAISE EXCEPTION 'validated Plan V2 canonical bytes are required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  BEGIN
    v_plan := p_plan_v2_canonical_json::jsonb;
    v_plan_envelope := p_plan_v2_envelope_canonical_json::jsonb;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'invalid Plan V2 JSON' USING ERRCODE = 'invalid_text_representation';
  END;
  IF v_plan - 'digest' IS DISTINCT FROM v_plan_envelope
    OR v_plan #>> '{domain}' IS DISTINCT FROM 'eightforge.repository-aware-implementation-plan'
    OR v_plan #>> '{schemaVersion}' IS DISTINCT FROM '2'
    OR v_plan #>> '{authority}' IS DISTINCT FROM 'non_authoritative'
    OR v_plan #>> '{executable}' IS DISTINCT FROM 'false'
    OR v_plan #>> '{grantsExecutionAuthority}' IS DISTINCT FROM 'false'
    OR v_plan #>> '{requiresHumanReview}' IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION 'Plan V2 authority or envelope mismatch' USING ERRCODE = 'check_violation';
  END IF;
  v_plan_digest := encode(extensions.digest(convert_to(p_plan_v2_envelope_canonical_json, 'UTF8'), 'sha256'), 'hex');
  IF v_plan #>> '{digest,value}' IS DISTINCT FROM v_plan_digest THEN
    RAISE EXCEPTION 'Plan V2 digest mismatch' USING ERRCODE = 'check_violation';
  END IF;

  IF p_raw_artifact_canonical_json IS NULL OR p_raw_envelope_canonical_json IS NULL THEN
    IF p_raw_artifact_canonical_json IS NOT NULL OR p_raw_envelope_canonical_json IS NOT NULL
      OR v_plan #>> '{providerProvenance,callCount}' IS DISTINCT FROM '0'
      OR v_plan #>> '{rawOutputSha256}' IS NOT NULL THEN
      RAISE EXCEPTION 'raw/provider call coherence mismatch' USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    BEGIN
      v_raw := p_raw_artifact_canonical_json::jsonb;
      v_raw_envelope := p_raw_envelope_canonical_json::jsonb;
    EXCEPTION WHEN others THEN
      RAISE EXCEPTION 'invalid raw artifact JSON' USING ERRCODE = 'invalid_text_representation';
    END;
    IF v_raw - 'digest' IS DISTINCT FROM v_raw_envelope
      OR v_raw #>> '{domain}' IS DISTINCT FROM 'eightforge.repository-plan-provider-evidence'
      OR v_raw #>> '{authority}' IS DISTINCT FROM 'non_authoritative'
      OR v_raw #>> '{trustedGuidance}' IS DISTINCT FROM 'false'
      OR v_raw #>> '{executable}' IS DISTINCT FROM 'false'
      OR v_raw #>> '{grantsExecutionAuthority}' IS DISTINCT FROM 'false'
      OR v_raw #>> '{requiresHumanReview}' IS DISTINCT FROM 'true'
      OR v_plan #>> '{providerProvenance,callCount}' IS DISTINCT FROM '1' THEN
      RAISE EXCEPTION 'raw evidence authority mismatch' USING ERRCODE = 'check_violation';
    END IF;
    v_raw_digest := encode(extensions.digest(convert_to(p_raw_envelope_canonical_json, 'UTF8'), 'sha256'), 'hex');
    IF v_raw #>> '{digest,value}' IS DISTINCT FROM v_raw_digest
      OR v_raw #>> '{rawOutputSha256}' IS DISTINCT FROM
        encode(extensions.digest(convert_to(v_raw #>> '{rawOutput}', 'UTF8'), 'sha256'), 'hex')
      OR v_raw #>> '{rawOutputSha256}' IS DISTINCT FROM v_plan #>> '{rawOutputSha256}'
      OR v_raw #>> '{sourceGuidanceInputDigestSha256}' IS DISTINCT FROM v_plan #>> '{source,guidanceInputDigestSha256}' THEN
      RAISE EXCEPTION 'raw evidence identity mismatch' USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF v_plan #>> '{providerProvenance,repositoryCommitSha}' IS DISTINCT FROM v_plan #>> '{source,repositorySnapshot,commitSha}'
    OR v_plan #>> '{providerProvenance,foundationDigestSha256}' IS DISTINCT FROM v_plan #>> '{source,foundationDigestSha256}'
    OR v_plan #>> '{providerProvenance,contentBundleDigestSha256}' IS DISTINCT FROM v_plan #>> '{source,contentBundleDigestSha256}'
    OR v_plan #>> '{providerProvenance,guidanceInputDigestSha256}' IS DISTINCT FROM v_plan #>> '{source,guidanceInputDigestSha256}'
    OR v_plan #>> '{guidance,sourceGuidanceInputDigestSha256}' IS DISTINCT FROM v_plan #>> '{source,guidanceInputDigestSha256}'
    OR v_plan #>> '{validatedOutputSha256}' IS DISTINCT FROM v_plan #>> '{guidance,digest,value}' THEN
    RAISE EXCEPTION 'Plan V2 source identity mismatch' USING ERRCODE = 'check_violation';
  END IF;

  -- B8.3d: a pin naming a source kind must be an exact, current-shape pin to a
  -- triage row that routed this signal to engineering under this classification.
  v_pin := v_plan #> '{source,reviewPin}';
  IF coalesce(v_pin ? 'sourceKind', false) THEN
    IF v_pin #>> '{sourceKind}' IS DISTINCT FROM 'triaged_improvement_signal'
      OR (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(v_pin)) <> 4
      OR coalesce(v_pin #>> '{submissionId}', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      OR coalesce(v_pin #>> '{triageReviewId}', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      OR pg_catalog.jsonb_typeof(v_pin -> 'triageVersion') IS DISTINCT FROM 'number'
      OR coalesce(v_pin #>> '{triageVersion}', '') !~ '^[1-9][0-9]{0,8}$' THEN
      RAISE EXCEPTION 'Plan V2 triaged signal pin invalid' USING ERRCODE = 'check_violation';
    END IF;
    SELECT * INTO v_triage FROM public.improvement_signal_triage_reviews AS triage
    WHERE triage.id = (v_pin #>> '{triageReviewId}')::uuid
      AND triage.triage_version = (v_pin #>> '{triageVersion}')::integer;
    IF v_triage.id IS NULL
      OR v_triage.submission_id IS DISTINCT FROM (v_pin #>> '{submissionId}')::uuid
      OR v_triage.disposition IS DISTINCT FROM 'route_to_engineering'
      OR v_triage.plan_classification IS DISTINCT FROM v_plan #>> '{guidance,classification}' THEN
      RAISE EXCEPTION 'Plan V2 triaged signal source mismatch' USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_plan_digest, 0));
  SELECT * INTO v_existing FROM public.workflow_repository_plan_v2_runs WHERE plan_v2_digest_sha256 = v_plan_digest;
  IF FOUND THEN
    IF v_existing.plan_v2_canonical_json IS DISTINCT FROM p_plan_v2_canonical_json
      OR v_existing.plan_v2_envelope_canonical_json IS DISTINCT FROM p_plan_v2_envelope_canonical_json THEN
      RAISE EXCEPTION 'Plan V2 idempotency conflict' USING ERRCODE = 'unique_violation';
    END IF;
    IF v_existing.raw_evidence_id IS NOT NULL THEN
      SELECT raw_artifact_canonical_json INTO v_existing_raw
      FROM public.workflow_repository_plan_raw_evidence WHERE id = v_existing.raw_evidence_id;
      IF v_existing_raw IS DISTINCT FROM p_raw_artifact_canonical_json THEN
        RAISE EXCEPTION 'raw evidence idempotency conflict' USING ERRCODE = 'unique_violation';
      END IF;
    ELSIF p_raw_artifact_canonical_json IS NOT NULL THEN
      RAISE EXCEPTION 'raw evidence idempotency conflict' USING ERRCODE = 'unique_violation';
    END IF;
    RETURN QUERY SELECT v_existing.id, v_existing.raw_evidence_id, false;
    RETURN;
  END IF;

  IF v_raw IS NOT NULL THEN
    INSERT INTO public.workflow_repository_plan_raw_evidence (
      guidance_input_digest_sha256, raw_output_sha256, raw_artifact_digest_sha256,
      raw_artifact_canonical_json, raw_envelope_canonical_json
    ) VALUES (
      v_raw #>> '{sourceGuidanceInputDigestSha256}', v_raw #>> '{rawOutputSha256}', v_raw_digest,
      p_raw_artifact_canonical_json, p_raw_envelope_canonical_json
    ) RETURNING id INTO v_raw_id;
  END IF;

  INSERT INTO public.workflow_repository_plan_v2_runs (
    raw_evidence_id, assessment_id, assessment_version, review_id, review_version,
    triage_review_id, triage_version, repository_commit_sha, effective_reviewed_specification_digest_sha256,
    implementation_plan_v1_digest_sha256, foundation_digest_sha256,
    content_bundle_digest_sha256, guidance_input_digest_sha256, plan_v2_digest_sha256,
    plan_v2_canonical_json, plan_v2_envelope_canonical_json
  ) VALUES (
    v_raw_id,
    CASE WHEN v_triage.id IS NULL THEN (v_plan #>> '{source,reviewPin,assessmentId}')::uuid END,
    CASE WHEN v_triage.id IS NULL THEN (v_plan #>> '{source,reviewPin,assessmentVersion}')::integer END,
    CASE WHEN v_triage.id IS NULL THEN (v_plan #>> '{source,reviewPin,reviewId}')::uuid END,
    CASE WHEN v_triage.id IS NULL THEN (v_plan #>> '{source,reviewPin,reviewVersion}')::integer END,
    v_triage.id, v_triage.triage_version,
    v_plan #>> '{source,repositorySnapshot,commitSha}',
    v_plan #>> '{source,effectiveReviewedSpecificationDigestSha256}',
    v_plan #>> '{source,implementationPlanV1DigestSha256}',
    v_plan #>> '{source,foundationDigestSha256}', v_plan #>> '{source,contentBundleDigestSha256}',
    v_plan #>> '{source,guidanceInputDigestSha256}', v_plan_digest,
    p_plan_v2_canonical_json, p_plan_v2_envelope_canonical_json
  ) RETURNING id INTO plan_v2_run_id;
  raw_evidence_id := v_raw_id;
  inserted := true;
  RETURN NEXT;
END;
$$;

-- ----------------------------------------------------------------------------
-- 5. Job completion: the run's source pin must equal the job's, NULL-safe.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.succeed_workflow_repository_plan_generation_job(
  p_job_id uuid, p_claim_token uuid,
  p_plan_v2_run_id uuid
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_job public.workflow_repository_plan_generation_jobs%ROWTYPE;
  v_plan public.workflow_repository_plan_v2_runs%ROWTYPE;
BEGIN
  SELECT * INTO v_job FROM public.workflow_repository_plan_generation_jobs AS job
  WHERE job.id = p_job_id AND job.status = 'claimed' AND job.claim_token = p_claim_token
  FOR UPDATE;
  IF v_job.id IS NULL THEN
    RAISE EXCEPTION 'repository plan generation claim lost' USING ERRCODE = 'serialization_failure';
  END IF;
  SELECT * INTO v_plan FROM public.workflow_repository_plan_v2_runs AS plan
  WHERE plan.id = p_plan_v2_run_id;
  IF v_plan.id IS NULL
    OR v_plan.assessment_id IS DISTINCT FROM v_job.assessment_id
    OR v_plan.assessment_version IS DISTINCT FROM v_job.assessment_version
    OR v_plan.review_id IS DISTINCT FROM v_job.review_id
    OR v_plan.review_version IS DISTINCT FROM v_job.review_version
    OR v_plan.triage_review_id IS DISTINCT FROM v_job.triage_review_id
    OR v_plan.triage_version IS DISTINCT FROM v_job.triage_version
    OR v_plan.implementation_plan_v1_digest_sha256 <> v_job.implementation_plan_v1_digest_sha256
    OR v_plan.plan_v2_canonical_json::jsonb #>> '{guidance,classification}' <> v_job.classification
    OR (v_plan.plan_v2_canonical_json::jsonb #>> '{providerProvenance,callCount}')::integer <> v_job.provider_call_count
    OR ((v_plan.raw_evidence_id IS NOT NULL) <> (v_job.provider_call_count = 1)) THEN
    RAISE EXCEPTION 'repository plan generation result identity mismatch'
      USING ERRCODE = 'check_violation';
  END IF;
  UPDATE public.workflow_repository_plan_generation_jobs AS job
  SET status = 'succeeded', plan_v2_run_id = v_plan.id,
      plan_v2_digest_sha256 = v_plan.plan_v2_digest_sha256,
      completed_at = clock_timestamp()
  WHERE job.id = v_job.id;
END;
$$;

-- ----------------------------------------------------------------------------
-- 6. Queue a job from one exact, current triage review.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.create_workflow_repository_plan_generation_job_from_triage(
  p_triage_review_id uuid, p_triage_version integer,
  p_classification text, p_requested_by_actor_id uuid,
  p_implementation_plan_v1_digest_sha256 text
)
RETURNS TABLE(job_id uuid, job_status text, created_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_triage public.improvement_signal_triage_reviews%ROWTYPE;
  v_row public.workflow_repository_plan_generation_jobs%ROWTYPE;
BEGIN
  IF p_triage_review_id IS NULL OR p_triage_version IS NULL OR p_triage_version <= 0
    OR p_classification IS NULL OR p_classification NOT IN ('RULE','VERIFY','EXTRACT','RECOVER','HUMAN','ADVISORY')
    OR p_implementation_plan_v1_digest_sha256 IS NULL
    OR p_implementation_plan_v1_digest_sha256 !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'invalid repository plan generation job identity'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.user_profiles WHERE id = p_requested_by_actor_id) THEN
    RAISE EXCEPTION 'repository plan generation actor not found' USING ERRCODE = 'foreign_key_violation';
  END IF;
  SELECT * INTO v_triage FROM public.improvement_signal_triage_reviews AS triage
  WHERE triage.id = p_triage_review_id AND triage.triage_version = p_triage_version;
  IF v_triage.id IS NULL THEN
    RAISE EXCEPTION 'exact triage review not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.improvement_signal_triage_reviews AS later
    WHERE later.submission_id = v_triage.submission_id
      AND later.triage_version > v_triage.triage_version
  ) THEN
    RAISE EXCEPTION 'triage review superseded' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF v_triage.disposition IS DISTINCT FROM 'route_to_engineering'
    OR v_triage.plan_classification IS DISTINCT FROM p_classification THEN
    RAISE EXCEPTION 'triage review does not route this classification to engineering'
      USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO public.workflow_repository_plan_generation_jobs (
    triage_review_id, triage_version, classification,
    requested_by_actor_id, implementation_plan_v1_digest_sha256
  ) VALUES (
    v_triage.id, v_triage.triage_version, p_classification,
    p_requested_by_actor_id, p_implementation_plan_v1_digest_sha256
  ) RETURNING * INTO v_row;
  RETURN QUERY SELECT v_row.id, v_row.status, v_row.created_at;
END;
$$;

-- ----------------------------------------------------------------------------
-- 7. Worker read of a triaged-signal job's source: the allowlisted payload and
--    the human classification only. No rationale, no reviewer, no organization.
--    Returns no row for an assessment job or a superseded triage.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.read_workflow_repository_plan_generation_signal_source(
  p_job_id uuid, p_claim_token uuid
)
RETURNS TABLE(submission_row jsonb, triage_row jsonb)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_job public.workflow_repository_plan_generation_jobs%ROWTYPE;
BEGIN
  SELECT * INTO v_job
  FROM public.workflow_repository_plan_generation_jobs AS job
  WHERE job.id = p_job_id AND job.status = 'claimed' AND job.claim_token = p_claim_token;
  IF v_job.id IS NULL THEN
    RAISE EXCEPTION 'repository plan generation claim lost' USING ERRCODE = 'serialization_failure';
  END IF;
  IF v_job.triage_review_id IS NULL THEN
    RETURN;
  END IF;
  RETURN QUERY
  SELECT
    pg_catalog.jsonb_build_object(
      'id', submission.id, 'signal_kind', submission.signal_kind,
      'signal_code', submission.signal_code, 'payload', submission.payload),
    pg_catalog.jsonb_build_object(
      'id', triage.id, 'submission_id', triage.submission_id,
      'signal_kind', triage.signal_kind, 'triage_version', triage.triage_version,
      'disposition', triage.disposition, 'capability_scope', triage.capability_scope,
      'semantics_defect_class', triage.semantics_defect_class,
      'plan_classification', triage.plan_classification)
  FROM public.improvement_signal_triage_reviews AS triage
  JOIN public.improvement_signal_submissions AS submission
    ON submission.id = triage.submission_id
    AND submission.organization_id = triage.organization_id
    AND submission.signal_kind = triage.signal_kind
  WHERE triage.id = v_job.triage_review_id
    AND triage.triage_version = v_job.triage_version
    AND NOT EXISTS (
      SELECT 1 FROM public.improvement_signal_triage_reviews AS later
      WHERE later.submission_id = triage.submission_id
        AND later.triage_version > triage.triage_version);
END;
$$;

-- ----------------------------------------------------------------------------
-- Ownership and access, mirroring the existing job RPCs.
-- ----------------------------------------------------------------------------
ALTER FUNCTION public.create_workflow_repository_plan_generation_job_from_triage(uuid,integer,text,uuid,text) OWNER TO postgres;
ALTER FUNCTION public.read_workflow_repository_plan_generation_signal_source(uuid,uuid) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.create_workflow_repository_plan_generation_job_from_triage(uuid,integer,text,uuid,text)
  FROM PUBLIC, anon, authenticated, service_role, forgewing_engineering_worker;
REVOKE ALL ON FUNCTION public.read_workflow_repository_plan_generation_signal_source(uuid,uuid)
  FROM PUBLIC, anon, authenticated, service_role, forgewing_engineering_worker;

GRANT EXECUTE ON FUNCTION public.create_workflow_repository_plan_generation_job_from_triage(uuid,integer,text,uuid,text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.read_workflow_repository_plan_generation_signal_source(uuid,uuid)
  TO forgewing_engineering_worker;
