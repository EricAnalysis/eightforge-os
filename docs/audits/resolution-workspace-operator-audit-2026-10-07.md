# Resolution Workspace operator audit (2026-10-07)

Scope: `components/resolution/ResolutionWorkspace.tsx`, the case read model
(`lib/resolution/resolutionCases.ts`), the request builder
(`lib/resolution/resolutionActionRequest.ts`) and what a saved decision does
downstream (`lib/humanFactAssertions/*`, `lib/validator/projectValidator.ts`).
Read-only audit; no code changed.

## What works

- One surface, server-driven: queue (grouped by root cause, tiered), evidence
  (source page with the cited region drawn), decision (only the actions the
  case offers). The client invents no case, anchor, impact or authority.
- Every write goes through the write path the case names, with an
  idempotency key; stale evidence is refused server-side and the case is
  refreshed in place with an explanation.
- Impact preview (B5-C) before saving a reviewed value, a withdrawal, a
  recovery or a rate link.
- Forgewing material is visually separated and labelled "Unverified" / "not
  authority"; a reading is copied into the draft only by explicit selection,
  and the reviewer still saves it as their own value.
- The deterministic investigation is shown as "Not a decision".

## Findings

### F1. A reviewed value can silently drop the row's category (correctness)

On every case except `category_review`, the category field is optional free
text, and nothing pre-fills it:

- The "Copy what extraction read" button exists only on `category_review`
  cases (`currentValue` is set only there) and copies description, unit and
  rate, never the category.
- A scanned-value case (`review_required_value`) or a withheld line on a row
  whose category deterministic extraction already resolved therefore saves a
  reviewed row with whatever the operator typed: blank, or text outside the
  allowed set.
- The reviewed row supersedes the machine row (B3.1) and reaches pricing and
  the Validator with that category. A blank or non-allowed category cannot be
  category-matched (`crossDocumentRateVerification` returns `needs_review`),
  and no case re-flags it: `categoryReviewTargets` reads extraction rows, not
  reviewed rows.

Net effect: confirming a scanned amount can turn a categorized, matchable row
into an uncategorized one, with no visible signal. The operator did more work
and the truth got worse.

Fix (small, Core): see `docs/design/category-review-load-reduction.md`,
section "Category control". In short: the category control is always the
allowed-category select; the request builder refuses non-allowed text; the
case carries the machine row's resolved category so it can be confirmed in
one action.

### F2. No queue-level view of load

The queue lists cases grouped by root cause, but shows no counts by kind or
document, and no filter. Hillsdale went from 22 to 46 category requirements
after #168; an operator cannot see that they are mostly one table's worth of
the same decision. See the load-reduction design.

### F3. Repeated decisions are entered one row at a time

Rows in one printed table usually share a category (a page headed
"Equipment Description" is equipment throughout). Today each row's category is
chosen from scratch. See the load-reduction design (table default category).

### F4. Invoice-side category has no reviewed path

`CROSS_DOCUMENT_CATEGORY_NEEDS_REVIEW` findings can only be opened in the
Validator or left; there is no way to record the invoice line's category, and
a manual rate link does not help (the comparison needs a known invoice
category before it uses the linked row). See
`docs/design/invoice-line-category-review.md`.

### F5. Minor

- "Leave unresolved" cycles to the next case without recording anything; it
  is correctly not a decision, but it is the only control without a
  confirmation of what it does ("skips for now; nothing is saved" would help).
- The case list shows only titles; a value case that also needs its category
  (`alsoUnresolved: ['category']`) is not marked in the list.
- Stale queue output: in production the three schedule documents still carry
  reconstruction v2 (see `docs/audits/ocr-runtime-parity-2026-10-07.md`), so
  today's queue does not reflect current extraction until they are
  re-analyzed.

## Recommended order

1. F1 fix (prevents truth loss; small, Core).
2. Re-analyze the three schedule documents so the queue reflects current
   extraction.
3. Load reduction (F2, F3).
4. Invoice-line category review (F4).

## Status (2026-10-09)

- **F1: fixed (#174).**
  - The category is a select over the allowed pricing categories, prefilled from the machine row's category.
  - The server refuses a category outside the allowed set.
  - The action request asks the operator to keep or change an existing category.
- **F2: partly done (#176).** The queue header shows counts by case kind and how many value cases also need a category. Counts by document and a queue filter are not built.
- **F3: open.** The table default category is still only the design in `docs/design/category-review-load-reduction.md`, Part 2.
- **F4: open.** Invoice-line category review is still only the design in `docs/design/invoice-line-category-review.md`.
- **F5: two of three done (#176).**
  - "Leave unresolved" now says it skips for now and saves nothing.
  - Value cases that also need a category carry a "+ category" marker.
  - Still open: re-analyzing the three schedule documents in production so the queue reflects current extraction.
