# EightForge + Forgewing as a productized Forward Deployed Engineer

Status: direction, not a specification. Each phase that builds on this note
gets its own scoped spec, audit and verification gates. Recorded 2026-10-04.

## North star

A Forward Deployed Engineer embeds with a customer, learns how their documents,
data and processes really work, wires up the messy pieces, and ships production
changes so the product fits the workflow. EightForge + Forgewing should do that
job as a product, for operational workflows:

> **EightForge is the deterministic operational system. Forgewing is the
> embedded Forward Deployed Engineer that helps each organization adapt,
> reconcile, integrate and continuously improve how EightForge fits its real
> workflows, while humans keep operational and engineering authority.**

This is broader than "AI that reads documents" and broader than "a Validator
with an assistant". The earlier Forgewing deterministic-rule workflow-task idea
(a repeated correction becomes a rule task) is one case of it.

## The loop

```
customer workflow
  -> EightForge observes the actual documents, data and relationships
  -> the deterministic Core handles what it can prove
  -> ResolutionCases expose what it cannot
  -> Forgewing investigates the long tail
  -> the operator makes the final operational decision
  -> reviewed truth
  -> Validator / Project Truth / workflow continues
  -> Forgewing observes repeated friction and corrections
  -> FORWARD DEPLOYMENT WORK ITEM
  -> Improvement Orchestrator: evidence, root cause, blast radius
  -> human engineering approval
  -> implementation (Codex / Claude), tests, CI, PR
  -> deployment
  -> EightForge handles that situation itself next time
```

## Two human authorities

```
Operational authority
  Forgewing proposes a project resolution
  -> the operator makes the final project decision

Engineering authority
  Forgewing identifies a recurring system gap
  -> the Orchestrator proposes an improvement
  -> an engineer approves the product change
```

AI never silently decides either. Both already have a single road:
`human_fact_assertions` for operational truth (B3/B4.2), and the reviewed
repository-plan pipeline for engineering change.

## Roles

- **Forgewing sees the customer's operational problem.** It watches where
  extraction failed, where operators corrected values, where documents do not
  reconcile, where expected relationships are missing, where operators repeat
  the same action, where customer terminology differs from EightForge's, where
  the Validator raises recurring false positives, where a missing integration
  causes manual work, and where operators leave EightForge to finish a task.
- **The Improvement Orchestrator decides how the product should change safely.**
  It explains why the friction happens, where the code path is, whether the fix
  is configuration or code, the blast radius, how to test it, and the minimal
  implementation request.
- **Implementation** (Codex / Claude) writes the change; **CI** proves it; a
  **human** approves deployment. Forgewing does not design its own patches.

## Decision hierarchy

Move down only as far as necessary, so EightForge does not become a pile of
customer-specific hardcoding:

1. Can existing EightForge handle it?
2. Can customer configuration handle it?
3. Can a mapping or integration handle it?
4. Is it a safe, reusable deterministic rule?
5. Does it need a product or code improvement?

Examples: a customer calling "Unit Price" "Billing Rate" is a mapping. "CY"
unresolved as a unit across many projects and customers is a Core
deterministic improvement. An ERP exporting invoice ids as
`PROJECT-LOCATION-INVOICE` belongs in an integration adapter, not the canonical
truth engine.

## Forward Deployment Work Item (draft shape)

Work item classes: `deterministic_rule_candidate`, `extraction_gap`,
`validator_rule_gap`, `document_relationship_rule`, `customer_field_mapping`,
`workflow_configuration`, `integration_gap`, `data_connector_requirement`,
`reporting_requirement`, `operator_workflow_improvement`.

```
ForwardDeploymentWorkItem {
  id
  organization, projects[], workflow
  problem_type
  observed_failures[]
  reviewed_operator_actions[]
  frequency, affected_projects, affected_documents, exposure
  forgewing_diagnosis
  recommended_change_class: configuration | mapping | integration
    | deterministic_rule | extraction | validator | product
  generalization_evidence
  customer_specificity
  proposed_acceptance_tests[]
  orchestrator_status, engineering_status
  resulting commit / PR / deployment
}
```

Traceability target: "Project A exposed the problem -> Forgewing identified the
pattern -> operators confirmed it N times -> the Orchestrator generalized it ->
PR #___ implemented it -> regression tests proved it -> deployed on ___."

## What already exists to build on

| Need | Existing piece |
| --- | --- |
| Where the deployed system struggles | ResolutionCases (B5-A) and the Resolution Workspace (B5-B) |
| What operators actually decided | `human_fact_assertions` chains (B3) |
| What AI thought | `forgewing_recovery_proposals`, incl. version 3 value readings (B4.2) |
| Whether Forgewing helped | Derived telemetry in `lib/resolution/valueReadingLifecycle.ts`: used unchanged, used then edited, rejected, suggestion ignored, entered without suggestion (B4.2) |
| Operational consequence | Deterministic impact preview (B5-C) |
| Real vs observed clearance | `operator_cleared` vs `not_observed` finding closure (#147) |
| Engineering pipeline | `workflow_intake_submissions` -> `workflow_assessments` (attempts, reviews, step reviews) -> `workflow_repository_plan_v2_runs` (raw evidence, generation jobs, recommendation reviews) -> `linear_projection_correlations` |
| Provider and data gates | Commercial entitlement (#142), data-policy ledger and durable call budget (B4.1) |

## Design notes for when this is built (B8 and later)

1. **Reuse the engineering pipeline.** A Forward Deployment Work Item should be
   a new intake source for the existing workflow intake -> assessment ->
   repository plan -> engineering review -> Linear projection chain, not a
   parallel system. One road from customer friction to approved change.
2. **Count only evidence of a real operator decision.** Human assertions,
   used/edited/rejected readings and operator clearance count; "not observed
   this run" never does (the #147 rule). Otherwise "operators confirmed it 22
   times" is inflated by absence.
3. **Keep tenants separate while generalizing.** "Observed across 6
   customers" must be built from counts and de-identified patterns, never by
   moving one organization's document content into another's work item.
   Sending customer examples to a model for implementation is a provider
   transmission and falls under the same data-policy ledger as Forgewing calls.
4. **A configuration / mapping layer is the first likely gap.** The decision
   hierarchy puts customer configuration and mapping before Core changes, but
   today unit aliases and similar normalizations live in Core code, and
   `semantic_column_mappings` records per-extraction interpretation rather than
   organization configuration. Audit this before B8; without an
   organization-scoped configuration layer every customer fix becomes Core code.
5. **Done means the friction stopped, not that the PR merged.** Close a work
   item only when the matching ResolutionCases and telemetry for that pattern
   drop after deployment. If the friction returns, reopen it, the same way
   Validator findings recur. That measurement is what makes the traceability
   claim provable.

## Explicit B8 audit item

**Customer configuration / mapping layer.** Confirmed 2026-10-04: there is no
organization-scoped place for safe customer adaptations such as unit aliases
or field names; those behaviors live in Core code today. Do not build it ahead
of B8, but B8 opens with a read-only audit of where such adaptations would live,
because the decision hierarchy depends on having somewhere to put them before
falling through to Core code changes.

## Forgewing request signals

Every valid, authorized operator request that reaches the Forgewing value-reading
engine leaves exactly one durable outcome, whether Forgewing generated a
proposal, reused one, or could not run because of deployment, policy, budget,
provider or evidence state (B4.3). Malformed or unauthorized requests leave
none. This is what lets B8 tell "operators never needed Forgewing" apart from
"operators asked 37 times and deployment policy blocked 29", and
`activation_not_allowed` in particular is evidence for qualifying a recovery
type next.

## Roadmap position

B4 continues as planned: B4.3 execution engine (mocked / permitted fixtures),
B4.4 workspace suggestion slot, B4.5 visual region reading, B4.6 benchmark,
then measured, controlled activation. The old B8 "Improvement Signals" phase
expands into this Forward Deployment layer.

B4.5 invariant: once a page image is transmitted, the request digest must
transitively bind the exact image bytes sent to the provider
(`render_digest = SHA256(rendered crop bytes)`, included in `request_digest`
with the evidence binding, text context, provider/model, prompt and output
schema), so a renderer change can never silently reuse an old answer.
