ALTER TABLE public.decision_feedback
  DROP COLUMN IF EXISTS feedback_note,
  DROP COLUMN IF EXISTS reviewed_by;

COMMENT ON TABLE public.decision_feedback IS
  'feedback_note removed: application writes notes column.
   reviewed_by removed: application uses reviewer_id with
   unique constraint (decision_id, reviewer_id).';
