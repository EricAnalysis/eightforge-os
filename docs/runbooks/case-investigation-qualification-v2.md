# Case Investigation qualification contract v2 (`case_investigation_qualification_v2`)

**Status:** owner-directed 2026-10-15. Corpus constructed and census complete. Phase-1 labels are proposed, and **78 cases await Eric Martin's adjudication**. No provider call has been made.

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
| `validator_failure` | **85** | 40 | Goodlettsville 46, TDOT 16, MVSU 7, Bentonville 6, B4.6 Golden 6, B4.6 Hillsdale 3, B4.6 DN 1 |
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
