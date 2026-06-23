# Phase A Gap Inventory Addendum: `public.rules`

Status: documentation-only inventory addendum. No migration is proposed or included. The dual-FK architecture remains in the cleanup queue, undecided.

Live project: `jpzeckefppmiujwajgvk`  
Captured: `2026-06-22 14:00:57.861663+00`  
Method: read-only catalog queries against `pg_attribute`, `pg_attrdef` + `pg_get_expr`, `pg_constraint` + `pg_get_constraintdef`, `pg_index` + `pg_get_indexdef`, `pg_policy`/`pg_policies`, `pg_trigger` + `pg_get_triggerdef`, and exact `count(*)` queries.

## Gap inventory table — row 22

| # | Table | Live rows | Columns | Constraints | Indexes | RLS | Committed migration references | Application references | Baseline disposition |
|---:|---|---:|---:|---:|---:|---|---|---|---|
| 22 | `public.rules` | 25 | 17 | 3 owned by `rules`; 1 inbound FK from `decisions` | 2 | Enabled; not forced; 4 permissive `PUBLIC` policies | Deterministic backbone, seed, verification, and RLS migrations (enumerated below) | Direct CRUD, evaluation loading, and decision-link persistence (enumerated below) | Include in the eventual real baseline. No migration in this addendum. Keep the dual-FK question in the cleanup queue, undecided. |

## Exact live schema

### Columns

| # | Column | Type | Nullable | Default | Identity/generated |
|---:|---|---|---|---|---|
| 1 | `id` | `uuid` | No | `gen_random_uuid()` | No |
| 2 | `organization_id` | `uuid` | Yes | none | No |
| 3 | `domain` | `text` | No | none | No |
| 4 | `document_type` | `text` | No | none | No |
| 5 | `rule_group` | `text` | Yes | none | No |
| 6 | `name` | `text` | No | none | No |
| 7 | `description` | `text` | Yes | none | No |
| 8 | `decision_type` | `text` | No | none | No |
| 9 | `severity` | `text` | No | `'medium'::text` | No |
| 10 | `priority` | `integer` | No | `100` | No |
| 11 | `status` | `text` | No | `'active'::text` | No |
| 12 | `condition_json` | `jsonb` | No | `'{}'::jsonb` | No |
| 13 | `action_json` | `jsonb` | No | `'{}'::jsonb` | No |
| 14 | `created_at` | `timestamp with time zone` | No | `now()` | No |
| 15 | `updated_at` | `timestamp with time zone` | No | `now()` | No |
| 16 | `created_by` | `uuid` | Yes | none | No |
| 17 | `updated_by` | `uuid` | Yes | none | No |

### Constraints owned by `rules`

All three constraints are validated, non-deferrable, and initially immediate.

| Name | Type | Exact `pg_get_constraintdef(..., true)` output |
|---|---|---|
| `rules_pkey` | Primary key | `PRIMARY KEY (id)` |
| `rules_severity_check` | Check | `CHECK (severity = ANY (ARRAY['low'::text, 'medium'::text, 'high'::text, 'critical'::text]))` |
| `rules_status_check` | Check | `CHECK (status = ANY (ARRAY['active'::text, 'inactive'::text, 'draft'::text]))` |

Inbound constraint:

| Source table | Name | Exact definition |
|---|---|---|
| `public.decisions` | `fk_decisions_rule` | `FOREIGN KEY (decision_rule_id) REFERENCES rules(id) ON DELETE SET NULL` |

### Indexes

Both indexes are ready and valid.

| Name | Primary | Unique | Exact `pg_get_indexdef` output |
|---|---:|---:|---|
| `idx_rules_scope` | No | No | `CREATE INDEX idx_rules_scope ON public.rules USING btree (organization_id, domain, document_type, status, priority)` |
| `rules_pkey` | Yes | Yes | `CREATE UNIQUE INDEX rules_pkey ON public.rules USING btree (id)` |

### RLS policies

`relrowsecurity = true`; `relforcerowsecurity = false`. Each live policy is permissive and applies to `PUBLIC`.

| Policy | Command | `USING` | `WITH CHECK` |
|---|---|---|---|
| `rules_select_org` | `SELECT` | `(organization_id IS NULL) OR (organization_id = (SELECT up.organization_id FROM user_profiles up WHERE up.id = auth.uid()))` | none |
| `rules_insert_org` | `INSERT` | none | `organization_id = (SELECT up.organization_id FROM user_profiles up WHERE up.id = auth.uid())` |
| `rules_update_org` | `UPDATE` | `organization_id = (SELECT up.organization_id FROM user_profiles up WHERE up.id = auth.uid())` | same as `USING` |
| `rules_delete_org` | `DELETE` | `organization_id = (SELECT up.organization_id FROM user_profiles up WHERE up.id = auth.uid())` | none |

### Trigger

The enabled ordinary trigger is `CREATE TRIGGER trg_rules_updated_at BEFORE UPDATE ON rules FOR EACH ROW EXECUTE FUNCTION set_updated_at()`.

### Row count

`SELECT count(*) FROM public.rules` returned **25**.

## Committed migration references

The following inventory is from committed files under `supabase/migrations`.

- `supabase/migrations/20250314000000_deterministic_decision_backbone.sql`
  - lines 121, 124: section marker and table creation.
  - lines 144-162: `rules` check-constraint section and `ALTER TABLE` statements.
  - lines 166-186: original per-column indexes plus composite active-scope index declarations.
  - lines 193, 398, 410-414: decision-column inventory comment and `rules` updated-at trigger.
  - lines 449-458: intended decisions-to-rules FK block; the committed SQL names `rule_id`/`decisions_rule_id_fkey`, while the live inbound FK is `decision_rule_id`/`fk_decisions_rule`.
  - lines 506-522: RLS enablement and original select policy.
- `supabase/migrations/20250314000001_seed_debris_ops.sql`
  - insert/guard pairs at lines 91/98, 101/108, 111/118, 121/128, 136/143, 146/153, 156/163, 171/178, 181/188, 191/198, 207/214, 217/224, 232/239, 242/249, 257/264, 267/274, 277/284, and 287/294.
- `supabase/migrations/20250314_verification_checklist.sql`
  - lines 164 and 175: read-only verification queries against `public.rules`.
- `supabase/migrations/20250316000000_add_rls_document_extractions_rules_signals.sql`
  - lines 72, 75-118: RLS enablement and select/insert/update/delete policy definitions for `public.rules`.
- `supabase/migrations/20260609000000_enable_rls_six_tables.sql`
  - lines 9 and 151-215 reference `decision_rules`, not `rules`; included here because that table participates in the live dual-FK state discussed below.

No committed migration found by repository search declares the live `fk_decisions_rule` name or the live `decisions_decision_rule_id_fkey` relationship to `decision_rules`. That is catalog/repository drift evidence only; this addendum does not prescribe a repair.

## Application-code references

Direct `public.rules` storage access:

- `app/api/rules/route.ts:30` — inserts a rule.
- `app/api/rules/[id]/route.ts:24,51` — updates and deletes a rule.
- `app/platform/rules/page.tsx:63` — lists rules.
- `app/platform/rules/[id]/edit/page.tsx:43` — loads one rule for editing.
- `lib/server/ruleEngine.ts:91-112` — loads applicable global/org rules from `rules`, including the direct table call at line 104.
- `app/api/documents/[id]/evaluate/route.ts:173-182` — calls that loader, then evaluates the returned rows.
- `lib/server/decisionPersistence.ts:92-121` — resolves `rules.id` values, including the direct table call at line 107.
- `lib/server/decisionPersistence.ts:156-206` — assigns the resolved `rules.id` to `decisions.decision_rule_id` on update/insert.
- `lib/server/decisionEngine.ts:88-127,177` — deduplicates by `decisions.decision_rule_id` and assigns a matched `RuleRow.id` to that column. The same insert object also includes `rule_id` at line 178, although `rule_id` is not a live `decisions` column.
- `lib/types/rules.ts:41-65,89` — live `RuleRow` shape and `decision_rule_id` result typing.
- `lib/validator/createFindingDecision.ts:106` — explicitly creates a decision with `decision_rule_id: null`.

Rule UI/type support associated with those direct accesses:

- `components/rules/RuleForm.tsx:4-7`, `components/rules/RuleTestPanel.tsx:5`, `components/rules/ConditionsBuilder.tsx:3`, and `components/rules/ActionBuilder.tsx:3` consume `lib/types/rules.ts` types.

The separate in-memory validator registry under `lib/rules/*` and `tests/ruleEngine.test.ts` uses the generic term “rules” but does not query `public.rules`; it is not counted as a table reference.

## Dual-FK observation — report only

Live `public.decisions.decision_rule_id` is constrained simultaneously by:

1. `decisions_decision_rule_id_fkey`: `FOREIGN KEY (decision_rule_id) REFERENCES decision_rules(id) ON DELETE SET NULL`.
2. `fk_decisions_rule`: `FOREIGN KEY (decision_rule_id) REFERENCES rules(id) ON DELETE SET NULL`.

Observed live data:

- `decisions`: 30 rows.
- non-null `decisions.decision_rule_id`: 0 rows (0 distinct IDs).
- non-null values joining to `rules`: 0 rows; orphan non-null values: 0 rows.
- `decision_rules`: 0 rows.

Observed application logic:

- `fk_decisions_rule` is not merely unreferenced in code: current code explicitly reads `rules.id` and attempts to write it into `decisions.decision_rule_id` (`lib/server/decisionPersistence.ts:92-121,156-206`; `lib/server/decisionEngine.ts:88-127,177`).
- No committed application query to `public.decision_rules` was found. The committed references found for `decision_rules` are its June 2026 RLS migration only.
- No live decision currently exercises either FK because every `decision_rule_id` is null. With both FKs present, a future non-null value must exist in both referenced tables; the live `decision_rules` row count is zero.

This inventory intentionally makes no conclusion about whether `rules` is dead and no recommendation about which FK or rule model should govern. That architectural decision remains queued separately.
