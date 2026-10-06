# Strict authored-rate parsing: consumer audit

The implementation was merged in PR #157 (b706a459ce0536c5fc2c027a17fd32395d4400bf). This follow-up adds regression proof; it does not change extraction or backfill persisted rows.

The page-reconstruction reader consumes exactly one digit-bearing authored token, with correctly grouped thousands separators and, when present, two to four decimal digits. Digit-free layout artifacts and a separate currency marker remain evidence. Integers remain supported. Refusal produces `rate: null`, `rate_amount: null`, and `confidence: needs_review`.

Precision is also corrected: `$0.085` previously became 0.08 and now becomes 0.085. The change therefore is not exclusively a transition from a number to null. Four decimal places are retained; five are refused. The tests also cover the native-text shapes `5 100.00` and `5 90.00` without interpreting `5` as a currency symbol.

Exact source-anchor regression coverage checks refusal preserves the row identity, raw rate, pricing-cell observation IDs, source anchor IDs, geometry references and reconstruction input without mutation. No source tokens are rewritten.

## Rebuild and cache boundaries

- `analyzeContractIntelligence.ts` calls `buildContractRateScheduleRowsWithDiagnostics` using persisted reconstruction and layout observations. Its page-priced reader rebuilds the number from `structured_rate.amount_text` when proven, otherwise the authored rate cell. Other rate readers remain separate.
- `intelligenceAdapter.ts` persists analysis `rate_schedule_rows` into execution-trace facts. Existing persisted numbers are not automatically reparsed by this patch.
- `documentIntelligenceViewModel.ts` reads execution-trace rows, canonical assembly rows, and typed rate-table rows into pricing assembly. `canonicalRowsToRateRows` and `typedRowsToRateRows` read cached numeric fields.
- At this audited main revision, assembly falls back to `parseContractPricingRate(rawText)` when cached numeric fields are null. Strict parsing alone does not establish downstream refusal or scanned-value authority. Claude's separate Phase 2 work in PR #159 owns protection against reparsing withheld values and the OCR review/authority boundary. This follow-up deliberately does not duplicate that architecture.

These are code-path findings, not claims that historical stored rows have been repaired or activated for pricing. No database query, migration, source change or backfill is part of this follow-up.
