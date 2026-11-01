# Case Investigation qualification contract v4 (`case_investigation_qualification_v4`)

**Status: frozen 2026-11-01. The single qualification run has not been made.** The workflow stays `disabled`. [v2](case-investigation-qualification-v2.md) and [v3](case-investigation-qualification-v3.md) FAILED on `claude-sonnet-4-6`. Those results are final and are not reinterpreted here.

## What v4 is

The same frozen capability on a stronger model. This is a Case Investigation-specific qualification: no Sonnet 5.5 result from B4.6.1, Phase 17 or any other capability is evidence here.

| Changed | From (v3) | To (v4) | Why |
|---|---|---|---|
| Model | `claude-sonnet-4-6` | `claude-sonnet-5-5` | The approved next step |
| `temperature` | `0` | omitted | Sonnet 5.5 rejects a non-default value (`getClaudeSamplingParameters`) |
| `thinking` | omitted (4.6 runs without thinking) | `{ type: 'between_tools' }` | Omitted on 5.5 means adaptive thinking, which spends the same 1,500-token cap. `between_tools` keeps the no-upfront-thinking request v3 measured (B4.6.1 v3 precedent). Chosen before any provider output existed |
| Price in the cost bar's arithmetic | $3 / $15 per MTok | $2 / $10 per MTok | The model's published list price. The $0.03 bar is unchanged |

Everything else is v3's, unchanged: the 111 cases (81 `validator_failure`, 30 `conflict`) and their identities; Eric Martin's adjudications and the final labels; source evidence and primary actions; the prompt bytes and output schema; the citation cap (1–12), diagnosis (1,200) and rationale (2,000) limits; the invented-number rule; invalid answers at most 5%; median at most 15 s and p95 at most 25 s; the 30 s timeout; $0.03 per investigation; top-1 at least 0.90 and at least the baseline; faithfulness and root-cause bars; zero retries; the $3 ceiling and call cap; human authority and canonical truth. Activation requires both classes.

No fallback model is configured: a `refusal` is a provider failure, and it counts as invalid.

## Compatibility probe (2026-11-01): compatible

Not a qualification. Three invented contexts, not corpus cases, through the production runner and adapter. No answer text was kept and no label was read. The probe ran twice because the first run did not record why an answer was rejected.

| | Probe 1 | Probe 2 (adds rejection categories) |
|---|---|---|
| Evidence (outside the repository) | `case-investigation-v4-compatibility-probe-20261101/probe.json` | `case-investigation-v4-compatibility-probe-2-20261101/probe.json` |
| Provider errors | 0 of 3 | 0 of 3 |
| Response model / stop reason | `claude-sonnet-5-5` / `end_turn` on all | same |
| Latency | 3.1–4.5 s | 3.4–6.7 s |
| Accepted by the runner | 1 of 3 | 1 of 3 |
| Spend | $0.013 | $0.013 |

In probe 2 every answer parsed with the schema's exact keys and stayed within the length and citation bounds. Both rejections were the invented-number rule. The cause was deliberately not investigated: the prompt is frozen, and nothing may be tuned against it. The full run measures this.

## Frozen identities

| Identity | Value |
|---|---|
| Contract | `case_investigation_qualification_v4` |
| Scorer / bars digest | `case_investigation_scorecard_v4` / `c48ae93dad5d392b39fb3785eeb9c43105dcc5f000e734953eda3df720fd659a` (v3's bars by reference; v4 pricing) |
| Prompt | `case_investigation_prompt_v3`, sha256 `ebee491dab80316c1219b95e546c226c5d3b9254d67fce3862d35e86e3837219` (unchanged) |
| Request | `claude-sonnet-5-5`, `temperature` omitted, `between_tools`, 1,500 output tokens, 30 s timeout, zero retries |
| Corpus manifest | `scripts/evaluation/artifacts/case-investigation-v4/corpus-manifest.json`, sha256 `b676bfec161b4b2dbc5aa7c010016ef93267a9fd554aa0222bf927b459ded81f` |
| Corpus content | 169 case files copied byte for byte from v3; 111 eligible; entries and census identical. Only `caseInvestigationClient.ts`'s source pin moved |
| Labels | `scripts/evaluation/artifacts/case-investigation-v4/labels.json`, digest `987ba91c8be621706081fee76919d2f69014787ea6dfc33ea861d4121558ba86`, carried verbatim from v3 `80d4c874…` |
| Preflight freeze | `8586731d6c098f5180f03a909032e6fbe9b13baeb2aea8511a6e2350759c90dc`. Evidence `case-investigation-v4-corpus-r2-20261101/` and `case-investigation-v4-preflight-r2-20261101/`, outside the repository |

An earlier freeze (`e992ae47…`, directories without `-r2`) is superseded. CI's import-boundary guard refused its adapter import, so the adapter now states the model difference itself, and no guard was widened. Its source pin moved, and all 111 request bodies and request digests are identical across the two freezes, so the probe and proofs below still apply. It was never run.

## Zero-call preflight (2026-11-01): pass

Run with no provider credential in the environment.

| Proof | Result |
|---|---|
| Cases, call cap, estimated maximum | 111; 134; $2.16 against the $3 ceiling |
| Sonnet 4.6 bodies reproduce v3's frozen body digests | 111 of 111 |
| A v4 body differs from a 4.6 body only in `model`, `temperature`, `thinking` | 111 of 111 |
| Requests built without reading labels are identical; label-only markers in a request | identical; 0 |
| Stub rehearsal through the production runner and adapter | 111 stub calls, sent bytes equal the freeze, 0 real calls |
| `case_investigation` ceiling with every switch on; 5.5 in the production model list | `disabled`; no |
| Database or durable-record reach from the harness | none (guard test) |
| v2 and v3 bars digests; committed v2 and v3 artifacts and runbooks | unchanged |

The v3 harness now refuses its corpus, because the pinned adapter changed: v3 cannot be reused by accident. The Sonnet 4.6 request is still byte-identical, which the proof above shows.

## Commands (zero-call except the run)

```text
qualifyV2.ts derive-corpus --contract v4 --from <r3 dir> --out <r4 dir>
qualifyV2.ts carry-labels  --contract v4 --corpus <r4 dir> --v3-labels <v3 labels.json> --out <labels.json>
qualifyV2.ts preflight     --contract v4 --corpus <r4 dir> --labels <labels.json> --v3-freeze <v3 preflight dir> --out <dir>
qualifyV2.ts run           --contract v4 --corpus <r4 dir> --labels <labels.json> --freeze <dir> --out <dir> --confirm-paid-run      (exactly once)
qualifyV2.ts grade-independent --contract v4 --labels <labels.json> --run <dir> --out <file>
qualifyV2.ts grading-packet / score --contract v4 ...
```

`grade-independent` applies the frozen scorer with the best grade every valid answer could receive. Any failure it reports is final whatever the graders decide. An empty result passes nothing: the graded bars still need two independent reviews, and Eric Martin decides every disagreement.

Pins are on-disk CRLF bytes, so run this on a Windows checkout whose pinned files came from `git checkout`.
