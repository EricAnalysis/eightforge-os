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
and permits exactly one production consumer: the trusted implementation-plan
read seam described below. The resolver's existing server read seam remains
its only runtime core consumer. There is no plan persistence, UI, provider
call, task integration, rule registry change, extraction integration, or
canonical/Validator/Project Truth/decision/action consumer.

## Trusted GET consumer

`GET /api/internal/workflow-assessments/[assessmentId]/implementation-plan`
requires exactly three query parameters: `assessmentVersion`, `reviewId`,
and `reviewVersion`. Together with the path UUID they form the complete
immutable pin. Versions use positive decimal integer strings in the range
1–2147483647. Missing, duplicate, unknown, or malformed parameters are
rejected; request bodies are not parsed or accepted.

The route calls only `readWorkflowImplementationPlan(request, pin)`. That seam
awaits `readEffectiveReviewedSpecification(request, pin)` and immediately
passes the same `resolved.artifact` to `buildWorkflowImplementationPlan`.
There is no serialization, artifact reconstruction, digest recomputation,
evidence reload, or latest fallback between the two calls. Both production
consumer boundaries name this exact seam; only this exact GET route may
consume the new seam. AST and object-identity regression tests guard the
direct composition.

Authorization is inherited from the resolver read seam: `getActorContext`
then `resolveWorkflowPlatformReviewAccess`. It requires an explicit platform
allowlist and does not add an owner/admin, cron, or anonymous fallback.

Success returns `{ ok: true, plan: artifact }` with the builder's complete plan unchanged:
domain, schemaVersion, non-authority literals, source pin and resolver digest,
plannedSteps, rejectedSteps, and plan digest. Raw resolver evidence is absent.
Readiness, specifications, and audit provenance are projections from Plan V1.
Responses use `Cache-Control: no-store`; each request recomputes from immutable
evidence without a cache or database write.

Failures return `{ ok: false, error: code }`, with no partial plan or resolver
validation paths. Status mapping: `unauthorized` 401; `reviewer_not_eligible`
403; `invalid_pin` 400; `assessment_not_found` / `review_not_found` 404;
`not_configured` 503; `read_failed` / `plan_not_composable` 500; all other
resolver incompatibility codes 422. A rejected trusted artifact is an internal
resolver/builder contract failure, so it returns 500 and logs a fixed message
without evidence. Unsupported mutation methods follow Next.js route behavior.

Historical incompatibility affects only the requested pin. No historical sweep
or recovery integration is part of this consumer.

Consumer verification at base `aef9556`: 343 tests passed across nine focused
suites (new seam, GET route, real resolver/builder integration, existing
resolver and plan suites, both boundary suites, and import boundaries).
All five actual break-and-restore probes failed: route importing the builder,
cloned resolver artifact, generic plan allowlist, generic resolver allowlist,
and removed review-version query filter. Functional server-prefix allowlist
bypasses were also rejected. All original source bytes were restored before
the combined focused run. Real provider calls: zero.

Final consumer gates: `npx tsc --noEmit`, `npm run build`, and
`git diff --check` passed. Build retained the existing two pdfjs-dist worker
externalization warnings. Full Vitest with `--maxWorkers=2 --testTimeout=120000
--hookTimeout=120000` passed: 4,082 tests passed, 23 skipped; 346 files passed,
four skipped, no worker errors (215.05 seconds). No live database, Preview,
deployment, or historical sweep was performed.

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
