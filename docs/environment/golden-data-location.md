# Golden Data Location Diagnostic

Date: 2026-06-07

Scope: read-only environment/data-location investigation. No code, migration, seed, or apply was performed.

## Verdict

The Williamson County / Aftermath Disaster Recovery Golden Project data currently lives in the configured Supabase project:

- Supabase URL: `https://jpzeckefppmiujwajgvk.supabase.co`
- Project row: `projects.id = 437502f2-d46d-447f-81e3-f26fa7ba0c14`
- Project name: `Golden Project`
- Organization: `11111111-1111-1111-1111-111111111111`
- Transaction dataset: `transaction_data_datasets.id = fc87b84a-fca6-4e28-a3fb-963d4c04369e`
- Transaction source document: `documents.id = 04e23a28-61a0-4abc-91ac-8c6f2db31ecf`, `ticket_query_20260404_191302.xlsx`

The configured Supabase environment is not empty as of this diagnostic. The earlier "empty environment" conclusion is stale or came from a different query shape / environment view.

## Configured Environment Contents

Read-only Supabase admin queries against `jpzeckefppmiujwajgvk` found:

| Table | Count / observed state |
|---|---:|
| `projects` | 2 |
| `documents` | 7 |
| `document_extractions` | 21 |
| `document_fields` | 43 |
| `transaction_data_datasets` | 1 |
| `transaction_data_rows` | 5,063 |
| `decisions` | 3 |
| `document_decisions` | 0 |
| `workflow_tasks` | 7 |
| `execution_items` | 337 |
| `activity_events` | 1,434 |
| `organizations` | 4 |

Matching project/document evidence:

- `Golden Project` has `validation_status = FINDINGS_OPEN`.
- `validation_summary_json.exposure.total_billed_amount = 815559.35`.
- Invoice `2026-002`: billed/supported/fully reconciled amount `534757.10`.
- Invoice `2026-003`: billed/supported/fully reconciled amount `280802.25`.
- Contract document: `Williamson Co TN Fern 0126_Williamson Co TN Aftermath Fern 0126_Contract and Price Sheet_1`.
- Invoice documents include `Aftermath-Williamson Co invoice ... 2026-002` and `Aftermath-Williamson Co invoice ... 2026-003`.

Transaction dataset evidence:

- `row_count = 5063`
- `total_extended_cost = 815559.35`
- `total_transaction_quantity = 216610`
- `summary_json.total_cyd = 215729`
- `date_range_start = 2026-03-30`
- `date_range_end = 2026-04-02`

Operational row labels observed include `Williamson Co TN Aftermath Fern 0126`, `Williamson Co TN COUNTY Fern 0126`, `Nolensville`, `Ag Center DMS`, `Grassland Park DMS`, and `Solid Waste Landfill FDS`.

## Ask Harness Data Source

The Phase 3 Ask harness is not reading a checked-in Williamson fixture in this checkout.

The source is `scripts/ask/phase3Diagnostic.ts`, run via `scripts/ask/vitest.phase3.config.ts`. Its precondition gate imports `getSupabaseAdmin()` from `lib/server/supabaseAdmin.ts`, then reads live Supabase tables:

- `projects`
- `documents`
- route-equivalent project truth through `retrieveProjectTruth`
- portfolio/operations models through `buildPortfolioCommandCenter` and `loadOperationalQueueModel`

The harness identifies Golden with this live query logic:

- project name contains `Williamson`, or
- project name contains `Golden Project` and `validation_summary_json` contains `Aftermath`.

The prior 60/60 reference is recorded in `docs/ask/selector-readnotcompute-audit.md` and `docs/ask/buildPrompt1-verification.md`. Those docs mention `scripts/ask/artifacts/phase3-diagnostic-log.json` from 2026-06-04, but the artifact files are not present in this working tree.

## Mismatch Explanation

The current mismatch is not "local fixture has Golden, live Supabase is empty." Current evidence shows live Supabase has Golden.

Most likely explanations for the previous failures:

1. Temporal state drift: Golden data may have been loaded or restored after the earlier grain/FK passes.
2. Query mismatch: searching project names for `Williamson` / `Aftermath` misses the live row because the project is named `Golden Project`; the Williamson/Aftermath labels are in documents and `validation_summary_json`.
3. Schema mismatch: stale transaction queries that expect non-existent columns such as dataset `name` or row `dataset_id` will incorrectly report absence. The live schema uses `document_id`, `project_id`, `summary_json`, and row-level `record_json` / `raw_row_json`.
4. Branch/CLI visibility issue: Supabase CLI branch and migration commands timed out locally, so connector/CLI visibility should not be treated as proof that only main exists.

## Grain Acceptance Check Location

The grain fix acceptance check should be run against the live canonical Golden dataset:

- `transaction_data_datasets.id = fc87b84a-fca6-4e28-a3fb-963d4c04369e`
- `transaction_data_rows.project_id = 437502f2-d46d-447f-81e3-f26fa7ba0c14`
- source workbook document `04e23a28-61a0-4abc-91ac-8c6f2db31ecf`

I did not find a persisted field literally named `County pile`.

Closest checked aggregates:

- `Solid Waste Landfill FDS`: `45` rows, `4121` CYD, `16442.25` extended cost.
- `Williamson Co TN COUNTY Fern 0126`: `825` rows, row-sum `31011` CYD, ticket-dedup `10337` CYD.
- `TRACKING ONLY COUNTY ...`: `275` rows, `10337` CYD.
- `Nolensville`: `25` rows, row-sum `8652` CYD, ticket-dedup `4202` CYD.

Therefore the 4,186 check can be run against the live Golden transaction rows, but the exact filter needs the intended business label for "County pile." It is not currently a direct persisted label in the checked columns.

## FK Migration Apply-Path Question

No apply was performed.

Local migration present:

- `supabase/migrations/20260606000000_repoint_decision_feedback_fk_to_decisions.sql`

The migration file records prior read-only preflight on `jpzeckefppmiujwajgvk`:

- `decision_feedback` rows: `0`
- rows resolving in `document_decisions`: `0`
- rows resolving in `decisions`: `0`
- would orphan under `decisions`: `0`
- current FK: `decision_feedback_decision_id_fkey -> document_decisions`
- classification: `State C`, empty feedback table, FK-only/cosmetic repoint

Dev/preview branch state could not be confirmed from this machine. These commands timed out:

- `npx supabase --version`
- `npx supabase branches list --project-ref jpzeckefppmiujwajgvk --experimental`
- `npx supabase migration list --linked`

Apply-path options to decide later:

1. Use a Supabase dev/preview branch if branch visibility is restored.
2. Use a disposable cloned project/database if no branch exists.
3. If no safe lower environment is available, run only read-only preflight against main and defer the FK apply until an approved maintenance path exists.

## Acceptance Checklist

- [x] `docs/environment/golden-data-location.md` produced.
- [x] Configured Supabase environment contents recorded.
- [x] Passing Ask harness data source identified by name.
- [x] Mismatch explained.
- [x] Grain check location identified.
- [x] Dev-branch / apply-path options recorded.
- [x] No code, migration, fix, or apply performed.
