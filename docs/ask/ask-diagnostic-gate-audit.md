# Ask diagnostic gate drift audit

Date: 2026-10-10. Phase A baseline: main
`322ca483abf763b81b1463da995cf96155dcf6db`. Conflict candidate: PR #205,
`6b2443bb7136a70197c8092d90546647954d29c9`.

**Phase A checkpoint: the gate was not green and #205 could not merge on this
audit alone.** The completed Phase B/merge evidence is recorded below.
The corpus expansion was intentional, the CI count is stale, and genuine Ask
answer-selection defects coexist with stale diagnostic scoring and mutable
integration data. Correcting the count alone cannot establish acceptance.

## Evidence and reuse

The saved unchanged-main/candidate comparison reports identical answer,
evidence, and criteria results: 60 queries, 42 passing, 18 failing, and 28
consolidated gaps. The original query IDs 1–22 have 19 passing, three failing,
and one consolidated gap. This is scoped parity, not byte parity: generated
timestamps differ. No production re-analysis or qualification evidence was
invalidated by this audit.

Raw client-bearing artifacts remain outside Git in the continuation scratchpad:
`ask-baseline/scripts/ask/artifacts/`, `ask-diagnostic/scripts/ask/artifacts/`,
and `ask-gate-baseline-comparison.json`. This document records classifications,
not source documents or complete production answers. Phase A made no code,
CI, schema, production data, or authority changes and required no new provider
calls or unrelated test runs.

## Exact history

| Commit | Change | Classification |
|---|---|---|
| `20822e2ef7508aa3d4233e4f881680f396cf8355`, June 4 | Added 22 queries, read-only live diagnostic, and CI requiring 22 passes and zero failures/gaps. | Original aligned contract. |
| `44de2a0a0217453d01b1e166d2c75204d4ad407d`, June 4 | Reclassified selector computations as upstream gaps and recorded capability/read boundaries. | Intentional authority constraint; missing capabilities must not be supplied by Ask arithmetic or inference. |
| `f39ccec908a614e242f3339abd6627379475e1ec`, June 5 | Added 38 matrix probes, IDs 23–60, plus concept/source/evidence scoring. Added baseline count 22 plus expansion count; saved 60/60 with zero gaps. Did not update CI. | Intentional corpus expansion not reflected in CI; stale CI expectation. |
| `811227322ff85960038f374e46e7dd744725a32a`, June 5 | Added deterministic intent-router scoring and refreshed saved artifacts. | Intentional scoring expansion. |
| `4c832a7b81ece8ab76fb8cf3a7b3506a481a2192`, June 5 | Stopped tracking generated diagnostic artifacts and local state. | Reference outputs remain in history; they are not immutable input fixtures. |
| `cd510256cc700eb1473fe5eb9134821f87c3cbbb`, June 6 | Added actionable gap responses in answer builders and upstream-gap detector without updating diagnostic scoring. | Output/scoring contract drift. |

`scripts/ask/phase3Diagnostic.ts:100–215` contains all 60 queries; lines
217–218 preserve the baseline count and expansion count. There is no baseline-only
execution mode. Lines 1050–1055 require the combined count. Conversely,
`.github/workflows/ask-phase3-diagnostic.yml:75–80` still requires exactly 22
executed/passing queries and zero failures/gaps; blame traces these assertions
to the original `20822e2` commit. The workflow path filter omits the diagnostic
scripts and workflow file themselves.

The harness test writes failures/gaps to artifacts and exits successfully; only
the workflow enforces artifact quality. A passing Vitest harness process is not
a passing Ask diagnostic gate.

## Failure classification

The three original failures are q17, q21, and q22. Their shared artifact gap is
gap 1. q17/q21 incorrectly take the generic portfolio gap path before existing
aggregate reads; q22 lacks the required ceiling-proximity aggregate and must
remain an explicit missing-capability response. All three also expose stale
scoring: `Open Portfolio` is absent from the allowed-action list, and the
gap-rendering regex does not recognize the current actionable-gap response.
These are not #205 regressions.

| Query | Matrix | Failed criteria / behavior | Root-cause classification | Required treatment |
|---|---|---|---|---|
| 17 | baseline / CM-049 | Allowed action and gap rendering; blocked-project aggregate reported absent. | Retrieval/dispatch gap plus scoring defect. | Read existing portfolio aggregate before generic gap; preserve explicit gap if genuinely absent. |
| 21 | baseline / CM-053 | Same criteria; approval-ready aggregate reported absent. | Retrieval/dispatch gap plus scoring defect. | Same existing-aggregate read boundary. |
| 22 | baseline / CM-056 | Same criteria; ceiling-proximity summary absent. | Missing upstream fixture/data capability plus scoring defect. | Keep typed missing-source response; do not infer ceiling status. |
| 23 | CM-001 | Matrix specificity/evidence; invoice-total fact answers approval readiness. | Real Ask answer-selection regression: direct-fact preemption. | Dispatch intended readiness selector before generic matching fact. |
| 25 | CM-003 | Evidence adequacy; invoice-total fact answers next action. | Real Ask answer-selection regression: direct-fact preemption. | Read canonical recommended action or emit its existing explicit gap. |
| 27 | CM-006 | Specificity/evidence; invoice-total fact answers fully supported amounts. | Real Ask answer-selection regression: direct-fact preemption. | Read supported-amount canonical source. |
| 28 | CM-007 | Specificity/evidence; invoice-total fact answers unsupported amounts. | Real Ask answer-selection regression: direct-fact preemption. | Read unsupported-amount canonical source. |
| 29 | CM-009 | Specificity/evidence; invoice-total fact answers exposure. | Real Ask answer-selection regression: direct-fact preemption. | Read exposure canonical source. |
| 30 | CM-010 | Specificity/evidence; invoice-total fact answers exception approval. | Real Ask answer-selection regression: direct-fact preemption. | Read canonical exception eligibility or emit explicit missing-source condition. |
| 39 | CM-022 | Specificity/evidence; invoice-total fact answers contract-rate correctness. | Real Ask answer-selection regression: direct-fact preemption. | Read canonical rate comparison; do not infer from invoice total. |
| 42 | CM-026 | Specificity/evidence; invoice-total fact answers ceiling proximity. | Real Ask answer-selection regression: direct-fact preemption. | Read ceiling/billed/proximity source or withhold unavailable conclusion. |
| 48 | CM-034 | Matrix sourced; processing metadata used as document review status. | Real Ask unsupported review claim / retrieval gap. | Read genuine review status/evidence or expose absence. Processing status is not reviewed truth. |
| 49 | CM-035 | Canonical layer, allowed action, specificity, evidence; reviewed-warning field reported absent. | Empty-versus-absent read defect plus scoring defect. | Treat canonical present-empty list as supported empty result; keep true absence explicit. |
| 52 | CM-038 | Canonical layer, specificity, evidence; first-inspection field reported absent. | Null-versus-absent read defect plus scoring defect. | Distinguish explicit canonical no-target from missing field; do not choose first retrieved document. |
| 56 | CM-042 | Matrix sourced; metadata describes a change without historical review evidence. | Real Ask unsupported history claim / retrieval gap. | Require before/after and review-baseline evidence; otherwise explicit gap. |
| 58 | CM-053 | Allowed action, gap rendering, specificity, evidence. | Same early portfolio gap path as q21 plus scoring defect. | Existing aggregate read and semantic evidence assertions. |
| 59 | CM-054 | Allowed action, gap rendering, evidence. | Early portfolio gap path for stale-project aggregate plus scoring defect. | Read existing stale subset/count; do not derive partition inside Ask. |
| 60 | CM-049 | Allowed action, gap rendering, evidence. | Same early portfolio gap path as q17 plus scoring defect. | Existing aggregate read and semantic evidence assertions. |

No failed criterion in this snapshot reports fabricated material, inference as
fact, unlabeled raw fallback, or portfolio raw-document traversal. That does
not prove the unsupported review/history wording correct: coarse criterion
checks cannot replace source-level classification.

## All 28 consolidated gaps

Gap IDs consolidate failed criteria; they are not 28 independent capabilities.
The gap generator assigns owner/type heuristically. Its `currentBehavior`
fallback can call a nonempty response “fabricated” merely because it failed
another criterion. The independent classifications above take precedence over
that label.

| Gap IDs | Queries | Artifact type | Independent classification |
|---|---|---|---|
| 1 | 17, 21, 22, 58, 59, 60 | portfolio_summary_absent | Existing aggregate reads preempted for blocked/ready/stale queries; genuinely missing ceiling summary for q22; stale action/rendering scoring for all six. |
| 2, 3 | 23 | canonical_field_absent; evidence_anchor_missing | Readiness direct-fact preemption. |
| 4 | 25 | evidence_anchor_missing | Recommended-action direct-fact preemption. |
| 5, 6 | 27 | canonical_field_absent; evidence_anchor_missing | Supported-amount direct-fact preemption. |
| 7, 8 | 28 | canonical_field_absent; evidence_anchor_missing | Unsupported-amount direct-fact preemption. |
| 9, 10 | 29 | canonical_field_absent; evidence_anchor_missing | Exposure direct-fact preemption. |
| 11, 12 | 30 | canonical_field_absent; evidence_anchor_missing | Exception-approval direct-fact preemption. |
| 13, 14 | 39 | canonical_field_absent; evidence_anchor_missing | Rate-comparison direct-fact preemption. |
| 15, 16 | 42 | canonical_field_absent; evidence_anchor_missing | Ceiling direct-fact preemption. |
| 17 | 48 | evidence_anchor_missing | Unsupported review-status claim; processing metadata is insufficient. |
| 18, 19, 20 | 49 | canonical_field_absent twice; evidence_anchor_missing | Present-empty warning list confused with absence, plus stale gap scoring. |
| 21, 22, 23 | 52 | canonical_field_absent twice; evidence_anchor_missing | Explicit null inspection target confused with absence, plus stale gap scoring. |
| 24 | 56 | evidence_anchor_missing | Unsupported change-history claim without baseline evidence. |
| 25, 26 | 58 | canonical_field_absent; evidence_anchor_missing | Early ready-project gap path plus matrix scoring. |
| 27 | 59 | evidence_anchor_missing | Early stale-project gap path plus matrix scoring. |
| 28 | 60 | evidence_anchor_missing | Early blocked-project gap path plus matrix scoring. |

Totals reconcile: one portfolio-summary gap, twelve canonical-field gaps, and
fifteen evidence gaps = 28. All 18 failed query IDs appear above.

## Fixture identity and credentials

The current runner is integration-backed. It obtains a service-role Supabase
admin client, finds the first live Williamson/Aftermath project among an
unordered 200-row selection, reads processed invoice/document state, and loads
project truth, operational queues, and portfolio aggregates. It does not pin a
project ID, input snapshot, source hash, clock, corpus version, or fixture digest.
Portfolio projects and staleness can change between runs. This is mutable
benchmark identity, even when both implementations share the same current
answers. See `phase3Diagnostic.ts:841–1045` and
`docs/environment/golden-data-location.md:61–75`.

The workflow expects Supabase URL and service-role secrets; missing secrets are
an environment/credential dependency of this implementation. They are not
intrinsically necessary for deterministic Ask regression CI. Existing unit
tests already exercise read boundaries with synthetic retrieval, mocked table
reads, and synthetic portfolio inputs. There is no existing full 60-query
hermetic runner. Adding one must test actual dispatch/retrieval/builders and
identify its synthetic inputs explicitly. Do not put client-bearing live
artifacts in Git or add production credentials for convenience.

## Smallest safe repair and acceptance constraints

1. Fix proven dispatch/read defects and unsupported review/history claims.
2. Version the complete 60-query registry and canonical input fixtures; include
   semantic expected outcomes and evidence requirements, with no expected-answer
   strings supplied as implementation input.
3. Use credential-free deterministic CI with two-run repeatability. Keep live
   read-only diagnostics as a separately identified integration mode/report.
4. Align CI to the explicit canonical corpus/version and fail on every unexpected
   failure or gap. Add path coverage for harness, fixtures, and workflow changes.
5. Preserve positive supported-answer requirements and explicit negative missing-
   source/review-required requirements. Do not lower thresholds to current output.

A “positive 60 fixture” cannot manufacture support for capabilities the reviewed
matrix still classifies as missing upstream. In particular, the absent portfolio
ceiling summary remains a negative case until its canonical producer/read path
exists. Supplying fabricated summary values or silently counting that production
gap as an answered capability would weaken the contract. Negative cases must
assert the typed gap, actual missing source, permitted workflow, absence of an
unsupported conclusion, and inspectable evidence. A green deterministic contract
does not imply the separate live integration data has zero missing capabilities.

## Phase B implementation and proof (2026-10-11)

The corrected CI contract executes the same complete 60-query registry through
the actual classifier, filtered synthetic storage adapter, retrieval and answer
builders. Inputs, corpus and semantic/evidence contracts have checked-in SHA-256
pins in `scripts/ask/diagnosticIdentity.json`. Unknown fixture tables fail closed.
The live read-only harness remains `vitest.phase3.config.ts`, with its capability
failures and gaps separate from deterministic correctness. No production
credentials are necessary for CI and none were added.

Fixture coverage is explicitly 25 sourced-answer cases and 35 missing-input
cases. This is not a claim of 60 material capabilities. The unsupported original
ceiling query, unprovided contract clauses and audit history remain unavailable.
Invoice totals cannot establish ticket-specific costs. Positive tests additionally
exercise actual governing statements, rate/ticket findings, review warnings,
human-reviewed values and complete invoice snapshots. Unrelated evidence, partial
snapshots, arbitrary scalar paraphrases and invented metadata are rejected.

The repair changes dispatch, read/presence checks and honest presentation only;
it adds no canonical producer, winner heuristic, review authority, schema or
production rewrite. The old positive regex result could not substantiate those
unsupported statements; preserving it would preserve fabricated capability.

Local checks: 87 Ask tests pass, the 60-query fixture has zero correctness
failures, and `npx tsc --noEmit` passes. Identity drift is enforced rather than
normalized away. Commands:

```text
npx vitest run lib/ask --reporter=dot
npx vitest run --config scripts/ask/vitest.hermetic.config.ts --pool forks
npx tsc --noEmit
```

## Completed merge evidence (2026-10-11)

PR #206 head `b892a06629c0b0de7e625fdaa78bab10feb669b5` passed independent
review after fixes, Ask CI run `38149934962`, both full Vitest lanes
`38149932382` / `38149935085`, and Vercel preview. It merged manually as
`167d485001093aa8a7bf27272e010c3666520482`.

PR #205 rebased cleanly to `43e410cb05deff70488fda9e3983b2a90da22b02`.
Range-diff proves its two conflict patches unchanged. Local dependent checks
passed 591 tests / 63 files, TypeScript and three hermetic harness tests. Ask
CI `38150685515`, full Vitest `38150683204` / `38150685530`, and Vercel preview
passed before it was marked ready and merged manually as
`75e7df032db8578b1da777f58b773a7b4cdd569c`.

Both CI correctness artifacts match the local Ask repair artifact byte-for-byte:
SHA-256 `59fd4cfe58a07da660c0a93199982f3a7c44547a0e487d83093498a6f0177374`.
This proves the pinned correctness contract, not absence of live capability gaps.
No production credentials were added, production analysis rerun, paid call made,
or frozen qualification threshold changed. Production deployment is not inferred
from these merges.
