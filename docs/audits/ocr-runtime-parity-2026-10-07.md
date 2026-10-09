# OCR runtime parity audit (2026-10-07)

Question: do our pinned evaluations measure the OCR and extraction path that
production actually runs? Read-only audit. No production data, configuration
or code was changed by the audit itself; the decision it led to is recorded in
`docs/decisions/NODE_RUNTIME_ALIGNMENT.md`.

## 1. Runtimes before alignment

| Environment | Node | Source |
|---|---|---|
| Production (Vercel project `eightforge-os`) | 24.x | Vercel project setting; nothing in the repo pinned it |
| CI (`full-vitest`, `migration-fresh-replay`, `ask-phase3-diagnostic`) | 20 | `actions/setup-node` |
| Evaluation image (first cut) | 20.19.5 | `Dockerfile.eval` |
| Codex local / this container | host-dependent (22 here) | none |

Node 20 reached end of life in April 2026.

## 2. Node selects the OCR engine build

tesseract.js (7.0.0) picks its WebAssembly core at runtime from V8 feature
detection (`wasm-feature-detect`): relaxed SIMD first, then SIMD, then plain.
Extraction creates its worker with the default OEM, so an LSTM core loads.

Measured in the evaluation image, same commit, same CPU (Intel Xeon, AVX-512, FMA):

| Node | `wasm_simd` | `wasm_relaxed_simd` | Core loaded |
|---|---|---|---|
| 20.19.5 | true | false | `tesseract-core-simd-lstm` |
| 22.23.3 | true | true | `tesseract-core-relaxedsimd-lstm` |
| 24.21.0 | true | true | `tesseract-core-relaxedsimd-lstm` |

So production (Node 24) runs a different OCR core build than CI and the
original evaluation image (Node 20).

## 3. Does the core build change output?

Corpus (no customer documents): the committed Goodlettsville price sheet
(native text plus OCR on 4 pages), a synthetic two-page scanned priced
schedule (80 rows, header row, moderate noise) and a synthetic degraded scan
(70 rows, small type, heavy noise, JPEG q45; about 2,100 OCR references, OCR
confidence 85). Each run with `--repeat` (every document extracted twice).

Result: every capture (extraction payloads, reconstruction dump, evidence
inventory) is byte-identical across Node 20, 22 and 24, and repeatable within
each run. Reconstruction ran on the synthetic schedules (40 + 40 and 48 rows
reconstructed; 128 scanned review-required values in the inventory).

Limits of this result:
- One CPU. Relaxed SIMD is implementation-defined by specification
  (for example fused vs unfused multiply-add), so results may differ on
  other hardware. The cross-machine run (Codex, Docker Desktop on Windows)
  is the test for that; production on Vercel x86-64 is a third CPU family.
- Synthetic scans, not the pinned customer corpus.

## 4. The `eng.traineddata` working-directory cache

tesseract.js reads `./eng.traineddata` (relative to `process.cwd()`) before
its configured `langPath`, and writes that cache after loading. This checkout
had a stale, untracked (`.gitignore`d) copy at the repository root. Any stale
copy on any machine silently replaces the pinned language data.

- Evaluation: the runner now refuses to start if the file exists; the image
  is built from `git archive`, so none can be present.
- Production (Vercel): the function directory is read-only, so the cache write
  fails. tesseract.js catches and logs it, and every cold start re-reads the
  gzipped language data from `node_modules/@tesseract.js-data/eng/4.0.0`
  (a cost, not a correctness issue). Production OCR does succeed (section 5), so
  that data is reachable in the deployed function.

## 5. Where production extraction actually runs

Code path: `POST /api/documents/[id]/analyze` creates a
`document_analysis_jobs` row and calls `POST /api/jobs/process/[jobId]` on the
same deployment, which runs `extractDocument()` inside the Vercel function
(no `maxDuration` export, so the platform default applies). The other caller,
`lib/pipeline/processDocument.ts` (`/api/documents/process`), also runs in
Vercel. Evaluation scripts call the same `extractDocument()`.

Production evidence (read-only SQL, counts and codes only):
- The three priced-schedule documents were extracted by manual
  `deterministic` analysis jobs on 2026-10-05, taking 34 to 301 s, with
  OCR on 2 to 19 pages (`ocr_ms` up to 173 s). Production OCR is real and runs
  on Vercel.
- AI assist (`ai_assist_v1`) was `skipped` for classification and extraction
  on every recent extraction: no provider ran inside production extraction.
- `forgewing_recovery_proposal_reviews` has no rows, so production passes no
  human-confirmed recovery selections. Production currently follows the same
  deterministic path the evaluation runs; that changes once recoveries are
  confirmed (production then extracts with them, evaluation without).

Differences that matter as much as the Node version:
1. **Stored output is stale.** The newest stored extraction for each of the
   three schedule documents carries `priced_schedule_reconstruction_v2`; current
   code produces v4. The resolution queue, pricing assembly and Validator read
   the stored reconstruction, so nothing qualified since v2 (v3 header roles,
   v4 table segments, #165 ruling geometry, #168 category evidence) reaches
   operators until those documents are analyzed again.
2. **Timeout margin.** One 19-page job took 301 s, at the edge of the
   function's duration limit. Two jobs from 2026-08-11 are still `running`
   with no completion, consistent with a function being terminated.
3. **Not all production extractions ran on Vercel.** A 238-page job
   (2026-08-12) recorded 2,252 s between start and completion, longer than any
   Vercel function can run; it was processed by a different runtime (likely a
   local server against the production database). Its runtime is unrecorded.
4. Extraction payloads do not record the Node version or OCR core build, so
   which runtime produced a stored extraction cannot be proven after the fact.

## Recommendations

1. One Node major everywhere: production, CI and evaluation on 24
   (done; see the decision record).
2. Re-analyze the three schedule documents through the app (normal operator
   action, not a backfill) so operators see current extraction output, then
   re-run the queue inventory.
3. Record runtime identity (Node version, tesseract core build, language data
   digest) in the extraction payload, so a stored extraction states what
   produced it. Extraction-owned change; scope it separately.
4. Set an explicit `maxDuration` on `/api/jobs/process/[jobId]` and mark
   abandoned `running` jobs as failed; large OCR documents need a path that
   is not bounded by one request.
5. Run the cross-machine evaluation (Codex, Windows Docker Desktop) to test
   relaxed-SIMD output across CPUs before treating pinned OCR numbers as
   hardware-independent.
