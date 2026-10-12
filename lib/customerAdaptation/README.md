# B8.1 customer header mapping contract

This module is contract-only. No production consumer, persistence, activation,
UI, provider call or new authority is introduced.

`ReviewedCustomerHeaderMappingRevision` binds organization/revision UUIDs,
SHA-256 identity, exact document type and source-schema scope, exact source
labels, existing target roles, opaque supporting evidence references, declared
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
matched evidence reference. Construction clones inputs and deeply freezes the
result; resolution neither mutates nor freezes input.

A digest proves object identity, not authentic human approval or evidence access.
Supporting evidence references are opaque: this module does not dereference or
prove their tenant ownership. The future trusted persistence/approval boundary
must authenticate approval actors, check evidence ownership, enforce revision
uniqueness and supersession chains, and choose exactly one approved revision for
the requested scope. It must reject overlapping active revisions; this resolver
does not select a winner among revisions. The future consumer must pass *all*
existing recognition, not filter out supporting roles, and must retain the
revision identity alongside unchanged source labels, values and geometry.

Storage, approval/activation roles and production integration remain unresolved.
No approval metadata in this contract grants activation, publication, pricing,
canonical mutation or execution authority.

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
node node_modules/typescript/bin/tsc --noEmit --incremental false
```
