# Repository-aware Plan V2: trusted production topology

The production topology is now an outbound worker pipeline:

```text
authorized Vercel operator route
  -> non-authoritative Supabase generation job
  -> trusted Forgewing Engineering Worker with a clean real Git checkout
  -> B1 foundation + committed evidence catalog
  -> B1.5 exact committed-object collection
  -> B2a contained input -> B2b zero-or-one provider call
  -> B3a immutable non-authoritative Plan V2 persistence
  -> existing human engineering review
  -> existing explicit operator-only Linear projection
```

The route accepts only `assessmentId`, `assessmentVersion`, `reviewId`,
`reviewVersion`, and one classification. It re-derives Plan V1 server-side and
queues its digest; it never receives a repository root, commit, evidence,
provider configuration, prompt, or output. The worker re-derives the same exact
reviewed source before doing any repository or provider work.

Forgewing suggests. Human decides. Plan V2 and the job remain
non-authoritative, non-executable, and human-review-required. Successful
generation never accepts a recommendation, changes canonical truth, executes
code, deploys, or invokes Linear.

## B1 trusted foundation

B1 provides `buildRepositoryPlanFoundation`, a pure builder consumed only by the
trusted production worker. It produces domain `eightforge.repository-plan-foundation`,
schema version 1, stage `pre_provider_foundation`. This is deliberately distinct
from completed Plan V2. It contains no provider provenance, generated guidance,
prompts, timestamps, persistence, or execution integration.

## Trust and source identity

The internal input contract requires an already trusted in-memory Plan V1 artifact
and the branded result of local `verifyRepositorySnapshot`. Like the existing V1
builder, it does not authenticate arbitrary JSON. A digest proves identity, not
origin or authorization. Casting a type or parsing a schema cannot establish trust.
There is no browser/request composition in B1. The production worker is the one
exact reviewed integration and preserves direct trusted-source composition;
additional consumers require an explicit guard change and review.

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

The B1 evidence contract is populated in production only by the exact committed
catalog loader. There is no repository search, heuristic ranking, provider-selected
discovery, or caller-supplied manifest.
Internal manifest/evidence inputs must come from trusted committed-blob inspection;
schema validation alone does not prove that a file exists or that content matches
its blob. No external caller may submit such records as trusted evidence. B1.5a
removes the obsolete future collector port that accepted a caller-selected `files`
array. Its pure content contract has no arbitrary path, glob, root, search-result,
or provider-selected file-list input. A future collector must supply only regular
committed blobs, verify Git blob identity, and enforce its fixed collection safety
budgets against **raw committed blob bytes**: 200 files, 64 KiB per file, and 1 MiB
total. This is distinct from the later, smaller B2 provider-input budget; B1.5
performs no token counting. An empty manifest is truthful when nothing has been
inspected.

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

## B1.5a committed-content contract

`lib/repositoryPlanContent.ts` remains a pure contract and is composed by the
trusted worker through the qualified collector. It selects one classification at a time by walking the foundation's
already canonical evidence order. Each evidence `filePath` is selected as source;
its explicit `relevantTestPath`, when present, is selected as a relevant test.
Both must resolve in the same classification manifest. Manifest-only paths are
authorization, not selection, and are never eagerly collected. Selection is
deduplicated by evidence ID; first occurrence fixes position and roles merge in
the fixed `source`, `relevant_test` order. ADVISORY yields a valid empty selection.
A non-ADVISORY classification with no manifest authorization fails closed.

Evidence IDs are full-width `ev_` plus `hashCanonical` over the fixed domain and
schema version together with exact commit, classification, path, and Git blob SHA.
Reason, symbol, evidence kind, relevant-test relationship, timestamps, foundation
digest, and provider data are excluded. The same blob in different classification
scopes therefore has different evidence IDs, while prose edits do not change the
content identity.

The schema fixes domain `eightforge.repository-committed-content`, version 1,
stage `pre_provider_content`, the non-authoritative/non-executable authority
literals, and `contentTrust: 'untrusted_repository_data'`. Each entry carries its
evidence ID, path, commit/blob identities, fixed regular-file mode, ordered roles,
exact UTF-8 content, raw byte length, and SHA-256 content identity. The artifact
binds the foundation digest, exact snapshot, one classification, fixed budgets,
collection counters, and all ordered content under the existing canonical digest.
Schema validation rechecks digest, counters, evidence IDs, content hashes and byte
lengths. Successful construction canonical-JSON detaches and deeply freezes the
result. B1.5a reads no Git objects and adds no collector; committed-object proof,
strict decoding, mode verification, and zero-write Git retrieval belong to B1.5b.

## B1.5b committed-object collector

`lib/server/repositoryPlanContentCollector.ts` accepts only a trusted foundation,
the separately supplied branded snapshot, one classification, and the verified
repository root capability. It revalidates the complete foundation and compares
the foundation snapshot with the branded snapshot using canonical identity. No
caller path, glob, branch, `HEAD`, search result, or provider input enters selection.
ADVISORY returns its deterministic empty bundle without Git.

For nonempty selections the collector runs exactly two Git command families with
no shell: `ls-tree -r -z --full-tree <exact commit SHA>` builds a complete in-memory
lookup, then `cat-file --batch` receives newline-separated exact blob SHAs. It never
reads source through `node:fs`, checkout paths, Git `show`, filters, text conversion,
or path-qualified revisions. It creates no temporary state and performs no writes.

Every selected path must occur in the same-classification manifest and exact commit
tree as a `100644 blob`; the tree and manifest blob SHAs must match. Executables,
symlinks, gitlinks, trees, missing objects, malformed/duplicate tree records,
malformed batch framing, unexpected object types, and identity mismatches fail the
entire collection. The Buffer batch parser verifies announced length, exact bytes,
framing newline, and Git's exit-zero `missing` response.

Raw committed blob bytes are the budget unit: 200 files, 65,536 bytes per file,
and 1,048,576 bytes total. There is no truncation, sampling, or partial success.
NUL, UTF-8 BOM, and invalid UTF-8 fail; fatal UTF-8 decoding otherwise preserves
LF, CRLF, bare CR, whitespace, comments, and trailing newlines exactly. Git blob
SHA-1 and independent SHA-256 of raw bytes remain distinct identities. This B1.5
collection ceiling is separate from the smaller future B2 provider budget.

All inherited `GIT_*` variables are scrubbed. Optional locks, replacement objects,
terminal prompts, and lazy fetching are disabled with bounded time and output.
Partial/promisor repositories work only for already-local exact objects; missing
objects fail without network access. Grafts do not alter an exact commit's tree.
Alternates may supply objects, but each still must match the pinned Git SHA and an
independent SHA-256. The deeply detached `{ ok: true, bundle }` remains
`untrusted_repository_data`; B2a owns prompt containment.

## Committed evidence catalog

`lib/repositoryPlanEvidenceCatalog.v1.json` is the versioned repository-owned
selection contract. Its schema contains only bounded literal classification,
path, evidence-kind, reason, optional symbol, and optional related-test fields.
The loader reads the catalog and every declared blob from the verified commit via
`git ls-tree` and `git cat-file --batch`; it never reads mutable worktree content.
All catalog entries for the requested classification are required. Overflow,
missing objects, invalid modes/UTF-8, NUL/BOM content, unauthorized paths, or an
invalid catalog fail the entire job without truncation.

The foundation, B2 input, and Plan V2 source chain carry the catalog's canonical
SHA-256 digest. Together with the repository snapshot commit and the fixed v1
catalog path, this makes the historical selection contract attributable without
making it canonical business truth.

## Durable job and worker authority

`workflow_repository_plan_generation_jobs` is operational coordination only.
Its closed state machine is `pending -> claimed -> succeeded|failed`; identity
and terminal rows are immutable. Atomic `SKIP LOCKED` claiming prevents two
workers from acquiring one job. A stale claim is recoverable only while the
durable provider-call count is zero. Once provider start is recorded, expiration
ends in failure and only a new explicit operator job may call again.

The dedicated `forgewing_engineering_worker` database role is carried by a signed
JWT and is not `service_role`. It can execute only claim, claim-bound exact-source
read, provider-start, success/failure, and the existing qualified B3a persistence
RPC. It has no direct job/B3 DML and no access to engineering-review, Linear, or
canonical mutation RPCs. Browser roles cannot call worker RPCs.

The worker first resolves the claimed review and recomputes Plan V1, verifies its
queued digest/classification, derives HEAD from its configured checkout, executes
the complete clean-tree verifier, loads the exact catalog, collects committed
content, prepares B2 input, then invokes the existing B2b seam. The durable
provider marker is written immediately before the provider boundary. ADVISORY and
insufficient-evidence outcomes bypass both that marker and the kill switch and
persist deterministic `callCount: 0` Plan V2 artifacts.

## Deployment and operations

Run the outbound worker with:

```text
npm run worker:repository-plan
```

The host requires Node.js, Git, a real clean EightForge checkout with local Git
objects and origin identity, and outbound access to Supabase and Anthropic. Worker
configuration is:

- `FORGEWING_REPOSITORY_ROOT` (required absolute checkout root)
- `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` (or the existing anon key)
- `FORGEWING_ENGINEERING_WORKER_ACCESS_TOKEN` with role exactly
  `forgewing_engineering_worker`
- provider credentials used by the existing Claude client
- `FORGEWING_SHADOW_ENABLED=1` and
  `FORGEWING_REPOSITORY_PLAN_GUIDANCE_ENABLED=1` to enable provider-required
  repository reasoning
- optional `FORGEWING_REPOSITORY_PLAN_POLL_INTERVAL_MS` (1,000-60,000; default
  5,000) and `FORGEWING_REPOSITORY_PLAN_ONE_SHOT=1`
- optional existing bounded model, timeout, and output-token settings

The historically named master shadow flag is retained as the operational kill
switch. Missing/malformed worker trust configuration fails closed. Disabling the
provider gate fails reasoning-required jobs without affecting deterministic
zero-call paths. Logs contain bounded job/result identity and typed failures, not
prompts, repository contents, raw provider output, rationale, or credentials.

Deployment requires applying the job migration, minting/rotating the dedicated
role JWT server-side, configuring the Vercel control plane's existing admin/auth
variables, and starting the worker. The first safe operational check is a one-shot
authorized ADVISORY job, followed by exact GET confirmation of a persisted
`callCount: 0` run before enabling a provider-required classification.

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
The B1.5 collector may use only its separately pinned `node:child_process`
wrapper for exact tree and batch-object reads; it has no filesystem, path, or OS
imports.
Provider/database/repository-mutation dependencies, computed runtime access, and
all external production consumers except the exact production worker graph are rejected.
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
$env:EIGHTFORGE_VERIFY_ACTUAL_COLLECTOR = '1'
npx vitest run lib/server/repositoryPlanContentCollector.actual-checkout.test.ts --maxWorkers=1 --testTimeout=120000 --hookTimeout=120000
Remove-Item Env:EIGHTFORGE_VERIFY_ACTUAL_COLLECTOR
```

Verification commands:

```text
npx vitest run lib/repositoryPlanContent.test.ts lib/server/repositoryPlanContentCollector.test.ts lib/repositoryPlanFoundation.test.ts lib/repositoryPlanEvidence.test.ts lib/repositoryPlanSnapshot.test.ts lib/server/repositoryPlanSnapshot.test.ts lib/architecture/repositoryPlanFoundationBoundaries.test.ts lib/architecture/workflowImplementationPlanBoundaries.test.ts lib/workflowImplementationPlan.test.ts lib/workflowImplementationPlanWire.test.ts lib/architecture/workflowImplementationPlanWireBoundaries.test.ts lib/server/workflowImplementationPlanRead.test.ts lib/server/workflowImplementationPlanRead.integration.test.ts lib/server/workflowImplementationPlanRoute.test.ts --maxWorkers=2 --testTimeout=120000 --hookTimeout=120000
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
