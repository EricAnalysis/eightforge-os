# B4.6 — Value-reading qualification result (canonical)

**Decision: FAIL** under the pre-registered `VALUE_READING_ACTIVATION_BAR`.

- **Production value reading remains disabled.** The activation ceiling in `lib/server/forgewingGates.ts` was not changed.
- **No benchmark result became canonical truth.** No proposal was written or promoted, no `human_fact_assertions` row was created, and no benchmark label was edited.

This record is final for B4.6. The bar, scorer and benchmark version are not changed after observing the run. Any further attempt is a separately versioned qualification (B4.6.1), with its bar pinned before execution.

## Run

| | |
| --- | --- |
| Date | 2026-10-05 |
| Model | `claude-sonnet-4-6`, production request shape: temperature 0, 300 output tokens, 8000 ms timeout, no retries, image only |
| Bar and scorer | `main` at `bfc0b90` (#155), merged before the first live call |
| Dry run | 85/85 crops deterministic; 0 provider calls |
| Live runs | One page at a time: Golden p8 (24 calls), then Hillsdale p3 (40), then DN p107 (21). 85 calls in total. |
| Tokens | 80,403 input / 7,827 output; no cache reads or writes |
| Estimated cost | $0.358614 at $3 per million input tokens and $15 per million output tokens. This is an estimate from reported usage; the API does not return billing. |
| Artifacts | Kept on the corpus machine, outside the repository (client material). Each live run directory holds the request, render and output digests, the raw provider outputs and the exact crops. |

## Pre-registered bar (B4.6)

| Bar | Value | Scope | Kind |
| --- | --- | --- | --- |
| Rate precision among value readings | at least 0.99 | per class | hard |
| Wrong source-region bindings | 0 | corpus | hard |
| Unsupported numeric inventions | 0 | corpus | hard |
| Unsupported value inventions (unit, category) | 0 | corpus | hard |
| Median total wait (render + provider) | at most 3000 ms | per class | hard |
| p95 total wait | at most 8000 ms | per class | hard |
| Cost per attempt | at most $0.05 | per class | hard |
| Cost per correct reading | at most $0.10 | per class | hard |
| Crops rendering to identical bytes | 100% | per class | hard |
| Rows per class | at least 20 | per class | hard |
| Correctly resolved, of readable targets | at least 0.80 | per class | soft |

## Why it failed

1. **Median latency, a hard bar, fails in both classes.** The 3000 ms limit was fixed before execution, and this failure alone makes B4.6 FAIL.
   - `ocr_price_sheet`: 3561 ms
   - `dense_scanned_ocr_priced_schedule`: 3016 ms
2. **Golden's semantic quality is short.** Its two-level price sheet produced category and description association errors and omissions. Only 4 of its 24 rows are strictly correct (pattern below). Pooling Golden with Hillsdale in the same evidence class does not hide this: the strict class result is 44/64 (0.6875), below the 0.80 coverage target.

## Numeric safety: strong

| Measure | Result |
| --- | --- |
| Rates exactly correct | **85/85** |
| Units correct | **85/85** |
| Wrong source-region bindings | **0** |
| Unsupported numeric inventions | **0** |
| Provider, parse or render failures | **0** |
| Abstentions | **0** |
| Deterministic crops | **85/85** |

## Class metrics (strict)

| Class | Rows | Correct | Rate precision | Median wait | p95 wait | Provider median | $ per attempt | $ per correct | Status |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| `ocr_price_sheet` | 64 | 44 (0.6875) | 1.000 | **3561 ms** | 4769 ms | 2883 ms | 0.00419 | 0.00609 | failed: median wait |
| `dense_scanned_ocr_priced_schedule` | 21 | 21 (1.000) | 1.000 | **3016 ms** | 4238 ms | 2719 ms | 0.00431 | 0.00431 | failed: median wait |

## Document metrics (strict)

| Page | Rows | Correct | Rates | Units | Median wait | p95 wait | Provider median | Estimated cost |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Golden p8 | 24 | **4 (0.167)** | 24/24 | 24/24 | 3672 ms | 4769 ms | 3422 ms | $0.108552 |
| Hillsdale p3 | 40 | 40 (1.000) | 40/40 | 40/40 | 3156 ms | 4706 ms | 2618 ms | $0.159507 |
| DN p107 | 21 | 21 (1.000) | 21/21 | 21/21 | 3016 ms | 4238 ms | 2719 ms | $0.090555 |

## Golden semantic failure pattern

Golden p8 is laid out as service category → distance or scope rows beneath it → unit → rate. Every one of its 20 failures has the correct rate and unit. Each is a text-field failure:

| Classification | Rows | What the reading did |
| --- | --- | --- |
| `SEMANTIC_OMISSION` (11) | r-0003–r-0005, r-0015–r-0022 | Returned only the service category as the description, with category null. The row's own distance or scope text, which tells otherwise identical rows apart (for example "16–30 Miles from ROW to DMS"), was dropped. |
| `SEMANTIC_FIELD_MISBINDING`, merged (7) | r-0002, r-0006–r-0008, r-0010, r-0023, r-0024 | Joined category and description into the description field, with category null. |
| `SEMANTIC_FIELD_MISBINDING`, swapped (2) | r-0009, r-0025 | Put the row's description text into the category field, and the category into the description. |

**Taxonomy ruling (owner):** r-0009 and r-0025 are **not** unsupported value inventions. The returned text is printed in the same source row and is assigned to the wrong field. It is not fabricated. The B4.6 scorer's mechanical category check counts them as category inventions, which would be a second corpus-wide safety failure. The owner's ruling classifies them as field misbinding. That changes no outcome, because latency fails the hard bar on its own.

All 20 remain incorrect under strict scoring. Readings that kept the full meaning but placed it in the wrong fields are not counted as correct.

## Parallel scorer not adopted

The local offline scorer on `codex/b46-local-qualification` reported "PASS under pooling". It is not canonical, for three reasons:

- It used a different bar. It omits the median-wait, rate-precision, per-attempt-cost and crop-determinism bars, and it changes the cost-per-correct limit.
- Its rulings were made by an AI and recorded as `source_verified`, where the runbook requires a person.
- It is a second decision path.

It will not be merged. Its request and response audit capture may be submitted separately, without any decision logic.

## Next

**B4.6.1** is a separately versioned remediation and requalification. It keeps the same safety, latency and cost bars, and pins them before execution. Its scope:

- prompt and schema semantics for hierarchical price sheets;
- deterministic local latency;
- a different provider model only as a separate B4.6.2, if the current model cannot plausibly meet 3 s.
