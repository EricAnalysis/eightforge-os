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

## Smallest next steps

1. **Read DN p107** (`confirm_scanned_amount` × dense scan, 20 cases). It needs a session with `ANTHROPIC_API_KEY` and confirmed prices. It cannot activate anything by itself; it tells us whether the dense-scan class can qualify.
2. **Codex:** fix the Golden p8 two-row lines, then re-run prepare.
3. **Label Golden p10**, the remaining 19 `confirm_scanned_amount` cases, with the existing label tool. Then the task can be decided as a whole.
4. `read_unresolved_line` needs labels on DN p110, Golden p11 and Hillsdale p1. `read_withheld_line` needs more cases than the corpus has.
