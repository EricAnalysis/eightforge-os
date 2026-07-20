# `financialIntegrity.ts` evidence enrichment — audit and Codex prompt

**Date:** 2026-07-20
**Type:** Phase A audit + bounded Phase B implementation prompt. Nothing implemented in this turn.
**Trigger:** live-UI observation on `FINANCIAL_RATE_CODE_MISSING`. The Subject summary correctly
showed `Not captured during extraction` for every field per the honest-degradation design (Phase
1+2, shipped and verified), but this exposed a real, separate gap underneath the display layer: the
rule that generates this finding evaluates the invoice line's own description, unit, quantity, and
rate internally, then discards all of it except the one field that's missing.
**Scope:** intentionally narrow — two rules in one file, plus one shared UI wording constant.
**Alignment:** `PRODUCT_ALIGNMENT.md` §4, §9; `CLAUDE.md` (reuse before invent, minimal diff,
preserve evidence anchors, deterministic behavior).

---

## A. What's actually happening (verified, not inferred from the UI alone)

`lib/validator/rulePacks/financialIntegrity.ts`, inside `runFinancialIntegrityRules`
(`for (const row of input.invoiceLines)`, starting line 271):

- `isRateCodeMissingInformational` (line 136–236) reads the invoice line's description, service
  item, material, unit, and rate directly off `row` to compare against the matched contract rate
  row. It returns a bare boolean. None of the values it read are returned or persisted.
- The `FINANCIAL_RATE_CODE_MISSING` finding (line 289–330) attaches exactly one invoice-line
  evidence entry: `structuredRowEvidenceInput({ evidenceType: 'invoice_line', row, fieldName:
  'rate_code', fieldValue: null, ... })`. No entry is written for description, quantity, unit price,
  line total, or invoice number, even though `row` — the full line — is sitting in scope the entire
  time.
- When `informational && scheduleItem`, a second evidence entry is attached for the **matched
  contract rate row** (line 312–326) carrying `canonical_category`, `rate_amount`,
  `source_category`/`unit_type`, `match_source_kind`. This is why the Rate Schedule card in the UI
  is fully populated while the invoice line's own identity is not — the asymmetry is real and is
  exactly what the user saw.
- `FINANCIAL_UNIT_TYPE_MISMATCH` (line 334–374) is in the same loop, uses the same
  `structuredRowEvidenceInput` helper, and has the identical gap one level less severe: it attaches
  `unit_type` (a real, non-null value) for the invoice line, but not description, quantity, unit
  price, line total, or invoice number. Same construction path, same file, same fix shape — safe to
  bundle per the requested scope.

**Available key constants:** `financialIntegrity.ts` already defines local
`INVOICE_LINE_DESCRIPTION_KEYS` (line 32–42) and `INVOICE_LINE_SERVICE_ITEM_KEYS` (line 43+). It
does **not** define quantity, line-total, or invoice-number key lists — those exist as local
(unexported, unverified whether exported) constants in `lib/validator/exposure.ts`
(`INVOICE_LINE_TOTAL_KEYS` line 91, `INVOICE_LINE_INVOICE_NUMBER_KEYS` line 47, quantity via
`deriveInvoiceLineQuantity` line 321). Six different rule-pack files in this codebase
(`financialIntegrity.ts`, `projectValidator.ts`, `reconciliation.ts`,
`contractInvoiceReconciliation.ts`, `crossDocumentRateVerification.ts`,
`invoiceTransactionReconciliation.ts`) already independently duplicate this exact style of key-alias
constant rather than importing a shared module — that is the established convention in this specific
codebase, not an oversight to fix here. **Codex must follow that convention**: add local key
constants matching the literal values already used elsewhere, not attempt a shared-module
refactor. Confirm exportability of `exposure.ts`'s constants before deciding whether to import or
duplicate; if unexported, duplicate the literals — do not export them from `exposure.ts` as a side
effect of this change (that's a larger refactor than this task's scope).

**Revalidation/duplication safety — verified, not assumed:** `lib/validator/persistValidationRun.ts`
inserts a new row into `project_validation_findings` per finding (`run_id: params.runId`, line
605–607 and 635–637 — a fresh insert, not an upsert), then separately inserts evidence via
`buildEvidenceInserts(findingId, evidence)` (line 568–569) referencing the **newly created**
`findingId`. This means every validation run produces wholly new finding and evidence rows — there
is no code path where a revalidation appends evidence onto a prior run's finding. **Cross-run
duplication of the same field/record cannot happen by construction.** The only real risk is
**within one finding's own evidence array**: the new code must not call
`structuredRowEvidenceInput` twice for the same `field_name` in a single finding (e.g. accidentally
duplicating `description`), and must not re-add `rate_code` on the invoice-line side (it already has
its one `null` entry representing "missing" — that entry stays untouched).

**Matched contract row must never supply invoice-line identity — verified as a live risk, not
theoretical.** The Subject-panel UI logic already excludes `rate_schedule`/`contract` evidence
groups from an `invoice_line` subject's summary (`ValidatorEvidenceDrawer.tsx`,
`findPrimaryEvidenceGroup`/`primaryEvidenceType`, verified in the last review pass). But that's a
UI-layer safeguard. This task adds the enrichment **upstream**, in the rule pack — so the same
discipline must be enforced there: every new evidence entry must read from `row` (the invoice line)
only, never from `scheduleItem`/`item` (the matched contract rate row). If the invoice line's own
description is genuinely blank in `row`, no entry is written for it — it does not get backfilled
from the contract item's description.

---

## B. Fallback wording

`components/validator/ValidatorEvidenceDrawer.tsx:56` defines a single shared constant:

```ts
const NOT_CAPTURED = 'Not captured during extraction';
```

This is the only place this string exists — it is used by every `DetailBlock` fallback throughout
the panel, for every rule type, not just these two. **Changing it is a one-line, text-only, global
change by construction** — there is no narrower way to scope it without duplicating the constant
per call site, which would be worse. The wording change is justified independent of scope: "not
captured during extraction" asserts a cause (OCR/extraction failure) that, after this fix, is no
longer the most likely explanation for a blank field — the more likely explanations become "this
specific value genuinely wasn't on the line" or "this finding predates the enrichment and never got
the richer evidence." `Not retained with this finding` is deliberately neutral about which of those
is true, which is more honest than the current wording in both cases.

---

## C. Bounded implementation plan

### Non-goals (explicit)
- No changes to `isRateCodeMissingInformational`, the informational/severity computation, or any
  other rule in `financialIntegrity.ts` beyond the two named.
- No changes to `rateBasedContractValidation.ts`, `crossDocumentRateVerification.ts`, or any other
  rule pack.
- No schema change, no migration — `field_name`/`field_value` on `project_validation_evidence`
  already accept this data.
- No change to `resolveFixSteps`'s existing branches for other categories.
- No new resolver, no new query, no change to `ValidatorTab.tsx` or its data loading.
- No Golden Project revalidation triggered as part of this work.

### Step 1 — Enrich evidence in `financialIntegrity.ts`
For both `FINANCIAL_RATE_CODE_MISSING` and `FINANCIAL_UNIT_TYPE_MISMATCH`, add
`structuredRowEvidenceInput` calls (reusing the existing helper, matching the existing call style in
this file) for: `invoice_number`, `description`, `quantity`, `unit_price`, `line_total`. Reuse
`INVOICE_LINE_DESCRIPTION_KEYS` already in this file. Add local `INVOICE_LINE_INVOICE_NUMBER_KEYS`,
`INVOICE_LINE_TOTAL_KEYS`, and a quantity read matching the literal values already used in
`exposure.ts`/`contractInvoiceReconciliation.ts` for consistency. `FINANCIAL_RATE_CODE_MISSING`
keeps its existing `rate_code: null` entry untouched. `FINANCIAL_UNIT_TYPE_MISMATCH` keeps its
existing `unit_type` entries on both sides untouched. Read only from `row`; never from
`scheduleItem`/`item`.

### Step 2 — Rule-specific "Fix This Issue" guidance
In `ValidatorEvidenceDrawer.tsx`, `resolveFixSteps`, add a branch keyed on `rule_id` (checked before
the generic `financial_integrity` branch at line ~317) with two variants:

- `FINANCIAL_RATE_CODE_MISSING`, informational/matched (severity `info`, `approval_gate_effect`
  reads as approved-with-notes): *"Confirm the invoice line's billing code. If the contract schedule
  has no explicit code, confirm the matched schedule row or approved description-based billing key.
  Reject the proposed match if it points to the wrong rate item."* (exact wording as specified — do
  not paraphrase).
- `FINANCIAL_RATE_CODE_MISSING`, non-informational (severity `warning`, no match found): reuse the
  existing `required_action` language already in `findingSemantics.ts:97–101` — *"Populate the
  invoice line billing code, or confirm the description-based billing key used for validation."*
  Do not invent new phrasing for this sub-case.
- `FINANCIAL_UNIT_TYPE_MISMATCH`: reuse the existing `required_action` language at
  `findingSemantics.ts:102–105` — *"Review the billed unit against the contract unit and correct the
  invoice or contract mapping before approval."*

Determine which `FINANCIAL_RATE_CODE_MISSING` variant applies from data already on the finding
(`severity`/`decision_eligible`/`action_eligible` — informational findings already carry
`decisionEligible: false`, `actionEligible: false` per `financialIntegrity.ts:300–301`) — do not
re-derive `isRateCodeMissingInformational` in the UI layer.

### Step 3 — Fallback wording
Change `NOT_CAPTURED` in `ValidatorEvidenceDrawer.tsx:56` from `'Not captured during extraction'` to
`'Not retained with this finding'`. Single line, global by construction (§B).

### Step 4 — Backward compatibility for existing findings
Findings persisted before this change have only the thin evidence shape. After Step 3, they render
the new fallback text for every field that's absent — this is already how `DetailBlock` and
`SubjectIdentitySummary` behave (verified in the prior review pass: missing values fall back
gracefully, no throw). No code change is required for old findings to render safely; this must be
**confirmed with a test**, not assumed, since it's the exact case the user's caution is about.

---

## D. Required verification

- **Deduplication within one finding:** a test asserting the new evidence array for a single
  `FINANCIAL_RATE_CODE_MISSING` finding contains no two entries with the same `field_name`.
- **New vs. old finding rendering:** one test with the enriched evidence shape (asserting the Subject
  summary now shows real values instead of the fallback), and one test with the old thin shape
  (asserting it still renders the fallback text safely, using the new wording) — both against the
  same rule, proving old and new findings coexist safely.
- **No behavior change:** run the existing `financialIntegrity`-adjacent test suites
  (`lib/validator/rulePacks/rateBasedContractValidation.test.ts`,
  `lib/validator/persistValidationRun.test.ts`, `lib/validator/exposure.test.ts`,
  `lib/validation/__tests__/decisionAssertionEvaluator.test.ts`) and confirm every existing
  assertion about `severity`, `status`, `decision_eligible`, `action_eligible`, `expected`, `actual`
  still passes unmodified. Only evidence-array-shape assertions, if any exist and assert an exact
  array (not a superset check), may need updating — and only those.
- **Matched-row isolation:** a test where the invoice line's own `description` is absent/blank but a
  matched `scheduleItem` has a populated description — assert the new invoice-line evidence entry is
  either absent or explicitly empty, and never equal to the contract item's description.
- **Golden Project:** no revalidation. Confirm via the existing test fixtures (not a live run) that
  the two rules' `expected`/`actual`/severity outputs for known Golden cases are unchanged.

## E. Verification gates

```bash
npx tsc --noEmit
npx vitest run lib/validator components/validator --reporter verbose
npm run build
```

---

## F. Codex prompt

> **Task: Enrich `FINANCIAL_RATE_CODE_MISSING` and `FINANCIAL_UNIT_TYPE_MISMATCH` evidence with the
> invoice line's own business fields; add rule-specific Fix guidance; correct the fallback wording**
>
> Read `PRODUCT_ALIGNMENT.md`, `CLAUDE.md`, `AGENTS.md`, and this audit
> (`docs/audits/financial-integrity-evidence-enrichment-audit-2026-07-20.md`) before starting.
> Reviewer: `eightforge-truth-engine-reviewer` + `eightforge-ux-reviewer`.
>
> **Scope — modify only:**
> `lib/validator/rulePacks/financialIntegrity.ts`,
> `components/validator/ValidatorEvidenceDrawer.tsx`
>
> Do not modify any other rule pack, `findingSemantics.ts`, `persistValidationRun.ts`, any migration,
> or any API route. Do not touch `isRateCodeMissingInformational`'s comparison logic, the severity
> assignment, `decisionEligible`/`actionEligible` values, or `expected`/`actual` for either rule.
>
> **Verified findings you may rely on (do not re-derive):**
> - `financialIntegrity.ts:271–330` builds `FINANCIAL_RATE_CODE_MISSING` with exactly one
>   invoice-line evidence entry (`rate_code`, value `null`) despite `isRateCodeMissingInformational`
>   (line 136–236) reading description/unit/rate/category off the same `row` internally.
> - `financialIntegrity.ts:334–374` builds `FINANCIAL_UNIT_TYPE_MISMATCH` the same way, with one real
>   `unit_type` entry per side and the same missing business-field gap.
> - The matched contract rate row already gets a rich evidence entry (line 312–326,
>   `evidence_type: 'rate_schedule'`) — this is why the asymmetry is visible in the UI today.
> - `financialIntegrity.ts` already defines `INVOICE_LINE_DESCRIPTION_KEYS` (line 32–42) locally. It
>   does not define invoice-number, line-total, or quantity key lists. `exposure.ts` has
>   `INVOICE_LINE_INVOICE_NUMBER_KEYS` (line 47), `INVOICE_LINE_TOTAL_KEYS` (line 91), and
>   `deriveInvoiceLineQuantity` (line 321) — check whether these are exported; if not, add local
>   constants in `financialIntegrity.ts` with matching literal values, following the existing
>   codebase convention of per-file local key-alias constants (confirmed present in at least six
>   other rule-pack files). Do not create a new shared module for this.
> - `persistValidationRun.ts` inserts a new finding row per run (`run_id`, line 605–607/635–637) and
>   inserts evidence against the newly created `findingId` (line 568–569) — every validation run
>   produces wholly new rows. Cross-run evidence duplication is not possible by construction; your
>   only duplication risk is within a single finding's own evidence array.
> - `ValidatorEvidenceDrawer.tsx:56` defines `const NOT_CAPTURED = 'Not captured during extraction'`
>   — the single shared fallback string used throughout the panel for every rule type.
>
> **Required changes:**
>
> 1. In `financialIntegrity.ts`, for both `FINANCIAL_RATE_CODE_MISSING` and
>    `FINANCIAL_UNIT_TYPE_MISMATCH`, add `structuredRowEvidenceInput` calls for `invoice_number`,
>    `description`, `quantity`, `unit_price`, `line_total`, reading each **only from `row`** (the
>    invoice line), never from `scheduleItem`/`item` (the matched contract rate row). Do not remove
>    or alter the existing `rate_code`/`unit_type` entries already being written for either rule. Do
>    not write an entry for a field that isn't present on `row` — omit it rather than writing an
>    empty string.
> 2. In `ValidatorEvidenceDrawer.tsx`, `resolveFixSteps`, add a `rule_id`-keyed branch evaluated
>    before the generic `financial_integrity` branch:
>    - `FINANCIAL_RATE_CODE_MISSING` where the finding indicates the informational/matched state
>      (use `decision_eligible === false` as the signal, matching how `financialIntegrity.ts:300–301`
>      already marks this case — do not re-implement the match logic in the UI): return exactly —
>      *"Confirm the invoice line's billing code. If the contract schedule has no explicit code,
>      confirm the matched schedule row or approved description-based billing key. Reject the
>      proposed match if it points to the wrong rate item."*
>    - `FINANCIAL_RATE_CODE_MISSING`, otherwise: *"Populate the invoice line billing code, or confirm
>      the description-based billing key used for validation."*
>    - `FINANCIAL_UNIT_TYPE_MISMATCH`: *"Review the billed unit against the contract unit and correct
>      the invoice or contract mapping before approval."*
>    Use this exact language — it was specified directly, not drafted for this task. Do not add a
>    trailing `nextAction`/`findingNextAction()` call to these three branches the way the generic
>    branches do, since the text already fully specifies the action.
> 3. Change `NOT_CAPTURED` at `ValidatorEvidenceDrawer.tsx:56` from `'Not captured during extraction'`
>    to `'Not retained with this finding'`. This is a single shared constant — the change is global
>    by construction; do not attempt to scope it to only these two rules.
>
> **Constraints:** no hardcoded Williamson County IDs, document names, invoice numbers, or rate
> codes in code. No schema change, no migration. No change to any other rule pack. No change to
> severity, `decision_eligible`, `action_eligible`, `expected`, or `actual` for either rule. Every
> new evidence value must trace to `row`; a value from `scheduleItem`/`item` must never appear under
> an invoice-line field name.
>
> **Tests:**
> - `lib/validator/rulePacks/financialIntegrity.test.ts` (create if it doesn't exist, matching the
>   existing test style in `rateBasedContractValidation.test.ts`): assert the enriched evidence array
>   for both rules contains the five new fields with correct values from a fixture row; assert no two
>   evidence entries in one finding share the same `field_name`; assert a fixture with a matched
>   `scheduleItem` whose description differs from the invoice line's own (blank) description never
>   produces an invoice-line evidence entry equal to the contract item's description; assert severity,
>   `decision_eligible`, `action_eligible`, `expected`, `actual` are byte-identical to the pre-change
>   values for the same fixtures.
> - `components/validator/ValidatorEvidenceDrawer.test.tsx`: extend with (a) a
>   `FINANCIAL_RATE_CODE_MISSING` fixture using the enriched evidence shape — assert the Subject
>   summary now shows real invoice number/description/quantity/unit price/line total/rate code
>   instead of the fallback; (b) the **existing thin-evidence fixture already in this file** (the one
>   from the honest-degradation test) — assert it still renders safely with the **new** fallback text
>   `Not retained with this finding` instead of the old string, proving old findings remain
>   compatible; (c) the informational-matched fixture — assert the new rule-specific Fix step text
>   appears verbatim; (d) the non-informational fixture — assert its distinct Fix step text appears;
>   (e) a `FINANCIAL_UNIT_TYPE_MISMATCH` fixture — assert its Fix step text appears.
>
> **Verification gates, in order:**
> ```bash
> npx tsc --noEmit
> npx vitest run lib/validator components/validator --reporter verbose
> npm run build
> ```
> Also run `lib/validator/rulePacks/rateBasedContractValidation.test.ts`,
> `lib/validator/persistValidationRun.test.ts`, `lib/validator/exposure.test.ts`, and
> `lib/validation/__tests__/decisionAssertionEvaluator.test.ts` explicitly and confirm every existing
> assertion still passes unmodified — flag any exact-array-equality evidence assertion that needed
> updating and explain exactly what changed and why.
>
> **Report back:** files changed; the exact new evidence fields added per rule with the fixture
> values used to prove correctness; confirmation no evidence value was sourced from
> `scheduleItem`/`item`; confirmation no duplicate `field_name` exists within a single finding's
> evidence array; confirmation old thin-evidence findings render safely with the new fallback text;
> confirmation severity/eligibility/expected/actual are unchanged, with the specific test proving it;
> the exact wording rendered for all three Fix-step variants; test and build results; whether this is
> safe to commit.
