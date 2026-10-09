# B4.6.1 Hillsdale p1 source-label finalization

Starting main: `1257e8989a7ab0ed9be0dd178622d9718375eb35` (after PR #191).
This increment adds only Hillsdale p1 benchmark truth and the two genuine
approval artifacts. Extraction, qualification scoring, frozen bars, exclusions,
request identities and production authority do not change.

## Source and independent review

Client sources, original proposals, comparisons, adjudications, renders and
provider review receipts remain outside Git:
`C:/Users/ADMS Thompson/.codex/tmp/b461-source-labels-20261009`.

The supplied Claude reviewer_b bundle was verified against the three full
SHA-256 values supplied by the owner. All three reviewer files passed
BenchmarkReviewerLabelSetSchema and exact source/frame/workspace binding.
Hillsdale source SHA-256:
`596adaccf865625723dc832f5206a8f690eb17d96921ef185df35b113c767537`.
Physical page 1 uses canonical frame 611 × 792 points, rotation 0, user unit 1.

The existing comparison CLI ran for Golden p10, Golden p11 and Hillsdale p1,
with ChatGPT as reviewer_a and Claude as reviewer_b. Geometry suggestions
remain provisional; no original independent proposal was rewritten.
All required comparison issues received explicit source-based resolutions.
Golden p11 suggestions additionally used one targeted provider-free local OCR
pass to address missing saved observations. Saved renders and prior extraction
evidence were reused; no full corpus/PDF recapture or qualification run occurred.

An authentic Claude CLI review rejected all three initial previews because
word scope was incomplete and some accepted OCR boxes were merged or clipped.
It independently confirmed the prepared cell/row truth and required monetary
exclusions. Those assertions were reused rather than re-inspecting unchanged
table content. Golden p10/p11 remain rejected and unfinalized outside Git.

## Hillsdale geometry reconciliation

The first Hillsdale preview had 156 retained words and ten geometry gaps.
One native word observation included both a dash and following number; selecting
only the number text while keeping that whole box was invalid. The original
rejection remains preserved outside Git.

The revision uses actual native PDF character observations from the byte-pinned
source. Each retained word binds to the literal source characters and their
exact bounding-box union. All 972 selected glyph IDs are consumed once. No cell
or word rectangle is divided, interpolated, clipped or duplicated. Native OCR
text is evidence, not semantic truth: transcription still comes from the visible
source page and independent review.

An enlarged source crop and glyph overlay confirm varying authored dash spacing.
This does not introduce a general tokenization policy. All 166 retained words
have source glyph bindings. The pairwise audit found seven adjacent-boundary
intersections, with maximum area 0.013155 square points, attributable to floating
point glyph tiling. Widths were plausible. Claude independently reviewed the
revised image/geometry, counted the 166 words and approved the exact new digest.
Character advance boxes include some whitespace and have approximately one-point
visual tolerance; they are not claimed to be pixel-tight ink outlines.

The seven human-required rate cells remain excluded:
`c-0027`, `c-0030`, `c-0033`, `c-0045`, `c-0048`, `c-0051`, `c-0079`.
Their rows `r-0009`, `r-0010`, `r-0011`, `r-0015`, `r-0016`, `r-0017`, `r-0025`
and nine rate words also remain excluded. These are the six dashed debris rates
and the illegible first stump rate. No rate/sign interpretation was invented.

## Frozen candidate and genuine approvals

Final candidate SHA-256:
`0f5d060208c6294e1ff3267e8b66657f15cfe109b58947a1c1b0723064dff292`.
Adjudication SHA-256:
`009d409969c294cb08cad550d931cc9bb75ce6eea8b53e8cb958c37058e4890e`.
Final inventory: 166 words, 80 cells, 20 rows; coverage `native_text_complete`.
Coverage describes available PDF text, not authoritative OCR tokenization.

ChatGPT authored its own approval. Claude authored its approval in an independent
restricted CLI session `215310e4-fe27-485d-978b-5ea8be1b256a`, using read/write
file tools scoped to the external review package and no command/MCP tools.
Codex did not author or edit Claude's approval. The original response and
independent findings remain in `independent-review-hillsdale-v2`.
Claude records its approval timestamp as estimated because that session had no
clock tool; the exact original approval bytes are retained, not rewritten.

The existing finalize-benchmark-adjudication CLI accepted both genuine approvals
and wrote the final labels. Only those labels and the two approving JSON files
are committed. Proposals, rejected previews, adjudications and client images
remain outside Git. The preview envelope's non-authoritative state was respected;
no preview was copied directly into tracked truth.

## Verification and remaining boundaries

- benchmarkTrackedTruth: 12 tests passed, including validation of the new
  committed label/approval chain.
- qualificationBinding and qualificationExclusions: 15 tests passed.
- git diff --check passed.
- Reused existing parser/runtime/corpus proofs because no tested code, runtime,
  source or frozen qualification contract changed. The PR's required CI is the
  broader final gate; no redundant local full suite was run.

Commands from the managed worktree:

```powershell
node node_modules/vitest/vitest.mjs run lib/evaluation/benchmark/benchmarkTrackedTruth.test.ts
node node_modules/vitest/vitest.mjs run lib/evaluation/benchmark/qualificationBinding.test.ts lib/evaluation/benchmark/qualificationExclusions.test.ts
```

All three initial previews are archived with their independent rejection
artifacts. Golden p10/p11 still need complete source word geometry, an audit of
accepted boxes, new candidate digests and both genuine approvals. Their cells
and rows have independent supporting review. A zoomed source crop confirms the
Golden p10 Truck Driver rate; no degraded-decimal exclusions were added because
the reviewers agree on rate cells. Golden symbol observations are provisional:
some are themselves merged or missing, so their generation is not proof that
the remaining geometry issues are solved.

DN p110 receives no priced-row labels. DN p107 remains 20/20 correct with zero
inventions/binding errors, but historical total median 3196.1921 ms fails the
frozen 3000 ms bar. No paid DN retest occurred. Owner registration of the crop
runtime from PR #191 is still required before a paid qualification rerun. No
class qualification or Forgewing activation is granted by this label increment.
No production mutation or re-analysis occurred.
