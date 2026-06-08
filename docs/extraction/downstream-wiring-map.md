# Downstream Wiring Map — Every Surface, What It Reads, Whether It's Correct

**Status:** READ-ONLY audit. No code, no fix, no surface change. This map scopes the downstream fix work.
**Date:** 2026-06-07
**Root cause class:** `ui_consumption_issue` + `state_synchronization_issue`
**Source of truth used for cross-check:** `docs/extraction/cyd-grain-confirmation.md` (live Williamson values) and `docs/extraction/grain-verification.md`.

---

## TL;DR — one mis-wire explains almost everything

The Facts/Evidence tab and the spreadsheet review/Forge panels are produced by the **same** function (`buildDocumentIntelligenceViewModel`, `lib/documentIntelligenceViewModel.ts:5521`) from the **same** inputs — but they read **two different sources**:

- **Fact Ledger** (`model.facts` / `model.groups`) is built **only from the extraction blob** `preferredExtraction.data` (via `extractNode` → `normalizeNode` → `buildAdditionalFacts`). It **never looks at `params.transactionRows`**.
- **Spreadsheet Review dataset** (`model.spreadsheetReviewDataset`) is built from `params.transactionRows`, reading canonical values out of **`raw_row_json`** (`toSpreadsheetReviewDataset`, line 1525; `raw_row_json` merge at line 1545–1549).

For the Williamson dataset the extraction blob carries **no** spreadsheet summary (canonical truth now lives in `transaction_data_rows.raw_row_json`; `transaction_data_summaries` has **0 rows**). So every Dataset-Summary fact the Fact Ledger tries to show resolves to null → **MISSING / 0 / $0**, while the review surface (and Forge truth) recompute the same numbers correctly from the rows.

**Therefore:** the Facts-tab `MISSING/0/$0` block is a single **MIS-WIRED** consumer (Fact Ledger reads the blob, not the canonical rows). The `$`-on-counts (`Total Tickets: $0`, `Count $5,063`) is a separate **DISPLAY-BUG** in `inferValueType`. `Total CYD` is genuinely **FACT-ABSENT**. `Resolved Volume = 215,729` is **RECOMPUTING** (row-grain). These four causes account for the full anomaly set.

---

## STEP 1 — Downstream consumer enumeration

| Area | Surface / component | Backing builder | Reads from |
|---|---|---|---|
| Workspace | **Fact Ledger** — Dataset Summary, Grouped Review Tables, Flags/Outliers, Row-Level Drilldown, Financials, References, Extracted Signals, Additional Extracted Fields (`components/document-intelligence/FactLedger.tsx`) | `buildDocumentIntelligenceViewModel` → `facts`/`groups` | extraction **blob** `preferredExtraction.data` |
| Workspace | **SpreadsheetReviewSurface** — KPI strip, By-Material / By-Site / By-Disposal / By-Service-Item / By-Rate-Code, Risk, Invoice readiness (`components/document-intelligence/SpreadsheetReviewSurface.tsx`) | same model → `spreadsheetReviewDataset` | `transactionRows.raw_row_json` (+ `transaction_data_summaries.summary_json` if present) |
| Workspace | Extraction tab, Insights tab | same model facts/diagnostics | extraction blob |
| Project (Forge) | **Transaction Truth panel** (Total Transaction Rows, Unique Tickets, Resolved Volume, Eligibility, Workbook Invoiced Amount) | `projectFacts.ts` → `resolveTransactionTruthRows` (line 3687) → `buildCanonicalTransactionSummaryFromRows` (line 2934) | `transaction_data_rows` `record_json`/`raw_row_json` |
| Project (Forge) | Project Operations Overview cards | `project_operations_overview` built in `buildCanonicalTransactionSummaryFromRows` (line 3009) | row-backed (raw_row) |
| Project (Forge) | Material Flow (By Disposal Site / Site Type / Material / Service Item), Cost Drivers (By Rate Code), Risk Review, Invoice Readiness, Validation Truth | `spreadsheetReviewDataset` grouped rows + `projectFacts` grouped builders | mixed (see Step 2) |
| Portfolio / Command Center | `app/api/portfolio/summary/route.ts`, `app/api/portfolio/overview/route.ts` → `lib/server/portfolioCommandCenter.ts` | `project_approval_snapshots` | pre-aggregated `blocked_amount` / `at_risk_amount` (amounts + finding counts only) |
| Ask | `selectProjectTicketValidation`, `selectProjectInvoiceSupport` (`lib/ask/selectors/*`) | `resolveCanonicalProjectValidationSnapshot` / `resolveCanonicalProjectFacts` | canonical `projectFacts` (read-through, no aggregation) |

---

## STEP 2 — Consumer × field trace and classification

Failure modes: **CORRECT** · **FACT-ABSENT** (canonical fact doesn't exist) · **MIS-WIRED** (fact exists, surface reads wrong/empty source) · **RECOMPUTING** (surface computes it instead of reading a canonical fact) · **DISPLAY-BUG** (value read fine, rendered wrong).

### Workspace — Fact Ledger (Dataset Summary group)

These facts are flattened from the blob. The "Dataset Summary" group matches keys `row_count`, `total_*`, `distinct_*`, `eligible_count`, `ineligible_count` (`GROUP_DEFINITIONS.spreadsheet`, line 2307–2328). Because the blob has none of them for Williamson, each is synthesized as a `missing` fact, and `formatFactValue(null, …)` returns the literal string `"Missing"` (line 2695).

| Surface | Field | Displayed | Real value | Source it reads | Mode | Notes |
|---|---|---|---|---|---|---|
| Fact Ledger | Total Extended Cost | `Missing` | **$815,559.35** | blob `total_extended_cost` (absent) | **MIS-WIRED** | Exists in `raw_row_json.Extended Cost`; the review surface recomputes it correctly (RECOMPUTING). Ledger never reads rows. `inferValueType` types it `currency` (label correct). |
| Fact Ledger | Transaction Row Count (`row_count`) | `0` | **5,063** | blob `row_count` (absent) | **MIS-WIRED** | Real count is `transactionRows.length`. `row_count` does **not** match the currency regex (line 2674) so it renders as a plain number — hence `0`, not `$0`. |
| Fact Ledger | Total Tickets | `$0` | **2,388** | blob `total_tickets` (absent) | **MIS-WIRED** + **DISPLAY-BUG** | Value missing → `0`; `inferValueType` matches `/total/` → forces `currency` → renders `$0`. Double fault. |
| Fact Ledger | Total CYD | `Missing` | **none persisted** (row-grain recompute = 215,729; ticket-grain target = 74,737) | blob `total_cyd` (absent) | **FACT-ABSENT** | No canonical CYD fact exists anywhere (`transaction_data_summaries` empty, no CYD column). Grain fix builds it. Would also be DISPLAY-BUG if shown (`/total/`→currency on a volume). |
| Fact Ledger | Total Transaction Quantity | `Missing`/`$…` | row-sum | blob (absent) | **MIS-WIRED** + **DISPLAY-BUG** | `/total/`→currency on a quantity. |
| Fact Ledger | Eligible / Ineligible count, distinct_* | `Missing`/`0` | recomputable | blob (absent) | **MIS-WIRED** | Same blob-vs-rows split. |

### Workspace — Fact Ledger (other groups)

| Group | Field(s) | Mode | Notes |
|---|---|---|---|
| Grouped Review Tables | `grouped_by_*`, `dms_fds_lifecycle_summary` | **MIS-WIRED** | Blob-sourced; empty for Williamson. (Forge recomputes some of these — see "renders fine" anomaly.) |
| Flags And Outliers | `outlier_rows`, `rows_with_*`, `*_review` | **MIS-WIRED** | Blob-sourced; empty. |
| Row-Level Drilldown | `transaction_data_records` | **MIS-WIRED** | Blob-sourced; the 5,063 rows live in `transactionRows`, which the ledger ignores. |
| References / Extracted Signals / Additional Extracted Fields | generic flattened keys | **CORRECT** (mechanism) | These render whatever the blob has; not transaction-truth, so not implicated except where empty. |

### Workspace — SpreadsheetReviewSurface (reads `spreadsheetReviewDataset`)

| Field | Displayed | Real | Source it reads | Mode | Quoted read |
|---|---|---|---|---|---|
| Total Extended Cost (KPI) | correct | $815,559.35 | `sumRecordNumberField(records,'extended_cost')` fallback | **RECOMPUTING** (correct) | line 1782–1788: `?? sumRecordNumberField(records,'extended_cost')` — amounts at row grain are correct. |
| Total Tickets (KPI) | correct-ish | 2,388 | `distinctTransactionCount` fallback | **RECOMPUTING** | line 1733–1738: `summary?.total_tickets ?? … ?? distinctTransactionCount`. Distinct on `record.transaction_number` from raw rows. |
| Total CYD (KPI) | blank | none | `summary?.total_cyd_ticket_grain ?? … ?? null` | **FACT-ABSENT** | line 1739–1745 — no canonical CYD and the KPI deliberately does **not** row-sum CYD, so it shows null rather than an inflated number. |
| Total Net Tonnage (KPI) | 0/blank | none (all NULL) | `sumRecordNumberField(records,'net_tonnage')` | **FACT-ABSENT** | line 1675–1679 — field carries no data in Williamson. |
| Material Flow / By-Site / By-Disposal / By-Rate-Code tables | empty | non-empty | `canonicalSummary.grouped_by_* ?? legacyExtraction…` | **FACT-ABSENT** (on this surface) | lines 1593–1645. `canonicalSummary` (summary_json) is empty AND `legacyExtraction` is nulled when rows are present (`hasNormalizedDatasetTables` → line 1557). No recompute-from-rows path for groups here, so the workspace grouped tables are empty — matching the "Grouped-by tables: MISSING" anomaly. |

### Project (Forge) — Transaction Truth panel (`resolveTransactionTruthRows`, line 3687)

This path **does** read the rows (`readProjectRowBackedTransactionSummary` → `buildCanonicalTransactionSummaryFromRows`, which reads `raw_row` via the ticket-grain helpers). This is why "project surfaces render them fine."

| Field | Displayed | Real | Source it reads | Mode | Quoted read |
|---|---|---|---|---|---|
| Total Transaction Rows | 5,063 | 5,063 | `dataset.row_count` (= `records.length`) | **RECOMPUTING** (correct) | line 3705 `readValue: (dataset) => dataset.row_count`. |
| Unique Tickets | 2,388 | 2,388 | `overview?.total_tickets` | **RECOMPUTING** (correct) | line 3710 — distinct `ticketGrainKey` from raw_row. |
| Resolved Volume | **215,729 CYD** | ticket-grain target 74,737 | `total_cyd_ticket_grain ?? total_cyd` | **RECOMPUTING** (inflated) | line 3713–3723. Self-computed from rows; the `?? total_cyd` fallback is row-grain. Grain fix corrects this to ticket grain. |
| Eligibility | computed | computed | `eligible_count`/`ineligible_count` | **RECOMPUTING** | line 3724–3735. |
| Workbook Invoiced Amount | correct | $815,559.35 (full)/invoiced subset | `total_invoiced_amount` | **RECOMPUTING** (correct) | line 3736–3740 — amounts row-grain are correct. |

### Project (Forge) — Project Operations Overview & grouped tables

`buildCanonicalTransactionSummaryFromRows` builds `project_operations_overview` and `grouped_by_rate_code` / `grouped_by_invoice` from rows (lines 2977–3035). It does **not** build `grouped_by_material` / `grouped_by_site_type` / `grouped_by_disposal_site` (overview hard-codes `distinct_site_type_count: 0`, `distinct_disposal_site_count: 0`, lines 3030–3031).

| Field | Mode | Notes |
|---|---|---|
| Cost Drivers — By Rate Code | **RECOMPUTING** (correct for amounts) | Built from rows; amounts row-grain are correct. |
| Material Flow — By Material / Site Type / Disposal Site | **FACT-ABSENT** | Not built in the row-backed summary; site/disposal group counts are zeroed. |
| Operations Overview CYD card | **RECOMPUTING** | `total_cyd_ticket_grain` now wired (line 3013–3015); displayed legacy value reflects row-grain until the fix lands end-to-end. |

### Portfolio / Command Center

| Field | Source | Mode | Notes |
|---|---|---|---|
| `totalRequiresVerification`, `totalAtRisk`, blocked/at-risk rollups | `project_approval_snapshots.blocked_amount/at_risk_amount`, summed across projects | **CORRECT** (portfolio-safe aggregate) | `portfolio/summary/route.ts:53–71`, `portfolioCommandCenter.ts:158–311`. Amounts only; never touches CYD or `raw_row_json`, so insulated from the split. |
| `totalQuantityMismatch` etc. | finding **counts** from snapshots | **CORRECT** | These are validator finding counts, not CYD totals. |

### Ask selectors

| Selector | Source | Mode | Notes |
|---|---|---|---|
| `selectProjectTicketValidation` | `resolveCanonicalProjectValidationSnapshot` + validator findings | **CORRECT** (read-through) | `projectTicketValidation.ts` — text-only, no aggregation; header comment: "reads canonical truth, never produces it." Inherits whatever `projectFacts` resolves; not on the blob path. |
| `selectProjectInvoiceSupport` | `resolveCanonicalProjectFacts` | **CORRECT** (read-through) | Same; reads canonical project facts, no recompute. |

---

## STEP 3 — The "N facts mapped / M missing" mapping layer

There is **no separate persistence** behind the mapped/missing counts. The "mapping layer" is a **render-time computation** in the view-model builder:

1. The set of *expected* spreadsheet fields is the schema list `FIELD_KEY_ALIASES.spreadsheet` (`documentIntelligenceViewModel.ts:2045–2093`: `row_count`, `total_tickets`, `total_cyd`, `total_extended_cost`, …).
2. Actual facts are flattened from the **blob** (`buildRawSourceMap` + `buildAdditionalFacts`, lines 3558–3562, 3906–3928).
3. Expected-but-absent fields become **synthetic `missing` facts** (`buildSyntheticMissingFacts`, line 4059) or carry `reviewState === 'missing'` when their value is null (`factState` → `'missing'`, line ~3792).
4. The Fact Ledger's per-group header recomputes `factCount` / `missingCount` live from `fact.reviewState === 'missing'` (`FactLedger.tsx:643–644`). The "58 mapped / 13 missing"-style counts are exactly `factCount` vs `missingCount`.

**Why facts that exist downstream ($815,559.35) show as "missing" here:** the mapping layer only ever inspects the **extraction blob**, never `transaction_data_rows`. The value exists in `raw_row_json` and is reachable by the review surface, but the ledger's expected-vs-blob diff has no line of sight to the rows, so it reports the field "missing." It is therefore the **render-time computation failing against an empty source** — *not* an unpopulated persistence and *not* a lookup against `transaction_data_summaries` (the ledger doesn't query that table at all). This layer is the prime suspect for the Facts-tab MISSING block, and it is fixed by pointing the ledger's spreadsheet facts at the same row-backed summary the review surface/Forge already use.

---

## STEP 4 — Typed-column vs `raw_row_json` split, per surface

Confirmed in `cyd-grain-confirmation.md`: typed columns `cyd`, `net_tonnage`, `mileage`, `project_name` are largely **NULL**; canonical values live in `raw_row_json` (`CYD`, `Net Tonnage`, `Extended Cost`, `Ticket No`, …).

| Surface | Reads | Side | Result |
|---|---|---|---|
| **Fact Ledger (Dataset Summary etc.)** | extraction blob (neither typed columns nor rows) | **blob** | MISSING/0 — worst case; doesn't even reach the rows. |
| **SpreadsheetReviewSurface** | `raw_row_json` (merged to `raw_row`, line 1545–1549) for amounts/tickets; typed `record.net_tonnage` for tonnage | **raw_row_json** (mostly) | Correct for amounts/tickets; tonnage null because field has no data. |
| **Forge Transaction Truth / Operations Overview** | `raw_row` via ticket-grain helpers (`ticketGrainKey`, `buildTicketGrainQuantityFacts` read `record.raw_row` keys `['CYD']` etc., `normalizeTransactionData.ts:331,343,374`) | **raw_row_json** | Correct grain logic; Resolved Volume still shows row-grain via the `?? total_cyd` fallback / pre-fix path. |
| `normalizeTransactionProjectionRow` typed reads (`cyd: readNumber(record.cyd)`, line 2910) | typed column from `record_json` | **typed (NULL)** | These typed reads resolve to null for Williamson; the ticket-grain helpers that read `raw_row` are what actually produce CYD. |
| **Ask selectors** | canonical `projectFacts` (read-through) | n/a | Inherit Forge correctness; no direct column read. |
| **Portfolio** | snapshot amount columns | n/a | Not transaction rows; insulated. |

**Takeaway:** the single split (blob/typed-NULL vs `raw_row_json`) explains the MISSING/0 anomalies. The Fact Ledger is on the wrong side (blob); the review/Forge surfaces are on the right side (raw_row_json). One re-point fixes the ledger.

---

## STEP 5 — Display / unit bug catalog (render bugs, separate from wiring)

| # | Bug | Where | Cause | Fix surface |
|---|---|---|---|---|
| D1 | `$` on count fields — `Total Tickets: $0`, `Count $5,063` | Fact Ledger via `inferValueType` | `inferValueType` regex `/(amount\|total\|sum\|…)/i` matches any key containing **`total`** and forces `valueType='currency'` (`documentIntelligenceViewModel.ts:2674`). Counts like `total_tickets` get a `$`. | Exclude count keys (`total_tickets`, `total_transaction_quantity`, `*_count`, `row_count`) from the currency regex, or whitelist count fields to `number`. |
| D2 | `$` on volume fields — `Total CYD` would render as currency | same | `total_cyd` matches `/total/` → currency; CYD is a volume (unit `CYD`), not money. | Same regex fix; give CYD a `quantity`/unit-aware type with `CYD` suffix. |
| D3 | CYD shown without unit elsewhere | Forge Resolved Volume appends `CYD` manually (`projectFacts.ts:3770`); the ledger would not | Unit is hard-coded per surface instead of carried on the fact's value type. | Centralize a `quantity` value type carrying `unitLabel`. |
| D4 | `Missing` literal vs `0` inconsistency | `formatFactValue(null,…)` returns string `"Missing"` (line 2695) while numeric-absent paths show `0` | Two different "no value" renderings for the same root cause (blob empty). | Cosmetic; resolves once D1/wiring fixed. |

These are independent of the wiring fix: even after the ledger reads correct values, `total_tickets` would still render as `$2,388` until `inferValueType` is corrected.

---

## SUMMARY — counts per failure mode and prioritized fix list

### Counts per failure mode

| Mode | Count (consumer × field instances) | Representative instances |
|---|---|---|
| **MIS-WIRED** | ~9 | Fact Ledger: Total Extended Cost, Transaction Row Count, Total Tickets, Total Transaction Quantity, eligible/ineligible, Grouped Review Tables, Flags/Outliers, Row-Level Drilldown |
| **FACT-ABSENT** | ~5 | Total CYD (ledger + review KPI), Net Tonnage, workspace grouped tables, Forge Material/Site/Disposal groups |
| **RECOMPUTING** | ~7 | Review KPIs (Extended Cost, Tickets), Forge Truth panel (Rows, Unique Tickets, Resolved Volume=inflated, Invoiced Amount), Cost Drivers By-Rate-Code |
| **DISPLAY-BUG** | ~4 | `$` on Total Tickets, `$` on Total Transaction Quantity, `$`/no-unit on Total CYD, `Missing`/`0` inconsistency |
| **CORRECT** | portfolio amount rollups, Ask selectors (read-through) | — |

### Prioritized fix list, grouped by cause (fix once → many surfaces resolve)

1. **[ROOT — fix once, resolves the whole Facts-tab MISSING block] Re-point the Fact Ledger's spreadsheet facts at the row-backed canonical summary.** The ledger must read the same `buildCanonicalTransactionSummaryFromRows(transactionRows)` the review surface/Forge already use, instead of the extraction blob, for the Dataset Summary / Grouped / Flags / Drilldown groups. This single change clears: Total Extended Cost MISSING, Transaction Row Count 0, Total Tickets 0, grouped/flags/drilldown MISSING. (MIS-WIRED group.)
2. **[GRAIN — separate task, already scoped in `cyd-grain-confirmation.md`] Build the canonical ticket-grain CYD / net-tonnage / mileage / diameter facts and persist them in the dataset summary; make every surface READ them.** This resolves the FACT-ABSENT `Total CYD` and corrects the RECOMPUTING `Resolved Volume` (215,729 → 74,737) and the inflated grouped volumes. Keep amounts at row grain.
3. **[DISPLAY — small, independent] Fix `inferValueType` (`documentIntelligenceViewModel.ts:2674`)** so `total_tickets`, `total_transaction_quantity`, `row_count`, and `*_count` are typed as counts (and `total_cyd` as a unit-bearing quantity), not currency. Removes the `$`-on-count/volume bugs regardless of the wiring fix.
4. **[GAP — medium] Add a recompute-from-rows path for the workspace grouped tables** (By-Material / By-Site / By-Disposal) in `toSpreadsheetReviewDataset`, or build those groups in `buildCanonicalTransactionSummaryFromRows`, so the workspace matches Forge. (FACT-ABSENT on the workspace side only.)

Items 1 and 3 together fully explain and clear the live `MISSING / 0 / $0` anomalies; item 2 is the already-confirmed grain fix; item 4 closes the remaining workspace grouped-table gap.

---

## Cross-check against known truth

- [x] **Total Extended Cost $815,559.35 exists** → Fact Ledger shows MISSING ⇒ classified **MIS-WIRED** (ledger reads empty blob; value lives in `raw_row_json`, recomputed correctly by the review surface). ✅
- [x] **Transaction Row Count 5,063 exists** → Fact Ledger shows 0 ⇒ classified **MIS-WIRED** (real count = `transactionRows.length`, ignored by the ledger). ✅
- [x] **Total CYD has no canonical fact** → classified **FACT-ABSENT** (`transaction_data_summaries` empty, no CYD column; grain fix builds it). ✅
- [x] **Resolved Volume 215,729 = row-grain** → classified **RECOMPUTING** (self-computed from rows; grain fix corrects to 74,737 ticket-grain). ✅

## Acceptance checklist

- [x] `docs/extraction/downstream-wiring-map.md` produced — read-only, no fix
- [x] Every downstream consumer enumerated (workspace, project, portfolio, Ask)
- [x] Each consumer × field traced with quoted read path (file:line)
- [x] Each classified: CORRECT / FACT-ABSENT / MIS-WIRED / RECOMPUTING / DISPLAY-BUG
- [x] "facts mapped / missing" mapping layer characterized (render-time expected-vs-blob diff; not a separate persistence; no `transaction_data_summaries` lookup)
- [x] Typed-column vs `raw_row_json` split mapped per surface
- [x] Display/unit bugs cataloged distinctly (`$` on counts via `inferValueType`)
- [x] SUMMARY: counts per failure mode + prioritized fix list grouped by cause
- [x] No code, fix, migration, or surface change made
