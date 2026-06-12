# Downstream Fixes 1 & 2 — Implementation Status

**Date:** 2026-06-08
**Scope shipped this session:** Fix 1 (Fact Ledger re-point) + the narrow regex-only part of Fix 2 (stop forcing `$` on counts/volumes).
**Deferred:** Fix 2's `quantity` value-type + `unitLabel` plumbing, and Fix 3 (workspace grouped-table build) — held until the sandbox can run tsc/build/tests.

> ⚠️ **NOT VERIFIED.** The isolated Linux sandbox (tsc / ESLint / `npm run build` / tests)
> would not start this session (`VM service not running`). No Phase-C gate below was
> executed. The code changes are hand-checked against the existing types only. Do not
> treat this as passing until the gates are run.

---

## What changed

`lib/documentIntelligenceViewModel.ts` (only file touched):

### Fix 1 — Fact Ledger spreadsheet facts re-pointed to the row-backed canonical summary
- Imported `buildCanonicalTransactionSummaryFromRows` + `CanonicalProjectTransactionRowInput`
  from `@/lib/projectFacts` (no new import cycle — that module was already imported here and
  does not import back).
- In `buildDocumentIntelligenceViewModel`, build `rowBackedCanonicalTransactionSummary` once
  from `params.transactionRows` (the same builder the review surface / Forge use — a **read,
  not a second row-sum**).
- New `applyRowBackedSpreadsheetFacts(...)` overlay runs just before the final fact sort:
  - Re-points existing **auto** facts in the transaction-truth groups
    (`dataset_summary`, `grouped_review_tables`, `flags_outliers`) to the canonical value.
  - Appends expected spreadsheet fields the blob never produced (but the rows do).
  - Leaves human-reviewed / overridden facts untouched (`displaySource !== 'auto'` skipped).
  - Leaves References / Extracted Signals / Additional Extracted Fields **blob-sourced** (unchanged).
- Re-pointed facts get `reviewState: 'derived'` (not `missing`), so the
  `FactLedger.tsx` "N mapped / M missing" counter self-corrects with no change to that file.

### Fix 2 (narrow, regex-only) — `inferValueType`
- Count fields (`total_tickets`, `row_count`, `*_count`) classify as `number` (no `$`).
- Volume/quantity fields (`*_cyd`, `*_mileage`, `*_diameter`, `*_tonnage`,
  `total_transaction_quantity`, `*_quantity`) classify as `number` (no `$`).
- Genuine currency keys (`total_extended_cost`, `*_cost`, `*_amount`, …) are **unchanged**.
- **Not done (deferred):** the new `quantity` value type + `unitLabel` plumbing. CYD therefore
  renders as a bare number (no "CYD" suffix) in the ledger — accepted cosmetic gap for now.

---

## Phase-C gates — ALL UNVERIFIED (sandbox down)

Fix 1:
- [ ] Fact Ledger spreadsheet facts source from the row-backed canonical summary, not the blob
- [ ] Non-spreadsheet fact groups still blob-sourced (unchanged)
- [ ] Total Extended Cost $815,559.35 (was MISSING)
- [ ] Transaction Row Count 5,063 (was 0)
- [ ] Total Tickets 2,388 (was 0)
- [ ] Total CYD ticket-grain 74,737/74,617 (was MISSING)
- [ ] Grouped (rate_code/invoice) / Flags groups populate from rows
- [ ] "N mapped / M missing" counter reflects real resolution
- [ ] No second independent row-sum added (reuses canonical summary) ✔ by construction
- [ ] Amounts row-grain, quantities ticket-grain (grain fix not regressed)
- [ ] tsc clean, ESLint clean on touched files, no new `any`
- [ ] `npm run build` passes
- [ ] Existing tests green; grain regression probe still passes

Fix 2:
- [ ] `total_tickets`, `row_count`, `*_count` render as plain numbers (no `$`)
- [ ] `total_transaction_quantity` renders as a number, not currency
- [ ] `total_cyd` / `*_cyd` render without `$` (bare number — unit label deferred)
- [ ] `total_extended_cost` / `*_cost` / `*_amount` still render as currency
- [ ] No genuine currency field lost its `$`
- [ ] tsc clean, ESLint clean
- [ ] `npm run build` passes; existing tests green

## Known partials / follow-ups
- **Row-Level Drilldown** group: the canonical summary has no `transaction_data_records`
  key, so that group is not re-pointed here. Populating it from rows is left to Fix 3 scope.
- **Grouped By Material / Site Type / Disposal Site**: the canonical summary does not yet
  build these (hard-coded `distinct_*_count: 0` in `buildCanonicalTransactionSummaryFromRows`).
  They remain empty until **Fix 3** (deferred). `grouped_by_rate_code` / `grouped_by_invoice`
  do populate.
- **Fix 2 quantity type + Fix 3**: deferred to a session where tsc/build/tests can run.

## Commands to run when the sandbox is back
```
npx tsc --noEmit
npx eslint lib/documentIntelligenceViewModel.ts
npm run build            # resolve the .next lock first if present
npm test                 # incl. transactionQuantityGrainIntegrity (grain regression probe)
```
