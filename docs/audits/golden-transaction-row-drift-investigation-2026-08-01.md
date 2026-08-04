# Golden Transaction-Row Drift Investigation — 2026-08-01

**Mode:** investigation only. No production behavior changed. No transaction normalization, canonical model, Validator, Project Facts, exposure, pricing, extraction, persistence, or migration touched. Nothing committed or pushed.

---

# DECISION

# DIFFERENT GRAIN OR SOURCE

`5,055` and `5,063` are both correct. They are not comparable because they were produced from **two different workbook files that share the filename `ticket_query_20260404_191302.xlsx`**.

- The persisted reference (`5,063`) derives from the original 2026-04-04 export, SHA-256 `86cb49a0…`.
- The current real-pipeline execution (`5,055`) runs against a **re-saved copy in the Golden corpus directory**, SHA-256 `241b1c4d…`, edited in Excel on **2026-06-08 by "Eric Martin"**, in which **eight rows were deleted and one column (`Project Specific Detail`) inserted**.

The current pipeline is not dropping anything. Executed against the original workbook it emits exactly **5,063** rows and reproduces **every** persisted rollup byte-for-byte. Executed against the corpus copy it emits exactly **5,055**. The eight rows are identified individually below by workbook row number, ticket number, ticket GUID, and persisted row id.

**Recommended owner: fixture/reference.** The defect is in the Golden corpus artifact, not in the pipeline and not in the persisted data.

## Resolution — 2026-08-02

The fixture/reference correction is complete and remains uncommitted pending review:

- The authoritative original export (`86cb49a07295aac80e8595a821ac595153ab1e0e3a8e7536dc7b0889c96f516e`) is installed at the corpus path consumed by the Golden full-chain harness.
- The edited workbook (`241b1c4d9712d40eee844db2ccf5b4c9e436c293bf094d1f5ca72a1c6690d2df`) is preserved under `transaction/variants/` and labelled `non_authoritative_source`.
- The harness pins the authoritative hash and role `authoritative_original_export`; the edited and unknown hashes fail closed.
- Authoritative real-pipeline execution emits 5,063 rows and matches the persisted 5,063-row population with delta 0 and status `exact_source_parity`.
- The edited derivative remains reproducible as 5,055 rows, delta -8, `$0.00` extended-cost impact, and no invoice, finding, or exposure impact.
- A deterministic checked-in fixture manifest records both identities, workbook metadata, row/column populations, known relationship, and the source-hash persistence gap.
- No transaction parsing, normalization, filtering, deduplication, Validator, canonical truth, Project Facts, exposure, persistence, or migration logic changed.
- Implementation commit: pending. Nothing committed or pushed.

The original investigation below is preserved unchanged as the evidence trail that led to this resolution.

---

## 1. Git state

- HEAD: `bf51956aab4251712933988af5cafd4b7f0f1a28` on `main` — `test(canonical): add opt-in Golden full-chain parity`.
- 51 pre-existing modified/untracked entries in the worktree (Phase 3 extraction, header-evidence, synthetic-generalization, audit, script, and pet files). Recorded and untouched.
- Added by this investigation (evaluation-only, unstaged, uncommitted):
  - `lib/evaluation/goldenTransactionRowDriftDiagnostic.ts`
  - `lib/evaluation/goldenTransactionRowDriftDiagnostic.test.ts`
  - `scripts/evaluation/runGoldenTransactionRowDrift.ts`
  - this report
- No commit, no push, no staged file.

## 2. Source workbook identity and hash

Two distinct files named `ticket_query_20260404_191302.xlsx` exist on this machine.

| | **A — Golden corpus copy** | **B — original export** |
|---|---|---|
| location | `<Desktop>\EightForgeDocTrainning\Training Projects\Golden Project-Williamson\` | `<Downloads>\` |
| SHA-256 | `241b1c4d9712d40eee844db2ccf5b4c9e436c293bf094d1f5ca72a1c6690d2df` | `86cb49a07295aac80e8595a821ac595153ab1e0e3a8e7536dc7b0889c96f516e` |
| bytes | 1,535,359 | 1,238,227 |
| filesystem created / modified | 2026-04-04 19:14:11 / **2026-06-08 15:32:52** | 2026-04-04 19:13:21 / 2026-04-04 19:13:24 |
| workbook `CreatedDate` / `ModifiedDate` | **2026-06-08T15:25:31Z** / **2026-06-08T15:32:52Z** | 2026-04-04T19:12:31Z / 2026-04-04T19:12:31Z |
| `Application` / `AppVersion` | Microsoft Excel / **16.0300** | Microsoft Excel / **12.0000** |
| `LastAuthor` | **Eric Martin** | Unknown Creator |
| worksheets | 1 — `Ticket Query Results` | 1 — `Ticket Query Results` |
| hidden worksheets | 0 | 0 |
| defined names / tables | 0 | 0 |
| used range | `A1:CG5056` | `A1:CF5064` |
| physical rows | **5,056** (1 header + 5,055 data) | **5,064** (1 header + 5,063 data) |
| physical columns | **85** | **84** |
| blank rows inside used range | 0 | 0 |
| hidden rows | 0 | 0 |
| filtered rows / autofilter | none | none |
| merged cells | 0 | 0 |
| formula cells | 0 (cached values only) | 0 (cached values only) |
| comments | none observed | none observed |

`241b1c4d…` is the hash pinned in `lib/evaluation/canonicalGoldenFullChainHarness.ts:20`. The harness therefore verifies that it is reading the **corpus copy** — and passes — while the persisted reference was never produced from that file.

### 2.1 Structural divergence

The corpus copy inserts one column, `Project Specific Detail`, at **0-based index 30**. Headers 0–29 are identical; every header from index 30 onward shifts by +1:

| Column | original index | corpus index |
|---|---:|---:|
| `Material` | 28 | 28 |
| `Diameter` | 30 | 31 |
| `CYD` | 42 | 43 |
| `Mileage` | 44 | 45 |
| `Net Tonnage` | 47 | 48 |
| `Invoice Date` | 68 | 69 |
| `Invoice Status` | 69 | 70 |
| `Rate Code` | 70 | 71 |
| `Invoice #` | 72 | 73 |
| `Transaction #` | 73 | 74 |
| `Extended Cost` | 76 | 77 |
| `Net Quantity` | 77 | 78 |
| `Eligibility` | 79 | 80 |

### 2.2 Was the persisted 5,063 generated from this exact workbook hash?

**No — and the persisted artifact does not record a source hash.** Stated explicitly as required:

- `documents` has no hash/checksum/size column (`id, organization_id, name, storage_path, status, created_at, title, document_type, project_id, processing_status, processing_error, processed_at, source_type, mime_type, file_path, domain, intelligence_trace, intelligence_trace_updated_at, operator_override_precedence, precedence_rank, deleted_at, operational_status, document_role, authority_status, effective_date, document_subtype`).
- `transaction_data_datasets` has no hash column either.

The source workbook is nevertheless identified **structurally and beyond doubt** by two independent proofs:

1. **Column geometry.** `documents.intelligence_trace.facts.header_map` records `cyd → column_index 42`, `diameter → 30`, `mileage → 44`, `net_tonnage → 47`, `invoice_date → 68`, `rate_code → 70`, `net_quantity → 77`, `eligibility → 79`. Every one matches workbook **B**; not one matches workbook **A**.
2. **Row content.** Zero of the 5,063 persisted rows carry the corpus-only `Project Specific Detail` key in `record_json.raw_row`, and all eight rows missing from A are present in the persisted table at their exact workbook-B row numbers (§7).

Timeline corroborates: `documents.created_at = 2026-04-04T20:01:09Z` (upload), `storage_path` prefix `1775332868646` ≈ 2026-04-04T20:01:08Z, `processed_at = 2026-06-10T17:08:18Z`. `docs/extraction/cyd-grain-confirmation.md` and `docs/environment/golden-data-location.md` already reported `5,063` on **2026-06-07** — before the corpus copy was edited on 2026-06-08. The ingest re-read the stored 2026-04-04 bytes; it never saw the desktop edit.

## 3. Definition of the 5,055 count

`5,055` is `result.records.length` in `lib/evaluation/canonicalGoldenFullChainHarness.ts:142`, i.e. the length of

`extraction.content_layers_v1.spreadsheet.normalized_transaction_data.records`

produced by the chain `parseWorkbook → detectSheets → normalizeTransactionData` over workbook **A**.

Stage boundaries, verified by execution:

| Stage | Boundary | Count (A) |
|---|---|---:|
| 1 physical workbook row | used range `A1:CG5056` | 5,056 |
| 2 parser-emitted row | `parseWorkbook` drops the header row, `sheet_to_json({blankrows:false})`, then `.filter(row => some value !== null)` (`parseWorkbook.ts:140-153`) | **5,055** |
| 3 normalized transaction row | `normalizeTransactionData` pushes `buildRecord(analysis, row)` for **every** parser row — `normalizeTransactionData.ts:2138-2140` | **5,055** |
| 4 eligibility/filter | **none exists** — no row is removed at this stage | 5,055 |
| 5 dedupe | **none exists** at row grain; ticket dedupe affects rollups only | 5,055 |
| 6 invoice-link | classification only, not removal: 4,780 linked / 275 unlinked | 5,055 |
| 7 final output | `records.length` | **5,055** |
| 8 persisted-reference membership | 5,055 of 5,063 persisted rows matched; 8 unmatched | — |

**The transaction chain contains no row-rejection rule after `parseWorkbook`.** Stage 2 = stage 3 exactly, asserted by the new diagnostic. The only removal rules that exist at all are the two blank-row rules in `parseWorkbook`, and on both workbooks they remove **zero** rows (blank-row count is 0 in each used range).

## 4. Definition of the 5,063 count

| Question | Answer |
|---|---|
| exact artifact | Supabase `public.transaction_data_rows`, `project_id = 437502f2-d46d-447f-81e3-f26fa7ba0c14`; corroborated by `transaction_data_datasets.row_count` (dataset `68ded1d3-1ed4-45b7-9d01-d5e405ab3419`) and `summary_json.row_count` |
| query | `select count(*) from transaction_data_rows where project_id = …` → **5,063** |
| grain | **transaction row grain** — one persisted row per workbook data row, carrying `source_sheet_name` + `source_row_number`. Not tickets, not unique ticket numbers |
| deleted / soft-deleted | none — no soft-delete column on the table; all 5,063 live |
| superseded / stale versions | none — single dataset row, single `document_id` |
| duplicates | none by source coordinate (§12) |
| summary / invalid / unmatched rows included | yes, and identically to local: 283 rows carry no invoice link and $0 cost; they are retained as review records, not rejected |
| spans one workbook or many | **one** — all 5,063 rows carry `document_id = 04e23a28-61a0-4abc-91ac-8c6f2db31ecf` and `source_sheet_name = 'Ticket Query Results'` |
| prior pipeline version | no — `lib/extraction/xlsx/parseWorkbook.ts` has not been modified since 2026-05-01, well before the 2026-06-10 ingest; the only post-ingest change to `normalizeTransactionData.ts` is header-alias cache memoization (`99a2505`, `368e763`, 2026-07-17), which does not touch row emission |
| manual inserts / corrections | none — all 5,063 rows share one contiguous ingest batch on 2026-06-10 (§12) |

## 5. Count grain and scope comparison

| Dimension | 5,055 | 5,063 | Comparable? |
|---|---|---|---|
| grain | transaction row | transaction row | ✅ same |
| sheet | `Ticket Query Results` | `Ticket Query Results` | ✅ same |
| workbook count | 1 | 1 | ✅ same |
| pipeline version | HEAD `bf51956` | row-emission code identical to HEAD | ✅ same |
| inclusion policy | all rows retained, none rejected | all rows retained, none rejected | ✅ same |
| **source file** | **`241b1c4d…` (5,055 data rows)** | **`86cb49a0…` (5,063 data rows)** | ❌ **different** |

Grain, scope, sheet, and pipeline are identical. **The source file is the only difference**, and it is sufficient to explain the entire delta.

## 6. Stage-by-stage row counts

Both workbooks executed through the real production chain:

| Stage | Workbook A (corpus, pinned) | Workbook B (original, persisted source) | Δ |
|---|---:|---:|---:|
| physical rows in used range | 5,056 | 5,064 | −8 |
| parser-emitted rows | 5,055 | 5,063 | −8 |
| normalized rows | **5,055** | **5,063** | **−8** |
| invoice-linked rows | 4,780 | 4,780 | 0 |
| uninvoiced rows | 275 | 283 | −8 |
| distinct tickets | 2,381 | 2,388 | −7 |
| total extended cost | `$815,559.35` | `$815,559.35` | `$0.00` |
| total transaction quantity | 216,608 | 216,610 | −2 |
| ticket-grain CYD (invoiced) | 74,617 | 74,617 | 0 |

**Workbook B reproduces the persisted reference exactly on every axis** — 5,063 rows, 216,610 quantity, `$815,559.35`, 2,388 tickets, 283 uninvoiced, 74,617 ticket-grain CYD. Persisted `summary_json.total_cyd_ticket_grain_full = 74,737`; workbook B full ticket-grain CYD = 74,737; workbook A = 74,617 (74,737 − 120).

## 7. The exact eight rows

Identified by workbook row number, ticket number, ticket GUID, raw-row hash, and stable persisted row id. **Not** by array position.

| # | Excel row (B) | Ticket No | Ticket ID | Rate code | Qty | Ext. cost | CYD | Eligibility | Subcontractor | Persisted `transaction_data_rows.id` |
|---:|---:|---|---|---|---:|---:|---:|---|---|---|
| 1 | 1068 | `330077-2664-51374` | `3C74B5FC-7D84-4F35-AFEC-36F85625F6AE` | — | — | 0 | — | **Void** | Test | `7f397ae5-64dc-4ea5-9156-533c516ef158` |
| 2 | 1791 | `330077-2664-51199` | `B080ADE4-39D8-4830-B8FD-5BC749ED3CE8` | — | — | 0 | — | **Void** | Test | `e9989ee4-01df-4c52-9032-16ce31b18b57` |
| 3 | 2118 | `200000-2671-34627` | `CECFA213-2EAC-499D-8393-6B20F7895B5B` | `6X` | 1 | 0 | — | Eligible | Freins | `df25c88a-3c17-4b8f-a883-8564c9101d52` |
| 4 | 3827 | `200001-2671-30914` | `2E1B73B0-1936-4EF3-8B47-C39C17E7F0ED` | `6X` | 1 | 0 | — | Eligible | Friens | `580f05b3-656f-4fe1-8939-4622b43dd201` |
| 5 | 4716 | `330077-2664-53159` | `D30A42ED-09BB-4E21-A4B1-EE09309A8C8F` | — | — | 0 | 0 | **Void** | Test | `1e6f2421-ab0f-441c-8e49-c0a9131dae58` |
| 6 | 4717 | `330077-2664-53159` | `D30A42ED-09BB-4E21-A4B1-EE09309A8C8F` | — | — | 0 | 0 | **Void** | Test | `40d452c9-e096-4487-b65a-9a5171935785` |
| 7 | 4936 | `500088-2658-54065` | `155ED42D-4506-414E-9A44-FAEDEFC37C3C` | — | — | 0 | 64 | **Out of Scope** | Olson | `bef0c894-4026-4b08-951d-64c45aee83c8` |
| 8 | 5003 | `500087-2658-52378` | `370C26EE-AC3A-47A1-866A-FD782FA896C4` | — | — | 0 | 56 | **Out of Scope** | Olson | `42846b40-7b7a-43a5-bbf2-654cd3076882` |

Free-text corroboration from the source rows themselves:

- rows 1068, 1791, 4716, 4717: `Eligibility External Comments = "Test ticket - EM"`, `Subcontractor = "Test"`, `Truck Other = "Test"`.
- rows 4936, 5003: `Eligibility External Comments = "Outside project boundary- EM."`, `Boundary = outside`, `Maintenance = "Williamson County Neighborhood"`.
- rows 2118, 3827: `Eligibility External Comments = "Changed diameter by rounding down based on photo - RM"`, rate `6X` = *UNDERSIZED* hanging-limb removal at `Transaction Rate = 0`.

**Rows present in A but absent from B: zero.** The corpus workbook is a strict subset. That is the signature of a manual row deletion, not of divergent exports.

### Classification

All eight classify as **different source workbook**. Every other candidate is excluded by evidence:

| Candidate class | Excluded because |
|---|---|
| parser omission | parser emits stage-2 = stage-3 on both files; zero rows dropped after `parseWorkbook` |
| unsupported sheet | one sheet in each file, same name, both processed |
| hidden row | `!rows` hidden count = 0 on both |
| filtered row | no autofilter on either |
| blank-row rule | blank-row count = 0 inside both used ranges |
| summary/footer exclusion | no summary or footer row exists; the eight are ordinary data rows mid-sheet |
| malformed transaction id | all eight carry well-formed `Ticket No` and `Ticket ID` GUIDs |
| missing invoice link | true of all eight, but also true of 275 rows the current pipeline **retains** — so it is not the cause |
| invalid quantity / extended cost | rows 3 and 4 carry valid quantity 1; all eight carry valid `Extended Cost = 0` |
| duplicate suppression | no row-grain dedupe exists anywhere in the chain |
| normalization collision | record ids are `transaction:<sheet>:<row>` — collision-free by construction |
| source-row overwrite | none — A is a strict subset of B, no A-only row exists |
| persisted manual insertion | all 5,063 rows are one machine ingest batch (§12) |
| persisted duplicate | zero duplicate `source_row_number` (§12) |
| prior-version behavior | `parseWorkbook` unchanged since 2026-05-01 (§11) |
| different counting grain | both counts are transaction-row grain (§5) |
| unknown | not reached |

## 8. Row-level rejection ledger

There is nothing to reject. Across both workbooks:

| Boundary | Function | Rows removed (A) | Rows removed (B) | Intentional | Diagnosed | Reversible |
|---|---|---:|---:|---|---|---|
| `sheet_to_json({blankrows:false})` | `parseWorkbook.ts:111-116` | 0 | 0 | yes | n/a — nothing removed | yes |
| all-null row filter | `parseWorkbook.ts:153` | 0 | 0 | yes | n/a — nothing removed | yes |
| header-row removal | `parseWorkbook.ts:141` | 1 | 1 | yes | yes | yes |
| `normalizeTransactionData` | `normalizeTransactionData.ts:2138-2140` | **0** | **0** | n/a — no filter exists | n/a | n/a |
| sheet selection | `normalizeTransactionData.ts:2107-2117` | 0 (one sheet, matched) | 0 | yes | via `gaps` | yes |
| row-count cap | `MAX_SHEETS = 8`, `MAX_COLUMNS = 128` | not reached | not reached | yes | via `gaps` | yes |
| error swallowing | `parseWorkbook` catch → `workbook_parse_failed` gap | not triggered | not triggered | yes | yes | yes |

The 275 (A) / 283 (B) `missing_invoice_link` entries in the harness loss ledger are **retained** review rows, not rejections. They carry full sheet/row/raw evidence.

**Complete subtraction accounting for the −8:**

```
5,063  workbook B data rows
   −8  rows deleted from the workbook file on 2026-06-08 (§7)
──────
5,055  workbook A data rows
   −0  removed by parseWorkbook blank-row rules
   −0  removed by normalizeTransactionData
──────
5,055  final output
```

## 9. Duplicate analysis

The persisted 5,063 does **not** contain duplicates the current pipeline collapses. The current pipeline collapses nothing at row grain.

One genuine duplicate group exists **in the source workbook itself**, and it is present in both the persisted reference and (previously) the corpus copy:

| Field | Value |
|---|---|
| group key | `Ticket ID = D30A42ED-09BB-4E21-A4B1-EE09309A8C8F` (`Ticket No 330077-2664-53159`) |
| source rows | workbook B rows 4716 and 4717 |
| raw difference | **exactly one cell** — `Discrepancy`: `"Invalid Dumpsite Coordinates"` vs `"Trip Time"`. All 83 other columns identical |
| normalized difference | none in canonical fields; distinct `raw_row` hashes (`f8da523c…` / `a3e627a1…`) and distinct record ids (`…:4716` / `…:4717`) |
| winner / losers | none — no dedupe runs; both survive |
| losers auditable | n/a — both retained with full evidence |
| persisted retains all members | **yes** — `1e6f2421-…` and `40d452c9-…` |
| handling changed across versions | no |

This is one physical ticket carrying two discrepancy flags, not a data-quality duplicate. It explains why **8 rows collapse to 7 distinct tickets**.

Specific hazards checked:

- **repeated ticket numbers** — 5,063 rows over 2,388 tickets (1,050 single-row, 1 double-row, 1,337 triple-row). Multi-row tickets are one physical load billed across several rate codes; `CYD` is uniform within every multi-row ticket (0 violations, per `docs/extraction/cyd-grain-confirmation.md`). This is intended row grain, not duplication.
- **same ticket across multiple sheets** — impossible; one sheet.
- **identical rows with different source row numbers** — one pair only, rows 4716/4717, and they are not byte-identical (§ above).
- **whitespace/case normalization collisions** — none; record identity is `transaction:<sheet_key>:<row_number>`, derived from physical coordinates, so no text normalization can collide it.
- **null/blank identifiers** — 283 rows carry no invoice number; all retain a ticket id and a distinct source row number.
- **invoice-number normalization collisions** — only two invoice numbers exist (`2026-002`, `2026-003`); row totals per invoice are identical local vs persisted.

## 10. Filter analysis

Every rule capable of removing a transaction row was traced. Result: **the transaction chain has exactly three, all in `parseWorkbook`, and none removed any of the eight rows.**

| Rule | File / function | Removed (A) | Removed (B) | Rows | Intentional | Diagnosed | Reversible |
|---|---|---:|---:|---|---|---|---|
| empty rows | `parseWorkbook.ts:115` `blankrows:false` | 0 | 0 | — | yes | n/a | yes |
| all-null data row | `parseWorkbook.ts:153` | 0 | 0 | — | yes | n/a | yes |
| header row | `parseWorkbook.ts:141` `.slice(headerRowIndex + 1)` | 1 | 1 | row 1 | yes | yes (`header_row_number`) | yes |
| summary / subtotal / total rows | *no such rule exists* | — | — | — | — | — | — |
| header repetition | *no such rule exists* | — | — | — | — | — | — |
| missing ticket number | *no such rule exists* | — | — | — | — | — | — |
| missing invoice number | *no such rule* — classified, not removed (`hasInvoiceLink`, `normalizeTransactionData.ts:860`) | 0 | 0 | 275 / 283 retained | yes | yes (`uninvoiced_line_count`, loss ledger) | n/a |
| zero quantity | *no such rule* — retained | 0 | 0 | — | — | yes (`rows_with_missing_quantity`) | n/a |
| zero extended cost | *no such rule* — retained | 0 | 0 | — | — | yes (`rows_with_zero_cost`) | n/a |
| invalid dates | *no such rule* — `parseDate` yields `null`, row retained | 0 | 0 | — | — | via `missing_fields` | n/a |
| unsupported material/site | *no such rule* | — | — | — | — | — | — |
| eligibility | *no such rule* — `normalizeEligibility` classifies only; the six Void/Out-of-Scope rows among the eight would have been **retained** | 0 | 0 | — | — | yes (`eligible`/`ineligible` counts) | n/a |
| malformed numeric values | `parseCell` / `parseNumber` yield `null`, row retained | 0 | 0 | — | — | via `missing_fields` | n/a |
| duplicate rows | *no such rule at row grain* | 0 | 0 | — | — | — | — |
| hidden / filtered Excel rows | not consulted by the parser; both files have none anyway | 0 | 0 | — | — | — | — |
| source-sheet allowlist | `normalizeTransactionData.ts:2107-2117` header-score gate | 0 | 0 | the one sheet matched | yes | yes (`transaction_data_headers_unresolved` gap) | yes |
| row-count caps | `MAX_SHEETS = 8`, `MAX_COLUMNS = 128` | not reached | not reached | — | yes | yes (`sheet_limit_applied` gap) | yes |
| error swallowing | `parseWorkbook` catch block | not triggered | not triggered | — | yes | yes (`workbook_parse_failed` gap) | yes |

The eligibility observation is worth stating plainly: **six of the eight deleted rows are `Void` or `Out of Scope`, but the pipeline has no eligibility filter.** Had they remained in the file they would have been emitted like the other 275 uninvoiced rows. Their absence is a file edit, not a rule.

## 11. Historical pipeline comparison

| Question | Finding |
|---|---|
| did a prior pipeline produce 5,063 from a different source? | No. The **current** pipeline produces 5,063 from workbook B — verified by execution at HEAD `bf51956`, not by inference |
| `parseWorkbook.ts` history | last modified `2f352dd` (2026-05-01), before the 2026-06-10 ingest. **Zero commits since 2026-06-10.** The row-emission boundary is byte-identical to what produced the persisted rows |
| `normalizeTransactionData.ts` since 2026-06-10 | `99a2505` and `368e763` (both 2026-07-17) — header-alias regex cache memoization and a self-heal fix. Neither touches `records.push(...)` or any filter |
| migration / backfill / reprocessing scripts | `docs/runbooks/production-migration-apply.md` and its 2026-06-23 logs record `row_count=5063` post-apply; the ticket-grain migration added summary columns only and did not alter row membership |
| prior Golden artifacts | `docs/environment/golden-data-location.md` (2026-06-07) → 5,063; `docs/extraction/cyd-grain-confirmation.md` (2026-06-07) → 5,063 rows / 2,388 tickets / 283 uninvoiced; `docs/runbooks/…/williamson-cyd-sql-gate.txt` → `5063 \| 215729.00 \| 74737.00 \| 815559.35`; `…/williamson-ticket-grain-code-gate.txt` → `row_count 5063`, `total_cyd_ticket_grain 74617`, `…_full 74737` |
| was the −8 introduced intentionally? | Not by any code change. It was introduced by a **manual Excel edit to the corpus artifact on 2026-06-08**, which no commit records and no gate detects |
| isolated-worktree replay of a prior commit | **not required** — running the prior code was unnecessary once the current code was shown to reproduce 5,063 exactly from workbook B. Executing an older commit could only have confirmed what is already proven, at the cost of touching the branch |

`docs/extraction/cyd-grain-confirmation.md:51` contains an early, misread trace of the same divergence: *"the live row/ticket distribution differs slightly from the source workbook (source: 4,780 rows / 2,381 tickets …)"*. `4,780` is the invoiced-only subset and `2,381` is workbook A's ticket count — the 2026-06-07 note was already comparing a local file against the persisted set and attributing the gap to invoicing status. That attribution was wrong; the file itself differed.

## 12. Persisted-reference integrity

Full read-only scan of all 5,063 rows (paginated REST, no write, no RPC, no migration):

| Check | Result |
|---|---|
| row count | **5,063** — matches `transaction_data_datasets.row_count` and `summary_json.row_count` |
| duplicate persisted rows | **0** — 5,063 distinct `source_row_number` for 5,063 rows |
| rows with no source sheet/row | **0** — every row carries `source_sheet_name = 'Ticket Query Results'` and a non-null `source_row_number` |
| `source_row_number` coverage | contiguous **2 … 5064**, zero gaps, zero values outside the range — an exact bijection onto workbook B's data rows |
| rows from another workbook/import | **0** — single `document_id = 04e23a28-61a0-4abc-91ac-8c6f2db31ecf` |
| manual inserts | **none detectable** — all 5,063 `created_at` fall in one machine batch on 2026-06-10 (17:07–17:08 UTC); a hand-inserted row would break the contiguity above |
| soft-deleted rows | none — no soft-delete column on `transaction_data_rows` |
| multiple dataset versions | **1** dataset row total |
| stale records | none — `processed_at` 2026-06-10 is the most recent ingest |
| reprocessing overlap | none — contiguity plus single batch rules it out |
| rows outside expected invoice range | none — `2026-002` (2,061 rows / 61,158 qty / `$534,757.10`), `2026-003` (2,719 / 145,113 / `$280,802.25`), no invoice (283 / 10,339 / `$0.00`) |
| source hash mismatch | **cannot be checked — no source-hash column exists** (§2.2). Identity established structurally instead |
| sums | `transaction_quantity = 216,610`, `extended_cost = $815,559.35` — both reproduced exactly by workbook B through the current pipeline |

Live database access was available and used. No fixture was treated as proof of persisted truth. The persisted reference is **clean**: a faithful, complete, unduplicated, single-source projection of workbook B.

## 13. Quantity impact

| Measure | Delta from the eight rows |
|---|---|
| transaction quantity | **−2** (rows 2118 and 3827, quantity 1 each; the other six carry no quantity) — exactly reconciles 216,610 → 216,608 |
| row-grain CYD | **−120** (row 4936 = 64, row 5003 = 56) |
| ticket-grain CYD, full dataset | 74,737 → 74,617 (**−120**) |
| ticket-grain CYD, invoiced only | 74,617 → 74,617 (**0**) — all eight rows are uninvoiced |
| distinct tickets | **−7** (8 rows, 7 tickets; rows 4716/4717 share one) |
| uninvoiced row count | 283 → 275 (**−8**) |
| net tonnage / diameter / mileage | no measurable change; the deleted rows carry none |

**Does the delta affect 74,617 CYD? No.** `74,617` is the *invoiced* ticket-grain figure and is identical on both workbooks. The coincidence that workbook A's *full* ticket-grain CYD also equals 74,617 is arithmetic, not accident: 74,737 − 120 = 74,617, because the eight deleted rows carry precisely the 120 CYD that separated full from invoiced.

## 14. Financial impact

| Measure | Delta |
|---|---|
| extended cost of the eight rows | **`$0.00`** — every one is zero-cost |
| total extended cost | `$815,559.35` on both workbooks — **unchanged** |
| invoice allocation | **none** — zero of the eight carry an invoice number |
| invoice 2026-002 | 2,061 rows / 61,158 qty / `$534,757.10` — **identical** local, corpus, and persisted |
| invoice 2026-003 | 2,719 rows / 145,113 qty / `$280,802.25` — **identical** |
| material/category distribution | 2 Vegetation/Neighborhood Veg rows with CYD, 2 hanging-limb `6X` rows, 4 rows with no material |
| ticket uniqueness | 7 distinct tickets, none appearing elsewhere in the workbook except the 4716/4717 pair |

**Does the delta affect `$815,559.35`? No.** **Invoice 2026-002? No.** **Invoice 2026-003? No.** **Any current finding or exposure amount? No** — the latest run has 0 findings, both invoices are `MATCH`, exposure is `$815,559.35` billed / supported / fully reconciled with `$0` unreconciled, at risk, or requiring verification. None of that is reachable from eight uninvoiced, zero-cost rows.

**Drift classification: count-only drift, with a contained ticket-count and full-dataset-CYD effect.** Not financially material. Not quantity material at the invoiced grain. Not duplicate-only. Six of eight are unsupported/junk rows (Void test tickets, out-of-scope loads); two are legitimate zero-rate `6X` records.

## 15. Finding / exposure impact

None. Exposure and findings are derived from invoice-linked rows and contract pricing. All 4,780 invoice-linked rows are byte-identical across both workbooks and the persisted set. No finding, disposition, approval outcome, or exposure amount moves in either direction.

## 16. Root cause

**The Golden corpus artifact was manually edited after the persisted dataset was created.**

1. 2026-04-04 19:12 — `ticket_query_20260404_191302.xlsx` exported (Excel `AppVersion 12.0000`), 5,063 data rows, 84 columns, SHA-256 `86cb49a0…`. Uploaded to Supabase storage at 20:01.
2. 2026-04-04 19:14 — copied to the Golden corpus directory.
3. 2026-06-07 — grain investigations read the persisted set and record 5,063 / 2,388 / 283.
4. **2026-06-08 15:25–15:32 — the corpus copy is opened and re-saved in Excel 16 by "Eric Martin". Eight rows are deleted (six Void/out-of-scope, two zero-rate `6X`) and a `Project Specific Detail` column is inserted at index 30.** The file becomes SHA-256 `241b1c4d…`, 5,055 data rows, 85 columns. No commit, no note, no gate.
5. 2026-06-10 17:07 — the document is reprocessed from **Supabase storage**, i.e. from the untouched 2026-04-04 bytes. 5,063 rows persist.
6. 2026-08-01 — the Golden full-chain harness pins `241b1c4d…` as the required workbook hash and compares its output against the persisted 5,063, producing `unresolved_drift`.

The harness's own hash assertion is what makes this recoverable: it proves the local execution read `241b1c4d…`, and `241b1c4d…` demonstrably has 5,055 data rows. The comparison was between an edited artifact and an unedited ingest — a source-version mismatch, not a pipeline defect.

**Neither count is wrong. Neither should be re-baselined.** They answer different questions about different files.

## 17. Recommended owner

**fixture/reference.**

Not `pipeline` — the pipeline reproduces both counts exactly from their respective inputs and drops nothing.
Not `persisted data` — the persisted reference is complete, unduplicated, single-source, and internally consistent.
Not `unresolved` — the eight rows are named, keyed, and reconciled to the last unit and cent.

## 18. Decision

# DIFFERENT GRAIN OR SOURCE

Specifically: **different source**. Same grain, same scope, same sheet, same pipeline, same inclusion policy — two different files.

## 19. Exact next implementation slice

Investigation-only work ends here. The next slice, when authorized, is narrow:

1. **Restore corpus integrity.** Replace the corpus `ticket_query_20260404_191302.xlsx` with the pristine 2026-04-04 export (`86cb49a0…`, 1,238,227 bytes), or authoritatively fetch the bytes from `documents.storage_path` and re-hash. Do not edit the corpus copy again.
2. **Repoint the harness hash.** Update `GOLDEN_SOURCE_SPECS.workbook.sha256` in `lib/evaluation/canonicalGoldenFullChainHarness.ts:20` from `241b1c4d…` to the restored hash, and change the pinned divergence object in `canonicalGoldenFullChainRealFixtureParity.test.ts:50-65` from `{ 5055, 5063, −8, unresolved_drift }` to `{ 5063, 5063, 0, exact }`. **This is not a re-baseline** — it corrects the input, and the expected output becomes equality. Both counts stay exactly as measured.
3. **Add a source-hash column to the persisted artifact.** `documents` and `transaction_data_datasets` record no hash today, which is the single reason this took execution rather than a lookup. A `source_sha256` written at ingest would have answered it in one query. This is a schema change and must be separately scoped and approved.
4. **Gate corpus artifacts.** The corpus lives outside version control and outside CI. Consider a checked-in manifest of expected artifact hashes so an out-of-band edit fails loudly at collection time instead of surfacing as an unexplained count three weeks later.
5. **Correct the stale note** at `docs/extraction/cyd-grain-confirmation.md:51`, which attributes this same divergence to invoicing status rather than to a differing source file.

Steps 1–2 together close the `unresolved_drift` pin. Steps 3–5 are independent hardening and should not ride along.

---

## Diagnostics added

Evaluation-only, imported by no production module, workbook paths from environment variables, no personal absolute path in source, opt-in for the expensive path, deterministic JSON/CSV output, source row identity preserved, no workbook or database mutation.

- `lib/evaluation/goldenTransactionRowDriftDiagnostic.ts` — physical workbook inspection (hash, sheets, hidden sheets, defined names, used range, physical rows, blank rows, hidden rows, merges, autofilter, formula cells, workbook metadata); real-chain execution (`parseWorkbook → detectSheets → normalizeTransactionData`) into a per-row ledger; identity-keyed diff that matches duplicates **by multiplicity**, never by array position; deterministic CSV emitter.
- `lib/evaluation/goldenTransactionRowDriftDiagnostic.test.ts` — always-on unit tests over synthetic ledgers (missing-row impact, duplicate multiplicity, order independence, CSV determinism, env gating, and machine-local-field removal). Real workbooks do not execute in Vitest.
- `scripts/evaluation/runGoldenTransactionRowDrift.ts` — artifact generator writing `golden-transaction-row-drift.json` and `.csv`.

```powershell
$env:GOLDEN_AUTHORITATIVE_TRANSACTION_WORKBOOK = '<path to the persisted-source workbook>'
$env:GOLDEN_EDITED_TRANSACTION_WORKBOOK        = '<path to the edited derivative>'
$env:GOLDEN_ROW_DRIFT_OUT_DIR      = '<output directory>'
npx tsx scripts/evaluation/runGoldenTransactionRowDrift.ts
```

### Gates

| Gate | Result |
|---|---|
| `npx tsc --noEmit` | **passed** |
| `npx eslint <3 changed files> --max-warnings=0` | **passed** |
| `npx vitest run lib/evaluation/goldenTransactionRowDriftDiagnostic.test.ts` (default) | **6 passed** — pure comparator tests only; no workbook parse |
| `scripts/evaluation/runGoldenTransactionRowDrift.ts` against both workbooks | **passed** — delta −8, 8 rows only-in-baseline, 0 only-in-comparison |
| `git diff --check` | **passed** — no whitespace errors |

### Known limitations

- A historical opt-in real-workbook Vitest run emitted `Timeout calling "onTaskUpdate"` from worker-RPC starvation during synchronous XLSX parsing. The retained implementation removes real workbook execution from Vitest and makes the script runner the only supported large-file path.
- `npx tsx` was not previously installed and was fetched on demand by `npx` (tsx@4.23.4). No dependency was added to `package.json`.
- The persisted reference carries no source hash, so its provenance is established structurally (column geometry + row membership) rather than cryptographically. §2.2 states this explicitly.
- The full default `npx vitest run` suite was not executed; this slice adds one isolated evaluation test file and touches no production module or shared configuration.
