# B8.2 customer mapping ownership and authority audit

Base: `91a907f67104fa929525f77833f0742da062e51e` (verified origin/main).
Original audit status: STOP before implementation under the owner's
evidence-ownership stop condition. The subsequent owner decisions and B8.2a
reconciliation below supersede that policy/design blocker. The original findings
remain preserved as audit history.

## Confirmed foundations

- `lib/server/getActorContext.ts:38-116`: bearer token validated by Supabase
  Auth; actor ID and organization/role read from the authenticated profile.
- `lib/server/projectAdmin.ts:77-101`: document reads filter organization and
  document ID. `lib/projectAdmin.ts:1-12` defines owner/admin roles;
  `lib/server/projectAdmin.ts:49-60` applies them to project administration.
- `app/api/documents/[id]/facts/region-assertions/route.ts:87-92` checks document
  organization before preparing an operational assertion.
- `lib/server/regionAssertionRequest.ts:145-171` calls existing
  `verifyRegionEvidence` (`lib/humanFactAssertions/regionBoundAssertions.ts:547-583`)
  to bind page representation and observation IDs and derive original text.
- `app/api/internal/forgewing-recovery-review/route.ts:52-69` binds review identity
  to authenticated actor/org. The review authorizes later explicit reprocess,
  not recurring organization configuration (comments at lines 14-15).
- `supabase/migrations/20260723163517_phase3_step0_compliance_foundation.sql:20-64,282-343`
  and `supabase/migrations/20260810191912_harden_extraction_dependency_closure_invariant.sql:22-42,181-229`
  provide tenant/source and verified-field dependency closure. Schema closure is
  not proof of a runtime mapping evidence resolver.

## Blocking gaps

1. B8.1 `supportingEvidenceRef` is an arbitrary nonblank string
   (`lib/customerAdaptation/headerMapping.ts:27`). Existing region verification
   establishes a page observation, not that this arbitrary reference identifies
   the exact priced-schedule header in the approved mapping scope. Existing
   header recovery candidates are source-specific; no reusable mapping-reference
   binding contract exists. Do not accept a populated reference or owned document
   as sufficient approval evidence.
2. No existing permission defines who approves, activates or withdraws reusable
   organization mappings. Project administration, operational recovery and
   internal engineering allowlists have different scopes. Extending one to
   recurring customer adaptations requires an explicit human policy decision.
3. `sourceSchemaIdentity` is mandatory in B8.1 but has no trusted producer in the
   extraction/job interfaces. A client-supplied name or document title cannot
   decide which mappings apply.

## Proposed decisions for the owner

- Restrict approve/activate/withdraw to authenticated organization owners/admins,
  using the existing role vocabulary and same-org checks. Approval and activation
  must be distinct recorded actions; existence/approval alone grants no usability.
  Decide whether the same person may perform both actions.
- Define a typed evidence binding containing document, extraction snapshot,
  source artifact, physical page, page representation digest, exact observed
  header label and ordered source observation identities. Reuse existing owned
  document/current-observation verification, then prove header membership against
  persisted header interpretation/source refs. Reject stale, partial, ambiguous
  and scope-mismatched bindings before any persistence. This would be a new narrow
  evidence resolver, not an already-established runtime capability.
- Specify a trusted source-schema binding. A customer schema registry does not
  exist in the inspected path. Do not silently substitute parser version for
  customer source-schema identity or derive it from text/names.

These are recommendations, not authorized policy or implemented contracts.

## Reusable implementation seams after the blockers are resolved

- Append-only revision payloads and lifecycle events; approval never implies
  activation. Atomic activation enforces one active revision per organization,
  exact scope and exact source label, while retaining supersession/withdrawal
  history. No auto-reactivation of predecessors on withdrawal.
- Load authorized mapping context once in
  `app/api/jobs/process/[jobId]/route.ts:181-198`; its complete extraction payload
  is already stored with org/document identity at `:242-250`.
- Pass the immutable context into `buildPagePricedScheduleReconstruction` at
  `lib/server/documentExtraction.ts:2273-2307`. Pin revision ID and digest in the
  existing reconstruction JSON output (`:1564`); preserve labels, values and
  geometry. No parallel interpretation store is needed.
- Carry pins from the persisted extraction, not current active config, through
  `lib/server/documentDiagnosticsRead.ts:226-241`,
  `lib/server/documentEvidenceAttention.ts:10-23,39-46`,
  `lib/resolution/resolutionCases.ts:344-351` and existing friction evidence.
  Current strict `lib/diagnostics/failureDiagnostic.ts:133-137` needs only the
  minimum additive provenance contract. Preserve historical diagnostic IDs.
- Preserve no-mapping serialized outputs. No B8.3 intake, B8.4 states, providers,
  fuzzy matching, new roles, unit equivalence or cross-tenant reuse.

## Verification required when implementation is authorized

Focused tests: authenticated role/same-org allow-deny matrix; exact header evidence
ownership and stale/malformed evidence; immutable revision/digest binding;
approval without activation inertness; concurrent activation uniqueness;
supersession preservation; withdrawal inertness/no predecessor fallback;
interpretation replay pins; downstream friction uses historical pins; unchanged
no-mapping output.

Run the new focused Vitest slice, affected interpretation/friction regression,
TypeScript and fresh disposable PostgreSQL migration replay with role/ACL/RLS,
immutability, race and rollback/forward-fix probes. Existing WSL PostgreSQL replay
tooling is available; no replay was executed for this audit. No full suite was run.

Production migration application/merge requires separate exact owner approval
under AGENTS.md. This audit does not authorize production schema changes.

## Owner decisions and B8.2a reconciliation

The owner authorized the narrow evidence/schema prerequisite before persistence:
owner/admin approve, activate and withdraw; the same actor may approve and
activate, but those are separate audited actions and timestamps. No action or
persistence schema is implemented by this prerequisite.

Implemented typed, strict header bindings and a versioned structural schema
producer, with authenticated read-only retrieval through existing actor and
organization-scoped server paths. The verifier proves document/project/extraction/
artifact ownership, exact ordered header observation closure, persisted page
digest and declared schema scope. Mapping contract version 2 rejects legacy
arbitrary references and inconsistent evidence scope.

The producer deliberately fails closed for unsupported inherited, segmented,
selected or ambiguous headers, mixed native/OCR refs and absent materialized
observations. Single-row, contiguous observed headers with current persisted
evidence are supported. No parser output, canonical roles, pricing semantics or
global recognition logic changes.

Independent review caught an implementation assumption that persisted bands
carry `column_index`; the actual producer uses array order. The verifier now
uses that established order and rejects only an explicitly inconsistent index.
Positive fixtures omit the field, matching the producer. Review also confirmed
the authenticated read path and tenant filters without repeating test execution.

B8.2b must call the verifier with freshly server-loaded evidence before approval;
typed shape or revision digest is insufficient. Activation must be separate and
enforce one active revision per org + scope + exact source label. B8.2c and B8.2d
must pin the actual used revision on interpretation and historical friction.
These remain future implementation, alongside immutable revision/event history.

No migrations, database writes, providers, broad UI, B8.3 intake wiring or B8.4
deployment/recurrence states are included. This checkpoint stops at B8.2a.

Verification: 101 tests pass across the evidence (38), mapping (27), authenticated
reader (8), GET route (10), existing layout observation closure (13) and preferred
blob selection (5) suites. TypeScript `--noEmit --incremental false` passes. No
full-suite, production DB or migration replay was run; this change adds no SQL.
