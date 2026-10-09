# Decision: one Node major (24) for production, CI and evaluation

Date: 2026-10-07. Evidence: `docs/audits/ocr-runtime-parity-2026-10-07.md`.

## Decision

Node 24 everywhere, declared in the repository:

- `package.json` `engines.node: "24.x"`: Vercel builds with it (it already
  ran 24.x from the project setting; this makes the repository the source).
- `.nvmrc` `24`: local development, and CI via `node-version-file: .nvmrc`
  in every workflow.
- `Dockerfile.eval`: `node:24.21.0-bookworm-slim`, pinned by digest (the
  exact release; production and CI follow the 24.x line).

## Why

- Production already ran 24.x; evaluation and CI ran 20, so qualification
  measured a different runtime than the one serving operators.
- Node chooses the OCR engine build: 20 loads `simd-lstm`, 24 loads
  `relaxedsimd-lstm`. Evaluating on 20 measured an OCR core production does
  not run.
- Node 20 is past end of life.
- The full suite passes on Node 24.21.0 (5,909 passed, 92 skipped; typecheck
  clean), and OCR captures on the audit corpus are identical to Node 20 on
  the tested CPU.

## Consequences

- Patch drift remains between the 24.x line (Vercel, CI) and the evaluation
  pin; the evaluation manifest records the exact version, and the pin moves
  deliberately.
- Relaxed SIMD may produce CPU-dependent OCR output. Not observed on the
  tested CPU; the cross-machine evaluation is the check.
- Developers on another major get an `npm` engine warning, not a failure.
