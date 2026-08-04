# Canonical Project Truth — Golden Shadow Slice

**Date:** 2026-08-01  
**Scope:** additive, in-memory canonical invoice/transaction/reconciliation/validation/project registry; no production reader wiring, UI change, Validator change, extraction change, assembler change, migration, commit, or push.

> **Superseded decision**
>
> The original `BLOCKED BY CURRENT SOURCE MODEL` decision in this report reflected
> the repository state before commit `57566c3`.
>
> Commit `57566c3` corrected the authored-description sequencing defect and restored
> source-backed route and distance-band interpretation for the affected Golden rows.
>
> The controlling follow-up review is:
>
> `docs/audits/canonical-project-truth-code-review-2026-08-01.md`
>
> Current status: `READY FOR A CONTAINED INTERPRETATION SLICE`.
>
> The original analysis below is retained as a historical record.

## 1. Git state

The repository started on `main`, ahead of `origin/main` by four commits, with substantial pre-existing modified and untracked extraction/evaluation/audit work. Those changes were preserved. This slice is intentionally uncommitted. No push was performed.

## 2. Files created and modified

Created:

- `lib/canonical/invoice/invoice.ts`
- `lib/canonical/invoice/invoiceLine.ts`
- `lib/canonical/invoice/invoiceAdapter.ts`
- `lib/canonical/transaction/transaction.ts`
- `lib/canonical/transaction/transactionAdapter.ts`
- `lib/canonical/reconciliation/pricingMatch.ts`
- `lib/canonical/reconciliation/invoiceTransaction.ts`
- `lib/canonical/reconciliation/projectReconciliation.ts`
- `lib/canonical/validation/factImpact.ts`
- `lib/canonical/project/projectTruth.ts`
- `lib/canonical/project/projectTruthBuilder.ts`
- `lib/canonical/project/canonicalProjectTruth.test.ts`
- `lib/canonical/project/goldenShadowChain.test.ts`
- `lib/evaluation/canonicalProjectTruthShadowHarness.ts`
- `lib/evaluation/canonicalProjectTruthShadowHarness.test.ts`
- this report

Modified within the existing untracked canonical slice:

- `lib/canonical/contract/pricing.ts`: removed unused `CanonicalPricingCoreField` export.
- `lib/canonical/contract/pricingResolution.ts`: removed unused `rowsInDisplayGroup` export.
- Replaced the earlier synthetic `lib/canonical/contract/goldenBusinessChain.test.ts` with the project-level Golden shadow-chain test because the earlier test incorrectly modeled the target authored row as clean and approval eligible.

Confirmed unchanged: `lib/projectFacts.ts`, `lib/extraction/domain/**`, Validator rule/generation code, pricing assembler code, UI, migrations.

## 3. Canonical invoice model

`CanonicalInvoice` retains a stable/labeled identity, invoice number, governing project, vendor, billing period, invoice date, billed total, optional supported/at-risk totals, governing contract/task-order references, source document, typed evidence, review state, absent fields, and unresolved fields. Core fields use `TruthEnvelope<T>`; conditional totals are sparse optional envelopes.

`CanonicalInvoiceLine` retains source line identity, source-backed evidence, raw and normalized descriptions, category, rate code, quantity, unit, billed rate, extended amount, material/site/route/band dimensions, source coordinates, unresolved/absent fields, review state, and existing billing keys. It does not manufacture rate codes or units.

## 4. Canonical transaction model

`CanonicalTransaction` stays at row/ticket grain. It preserves transaction/ticket identity, invoice link, date, material, quantity, unit when typed upstream, rate code, applied rate, extended cost, site/route/band dimensions when typed upstream, load identity, workbook/document/sheet/row identity, raw row JSON, evidence, raw eligibility, translated support state, review state, missingness, and existing matching keys.

It does not aggregate rows into invoice summaries. Mileage is not relabeled as a distance band. Unknown eligibility remains `unknown`, never silently `ineligible`.

## 5. Pricing match model

`CanonicalPricingMatch` is a representation of an existing matcher result, not a replacement matcher. It preserves candidate row ids separately from the selected row, relevant transaction ids, keys used, normalized description key/current similarity when available, per-dimension match results, expected/billed rate, variance, affected amount, evidence, unresolved reasons, approval impact, source matcher, and source match status.

Statuses cover: matched, unmatched, ambiguous, rate mismatch, unit mismatch, applicability unresolved, governing rate requires review, and insufficient evidence. No confidence is invented.

## 6. Reconciliation models

The slice defines typed contract-to-invoice, invoice-to-transaction, and project reconciliation objects. Each separates numeric/source facts from the conclusion and reasons. Facts include billed/supported quantities and amounts, variances, pricing status, completeness, mismatch counts, orphans, and at-risk totals.

## 7. Validation fact-impact model

`CanonicalValidationFactImpact` maps an unchanged `ValidationFinding` and its evidence to exact canonical object ids and field paths. It preserves expected/observed values, evidence ids, affected amount, approval-gate effect, required action, rule/finding ids, and finding status. It does not change findings or generate new ones.

## 8. Project Truth registry

`CanonicalProjectTruth` organizes governing documents/relationships, contract term references, canonical pricing schedules, invoices, invoice lines, and transactions. Pricing matches, reconciliations, validation impacts, and exposure/readiness references are explicitly nested under `derived`; they are not independent records of truth. Construction is labeled `shadow_only`, `persisted: false`.

The builder sorts every collection by stable identity and does no derivation beyond deterministic assembly/order.

## 9. Adapter boundaries

- Typed invoice extraction → `adaptInvoiceExtraction`.
- Effective current Validator invoice/invoice-line rows → `adaptCurrentInvoiceRows`; reads already-typed values and keys only, without recovery or normalization.
- Normalized XLSX row → `adaptNormalizedTransaction`.
- Persisted transaction row → structural `adaptProjectTransactionRow`; no import from `projectFacts.ts` and no synthetic Project Facts defaults.
- Existing matcher output → `representCanonicalPricingMatch`.
- Existing finding/evidence → `mapValidationFindingToCanonicalFacts`.

The invoice adapter reads the source vendor directly and never imports `invoiceCanonicalNames.ts` or its hardcoded `Aftermath Disaster Recovery` literal.

## 10. Sparse-envelope decision

Decision: **required core plus optional conditional envelopes**.

Core facts that must communicate why a value is unavailable always carry an envelope. Conditional fields are omitted when absent and their names are retained in `absentFields`. This keeps type safety and semantic missingness without serializing large empty envelope objects. Tests prove JSON output omits absent `rateCode`, `unit`, and `materialType` envelopes.

## 11. Identity model

Source ids, evidence anchors, document ids, transaction ids, sheet names, and source row numbers are preferred. `line_code` is not treated as line identity. When no source identity exists, adapters create a deterministic content/source-coordinate fallback prefixed `fallback:` and set `identityKind: deterministic_fallback` plus an explicit warning. Array ordinal is not a primary production identity.

## 12. Golden artifact inventory

Corpus root: `C:\Users\ADMS Thompson\Desktop\EightForgeDocTrainning\Training Projects`.

| Artifact | SHA-256 | Execution in this slice |
|---|---|---|
| Golden governing contract/rate schedule PDF | `922161a533bb6b8c1afb52cb9536044c8a6836bed62401634f4f505025631e8f` | real pipeline executed |
| Invoice 2026-002 cover PDF | `af399fea21ba2bca5c0381de2289a564e924e252553403c311c0486fa0723282` | represented from checked current-runtime fixture; PDF not executed |
| Invoice 2026-003 cover PDF | `a530233b65956a5d267320bea2b43c248442e4ab98d762fba8b725549ab255c0` | inventoried; PDF not executed |
| `ticket_query_20260404_191302.xlsx` | `241b1c4d9712d40eee844db2ccf5b4c9e436c293bf094d1f5ca72a1c6690d2df` | represented from row-grain checked fixture; workbook not re-executed |

Accepted intelligence traces, persisted Golden findings/exposure, and `validation_summary_json` are unavailable locally; this slice does not contact Supabase.

## 13. Golden shadow-chain results

Real pricing execution reconfirmed:

- 105 rate schedule rows
- 90 assembler rows
- 90 canonical candidates
- 56 resolved / approval eligible
- 34 needs review / approval ineligible
- 0 excluded
- 15 merged with diagnostics
- 0 silently lost

The fast project fixture represents invoice 2026-002 line 1A, two source-row-addressable transaction records totaling 43,894 CY and $302,868.60, the supplied current unmatched matcher state, typed reconciliation facts, the unchanged current finding fixture, its exposure, and the in-memory project registry. Invoice 2026-003 is supported by the model/current fixture inventory but was not added to the targeted ROW-to-DMS registry because its real PDF was not executed in this slice.

## 14. ROW-to-DMS 0–15 trace

| Required link | Result |
|---|---|
| Contract row exists | confirmed: page 8, `pdf:table:p8:t26:r2` |
| Description/category/unit/rate/evidence survive | confirmed: Vegetative, source description, Cubic Yard, $6.90, four real-fixture evidence refs |
| Route and distance band survive | **blocked**: real current candidate has `route=null`, `distanceBand=null`; canonical preserves absence and does not parse them from description |
| Authored correction remains review | confirmed: `authored_value_correction`, `needs_review` |
| Approval eligibility | confirmed false |
| Invoice line | represented: 2026-002 / 1A / 43,894 / $6.90 / $302,868.60 |
| Transaction rows | represented at row grain with workbook/sheet/row/raw evidence |
| Current match | represented as `governing_rate_requires_review`, source status `unmatched`, candidate present but no selected governing row |
| Existing finding | unchanged by deep equality in fixture test |
| Affected amount | preserved as $302,868.60 in line, match, impact, and exposure fixture |
| Finding status | remains open/blocked |

No rate, route, band, match, or finding was “fixed” in this slice.

## 15. Current-system parity matrix

The evaluation harness compares stable ids/typed semantic fingerprints, never display-only strings.

| Boundary | Classification | Basis |
|---|---|---|
| Contract pricing | represented but requires review | exact row/rate/category/unit/evidence; authored correction retained; route/band absent upstream |
| Invoice | represented with richer typing | current typed/effective row fields preserved in envelopes |
| Transaction | represented with richer typing | persisted/normalized row identity and raw evidence retained |
| Contract→invoice reconciliation | conflicting current truth path | current code can count candidate presence as matched while another path requires a selected match |
| Invoice→transaction reconciliation | represented with richer typing | numeric facts and conclusion separated |
| Cross-document rate verification | represented but requires review | supplied current unmatched status retained; canonical candidate does not override it |
| Findings | exact semantic parity in checked fixture | full finding deep-equal before/after registry construction |
| Exposure | current source unavailable | persisted/live Golden exposure unavailable; typed fixture represented only |

## 16. Duplicate truth paths found

- Two public invoice extraction models (`lib/types/extractionSchemas.ts`, `lib/types/documentIntelligence.ts`).
- Loose Validator `InvoiceRow`/`InvoiceLineRow` plus three private `CanonicalInvoiceLine` shapes in reconciliation/rate-verification packs.
- Normalized, persisted, Validator, and Project Facts transaction row projections; Project Facts introduces synthetic defaults and is not used by the canonical adapter.
- Matching keys are produced/read across invoice parser, XLSX normalization, `billingKeys.ts`, and private rule-pack projections.
- Contract/invoice reconciliation counts candidate presence in one path while cross-document/exposure paths rely on a selected match.
- Exposure derives private invoice/transaction shapes independently and ignores passed findings.
- Project Facts and Validator independently derive presentation/reconciliation summaries.
- `invoiceCanonicalNames.ts` contains a Golden vendor literal; canonical code does not import or reproduce it.
- The only canonical truth-state definition remains `CanonicalTruthState` in `truth/envelope.ts`.

No duplicate path was broadly fixed.

## 17. Persistence mapping

No migration or production persistence was added. A later persistence adapter could map:

- resolved field envelopes with machine evidence → `canonical_document_facts`;
- reconciliation/exposure outputs with dependency refs → `derived_document_facts`;
- operator review/correction and override chains → `human_fact_assertions`;
- registry construction metadata and source snapshot id → `document_interpretation_snapshots`;
- object/field/evidence links → interpretation records.

That adapter must reuse the existing ledgers and must not create a second canonical registry table.

## 18. Test/build results

| Gate | Result |
|---|---|
| `npx tsc --noEmit` | passed |
| `npx eslint lib/canonical --max-warnings=0` | passed |
| canonical + parity harness | 87 passed |
| current Validator/reconciliation/exposure/quantity regression set | 39 passed |
| real pricing fixtures | 4 passed in ~202 s; exact Golden/Goodlettsville/TDOT/MDOT counts reconfirmed |
| `npm run build` | passed; existing `pdfjs-dist` externalization warning only |
| full suite excluding the separately-run long real-fixture test | 203 files / 1,788 tests passed, 11 skipped; one `beforeAll` hook timed out under contention |
| isolated timeout rerun | `processDocument.test.ts`: 9 passed with `--hookTimeout=120000`; deterministic regression ruled out |
| `git diff --check` | passed; pre-existing LF→CRLF notices only |

Real fixture execution emitted known PDF decoder/font warnings and unavailable optional vision credentials, then completed successfully through deterministic OCR/table paths.

## 19. Known limitations

- The real target pricing candidate lacks structured route and distance-band fields. Inferring them from description is outside a pure adapter and would create a second interpretation path.
- Golden invoice PDFs and the transaction workbook were not re-executed; their canonical chain uses checked current-runtime fixtures.
- Live persisted Golden findings, exposure, Project Facts, and validation summary are unavailable locally, so parity is fixture/code-path parity, not live database parity.
- Current transaction sources do not consistently expose unit, timestamp, origin/destination, route, or distance band as typed columns.
- Effective invoice rows are structurally typed as `Record<string, unknown>` upstream; the canonical adapter can preserve typed fields but cannot restore evidence already flattened upstream.

## 20. Exact next integration boundary

Stop here. Before any UI, Validator, Project Facts, persistence, or reader cutover:

1. Add a source-neutral upstream interpretation that emits structured `route` and `distanceBand` for the target row with source evidence, or explicitly revise the required trace to accept absence.
2. Execute Golden invoice 2026-002, invoice 2026-003, and the ticket workbook through their real current pipelines and feed those outputs into the shadow registry.
3. Load the persisted current Golden finding/exposure snapshot read-only and run the semantic parity harness against it.
4. Resolve/document the current candidate-present versus selected-match reconciliation conflict without changing production behavior in the same step.

Only after those gates should a separate reviewed slice design a production integration boundary.

## 21. Decision

# BLOCKED BY CURRENT SOURCE MODEL

The typed shadow registry and business-chain representation are implemented and internally verified, but the required ROW-to-DMS trace cannot honestly prove route and distance-band survival because the real current source candidate contains neither. Live finding/exposure parity also cannot be claimed from this machine. No value was manufactured to force a green decision.
