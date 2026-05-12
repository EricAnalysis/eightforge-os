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

Future Agent Unlocks:
- PR reviewers
- Automated architecture guards
- Execution safety validators
- Migration inspectors
- Operational copilots
- Autonomous code review agents

Usage:
Reference the umbrella reviewer for full reviews.
Use specialized reviewers for domain-specific operational reviews.
Combine reviewers as needed, for example `truth-engine` + `cross-document` + `execution`.
Cross-document + execution reviewers should often be combined when governing contract logic directly affects downstream approvals, workflows, or automation behavior.
