-- Forgewing S5: every Forgewing activation names the human who granted it.
--
-- Commercial entitlement and data-processing authorization are the two
-- human decisions that let an organization's content reach an AI provider.
-- Both ledgers are append-only, but `recorded_by` was nullable, so a grant
-- could be recorded with no attributable actor. From now on a GRANT
-- (entitlement enabled = true, data policy approved = true) must name an
-- existing auth user. A revocation may still be recorded without one, so an
-- emergency stop is never blocked; revocations only narrow.
--
-- NOT VALID: the constraint applies to every new row and never rewrites or
-- re-judges historical evidence. (Production held zero rows in either ledger
-- when this was written, so nothing historical is exempted in practice.)
-- No row, grant, trigger or function changes.

ALTER TABLE public.organization_forgewing_entitlement_events
  ADD CONSTRAINT organization_forgewing_entitlement_events_grant_actor_check
  CHECK (enabled IS NOT TRUE OR recorded_by IS NOT NULL) NOT VALID;

ALTER TABLE public.organization_forgewing_data_policy_events
  ADD CONSTRAINT organization_forgewing_data_policy_events_grant_actor_check
  CHECK (approved IS NOT TRUE OR recorded_by IS NOT NULL) NOT VALID;
