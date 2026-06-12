-- ============================================================================
-- MIGRATION: Transaction data ticket-grain quantity facts
-- Date: 2026-06-07
-- Purpose:
--   Add canonical quantity facts for one-physical-load-per-ticket fields.
--   Amounts remain row-grain; these facts are additive and mirrored in
--   summary_json by application persistence.
-- ============================================================================

ALTER TABLE public.transaction_data_datasets
  ADD COLUMN IF NOT EXISTS total_cyd_ticket_grain double precision NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_cyd_ticket_grain_full double precision NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_mileage_ticket_grain double precision NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_mileage_ticket_grain_full double precision NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_diameter double precision NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_diameter_full double precision NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_net_tonnage double precision NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_net_tonnage_full double precision NOT NULL DEFAULT 0;

UPDATE public.transaction_data_datasets
SET
  total_cyd_ticket_grain = COALESCE(total_cyd_ticket_grain, 0),
  total_cyd_ticket_grain_full = COALESCE(total_cyd_ticket_grain_full, 0),
  total_mileage_ticket_grain = COALESCE(total_mileage_ticket_grain, 0),
  total_mileage_ticket_grain_full = COALESCE(total_mileage_ticket_grain_full, 0),
  total_diameter = COALESCE(total_diameter, 0),
  total_diameter_full = COALESCE(total_diameter_full, 0),
  total_net_tonnage = COALESCE(total_net_tonnage, 0),
  total_net_tonnage_full = COALESCE(total_net_tonnage_full, 0),
  summary_json = COALESCE(summary_json, '{}'::jsonb)
WHERE
  total_cyd_ticket_grain IS NULL
  OR total_cyd_ticket_grain_full IS NULL
  OR total_mileage_ticket_grain IS NULL
  OR total_mileage_ticket_grain_full IS NULL
  OR total_diameter IS NULL
  OR total_diameter_full IS NULL
  OR total_net_tonnage IS NULL
  OR total_net_tonnage_full IS NULL
  OR summary_json IS NULL;
