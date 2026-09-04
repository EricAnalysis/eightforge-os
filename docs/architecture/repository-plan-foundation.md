# Repository-aware Plan V2: B1 trusted foundation

B1 introduces `buildRepositoryPlanFoundation`, a dormant, pure builder with no
production consumers. It produces domain `eightforge.repository-plan-foundation`,
schema version 1, stage `pre_provider_foundation`. This is deliberately distinct
from completed Plan V2. It contains no provider provenance, generated guidance,
prompts, timestamps, persistence, or execution integration.

## Trust and source identity

The internal input contract requires an already trusted in-memory Plan V1 artifact
and the branded result of local `verifyRepositorySnapshot`. Like the existing V1
builder, it does not authenticate arbitrary JSON. A digest proves identity, not
origin or authorization. Casting a type or parsing a schema cannot establish trust.
There is no browser, request, UI, API, or production server composition in B1.
A future integration must preserve direct trusted-source composition and receive
its own review before any consumer allowlist changes.

The builder validates V1's complete transport shape, provenance pin coherence,
disposition/readiness semantics, and complete canonical digest. It copies the V1
domain/version/digest, all four reviewed workflow pin fields, and the inherited
effective-reviewed-specification digest without rereading intake or resolver
evidence. It rejects non-JSON values and caller serialization hooks. Its output is
detached and deeply frozen.

## Repository snapshot

`lib/server/repositoryPlanSnapshot.ts` inspects only local Git and requires an
expected full lowercase SHA-1 commit. The root directory selects the repository;
the remote identity comes exclusively from local `remote.origin.url`. Supported
HTTPS, `git@host:path`, and `ssh://git@host/path` identities normalize to HTTPS
identity spelling without a trailing `.git`; this normalization performs no network
request. Local paths, credentials, query strings, and remote helpers are rejected.

The strict snapshot carries `repositoryUrl`, `objectFormat: 'sha1'`, `commitSha`,
informational `branchName` (null for detached HEAD), `worktreeDirty: false`,
`untrackedPolicy: 'excluded_from_trusted_manifest'`, and
`submoduleStatus: { state: 'none' }`. Both staged and unstaged tracked changes
fail closed. All submodules are unsupported in B1 and fail closed, rather than
claiming their recursive content has been verified. Unsupported index flags and
applied content filters also fail closed. Installed but unused LFS filters are
allowed. Git's read-only `hash-object --stdin-paths` also compares actual normalized
file bytes against index blob identities, rejecting edits hidden by timestamp
caching. Unsupported symlinks/special index modes fail closed. Inspection disables
optional Git locks and fsmonitor and never executes
a shell, network operation, checkout, repair, staging, commit, or push.

The snapshot describes the inspected state, not a filesystem lock. Future evidence
collection must read immutable objects at the exact commit and reject HEAD/source
mismatch; it must never read later working-tree content under an old snapshot.

## Scoped evidence and manifest

The B1 collector is a **contract only**, not a registered content collector. There
is no repository search, content acquisition, provider, or recommendation engine.
Internal manifest/evidence inputs must come from trusted committed-blob inspection;
schema validation alone does not prove that a file exists or that content matches
its blob. No external caller may submit such records as trusted evidence. A future
collector must supply only regular committed blobs, verify Git blob identity, and
enforce its fixed budgets: 200 files, 64 KiB per file, 1 MiB total UTF-8 content.
An empty manifest is truthful when nothing has been inspected.

Each manifest entry carries a literal repository-relative path, exact commit,
required Git blob SHA, and classification authorizing inspection. Paths reject
absolute/Windows/UNC/URL syntax, traversal, backslashes, empty components, encoded
escapes, globs, device names, and alternate streams. The intentionally portable
path subset can reject otherwise legal Git filenames.

| Classification | Allowed inspection surface |
| --- | --- |
| RULE / VERIFY | `lib/rules/`, `lib/validator/rulePacks/`, including colocated tests |
| EXTRACT | `lib/documentTypes.ts`, `lib/extraction/` |
| RECOVER | `lib/forgewing/`, exact compliance-shadow implementation and two tests |
| HUMAN | Exact workflow-task server/type files and four named authority migrations |
| ADVISORY | No inspection roots |

The exact HUMAN migration paths and RECOVER filenames are enumerated in
`repositoryPlanEvidence.ts`. Merely naming authority source files does not import
or execute them. Root expansion requires a reviewed source change; no caller
override exists. Manifest classifications must occur in V1's planned steps.

Evidence records contain path, commit, classification, optional symbol, closed
evidence kind, bounded reason, and optional relevant test path. Evidence and tests
must be members of the same classification's pinned manifest. All commits must
match the snapshot; a path cannot identify different blobs across scopes.
Identical duplicate records are collapsed; conflicting blobs fail. Ordering uses
canonical record bytes with ordinal comparison, independent of locale and input
order. Output schema validation also rejects noncanonical ordering/duplicates.

The future step-guidance schema defines closed classification-specific kinds and
requires evidence for implementation recommendations. ADVISORY permits only
`no_implementation_required` with no scan. The speculative product/documentation
change kind is deferred because B1 has no basis for justifying it. Evidence
classifications must match guidance classification. No guidance is generated;
future completed-output validation must additionally bind step IDs and evidence
to the exact input manifest and define genuine provider provenance.

## Authority, digest, and failure

All artifacts require `authority: 'non_authoritative'`, `executable: false`,
`grantsExecutionAuthority: false`, and `requiresHumanReview: true`. There is no
approval status and no permission to execute. Human review is a requirement,
not an assertion that review occurred.

The existing `canonicalJson` and `hashCanonical` primitives cover the entire
foundation envelope except its own digest, including authority, source identities,
snapshot, manifest, and evidence. Digest metadata remains SHA-256 and
`recursive-key-sorted-json-v1`. No second canonicalization algorithm is introduced.

Failures return no partial artifact. Snapshot failures distinguish unavailable
Git, malformed/unsupported identity, missing remote, HEAD mismatch, dirty tracked
state, unsupported paths/configuration/submodules, and malformed Git state.
Builder failures distinguish invalid V1, invalid V1 digest, and invalid repository
evidence. There is no repair, branch fallback, retry, or caller override.

## Boundaries and verification

The AST guard fixes the complete runtime import graph to Zod, the snapshot/evidence
schemas, the existing wire schema, and the shared hash helper. V1 and verifier
imports in the foundation are erased types. The verifier alone may use its narrow
read-only Git subprocess wrapper. Provider/database/mutation dependencies,
computed runtime access, and all external production consumers are rejected.
The existing V1 production runtime consumer remains its original trusted read seam.
The wire-schema guard permits one exact additional pure consumer: this foundation.
The Forgewing textual guard permits only the literal inspection root in the evidence
module's `roots.RECOVER` array. Its import consumer allowlist remains unchanged;
additional mentions and imports still fail. The verifier guard pins full command
argument arrays, including rejection of write-producing `diff --output` and
`hash-object -w` variants.

Focused tests cover malformed inputs, pin preservation, digest sensitivity,
detachment, immutable authority, scope/path/blob/commit closure, deterministic
duplicates/order, and Git fixture state. Negative probes include tracked-file
edits/restoration, branch-as-SHA, traversal, wrong commits, absolute paths,
unauthorized roots, provider imports, and a fake Codex consumer. Temporary Git
fixture setup is test-only; runtime does not write repository files.

Verification commands:

```text
npx vitest run lib/repositoryPlanFoundation.test.ts lib/repositoryPlanEvidence.test.ts lib/repositoryPlanSnapshot.test.ts lib/server/repositoryPlanSnapshot.test.ts lib/architecture/repositoryPlanFoundationBoundaries.test.ts lib/architecture/workflowImplementationPlanBoundaries.test.ts lib/workflowImplementationPlan.test.ts lib/workflowImplementationPlanWire.test.ts lib/architecture/workflowImplementationPlanWireBoundaries.test.ts lib/server/workflowImplementationPlanRead.test.ts lib/server/workflowImplementationPlanRead.integration.test.ts lib/server/workflowImplementationPlanRoute.test.ts --maxWorkers=2 --testTimeout=120000 --hookTimeout=120000
npx tsc --noEmit
npm run build
npx vitest run --maxWorkers=2 --testTimeout=120000 --hookTimeout=120000
git diff --check
```

No commit, push, merge, deployment, provider enablement, or production consumer is
authorized by B1. Suggested eventual commit subject after review:
`feat: add repository-aware plan pre-provider foundation`.

## B1 delivery verification (2026-09-04)

Preflight: `main` and local `origin/main` both pointed to
`d26d9142e1c8b9081aab334a60ab424e110a6378`; tracked state was clean, Git used
SHA-1, origin was `https://github.com/EricAnalysis/eightforge-os.git`, and no
submodules were reported. Three existing untracked Phase A audit documents were
excluded from evidence and left untouched. Work is uncommitted on
`codex/phase-11e-b1-trusted-foundation`, based on that exact commit.

- Foundation/evidence: 37 tests passed. Snapshot schema/verifier: 32 passed.
- Final architecture slice: 158 tests passed across four files, including V1,
  wire, Forgewing, and B1 boundaries. Existing V1 functional regressions passed.
- Actual provider-import and fake Codex-consumer source probes failed their
  guards and were restored. A-F invalid-state/input probes also passed.
- Final `npx tsc --noEmit`, `npm run build`, and tracked/new-file whitespace
  checks passed. Build reported the two existing pdfjs-dist worker warnings.
- Final full Vitest: **4,319 passed, 23 skipped; 354 files passed, four skipped**,
  exit 0, no worker errors, 193.36 seconds, with two workers and 120-second
  test/hook headroom. The earlier full run exposed the literal inspection-root
  guard conflict; the narrow correction passed the final complete rerun.
- Early default-timeout fixture/scan runs encountered execution contention;
  generous headroom and yielding between synchronous Git fixtures resolved it.
  Tests and production semantics were not weakened.
- Real provider calls: zero. Runtime repository writes: zero. No project commit,
  push, merge, deployment, database persistence, or production consumer added.

No known blocking B1 defects remain. Content collector implementation, completed
provider output/provenance validation, production trust composition, persistence,
and UI remain explicitly deferred. Claude Code review may begin.
