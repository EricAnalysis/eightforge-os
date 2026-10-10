# B4.6.1: Golden p10 and p11 source labels finalized (2026-10-10)

The labels were finalized through the existing E3 delegated path. Two genuine, independently authored approvals, ChatGPT and Claude, are bound to each exact candidate digest. The sole finalizer, `scripts/evaluation/e3/finalize-benchmark-adjudication.ts`, wrote each file, and each is committed byte for byte with its two approvals.

| Page | Label digest (= approved candidate) | Words | Cells | Rows | Coverage |
|---|---|---:|---:|---:|---|
| golden-p10 | `ef4505942b8cbebcebc423774e6528c87aff0c0d05db77349ad22063de5b36f4` | 311 | 160 | 40 | requires_ocr |
| golden-p11 | `c630b56daa1de2add2d8b2bb17103326400daca04bc3d5b5a9de6f3c397ac407` | 214 | 112 | 28 | requires_ocr |

Both pages bind to source `922161a5…` (2,481,310 bytes), physical pages 10 and 11, canonical frame 612.48 × 792, rotation 0.

## How the truth was reached

1. **Reviewer A (ChatGPT) and reviewer B (Claude)** each read the clean source page only. They did not see machine suggestions or each other's labels.
2. **Reviewer B's word geometry was source-measured.**
   - Words are tight boxes around whole ink components; word breaks were read from the image; cells are the union of their word boxes.
   - Every box was checked visually. Nothing was interpolated or divided proportionally.
   - The documented limitations are:
     - ink touching a table rule is extended only to the rule edge, at most 0.5 pt;
     - four p11 words were divided at a reviewed break through scan-bridged components;
     - five p10 text-span clips exclude stray marks;
     - speckle connected to a glyph is retained.
3. **Comparison, adjudication and candidate** were computed with repository code.
   - The first candidates were rejected by Claude for one defect per page: a dash spelled as a hyphen. The source glyph measures 15–20 px against 9–13 px for every hyphen on the same pages.
   - The adjudication restored the en dash (U+2013) in p10 word 143 / cell 73 and p11 word 180 / cell 97.
   - Both reviewers then approved the exact new digests. The rejected approvals stay outside Git as history.
4. **One ambiguity is left as transcribed.** In p11 `grapple`, a faint 5 × 4 px baseline mark follows the word. The label keeps the word without a period, and its box excludes the mark.

Client page images, transcription working files and review packages stay outside Git.

## Effect

The labels are evaluation ground truth only (`delegated_dual_ai_evaluation_ground_truth_only`). Nothing in production reads them.

- The B4.6.1 qualification exclusion for p10 row 21 (`qualificationExclusions.ts`) is unchanged.
- No bar, prompt, crop, taxonomy or request identity changed.
- DN p110 receives no priced labels.
- Hillsdale p1 was finalized earlier (#192) and is unchanged.
