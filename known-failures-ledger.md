# Known Failures Ledger

Generated during behavioral test triage against baseline `d3bc3bf2` (`Add operational rate schedule fallback`).

## Pre-existing behavioral failures

| Test | File | Cause | Owning workstream |
|---|---|---|---|
| `extractDocument transaction_data routing > routes explicit transaction_data uploads through the dedicated spreadsheet normalization path` | `lib/server/documentExtraction.transactionData.test.ts` | Transaction rollup shape includes `eligible_count` / `ineligible_count` before the type-safety pass; expectation drift in transaction-data normalization corpus. | Document intelligence / transaction-data |
| `validator finding queue actions > builds a Williamson-style queue action for a rate mismatch finding` | `lib/validator/queueFindingActions.test.ts` | Queue action href includes row-level `recordId` before the type-safety pass; expectation drift in evidence navigation URL shape. | Validator / execution queue |
| `validator fact priority > persists contract validation context in the shared validation summary shape` | `lib/validator/shared.test.ts` | Validation summary includes `relationship_context: null` before the type-safety pass; expectation drift in shared validation summary shape. | Truth engine / validator summary |

## Current full-suite timing artifacts

These failed only in repeated overloaded full-suite runs and passed when rerun directly.

| Test | File | Evidence | Owning workstream |
|---|---|---|---|
| `processDocument canonical persistence gating > keeps Williamson-style contract failures at extracted and blocks all downstream decisioning` | `lib/pipeline/processDocument.test.ts` | Timed out in full suite at 20s; passed in isolated file run with the same timeout. | Document pipeline / test infrastructure |
| `documentExtraction pdf fallback gate > uses pdf_text when meaningful native page text blocks the weak fallback gate` | `lib/server/documentExtraction.pdfFallbackGate.test.ts` | Timed out in full suite at 20s; no assertion regression observed in related focused reruns. | Document extraction / test infrastructure |

## Type-pass regressions fixed during triage

| Area | Restored behavior |
|---|---|
| Ask ceiling-vs-billed reasoning | Restored invoice-total summing fallback and decision amount fallback when canonical `total_billed` is absent. |
| Contract/invoice reconciliation | Restored exact rate-code matching as the contract row used for rate-mismatch findings; prevented description-only/suspicious rows from clearing missing-rate blockers. |
| FEMA mock corpus activation issue | Restored activation issue visibility for `dual_party_client_vs_agency` while preserving explicit effective-date + executed-date suppression behavior. |
| Validation summary | Made contract identity lookup null-safe without changing test expectations. |
