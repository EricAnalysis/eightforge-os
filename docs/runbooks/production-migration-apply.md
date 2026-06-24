# Production Migration Apply Runbook

Status: PRODUCTION APPLY COMPLETE. The Phase B follow-up migration `20260623000004_document_status_recompute_triggers.sql` was applied and verified on 2026-06-24 through the IPv4 shared Supavisor session pooler. Earlier halted attempts remain recorded below for audit history.

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
