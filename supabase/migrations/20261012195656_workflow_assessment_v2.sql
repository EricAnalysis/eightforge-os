-- B8.5: additive source/assessment versions. No historical answers are rewritten.
-- The v1 default remains for deployment compatibility with the previous app.
BEGIN;
ALTER TABLE public.workflow_intake_submissions
  ADD COLUMN IF NOT EXISTS information_or_systems text,
  ADD COLUMN IF NOT EXISTS success_outcome text;

ALTER TABLE public.workflow_intake_submissions
  ALTER COLUMN documents_involved DROP NOT NULL,
  DROP CONSTRAINT IF EXISTS workflow_intake_submissions_schema_version_check,
  DROP CONSTRAINT IF EXISTS workflow_intake_submissions_documents_involved_check;

ALTER TABLE public.workflow_intake_submissions
  ADD CONSTRAINT workflow_intake_submissions_schema_version_check
    CHECK (schema_version IN ('workflow_intake_v1', 'workflow_intake_v2')),
  ADD CONSTRAINT workflow_intake_submissions_documents_involved_check
    CHECK (
      (schema_version <> 'workflow_intake_v1' OR documents_involved IS NOT NULL)
      AND (documents_involved IS NULL OR (btrim(documents_involved) <> '' AND length(documents_involved) <= 5000))
    );

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.workflow_intake_submissions'::regclass
    AND conname = 'workflow_intake_submissions_v2_answers_check') THEN
    ALTER TABLE public.workflow_intake_submissions
      ADD CONSTRAINT workflow_intake_submissions_v2_answers_check CHECK (
        (schema_version <> 'workflow_intake_v2' OR (information_or_systems IS NOT NULL AND success_outcome IS NOT NULL))
        AND (information_or_systems IS NULL OR (btrim(information_or_systems) <> '' AND length(information_or_systems) <= 5000))
        AND (success_outcome IS NULL OR (btrim(success_outcome) <> '' AND length(success_outcome) <= 5000))
      );
  END IF;
END $$;

ALTER TABLE public.workflow_assessments
  DROP CONSTRAINT IF EXISTS workflow_assessments_schema_version_check;
ALTER TABLE public.workflow_assessments
  ADD CONSTRAINT workflow_assessments_schema_version_check
    CHECK (schema_version IN ('workflow_assessment_v1', 'workflow_assessment_v2'));

-- No database object depends on this RPC. PostgreSQL requires recreation when
-- extending its TABLE return shape; preserve the original columns and append v2.
DROP FUNCTION IF EXISTS public.read_workflow_intake_submission(uuid);
CREATE FUNCTION public.read_workflow_intake_submission(submission_id uuid)
RETURNS TABLE (
  id uuid, schema_version text, workflow_description text, documents_involved text,
  manual_checks text, frequency_and_volume text, exceptions text, human_decisions text,
  submitted_at timestamp with time zone, information_or_systems text, success_outcome text
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT s.id, s.schema_version, s.workflow_description, s.documents_involved,
    s.manual_checks, s.frequency_and_volume, s.exceptions, s.human_decisions,
    s.submitted_at, s.information_or_systems, s.success_outcome
  FROM public.workflow_intake_submissions AS s WHERE s.id = submission_id;
$$;
ALTER FUNCTION public.read_workflow_intake_submission(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.read_workflow_intake_submission(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.read_workflow_intake_submission(uuid) TO service_role;
-- Table grants, RLS, and all immutability triggers remain unchanged.
COMMIT;
