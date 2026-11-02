-- Workflow Assessment follow-up answers.
--
-- A readiness plan can name what an assessment left open, but until now an answer
-- had nowhere to go. This adds one append-only table beside the assessment, and
-- leaves the intake, the assessment and its reviews exactly as they are.
--
-- An answer is input for a reviewer. It is not canonical truth, it does not edit the
-- original seven answers or the assessment, and no truth, Validator, pricing or
-- configuration path reads it. Changing an answer appends a new revision pointing at
-- the one it replaces, so every earlier answer stays.
--
-- A follow-up keeps one identity across assessment versions, so answers belong to the
-- submission, and each records which assessment version it was given against.
--
-- This table holds customer free text, like the intake, so it stays apart from the
-- content-free telemetry. RLS is on with no policies, and only service_role may read
-- or insert.
--
-- Compatibility: purely additive. The review packet tolerates a failed read, so code
-- running before this applies shows every follow-up as still open.
--
-- Rollback: revert the code first, then drop the table and the two functions. That
-- discards any recorded answers, so export them first if any exist.

CREATE TABLE public.workflow_assessment_follow_up_answers (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  source_submission_id uuid NOT NULL REFERENCES public.workflow_intake_submissions(id) ON DELETE RESTRICT,
  -- The assessment version this was answered against.
  assessment_id uuid NOT NULL REFERENCES public.workflow_assessments(id) ON DELETE RESTRICT,
  assessment_version integer NOT NULL CHECK (assessment_version >= 1),
  follow_up_id text NOT NULL CHECK (follow_up_id ~ '^[0-9a-f]{64}$'),
  follow_up_kind text NOT NULL CHECK (follow_up_kind IN ('determinism_gap', 'unresolved_assumption')),
  step_id text CHECK (step_id IS NULL OR length(btrim(step_id)) BETWEEN 1 AND 120),
  -- The question as asked, so the answer still reads correctly if the assessment moves on.
  question_snapshot text NOT NULL CHECK (length(btrim(question_snapshot)) BETWEEN 1 AND 2000),
  answer_text text NOT NULL CHECK (length(btrim(answer_text)) BETWEEN 1 AND 4000),
  answer_source text NOT NULL CHECK (answer_source IN ('customer_stated', 'found_in_supplied_evidence')),
  evidence_attachment_ids uuid[] NOT NULL DEFAULT '{}' CHECK (cardinality(evidence_attachment_ids) <= 5),
  revision integer NOT NULL CHECK (revision >= 1),
  supersedes_answer_id uuid REFERENCES public.workflow_assessment_follow_up_answers(id) ON DELETE RESTRICT,
  -- Pinned: no row can claim to be truth.
  authority text NOT NULL DEFAULT 'non_authoritative' CHECK (authority = 'non_authoritative'),
  answered_by uuid NOT NULL REFERENCES public.user_profiles(id) ON DELETE RESTRICT,
  answered_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT workflow_assessment_follow_up_answers_revision_unique
    UNIQUE (source_submission_id, follow_up_id, revision),
  CONSTRAINT workflow_assessment_follow_up_answers_supersedes_check
    CHECK ((revision = 1) = (supersedes_answer_id IS NULL))
);

CREATE INDEX workflow_assessment_follow_up_answers_submission_idx
  ON public.workflow_assessment_follow_up_answers (organization_id, source_submission_id, follow_up_id, revision);

CREATE FUNCTION public.reject_workflow_follow_up_answer_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  RAISE EXCEPTION 'Workflow assessment follow-up answers are append-only'
    USING ERRCODE = '42501';
END $$;

CREATE TRIGGER workflow_assessment_follow_up_answers_immutable
  BEFORE UPDATE OR DELETE ON public.workflow_assessment_follow_up_answers
  FOR EACH ROW EXECUTE FUNCTION public.reject_workflow_follow_up_answer_mutation();

-- SECURITY DEFINER because the intake grants service_role no direct read. It reads
-- only what this check needs, and it cannot be called directly.
CREATE FUNCTION public.assert_workflow_follow_up_answer_scope()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.workflow_intake_submissions AS submission
    WHERE submission.id = NEW.source_submission_id AND submission.organization_id = NEW.organization_id
  ) THEN
    RAISE EXCEPTION 'Follow-up answer names a submission outside its organization'
      USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.workflow_assessments AS assessment
    WHERE assessment.id = NEW.assessment_id
      AND assessment.source_submission_id = NEW.source_submission_id
      AND assessment.assessment_version = NEW.assessment_version
  ) THEN
    RAISE EXCEPTION 'Follow-up answer names an assessment of another submission or version'
      USING ERRCODE = '42501';
  END IF;
  IF NEW.revision > 1 AND NOT EXISTS (
    SELECT 1 FROM public.workflow_assessment_follow_up_answers AS prior
    WHERE prior.id = NEW.supersedes_answer_id
      AND prior.source_submission_id = NEW.source_submission_id
      AND prior.follow_up_id = NEW.follow_up_id
      AND prior.revision = NEW.revision - 1
  ) THEN
    RAISE EXCEPTION 'Follow-up answer must supersede the revision before it'
      USING ERRCODE = '42501';
  END IF;
  IF (
    SELECT count(*) FROM public.workflow_assessment_attachments AS attachment
    WHERE attachment.id = ANY (NEW.evidence_attachment_ids)
      AND attachment.draft_id = NEW.source_submission_id
      AND attachment.organization_id = NEW.organization_id
      AND attachment.removed_at IS NULL
  ) <> cardinality(NEW.evidence_attachment_ids) THEN
    RAISE EXCEPTION 'Follow-up answer cites a file outside this submission'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER workflow_assessment_follow_up_answers_scope
  BEFORE INSERT ON public.workflow_assessment_follow_up_answers
  FOR EACH ROW EXECUTE FUNCTION public.assert_workflow_follow_up_answer_scope();

ALTER TABLE public.workflow_assessment_follow_up_answers ENABLE ROW LEVEL SECURITY;

-- Server-side only. The browser reaches this through the platform-gated route.
REVOKE ALL ON TABLE public.workflow_assessment_follow_up_answers
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT ON TABLE public.workflow_assessment_follow_up_answers TO service_role;

REVOKE ALL ON FUNCTION public.reject_workflow_follow_up_answer_mutation()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.assert_workflow_follow_up_answer_scope()
  FROM PUBLIC, anon, authenticated, service_role;
