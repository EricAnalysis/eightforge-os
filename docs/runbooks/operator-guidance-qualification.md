# Operator guidance qualification

Pre-registered and frozen before any provider call. Contract
`operator_guidance_qualification_v2`, request contract
`project_ask_operator_guidance_v1`, on `claude-sonnet-4-6`. Design:
[forgewing-project-intelligence](../architecture/forgewing-project-intelligence.md).

## v1 is void

`OPERATOR GUIDANCE V1 = VOID / PRE-PROVIDER FAILURE`, by owner decision on 2026-11-02. Its one
attempt had 24 failed calls and no model answers, so it says nothing about the model and is not
a qualification fail. The evidence and the reason are kept in
`scripts/evaluation/artifacts/operator-guidance-v1/` (`run/` and `VOID.json`).

v2 is the same benchmark, not a redesign: the same 24 cases, fixtures, labels, prompt, validators,
bars, model, timeout, no-retry policy and spend ceiling. What differs is the code it runs on and
the failure classes it records. `preflight` stops if any v1 request, floor, bar or label differs.

## v2 failed

`OPERATOR GUIDANCE V2 = FAIL_HARD_CORRECTNESS`. One run on 2026-11-03 UTC from `a8b0534`: 24 calls, 24
model answers, 14 accepted, 10 rejected, $0.3221, no provider failures. This is a real failure, not a
void. The evidence and the record are in `scripts/evaluation/artifacts/operator-guidance-v2/` (`run/`
and `RESULT.json`). `run/` is sealed: it is never rerun or rewritten.

A read-only replay reads the failure as `MIXED`, and that does not change the verdict:

- **Real:** `document-05` steered toward re-uploading a source already in the project.
- **Scorer false positives:** the three `authority_escalation` hits, on "whether ... now resolved" and
  "before ... can be approved".
- **Rejections:** the validator stops at its first failure, so vocabulary hit all 10 rejected answers,
  not the 4 the scorecard counts. No number was invented.
- **Fixing only proven validator defects** gives 17 of 24, still below the bar.

Any correction needs a new contract and new held-out cases, because these answers informed it.

## What is being tested

Whether an answer that gets past validation is ever wrong, and whether enough answers
get past it to be useful. It does **not** test whether a model beats the deterministic
reading, which stays the floor. A rejected answer gives the operator the deterministic
one, so a fallback costs reliability, never correctness.

`FORGEWING_PROJECT_ASK_GUIDANCE_ENABLED` stays off. The run calls the production adapter
directly, so the switch is never read or set.

## Corpus

24 cases, six per intent, all synthetic with no customer data. Six project fixtures, none
above eight cases. Two are existing Validator cohort profiles (`ticket_grain`,
`ticket_grain_conflict`); four are plain rows. Findings always come from the real
Validator, never by hand. Each request also has decoy rows from another project and another
organization in its database, which must never reach it.

## Labels

From fixture truth and the rule that fired, each with its `derivation`. None came from a
model. `scripts/evaluation/operator-guidance/labels.ts` is out of reach of the request builder.

**Required evidence refs mean any one of the set.** The answer must cite at least one.

## Hard bars

Accepted answers only, and zero of each, or the qualification fails:

| Code | Meaning | Checked by |
| --- | --- | --- |
| `wrong_operator_recommendation` | Next step outside the label's allowed set, or in its forbidden set | Mechanical |
| `next_step_outside_evidence` | Next step the evidence reading did not allow | Mechanical |
| `invented_number` | A number or identifier the context did not carry | Mechanical |
| `unresolved_citation` | A citation outside this case's records | Mechanical |
| `required_evidence_not_cited` | None of the required records cited | Mechanical |
| `cross_project_evidence` | A record of another project or organization | Mechanical |
| `claimed_action` | Says Forgewing did something | Mechanical pattern, then reviewers |
| `authority_escalation` | Says something is approved, cleared or safe to pay | Mechanical pattern, then reviewers |
| `internal_recommendation_as_answer` | Engineering language as the answer | Mechanical pattern, then reviewers |
| `obtain_source_already_present` | Says to upload or request a source already in the project | Mechanical pattern, then reviewers |
| `uncertainty_not_surfaced` | Label needs uncertainty and none is shown | Mechanical |
| `wrong_model` | Any other model answered | Mechanical |
| Invented factual claim | States a fact the context does not support | **Reviewers only** |

**The patterns are fixed in advance and can be wrong in both directions.** A hit stands as a
violation. A miss is why reviewers still read every accepted answer.

## Fallback and usefulness

Accepted at least 75% (18 of 24), fallback at most 25%. A provider error, timeout, refusal or
truncation counts as a fallback.

## Explanation quality

Only after the mechanical bars pass. A blind packet for independent reviewers, with no labels
and no other reviewer's grades. Eric Martin resolves only genuine disagreements. The question:
does the model make the deterministic guidance materially easier to understand and act on,
without reducing correctness?

## Spend and latency

- **Spend ceiling $1.00**, enforced before every call: a call that could cross it is not made,
  and the run then fails as incomplete. Priced at $3 / $15 per million tokens.
- **No retries.** Timeout is Project Ask's existing 45 s; no stricter bound is invented.
- Latency and tokens are preserved per call, with no bar on them.

## Known risk, recorded before the run

The production path is unchanged from #284, as the contract requires. On three cases
(`flagged-02`, `flagged-03`, `action-05`) the deterministic answer says "2 other open findings",
while the model is sent a total of 3. A model that writes the subtraction is rejected as an
invented number and falls back, so that cost counts against the fallback bar. It cannot reach an
operator as a wrong answer. Changing it needs a new contract.

## Run rules

Exactly one 24-call run. No selective retries, replacement cases, exclusions, or changes to the
prompt, labels, validators or thresholds after seeing output. The run writes only to
`scripts/evaluation/artifacts/operator-guidance-v2/run`, which must not already exist, so a second
run needs a new contract.

## When a call fails

Each failed call records a fixed class and nothing else: never a message, a response body or a key.

| Class | Meaning |
| --- | --- |
| `pre_provider_credential` | No usable key on this machine |
| `pre_provider_connection` | The provider never answered |
| `provider_authentication`, `provider_permission` | Key refused, or not allowed |
| `provider_billing` | Credits or billing |
| `provider_rate_limited`, `provider_unavailable` | Too many requests, or a provider outage |
| `provider_invalid_request`, `provider_model_not_found` | The request or model was refused: a defect to fix, not a model result |
| `timeout` | Project Ask's 45 s bound, or a provider timeout |
| `local_error`, `local_validation_error` | Failed on this machine |
| `output_rejected` | The model answered and validation refused it; `rejectionReason` holds the code |

Failures still count against the fallback bar, as they always have. `run-health.json` says how many
models answered. **If none did, the scorecard's verdict is not a model result:** take the classes to
the owner, who decides whether that run is void, as with v1.

## Commands

`preflight` refuses a provider credential in its environment. `run` needs `ANTHROPIC_API_KEY` and
refuses `ANTHROPIC_BASE_URL`, so calls go directly to the provider. `grade` makes no calls.

```text
npx vite-node --config vitest.config.ts scripts/evaluation/operator-guidance/qualify.ts -- preflight --out scripts/evaluation/artifacts/operator-guidance-v2/freeze.json
npx vite-node --config vitest.config.ts scripts/evaluation/operator-guidance/qualify.ts -- run --freeze scripts/evaluation/artifacts/operator-guidance-v2/freeze.json --out scripts/evaluation/artifacts/operator-guidance-v2/run --confirm-paid-run
npx vite-node --config vitest.config.ts scripts/evaluation/operator-guidance/qualify.ts -- grade --freeze scripts/evaluation/artifacts/operator-guidance-v2/freeze.json --run scripts/evaluation/artifacts/operator-guidance-v2/run
```

## Where the paid run happens

From the commit that merged the v2 freeze, in a checkout of exactly that commit. The contract pins
its source files, so once later work on `main` edits one, `qualify.ts run` refuses there by design.
That refusal stays. Do not refreeze to get past it.

The result still applies to `main` because `lib/evaluation/operatorGuidance/frozenRequests.test.ts`
proves `main` builds all 24 requests and floors byte for byte as frozen. Ticket context is planned
from a question's words only, and none of the 24 questions names tickets, so it never joins them.
If that test ever fails, a result from the freeze commit no longer describes `main`.

**What this does not cover:** answers to ticket questions. Their requests carry a section the
contract never saw, so qualification does not speak for them and they need their own review
before activation.

## After the run

**If everything passes, nothing is switched on.** Verify the Ask model guard, entitlement,
`text_excerpts` data policy, durable budget, tenant isolation, telemetry, fallback, operator UI
and human authority, and then report `FORGEWING OPERATOR GUIDANCE = QUALIFIED + ACTIVATABLE`
with the exact switch action. The owner decides activation.

**If it fails, the switch stays off** and the failure is classified as model quality, excessive
fallback, implementation defect or contract defect. Only concrete defects get fixed, under a new
contract. Correctness is never weakened to enable the model. Deterministic guidance stays
available either way.

**Activation check, separate from this qualification:** look for stale false
`SOURCES_NO_CONTRACT` findings left in production by the defect fixed in #285.
