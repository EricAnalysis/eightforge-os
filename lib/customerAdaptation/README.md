# B8 customer header mapping contract and B8.2a evidence prerequisite

This module contains a pure mapping contract and a read-only authenticated
header-evidence prerequisite. Persistence and production mapping consumption
remain deferred to B8.2b and B8.2c.

`ReviewedCustomerHeaderMappingRevision` binds organization/revision UUIDs,
SHA-256 identity, exact document type and source-schema scope, exact source
labels, existing target roles, typed supporting header-evidence bindings, declared
human approval actor/time and optional superseded revision UUID.

Targets reuse `PRICED_SCHEDULE_ASSEMBLY_ROLES` from `pricedScheduleRoles.ts`:
description, unit, origin_destination and rate. Supporting roles are not mapping
targets in this increment. Mapping a header to `unit` recognizes a column; it
does not normalize or equate its body values.

The pure resolver consumes one explicitly supplied revision. Null/empty/unmatched
mappings preserve upstream recognition. Existing recognition is opaque so
supporting roles and upstream ambiguity are not discarded. Exact matching is
case/whitespace sensitive, with no normalization or fuzzy fallback. Duplicate
labels, contradictory entries and disagreement with upstream recognition return
review-required with no selected role. Invalid revisions, tenant mismatch and
scope mismatch reject with no selected role. Replay output carries revision ID
and digest after successful scope validation, plus the original label and the
matched evidence binding. Construction clones inputs and deeply freezes the
result; resolution neither mutates nor freezes input.

A digest proves object identity, not authentic human approval or evidence access.
Schema version 2 replaces arbitrary string references; version 1 is rejected.
Envelope validation checks evidence org, document type, exact label and schema
against the revision. A well-shaped binding alone is not proof. Before approval,
B8.2b must reload trusted persisted evidence and call `verifyCustomerHeaderEvidence`.
The future trusted persistence/approval boundary must authenticate actors, enforce revision
uniqueness and supersession chains, and choose exactly one approved revision for
the requested scope. It must reject overlapping active revisions; this resolver
does not select a winner among revisions. The future consumer must pass *all*
existing recognition, not filter out supporting roles, and must retain the
revision identity alongside unchanged source labels, values and geometry.

Owner/admin authority for approval, activation and withdrawal is decided. The
same actor may approve and activate, as separate audited actions with separate
timestamps. Storage and those actions remain unimplemented in B8.2a.
No approval metadata in this contract grants activation, publication, pricing,
canonical mutation or execution authority.

## B8.2a evidence and structural schema

`GET /api/documents/[id]/customer-header-evidence?headerIndex=0` uses
`getActorContext` and organization-filtered reads of document, project, preferred
full extraction and source artifact. It returns verified evidence or fails
closed. Extraction identity, schema and observations come from storage.

The pure verifier closes ordered source refs against persisted PDF observations
using the existing text, geometry, observation-identity and physical-page checks.
It also verifies page representation digest, artifact ownership, exact label
composition, complete header partition and contiguous column boundaries.
Bindings pin org/project/document/extraction/artifact/source digest/page/page
digest/header and column indices/exact label/ordered observation IDs/schema.

`customer-header-schema-v1` hashes source kind, observed source method,
interpretation family, one header row and ordered exact labels with column
indices and spans. IDs, source digests, coordinates, inferred roles and parser
versions are excluded, so equivalent structures across documents share scope.
Raw evidence retains the source identity separately. Native and OCR methods
have distinct scopes; mixed methods fail closed.

This first producer accepts only one unambiguous, contiguous single-row header
per physical page. Inherited, human-selected, segmented, overlapping, duplicate
or ambiguously grouped headers are rejected. Missing materialized header
observations are rejected rather than fabricated from reconstruction text.
No extraction output is changed and no customer mapping is applied.

B8.2c must persist the actual revision ID, digest and source schema with each
interpretation. B8.2d must carry those historical pins into friction; querying
the active mapping later cannot substitute for the revision actually used.

## Later B8 evidence and intake boundaries

Main `39a8f07` (B7.1 / #216) adds the first opted-in reviewable advisory rule,
`SOURCES_REFERENCED_AMENDMENT_MISSING`. The existing
`ADVISORY_REVIEWABLE_RULE_IDS` in `lib/execution/syncExecutionItems.ts` owns
this opt-in; its execution items begin `resolvable`, not blocking `open`.
Recorded `execution_items.outcome = 'overridden'` enters the existing B6.4
rule-semantics evidence reader. B8 must reuse this declaration, not introduce
another advisory-review policy.

The existing friction-to-internal-Orchestrator link has no durable production
destination: `app/api/internal/orchestrator/route.ts` returns 404 in production;
outside production it generates guidance rather than creating a reviewed Phase
11 request. This is a reachability gap, not an authority breach. Leave repair
to B8.3: tenant-bound friction must enter the existing intake, assessment,
repository-plan, engineering-review, approved-request and Linear-projection
chain. Do not enable or expand the internal prompt generator as a second path.

Focused verification (from this checkout):

```powershell
node node_modules/vitest/vitest.mjs run lib/customerAdaptation --maxWorkers 1 --no-file-parallelism --testTimeout 120000 --hookTimeout 120000
node node_modules/vitest/vitest.mjs run lib/server/customerHeaderEvidenceRead.test.ts lib/server/customerHeaderEvidenceRoute.test.ts lib/extraction/pdf/layoutObservationEvidence.test.ts tests/blobExtractionSelection.test.ts --maxWorkers 1 --no-file-parallelism --testTimeout 120000 --hookTimeout 120000
node node_modules/typescript/bin/tsc --noEmit --incremental false
```
