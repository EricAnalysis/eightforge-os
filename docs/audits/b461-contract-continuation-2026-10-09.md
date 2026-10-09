# B4.6.1 contract continuation (2026-10-09)

Continued Claude's interrupted step E from PR #185 head
`7487bc357dd71fe0b247029ad33796ac4f59200a` in an isolated worktree. The older
`codex/e3-dual-ai-delegated-approval` checkout and its unrelated dirty files
were preserved. Both of that branch's commits have patch-equivalent changes
on main (`git cherry` reports `-`); the checked-out branch was not deleted.

## Changes

Registered the scorer, taxonomy, binding, workflow classes, unchanged bars,
corpus, model, prompt and request execution in a deeply frozen contract.
Relevant source modules are pinned in Git LF form; capture artifacts are
verified as exact bytes without normalization. Runtime identities are
observations at execution time, not machine identities fixed in advance.

The runner verifies both producer manifests and all five artifact hashes,
binds decisions to capture/runtime identities and label provenance, and
rejects foreign, duplicate, wrong-class, missing or stale request records.
Registered pages without finalized labels remain unlabelled. Arbitrary
evidence-class overrides are rejected.

The two human exclusions match exact source SHA-256, document ID, physical
page, page digest, observation anchor, case identity and label binding.
They appear separately in reports and never enter scores, safety counts or
case denominators. Missing or changed anchors block provider runs and
decisions. Excluded-only classes remain visible and cannot enable a task.

Architecture verification required two narrow reconciliations: the pure
contract's source-path mention is an exact allowed evaluation consumer,
while importing a Forgewing runtime from it remains forbidden; a source
regex accepts CRLF as well as LF while checking the same request-digest
invariant. The Windows Docker instructions explicitly set the immutable
`EIGHTFORGE_EVAL_IMAGE_ID`.

## Reused evidence

The existing extraction-v5 captures were reused after an empty dependency
diff from `2d77a9e5fd3251f55736f1dffc3e7cf19c9e07e7` to the continuation base
over extraction, OCR, PDF runtime, inventory, resolution cases and lockfile.
All five artifact hashes and all three source PDF hashes were reverified.

- Capture set: `4d024fbea02ac9c1f55fd71e48fe8b2c9df41c3c7d047508dcc1205872047c13`.
- Runtime identity: `14e926630c95b6e5b1ef404727d723ce5233e184adfe45e23fd2fe1d84b266ee`.
- Capture source commit: `2d77a9e5fd3251f55736f1dffc3e7cf19c9e07e7`.

The OCR parity audit and completed Phase A / Phase B audits remain applicable.
The old prepare's prompt v1, binding v1 and renderer v1 crop/request proof was
not reused for the current request identity.

## New preparation

Preparation exited 0 with **181 inventory cases, 2 separate exclusions,
82/82 eligible bound crops rendered twice to identical bytes, zero provider
calls and zero spend**. Both exact exclusion anchors finalized successfully.
Binding digest prefix: `235ef06238007bbf`.

DN p107 has 20 eligible bound cases and is ready for its own class run.
The price-sheet scanned class has 49 bound cases and 18 unlabelled cases;
it cannot qualify as a whole yet. No class or task was activated. Crop host:
Windows x64, Node v24.13.1. The preparation median of 1063 ms was measured
while other checks ran and is not a provider latency qualification.

## Validation and remaining boundaries

`tsc --noEmit --incremental false` exited 0. Focused contract tests passed
10/10; focused binding/exclusion tests passed 15/15.

The initial combined regression was not a passing gate: it had architecture
scan timeouts under contention, the two integration/portability findings
described above, and asynchronous/RPC errors. The remediated slice passed
with one worker, no file parallelism and 120-second test/hook limits:
**19 test files passed, 322 tests passed, 1 file / 3 real-source tests skipped,
exit 0**, in 93.68 seconds. This is the benchmark plus two affected authority
suites, not a full-repository suite pass. The initial timeout/RPC behavior is
recorded as execution contention, separately from the corrected defects.

```powershell
node node_modules/typescript/bin/tsc --noEmit --incremental false
node node_modules/vitest/vitest.mjs run lib/evaluation/benchmark lib/architecture/forgewingValueReadingBoundaries.test.ts lib/architecture/importBoundaries.test.ts --maxWorkers 1 --no-file-parallelism --testTimeout 120000 --hookTimeout 120000 --reporter dot
```

Claude's new Golden p10/p11 and Hillsdale p1 proposals were not recovered
locally or in the fetched branches. Those final labels remain work to do.
DN p110 is an insurance certificate, so no priced-row labels are manufactured;
its 18 priced-line cases remain a workflow-typing defect. Production runtime
identity recording, job hardening and production re-analysis are later steps.
No production write, deployment or activation is part of this continuation.

Client PDFs and row-bearing artifacts remain outside the repository. A DN
provider run uses only the extracted provider credential in a child process
with database and unrelated service credentials removed. Its model stays
`claude-sonnet-4-6`; standard prices were checked against the official model
documentation before execution ($3 input / $15 output per million tokens).
