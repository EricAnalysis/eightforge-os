# Design: invoice-line category review

Status: proposal (2026-10-07). No code yet.

## Problem

Invoice lines are categorized at read time by the shared rate taxonomy
(`resolveCanonicalRateCategory` in `lib/invoices/invoiceParser.ts` and
`lib/validator/effectiveInvoiceLineCompletion.ts`). When the taxonomy cannot
resolve a line confidently, cross-document rate verification stops at
`needs_review` (`CROSS_DOCUMENT_CATEGORY_NEEDS_REVIEW`) before it looks at the
contract row, so even a correct manual rate link does not clear it. After
#168 removed incidental single-letter C&D matches, more lines land here
(fresh path: Hillsdale 5, DN 3 on the audit corpus). The operator has no way
to record the line's category: the finding can only be opened or left.

## Principles

- Only `human_fact_assertions` produce HUMAN_REVIEWED truth; no second store.
- Reuse the existing precedence: the taxonomy already lets an existing
  category win (`existingCanonicalCategory`, basis `existing`). A reviewed
  category enters there, so no new resolver and no new matching logic.
- Bind to evidence and fail closed: a reviewed category applies only to the
  exact line it was recorded for; if the line's evidence changes, it stops
  applying and the case reopens.
- Categories come only from `ALLOWED_RATE_CATEGORIES`.

## Proposal

### Fact

A new fact key `invoice_line_category` in `human_fact_assertions`, value
`{ category }` with `category` in `ALLOWED_RATE_CATEGORIES`, recorded through
the existing B3 record RPC and supersession chain (same withdraw and re-review
rules as `contract_rate_row`).

### Identity

Invoice lines today have positional ids (`typed:<doc>:invoice:line:<n>`),
which move when re-extraction reorders lines. The assertion binds to:

- `document_id`, and
- an evidence digest of the line: `hashCanonical([line_code, description,
  unit, quantity, unit_price, line_total])` as read, plus the source
  observation ids where the line came from a PDF region (spreadsheet lines
  have none; the digest alone binds them).

The resolver applies a reviewed category to the line whose current digest
equals the recorded one. No match, no application: the line falls back to the
taxonomy and its finding reopens as a re-review case (the existing
`reviewed_value_needs_rereview` pattern).

### Consumption (one seam)

`effectiveInvoiceLineCompletion` (the shared completion every invoice consumer
already reads) passes the effective reviewed category as
`existingCanonicalCategory` with confidence 1. `invoiceParser` is unchanged.
`crossDocumentRateVerification` sees a confident category and proceeds to the
contract comparison as it does for any categorized line.

### Case and action

`validatorCases` (resolutionCases.ts): a `CROSS_DOCUMENT_CATEGORY_NEEDS_REVIEW`
finding gains an `enter_reviewed_category` action (allowed-category select,
required reason), alongside the existing open-in-Validator. Impact preview
runs as for other reviewed facts.

Shortcut, not authority: when the operator has manually linked the line to a
contract row (`link_invoice_line_rate`), the action pre-selects that row's
category. The operator still confirms; nothing is inferred silently.

### Friction and investigation

`frictionReason`: the existing `category_unresolved` reason, root cause
`mapping_issue`. Investigation context: the line's own text and the linked
contract row, never another line's category.

## Out of scope

- Changing the taxonomy or its thresholds.
- Backfilling categories for historical lines.
- Any provider suggestion of a category (a later Forgewing proposal could
  pre-fill the select, as value readings do, and stay unverified).

## Tests to write with it

- A reviewed category resolves the finding to the contract comparison.
- A changed line (digest mismatch) reopens the case; the reviewed category is
  not applied to a different line.
- A category outside the allowed set is refused by the request builder and
  the RPC.
- Withdraw restores the taxonomy result.
- Architecture: no consumer reads `invoice_line_category` except through
  `effectiveInvoiceLineCompletion`.
