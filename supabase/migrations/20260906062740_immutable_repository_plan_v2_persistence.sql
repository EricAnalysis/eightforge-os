-- Phase 11E B3a: immutable, non-authoritative repository-aware Plan V2 evidence.
-- Raw provider evidence is physically separate from validated guidance. The
-- only writer is the service-role RPC below; direct DML is deliberately absent.

CREATE TABLE public.workflow_repository_plan_raw_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  guidance_input_digest_sha256 text NOT NULL CHECK (guidance_input_digest_sha256 ~ '^[a-f0-9]{64}$'),
  raw_output_sha256 text NOT NULL CHECK (raw_output_sha256 ~ '^[a-f0-9]{64}$'),
  raw_artifact_digest_sha256 text NOT NULL UNIQUE CHECK (raw_artifact_digest_sha256 ~ '^[a-f0-9]{64}$'),
  raw_artifact_canonical_json text NOT NULL,
  raw_envelope_canonical_json text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.workflow_repository_plan_v2_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  raw_evidence_id uuid UNIQUE REFERENCES public.workflow_repository_plan_raw_evidence(id) ON DELETE RESTRICT,
  assessment_id uuid NOT NULL,
  assessment_version integer NOT NULL CHECK (assessment_version > 0),
  review_id uuid NOT NULL,
  review_version integer NOT NULL CHECK (review_version > 0),
  repository_commit_sha text NOT NULL CHECK (repository_commit_sha ~ '^[a-f0-9]{40}$'),
  effective_reviewed_specification_digest_sha256 text NOT NULL CHECK (effective_reviewed_specification_digest_sha256 ~ '^[a-f0-9]{64}$'),
  implementation_plan_v1_digest_sha256 text NOT NULL CHECK (implementation_plan_v1_digest_sha256 ~ '^[a-f0-9]{64}$'),
  foundation_digest_sha256 text NOT NULL CHECK (foundation_digest_sha256 ~ '^[a-f0-9]{64}$'),
  content_bundle_digest_sha256 text NOT NULL CHECK (content_bundle_digest_sha256 ~ '^[a-f0-9]{64}$'),
  guidance_input_digest_sha256 text NOT NULL CHECK (guidance_input_digest_sha256 ~ '^[a-f0-9]{64}$'),
  plan_v2_digest_sha256 text NOT NULL UNIQUE CHECK (plan_v2_digest_sha256 ~ '^[a-f0-9]{64}$'),
  authority text NOT NULL DEFAULT 'non_authoritative' CHECK (authority = 'non_authoritative'),
  executable boolean NOT NULL DEFAULT false CHECK (executable = false),
  grants_execution_authority boolean NOT NULL DEFAULT false CHECK (grants_execution_authority = false),
  requires_human_review boolean NOT NULL DEFAULT true CHECK (requires_human_review = true),
  plan_v2_canonical_json text NOT NULL,
  plan_v2_envelope_canonical_json text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.workflow_repository_plan_raw_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workflow_repository_plan_v2_runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.workflow_repository_plan_raw_evidence FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.workflow_repository_plan_v2_runs FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.workflow_repository_plan_v2_runs TO service_role;

CREATE OR REPLACE FUNCTION public.reject_workflow_repository_plan_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'workflow repository plan evidence is immutable'
    USING ERRCODE = 'object_not_in_prerequisite_state';
END;
$$;

CREATE TRIGGER workflow_repository_plan_raw_evidence_immutable
BEFORE UPDATE OR DELETE ON public.workflow_repository_plan_raw_evidence
FOR EACH ROW EXECUTE FUNCTION public.reject_workflow_repository_plan_mutation();

CREATE TRIGGER workflow_repository_plan_v2_runs_immutable
BEFORE UPDATE OR DELETE ON public.workflow_repository_plan_v2_runs
FOR EACH ROW EXECUTE FUNCTION public.reject_workflow_repository_plan_mutation();

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
    repository_commit_sha, effective_reviewed_specification_digest_sha256,
    implementation_plan_v1_digest_sha256, foundation_digest_sha256,
    content_bundle_digest_sha256, guidance_input_digest_sha256, plan_v2_digest_sha256,
    plan_v2_canonical_json, plan_v2_envelope_canonical_json
  ) VALUES (
    v_raw_id, (v_plan #>> '{source,reviewPin,assessmentId}')::uuid,
    (v_plan #>> '{source,reviewPin,assessmentVersion}')::integer,
    (v_plan #>> '{source,reviewPin,reviewId}')::uuid,
    (v_plan #>> '{source,reviewPin,reviewVersion}')::integer,
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

ALTER FUNCTION public.record_workflow_repository_plan_v2_run(text, text, text, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.record_workflow_repository_plan_v2_run(text, text, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_workflow_repository_plan_v2_run(text, text, text, text)
  TO service_role;

REVOKE ALL ON FUNCTION public.reject_workflow_repository_plan_mutation() FROM PUBLIC, anon, authenticated, service_role;
