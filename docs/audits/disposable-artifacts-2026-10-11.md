# Disposable artifact audit — 2026-10-11

Baseline: main `3e53a1f44be31c0475d406f6def3783928eef986`.
Scope is cleanup only. No feature, authority, migration, production-data or
qualification-contract change. The deletion proposal was reported before edits.

## Classification and disposition

| Category | Inspected examples / disposition |
|---|---|
| PERMANENT PRODUCT | Product scripts, operational workers, source-identity backfill and canonical consumers: retain. |
| PERMANENT REGRESSION / EVIDENCE | Extraction/truth tests and fixtures, reviewer guardrails, production audits: retain. Goodlettsville PDF is pinned and consumed by tests. |
| ACTIVE QUALIFICATION INFRASTRUCTURE | Dockerfile.eval, compose.eval.yaml, runtime builder, B4.6.1 contracts/scorer/tests, source pins, finalized labels, E3 tools, Ask hermetic gate, current handoff: retain. |
| ARCHIVABLE HISTORICAL EVIDENCE | Audits/handoff (1,443,871 bytes), tracked evaluation artifacts (4,495,872 bytes), historical captures, production exports and source geometry: retain. Some exact artifacts are authenticated by regression tests; hashes cannot recreate historical payloads. |
| GENERATED / REBUILDABLE | Five Playwright CLI outputs below; scoped ignored dependency/build directories in old clean merged checkouts. |
| OBSOLETE / DEAD | No script or migration helper proved sufficiently dead for deletion. |
| UNKNOWN — DO NOT DELETE | Unreferenced one-off Golden/TDOT diagnostics, dirty/unique worktrees, managed metadata, undocumented source/evidence copies: retain. |

## Tracked deletion manifest

All paths are under `.playwright-cli/`. The first manifest identifies Windows
checkout bytes (5,543 total); four files have CRLF checkout conversion. The
second identifies original Git blobs (5,483 total), retained in baseline history.
These are separate byte identities, not normalized parity.

| File | Bytes | SHA-256 |
|---|---:|---|
| console-2026-04-22T23-49-44-502Z.log | 3768 | 56ae0df145a14f01070e4926c5e4ce2f2844e235b52b27f9dc0337343d64391f |
| console-2026-04-22T23-54-12-527Z.log | 301 | f52c92dc2c3555b4dc9871381eb60248108c538743e69a6704edb724a2cdd671 |
| page-2026-04-22T23-49-46-190Z.yml | 629 | e55ac1004b5957bf2f4299ff1c109704ac3cdf33a9fd49305b15e060de474689 |
| page-2026-04-22T23-51-21-965Z.yml | 714 | 934e211d385f6fba68b33df1d9e34d140c013aabc85467b6ddbdef41ddd98f46 |
| page-2026-04-22T23-54-13-107Z.yml | 131 | baa76f184ac81ea0b568390d166928024238f23a86cefdcd72601b9477797da5 |

| Git blob (same filename above) | Bytes | SHA-256 |
|---|---:|---|
| console 23-49-44-502Z | 3743 | 526e554cecdd55e929916b63d52edbc05f72c449f62cc1e76ec730ccfde7a318 |
| console 23-54-12-527Z | 299 | c49a6227e52607f43302090f5736b93391b6f35893adb6ccb161ab96dc668ae0 |
| page 23-49-46-190Z | 613 | f547d46729af15d21234be4679478b4d5f3ca8a61e463d8c278207da256bf970 |
| page 23-51-21-965Z | 697 | 060f930e8a38599ce1b81e8d3a1385d0b0275ad43ec9d42323c9bd648300544c |
| page 23-54-13-107Z | 131 | baa76f184ac81ea0b568390d166928024238f23a86cefdcd72601b9477797da5 |

Content inspection found local HMR/CORS/health/favicon errors, synthetic invalid
sign-in snapshots and a missing-API-key error. None records client source,
reviewed truth, labels, corpus captures or a benchmark result. Hidden reference
search finds only the historic system-map directory listing. Playwright selects
auth setup and spec files elsewhere; Vitest selects tests elsewhere; TypeScript
selects TS/TSX/MTS. No production loader, test input, qualification manifest or
source pin consumes these files. Ignore future `/.playwright-cli/` output.

## Local storage and evidence

The external inventory covers 62 registered worktrees: nine dirty and eleven
with HEAD commits not reachable from main. Preserve all branches/checkouts,
stashes and managed contexts. Shared primary/B4.6.1/Golden dependency roots are
excluded. The generated cohort is 22 directories, 7.172 GiB, in clean merged
checkouts: ignored with no tracked entries, preserved lockfile hashes, no inbound
junctions, active consumers, patch configuration or documented evidence duty.
Only installed dependencies and `.next` are removed; `npm ci` and the existing
build regenerate them. Sources, credentials, OCR assets and evidence stay.

Exact local paths, sizes, statuses, lock hashes and cleanup results remain outside
Git in `.codex/tmp/eightforge-cleanup-audit-20261011/`. Logical file bytes differ
from actual physical recovery. Docker images/volumes and raw historical evidence
are retained. No client material is added to Git.

## Verification

All 22 local targets are absent and preserved lock hashes unchanged. Local
focused import-boundary, frozen-artifact and qualification-contract tests pass
86/86 in three files; TypeScript passes. The first focused run had a worker RPC
timeout during concurrent disk cleanup, despite passing assertions; it is not
claimed as a clean pass. The independent single-worker rerun completed in
20.67 seconds without errors. The dedicated PR must pass final full Vitest CI
before merge. Unused Docker builder cache reported 394.4 MB reclaimed; no
image, volume, worktree, branch, source or historical payload was deleted.
