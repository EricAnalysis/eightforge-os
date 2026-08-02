---
name: eightforge-performance-reviewer
description: >
  Reviews EightForge performance and scale: large spreadsheets and PDFs, extraction throughput, query fan-out, Postgres/Supabase efficiency, SSR/client rendering cost, memory, serverless limits, timeouts, caching, pagination, background work, retries, and freshness-safe revalidation. Use for heavy or latency-sensitive pipelines, lists, APIs, workers, and operator surfaces.
---

# EightForge Performance Reviewer

Expert review lens for keeping **EightForge** responsive under real debris-recovery payloads: huge spreadsheets, dense timelines, and multi-document projects.

**Complements**: `eightforge-document-intelligence-reviewer`, `eightforge-supabase-reviewer`, `eightforge-truth-engine-reviewer`, `eightforge-ux-reviewer`, and `eightforge-code-reviewer`.

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

- **Minimal-Diff Only**: Prefer measured, targeted optimizations; avoid premature abstraction or unrelated perf refactors in the same PR.
- **Classify the Path First**: State whether the measured path is production authority, production compatibility, shadow implemented, design target, or superseded/rejected before drawing performance conclusions.
- **Correct and Complete Before Fast**: A faster incorrect, stale, incomplete, non-deterministic, unauditable, or cross-tenant result is a failure, not an optimization.
- **No Lossy Optimization**: Never improve performance through silent row truncation, silent sampling, dropped evidence dependencies, weakened tenant isolation, bypassed freshness, changed deterministic output, hidden partial completion, or replacement of durable state with an unauditable cache.
- **Explicit Work State**: Distinguish bounded work, deferred work, partial work, failed work, and complete work in runtime state, persistence, metrics, and operator-facing status.
- **Prove the Hot Path**: Measure the actual authority-classified bottleneck with representative volume before rewriting; do not generalize shadow or synthetic measurements to production.
- **Bounded Background Work**: Bound and defer workers and queues with explicit limits, retries, idempotency, backpressure, and visible terminal failure; never silently discard work under pressure.
- **Deterministic Batching**: Chunking, pagination, streaming, and parallelism must preserve full population coverage, stable ordering/identity where required, dependency closure, deterministic reruns, and honest partial/failure state.
- **Pagination & Bounded Reads**: Lists and APIs use **pagination** or keyset patterns; avoid loading unbounded row sets for UI or aggregations.
- **Memory Explosion Prevention**: Cap buffers for large files; avoid duplicating giant structures in React state; stream or chunk where appropriate.
- **Cache Is a Projection**: A cache preserves tenant scope, freshness/invalidation, provenance references, and reconstructability from durable authority. It must not become unaudited durable state or bypass current resolvers.
- **Supabase Queries & RLS Cost**: Queries stay selective; indexes align with filters; be mindful that RLS adds predicate cost — validate plans for hot paths (see `eightforge-supabase-reviewer`).

## Review Checklist

- [ ] Record authority classification, representative dataset/page/row counts, baseline, budget, p50/p95/max or equivalent, and measurement limitations.
- [ ] Query count, fan-out, and row volume are bounded for the user action; hot filters and RLS predicates have measured plans.
- [ ] Large uploads / extractions guarded by limits, timeouts, user-visible progress, and honest failure modes.
- [ ] Queue/worker concurrency and payloads are bounded; deferred, partial, failed, retriable, and complete states remain explicit.
- [ ] React lists and document intelligence panels avoid unnecessary full re-renders of huge structures.
- [ ] API routes bound work (timeouts, batch size); no unbounded `select *` on wide tables for UI.
- [ ] Appropriate use of Server Components vs client hydration for data-heavy surfaces.
- [ ] Before/after equality covers row/cell/fact/finding counts, stable IDs/order where required, dependency closure, and deterministic output hashes.
- [ ] Timeout, retry, partial, failed, deferred, and resumed work never renders or persists as complete.
- [ ] Tenant/RLS behavior and freshness invalidation remain unchanged; cache loss/rebuild preserves durable reconstructability.
- [ ] Vitest, parity, or load-oriented tests cover representative worst cases when complexity or batching changes.

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

**When to use**: Changes to extraction pipelines, document intelligence views, background work, operational queues, large-data surfaces, Supabase-heavy routes, or reported slowness. Route RLS/query-policy correctness to `eightforge-supabase-reviewer`, extraction completeness to `eightforge-document-intelligence-reviewer`, authority/freshness consequences to `eightforge-truth-engine-reviewer`, and interaction usability to `eightforge-ux-reviewer`; this reviewer owns correctness-preserving scale.
