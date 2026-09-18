# Extraction benchmark and labeling workspace (E3)

**Status:** harness implemented, **awaiting human labels**. **Date:** 2026-09-18.

E3 measures extraction against human ground truth. It decides nothing: every result
carries `productionEligibilityDecision: 'not_in_scope'` and
`authority: 'non_authoritative_measurement'`.

## The three benchmark pages

| Page | Why it is here | Source env var |
|---|---|---|
| `golden-p8` | real mixed native/OCR rate table | `GOLDEN_CORPUS_ROOT` |
| `hillsdale-p3` | OCR price sheet | `MIXED_MODE_HILLSDALE_PRICE_SHEET_PDF` |
| `dn-p107` | dense native priced schedule | `DN_PRICED_SCHEDULE_SOURCE_PDF` |

Each is pinned by sha256 and byte length, re-verified on every read. Paths are never
committed; the corpus lives outside the repository.

## What a human labels

Word boxes with exact text · cell boxes with exact text · which cells are header cells ·
row membership in reading order · coverage truth (what the page actually contains).

All boxes are `canonical_v1`: the E2 frame, top-left origin, PDF points, rotation applied.

## No generated labels

The workspace is empty by construction. Every section starts `unlabeled` with no items and
coverage has no truth. The schema refuses a labeled-but-empty section and an unlabeled-but-
populated one, so "nobody has labeled this" can never be confused with "a human looked and
found nothing". The scorer returns `labels_unavailable` for any unlabeled section rather
than producing a number, and the workspace contains no extractor output at all — a labeler
shown the machine's reading would no longer be independent ground truth.

## Running it

```bash
npx vite-node --config vitest.config.ts scripts/evaluation/e3/prepare-benchmark-workspace.ts -- --out .benchmark-workspace
```

Then open `label-tool.html` in that page's folder (offline, no server), label, export, and
copy the result to `lib/evaluation/benchmark/labels/<pageKey>.labels.json`. Regenerating
never overwrites an existing `labels.json`. Rendered pages are gitignored: only labels are
committed.

## What is measured

CER and WER over reading-order text · one-to-one IoU matching (order-independent) with
precision, recall, F1 and mean matched IoU · cell text and header-role accuracy · row
membership, set and ordered · coverage correctness · determinism across repeat runs ·
runtime. Determinism and runtime are measurable before labels exist; accuracy is not.

## Open dependency

The harness cannot produce a benchmark result until a person labels the three pages. That
is the intended gate, not a defect.

## Carried over from E2

Golden p8 is in this set specifically to answer the residual E2 question: whether the
corrected canonical native/OCR overlap changes OCR admissibility on a real mixed page, and
whether that moves the page representation digest and therefore future candidate identity.
Answering it needs a real OCR run supplying word geometry to the machine pass; the harness
accepts that input, and the run itself is a separate opt-in step.
