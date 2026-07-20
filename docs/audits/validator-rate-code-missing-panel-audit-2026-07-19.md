# Validator "Evidence & Truth" panel audit — FINANCIAL_RATE_CODE_MISSING

**Date:** 2026-07-19
**Type:** Phase A audit. No implementation performed.
**Scope:** Reviewer-facing content of the middle Validator panel for one finding type.
**Alignment:** `PRODUCT_ALIGNMENT.md` §4 (Validator workflow), §5 Phase C (performance), §9 (working behavior).

---

## A. Repository findings

### A.1 Render path

| Layer | File | Notes |
|---|---|---|
| Route | `app/platform/projects/[id]/page.tsx` | Single load gate via `useProjectWorkspaceData(id)` |
| Host | `components/projects/ProjectOverview.tsx` (1,811) | Receives `validatorTab` render prop |
| Tab | `components/projects/ValidatorTab.tsx` (1,097) | Three-panel composition |
| Left | `components/validator/ValidatorFindingsPanel.tsx` (93) → `ValidatorFindingsTable.tsx` (345) | Findings list |
| **Middle** | **`components/validator/ValidatorEvidenceDrawer.tsx` (623)** | **Target of this audit** |
| Right | `components/validator/ValidatorDecisionExecutionPanel.tsx` (184) | Decision + execution |

Supporting modules consumed by the drawer:

- `lib/truthToAction.ts` — `findingProblem`, `findingGateImpact`, `findingNextAction`, `findingApprovalLabel`, `humanizeTruthToken`
- `lib/validator/findingSemantics.ts` — `normalizeValidationFinding`; `FINANCIAL_RATE_CODE_MISSING` semantics at **:97–101**
- `lib/validator/evidenceNavigation.ts` — `buildEvidenceTarget`, `ValidationEvidenceTarget`
- `components/evidence/EvidenceInspector.tsx` + `components/evidence/evidenceInspectorModel.ts`
- `types/validator.ts` — `ValidationFinding`, `ValidationEvidence`, `ValidationSeverity`

**Not imported by the drawer, but already correct:** `lib/issueDisplayFormatter.ts:21–28` defines reviewer-facing `title`, `explanation`, `recommended_action`, `category` for `FINANCIAL_RATE_CODE_MISSING`, with `raw_key` explicitly documented as "never shown as primary display text." This module solves part of the stated problem and is currently unused on this surface.

### A.2 Finding generation

`lib/validator/rulePacks/financialIntegrity.ts`

- `runFinancialIntegrityRules` **:262–330** — emits the finding
- `isRateCodeMissingInformational` **:136–236** — severity downgrade predicate
- Subject: `subjectId: lineId` where `lineId = invoiceLineId(row)` over `INVOICE_LINE_ID_KEYS = ['id','invoice_line_id','line_id']` (**:25**)
- Severity: `informational ? 'info' : 'warning'`; when informational, `decisionEligible: false` and `actionEligible: false` (**:300–301**)
- Matched rate: `input.invoiceLineToRateMap.get(lineId)` (**:275**)

`lib/validator/shared.ts`

- `rowIdentifier` **:565–573** — `preferredKeys` → `id` → `${prefix}:unknown`
- `structuredRowEvidenceInput` **:668–686**
- `makeFinding` **:688+** — `checkKey = ${ruleId}:${subjectId}`; evidence IDs `${id}:evidence:${n}`

Persistence: `lib/validator/persistValidationRun.ts` (1,345) → `project_validation_findings` (478 rows live) / `project_validation_evidence` (2,609 rows live).

### A.3 Root causes of unusable display values

**Cause 1 — evidence persistence discards the row.** `structuredRowEvidenceInput` (`shared.ts:668–686`) accepts a full `StructuredRow` but persists only five fields:

```
evidence_type, source_document_id, record_id, field_name, field_value, note
```

The `row` argument — carrying description, quantity, unit, unit price, extended amount, invoice number, sheet and source row — is used only to read `source_document_id` and `record_id`, then discarded. For this finding `fieldValue` is `null` (the missing rate code), so the persisted invoice-line evidence row contains **no business data at all**.

This is the single largest cause of the reported symptom, and it is upstream of the panel.

**Cause 2 — the downgrade rationale is computed and thrown away.** `isRateCodeMissingInformational` computes `descriptionMatched`, `unitMatched`, `rateMatched`, `categoryMatched` and `matchConfidence` (**:173–235**), applies a `matchConfidence >= 0.7` gate, then returns a bare `boolean`. None of the five signals is persisted. **Reviewer question 4 ("why was this downgraded to informational?") cannot currently be answered from stored data.**

**Cause 3 — raw identifiers rendered directly.**

| Symptom | Source |
|---|---|
| `invoice_line:fact:aa3b…:line:4` | `formatSubject` **:75–77**, rendered at **:487** |
| `fact:aa3b…:line:4` | `activeFinding.subject_id` at **:499** |
| `Document aa3b36ac` | **:569–571** — `Document ${source_document_id.slice(0, 8)}`; document name never fetched |
| Repeated rule/subject/field | `findingSourceReference` **:89–97**, rendered at **:525**, duplicating **:487–488** |
| Raw JSON in Values | `StructuredEvidenceCard` **:317** — `entry.item.field_value` printed unformatted |

**Cause 4 — static category-based fix steps.** `resolveFixSteps` **:178–242** branches on `finding.category`. `FINANCIAL_RATE_CODE_MISSING` has `category = financial_integrity`, so it falls into the **:209–221** branch and renders contract-rate prose that does not describe the actual reviewer action for a missing invoice billing code.

**Cause 5 — `findingSemantics` entry is thin.** `findingSemantics.ts:97–101` supplies only `source_family` and `required_action` for this rule — no `problem`, `impact`, or `approval_gate_effect`, unlike neighbouring entries (**:62–79**). The Problem section therefore falls back to `findingProblem()` generic text.

### A.4 Fields that already exist but are not rendered

| Field | Where it exists | Persisted? |
|---|---|---|
| `rate_code`, `unit_type`, `rate_amount`, `canonical_category` of the matched rate | `financialIntegrity.ts:318–323` — `field_value` JSON on the `rate_schedule` evidence row | **Yes**, when `informational && scheduleItem` |
| `source_document_id`, `record_id` for both invoice line and rate row | evidence rows | Yes — rendered as raw IDs only |
| Reviewer-facing title / explanation / action | `lib/issueDisplayFormatter.ts:21–28` | Static, not wired to drawer |
| `expected` / `actual` | finding columns | Yes — rendered generically |

### A.5 Fields absent from persistence

All are computed at validation time and discarded.

`lib/validator/exposure.ts:565–638` builds a `LineContext` per invoice line containing `invoice_number`, `line_total`, `quantity`, `quantity_inferred`, `unit_price`, `billing_rate_key`, `invoice_rate_key`, `contract_supported`, `schedule_item` and the full `row`. Nothing on this path reaches `project_validation_evidence`.

| Reviewer field | Available at validation time | Persisted |
|---|---|---|
| invoice number | `exposure.ts:573–576` | No |
| line description | `exposure.ts:600` | No |
| quantity / unit / unit rate / extended amount | `exposure.ts:603–605` | No |
| current rate code | `financialIntegrity.ts:273` | No |
| source filename | documents table (join) | No |
| worksheet / sheet name | extraction payload | No |
| visible source row number | extraction payload | No |
| governing document name | documents table (join) | No |
| contract item description | `RateScheduleItem.description` | No |
| page / table / section | rate-schedule anchors | Partial |
| match basis / confidence | `financialIntegrity.ts:173–235` | No |

### A.6 Invoice-line resolvability (question 5)

**Yes — resolvable by targeted query, and it does not involve `transaction_data_rows`.**

Invoice lines and transaction rows are distinct grains. `transaction_data_rows` (9,983 live) is ticket/transaction data. Invoice lines derive from `document_extractions` typed fields: per audit `backlog-closeout-and-schema-drift-2026-07-19.md` §2.2, the `invoices` / `invoice_lines` projection was **retired**, and invoice truth now flows solely from `document_extractions` through `buildCanonicalInvoiceRowsFromTypedFields`, with live reconstruction via `synthesizeInvoicesFromLegacyExtractions`.

`finding.subject_id` (observed form `fact:<uuid>:line:<n>`) is produced by `rowIdentifier` from the canonical row's own `id`. Resolution path:

```
finding.subject_id
  → evidence.source_document_id  (already persisted)
  → single document_extractions read for that document
  → buildCanonicalInvoiceRowsFromTypedFields
  → match on row id === subject_id
```

One row read against an indexed document ID. **No full-dataset load is required**, satisfying the Phase C constraint in `PRODUCT_ALIGNMENT.md`.

Caveat: `rowIdentifier` falls back to `invoice_line:unknown` when no ID key is present. Any resolver must treat that as unresolvable rather than guessing by position.

### A.7 Governing-rate match persistence (question 6)

**Partially — and the existing precedent is the right one to extend.**

`supabase/migrations/20260630000000_create_invoice_line_rate_links.sql` already denormalizes exactly the fields this panel needs, keyed by `invoice_line_subject_id` — the same value as `finding.subject_id`:

```
invoice_line_subject_id, invoice_line_number, invoice_line_description,
invoice_line_billing_code, contract_document_id, contract_rate_row_id,
rate_row_description, rate_row_unit_type, rate_row_rate_amount,
actor_id, reason, created_at, is_active, superseded_by
```

Unique partial index on `(organization_id, project_id, invoice_document_id, invoice_line_subject_id) WHERE is_active`. Write path: `app/api/projects/[id]/invoice-line-rate-link/route.ts` → `lib/server/manualRateLinkClosure.ts`.

Coverage by match type:

| Match type | Persisted | Where |
|---|---|---|
| Manual operator link | **Full** | `invoice_line_rate_links` (3 rows live) |
| Automatic semantic match, `informational = true` | **Partial** — rate_code, unit_type, rate_amount, canonical_category only | `rate_schedule` evidence `field_value` |
| Automatic semantic match, `informational = false` | **None** | attempted match not recorded |
| No match | None | — |

**Recommendation:** extend the existing denormalization precedent rather than inventing a new concept. `invoice_line_rate_links` demonstrates that persisting reviewer-facing anchor fields alongside record IDs is already architecturally accepted here.

### A.8 Write paths (questions 7–8)

| Route | Purpose |
|---|---|
| `app/api/documents/[id]/facts/override/route.ts` | Canonical fact correction → `document_fact_overrides` |
| `app/api/documents/[id]/facts/review/route.ts` | Fact review state |
| `app/api/documents/[id]/facts/anchor/route.ts` | Evidence anchoring |
| `app/api/execution-items/[id]/outcome/route.ts` | **Controlled decision boundary** |
| `app/api/projects/[id]/invoice-line-rate-link/route.ts` | Manual rate link + finding closure |
| `app/api/decisions/[id]/status/route.ts` | Decision status |
| `app/api/projects/[id]/revalidate/route.ts` | Revalidation trigger |

`execution-items/[id]/outcome` (`resolveOutcome` **:166–202**) accepts exactly three actions:

| Action | Outcome | Finding status | Activity event | Trigger source |
|---|---|---|---|---|
| `approve` | `confirmed` | `resolved` | `execution_item_approved` | `review_confirmed` |
| `correct` | `resolved` | `resolved` | `execution_item_corrected` | `review_corrected` |
| `override` | `overridden` | `dismissed` | `execution_item_overridden` | `override_applied` |

`override` requires a non-empty `reason` (**:225–227**). The route also performs canonical-mutation verification (**:142–164**, `canonical_mutation_not_found` warning) and emits an activity event with prior and new status (**:315–345**).

**Blocking interaction:** when `isRateCodeMissingInformational` returns true, the finding is created with `decisionEligible: false` and `actionEligible: false` (`financialIntegrity.ts:300–301`). If no execution item is synthesized for ineligible findings, actions 1, 5 and 6 below have **no execution item to PATCH**. This must be confirmed in `lib/execution/syncExecutionItems.ts` before Phase 3 of the plan.

### A.9 Existing tests

| File | Relevance |
|---|---|
| `lib/validator/rulePacks/rateBasedContractValidation.test.ts:537,579` | Rule emission |
| `lib/validator/persistValidationRun.test.ts:692–800` | Check-key and lifecycle persistence |
| `lib/validator/exposure.test.ts:581` | Exposure interaction |
| `lib/validator/validatorDecisionSync.test.ts:452` | Decision sync |
| `lib/validation/__tests__/decisionAssertionEvaluator.test.ts:55,246` | Assertion evaluation |
| `lib/execution/syncExecutionItems.test.ts:355` | Execution item creation |
| `tests/e2e/golden-overview.smoke.spec.ts:100` | **Golden gate** — asserts the raw string `FINANCIAL_RATE_CODE_MISSING` is visible |

`golden-overview.smoke.spec.ts:100` asserts on the raw rule key. Replacing raw keys with reviewer language in the findings list will break it. Update deliberately, and keep the raw key assertion against a Technical Details region so provenance visibility remains gated.

---

## B. Proposed reviewer-facing mapping

Panel structure is preserved. No section is added, removed, or reordered.

| Section | Current source | Proposed content | Fallback | Backend work |
|---|---|---|---|---|
| **Issue Overview** | severity + `issueCategoryLabel` + `findingApprovalLabel` | Keep chips; add one line: `Invoice {number} · Line {n} · {description}` | Omit line if unresolved; chips unchanged | Yes — line resolver |
| **Problem** | `blocked_reason` or `findingProblem` | `issueDisplayFormatter.ts:21` explanation + concrete billed values (`{qty} {unit} @ {rate} = {extended}`) | Existing generic text | Yes — line resolver |
| **Conflict** | `expected` / `actual` | Expected: matched contract rate (`{code} · {desc} · {rate}/{unit}`). Actual: `No rate code on invoice line` | Current strings | No — evidence JSON already persisted |
| **ODP Note** | `odpNote` prop | Unchanged | Unchanged | No |
| **Fix This Issue** | `resolveFixSteps` static prose | Rule-specific steps + resolution controls (§C) | Static steps | Yes — §C |
| **Source Trace** | `sourceTraceLabel`, `field`, `formatSubject`, `rule_id` | Document filename · sheet · visible row · invoice number. Move `formatSubject` + `rule_id` into Technical Details | `Source reference unavailable` | Yes — document join |
| **Structured Data** | raw `record_id`, `field_name`, `field_value` | Two labelled groups: Invoice Line (desc, qty, unit, rate, extended, current code) and Matched Contract Rate (doc, item desc, category, code, amount, unit, page, basis, confidence) | Per-field `Not captured during extraction` | Yes — both resolvers |
| **Document / Contract Evidence** | `Document ${id.slice(0,8)}` | Real filename + document type; keep anchor links and on-demand geometry | `Unnamed document ({id.slice(0,8)})` | Yes — document join |
| **Technical Details** *(new, collapsed)* | — | subject_id, check_key, evidence IDs, record IDs, raw `field_value` JSON, rule ID | Always available | No |

Rules governing fallbacks:

- Never render an AI-composed sentence in place of a missing field. Use an explicit `Not captured during extraction` marker.
- Never invent invoice numbers, sheet names or row numbers when the extraction did not capture them.
- Raw identifiers move to Technical Details; they are never deleted.

---

## C. Resolution-action matrix

| # | Action | Intended outcome | Write path | Canonical truth impact | Revalidation | Audit event | Status |
|---|---|---|---|---|---|---|---|
| 1 | Accept semantic match, approve with notes | Finding resolved; match affirmed | `PATCH /api/execution-items/[id]/outcome` `action=approve` | None — affirms existing derivation | `review_confirmed` | `execution_item_approved` | **Exists**; blocked if no execution item for `actionEligible:false` |
| 2 | Assign / correct invoice rate code | Canonical fact corrected; rate code populated | `POST /api/documents/[id]/facts/override` then `action=correct` | **Mutates canonical fact** via override precedence (human-reviewed = highest) | `review_corrected` | `execution_item_corrected` + fact override event | **Exists**; needs Validator-side UI + field-key mapping |
| 3 | Match line to a different governing rate | Operator-chosen rate link persisted | `POST /api/projects/[id]/invoice-line-rate-link` | Adds override link consumed at validation time | Existing closure path | Existing manual-rate-link event | **Exists**; needs rate-row picker in Validator |
| 4 | Mark billing unsupported | Finding escalated; line flagged | `action=override` with required reason | Dismisses finding; exposure unchanged | `override_applied` | `execution_item_overridden` | **Exists**; semantics differ from #5 — see note |
| 5 | Mark not applicable | Finding dismissed as non-issue | `action=override` with reason | Dismisses finding | `override_applied` | `execution_item_overridden` | **Partially exists** — indistinguishable from #4 today |
| 6 | Leave open / needs review | Finding stays open with note | — | None | None | Needs event | **New work** |

Two gaps requiring new controlled commands:

- **#4 vs #5 collapse to the same outcome.** Both map to `override` → `dismissed`. "Unsupported billing" and "not applicable" are opposite conclusions and must not share an audit signature. Options: add a `disposition` discriminator to the outcome payload (additive, preferred), or extend `ExecutionItemOutcome`. Extending the enum requires the additive-constraint discipline in audit §1.4 — read the live constraint, extend, never drop.
- **#6 has no write path.** A note-without-resolution command does not exist. Smallest safe form is an annotation that leaves `status='open'` and emits a distinct activity event.

**Boundary constraint:** the Validator must not write canonical truth directly. Every action above routes through an existing controlled endpoint. Action 2 is a two-step sequence — fact override first, then execution outcome — and must not be collapsed into one write.

---

## D. Bounded implementation plan

Each phase is independently shippable and independently revertible.

### Phase 1 — Display-only, zero backend

Wire `issueDisplayFormatter.ts` into the drawer. Add collapsed Technical Details. Move `formatSubject` and `findingSourceReference` output into it. Format `field_value` JSON instead of printing it raw. Render the already-persisted `rate_schedule` evidence JSON (`rate_code`, `unit_type`, `rate_amount`, `canonical_category`) into Conflict and Structured Data. Add rule-specific `resolveFixSteps` branch.

*Acceptance:* no raw `fact:…:line:n` outside Technical Details; matched rate amount and unit visible; Golden findings count and severities unchanged; no new queries.

### Phase 2 — Document identity

Resolve `source_document_id` → filename and document type from the already-loaded documents collection. Replace `Document ${id.slice(0,8)}`.

*Acceptance:* real filenames in Document/Contract Evidence; `Unnamed document ({id8})` fallback; no additional round trip.

### Phase 3 — Selected-finding view model

Add a targeted resolver for one invoice line via `document_extractions` + `buildCanonicalInvoiceRowsFromTypedFields` (§A.6), invoked on selection only. Populate invoice number, description, quantity, unit, unit rate, extended amount, current rate code.

*Acceptance:* one row read per selection; `transaction_data_rows` untouched; findings list payload unchanged; selection responds < 500 ms per Phase C targets; `invoice_line:unknown` renders as unresolvable rather than guessing.

### Phase 4 — Persist match rationale

Extend `structuredRowEvidenceInput` (or add a sibling) to carry a bounded, explicitly-listed set of reviewer-facing fields. Persist the five signals from `isRateCodeMissingInformational` as a `match_basis` evidence entry. Additive columns only; follow audit §1.4 scoped-corrective-migration discipline; add the schema snapshot in the same PR.

*Acceptance:* new findings carry match basis and confidence; **existing findings still render** via Phase 3 fallback; Golden CYD 74,617 and Extended Cost $815,559.35 unchanged; schema-parity check passes.

### Phase 5 — Resolution controls

Surface actions 1–3 in Fix This Issue using existing endpoints. Confirm execution-item availability for `actionEligible:false` findings first (§A.8). Add the `disposition` discriminator for #4 vs #5. Defer #6.

*Acceptance:* each action produces the expected activity event and finding status; override reason enforced; no direct canonical write from the Validator; #4 and #5 distinguishable in audit history.

---

## E. Codex implementation prompt (Phase 1 only)

> **Task: Validator Evidence & Truth panel — reviewer-facing display for FINANCIAL_RATE_CODE_MISSING (Phase 1, display-only)**
>
> Read `PRODUCT_ALIGNMENT.md`, `CLAUDE.md`, `AGENTS.md`, and
> `docs/audits/validator-rate-code-missing-panel-audit-2026-07-19.md` before starting.
> Reviewer for this change: `eightforge-ux-reviewer` + `eightforge-truth-engine-reviewer`.
>
> **Scope — modify only:**
> `components/validator/ValidatorEvidenceDrawer.tsx`
>
> You may import from `lib/issueDisplayFormatter.ts` but must not modify it. Do not modify any
> rule pack, persistence path, API route, migration, or the findings list.
>
> **Do not:** add queries, change props, alter finding generation or persistence, restructure the
> three-panel layout, add or reorder panel sections, or introduce AI-generated prose.
>
> **Phase A findings you may rely on (verified — do not re-derive):**
> - `lib/issueDisplayFormatter.ts:21–28` already contains the correct reviewer-facing `title`,
>   `explanation`, `recommended_action` and `category` for this rule. It is not currently imported
>   by the drawer.
> - The matched contract rate is already persisted on the `rate_schedule` evidence row as a
>   `field_value` object containing `rate_code`, `unit_type`, `rate_amount`, `canonical_category`
>   (written at `lib/validator/rulePacks/financialIntegrity.ts:318–323`). It is present only when
>   the finding was downgraded to informational **and** a schedule item matched.
> - `Document aa3b36ac` originates at `ValidatorEvidenceDrawer.tsx:569–571`.
> - Duplicate rule/subject/field output comes from `formatSubject` (:75) at :487 and
>   `findingSourceReference` (:89) at :525.
> - `resolveFixSteps` (:178) routes this rule into the generic `financial_integrity` branch at
>   :209–221.
>
> **Required changes:**
> 1. Import `issueDisplayFormatter` and use its `title` for the panel heading and `explanation` for
>    the Problem body when a template exists for `finding.rule_id`. Fall back to current
>    `findingProblem` / `findingGateImpact` behaviour when it does not.
> 2. Add a collapsed `<details>` region titled **Technical Details** as the final section. Move into
>    it: `formatSubject` output, `rule_id`, `check_key`, evidence IDs, evidence `record_id` values,
>    and raw `field_value` JSON. Preserve every current value — relocate, do not delete.
> 3. Remove the duplicated `Reference` block at :525 from Structured Data (its content now lives in
>    Technical Details). Keep `Variance`.
> 4. In `StructuredEvidenceCard`, when `field_value` parses as an object, render labelled key/value
>    rows using human labels (`rate_code` → "Rate code", `unit_type` → "Unit", `rate_amount` →
>    "Rate amount" formatted as currency, `canonical_category` → "Category"). Unrecognized keys use
>    a de-underscored, capitalized label. Never print `[object Object]` or raw JSON here.
> 5. In the Conflict section, when a `rate_schedule` evidence entry with a parseable `field_value`
>    exists, render Expected as `{rate_code} · {rate_amount} per {unit_type}` and Actual as
>    `No rate code on invoice line`. Otherwise keep current `normalizedFinding` values verbatim.
> 6. Add a `FINANCIAL_RATE_CODE_MISSING`-specific branch to `resolveFixSteps`, placed before the
>    `financial_integrity` branch, returning:
>    - "Open the invoice line and confirm the billed description, quantity, unit, and rate."
>    - "Compare it against the matched contract rate shown in Conflict above."
>    - "If the match is correct, approve with a note recording the basis."
>    - "If it is wrong, assign the correct billing code or link a different contract rate."
>    - `findingNextAction(finding)`
> 7. Where a value is unavailable, render the literal string `Not captured during extraction`.
>    Do not substitute generated prose. Do not invent invoice numbers, sheet names or row numbers.
>
> **Constraints:**
> - No new network calls. Render only from the existing `finding` and `evidence` props.
> - No hardcoded Williamson County IDs, document names, invoice numbers or rate codes.
> - Preserve `isDocumentEvidence`, `classifyDocumentEvidence`, `buildEvidenceTarget` and all
>   existing evidence links and `EvidenceInspector` usage unchanged.
> - Keep the read-only posture of this panel. Resolution controls are Phase 5.
>
> **Tests:**
> - Add `components/validator/ValidatorEvidenceDrawer.test.tsx` covering: reviewer title replaces
>   raw rule key; Technical Details contains `subject_id` and `rule_id`; parsed `field_value` renders
>   labelled rows rather than JSON; Conflict shows rate amount and unit when rate_schedule evidence
>   is present; missing fields render `Not captured during extraction`; a finding with **no**
>   rate_schedule evidence still renders without throwing.
> - Build fixtures inline. Do not import live project data.
>
> **Verification gates, in order:**
> ```bash
> npx tsc --noEmit
> npx vitest run components/validator --reporter verbose
> npx vitest run lib/validator --reporter verbose
> npm run build
> ```
>
> **Known break — fix deliberately:** `tests/e2e/golden-overview.smoke.spec.ts:100` asserts the raw
> string `FINANCIAL_RATE_CODE_MISSING` is visible. After this change the reviewer-facing title is
> shown instead. Update that assertion to target the Technical Details region so raw-key provenance
> remains asserted. Do not delete the assertion.
>
> **Report back:** files changed; each panel section's before/after source; confirmation that no
> query was added; confirmation that no raw identifier was deleted rather than relocated; test and
> build results; the e2e assertion change; and whether this is safe to commit.

---

## F. Risks

| Risk | Assessment |
|---|---|
| **Canonical truth** | Phases 1–3 are read-only. Phase 4 is additive persistence. Phase 5 routes exclusively through existing controlled endpoints. No phase lets the Validator write canonical truth directly. |
| **Provenance** | Highest risk in Phase 1 — relocating identifiers into Technical Details must not become deletion. Every raw value present today must remain reachable. |
| **Revalidation** | Phase 4 changes evidence shape. Old findings lack new fields; the resolver must degrade rather than throw. Golden must be re-verified without a forced revalidation (no unauthorized revalidation on the Golden Project). |
| **Schema parity** | Phase 4 is the only migration. Scoped corrective migration per audit §1.4; snapshot updated in the same PR; must land after schema-parity CI exists per `PRODUCT_ALIGNMENT.md` Phase A. |
| **Performance** | Phase 3 adds one row read on selection. Findings list payload must not grow. Do not join invoice-line detail into the list query. |
| **Golden regression** | CYD 74,617 and Extended Cost $815,559.35 must be unchanged through all phases. Only display and additive evidence change. |
| **Execution-item availability** | Unverified: whether `actionEligible:false` findings receive execution items. Blocks Phase 5 actions 1, 5, 6. Confirm in `lib/execution/syncExecutionItems.ts` first. |

## G. Alignment conflict requiring an owner decision

`PRODUCT_ALIGNMENT.md` §4 states: *"The project workspace must not become read-only for canonical facts."*

`ValidatorEvidenceDrawer.tsx:617` currently renders: *"Validator is read only. Use the Decision & Execution panel to confirm, correct, or override this finding."*

These are not yet in conflict — correction is delegated to an adjacent panel rather than absent. But the requested Phase 5 controls (particularly action 2, assigning a rate code) would place fact correction inside the Validator, at which point that copy becomes false and the delegation model changes.

**Decision required before Phase 5:** does fact correction happen *in* the Validator, or does the Validator deep-link into the correction surface? This is the same question as the `FactEvidencePanel` port recorded in `PRODUCT_ALIGNMENT.md` §3.3, and it should be answered once for both. Phases 1–4 are unaffected either way.
