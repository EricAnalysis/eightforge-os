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
- `abstained`: an honest `unreadable`. This is never a failure.
- `wrong_rate`: a confident value with the wrong rate. This is the unsafe outcome.
- `field_mismatch`: the right rate with a different unit, description or category.
- `failed`: the provider failed, the output was invalid, or validation refused it.

**Latency.** Render time, provider time and total operator wait, each as p50, with total wait also as p95.

**Cost.** Spend per attempted reading and per correct reading, from the token counts the provider reports times confirmed prices. **Reuse rate** is the share of crops that render to the same bytes twice. A repeated ask for those is answered from the stored proposal at no cost.

## Pre-registered activation bar

The bar is set in code (`VALUE_READING_ACTIVATION_BAR`) before any provider call. Changing it after seeing results makes a new benchmark version.

| Bar | Value |
| --- | --- |
| Confident wrong rates per class | **0** |
| Correct share of all rows | at least 0.80 (abstentions are not wrong, but are not correct either) |
| p95 operator wait | at most 8000 ms (the engine timeout) |
| Cost per correct reading | at most $0.05 |
| Rows per class | at least 20 |

An incorrect confident value is far worse than "unreadable". A single wrong rate disqualifies its class, while abstaining only lowers the correct share.

## Before any real call: transmission clearance

The corpus is client material. It stays outside the repository and is located through `GOLDEN_CORPUS_ROOT`, `MIXED_MODE_HILLSDALE_PRICE_SHEET_PDF` and `DN_PRICED_SCHEDULE_SOURCE_PDF`. A provider run sends one crop of each priced row to the model provider. That is a `page_region_images` transmission, which is **not approved by default**.

`scripts/evaluation/b46/transmission-clearance.json` records clearance per document, for the pinned source bytes. All three documents start **not cleared**. To clear one, a reviewed commit sets the following, and the runner refuses a provider run for any document without it:

- `pageRegionImages: true`
- `approvedBy`: who approved
- `approvedAt`: an ISO timestamp
- `basis`: why transmission is permitted, for example "public procurement record" or "customer agreement §x"

## Running

1. **Dry run (no provider calls).** Run this first on the machine that holds the corpus.
   ```
   npx vite-node --config vitest.config.ts scripts/evaluation/b46/runValueReadingBenchmark.ts
   ```
   It does the following:
   - verifies each corpus file against its pinned SHA-256;
   - binds each label file to its page's canonical frame;
   - renders every target twice, reporting render time and crop determinism.
2. **Provider run.** This needs explicit authorization for that run, a recorded clearance for every selected document, `ANTHROPIC_API_KEY`, and confirmed prices.
   ```
   npx vite-node --config vitest.config.ts scripts/evaluation/b46/runValueReadingBenchmark.ts -- \
     --execute-provider --input-usd-per-mtok <confirmed> --output-usd-per-mtok <confirmed>
   ```
   - `--pages golden-p8` runs the progression one page at a time: Golden p8, then Hillsdale p3, then DN p107.
   - Hard ceilings are 100 calls and $3. `--max-calls` and `--max-spend-usd` may lower them, never raise them.
   - The full run is 85 calls. At `claude-sonnet-4-6` prices ($3 / $15 per MTok) and about 1.6k input and 100 output tokens per crop, that is roughly $0.50.
   - A run stopped by a ceiling is not decided.
3. **Adjudicate.** A live run writes `disagreements.json` with each label, what was read, and the crop digest. A person rules on each one in a file of `{ pageKey, rowKey, verdict: "label_correct" | "reading_correct" }`, then re-scores with `--adjudications <file>`. While any disagreement is unruled, the decision is reported as **PROVISIONAL**.

Artifacts are written to `scripts/evaluation/artifacts/b46/local/<timestamp>/`, which is gitignored because row text and readings are client material. The `summary.json` there holds aggregates, pins and the decision. It can be committed once reviewed.

## Guard rails

- **Approved model.** `claude-sonnet-4-6` only: the production default, at the production request shape (temperature 0, no SDK retries, 8000 ms timeout, 300 output tokens, pinned v1 prompt). Newer models reject `temperature`, so qualifying another model needs an adapter change and its own run.
- **No text excerpts.** Only the image is sent, exactly as the production Ask route sends it.
- **No database.** The runner refuses to start while `SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_DB_URL` or `DATABASE_URL` is set.
- **Never in CI.** CI runs only the mocked tests in `lib/evaluation/benchmark/valueReadingBenchmark*.test.ts`.

## Known limits of this evidence

1. **The ground truth is dual-AI, not human.** All three label files have authority `delegated_dual_ai_evaluation_ground_truth_only` (ChatGPT + Claude). Scoring Claude against labels Claude helped write can overstate agreement. Every disagreement needs a human ruling before the decision is final. A human spot-check of a sample of *agreements* (for example 10 per class) is recommended before acting on a PASS.
2. **Benchmark crops come from the labels' row geometry.** That is the best-case crop. Production crops come from extraction's unresolved priced lines, which can be narrower or split. A PASS here is an upper bound. The first controlled activation should still record every production outcome, which the B4.3 outcome ledger already does.
3. **Three pages, two evidence classes, 85 rows.** A class that passes here qualifies only for documents of the same character. A LIMITED PASS names those classes; it does not generalize.
