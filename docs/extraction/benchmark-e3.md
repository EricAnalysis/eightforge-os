# Extraction benchmark and labeling workspace (E3)

**Status:** dual-review workflow and E3-only delegated finalization implemented; approval
artifacts remain external and explicit. **Date:** 2026-09-28.

E3 measures extraction against human ground truth. It decides nothing: every result
carries `productionEligibilityDecision: 'not_in_scope'` and
`authority: 'non_authoritative_measurement'`.

## The four benchmark pages

| Page | Why it is here | Source env var |
|---|---|---|
| `golden-p8` | image-only OCR rate table | `GOLDEN_CORPUS_ROOT` |
| `hillsdale-p3` | OCR price sheet | `MIXED_MODE_HILLSDALE_PRICE_SHEET_PDF` |
| `dn-p106` | dense native-text priced schedule | `DN_PRICED_SCHEDULE_SOURCE_PDF` |
| `dn-p107` | dense scanned/OCR priced schedule | `DN_PRICED_SCHEDULE_SOURCE_PDF` |

Each is pinned by sha256 and byte length, re-verified on every read. Paths are never
committed; the corpus lives outside the repository. Direct `pdfjs-dist` 5.5.207 measurements
were repeated twice against the exact pinned bytes:

- Golden p8: zero content items, zero non-empty text items, one page image. The visible
  rate table is image-only and requires OCR.
- DN p106: 394 content items, 201 non-empty text items, no page image. It is the native-text
  priced-schedule control.
- DN p107: zero content items, zero non-empty text items, one page image. It is the scanned/OCR
  priced-schedule control and requires OCR.

DN p106 and p107 share exact source bytes but bind separate physical pages. Their semantic
labels, adjudication, geometry, and benchmark truth are independently reviewed and must never
be copied between pages.

## What a human labels

Word boxes with exact text · cell boxes with exact text · which cells are header cells ·
row membership in reading order · coverage truth (what the page actually contains).

All boxes are `canonical_v1`: the E2 frame, top-left origin, PDF points, rotation applied.

## Primary dual-review workflow

The preferred path preserves independent semantic readings and explicit human authority:

1. Give ChatGPT only the clean source page and collect `reviewer-a.labels.json`.
2. Give Claude only the clean source page and collect `reviewer-b.labels.json`.
3. Compare the two non-authoritative proposals deterministically.
4. Only after both proposals exist, optionally use bound provisional OCR suggestions for
   unique exact-text geometry matches.
5. Resolve every disagreement, unmatched item, and geometry ambiguity in a separate
   `adjudication.json`.
6. The user explicitly approves the fully resolved final-label candidate digest.
7. The approval-gated finalizer writes `labels.json` in the existing benchmark schema.

Reviewer artifacts use authority `non_authoritative_reviewer_proposal` and must attest that
their input was `clean_source_page_only`, without machine suggestions or the other reviewer's
labels. Agreement is never authority. The comparator always records that user adjudication
and approval are required, even when both proposals agree exactly.

The comparator pairs reviewer items only by explicit reading-order positions and compares
their values exactly. It performs no fuzzy or semantic matching. A provisional OCR box can
be attached only when both reviewers agree semantically, neither supplied a conflicting box,
and the exact text resolves to one unique bound suggestion. Repeated or missing geometry is
an ambiguity for the user, never an inferred match.

Run the comparator with the exact workspace manifest that supplied the clean page:

```bash
npx vite-node --config vitest.config.ts scripts/evaluation/e3/compare-benchmark-reviewers.ts -- \
  --workspace .benchmark-workspace \
  --reviewer-a .benchmark-review/golden-p8/dual-review/reviewer-a.labels.json \
  --reviewer-b .benchmark-review/golden-p8/dual-review/reviewer-b.labels.json \
  --suggestions .benchmark-workspace/golden-p8/suggestions.json \
  --out .benchmark-review/golden-p8/dual-review/comparison.json
```

Omit `--suggestions` when no provisional geometry is available. `comparison.json` preserves
both reviewer values and separately lists text, bbox, cell-structure, row-membership, and
coverage disagreements, ambiguous items, unmatched items, candidate resolutions, and every
issue ID requiring explicit adjudication. The comparator refuses to write `labels.json`.

`adjudication.json` is separate from comparison output. It binds the exact reviewer,
comparison, and optional suggestion digests. Every comparison issue must have exactly one
typed resolution: choose reviewer A, choose reviewer B, provide an explicit manual value of
the matching kind, or use `exclude_item` for a word, cell, or row issue. Those resolutions
deterministically assemble the final-label candidate. Reviewer row choices map the selected
reviewer's semantic membership onto already-resolved final cells and fail if any member is
missing or differs; they never rewrite membership by position. The adjudication artifact
cannot carry a parallel hand-edited final payload. File presence is
not approval: the finalizer requires `approval.decision` to equal
`approve_as_benchmark_truth`, a non-empty approving identity distinct from either reviewer,
an ISO-8601 timestamp, and an approved candidate digest equal to the exact assembled
`BenchmarkPageLabelsSchema` payload.

For word, cell, or row issues only, `exclude_item` records the user's explicit adjudication
that the proposed item is not benchmark truth and contributes no replacement item; it is
invalid for coverage metadata, and retained rows may not reference an excluded cell.

An explicit `userChallenges` entry may replace or exclude a word, cell, or row that both
reviewers agreed on. The challenge binds the preserved agreement ID and digest and is user
adjudication—not an automatically created disagreement. Challenges apply during deterministic
assembly before the exact final-payload digest is presented for user approval. Each item has
one adjudication path: an agreement is challengeable only when no required issue has the same
exact `matchKey`; linkage is never inferred from text. Word and cell challenges establish the
final cell semantics before reviewer row choices run, and unchanged agreed rows are validated
against those same final semantics. A meaning-changing cell challenge therefore requires the
affected row to be explicitly replaced or excluded rather than silently retaining stale row
meaning.

After the user has explicitly approved that artifact, finalize with:

```bash
npx vite-node --config vitest.config.ts scripts/evaluation/e3/finalize-benchmark-adjudication.ts -- \
  --workspace .benchmark-workspace \
  --reviewer-a .benchmark-review/golden-p8/dual-review/reviewer-a.labels.json \
  --reviewer-b .benchmark-review/golden-p8/dual-review/reviewer-b.labels.json \
  --comparison .benchmark-review/golden-p8/dual-review/comparison.json \
  --adjudication .benchmark-review/golden-p8/dual-review/adjudication.json \
  --suggestions .benchmark-workspace/golden-p8/suggestions.json \
  --out .benchmark-workspace/golden-p8/labels.json
```

If comparison was not suggestion-bound, omit `--suggestions` from finalization too. The
finalizer reruns the shared deterministic comparator from the bound source manifest,
reviewer artifacts, and optional suggestions. It rejects a supplied comparison whose exact
content or digest differs from that recomputation, then assembles the payload from the typed
resolutions and verifies the approval digest against those exact bytes. It also rejects stale
digests, missing resolutions, absent approval, reviewer-as-approver identity matches after
case-folding and trimming, incomplete final labels, and attempts to overwrite existing partial
or complete benchmark truth.

## E3-only delegated dual-AI approval

The original human approval path above remains unchanged. A second, narrowly scoped finalization
mode is enabled only for `golden-p8`, `hillsdale-p3`, `dn-p106`, and `dn-p107`. Its version-controlled
delegation is limited to E3 benchmark-label finalization and to the exact approver identity set
`chatgpt` plus `claude`; it grants no extraction, production, workflow, deployment, E4, or E5
authority. Setting the delegation inactive fails closed.

Delegated mode requires a complete `adjudication.json` whose embedded human approval remains
`null`. The shared resolution engine deterministically constructs one candidate with:

- `authority: delegated_dual_ai_evaluation_ground_truth_only`
- `labeledBy: delegated_dual_ai:chatgpt+claude`
- `labeledAt: null`

Approval timestamps live only in the two strict approval artifacts, so they cannot change the
candidate digest. Each approval binds the exact parsed adjudication, comparison, reviewers,
optional suggestions, source, frame, candidate digest, and candidate summary. The delegated
finalizer requires exactly two approvals, distinct identities equal to `chatgpt` and `claude`, and
`decision: approve` from both. Any missing, rejected, unresolved, stale, or mismatched binding
fails before a write.

Compute the candidate without creating truth or approval artifacts:

```bash
npx vite-node --config vitest.config.ts scripts/evaluation/e3/compute-benchmark-candidate.ts -- \
  --workspace .benchmark-workspace \
  --reviewer-a .benchmark-review/golden-p8/dual-review/reviewer-a.labels.json \
  --reviewer-b .benchmark-review/golden-p8/dual-review/reviewer-b.labels.json \
  --comparison .benchmark-review/golden-p8/dual-review/comparison.json \
  --adjudication .benchmark-review/golden-p8/dual-review/adjudication.json \
  --suggestions .benchmark-workspace/golden-p8/suggestions.json
```

An optional `--out` writes only a `non_authoritative_candidate_preview` envelope. The preview
command rejects `labels.json` and every frozen input path as output. The envelope cannot parse as
`BenchmarkPageLabelsSchema`.

After two independent approval artifacts exist, delegated finalization uses the same sole-writer
CLI with `--approval-a` and `--approval-b`. Human approval and delegated approvals are mutually
exclusive, and the existing safe-overwrite protection remains in force:

```bash
npx vite-node --config vitest.config.ts scripts/evaluation/e3/finalize-benchmark-adjudication.ts -- \
  --workspace .benchmark-workspace \
  --reviewer-a .benchmark-review/golden-p8/dual-review/reviewer-a.labels.json \
  --reviewer-b .benchmark-review/golden-p8/dual-review/reviewer-b.labels.json \
  --comparison .benchmark-review/golden-p8/dual-review/comparison.json \
  --adjudication .benchmark-review/golden-p8/dual-review/adjudication.json \
  --suggestions .benchmark-workspace/golden-p8/suggestions.json \
  --approval-a chatgpt-approval.json \
  --approval-b claude-approval.json \
  --out .benchmark-workspace/golden-p8/labels.json
```

## Human labels and provisional suggestions

The workspace is empty by construction. Every section starts `unlabeled` with no items and
coverage has no truth. The schema refuses a labeled-but-empty section and an unlabeled-but-
populated one. The scorer returns `labels_unavailable` for any unlabeled section rather
than producing a number.

An optional `suggestions.json` can be generated from the provider-free E3 machine pass.
It is exact-source/frame-bound, visibly separate in the labeler, and never enters
`labels.json` merely because it was loaded. Accepting or editing a suggestion creates a
human-reviewed draft with provenance; the human must still explicitly mark the section
complete before export. Rejecting a suggestion never changes labels. Suggestions for an
already labeled section are suppressed, so existing human truth cannot be overwritten.

The current suggestion source is native-only unless OCR geometry is supplied separately,
and its priced-schedule reconstruction does not emit header cells. Source-run metadata
records native and OCR token counts; the missing-header limitation is documented here,
not encoded as a separate suggestion-metadata field.

## Workspace and fallback browser labeler

```bash
npx vite-node --config vitest.config.ts scripts/evaluation/e3/prepare-benchmark-workspace.ts -- --out .benchmark-workspace
```

Add `--suggestions` to write the separate provisional suggestion artifact. The existing
`label-tool.html` Accept/Edit/Reject workflow remains available for correcting an individual
box, resolving disputed labels, manually drawing missing geometry, or completing the work
without dual review. It is a fallback, not the required primary path. Regenerating never
overwrites an existing `labels.json`. `.benchmark-workspace/` and `.benchmark-review/` are
gitignored. Keep reviewer proposals, comparison, and adjudication artifacts below one of those
folders (the examples use `.benchmark-review/<pageKey>/dual-review/`); arbitrary repository
paths are not implicitly ignored. Only explicitly approved final labels are eligible to be
committed.

The manifest always represents the complete four-page registry. A page-specific refresh merges
the newly measured page into the existing manifest and preserves the other registered pages in
registry order. Duplicate, unknown, missing, or source/page/frame-conflicting entries fail before
workspace files are written. A page-specific refresh requires an existing manifest; initialize a
new workspace with the full command above. Repeating an unchanged refresh preserves `generatedAt`,
so both the manifest and README remain byte-stable.

For an OCR-backed page, add the explicit `--local-ocr` flag together with `--suggestions`.
This runs the existing provider-free local Tesseract geometry path only for the selected
physical page. It records local-OCR generation metadata in `suggestions.json`; the output
remains provisional and does not change or complete any section in `labels.json`.

Create a source-clean independent review pack from an existing workspace with:

```bash
npx vite-node --config vitest.config.ts scripts/evaluation/e3/prepare-benchmark-review-pack.ts -- --workspace .benchmark-workspace --out .benchmark-review
```

The review pack allowlists only the exact workspace `page.png`, a human-readable summary,
and bound `labels.json` bytes when at least one section is human-labeled. Suggestions and
machine output are excluded by default. Both local workspace folders are gitignored.

## What is measured

CER and WER over reading-order text · one-to-one IoU matching (order-independent) with
precision, recall, F1 and mean matched IoU · cell text and header-role accuracy · row
membership, set and ordered · coverage correctness · determinism across repeat runs ·
runtime. Determinism and runtime are measurable before labels exist; accuracy is not.

## Open dependency

The harness cannot produce a complete benchmark result until the four pages are independently
labeled. DN p106 requires fresh Reviewer A and Reviewer B proposals; no p107 truth is reused. That
is the intended gate, not a defect.

## Carried over from E2

Golden p8 remains in this set as an OCR/image benchmark bound to the established canonical
frame. Direct source measurement supersedes the earlier mixed-layer characterization: the pinned
physical page has no native text items and one page image. A real OCR run supplies provisional
word geometry to the machine pass; it does not create labels or benchmark truth.
