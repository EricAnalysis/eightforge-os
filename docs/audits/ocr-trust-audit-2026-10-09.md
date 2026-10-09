# OCR trust audit (2026-10-09)

Question: can B4.6.1 qualification trust that the OCR it measures is the OCR production runs, and what must a qualification record so that this stays provable?

This is a read-only audit. It reuses `docs/audits/ocr-runtime-parity-2026-10-07.md` and re-checks only what has changed since. No production data or configuration was changed.

## Result

There is no blocking mismatch, so qualification can proceed. Three gaps were found, each with an owner:

1. **Qualification runs are not yet bound to the captures they read.** Fixed when the B4.6.1 contract is frozen (step E): the run records the capture-set digest and runtime identity digest, and refuses to mix them.
2. **Production extraction payloads do not record their runtime.** This is still open from the 10-07 audit, recommendation 3. Owner: production runtime hardening (step H).
3. **The function-tracing guard did not cover the OCR core.** Fixed here: the core build Node 24 loads, and the feature detector that picks it, are now required runtime files in `lib/architecture/nextConfigTracing.test.ts`.

## 1. Runtime identity, now

| Layer | Production (Vercel `eightforge-os`) | CI | Evaluation image |
|---|---|---|---|
| Node | `24.x` (project setting, re-read 2026-10-09; `package.json` `engines.node: 24.x`) | `.nvmrc` `24` in all three workflows | `node:24.21.0-bookworm-slim` by digest |
| tesseract.js / core | 7.0.0 / 7.0.0 (lockfile) | same lockfile | same lockfile, `npm ci` |
| Core build selected | `tesseract-core-relaxedsimd-lstm` (Node 24, default OEM) | same | same, recorded with file hashes in `runtime-manifest.json` |
| Language data | `@tesseract.js-data/eng` 1.0.0, `4.0.0/eng.traineddata.gz` via `langPath` | same | same, hash recorded |
| Page rendering | pdfjs-dist 5.5.207 + @napi-rs/canvas 0.1.97 (linux-x64-gnu) | same | same, canvas binary hashed |

At the lockfile pinned on 2026-10-09:
- `eng.traineddata.gz` SHA-256 is `ed350f37…2a2468`;
- `tesseract-core-relaxedsimd-lstm.wasm` SHA-256 is `7985c92d…a24545`.

Patch drift is unchanged: Vercel and CI follow 24.x, and evaluation pins 24.21.0. Rerun the evaluation when the pin moves; the manifest records the exact version.

## 2. The language-data cache

The 10-07 finding still holds. tesseract.js reads `./eng.traineddata` from the working directory before `langPath`.

- **Production:** the function directory is read-only, and the file is `.gitignore`d, so a Git-built deployment cannot carry it.
- **Evaluation:** the runner refuses to start if the file exists.

No change is needed.

## 3. Cross-machine parity: now measured on the pinned corpus

The 10-07 audit could not rule out CPU-dependent relaxed-SIMD output; it had one CPU and synthetic scans. The pinned customer corpus has since been extracted, in the canonical image, on two hosts:

| Run | Host | Commit | Capture set |
|---|---|---|---|
| Claude, B4.6.1 prepare (2026-10-08) | Linux cloud container, Docker | `6117550` | `b8cf14e638079170…cf3eb9d` |
| Codex, #179 baseline (2026-10-08) | Windows, Docker Desktop | `1dd82d9` (main) | `b8cf14e638079170…cf3eb9d` |

Extraction code is the same at both commits. The capture set covers:
- every extraction payload, including all OCR observations (Golden p8 and p10, DN p107 and the other scanned pages);
- the reconstruction dump;
- the inventory.

Identical capture sets on two hosts mean the relaxed-SIMD core produced byte-identical OCR on both. That is the evidence the 10-07 audit asked for. Per the proof-reuse doctrine (`AGENTS.md`), it is reused here and not re-run: its identity is computed from the artifacts, and the extraction, OCR and lockfile inputs have not changed since.

**Not yet proven: Vercel's own CPU.** No evaluation can run inside a Vercel function without a production write. The proof comes for free with step I, production re-analysis:
- re-analyze the pinned documents at a known commit;
- compare the stored OCR observations with the evaluation capture of the same commit and the same source SHA-256.

Until then, a production reading is trusted on the strength of the two-host result, not proven on Vercel's CPU.

## 4. Production OCR invocation paths

These are unchanged from 10-07. All of them reach `extractPdfPageTextViaOcr` in `lib/server/documentExtraction.ts`:
- `POST /api/documents/[id]/analyze` → `POST /api/jobs/process/[jobId]`;
- `/api/documents/process` (`lib/pipeline/processDocument.ts`).

Neither route exports `maxDuration`. Only the `app/api/internal/*` routes do, at 30–60 s. That is step H.

## 5. What qualification must record

Recorded at execution time, never frozen as a machine identity:

1. **Capture identity.** `capture_set_digest` and `runtime_identity_digest` from the captures' `capture-hashes.json`. Every run in one decision must share both.
2. **Capture runtime.** The captures' `runtime-manifest.json` `identity`: Node, the OCR core build and its hashes, language-data hashes, canvas binary hashes, the source PDF hashes and the pins digest.
3. **Crop runtime.** For the host that renders crops and calls the provider: Node version, platform and architecture, pdfjs-dist and @napi-rs/canvas versions, and each crop's render digest. The binding already proves render determinism by rendering every bound crop twice.
4. **Execution identity.** This is already recorded: binding digest, model, prompt template and SHA-256, output schema, crop renderer, scale and padding, and the activation bar.

Items 1 and 3 are added when the contract is frozen.
