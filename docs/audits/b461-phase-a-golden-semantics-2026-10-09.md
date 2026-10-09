# B4.6.1 Phase A: Golden semantic audit (2026-10-09)

The question: why did B4.6 read Golden p8's two-level price sheet wrongly, and what is the smallest general correction?

The audit uses the current pinned captures and no provider calls:
- extraction v5, merged in #179;
- capture set `4d024fbe…`, the same set Codex produced on Windows for #179's final commit.

No row text appears here.

## B4.6 failure pattern (recorded result, `85c7ce6`)

Golden p8 is laid out as a category column with merged cells, then the row's own scope description, then unit, then rate. All 20 Golden failures had the correct rate and unit. Each one was a text-field association error:
- category and description merged into one field;
- category and description swapped;
- the scope description dropped.

## Root cause: the benchmark crop, not the production crop

B4.6 cropped each row from the **labels'** row geometry, which includes the row's category cell. The reader saw the merged category text beside the scope text, with no column header, and associated them wrongly.

B4.6.1 crops each case exactly as production does, from the case's own source observations (`canonicalBoxesForObservations`). On those crops:

| Page | Cases | Labelled cells inside each production crop |
|---|---:|---|
| Golden p8, scanned amount | 10 | the row's description, unit and rate; **never its category cell** |
| Golden p8, withheld | 12 | description, unit and rate in 11 cases; unit and rate in 1 |
| Hillsdale p3, scanned amount | 40 | description, unit and rate (the page has no category column) |
| DN p107, scanned amount | 20 | description, quantity, unit and rate (no category column) |

The merged category cell is never in a Golden production crop. The text that confused B4.6 is therefore not in front of the reader at all, and the scope description is the only description it can see. **Nothing needs to change in extraction, the crop or the prompt**, so none of them is changed.

What remains is a scoring question. Under the B4.6 rule, a row's category is truth whenever the page labels a category column. On a production crop that cannot show the category, a reader that correctly reports `category: null` (the prompt says a category "only if it appears on this line") would be scored a field mismatch on every Golden case.

## Changes

1. **Scoring production crops (binding `b461-target-binding-v2`).** Fixed before any B4.6.1 provider run. When a target is cropped from production evidence:
   - the row's category is truth only when its category cell is visible in the crop;
   - a category is supported only by evidence the crop shows (the row's own cell, or the section heading's cells);
   - so a category reported from outside the crop is now an **unsupported semantic invention**, a hard corpus-wide failure. That is stricter than before on guessing.

   Labelled-row crops (B4.6) keep their rule unchanged. Test: `valueReadingBenchmark.test.ts`, "scores a production crop only on what it shows".
2. **Product: a suggestion no longer drops the machine row's category.** "Use suggestion" used to copy `category: ''` whenever the reading named no allowed category, overwriting the category the machine row carries. That is exactly the Golden case: the category is known from extraction and absent from the crop. The draft now keeps the machine row's allowed category unless the reading names another allowed one. This is the same rule F1 (#174) applied to typed reviews. Test: `ResolutionWorkspace.test.tsx`.

## Result (prepare, no provider calls)

- 181 cases; 83/83 bound crops render deterministically; render p50 469 ms on this host.
- `confirm_scanned_amount × ocr_price_sheet`: 50 cases, all bound, 0 binding failures.
- `confirm_scanned_amount × dense scanned` (DN p107): 20 cases, all bound.

## Found during the audit: priced-line cases on a page with no price table

DN physical page 110 is an insurance certificate. Its coverage limits are amounts, and no line reads as a header. Reconstruction therefore records the page as `header_not_found`: 3 or more table-candidate lines carry a rate marker (`unresolvedPricedPage`, `pagePricedScheduleReconstruction.ts`).

The queue then opens **18 unreadable priced-line cases** on a page that has no priced rows. Labelling that page as a price sheet would manufacture truth, so it is not labelled. Taxonomy: `region_not_priced_row`, owner workflow typing / deterministic extraction. A Codex task is scoped separately.

## Unchanged

- Prompt `forgewing-priced-value-reading@v1`;
- crop renderer, scale and padding;
- request identity;
- the activation bar.

Value reading stays inactive.
