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
- **Persistence.** One additive migration, `20261004120000_recovery_header_role_selection.sql`.
  - It widens the proposal and generation-outcome type checks.
  - It adds `is_valid_header_role_recovery_candidate` closure validation.
  - It replaces `record_forgewing_recovery_proposal_v2` with a body identical to Phase 14 apart from the new-type branches and the deterministic-envelope check.
  - Reviews reuse `confirmed_candidate_id`. The append-only triggers are untouched.

## Activation

**Qualified 2026-10-03: `corpus_qualified`, ceiling `controlled`** (explicit decision, after the activation gate below). Behaviour is the same as continuation attribution:

- Candidates are generated and proposals scheduled only when both `FORGEWING_SHADOW_ENABLED=1` and `FORGEWING_EXTRACTION_RECOVERY_V2_ENABLED=1`.
- Human review remains mandatory, and `enabled` stays reserved for `production_qualified`.
- With both gates off (the default), nothing changes.

**Deployment order matters.** Apply `20261004120000_recovery_header_role_selection.sql` (the corrected version from `be629b1`) to the target database **before** turning the gates on. Otherwise the proposal RPC rejects the new type: each attempt is recorded as a failed generation outcome, nothing is persisted, and pricing is unaffected.

**Pricing still needs the document's pricing scope to be authoritative.** Selecting a header resolves semantics only. Rows price once operator rate-schedule pages make the pricing source scope authoritative (see the UI gate below).

Phase 17 pins: the task, candidate, durable-proposal, planner and policy source digests moved when the type was added (2026-10-02), and the policy digest moved again at qualification. The prompt, output schema and request-builder digests are unchanged, and continuation candidate ids and digests are byte-identical.

## Verification

- **No confirmation** (`scripts/evaluation/e3/verify-header-role-selection.ts`, baseline captured at `261ebc1`): all four pages' reconstruction, pricing and `spacing_only` output byte-identical; both prediction runs byte-identical. E3 510/583, 87/116, 58 pricing rows.
- **Hillsdale p3, evaluation-only confirmation** (real source PDF, original scale-2 OCR, production observation identities):
  - Candidate: one qualifying option ("Equipment Description" → description, Unit → unit, Unit Price → rate).
  - Pricing rows: **0 → 39**. Rate mismatches against E3 truth: **0** (numeric and raw).
  - Still withheld: the `CAT D6 Dozer Hour [$320.00` line (`ambiguous_row_assignment`; truth cell `c-0039`). Correct: its rate is damaged OCR and needs the separate attested-value / re-OCR path.
  - Every priced row carries the `human_selected` receipt. Header evidence is durable. The original interpretation is unchanged.
- **Tests:** focused extraction, evaluation, contracts, canonical, server, diagnostics, Forgewing and component suites, 3,638 passed. The one failure is the pre-existing CRLF `goldenTransactionFixtureManifest` test. `tsc --noEmit`, `npm run build` and `git diff --check` pass.

## Activation gate (2026-10-02)

Docker (and so the local Supabase stack) is not installed on the verification machine. The database gate instead ran on a throwaway local **PostgreSQL 18.4** (WSL) carrying all 109 prior repo migrations plus a minimal Supabase platform shim: `anon`/`authenticated`/`service_role` roles, `auth.uid()`/`auth.role()`/`auth.users`, and `pgcrypto` in `extensions`. Writes went through the real application functions (`persistForgewingRecoveryProposalV2`, `recordForgewingRecoveryProposalReview`) as `service_role`. Reads went through the real resolvers (`resolveEffectiveRecoveryConfirmations`, `loadConfirmedRecoverySelections`, `readRecoveryReviewQueue`). The harness is gitignored (`.benchmark-workspace/_type3_db_roundtrip.ts`). Nothing touched a remote database.

**Defect found and fixed:** the validator's `flattened_ids || label->'orderedObservationIds'` parsed as `(flattened_ids || label) -> ...` (shared operator precedence), so it yielded NULL and **rejected every genuine header candidate**. It is now parenthesized. Unit tests could not catch this because they mock the RPC. The RPC also now refuses a `headerRoleSelection` payload on any other recovery type. The migration was corrected in place; it had never been applied to a shared database.

Results, all 25 checks passing:

- **Migration.** Applies cleanly on top of pre-existing proposal/review rows. The schema diff is limited to the four widened constraints, the new validator function and the extended RPC body; no table, column or data is dropped.
- **Existing types.** A pre-migration continuation confirmation still resolves after the migration, and a new continuation proposal is still writable.
- **Header persistence.**
  - The real Hillsdale candidate (exactly the one preserved qualifying option) persists through the deterministic envelope, and replay is idempotent.
  - The database refuses a label text that differs from its cited evidence, a duplicate description role, a missing rate role, a dishonest deterministic envelope, a header payload on another type, and acceptance of a candidate the proposal never offered.
- **Reviews.** Defer, accept (stores the candidate id and review id; review v2) and reject (confirms nothing) all record. UPDATE and DELETE on reviews and proposals are refused ("forgewing recovery records are immutable").
- **Reprocess from stored confirmations.**
  - The resolver returns the header selection with the stored review id; continuation confirmations stay on their own channel.
  - Hillsdale pricing rows go 0 → 39, the Dozer line stays withheld, and every recovered row carries `human_selected` with the stored review id.
  - The original interpretation is preserved and there are no recovery diagnostics.
- **Review read model** (`readRecoveryReviewQueue` on the stored rows):
  - Deterministic proposal: `recommendationAvailable: false`, state `accepted_awaiting_reprocess`.
  - Advisory proposal: `rejected`.
  - Only the preserved option is selectable (3 labels, 39 rows, 5 evidence boxes).
  - The panel submits only a disposition, a candidate id and a required rationale; there is no value or role input.

## UI and end-to-end gate (2026-10-03)

**Setup.** A local Supabase stack (Docker Desktop; Postgres 17.6, Auth, REST, Storage, gateway) in a scratch project outside the repo. **All 110 migrations apply on the real Supabase image.** The Next dev server ran from this worktree, which has no `.env` files, with only local-stack settings, so production was unreachable. A generated test reviewer was used. Hillsdale went through the real `/api/documents/upload` and `/api/documents/process` routes, including OCR. The full document has two semantically unresolved pages: p2 "Personnel Description" (10 rows) and p3 "Equipment Description" (39 rows).

The type remains `disabled`, so the scheduler does not generate proposals. The deterministic proposal envelope was therefore built from the **persisted** extraction (`buildHeaderRoleSelectionCandidates` with the persisted observation digests) and saved with the application's own `persistForgewingRecoveryProposalV2`. The policy was not changed.

**Browser results** (`RecoveryReviewPanel` in the document page):

- Both proposals render as "Header semantics withheld — select a preserved role assignment", labelled "No Forgewing recommendation. This option was preserved by the extractor."
- Each offers exactly one radio option (label → role map plus structural row count), a required rationale, and Confirm / Reject / Defer. There is no value or role input.
- "View source" renders the stored Hillsdale page with header-token highlight boxes ("Member 1 of 5").
- Page 2 rejected: shown as "rejected · review v1"; it stays withheld.
- Page 3 deferred, then accepted: "accepted · review v2 · confirmed selection recorded".
- The panel's Reprocess run produced an extraction where p3 is `resolved` with `header_semantics: human_selected` (the stored review id and candidate id), with no recovery diagnostics. P2 stays unresolved.

**Pricing through the real product pipeline.**

- With machine-detected rate pages only, the pricing source scope is `provisional` (authoritative pages `[]`), so `rate_schedule_rows` is empty. This is a separate, pre-existing authority gate, working as designed.
- After operator upload guidance (rate schedule on pages 2–3, through `/api/documents/[id]/upload-guidance`) and a recovery reprocess, the scope is `authoritative [2, 3]`. The contract analysis then carries **39 `page_priced_schedule` rows, all from p3, every one `human_selected` with the single stored review id**. P2 contributes 0 rows and the CAT D6 Dozer row stays withheld; rates are correct (for example, JD 544 Wheel Loader at $250/Hour).

**Defect fixed (pre-existing, all recovery types).** The panel treated `deferred` as closed and hid the review form, so a deferred proposal could never be decided in the UI, even though reviews are versioned and the latest is effective. The decision-state rule now lives in the client-safe `lib/recovery/recoveryReviewDecision.ts`, with a test: pending and deferred stay open; accepted, rejected and ambiguous are closed.

**Findings recorded, not fixed (out of scope).**

- *Migrations do not fully reproduce the production schema.* `document-diagnostics` returns 500 because it selects `documents.updated_at`, which no migration creates. The field-level `document_extractions` upsert writes `data` null against the migration's NOT NULL constraint. Both occur before any recovery action.
- *A slow storage response blocks a recovery reprocess, fail-closed.* The storage-identity capture has a 1-second bound. When it timed out on the local stack, processing found no artifact identity, refused with "No effective recovery confirmation was available", and succeeded on retry.
- *No "applied" review state.* By design the read model never marks an accepted proposal as consumed, so the panel keeps showing "Confirmed — reprocessing required" after a successful reprocess. This applies to every recovery type.
- `recoveryReviewBoundaries.test.ts` failed intermittently (two different cases) while Docker and the dev server were loading the machine. It passed alone and on three further combined runs.

## Not verified here

- Production deployment and the remote database: deliberately untouched.
