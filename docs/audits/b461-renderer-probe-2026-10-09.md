# DN p107 local renderer latency audit, 2026-10-09

No repository source, frozen qualification contract, request, threshold, provider run, extraction capture, or production state was changed. Zero provider calls. All client-bearing inputs and audit artifacts remain outside Git.

## Finding

pdfjs-dist 5.5.207 NodeWasmFactory passes its concatenated baseUrl/filename string to Node fs.promises.readFile. Its getFactoryUrlProp requires the base to end in literal `/`, even on Windows. The valid installed local setting is `wasmUrl: "C:/Dev/eightforge-os/node_modules/pdfjs-dist/wasm/"`. A file URL string would not be the correct filesystem pathname. The frozen renderer supplies no wasmUrl and emits the JBIG2 WASM warning and CCITT JS fallback warnings. The candidate supplies only wasmUrl; font settings, context, canvas, transform, padding, scale and encoding are identical.

The candidate eliminates these decoder warnings in isolated processes and preserves PNG bytes for all three sampled DN p107 regions, twice. It does **not** prove a latency improvement: the direction reverses between repetitions under variable host contention. No renderer change or additional paid qualification is recommended on this evidence. The previous DN qualification remains failed on its frozen total latency bar.

## Local probe

Source SHA-256: `69247bff02744276b75f2cb0d4c00610e8614bd5822d2d10ae2ad35564c3b272`.
Node v24.13.1, Windows x64, installed pdfjs-dist 5.5.207. Dependencies resolve through the existing worktree junction to C:/Dev/eightforge-os/node_modules.
The exact live bindings select r-0007/r-0016/r-0018. Their canonical boxes come from the reused final-v5 inventory. The existing production `valueReadingBenchmarkCropSpec` and `valueReadingCropPixels` helpers compute the crops. Each measurement copies source bytes, loads a fresh document, obtains page 107, constructs the identical canvas/viewport/transform, renders, PNG-encodes and destroys the document. Only local wasmUrl differs. PDF bytes and PNGs remain in memory; no PDF or PNG output copies were written.

The four final processes were run sequentially in order frozen-1, local_wasm-1, local_wasm-2, frozen-2, each measuring the three regions. This prevents pdfjs's process-global decoder cache from causing one mode to inherit another's decoder initialization. Raw stage measurements include load, getPage, setup, render, encode and destroy. Total excludes initial module import and PDF filesystem read; it must not be substituted for benchmark provider-inclusive total latency.

| Repetition | Frozen mean total ms | Local WASM mean total ms | Frozen mean render ms | Local WASM mean render ms |
|---|---:|---:|---:|---:|
| 1 | 314.52 | 407.06 | 234.10 | 299.18 |
| 2 | 616.16 | 459.58 | 455.23 | 326.35 |

12/12 final PNG hashes equal the corresponding immutable live-run PNG hash, including all 6 candidate renders:

- r-0007: `d713bacfd97c24a727e29f94024c80d4d603a5012d511d3d581d7f989a1ff625`
- r-0016: `2eb30bc3064d47a19bde743d75e8545dcee2f3e787cd272766bd688e236446ba`
- r-0018: `2903b8fec91a006cdc35ff43a9c792985df2ba4825a59fff7baf98a0e9cbb834`

The assets and renderer/inventory/live-record SHA-256 values are recorded in each `isolated-*.json`. WASM asset identities:

- jbig2.wasm: `e6bee67724a7b5436fe8162638e3708cfc8d52b6342db69a49715e30ff27cfdc`
- openjpeg.wasm: `67b8e2b162da472e98cb48d3d32e3e38fff481b9b32ff4818e78bb248af88ab2`
- qcms_bg.wasm: `6017eca5939cde1836e88e6d8cd27ae039246f206515ea4487bdfd0e3fb16e26`

## Preserved preliminary evidence and limits

The initial backslash-terminated pathname was rejected by pdfjs's factory URL validator before a candidate render; it was corrected to a forward-slash filesystem path. `probe-results.json` preserves a subsequent exploratory mixed-process run, but its timing comparisons are not valid because pdfjs decoder initialization is shared across modes. Only `isolated-frozen-1.json`, `isolated-frozen-2.json`, `isolated-local_wasm-1.json`, and `isolated-local_wasm-2.json` support the final comparison above. The current `probe.ts` runs one mode/repetition per process, requiring B461_PROBE_MODE and B461_PROBE_REPETITION. No broad corpus, full suite, installation, extraction, or production access was performed.

Sample equality does not establish corpus-wide or cross-runtime equivalence. A later optimization would require an explicitly versioned renderer/request contract, independent byte validation of the affected corpus and review before any final DN paid run. Threshold/model/prompt changes are outside this audit.
