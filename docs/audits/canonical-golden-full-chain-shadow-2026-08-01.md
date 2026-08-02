# Canonical Golden Full-Chain Shadow — 2026-08-01

## Decision

# REVISE

The real local contract, both invoice PDFs, and the transaction workbook now execute through the current production-core functions and feed an in-memory canonical shadow registry. The business totals and the ROW-to-DMS 0–15 amount chain are exact. Production readers, Validator behavior, persistence, migrations, Project Facts, UI, and the dirty Phase 3 extraction work remain untouched.

The original 2026-08-01 run correctly pinned a 5,055-versus-5,063 mismatch for the bytes it received. The follow-up source investigation proved those counts came from different workbook byte streams, and the 2026-08-02 fixture restoration replaced the consumed corpus file with the authoritative original export. The real pipeline now emits 5,063 rows from that source with delta 0 against persisted truth. No transaction-pipeline fix or persisted re-baseline was required. The former 5,055 measurements remain below as historical evidence for the edited derivative.

## Resolution addendum — 2026-08-02

- Authoritative original: SHA-256 `86cb49a07295aac80e8595a821ac595153ab1e0e3a8e7536dc7b0889c96f516e`, 5,063 data rows, 84 columns.
- Preserved edited derivative: SHA-256 `241b1c4d9712d40eee844db2ccf5b4c9e436c293bf094d1f5ca72a1c6690d2df`, 5,055 data rows, 85 columns, classified `non_authoritative_source`.
- Cause: the edited derivative deleted eight rows and inserted `Project Specific Detail`; the pipeline emits the complete population for either input.
- Impact: the eight-row derivative delta is `$0.00`, has no invoice linkage, and changes no finding, exposure amount, or approval outcome.
- Current authoritative status: `exact_source_parity` — 5,063 actual, 5,063 persisted, delta 0.
- Detailed restoration evidence: `docs/audits/golden-transaction-fixture-restoration-2026-08-01.md`.

Unless explicitly identified as current in this addendum, the measurements below describe the original 2026-08-01 execution against the edited derivative and are intentionally retained as historical evidence.

## 1. Git state

- Starting HEAD: `e82b031b5e4ba3a5b64c2ee0534abfbd4a8555ea` on `main`.
- Checkpoint history: `57566c3`, `b75ae73`, `e82b031`.
- The worktree began with unrelated modified/untracked Phase 3 extraction, header-evidence, synthetic-generalization, audit, script, and pet files. They were recorded and excluded.
- No file was staged. No commit or push was performed.

## 2. Files created and modified

Created:

- `lib/evaluation/canonicalGoldenFullChainHarness.ts`
- `lib/evaluation/canonicalGoldenFullChainRealFixtureParity.test.ts`
- this report

Modified:

- `lib/canonical/project/goldenShadowChain.test.ts` — removed the competing hand-authored invoice, transaction, reconciliation, finding, and exposure chain; now enforces a repository-wide AST/import boundary for Golden full-chain proof.
- `lib/canonical/project/canonicalProjectTruth.test.ts` — restores generic populated composition coverage for pricing matches, validation impacts, reconciliation collections, deterministic ordering, mutation safety, and stable serialization.
- `lib/architecture/importBoundaries.test.ts` — adds the production-reader cutover guard and alias, relative, static require, dynamic import, nested-directory, optional-root, and test/evaluation allowance cases.
- `lib/evaluation/canonicalPricingRealFixtureParity.test.ts` — removes the older personal corpus path and derives optional sibling evaluation fixtures from `GOLDEN_CORPUS_ROOT`.
- `.gitignore` — ignores Python cache directories and bytecode.

No production module was modified.

## 3. Golden artifact inventory and hashes

Corpus: external local directory supplied at runtime through `GOLDEN_CORPUS_ROOT`. No username or personal absolute filesystem path is present in the correction source or this report.

| Artifact | Bytes | SHA-256 |
|---|---:|---|
| governing contract / rate schedule PDF | 2,481,310 | `922161a533bb6b8c1afb52cb9536044c8a6836bed62401634f4f505025631e8f` |
| invoice 2026-002 PDF | 67,806 | `af399fea21ba2bca5c0381de2289a564e924e252553403c311c0486fa0723282` |
| invoice 2026-003 PDF | 73,755 | `a530233b65956a5d267320bea2b43c248442e4ab98d762fba8b725549ab255c0` |
| `ticket_query_20260404_191302.xlsx` | 1,535,359 | `241b1c4d9712d40eee844db2ccf5b4c9e436c293bf094d1f5ca72a1c6690d2df` |

The corpus contains exactly these four files. No invoice-detail XLSX, local Golden intelligence trace, support file, or persisted snapshot JSON is present.

### 3.1 Opt-in execution contract

The multi-minute real-fixture suite is opt-in. It executes only when both conditions hold:

- `RUN_GOLDEN_REAL_FIXTURE_TESTS=1`;
- `GOLDEN_CORPUS_ROOT` resolves to a directory containing all four required artifacts.

If the opt-in flag is absent, the corpus variable is absent, or any required artifact is missing, `describe.skipIf(...)` skips the real-fixture suite during collection without reading source bytes or throwing. Therefore the normal `npx vitest run` suite does not execute the Golden PDF/XLSX pipeline and its runtime is unaffected by the real fixture.

Manual Windows PowerShell command:

```powershell
$env:RUN_GOLDEN_REAL_FIXTURE_TESTS = '1'
$env:GOLDEN_CORPUS_ROOT = 'C:\path\to\Golden Project-Williamson'
npx vitest run lib/evaluation/canonicalGoldenFullChainRealFixtureParity.test.ts --testTimeout=900000 --hookTimeout=900000
```

## 4. Real invoice pipeline execution

Safe production-core seam:

`local bytes → extractDocument → runDocumentPipeline`

`processDocument` was deliberately not called because it writes processing status, extraction rows, normalized records, and persistence artifacts.

| Invoice | Typed lines | Canonical lines | Billed total | Result |
|---|---:|---:|---:|---|
| 2026-002 | 6 | 6 | `$534,757.10` | exact |
| 2026-003 | 4 | 4 | `$280,802.25` | exact |

Captured boundaries include the full extraction payload, PDF text/tables/forms/evidence/gaps, typed invoice fields, the current normalized invoice row/lines from `buildCanonicalInvoiceRowsFromTypedFields`, compact pipeline line output, canonical invoice, and canonical lines. The current parser does not expose a complete general-purpose rejection ledger; a line containing no code, description, total, quantity, or price is silently filtered. That unobservable boundary is reported, not reconstructed.

## 5. Historical real transaction pipeline execution against edited derivative

The then-current edited workbook executed through:

`parseWorkbook → detectSheets → normalizeTransactionData → runDocumentPipeline`

| Metric | Current local execution | Current persisted dataset |
|---|---:|---:|
| sheets | 1 (`Ticket Query Results`) | 1 |
| normalized row-grain records | **5,055** | **5,063** |
| total extended cost | `$815,559.35` | `$815,559.35` |
| total transaction quantity | **216,608** | **216,610** |
| ticket-grain CYD | `74,617` | `74,617` |
| total tickets | **2,381** | **2,388** |
| uninvoiced/zero-cost tracking rows | **275** | **283** |
| 2026-002 linked rows / quantity / cost | `2,061 / 61,158 / $534,757.10` | same |
| 2026-003 linked rows / quantity / cost | `2,719 / 145,113 / $280,802.25` | same |

Normalization retains populated malformed/review rows rather than rejecting them, and row-grain records are not deduplicated. Ticket-grain deduplication affects rollups only. The eight-row difference is confined to uninvoiced, zero-cost tracking rows; it does not change invoice support or money, but it is still unexplained source/runtime drift.

The parity assertion deliberately pins the complete divergence object rather than treating 5,055 as accepted persisted truth:

```text
actual real-pipeline count: 5,055
persisted reference count: 5,063
delta: -8
status: unresolved_drift
```

Any count change fails with an instruction to reinvestigate the source/runtime difference instead of silently re-baselining it.

## 6. Historical canonical registry construction

The evaluation harness adapts actual outputs into:

- one real 90-row canonical pricing schedule;
- two canonical invoices;
- ten canonical invoice lines;
- 5,055 canonical row-grain transactions from the edited derivative; the corrected authoritative run contains 5,063;
- one deterministic `CanonicalProjectTruth` registry.

Construction remains `shadow_only`, `persisted: false`, source-hash labelled, and sorted by stable top-level identities. The harness is under `lib/evaluation/**` and is imported by no production reader.

Derived pricing matches, reconciliation objects, validation impacts, and exposure references are intentionally not hand-authored into the registry. Source parity is now resolved, but a typed adapter must still consume the authoritative current Validator result before those sections can be populated without creating another truth path.

Generic focused composition tests separately populate `pricingMatches`, `validationImpacts`, both reconciliation collections, `projectReconciliation`, and exposure references. They verify deterministic collection ordering, intact object ids and field paths, derived-only nesting, no finding or input mutation, and stable serialization. These generic fixtures do not claim real Golden execution.

## 7. Persisted Golden truth retrieval

Read-only Supabase retrieval succeeded through `.env.local`; no credentials were printed and no write/RPC/migration was executed.

- Project id: `437502f2-d46d-447f-81e3-f26fa7ba0c14`; status `VALIDATED`.
- Latest run: `07eb3d80-6675-4fc5-a69c-885b1e0b529b`, complete, 0 findings.
- Historical findings: 362; 359 resolved, 3 dismissed, 0 open.
- Current summary hash: `491707d46dc0b8b253e6b6224171522c6142cacdf1af7d515f20a9c0fc8bd052`.
- Dataset id: `68ded1d3-1ed4-45b7-9d01-d5e405ab3419`; summary hash `7427ae9f0a08f2c576f2f65f7fab5ebcecbc8f69f434480e8a26bee1151a1b53`.
- Exposure: `$815,559.35` billed, supported, and fully reconciled; `$0` unreconciled, at risk, or requiring verification.
- Both invoices are `MATCH`.
- Relationships: three `attached_to` edges from the workbook to the contract and both invoices.
- Seven active legacy fact overrides exist. `human_fact_assertions` and the newer extraction/interpretation snapshot tables are unavailable in the live schema cache.

The latest project approval snapshot is historical/incomplete: it says approved but has zero invoices and null totals, conflicting structurally with the current validation summary. It is not used as exposure truth.

## 8. Contract-pricing parity

Exact accepted ledger:

- 105 rate schedule rows
- 90 assembler rows / canonical candidates
- 56 resolved and approval eligible
- 34 needs review and approval ineligible
- 0 excluded
- 15 merged with diagnostics
- 0 silently lost

The three approved authored-correction rows retain route/distance dimensions and remain review-only. Both `$10.90` description-unresolved rows remain review-only. No matcher or approval input was changed.

## 9. Invoice parity

Both source PDFs produced the expected invoice number, line count, typed amounts, billing keys, and totals. Canonical representation is richer for typed state and evidence, but the source only supplies page-level/anchor evidence for some line fields; it does not provide reliable per-line bounding boxes.

## 10. Transaction parity

Invoice-linked monetary and quantity groups are exact. Canonical adaptation preserves stable record id, invoice/ticket identity, date, rate code, billing keys, material, quantity, applied rate, extended cost, workbook/sheet/row, raw row JSON, and cell/row evidence. Current normalized-source adaptation does not promote unit, origin/destination, route, or distance band even when a raw column may exist.

Classification: `conflicting current truth path` for the eight zero-cost tracking records; `exact semantic parity` for both invoice-linked populations and all monetary totals.

## 11. Reconciliation parity

Current persisted exposure and direct transaction-group matching show:

- 2026-002: 2,061 linked rows, `$534,757.10`, `MATCH`.
- 2026-003: 2,719 linked rows, `$280,802.25`, `MATCH`.
- 2026-003 rate groups: 2A 1,337 rows; 2B 1,337; 3B 23; 3C 22.

The canonical model already separates candidate presence from selected governing truth, but this slice does not fabricate derived reconciliation objects from summary strings. Exact numeric source facts are present in the registry; current conclusions remain authoritative in `validation_summary_json` until a typed result adapter is added.

## 12. Validation parity

The previously hand-authored open finding was stale and has been removed from the Golden shadow test. Current persisted truth is 0 open findings and 0 findings in the latest run. No finding, disposition, or approval outcome was changed by this slice. No real-fixture claim now comes from a hand-authored Golden contract-to-invoice-to-transaction chain; repository policy requires that proof to remain under `lib/evaluation/**`.

Classification: `conflicting current truth path` for the deleted test fixture; `exact semantic parity` with the current persisted latest run.

## 13. Exposure parity

| Amount | Current persisted truth | Real local source totals |
|---|---:|---:|
| billed | `$815,559.35` | `$815,559.35` |
| supported | `$815,559.35` | `$815,559.35` |
| unsupported/unreconciled | `$0` | `$0` by invoice-linked totals |
| requires verification | `$0` | no contrary amount |
| at risk | `$0` | no contrary amount |
| blocked | `$0` | no current finding |

## 14. ROW-to-DMS 0–15 trace

| Link | Real result |
|---|---|
| contract row | `pdf:table:p8:t26:r2`; Vegetative; Cubic Yard; `$6.90`; `ROW to DMS`; `0 to 15 Miles` |
| contract state | authored correction; `needs_review`; approval false |
| invoice line | 2026-002 / 1A / 43,894 / `$6.90` / `$302,868.60` |
| transactions | 775 row-grain records; quantity 43,894; cost `$302,868.60`; sheet/row/raw evidence present |
| current persisted conclusion | invoice 2026-002 `MATCH`; project `VALIDATED`; no open finding |
| canonical selection | candidate-vs-selected fields are representable; no selected derived object is fabricated in this revision |

The requested “current finding preserved” premise is superseded by current persisted truth. The test now proves that no stale open finding is reintroduced.

## 15. Invoice 2026-003

- 4 invoice lines; billed total `$280,802.25`.
- 2,719 transaction rows; supported quantity 145,113; extended cost `$280,802.25`.
- Rate groups: 2A `$105,744.00`; 2B `$158,616.00`; 3B `$8,040.00`; 3C `$8,402.25`.
- Current exposure conclusion `MATCH`; 0 at risk.
- Evidence is complete at workbook row/cell grain. Invoice line geometry is not available at bbox grain.
- It does not reveal a new canonical business concept, but it reinforces the source-model gaps for unit and location/distance promotion.

## 16. Candidate-versus-selected matrix

Real Golden lines exercise candidate presence, selected current pricing, selected review-only pricing, and exact-rate support. The canonical type explicitly retains `candidatePresent`, `candidateCount`, `selectedGoverningRowId`, `selectionStatus`, `selectedRowApprovalEligible`, `expectedRateAvailable`, and `unresolvedReason`.

The real 1A line is the important split: the pricing candidate exists and is review-only, while current persisted invoice reconciliation is `MATCH`. The canonical derived section remains empty rather than falsely selecting or rejecting the candidate. Synthetic unit tests continue to cover no-candidate, ambiguous/multiple-candidate, rate-mismatch, unit-mismatch, and applicability-unresolved statuses; they are not labelled as real Golden evidence.

## 17. Rejection/loss ledger

- Contract pricing: 15 merge suppressions, all diagnosed; 0 silent loss.
- Invoice operational assembly: observable rejected rows are captured when emitted.
- Invoice parser: general rejected/suppressed candidates are not exposed; the all-empty line filter is a documented silent boundary.
- Transactions: 275 retained rows carry `missing_invoice_link`; all have zero cost and preserved sheet/row/raw evidence. They remain canonical review records rather than being silently removed.
- Historical edited-derivative comparison: eight authoritative uninvoiced/zero-cost rows are absent from the edited copy. The focused dataset diff identified all eight; this is source-variant evidence, not pipeline loss.

## 18. Duplicate truth paths

| Concept | Paths | Classification |
|---|---|---|
| invoice identity/lines | typed extraction; normalized runtime; Validator rows; Project Facts display | source + typed projections + display projection |
| transaction quantity/cost | normalized workbook; persisted rows/dataset summary; Validator; Project Facts | source/runtime vs persisted conflict on 8 rows |
| rate keys/matching | invoice parser; XLSX normalization; `billingKeys`; rule-pack private projections | derived duplication |
| reconciliation/exposure | Validator runtime; persisted `validation_summary_json`; Project Facts overlay | source of record + derived/display projections |
| Golden test truth | former hand-authored chain | removed conflicting fixture truth path |
| approval snapshot | incomplete historical snapshot | legacy/incomplete projection |

## 19. Source-model gaps

| Gap | Recommendation |
|---|---|
| per-line invoice bbox/raw span mapping | add evidence sidecar at invoice parsing boundary |
| invoice rejected-candidate ledger | preserve at earlier parser boundary |
| transaction unit | add adapter field only after typed upstream field is confirmed |
| timestamp, origin/destination, route, band | preserve/promote at normalization boundary; do not parse in canonical adapter |
| human review/override history | source-model/schema alignment first; live `human_fact_assertions` is unavailable |
| extraction snapshot FK verification | fix live schema/migration alignment before persistence integration |
| eight persisted-only tracking rows | focused source-row identity diff before artifact generation |

## 20. Static, test, and build results

- `npx tsc --noEmit`: passed after final edits.
- Changed-file ESLint with `--max-warnings=0`: passed.
- Default-skip proof: targeted normal-mode run passed 27 tests with the real full-chain test skipped; no `GOLDEN_CORPUS_ROOT` was required and no Golden PDF/XLSX pipeline executed.
- Canonical composition and fixture-boundary tests: 18 tests passed.
- Reader-cutover guard: 9 tests passed, including alias, relative, static require, dynamic import, nested `canonical` directory, missing root, and test/evaluation allowance cases.
- Explicit opt-in real full-chain test: passed, 1 test, 420.510 s (430.02 s total command duration).
- Opt-in invoice results: 2026-002 produced 6 lines / `$534,757.10`; 2026-003 produced 4 lines / `$280,802.25`.
- Opt-in workbook and registry: one workbook/sheet, 5,055 normalized rows, 5,055 shadow-registry transactions, `$815,559.35`, 74,617 ticket-grain CYD, and 275 non-silent loss-ledger entries.
- Opt-in divergence: 5,055 actual versus 5,063 persisted, delta -8, status `unresolved_drift`.
- Exact default `npx vitest run`: **passed** with 207 files passed, 1 skipped; 1,839 tests passed, 6 skipped. The expensive Golden full-chain suite was skipped as intended.
- The default gate was red before this slice for a pre-existing reason unrelated to the Golden corpus: `lib/evaluation/pdfSourceMutations.test.ts` (7) and `lib/evaluation/syntheticGeneralizationHarness.test.ts` (1) timed out under the 5 s default on every machine, corpus or not. Those suites were given explicit `{ timeout: 30_000 }` in the separate baseline-health commit `c8c27f1`, which is not part of this slice.
- Production build: passed; 42/42 static pages generated. Existing `pdfjs-dist` externalization warning only.
- `git diff --check`: passed for tracked slice files; LF-to-CRLF working-copy notices only.

## 21. Known limitations

- Historical note resolved: the edited derivative and persisted dataset are not row-identical; the restored authoritative corpus and persisted dataset are exact at 5,063 rows.
- The canonical derived registry sections are not populated from display summaries or hand-authored objects.
- Current invoice parsing does not expose a comprehensive rejection ledger or per-line bbox closure.
- Live schema is behind repository migrations for interpretation/snapshot ledgers.
- Optional vision supplementation was unavailable; deterministic OCR completed.

### Bounded guard coverage

Both new guards are behavioral, but their reach is deliberately bounded. These are documented scope limits, not defects:

- The Golden fixture boundary is **name-based**. `golden_exposure_proof` and `manual_golden_full_chain` both require a Golden identity literal (`Golden Project`, `golden-project`, `golden-full-chain`). A reintroduced hand-authored chain named for something else — for example `williamson-fixture` — would not trip those rules. `golden_validation_finding` is broader, keying on a `project_id` initializer matching `/golden/i` alongside a `@/types/validator` import.
- The TypeScript AST parser is applied **only to canonical Project Truth import candidates**. `allEdges()` still uses the memoized regex scanner for the pre-existing layer-boundary rules; the AST path runs only for files that already contain `canonical/project/`. Existing boundary rules therefore did not gain AST accuracy in this slice.
- `canonicalPricingRealFixtureParity.test.ts` derives the TDOT and MDOT fixture paths from `dirname(GOLDEN_CORPUS_ROOT)`. If the configured Golden root does not sit beside those sibling directories, those fixtures skip with a reported reason rather than failing or passing falsely.

## 22. Exact next integration boundary

Do **source-model repair first**, narrowly:

1. Diff the 5,055 local normalized transaction identities against the 5,063 persisted identities and identify the eight tracking rows and the 2-unit/7-ticket delta.
2. Add an evaluation-only typed adapter from the current `ValidatorResult` to canonical pricing matches, reconciliations, validation impacts, and exposure references; do not read Project Facts display strings.
3. Add an observable invoice-parser rejection ledger/evidence sidecar without changing acceptance behavior.
4. Generate a checked full-chain artifact only after those results are deterministic and include source hashes, generator commit/version, stable identities, and authoritative persisted snapshot hashes.
5. Keep the next production slice to `current outputs → canonical shadow publisher → comparison diagnostics`; no reader cutover.

Do not begin a Project Facts read experiment, Validator input experiment, persistence adapter, or migration until these gates are closed.

## 23. Decision rationale

`READY FOR CODE REVIEW` is not justified because the acceptance criteria require the exact default `npx vitest run` command to succeed, and it currently fails on eight timeouts in pre-existing unrelated Phase 3 evaluation tests. The correction does not expand scope by changing those files or the global Vitest timeout.

The 5,055-versus-5,063 difference is no longer an unlabelled blocker: it is an asserted `unresolved_drift` object and any change requires reinvestigation rather than silent re-baselining. Populated derived composition is covered with generic fixtures, not a fabricated Golden chain.

`INSUFFICIENT LIVE PARITY EVIDENCE` is not accurate: live project, findings, relationships, dataset, exposure, and approval state were retrieved successfully.

`BLOCKED BY SOURCE MODEL` is too strong: the core business facts are representable and exact; the remaining issues are observable boundary/version alignment and a contained derived-result adapter.

Therefore the correct decision is **REVISE**.
