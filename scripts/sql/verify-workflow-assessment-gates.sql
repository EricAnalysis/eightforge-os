\set ON_ERROR_STOP on

-- Forgewing S3: Workflow Assessment claims are narrowed to organizations the
-- shared gates admit, and spend that organization's durable budget atomically
-- with the attempt. Disposable fixtures only; the replay job drops the DB.
INSERT INTO public.organizations (id, name) VALUES
  ('95300000-0000-4000-8000-0000000000a1', 'S3 gates eligible org'),
  ('95300000-0000-4000-8000-0000000000a2', 'S3 gates ineligible org'),
  ('95300000-0000-4000-8000-0000000000a3', 'S3 gates capped org');

INSERT INTO public.workflow_intake_submissions (
  id, workflow_description, documents_involved, manual_checks,
  frequency_and_volume, exceptions, human_decisions, submitted_at, organization_id
) VALUES
  ('95300000-0000-4000-8000-000000000001','eligible','docs','checks','daily','none','review',now() - interval '40 minutes','95300000-0000-4000-8000-0000000000a1'),
  ('95300000-0000-4000-8000-000000000002','ineligible org','docs','checks','daily','none','review',now() - interval '39 minutes','95300000-0000-4000-8000-0000000000a2'),
  ('95300000-0000-4000-8000-000000000003','no organization','docs','checks','daily','none','review',now() - interval '38 minutes',NULL),
  ('95300000-0000-4000-8000-000000000004','capped first','docs','checks','daily','none','review',now() - interval '37 minutes','95300000-0000-4000-8000-0000000000a3'),
  ('95300000-0000-4000-8000-000000000005','capped second','docs','checks','daily','none','review',now() - interval '36 minutes','95300000-0000-4000-8000-0000000000a3');

-- The browser can neither list candidates nor claim.
DO $$ BEGIN
  IF has_function_privilege('anon', 'public.list_workflow_assessment_candidate_organizations()', 'EXECUTE')
    OR has_function_privilege('authenticated', 'public.list_workflow_assessment_candidate_organizations()', 'EXECUTE')
    OR has_function_privilege('anon', 'public.claim_workflow_assessment_attempt(integer, uuid, uuid[], uuid[], integer)', 'EXECUTE')
    OR has_function_privilege('authenticated', 'public.claim_workflow_assessment_attempt(integer, uuid, uuid[], uuid[], integer)', 'EXECUTE')
    OR NOT has_function_privilege('service_role', 'public.claim_workflow_assessment_attempt(integer, uuid, uuid[], uuid[], integer)', 'EXECUTE')
  THEN RAISE EXCEPTION 'S3 function grants are wrong'; END IF;
  -- No overload without the narrowing survives.
  IF to_regprocedure('public.claim_workflow_assessment_attempt(integer, uuid, uuid[])') IS NOT NULL THEN
    RAISE EXCEPTION 'the unnarrowed three-argument claim still exists';
  END IF;
END $$;

SET request.jwt.claim.role = 'service_role';
SET ROLE service_role;
DO $$
DECLARE
  claimed record;
  candidates uuid[];
BEGIN
  SELECT array_agg(organization_id ORDER BY organization_id) INTO candidates
  FROM public.list_workflow_assessment_candidate_organizations()
  WHERE organization_id::text LIKE '95300000-%';
  IF candidates IS DISTINCT FROM ARRAY[
    '95300000-0000-4000-8000-0000000000a1'::uuid,
    '95300000-0000-4000-8000-0000000000a2'::uuid,
    '95300000-0000-4000-8000-0000000000a3'::uuid] THEN
    RAISE EXCEPTION 'candidate organizations wrong (organization-less intake must never be a candidate): %', candidates;
  END IF;

  -- No eligible organization: nothing is claimed.
  IF EXISTS (SELECT 1 FROM public.claim_workflow_assessment_attempt(2, NULL, NULL, NULL, 10))
    OR EXISTS (SELECT 1 FROM public.claim_workflow_assessment_attempt(2, NULL, NULL, ARRAY[]::uuid[], 10)) THEN
    RAISE EXCEPTION 'a claim without eligible organizations succeeded';
  END IF;

  -- An ineligible organization's submission and an organization-less one are never claimed.
  IF EXISTS (SELECT 1 FROM public.claim_workflow_assessment_attempt(2,
        '95300000-0000-4000-8000-000000000002', NULL, ARRAY['95300000-0000-4000-8000-0000000000a1'::uuid], 10))
    OR EXISTS (SELECT 1 FROM public.claim_workflow_assessment_attempt(2,
        '95300000-0000-4000-8000-000000000003', NULL, ARRAY['95300000-0000-4000-8000-0000000000a1'::uuid], 10)) THEN
    RAISE EXCEPTION 'an ineligible or organization-less submission was claimed';
  END IF;
  IF EXISTS (SELECT 1 FROM public.workflow_assessment_attempts
      WHERE source_submission_id IN ('95300000-0000-4000-8000-000000000002', '95300000-0000-4000-8000-000000000003')) THEN
    RAISE EXCEPTION 'a denied submission spent an attempt';
  END IF;

  -- An eligible claim returns its organization and the reservation it spent.
  SELECT * INTO claimed FROM public.claim_workflow_assessment_attempt(2,
    '95300000-0000-4000-8000-000000000001', NULL, ARRAY['95300000-0000-4000-8000-0000000000a1'::uuid], 10);
  IF claimed.attempt_id IS NULL OR claimed.attempt_number <> 1
    OR claimed.organization_id <> '95300000-0000-4000-8000-0000000000a1'::uuid
    OR claimed.reservation_id IS NULL THEN
    RAISE EXCEPTION 'eligible claim returned incorrect values: %', claimed;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.forgewing_provider_call_reservations r
      WHERE r.id = claimed.reservation_id
        AND r.organization_id = '95300000-0000-4000-8000-0000000000a1'
        AND r.recovery_type = 'workflow_assessment'
        AND r.reserved_by IS NULL
        AND r.request_digest_sha256 = encode(sha256(convert_to(
          'workflow_assessment:95300000-0000-4000-8000-000000000001:1', 'UTF8')), 'hex')) THEN
    RAISE EXCEPTION 'the claim did not spend the organization''s workflow_assessment budget';
  END IF;
  PERFORM public.finalize_workflow_assessment_attempt(claimed.attempt_id, 'failed', 'proof');

  -- Budget exhaustion excludes the organization without creating an attempt.
  SELECT * INTO claimed FROM public.claim_workflow_assessment_attempt(2,
    NULL, NULL, ARRAY['95300000-0000-4000-8000-0000000000a3'::uuid], 1);
  IF claimed.source_submission_id IS DISTINCT FROM '95300000-0000-4000-8000-000000000004'::uuid THEN
    RAISE EXCEPTION 'capped organization first claim wrong: %', claimed;
  END IF;
  PERFORM public.finalize_workflow_assessment_attempt(claimed.attempt_id, 'failed', 'proof');
  IF EXISTS (SELECT 1 FROM public.claim_workflow_assessment_attempt(2,
      NULL, NULL, ARRAY['95300000-0000-4000-8000-0000000000a3'::uuid], 1)) THEN
    RAISE EXCEPTION 'a claim beyond the organization''s daily cap succeeded';
  END IF;
  IF EXISTS (SELECT 1 FROM public.workflow_assessment_attempts
      WHERE source_submission_id = '95300000-0000-4000-8000-000000000005') THEN
    RAISE EXCEPTION 'a budget-refused submission spent an attempt';
  END IF;
  IF (SELECT count(*) FROM public.forgewing_provider_call_reservations
      WHERE organization_id = '95300000-0000-4000-8000-0000000000a3') <> 1 THEN
    RAISE EXCEPTION 'reservations and attempts diverged for the capped organization';
  END IF;

  -- An invalid cap fails loudly, never silently widening.
  BEGIN
    PERFORM * FROM public.claim_workflow_assessment_attempt(2,
      '95300000-0000-4000-8000-000000000005', NULL, ARRAY['95300000-0000-4000-8000-0000000000a3'::uuid], 5000);
    RAISE EXCEPTION 'an out-of-range daily cap was accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
END $$;
RESET ROLE;
RESET request.jwt.claim.role;

-- Without the service-role claim the reservation, and so the claim, is refused.
SET ROLE service_role;
DO $$ BEGIN
  BEGIN
    PERFORM * FROM public.claim_workflow_assessment_attempt(2,
      '95300000-0000-4000-8000-000000000005', NULL, ARRAY['95300000-0000-4000-8000-0000000000a3'::uuid], 10);
    RAISE EXCEPTION 'a claim without the service-role claim reserved budget';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  IF EXISTS (SELECT 1 FROM public.workflow_assessment_attempts
      WHERE source_submission_id = '95300000-0000-4000-8000-000000000005') THEN
    RAISE EXCEPTION 'a refused reservation left an attempt behind';
  END IF;
END $$;
RESET ROLE;

-- Every claim-made reservation for these fixtures belongs to exactly one attempt.
DO $$ BEGIN
  IF (SELECT count(*) FROM public.forgewing_provider_call_reservations
      WHERE recovery_type = 'workflow_assessment' AND organization_id::text LIKE '95300000-%')
    <> (SELECT count(*) FROM public.workflow_assessment_attempts
      WHERE source_submission_id::text LIKE '95300000-%') THEN
    RAISE EXCEPTION 'workflow_assessment reservations and attempts diverged';
  END IF;
END $$;

SELECT 'WORKFLOW ASSESSMENT FORGEWING GATES: PASS' AS result;
