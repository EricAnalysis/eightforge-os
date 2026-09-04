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
allowed. Unsupported symlinks/special index modes fail closed.

Verification creates a fresh OS-generated temporary directory outside the resolved
repository root and its Git/common metadata directories. It checks the resolved
temporary parent before creating anything; containment or filesystem failures fail
closed. Every call constructs a new external index using
`read-tree --no-sparse-checkout <captured-SHA>`. No real-index stat metadata is
copied. Comparing the real index's stage/mode/blob/path records with this HEAD-derived
index independently rejects staged additions, deletions, renames, mode changes and
content changes, even when the worktree matches HEAD.

Git then compares the worktree against that external index using exactly
`diff --no-ext-diff --no-textconv --no-renames --no-relative --name-only -z --`.
Git remains the content-conversion authority, including CRLF-in-index safeguards
and ordinary LF-blob/CRLF-checkout behavior. Fresh stat metadata forces content
comparison, including equal-length edits with restored mtime under relaxed stat
settings. No custom line-ending conversion is implemented. Untracked files remain
excluded from trusted manifests and tracked-content comparison.

All inherited `GIT_*` variables are scrubbed. Verification sets optional locks off,
replacement objects off, terminal prompts off, and lazy fetching off. The external
Git wrapper additionally isolates hooks in an empty temporary directory, disables
fsmonitor, split index, sparse checkout/index, untracked cache and automatic
maintenance, and retains `diff.autoRefreshIndex=true`. Applied `filter` attributes
are rejected in both cached and worktree attributes before comparison: clean/process
filters can run arbitrary programs despite `--no-ext-diff --no-textconv`.

Git's diff may refresh its selected index even with `GIT_OPTIONAL_LOCKS=0`.
Consequently **all constructing/refreshing commands target only the external
index**. It is discarded and never reused. Reading an actual split index can also
freshen a shared index's timestamp. The verifier rejects any `sharedindex.*` file
in the real Git directory before running an index reader, including harmless orphan
files. A split-index configuration alone remains supported when no shared index
exists; the disposable index always disables split-index behavior.

The runtime contract is **zero runtime repository writes**, not zero file writes:
no working-tree, real index, config, refs, logs, or object-database writes. Ephemeral
external files and their index locks are permitted solely for verification, are
non-authoritative, and must be removed in `finally` before trusted success returns.
Creation or cleanup failure returns `repository_unavailable`, with no trusted
snapshot. Process termination or power loss may leave temporary files; later runs
never reuse them or consume them as evidence. Git subprocesses have bounded buffers
and a 120-second per-command timeout. No shell, network operation, checkout,
repository repair, staging, commit, or push is part of verification.

HEAD, origin configuration, real-index entries and flags are rechecked after
comparison. A changed HEAD returns `head_mismatch`; other identity changes fail
closed. This establishes a bounded read-only observation, **not atomic filesystem
snapshot isolation**. Residual races include concurrent content/config/attribute
changes and HEAD changing away and back between checks; no locking is introduced.
Future evidence
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
Git subprocess wrappers and external temporary-directory filesystem primitives.
Provider/database/repository-mutation dependencies,
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
fixture setup is test-only; runtime does not write repository files. The verifier's
filesystem allowance is limited to fresh external verification state and its cleanup.

The actual-checkout gate is opt-in so ordinary development with tracked edits does
not create a flaky unit test. When enabled, a dirty tracked checkout is a failure,
not a skip. It compares tracked/untracked content and Git metadata identities before
and after verification, including any existing untracked audit documents. It does
not inventory ignored dependencies/build output or write any files:

```powershell
$env:EIGHTFORGE_VERIFY_ACTUAL_CHECKOUT = '1'
npx vitest run lib/server/repositoryPlanSnapshot.actual-checkout.test.ts --maxWorkers=1 --testTimeout=120000 --hookTimeout=120000
Remove-Item Env:EIGHTFORGE_VERIFY_ACTUAL_CHECKOUT
```

Verification commands:

```text
npx vitest run lib/repositoryPlanFoundation.test.ts lib/repositoryPlanEvidence.test.ts lib/repositoryPlanSnapshot.test.ts lib/server/repositoryPlanSnapshot.test.ts lib/architecture/repositoryPlanFoundationBoundaries.test.ts lib/architecture/workflowImplementationPlanBoundaries.test.ts lib/workflowImplementationPlan.test.ts lib/workflowImplementationPlanWire.test.ts lib/architecture/workflowImplementationPlanWireBoundaries.test.ts lib/server/workflowImplementationPlanRead.test.ts lib/server/workflowImplementationPlanRead.integration.test.ts lib/server/workflowImplementationPlanRoute.test.ts --maxWorkers=2 --testTimeout=120000 --hookTimeout=120000
npx tsc --noEmit
npm run build
npx vitest run --maxWorkers=2 --testTimeout=120000 --hookTimeout=120000
git diff --check
```

B1 artifacts grant no commit, push, merge, deployment or provider execution
authority. Repository development actions require their own user authorization.

## Original B1 delivery verification (2026-09-04, historical)

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

The original gates above did not exercise the verifier against the actual checkout.
Claude subsequently identified the blocking CRLF clean-tree rejection at
`044683d544627dacf981da850ce5da2f5897602c`; the original no-blocker conclusion was
incorrect. The external-index remediation requires its own local gates and Claude
delta review before merge. The investigation demonstrated byte-identical manifests
across 84,394 real-checkout files; that expensive inventory is investigation evidence,
not normal test or runtime behavior. Content collector implementation, completed
provider output/provenance validation, production trust composition, persistence,
and UI remain explicitly deferred.
