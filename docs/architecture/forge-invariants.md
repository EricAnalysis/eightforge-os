# Forge Architectural Invariants

Forge is the operational center of EightForge. It turns project-scoped documents and datasets into validated facts, decisions, actions, and audit evidence before approval-sensitive work moves forward.

This document defines the invariants that should hold across implementation details. Engineers and AI coding agents should use it as a constitution when changing Forge, validators, document intelligence, decision flows, audit trails, or migrations.

## System Shape

EightForge follows one continuous progression:

`Documents -> Facts -> Validation -> Decisions -> Actions -> Audit`

Each layer has a different responsibility. Documents preserve source material and provenance. Facts express operational truth. Validation observes whether that truth is complete, consistent, and approval-safe. Decisions and actions route work created by validation. Audit records what happened, who caused it, and what changed as a consequence.

No layer should quietly become a second source of truth for another layer.

## Canonical Truth

Canonical facts are the single source of truth for project and document state. Surfaces, selectors, validators, decisions, and actions should consume canonical facts through shared builders and resolvers instead of re-reading raw extraction payloads or recomputing truth locally.

Canonical history must be preserved. When a fact is corrected, confirmed, superseded, or completed, the system should retain the prior value, provenance, and evidence anchors needed to explain why the effective answer changed.

Effective facts are additive projections over canonical history. They may choose the current best value for a workflow, but they must not overwrite or erase the history that made that value inspectable. A projection is allowed to simplify consumption; it is not allowed to obscure lineage.

Any canonical mutation must trigger revalidation. If a change can affect approval, exposure, contract interpretation, document relationships, invoice support, ticket integrity, or execution readiness, validators must get a fresh opportunity to observe the new state.

## Validation And Approval

Validation findings are immutable observations from a specific validation run. New runs may generate new findings, resolve old findings, or produce changed conclusions, but they should not rewrite prior observations into a different history.

Approval state is derived from validation findings and their downstream execution posture. It should not be maintained as an independent state machine that can drift away from validator output. If approval readiness changes, the explanation should trace back to findings, evidence, and the validation run that produced the current conclusion.

Findings should carry enough operational meaning to drive decisions and actions: what is wrong, what is at risk, what evidence supports it, and what must happen next. Presentation layers may summarize or filter that information, but they should not invent the approval logic themselves.

## Decisions, Actions, And Audit

Decisions and actions exist to move validated work forward. They should reference findings, facts, documents, invoices, contract terms, or other canonical records rather than duplicating their meaning. Closing a decision or completing an action should update the appropriate canonical state and then revalidate when that state can affect approval.

Audit records consequences and attribution. It should answer who did what, when it happened, what canonical records were affected, and what downstream consequences followed. Audit is historical evidence, not a competing source of current truth.

Audit records may support reconstruction of a timeline, but runtime behavior should continue to read from canonical facts, validation findings, execution records, and shared projections. If application logic needs to consult audit to know the current answer, the current-state model is probably incomplete.

## Document Provenance

Documents must preserve provenance by distinguishing extracted, derived, confirmed, and corrected values.

Extracted values come from source documents or datasets. Derived values are produced by system reasoning over canonical inputs. Confirmed values are operator attestations that the existing value is acceptable. Corrected values are operator-supplied replacements that must retain the machine value they superseded.

These categories are not cosmetic. They tell operators and auditors whether a value came from source evidence, deterministic reasoning, human review, or human correction. Forge should make that lineage available wherever a value influences validation, approval, or execution.

## Reasoning Boundaries

Business logic belongs in the reasoning layer, not in presentation layers. UI components should render canonical state and call shared helpers; they should not independently decide contract precedence, approval readiness, exposure math, finding severity, or document truth.

Shared semantic helpers should be used whenever a rule crosses more than one surface. If two screens need to answer the same business question, they should use the same resolver, selector, or validation helper. Duplicated local logic is a warning sign because it creates silent truth divergence.

Presentation layers may adapt shape, language, and emphasis for operator clarity. They may not create alternate derivation paths for business meaning.

## Migration Safety

Database migrations are schema history and must remain replay-safe. They should apply cleanly on a fresh database, on Supabase preview branches, and on existing production databases.

Migrations should not assume production-specific project records, document IDs, extracted arrays, or fixture data exist unless that data is created by the migration history itself. Environment-specific repairs must be scoped, guarded, idempotent, and explicit about skipped records.

Backfills must preserve canonical truth. They should never synthesize operational documents, fake facts, default missing evidence into apparently valid values, or relax data-quality checks for records they actually process.

## Decision Test

Before implementing a Forge change, ask:

- What is the canonical source of truth for this value?
- Am I adding an effective projection, or am I overwriting history?
- Does this mutation require revalidation?
- Is approval state still derived from findings?
- Are new observations appended rather than rewritten?
- Does audit record attribution and consequence without becoming runtime truth?
- Is provenance visible for extracted, derived, confirmed, and corrected values?
- Is business logic in a shared reasoning helper instead of a UI component?
- Will every surface use the same semantic helper for this rule?
- Will every migration replay on an empty database and in preview without production-only data?

Extract once. Reason once. Validate once. Project everywhere. Audit everything.
