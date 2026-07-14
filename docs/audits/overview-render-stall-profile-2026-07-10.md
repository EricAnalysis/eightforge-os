# Overview render-stall profile — 2026-07-10

## Verdict

**Fail. Production Golden Overview became interactive in 42.81s — unacceptable (>10s).** The authenticated Validator transition completed in 76.38s in production. This is not dev-only drama: the production bundle is materially faster than dev (70.66s vs 42.81s) but still unusable.

Baseline was clean at `origin/main` `4b153bd` before temporary `TEMP-PROFILE-0709` probes. The documented durable viewer harness seeded `e2e-verifier@eightforge.test`, refreshed `tests/.auth/user.json`, and verified a browser-equivalent Golden RLS read. No login, middleware, RLS, schema, or application fix was changed.

## Measurements

### Dev first load

| Stage | Golden ms / calls / cardinality | MVSU ms / calls / cardinality | Golden:MVSU |
|---|---:|---:|---:|
| Overview interactive | 70,658 / 1 / 5,063 rows | 5,580 / 1 / 0 rows | 12.7x |
| Workspace stage 1 fetches | 7,219 / 1 / 5,063 rows, 339 execution | 493 / 1 / 0 rows, 0 execution | 14.6x |
| Attach transaction rows | 8 / 1 / 1 dataset, 5,063 rows | 0.1 / 1 / 0 | 78x |
| Workspace stage 2 | 1,234 / 1 / 4 docs, 342 IDs, 1,000 evidence | 283 / 1 / 3 docs, 1 ID, 1 evidence | 4.4x |
| Audit fetch | 270 / 1 / 150 events | 250 / 1 / 38 events | 1.1x |
| `buildProjectOverviewModel` | 97 + 11 / 2 / 4 docs, 8 findings | 55 + 3 / 2 / 3 docs, 1 finding | 1.8x total |
| `resolveProjectIssueObjects` | 64 + 51 / 2 / 8 findings, 339 execution, 150 events | 8 + 1 / 2 / 1, 0, 38 | 12.8x total |
| execution-backed loop | 46 + 48 / 2 / 334 output; 50,100 upper-bound matches/call | 0 / 2 / 0 | N/A |
| Truth sections | 13,019 + 14,923 / 2 / 5,063 rows | 9 + 1 / 2 / 0 | 2,994x total |
| Overview briefing | 14,495 + 13,969 / 2 / 5,063 rows | 2 + 1 / 2 / 0 | 9,488x total |
| Row-summary normalization | 12,990 + 14,485 + 14,914 + 13,957 / 4 / 5,063 rows | not called / 0 / 0 | N/A |
| First Overview paint | 29,059 + 29,067 / 2 / 342 issues | 53 + 56 / 2 / 7 issues | 541x total |

The two full Overview derivation passes are development StrictMode. They are expected; the four row normalizations are still independently expensive (12.99–14.91s each).

### Dev Validator transition

The terminal click-to-Validator result was **144,711ms**. After the click, the overview recomputed row normalization **10** more times before the Validator state load completed. The first eight normalizations were 17,547, 18,891, 14,987, 15,765, 14,270, 15,028, 11,703, and 11,659ms; `ValidatorTab.loadValidatorState` then took 48,833ms. `ProjectOverview.paint` recorded 60,127ms for the first validator render.

### Production Golden

| Event / stage | ms | calls | cardinality |
|---|---:|---:|---:|
| Overview interactive | **42,811** | 1 | 5,063 rows |
| Workspace stage 1 / stage 2 / audit | 6,312 / 1,144 / 268 | 1 each | 5,063 rows; 342 evidence IDs; 150 events |
| `resolveProjectIssueObjects` | 49 | 1 | 8 findings, 339 execution, 150 events |
| execution-backed loop | 36 | 1 | 334 output, 50,100 match upper bound |
| Truth sections / briefing | 16,536 / 14,668 | 1 each | 5,063 rows |
| Row-summary normalization | 16,513 + 14,655 | 2 | 5,063 rows |
| First Overview paint | 31,384 | 1 | 342 issues |
| Validator interactive | **76,384** | 1 | same Golden payload |
| Validator transition normalizations | 15,656 + 14,484 + 15,172 + 16,851 + 13,922 | 5 | 5,063 rows |
| Validator state fetch/load | 31,682 | 1 | 8 findings, 1,000 evidence rows |

`npm run build` completed in 128.5s after `.next` was removed, and `next start` served `/login`; production measurement is valid. MVSU production was not repeated because the required Golden verdict and dev comparator were complete.

## Flame-chart evidence

Chrome Performance traces were captured for dev Golden first load and tab switch (`output/playwright/temp-profile-dev-golden-performance.trace.json`). The dominant long tasks align with the tagged spans:

1. `lib/projectFacts.ts:2941` — `buildCanonicalTransactionSummaryFromRows`: 11.66–18.89s self-contained synchronous normalizations of 5,063 rows.
2. `components/projects/ProjectOverview.tsx:1416` and `:1425` — truth sections and briefing invoke that normalization independently; the tab transition repeats the pair repeatedly.
3. `components/projects/ValidatorTab.tsx:475` — `loadValidatorState`: 48.83s dev / 31.68s prod after the tab is mounted, including its evidence fetch and state assembly.
4. `lib/resolveProjectIssueObjects.ts:699-704` — execution-backed pass is real but small: 36–48ms despite its 50,100 predicate upper bound.

## Hypotheses

| Hypothesis | Status | Evidence |
|---|---|---|
| H-A repeated transaction normalization | **CONFIRMED** | Four 12.99–14.91s Golden dev normalizations before first interactive; two 14.66–16.51s production normalizations. Tab switch adds five production and ten dev normalizations. MVSU has zero rows and no normalization. |
| H-B execution-backed issue quadratic scan | **PARTIAL** | Shape is exact: 334 execution-backed issues × 150 events = 50,100 upper-bound evaluations. Measured loop is only 36–48ms, so it is not the stall leader today. |
| H-C N× recomputation | **CONFIRMED** | First load is expected StrictMode 2×, but the Validator switch recomputed the row summary 5× production / 10× dev. This exceeds StrictMode-only behavior and directly explains the tab stall. |

## Ranked fix directions — not implemented

1. **Reuse a single row-backed transaction summary for truth sections and briefing** (`lib/projectFacts.ts:2941`, `components/projects/ProjectOverview.tsx:1416/:1425`). Production has 31.17s of first-load summary work; avoiding the duplicate pass should remove roughly 14–16s before any further work. Preserve the exact canonical summary/evidence payload.
2. **Prevent full Overview truth/briefing recomputation on surface-only changes.** The production Validator switch spends about 76.1s in five normalizations plus 31.7s of Validator loading. Stable memoization keyed to workspace payload should remove roughly 60s of the measured switch, subject to explicit invalidation on mutations.
3. **Split/defer Validator data loading only after retaining canonical data correctness.** `ValidatorTab.loadValidatorState` costs 31.7s production. Reuse already-loaded findings/evidence or narrow the supplemental fetch; expected payoff is up to that 31.7s after the recomputation fix.
4. **Index execution/activity relationships in `resolveProjectIssueObjects`.** It removes the 50,100-match shape but offers only ~36–48ms current payoff; do it after the row-summary and surface recomputation fixes.

## Deferred UI evidence

Validator eventually rendered in both dev and production sessions. Ignored evidence screenshots were captured at `output/playwright/temp-profile-dev-golden-validator.png` and `output/playwright/temp-profile-prod-golden-validator.png`; the existing authenticated smoke specification remains the assertion source for the five open `FINANCIAL_RATE_CODE_MISSING` findings and the stale execution item shown as history.

## Probe removal and worktree state

All `TEMP-PROFILE-0709` source probes and the temporary capture runner were removed after capture. Raw traces and screenshots remain ignored under `output/playwright/`. `git status --short` contains only this audit document.
