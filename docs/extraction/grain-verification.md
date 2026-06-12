# Spreadsheet Output Grain Verification

Date: 2026-06-06

## Verdict

Fail for quantity grain. Amount fields accumulate at row grain, which is correct, but CYD and net tonnage are also accumulated at row grain in both extraction/workspace summaries and Forge project truth. Diameter has one workspace service-item path that deduplicates by ticket, but no project-level diameter total was found. Mileage is reviewed per row only; no mileage total was found.

The bug class is confirmed in code: `SUM(extended_cost)` and `SUM(cyd)` are implemented with the same row-reduce pattern. That means a ticket repeated across multiple transaction rows inflates physical quantities.

## Ticket Identity

Ticket identity exists and is stored as `transaction_number`.

- Field definition: `lib/types/transactionData.ts` defines `transaction_number` as a canonical row field, and aliases include `ticket #`, `ticket number`, `ticket id`, `ticket`, `load ticket`, and related headers.
- Persistence: `lib/server/transactionDataPersistence.ts` persists `transaction_number` on `transaction_data_rows`.
- Dedup key in code: both extraction and Forge use `normalizeLooseText(record.transaction_number)` when they need a distinct ticket key.

Code evidence:

```ts
// lib/types/transactionData.ts
export type TransactionDataFieldKey =
  | 'transaction_number'
```

```ts
// lib/types/transactionData.ts
transaction_number: [
  'transaction #',
  'transaction number',
  'ticket #',
  'ticket number',
  'ticket id',
  'ticket',
  'load ticket',
  'load ticket number',
],
```

```ts
// lib/extraction/xlsx/normalizeTransactionData.ts
const transactionNumber = normalizeLooseText(record.transaction_number);
if (!transactionNumber) continue;
normalizedTransactionNumberSet.add(transactionNumber);
```

Multiple rows can share a ticket id. The local spreadsheet integration fixture has two rows with `Ticket ID = TID-1002`, and the normalization test asserts `total_tickets = 3` across 4 rows. That confirms `transaction_number` is used as the distinct ticket key.

## Aggregation Matrix

| Aggregation Location | Field Aggregated | Field Type | Grain Used | Correct? |
|---|---:|---|---|---|
| `normalizeTransactionData` top-level summary | `extended_cost` / `total_extended_cost` | AMOUNT | row-sum | Correct |
| `normalizeTransactionData` top-level summary | `transaction_quantity` / `total_transaction_quantity` | amount-like transaction quantity | row-sum | Correct if this is a line quantity; risky if it means physical load quantity |
| `normalizeTransactionData` top-level summary | `cyd` / `total_cyd` | QUANTITY | row-sum | Critical: inflated |
| `buildRateCodeGroups` | `transaction_quantity`, `extended_cost` | line quantity / AMOUNT | row-sum | Correct for amounts; quantity depends on semantics |
| `buildInvoiceGroups` | `transaction_quantity`, `extended_cost` | line quantity / AMOUNT | row-sum | Correct for amounts; quantity depends on semantics |
| `buildSiteMaterialGroups` | `transaction_quantity`, `extended_cost` | line quantity / AMOUNT | row-sum | Correct for amounts; quantity depends on semantics |
| `buildServiceItemGroups`, `buildMaterialGroups`, `buildSiteTypeGroups`, `buildDisposalSiteGroups` via `pushReviewGroupRecord` | `cyd` / `total_cyd` | QUANTITY | row-sum | Critical: inflated |
| `buildLifecycleSummary` | `cyd` / `total_cyd` | QUANTITY | row-sum | Critical: inflated |
| `buildProjectOperationsOverview` | `total_cyd` | QUANTITY | inherits row-sum | Critical: inflated |
| `documentIntelligenceViewModel` KPI / volume basis | `total_cyd` | QUANTITY | reads summary row-sum; fallback row-sum | Critical: inflated |
| `documentIntelligenceViewModel` tonnage fallback | `net_tonnage` | QUANTITY | row-sum | Critical if repeated per ticket |
| `documentIntelligenceViewModel` group tonnage | `net_tonnage` | QUANTITY | row-sum | Critical if repeated per ticket |
| `documentIntelligenceViewModel` service item diameter | `diameter` | QUANTITY | ticket-dedup, first non-null per ticket | Correct |
| `projectFacts.buildCanonicalTransactionSummaryFromRows` | `extended_cost` / `total_extended_cost` | AMOUNT | row-sum | Correct |
| `projectFacts.buildCanonicalTransactionSummaryFromRows` | `cyd` / `total_cyd` | QUANTITY | row-sum | Critical: inflated |
| `projectFacts.resolveTransactionTruthRows` | `total_cyd` / `Resolved Volume` | QUANTITY | reads row-backed summary row-sum | Critical: inflated |
| `SpreadsheetReviewSurface` KPI and tables | CYD / tons / amount | display only | inherits view model | Mirrors upstream grain |
| `selectProjectTicketValidation` | CYD / tonnage / mileage | selector text only | no aggregation | Not applicable |

## Code Evidence

Amounts accumulate correctly:

```ts
// lib/extraction/xlsx/normalizeTransactionData.ts
const totalExtendedCost = roundNumber(
  records.reduce((sum, record) => sum + (record.extended_cost ?? 0), 0),
  2,
);
```

CYD uses the same row-sum pattern, which is wrong for repeated ticket quantities:

```ts
// lib/extraction/xlsx/normalizeTransactionData.ts
const totalCyd = roundNumber(
  records.reduce((sum, record) => sum + (record.cyd ?? 0), 0),
  3,
);
```

Grouped workspace quantities also row-sum CYD:

```ts
// lib/extraction/xlsx/normalizeTransactionData.ts
accumulator.row_count += 1;
accumulator.total_qty += record.transaction_quantity ?? 0;
accumulator.total_cyd += record.cyd ?? 0;
accumulator.total_cost += record.extended_cost ?? 0;
```

Forge rebuilds the same row-sum summary from canonical rows:

```ts
// lib/projectFacts.ts
const totalCyd = roundNumber(
  records.reduce((sum, record) => sum + (record.cyd ?? 0), 0),
  3,
);
```

Forge truth then displays that value as resolved volume:

```ts
// lib/projectFacts.ts
readValue: (dataset) => readNumber(readTransactionOverview(dataset)?.total_cyd)
```

Diameter is the only audited quantity path found with ticket dedup:

```ts
// lib/documentIntelligenceViewModel.ts
const ticketKey = normalizeTicketIdentity(record.transaction_number, `record:${record.id}`);
...
sum = (sum ?? 0) + ticketDiameter;
```

## Williamson Known-Value Check

Known external target for Williamson County, County pile, CYD:

- Correct ticket-grain total: 4,186 CYD
- Inflated row-grain total: 8,372 CYD

Current workspace limitation: the configured Supabase environment has no Williamson/Aftermath/Fern project and no matching `transaction_data_datasets` rows, so the live canonical output value could not be read from this machine.

Local fixture evidence still confirms the failure mode. In `lib/documentIntelligence.spreadsheetReview.integration.test.ts`, two rows share ticket `TID-1002`; the asserted `normalized.summary.total_cyd` is 22, which is the row sum `10 + 4 + 8 + 0`, not a ticket-dedup total. A ticket-dedup CYD total for that fixture would be 14 if the first `TID-1002` value wins, or 18 if the last value wins. That proves current code is row-grain for CYD.

Tonnage spot-check: the same fixture asserts `normalizedNetTonnage = 8.5`, the row sum `2.5 + 1.5 + 3.5 + 1`. If net tonnage is repeated per ticket, this is inflated by the duplicate `TID-1002` row.

Mileage spot-check: no mileage total was found. Mileage is used in `buildMileageReview` as per-row validation, not a project/workspace total.

Diameter spot-check: service item rows deduplicate by `transaction_number` before summing diameter. Tests explicitly cover duplicate ticket rows and conflicting diameter rows, and this path is correct for the workspace service-item display.

Amount spot-check: the fixture asserts `total_invoiced_amount = 2800`, which is the row-sum of extended costs `1000 + 600 + 1200` for invoiced rows. That is correct because dollar amounts accumulate per transaction row.

## Workspace vs Forge Agreement

Workspace and Forge agree, but they agree on the wrong grain for CYD:

- Workspace extraction summary computes `total_cyd` with a row-sum.
- Workspace view model reads `summary.total_cyd`, `project_operations_overview.total_cyd`, or row-sums as fallback.
- Forge `buildCanonicalTransactionSummaryFromRows` recomputes `total_cyd` from persisted rows with the same row-sum.
- Forge `resolveTransactionTruthRows` reads that total as `Resolved Volume`.

This is not a split-brain divergence; it is a shared canonical truth defect.

## Findings

1. Critical: CYD totals are row-summed in extraction summaries, workspace rollups, lifecycle summaries, project row-backed summaries, and Forge truth rows. This will produce 8,372 instead of 4,186 on a two-row-per-ticket Williamson pattern.
2. Critical: net tonnage is row-summed in the view model when CYD is absent. If tonnage is repeated per ticket, it inflates the same way as CYD.
3. Critical: grouped CYD totals by service item, material, site type, disposal site, and lifecycle stage are row-summed, so pile or cost-driver quantities can inflate even when ticket counts are distinct.
4. Concern: `transaction_quantity` is treated as row-summable everywhere. That is correct only if it is a true per-transaction quantity; if it is an alias for physical ticket load quantity, it has the same inflation risk.
5. Limitation: live Williamson canonical output could not be verified because no matching project/dataset exists in the configured local Supabase environment.

## Acceptance Checklist

- [x] Report produced as `docs/extraction/grain-verification.md`.
- [x] Ticket identity field confirmed: `transaction_number`.
- [x] Transactional aggregation grain classified across extraction/workspace and Forge.
- [x] Quantity row-sums flagged as inflation risks.
- [ ] Live Williamson County `County` pile CYD recorded from canonical output. Blocked by absent local dataset.
- [x] Tonnage, mileage, and diameter paths checked.
- [x] Dollar amount total confirmed to accumulate across rows in local fixture.
- [x] Workspace vs Forge agreement checked.

## Final Verdict by Field Type

Amounts: correct. `extended_cost`, `total_extended_cost`, and `total_invoiced_amount` accumulate by transaction row.

Quantities: broken for CYD and likely broken for tonnage when repeated per ticket. Diameter is correct only in the workspace service-item path that explicitly deduplicates by ticket. Mileage has no total path found, only per-row review.

Fix scope for a later pass: introduce a shared ticket-dedup quantity aggregation helper keyed by normalized `transaction_number`, use it for CYD/net tonnage/diameter/mileage totals and grouped quantity rollups, and preserve row-sum behavior for amounts.
