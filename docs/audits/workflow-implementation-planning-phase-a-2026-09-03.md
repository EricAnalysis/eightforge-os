# Workflow → Implementation Planning V1 — Phase A Audit

Date: 2026-09-03
Status: read-only audit. No implementation in this document or this session.
Trigger: Workflow Intelligence / Review chain closed at `a47f27f` (PR #124 merged
to `main`). This is the next phase per the decision recorded in
`implementation-planning-next-phase` memory: *Reviewed Specification →
Implementation Plan → engineering/operator review → Codex implementation
prompt → normal PR/tests/deployment*.

Scope of this document: trace what data an Implementation Plan would consume,
what already exists in EightForge that a plan could reuse, what does not exist
yet, and what open questions Phase B (a bounded Codex prompt) needs to answer
before any code is written. **No code is proposed or written here.**

---

## 1. The input: what "accepted reviewed specification" actually is

The critical input rule from the prior decision: a plan reuses the **accepted
reviewed specification**, never the original intake prose. Tracing what that
object concretely is, end to end:

```
workflow_intake_submissions        (immutable; public, unauthenticated origin)
  └─ workflow_assessments  vN       (immutable; Forgewing's proposal)
        └─ workflow_assessment_reviews         (one operator judgement, versioned)
              └─ workflow_assessment_step_reviews   (one disposition per step)
```

- `workflow_assessment_reviews` / `workflow_assessment_step_reviews`:
  [supabase/migrations/20260831000000_workflow_assessment_reviews.sql](supabase/migrations/20260831000000_workflow_assessment_reviews.sql):31-180.
  A review pins an exact `(assessment_id, assessment_version)` — no
  latest-version fallback (enforced in
  [supabase/migrations/20260904000500_workflow_database_authority_closure.sql](supabase/migrations/20260904000500_workflow_database_authority_closure.sql)
  in `record_workflow_assessment_review`, which reads
  `WHERE assessment.id = p_assessment_id AND assessment.assessment_version = p_assessment_version`).
- Four dispositions per step, DB-enforced coherence between disposition and
  `reviewed_classification`
  ([20260831000000_workflow_assessment_reviews.sql:131-180](supabase/migrations/20260831000000_workflow_assessment_reviews.sql)):
  - `accepted` — Forgewing's proposal stands. `accepted_specification` is
    `NULL` by design (the original already exists immutably in
    `workflow_assessments`; it is never copied).
  - `modified` — classification unchanged, specification replaced with a
    complete, self-contained `accepted_specification` (jsonb).
  - `reclassified` — classification changed (e.g. RULE → HUMAN), replacement
    specification required.
  - `rejected` — nothing accepted; `accepted_specification` is `NULL`.
- The shape of `accepted_specification`, per classification, is the single
  canonical Zod contract in
  [lib/workflowReviewedSpecification.ts](lib/workflowReviewedSpecification.ts):1-90,
  mirrored at the database boundary by
  `workflow_reviewed_specification_keys` /
  `assert_workflow_reviewed_specification` in
  [20260904000400_reviewed_specification_structural_validation.sql](supabase/migrations/20260904000400_reviewed_specification_structural_validation.sql)
  and proven identical to the TS schema by
  [lib/architecture/reviewedSpecificationSqlParity.test.ts](lib/architecture/reviewedSpecificationSqlParity.test.ts).

**Proven, not inferred:** for `accepted`, the effective specification is *not*
a column on the review row — it must be read back out of the pinned
`workflow_assessments.assessment` jsonb, at the specific step, using the
proposal-collection lookup that
[lib/workflowAssessmentProposalClosure.ts](lib/workflowAssessmentProposalClosure.ts)
already implements and that the same migration reuses server-side
(`workflow_accepted_proposal_specification` in
[20260904000500_workflow_database_authority_closure.sql](supabase/migrations/20260904000500_workflow_database_authority_closure.sql)).
This is the "one canonical closure implementation" the prior review verified —
**a plan should call this existing function/module, not re-derive the lookup.**

**Not yet built:** there is no single read path today that returns "the
effective reviewed specification" for a whole assessment in one call — i.e. a
function that, given `(assessment_id, assessment_version)`, walks every step
review and returns, per step, either the original proposal detail (accepted),
the stored replacement (modified/reclassified), or an explicit "rejected, no
specification" marker. The closure/validation functions prove that this
*can* be derived deterministically (their job is exactly to prove the
`accepted` case is composable), but no consumer assembles the full resolved
set yet. **This resolver is the first concrete implementation candidate** —
it is planning-adjacent (a pure read/derivation, no authority), and is
explicitly anticipated by
[lib/workflowAssessmentProposalClosure.ts](lib/workflowAssessmentProposalClosure.ts):1-20's
own comments ("A future resolver builds the effective reviewed specification
by taking the original proposal wherever a step was accepted as proposed").

---

## 2. Per-classification: what implementing it would eventually touch

This section identifies existing components per the six classifications, and
marks what a plan needs to decide. It does not decide it.

### RULE / VERIFY

- **Existing precedent, found this session:** [lib/rules/](lib/rules) is a
  live, hand-authored deterministic rule engine —
  `RULE_PACK_VERSION = 'v1.0.0'`
  ([lib/rules/registry.ts:1-13](lib/rules/registry.ts)), ~30 rules across
  ticket/invoice/contract/payment-rec families, with `types.ts`
  (`RuleDefinition`, `RuleContext`, `TaskType`, `RuleFamily`), `evaluator.ts`,
  `adapter.ts`, `rerun.ts`.
- **Shape overlap:** a reviewed RULE specification
  (`plainLanguageRule`, `requiredFacts`, `conditionType`, `expectedEvidence`,
  `expectedOutcome`) is a *plain-language* description of exactly the kind of
  thing `lib/rules/registry.ts` encodes as executable TypeScript today. There
  is no bridge between the two — a reviewed RULE spec is data (jsonb); the
  rule pack is code.
- **Open question a plan must answer, not this document:** does
  Implementation V1 extend the existing static registry (a human writes a new
  `RuleDefinition` informed by the reviewed spec — no new execution
  infrastructure, but no traceability from spec to code) or introduce a
  data-driven rule loader that reads `accepted_specification` at runtime (new
  infrastructure, but closes the loop the review chain was built to produce)?
  Both are legitimate; this is exactly the kind of decision an Implementation
  Plan should surface with tradeoffs, not one Phase A should preempt.
- `conditionType` enum
  (`comparison, calculation, presence_check, date_range, identity_match,
  duplicate_detection, precedence` —
  [lib/workflowReviewedSpecification.ts:36-40](lib/workflowReviewedSpecification.ts))
  should be checked against `lib/rules/types.ts`'s own condition vocabulary for
  overlap before any new rule-authoring convention is chosen.

### EXTRACT

- `describedFact`, `sourceDocument`, `deterministicExtractionPlausible` map
  conceptually onto the extraction pipeline under `lib/extraction/` and the
  Forgewing structured-output/qualification path
  ([lib/forgewing/tasks/workflowAssessment.ts](lib/forgewing/tasks/workflowAssessment.ts)).
  **Not traced in this session** — a full Phase A for this classification
  alone would need to map `sourceDocument` (free text from a public,
  unauthenticated intake form) onto the document-family/document-type
  taxonomy the extraction pipeline actually recognizes. That mapping is
  unverified and should not be assumed 1:1.

### RECOVER

- Composed server-side from two historical objects
  (`extractionRequirements` + `forgewingRecoveryTasks`) with an explicit
  semantic gate: `deterministicExtractionPlausible` must be literally `false`
  ([20260904000500_workflow_database_authority_closure.sql](supabase/migrations/20260904000500_workflow_database_authority_closure.sql),
  `workflow_accepted_proposal_specification`, RECOVER branch). Git history
  shows a related precedent branch,
  `codex/forgewing-extraction-recovery-v1` ("add provenance-bound pricing
  recovery") — **not read this session**; worth reviewing before planning
  RECOVER's implementation path, since it may already define the recovery
  vocabulary this classification should reuse.

### HUMAN

- **Existing precedent, found this session:**
  `public.workflow_tasks` /
  `public.workflow_task_events`
  ([supabase/migrations/20250310000000_missing_live_schema_baseline.sql:413-450](supabase/migrations/20250310000000_missing_live_schema_baseline.sql))
  — an existing, tenant-scoped (`organization_id NOT NULL`), decision-linked
  task queue.
- **Architectural mismatch a plan must resolve:** the workflow intake/
  assessment/review chain is deliberately global and organization-less — that
  is precisely why platform review authorization
  ([lib/server/workflowPlatformReviewAccess.ts](lib/server/workflowPlatformReviewAccess.ts))
  had to be built as a new allowlist rather than reusing tenant admin roles.
  A HUMAN decision point coming out of this chain has no `organization_id` to
  attach to `workflow_tasks` as-is. Whether HUMAN implementation reuses
  `workflow_tasks` (requiring a scoping decision), or is a new
  platform-level task concept, is an open question for the plan.

### ADVISORY

- `description` only — the lightest classification. No dedicated existing
  table found; likely the smallest implementation surface, but not scoped
  this session.

---

## 3. Non-authority boundary carries forward unchanged

Every finding above is subject to the same constraint the whole chain has
enforced so far: nothing in `workflow_assessments`, `_reviews`, or
`_step_reviews` may become Canonical Truth, Validator state, Project Truth, a
decision, an action, or an executable rule by implication. An Implementation
Plan is a design document describing what *would* need to be built; it is not
itself authority, and turning a reviewed RULE into a live `lib/rules/`
`RuleDefinition` is Phase C (normal PR / tests / deployment) work with its own
review, not something a plan document does.

---

## 4. What Phase B (the bounded Codex prompt) should be scoped to

Per `working-cadence`: Phase A is read-only; Eric runs Phase B via Codex, not
me. Based on the above, a well-bounded first Codex prompt is:

> Build the **effective reviewed specification resolver** — a pure, read-only
> function that, given `(assessment_id, assessment_version)`, returns one
> resolved record per step: `{stepId, effectiveClassification,
> effectiveSpecification | null, disposition, provenance}`, using the existing
> `workflow_accepted_proposal_specification` /
> `assert_workflow_reviewed_specification` functions for the `accepted` case
> and the stored `accepted_specification` for `modified`/`reclassified`, with
> `rejected` steps carrying no specification. No new authority, no new tables,
> no writes. This is the concrete deliverable
> `lib/workflowAssessmentProposalClosure.ts`'s own comments anticipate.

This is deliberately narrow: it is the one piece of section 1 above that is
proven necessary and not yet built, it touches no per-classification
ambiguity from section 2, and its output is exactly the artifact a later,
larger Implementation Plan document would need as a fixture to reason about
each classification concretely instead of abstractly.

**Explicit non-goals for Phase B:** no rule-execution engine changes, no
`workflow_tasks` integration, no extraction pipeline changes, no new database
tables, no UI. Those are separable follow-on questions this audit surfaces
but does not resolve.

## 5. Stop conditions

- **Checked this session:** `workflow_accepted_proposal_specification` has no
  explicit `GRANT EXECUTE ... TO service_role`
  ([20260904000500_workflow_database_authority_closure.sql:396-398](supabase/migrations/20260904000500_workflow_database_authority_closure.sql))
  — it is only revoked from `PUBLIC, anon, authenticated`. It is currently
  callable solely as an internal call from another `postgres`-owned
  `SECURITY DEFINER` function (ownership grants implicit EXECUTE). A new
  resolver function should follow the same pattern — `SECURITY DEFINER`,
  owned by `postgres`, explicit `search_path`, `GRANT EXECUTE` to
  `service_role` only on the *new* resolver function itself — rather than
  widening grants on the existing closure function. If Phase B finds this
  pattern insufficient, stop and report rather than granting broader access.
- If mapping any classification's fields onto an existing EightForge concept
  (rule pack, workflow_tasks, extraction pipeline) requires guessing at
  intake-prose semantics rather than reading the reviewed specification
  fields directly, stop and report — that would be re-reading the prose the
  critical input rule forbids.
