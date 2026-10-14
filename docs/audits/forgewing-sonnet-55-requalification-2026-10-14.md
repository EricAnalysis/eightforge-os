# Forgewing Sonnet 5.5 Requalification — 2026-10-14

## Decision

**FAIL — not eligible for promotion.** Keep `FORGEWING_MODEL=claude-sonnet-4-6`.

The additive qualification identity executed without changing the frozen Sonnet
4.6 contracts or evidence. B4.6.1 DN p107 failed the unchanged qualification
bar. Phase 17 remained fail-closed because its committed human label set is
incomplete, so no Phase 17 provider calls were made.

## Frozen relationship

- Model: `claude-sonnet-5-5`
- Sampling provenance: `temperature` explicitly omitted
- B4.6.1 framework: `b461-qualification-contract-v2`
- B4.6.1 contract digest: `74e78283d97d155f37b3b37477303618ccd7512c3d1f6057ae33f8f20303b757`
- Phase 17 framework: `phase17-continuation-qualification-contract-v2-sonnet-5-5`
- Corpus identity: `593e2b6885cf0c66898a269fd6c61b21b3e39f6c09ec0f18544307ee9961998a`
- B4.6.1 binding: `235ef06238007bbf14ac009af78eabf528cb2bd4468c49ff155c3589cc804d40`
- Expected-output identity: `1268667fee7c69708d4294dc4c3788ced225bd1750758839fff8a64e0a7c69fd`
- Scoring identity: `be49ee8df18121ddfbba0b76915045b74a5b18b232908cff6d89408024e3fa71`
- Threshold identity: `1e21ebac3e3e8fb89f0b1b03a4ecad4e0d56167eb6680d7df3777b971998fbe8`
- Prompt SHA-256: `17ba8da5a1efdb172a6b347ce0bdc43c798e97a08b6098e400144a4d9c1bbcad`
- Capture runtime identity: `14e926630c95b6e5b1ef404727d723ce5233e184adfe45e23fd2fe1d84b266ee`
- Capture-set identity: `4d024fbea02ac9c1f55fd71e48fe8b2c9df41c3c7d047508dcc1205872047c13`

The B4.6.1 request identity remains the frozen formula over page, row, render,
model, prompt, and output-schema identities. The model value makes the 5.5
request digests distinct from 4.6, and the pinned 5.5 client proves that the
request body contains no `temperature` key.

## Gate results

| Gate | B4.6.1 DN p107 | Phase 17 |
|---|---|---|
| Frozen identity and corpus | PASS | PASS |
| Zero-call preflight | PASS — 82/82 deterministic crops, zero calls | PASS — 48-call plan frozen, zero calls |
| Output correctness | FAIL — 17/20 correct; 3 provider-truncated outputs | NOT RUN — committed labels are incomplete |
| Schema compliance | FAIL — 17 valid structured outputs; 3 truncated outputs | NOT RUN |
| Authority / behavior constraints | PASS — zero wrong bindings, inventions, or authority writes | PASS at preflight; live behavior not run |
| Latency | FAIL — total p50 4020.3608 ms > 3000 ms; p95 6099.0269 ms <= 8000 ms | NOT RUN |
| Determinism / repeatability | PASS for frozen crop reuse, 20/20 | NOT RUN |
| Cost | PASS — $0.0041354/attempt and $0.0048652/correct | NOT RUN |
| Qualification | FAIL | NOT RUN / fail-closed |

The three failed DN readings ended with `provider_truncated_output` at the
unchanged 300-token cap. No prompt, output cap, scoring rule, threshold, label,
exclusion, or benchmark definition was changed in response.

## Historical Sonnet 4.6 baseline

The authoritative DN p107 baseline remains unchanged: 20/20 correct, zero
inventions and wrong bindings, median total latency 3196.1921 ms against the
frozen 3000 ms bar, result **FAIL**.

Sonnet 5.5 materially regressed this measured run: three truncated outputs and
approximately 824.17 ms higher median total latency. Both models fail the same
latency bar; only the recorded frozen runs support these comparisons.

## Evidence

- B4.6.1 live result artifact digest: `a97ec0bac70c6e4868f0693f98c78292e65941965d91699ea98e85eebd245fac`
- B4.6.1 independent decision artifact digest: `21561110384968362b61cb40c8ab83f65d9a59b5ba189c0c626e2e467c5b24a9`
- Phase 17 zero-call result artifact digest: `51cd4a976e2189b3466644a53b91c034cc9e2950b5adfbb664bb5081da71a67d`
- B4.6.1 live calls: 20
- Phase 17 provider calls: 0
- Production model changes: none

The B4.6.1 evidence is stored under the separate local root
`C:\Users\ADMS Thompson\.codex\tmp\forgewing-sonnet-55-live-20261013`; the
final Phase 17 dry artifact is under
`C:\Users\ADMS Thompson\.codex\tmp\forgewing-sonnet-55-live-20261014`.
Historical Sonnet 4.6 artifacts were not overwritten or co-mingled.

## Implementation validation

- Additive contract, request-shape, dry-run, artifact, and architecture slice:
  33 tests passed.
- Focused rerun after TypeScript corrections: 10 tests passed.
- Import boundary: 70 assertions passed before the new pure-contract source-pin
  registration was identified; the two affected assertions then passed
  independently after the allowlist correction.
- TypeScript: passed with `--noEmit --incremental false` and an 8 GB Node heap.
- `git diff --check`: passed.
- Paid provider calls in implementation tests: zero.
