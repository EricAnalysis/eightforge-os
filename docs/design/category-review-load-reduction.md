# Design: category review load reduction (and the category control)

Status: proposal (2026-10-07). No code yet.

## Problem

After #168 removed incidental single-letter C&D matches, category
requirements on the audit corpus are Golden 12, Hillsdale 46, DN 12
(Codex's offline inventory, unreviewed). Every one is decided row by row.
They are not independent: they cluster in a handful of printed tables.

| Document | Requirements | Standalone category cases | Attached to value cases | Pages |
|---|---:|---:|---:|---|
| Golden | 12 | 0 | 12 | p8, p10 |
| Hillsdale | 46 | 9 | 37 | p2, p3 |
| DN | 12 | 6 | 6 | p106, p107 |

About 70 category decisions span roughly six tables. Most (55) ride on value
cases that need a per-row value review anyway, so the saving is in the
category decision, not in the number of rows reviewed.

The audit also found a correctness gap in the same control
(`docs/audits/resolution-workspace-operator-audit-2026-10-07.md`, F1): a
reviewed value can silently drop a category the machine row had.

## Principles

- Every row keeps its own reviewed assertion, bound to its own evidence. A
  batch is a way of entering decisions, never a group fact.
- No category is inferred from a neighbour, a section or a page heading by
  the machine: a person chooses it once, and confirms each row it applies to.
- Categories come only from `ALLOWED_RATE_CATEGORIES`.

## Part 1: the category control (fixes F1)

1. The category control on `enter_reviewed_value` is always the
   allowed-category select. Where the case does not require a category, it
   still offers "No category", but never free text.
2. `buildResolutionActionRequest` refuses any non-empty category outside the
   allowed set, required or not. The record RPC does the same server-side.
3. Every `enter_reviewed_value` action on a priced row carries
   `currentValue.category`: the machine row's resolved allowed category
   (`resolveRateScheduleRowCategory`), or null. "Copy what extraction read"
   is offered on every such case and copies the category too.
4. A reviewed row saved with no category on a row the machine had
   categorized is refused with "This row has a category (X). Keep it or
   choose another." Leaving the category blank is allowed only where the
   machine had none, and the row then stays a category case.

## Part 2: table default category

A table is the deterministic grouping the reconstruction already proves:
same document, same physical page, same table segment (v4 `table_segment`),
same header. No new grouping logic.

- The queue groups category requirements by table and shows the count
  ("Hillsdale p3, table 1: 36 rows need a category").
- On the first case of a table, the operator may set a table default
  category, with a required reason (for example "the table header reads
  Equipment Description").
- The default pre-selects the category on every remaining case of that table,
  for that session. Each row is still saved by the operator, after seeing its
  own evidence, as its own assertion. The pre-selection is visibly marked
  "table default; confirm for this row", and changing it per row is one
  select.
- The default itself is not stored as truth. Its reason is copied into each
  row's assertion reason, so the audit trail shows why each row got its
  category.
- Standalone category cases (no value needed) may be confirmed for the table
  in one action after the operator has reviewed the list. This writes one
  assertion per row and shows each row's evidence in the confirmation list;
  any row can be unticked. The same idempotency and staleness rules apply per
  row: a row whose evidence moved is refused individually, the rest save.

## Part 3: visibility

- Queue header: counts by case kind and by document.
- Case list: a "+ category" marker on value cases with
  `alsoUnresolved: ['category']`.
- Friction report: category requirements per table feed the Orchestrator
  (root cause `mapping_issue`), so a recurring "whole table uncategorized"
  pattern becomes an extraction or mapping improvement (for example, using a
  printed table heading as category evidence) rather than permanent operator
  work.

## Expected effect

On the audit corpus: about 70 independent category choices become about six
table decisions plus per-row confirmation. No row is saved without its own
evidence being shown. The number of reviewed assertions is unchanged.

## Out of scope

- Machine inference of category from headings (that is Part 3's improvement
  loop, through normal extraction PRs and qualification).
- Any Forgewing category suggestion.

## Tests to write with it

- Free-text and non-allowed categories are refused (client builder and RPC).
- A value review on a categorized row keeps the category unless the operator
  changes it; blank is refused.
- The table default pre-selects only within its table, never across tables or
  documents.
- Bulk confirmation of standalone cases writes one assertion per ticked row;
  a stale row is refused alone.

## Status (2026-10-09)

- **Part 1: built (#174).**
- **Part 3: partly built.**
  - Built: counts by kind, the "+ category" marker (#176), and the per-case friction mapping of unresolved categories to `mapping_issue`.
  - Not built: counts by document, and aggregation of category requirements per table.
- **Part 2 (table default category): not started.**
