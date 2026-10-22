# Case Investigation qualification contract v2 (`case_investigation_qualification_v2`)

**Status:** **closed 2026-10-22: the single qualification run FAILED** (see [Qualification run result](#qualification-run-result-2026-10-22-fail)). All 111 labels were frozen after Eric Martin adjudicated the 22 residual cases. The workflow stays `disabled`. Successor proposed: [v3](case-investigation-qualification-v3.md).

*History:* owner-directed 2026-10-15. Corpus constructed and census complete. Corpus r2: 111 eligible cases, of which 89 were labelled by reviewer agreement and 22 awaited Eric Martin's adjudication.

v2 is additive. [v1](case-investigation-qualification.md) stays exactly as recorded, as historical evidence:
- the production corpus was insufficient;
- the qualification was not run;
- no provider calls were made;
- no labels were fabricated;
- no thresholds were changed.

v2 differs from v1 **only where required to establish a valid corpus**. The following are v1's, unchanged:
- the classes and their minimums;
- the labels and reviewer process;
- the request and pins;
- the treatment of provider errors and timeouts;
- the hard bars and soft bars;
- the latency and cost limits;
- the spend ceiling;
- the run stop conditions;
- the promotion rule.

## What changes: the corpus

### `validator_failure` (minimum 40)

Cases are open Validator-finding cases from real production projects, read through the live context path.

- **v1 corpus, kept where eligible:** Golden, Hillsdale, DN.
  - Golden Project contributes nothing, because every finding there is resolved or dismissed.
- **Primary expansion source:** Goodlettsville.
- **Further expansion:** Bentonville, MVSU, TDOT. These are real production projects in the same organization.
- **Excluded until the underlying truth is resolved:** every Goodlettsville case whose source truth rests on its duplicate price sheet.
  - Background: the same physical price sheet was uploaded twice, and no operator disposition has been recorded.
  - Exclusion is decided by rule, from what the emitting rule pack reads, not from current outcomes. The excluded rules are the contract-rate, category, line-code and rate-code checks, and every exposure rule.
  - Any case that cites either price-sheet document is also excluded.
  - See `GOODLETTSVILLE_RATE_SCHEDULE_DEPENDENT_RULES` in `lib/evaluation/caseInvestigation/corpusV2.ts`.

### `conflict` (minimum 20)

Production holds no finding for the three conflict rules: they fire only in canonical truth-authority mode. So the conflict class comes from **deterministic fixtures that make the existing rules fire through their real path**. Each fixture is built as follows:

1. Persisted-shape source rows (transaction rows, invoice rows, governing-contract candidates) are resolved by `resolveProjectTruthAuthority` in canonical mode.
2. The real rule packs (`transactionGrainConflict`, `canonicalTruthIntegrity`) produce the findings.
3. Those findings become the project's open finding and evidence rows.
4. The provider context is then built by the live `readInvestigationContext` over those rows.

Nothing in a conflict, its evidence or its context is hand-written. The fixtures carry no customer content. They are versioned as `case_investigation_conflict_fixtures_v1` in `lib/evaluation/caseInvestigation/conflictFixtures.ts`.

The conflict invariant is unchanged: Forgewing may explain a conflict but may never choose a winner. That is a hard bar.

## Identity freeze

Every case is read through the **same server path the live capability uses**: `readInvestigationContext` → `readResolutionQueue` → the precedence snapshot.

- **Purpose and content class:** each case is read for `provider_investigation`, with exactly `text_excerpts` approved, which is the class activation requires.
- **Reviewer view:** each case is also read for `operator_review`, for the reviewers.
- **Production read-only by construction:** production is read through `readOnlyClient`. Only `.from(table).select(...)` is reachable; every write method and every RPC throws before a request is built.
- **Zero-call build:** the build refuses to run with provider keys in its environment.

The manifest pins:
- each case's `transmittedDigest` and `readDigest`;
- the Validator rule-catalogue fingerprint;
- the context version, the prompt version and the approved content classes;
- the sha256 of the runner, client, context builder, context read, deterministic investigation, fixtures and corpus policy.

A change to any pin after labelling invalidates the frozen corpus.

## Corpus census (built 2026-10-15)

| Class | Eligible | Minimum | Sources |
|---|---|---|---|
| `validator_failure` | **85** (r1; **81** after correction r2) | 40 | Goodlettsville 46, TDOT 16, MVSU 7, Bentonville 6, B4.6 Golden 6, B4.6 Hillsdale 3, B4.6 DN 1 |
| `conflict` | **30** | 20 | Ticket grain 11, invoice identity 7, governing relationship 12 (fixtures) |
| Excluded | 54 | — | All Goodlettsville rate-schedule-dependent cases |

Both minimums are met.

The distribution is the real one:
- Goodlettsville's `TRANSACTION_GROUP_EXISTS_FOR_INVOICE_LINE` (19 cases) and `contract_ceiling_missing` across projects (14) dominate.
- Several cases offer a single rankable action, so their top-1 score is reported but, as in v1, not used for the ranking bar.

The manifest of identities and digests only is `scripts/evaluation/artifacts/case-investigation-v2/corpus-manifest.json`. The case contexts contain customer text and are kept outside the repository.

## Labels

Labels are created in two phases. Both use two independent reviewers who do not see each other's answers, and no provider output is used to establish benchmark truth.

1. **Before any provider call, frozen with the corpus:** for each case, the correct primary action (from the case's rankable kinds, or `none`) and the root cause (`source_missing`, `extraction_error`, `contract_mismatch`, `relationship_or_precedence`, `genuine_exposure`, `other`).
2. **After the run (scoring, not truth):** the 0–2 faithfulness grade of each diagnosis against the frozen evidence, and the reviewer-judged hard bars (side-selection, a recommendation to approve, correct or override).

Rules for both phases:
- Any disagreement goes to **Eric Martin** for final adjudication before the label set is frozen.
- AI reviewer output is supporting evidence.
- Labels are never altered after provider outputs have been seen.

## Run order

The run proceeds in this order:
1. Corpus constructed.
2. Census complete.
3. Independent labels.
4. Disagreements resolved.
5. Identities frozen.
6. Zero-call preflight.
7. Paid run.

Steps 1 and 2 are done. The run happens only if every minimum is still met.

## Phase-1 label status (2026-10-15)

Two independent reviewers, AI on different models, labelled all 115 eligible cases from the frozen packets. Their output is supporting evidence only.

**Packets.** Each packet holds the operator-visible evidence: problem, expected-versus-found state, evidence labels, sibling findings, relationships, reviewed values and offered actions.
- The deterministic Validator investigation was withheld, so that labels are not anchored on current Validator output.
- Source-document text was not included.

**Agreement.**
- **Primary action:** the reviewers agreed on all 115 cases (1.000). In 42 cases no rankable action is offered, and in 58 exactly one is.
- **Root cause:** the reviewers agreed on 0.765 of cases. **37 cases** are agreed and determinable.

**Escalated to Eric Martin: 78 cases (73 `validator_failure`, 5 `conflict`).**
- All 78 were marked not determinable from the packet by at least one reviewer.
- 27 of them also have a root-cause disagreement.
- The open question is almost always whether a value is absent from the source document (`source_missing`) or present but missed by extraction (`extraction_error`). The packets cannot answer that; the source document can.
- The adjudication sheet, which holds customer text and is kept outside the repository, groups the 78 cases into 37 project-and-rule groups.

The label set is not frozen and no provider call may be made until the adjudication is complete.

## Corpus correction r2 (2026-10-15, before any label was frozen)

While preparing source-enriched packets, a corpus defect surfaced. The duplicate-price-sheet exclusion checked only a case's evidence rows. Decision-backed issues have no evidence rows: their cited source is the decision's own document. Four Goodlettsville decision-backed cases cite one of the two price-sheet uploads directly (contract ceiling ×2, contractor ×2), and the rule always required excluding them.

- The builder now records every cited document as `citedDocumentIds`: evidence rows, the case document, and a decision's own and governing documents. Exclusion uses that list.
- Corpus rebuilt as r2: **`validator_failure` 81, conflict 30, excluded 58.** Both minimums are still met.
- The case set and every remaining case's `transmittedDigest` and `readDigest` are unchanged from r1. None of the four newly excluded cases had an agreed label.

## Source-enriched relabelling (owner decision 2026-10-15)

The 78 phase-1 escalations were not sent to Eric Martin. The cause was an evidence gap: the packets could not separate a value absent from the source from one EightForge failed to read.

The 74 unresolved r2 cases (78 escalations minus the 4 excluded) were rebuilt with each case's exact cited source evidence (`enrichPacketsV2.ts`, zero provider calls, read-only):
- document type and extraction coverage;
- bounded excerpts around the rule's own terms in the cited document or on the cited page, at most 5 × 500 characters, with hit counts;
- for transaction workbooks, the exact cited rows;
- for fixtures, the fixture source rows.

The action set and the six-category vocabulary are unchanged. The same two independent reviewers relabel the cases. Exact agreement is accepted automatically, and only residual disagreements go to Eric Martin, grouped by project, rule and source.

`scripts/evaluation/artifacts/case-investigation-v2/enriched-packets.index.json` records, per case, the cited document ids, pages, hit counts and excerpt and row digests only. The excerpts themselves stay outside the repository.

Note on the relabel packets: in the 5 conflict-fixture packets the reviewers labelled, each fixture source row named its document by its fixture key (for example `tickets`) rather than its title. A spread-order bug in `enrichPacketsV2.ts` caused this, and it has since been fixed. The labelled packets are identified by their recorded `packetSha256`, so the evidence the reviewers saw stays exactly reproducible. The rows' values were complete and correct.

### Relabel result (2026-10-15)

| | Cases |
|---|---|
| Relabelled with cited source evidence | 74 |
| Accepted by exact reviewer agreement (primary action and root cause) | **52** |
| Phase-1 agreements carried | 37 |
| **Labelled so far** | **89 of 111** |
| Residual disagreements for Eric Martin | **22** (21 `validator_failure`, 1 `conflict`) |

The residual sheet groups cases by project, rule and cited source document, and is kept outside the repository because it quotes customer text. Each of the 22 residual cases cites a different source document, so each needs its own source-truth decision. **Labels are not frozen**, and no zero-call preflight or provider call may run until the 22 are resolved.

## Qualification harness (2026-10-22, before any label was frozen)

Until now the repository had no way to freeze the labels, preflight or run the
qualification, so nothing could follow the 22 decisions. The harness adds that path. It
changes no contract term, request, prompt, bar or label.

| Step | Command (`scripts/evaluation/case-investigation/qualifyV2.ts`) | Calls |
|---|---|---|
| Corpus identity re-check, no labels needed | `verify-corpus --corpus <r2>` | 0 |
| Freeze the 111 labels | `freeze-labels --corpus <r2> --phase1 <r1> --adjudication eric-martin-adjudication.json --out <labels.json>` | 0 |
| Zero-call preflight | `preflight --corpus <r2> --labels <labels.json> --out <dir>` | 0 |
| The one paid run | `run ... --freeze <preflight dir> --out <dir> --confirm-paid-run` | ≤ 134 |
| Post-run grading packet | `grading-packet --corpus <r2> --run <dir> --out <packets.jsonl>` | 0 |
| Scorecard | `score --labels <labels.json> --run <dir> --grades-a ... --grades-b ... [--grade-adjudication ...]` | 0 |

- **Label freeze** (`lib/evaluation/caseInvestigation/labelsV2.ts`) is built from people only:
  - the 37 phase-1 agreements;
  - the 52 relabel agreements, with agreement re-checked rather than trusted;
  - Eric Martin's root-cause decision for each of the 22 residual cases. In all 22, both reviewers already agree on the primary action.
  - It fails closed on any missing, duplicate, ineligible, unoffered or invalid label, or on an adjudicator other than Eric Martin.
  - The frozen file holds case ids, actions, root causes and input digests only. It can be committed.
- **Preflight and run** re-verify every frozen identity from bytes:
  - the committed manifest;
  - the seven pinned sources, hashed as on-disk bytes exactly as `buildCorpusV2.ts` hashed them;
  - the Validator rule catalogue;
  - each case's `transmittedDigest`, recomputed from the frozen provider context;
  - the offered actions, and each request body against the freeze.
  - On 2026-10-22, `verify-corpus` passed for all 111 cases (81 `validator_failure`, 30 `conflict`) with zero calls.
  - Call cap: 134. The conservative maximum estimate is $3.13 (input at 1 token per 3 characters, every answer at the full 1,500-token cap). The run halts at the $3.00 safety ceiling, and any case it cannot reach counts as an invalid answer.
- **The run** uses the production runner and Claude adapter unchanged:
  - Only three runner dependencies are replaced: the context read returns the frozen context, eligibility is the qualification itself, and the reservation is a local ledger.
  - The adapter's client is wrapped only to record usage. It forwards the exact body and options.
  - There are no retries and no selective reruns.
- **Scoring** (`lib/evaluation/caseInvestigation/qualificationV2.ts`) applies v1's bars verbatim. These interpretations are fixed before any call, each the strictest coherent reading:
  - A raw answer with an invented number, an unoffered action or an untransmitted evidence reference breaches that hard bar, even though the runner then rejects it as invalid.
  - No case leaves a denominator. An invalid answer is a wrong top-1, a root-cause disagreement and faithfulness 0 in the mean. The faithfulness-0 hard bar counts graded valid answers.
  - The ranking bar uses cases offering at least two rankable actions: 3 `validator_failure` and 12 `conflict`. Single- and zero-action cases are reported only.
  - A call that reports no usage is charged its upper bound. Unknown cost is never zero.
  - Percentiles are nearest-rank, as in B4.6.1.
- **Post-run grades** follow the same two-reviewer process as the labels. The packet shows graders the frozen operator evidence and the answer, never the benchmark label. Every disagreement needs Eric Martin's decision.

The workflow stays `disabled`. A PASS can only support a reviewed PR that raises the code ceiling (see the promotion rule).

## Qualification run result (2026-10-22): FAIL

The single paid run was made exactly once under the frozen identities, from a checkout byte-identical to main `7b62011`. There were no retries, replacement cases or exclusions. The evidence directory, which holds customer text, is kept outside the repository: `case-investigation-v2-qualification-20261022/`. Its `SHA256SUMS.txt` lists every artifact.

| Identity | Value |
|---|---|
| Owner adjudication file (sha256) | `62c465ab4681d2057abbcc3d80d9fe0236d8e2669606b190689fe490b50abed2` — Eric Martin, 22 decisions, structurally valid |
| Label-set digest | `7a139119e16be2cd3dac83a9994188bbde8c862fd1d6579885523844d494063f` (37 phase-1 + 52 relabel agreements + 22 owner adjudications); label file sha256 `789800e5294c5d824df012d5912941b9786aa071b3bdde3a15aae103bf4dcb7e` |
| Preflight freeze | `8cdec598d0d9d3a38ea9274a5337e6bd0557b21404f23c6bb08e2312232abd09`. Zero calls; 111 cases (81 / 30); call cap 134; estimated maximum $3.13 against the $3.00 ceiling |
| Bars digest | `e47875886300dce952827286c0584e10cfd6c70a16d8ff52d031723f54a9ccfd` |

**Run:** 111 calls, an upper-bound spend of $2.0489, and no halt.

| | `validator_failure` (81) | `conflict` (30) | Bar |
|---|---|---|---|
| Accepted (`proposed`) | 19 | 3 | — |
| Invalid share | 0.765 | 0.900 | ≤ 0.05 ✗ |
| Provider timeouts (all at the 15 s timeout) | 34 | 1 | count as invalid |
| Invented numbers | 18 | 0 | 0 ✗ |
| Wrong evidence references | 5 | 23 | 0 ✗ |
| Unoffered ranked actions | 0 | 0 | 0 ✓ |
| Median / p95 latency | 12.9 s / 15.0 s | 12.9 s / 14.7 s | ≤ 6 s / ≤ 12 s ✗ |
| USD per investigation | 0.0199 | 0.0147 | ≤ 0.03 ✓ |
| Top-1 on ranking cases (baseline) | 1/3 (3/3) | 0/12 (12/12) | ≥ max(baseline + 0.10, 0.70) ✗ |

**Not graded:** faithfulness, root-cause agreement, side selection and decision recommendations. The grading packet was built (22 valid answers), but no independent grades exist. Grades cannot change the verdict:
- The hard bars above fail mechanically.
- Root-cause agreement is at most 19/81 and 3/30, against a 0.70 bar.
- Mean faithfulness is at most 0.47 and 0.20, against a 1.6 bar.

**Diagnosis**, read-only over the stored records and answers:
- **Latency is the binding limitation.** It is genuine model and contract fit, not a defect: every call that answered still took a median 11.4 s, against the 6 s bar. All 35 provider failures are 15 s timeouts.
- **Three concrete implementation defects inflated invalidity** (fixed for v3; see v3):
  1. **The relationships slice was uncitable.** `document_relationships` was transmitted with `provenance.recordIds = []` whenever the case document had no relationship row, which is 55 of 111 cases. All 28 wrong evidence references cite that slice: 22 with an empty id and 6 with the case document's id.
  2. **The length bounds were unstated.** The runner rejects a diagnosis over 1,200 characters or a rationale over 2,000. Neither the prompt nor the provider schema said so; structured outputs cannot express string lengths. 7 answers were rejected for length alone.
  3. **Some record ids could not be cited.** Transmitted record ids reach 315 characters, but the runner capped a cited `recordId` at 200. A correct citation was impossible in 12 conflict cases, and 3 answers were rejected for it.
- **Two contract observations for the owner, not changed:**
  - 14 of the 18 invented-number flags are enumeration markers such as "(1)", which the strict "every number you write" rule counts.
  - The top-1 ranking bar cannot be met in either class: the deterministic baseline is 100% on the ranking cases, so the required score is 1.10.

This result is final for v2. Labels, bars and corpus were not changed after the outputs were seen.
