# Insurance-limit workflow typing (2026-10-09)

The unresolved-page fallback treated three or more currency-bearing table lines
without a price header as a headerless schedule. On the pinned DN page 110
insurance certificate, this produced 18 unreadable priced-line cases. The queue
was faithfully exposing the extractor's incorrect classification.

The deterministic correction requires an authored, horizontally ordered
TYPE OF INSURANCE / POLICY NUMBER / LIMITS header and a following section
boundary. Only currency spine tokens fully contained beneath that header,
above that boundary and within the limits column are removed from the
header-not-found fallback. Missing evidence keeps the original behavior.
Qualifying price headers and unresolved price-header candidates retain priority;
separate headerless schedules outside the bounded region keep their evidence.
There is no document-specific exception, benchmark suppression or AI decision.
The spacing_only path is unchanged.

New output is explicitly priced_schedule_reconstruction_v6. Stored v1 through
v5 remain supported. Raw native layout is preserved; reconstruction and its
derived priced-line observations change only at the affected classification
boundary. No canonical value, write authority, migration or production state
was changed.

## Proof and limits

The source PDF hash was verified as
69247bff02744276b75f2cb0d4c00610e8614bd5822d2d10ae2ad35564c3b272.
One provider-free native extraction supplied the saved page layout, followed by
repeatable reconstruction against that same layout. DN page 110 went from
18 unresolved price cases to zero, with zero accepted rows and unchanged raw
layout (SHA-256
88e61fe050a1eedb3fd443ffa2ae8f52b821d4fded4b2a7be98cdc79f8687f5e).
Local proof: C:/Users/ADMS Thompson/.codex/tmp/dn-p110-typing-proof-20261009.json.
Client-bearing layout and scripts remain outside Git.

The first eligible DESCRIPTION OF OPERATIONS text is a conservative boundary
inside the form; this proof establishes zero downstream price targets, rather
than asserting that all 18 original lines were individually classified as
insurance limits. Synthetic tests preserve real headerless pricing below the
form, missing or misordered headers, incomplete boundaries, out-of-column
currency, crossing boxes, and qualifying price-header precedence.

Independent document-intelligence and truth-engine judgment found no blocking
defect. Coverage is page-scoped plus synthetic regression; this is not a new
whole-corpus parity or Docker qualification claim. Historical v5 capture proofs
remain valid for their recorded bytes, but cannot establish a current v6 queue.

Focused unresolved-page/header-reuse tests passed 25 tests. The final affected
regression passed 26 files / 441 tests, exit 0:

```powershell
node node_modules/vitest/vitest.mjs run lib/extraction/pdf lib/extraction/geometry/canonicalGeometryIdentityStability.test.ts lib/resolution/v4SegmentEvidenceAttention.test.ts --maxWorkers 1 --no-file-parallelism --testTimeout 120000 --hookTimeout 120000 --reporter dot
```

This includes the existing provider-free scanned fixture. PDF standard-font
warnings did not prevent command completion. No paid calls or customer corpus
rerun were needed for this change.

`node node_modules/typescript/bin/tsc --noEmit --incremental false` also exited 0.
