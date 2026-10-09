# B4.6.1: crop render time depends on the host (2026-10-09)

This is a zero-call measurement. No provider call, no request change, no contract change. It follows the DN p107 latency failure recorded in `b461-dn-p107-result-2026-10-09.md`.

## Question

DN p107 failed on one bar only: median total wait was 3196 ms against 3000 ms. The saved run rendered its crops on Windows x64 with native Node v24.13.1, and recorded a 723 ms median render. Production renders crops inside a Vercel function on Linux x64 with Node 24.x. **How much of the measured wait belongs to the measurement host rather than the request?**

## Measurement

The B4.6.1 `prepare` step was run inside the pinned evaluation image, built from main `892ad73`:
- image id `sha256:729747f57177bb3cc20bfe6f1a89e8645f2515dd940d1e53922f457b7dc2d428`;
- Linux x64, Node v24.21.0, the same lockfile pdfjs-dist and @napi-rs/canvas;
- no network;
- 4 vCPU Intel Xeon at 2.10 GHz.

It used the contract's pinned capture set `4d024fbe…`, and reproduced the same binding digest `235ef06238007bbf…` and the same two exclusions as the recorded run. 82 of 82 bound crops rendered deterministically.

| Page (class) | Crops | Render median | Render p95 | Saved Windows run median |
|---|---:|---:|---:|---:|
| DN p107 (dense scanned) | 21 | **317 ms** | 352 ms | 723 ms |
| Golden p8 (OCR price sheet) | 21 | 102 ms | 163 ms | — |
| Hillsdale p3 (OCR price sheet) | 40 | 424 ms | 487 ms | — |

Request identity is identical between the two runs. The same request bytes took **2.3× longer to render** on the Windows crop host than on Linux. The Windows run also logged pdf.js JBIG2 decoder fallback warnings (see the crop lifecycle audit).

## What this does and does not show

- **It does not change the recorded result.** DN p107 failed the bar as measured, and that result stands. Rendering times from one run are never combined with provider times from another, so this measurement does not rescore anything.
- **It does show the render half of the wait is a property of the host.** The Windows render median (723 ms) exceeds the Linux one (317 ms) by about 406 ms, while the run missed the 3000 ms bar by 196 ms. The frozen contract records the crop runtime at execution time and does not fix where it runs.
- **Neither host is production.** Vercel's CPU allotment is not visible to us (plan and duration settings are unreadable through the API, as already recorded). The pinned Linux image is the closest reproducible proxy: same OS, architecture, Node major and native canvas build as a Vercel Node 24 function.

## Recommendation (owner decision, before any further paid run)

Register **before** running that the qualification crop runtime is the pinned Linux evaluation image (or another stated Linux x64 Node 24 host). Then run DN p107 once more with the **unchanged** frozen request identity, and score it independently under the unchanged contract.

This changes no bar, model, prompt, crop, exclusion or scorer. It moves the one observed variable, the render host, to the runtime production uses, and it is decided before the result is known. If the owner prefers to qualify on the slowest plausible host instead, the recorded FAIL stands, and the remaining lever is the crop lifecycle cache, which still needs admission, lease and eviction design.

Runtime manifest and records for this measurement are kept outside Git with the other client-bearing artifacts. They contain no row text beyond what `records.json` holds.
