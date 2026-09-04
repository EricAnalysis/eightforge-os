# Workflow implementation plan V1

`buildWorkflowImplementationPlan` in `lib/workflowImplementationPlan.ts` projects
one `EffectiveReviewedSpecificationArtifact` into a deterministic description of
implementation readiness. It returns `{ ok: true, artifact }` or
`{ ok: false, code: 'invalid_artifact' }`. It reads no additional context and has
no authorized production consumers.

The artifact uses domain `eightforge.implementation-plan`, `schemaVersion: 1`,
`authority: 'non_authoritative'`, `executable: false`, and
`grantsExecutionAuthority: false`. `specification_complete` describes the
specification only; it grants no permission to execute or promote anything.

| Effective classification | Readiness state | Closed detail |
| --- | --- | --- |
| RULE | `blocked_structural` | `blocker: 'rule_definition_is_code'` |
| VERIFY | `blocked_structural` | `blocker: 'rule_definition_is_code'` |
| HUMAN | `blocked_structural` | `blocker: 'no_organization_for_task'` |
| EXTRACT | `requires_operator_decision` | `decision: 'source_document_taxonomy'` |
| RECOVER | `requires_operator_decision` | `decision: 'recovery_vocabulary_unresolved'` |
| ADVISORY | `specification_complete` | none |

The mapping examines classification alone. It never interprets specification
prose, generates rules, assigns organization ownership, maps document types, or
integrates recovery behavior.

`plannedSteps` is mapped exclusively from `effectiveImplementationSet` in its
existing order. Each entry carries `stepId`, `effectiveClassification`,
`specification`, `provenance`, `originalClassification`, `disposition`,
`specificationSource`, and `implementationReadiness`. Specifications and
provenance retain exact resolver values, including whitespace. Schema parsing
validates but its potentially normalized output is not used for projection.

`rejectedSteps` carries complete rejected resolver step objects from `steps`,
in their existing order. Rejected steps never appear in `plannedSteps`. An
all-rejected input produces an empty planned set and a valid plan digest.

`source.pin` copies the resolver pin and
`source.effectiveReviewedSpecificationDigestSha256` copies its digest value.
The complete plan envelope, including domain, schema version, authority
literals, source, both step collections, specifications, provenance, and
readiness, is hashed with the existing `hashCanonical` primitive. Only the
plan's own `digest` field is excluded. Digest metadata is `algorithm: 'sha256'`
and `encoding: 'recursive-key-sorted-json-v1'`. A changed source digest changes
the plan digest. The source digest is an identity pin, not independently
recomputed evidence validation or authorization.

The existing `canonicalJson` primitive also serializes the envelope before a
JSON parse detaches every nested output object and array from caller input and
the readiness constants. Mutations in either direction cannot affect the
other artifact. Repeated planning yields identical serialized output and digest;
array order remains unchanged. There are no timestamps or transient metadata.

Validation fails closed for non-JSON values, malformed projection shapes,
unknown classifications, absent or malformed pin/digest/authority fields,
invalid classification-specific specifications, duplicate step identities,
provenance pin mismatches, incoherent dispositions, and an implementation set
that differs from the non-rejected steps, including ordering. Evidence is
checked as JSON record containers; historical assessment/review evidence is
not re-resolved. The caller supplies an artifact from the existing resolver.
Malformed inputs are never repaired and no source evidence is reread.

The architecture guard fixes dependencies to Zod, an erased resolver type
import, the shared reviewed-specification schemas, and the existing hash
primitive. It bans dynamic/computed imports and runtime IO or nondeterminism,
and enforces an empty production consumer set. The resolver's existing server
read seam remains its only runtime consumer. There is no plan persistence,
route, UI, provider call, task integration, rule registry change, extraction
integration, or canonical/Validator/Project Truth/decision/action consumer.

## Phase B verification (2026-09-03)

Base `17ce4c7` and the Phase A audit were checked before implementation.
The implementation changes five files and makes zero real provider calls.

- Focused plan suite: 62 passed. Combined plan, resolver core/read seam,
  both boundary suites, and import boundaries: 265 passed across six files.
- `npx tsc --noEmit`: passed.
- `npm run build`: passed; reports pdfjs-dist worker externalization warnings.
- `git diff --check` and staged diff check: passed.
- Full `npx vitest run --maxWorkers=2 --testTimeout=60000 --hookTimeout=60000`:
  4,003 passed, 23 skipped, one pricing-scope timeout, and two worker
  `onTaskUpdate` RPC timeout errors. This is **not a clean full-suite pass**.
  The pricing-scope and concurrent canonical-domain-coverage files both
  recorded about 1,481 seconds during an apparent execution interruption.
  Independent rerun with one worker and 120-second test/hook headroom passed
  all 62 tests in 3.96 seconds; no fixture or production-code changes were
  made to obtain that result.

All five deliberate break-and-restore probes failed their targeted tests:
RULE marked complete (one failure); rejected steps appended to planned steps
(one); planned steps sorted by step ID (one); shallow envelope copy (both
detachment directions failed); resolver digest omitted from the hash envelope
(one). Original core bytes were restored and the 265-test combined run passed
after restoration. Broken variants are not part of the implementation.
