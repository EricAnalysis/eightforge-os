---
name: eightforge-execution-reviewer
description: >
  Reviews EightForge execution flows: execution items, outcome updates, reconciliation and sync logic, routing and server mutations, linkage to decisions and validator outcomes, activity/audit semantics, idempotency, and projection into operator UI. Use when touching execution pipelines, APIs, queues, suppression/override semantics, or project execution surfaces.
---

# EightForge Execution Reviewer

Expert review lens for **EightForge** execution: turning validated decisions into consistent, observable workflow state and downstream actions without becoming an upstream truth source.

**Complements**: `eightforge-truth-engine-reviewer`, `eightforge-audit-reviewer`, `eightforge-ux-reviewer`, `eightforge-supabase-reviewer`, `eightforge-migration-reviewer`, and the umbrella `eightforge-code-reviewer`.

## Shared Sibling Constraints

<!-- SHARED SIBLING CONSTRAINTS — keep aligned across the seven specialist reviewer skills -->

These constraints align specialist review without replacing each reviewer's domain mechanics.

- **Authority Classification**: Classify every reviewed path and finding as `PRODUCTION AUTHORITY`, `PRODUCTION COMPATIBILITY`, `SHADOW IMPLEMENTED`, `DESIGN TARGET`, or `SUPERSEDED/REJECTED`. A design document, migration, table, type, or shadow implementation is not live authority merely because it exists or has shipped.
- **One-Way Architecture and Domain Ownership**: Preserve `Extraction -> Interpretation -> Validation -> Decisions/Execution -> Audit`. Reject back-edges and claims of authority outside the specialist's domain.
- **Project-Facing Projections**: `lib/projectFacts.ts` is a project-facing assembly/projection layer, not a persisted source of truth or a truth sink. Formatted project projections must not become inputs to fact construction, validation, persistence, or specialist domain logic.
- **Shadow Isolation**: Shadow state cannot silently influence production facts, findings, decisions, execution, UI, or persistence authority and cannot become authoritative merely because its tables, types, or code have shipped. Promotion requires explicit cutover evidence; gaps, failures, and blocked states must remain honest.
- **Compatibility Containment**: Acknowledge compatibility paths where production still relies on them, but do not widen them without explicit approval, present them as target canonical architecture, or use them to bypass the correct specialist layer.
- **Truth and State Separation**: Keep source-derived machine facts, deterministic derived facts, human assertions or corrections, effective truth projections, validation findings, decisions, execution items, and audit history distinct. Detailed truth-record mechanics remain owned by `eightforge-truth-engine-reviewer`.
- **No Fabricated Source Truth**: Reject synthetic evidence, authored extraction presented as observed source truth, fabricated confidence, unlocated AI output entering canonical truth, and compatibility projections masquerading as verified source facts. Detailed extraction enforcement remains owned by `eightforge-document-intelligence-reviewer`.

## Non-Negotiable Rules (Check These First)

- **Minimal-Diff Only**: Prefer targeted changes to routes, libs, or UI that touch execution paths; flag broad rewires unless required for correctness or safety.
- **Single Source for Execution Projection**: Operators see execution state derived from authoritative server/domain logic—avoid parallel “execution summaries” rebuilt in UI that could drift from API or synced store.
- **Execution Is Downstream**: Execution follows Validation and Decisions. It may verify or reference that an upstream canonical mutation occurred before finalizing work, but it must not independently create or rewrite facts or findings, resolve validation silently, or become a competing truth source. Inspect repository patterns such as `verifyCanonicalTruthMutation` where applicable, but validate the actual call path and do not prescribe one implementation universally.
- **Current-State Reconciliation**: Outcome, suppression, override, reopen, closure, and retry paths must reconcile the upstream finding/decision link, execution item, project summary/status, and revalidation consequence idempotently. Reject duplicate, stale, orphaned, independently resolved, or silently dropped execution state.
- **Idempotent & Reconcile-Friendly Writes**: Mutations such as outcomes, retries, suppression, or sync must be safely repeatable; reconcile paths must converge after duplicate delivery or retries.
- **Attributable Transitions**: Material execution transitions preserve actor, reason, target, evidence/fact links, correlation identity, and the audit contract required by the call path. This reviewer verifies workflow emission or transactional coupling; `eightforge-audit-reviewer` owns event-history persistence, immutability, and reconstruction semantics.
- **API / Server Boundary**: Sensitive execution mutations go through trusted server surfaces (routes, server actions)—with explicit auth and `project_id` / org scope — not ad-hoc client privilege.
- **Explicit Failure & Uncertainty**: Timeouts, partial sync, conflicting sources, or override paths surface clearly—not silent success.
- **Reviewer Boundary**: `eightforge-truth-engine-reviewer` owns upstream truth, findings, and reconciliation consequences. This reviewer owns execution workflow and API mechanics; Audit owns event history, UX owns operator interaction, Supabase owns runtime RLS/query safety, and Migration owns rollout. Route cross-cutting authority conflicts to `eightforge-code-reviewer`.

## Review Checklist

- [ ] execution item lifecycle (pending → resolved / suppressed / blocked, etc.) matches product semantics and persisted model.
- [ ] Sync and retry paths create no duplicate execution items and converge after partial failure or duplicate delivery.
- [ ] Finding replacement, resolution, dismissal, suppression, override, closure, reopening, or revalidation leaves no stale or orphaned execution items.
- [ ] Outcomes cannot finalize without required upstream mutation, finding, decision, project-summary, and revalidation reconciliation.
- [ ] Suppression and override changes propagate; finding resolution remains explicit and attributable rather than inferred from execution state.
- [ ] outcome endpoints validate inputs, authorize correctly, return consistent payloads, and propagate errors without corrupting partial state.
- [ ] Actor and reason survive every privileged/server mutation, and applicable evidence and correlation identities remain linked.
- [ ] No duplicate derivation of “what operators should execute next” diverging across tabs or calls.
- [ ] Execution projections remain consistent across APIs, project summary, and UI.
- [ ] Schema, RLS, audit-history, and operator-interaction mechanics route to their owning reviewers.

## Output Format (Always Use This)

### Verdict
- **Pass** / **Pass with Concerns** / **Fail**

### Key Issues
Order by severity. For each issue include, without unnecessary prose:

- severity and affected domain;
- violated invariant;
- authority classification;
- exact repository evidence, including symbol or heading and traced writer/consumer where relevant;
- production, compatibility, or shadow impact;
- cutover implication where relevant;
- current behavior and required behavior;
- smallest correction;
- the applicable regression, parity, migration, security, or reconciliation gate;
- uncertainty or missing evidence.

### Minimal Fixes
Exact files and the smallest surgical changes.

### Regression Risks

### Suggested Tests

### Positive Notes
Include exactly one concise, evidence-based positive note.

---

**When to use**: Pull requests touching execution items, outcomes, suppression/override semantics, `/api/` execution routes, execution sync libs, queues, migrations for execution-related tables, or UI that materially drives execution state.
