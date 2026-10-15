-- Forgewing census D2: durable daily budgets for the extraction shadow and
-- recovery provider calls.
--
-- The five extraction shadow tasks (region classification, table
-- continuation, column mapping, observation arbitration, pricing
-- interpretation) and the recovery tasks send customer document
-- text to the provider. Until now they were bounded only by an in-request call
-- budget. Each provider call now first spends one slot of its organization's
-- durable daily budget in the EXISTING append-only reservation ledger, through
-- the EXISTING `reserve_forgewing_provider_call` (advisory-locked per
-- organization and type; trailing 24-hour window; cap enforced in-database).
--
-- Like 20261006120000 and 20261014150000, this only widens the set of budget
-- types:
--
--   extraction_shadow     the five shadow tasks, one shared budget
--   extraction_recovery   the recovery V2 recommendation, and the deprecated V1
--                         pricing rate-cluster recovery (ceiling disabled)
--
-- No row is written or rewritten; no table, column, grant, trigger or
-- function changes; the ledger stays append-only and service_role-only.
-- These calls are system-initiated, so `reserved_by` is NULL (the column has
-- always been nullable).

ALTER TABLE public.forgewing_provider_call_reservations
  DROP CONSTRAINT forgewing_provider_call_reservations_recovery_type_check;

ALTER TABLE public.forgewing_provider_call_reservations
  ADD CONSTRAINT forgewing_provider_call_reservations_recovery_type_check
  CHECK (recovery_type IN ('priced_value_reading', 'project_ask', 'case_investigation', 'workflow_assessment',
    'extraction_shadow', 'extraction_recovery'));
