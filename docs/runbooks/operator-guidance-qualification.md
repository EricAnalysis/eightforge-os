# Operator guidance qualification

Pre-registered and frozen before any provider call. Contract
`operator_guidance_qualification_v3`, request contract
`project_ask_operator_guidance_v2`, on `claude-sonnet-4-6`. Design:
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

Final disposition: `FAIL_HARD_CORRECTNESS / MIXED`. One run on 2026-11-03 UTC from `a8b0534`: 24 calls, 24
model answers, 14 accepted, 10 rejected, $0.3221, no provider failures. This is a real failure, not a
void. The evidence and the record are in `scripts/evaluation/artifacts/operator-guidance-v2/` (`run/`
and `RESULT.json`). `run/` is sealed: it is never rerun or rewritten.

A read-only replay reads the failure as `MIXED`, and that does not change the verdict:

- **Real:** `document-05` steered toward re-uploading a source already in the project. `document-04`
  advised a contract link the rule does not need. `action-02` promised that linking "will resolve" the
  finding and "unblock" the project, though it was rejected for other reasons.
- **Scorer false positives:** the three `authority_escalation` hits, on "whether ... now resolved" and
  "before ... can be approved".
- **Rejections:** the validator stops at its first failure, so vocabulary hit all 10 rejected answers,
  not the 4 the scorecard counts. No number was invented.
- **Fixing only proven validator defects** gives 17 of 24, still below the bar.

Any correction needs a new contract and new held-out cases, because these answers informed it.

## What v3 changes

v3 fixes concrete defects found in v2. No bar is lowered. The prompt, model, temperature, timeout,
no-retry policy, $1.00 ceiling, output schema and next-step vocabulary are all v2's, and so are the
production vocabulary, authority-claim and obtain-source patterns.

| Phase | Correction | Where |
| --- | --- | --- |
| B | The action link opens what the recommendation names: a source reading's own source, or otherwise the finding's evidence. **Not behind the switch** | `nextStepActionHref` |
| C | The copy sent to the model uses operator terms, from one seam. Canonical values, stored records and telemetry keep their codes, and validation stays as strict, so an uncovered identifier still falls back. The bare word `canonical` stays rejected, and the fix is that the model is no longer sent it | `operatorTerms.ts` |
| D | The reading sends the real production next step as `deterministicNextStep`. Its `kind` stays in the vocabulary the model must answer in | `guidanceTransmittedContext` |
| E | Guidance's own number check. Digits inside a UUID, hash, identifier, title or timestamp support nothing. List markers, ordinal words and `Finding N` up to the open count are ignored, and dates match across safe formats. Critical, warning and total counts are sent, and a count stated about the findings must equal them. Anything else not sent is rejected. Case Investigation's helper is not edited | `guidanceUnsupportedNumbers` |
| F | `authority_escalation` reads actual claims ("this is approved", "the finding is cleared", "I approved this") and ignores conditions ("check whether it is resolved", "before the invoice can be approved") | `authorityEscalationIn` |
| G | New hard bar `promised_outcome`, apart from authority | `promisedOutcomeIn` |
| I | New hard bar `unsupported_relationship_advice`: advice that a link is needed, where the reading never offered linking | `unsupportedRelationshipAdviceIn` |
| H | The run record and scorecard gain `allRejectionReasons`. Accept or reject behaviour does not change | `guidanceRejectionReasons` |

**The scorer patterns stay out of production for v3 and must move there before activation** (owner
decision). A passing sample does not stop a future hit from being shown.

## What is being tested

Whether an answer that gets past validation is ever wrong, and whether enough answers
get past it to be useful. It does **not** test whether a model beats the deterministic
reading, which stays the floor. A rejected answer gives the operator the deterministic
one, so a fallback costs reliability, never correctness.

`FORGEWING_PROJECT_ASK_GUIDANCE_ENABLED` stays off. The run calls the production adapter
directly, so the switch is never read or set.

## Corpus

24 new cases, six per intent, all synthetic with no customer data, on six project fixtures of their
own, none above eight cases. They cover a source genuinely missing, present, unread, and with an open
relationship, a likely EightForge issue, human judgment, no action needed, several open findings, ticket
evidence, source-family ambiguity and an already-correct project. Findings always come from the real
Validator, never by hand. Each request also has decoy rows from another project and another organization
in its database, which must never reach it.

**v1 and v2's 24 cases are regression evidence only.** v3's corrections were derived from their answers,
so they are never called in a run and never count towards a result.
`scripts/evaluation/artifacts/operator-guidance-v3/regression-v2-answers.json` holds v2's saved answers
under v3, and `qualify.ts regression` rebuilds it with zero calls.

**Questions naming tickets stay outside this contract.** Their requests carry a section it never saw, so
ticket evidence is covered through ticket findings, with questions that do not name tickets.

**Disclosure:** the author of these cases had read v2's answers, and `heldout-document-01` deliberately
tests the re-upload class again, with a different fixture and wording. The model has seen none of them,
and the prompt is unchanged. `heldout-missing-02` and `heldout-document-04` carry `openForAdjudication`,
where deterministic truth alone leaves a real question. Their labels follow the reading.

## Labels

From fixture truth and the rule that fired, each with its `derivation`. None came from a
model. `scripts/evaluation/operator-guidance/labels.ts` is out of reach of the request builder.

**Required evidence refs mean any one of the set.** The answer must cite at least one, and
`preflight` stops if the deterministic floor itself would not.

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
| `promised_outcome` | Says a step will resolve, clear or unblock something the reading does not guarantee | Mechanical pattern, then reviewers |
| `unsupported_relationship_advice` | Says a document link is needed where the reading never offered linking | Mechanical pattern, then reviewers |
| `internal_recommendation_as_answer` | Engineering language as the answer | Mechanical pattern, then reviewers |
| `obtain_source_already_present` | Says to upload or request a source already in the project | Mechanical pattern, then reviewers |
| `uncertainty_not_surfaced` | Label needs uncertainty and none is shown | Mechanical |
| `wrong_model` | Any other model answered | Mechanical |
| Invented factual claim | States a fact the context does not support | **Reviewers only** |

**The patterns are fixed in advance and can be wrong in both directions.** A hit stands as a
violation. A miss is why reviewers still read every accepted answer.

## Fallback and usefulness

Accepted at least 75% (18 of 24), fallback at most 25%, counted on the held-out cases alone. A provider
error, timeout, refusal or truncation counts as a fallback.

## Explanation quality

Only after the mechanical bars pass. A blind packet for independent reviewers, with no labels
and no other reviewer's grades. Eric Martin resolves only genuine disagreements. The question:
does the model make the deterministic guidance materially easier to understand and act on,
without reducing correctness?

## Spend and latency

- **Spend ceiling $1.00**, enforced before every call: a call that could cross it is not made,
  and the run then fails as incomplete. Priced at $3 / $15 per million tokens. `preflight` projects
  spend from what v2 actually cost, scaled by request size. The maximum is the ceiling.
- **No retries.** Timeout is Project Ask's existing 45 s; no stricter bound is invented.
- Latency and tokens are preserved per call, with no bar on them.

## Known risks, recorded before the run

- **v3 can fail, and might.** `document-05`'s error and `action-02`'s promise were model behaviour.
  C4 and C5 give them a fair test, not a pass.
- **A recital can hit.** An answer quoting a finding's "attach or extract" text where the source is
  present fires `obtain_source_already_present`, and it stands.
- **The promise bar is narrow.** "so the system can ... clear the critical finding" does not match.
  Reviewers cover what patterns miss.
- **Floor wording.** On the reference-only state the floor says "check whether it is linked" although
  it is attached, and C4 now sends that to the model. Floors also show labels such as
  "Document link: attached_to" to operators. Neither changes here.
- **Production coverage.** The translation is proven on these 48 requests. Other rules may send
  identifiers it does not cover, which fall back safely.
- **Numbers written as words are not read.** "Two critical findings" is not checked. Reviewers read every
  accepted answer.
- **A partial title can fall back.** "Invoice 7" for a document titled "Sample Invoice 7" is read as a
  bare 7, which is safe and costs a fallback.

## Run rules

Exactly one 24-call run, and only on a fresh owner instruction after the freeze is reported. No
selective retries, replacement cases, exclusions, or changes to the prompt, labels, validators or
thresholds after seeing output. The run writes only to
`scripts/evaluation/artifacts/operator-guidance-v3/run`, which must not already exist, so a second
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
npx vite-node --config vitest.config.ts scripts/evaluation/operator-guidance/qualify.ts -- preflight --out scripts/evaluation/artifacts/operator-guidance-v3/freeze.json
npx vite-node --config vitest.config.ts scripts/evaluation/operator-guidance/qualify.ts -- run --freeze scripts/evaluation/artifacts/operator-guidance-v3/freeze.json --out scripts/evaluation/artifacts/operator-guidance-v3/run --confirm-paid-run
npx vite-node --config vitest.config.ts scripts/evaluation/operator-guidance/qualify.ts -- grade --freeze scripts/evaluation/artifacts/operator-guidance-v3/freeze.json --run scripts/evaluation/artifacts/operator-guidance-v3/run
```

## Where the paid run happens

From the commit that merged the v3 freeze, in a checkout of exactly that commit. The contract pins
its source files, so once later work on `main` edits one, `qualify.ts run` refuses there by design.
That refusal stays. Do not refreeze to get past it.

`preflight` proves what v3 did not set out to change: before its corrections, v2's 24 requests are
byte for byte the same, 22 floors are identical, the other two differ only in their action link, the
v1 and v2 evidence matches its digests, and the Case Investigation runner is the one v2 froze.
`lib/evaluation/operatorGuidance/frozenRequests.test.ts` holds the same on `main`, and holds the 24
held-out requests to the freeze. Ticket context is planned from a question's words only, and none of
these questions names tickets, so it never joins them.

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
