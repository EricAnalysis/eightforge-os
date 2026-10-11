# B4.6.1 DN p107: one exception run, pre-registered (2026-10-11)

The owner approved, on 2026-10-11, **one** further paid DN p107 run that keeps the frozen request unchanged and executes on the registered crop runtime. This record is merged before that run, so every condition below is fixed before any result exists.

It is a deliberate exception to the rule recorded on 2026-10-10 (`b461-crop-runtime-registration-2026-10-10.md`) that a further paid DN p107 run needs a new, frozen, latency-ready request identity.

## Why the exception

- **The recorded result:** 20/20 correct, zero inventions, zero binding errors. Median total wait **3,196 ms** against the 3,000 ms bar, so **FAIL** on latency only (`b461-dn-p107-result-2026-10-09.md`).
- **The host behind it:** that run rendered its crops on Windows x64 with Node v24.13.1. The median render was 723 ms.
- **Linux renders the same bytes faster:** the registered runtime (Linux x64, Node v24.21.0) rendered the same 21 crop bytes with a 317 ms median (`b461-render-host-dependence-2026-10-09.md`). Production renders on Linux.
- **The request itself offers nothing:** the zero-call latency breakdown (2026-10-11) found no safe change that would save meaningful time.
  - The prompt is already v2.
  - The input is about 890 tokens per call, below the prompt-caching minimum.
  - Output length (57–71 tokens) explains essentially none of the provider-time variation: R² 0.0065 once the first call is excluded.
  - `rationale` is kept.
- **Not a proof of a pass:** component medians cannot be substituted into the total median. Only a run can answer the question.

## What is fixed

| Item | Value |
|---|---|
| Contract | `QUALIFICATION_CONTRACT` (`b461-qualification-contract-v1`), unchanged |
| Class | `confirm_scanned_amount:dense_scanned_ocr_priced_schedule` (DN p107), alone |
| Model | the contract model (`claude-sonnet-4-6`), unchanged |
| Prompt / schema / renderer | `forgewing-priced-value-reading@v2` / `value_reading_output_v2` / `value_reading_region_crop_v2`, unchanged |
| Captures and binding | the contract's pinned capture set `4d024fbe…`, binding digest `235ef06238007bbf…`, same two exclusions. **Not** the new v6 captures. |
| Bar | median total ≤ 3,000 ms and p95 ≤ 8,000 ms, plus every correctness bar. Unchanged. Nearest-rank p50 as the frozen scorer computes it. |
| Crop runtime | the registered runtime: the `Dockerfile.eval` image built from main `3e53a1f`, image `sha256:4cd74cc34334bfa35c4d56db5baee4ac207e2e74142417faac3509a27e98cad5`. Linux x64, Node v24.21.0, pdfjs-dist 5.5.207, @napi-rs/canvas 0.1.97, canvas binary SHA-256 `8af96229…cfb60`. |
| Ceilings | 20 provider calls, $1 |
| Pricing | confirmed from the official model page immediately before execution, then passed explicitly |

## Order of execution

1. **Prepare first, no provider calls.** Run prepare in the registered image with the pinned captures. Before any paid call, check that:
   - DN p107's 20 eligible targets carry **exactly the same render digests and request digests** as the recorded run `2026-10-09T15-38-00-718Z-live` (`records.json`, SHA-256 `43694bd9…`);
   - the binding digest equals `235ef06238007bbf…`.

   Any mismatch means this is not the unchanged request, and the run **does not happen**.
2. **One live execution** of the class above, inside the same image. There are no warm-up calls, retries or extra calls. The first call counts like every other.
3. **Independent decision.** Run `--decide` over **this run alone**. It is never combined with, averaged with or substituted into the 2026-10-09 run.
4. **Runtime check.** The run's recorded `runtime` must match every registered field above. If it doesn't, the run does not count. That is recorded as a void run, not a pass or a fail.

## How the result is read

- **PASS** (every bar met): the class counts as qualified under the unchanged contract, with this exception recorded beside it.
  - The 2026-10-09 FAIL stays in the record as history.
  - Qualifying the class does not activate anything. The runbook gates activation by task, so `confirm_scanned_amount` can be proposed only once **every** evidence class of that task qualifies.
  - Activation is a separate owner decision.
- **FAIL** on any bar: final for this request identity. No further run of the unchanged identity is made on any host. DN p107 then needs a new request identity, or another model under a separately pre-registered owner decision.
- **Void** (digest mismatch, runtime mismatch, a ceiling hit, or an incomplete run): no result. Report it as void. A repeat is a new owner decision.

Nothing here changes the bar, model, prompt, crop, exclusions, scorer or median convention, and no production write or activation follows from the run. Client-bearing artifacts stay outside Git, and only their hashes are recorded.
