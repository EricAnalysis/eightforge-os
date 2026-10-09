# B4.6.1: per-class value-reading qualification

B4.6 measured visual reading on labelled rows, and failed (`docs/runbooks/b46-value-reading-benchmark.md`).
B4.6.1 measures what production would actually ask:

- the **cases** the resolution queue opens, from the same shared builders
  (`lib/evaluation/resolutionEvidenceInventory.ts`);
- the **crop** each case would send, by the production crop rule
  (`canonicalBoxesForObservations`);
- each workflow class **alone**, against the unchanged pre-registered bar
  (`VALUE_READING_ACTIVATION_BAR`).

Every target is scored against tracked source truth (`lib/evaluation/benchmark/labels`), never against a reading.

## Classes

A workflow class is a task × evidence class. The task is what Forgewing is asked to do:

| Task | Case kind it measures | Objective source answer? |
|---|---|---|
| `confirm_scanned_amount` | `review_required_value` (scanned source) | yes: the labelled row |
| `read_unreadable_amount` | `review_required_value` (unreadable native amount) | yes |
| `read_withheld_line` | `withheld_priced_line` | yes |
| `read_unresolved_line` | `unreadable_priced_line` | yes |
| `choose_category` | `category_review` | **no: human-only** |

`choose_category` is never benchmarked. A category case exists precisely because no source evidence names an allowed category, so any label would be manufactured.

Production gates reading by **task** (case family), not by evidence class. A task may therefore be proposed for activation only when **every** evidence class of that task qualifies. A class that is unlabelled, unbindable, too small or failed blocks its task.

## Binding: from case to truth

`lib/evaluation/benchmark/qualificationBinding.ts`. A case is scored only when exactly one labelled priced row's rate cell lies inside the case's own reading region. Otherwise the binding fails, and the failure is classified before any provider call:

| Binding failure | Owner | Meaning |
|---|---|---|
| `region_spans_rows` | deterministic extraction | the case's line holds two labelled rows |
| `region_misses_rate` | deterministic extraction | the line is a priced row without its rate cell |
| `region_not_priced_row` | workflow typing | the line is not a priced row at all |
| `duplicate_case_for_row` | workflow typing | two cases for one physical row (both fail, neither counted) |
| `reading_region_unproven` | deterministic extraction | no canonical geometry; production would not draw it either |

## Failure taxonomy and owners

`lib/evaluation/benchmark/qualificationTaxonomy.ts` is pre-registered. Each failure has one kind, one owner and one smallest correction.

| Kind | Severity | Owner |
|---|---|---|
| Unsupported numeric invention | hard, corpus-wide | Forgewing prompt/reasoning |
| Unsupported semantic invention (unit, category) | hard, corpus-wide | Forgewing prompt/reasoning |
| Wrong source-region binding | hard, corpus-wide | evidence/context selection if the crop showed the copied value; otherwise prompt/reasoning |
| Field mismatch (description, unit, category) | soft | prompt/reasoning |
| Output invalid | soft | prompt/reasoning |
| Provider failure; crop unrendered | soft | provider/runtime |
| Latency; cost | hard, per class | provider/runtime |

Authority and action wiring is proven by CI on the qualification commit (`VALUE_READING_AUTHORITY_INVARIANTS`), not by a run.

## Running

On the machine holding the pinned PDFs, with no database variables set.

1. **Captures.** Run the pinned evaluation (`docs/testing/docker-evaluation-runtime.md`) at the qualification commit.
2. **Prepare.** No provider calls. It binds every case and renders every bound crop twice:
   ```
   npx vite-node --config vitest.config.ts scripts/evaluation/b461/runQualification.ts -- \
     --captures <run dir> --corpus <pdf dir> --pins scripts/evaluation/docker/pinned-corpus.pins.json
   ```
3. **Read one class.** Provider calls for that class only, needing `ANTHROPIC_API_KEY`, the approved model and confirmed prices:
   ```
   ... --execute-provider --class confirm_scanned_amount:dense_scanned_ocr_priced_schedule \
     --input-usd-per-mtok <confirmed> --output-usd-per-mtok <confirmed>
   ```
   Stop and look after any wrong rate or invention (`disagreements.json`, local only).
4. **Decide.**
   ```
   ... --decide --runs <run dir>[,<run dir>] [--adjudications <file>]
   ```
   The command refuses a run of another binding, model, prompt, schema, crop or bar, a run that stopped early, and a row scored twice.

Transmission reuses the B4.6 clearance (`scripts/evaluation/b46/transmission-clearance.json`): same documents, same content class (page-region images), same qualification. Artifacts go under `scripts/evaluation/artifacts/b461/local/` (gitignored). `bindings.json` and `decision.json` hold no row text.

## Prepared result (2026-10-08, pinned corpus, no provider calls)

Captures come from commit `6117550`, image `a2270a48…`, capture set `b8cf14e6…`, binding `4b039552…`. 174 cases. All 78 bound crops rendered, and 78/78 were byte-identical on re-render.

| Class | Cases | Bound | Status | Blocker and owner |
|---|---:|---:|---|---|
| `confirm_scanned_amount` × dense scanned schedule (DN p107) | 20 | 20 | **ready to read** | none; exactly at the 20-case minimum |
| `confirm_scanned_amount` × OCR price sheet (Golden p8, Hillsdale p3) | 51 | 50 | binding failed | 1 Golden p8 line spans two labelled rows (deterministic extraction) |
| `confirm_scanned_amount` × unlabelled (Golden p10) | 19 | 0 | needs labels | Golden p10 has no tracked labels |
| `read_withheld_line` (all classes) | 24 | 8 | insufficient | 2 to 13 cases per class; 3 lines span two rows or miss the rate (deterministic extraction) |
| `read_unresolved_line` (DN p110, Golden p10/p11, Hillsdale p1) | 45 | 0 | needs labels | none of these pages is labelled |
| `read_unreadable_amount` | 0 | 0 | no cases | — |
| `choose_category` | 15 | — | human-only | — |

**Activatable tasks: none.** `confirm_scanned_amount` has one class ready to read, but the task can be proposed only if its price-sheet class (blocked by extraction) and its Golden p10 cases (unlabelled) also qualify.

### Binding failures, by owner (deterministic extraction)

Golden p8 holds three lines whose observations span two or three printed rows (13 to 19 boxes, about 45 pt tall):
- one published scanned row whose rate observation is a single OCR box about 30 pt tall over two rows;
- two withheld bundles.

Production would send these crops with two rates in view.

The smallest correction is deterministic. A rate observation taller than one row band is not bound to one row: withhold the row as a structure case, or split it by the row bands. This change belongs to Codex.

## Continuation after Phase A and Phase B (2026-10-09)

The prepared result above is historical. Extraction v5 (#179) resolved the
Golden multi-row geometry failures; Phase A (#183) scores production crops
only against the evidence they show. The OCR audit (#182) reuses the two-host
parity proof. Renderer v2 and prompt v2 are carried by #185. See the three
dated audits under `docs/audits/`; none of those results is a B4.6.1 provider
qualification or an activation decision.

The qualification contract is registered in
`lib/evaluation/benchmark/qualificationContract.ts`. It pins the scorer,
taxonomy, binding, tasks, bar, corpus and request execution. The runner verifies
the runtime and capture-set manifests and every declared artifact before
building inventory. It records the captures' runtime identity and the crop
host's runtime at execution; machine identity is not a pre-registered constant.
Decisions require identical execution identities and complete readings for
exactly the selected class's eligible bound rows. Foreign, duplicate, missing
and stale request identities are rejected.

Known exclusions are registered in `qualificationExclusions.ts`: Golden p8
`r-0006` (OCR misread) and Golden p10 original row index 21 (deliberately
withheld). They are matched by exact pinned source and observation anchors,
listed separately and removed from scoring and denominators. An absent or
changed exclusion anchor blocks provider execution and decisions. Exclusions
never count toward the 20-case minimum, and an excluded-only class cannot
silently disappear and permit task activation.

The new Golden p10/p11 and Hillsdale p1 source labels from Claude's handoff
were not recovered locally or in the fetched branches. A proposal is not a
final label: these pages remain unlabelled until source-bound artifacts pass
the existing label authority path. **DN p110 is an insurance certificate**
(Phase A audit), so do not manufacture priced-row labels for it. Its priced-line
cases remain a workflow-typing defect requiring deterministic correction.

Next, run prepare through the frozen contract, then read DN p107's class only
with the reusable pinned-document transmission clearance, a configured
provider credential and confirmed prices. Inspect disagreements before
continuing to other classes. Final qualification remains class-by-class;
value reading stays inactive until the existing human activation path is used.

The first frozen DN p107 run is now recorded in
`docs/audits/b461-dn-p107-result-2026-10-09.md`: 20/20 correct readings, zero
inventions or binding errors, but **FAIL** on median total wait (3196 ms
against the unchanged 3000 ms bar). The independent decision reproduced it.
No class or task qualifies yet. Complete the remaining source-label and
workflow-typing work; any model or bar change is a separate pre-registration.

### Backlog continuation snapshot (2026-10-09)

PRs #185 and #186 are merged. PR #187 adds reconstruction v6: authored,
bounded insurance-limit evidence no longer opens headerless price targets;
the pinned DN p110 replay has zero such targets. Stored v1–v5 remain supported.
See `docs/audits/dn-p110-workflow-typing-2026-10-09.md` for scope and regression
proof. The historical v5 captures above remain evidence for their recorded
inputs, not current whole-queue v6 qualification.

Non-authoritative source proposals for Golden p10/p11 and Hillsdale p1 are
ready outside Git, pending authentic independent Claude review, precise
geometry and candidate-bound approvals. DN p110 receives no price labels.
The decoder probe preserved sampled crop bytes but showed no reliable latency
gain; no renderer/request change or paid retest was performed. Stage separation
inside the nonstreaming provider wait remains unmeasured. Keep all reading
classes inactive and do not rerun DN until a latency-ready identity is frozen.
The exact continuation state and commands are in
`docs/handoffs/claude-current-handoff.md`.
