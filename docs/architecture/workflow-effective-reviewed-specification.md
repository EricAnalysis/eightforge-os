# Workflow Effective Reviewed Specification

The effective reviewed specification resolver is a read-only projection over one explicitly pinned immutable workflow assessment review. It exists so an operator-approved review can be inspected as a typed artifact without selecting the latest review, reading the original intake submission, invoking Forgewing, or creating execution authority.

## Evidence Pin

Callers must provide all four pin values:

- `assessmentId`
- `assessmentVersion`
- `reviewId`
- `reviewVersion`

The resolver accepts exactly one immutable assessment row, one parent review row, and the review's child step-review rows. It validates that the assessment and review match the pin, that the assessment and review share the same source submission id, that every child belongs to the pinned parent review, and that there is exactly one child review for every immutable assessment step.

There is no fallback to latest review, latest assessment version, intake data, reviewer prose, or step text matching. Child rows may be returned by the database in any order; the artifact orders them by the immutable assessment's workflow step order before hashing.

## Effective Set

Each child disposition is preserved:

- `accepted` uses the original proposal detail from the pinned assessment.
- `modified` uses the reviewed `accepted_specification` row value.
- `reclassified` uses the reviewed classification and reviewed `accepted_specification` row value.
- `rejected` remains in the artifact with null effective classification and specification.

The `effectiveImplementationSet` contains only non-rejected steps. An all-rejected review is valid and produces an empty implementation set.

Accepted originals are composed through `composeAcceptedWorkflowProposals`, which uses the same structural closure rules as assessment approval. The projection matches the SQL `workflow_accepted_proposal_specification` field contract: RULE and VERIFY strip `ruleId` and `stepId`, EXTRACT strips `requirementId` and `stepId`, HUMAN strips `decisionId` and `stepId`, ADVISORY strips `advisoryId` and `stepId`, and RECOVER combines the extraction requirement with the recovery task.

Reviewed replacements are validated against `REVIEWED_SPECIFICATION_SCHEMAS`. Validation is not normalization for this resolver: parsed output is discarded and the exact stored JSON values are retained in the artifact.

## Digest Contract

The artifact domain is `eightforge.effective-reviewed-specification` and the schema version is `1`.

The resolver builds an envelope containing:

- domain and schema version
- `authority: "non_authoritative"`
- `executable: false`
- `grantsExecutionAuthority: false`
- the four-field pin
- full assessment, parent review, and ordered child review evidence
- all resolved steps
- the non-rejected effective implementation set

The digest is SHA-256 over the envelope before the `digest` field is attached. Encoding is recursive key-sorted JSON. Object keys are sorted only for digest and stable output insertion order; arrays keep their defined order, including meaningful array order inside specifications and evidence. The resolver rejects non-JSON JavaScript values before hashing, including non-finite numbers, `-0`, sparse arrays, cycles, symbols, accessors, and class instances.

## Server Read Boundary

`readEffectiveReviewedSpecification` is the only server read boundary. It verifies the platform actor first, checks workflow platform review access, validates the exact pin, and then uses service-role reads against only:

- `workflow_assessments`
- `workflow_assessment_reviews`
- `workflow_assessment_step_reviews`

It does not read intake submissions, call RPCs, write rows, load runtime rules, invoke providers, or publish canonical truth.

## SQL Parity Limit

The SQL closure function proves the proposal-side structural projection for accepted originals. It does not prove reviewed-specification enum coverage, replacement cardinality, Zod bounds, digest stability, authorization, or no-consumer boundaries. Those guarantees live in the pure resolver tests, read-boundary tests, and architecture guard.
