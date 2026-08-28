# Forgewing V2 Phase B′ — local human field-label review workspace

Evaluation-only, local-only, provider-free. The workspace never calls a provider,
never writes canonical data, and stays disabled in production.

Route: `http://127.0.0.1:<port>/evaluation/forgewing/v2-field-labels`

## Required configuration contract

The route renders (HTTP 200) whenever the feature flag, host, and `NODE_ENV`
gates pass, but the workspace itself refuses to load unless **all five** values
below resolve. A missing value produces `CONFIGURATION_REQUIRED`, rendered as:

> Evaluation configuration is missing — review disabled.

| Variable | Required | Notes |
| --- | --- | --- |
| `ENABLE_V2_PHASE_B_PRIME_REVIEW_WORKSPACE` | yes | must be exactly `1` |
| `TDOT_PHASE1_SOURCE_PDF` | yes | absolute path to an existing file |
| `DN_PRICED_SCHEDULE_SOURCE_PDF` | yes | absolute path to an existing file |
| `V2_BPRIME_REVIEW_PACKET_PATH` | **yes — no default** | absolute path to the generated review packet |
| `V2_BPRIME_IMPLEMENTATION_COMMIT` | **yes** | 40-char lowercase hex; must equal the packet's `labelWorkflowImplementationCommit` |
| `V2_BPRIME_PHASE_B_ARTIFACT` | no | defaults to `scripts/evaluation/artifacts/local-v2-phase-b/phase-b-f13c815.json` |
| `V2_BPRIME_REVIEW_OUTPUT_DIRECTORY` | no | defaults to `scripts/evaluation/artifacts/local-v2-bprime-review` |

`V2_BPRIME_REVIEW_PACKET_PATH` and `V2_BPRIME_IMPLEMENTATION_COMMIT` are the two
values most often missed: neither has a fallback, and omitting either yields the
same generic `CONFIGURATION_REQUIRED` card as a missing PDF path.

Paths must be **absolute** and point at an existing file; a relative path or a
directory resolves to `null` and fails the same way.

Two distinct commits are involved — do not confuse them:

- `f13c815b2bdb386353f008f8d56c5622407d8aec` — the accepted **Phase B preparation**
  commit, pinned in code and matched against the artifact. Not an env var.
- `V2_BPRIME_IMPLEMENTATION_COMMIT` — the **label-workflow** commit recorded in the
  packet (currently `fc7433a98194b49efd09430d8a27e63d3f1f1984`).

## 1. Generate the review packet (once per label-workflow commit)

Only needed if no packet exists for the current workflow commit, or the accepted
Phase B artifact changed. The packet is written exclusively — re-running against
an existing path fails rather than overwriting.

```powershell
$env:FORGEWING_V2_BPRIME_PREPARE_CLI = '1'
$env:TDOT_PHASE1_SOURCE_PDF = 'C:\Users\ADMS Thompson\Desktop\EightForgeDocTrainning\Training Projects\TDOT\SWC 820 - Fern - Contract #89633 PHILLIPS HEAVY INC- PJ.pdf'
$env:DN_PRICED_SCHEDULE_SOURCE_PDF = 'C:\Users\ADMS Thompson\Desktop\EightForgeDocTrainning\Contract and Rates\DN12189513 CONTRACT.pdf'
$env:V2_BPRIME_IMPLEMENTATION_COMMIT = (git rev-parse HEAD)
npx vite-node -c vitest.config.ts scripts/evaluation/prepareForgewingPricingProposalV2HumanReview.ts --output "C:\Dev\eightforge-os\scripts\evaluation\artifacts\local-v2-bprime-review\phase-b-prime-review-packet.json"
```

The script prints the packet path and its SHA-256. It performs a provider-free
replay of both sources and refuses to emit a packet unless the replay matches the
accepted Phase B artifact and `orderingDeterministic` is true for every source.

## 2. Start the review server

All five variables must be set **in the shell that starts Next**. Next reads
`process.env` at request time from the server process, so exporting them in a
different terminal after startup has no effect. `.env.local` does not define any
of them.

```powershell
$env:ENABLE_V2_PHASE_B_PRIME_REVIEW_WORKSPACE = '1'
$env:TDOT_PHASE1_SOURCE_PDF = 'C:\Users\ADMS Thompson\Desktop\EightForgeDocTrainning\Training Projects\TDOT\SWC 820 - Fern - Contract #89633 PHILLIPS HEAVY INC- PJ.pdf'
$env:DN_PRICED_SCHEDULE_SOURCE_PDF = 'C:\Users\ADMS Thompson\Desktop\EightForgeDocTrainning\Contract and Rates\DN12189513 CONTRACT.pdf'
$env:V2_BPRIME_REVIEW_PACKET_PATH = 'C:\Dev\eightforge-os\scripts\evaluation\artifacts\local-v2-bprime-review-20260827T1102Z\phase-b-prime-review-packet-fc7433a.json'
$env:V2_BPRIME_IMPLEMENTATION_COMMIT = 'fc7433a98194b49efd09430d8a27e63d3f1f1984'
npx next dev --hostname 127.0.0.1 --port 3017
```

Then open `http://127.0.0.1:3017/evaluation/forgewing/v2-field-labels`.

Expected: 17 fields, 0 confirmed, every dropdown showing `Select explicitly…`,
reviewer handle blank, attestation unchecked, completion disabled.

## Failure codes

`CONFIGURATION_REQUIRED` is the only code caused by configuration. Every other
code means an integrity check failed and must **not** be worked around:

| Code | Meaning |
| --- | --- |
| `CONFIGURATION_REQUIRED` | one of the five required values is missing or unresolvable |
| `PREPARATION_ARTIFACT_CHANGED` | Phase B artifact SHA or report digest does not match the accepted values |
| `SOURCE_REPLAY_INVALID` | packet digest, version, pinned commits, or field set drifted |
| `SOURCE_IDENTITY_CHANGED` | a source PDF's bytes do not match the packet's recorded identity |
| `ORDERING_NONDETERMINISTIC` | replay ordering was not deterministic |
| `IMPLEMENTATION_COMMIT_CHANGED` | the workflow commit moved mid-review |

## Guarantees

- 0 provider calls; `promotionEvidence` and `promotionAuthorized` are always false.
- Disabled when `NODE_ENV=production`, when the flag is unset, and for any host
  other than `localhost`, `127.0.0.1`, or `::1`.
- No label is ever pre-filled from `sourceFieldRole`; deterministic structure is
  display context only, and every expected role must be chosen explicitly.
