# Golden Transaction Fixture Restoration — 2026-08-01

**Scope:** fixture/reference correction only. No transaction parser, normalization, filtering, deduplication, Validator, canonical-domain, Project Facts, exposure, persistence, or migration code changed. Nothing committed or pushed.

## 1. Git state

- Branch: `main`.
- Validation base commit: `e037d6b5ec41c6704d7c1f06ec047d56b16410c8`.
- The worktree began dirty with unrelated Phase 3 extraction, contract, synthetic-generalization, audit, script, and pet changes. They were preserved and excluded from this slice.
- No file is staged. No commit or push was performed.

## 2. Authoritative workbook identity

| Field | Value |
|---|---|
| logical role | `authoritative_original_export` |
| persisted relationship | `persisted_ingest_source` |
| filename | `ticket_query_20260404_191302.xlsx` |
| SHA-256 | `86cb49a07295aac80e8595a821ac595153ab1e0e3a8e7536dc7b0889c96f516e` |
| bytes | 1,238,227 |
| workbook application/version | Microsoft Excel / `12.0000` |
| created / modified | `2026-04-04T19:12:31.000Z` / `2026-04-04T19:12:31.000Z` |
| last author | `Unknown Creator` |
| worksheet / range | `Ticket Query Results` / `A1:CF5064` |
| physical / data rows | 5,064 / 5,063 |
| columns | 84 |

The full 84-column ordered header map is committed in the fixture manifest. Physical inspection and real-pipeline execution independently confirm this identity.

## 3. Edited variant identity

| Field | Value |
|---|---|
| logical role | `edited_derivative` |
| authority status | `non_authoritative` |
| filename | `ticket_query_20260404_191302.edited-2026-06-08.xlsx` |
| SHA-256 | `241b1c4d9712d40eee844db2ccf5b4c9e436c293bf094d1f5ca72a1c6690d2df` |
| bytes | 1,535,359 |
| workbook application/version | Microsoft Excel / `16.0300` |
| created / modified | `2026-06-08T15:25:31.000Z` / `2026-06-08T15:32:52.000Z` |
| last author | `Eric Martin` |
| worksheet / range | `Ticket Query Results` / `A1:CG5056` |
| physical / data rows | 5,056 / 5,055 |
| columns | 85 |

Headers 0–29 are identical. The edited derivative inserts `Project Specific Detail` at index 30 and shifts the remaining headers by one column. It is a strict subset of the authoritative workbook after eight row deletions.

## 4. Fixture layout

```text
Golden Project-Williamson/
  ticket_query_20260404_191302.xlsx
  manifest.json
  transaction/
    variants/
      ticket_query_20260404_191302.edited-2026-06-08.xlsx
```

The root workbook path remains stable for existing tooling. The root file is now authoritative; the edited derivative is retained under an explicit variant path.

## 5. Manifest design

`lib/evaluation/goldenTransactionFixtureManifest.json` is the checked-in, deterministic provenance artifact. It contains no absolute path and records:

- logical identity, role, authority, hash, byte size, sheet, range, rows, columns, workbook metadata, and ordered headers;
- relationship to the persisted ingest and to the edited derivative;
- exact authoritative rollups;
- the eight-row deletion ledger, including Excel row, ticket identity, values, raw-row SHA-256, and persisted row id;
- the source-hash persistence gap and proposed future fields;
- validation commit and timestamp.

The same manifest is copied to the external corpus root as `manifest.json`. The committed JSON is canonical two-space serialization and its test rejects personal absolute paths.

## 6. Files copied or moved

1. The former root edited workbook was copied byte-for-byte to `transaction/variants/ticket_query_20260404_191302.edited-2026-06-08.xlsx`; its `241b…` hash was verified after copying.
2. The original export was copied byte-for-byte onto the existing root fixture path; its `86cb…` hash and 1,238,227-byte size were verified after copying.
3. The deterministic manifest was copied to the corpus root.

No workbook contents were edited.

## 7. Harness hash changes

- `GOLDEN_SOURCE_SPECS.workbook.sha256` now derives from the authoritative manifest (`86cb…`).
- The workbook spec records `sourceRole: authoritative_original_export` and expected row count 5,063.
- The byte boundary rejects the known edited hash with `non_authoritative_source`, rejects unknown hashes explicitly, and accepts only the authoritative hash.
- The post-pipeline boundary requires 5,063 rows for the authoritative hash and reports `exact_source_parity` only at delta 0.

## 8. Authoritative execution results

| Source/result | Lines | Amount | Evidence result |
|---|---:|---:|---|
| Invoice 2026-002 | 6 | `$534,757.10` | exact typed/canonical result; source evidence retained |
| Invoice 2026-003 | 4 | `$280,802.25` | exact typed/canonical result; source evidence retained |

| Transaction metric | Result |
|---|---:|
| normalized rows | 5,063 |
| total quantity | 216,610 |
| total extended cost | `$815,559.35` |
| unique tickets | 2,388 |
| uninvoiced retained review rows | 283 |
| ticket-grain invoiced CYD | 74,617 |
| rejected/lost source rows | 0 |
| non-silent review-ledger entries | 289 |

The 289 ledger entries comprise 283 missing-invoice links and six invalid-quantity observations. Every referenced source record remains in the 5,063-row canonical population with raw evidence; none is a rejected or silently lost source row.

## 9. Variant diagnostic results

The standalone script runner executed both real workbooks through `parseWorkbook → detectSheets → normalizeTransactionData`:

| Metric | Authoritative | Edited variant | Delta |
|---|---:|---:|---:|
| normalized rows | 5,063 | 5,055 | -8 |
| rows only in authoritative | 8 | — | 8 |
| rows only in edited variant | — | 0 | 0 |
| distinct-ticket impact | — | — | -7 |
| quantity impact | — | — | -2 |
| extended-cost impact | — | — | `$0.00` |
| row/full-grain CYD impact | — | — | -120 |
| invoice-linked impact | — | — | 0 |

Deleted Excel rows are exactly 1068, 1791, 2118, 3827, 4716, 4717, 4936, and 5003. The manifest retains their complete identity/value/hash ledger. The result is classified `non_authoritative_source`, not pipeline loss.

## 10. Persisted parity

A fresh read-only persisted check on 2026-08-02 returned dataset `68ded1d3-1ed4-45b7-9d01-d5e405ab3419` with:

- 5,063 rows;
- 216,610 quantity;
- `$815,559.35` extended cost;
- 2,388 tickets;
- 283 uninvoiced rows;
- 74,617 ticket-grain CYD.

The authoritative current-pipeline population is 5,063, persisted reference is 5,063, delta is 0, and status is `exact_source_parity`. Persisted truth was not re-baselined.

## 11. Financial and quantity parity

- Invoice total: `$815,559.35`.
- Transaction extended cost: `$815,559.35`.
- Authoritative transaction quantity: 216,610.
- Ticket-grain invoiced CYD: 74,617.
- The edited derivative's eight absent rows account for quantity 2 and full-dataset CYD 120, but `$0.00` and no invoiced CYD.

## 12. Finding/exposure impact

Fresh persisted truth remains `VALIDATED` with zero open findings. Invoices 2026-002 and 2026-003 remain `MATCH`. Exposure remains `$815,559.35` billed and supported, `$0` at risk, `$0` unreconciled, and `$0` requiring verification. Approval outcomes are unchanged.

The eight edited-variant omissions have no invoice link and zero extended cost, so they do not enter invoice findings or exposure. No Validator or exposure behavior changed.

## 13. Diagnostic-code disposition

Disposition: **retain a smaller source-neutral, opt-in comparator**.

- Production imports: none.
- Default-suite real workbook execution: none.
- Real large-file comparison: script runner only.
- Paths: supplied through `GOLDEN_AUTHORITATIVE_TRANSACTION_WORKBOOK` and `GOLDEN_EDITED_TRANSACTION_WORKBOOK`.
- Deterministic output excludes absolute input paths and filesystem mtimes; workbook-internal metadata remains.
- CSV sorting is deterministic by sheet, row, then record id.
- Vitest covers pure comparison, multiplicity, ordering, environment gating, and output sanitization without loading real workbooks.

Preferred runner:

```powershell
$env:GOLDEN_AUTHORITATIVE_TRANSACTION_WORKBOOK = '<authoritative workbook>'
$env:GOLDEN_EDITED_TRANSACTION_WORKBOOK = '<edited derivative workbook>'
$env:GOLDEN_ROW_DRIFT_OUT_DIR = '<diagnostic output directory>'
npx tsx scripts/evaluation/runGoldenTransactionRowDrift.ts
```

## 14. Source-hash persistence gap

`documents` and `transaction_data_datasets` do not persist transaction source SHA-256. No schema change is included here. A future contained migration and ingestion slice should consider:

- source SHA-256 and byte size;
- source worksheet identity;
- ingestion parser version;
- derived artifact manifest hash.

That future change requires its own migration, backfill, RLS, replay, and deployment review.

## 15. Tests and build results

- `npx tsc --noEmit`: passed.
- Changed-source ESLint with `--max-warnings=0`: passed.
- Manifest and source-neutral diagnostic tests: 2 files passed, 10 tests passed.
- Canonical Golden tests in default mode: 3 files passed, 1 skipped; 21 tests passed, 1 opt-in test skipped.
- Architecture boundary after relocating the manifest out of the reserved `fixtures` directory: 9 tests passed.
- `npm run build`: passed. The existing `pdfjs-dist` worker externalization warning remains non-fatal.
- `git diff --check`: passed before this report update and is rerun as the final repository check.
- Standalone authoritative-versus-variant comparator: passed with the exact eight-row ledger and `$0.00` cost impact.
- Explicit authoritative full-chain run: passed, 1 test, 401.928 seconds (417.08 seconds total); 5,063 rows, delta 0, exact rollups, and 289 review-ledger entries.
- Exact default `npx vitest run`: **not green**. After the contained architecture violation was fixed, the run reported 205 files passed, 1 skipped, and 4 contention-timeout failures (`processDocument` warm-up hook, one `projectFacts` test, one `persistValidationRun` test, and `jobRouteShadowIsolation`). It completed 1,837 tests successfully with 15 skipped before exiting red.
- Contention audit: all four affected suites passed independently with `--testTimeout=30000 --hookTimeout=30000` (9 `processDocument`, 32 `projectFacts`, 31 `persistValidationRun`, and 1 `jobRouteShadowIsolation` tests). No assertion regression was reproduced, but the literal default-suite gate remains unmet and was not hidden by changing unrelated timeout configuration.

The expensive real fixture remains opt-in through `RUN_GOLDEN_REAL_FIXTURE_TESTS=1` and `GOLDEN_CORPUS_ROOT`; it did not execute during the default suite.

## 16. Exact files to stage

```text
docs/audits/canonical-golden-full-chain-shadow-2026-08-01.md
docs/audits/golden-transaction-row-drift-investigation-2026-08-01.md
docs/audits/golden-transaction-fixture-restoration-2026-08-01.md
lib/evaluation/canonicalGoldenFullChainHarness.ts
lib/evaluation/canonicalGoldenFullChainRealFixtureParity.test.ts
lib/evaluation/goldenTransactionFixtureManifest.json
lib/evaluation/goldenTransactionFixtureManifest.ts
lib/evaluation/goldenTransactionFixtureManifest.test.ts
lib/evaluation/goldenTransactionRowDriftDiagnostic.ts
lib/evaluation/goldenTransactionRowDriftDiagnostic.test.ts
scripts/evaluation/runGoldenTransactionRowDrift.ts
```

## 17. Files excluded

Exclude every other modified or untracked path, especially:

- `lib/extraction/domain/**` and other Phase 3 extraction/diagnostic files;
- `lib/contracts/**` line-ending or unrelated contract work;
- `lib/evaluation/syntheticGeneralizationHarness.ts` and unrelated evaluation diagnostics;
- `scripts/phase3-step4/**`;
- `public/pets/**`;
- temporary JSON/CSV diagnostic output;
- the external corpus workbook bytes, which are not repository files.

Do not use `git add .` or `git commit -a`.

## 18. Proposed commit

**Message:** `test(golden): restore authoritative transaction fixture identity`

**Body:**

```text
Restore the Golden transaction corpus to the original persisted-ingest bytes.

Preserve the edited 5,055-row workbook as a non-authoritative variant and
pin both identities in a deterministic fixture manifest. Update the opt-in
full-chain parity gate to require 5,063 rows with exact persisted parity, and
retain a script-only comparator for authoritative-versus-variant evidence.

No transaction pipeline, Validator, canonical truth, persistence, or migration
behavior changes.
```

## 19. Decision

**REVISE.** The fixture/reference correction itself is complete and the authoritative opt-in run passes every parity requirement. The strict readiness rule also requires the literal default `npx vitest run` command to be green; it remains red from four all-at-once contention timeouts even though every affected suite passes independently under the repository's 30-second contention protocol. No unrelated timeout files were changed. Nothing is staged, committed, or pushed.
