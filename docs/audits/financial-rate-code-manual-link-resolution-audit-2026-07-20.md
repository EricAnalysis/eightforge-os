# FINANCIAL_RATE_CODE_MISSING — Manual Rate Link Resolution: Phase A Audit

**Audit date:** 2026-07-20
**Trigger:** Live Validator finding `FINANCIAL_RATE_CODE_MISSING` on invoice line `fact:53d74340-4d00-4d55-a937-4d0eca9c1573:line:6` (Williamson Co, invoice 2026-002, "Tree Operations Hazardous Hanging Limb Removal>2\"per tree", qty 994, $80/unit, $79,520 total). Operator asked for a Decision & Execution capability to confirm a recommended rate code, not just be told one is missing.
**Verdict:** Do not build new decision architecture. The mechanism the operator is asking for is already built — `invoice_line_rate_links` + `manualRateLinkClosure.ts` + `POST /api/projects/[id]/invoice-line-rate-link` — and "Pass 2" (validation-time injection so a manual link survives revalidation) is **already shipped**, not outstanding as its own code comments claim. It is wired into exactly one rule pack (`crossDocumentRateVerification.ts`) and into `exposure.ts`. It has **zero UI entry point** and **zero coupling to `financialIntegrity.ts`**. Phase 1 is: extend two files, add one UI surface, correct one stale comment.

---

## 1. What already exists (verified against source)

| Component | File | Status |
|---|---|---|
| Link persistence table | `supabase/migrations/20260630000000_create_invoice_line_rate_links.sql` | Live. Supersession chain, RLS, one-active-link-per-line unique index. |
| Insert + closure service | `lib/server/manualRateLinkClosure.ts` | Live. `insertManualRateLink()` persists the link with supersession; `closeManualRateLinkFindings()` resolves the currently-open finding, cascading through `finalizeDecision` if a decision is linked, or a direct update + explicit `logActivityEvent` otherwise. |
| Write endpoint | `app/api/projects/[id]/invoice-line-rate-link/route.ts` | Live, rule-agnostic at insert time — it takes `invoice_line_subject_id` + `contract_rate_row_id` and does not require or check a `rule_id`. |
| **Pass 2 (validation-time injection)** | `lib/validator/projectValidator.ts:916-1049` (`buildManualRateLinkOverrides`, `loadManualRateLinkOverrides`), `:1966-2023` (`buildInvoiceLineToRateMap`, `resolveManualRateLinkOverride`) | **Live, not outstanding.** An active link is loaded every validation run, converted into a `RateScheduleItem` tagged `match_source_kind: 'manual_link'`, and takes precedence over the automated matcher (`manualRateLink ?? matchRateScheduleItemForInvoiceLine(...)`, `crossDocumentRateVerification.ts:857-871`; same precedence in `buildInvoiceLineToRateMap`, `projectValidator.ts:1976-1980`). |
| Rule pack consuming it | `lib/validator/rulePacks/crossDocumentRateVerification.ts:857` | `CROSS_DOCUMENT_CONTRACT_RATE_EXISTS` treats a manual link exactly like a confident automated match: `contract_rate_found: contractItem != null` (line 893), `contract_match_source: 'manual_link'` (line 894). Test coverage exists: `crossDocumentRateVerification.test.ts:177-267`. |
| Exposure consuming it | `lib/validator/exposure.ts:428-433` | Already trusts a manual link for the full `line_total` with **no rate-tolerance check required** — explicit comment: "operator explicitly confirmed this line maps to a contract rate item." This directly answers the reviewer's open question ("must exposure remain explicitly deferred?"): no, it already isn't deferred, and it's already scoped narrower/safer than a full re-derivation (it only affects the exposure-support amount, not the underlying validation unit). |
| Rule pack **not** consuming it | `lib/validator/rulePacks/financialIntegrity.ts` (whole file) | No import of `manualRateLinkOverrides`, `resolveManualRateLinkOverride`, or `match_source_kind`. Zero references. |
| UI caller of the endpoint | *(none found)* | Grepped every component under `components/`. No component calls `/invoice-line-rate-link`. The backend is fully orphaned from any operator-facing surface. |

**Correction to the codebase's own documentation:** `manualRateLinkClosure.ts:129-134` and the migration header both say "Pass 2 has not been built yet... the next re-validation run will reopen this finding." That statement is stale. Pass 2 shipped (`buildManualRateLinkOverrides`/`loadManualRateLinkOverrides`/`resolveManualRateLinkOverride`, wired into `projectValidator.ts` at lines 2376-2423 and consumed by `crossDocumentRateVerification.ts`), just not for every rule pack. The comment should be corrected as part of Phase 1 so future readers don't re-scope work that's already done.

## 2. Reviewer's five audit questions, answered

**1. Where does the picker get canonical rate rows?**
`assembleContractPricingRows` in `lib/contracts/contractPricingAssembly.ts:1525-1685` is the one real canonical assembler (confirmed by `docs/audits/CONTRACT_RATE_ASSEMBLER_DESCRIPTION_CATEGORIZATION_AUDIT.md`). The validator's own rate-row pool (`input.factLookups.rateScheduleItems`) is built from the same assembler via `buildRateScheduleItems` (`projectValidator.ts:1398-1476`). There is no existing API endpoint that exposes this list to a client for picking — one needs to be added (GET, read-only, scoped to the governing contract family for the project). Do not have the picker parse evidence JSON or re-derive rows from raw extraction; it must call a server route that returns the same `RateScheduleItem[]` the validator already computed for this project/run.

**2. Why does Documents show `6A` while the finding says the rate code is missing?**
Traced two independent extraction paths for the same invoice:
- **Documents "Billed Line Items" table** (`components/document-intelligence/InvoiceSurface.tsx:282-299`) renders `invoiceSurfaceLineItemToLedgerRecord` → `buildInvoiceLedgerLineDisplay` (`lib/documentIntelligenceViewModel.ts`), sourced from `extraction.lineItems` / `line_items` on the legacy/presentational `InvoiceExtraction` blob.
- **Validator's `InvoiceLineRow`** is sourced from `buildCanonicalInvoiceRowsFromTypedFields` → `normalizeTypedInvoiceLine` (`lib/invoices/invoiceParser.ts:2127-2219`), which reads `typed_fields` from `document_extractions` and does attempt to populate `rate_code` from `line_code`/`rate_code`/`code` on that record (line 2137-2140, 2198).

Both paths are real production code and both *can* independently succeed or fail per line. The most likely explanation, based on source alone (I did not query the live `document_extractions` row — that requires DB access this audit did not use, and the project's own Golden Project handling means I shouldn't touch live data without your authorization): the typed-fields extraction for this specific row did not capture a `line_code`/`rate_code`/`code` value that the blob/presentational parser did capture through its own (more permissive) regex logic (`invoiceParser.ts:663, 801, 827` — same file, different function, different code path). This is a **mapping/extraction divergence between two parsers reading the same document**, not a case of the invoice genuinely lacking a code and the UI hallucinating one.

This means: **the reviewer's "Issue A" (false-positive finding) is real for this project, but it is not the same as, and should not be conflated with, the "Issue B" (build resolution capability) work.** Issue A is a separate, narrower bug: the typed-fields parser should extract `line_code` at least as reliably as the presentational parser does for the same document. Recommend filing this separately and NOT bundling a fix into Phase 1 below — the two invoiceParser.ts code paths differ enough (see the two independent `line_code` derivations at lines ~663-827 vs. ~2137-2140) that reconciling them safely needs its own audit and is out of scope for a "expose an existing manual-link workflow" phase. Flagging it here so it isn't lost.

**3. What exactly is being written?**
Confirmed by source: `insertManualRateLink` (`manualRateLinkClosure.ts:37-122`) writes a **new row in `invoice_line_rate_links`** linking `invoice_line_subject_id` → `contract_rate_row_id`, with supersession of any prior active link. It does not touch `document_extractions`, does not touch the invoice line's own `rate_code` field, and does not touch canonical facts. The source invoice extraction is untouched — the reviewer's "two separate facts" principle (source value vs. confirmed canonical mapping) is already how this table is designed; no new schema work needed.

**4. What happens after revalidation?**
Confirmed by source for `CROSS_DOCUMENT_CONTRACT_RATE_EXISTS`: the link survives, because `loadManualRateLinkOverrides` reloads active links on every validation run and `resolveManualRateLinkOverride` takes precedence over the automated matcher (`crossDocumentRateVerification.ts:857-858`). Test: `crossDocumentRateVerification.test.ts:177-267` asserts `contract_match_source === 'manual_link'` survives a rebuilt validation unit. **Not yet confirmed for `FINANCIAL_RATE_CODE_MISSING`** — `financialIntegrity.ts` doesn't consult manual links at all today (see §1), so a manual link currently has zero effect on this specific finding. This is the actual Phase 1 gap, not "build Pass 2."

**5. What existing findings are eligible?**
`closeManualRateLinkFindings` (`manualRateLinkClosure.ts:166-287`) currently hardcodes `CROSS_DOCUMENT_RATE_RULE_ID = 'CROSS_DOCUMENT_CONTRACT_RATE_EXISTS'` as the only closable rule (line 5, 179). It queries `status = 'open'` only, so an already-resolved finding is correctly left alone (`no_open_finding` result path). Extending eligibility to `FINANCIAL_RATE_CODE_MISSING` requires broadening this one query, not rebuilding the service. Both `info` and `warning` severities of `FINANCIAL_RATE_CODE_MISSING` should be operator-resolvable — nothing in the closure path is severity-gated today, and severity here is a downgrade signal, not a decision-eligibility gate (`decision_eligible` defaults `false` for both, per `shared.ts:750`, already verified in a prior pass of this engagement).

## 3. Scoping the three workstreams against what's real

**Workstream 1 — extend the closure path.** Smaller than proposed. Two changes: (a) `closeManualRateLinkFindings` should accept a list of closable rule IDs (or query by `invoice_line_subject_id` across both `CROSS_DOCUMENT_CONTRACT_RATE_EXISTS` and `FINANCIAL_RATE_CODE_MISSING` rather than one hardcoded constant), and (b) `runFinancialIntegrityRules` needs to receive `manualRateLinkOverrides`/consult `scheduleItem?.match_source_kind === 'manual_link'` and treat that as authoritative — currently a manual link only affects `isRateCodeMissingInformational`'s severity heuristic (and only if it happens to also pass the same description/unit/rate/category thresholds used for automated matches, `financialIntegrity.ts:159-259`). An operator-confirmed link should not have to re-clear an automated-match-quality bar; it should suppress the finding outright, matching how `CROSS_DOCUMENT_CONTRACT_RATE_EXISTS` treats it, and matching this project's own canonical-truth precedence (human-reviewed override ranks above validator-confirmed).

Keep `FINANCIAL_UNIT_TYPE_MISMATCH` **out** of Phase 1. Confirmed reason, not just caution: its finding condition (`financialIntegrity.ts:400-409`) compares the invoice's *billed* unit against the matched schedule item's unit — a manual link changes which schedule item is matched but does nothing to resolve a genuine unit disagreement, which needs a different operator decision (fix the unit vs. fix the mapping vs. fix extraction). Confirming a rate code and resolving a unit mismatch are different decisions; don't collapse them into one control.

**Workstream 2 — "complete Pass 2."** Materially done. What's actually missing is much narrower than "build the injection point": thread `manualRateLinkOverrides` into `runFinancialIntegrityRules` (it's already loaded once per validation run at `projectValidator.ts:2376` and passed to `buildInvoiceLineToRateMap` at line 2381 — `financialIntegrity.ts` already receives `scheduleItem` derived from that map via `input.invoiceLineToRateMap`, per line 340 of that file — so the data is already one property away, not a new load path) and add the suppression check described above. No new injection point, no new table, no new load path.

**Workstream 3 — minimal Decision-panel UI.** Matches the reviewer's proposal closely. Confirm this explicitly: **do not add a new execution-item action type.** `insertManualRateLink` + `closeManualRateLinkFindings` already produce their own audit trail (`logActivityEvent`, `manualRateLinkClosure.ts:265-284`) and their own closure semantics; routing this through the generic `project_execution_items`/`resolveOutcome` path (`app/api/execution-items/[id]/outcome/route.ts`) would create a second, parallel write path for the same operator action, which conflicts with this repo's own rule against duplicate business logic. The UI's "Confirm" button calls the existing endpoint directly.

## 4. Required tests (Codex must add or confirm)

- `financialIntegrity.test.ts`: an active `manual_link`-sourced `scheduleItem` suppresses `FINANCIAL_RATE_CODE_MISSING` for that invoice line (new).
- `financialIntegrity.test.ts`: an invoice line with no rate code and **no** manual link still fires the finding unchanged (regression — confirms Phase 1 doesn't weaken the existing rule).
- `manualRateLinkClosure.test.ts`: `closeManualRateLinkFindings` closes an open `FINANCIAL_RATE_CODE_MISSING` finding for the linked subject id (new), and continues to close `CROSS_DOCUMENT_CONTRACT_RATE_EXISTS` unchanged (regression).
- `manualRateLinkClosure.test.ts`: linking a different rate row supersedes the prior active link (already covered by `insertManualRateLink`'s supersession logic per `manualRateLinkClosure.ts:59-68` — confirm existing coverage, don't re-test if present).
- `projectValidator.inputLoading.test.ts` or equivalent: revalidation after a confirmed link does not reopen `FINANCIAL_RATE_CODE_MISSING` for that line (integration-level, not just unit-level — this is the reviewer's required "not a narrative assumption" test).
- Reject a `contract_rate_row_id` belonging to a different project/org (the endpoint currently trusts the caller-supplied `contract_document_id`/`contract_rate_row_id` without cross-checking they belong to the project's governing pricing family — confirm whether this validation exists; if not, Codex must add it before shipping a UI that makes this call operator-triggerable).
- Old findings without any link metadata continue rendering via the existing "Not retained with this finding" honest-degradation path (already shipped in the prior evidence-enrichment change — regression only).
- UI test: picker source is the assembler-backed rate-schedule endpoint, not evidence JSON (component test asserting the fetch target).
- UI test: double-submit is prevented; endpoint failure leaves the finding open and shows an explicit error, not false success.
- Source invoice fact (`document_extractions`) is unchanged after confirmation — assert no write to that table from this flow.

## 5. Named follow-up issue (tracked now, not in Phase 1 scope)

**Title:** Reconcile invoice line-code extraction between InvoiceSurface blob data and canonical typed_fields

**Description:** `components/document-intelligence/InvoiceSurface.tsx` (via `invoiceSurfaceLineItemToLedgerRecord`/`buildInvoiceLedgerLineDisplay`, sourced from `extraction.lineItems`/`line_items`) and the validator's canonical `InvoiceLineRow` (via `buildCanonicalInvoiceRowsFromTypedFields` → `normalizeTypedInvoiceLine`, sourced from `typed_fields`) are two independent parsers reading the same invoice document, with independent `line_code` derivation logic (`lib/invoices/invoiceParser.ts` lines ~663/801/827 for the blob path vs. ~2137-2140 for the typed-fields path). They can disagree on whether a given line has a rate code. This is the root cause of the live `6A` discrepancy this audit traced (§2 question 2).

**Why this must be tracked immediately, not deferred silently:** the manual-link feature being built in Phase 1 lets an operator confirm a rate-code mapping. If the underlying divergence isn't tracked, an operator could confirm a mapping (e.g. `6A`) that the canonical typed-fields extraction should have captured on its own — masking a real parser defect behind a manual override instead of surfacing it for a fix. Phase 1 must not be read as having resolved this; it only gives the operator a way to work around it per line.

**Required regression case for the follow-up fix (not for Phase 1):**
```
For the same source row, if the presentational invoice line has code 6A,
the canonical typed invoice row must either retain 6A or explicitly record
why the code was rejected.
```

**Status:** Out of scope for the Phase 1 Codex prompt below. Do not bundle a fix into Phase 1 — the two `invoiceParser.ts` code paths differ enough that reconciling them safely needs its own audit, and conflating the two would make Phase 1 harder to verify and roll back independently.

---

## Codex Implementation Prompt (Phase 1)

```
TASK: Extend the existing manual invoice-line-to-contract-rate-row link workflow
to cover FINANCIAL_RATE_CODE_MISSING, and add a minimal Decision & Execution UI
that calls it. Do not build new decision architecture — this mechanism already
exists (invoice_line_rate_links, lib/server/manualRateLinkClosure.ts,
POST /api/projects/[id]/invoice-line-rate-link, and validation-time injection
via buildManualRateLinkOverrides/resolveManualRateLinkOverride in
lib/validator/projectValidator.ts) and is already live for
CROSS_DOCUMENT_CONTRACT_RATE_EXISTS and lib/validator/exposure.ts. Your job is
to extend it to one more rule pack and expose it in the UI. Read
docs/audits/financial-rate-code-manual-link-resolution-audit-2026-07-20.md
first; it traces every file below with line numbers.

Final scope, exactly this and nothing more:
1. A valid active manual link suppresses FINANCIAL_RATE_CODE_MISSING outright
   (not a severity downgrade — see Phase B step 1, this is non-negotiable).
2. The existing closure service closes both eligible rate-link findings
   (CROSS_DOCUMENT_CONTRACT_RATE_EXISTS and FINANCIAL_RATE_CODE_MISSING) and
   reports which rule was closed through which path.
3. The existing write endpoint validates project/org/pricing-family ownership
   of the selected contract_rate_row_id before inserting a link.
4. A read-only assembler-backed endpoint supplies canonical rate-row options
   plus separate recommendation state (see Phase B step 4).
5. The Decision & Execution panel offers exactly two actions: Confirm
   recommended rate, and Choose another rate.
6. Confirmation refreshes the finding and displays the durable operator
   mapping (source value stays "missing"; confirmed mapping is shown
   separately — never overwrite the source value).
7. No source invoice extraction or canonical source fact is overwritten by
   any part of this flow.
8. Revalidation does not recreate the resolved finding.

PHASE A — CONFIRM BEFORE CHANGING (report back, do not skip)
1. Confirm current behavior: in lib/validator/rulePacks/financialIntegrity.ts,
   runFinancialIntegrityRules() reads scheduleItem from
   input.invoiceLineToRateMap.get(lineId) (line ~340) but the
   FINANCIAL_RATE_CODE_MISSING block only uses that matched item to compute
   isRateCodeMissingInformational() severity (info vs warning) — it never
   skips generating the finding, even when scheduleItem.match_source_kind is
   'manual_link'. Confirm this reading against current source before changing
   anything.
2. Confirm app/api/projects/[id]/invoice-line-rate-link/route.ts does not
   currently validate that contract_rate_row_id / contract_document_id belong
   to the project's governing pricing family (vs. an arbitrary or
   cross-project value). If unvalidated, this must be fixed as part of this
   task before the UI can call it safely.
3. Confirm no frontend component currently calls this endpoint (grep
   components/ and app/ for "invoice-line-rate-link"). If one exists, report
   it and adjust scope — do not build a duplicate entry point.

PHASE B — IMPLEMENTATION

1. lib/validator/rulePacks/financialIntegrity.ts
   - REQUIRED (not optional, not a choice): when scheduleItem?.match_source_kind
     === 'manual_link' for an invoice line, do NOT emit FINANCIAL_RATE_CODE_MISSING
     for that line at all. Skip pushing the finding entirely — do not fall
     through to isRateCodeMissingInformational's automated-match thresholds
     (description/unit/rate/category scoring) for a manual-link line, and do
     not merely downgrade severity to 'info'. An active operator-confirmed
     link means the missing mapping has been resolved; downgrading instead of
     suppressing would leave an open finding after the operator completed the
     requested correction, undermine the closure service in step 2 below, and
     leave clutter in the Validator. This matches how
     crossDocumentRateVerification.ts already treats a manual link as
     equivalent to (in fact, higher-trust than) a confident automated match.
   - The invoice line's own extracted rate_code stays whatever it actually is
     (still "missing" if the source never had one) — do not write the manual
     link's rate code back onto the invoice line row or its evidence. The
     distinction stays: source rate code = missing; confirmed contract-rate
     mapping = the manually linked row. Only the finding's existence changes,
     not the underlying extracted fact.
   - Do not change FINANCIAL_UNIT_TYPE_MISMATCH in this task.
   - Preserve all existing evidence-enrichment behavior shipped in the prior
     financial-integrity-evidence-enrichment change (invoiceLineBusinessEvidence,
     'Not retained with this finding' fallback) — this is additive only.

2. lib/server/manualRateLinkClosure.ts
   - Generalize closeManualRateLinkFindings so it can close an open finding
     for either CROSS_DOCUMENT_CONTRACT_RATE_EXISTS or
     FINANCIAL_RATE_CODE_MISSING for the same invoice_line_subject_id (both
     may be open simultaneously for the same line — close whichever are open).
     Do not create a second closure function; extend the existing one's
     rule_id handling from a single hardcoded constant to a small fixed list.
   - Change the result shape from a flat closedFindingIds: string[] to a
     structured list so callers and tests can confirm which rule was closed
     and how:
       closedFindings: Array<{
         findingId: string;
         ruleId: string;
         closurePath: 'direct_update' | 'finalize_decision';
       }>
     Update CloseManualRateLinkFindingsResult and every caller (including
     app/api/projects/[id]/invoice-line-rate-link/route.ts's response body)
     to use this shape. Do not return a bare list of IDs with no rule/path
     attribution — the endpoint and tests must be able to assert which rule
     was closed and through which path.
   - Correct the stale "Pass 2 has not been built yet" comment (lines ~129-134
     and the migration file's header comment) to reflect that the
     validation-time injection is live for crossDocumentRateVerification.ts
     and exposure.ts, and now also for financialIntegrity.ts as of this
     change.

3. app/api/projects/[id]/invoice-line-rate-link/route.ts
   - Add the project/org-scoped validation identified in Phase A step 2 if it
     is missing: reject a contract_rate_row_id whose contract_document_id is
     not part of the project's governing pricing family before inserting the
     link.

4. New read endpoint for the picker (server-side, read-only)
   - Add a project-scoped GET endpoint, parameterized by invoice_line_subject_id,
     that returns three distinct things — do not collapse them into one value:
       a. options: the canonical rate-row candidates for this project (reuse
          buildRateScheduleItems / assembleContractPricingRows — do not
          re-implement assembly, do not parse evidence JSON, do not query
          document_extractions directly from the route). Shape per row:
          document id, record id, rate_code, description, unit_type,
          rate_amount, canonical_category.
       b. recommendedRecordId: the record_id the existing automated matcher
          (matchRateScheduleItemForInvoiceLine) would select for this line
          today, if any — null if unresolved/ambiguous. This is the "before
          confirmation" state.
       c. activeManualLinkRecordId: the record_id of the currently active
          invoice_line_rate_links row for this line, if one exists — null
          otherwise. This is the "after confirmation" state.
     The UI must use recommendedRecordId and activeManualLinkRecordId exactly
     as returned by this endpoint. Do not have the UI reconstruct a
     recommendation by reading the finding's evidence JSON or the
     validator's in-memory scheduleItem — the right panel does not have
     direct access to validator run state, only to persisted findings and
     evidence, so the recommendation must come from this endpoint.

5. Decision & Execution panel UI (components/validator/*, wherever the
   FINANCIAL_RATE_CODE_MISSING right-panel is rendered today)
   - For an open FINANCIAL_RATE_CODE_MISSING finding, call the endpoint from
     #4. If activeManualLinkRecordId is set, show it as the confirmed mapping
     (the finding should already be suppressed/closed in this state per step
     1/2, so this is mainly for display after a fresh confirmation before the
     panel refreshes). Otherwise, if recommendedRecordId is set, show that
     row as "Recommended contract rate" with description/unit/rate, and offer
     two actions: "Confirm this rate" and "Choose another rate" (opens the
     picker over the `options` list, no free-text entry). If neither is set,
     show only "Choose another rate."
   - Submitting either action calls POST /api/projects/[id]/invoice-line-rate-link
     with the existing required fields, then: show success, refresh the
     finding's status, disable the button during submission (no
     double-submit), and surface the endpoint's error message on failure
     without marking the finding resolved client-side.
   - Do not add a new execution-item action type. Do not write to canonical
     truth or document_extractions from this UI. This is the only new UI
     entry point for this endpoint — do not duplicate it elsewhere.

REQUIRED TESTS (add or confirm existing coverage; do not skip any)
- financialIntegrity.test.ts: active manual_link scheduleItem SUPPRESSES
  FINANCIAL_RATE_CODE_MISSING entirely (no finding pushed) — not a severity
  downgrade. Assert the findings array contains zero FINANCIAL_RATE_CODE_MISSING
  entries for that line, not an 'info'-severity one.
- financialIntegrity.test.ts: unchanged behavior with no manual link
  (regression) — finding still fires at its existing severity.
- financialIntegrity.test.ts: the invoice line's own rate_code field/evidence
  is untouched by a manual link (still reads "missing" if it always was).
- manualRateLinkClosure.test.ts: closeManualRateLinkFindings returns
  closedFindings with correct {findingId, ruleId, closurePath} for a
  FINANCIAL_RATE_CODE_MISSING finding; still returns correct entries for
  CROSS_DOCUMENT_CONTRACT_RATE_EXISTS (regression); returns entries for BOTH
  rules when both are open on the same invoice line; a different rate
  selection supersedes the prior link.
- Integration-level test: revalidation after confirmation does not reopen
  FINANCIAL_RATE_CODE_MISSING for that line (not just a unit assertion —
  must run through the actual validator input-loading path).
- Endpoint test: reject a contract_rate_row_id outside the project's pricing
  family.
- Endpoint test: response body reflects the new closedFindings shape, not a
  flat ID list.
- Read endpoint test: recommendedRecordId and activeManualLinkRecordId are
  returned as separate, independently-nullable fields — not merged into one
  value, and not derived from evidence JSON.
- Endpoint/service test: old findings and lines with no link metadata render
  unchanged ("Not retained with this finding" honest-degradation path).
- UI test: picker calls the new read endpoint for options/recommendation/
  active-link state, not evidence JSON parsing and not the validator's
  in-memory scheduleItem.
- UI test: double-submit prevented; failure path shows error and leaves
  finding open.
- Assert no write to document_extractions or canonical invoice-line facts
  from any part of this flow — only invoice_line_rate_links and the finding's
  status/audit trail change.

VERIFICATION GATES
npx tsc --noEmit
npm run build
npx vitest run lib/validator/rulePacks/financialIntegrity.test.ts lib/server/manualRateLinkClosure.test.ts lib/validator/projectValidator.inputLoading.test.ts lib/validator/exposure.test.ts components/validator/ValidatorEvidenceDrawer.test.tsx --reporter verbose

Do not trigger a live Golden Project revalidation. Do not touch
FINANCIAL_UNIT_TYPE_MISMATCH. Do not add a new execution-item action type.
Do not modify document_extractions or any canonical invoice-line fact write
path. Do not downgrade FINANCIAL_RATE_CODE_MISSING to informational as a
substitute for suppression — an active manual link must suppress it outright.
Report back: files changed, confirmation that suppression (not downgrade) was
implemented, the exact closedFindings response shape used, whether the
project/org-scoping validation was already present or added, tests
added/passing, and any discrepancy found versus this prompt's assumptions.

Separately, file the follow-up issue named in the audit doc's §5
("Reconcile invoice line-code extraction between InvoiceSurface blob data and
canonical typed_fields") in whatever tracker this team uses — do not
implement it, just confirm it's been logged so the manual-link workaround
built here doesn't get mistaken for having fixed the underlying extraction
divergence.
```
