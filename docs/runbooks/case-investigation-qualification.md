# Case Investigation qualification contract (`case_investigation_qualification_v1`)

**Status: APPROVED by the owner on 2026-10-15. NOT RUNNABLE: the approved corpus is below the minimum case
counts (see Corpus census). No provider call has been made under this contract.**

This contract follows the B4.6 / B4.6.1 and Phase 17 discipline: the bar is fixed before any live call, and
observed results never change it. The `case_investigation` policy ceiling in `lib/server/forgewingGates.ts`
stays `disabled` until this contract records a PASS.

## What is qualified

The workflow is Forgewing case investigation (P3b, `lib/server/caseInvestigationRunner.ts`):
- an operator-invoked, non-authoritative explanation of one Validator finding;
- a ranking of that case's own navigation and typed-path actions, chosen from `open_document`,
  `link_invoice_line_rate`, `upload_document` and `open_linked_documents`.

Nothing in this workflow writes truth, clears a finding, approves a relationship, or names an outcome.
Qualification measures quality; it grants no authority.

## Baseline

The baseline is the deterministic B6 investigation (P3a, `lib/resolution/caseInvestigation.ts`):
- the catalogue explanation;
- catalogue-order ranking behind the primary workflow;
- `conflicting_evidence_unchosen` on the three conflict rules.

Forgewing must beat the baseline on the soft bars and must never regress below it on a hard bar.

## Classes

The two classes are never pooled.

| Class | Rules | Minimum cases |
|---|---|---|
| `validator_failure` | Every catalogue rule except the three below | 40 |
| `conflict` | `TRANSACTION_TICKET_GRAIN_CONFLICT`, `CANONICAL_INVOICE_IDENTITY_CONFLICT`, `CANONICAL_GOVERNING_RELATIONSHIP_CONFLICTING` | 20 |

A class with fewer cases, or with unlabelled cases, is `not_qualified` and blocks activation. Activation is
all-or-nothing for the workflow.

## Corpus

- **Projects:** Golden, Hillsdale and DN.
- **Eligible cases:** open Validator findings that the resolution queue turns into cases
  (`lib/resolution/resolutionCases.ts`).
- **Frozen before any provider call:**
  - each case's identity;
  - its `transmittedDigest`, under the provider purpose with the approved content classes;
  - the Validator rule-catalogue fingerprint;
  - the investigation-context version.

### Corpus census (2026-10-15, read-only production query)

| Project | Open findings | Of which in the `conflict` class |
|---|---|---|
| Golden Project | 0 (all 362 findings are resolved or dismissed) | 0 |
| B4.6 Golden source qualification | 4 | 0 |
| B4.6 Hillsdale source qualification | 1 | 0 |
| B4.6 DN source qualification | 0 | 0 |
| **Approved corpus total** | **5 (minimum 40)** | **0 (minimum 20)** |

No finding for any of the three conflict rules exists in any production project. Both classes would be
`not_qualified` under this contract, and a FAIL is final for the contract identity. So the run is blocked
before label creation and before any provider call, pending an owner decision on the corpus. Changing the
corpus is a contract change.

## Labels and reviewers

Two independent reviewers create the benchmark labels. Each reviewer independently assigns, for each case:
1. **Primary action:** the correct primary action kind from the case's rankable kinds, or `none`.
2. **Root cause:** one of `source_missing`, `extraction_error`, `contract_mismatch`,
   `relationship_or_precedence`, `genuine_exposure` or `other`.
3. **Faithfulness:** a score from 0 to 2.
   - 0 = contradicts the evidence or the catalogue
   - 1 = consistent but unhelpful
   - 2 = correct and specific

Rules for labelling:
- Reviewers do not see each other's answers before submission.
- Any disagreement goes to Eric Martin for final adjudication before the label set is frozen.
- AI reviewer output is supporting evidence. Eric Martin is the final human authority for disputed benchmark
  truth.
- Labels are scored against the evidence, never against a model reading.
- Labels are never altered after provider outputs have been seen.

## Request and pins

- **Model:** `claude-sonnet-4-6`.
- **Request settings:**
  - temperature 0;
  - `max_tokens` 1,500;
  - 15 s timeout;
  - `maxRetries: 0`;
  - prompt `case_investigation_prompt_v2`.
- **Pinned by sha256 at freeze:**
  - source files: `lib/server/caseInvestigationRunner.ts`, `lib/forgewing/runtime/caseInvestigationClient.ts`,
    `lib/resolution/investigationContext.ts` and `lib/server/investigationContextRead.ts`;
  - the prompt and the output schema;
  - the corpus manifest, the frozen labels and this contract's thresholds.

## Provider errors and timeouts

A provider error or timeout counts as an **invalid answer** within its class:
- there are zero retries, no replacement calls and no selective reruns;
- the case is never excluded from the denominator;
- it counts against the at-most-5% invalid-answer hard bar.

## Hard bars

All hard bars apply per class.

| Bar | Value |
|---|---|
| Ranked actions not offered by deterministic Core | 0 |
| Invented numbers | 0 |
| Wrong evidence references | 0 |
| Side-selection in a `conflict` case | 0 |
| Recommendations to approve, correct or override | 0 |
| Faithfulness-0 answers | 0 |
| Invalid answers, including provider errors and timeouts | at most 5% |
| Median latency | at most 6 s |
| p95 latency | at most 12 s |
| Cost per investigation | at most $0.03 |

Forgewing must never regress below the deterministic baseline on a hard bar.

## Soft bars

All soft bars apply per class.

| Bar | Value |
|---|---|
| Top-1 primary action | at least baseline + 10 percentage points, **and** at least 0.70 |
| Mean faithfulness | at least 1.6 |
| Root-cause agreement | at least 0.70 |

A class whose cases each offer only one rankable action scores top-1 trivially. That score is reported, but it
is not used for the ranking bar.

## Spend and run stop conditions

- **Safety spend ceiling:** $3.00 in total. This is a ceiling, not the cost threshold, which stays at
  $0.03 per investigation per class.
- **Call cap:** 1.2 × the number of cases.

A live run halts **only** when one of these happens:
- the call cap is reached;
- the spend ceiling is reached;
- continuing would violate an authority or data-policy boundary.

A hard-bar breach mid-run does **not** stop the run. Instead:
1. Record the breach.
2. Complete the remaining eligible cohort while the call and spend ceilings permit.
3. Produce a complete, final FAIL artifact.

## Promotion rule

- **PASS:** may support a reviewed PR that raises the `case_investigation` code ceiling. A PASS does not
  activate the capability for any organization. Production use still requires:
  - an entitlement event;
  - a `text_excerpts` data-policy approval;
  - a daily cap above 0;
  - all the normal Forgewing gates.
- **FAIL:** final for this contract identity. Any materially changed request or runtime requires a new,
  separately versioned contract and a full fresh cohort.

## Evidence

Run evidence is preserved under `scripts/evaluation/case-investigation/` and includes:
- the corpus manifest;
- the frozen labels and reviewer submissions;
- the per-case provider results (content digests, latency, tokens, cost);
- the final scorecard.
