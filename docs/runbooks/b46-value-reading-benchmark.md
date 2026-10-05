# B4.6 — Value-reading qualification benchmark

B4.6 is a measurement, not an architecture phase. It answers one question:

> Can Forgewing read unresolved pricing cells accurately enough, fast enough
> and cheaply enough to justify controlled activation?

It ends with exactly one decision:

| Decision | Meaning |
| --- | --- |
| **PASS** | Every evidence class meets every bar. Controlled activation may be proposed. |
| **LIMITED PASS** | Some classes meet every bar. Activation may be proposed for those classes only. |
| **FAIL** | No class qualifies. Value reading stays disabled; the report shows where reading breaks. |

The benchmark never changes the activation ceiling. A PASS or LIMITED PASS is the evidence for a separate, reviewed change to `VALUE_READING_POLICY` in `lib/server/forgewingGates.ts`.

## What is measured

The benchmark runs the production read path for every labelled priced row on the three corpus pages. That path is the B4.5 renderer (`renderValueReadingCrop`), the B4.5 Claude adapter, and the strict output parser (`parseValueReadingOutput`). There is no database and nothing is persisted.

| Page | Evidence class | Priced rows |
| --- | --- | --- |
| Golden p8 | `ocr_price_sheet` | 24 |
| Hillsdale p3 | `ocr_price_sheet` | 40 |
| DN p107 | `dense_scanned_ocr_priced_schedule` | 21 |

**Accuracy.** Each reading is scored against the tracked label truth:

- `correct`: the rate, unit and description match, and the category matches where the page labels one. Text comparison ignores case, spacing and dash or quote variants.
- `abstained`: an honest `unreadable`. It is allowed, and preferred over guessing.
- `wrong_rate`: a confident value with the wrong rate. This is the unsafe outcome.

  **Correctness is decided by the target region alone:** a rate is correct only if it is the target cell's value, and no value from anywhere else is ever accepted. The wider page evidence (every labelled cell and word on the page) then classifies the error, for diagnosis only. Both kinds are hard qualification failures, reported separately:
  - a **wrong source-region binding**: the returned value exists elsewhere in the page evidence, but not in the target row or field. For example, target $14.50, returned $425.00, and $425.00 is printed elsewhere on the page. The disagreement names the source and whether it was inside the crop.
  - an **unsupported numeric invention**: the returned value exists nowhere in the page evidence. For example, target $14.50, returned $17.80, and $17.80 appears nowhere.
- `field_mismatch`: the right rate with a different unit, description or category.
- `failed`: the provider failed (including timeouts), the output was invalid, validation refused it, or the crop could not be drawn.

A reading is also flagged as an **unsupported value invention** when it reports a value the target evidence does not support:
- a **unit** other than the target row's own unit cell (a unit printed elsewhere on the page does not count as support);
- a **category** that is neither the row's own category cell nor the explicitly allowed structural context, which is the nearest preceding section heading (for example DN's "ROADWAY ITEMS").

Comparison ignores case, spacing and dash or quote variants only. Description mismatches are field mismatches, not inventions.

**Usefulness.** The share of *genuinely readable* targets resolved correctly. A person may rule an abstained row genuinely unreadable, which takes it out of the denominator.

**Latency.** Render time and provider time at p50; total operator wait at p50 and p95; and the timeout count.

**Cost.** Spend per attempt (per provider call) and per correct reading, computed from the provider's reported tokens and confirmed prices. **Reuse rate** is the share of crops that render to identical bytes, so that a repeat ask is answered from the stored proposal at $0.

## Controlled-activation bar (confirmed, pre-registered)

The bar is fixed in code (`VALUE_READING_ACTIVATION_BAR`) before any provider call. Changing it after seeing results makes a new benchmark version.

| Dimension | Bar | Scope | Kind |
| --- | --- | --- | --- |
| Rate precision among value (non-abstained) readings | at least 99% | per class | hard |
| Wrong source-region bindings | 0 | whole corpus | hard |
| Unsupported numeric inventions | 0 | whole corpus | hard |
| Unsupported value inventions (unit, category) | 0 | whole corpus | hard |
| Correctly resolved, of genuinely readable targets | at least 80% | per class | **soft** |
| Median end-to-end wait | at most 3 s | per class | hard |
| p95 end-to-end wait | at most 8 s (the engine's timeout ceiling) | per class | hard |
| Cost per attempted reading | at most $0.05 | per class | hard |
| Cost per correct reading | at most $0.10 | per class | hard |
| Crops rendering to identical bytes (repeat asks reused at $0) | 100% | per class | hard |
| Rows per class | at least 20 | per class | hard |

**Decision.**
- **PASS:** no corpus-wide safety failure, and every class meets every bar.
- **LIMITED PASS:** no corpus-wide safety failure, and at least one class meets every hard bar. That class's status is `qualified`, or `qualified_low_coverage` when it is below 80% coverage. Only those classes may be enabled.
- **FAIL:** anything else.

Lower coverage is accepted only when every hard bar holds. It can never reach PASS, and coverage is never bought by relaxing a hard bar. A class with no value readings at all has undefined precision and fails.

**Authority and safety.** These are properties of the system, not of a reading, so this measurement does not prove them. The decision lists each invariant with the suites that prove it. Those suites must be green on the qualification commit (full-vitest and the Phase 1B Postgres regression):

- 100% of readings remain AI_PROPOSED and non-authoritative until a human assertion cites them.
- 100% of stale evidence is rejected. A reading whose page or binding moved is discarded, and a stale citation is refused.
- 100% of rejected and deferred proposals are unpromotable, including under concurrency.
- No Core, canonical or Validator path consumes an AI proposal directly.

## Before any real call: transmission clearance

The corpus is client material. It stays outside the repository and is located through `GOLDEN_CORPUS_ROOT`, `MIXED_MODE_HILLSDALE_PRICE_SHEET_PDF` and `DN_PRICED_SCHEDULE_SOURCE_PDF`. A provider run sends one crop of each priced row to the model provider. That is a `page_region_images` transmission, which is **not approved by default**.

`scripts/evaluation/b46/transmission-clearance.json` records clearance per document, for the pinned source bytes, with `scope: b46_value_reading_benchmark`. Golden, Hillsdale and DN are **cleared**: the repository owner approved `page_region_images` and `text_excerpts` for this qualification on 2026-10-05. The benchmark sends images only, matching the production Ask route.

This record authorizes benchmark runs only. It does not change or bypass the B4.1 organization data-policy ledger, which still governs every production transmission. Under any other scope the same entries clear nothing.

A document is cleared only when a reviewed commit sets the following; the runner refuses a provider run for any document without it:

- `pageRegionImages: true`
- `approvedBy`: who approved
- `approvedAt`: an ISO timestamp
- `basis`: why transmission is permitted, for example "public procurement record" or "customer agreement §x"

## Running

Run all of this on the machine that holds the corpus, in a shell with **no** database variables set (`SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_DB_URL`, `DATABASE_URL`). Set the corpus variables first:

```
export GOLDEN_CORPUS_ROOT=<folder holding the Golden contract PDF>
export MIXED_MODE_HILLSDALE_PRICE_SHEET_PDF=<path to the Hillsdale PDF>
export DN_PRICED_SCHEDULE_SOURCE_PDF=<path to the DN PDF>
```

1. **Dry run (no provider calls).**
   ```
   npx vite-node --config vitest.config.ts scripts/evaluation/b46/runValueReadingBenchmark.ts
   ```
   It does the following:
   - verifies each corpus file against its pinned SHA-256;
   - binds each label file to its page's canonical frame;
   - prints each document's clearance;
   - renders every target twice, reporting render time and crop determinism. This must report 85/85 deterministic.
2. **Live run, one page at a time.** It needs `ANTHROPIC_API_KEY`, and `FORGEWING_MODEL` either unset or set to `claude-sonnet-4-6`. Confirm the current per-token prices, then substitute them for the `<…>` values:
   ```
   npx vite-node --config vitest.config.ts scripts/evaluation/b46/runValueReadingBenchmark.ts -- \
     --execute-provider --pages golden-p8 --input-usd-per-mtok <input> --output-usd-per-mtok <output>
   ```
   - Then run `--pages hillsdale-p3`, then `--pages dn-p107`.
   - Stop and look after any page with a wrong rate or an invention.
   - Each run is capped at 100 calls and $3. The full corpus is 85 calls.
3. **Score the corpus as one decision.**
   ```
   npx vite-node --config vitest.config.ts scripts/evaluation/b46/scoreValueReadingBenchmark.ts -- \
     --runs <golden run dir>,<hillsdale run dir>,<dn run dir>
   ```
   The command refuses a run that is not live or not complete, runs that differ in model, prompt, schema, crop or bar, and a row scored twice. It makes no provider call.
4. **Adjudicate.** Each live run writes `disagreements.json`. It lists every wrong rate, field mismatch and invention, with the label, what was read, the classification, the binding trace and the digests. A person rules in a file of `{ pageKey, rowKey, verdict }` entries:
   - `label_correct`: the reading was wrong.
   - `reading_correct`: the label was wrong. The row is scored correct.
   - `target_unreadable`: for abstentions only. The crop is genuinely unreadable, so the row leaves the coverage denominator.

   Re-run step 3 with `--adjudications <file>`. While any disagreement is unruled, the decision is **PROVISIONAL**.
5. **Report PASS / LIMITED PASS / FAIL** before any activation change.

Artifacts are written to `scripts/evaluation/artifacts/b46/local/<timestamp>/`, which is gitignored because row text and readings are client material:
- `summary.json`: aggregates, pins, clearance, the bar and the decision. It can be committed once reviewed.
- `records.json`: per row, the typed outcome, binding trace and inventions, and the request, render and output digests.
- `readings.json`: every raw provider output, which is the audit trail behind each output digest.
- `disagreements.json`: what needs a human ruling.

Benchmark readings are never written anywhere as proposals, and never promoted to HUMAN_REVIEWED truth. Production stays disabled until the decision (PASS, LIMITED PASS or FAIL) has been reported and a separate, reviewed change acts on it.

## Guard rails

- **Approved model.** `claude-sonnet-4-6` only: the production default, at the production request shape (temperature 0, no SDK retries, 8000 ms timeout, 300 output tokens, pinned v1 prompt). Newer models reject `temperature`, so qualifying another model needs an adapter change and its own run.
- **No text excerpts.** Only the image is sent, exactly as the production Ask route sends it.
- **No database.** The runner refuses to start while `SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_DB_URL` or `DATABASE_URL` is set.
- **Never in CI.** CI runs only the mocked tests in `lib/evaluation/benchmark/valueReadingBenchmark*.test.ts`.

## Known limits of this evidence

1. **The ground truth is dual-AI, not human.** All three label files have authority `delegated_dual_ai_evaluation_ground_truth_only` (ChatGPT + Claude). Scoring Claude against labels Claude helped write can overstate agreement. Every disagreement needs a human ruling before the decision is final. A human spot-check of a sample of *agreements* (for example 10 per class) is recommended before acting on a PASS.
2. **Benchmark crops come from the labels' row geometry.** That is the best-case crop. Production crops come from extraction's unresolved priced lines, which can be narrower or split. A PASS here is an upper bound. The first controlled activation should still record every production outcome, which the B4.3 outcome ledger already does.
3. **The crop shows neighbouring rows.** With the B4.5 renderer's 6-point padding, the crop reaches into adjacent rows on 23 of 24 Golden rows, 38 of 40 Hillsdale rows and all 21 DN rows (on DN, up to two rows either side). That is a measured property of the production crop, not something this benchmark changes. Any resulting misreads are scored as wrong source-region bindings, with the source cell named and marked as inside the crop.
4. **Three pages, two evidence classes, 85 rows.** A class that passes here qualifies only for documents of the same character. A LIMITED PASS names those classes; it does not generalize.
