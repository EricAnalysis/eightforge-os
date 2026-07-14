# Overview Hang And Suite Triage - 2026-07-09

Read-only audit. No application code, tests, migrations, or data were changed.

## Part 1 - ProjectOverview Load Hang

Verdict: pre-existing. The hang/repro is not caused by the shadow-mismatch flush or the read-path gate fix.

Current working tree on `http://localhost:3000/platform/projects/437502f2-d46d-447f-81e3-f26fa7ba0c14`:

- Authenticated Chrome profile reached the project route.
- Supabase traffic completed: 32 successful Supabase responses and 3 expected 400 schema/fallback responses.
- Pending network requests after the observation window: 0.
- POSTs to `/api/projects/[id]/shadow-mismatches`: 0.
- Resolver/shadow console logs: 0.
- Workspace load completed: `[EightForge] workspace total load: 15154.9ms`.
- After the workspace completed, `body.innerText` timed out after 5s, indicating browser/main-thread render nonresponsiveness rather than a pending fetch.

Clean baseline comparison:

- I created a temp worktree at `HEAD` (`284bf04`), before the uncommitted shadow-flush/read-path-gate changes in this working tree.
- The same route/profile on port 3000 reproduced the same symptom: 32 successful Supabase responses, 3 expected 400 fallback responses, 0 pending requests, and `body.innerText` timing out after the workspace load completed.
- The first temp baseline run under Turbopack hit a Next/Turbopack write panic in the temp worktree, so I reran the baseline under `next dev --webpack`; the webpack baseline reached app code and reproduced the same post-load nonresponsiveness.

Recent-change clearance:

- Shadow flush is cleared: current run fired 0 shadow-mismatch POSTs, so the new `ProjectOverview.tsx` flush effect was not the hang source.
- Read-path gate is cleared: clean baseline without the gate reproduced the same post-load nonresponsiveness.

Blocking call:

- There is no Supabase request or internal API request that remains pending.
- The observed handoff is: `lib/useProjectWorkspaceData.ts:711-724` sets the loaded workspace state and `setLoading(false)` after all fetches/fallbacks complete; then `app/platform/projects/[id]/page.tsx:18-29` builds the overview model and `app/platform/projects/[id]/page.tsx:78-103` renders `ProjectOverview`.
- The render path immediately runs truth/briefing assembly in `components/projects/ProjectOverview.tsx:1402-1434` and renders the overview surface. With Golden's large workspace payload, the page becomes nonresponsive before Playwright can read body text.
- Therefore the ProjectOverview symptom is a client render/main-thread stall after successful data load, not a never-settling workspace promise.

Schema fallback findings:

- `projects.validation_phase` is absent in the live schema. The initial query at `lib/useProjectWorkspaceData.ts:390-395` returns 400, then fallback query at `lib/useProjectWorkspaceData.ts:455-460` returns 200.
- Document precedence columns are absent. The initial documents query at `lib/useProjectWorkspaceData.ts:396-403` returns 400, then the legacy fallback at `lib/useProjectWorkspaceData.ts:470-478` returns 200.
- The activity-events fallback query at `lib/projectActivityEvents.ts:95-105` returns 400, but it is handled as a non-core load issue and the workspace still logs completion.
- M4 is real schema drift, but in this run the `validation_phase` fallback did not hang. It settled and is not the blocking call.

## Part 2 - UI Verification Gap

Status: blocked by the pre-existing ProjectOverview render/main-thread stall.

What was verified:

- Rendering Golden Project on the current working tree fired no POST to `/api/projects/[id]/shadow-mismatches`.
- The shared route always builds the overview model before rendering any hash tab. `#project-validator` cannot bypass the stall because the same `app/platform/projects/[id]/page.tsx` path builds `model` first.
- There is no separate validator project route; `app/platform/workspace/projects/[id]/page.tsx` redirects back to `/platform/projects/[id]#project-validator`.

What remains unverifiable in-browser without an application-code workaround:

- Screenshot of Validator Findings showing the five known `FINANCIAL_RATE_CODE_MISSING` findings as open.
- Screenshot of Overview Required Reviews showing 8.
- Screenshot/confirmation of the Decision & Execution panel showing stale execution item context without resolving the issue.

Shadow mismatch count:

- REST count against `state_projection_shadow_mismatches` failed with `403 permission denied for table state_projection_shadow_mismatches`.
- Direct Postgres via `DATABASE_URL` failed first with `getaddrinfo ENOTFOUND db.jpzeckefppmiujwajgvk.supabase.co`; resolving the AAAA record and forcing that address failed with `ENETUNREACH`.
- Result: the requested live count was not observable from this session. The prior confirmed fact remains 5, but this audit did not independently re-count it.

## Part 3 - Standing Test Failure Inventory

Command run once: `npx vitest run`.

Result: 8 failed files, 9 failed tests; 143 files passed, 1289 tests passed.

CI evidence:

- `.github/workflows` contains `ask-phase3-diagnostic.yml` and `migration-fresh-replay.yml`.
- There is no workflow that runs full `npx vitest run`.
- PR #33 (`ci: add migration fresh replay check`) check rollup showed Vercel, Supabase Preview skipped, and Vercel Preview Comments; it did not show a full Vitest run.
- Later `migration-fresh-replay.yml` runs are green, but that workflow only replays migrations and does not execute this test suite.

| Test file | Failure mode | First actual error line | Live DB/network? | Last plausible pass / history | Classification | Recommendation |
|---|---|---|---|---|---|---|
| `lib/decisionContext.test.ts` | Assertion | `Expected values to be strictly equal: + 'Needs Review' - 'Not Evaluated'` | Isolated | Test line uses `decisionStatus: 'suppressed'`; `lib/decisionContext.ts` last relevant change includes `7459abb fix: replace decisions 'suppressed' status with 'dismissed' to match live CHECK constraint`. | Recent identifiable stale expectation | Fix test/status fixture to the current `dismissed` model, or adjust code only if `suppressed` must still be accepted as legacy input. |
| `lib/projectDocumentsSurfaceBoundary.test.ts` | Assertion, 2 failures | `Decision Impact` present; `Key Extracted Facts should not be in ProjectDocumentsForge` | Isolated source-text test | Test authored in `5d29368`; subject files later changed in `118e647 Fold Facts tab into Documents`, `84668dd Consolidate Validator and Decisions`, and `639829a Unify Overview's Required Reviews count...`. | Recent/intentional product change made boundary test obsolete | Delete or rewrite as a current surface-boundary test; do not keep string bans that contradict the Four-Surface consolidation. |
| `lib/pipeline/processDocument.test.ts` | Timeout | `Error: Test timed out in 5000ms.` | Isolated/mocked | Test from `f5a7839`; subject `lib/pipeline/processDocument.ts` last changed in `9762648`. No full-suite CI evidence. | Long-standing or recently exposed mock/import rot | Fix the mocked import harness; quarantine with explicit ticket only if it blocks unrelated CI work. |
| `lib/server/documentExtraction.pdfFallbackGate.test.ts` | Timeout | `Error: Test timed out in 5000ms.` | Isolated/mocked PDF/OCR dependencies | Test from `f5a7839`; subject `lib/server/documentExtraction.ts` recently changed in `c544f75`, `31a7e3c`, `a289d2a`, `0c0f168`. | Recent identifiable PDF/OCR path drift likely | Fix the mocked PDF/OCR path so it cannot enter a real or unresolved fallback branch. |
| `lib/server/intelligencePersistence.invoice.test.ts` | Timeout | `Error: Test timed out in 5000ms.` | Isolated/mocked | Test from `2f352dd` with updates in `9762648`; subject `lib/server/intelligencePersistence.ts` recently changed in `5870b0a` and `7459abb`. | Recent/unknown persistence import-path rot | Fix the persistence test harness or module-level async dependency; keep the test if canonical invoice persistence remains active. |
| `lib/server/intelligencePersistence.support.test.ts` | Timeout | `Error: Test timed out in 5000ms.` | Isolated/mocked | Test from `2f352dd` with updates in `9762648`; subject `lib/server/intelligencePersistence.ts` recently changed in `5870b0a` and `7459abb`. | Recent/unknown persistence import-path rot | Fix alongside the invoice/transaction persistence timeout group. |
| `lib/server/intelligencePersistence.transactionData.test.ts` | Timeout | `Error: Test timed out in 5000ms.` | Isolated/mocked | Test from `f5a7839` with updates in `9762648`; subject `lib/server/intelligencePersistence.ts` recently changed in `5870b0a` and `7459abb`. | Recent/unknown persistence import-path rot | Fix alongside the invoice/support persistence timeout group. |
| `lib/ai/instructor/instructorAssist.test.ts` | Assertion | `expected 'fallback' to be 'instructor' // Object.is equality` | Isolated/mocked | Test from `f5a7839`; subject `lib/ai/instructor/classifyDocumentFamily.ts` changed in `d4ea374 Disable model-assisted classification and simplify validator actions`. | Recent identifiable intentional behavior change | Update/delete the instructor retry expectation if model-assisted classification is intentionally disabled; otherwise restore the retry path deliberately. |

Overall suite verdict: red, but not because of live database/network availability. All failing files are isolated/mocked or source-text tests.

## Proposed Follow-Up - Not Implemented

1. Treat the ProjectOverview load issue as a performance/render investigation, not a data-load fallback bug. Add timing/profiling around `buildProjectOverviewModel`, `resolveCanonicalProjectTruthSections`, `resolveCanonicalProjectOverviewBriefing`, and the first `ProjectOverview` render with Golden-sized data.
2. Add a non-UI verification harness for the read-path gate that renders `ValidatorTab` or consumes `resolveProjectIssueObjects` directly, so lifecycle verification is not blocked by the full overview render.
3. Restore a CI lane that runs full Vitest or an intentional quarantined subset, because PR #33/fresh-replay does not cover the current red suite.
