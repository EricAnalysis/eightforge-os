# Overview render-stall profile — 2026-07-09

## Verdict

**Blocked — no live timing, invocation, first-paint, or flame-chart capture is valid.** The authenticated project route could not be reached in either browser run: it redirected to `/login`, and the workspace contains neither `tests/.auth/user.json` nor `.env.test.local` credentials. No credentials were guessed or created.

The temporary probes were added, type-checked, and removed. This report records the measurements that could be made read-only, the exact capture gap, and static hot-path evidence. It must not be read as proof that any candidate below is the measured stall.

## Method and available evidence

- Added and later removed `TEMP-PROFILE-0709` probes around every requested workspace fetch/transform group, `buildProjectOverviewModel`, `resolveProjectIssueObjects` (including its three construction loops), truth sections, overview briefing, and first `ProjectOverview` paint. Each probe logged `performance.now()` duration, invocation count, and input cardinalities.
- `npx tsc --noEmit --pretty false` passed while the probes were present.
- The headed development-browser route and the production-browser route both redirected to `/login` before `useProjectWorkspaceData` ran; therefore their console contained no probe records.
- Read-only database counts were obtained with the configured service role. No data was written.
- `npm run build` ran beyond the 124-second command window and left partial output. It was not a usable production build: `next start` failed with `ENOENT` for `.next/prerender-manifest.json`.

Small-project comparator selected: **MVSU** (`22d51a76-79d8-4026-81bf-d78c0266c489`): 0 transaction rows, 1 open finding, 0 execution items. Golden currently has 5,063 transaction rows, 8 open findings, 15 matching evidence rows, 339 execution items, 6 decisions, and 1,613 project-scoped activity rows. The hook caps its merged activity result at 150 rows.

## 1. Timing table

### Development build

| Stage | Golden ms | Small-project ms | Ratio | Invocation count (dev) |
|---|---:|---:|---:|---:|
| Initial workspace fetch group | Not captured (login redirect) | Not captured | N/A | N/A |
| Transaction-row attachment transform | Not captured | Not captured | N/A | N/A |
| Document-review fetch | Not captured | Not captured | N/A | N/A |
| Decisions/tasks fetch and transforms | Not captured | Not captured | N/A | N/A |
| Validation-evidence fetch | Not captured | Not captured | N/A | N/A |
| Audit fetch and transform | Not captured | Not captured | N/A | N/A |
| Final workspace state commit | Not captured | Not captured | N/A | N/A |
| `buildProjectOverviewModel` | Not captured | Not captured | N/A | N/A |
| `resolveProjectIssueObjects` and its subloops | Not captured | Not captured | N/A | N/A |
| `resolveCanonicalProjectTruthSections` | Not captured | Not captured | N/A | N/A |
| `resolveCanonicalProjectOverviewBriefing` | Not captured | Not captured | N/A | N/A |
| First `ProjectOverview` paint | Not captured | Not captured | N/A | N/A |

### Production build

| Stage | Golden ms | Small-project ms | Ratio | Invocation count |
|---|---:|---:|---:|---:|
| All requested stages | Not captured — the generated build was incomplete and `next start` could not open `.next/prerender-manifest.json`. | Not captured | N/A | N/A |

## 2. Named culprits and algorithmic evidence

No browser Performance flame chart exists for the target page, so there are **no measured self-time leaders** and no proven single culprit. The following are ranked static candidates to confirm with the already-designed probe and a flame chart after authentication is supplied.

1. **Repeated Golden-sized transaction normalization — high-confidence hot-path candidate.** `lib/projectFacts.ts:2941` (`buildCanonicalTransactionSummaryFromRows`) normalizes every row and constructs several aggregate/grouping projections. `resolveTransactionTruthRows` invokes it through `readProjectRowBackedTransactionSummary` at `lib/projectFacts.ts:3704`. The overview calls truth sections directly at `components/projects/ProjectOverview.tsx:1416`, then calls briefing at `:1425`; briefing itself calls truth sections again at `lib/projectFacts.ts:3977`. Thus, on the default Overview render, the 5,063 transaction rows are fully normalized at least twice before considering rerenders. This is a synchronous CPU transform, not a fetch, and directly matches the Golden-versus-MVSU payload contrast.

2. **Execution-backed audit-chain sweep — high-confidence quadratic candidate.** In `lib/resolveProjectIssueObjects.ts:699-704`, each execution item not represented by a finding becomes an execution-backed issue. Its builder filters every activity event (`:524-526`). Read-only counts show only 5 of Golden's 339 execution items match its 8 open findings by validator source, leaving up to 334 execution-backed issues. With the hook's 150-event cap, that is up to **334 × 150 = 50,100** `eventMatchesIssue` evaluations per resolver invocation, plus sorting of each resulting chain. The exact realized count requires the live probe/flame chart.

3. **Finding-to-related-record linear scans — verified shape, smaller current input.** The finding loop at `lib/resolveProjectIssueObjects.ts:637-656` scans decisions, execution items, evidence, and activity rows per finding. Golden's current upper-bound work is 8 × 339 = **2,712** execution comparisons, 8 × 150 = **1,200** activity-event predicates, and 8 × 15 = **120** evidence predicates. The subsequent execution filtering adds 339 × 8 = **2,712** finding checks (`:699-702`). This is O(n×m), but is less likely than candidate 1 or the 50,100-event execution path at current cardinalities.

The immediate render path has no direct `structuredClone` or deep-equality sweep. `JSON.stringify` is present in `lib/projectFacts.ts:2852` only for object deduplication and in `components/projects/ProjectOverview.tsx:1206` for the pre-existing shadow-mismatch POST effect; neither is flame-chart-proven as the stall. The latter is after commit and was already cleared by the supplied bisection context.

### Memo/dependency stability

`issueObjects` is memoized at `components/projects/ProjectOverview.tsx:1166-1184` with state arrays and `model.project.id` as dependencies. The overview model is memoized at `app/platform/projects/[id]/page.tsx:18-35` with the corresponding workspace arrays. The workspace hook stores those arrays in React state and writes them once in its final load block (`lib/useProjectWorkspaceData.ts:711-724`), so static inspection found no newly allocated array/object dependency in either dependency list that would itself force an N-times recomputation. The live invocation counters remain required to distinguish expected development StrictMode 2× behavior from a real N× loop.

## 3. Dev-versus-production verdict

**Unknown.** A real user's Golden Project experience was not measured. Development could not pass authentication, and the attempted production server could not start from the incomplete build output. It would be inaccurate to call this dev-only, production-acceptable, or production-broken.

## 4. Proposed fix directions — not implemented

1. **Highest impact / low-to-medium effort:** build the row-backed transaction summary once per workspace payload and pass/reuse it for both truth sections and briefing. This changes the default overview path from two 5,063-row normalizations to one O(n) normalization plus O(1) reuse; preserve the canonical summary and evidence fields unchanged.
2. **High impact / medium effort:** index issue relationships before constructing issue objects: `Map<findingId, evidence[]>`, `Map<findingId, executionItem>`, `Map<findingId, activity[]>`, plus decision/execution-ID maps. This turns the per-issue scans into one O(e + a + x + d) indexing pass followed by O(1) lookups, eliminating the roughly 50,100 execution-backed event predicates.
3. **Medium impact / low effort:** memoize `truthDocuments` and the truth/briefing derived data together, keyed by stable workspace arrays, only after the counter confirms avoidable rerenders. Do not cache across project mutations without explicit invalidation.
4. **Medium impact / medium effort:** keep heavy transaction projection off the first interactive render (for example a precomputed canonical row-backed summary from the already-loaded data, or a deferred non-critical section). Validate that the first Overview paint retains canonical truth and evidence labels.

## 5. Part 2 closure evidence

**Blocked.** The Validator Findings, Overview Required Reviews, Decision & Execution panels, and M6 page-load-to-interactive number could not be captured because authenticated browser rendering was unavailable.

## 6. Instrumentation removal and worktree state

Code search (excluding this audit) found no remaining `TEMP-PROFILE-0709` tag or `tempProfile0709` file/import. All temporary source instrumentation and browser artifacts were removed.

`git status --short` is **not clean**, but it was already not clean before this investigation: it contains pre-existing modifications to `components/projects/ProjectOverview.tsx`, `lib/resolveProjectIssueObjects.test.ts`, `lib/resolveProjectIssueObjects.ts`, `lib/stateProjectionShadow.ts`, plus the pre-existing untracked API/audit paths. The only new intended artifact from this task is this required audit document. No existing user change was reverted, staged, or committed.
