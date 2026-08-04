---
name: eightforge-supabase-reviewer
description: >
  Reviews EightForge Supabase/Postgres runtime persistence and access behavior: RLS, organization/project scoping, service-role safety, tenant isolation, query filtering, storage access, transactions, idempotency, and database enforcement. Use for policies, API/server data access, auth-scoped queries, privileged operations, or runtime persistence behavior; pair with the migration reviewer for schema rollout and backfills.
---

# EightForge Supabase Reviewer

Expert review lens for **EightForge** runtime persistence and access control: multi-tenant safety, least privilege, and database behavior aligned with application authority boundaries.

**Complements**: `eightforge-migration-reviewer`, `eightforge-truth-engine-reviewer`, `eightforge-audit-reviewer`, `eightforge-performance-reviewer`, and `eightforge-code-reviewer`.

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

- **Minimal-Diff Only**: Prefer narrow policy, query, storage, and runtime-persistence edits; route unrelated schema rollout changes to the Migration reviewer.
- **Authority Before Database Verdict**: Before evaluating a table, function, policy, or query, classify it as production authority, production compatibility, shadow implemented, design target, or superseded/rejected. A canonical-looking name or deployed table does not establish authority; trace writers and readers.
- **No Service Role in Untrusted Contexts**: **No service role keys** in browser bundles, client components, public env, or other untrusted surfaces — server-only with explicit call sites.
- **Writes via Trusted Server Paths**: Mutations go through **API routes** or **safe server actions** with auth and scoping checks; avoid ad-hoc client writes against privileged keys.
- **RLS Protects Sensitive Tables**: User-reachable tables have Row Level Security; policies express org/project (or equivalent) isolation; deny-by-default where appropriate.
- **Validate `project_id` and Organization Scoping**: Queries and policies must scope rows correctly; catch IDOR and cross-tenant reads/writes (including null or ambiguous scope).
- **Shadow Reader Isolation**: Reject production readers, functions, triggers, RPCs, or fallbacks that make shadow tables authoritative without an explicit cutover decision and verified promotion gates.
- **Database Dependency Closure**: Where correctness requires referential or dependency closure, enforce it with appropriate foreign keys, constraints, validated references, or fail-closed transactional checks; do not rely only on application convention.
- **Privileged Actor Context**: Service-role operations remain server-only, narrowly scoped, and retain actor or system identity plus audit context where the mutation contract requires it.
- **Transaction and Idempotency Safety**: Multi-record truth-impacting writes define atomicity boundaries, retry behavior, conflict handling, and idempotency. State explicitly when a side effect is best-effort rather than transactional.
- **RLS Evidence, Not Assumption**: Verify enabled RLS, policy coverage, role grants, storage policies, and organization/project predicates from repository or database evidence. Report uncertainty when deployed policy state is unavailable.
- **Runtime Index Safety**: Preserve index coverage for filters used in RLS and hot runtime queries, especially `project_id`; route index rollout mechanics to the Migration reviewer.
- **Tenant Isolation**: No row leakage across organizations or projects; exercise edge cases (null project, moved resources).
- **Runtime/Rollout Boundary**: This reviewer owns runtime persistence safety, RLS, storage access, and query behavior. `eightforge-migration-reviewer` owns schema rollout, backfills, sequencing, compatibility windows, contraction, and rollback.

## Review Checklist

- [ ] Every table, function, policy, query, and finding has an authority classification backed by traced readers and writers.
- [ ] Shadow tables have no accidental production readers, triggers, RPCs, or fallback authority.
- [ ] New or altered tables: RLS enabled; policies match product intent (read/write split).
- [ ] Policies reference stable session claims; no overly broad `USING true` on sensitive data.
- [ ] Required foreign-key and dependency closure is database-enforced or explicitly fail-closed.
- [ ] Service-role paths preserve tenant scope and applicable actor/system audit context.
- [ ] Multi-row writes are transactionally correct and retry-idempotent; best-effort side effects are labeled honestly.
- [ ] RLS, role-grant, policy, and storage coverage is proven; missing deployment evidence is recorded as uncertainty.
- [ ] Runtime indexes cover tenant and hot-query predicates; rollout findings are routed to the Migration reviewer.
- [ ] API routes validate auth and scope before queries; filters always include tenant/project predicates where required.
- [ ] Supabase types / generated types updated if the repo uses them.

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

**When to use**: RLS policies, Supabase client/server usage, storage access, multi-tenant queries, privileged operations, transactions, or runtime behavior affecting who can read or write which rows. Pair with `eightforge-migration-reviewer` for schema evolution and rollout, `eightforge-truth-engine-reviewer` for authority and reconciliation consequences, `eightforge-audit-reviewer` for event-history mechanics, and `eightforge-performance-reviewer` for measured query scale. This reviewer does not own migration rollout or truth semantics.
