# Forgewing Resolution Layer — Phase A audit (2026-10-04)

This audit is read-only. It changes no code, schema or data.

**Purpose.** On 2026-10-04 the product direction changed:

- EightForge ships in two tiers:
  - **Core** is deterministic.
  - **Core + Forgewing** adds an AI investigative layer.
- Forgewing is no longer limited to choosing among options that deterministic extraction already produced. It may:
  - read source documents visually and propose values;
  - propose document relationships;
  - explain reconciliation failures and suggest operator actions;
  - emit improvement signals.

**Unchanged rule.** EightForge keeps **one** canonical truth model. AI-proposed values are never canonical. Only deterministic values and operator-reviewed values reach the Validator.

This audit maps that design onto the code as it stands on `main` (`40f7224`) plus PR #140, the E3 stack with recovery type 3. It lists the gaps and proposes a build order. Every claim cites a file or a migration. A claim not verified here is marked *inferred*.

---

## 1. Authority model: what exists

| Class | Existing mechanism | Where |
|---|---|---|
| **Deterministic** | Extraction and reconstruction produce rows with typed receipts. The Validator consumes the canonical projection. | `lib/extraction/pdf/pagePricedScheduleReconstruction.ts`, `lib/contracts/*`, `lib/canonical/*` |
| **AI proposed** | `forgewing_recovery_proposals`. The database pins `authority = 'non_authoritative'` and `requires_human_review = true`, and the table is immutable by trigger. | `supabase/migrations/20260909182310_phase_12_recovery_proposals.sql` |
| **Reviewed (selection)** | `forgewing_recovery_proposal_reviews` is append-only. A review may only confirm an observation or candidate that the proposal itself cited: "a review never authors a value". | `20260909182311_phase_12_recovery_review.sql`; candidate closure in `20260910160124`, `20260911144106`; type 3 in `20261004120000` (PR #140) |
| **Reviewed (document field)** | `document_fact_overrides`: add or correct, with a supersession chain. Displayed as `human_added` / `human_corrected`. Consumed by canonical truth and the Validator. | `lib/documentFactOverrides.ts`, `lib/canonical/truth/envelope.ts:298-380`, `lib/validator/projectValidator.ts`, `lib/validator/triggerProjectValidation.ts` |
| **Reviewed (invoice line ↔ rate)** | `invoice_line_rate_links`: operator links with supersession. | `20260630000000_create_invoice_line_rate_links.sql`, `lib/server/manualRateLinkClosure.ts`, `components/validator/ManualRateLinkResolutionPanel.tsx` |
| **Reviewed (assertion ledger), UNUSED** | `human_fact_assertions`: source-bound or domain assertion, a required reason, supersession, and status `active` / `superseded` / `needs_review`. **No application code reads or writes it.** | `20260723163517_phase3_step0_compliance_foundation.sql:571` |

**Precedent for "AI proposed never canonical":** rate rows produced by the authored stitching paths are already quarantined. `authored_unverified` raises the critical, blocking finding `FINANCIAL_AUTHORED_RATE_ROW_UNVERIFIED` (`lib/validator/rulePacks/authoredRateRowQuarantine.ts`, `lib/contracts/authoredRowQuarantine.ts`). Forgewing value proposals should get the same treatment until an operator reviews them.

**Precedent for reviewed receipts flowing into pricing:** type 3 rows carry `header_semantics: { status: 'human_selected', candidate_id, review_id }` (`lib/contracts/types.ts:204`, `lib/canonical/contract/pricing.ts:59`).

**Core / Forgewing boundary already tested:** `lib/architecture/recoveryReviewBoundaries.test.ts:116` asserts that "every canonical and validator path [is] unaware that recovery exists".

## 2. Forgewing runtime: what exists

- **Provider.** The official Anthropic SDK with structured outputs (`lib/forgewing/runtime/client.ts`). It is **text-only**: the request content is a single JSON string (`client.ts:187`, `content: request.inputJson`). No task sends an image or a document.
- **Tasks.** `regionClassification`, `tableContinuation`, `columnMapping`, `observationArbitration`, `pricingInterpretation`, `pricingRateClusterRecovery`, `recoveryCandidateV2`, `workflowAssessment` and `repositoryPlanGuidance` (`lib/forgewing/tasks/*`, `lib/forgewing/prompts/*`).
- **Gates.** These are environment flags, global to the deployment. The master `FORGEWING_SHADOW_ENABLED` is ANDed into every feature gate, and each gate requires the strict value `'1'` (`lib/forgewing/runtime/modelConfig.ts:32-93`).
- **Page rendering already exists server-side.** `extractPdfPageTextViaOcr` renders pages with `pdfjs-dist` and `@napi-rs/canvas` (`lib/server/documentExtraction.ts:1021`). A vision task can reuse it without a new rendering stack.
- **Evaluation.**
  - The E3 four-page benchmark has delegated truth (`lib/evaluation/benchmark/*`).
  - The Phase 17 live-eval seams are in `lib/evaluation/phase17LiveSeams.ts`.
- **Orchestrator (engineering loop).** This path already exists:
  1. workflow intake;
  2. assessment;
  3. review;
  4. implementation plan;
  5. repository Plan V2;
  6. engineering recommendation review;
  7. Linear projection.

  It is backed by migrations `20260830…` through `20260908…` and the Forgewing engineering worker role. It is built around *customer workflow intake*, not internal improvement signals.

## 3. Validator: what exists

- About 50 stable rule IDs across `lib/validator/rulePacks/*`. Examples:
  - `FINANCIAL_INVOICE_UNIT_PRICE_MATCHES_CONTRACT_RATE`
  - `CROSS_DOCUMENT_RATE_MATCHES_CONTRACT`
  - `FINANCIAL_RATE_CODE_MISSING`
  - `CANONICAL_GOVERNING_RELATIONSHIP_UNRESOLVED`
  - `SOURCES_NO_RATE_SCHEDULE`
  - `TICKET_QTY_CYD_MISMATCH`
- Findings carry `expected`, `actual`, evidence and eligibility flags (`decisionEligible`, `actionEligible`). They feed decisions and actions through `lib/validator/createFindingDecision.ts`, `createFindingAction.ts` and `queueFindingActions.ts`.
- Operator UI: `components/validator/*`, which includes `ValidatorFindingsPanel`, `ValidatorEvidenceDrawer` and `ManualRateLinkResolutionPanel`.
- There is **no explanation layer**. No mapping exists from a rule ID to operator guidance, and there is no fixed vocabulary of next actions.

## 4. Document relationships: what exists

- `document_relationships` supports these types:
  - `attached_to`, `supplements`, `supersedes`, `amends`, `governs`, `replaces`, `supports`, `applies_to`, `duplicate_of`.
- Precedence and governing families live in `lib/documentPrecedence.ts`, `lib/server/documentPrecedence.ts` and `app/api/projects/[id]/document-precedence/route.ts`.
- Relationships are **operator-created**. Nothing detects a referenced-but-missing document (for example "Amendment No. 3").
- Production has no foreign keys on this table (see `20260811170000_reconcile_production_schema.sql`); that is a separate integrity audit.

## 5. Gaps

| # | Gap | Evidence |
|---|---|---|
| G1 | **No tier or entitlement.** No plan or tier column or table exists, and Forgewing gates are deployment-global environment flags. | `modelConfig.ts`; schema search found no `tier` or `entitlement` |
| G2 | **No vision input** to any Forgewing task. | `client.ts:187` |
| G3 | **No region-bound reviewed value.** `human_fact_assertions` requires a `target_machine_fact_id` or `target_verified_field_id` when source-bound, and has no page or region binding. A value that extraction never produced has no fact to target. `document_fact_overrides` works at document-field grain only. Recovery reviews cannot author values. | `20260723163517…:571-590`; `phase_12_recovery_review.sql` |
| G4 | **Unresolved evidence is not durable.** `reconstructPage` returns `null` when no header exists or there are several (`pagePricedScheduleReconstruction.ts:506, 583, 914`). Unresolved role cells and unattached tokens live only inside the reconstruction JSON. | readiness audit (memory `forgewing-readiness-audit`) |
| G5 | **No unified operator queue.** Validator findings, pending recovery proposals, unresolved evidence and relationship gaps surface in separate panels (`ValidatorFindingsPanel`, `RecoveryReviewPanel` on the document page). | `components/documents/RecoveryReviewPanel.tsx`, `components/validator/*` |
| G6 | **No explanation or action layer** for findings. | §3 |
| G7 | **No missing-document or relationship detection.** | §4 |
| G8 | **No improvement-signal aggregation.** The Orchestrator intake is customer-workflow shaped. | §2 |
| G9 | **"Core works with AI off" is not a gate.** Only the recovery-unaware boundary test exists. | `recoveryReviewBoundaries.test.ts:116` |
| G10 | **No measured accuracy** for AI value extraction, so confidence values are uncalibrated. | none |
| G11 | **External: customer data handling.** Customer contracts must permit page images to Claude and cross-customer pattern learning. | not a code gap |

## 6. Proposed design decisions (to confirm before Phase B)

- **D0 Human reviewed input is final, and visible upstream and downstream. This is a hard invariant set by the user on 2026-10-04.**
  - Forgewing may propose, extract, reconcile, explain and link. Whenever AI is involved, the operator's reviewed input is the authority.
  - It applies equally to:
    - scalar values;
    - document relationships (Forgewing proposes `Invoice → Amendment 3`; once confirmed, the relationship is `human_reviewed`);
    - Validator resolutions (Forgewing explains a mismatch; the operator's chosen resolution is final and `human_reviewed`).
  - **Upstream.** Reprocessing and reconciliation must know that a human already reviewed a source region and established its value. A later machine or AI reading of the same evidence never silently replaces it. It may only raise a contradiction for re-review. This matches the digest-bound `needs_review` rule in D2.
  - **Downstream.** Every consumer must keep the provenance chain, never only the final number:
    - Project Truth;
    - the Validator;
    - decisions;
    - reports and exports;
    - downstream reconciliation.
  - The chain to keep:
    1. original extraction (e.g. `[$320.00`, or "none");
    2. Forgewing suggestion, if any;
    3. operator decision: approved, modified, manually entered or rejected;
    4. final reviewed value, with its source document, page and evidence link.
  - If the operator changes an AI suggestion, both are shown: "Forgewing suggested $320.00; operator entered $325.00; final $325.00". The AI suggestion stays as historical evidence; the operator's value is the authority.

- **D1 Authority classes.**
  - Classes: `deterministic`, `ai_proposed`, `reviewed`.
  - `reviewed` carries an origin of `operator_entered`, `operator_selected` (types 1–3) or `ai_proposed_operator_approved`.
  - The Validator consumes `deterministic` and `reviewed` only. An `ai_proposed` value surfaces as a quarantined proposal, never as a fact (the precedent in §1).
- **D2 Reviewed values reuse `human_fact_assertions`; no new ledger.**
  - Extend it additively with an optional region binding. Columns:
    - value type or field;
    - source artifact and physical page;
    - source region and boxes;
    - page-representation digest;
    - target cell or field identity;
    - the original source text;
    - an optional Forgewing proposal ID;
    - the operator review ID and disposition (`approved`, `modified`, `manually_entered`);
    - `authority = human_reviewed`.
  - Allow a third `source_binding` value, `region_bound`, so a value extraction never produced can be asserted.
  - Fix the binding to the page-representation digest. If the digest changes, set status `needs_review`; never carry the value over silently.
  - Keep "latest active wins" with append-only supersession, as the table already has.
  - This applies the 2026-10-02 attestation decision on the existing ledger.
  - It is a **Core** capability. Forgewing only pre-fills it.
- **D3 AI value proposals.**
  - New proposal kind: `forgewing_value_proposals`, using the same organization FK, immutability trigger and `non_authoritative` pinning as `forgewing_recovery_proposals`.
  - It records page/region binding, page-image digest, model, prompt version, proposed value, the deterministic state at proposal time, and the model's self-reported confidence (*uncalibrated*).
  - Operator approval writes an `ai_proposed_operator_approved` `human_fact_assertions` row through one RPC. The proposal row is never mutated.
  - A separate table, rather than a new recovery type, because the recovery closure (a value must equal cited evidence) does not hold for AI-read values. *Recommendation; confirm in Phase B.*
- **D4 ResolutionCase is a derived read model, not a store.**
  - It is a pure function over open validator findings, pending recovery and value proposals, durable unresolved evidence (once G4 is closed) and relationship gaps.
  - Only proposals and decisions are persisted, and they already have tables.
- **D5 Tier entitlement.**
  - Add an `organization_entitlements` table, or a `forgewing_enabled_at` column on `organizations`. *Decide in B1.*
  - Add one server function, `isForgewingEnabledForOrganization(orgId)`, that ANDs the entitlement with the global kill switch. Every Forgewing entry point and UI affordance checks it.
  - Core code paths never call it.
  - On downgrade, reviewed assertions remain valid, and pending proposals go inert: hidden and never deleted.
- **D6 Explanations are deterministic first.**
  - Rule-ID templates plus a fixed action vocabulary are a **Core** feature. The vocabulary:
    - `upload_document`
    - `open_linked_documents`
    - `open_manual_rate_link`
    - `open_evidence_inspector`
    - `enter_reviewed_value`
    - `mark_unresolved`
  - Every action maps to an existing UI route or panel.
  - Forgewing adds an optional narrative and a ranked choice from the same vocabulary. It never adds free-text actions.
- **D7 Missing-document detection is deterministic first.**
  - Scan extracted text for document references: amendments, task orders, change orders, exhibits, addenda. A reference that does not resolve in the project graph raises a Core finding.
  - Forgewing proposes `document_relationships` rows, which an operator confirms.
- **D8 Improvement signals.**
  - Aggregate reviewed corrections by a deterministic pattern key, such as a unit alias or a header label.
  - Emit a signal only above a threshold of independent reviews across several projects.
  - Signals enter the Orchestrator as a new internal intake kind. The proposed rule is evaluated against stored evidence and the Golden/E3 regression gates before any implementation.
  - An approval rate alone is not proof.

## 7. Proposed build order (Phase B)

Each step is its own PR with its own gates. Steps marked **Core** ship to both tiers.

| Step | Scope | Tier | Depends on |
|---|---|---|---|
| B0 | Land PR #140 (type 3), then apply `20261004120000` to production with gates off | — | — |
| B1 | Entitlement (D5), plus a gate that runs the Core pipeline with the Anthropic key absent and checks the output is unchanged (G9) | Core | — |
| B2 | Durable unresolved evidence (G4): page-level "table suspected" records, plus observations for the refs that are currently missing | Core | — |
| B3 | Region-bound reviewed values on `human_fact_assertions` (D2), plus an operator entry UI in the Evidence Inspector, flowing into pricing and the Validator with `operator_entered` provenance | Core | B2 |
| B4 | Forgewing vision value proposals (D3), with offline accuracy measured on E3 truth before any operator exposure (G10) | Forgewing | B1, B3 |
| B5 | ResolutionCase read model and a unified operator queue (D4) | Core (+ Forgewing items) | B2, B3 |
| B6 | Validator explanations and the action vocabulary (D6), plus an optional Forgewing narrative | Core (+ Forgewing) | B5 |
| B7 | Missing-document detection (D7), plus Forgewing relationship proposals | Core (+ Forgewing) | B5 |
| B8 | Improvement signals into the Orchestrator (D8) | Forgewing | B3, B4, operator volume |

## 8. Non-goals and open questions

- Not in scope: the production foreign-key and duplicate-policy integrity findings.
- **Open questions for the user:**
  - D2: extend `human_fact_assertions` (recommended) or keep a separate attestation table?
  - D3: a separate value-proposal table (recommended) or a new recovery type?
  - D5: an entitlement table or a column?
  - G11: are customer data-handling terms confirmed?
- *Inferred, not verified here:* `document_relationships` creation is operator-only. No automatic writer was found by name search, but writers outside `lib/server/projectAdmin.ts` and the precedence route were not exhaustively traced.

## 9. Status (2026-10-09)

This audit is a Phase A snapshot. Its proposals have since been decided and built on `main`. The record of what landed, so the open questions above are not read as still open:

- **D2: decided. Extend `human_fact_assertions`.** `20261004160000_human_fact_assertions_region_bound.sql` adds:
  - `source_binding = 'region_bound'`;
  - the page-representation digest binding;
  - the `needs_review` status;
  - review origins `operator_entered`, `ai_proposed_operator_approved` and `ai_proposed_operator_modified`.
  - It remains the only ledger that produces human-reviewed truth.
- **D3: decided. A separate proposal table.** `20261004220000_forgewing_value_reading_proposals.sql` and the migrations after it hold the proposals.
  - The proposals are `non_authoritative`.
  - Using a proposal writes a `human_fact_assertions` row through `record_region_bound_human_fact_assertion`, and the proposal row is never mutated.
- **D5: decided. An append-only entitlement event table, not a column.** `20261004200000_organization_forgewing_entitlements.sql` holds the events. The latest event per organization wins; no event means not entitled. It is ANDed with the deployment kill switch (`lib/server/forgewingGates.ts`).
- **G11: answered in code, not in contracts.** `20261004210000_forgewing_data_policy_and_call_budget.sql` adds per-organization data-policy events, keyed per provider and content class.
  - Each event must cite the terms it rests on.
  - The default is deny, and nothing in the product grants approval.
  - Whether a given customer's terms permit sending content is still a business decision, recorded per organization through that ledger.
- **Phase B steps landed:**
  - B1, entitlement and gates;
  - B2, durable unresolved priced-page evidence;
  - B3, region-bound reviewed values with operator entry;
  - B4.1–B4.3, the data policy, call budgets, proposals and execution engine;
  - B5, the ResolutionCase read model and Resolution Workspace queue, with typed actions and the queue summary.
- **Still open:**
  - B4.6.1 qualification. Value reading stays inactive until a class qualifies; see `docs/runbooks/b461-qualification.md`.
  - B6, Validator explanations and narrative.
  - B7, missing-document detection beyond the `missing_document_or_link` case kind.
  - B8, improvement signals.
