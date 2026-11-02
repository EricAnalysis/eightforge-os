# SOURCES_NO_RATE_SCHEDULE reachability and retirement (2026-11-01)

Audited at `f873c3f`, then retired on owner instruction. Line numbers before "Retirement"
are from before the removal.

| Question | Answer |
| --- | --- |
| Reachable? | **Unreachable** on production input |
| Kind of defect | **Rule defect.** Not a source-classification defect, and not a false suspicion |
| Operator impact | None: `FINANCIAL_RATE_BASED_SCHEDULE_REQUIRED` fires instead |
| Would fixing it to fire help? | No. It would only add a second critical finding |
| Outcome | Evaluation branch **retired**; history stays readable |

Production history was not read. It is not needed: the rule did not emit on production
input, so there is nothing to repair, and historic rows stay displayable.

## The claim, tested

> Whenever a contract exists, the pricing-source list includes the contract itself,
> making `SOURCES_NO_RATE_SCHEDULE` unreachable.

**The conclusion holds. The premise needed narrowing.** "A contract exists" has to mean a
document in `contract_identity`, meaning a base or replacement contract. A project whose
contract family holds only an amendment has an empty `contract_identity`, and possibly an
empty `pricing` list, but then `hasContract` is false, so the rule was blocked there.

## Exact conditions

The rule fired only when all of these held:

1. `contract_identity` is non-empty.
2. Pricing is required: a rate-based ceiling, a schedule-present fact, or a row count above zero.
3. `hasRateScheduleFacts` is false.
4. `pricing` and the `rate_sheet` family are both empty.

Conditions 1 and 4 cannot both be true on production input, because `contract_identity`
is always a subset of `pricing`:

- `resolveDocumentTruthCategoryIds` adds `...contractIdentity` to `pricing` and strips the
  same duplicates from both lists (`documentPrecedence.ts:919-925`).
- `buildDocumentIdsByFamily` only narrows `contract_identity` and only adds to `pricing`,
  removing the same duplicates (`projectValidator.ts:1586-1617`).
- It is the only production builder; `deriveValidatorSourceSnapshot` and
  `buildValidatorInputFromSourceSnapshot` pass its result through.

## Why it was a rule defect

**`pricing` is a list of places to look for rates. It does not mean "a schedule exists".**
Its other consumers all use it that way, and they need the contract in it because
contracts often hold their own rate exhibit:

- Rate fact lookup (`rateFactDocumentIds` in `buildFactLookups`).
- Rate authority candidates and reviewed-rate documents (`projectValidator.ts`).
- Support matching (`crossDocumentRateVerification.ts:392-397`).
- A resolver test pins the order: `['exhibit-a', 'base-contract']` (`documentPrecedence.test.ts:499`).

So the classification is correct, and taking the contract out of `pricing` would break
rate lookup. The rule was what misread the list, as evidence of presence.

## Why correcting it would have added nothing

Asking the rule's question properly, without counting the contract as a schedule, adds no
coverage:

- `RATE_SCHEDULE_FACT_KEYS` contains every schedule-present and row-count key, so a true
  present fact or a positive count already makes `hasRateScheduleFacts` true.
- That leaves one way to reach the condition: a rate-based contract with no schedule facts.
  `rateSchedulePresent` is then not `true`, so `FINANCIAL_RATE_BASED_SCHEDULE_REQUIRED`
  fires (`rateBasedContractValidation.ts:313-318`).

## Retirement

Removed from `requiredSources.ts`: the evaluation branch and the three variables only it
used. Nothing else in the Validator changed.

Kept, so recorded findings stay displayable and auditable: the catalogue entry, the approval
gate reason, finding semantics, the `truthEngine` checks, the field map in `shared.ts`, and
the rule's place in `SOURCE_NEED_BY_RULE`. `ruleExplanations.test.ts` now lists it as a legacy
rule, the same way as `FINANCIAL_RATE_NOT_IN_SCHEDULE`.

Not done, by instruction: no change to historical rows, no migration, no replacement rule, no
change to `FINANCIAL_RATE_BASED_SCHEDULE_REQUIRED`, source classification, authority or
severity. No production repair is needed.

## Evidence

| Test | Covers |
| --- | --- |
| `requiredSourcesReachability.test.ts` | 7,680 project shapes through the real resolvers: `contract_identity` is always a subset of `pricing`, and the branch emits nothing, even on a hand-built `pricing: []`. The other required-source rules and the dedicated rule still fire. Historical rows still explain, display and normalize |
| `requiredSourcesFactsPath.test.ts` | 72 shapes through the real `runProjectValidation`, with real facts: never emitted. Everywhere a corrected rule would fire, the dedicated rule already does. A contract holding its own rates needs no separate schedule |
| `approvalGate.test.ts` | A recorded finding keeps its gate reason |

The hand-built case failed before the removal (it fired) and passes after it.

One existing test depended on the impossible input. `issueDisplayFormatter.test.ts` hand-built
a contract with `pricing: []` and expected 3 required-source findings, one of them this rule.
It now names the 2 remaining rules. The audit first missed this because the test counts
findings without naming the rule ID, so it is the one test that did show the rule firing, and
only on input production cannot build. No test expectation for a Golden count moved, and no
other Validator count moved.

## Also noted

`factLookups.pricingContextDocumentIds` is built but has no production reader.
