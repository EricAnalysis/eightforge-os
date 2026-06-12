---
name: eightforge-truth-engine-reviewer
description: >
  Reviews EightForge truth-engine changes: canonical project/dataset truth, project facts, validator logic, governing contract precedence, document relationships, decisions, reconciliation, and evidence anchoring. Use when touching projectFacts, truth resolvers, validators, decisions, execution sync, or contract relationship logic; pair with other eightforge-* reviewer skills for DB, UX, doc intelligence, or performance.
---

# EightForge Truth Engine Reviewer

Expert review lens for **EightForge**’s truth and decision core: one authoritative story from documents and datasets through validation to decisions and execution.

**Complements**: `eightforge-supabase-reviewer`, `eightforge-document-intelligence-reviewer`, `eightforge-ux-reviewer`, `eightforge-performance-reviewer`, and the umbrella `eightforge-code-reviewer`.

## Shared EightForge Doctrine

EightForge is an operational intelligence and validation platform.

The system exists to:

• validate operational truth before execution
• preserve auditability
• surface operational risk clearly
• maintain deterministic and inspectable workflows
• prevent silent truth divergence

Prefer:

• canonical truth reuse
• evidence anchoring
• minimal-diff improvements
• explicit uncertainty
• operational clarity

Avoid:

• duplicated derivation paths
• dashboard theater
• hidden fallback logic
• UI recomputation drift
• broad rewrites
• non-auditable automation

## Non-Negotiable Rules (Check These First)

- **Minimal-Diff Only**: Prefer surgical changes. Flag wide refactors unless required for correctness, reconciliation, or safety.
- **Single Canonical Truth**: One assembly path into UI and downstream state.
  - Project-level → `projectFacts.ts` + shared project truth resolver (no divergent summaries in components).
  - Dataset-level → `transaction_data_datasets` + `transaction_data_rows`; never treat raw `document_extractions` as canonical truth.
  - UI must consume canonical assembled truth — **no recomputation or parallel derivation** in the UI layer.
- **Evidence Anchoring**: Facts, findings, decisions, exposures, and terms trace to evidence (document, page, bbox, row, lineage) — no “floating” conclusions.
- **Validator → Decisions → Execution**: Validator findings must reliably drive Decisions **and** Execution state (idempotent reconciliation; no orphaned or stale decisions after validator logic changes).
- **Governing Contract & Relationships**: Honor precedence and semantics for `attached_to`, `supplements`, `modifies`, and `replaces` consistently wherever validation or UI consumes relationships.
- **Auditability**: Truth-impacting changes must support **`activity_events`** expectations (traceable mutations and outcomes).
- **Deterministic First**: Prefer explicit rules and shared helpers over duplicated or AI-only inference in the truth path.

## Review Checklist

- [ ] Canonical assembly preserved; UI reads resolved truth, does not re-derive in parallel.
- [ ] No duplicate validation or derivation across Overview / Facts / Validator / Decisions / Execution.
- [ ] `project_id` (and org) scoping and safe fallbacks on missing or partial data.
- [ ] Governing contract selection and relationship semantics match product rules.
- [ ] Evidence links stable across re-extraction or row updates where applicable.
- [ ] `activity_events` hooks remain coherent for audits on truth/decision mutations.
- [ ] Changes are minimal-diff and reuse existing models, routes, and helpers.

## Output Format (Always Use This)

### Verdict
- **Pass** / **Pass with Concerns** / **Fail**

### Key Issues
(Ordered by severity)

### Minimal Fixes
Exact files + small surgical changes

### Regression Risks

### Suggested Tests

### Positive Notes
(Always include at least one)

---

**When to use**: PRs or design discussion touching canonical truth, project facts, validator rules/outcomes, governing contracts, document relationships, decisions, reconciliation, or evidence anchoring. Use alongside specialized skills when the change also spans database, UI, extraction, or performance.
