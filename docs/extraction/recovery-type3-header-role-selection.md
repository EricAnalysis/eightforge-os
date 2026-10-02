# Recovery type 3: header role selection

Base: `261ebc1` (priced_schedule_reconstruction_v2). Local, evaluation-backed; no push or merge.

## What it does

A page whose table structure reconstructs but whose header semantics are unresolved (`semantic_status: 'unresolved'`) previously priced nothing, and recovery was explicitly disabled on it. An operator can now select one of the **qualifying `role_assignment` options the extractor already computed** in `header_interpretation.options`. A review selects a preserved option; it never authors a value or a role.

## Contract

- **Candidate** (`priced_schedule_header_role_selection`, `RecoveryCandidateV2.headerRoleSelection`).
  - One candidate per qualifying `role_assignment` option, generated only from a v2 reconstruction and only in the explicit proposal-generation pass.
  - Identity binds: document, artifact, page, page-representation digest, parser version, header-interpretation version, option id, the ordered label→role map, and the ordered header observation ids.
  - `structuralRowCount` is display-only and excluded from identity.
  - Out of scope: `label_grouping` options, `options_limit_exceeded`, failed-closed pages without structural columns, and legacy v1 records (reprocess first).
  - Existing types' candidate ids and digests are byte-identical.
- **Evidence.** Header refs of an unresolved interpretation become durable diagnostic observations. They are never accepted pricing refs by themselves.
- **Re-entry.** A confirmed selection applies only when the current v2 reconstruction reproduces the identical candidate (id and full closure), the page digest matches and coverage is trusted.
  - Otherwise the selection is withheld with a recovery diagnostic: `confirmed_recovery_evidence_changed` / `_unverifiable`, `confirmed_recovery_not_applied` (including `coverage_not_trusted`), `confirmed_recovery_unbound`, `ambiguous_recovery_confirmation` for more than one selection on a page, or the new `confirmed_header_option_not_offered`.
  - When applied, the page reconstructs with the selected role map and every normal admission rule runs unchanged, including ruling ownership, the R13.1 pricing-authority view and the `261ebc1` withheld-authority diagnostics. Other recovery types stay disabled on that page in the same pass.
- **Provenance.** `header_semantics: { status: 'human_selected', candidate_id, review_id }` is set on the page and every resulting row. It survives the pricing-authoritative view, the rate-schedule rows, contract pricing assembly and the canonical pricing adapter (as audit metadata, never read by a resolution rule). The original `header_interpretation` is preserved unchanged.
- **Forgewing.** Forgewing may only rank and explain the preserved options. A page with a single qualifying option gets a deterministic review envelope with no provider call (`provider_model: 'deterministic_header_options'`, certainty 0), so review never depends on AI.
- **Persistence.** One additive migration, `20261002190502_recovery_header_role_selection.sql`.
  - It widens the proposal and generation-outcome type checks.
  - It adds `is_valid_header_role_recovery_candidate` closure validation.
  - It replaces `record_forgewing_recovery_proposal_v2` with a body identical to Phase 14 apart from the new-type branches and the deterministic-envelope check.
  - Reviews reuse `confirmed_candidate_id`. The append-only triggers are untouched.

## Activation

The type ships **`synthetic_qualified` with a `disabled` ceiling**, matching the multi-observation cluster V2 precedent. It generates no candidates in any deployment until a reviewed qualification change in `recoveryOperationalPolicy.ts` (see `docs/runbooks/forgewing-recovery-activation.md`). Requesting it through the V2 gate emits `unqualified_activation_requested` (`recovery_v2_gate`).

The Phase 17 contract pins for the task, candidate, durable proposal, planner and policy sources were updated because those files gained the type. The prompt, output schema and request-builder digests are unchanged, and continuation candidate ids and digests are byte-identical.

## Verification

- **No confirmation** (`scripts/evaluation/e3/verify-header-role-selection.ts`, baseline captured at `261ebc1`): all four pages' reconstruction, pricing and `spacing_only` output byte-identical; both prediction runs byte-identical. E3 510/583, 87/116, 58 pricing rows.
- **Hillsdale p3, evaluation-only confirmation** (real source PDF, original scale-2 OCR, production observation identities):
  - Candidate: one qualifying option ("Equipment Description" → description, Unit → unit, Unit Price → rate).
  - Pricing rows: **0 → 39**. Rate mismatches against E3 truth: **0** (numeric and raw).
  - Still withheld: the `CAT D6 Dozer Hour [$320.00` line (`ambiguous_row_assignment`; truth cell `c-0039`). Correct: its rate is damaged OCR and needs the separate attested-value / re-OCR path.
  - Every priced row carries the `human_selected` receipt. Header evidence is durable. The original interpretation is unchanged.
- **Tests:** focused extraction, evaluation, contracts, canonical, server, diagnostics, Forgewing and component suites, 3,638 passed. The one failure is the pre-existing CRLF `goldenTransactionFixtureManifest` test. `tsc --noEmit`, `npm run build` and `git diff --check` pass.

## Not verified here

- The migration was reviewed statically but not applied: the local Supabase stack needs Docker, which is not running.
- The `RecoveryReviewPanel` changes have not been exercised in a browser against live review data.
