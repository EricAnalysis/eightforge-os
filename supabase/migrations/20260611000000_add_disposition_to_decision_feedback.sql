ALTER TABLE public.decision_feedback
  ADD COLUMN IF NOT EXISTS disposition text;

COMMENT ON COLUMN public.decision_feedback.disposition IS
  'Operator disposition recorded for this decision feedback. Values: accept, reject, escalate, suppress, resolved, suppressed, or null for triage-only feedback.';
