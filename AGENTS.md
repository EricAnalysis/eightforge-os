## Skills & Reviewers (Current Architecture)

You now have a clean, layered reviewer system:

| Reviewer | Core Responsibility | Best Used For |
|---|---|---|
| `eightforge-code-reviewer` | Umbrella full PR and architecture guard | General reviews, big changes |
| `eightforge-truth-engine-reviewer` | Canonical truth, facts, validator logic | Project facts, validation, reconciliation |
| `eightforge-cross-document-reviewer` | Relationships, precedence, governing contracts, conflicts | Contract families, amendments, exhibits, rate schedules |
| `eightforge-execution-reviewer` | Actions, workflows, gates, overrides, rollback | Decisions → Execution, automation safety |
| `eightforge-document-intelligence-reviewer` | Extraction, OCR, evidence anchoring, spreadsheets | Document pipelines, normalization |
| `eightforge-supabase-reviewer` | RLS, scoping, data safety | Database, auth, queries |
| `eightforge-migration-reviewer` | Schema/data migrations, rollback safety, deployment sequencing | SQL migrations, backfills, indexes, constraints |
| `eightforge-audit-reviewer` | Activity events, provenance, immutable history, compliance traceability | Audit logs, overrides, execution history, decision provenance |
| `eightforge-performance-reviewer` | Scale, timeouts, efficiency, large data | Heavy pipelines, rendering |
| `eightforge-ux-reviewer` | Operator-first UX, risk hierarchy, clarity | UI, workflows, navigation |

All reviewers inherit the Shared EightForge Doctrine:
canonical truth, evidence anchoring, auditability, deterministic workflows, minimal-diff architecture, and operator-first operational clarity.

## PROOF REUSE / NON-REDUNDANT VERIFICATION

Treat previously established checks as reusable evidence.

Do NOT repeat already-proven checks unless the current change can reasonably invalidate them.

A prior proof should be considered invalidated only when the change affects one or more of:

- the code path under test;
- an upstream dependency of that path;
- a downstream contract being asserted;
- schema or migration behavior;
- canonical truth / authority semantics;
- source parsing or extraction behavior;
- runtime or native dependency behavior;
- fixture identity or benchmark corpus;
- environment assumptions relevant to the proof;
- test logic itself.

When prior proof remains valid:

- cite/reuse it;
- run only the smallest focused check needed for the changed behavior;
- do not rerun unrelated reviewer passes;
- do not rerun full suites during iteration.

Verification order:

1. reuse existing proof where still valid;
2. run focused tests for the changed boundary;
3. run broader dependent tests only if that boundary changed;
4. run one final full regression gate before PR completion when required.

Do not perform duplicate audits merely because multiple reviewer skills are active.

One reviewer may rely on evidence already produced by another reviewer when:

- the evidence identity is clear;
- the underlying code/data has not changed;
- the assertion being reused is equivalent.

If uncertain whether prior proof was invalidated, identify the dependency first rather than rerunning everything by default.

## REVIEWER ACTIVATION

Invoke only the minimum set of reviewer skills materially relevant to the task.

Do not activate sibling reviewers "for completeness."

Examples:

Extraction geometry change:

- document-intelligence
- truth-engine
- audit only if provenance changes

Database migration:

- migration
- supabase
- truth-engine only if canonical semantics change

UI-only change:

- UX
- execution only if operator action semantics change

Performance-only optimization:

- performance
- relevant domain reviewer only if output semantics could change

## CROSS-REVIEWER EVIDENCE REUSE

When multiple reviewer skills are active on the same task, they must share
already-established evidence rather than independently reproducing it.

A reviewer may reuse another reviewer's result when:

- the evidence source is identified;
- the evidence applies to the same commit / artifact state;
- the relevant dependency has not changed;
- the reused assertion is within the reviewer's scope.

Do not repeat:

- the same source inspection;
- the same PDF/page inspection;
- the same trace;
- the same benchmark run;
- the same test suite;
- the same migration replay;
- the same provenance check;

solely because another reviewer skill is now considering the task.

If an additional reviewer needs a different assertion from the same evidence,
read the existing evidence first and extend only the missing portion.

Reviewer independence means independent judgment where needed, not duplicate
execution.

## TEST ECONOMY

During implementation:

- targeted tests only.

Before PR completion:

- one dependency-appropriate regression pass;
- one full suite only when repository policy requires it.

Do not run the full suite after every edit.
Do not rerun a full suite that already passed on the exact same commit.
Do not rerun unchanged benchmark corpora unless the affected code path,
runtime, fixture, or scorer changed.

Future Agent Unlocks:
- PR reviewers
- Automated architecture guards
- Execution safety validators
- Migration inspectors
- Operational copilots
- Autonomous code review agents

Usage:
Reference `eightforge-code-reviewer` for full reviews.
Use specialized reviewers for domain-specific operational reviews.
Combine reviewers as needed, for example:
`eightforge-truth-engine-reviewer` + `eightforge-cross-document-reviewer` + `eightforge-execution-reviewer`.

`eightforge-cross-document-reviewer` + `eightforge-execution-reviewer` should often be combined when governing contract logic directly affects downstream approvals, workflows, or automation behavior.
