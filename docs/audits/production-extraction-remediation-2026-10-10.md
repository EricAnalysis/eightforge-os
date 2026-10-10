# Production extraction remediation, 2026-10-10

## Confirmed production result

Production deployment at main `792913240480159e5c76523e4004be1f3ef6f1f8` was Ready. A normal signed-in Reprocess operation on the Golden qualification document followed an immediate ownership, pinned-source, stale-extraction and no-active-owner preflight. It created exactly one job and one full extraction.

Job `29fe1f23-425e-477a-a95a-b61adee284fc` completed on attempt 1 at 15:59:37 UTC; extraction `19e5c631-8347-43b7-bfc1-a1e4dab71508` is nevertheless a failed re-analysis outcome: `pdf_fallback`, no parsed pages, zero rate mentions, null typed fields, dependency fingerprints `not_observed`. The prior full extraction remains stored.

Live runtime logs confirm PDF.js fake-worker initialization failed because `node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs` was missing. Reconstruction v6 in an empty payload does not establish successful extraction.

No reviewed assertions, overrides or review records changed. Golden open decisions changed 3 to 4, tasks 2 to 3; the four project findings retained their identities. Decision/task identities changed during normal recomputation. Raw before/after records and logs are outside Git. No direct cleanup, rollback, repointing or repeated reconciliation was performed. Hillsdale and DN have not been reprocessed.

## Deterministic correction

Four extraction routes now explicitly include the PDF worker and finite OCR worker dependency closure, all reachable core JS/WASM variants, feature detector metadata and local English language data. Other routes and scoped exclusions retain their previous behavior.

An isolated worker startup probe also established that installed Tesseract 7 passes a Boolean `lstmOnly` into its Node adapter, which tests numeric OEM values and selects a non-LSTM-named core. Installed package files match the lock-bound registry tarball. The fingerprint observer previously inferred a LSTM-named core from CPU features. It now invokes the installed adapter with extraction's actual options and binds its returned module to exactly one loaded core export before hashing that build's assets. No OCR option, language, crop, prompt, scoring bar or recognition behavior changed.

A separate existing Step 1 RPC mismatch is corrected: the producer omits the optional interpretation snapshot when absent. Internal bridge null semantics, present snapshots, semantic arrays and SQL hash coalescing stay the same. No migration is needed for this serialization correction.

## Verification

- Focused deployment tracing and runtime identity/fingerprint checks: 13 tests passed.
- Step 1 shadow persistence: 10 tests passed, including absent/empty/present interpretation snapshot cases.
- Config-assembled sandbox: 87 dependency/assets, 88,374,826 bytes; real PDF worker parsed a synthetic one-page PDF; local English OCR worker initialized and terminated; corrected fingerprints observed the actual selected core. Main and worker network adapters were disabled. This is a startup/package proof, not corpus OCR qualification or a deployed function proof.
- External sandbox manifest SHA-256: `c50431454ae7fb94f09e1001646745589f04bb6361fba69ba32c34742bb0ebb3`.
- External probe result SHA-256: `9df93f16c4aa675fd28b5c22a16a2aef6c899849890d39fbe4e9ad0a4908571a`.
- Normal build initially stopped before compilation on the managed checkout's dependency junction. A Webpack fallback encountered existing client ESM worker-URL incompatibility and is not claimed as verification. Dependencies were copied physically into the managed checkout, preserving the primary checkout. The final normal `npm run build` passed on the corrected source (two existing client ESM externalization warnings). All four produced route NFT manifests contain every one of the 87 sandbox assets; no required probe asset is missing.
- No unchanged corpus or paid qualification run was repeated.

## Remaining production contract defect

Live normalized-fact upserts write `active`, while the existing production `document_extractions_status_check` permits only `success`, `failed` and `partial`. Readers and supersession use `active`/`superseded`; a one-word status substitution would violate that lifecycle. This is independent of packaging and remains unresolved. The pipeline currently logs the rejected upsert and still completes the job. Do not treat completion as proof of normalized fact persistence. No database DDL was applied in this continuation.

The compatibility migration is prepared, but not applied to production. It preserves all formerly accepted statuses, adds active/superseded only when field_key is non-null, and changes no rows/defaults/RLS/grants. Executable PostgreSQL verification passed in a network-disabled disposable container: six legacy rows unchanged, migration applied twice, active-to-superseded fact lifecycle, seven invalid cases rejected with 23514. The fixture is wired into the existing full migration replay gate.

Migration-reviewer verdict: **Pass with Concerns**. Key issue: replacing the validated constraint takes a table lock and scans existing rows. Minimal fix: the new status compatibility migration only. Regression risk: reverting the old constraint after fact rows exist would reject valid lifecycle history; use a reviewed forward fix. Suggested tests: the focused PostgreSQL fixture plus full fresh-replay CI. Positive notes: no mapping, backfill, tenant policy, grant or authority change. Production apply requires the owner's separate authorization.

The production sequence stays stopped until the extraction and persistence mismatches are reconciled. Browser search/filter verification showed one Golden document, four findings and three execution actions. Golden Resolution Workspace displays 69 cases (66 document, three project), its document filter works, + category markers appear, and the category selector changes its unsaved draft. No review was saved. An unread p10 line explains ambiguous table headers and withholding from pricing. A p8 case's main pane reports a scan amount while its investigation says no usable amount; this inconsistent context is recorded for post-remediation verification. Derived expiry has no current persisted-running sample; #198 boundary tests are reused without creating a production test job.

