# B4.6.1: crop runtime registration (2026-10-10)

The owner approved this registration on 2026-10-10. It is the step `b461-render-host-dependence-2026-10-09.md` recommended: **declare, before any further paid run, the host that renders qualification crops.**

The registration changes no code, contract, bar, taxonomy, exclusion, prompt, crop semantics or request identity. `QUALIFICATION_CONTRACT` (`b461-qualification-contract-v1`) and its pinned source digests are untouched, so the frozen contract digest is unchanged. The runner already records the crop runtime at execution (`scripts/evaluation/b461/runQualification.ts`: `runtime` in `summary.json` and `decision.json`). This registration fixes which recorded runtime a future decision accepts.

## Registered crop runtime

A B4.6.1 qualification run counts toward a decision only if its recorded `runtime` matches all of these:

| Field | Registered value |
|---|---|
| Host | The pinned evaluation image built by `Dockerfile.eval` (base `node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20`, `--platform=linux/amd64`) |
| `platform` / `arch` | `linux` / `x64` |
| `nodeVersion` | `v24.21.0` |
| `packages['pdfjs-dist']` | `5.5.207` |
| `packages['@napi-rs/canvas']` | `0.1.97` |
| Native binary that renders | `@napi-rs/canvas-linux-x64-gnu/skia.linux-x64-gnu.node`, SHA-256 `8af96229a864c193df54f9c3eefb489ce8fab0867dfab9ed8c694b53034cfb60` |

The reference measurement is image `sha256:729747f57177bb3cc20bfe6f1a89e8645f2515dd940d1e53922f457b7dc2d428`, built from main `892ad73`. It rendered all 82 bound crops deterministically, with a DN p107 render median of 317 ms. An image rebuilt from a later main qualifies when the fields above match; the image id itself depends on the source tree.

## What this does not change

- **The DN p107 result stands as recorded.** 20/20 correct, zero inventions or binding errors, median total 3,196 ms against the 3,000 ms bar: **FAIL** (`b461-dn-p107-result-2026-10-09.md`). The run was on a Windows x64 crop host, Node v24.13.1.
- Registering the runtime changes no provider input: the request identity, which is a digest of the crop bytes, model, prompt and schema, is unchanged. The DN correctness proofs are therefore reused, not repeated.
- **No DN rerun is made because of this registration.** A further paid DN p107 run happens only when a real latency optimization produces a new, frozen, latency-ready request identity, as the owner directed on 2026-10-10. If one does, it must run on the registered runtime above, and its saved execution must be scored independently under the unchanged contract.
- The bar stays at 3,000 ms median and 8,000 ms p95. It is never relaxed, and the model is never changed to rescue a result.

## Value reading stays inactive

No qualified class exists. DN p107 (`dense_scanned_ocr_priced_schedule`) is inactive on latency. The other classes become scoreable only as their labels, captures and bindings reach the 20-row minimum per class under the unchanged contract.
