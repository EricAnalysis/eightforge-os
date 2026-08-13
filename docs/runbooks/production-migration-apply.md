# Production Migration Apply Runbook

Status: PHASE 3 + P2 STAGED CATCH-UP IN PROGRESS — Checkpoint 6 (fresh-upload identity proof) verified 2026-08-11 through the real production application, not direct SQL. Next: Checkpoint 7 (backfill authorization), pending separate authorization. Prior entry: PRODUCTION APPLY COMPLETE for the 2026-07-07 workspace-load performance indexes.

## Phase 3 + P2 staged catch-up — Checkpoint 1 (Step 0 foundation), 2026-08-11

Status: **SUCCESSFUL DIRECT APPLY.** Two migrations applied to `jpzeckefppmiujwajgvk`, each in its own transaction together with its ledger row.

Backup precondition: operator confirmed satisfied on 2026-08-11 prior to apply. **The exact backup timestamp was not supplied to the applying session and is not recorded here — an operator should fill it in for audit completeness.** Latest production write immediately before apply was `2026-08-11 17:57:38 UTC` (recorded at Checkpoint 0), which bounds the restore gap.

Files applied, in order:

```text
supabase/migrations/20260723163517_phase3_step0_compliance_foundation.sql
  sha256 3ae44cdc8e2adcf2115f7cce80cef64f929dc289ed4aa0dade5512f6bb56a88b
supabase/migrations/20260724000000_revoke_direct_snapshot_assignment_writes.sql
  sha256 40ecaeaba13b8a9c21457eb59cc1cc41044e72b9b22700b027cbc69b991f6d44
```

Connection: `psql` is not installed on this workstation, and the direct hostname `db.jpzeckefppmiujwajgvk.supabase.co` failed DNS resolution (`ENOTFOUND`) — the same AAAA-only condition recorded in the 2026-06-24 entry. Applied through the documented IPv4 Supavisor session pooler `aws-0-us-west-2.pooler.supabase.com:5432` (resolved to `44.238.118.41`, `35.160.209.8`, `54.70.143.232` — the same addresses recorded previously), using a temporary `pg` client (`npm install --no-save pg`; `package.json`/`package-lock.json` verified unaffected). Credentials were read from `.env.local` and never printed.

Pre-apply checks: ledger 44 rows; `extraction_%` tables 0; no ledger row for either target version; `enforce_extraction_source_document_org` absent; `documents` 28. Neither file contains `CREATE INDEX CONCURRENTLY`, so both are transaction-safe.

Apply output:

```text
OK (1112ms): 20260723163517_phase3_step0_compliance_foundation
OK (378ms):  20260724000000_revoke_direct_snapshot_assignment_writes
```

### Post-apply verification

| Check | Expected | Actual |
| --- | --- | --- |
| Ledger rows | 46 | **46** |
| Ledger head | `20260724000000` | **`20260724000000`** |
| Both ledger rows present, correctly named | yes | **yes** |
| Total `public` base tables | 46 + 27 = 73 | **73** |
| `extraction_%` tables | 16 | **16** |
| `public.extraction_source_artifacts` | present | **present** |
| Its columns (pre-P2) | `id, organization_id, source_document_id, source_sha256, storage_object_version, media_type_sniffed, byte_length, created_at` | **matches** |
| `extraction_source_artifacts` row count | 0 | **0** |
| RLS enabled on new `extraction_%` tables | 16 | **16** |
| `public` tables with RLS disabled | 0 | **0** |
| Non-internal triggers on `extraction_%` | present | **26** |
| `enforce_extraction_source_document_org` | present | **present** |
| `check_extraction_dependency_closure` | present (pre-#108 form) | **present** |
| `service_role` INSERT on `document_extraction_snapshot_assignments` | revoked | **false** |
| `service_role` UPDATE on same | revoked | **false** |
| `service_role` SELECT on same | retained | **true** |
| `documents` / `document_relationships` / `projects` / `organizations` | 28 / 8 / 7 / 4 unchanged | **28 / 8 / 7 / 4** |

No pre-existing production table was modified and no existing row was touched, consistent with the pre-deployment audit finding that the Phase 3 chain is additive new-namespace DDL only.

Note: `check_extraction_dependency_closure` is currently the **pre-hardening, RLS-dependent** definition. This is expected at Checkpoint 1 and is corrected at Checkpoint 4 by `20260810191912`. Do not treat the current closure function as the reviewed final state.

## Phase 3 + P2 staged catch-up — Checkpoint 2 (Step 1 publication + span hardening), 2026-08-11

Status: **SUCCESSFUL DIRECT APPLY.** Two migrations applied, each in its own transaction together with its ledger row, using the same pooler mechanism as Checkpoint 1 (`psql` still not installed locally; direct hostname still `ENOTFOUND`; temporary `pg` client via `npm install --no-save pg`, `package.json`/`package-lock.json` verified unaffected).

Files applied, in order:

```text
supabase/migrations/20260724010000_phase3_step1_shadow_publication.sql
  sha256 d440c8cb06a7365bcd6b273ccab03d809a8ddd823832f1700c8bbe53ece0d286
supabase/migrations/20260727000000_harden_phase3_step1_span_verification.sql
  sha256 b5b5a52c95e7383cf5ba2106ad57e9c060c452d8edbb59ebeb9442bdfb2da4a7
```

Pre-apply checks: ledger 46 rows; no ledger row for either target version; `publish_extraction_step1_shadow`/`resolve_extraction_step1_source` absent; `documents` 28, `document_relationships` 8, `extraction_source_artifacts` 0 rows. Neither file contains `CREATE INDEX CONCURRENTLY`, so both are transaction-safe.

Apply output:

```text
OK (484ms): 20260724010000_phase3_step1_shadow_publication
OK (384ms): 20260727000000_harden_phase3_step1_span_verification
```

### Post-apply verification

| Check | Expected | Actual |
| --- | --- | --- |
| Ledger rows | 48 | **48** |
| Ledger head | `20260727000000` | **`20260727000000`** |
| Both ledger rows present, correctly named | yes | **yes** |
| `publish_extraction_step1_shadow` present, `SECURITY DEFINER` | yes | **yes** |
| `resolve_extraction_step1_source` present, `SECURITY DEFINER` | yes | **yes** |
| `enforce_shadow_assignment_monotonic` present | yes | **yes** |
| `verify_extraction_candidate_content` present | yes | **yes** |
| `trg_shadow_assignment_monotonic` (non-internal) | 1 | **1** |
| `trg_extraction_field_candidates_content` (non-internal) | 1 | **1** |
| Existing data (`documents`/`document_relationships`/`projects`/`organizations`) | 28/8/7/4 unchanged | **28/8/7/4** |
| `extraction_source_artifacts` row count | 0 | **0** |
| Total `public` base tables | 73 (no new tables in this checkpoint) | **73** |

### Privilege isolation — `publish_extraction_step1_shadow` / `resolve_extraction_step1_source`

Explicitly verified per this checkpoint's request, separate from waiting for #108:

| Role | `publish_extraction_step1_shadow` EXECUTE | `resolve_extraction_step1_source` EXECUTE |
| --- | --- | --- |
| `anon` | **false** | **false** |
| `authenticated` | **false** | **false** |
| `service_role` | **true** | **true** |

Matches the migration's `REVOKE ALL ... FROM PUBLIC` / `GRANT EXECUTE ... TO service_role` pairing for both RPCs.

### Finding: trigger-support functions retain `anon`/`authenticated` EXECUTE

`enforce_shadow_assignment_monotonic()` and `verify_extraction_candidate_content()` are declared with `REVOKE ALL ... FROM PUBLIC` in their migrations, but their live ACLs on this project are:

```text
{postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}
```

i.e. `anon` and `authenticated` still hold direct EXECUTE. This is consistent with Supabase's standard `ALTER DEFAULT PRIVILEGES` schema configuration granting EXECUTE on newly created `public` functions to `anon`/`authenticated`/`service_role` at creation time — `REVOKE ALL FROM PUBLIC` revokes the PUBLIC pseudo-role's grant, not those role-specific default grants. **Practical risk is nil**: both functions are `RETURNS trigger` (confirmed via `pg_proc.prorettype`), and Postgres refuses to execute a trigger function outside trigger-firing context regardless of EXECUTE privilege. No remediation was performed — out of scope for this checkpoint and not required by #108, which does not touch either function. Recorded here as a verified, currently-inert discrepancy between migration intent and this project's live grants, for awareness at future security review.

## Phase 3 + P2 staged catch-up — Checkpoint 3 (Step 2/3 structures), 2026-08-11

Status: **SUCCESSFUL DIRECT APPLY.** Four migrations applied, each in its own transaction together with its ledger row, same pooler mechanism as Checkpoints 1–2 (`package.json`/`package-lock.json` verified unaffected).

Files applied, in order:

```text
supabase/migrations/20260727010000_phase3_step2_generic_ocr_gap_reasons.sql
  sha256 e319f70f00a085ab311faaa018ff0dc9874dfc9ed7eebd293a1f8a740c78b7f5
supabase/migrations/20260727020000_persist_candidate_fragment_dependency_roles.sql
  sha256 4247918f73040d93e6a75343022025d4c8cae81ba23f9619b04d5cdb6b140ad8
supabase/migrations/20260727030000_phase3_step3_generic_table_artifacts.sql
  sha256 2ec00453e4370d9d21e90c8332d6ed78992004733a8f08eb36c32f5f07d11ac3
supabase/migrations/20260727040000_phase3_step3_continuation_cell_reconstruction_remediation.sql
  sha256 a2dfb1a02a599661d08f5b57b04a4b0e9ca4daa31ea6c554a8c61c6fca61e639
```

Two of these migrations (`20260727020000`, and three sites within `20260727030000`) do not create new functions — they patch existing function bodies in place via `DO $migration$` blocks that read `pg_proc.prosrc`, `replace()` an exact expected substring, assert the replacement actually changed the body (`RAISE EXCEPTION` otherwise), and `EXECUTE format('CREATE OR REPLACE FUNCTION ...')` the patched result. This is a stronger-than-usual safety property: the migration cannot silently no-op against a function body it doesn't recognize. All such assertions passed.

Pre-apply checks: ledger 48 rows; no ledger row for any of the four target versions; `extraction_processing_gaps` and `extraction_field_candidate_sources` present (from Checkpoint 1) with 0 rows each — so the `ADD COLUMN dependency_role text NOT NULL DEFAULT 'content'` and its `VALIDATE CONSTRAINT` in `20260727020000` had nothing to backfill or validate against; `verify_extraction_candidate_content`, `enforce_extraction_provenance_integrity`, `check_extraction_dependency_closure`, `publish_extraction_step1_shadow` all present (from Checkpoints 1–2, as targets of the patches). `documents` 28, `document_relationships` 8, `extraction_source_artifacts` 0 rows. No `CREATE INDEX CONCURRENTLY` in any of the four files.

Apply output:

```text
OK (376ms): 20260727010000_phase3_step2_generic_ocr_gap_reasons
OK (375ms): 20260727020000_persist_candidate_fragment_dependency_roles
OK (683ms): 20260727030000_phase3_step3_generic_table_artifacts
OK (365ms): 20260727040000_phase3_step3_continuation_cell_reconstruction_remediation
```

### Post-apply verification

| Check | Expected | Actual |
| --- | --- | --- |
| Ledger rows | 52 | **52** |
| Ledger head | `20260727040000` | **`20260727040000`** |
| All four ledger rows present, correctly named | yes | **yes** |
| `extraction_processing_gaps_reason_check` includes `table_structure_unresolved`, `arbitration_unresolved` | yes | **yes** |
| `extraction_field_candidate_sources.dependency_role` column | `NOT NULL DEFAULT 'content'` | **matches** |
| Its check constraint validated (not just `NOT VALID`) | yes | **`convalidated = true`** |
| New Step 3 tables | 14 | **14** (`extraction_table_continuation_links`, `_link_basis_fragments`, `_chains`, `_chain_segments`, `_chain_links`, `_chain_gaps`, `_sections`, `_section_rows`, `_section_child_chains`, `extraction_arbitration_decisions`, `_decision_candidates`, `semantic_column_mappings`, `_mapping_fields`, `extraction_step3_publication_receipts`) |
| RLS enabled on all 14 | 14 | **14** |
| `trg_document_interpretation_records_provenance_integrity` | present | **present** |
| `trg_extraction_table_cell_dependency_edge` | present | **present** |
| `trg_extraction_table_cell_reconstruction` (constraint trigger) | present | **present** |
| `verify_extraction_candidate_content` body contains new role-aware `FILTER` clause | yes | **yes** (patch confirmed live, not just applied) |
| `publish_extraction_step1_shadow` body references `extraction_step3_publication_receipts` | yes | **yes** (patch confirmed live) |
| `enforce_extraction_table_cell_dependency_edge`, `check_extraction_table_cell_reconstruction` present, `RETURNS trigger` | yes | **yes** |
| Existing data (`documents`/`document_relationships`/`projects`/`organizations`) | 28/8/7/4 unchanged | **28/8/7/4** |
| `extraction_source_artifacts` rows | 0 | **0** |
| `extraction_processing_gaps` / `extraction_field_candidate_sources` rows | 0 / 0 | **0 / 0** |
| Total `public` base tables | 73 + 14 = 87 | **87** |

### Function EXECUTE privilege inventory — all Phase 3 functions through Checkpoint 3

| Function | Return type | `SECURITY DEFINER` | `anon` EXECUTE | `authenticated` EXECUTE | `service_role` EXECUTE |
| --- | --- | --- | --- | --- | --- |
| `publish_extraction_step1_shadow(jsonb)` | `jsonb` (callable RPC) | true | **false** | **false** | **true** |
| `resolve_extraction_step1_source(jsonb)` | `jsonb` (callable RPC) | true | **false** | **false** | **true** |
| `enforce_extraction_source_document_org()` | `trigger` | false | true* | true* | true |
| `enforce_shadow_assignment_monotonic()` | `trigger` | false | true* | true* | true |
| `verify_extraction_candidate_content()` | `trigger` | false | true* | true* | true |
| `enforce_extraction_provenance_integrity()` | `trigger` | false | true* | true* | true |
| `check_extraction_dependency_closure()` | `trigger` | false | true* | true* | true |
| `enforce_extraction_table_cell_dependency_edge()` | `trigger` | false | true* | true* | true |
| `check_extraction_table_cell_reconstruction()` | `trigger` | false | true* | true* | true |

`*` = inherited via this project's `ALTER DEFAULT PRIVILEGES` (same mechanism first noted at Checkpoint 2), not exploitable: Postgres refuses to execute any `RETURNS trigger` function outside trigger-firing context, independent of EXECUTE grants. Confirmed for all 7 trigger-support functions now in production, not just the 2 flagged at Checkpoint 2.

**Both callable, non-trigger RPCs are correctly locked to `service_role` only.** This is the property that actually matters for authorization; it holds without exception across every Phase 3 RPC deployed so far.

**No remediation performed for the inherited grants**, per explicit instruction: this is deferred to Checkpoint 4, where the choice is between letting `20260810191912` (#108) additionally correct it, or adding a small explicit hardening migration if #108 doesn't. Decision not yet made.

## Phase 3 + P2 staged catch-up — Checkpoint 4 (P1 duplicate semantics + #108 hardening + trigger-function least-privilege), 2026-08-11

Status: **SUCCESSFUL DIRECT APPLY**, plus a targeted, empirically-verified privilege normalization performed after the two migrations. Same pooler mechanism as Checkpoints 1–3 (`package.json`/`package-lock.json` verified unaffected).

Files applied, in order:

```text
supabase/migrations/20260810145107_add_duplicate_document_relationship.sql
  sha256 42bc7a778630c0307908039e05da9157a41533b9503d1a9f4f7e39ea5e559f35
supabase/migrations/20260810191912_harden_extraction_dependency_closure_invariant.sql
  sha256 7fd9f5e7b122f2185c61732124fd20f79efb34f85028f934109545bdda8d5a0d
```

Pre-apply checks: ledger 52 rows; no ledger row for either target version; `document_relationships` 8 rows unchanged since Checkpoint 0 (content SHA-256 `c538b0b8...339cbf` over all 8 rows' full column set, matching the Checkpoint 0 snapshot exactly); pre-hardening `check_extraction_dependency_closure` confirmed `SECURITY DEFINER = false` (i.e. still the original RLS-dependent form) immediately before apply. Neither file contains `CREATE INDEX CONCURRENTLY`.

Apply output:

```text
OK (370ms): 20260810145107_add_duplicate_document_relationship
OK (380ms): 20260810191912_harden_extraction_dependency_closure_invariant
```

### P1 verification — `document_relationships_relationship_type_check`

| Check | Expected | Actual |
| --- | --- | --- |
| Constraint includes `duplicate_of` alongside the other 8 values | yes | **yes** — `CHECK (relationship_type = ANY (ARRAY['duplicate_of', 'attached_to', 'supplements', 'amends', 'supersedes', 'governs', 'replaces', 'supports', 'applies_to']))` |
| Existing 8 rows still satisfy the new constraint | yes (constraint `ADD CONSTRAINT` would itself have aborted the migration otherwise) | **yes** — apply succeeded |
| Existing 8 rows unchanged in content, not just count | yes | **yes** — content SHA-256 over all 8 rows (`id, project_id, source_document_id, target_document_id, relationship_type, created_at, created_by, organization_id`) is identical before and after: `c538b0b875d984ebebe9cc1822b6368157368999d5223aa21f66ec9c1a339cbf` |
| `duplicate_of` is actually accepted, not just present in the constraint text | yes | **yes** — a real `INSERT ... relationship_type = 'duplicate_of'` was attempted inside a transaction and succeeded, then rolled back; no row persisted |

### #108 verification — `check_extraction_dependency_closure`

| Check | Expected | Actual |
| --- | --- | --- |
| `SECURITY DEFINER` | true | **true** |
| Owner | `postgres` | **`postgres`** |
| `search_path` | fixed, safe | **`search_path=pg_catalog`** — a minimal, hardcoded search path containing no user schema, so it cannot be redirected by a caller's session `search_path` |
| All `FROM`/`JOIN` targets schema-qualified | yes | **yes** — every real table reference in the function body is `public.`-qualified; verified by parsing all `FROM`/`JOIN` targets out of `pg_proc.prosrc` (one apparent hit was `IS DISTINCT FROM candidate_source_ids`, a false positive, not a table reference) |
| `anon` EXECUTE | revoked | **false** |
| `authenticated` EXECUTE | revoked | **false** |
| `service_role` EXECUTE | revoked (per the migration's own `REVOKE ALL ... FROM PUBLIC, anon, authenticated, service_role`) | **false** |
| Live ACL | `{postgres=X/postgres}` only | **matches** |

The migration's own comment states *"Trigger invocation does not require direct EXECUTE, and this function is not an application RPC"* — the authors' own documented rationale for revoking `service_role` too, corroborating the empirical test below.

### Empirical trigger-invocation privilege test (performed before any REVOKE)

Per explicit instruction, this was run and required to pass before any of the six REVOKEs below were issued — the plan was to stop and report if it didn't.

Method: inside a single transaction, ending in `ROLLBACK` (nothing persisted — confirmed by re-querying `pg_proc` for the throwaway function name after rollback, count 0):

1. Created a session-temp table and a throwaway trigger function (`RETURNS trigger`, plain `LANGUAGE plpgsql`, no `SECURITY DEFINER` — matching the real functions' structure).
2. `REVOKE ALL ... FROM PUBLIC, anon, authenticated, service_role` on that function, and confirmed via `has_function_privilege` that `authenticated` genuinely had zero EXECUTE.
3. `GRANT INSERT` on the temp table to `authenticated`, then `SET ROLE authenticated` and performed a real `INSERT` that fires the trigger.
4. `RESET ROLE`.

Result:

```json
{
  "authenticated_had_execute_before_test": false,
  "insert_as_authenticated_succeeded_despite_no_execute": true,
  "insert_error_if_any": null,
  "row_landed": 1
}
```

The insert succeeded and the row landed despite `authenticated` holding zero EXECUTE on the trigger function. This directly answers the question empirically rather than by assumption: in this deployment, DML that fires a trigger does not require the invoking role to hold EXECUTE on the trigger function — Postgres's trigger-invocation path does not perform the same ACL check that a direct `SELECT fn()`/`PERFORM fn()` call would.

### Targeted least-privilege normalization — 6 of the 7 trigger-support functions

`check_extraction_dependency_closure` was excluded from this step: `20260810191912` (#108) had already revoked `anon`, `authenticated`, **and** `service_role` on it directly — stricter than what this normalization does to the other six, so re-issuing a REVOKE against it would be a no-op. Recorded here rather than silently skipped.

For the remaining six, `REVOKE EXECUTE ON FUNCTION public.<fn> FROM anon, authenticated` was issued individually per function (no `ALTER DEFAULT PRIVILEGES` touched — this is a per-object grant change only, so it does not affect any future function's inherited grants):

| Function | ACL before | ACL after |
| --- | --- | --- |
| `enforce_extraction_source_document_org()` | `{postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}` | `{postgres=X/postgres,service_role=X/postgres}` |
| `enforce_shadow_assignment_monotonic()` | `{postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}` | `{postgres=X/postgres,service_role=X/postgres}` |
| `verify_extraction_candidate_content()` | `{postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}` | `{postgres=X/postgres,service_role=X/postgres}` |
| `enforce_extraction_provenance_integrity()` | `{postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}` | `{postgres=X/postgres,service_role=X/postgres}` |
| `enforce_extraction_table_cell_dependency_edge()` | `{postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}` | `{postgres=X/postgres,service_role=X/postgres}` |
| `check_extraction_table_cell_reconstruction()` | `{postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}` | `{postgres=X/postgres,service_role=X/postgres}` |
| `check_extraction_dependency_closure()` (unchanged, already normalized by #108) | `{postgres=X/postgres}` | `{postgres=X/postgres}` |

`service_role` EXECUTE was **not** revoked on any of the six — only `anon`/`authenticated`. `service_role` is the only role that performs DML on these tables in production (via the `SECURITY DEFINER` RPCs or direct service-role writes), so its access is preserved and no production write path is affected.

### Post-REVOKE verification

- Both callable RPCs confirmed unaffected: `publish_extraction_step1_shadow(jsonb)` and `resolve_extraction_step1_source(jsonb)` — `anon=false, authenticated=false, service_role=true` for both, identical to Checkpoint 3.
- "All affected triggers still fire correctly" was not re-tested via a fresh real-table DML insert: constructing one requires satisfying the FK chain into `extraction_source_artifacts` (still 0 rows), and building throwaway rows through that chain to prove a point already proven synthetically was judged higher risk than value. Instead: (a) the empirical test above used a REVOKE-ALL-from-everyone state, which is stricter than what six of these functions now have (`service_role` still holds EXECUTE on all six) and structurally identical to what `check_extraction_dependency_closure` already has live in production; (b) `service_role`, the only role that performs real DML against these tables, was not touched. Both together make a further live-data test redundant rather than additionally informative. If a literal real-traffic proof is wanted, the natural point for that is after Phase 3 goes live, not while these tables remain empty shadow-only structures.
- Existing production data reconfirmed unchanged: `documents` 28, `document_relationships` 8, `projects` 7, `organizations` 4. `extraction_source_artifacts` still 0 rows. Total `public` base tables unchanged at 87 (no new tables in this checkpoint).
- Ledger: 52 → **54** rows, head `20260810191912`.

### Security posture after Checkpoint 4

```text
Phase 3 structures     deployed
P1 duplicate semantics  deployed
closure invariant       RLS-independent
callable RPCs           service-role-only
trigger helpers         least privilege
```

This is the posture the review chain (#107/#108, then this staged catch-up) was designed to reach before P2. Checkpoint 5 (P2 itself) is next, pending separate authorization.

## Phase 3 + P2 staged catch-up — Checkpoint 5 (P2 immutable source-artifact ingestion), 2026-08-11

Status: **SUCCESSFUL DIRECT APPLY.** Same pooler mechanism as Checkpoints 1–4 (`package.json`/`package-lock.json` verified unaffected).

File applied:

```text
supabase/migrations/20260811160000_p2_immutable_source_artifact_ingestion.sql
  sha256 caf15d568939c7d35cad21340bce7f158cfbb193fa552b2e20c80fae090a0703
```

### Preflight (run before apply)

Ran the migration's own conflict-detection query directly against production:

```sql
WITH conflicts AS (
  SELECT organization_id, source_document_id, storage_object_version
  FROM public.extraction_source_artifacts
  GROUP BY organization_id, source_document_id, storage_object_version
  HAVING count(*) > 1
)
SELECT count(*) FROM conflicts;
```

Result: **0 conflicting version groups** — expected, since `extraction_source_artifacts` was empty (0 rows, confirmed at every prior checkpoint since Checkpoint 1). Pre-apply state: ledger 54 rows, no `20260811160000` ledger row, `record_extraction_source_artifact_identity` absent, table columns `id,organization_id,source_document_id,source_sha256,storage_object_version,media_type_sniffed,byte_length,created_at` (pre-P2 set).

Apply output:

```text
OK (374ms): 20260811160000_p2_immutable_source_artifact_ingestion
```

### Structural verification

| Check | Expected | Actual |
| --- | --- | --- |
| Ledger rows | 55 | **55** |
| Ledger head | `20260811160000` | **`20260811160000`** |
| `storage_bucket` column | present | **present** |
| `storage_path` column | present | **present** |
| `identity_origin` column | present | **present** |
| `idx_extraction_source_artifacts_document_version` | unique, on `(organization_id, source_document_id, storage_object_version)` | **matches exactly** |
| `record_extraction_source_artifact_identity` | present | **present** |
| Owner | `postgres` | **`postgres`** |
| `SECURITY DEFINER` | true | **true** |
| `search_path` | fixed, empty | **`search_path=""`** |
| `anon` EXECUTE | false | **false** |
| `authenticated` EXECUTE | false | **false** |
| `service_role` EXECUTE | true | **true** |
| `extraction_source_artifacts` rows | 0 | **0** |
| Existing data (`documents`/`document_relationships`/`projects`/`organizations`) | 28/8/7/4 unchanged | **28/8/7/4** |
| Total `public` base tables | 87 (P2 adds no new table) | **87** |
| P1 constraint (`document_relationships_relationship_type_check`) | unchanged, includes `duplicate_of` | **unchanged** |
| `check_extraction_dependency_closure` | still `SECURITY DEFINER`, `search_path=pg_catalog`, ACL `{postgres=X/postgres}` only | **unchanged — no regression** |

### Functional verification — idempotency, conflict rejection, unique-index enforcement

All three tests ran inside one transaction against a real existing document (`18550bfc-c057-4aae-bfa3-db896e36edb0`, org `11111111-1111-1111-1111-111111111111`), using savepoints so an expected error didn't abort the whole probe, and ending in an unconditional top-level `ROLLBACK`. No test data persisted.

**Idempotent retry** (same payload called twice):

```json
{ "first_outcome": "newly_populated", "second_outcome": "already_populated", "same_artifact_id": true, "row_count_after_both_calls": 1 }
```

**Conflicting SHA for the same document/version** (second call, same `organization_id`/`source_document_id`/`storage_object_version`, different `source_sha256`):

```json
{ "first_outcome": "newly_populated", "second_call": { "threw": true, "code": "23514", "message": "immutable source artifact identity conflict" } }
```

Matches the modeled conflict exactly — fails closed with the reviewed error, not a generic exception.

**Direct unique-index enforcement** (bypassing the RPC entirely — a raw `INSERT` of a second row with the same `(organization_id, source_document_id, storage_object_version)` and a different SHA):

```json
{ "threw": true, "code": "23505", "constraint": "idx_extraction_source_artifacts_document_version" }
```

Confirms the invariant is enforced at the index level, not only inside the RPC — no direct-write path can create a conflicting identity even if it bypassed the recorder.

**Table state during and after every probe:**

```json
{ "rows_during_probe_before_final_rollback": 0, "rows_after_final_rollback": 0 }
```

`extraction_source_artifacts` never held a persisted row at any point in this checkpoint.

### No fresh-upload test or backfill performed

Per instruction, this checkpoint stops here. Checkpoint 6 (proving upload-time identity persistence end-to-end) is deliberately a separate, later authorization — it is the first point in this catch-up where new production application data is intentionally created. Per operator decision, Neenah (`c4c01db1-a722-44f4-a9e4-f9b29f542ac2`) remains untouched and reserved as the pre-P2 backfill benchmark; Checkpoint 6 will use a different, separately-designated small contract for the fresh-ingestion proof.

## Phase 3 + P2 staged catch-up — Checkpoint 6 (fresh-upload identity proof), 2026-08-11

Status: **VERIFIED — through the real production application, not direct SQL.** No backfill performed.

### Method

The upload route (`app/api/documents/upload`) requires a genuine Supabase Auth Bearer token resolved via `getActorContext` — a direct RPC call would not exercise the actual application code path, so this had to go through the deployed app. A session was obtained legitimately for the requesting operator's own account (`emartind8@gmail.com`, id `a6314323-6f0b-446e-ab32-7fbc88b34a19`, `role=admin` in org `11111111-1111-1111-1111-111111111111`, the same actor already attributed to every pre-existing `document_relationships` row) using Supabase's admin `generateLink` (magic link) + `verifyOtp` mechanism — the standard first-party mechanism for minting a real session server-side. No password was requested, entered, or stored; no new account was created; no other user's identity was used.

Production URL resolved via the Vercel API (`eightforge-os` project, team `ericanalysis-projects`): `https://eightforge-os.vercel.app`, matching the latest `READY`/`production` deployment.

A minimal, distinctive, inert 254-byte synthetic PDF was uploaded via a real `multipart/form-data` `POST /api/documents/upload` request with the obtained Bearer token — title `"P2 Checkpoint 6 Fresh Upload Proof"`, `documentType: "other"`, no `projectId` (org-level only), so it cannot be confused with any real operational document.

The session token was written to a local temp file only for the duration of the request and deleted immediately after; it was never logged, printed to this transcript, or committed. No project ID, credential, or secret was placed in production code — all values used were read from the existing local `.env.local` (already used identically at Checkpoints 1–5) or obtained transiently via the admin API call above.

### Application response

```json
{
  "ok": true,
  "doc": { "id": "8d828ac2-23ae-4dd2-ba1f-df5390d5221c", "title": "P2 Checkpoint 6 Fresh Upload Proof", "document_type": "other", "status": "uploaded" },
  "storagePath": "11111111-1111-1111-1111-111111111111/1786477690932-p2-checkpoint6-fresh-upload-proof.pdf",
  "sourceIdentity": {
    "status": "persisted",
    "sourceArtifactId": "c93619e8-09bf-49b2-b29b-68681763e827",
    "sourceSha256": "ef6086c2937c20a691d4b593d08ad8e9ed480b63298a6fa9c0eaf52c81404bee",
    "storageObjectVersion": "478356b9-d484-44e2-924e-9539fd441379:ab8c5d11-11dc-4693-80b5-615de196d95a",
    "outcome": "newly_populated"
  }
}
```

`sourceIdentity.status = "persisted"` — the identity was reported persisted, not `"unavailable"`. This is the field the upload route sets from `UploadedSourceArtifactIdentityResult`; an `"unavailable"` value here (with a `failure.code`) would have meant the RPC failed or storage versioning was unreadable, and would have been reported as a failure rather than treated as success.

### Record identifiers

| Field | Value |
| --- | --- |
| Document id | `8d828ac2-23ae-4dd2-ba1f-df5390d5221c` |
| Storage path | `11111111-1111-1111-1111-111111111111/1786477690932-p2-checkpoint6-fresh-upload-proof.pdf` |
| `extraction_source_artifacts` id | `c93619e8-09bf-49b2-b29b-68681763e827` |
| `source_sha256` | `ef6086c2937c20a691d4b593d08ad8e9ed480b63298a6fa9c0eaf52c81404bee` |
| `storage_object_version` | `478356b9-d484-44e2-924e-9539fd441379:ab8c5d11-11dc-4693-80b5-615de196d95a` |

### Database verification (read-only, plus one real idempotent RPC re-call)

| Check | Expected | Actual |
| --- | --- | --- |
| Exactly one `extraction_source_artifacts` row for this document | 1 | **1** |
| `source_document_id` matches | yes | **yes** |
| `organization_id` matches document tenant | `11111111-1111-1111-1111-111111111111` | **matches** |
| `storage_object_version` nonblank | yes | **yes** — `478356b9-...:ab8c5d11-...` |
| `source_sha256` populated and valid SHA-256 | 64 lowercase hex chars | **yes** — verified by regex, not eyeballed (`/^[0-9a-f]{64}$/`) |
| `storage_bucket`/`storage_path` match the actual uploaded object | yes | **yes** — cross-checked against `storage.objects` (`id=ab8c5d11-...`, same `bucket_id`/`name`) |
| `identity_origin` | `'upload'` | **`upload`** |
| `media_type_sniffed` / `byte_length` | `application/pdf` / 254 | **matches** the actual uploaded file exactly |
| Row created through the normal application path, not manually | yes | **yes by construction** — created via a real authenticated `POST` to the deployed app, not a direct `INSERT`; this is the entire reason the magic-link session was obtained rather than writing the row directly |
| Re-reading the same source does not create a second identity row | yes | **yes** — the RPC was called again for real (not rolled back) with the exact same values; returned `outcome: "already_populated"`, identical `source_artifact_id` and `created_at`; row count for this document remained **1** afterward. Structurally reinforced: `persistUploadedSourceArtifactIdentity`/`captureUploadedStorageObjectVersion` have exactly one call site in the entire non-test codebase (the upload route itself) — there is no other code path that could attempt a second write for this document |
| No unrelated `extraction_source_artifacts` rows appeared | — | **One additional row exists, explained, not an anomaly**: `extraction_source_artifacts` totaled 2 rows, not 1. The second (`28fa7819-...`) belongs to a different real document (`722d3aa7-...`, titled "IFB-24-44 Emergency Debris Removal..."), created by genuine concurrent production traffic at 19:41:55 UTC — six minutes *before* this checkpoint's upload (19:48:11 UTC) — through the same now-live upload path. This is expected: P2's upload-time hook is live for the whole application, not scoped to this test, so real organic uploads during this window correctly received their own identity rows too. Verified by timestamp and document identity, not assumed |
| Neenah still has no identity row | 0 | **0** — confirmed unchanged; remains a true pre-P2/backfill case |
| Existing production row counts otherwise unchanged | `document_relationships` 8, `organizations` 4 unchanged; `documents`/`projects` reflect real activity | **`document_relationships` 8, `organizations` 4 — unchanged.** `documents` 28→30 and `projects` 7→8: **only one of the two new documents is this checkpoint's** (`project_id=null`); the other document and project came from the same unrelated concurrent production activity noted above, not from this checkpoint |

### Assessment

Every check requested passed. The one deviation from a naive expectation — 2 rows instead of 1, `documents`/`projects` up by 2 instead of 1 — was investigated to a specific, verified cause (real concurrent production usage of the now-P2-enabled upload path) rather than assumed benign or silently absorbed into the report. Production is a live system with real traffic during this operation; counts for tables this checkpoint doesn't control can move for reasons unrelated to the checkpoint, and each such movement here was traced to an identifiable, legitimate source before being reported as "unchanged" or explained.

Checkpoint 7 (backfill authorization) is next, pending separate authorization.

## Phase 3 + P2 staged catch-up — Checkpoint 0 (baseline), 2026-08-11

Scope: baseline snapshot only. **No migration was applied. Production was queried read-only.**

Context: PR #109 (merged as `c8f4ddb`) added `20260811160000_p2_immutable_source_artifact_ingestion.sql`. A pre-deployment audit found production is missing the entire Phase 3 chain, so `extraction_source_artifacts` does not exist and P2 cannot apply standalone. See the audit summary below for the ordered delta.

Target project: `eightforge-os` / `jpzeckefppmiujwajgvk`.

### Baseline snapshot (read-only, `2026-08-11 18:02:26 UTC`)

| Metric | Value |
| --- | --- |
| Ledger rows (`supabase_migrations.schema_migrations`) | 44 |
| Ledger head | `20260719194453` |
| Repo head | `20260811160000` |
| `public.documents` | 28 |
| `public.document_relationships` | 8 |
| `public.projects` | 7 |
| `public.organizations` | 4 |
| `public` tables total | 46 |
| `extraction_%` tables | **0** |
| `public` functions matching `%extraction%` | **0** |

Relationship-type distribution (pre-P1-constraint):

```text
attached_to   7
supplements   1
```

Both values are within the 9-value set that `20260810145107_add_duplicate_document_relationship.sql` will enforce, so that `ADD CONSTRAINT` will validate cleanly against current data.

Latest production write across `decisions`, `documents`, `document_extractions`, `activity_events`, `execution_items`, `project_validation_findings`, `project_validation_runs`, `document_relationships`, `transaction_data_rows`: `2026-08-11 17:57:38 UTC` (6 of those tables written within the prior 24h — the Neenah upload and its processing).

### Backup precondition — NOT YET SATISFIED

`supabase backups list --project-ref jpzeckefppmiujwajgvk -o json` could not be run: no `SUPABASE_ACCESS_TOKEN` in the environment and `supabase login` requires interactive OAuth. Supabase CLI v2.84.2 is installed locally.

**Before Checkpoint 1, an operator must confirm and record here:**

- most recent production backup timestamp (dashboard or authenticated CLI);
- the resulting restore gap, measured against the `2026-08-11 17:57:38 UTC` latest-write timestamp above.

### Planned checkpoint sequence

Do not shortcut to Step 0 + P2. `20260810191912` (#108, RLS-independent closure hardening) references Step 3 tables (`extraction_table_chains`, `extraction_table_chain_segments`, `extraction_table_continuation_link_basis_fragments`, `extraction_table_section_rows`), so a Step-0-only path would leave the pre-hardening closure function in production with no way to apply #108. The safe unit is the Phase 3 chain through #108, then P2.

```text
Checkpoint 0  backup + baseline                        <- this entry
Checkpoint 1  20260723163517 step0, 20260724000000
Checkpoint 2  20260724010000 step1, 20260727000000
Checkpoint 3  20260727010000, 20260727020000, 20260727030000, 20260727040000
Checkpoint 4  20260810145107 (P1), 20260810191912 (#108)
Checkpoint 5  20260811160000 (P2)
Checkpoint 6  fresh post-P2 upload identity test
Checkpoint 7  backfill authorization (separate)
```

Apply mechanism remains direct `psql` per this runbook's established practice; `supabase db push` is not used, and ledger rows are inserted manually per applied file.

### Post-migration benchmark document (Neenah)

Recorded for Checkpoint 6 comparison. Not modified.

| Field | Value |
| --- | --- |
| Document id | `c4c01db1-a722-44f4-a9e4-f9b29f542ac2` |
| Project id | `ae896047-f6d3-4701-a567-6c7bfb52333c` |
| Organization id | `11111111-1111-1111-1111-111111111111` |
| `processing_status` / `operational_status` | `decisioned` / `Operationally clear` |
| `processed_at` | `2026-08-11 17:49:38 UTC` |
| Legacy `document_extractions` rows | 2 |
| P2 source identity | none, and not possible pre-migration (`extraction_source_artifacts` absent) |

Neenah is a valid pre-migration benchmark: an existing document with a live storage object and no source identity, i.e. backfill-eligible.

## Workspace-load performance indexes, 2026-07-07 (prior entry)

Status: PRODUCTION APPLY COMPLETE. The workspace-load performance indexes (`20260707000000_activity_events_project_created_index.sql`, `20260707000001_transaction_data_rows_pagination_sort_index.sql`) were applied and verified on 2026-07-07. The Phase B follow-up migration `20260623000004_document_status_recompute_triggers.sql` was applied and verified on 2026-06-24 through the IPv4 shared Supavisor session pooler. Earlier halted attempts remain recorded below for audit history.

## Workspace-load performance indexes, 2026-07-07

Branch and source:

- branch: `perf/parallelize-workspace-fetch-and-indexes`
- migrations: `20260707000000_activity_events_project_created_index.sql`, `20260707000001_transaction_data_rows_pagination_sort_index.sql`
- both are additive `CREATE INDEX IF NOT EXISTS` only — no column/table/constraint changes, no data writes.

Production connection: direct connection via `DATABASE_URL` from `.env.local` (`db.jpzeckefppmiujwajgvk.supabase.co:5432`) using a temporary `pg` client (`npm install --no-save pg`, removed after use; `package.json`/`package-lock.json` unaffected). The direct hostname resolved and connected successfully this time (no pooler workaround needed).

Pre-apply checks:

- Neither target index existed yet (`pg_indexes` query returned zero rows for both names).
- Table sizes at apply time: `activity_events` ~2,343 rows, `transaction_data_rows` ~9,983 rows (organization-wide) — small enough that a plain (non-`CONCURRENTLY`) `CREATE INDEX` was judged safe, consistent with the migration file's own reasoning.
- Confirmed `activity_events.project_id` column already exists on this database (so the earlier audit's "missing index" diagnosis applies; the earlier "missing column" theory does not, for this environment).

Apply output:

```text
--- Applying supabase/migrations/20260707000000_activity_events_project_created_index.sql ---
OK (278ms): CREATE
--- Applying supabase/migrations/20260707000001_transaction_data_rows_pagination_sort_index.sql ---
OK (1189ms): CREATE
```

Post-apply verification:

- Both indexes confirmed present via `pg_indexes`.
- Row counts unchanged post-apply (`activity_events` 2,343; `transaction_data_rows` 9,983) — confirms no data was touched.
- `EXPLAIN` against the live Golden Project (`437502f2-d46d-447f-81e3-f26fa7ba0c14`) confirmed the planner uses both new indexes:
  - `activity_events`: `Index Scan using idx_activity_events_org_project_created`, `Index Cond` on `organization_id` + `project_id`.
  - `transaction_data_rows`: `Index Scan using idx_transaction_data_rows_project_pagination_sort`, `Index Cond` on `project_id`, and **no separate Sort node** — the index fully satisfies the `ORDER BY invoice_date, source_sheet_name, source_row_number` pagination sort in-index.

## Phase B Follow-up Trigger Apply, 2026-06-24 America/New_York

Branch and source:

- branch: `state-machine-phase-b`
- HEAD: `8a91bfb1650b7e832aae2e4d73ab5bca2c7dc068`
- `origin/main`: `477f5f2d1ce778a672f21bd893c902218d3d6f47`
- divergence: `origin/main` is an ancestor of HEAD; the branch adds only `8a91bfb`
- migration SHA-256: `C2C18A41A5BE748EA34ED66F46BADEDE1F574C2ED2E3F93D25444BCD338FFDFF`

Production connection:

```text
postgresql://postgres.jpzeckefppmiujwajgvk:<REDACTED>@aws-0-us-west-2.pooler.supabase.com:5432/postgres?sslmode=require
```

The pooler resolved to IPv4 addresses `54.70.143.232`, `35.160.209.8`, and `44.238.118.41`; `SELECT 1` succeeded. The direct database hostname remained AAAA-only from this network.

Backup decision:

- Dashboard Backups retry was unavailable/hung and did not provide a fresher timestamp.
- Operator explicitly authorized proceeding with `2026-06-23 08:49:05 UTC` as the rollback point.
- The recorded restore gap was 463 `project_validation_findings` updates and 414 `execution_items` updates after that backup.
- The decision to proceed was based on the migration being additive: four `CREATE INDEX IF NOT EXISTS` statements, function definitions, and trigger replacement pairs; it contains no table/column/constraint drop, table alteration, or data backfill.

Exact direct-apply output:

```text
CREATE INDEX
CREATE INDEX
CREATE INDEX
CREATE INDEX
CREATE FUNCTION
CREATE FUNCTION
CREATE FUNCTION
CREATE FUNCTION
CREATE FUNCTION
CREATE FUNCTION
CREATE FUNCTION
DROP TRIGGER
DROP TRIGGER
CREATE TRIGGER
CREATE TRIGGER
CREATE FUNCTION
DROP TRIGGER
DROP TRIGGER
CREATE TRIGGER
CREATE TRIGGER
CREATE FUNCTION
DROP TRIGGER
DROP TRIGGER
CREATE TRIGGER
CREATE TRIGGER
CREATE FUNCTION
DROP TRIGGER
DROP TRIGGER
CREATE TRIGGER
CREATE TRIGGER
CREATE FUNCTION
DROP TRIGGER
DROP TRIGGER
CREATE TRIGGER
CREATE TRIGGER
CREATE FUNCTION
DROP TRIGGER
DROP TRIGGER
CREATE TRIGGER
CREATE TRIGGER
```

`psql` also emitted the expected `DROP TRIGGER IF EXISTS` notice for the previously absent review trigger. PowerShell classified that stderr notice as a native-command error after `psql` completed; direct catalog verification confirmed the migration completed: all 12 functions exist and all 12 expected triggers are enabled (`tgenabled = 'O'`).

The manual production ledger row was inserted and verified:

```text
20260623000004 | document_status_recompute_triggers
```

Real before/after trigger proof:

- finding: `757111b2-eacb-47b8-b802-a9822b85737b`
- check: `FINANCIAL_NTE_FACT_MISSING:445c7376-659a-4261-a445-d99585114b21`
- risk controls: severity `info`, exactly one attached document, not decision/action eligible, no linked decision/action
- finding mutation: `open` -> `resolved`; lifecycle state became `resolved`
- document: `6866832f-5126-435d-9329-f09bade970a8` (`310225302000_Executed_Contractor`)
- `documents.operational_status`: `Operationally clear` -> `Blocked`
- post-trigger persisted status matched `compute_document_operational_status_for_document`: `Blocked`
- status-direction clarification: resolving the inert `info` finding did not create the blocker; it fired the new recompute path, which surfaced three pre-existing open blocking decisions (critical/mismatch) and three pending workflow tasks already attached to the document. The old `Operationally clear` value was stale, so `Blocked` was the expected canonical result.

No additional decision or execution-item row was mutated. Those paths were verified structurally: the decision, workflow-task, finding, finding-evidence, execution-item, and review INSERT/UPDATE plus DELETE triggers all exist and are enabled.

Section 2 zero-diff re-confirmation:

```text
untouched_diff_count=0
touched_expected_diff_count=1
```

The sole expected row is the touched document: the older Section 2 simple resolver derives `Operationally clear`, while the new full resolver and persisted value are `Blocked`. Every untouched document remained zero-diff.

Williamson production-adjacent read-only gate:

```text
row_count=5063
total_cyd_ticket_grain=74617
total_extended_cost=815559.35
```

Result: Phase B plus the trigger follow-up are fully verified and ready to merge as one combined change.

## Prompt 3 Halted Direct-PSQL Attempt, 2026-06-23 America/New_York

No production writes were performed in this attempt. The explicit stop condition triggered before apply because the required recent production backup/snapshot timestamp was not confirmable from this shell.

Local checkout:

- branch: `main`
- HEAD: `64c08fd6a4bcbf9c8a6bcd0e57a13d32ac040742`
- origin/main: `64c08fd6a4bcbf9c8a6bcd0e57a13d32ac040742`
- Supabase CLI: `2.84.2`
- production project ref inferred from `NEXT_PUBLIC_SUPABASE_URL`: `jpzeckefppmiujwajgvk`
- direct `psql` binary on PATH: unavailable
- direct `psql` workaround validated: `docker run --rm --network host -e DATABASE_URL postgres:17-alpine psql "$url" ...`

Backup check command:

```powershell
$ErrorActionPreference='Continue'
Get-Content .env.local | ForEach-Object {
  if ($_ -match '^\s*([^#][^=]+)=(.*)$') {
    [Environment]::SetEnvironmentVariable($Matches[1].Trim(), $Matches[2].Trim(), 'Process')
  }
}
supabase backups list --project-ref jpzeckefppmiujwajgvk -o json
```

Exact backup check output:

```text
Access token not provided. Supply an access token by running supabase login or setting the SUPABASE_ACCESS_TOKEN environment variable.
Try rerunning the command with --debug to troubleshoot the error.
```

Direct `psql` read-only connection test:

```powershell
$ErrorActionPreference='Stop'
Get-Content .env.local | ForEach-Object {
  if ($_ -match '^\s*([^#][^=]+)=(.*)$') {
    [Environment]::SetEnvironmentVariable($Matches[1].Trim(), $Matches[2].Trim(), 'Process')
  }
}
$url = $env:DATABASE_URL
$env:DATABASE_URL = $null
docker run --rm --network host -e DATABASE_URL postgres:17-alpine psql "$url" -v ON_ERROR_STOP=1 -X -qAt -c "select current_database(), current_user;"
```

Exact output:

```text
postgres|postgres
```

Pre-apply production `schema_migrations` snapshot rechecked directly:

```text
20260309181926
20260309181940
20260309181952
20260310185106
20260311020231
20260311022733
20260311024745
20260312015444
20260316225536
20260317033024
20260328222259
20260328222316
20260328222320
20260328222329
20260329130403
20260602145406
20260602145431
20260608220804
20260609000002
20260609195900
20260609200014
20260609201018
```

Read-only live object checks:

```text
public|document_extractions
public|documents
public|organizations
public|project_validation_findings
public|project_validation_runs
public|projects
public|rules
public|signals
```

The following live checks were used to separate already-live manual drift from genuinely absent content:

```text
decision_feedback_columns|disposition|text
decision_feedback_columns|notes|text
decision_feedback_columns|reviewer_id|uuid
documents_columns|deleted_at|timestamp with time zone
documents_columns|document_type|text
index|idx_documents_active_by_organization_created_at|i
index|idx_documents_active_by_project_created_at|i
```

`documents_document_type_known_values_check` was not found live.

Final candidate direct-apply file list for the next attempt, pending backup confirmation, in filename order:

```text
supabase/migrations/20250310000000_missing_live_schema_baseline.sql
supabase/migrations/20260620000000_add_price_sheet_document_type.sql
supabase/migrations/20260621000000_migrate_legacy_rate_schedule_kind_override.sql
supabase/migrations/20260622155007_missing_live_schema_constraints_security_and_routines.sql
supabase/migrations/20260622180818_deterministic_org_select_policies.sql
```

Rationale:

- `20250310000000` is the PR #30 additive live-schema baseline file absent from the production ledger.
- `20260620000000` contains the `documents_document_type_known_values_check` constraint, which is absent live and absent from the 22-row ledger.
- `20260621000000` is the PR #28 legacy rate-schedule-kind override migration absent from the production ledger.
- `20260622155007` is the PR #30 completion migration for constraints, indexes, RLS, policies, routines, and triggers absent from the production ledger.
- `20260622180818` is the PR #30 deterministic policy replay migration absent from the production ledger.
- `20260611000000`, `20260613000000`, and `20260620001000` were not included in the direct-apply candidate list because their concrete schema effects checked in this attempt are already live; do not add ledger rows for those in this manual-new-content process unless a separate reconciliation decision is made.
- `20260611000001` is an empty migration file and has no production content to apply.

Required next step before any production write: confirm and record the recent production backup/snapshot timestamp from the Supabase dashboard or by rerunning `supabase backups list --project-ref jpzeckefppmiujwajgvk -o json` after `supabase login` or setting `SUPABASE_ACCESS_TOKEN`.

## Prompt 4 Successful Direct-PSQL Apply, 2026-06-23 America/New_York

Status: SUCCESSFUL DIRECT APPLY. Production was updated by direct `psql` only. `supabase db push` was not used.

Backup precondition:

- Most recent scheduled production backup confirmed by operator: `2026-06-22 08:47:41 UTC`, Physical.
- Read-only timestamp scans before write found no public-table or `auth.users` timestamps after that backup time.
- Restore-window note: a restore to the confirmed scheduled backup would lose any production data written after `2026-06-22 08:47:41 UTC`; no evidence of such writes was found in the checked timestamp columns before apply.

Dependency check for `20260620000000_add_price_sheet_document_type.sql`:

- Full file content only adds `documents_document_type_known_values_check` on `public.documents.document_type`.
- It does not reference, alter, or depend on `decision_feedback.disposition`, `decision_feedback.feedback_note`, `decision_feedback.reviewed_by`, `documents.deleted_at`, or the active-document indexes from the excluded migrations.
- Its only schema dependency is `public.documents.document_type`, which exists in the baseline/live schema.
- Therefore the final apply list remained unchanged.

Final file list applied, in filename order:

```text
supabase/migrations/20250310000000_missing_live_schema_baseline.sql
supabase/migrations/20260620000000_add_price_sheet_document_type.sql
supabase/migrations/20260621000000_migrate_legacy_rate_schedule_kind_override.sql
supabase/migrations/20260622155007_missing_live_schema_constraints_security_and_routines.sql
supabase/migrations/20260622180818_deterministic_org_select_policies.sql
```

Direct apply command family used for each file:

```powershell
$url = $env:DATABASE_URL
$env:DATABASE_URL = $null
docker run --rm --network host -v "${root}:/work" -w /work -e DATABASE_URL postgres:17-alpine `
  psql "$url" -v ON_ERROR_STOP=1 -X -f "/work/<migration-file>"
```

Manual ledger insert command family used after each successful file:

```powershell
docker run --rm --network host -e DATABASE_URL postgres:17-alpine `
  psql "$url" -v ON_ERROR_STOP=1 -X `
  -c "insert into supabase_migrations.schema_migrations (version, name) values ('<version>', '<name>') returning version, name;"
```

Exact raw outputs for the apply, ledger inserts, and verification were captured into:

```text
docs/runbooks/production-migration-apply-20260623-logs/20250310000000-apply.txt
docs/runbooks/production-migration-apply-20260623-logs/20250310000000-ledger.txt
docs/runbooks/production-migration-apply-20260623-logs/20260620000000-apply.txt
docs/runbooks/production-migration-apply-20260623-logs/20260620000000-ledger.txt
docs/runbooks/production-migration-apply-20260623-logs/20260621000000-apply.txt
docs/runbooks/production-migration-apply-20260623-logs/20260621000000-ledger.txt
docs/runbooks/production-migration-apply-20260623-logs/20260622155007-apply.txt
docs/runbooks/production-migration-apply-20260623-logs/20260622155007-ledger.txt
docs/runbooks/production-migration-apply-20260623-logs/20260622180818-apply.txt
docs/runbooks/production-migration-apply-20260623-logs/20260622180818-ledger.txt
docs/runbooks/production-migration-apply-20260623-logs/post-apply-verification.txt
docs/runbooks/production-migration-apply-20260623-logs/post-apply-verification-2.txt
docs/runbooks/production-migration-apply-20260623-logs/williamson-gate.txt
docs/runbooks/production-migration-apply-20260623-logs/williamson-ticket-grain-code-gate.txt
```

Ledger rows inserted:

```text
20250310000000 | missing_live_schema_baseline
20260620000000 | add_price_sheet_document_type
20260621000000 | migrate_legacy_rate_schedule_kind_override
20260622155007 | missing_live_schema_constraints_security_and_routines
20260622180818 | deterministic_org_select_policies
```

Post-apply ledger verification:

```text
20250310000000 | missing_live_schema_baseline
20260620000000 | add_price_sheet_document_type
20260621000000 | migrate_legacy_rate_schedule_kind_override
20260622155007 | missing_live_schema_constraints_security_and_routines
20260622180818 | deterministic_org_select_policies
```

Baseline table verification:

```text
public | document_extractions
public | documents
public | organizations
public | project_validation_findings
public | project_validation_runs
public | projects
public | rules
public | signals
```

Price-sheet document-type constraint verification:

```text
documents_document_type_known_values_check | c | convalidated=false | CHECK (...) NOT VALID
```

Rate-schedule-kind migration verification:

```text
legacy_count=0
canonical_count=1
```

The migration output for `20260621000000_migrate_legacy_rate_schedule_kind_override.sql` was:

```text
DO
psql:/work/supabase/migrations/20260621000000_migrate_legacy_rate_schedule_kind_override.sql:66: NOTICE:  Golden Project rate schedule kind override is already canonical
```

This means production was already in the canonical one-row state at apply time. The migration did not take the fresh-install no-op path. It also did not rewrite a legacy row during this run because there was no legacy row left to migrate.

RLS policy verification:

```text
public | rules   | rules_select_org   | SELECT | permissive | roles {-} | ((organization_id IS NULL) OR (organization_id = (SELECT up.organization_id FROM user_profiles up WHERE up.id = auth.uid())))
public | signals | signals_select_org | SELECT | permissive | roles {-} | (organization_id = (SELECT up.organization_id FROM user_profiles up WHERE up.id = auth.uid()))
```

Williamson production gate:

```text
persisted_run_id=7e37dac7-118e-48fa-83cf-b02c650675ff
script_exit_code=0
invoice 2026-002 billed_amount=534757.10
invoice 2026-003 billed_amount=280802.25
total_extended_cost=815559.35
total_cyd_ticket_grain=74617
```

The Golden validation runner exited successfully and persisted a run. It also logged non-core side-effect errors while trying to sync execution items / approval actions:

```text
syncExecutionItems: insert or update on table "project_validation_findings" violates foreign key constraint "fk_validation_action"
approvalActionEngine: workflow_tasks_source_check violations for requires_verification_review, flag_project, notify_operator
```

These side-effect errors were logged by the runner but did not change its exit code; the canonical Williamson ticket-grain/cost gate still held.

Operational rule going forward:

- This production ledger has significant pre-existing historical drift.
- `supabase db push` remains unsafe unless and until that historical drift is explicitly reconciled.
- For genuinely new committed migration content that is absent from production under every known historical mapping, the safe process is direct `psql` apply of the new SQL only, followed by manual insertion of new `supabase_migrations.schema_migrations` rows for the applied file versions/names.
- Do not touch, rewrite, repair, delete, or reorder the pre-existing 22 historical rows as part of this new-content-only process.

## Purpose

EightForge does not currently have an automated production migration-apply mechanism. The repo investigation confirmed there is no GitHub Action that applies migrations on push to `main`, no Vercel deploy hook that applies migrations, and no `postbuild` script that applies migrations. Production migration apply is therefore a deliberate manual action.

Do not automate this process without a separate reviewed decision. Production schema changes affect canonical truth, evidence anchoring, audit history, RLS behavior, validator state, and execution workflows.

## Confirm The Production Migration Delta

Confirmed process: compare the production `supabase_migrations.schema_migrations` table against the migration files committed on `main`. The output of this step is the exact list of migration versions committed in the repo but not yet applied to production.

Run this only with production read-only access until the apply step is explicitly approved.

1. Ensure the local checkout is on the reviewed `main` commit whose migrations are intended for production.

2. List committed migration versions from the repo:

```powershell
Get-ChildItem -LiteralPath .\supabase\migrations -Filter *.sql |
  Sort-Object Name |
  ForEach-Object {
    if ($_.BaseName -match '^([^_]+)') { $Matches[1] }
  }
```

3. Query production applied migration versions:

```sql
select version
from supabase_migrations.schema_migrations
order by version;
```

4. Diff the two lists. Any version present in `supabase/migrations/*.sql` but absent from `supabase_migrations.schema_migrations` is pending production apply.

Record the exact pending list here before applying:

```text
Prompt 2 halted attempt, 2026-06-22 late evening America/New_York.

Local checkout:
- branch: main
- origin/main: 64c08fd
- local HEAD after git pull --ff-only: 64c08fd
- Supabase CLI: 2.84.2
- production project ref inferred from NEXT_PUBLIC_SUPABASE_URL: jpzeckefppmiujwajgvk
- linked Supabase CLI project: not present in supabase/.temp; only supabase/.temp/cli-latest existed.
- Supabase management API auth: unavailable in this shell; `supabase projects list` failed with:
  Access token not provided. Supply an access token by running supabase login or setting the SUPABASE_ACCESS_TOKEN environment variable.

Pre-apply production schema_migrations snapshot:
20260309181926
20260309181940
20260309181952
20260310185106
20260311020231
20260311022733
20260311024745
20260312015444
20260316225536
20260317033024
20260328222259
20260328222316
20260328222320
20260328222329
20260329130403
20260602145406
20260602145431
20260608220804
20260609000002
20260609195900
20260609200014
20260609201018

Committed local migration versions absent from production by direct version comparison:
20250310000000
20250311000000
20250312000000
20250313000000
20250314000000
20250314000001
20250316000000
20250316000001
20250316000002
20250317000000
20260318000000
20260319000000
20260323000000
20260328000000
20260328000001
20260328000002
20260328000003
20260329000000
20260329010000
20260330000000
20260330000001
20260401000000
20260401010000
20260404000000
20260407000001
20260417000000
20260422000000
20260429000000
20260430000000
20260506000000
20260506001000
20260506002000
20260602000000
20260602001000
20260606000000
20260607000000
20260609000000
20260609000001
20260611000000
20260611000001
20260613000000
20260620000000
20260620001000
20260621000000
20260622155007
20260622180818

Production versions absent from local migrations:
20260309181926
20260309181940
20260309181952
20260310185106
20260311020231
20260311022733
20260311024745
20260312015444
20260316225536
20260317033024
20260328222259
20260328222316
20260328222320
20260328222329
20260329130403
20260602145406
20260602145431
20260608220804
20260609195900
20260609200014
20260609201018
```

## Apply Pending Migrations

Status: Prompt 2 halted before write. Do not run production apply until migration-history divergence is explicitly reconciled or an approved command path is established.

The expected command family was Supabase CLI migration push. The actual environment had no linked project metadata and no Supabase management API token, so `supabase db push --linked` was not a valid verified invocation in this shell. The only usable production database target available was `.env.local`'s `DATABASE_URL`, referenced via `$env:DATABASE_URL` so the secret did not enter command history or logs.

Read-only command discovery confirmed:

```powershell
supabase db --help
supabase db push --help
supabase projects list --help
supabase link --help
supabase migration list --help
supabase backups list --help
```

Safe dry run attempted:

```powershell
$ErrorActionPreference='Stop'
Get-Content .env.local | ForEach-Object { if ($_ -match '^\s*([^#][^=]+)=(.*)$') { [System.Environment]::SetEnvironmentVariable($Matches[1].Trim(), $Matches[2].Trim(), 'Process') } }
supabase db push --db-url "$env:DATABASE_URL" --dry-run
```

Exact dry-run output:

```text
DRY RUN: migrations will *not* be pushed to the database.
Connecting to remote database...
Remote migration versions not found in local migrations directory.

Make sure your local git repo is up-to-date. If the error persists, try repairing the migration history table:
supabase migration repair --status reverted 20260309181926 20260309181940 20260309181952 20260310185106 20260311020231 20260311022733 20260311024745 20260312015444 20260316225536 20260317033024 20260328222259 20260328222316 20260328222320 20260328222329 20260329130403 20260602145406 20260602145431 20260608220804 20260609195900 20260609200014 20260609201018

And update local migrations to match remote database:
supabase db pull
```

Result: halted before production write. No CLI prompt was answered and no migration was applied.

## Verify Success

Confirmed process: verify by querying production state again after apply, then spot-checking key schema objects introduced by the pending migrations.

1. Re-query applied migration versions:

```sql
select version
from supabase_migrations.schema_migrations
order by version;
```

Expected result:

```text
Not reached in Prompt 2 halted attempt. Production was not changed.
```

2. Confirm no committed migration remains pending by repeating the repo-vs-production diff from "Confirm The Production Migration Delta".

3. Spot-check key objects created or changed by the applied migrations. If this is the first baseline landing, include an `organizations` table existence check:

```sql
select table_schema, table_name
from information_schema.tables
where table_schema = 'public'
  and table_name in (
    'organizations',
    'projects',
    'documents',
    'document_extractions',
    'project_validation_runs',
    'project_validation_findings'
  )
order by table_name;
```

Add migration-specific object checks from the actual pending list:

```sql
-- Not reached in Prompt 2 halted attempt. Production was not changed.
```

4. Re-run the production-adjacent Williamson/Golden Project validation gate if applicable to the migration set.

Known local command shape for the Golden Project validation script:

```powershell
node scripts/run-golden-validation.mjs
```

Prompt 2 halted before apply; Williamson/Golden Project production verification was not run because there was no schema change to validate and the stop condition had already triggered.

## If The Apply Fails Partway

Status: confirmed risk. Prompt 2 did not fail partway through an apply; it failed during pre-write dry-run validation.

Do not assume all files roll back as one unit. Supabase/Postgres migration execution may wrap an individual SQL file in a transaction depending on CLI behavior and file contents, but this project should not rely on automatic transactionality across multiple migration files. If file N succeeds and file N+1 fails, production may be left at a partially advanced migration state.

Failure response:

1. Stop. Do not re-run blindly.
2. Capture the exact CLI output and the last successful version in `supabase_migrations.schema_migrations`.
3. Query the schema objects touched by the failed and immediately preceding migrations.
4. Decide between forward-fix, manual reconciliation, or Supabase migration repair using the same migration repair/manual reconciliation techniques already developed during the investigation.
5. Record every manual SQL statement or repair command used in this runbook before considering the incident closed.

Prompt 2 observed failure before production write, not partial production apply. The dry-run failure was:

```text
Remote migration versions not found in local migrations directory.
```

No partial-failure recovery was needed because no migration apply command was run.

## Authorization And Operating Rule

This is a deliberate, manual, reviewed production action. It should be run only by an operator with production Supabase access who has reviewed:

- the pending migration list
- the expected schema/data impact
- RLS and tenant-scoping implications
- validator, canonical truth, execution, and audit-history implications
- the rollback or forward-fix posture for the specific pending migrations

This process must not be hidden in CI, Vercel build/deploy, local `postbuild`, or any automatic hook unless EightForge separately decides to automate production migration apply with explicit safeguards.

## Placeholder vs Confirmed Summary

Confirmed now:

- No automated production migration apply was found in repo automation, Vercel hook evidence, or package scripts.
- Current production migration state should be checked by read-only query against `supabase_migrations.schema_migrations`.
- Pending migrations are computed by comparing production-applied versions with `supabase/migrations/*.sql` on reviewed `main`.
- Success verification must include a post-apply `schema_migrations` query and schema/object spot checks.
- This is a manual reviewed action, not an implicit deployment side effect.
- Cross-file transactionality must not be assumed; a partial apply may require repair or manual reconciliation.

Placeholders pending Prompt 2:

- backup timestamp from Supabase dashboard was not confirmed in this shell before halt.
- successful production apply command remains unconfirmed.
- exact post-apply migration state remains pending because production was not changed.
- migration-specific object checks remain pending because production was not changed.
- Williamson/Golden Project production verification remains pending for the next successful apply.
