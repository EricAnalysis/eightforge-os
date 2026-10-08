# Golden row bands: PR report

Implementation evaluated: `2d77a9e5fd3251f55736f1dffc3e7cf19c9e07e7`, compared with main `1dd82d9169957f2ff2d1344fd60f27e5f97f52b5`. Branch: `codex/golden-row-bands`. This report records audit-only follow-up; no further extraction correction is included. Client PDFs, page renders, capture payloads and synthetic replay artifacts remain outside the repository.

## Known, page-confirmed limitations deliberately left uncorrected

**Golden physical p10, main row index 21 is a valid individual priced source row.** It remains withheld because a 53 px OCR pipe observation over the printed Unit/Rate divider crosses the measured row boundaries by approximately 10.91 px above and 15.37 px below. The actual unit-word observation is 16 px tall and fits the printed row. Source-page inspection confirms the row is valid; it is deliberately not corrected in this branch follow-up. No box was trimmed, tolerance widened or reviewed value manufactured.

**Golden p10 row 24 has a new machine-category abstention.** Source inspection confirms Equipment. Attaching an OCR pipe over the Category/Description divider changes its supporting cell from the exact category to category-plus-pipe; the production adapter changes Equipment to unresolved and requires category review. Its description, unit, rate cells and scanned-rate authority are unchanged. This limitation is also deliberately left uncorrected under the audit-only scope. A future correction should classify attested separator ink as structural, rather than guess category text or relax text containment.

Source PDF SHA-256: `922161a533bb6b8c1afb52cb9536044c8a6836bed62401634f4f505025631e8f`. Physical page 10 was rendered and visually inspected. No production database or persisted historical review was queried. The older-v2 production state is user-provided context, not independently verified here.

## Before/after reconstruction

| Document / page | Published main -> branch | Rejected main -> branch |
| --- | ---: | ---: |
| Golden total | 44 -> 42 | 20 -> 29 |
| Golden p8 | 11 -> 10 | 9 -> 12 |
| Golden p10 | 19 -> 18 | 8 -> 14 |
| DN | 41 -> 41 | 0 -> 0 |
| Hillsdale | 50 -> 50 | 2 -> 2 |

P8 publishes every main row except original two-row line A; restored labels include r-0006, r-0016, r-0017 and r-0018. DN and Hillsdale whole captures differ only in reconstruction parser_version.

All 19 p10 main rows are accounted for: indices 0-10 and 14 retain identical complete row objects; 12,13,17,23,24 retain identical priced cells/bounds with supporting evidence changes; 20 retains identical priced cells but detaches supporting evidence and narrows aggregate bounds to y1137-1165; 21 is the page-confirmed known limitation above. Supporting moves can change category semantics despite unchanged prices.

## Every published row with changed observation membership

The audit matched all 42 surviving Golden main publications (10 on p8,14 on p9,18 on p10) using unique rate-observation provenance. Fourteen rows changed assembly or supporting membership; all28 other publications, including every p9 row, remain unchanged. Golden's 1,165 persisted observations and canonical geometry are byte-identical; these are membership/order changes, not recreated observation IDs or deleted source evidence.

There are two identities to distinguish: the display/adapter ID `page_priced_schedule:p<page>:r<index>` and the priced-review anchor hashing ordered pricing-authoritative assembly observations. Display IDs remain unchanged in all14 cases. Only p8 indices3 and11 change priced-review anchors. Raw assembly additions in p8 indices8 and16 are excluded by the existing pricing-authoritative projection; their review anchors remain unchanged.

Each table result executes the existing pure resolver against synthetic old-main-evidence rate and category confirmations, verifies the exact old IDs against the current persisted page, and runs machine supersession. These are 28 successful synthetic replays, not actual saved-review replays.

| Page | Main/branch row index | Display row identity | Priced-review anchor | Supporting refs main -> branch | Existing otherwise-valid rate/category review held? |
| --- | ---: | --- | --- | ---: | --- |
| 8 | 3 | unchanged | changed | 8 -> 4 | No; effective in resolver replay |
| 8 | 5 | unchanged | unchanged | 0 -> 5 | No; effective in resolver replay |
| 8 | 8 | unchanged | unchanged | 5 -> 3 | No; effective in resolver replay |
| 8 | 11 | unchanged | changed | 6 -> 9 | No; effective in resolver replay |
| 8 | 12 | unchanged | unchanged | 0 -> 6 | No; effective in resolver replay |
| 8 | 13 | unchanged | unchanged | 3 -> 7 | No; effective in resolver replay |
| 8 | 15 | unchanged | unchanged | 8 -> 9 | No; effective in resolver replay |
| 8 | 16 | unchanged | unchanged | 5 -> 3 | No; effective in resolver replay |
| 10 | 12 | unchanged | unchanged | 3 -> 1 | No; effective in resolver replay |
| 10 | 13 | unchanged | unchanged | 0 -> 2 | No; effective in resolver replay |
| 10 | 17 | unchanged | unchanged | 2 -> 1 | No; effective in resolver replay |
| 10 | 20 | unchanged | unchanged | 2 -> 1 | No; effective in resolver replay |
| 10 | 23 | unchanged | unchanged | 1 -> 1 | No; effective in resolver replay |
| 10 | 24 | unchanged | unchanged | 1 -> 2 | No; effective in resolver replay |

Changed priced-review anchors:

- p8 index3: `p8:priced_line:7639b36ed896a2df45e275ec6d6d6757` -> `p8:priced_line:fae8ff033a5a752cbd3ac9146bfb3d47`.
- p8 index11: `p8:priced_line:521ade93f7aa4d9d911c2fa8a4c503e6` -> `p8:priced_line:8b2f8b94e17eb8c4265b7ec50ee71bc7`.

A changed priced anchor does **not** itself hold an existing region-bound human fact assertion under the current contract. `resolveRegionBoundAssertions` holds on an absent/changed page-representation digest; both p8/p10 digests remain unchanged. The existing observations remain verifiable. `decideAgainstHumanReview` supersedes a machine row on any source-observation overlap with the effective human-reviewed row. All14 changed rows retain that overlap, including the two changed anchors. This is not a claim that every historical review survives a v2-to-v5 re-extraction: no production records were loaded, and different page state, competing assertions or unprovable binding still fail closed.

Relevant contracts: `lib/humanFactAssertions/regionBoundAssertions.ts`, `lib/humanFactAssertions/humanReviewSupersession.ts`, `lib/contracts/categoryReview.ts` and `lib/extraction/pdf/pricedScheduleAuthority.ts`.

## Downstream category changes

The existing production pure adapters were run against both pinned captures. P8 index5 gains Vegetative; 11,12,13 gain C&D; other affected p8 categories remain unchanged. On p10:

| Main row index | Allowed category main -> branch | Machine category review |
| --- | --- | --- |
| 12 | unresolved -> Equipment | removed |
| 13 | unresolved -> unresolved | still required |
| 17 | unresolved -> Equipment | removed |
| 20 | unresolved -> Equipment | removed |
| 23 | Equipment -> Equipment | still unnecessary |
| 24 | Equipment -> unresolved | newly required; known limitation |

All six p10 rate-authority states remain `review_required` on `scanned_source`; the pure adapter emitted no ruling-pricing-authority diagnostics. Otherwise-valid human-chosen category authority is not replaced by the machine category change.

## Confirmed continuations retain their reviewed binding

Structural detachment is disabled when any contributing SourceLine carries a confirmed continuation candidate. This preserves the exact reviewed line and target context; the parser cannot rebuild a shortened description and silently apply the old confirmation. V2 continuation re-entry still regenerates the candidate against exact composed text, ordered observation IDs, target-context evidence and page digest. Conflicting physical bands keep the row withheld with `confirmed_recovery_not_applied` instead of publishing altered reviewed content.

The synthetic OCR/ruling regression proves ordinary exact-confirmation publication without conflicting rules and withholding with conflicting physical bands. Removing the guard makes that regression fail by incorrectly publishing the reviewed row. The guard was restored before the evaluated implementation. The current-commit recovery re-entry suite passed 45/45, including legacy-candidate, reparsed-context and page-digest controls. This establishes the continuation contract, not the existence or preservation of particular production continuation reviews.

## B4.6.1 before/after

| Class | Cases main -> branch | Bound main -> branch | Failures main -> branch |
| --- | ---: | ---: | ---: |
| Scanned amount: dense schedule | 20 -> 20 | 20 -> 20 | 0 -> 0 |
| Scanned amount: price sheet | 51 -> 50 | 50 -> 50 | 1 -> 0 |
| Scanned amount: unclassified | 19 -> 18 | 0 -> 0 | 0 -> 0 |
| Withheld: dense schedule | 2 -> 2 | 1 -> 1 | 1 -> 1 |
| Withheld: price sheet | 9 -> 12 | 7 -> 12 | 2 -> 0 |
| Withheld: unclassified | 13 -> 19 | 0 -> 0 | 0 -> 0 |
| Unresolved: unclassified | 45 -> 45 | 0 -> 0 | 0 -> 0 |
| Category: human only | 15 -> 15 | 0 -> 0 | 0 -> 0 |

No new binding failure of any kind. All three Golden `region_spans_rows` failures resolve. Only DN's existing p107 `region_misses_rate` remains. All additional withheld p8/p10 cases have unique main provenance parents and description-plus-authored-rate evidence. P10 remains unlabelled/unscored; its source-review findings above do not substitute for a labelled qualification set.

## Verification and evidence boundaries

Docker evaluation explicitly set `EIGHTFORGE_EVAL_IMAGE=eightforge-eval:2d77a9e5fd32`; exact source digest `2c4401ab682f696df9d1cc2b7ce9dd1ba1864439baf58f80d5fa48aaccdd205d`, 1831 files. Corpus/pins mounted read-only, network disabled, no application/provider credentials. DN, Golden and Hillsdale captures repeatable; 83/83 bound crops deterministic; zero provider calls/spend. No qualification activation claimed.

- Focused six-file suite: 206 passed; recovery/ruling suite: 59 passed; current-commit recovery re-entry recheck: 45 passed.
- TypeScript and git diff --check passed.
- Complete Linux suite: 5961 passed,92 skipped, zero failures, 494 passing files. Disposable verification container added Git and shallow metadata for the same commit, retained exact source bytes, and was network-disconnected before testing.
- Windows LF checkout: 6005 passed,2 failed,46 skipped. Both failures are unchanged forward-slash/backslash exclusions in forgewingGatesBoundaries.test.ts; this is not a clean Windows full-suite pass.
- Raw canonical comparison remains `PARITY: NO -- stop and report; do not normalize differences away`. Runtime commit/tree identity and intended Golden reconstruction/closure differences are preserved. Supplementary exact DN/Hillsdale checks exclude only their parser_version path.

Capture-set SHA-256 main: `b8cf14e638079170f238226f8cac59d0b911f87d836dc76c63e07a447cf3eb9d`.
Capture-set SHA-256 branch: `4d024fbea02ac9c1f55fd71e48fe8b2c9df41c3c7d047508dcc1205872047c13`.

Local external evidence includes FINAL-REPORT.md, VERIFICATION.md, raw-capture-comparison.log, all-changed-published-review-identity-audit.json, p10-category-downstream-audit.json and p10-source-review page renders. PDFs, raw captures and rendered client pages must stay outside Git. This report contains metrics, identities and audit conclusions only.

This audit documents known limitations and review behavior; it is not a merge-readiness claim or authorization to merge. No PR is opened by this work.