# Legacy Table Reference Classification — 2026-07-17

## Scope and method

This is a read-only source classification for the five tables reported absent from the live schema in `docs/audits/full-system-audit-2026-07-08.md` (M5): `document_facts`, `invoices`, `invoice_lines`, `validation_runs`, and `validation_findings`.

The sweep covered `lib/` and `app/` and excluded `.claude/worktrees/**`. It found 13 exact literal `.from('<legacy table>')` call sites. Four additional call sites use a statically constrained table variable that can target `invoices` or `invoice_lines`; those are included so the runtime inventory does not omit helper-mediated reads/writes. There are no exact or statically constrained calls to `validation_runs` or `validation_findings`; current validation persistence uses the distinct canonical tables `project_validation_runs` and `project_validation_findings`.

Dispositions are based on current importer reachability, not only local error handling:

- `LIVE-PATH-UNGUARDED`: reachable from a user-facing path and a missing table can escape as a failure.
- `LIVE-PATH-GUARDED`: reachable, but the missing-table condition is converted to an empty result, skipped persistence, or a contained failed trigger.
- `DEAD-FALLBACK`: the code is not reachable from a current caller.
- `AUDIT-OR-SCRIPT-ONLY`: only audit/script code can reach it.

## Summary

| disposition | call sites |
|---|---:|
| LIVE-PATH-UNGUARDED | 0 |
| LIVE-PATH-GUARDED | 14 |
| DEAD-FALLBACK | 3 |
| AUDIT-OR-SCRIPT-ONLY | 0 |
| **Total classified** | **17** |

### User-facing unguarded candidates

**None found.** No classified call site currently turns the absence of one of these five tables directly into an unhandled user-facing 500.

The highest operational risk is nevertheless the guarded `invoices` / `invoice_lines` path. Document processing reaches invoice persistence and project validation reaches invoice loading, but missing tables cause persistence to be skipped and canonical invoice inputs to become empty. The route survives, while invoice-backed validation truth can be absent. The owner should decide whether these tables are intended canonical storage that must exist, or whether both readers and writers should be retired in favor of an already-live canonical source. That decision needs its own scoped issue because it affects validator truth and persistence provenance.

## Classification

Sorted by disposition priority, then file and line.

| file:line | table | reachability (entry point) | guarded? | disposition | notes |
|---|---|---|---|---|---|
| `lib/ask/retrieval.ts:611` | `document_facts` | User-facing Ask via `POST /api/ask/project` → `retrieveProjectTruth` → `loadStructuredFacts` | Yes | LIVE-PATH-GUARDED | Any query error, including missing-table errors, becomes `[]`; canonical project facts and active `document_extractions` remain available. This is graceful but generates a failed legacy query on the live Ask path. |
| `lib/ask/retrieval.ts:708` | `document_facts` | User-facing Ask via `POST /api/ask/project` → `retrieveProjectTruth` → `loadFactsByFieldKeys` | Yes | LIVE-PATH-GUARDED | Any query error becomes `[]`; reasoning continues from canonical project facts and filtered active `document_extractions`. |
| `lib/server/invoicePersistence.ts:201` | `invoices` | Validator input via manual/background validation routes → `validateProject` → `getCanonicalInvoicesForProject` → document-ID compatibility fallback | Yes | LIVE-PATH-GUARDED | Helper returns the error; `getCanonicalInvoicesForProject` recognizes unavailable-table errors and returns empty invoice truth. This branch is reached only after the primary project-scoped query needs compatibility fallback. |
| `lib/server/invoicePersistence.ts:210` | `invoices` | Same validator path; legacy `document_id` fallback after `source_document_id` is missing | Yes | LIVE-PATH-GUARDED | Returned missing-table error is handled by `getCanonicalInvoicesForProject`; no route exception escapes. |
| `lib/server/invoicePersistence.ts:224` | `invoice_lines` | Validator input via `getCanonicalInvoicesForProject` → document-ID compatibility fallback | Yes | LIVE-PATH-GUARDED | Helper returns the error; caller converts unavailable-table errors to an empty `invoiceLines` array. |
| `lib/server/invoicePersistence.ts:233` | `invoice_lines` | Same validator path; legacy `document_id` fallback after `source_document_id` is missing | Yes | LIVE-PATH-GUARDED | Returned missing-table error is handled by the caller. |
| `lib/server/invoicePersistence.ts:247` | `invoice_lines` | Validator input via `getCanonicalInvoicesForProject` → invoice-ID compatibility fallback | Yes | LIVE-PATH-GUARDED | Returned missing-table error is subsequently handled and degrades to no invoice lines. |
| `lib/server/invoicePersistence.ts:274` | `invoices` / `invoice_lines` (constrained dynamic target) | Document processing via `POST /api/documents/process` or `POST /api/documents/[id]/evaluate` → canonical intelligence → `persistCanonicalInvoiceForDocument` cleanup | Yes | LIVE-PATH-GUARDED | `deleteDocumentScopedRows` maps missing-table errors to `{ ok: false, reason: 'missing_table' }`; persistence returns a skipped result rather than throwing. |
| `lib/server/invoicePersistence.ts:307` | `invoices` | Same document-processing paths; cleanup of a partially inserted invoice | Yes | LIVE-PATH-GUARDED | `deleteInvoiceRowById` explicitly suppresses unavailable-table errors; other errors throw into the enclosing canonical-intelligence containment path. |
| `lib/server/invoicePersistence.ts:337` | `invoices` / `invoice_lines` (constrained dynamic target) | Same document-processing paths; insert branch that requests the inserted invoice ID | Yes | LIVE-PATH-GUARDED | Helper returns the error; `persistCanonicalInvoiceForDocument` converts unavailable tables to `skipped: true, reason: 'missing_table'`. Canonical-intelligence orchestration records a persistence error without throwing the route solely for this condition. |
| `lib/server/invoicePersistence.ts:369` | `invoices` / `invoice_lines` (constrained dynamic target) | Same document-processing paths; bulk invoice-line insert branch | Yes | LIVE-PATH-GUARDED | Same missing-table conversion as the selected insert branch, with cleanup guarded by `deleteDocumentScopedRows` / `deleteInvoiceRowById`. |
| `lib/server/invoicePersistence.ts:631` | `invoices` | Validator input via `validateProject` from `POST /api/projects/[id]/validation-phase`, `POST /api/projects/[id]/revalidate`, document review/process triggers, and execution-outcome refresh | Yes | LIVE-PATH-GUARDED | Primary project-scoped read returns `{ invoices: [], invoiceLines: [] }` when `isInvoicePersistenceTableUnavailableError` matches. This prevents a 500 but removes invoice-backed validator input. |
| `lib/server/invoicePersistence.ts:674` | `invoice_lines` | Same validator entry points through `getCanonicalInvoicesForProject` | Yes | LIVE-PATH-GUARDED | Missing table returns the already-loaded invoices with an empty `invoiceLines` array. |
| `lib/validator/triggerProjectValidation.ts:341` | `invoice_lines` | All `triggerProjectValidation` callers, including manual validation, revalidation, document processing/review, and execution-outcome routes | Yes | LIVE-PATH-GUARDED | Missing table or missing `project_id` column returns count `0`; any other error is caught by the outer trigger and returned as `{ status: 'failed' }`, not thrown to the caller. |
| `lib/validator/projectValidator.ts:1139` | `invoices` / `invoice_lines` (type permits them; no current caller supplies either) | No current runtime entry point; `loadStructuredRows` is currently called only for `mobile_tickets` and `load_tickets` | Yes | DEAD-FALLBACK | Generic helper would return `[]` on a missing table, but its legacy invoice members are dormant. Tightening `StructuredTable` is a cleanup candidate only after owner confirmation. |
| `lib/validator/projectValidator.ts:1159` | `invoice_lines` | No entry point; private `loadInvoiceLines` has no callers | Yes | DEAD-FALLBACK | Primary query returns `[]` on missing table. Current validator loading uses `getCanonicalInvoicesForProject` instead. |
| `lib/validator/projectValidator.ts:1182` | `invoice_lines` | No entry point; compatibility branch inside the uncalled `loadInvoiceLines` helper | Yes | DEAD-FALLBACK | Fallback query also returns `[]` on missing table. |

## Reachability evidence

- `app/api/ask/project/route.ts` imports and awaits `retrieveProjectTruth`.
- `lib/validator/projectValidator.ts` imports `getCanonicalInvoicesForProject`; `validateProject` loads it as part of validator input.
- `lib/validator/triggerProjectValidation.ts` imports `validateProject`. Its callers include project validation/revalidation routes, document processing/review routes, and the execution-outcome route.
- `lib/server/intelligencePersistence.ts` imports `persistCanonicalInvoiceForDocument`. It is reached from `lib/pipeline/processDocument.ts` and `app/api/documents/[id]/evaluate/route.ts`.
- `loadInvoiceLines` in `lib/validator/projectValidator.ts` has no caller, and current `loadStructuredRows` invocations name only `mobile_tickets` and `load_tickets`.

## Candidate follow-up decisions

1. **Invoice truth ownership:** decide whether `invoices` and `invoice_lines` must be restored as canonical tables or whether invoice persistence/loading must move to a live canonical source. Guarding prevents route failure but can silently remove invoice-supported validator evidence.
2. **Ask legacy probe:** decide whether the two `document_facts` probes should be removed now that canonical project facts and `document_extractions` supply the fallback path.
3. **Dead validator cleanup:** after the invoice-truth decision, consider removing the uncalled `loadInvoiceLines` helper and narrowing `StructuredTable`; do not delete them independently of that decision.

This issue changes no application code or schema.
