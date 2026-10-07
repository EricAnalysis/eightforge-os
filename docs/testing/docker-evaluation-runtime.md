# Docker evaluation runtime

One canonical runtime for the pinned PDF extraction/evaluation workload, so
Codex on Windows (Docker Desktop), Claude on Linux and CI produce identical,
comparable capture hashes for the same commit and the same pinned PDFs.

Scope: evaluation reproducibility only. It is not the development stack, not
the CI test runner and not a production image. It changes no extraction,
Validator, Forgewing, ResolutionCase, Supabase or deployment behavior.

## What it pins

| Layer | Pin |
|---|---|
| Node | `node:24.21.0-bookworm-slim` by digest (production and CI: major 24; see `docs/decisions/NODE_RUNTIME_ALIGNMENT.md`) |
| Python | `python:3.13.7-slim-bookworm` by digest (CI: 3.13) |
| Python deps | `requirements-test.txt` (PyMuPDF 1.28.0) |
| npm deps | `package-lock.json` via `npm ci` |
| Platform | `linux/amd64` on every host |
| Fonts | `fontconfig 2.14.1-4`, `fonts-dejavu-core 2.37-6`, `fonts-liberation2 2.1.5-1` |
| OCR | tesseract.js / core / `@tesseract.js-data/eng` from the lockfile; the core build Node selects (`relaxedsimd-lstm` on 24) is recorded |
| Locale | `LANG=LC_ALL=C.UTF-8`, `TZ=UTC`, `PYTHONUTF8=1` |
| Source | `git archive` of one commit (committed blob bytes; nothing untracked) |

Base images come from `public.ecr.aws/docker/library` (the AWS mirror of
Docker official images: same digests, no anonymous pull limit).

No credentials enter the image or the container: no `env_file`, and the runner
refuses database, provider, Linear, GitHub and Vercel credentials. Customer
PDFs are never in the image; they are mounted read-only at run time.

## Runtime-parity audits

To compare another Node runtime on identical source, build a variant (tagged
`eightforge-eval:<commit12>-<tag>`, never `:local`):

```bash
EIGHTFORGE_EVAL_NODE_IMAGE=<image@digest> EIGHTFORGE_EVAL_NODE_TAG=node20 \
  node scripts/evaluation/docker/build-eval-image.mjs
```

## Build

```bash
node scripts/evaluation/docker/build-eval-image.mjs            # HEAD
node scripts/evaluation/docker/build-eval-image.mjs <commit>   # any commit
```

Tags `eightforge-eval:<commit12>` and `eightforge-eval:local`, and prints
`EIGHTFORGE_EVAL_IMAGE_ID`. Behind a TLS-intercepting proxy, set
`EIGHTFORGE_EVAL_BUILD_CA=<pem bundle>` (a build secret, never stored) and, if
the proxy only listens on the host, `EIGHTFORGE_EVAL_BUILD_NETWORK=host`.

## Pins

A pins file names each pinned PDF by label, plain corpus file name and exact
SHA-256. The file name is part of every capture (the payload records it), so
every machine must use the same pins file: the canonical pinned corpus is
`scripts/evaluation/docker/pinned-corpus.pins.json` (`golden.pdf`,
`hillsdale.pdf`, `dn.pdf`). Name the PDFs exactly so in the corpus directory. The run refuses a missing file, a mismatched hash, a traversal path or
a duplicate. Keep the pins for customer documents outside the repository with
the corpus; `scripts/evaluation/docker/smoke.pins.json` pins the committed
smoke fixture.

```json
{
  "schema": "eightforge_eval_corpus_pins_v1",
  "documents": [
    { "label": "Golden", "file": "golden.pdf", "sha256": "<64 hex>" },
    { "label": "Hillsdale", "file": "hillsdale.pdf", "sha256": "<64 hex>" },
    { "label": "DN", "file": "dn.pdf", "sha256": "<64 hex>" }
  ]
}
```

## Run

```bash
EIGHTFORGE_EVAL_CORPUS=/path/to/pinned-pdfs \
EIGHTFORGE_EVAL_PINS=/path/to/pins.json \
EIGHTFORGE_EVAL_OUT=/path/to/empty-artifacts \
EIGHTFORGE_EVAL_IMAGE_ID=<printed by the build> \
docker compose -f compose.eval.yaml run --rm eightforge-eval
```

PowerShell: set each with `$env:EIGHTFORGE_EVAL_CORPUS = 'C:\...'` first. Add
`--corpus /corpus --pins /pins/pins.json --out /artifacts/run --repeat` after
the service name to also re-extract every document and require identical
captures within the run.

The container has no network (`network_mode: none`); the runner also probes
and refuses to run if the network is reachable. It refuses a non-empty output
directory, and refuses to start if `./eng.traineddata` exists in the working
directory: tesseract.js reads that cache before its pinned language data, so a
stale copy would silently change OCR.

## Outputs

`<out>/run/`:

| File | Content |
|---|---|
| `extraction/<label>.json` | Capture: the `extractDocument()` payload minus exactly the wall-clock fields listed in the manifest. Holds source text. |
| `reconstruction-dump.json` | The reconstruction diff's dump format (`diffPricedScheduleReconstruction.ts`), from the captures. |
| `inventory.json` | The resolution evidence inventory, from the captures. |
| `capture-hashes.json` | SHA-256 of each output, the capture-set digest and the runtime identity digest. Safe to share. |
| `runtime-manifest.json` | `identity` (must match across machines) and `observed` (image id, CPU, kernel, timings; expected to differ). Safe to share. |

`identity` records the commit and source-tree digest, lockfile digest,
platform, Node/Python/PyMuPDF versions, OCR package versions, the tesseract
core build selected on this runtime with its file hashes, language data
hashes, canvas native binary hashes, the font tree digest, locale/timezone,
the pins digest, every source PDF hash and the exact volatile paths removed.

## Compare

```bash
npx vite-node --config vitest.config.ts scripts/evaluation/compareEvaluationRuns.ts -- <runA> <runB>
```

`PARITY: yes` only when the runtime identity and every capture hash match. On
any difference it lists the differing identity fields and outputs and, for
captures, the first differing paths with the extraction stage they sit in
(OCR, PDF text, rendering, ruling lines, reconstruction/geometry, ordering).
It normalizes nothing: a difference is stopped on and reported, never smoothed
away. It prints paths and stages, never row text.

The two run directories must be on one machine to compare captures; across
machines, compare `capture-hashes.json` and `runtime-manifest.json` first
(they hold no source text), and move captures only if hashes differ.

## Parity proof

1. Same commit: each machine builds its image from that commit.
2. Same PDFs: each run's `identity.source_pdf_sha256` matches the pins.
3. Codex (Windows, Docker Desktop), Claude (Linux, Docker) and CI each run the
   smoke corpus; the pinned Golden/Hillsdale/DN corpus runs where the PDFs are.
4. All `runtime_identity_digest` and `capture_set_digest` values are equal.
   If not: stop, run the compare tool, report the differing outputs and stages.
