-- Forgewing generalization, phase 3: one gate module for every AI surface.
--
-- Each Forgewing workflow that sends content to a provider spends its own
-- durable daily budget in the existing append-only reservation ledger. This
-- only widens the set of budget types; no row, grant, trigger or function
-- changes, and the ledger stays append-only.
--
--   priced_value_reading  (B4.1, unchanged)
--   project_ask           operator questions answered from project truth
--   case_investigation    a model's reading of a ResolutionCase (wired, unqualified)

ALTER TABLE public.forgewing_provider_call_reservations
  DROP CONSTRAINT forgewing_provider_call_reservations_recovery_type_check;

ALTER TABLE public.forgewing_provider_call_reservations
  ADD CONSTRAINT forgewing_provider_call_reservations_recovery_type_check
  CHECK (recovery_type IN ('priced_value_reading', 'project_ask', 'case_investigation'));
