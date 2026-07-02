---
generated_at: 2026-06-29T17:31:04.391Z
model: claude-sonnet-4-6
root_cause_category: none
tool: improvement-orchestrator-ai
---

# EightForge Engineering Orchestrator Answer

## Raw Input

Invoice 2026-002, line 6A: "Tree Operations Hazardous Hanging Limb Removal>2"per tree," qty 994, $80.00/unit, total $79,520.00, fails CROSS_DOCUMENT_CONTRACT_RATE_EXISTS on document 53d74340 line 6 with "no confident contract rate-row match found." The contract row appears correctly extracted: assembled rate table shows "Trees with Hazardous Limbs Hanging," unit Tree, $80.00, page 9 — confirmed against the source PDF, which says "Trees with Hazardous Limbs Hanging Removal >2"." This looks like a word-order/phrasing mismatch ("Hazardous Hanging Limb" vs. "Hazardous Limbs Hanging"), not a missing or miscategorized row. Diagnose why the description-similarity matcher fails this pair, and recommend a minimal-diff fix.

## Structured Context

_None provided._

## Generated Answer

## Assessment

This is a **description-similarity matcher failure** caused by a word-order/phrasing divergence between the invoice line description and the contract rate row description. The canonical rate row exists, is correctly extracted, and is correctly valued. The validator is producing a false-positive finding. No canonical fact is wrong; the matching logic is wrong.

---

## Root Cause Class

**`validation_rule_issue`** — The similarity matcher used by `CROSS_DOCUMENT_CONTRACT_RATE_EXISTS` is not tolerant of word-order permutations or minor morphological variation in multi-word service descriptions. It fails to recognize that:

- Invoice: `"Tree Operations Hazardous Hanging Limb Removal >2" per tree"`
- Contract: `"Trees with Hazardous Limbs Hanging Removal >2""`

...are the same operational service. The token sets overlap almost completely; the failure is purely a ranking/threshold artifact of how the matcher scores word-order-sensitive similarity.

Secondary contributing factor: the invoice description includes a **category prefix** (`"Tree Operations"`) that is not present in the contract row label. This prefix inflates the apparent distance between the two strings before any similarity scoring begins.

---

## Evidence Needed

Before implementing, confirm the following:

1. **What similarity method is in use?** Identify whether the matcher uses cosine over TF-IDF vectors, token sort ratio, token set ratio, sequence ratio, embedding similarity, or a hybrid. The failure mode differs by method.
2. **What is the current passing threshold?** Retrieve the numeric cutoff. A word-order-permuted pair like this will typically score 0.55–0.75 on sequence ratio but 0.85–0.95 on token set ratio. Knowing the threshold tells you whether this is a threshold problem, a method problem, or both.
3. **Does the matcher strip category prefixes before scoring?** Confirm whether `"Tree Operations"` is being passed into the similarity function as part of the invoice description string, or whether a normalization step removes known category prefixes first.
4. **Is the `>2"` measurement suffix handled consistently?** Confirm both strings carry it through normalization identically. A mismatch in quote character encoding (`"` vs `"` vs `''`) or whitespace around `>` could independently suppress the score.
5. **Is this a single-pass matcher or does it attempt multiple normalization strategies before failing?** If it is single-pass, the fix is a normalization pre-step. If it already attempts fallbacks, the fallback chain is incomplete.
6. **What is the confidence score actually produced for this pair?** Retrieve the raw similarity score from the finding detail or matcher diagnostic log. This distinguishes "close miss below threshold" from "genuinely low score due to prefix pollution."

---

## Likely Files

Without repo structure provided, these are the canonical search targets:

| Target | What to look for |
|---|---|
| Validator rule for `CROSS_DOCUMENT_CONTRACT_RATE_EXISTS` | The entry point that calls the description matcher and sets the confidence threshold |
| Description similarity utility / helper | The function that scores two description strings — likely a shared utility used across multiple validator rules |
| Invoice line normalization | Any pre-processing applied to invoice descriptions before matching (category prefix stripping, punctuation normalization, unit suffix removal) |
| Contract rate row normalization | Corresponding pre-processing on the contract side — confirm it is symmetric with invoice normalization |
| Matcher test suite | Existing test cases for description matching — this pair must be added as a regression case |

---

## Recommended Phase

**Phase A → B → C.** This is a validator logic fix with a regression gate requirement. It is not a canonical data change, not a migration, and not an extraction fix. The canonical rate row is correct. Only the matching logic needs repair.

---

## Minimal Safe Change

**Do not change canonical facts, extraction output, or the rate row.** The fix lives entirely in the similarity matching layer.

The minimal-diff repair is a **two-part normalization pre-step** applied symmetrically to both strings before similarity scoring:

**Part 1 — Category prefix stripping.**
Maintain a known set of invoice category prefix tokens (e.g., `"Tree Operations"`, `"Debris Removal"`, etc.) and strip them from the invoice description before scoring. Alternatively, use a more general heuristic: if the invoice description begins with tokens that do not appear in any candidate contract row label, strip the leading non-matching prefix before scoring. The symmetric approach (strip from invoice side only, since contract rows do not carry category prefixes) is safer and easier to test.

**Part 2 — Token set normalization before scoring.**
Replace or supplement the current similarity method with **token set ratio** scoring (sort both strings' token sets, deduplicate, rejoin, then score). Token set ratio is specifically designed to be invariant to word order and handles the `"Hazardous Hanging Limb"` vs. `"Hazardous Limbs Hanging"` permutation correctly. If the codebase already uses a library like `rapidfuzz` or `fuzzywuzzy`, `token_set_ratio` is a direct drop-in. If it uses a custom cosine/TF-IDF approach, add a token-sort normalization step before vectorization.

**Threshold note:** If the current threshold was calibrated against the old method, re-evaluate it after switching to token set ratio. Token set ratio scores tend to run higher for legitimate matches and should not require lowering the threshold to pass this case — if the score is still below threshold after normalization, the threshold itself needs review, but do not lower it without re-running the full known-match corpus.

**Do not make the matcher more permissive globally** without running it against the full set of known invoice/contract pairs to confirm the false-positive rate does not increase. A matcher that is too loose will suppress legitimate `CROSS_DOCUMENT_CONTRACT_RATE_EXISTS` findings on genuinely unmatched lines.

---

## Stop Conditions

- Do not proceed if the raw similarity score for this pair (after prefix stripping) is below 0.70 on token set ratio — that would indicate a deeper normalization problem (encoding, measurement suffix mismatch, or stemming failure) that needs separate diagnosis before the threshold fix.
- Do not change the canonical rate row description, the invoice line description, or any persisted canonical fact to force a match. The fix must be in the matcher, not in the data.
- Do not widen the threshold as a shortcut without evidence from the full match corpus.
- Do not alter the finding lifecycle for `CROSS_DOCUMENT_CONTRACT_RATE_EXISTS` findings globally — only the scoring logic for this rule's description comparison step.
- If the `>2"` measurement suffix is found to encode differently between invoice and contract (quote character mismatch), treat that as a **separate extraction normalization fix** and do not conflate it with the word-order fix.

---

## Regression Gates

1. **This pair must pass after the fix:** Invoice `"Tree Operations Hazardous Hanging Limb Removal >2" per tree"` matches contract `"Trees with Hazardous Limbs Hanging Removal >2""` at or above threshold, finding resolves as matched, no false `CROSS_DOCUMENT_CONTRACT_RATE_EXISTS` finding is raised.
2. **Rate integrity:** Matched rate must be `$80.00/unit`, unit `Tree`. The fix must not alter the matched rate value or unit.
3. **No new false positives:** Run the matcher against all existing invoice/contract pairs in the test suite. No previously-unmatched pair should now produce a spurious match.
4. **No regression on legitimate findings:** Pairs that correctly fail `CROSS_DOCUMENT_CONTRACT_RATE_EXISTS` (genuinely missing contract rates) must continue to fail.
5. **Williamson CYD 74,617 / Extended Cost $815,559.35 invariant:** If any invoice line or rate row in the Williamson document family passes through this matcher, confirm those lines are unaffected by the normalization change.
6. **Finding lifecycle:** Confirm that once the match succeeds, the finding for document `53d74340` line 6 transitions correctly (suppressed, resolved, or not raised — per the finding lifecycle rules) and does not persist as a stale active finding.

---

## Codex Prompt

```
CONTEXT
=======
EightForge validator rule CROSS_DOCUMENT_CONTRACT_RATE_EXISTS raises a false-positive
finding on invoice document 53d74340, line 6 (invoice line 6A).

Invoice description:  "Tree Operations Hazardous Hanging Limb Removal >2\" per tree"
Contract row label:   "Trees with Hazardous Limbs Hanging Removal >2\""
Contract rate:        $80.00 / Tree / page 9

The canonical rate row is correctly extracted and confirmed against the source PDF.
The failure is a word-order/phrasing mismatch in the description similarity matcher,
compounded by a category prefix ("Tree Operations") present on the invoice side only.

PHASE A — AUDIT (complete before writing any code)
===================================================
1. Locate the validator rule file that implements CROSS_DOCUMENT_CONTRACT_RATE_EXISTS.
   Identify the exact function call that scores invoice-to-contract description similarity.

2. Locate the description similarity utility it calls. Identify:
   a. The similarity method (sequence ratio, cosine/TF-IDF, token sort ratio, token set
      ratio, embedding, or hybrid).
   b. The numeric confidence threshold used to determine "no confident match."
   c. Whether any normalization (lowercasing, punctuation stripping, prefix removal,
      stemming) is applied before scoring, and whether it is applied symmetrically to
      both strings.

3. Confirm whether the invoice description is passed into the scorer with or without
   the "Tree Operations" category prefix.

4. Retrieve the raw similarity score produced for this specific pair from the finding
   detail, matcher diagnostic log, or by running the scorer directly on the two strings.
   Record it.

5. Check whether the >2" measurement suffix encodes identically in both strings
   (quote character, whitespace around >, encoding). Flag any mismatch as a separate
   issue.

6. Identify all other validator rules that call the same similarity utility, so the
   Phase B change can be scoped correctly.

7. Locate the existing matcher test suite. Confirm whether any word-order-permuted
   pairs are already covered.

STOP if the raw score (after manual prefix stripping) is below 0.70 on token set ratio.
That indicates a deeper normalization problem. Report findings and do not proceed to
Phase B until the cause of the low score is understood.

PHASE B — IMPLEMENTATION
=========================
Make the smallest change that fixes the matcher for this class of failure without
weakening legitimate findings.

1. Add a symmetric normalization pre-step to the description similarity utility:
   a. Lowercase both strings.
   b. Normalize whitespace and punctuation (collapse runs, strip leading/trailing).
   c. Strip known invoice category prefixes from the invoice-side string before scoring.
      Use a maintained prefix list or a heuristic (strip leading tokens absent from the
      candidate contract label). Do NOT strip from the contract side.
   d. Normalize the measurement suffix: standardize quote characters to a single
      canonical form (e.g., plain double-quote) and normalize whitespace around >.

2. Replace or supplement the current similarity scoring with token set ratio:
   - Sort each string's token set, deduplicate, rejoin, then score.
   - If the codebase uses rapidfuzz or fuzzywuzzy, use token_set_ratio directly.
   - If using a custom method, add a token-sort normalization step before the existing
     scorer.
   - Do NOT lower the confidence threshold as a substitute for proper normalization.

3. Do not change:
   - Any canonical fact, rate row, invoice line, or persisted extraction output.
   - The finding lifecycle rules for CROSS_DOCUMENT_CONTRACT_RATE_EXISTS.
   - Any other validator rule's behavior unless it shares the same utility and the
     change is provably safe for all callers (confirmed in Phase A step 6).

4. Add the failing pair as a named test case in the matcher test suite:
   Input A:  "Tree Operations Hazardous Hanging Limb Removal >2\" per tree"
   Input B:  "Trees with Hazardous Limbs Hanging Removal >2\""
   Expected: match score >= threshold, match result = True
   Also assert: matched rate = $80.00, matched unit = Tree

PHASE C — VERIFICATION
=======================
1. Run the matcher unit tests. The new test case must pass. All existing cases must pass.

2. Run the full CROSS_DOCUMENT_CONTRACT_RATE_EXISTS validator against the complete
   invoice/contract pair corpus. Confirm:
   a. No previously-failing pair now produces a spurious match (false positive rate
      must not increase).
   b. No previously-passing pair now fails (no regression on legitimate findings).

3. Confirm the finding for document 53d74340 line 6 resolves correctly after the fix:
   it must not persist as an active CROSS_DOCUMENT_CONTRACT_RATE_EXISTS finding.

4. Confirm the matched rate is $80.00/Tree and the match is traced to page 9 of the
   contract source document. The evidence anchor must not be weakened.

5. Williamson invariant check: if any invoice line or rate row in the Williamson
   document family passes through this matcher, run those pairs explicitly and confirm
   CYD 74,617 / Extended Cost $815,559.35 are unaffected.

6. If the >2" suffix was found to encode differently (Phase A step 5), verify the
   normalization fix resolves that independently and does not mask a real extraction
   discrepancy.

HARD CONSTRAINTS
================
- Do not mutate canonical facts, rate rows, invoice lines, or extraction output.
- Do not lower the confidence threshold without corpus evidence.
- Do not make the matcher globally more permissive without regression evidence.
- Do not claim the fix is complete until Phase C gates pass.
- Do not alter finding lifecycle rules globally.
```
