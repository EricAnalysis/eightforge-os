# Production Golden first-load decomposition — 2026-07-15

## Verdict

**Pass with concerns.** This was a read-only, production-build investigation on updated `main` at `c280414` (PR #64 merged). Three independent, fresh-browser-context Golden runs completed on `next start`; no dev measurement is used for any accounting below.

The measured Golden median was **22,173.9ms** to the first Overview paint. That is lower than the supplied 39.90s baseline, so it should not be read as a new release claim: local server/browser and live-service variance changed the absolute wall time. The decomposition is still decisive: the single canonical 5,063-row normalization is the largest production stage at **10,902.5ms** (49.2% of the median wall time), and the paginated transaction-row fetch is second at **8,252.8ms** (37.2%).

Fresh production builds were completed after deleting `.next` (205.8s for the final instrumented build), and `next start` returned HTTP 200 from `/login` before measurement. The documented ordinary-viewer harness was reseeded and authenticated; its seed verified a browser-equivalent Golden RLS read.

## Method

Temporary `TEMP-PROFILE-0715` probes were gated by an explicit query string and emitted tagged structured console records in the optimized production bundle. They measured the workspace dependency groups, compatibility fallbacks, canonical normalization, overview model, issue loops, truth/briefing, commit/paint, and Validator transition. Each Golden run used a new browser context from the documented durable auth state. Every runner phase had a 300,000ms timeout.

For the Supabase calls, browser resource timing exposed delivery duration (`responseEnd - startTime`) but not TTFB: cross-origin resource entries had `responseStart = 0`, indicating no Timing-Allow-Origin visibility. Thus “network” below means observed browser delivery wait; the remainder of each measured group is client-side promise resolution/parse/transform. The same-origin project-page request did expose TTFB.

### Project page request (not additive to the stage table)

| Metric | Run 1 | Run 2 | Run 3 | Median | MVSU |
|---|---:|---:|---:|---:|---:|
| Page TTFB | 47.4 | 63.5 | 71.7 | 63.5 | 16.5 |
| Page payload delivery after TTFB | 19.3 | 10.6 | 29.6 | 19.3 | 5.7 |

The project document itself is not a server-side bottleneck in these runs. “Navigation/bootstrap” in the main table includes this request plus hydration and authentication settling, so it is deliberately not double-counted.

## Production stage table

All values are milliseconds. The raw run columns sum to the observed wall clock; the median components sum to 23,224.2ms (104.7% of the 22,173.9ms wall-clock median) because each independent stage median can come from a different run. That is a median-property difference, not unattributed work. The explicit residual is 0.02–0.05% per raw run, well below the 15% closure threshold.

| Stage | Run 1 | Run 2 | Run 3 | Median ms | % of total | MVSU ms | Ratio |
|---|---:|---:|---:|---:|---:|---:|---:|
| Navigation/bootstrap to workspace start | 1,977.4 | 1,162.2 | 1,281.9 | 1,281.9 | 5.8% | 1,063.5 | 1.21x |
| Workspace stage 1 fetch group | 9,626.3 | 6,598.1 | 8,252.8 | 8,252.8 | 37.2% | 172.6 | 47.8x |
| `projects` schema-compatibility fallback | 476.1 | 493.0 | 427.0 | 476.1 | 2.1% | 160.9 | 3.0x |
| `documents` schema-compatibility fallback | 855.4 | 772.8 | 889.1 | 855.4 | 3.9% | 418.1 | 2.0x |
| Attach transaction rows to dataset | 4.9 | 1.7 | 1.7 | 1.7 | <0.1% | 0.1 | 17.0x |
| Canonical normalization, 5,063 rows | 11,868.9 | 10,902.5 | 9,670.9 | 10,902.5 | 49.2% | 0.0 | n/a |
| Workspace stage 2 fetch group | 1,137.4 | 1,096.2 | 1,341.2 | 1,137.4 | 5.1% | 185.5 | 6.1x |
| Audit fetch group | 277.1 | 231.5 | 230.6 | 231.5 | 1.0% | 140.1 | 1.7x |
| Data-ready → first Overview paint | 114.3 | 79.1 | 74.5 | 79.1 | 0.4% | 32.6 | 2.4x |
| Inter-stage state/error scheduling residual | 13.0 | 5.8 | 4.2 | 5.8 | <0.1% | 3.6 | 1.6x |
| **Observed wall clock to Overview interactive** | **26,350.8** | **21,342.9** | **22,173.9** | **22,173.9** | **100.0%** | **2,177.0** | **10.2x** |

### Workspace fetch groups: observed network delivery vs client work

| Fetch group | Network / delivery (R1 / R2 / R3; median) | Client parse/transform (R1 / R2 / R3; median) | MVSU network / client |
|---|---|---|---:|
| Stage 1 — six serial `transaction_data_rows` pages are the critical chain | 9,358.3 / 6,307.5 / 8,039.2; **8,039.2** | 268.0 / 290.6 / 213.6; **268.0** | 164.4 / 8.2 |
| `projects` fallback | 471.9 / 486.6 / 423.8; **471.9** | 4.2 / 6.4 / 3.2; **4.2** | 159.5 / 1.4 |
| `documents` fallback | 784.6 / 698.1 / 827.3; **784.6** | 70.8 / 74.7 / 61.8; **70.8** | 413.8 / 4.3 |
| Stage 2 — validation-evidence request is the critical chain | 1,126.2 / 1,086.3 / 1,330.3; **1,126.2** | 11.2 / 9.9 / 10.9; **10.9** | 180.6 / 4.9 |
| Audit — activity-events request is the critical chain | 269.4 / 227.1 / 225.7; **227.1** | 7.7 / 4.4 / 4.9; **4.9** | 138.2 / 1.9 |

The stage-1 delivery chain is six 1,000-row pages plus the final partial page. It, not client-side parsing, is the workspace fetch bottleneck. The two compatibility fallbacks are serial after stage 1 and add a 1.33s median wall-clock cost.

### Data-ready → first paint decomposition

These are children of the single 79.1ms median row in the main table and therefore are not added there again.

| Child stage | Run 1 | Run 2 | Run 3 | Median |
|---|---:|---:|---:|---:|
| `buildProjectOverviewModel` (all major sections) | 46.7 | 21.7 | 20.3 | 21.7 |
| `resolveProjectIssueObjects` (all construction loops + sort) | 24.5 | 23.0 | 21.6 | 23.0 |
| Truth-section shaping + truth sections + briefing | 17.9 | 13.9 | 13.5 | 13.9 |
| React commit/paint residual | 25.2 | 20.5 | 19.1 | 20.5 |
| **Data-ready → first paint** | **114.3** | **79.1** | **74.5** | **79.1** |

`buildProjectOverviewModel` did not dominate; its largest measured internal section was validator-summary assembly (33.0ms in run 1, 13.6ms in run 2, 12.8ms in run 3). The post-data render is not responsible for the Golden stall.

## H-B — execution-backed issue sweep

**Verdict: KILLED.** The exact production shape exists: 334 unmatched execution items × 150 activity events = a 50,100-predicate upper bound. But the construction-loop measurements were:

| Resolver loop | Run 1 | Run 2 | Run 3 | Median |
|---|---:|---:|---:|---:|
| Finding-backed | 4.2 | 3.7 | 3.7 | 3.7 |
| Execution-backed | 19.8 | 18.8 | 17.4 | 18.8 |
| Legacy-decision | 0.0 | 0.1 | 0.1 | 0.1 |
| Sort | 0.5 | 0.4 | 0.4 | 0.4 |
| **Resolver total** | **24.5** | **23.0** | **21.6** | **23.0** |

The execution-backed loop is only 0.08% of the Golden wall-clock median. It is a valid future hygiene target, not a first-load fix direction.

## Normalization closure

PR #64’s intended closure holds structurally in production: **one** call to `buildCanonicalTransactionSummaryFromRows` occurred in each Golden first load, and none occurred for MVSU’s zero rows. Its measured single-pass cost was **11,868.9ms / 10,902.5ms / 9,670.9ms**, median **10,902.5ms**.

This is not the historical repeated-normalization issue: there is no second Overview truth/briefing normalization pass. The remaining single pass is still expensive enough to own roughly half of first load.

One **DEV-only** CPU trace was captured solely for attribution and is not used in any table or payoff estimate. It places the canonical work at `lib/projectFacts.ts:2943` (`buildCanonicalTransactionSummaryFromRows`) and its hottest inner samples in `lib/extraction/xlsx/normalizeTransactionData.ts:479` (`headerWordBoundaryMatch`), with related `normalizeHeader` / `compactNormalizedHeader` helpers at lines 118 and 122. Raw ignored artifact: `output/playwright/temp-profile-0715-dev-cpu.trace.json`.

## Validator switch (one production run)

Golden’s production Validator transition was **26,589.9ms** from click to interactive (the supplied comparator was 25.72s). Its critical path closes exactly:

| Stage | ms |
|---|---:|
| Initial tab render/scheduling | 17.3 |
| First `resolveCanonicalProjectValidatorWorkspace` assembly | 12,456.9 |
| Scheduling to initial fetch | 4.5 |
| Initial fetch group (489.3ms observed delivery, 43.5ms client) | 532.8 |
| Between-fetch scheduling | 1.7 |
| Evidence fetch (228.0ms delivery, 1.7ms client) | 229.7 |
| Scheduling to post-load assembly | 1.1 |
| Second `resolveCanonicalProjectValidatorWorkspace` assembly | 13,146.3 |
| Final render/paint | 199.6 |
| **Validator interactive** | **26,589.9** |

The switch is not blocked by Validator network I/O (762.5ms total fetch time). Its two workspace assemblies consume 25,603.2ms (96.3%).

## Ranked fix directions — not implemented

1. **Reduce the cost of the one canonical transaction normalization pass.** Production evidence: 10,902.5ms median for 5,063 rows; DEV attribution isolates `headerWordBoundaryMatch` and header normalization under `buildCanonicalTransactionSummaryFromRows`. A deliberately conservative half-reduction target implies **5,451ms** expected first-load payoff, derived only from the production median. Verify success when the same three-run production median for `workspace:canonical-normalization` is **≤5,451ms** with exactly one pass and unchanged canonical summary/evidence output.

2. **Shorten the six-page transaction-row delivery chain without dropping canonical evidence.** Production evidence: 8,039.2ms median observed network delivery versus only 268.0ms client parse/transform. A half-reduction target implies **4,020ms** expected payoff. Verify success when the same production harness reports critical-chain delivery **≤4,020ms**, transaction row count remains 5,063, and the final canonical totals/evidence remain unchanged.

3. **Retire only the schema-compatibility fallback reads once schema parity is proven.** Production evidence: serial `projects` + `documents` fallback medians total 1,331.5ms. A half-reduction target implies **666ms** expected payoff; the full ceiling is 1,331.5ms. Verify success when both fallback probe counts are zero and the normal query returns the same document/project fields under the authenticated production harness. This is not authorization to change schema in this audit.

4. **Make Validator workspace assembly stable across the tab transition.** Production evidence: two assemblies cost 12,456.9ms and 13,146.3ms; removing one is a **12,802ms** expected Validator-switch payoff. Verify success when a production Validator click has one such assembly and switch median is **≤13,788ms** (26,589.9ms minus one-pass median), while the rendered validator coverage and findings remain canonical.

5. **Defer H-B indexing.** Production evidence: the execution-backed loop is 18.8ms median. Even eliminating it entirely yields only **18.8ms** first-load payoff. Verify any future change by lowering that loop’s production median without altering the 334 execution-backed issue count or audit-chain membership.

## Probe removal and repository state

All `TEMP-PROFILE-0715` source probes and both temporary runners were removed after capture. Raw production JSON and the DEV CPU trace remain only under ignored `output/playwright/`. No application, schema, data, dependency, or production code change was retained.

Final `git status --short` contains only this audit document.
