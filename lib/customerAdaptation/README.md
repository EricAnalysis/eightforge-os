# B8 customer header mappings: evidence, lifecycle and interpretation provenance

This module contains the exact mapping contract, authenticated evidence retrieval,
immutable reviewed revision persistence, separate owner/admin lifecycle actions,
explicit production interpretation and historical tenant-local friction evidence.

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
B8.2b reloads trusted persisted evidence and calls `verifyCustomerHeaderEvidence`.
The persistence/approval boundary authenticates actors and enforces revision
uniqueness and supersession chains, and chooses exactly one active revision for
the requested scope and label. It rejects overlapping active revisions; this resolver
does not select a winner among revisions. The consumer passes *all*
existing recognition, including supporting roles, and retains the
revision identity alongside unchanged source labels, values and geometry.

Owner/admin authority for approval, activation and withdrawal is decided. The
same actor may approve and activate, as separate audited actions with separate
timestamps. Approval creates a reviewed revision and approval event; it does not
create an active pointer.
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
The evidence prerequisite itself does not apply customer mappings.

B8.2c persists the actual revision ID, digest and source schema with each applied
interpretation. B8.2d carries those historical pins into friction; querying the
active mapping later cannot substitute for the revision actually used.

## B8.2b immutable lifecycle

The persisted increment supports one exact source label per reviewed revision.
The version 2 contract still permits arrays, but reusable persistence rejects
multi-label payloads so each lookup key has a single unambiguous supersession
chain. The key is organization + interpretation boundary + document type +
source schema + exact source label. All matching is case/whitespace sensitive.

Revisions store the canonical envelope bytes and SHA-256 digest. Revisions and
events reject update, delete and truncate. The active pointer is a mutable
projection maintained only by the lifecycle RPC. Browser roles cannot read or
write the tables or call the RPCs; authenticated server routes enforce the
organization authority, and SQL rechecks same-org owner/admin authority.

Minimal review/activation surface:

- `GET /api/customer-header-mappings`: owner/admin history and active pointers.
- `POST /api/customer-header-mappings/approve`: one `targetRole`, typed
  `supportingEvidence`, and nullable `supersedesRevisionId`. The actor, revision
  ID and approval timestamp are server-owned. Fresh verification is required;
  the RPC locks and compares the exact verified stored extraction.
- `POST /api/customer-header-mappings/[id]/activate`: exact revision `digest`.
- `POST /api/customer-header-mappings/[id]/withdraw`: exact revision `digest`.

Approval must supersede the current reviewed chain head. A pending approved
revision may itself be superseded before activation. Activation admits only the
latest unactivated head and atomically replaces its active ancestor, retaining
the supersession event. Withdrawal clears only the exact active pointer; it
never restores a predecessor. Withdrawn/superseded revisions cannot reactivate.
Concurrent transitions serialize on the entire exact lookup key, backed by its
composite primary key. Incomplete/truncated active reads fail processing rather
than silently substituting a partial snapshot.

## B8.2c explicit interpretation

Both production processing paths load and freeze one active revision snapshot
per document job. The deterministic parser receives closed assignments derived
from current observed header structure, source observations and page digest.
There is no new global header vocabulary or fuzzy fallback.

Only a direct unresolved single-row header can gain an existing assembly role.
Existing recognized/supporting roles and ambiguity remain protected. Incomplete
or duplicate role results remain unresolved. Human-selected, segmented,
inherited and `spacing_only` paths retain their existing behavior. Mapped roles
cannot carry onto a headerless page. Without an applied mapping, serialized
reconstruction output is unchanged.

Applied revisions are recorded in each page's `customer_header_mapping_pins`,
including revision ID/digest/schema, org/document type, physical page/page digest,
exact label/column index and ordered source observations. The existing pricing
admission gates still decide whether reconstructed rows are usable.

The Step 1 shadow graph consumes source sidecar observations and category
presence, not this reconstruction. Those inputs are unchanged, so its parser
manifest/publication identity is unchanged.

## B8.2d historical friction

Diagnostics read pins from the stored interpretation and retain diagnostic IDs.
Pins travel through attention diagnostics and resolution cases into optional
tenant-local friction provenance. Manual source-row assertions store optional
action-time `customer_mapping_evidence` bound to the exact stored extraction,
page digest and selected row observations. Existing assertions without this
provenance remain unknown; they are not backfilled from current mappings.

The platform-facing B8.3 signal allowlist and Orchestrator prefill stay unchanged.
Customer labels and tenant-local mapping evidence never enter those payloads.
Proposal and outcome evidence uses the historical extraction ID stored when the
request was made, with org/document/artifact/page/digest checks. Validator
overrides without an interpretation snapshot keep their mapping provenance
unknown rather than consulting current configuration.

Deployment sequence: apply the reviewed migrations before deploying consumers.
For rollback, disable lifecycle RPC access and roll back consumer code while
retaining revisions/events/assertion evidence. Do not delete historical data.
Production migration application and merge still require exact owner approval
under repository policy; local implementation does not authorize them.

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
node node_modules/vitest/vitest.mjs run lib/server/customerHeaderMappingLifecycle.test.ts lib/server/customerHeaderMappingRoutes.test.ts lib/server/regionAssertionMappingRoute.test.ts lib/server/frictionHistoricalMappingRead.test.ts --maxWorkers 1 --no-file-parallelism --testTimeout 120000 --hookTimeout 120000
node node_modules/typescript/bin/tsc --noEmit --incremental false
npm run build
# From the worktree under WSL Ubuntu, using its disposable local Postgres only:
# bash scripts/verify-customer-header-mapping-postgres.sh
```
