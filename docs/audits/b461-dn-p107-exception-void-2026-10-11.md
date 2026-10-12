# B4.6.1 DN p107 exception: void before provider execution (2026-10-11)

**VOID. Zero provider calls; $0 spent.** The required unchanged-request
preflight failed: 13 of DN p107's 20 eligible targets have different render
digests from the historical live run, and therefore different request digests.
The other seven match exactly. No live run or independent `--decide` step
was started, and no retry was made.

The owner pre-registration was already on main before preparation:
[#208](https://github.com/EricAnalysis/eightforge-os/pull/208) merged at
2026-10-11 15:53:11 UTC as `120d3015b9a4d837052c41e6fc218e5b5e744932`.
Its conditions are in
`b461-dn-p107-exception-run-preregistration-2026-10-11.md`.
Preparation produced `2026-10-11T15-57-44-092Z-prepare`, after that merge.

## Decision table

| Registered condition | Observed | Result |
| --- | --- | --- |
| Pre-registration on main before execution | #208 merged at 15:53:11 UTC; prepare artifacts at 15:57:44.092 UTC | met |
| Image | `sha256:4cd74cc34334bfa35c4d56db5baee4ac207e2e74142417faac3509a27e98cad5` | exact |
| Capture set | `4d024fbea02ac9c1f55fd71e48fe8b2c9df41c3c7d047508dcc1205872047c13` | exact |
| Binding digest | `235ef06238007bbf14ac009af78eabf528cb2bd4468c49ff155c3589cc804d40` | exact |
| Historical `records.json` | `43694bd99fe8142eaead1e73adc51bcd29a4656051b71d7fa7a1a0da72395d7c` | exact |
| Eligible DN p107 targets | 20 unique targets, same historical target identities | met |
| Local crop repeatability | 20/20 deterministic; zero unrendered or omitted targets | met |
| Render identity against historical run | **7 match, 13 differ** | **mismatch; stop** |
| Request identity against historical run | **7 match, 13 differ** | **mismatch; stop** |
| Two registered exclusions | both resolved; frozen; no exclusion blockers | met |
| Recorded runtime | every registered field below matches | met |
| Provider execution | not started; calls 0; spend $0 | stopped at preflight |
| Exception outcome | **VOID before provider execution** | no qualification result |
| Selected class in prepare `decision.json` | `not_run`: 0 of 20 bound cases read | preparation only |
| Qualified classes / activatable tasks | none / none | inactive |

Preparation was class-scoped to
`confirm_scanned_amount:dense_scanned_ocr_priced_schedule`. It used the
contract's historical captures, not the v6 captures, with read-only corpus
and capture mounts, no network and no credentials. The unchanged runner
validated the frozen contract's source digests, corpus bytes and capture
manifests before building inventory. All artifacts remain outside Git.

## Exact identity comparison

The dry-run records intentionally have `requestDigestSha256: null`, because
no provider request was executed. For the required preflight comparison,
the candidate request digest was derived with the frozen runner's exact
identity formula:

```text
sha256(JSON.stringify(['b46', pageKey, rowKey, renderDigestSha256, model,
  promptTemplateId, promptTemplateVersion, outputSchemaVersion]))
```

That formula reproduced all 20 historical request digests using their
historical render digests. Using the prepared render digests produced seven
matches and 13 mismatches. A separate Node verifier checked every value in
the complete local comparison, independently of the PowerShell comparison
that produced it. The first mismatch stopped the execution gate; completing
the read-only artifact comparison made no additional renders or calls.

| DN p107 row key | Render digest | Derived request digest |
| --- | --- | --- |
| r-0007 | differs | differs |
| r-0016 | exact | exact |
| r-0018 | differs | differs |
| r-0021 | exact | exact |
| r-0024 | differs | differs |
| r-0008 | exact | exact |
| r-0019 | differs | differs |
| r-0010 | exact | exact |
| r-0009 | differs | differs |
| r-0020 | differs | differs |
| r-0004 | differs | differs |
| r-0013 | exact | exact |
| r-0015 | differs | differs |
| r-0023 | differs | differs |
| r-0011 | exact | exact |
| r-0006 | exact | exact |
| r-0012 | differs | differs |
| r-0014 | differs | differs |
| r-0022 | differs | differs |
| r-0005 | differs | differs |

First mismatch, `dn-p107/r-0007`:

| Identity | Historical live run | Registered-image prepare |
| --- | --- | --- |
| Render SHA-256 | `d713bacfd97c24a727e29f94024c80d4d603a5012d511d3d581d7f989a1ff625` | `2b90fb249a30a38880f896f3f55ffc21f31b11d7197d4b975bcb181cdedf00db` |
| Request SHA-256 | `55398c4c7270426c24271c4d3bfb0576f1945a63a93ee9aeb132e1ede6bacbeb` | `43d2b1751cb3a90e2a14d9ceed160e5bba6e7398ac8652d0f5fe2ee334709693` (derived) |

**PARITY: NO -- stop and report; do not normalize differences away.**
Local repeatability is not equality with historical bytes. This evidence
establishes a mismatch, not its root cause. No decoder, renderer, prompt,
model, schema, source, capture, exclusion or scoring change was attempted.

## Recorded preparation runtime

| Field | Observed value |
| --- | --- |
| `platform` / `arch` | `linux` / `x64` |
| `nodeVersion` | `v24.21.0` |
| `packages['pdfjs-dist']` | `5.5.207` |
| `packages['@napi-rs/canvas']` | `0.1.97` |
| GNU canvas binary | `@napi-rs/canvas-linux-x64-gnu/skia.linux-x64-gnu.node` |
| GNU canvas binary SHA-256 | `8af96229a864c193df54f9c3eefb489ce8fab0867dfab9ed8c694b53034cfb60` |

Both preparation `summary.json` and `decision.json` record this runtime.
There is no live-run runtime to accept. Pricing confirmation and the paid
execution step were never reached because the pre-registration explicitly
requires a stop on an identity mismatch.

## Artifact identity and verification

External artifact root:
`C:\Users\ADMS Thompson\.codex\tmp\b461-dn-exception-20261011`.
The first three artifacts below are in `2026-10-11T15-57-44-092Z-prepare`;
the comparison is at the artifact root.

| Artifact | SHA-256 |
| --- | --- |
| prepare `summary.json` | `f85cd47fd8fe612ccc5e27635b04a91f1445d4dc9f4daa5e0bb5795ea615ae3e` |
| prepare `records.json` | `bf7dbaf660f05f29e5c06910fb99bd877e53ef0013b6a2d59ab79f017890afbf` |
| prepare `decision.json` | `fd89ee977d299e8ade1cbc06040686bef004379b02499f608496d96e98cbbc03` |
| `identity-comparison.json` | `ef3c3c335e5e67c52b2c77b61c3b9cf4db3293dc2cc62663fe48fb48aa25feaa` |

Executed preparation command (PowerShell; `$exceptionRoot` is the external
artifact root above):

```powershell
docker run --rm --network none --platform linux/amd64 --entrypoint node `
  --mount 'type=bind,source=C:\Users\ADMS Thompson\.codex\tmp\golden-row-bands-20261008\corpus,target=/corpus,readonly' `
  --mount 'type=bind,source=C:\Users\ADMS Thompson\.codex\tmp\golden-row-bands-followup-20261008\after-final-complete\run,target=/captures,readonly' `
  --mount "type=bind,source=$exceptionRoot,target=/artifacts" `
  sha256:4cd74cc34334bfa35c4d56db5baee4ac207e2e74142417faac3509a27e98cad5 `
  node_modules/vite-node/vite-node.mjs --config vitest.config.ts `
  scripts/evaluation/b461/runQualification.ts -- `
  --captures /captures --corpus /corpus `
  --pins scripts/evaluation/docker/pinned-corpus.pins.json `
  --artifact-root /artifacts `
  --class confirm_scanned_amount:dense_scanned_ocr_priced_schedule
```

Preparation exited 0, rendering 20/20 crops twice with calls 0 and spend $0.
The identity gate then rejected the first differing render digest. The
read-only `verify-void.cjs` verification exited 0 after checking all 20
comparisons, full hashes, registered runtime, exclusions, target completeness
and zero-call state. Its machine-readable result is `void-verification.json`
under the external root. Existing full-suite and correctness evidence was
not rerun: this change adds only this audit record and does not modify the
frozen execution or scoring paths.

The 2026-10-09 **FAIL remains historical evidence**. This void preparation
neither replaces it nor produces a new PASS or FAIL. Nothing activates,
and no production write or deployment occurred. Under the pre-registration,
any repeat requires a new owner decision.
