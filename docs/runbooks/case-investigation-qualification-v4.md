# Case Investigation qualification contract v4 (`case_investigation_qualification_v4`)

**Status: closed 2026-11-01. The single qualification run FAILED** (see [Qualification run result](#qualification-run-result-2026-11-01-fail)). **Case Investigation is MODEL-BLOCKED / PARKED**, and the workflow stays `disabled`. The terms below were frozen before the run and were not changed after it. [v2](case-investigation-qualification-v2.md) and [v3](case-investigation-qualification-v3.md) FAILED on `claude-sonnet-4-6`. Those results are final and are not reinterpreted here.

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

## Qualification run result (2026-11-01): FAIL

The single paid run was made exactly once under the frozen identities. There were no retries, replacement cases or exclusions.

| Identity | Value |
|---|---|
| Preflight freeze | `8586731d6c098f5180f03a909032e6fbe9b13baeb2aea8511a6e2350759c90dc`. Zero calls; 111 cases; call cap 134 |
| Commit | Run from `662983c`, public before the run started. It began before PR #282 merged, while CI was still running. Merged as `775ea03`; every pinned source, the manifest, the labels and the harness have identical blobs on main |
| Evidence | `case-investigation-v4-qualification-20261101/`, outside the repository. `SHA256SUMS.txt` lists all 9 artifacts |

**Run:** 111 calls, an upper-bound spend of $1.27, and no halt. Every response came from `claude-sonnet-5-5` and ended with `end_turn`. There were no timeouts, refusals or truncations.

| | `validator_failure` (81) | `conflict` (30) | v4 bar |
|---|---|---|---|
| Accepted | 79 | **30** | — |
| Invalid share | 0.025 ✓ | 0.000 ✓ | ≤ 0.05 |
| Invented numbers | **1** ✗ | 0 ✓ | 0 |
| Wrong references, unoffered actions | 0 / 0 | 0 / 0 | 0 |
| Median / p95 latency | 5.2 s / 7.8 s ✓ | 4.8 s / 7.9 s ✓ | ≤ 15 s / ≤ 25 s |
| USD per investigation | 0.0122 ✓ | 0.0094 ✓ | ≤ 0.03 |
| Top-1 on ranking cases (baseline) | **2/3** (3/3) ✗ | 12/12 (12/12) ✓ | ≥ 0.90 and ≥ baseline |

**Verdict: FAIL**, final for v4. Activation requires both classes, and `validator_failure` fails a hard bar and the top-1 bar. The graded bars were not graded, because grades cannot change the verdict: `grade-independent.json` applies the frozen scorer with the best possible grade on every valid answer, and it still fails. The packet for the 109 valid answers is preserved with the evidence.

`conflict` passed every mechanical bar. That is an observation only: it does not qualify anything, because activation is all-or-nothing.

**Diagnosis (read-only, after the run):** this is genuine model behaviour under the frozen contract. No implementation defect was found.
- **The invented number.** The answer wrote the difference between two amounts in the evidence. The subtraction is correct, but the figure appears nowhere in the transmitted payload or provenance, and the rule is that every number must appear in the context. v3 recorded this kind of derived figure, and the owner kept the rule strict.
- **The top-1 miss.** A valid answer on a `SOURCES_NO_CONTRACT` finding ranked `open_linked_documents` above `upload_document`, which is both the frozen label and the deterministic baseline.
- **The other invalid answer.** It cited 14 records against the cap of 12. This is within the 5% invalid bar and is not a cause of the FAIL.

**Observations.** These are not changed and not proposed here.
- Sonnet 5.5 corrected 24 of v3's 26 invalid answers. The 2 still invalid are the same 2 cases v3 rejected. The top-1 miss is new: v3 ranked that case correctly.
- Each failing bar turns on one case. On this corpus the top-1 requirement is 1.00 over only 3 `validator_failure` ranking cases. A near miss is still a FAIL.

## Case Investigation state: MODEL-BLOCKED / PARKED

| Contract | Model | Result |
|---|---|---|
| v2 | `claude-sonnet-4-6` | FAIL (latency, invalid answers; defects later fixed for v3) |
| v3 | `claude-sonnet-4-6` | FAIL (invalid share 0.321, 4 invented numbers) |
| v4 | `claude-sonnet-5-5` | FAIL (1 invented number, top-1 2/3) |

- **Production:** `case_investigation` stays `unqualified` with its code ceiling `disabled`, so it cannot run whatever its switch, entitlement, data policy or cap say. `FORGEWING_QUALIFIED_MODELS` is unchanged. Nothing was activated, and the worker stays undeployed.
- **The deterministic investigation is unaffected:** it still runs for every case without a provider.
- **The merged adapter change is inert in production:** the Sonnet 4.6 body is byte-identical (111 of 111), and the route refuses `claude-sonnet-5-5` as an unqualified model.
- **No implementation defect remains** that explains this result.
- **Reopening** requires a materially different model or a separately approved qualification contract. No v5 prompt tuning, weakened bar, or change to labels or corpus follows from this result, and no other model is tried without separate approval.
