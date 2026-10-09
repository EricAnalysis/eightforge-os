# B4.4 Resolution Workspace qualification

B4.4 exposes existing B4.3 value readings through the B5 Resolution Workspace. A reading remains an unverified suggestion. Only an explicit operator submission through B3 `human_fact_assertions` creates truth. This implementation starts from `main` at B4.3 merge `3948a26`; Claude's uncommitted cloud patch was unavailable and was not reconstructed.

## Behavior and authority

- The server enriches an already-derived Core unreadable case only when Forgewing entitlement and exact source evidence allow it. Core manual entry remains available without a Forgewing area.
- Ask requests use authenticated actor context and a freshly derived case. The browser cannot supply evidence, provider configuration, activation overrides, or an invented action.
- A current pending reading appears beside an empty operator form. Use copies the complete rate row locally; selection and B5-C preview do not write truth. Edits preserve the selected proposal citation.
- Reject and Defer append existing non-authoritative review history, keep the case open, and remove the reading from future offers. The review request pins the proposal ID and digest the operator actually saw.
- Stale/conflicting decisions clear the draft and citation. Changed source, assertion-chain head, entitlement, or proposal identity also invalidates the draft.
- B5-C preview uses only the operator's proposed value and the existing Validator. B3 derives approved versus modified proposal origin on the server. No generic approval route or second truth writer was added.

## Surgical defect reconciliation

The deployed B3 function allowed a rejected/deferred reading to be cited for a new assertion. The PostgreSQL probe reinstalls that exact deployed function inside a rollback transaction and demonstrates both promotions; rollback removes the temporary assertions and restores the corrected function. The new forward migration adds the disposition guard and serializes citation and review on the existing proposal row. Two-session tests cover reject-first, defer-first, legacy-review-first, and promotion-first ordering. Existing assertions and their exact retries survive a later disposition. Manual entry retains its existing path.

The B4.3 engine also replayed an actor/request key against a different case or a changed page digest. Both regressions failed against the original `3948a26` engine before correction. Replay now compares the current case and stored document/artifact/page/digest/anchor binding and refuses a collision. Existing outcome columns supply the binding; no schema change was required.

Source/dataflow inspection established that the new review route initially needed a proposal pin: rederiving only the case could apply Reject/Defer to a newly arrived proposal that the operator had never seen. The route now compares the client-observed proposal ID/digest with the freshly offered action. The corrected-route regression rejects replacement proposals with HTTP 409 and no review write; no executable failing-before-fix route test was run.

`20261004230000_forgewing_value_reading_outcomes.sql` and the deployed B4.2 migration are unchanged. Architecture tests pin their Git-content hashes. The only new migration is `20261005004024_forgewing_value_reading_disposition_guard.sql`; it replaces existing functions without new tables, columns, grants, or historical-data rewrites. Deploy this migration before the B4.4 workspace. Restoring the old functions would reopen the defect.

## Verification

Qualification completed on 2026-10-04/05:

- Focused backend/dispatcher/UI/authority tests passed, including 12 route tests and the final 27-test UI/dispatcher/boundary slice.
- Full Vitest: 469 files passed, 15 existing files skipped; 5,705 tests passed, 92 skipped. Architecture checks are included. Skipped external corpus/actual-checkout gates are coverage limits, not evidence of parity.
- TypeScript, changed-file ESLint, final production build, and whitespace checks passed. The build retains two existing `pdfjs-dist` externalization warnings.
- Fresh disposable PostgreSQL replay: all 120 migrations passed, including B3/B4.2/B4.3 qualifications, deployed-function defect reproduction in rollback, and observed two-session B4.4 serialization. The disposable database was removed afterward.
- Final browser gate: all 12 scenarios passed, with no browser errors, provider calls, or database calls.
- Independent source review found no authority expansion. Its monetary-precision finding was corrected only in the suggestion formatter, with exact display/selected-draft regressions and another browser run.

The first Windows architecture attempt was interrupted under execution contention; it was not a clean pass. An initial Linux source-only copy failed five files because Python/Git metadata were absent and copied fixture line endings differed. All five passed in the successful native Linux Git checkout, with local Python/PyMuPDF and the same final patch. No tests or unrelated production behavior were changed to remove that environment noise. The native checkout's final component/test bytes match the Windows worktree.

Reproduce with:

```text
npx vitest run lib/server/valueReadingEngine.test.ts lib/server/valueReadingWorkspace.test.ts lib/server/valueReadingWorkspaceRoutes.test.ts lib/server/resolutionQueueRead.test.ts lib/resolution/valueReadingLifecycle.test.ts lib/resolution/resolutionActionRequest.test.ts components/resolution/ResolutionWorkspace.test.tsx lib/architecture/valueReadingDispositionGuard.test.ts lib/architecture/valueReadingWorkspaceBoundaries.test.ts lib/architecture/forgewingValueReadingBoundaries.test.ts lib/architecture/resolutionWorkspaceBoundaries.test.ts
npx vitest run --maxWorkers=2 --testTimeout=120000 --hookTimeout=120000
npx tsc --noEmit
npx eslint <changed TypeScript and TSX files>
npm run build
STEP0_REPLAY_DATABASE_URL=<disposable PostgreSQL URL> bash scripts/verify-step0-migration-replay.sh
npx vite-node --config vitest.config.ts scripts/evaluation/b44/run.ts
git diff --check
```

The browser gate runs the actual workspace and reviewed-values panel with synthetic fixture transport and the real B5-C Validator. Its 12 scenarios include monetary display, Ask, explicit Use, unchanged/edited cited submission, reviewed-value visibility, Reject/Defer, stale refresh, failure outcomes, and Core manual entry. The fixture retains three findings/blockers before and after its preview; no invoice-clearance claim is made. Browser transport does not prove database persistence, production PDF rendering, provider behavior, or activation. Separate SQL and backend gates cover persistence and authority.

## Remaining B4.5 work

Real region rendering and image-provider integration, exact rendered-byte digest binding before transmission, production data-policy/activation qualification, and live operational qualification remain B4.5 work. No real provider was called, customer data transmitted, production database used, or production capability activated for B4.4.
