# Case Investigation qualification contract v3 (`case_investigation_qualification_v3`)

**Status: FROZEN 2026-10-22.** Every term is decided by the owner, the identities are committed below, and exactly one paid run is authorized. The workflow stays `disabled` until a PASS passes the reviewed activation path. [v2](case-investigation-qualification-v2.md) FAILED on 2026-10-22. That result is final for v2 and is not reinterpreted here.

## Defects fixed in code (this PR)

| v2 defect | Fix | Proof |
|---|---|---|
| `document_relationships` was transmitted with no citable record whenever the case document had no relationship row (55 of 111 cases), so every citation of it was refused | `documentRelationshipRecordIds`: the slice also cites the documents it describes, namely the case document, then the governing document, then the relationship rows (deduplicated). No relationship evidence is invented, and relationship authority is unchanged: these ids were already in the slice's payload and provenance | Over the frozen r2 corpus: uncitable slices fall from 55 to 0. Only the provenance of 72 contexts changes; payloads do not |
| The runner enforced the answer's bounds (1,200 / 2,000 characters, 1–12 citations) without stating them; structured outputs cannot express string lengths | `CASE_INVESTIGATION_OUTPUT_LIMITS`, one constant used by both the schema and the prompt (`case_investigation_prompt_v3`). The bounds are unchanged | Runner tests |
| A cited `recordId` was capped at 200 characters, but transmitted ids reach 315 | No cap of its own. A cited id must equal a transmitted id exactly, which is the strict bound | Runner tests |
| A UUID's digits were read as loose numbers (1 of v2's 18 invented-number flags) | `unsupportedNumbers` reads a UUID whole. It must be an identifier the context carried; any other UUID is invented. No factual number is exempt | Runner tests: a carried UUID passes; an unknown UUID, or a factual number written beside a carried UUID, fails |

The context-digest formula moved into `investigationContextDigests`. Over the frozen r2 corpus it reproduces all 111 `transmittedDigest` and `readDigest` values exactly, with zero calls.

## Owner decisions (2026-10-22)

1. **Enumeration markers:** handled in the prompt, not in the checker. The prompt says: "Write points as prose, or separate them with semicolons; never number or letter them."
   - The invented-number check stays fully strict: "(1)" still fails.
   - The UUID-as-identifier rule above is the only narrowing.
   - Factual quantities, rates, counts, dates, amounts and identifiers the context did not carry still fail.
2. **Top-1 bar: contract correction.** v2's `max(baseline + 0.10, 0.70)` cannot be met when the deterministic baseline is 1.00, which it is in both classes (3/3 and 12/12 ranking cases).
   - v3 replaces it with **top-1 ≥ 0.90 and top-1 ≥ the deterministic baseline**, with no bonus, clipping or special-case arithmetic. On this corpus the baseline term binds, so the requirement is 1.00.
   - This corrects an impossible v2 threshold. It is not a post-hoc attempt to make the failed v2 run pass. v2 also failed on hard bars that this change does not touch.
   - The owner's two instructions named floors of 0.90 and 0.70; v3 takes the stricter, 0.90.
3. **Relationship citation defect:** fixed as above, using the existing precedence provenance only.
4. **Request size:** investigated, and no reduction is justified.
   - Input is small: v2 median 1,214 tokens, maximum 1,859.
   - v2's own data fits latency at about 4.4 s plus 12.5 ms per **output** token. Output, not the request payload, drives latency.
   - No evidence was removed.
5. **Corpus and labels carry over unchanged.**
   - The v3 corpus is the same 111 cases: each frozen r2 context, with only its relationships provenance re-derived by the production helper. It is not a live rebuild, so no case can enter or leave.
   - The labels are the frozen v2 label set `7a139119…063f`, including Eric Martin's 22 adjudications, carried over verbatim under a v3 label identity.
   - Classes, minimums, root-cause vocabulary, human authority, model, temperature 0, zero retries, all other bars, cost limit, $3.00 ceiling and run rules are unchanged.
6. **Latency, raised deliberately** (decision 6, after probes 1–3 below):
   - median ≤ **15 s** (was 6 s); p95 ≤ **25 s** (was 12 s); provider timeout **30 s** (was 15 s);
   - invalid answers, timeouts included, stay at most **5%**.
   - **Why:** the operator invokes the investigation on demand, and the deterministic investigation is already on screen, so the operator is never blocked. The 30 s timeout covers the longest observed answer (817 tokens) at the slowest observed throughput (about 27 ms per token). It stays under the app's 45 s budgeted-call bound and the 300 s function limit. The p95 bar sits below the timeout, and the unchanged 5% invalid bar controls the tail.
   - This is a deliberate product decision, not a correction of v2, and v2's FAIL stands.
7. **Citations by letter ref (option B).** The model cites each record by the short ref in its slice's `cite` map, and the runner resolves the ref to the slice kind and record id.
   - The stored investigation, the durable record and the UI are unchanged.
   - Unknown or duplicate refs are refused.
   - The code from draft #279 is merged with this freeze.

## The latency probe (2026-10-22): the short-answer budget does not fit

The probe was owner-approved. It is not a qualification.

| Setting | Value |
|---|---|
| Script | `scripts/evaluation/case-investigation/probeLatencyV3.ts` |
| Cases | 10 synthetic conflict-fixture cases, no customer content |
| Request | v3 contexts; production runner and adapter; `claude-sonnet-4-6` |
| Probed budget | diagnosis ≤ 400 and rationale ≤ 600 characters, 500 output tokens |
| What was kept | No answer text, and no label read |
| Evidence | `case-investigation-v3-latency-probe-20261022/probe.json`, sha256 `6f5299a9…82ab` |

| Result | Value | Bar |
|---|---|---|
| Median latency | **8.9 s** | ≤ 6 s ✗ |
| p95 latency | 10.2 s | ≤ 12 s |
| Truncated at 500 tokens (`provider_failed`) | 6 of 10 | — |
| Completed but over the stated length (`output_invalid`) | 3 of 10 | — |
| Accepted | 1 of 10 | — |
| Known spend | $0.12 | — |

The model does not keep to a stated character budget: it overran the budget or was truncated. Even truncated at 500 tokens, the median stayed far above 6 s. The short budget was therefore **not adopted**, and the code keeps v2's bounds.

## Probe 2 (2026-10-22): option B, citing records by letter ref

The owner chose to try option B before deciding latency.
- **Request change:** the model cites each record by a short letter ref from its slice's `cite` map, instead of echoing the record id. The runner resolves the ref back to the slice kind and record id, so the stored record and UI are unchanged.
- **Setup:** the same 10 synthetic fixture cases and production runner as probe 1. The answer bounds stayed at v2's 1,200 / 2,000 characters and 1,500 tokens.
- **Code:** draft PR #279, not merged.
- **Evidence:** `case-investigation-v3-latency-probe-b-20261022/probe.json`, sha256 `7042a75b624526b7ba57527052af15ef86bbaf31375f667c1d6cb214522988a3`; prompt sha256 `ebee491d…7219`. Known spend $0.07.

| Result | Value | Bar |
|---|---|---|
| Accepted, of completed answers | **6 of 6** | — |
| Timeouts at 15 s | 4 of 10 | — |
| Median latency | **14.7 s** | ≤ 6 s ✗ |
| p95 latency | 15.0 s | ≤ 12 s ✗ |
| Output tokens, completed answers | 434–498 (v2 median 528) | — |

**What the probe shows:**
- **Validity improved.** No completed answer was rejected.
- **Latency did not.** The model spent the tokens it no longer used on ids on longer prose, so output fell only about 10%.
- **Provider throughput varies.** It was slower this session, about 27 ms per output token against v2's fitted 12.5 ms.
- **Conclusion:** neither the shorter-instruction budget (probe 1) nor compact citations (probe 2) bring Sonnet 4.6 near the 6 s median on this request.

## Probe 3 (2026-10-22): the tail at a 30 s timeout, before the freeze

The owner approved this probe as the go/no-go check for the new latency terms.
- **Setup:** the same 10 synthetic fixture cases; letter-ref citations; v2's answer bounds; timeout 30 s.
- **Evidence:** `case-investigation-v3-latency-probe-c-20261022/probe.json`. Known spend $0.12.

| Result | Value | v3 bar |
|---|---|---|
| Accepted | **10 of 10** | invalid ≤ 5% |
| Median latency | **13.4 s** | ≤ 15 s |
| p95 / longest | 16.6 s / 16.6 s | ≤ 25 s |
| Timeouts | 0 | — |

The bars were not already lost, so v3 was frozen. The median margin is thin: the probe covered synthetic conflict cases only, and provider throughput varies.

## Frozen identities

| Identity | Value |
|---|---|
| Contract | `case_investigation_qualification_v3` |
| Scorer / bars digest | `case_investigation_scorecard_v3` / `f288175020a6a9606d4c56284b9e1f9d7cb8ade599e669586aeaaff6b6324ce9` |
| Prompt | `case_investigation_prompt_v3`, sha256 `ebee491dab80316c1219b95e546c226c5d3b9254d67fce3862d35e86e3837219` |
| Request | `claude-sonnet-4-6`, temperature 0, 1,500 output tokens, **30 s** timeout, zero retries |
| Corpus manifest | `scripts/evaluation/artifacts/case-investigation-v3/corpus-manifest.json`, sha256 `017ee6339992ae42b8c39f4d9a2f9c788e005e10b2c645114c5e681bf8f64672` |
| Corpus content | Derived from the committed v2 manifest: 169 cases, 111 eligible (81 / 30), 126 identities changed by relationships provenance only |
| Labels | `scripts/evaluation/artifacts/case-investigation-v3/labels.json`, digest `80d4c874fc570b8ee79fc90e9d83ea4a3d2326065e06c3f60702541f85ade605`, carried verbatim from v2 `7a139119…063f` |

**Proof before the paid run:**
- v2's bars digest is unchanged (`e4787588…`), and all 9 v2 evidence files match their recorded checksums.
- The v2 harness now refuses the v2 corpus ("pinned source changed"), so v2 cannot be reused by accident.
- Architecture guards pass (40 files, 470 tests), along with the focused tests and tsc.

## Commands (zero-call except the run)

```text
qualifyV2.ts derive-corpus --contract v3 --from <r2 dir> --out <r3 dir>
qualifyV2.ts carry-labels  --contract v3 --corpus <r3 dir> --v2-labels <v2 labels.json> --out <labels.json>
qualifyV2.ts preflight     --contract v3 --corpus <r3 dir> --labels <labels.json> --out <dir>
qualifyV2.ts run           --contract v3 ... --confirm-paid-run      (exactly once)
qualifyV2.ts grading-packet / score --contract v3 ...
```

## Known residual, not on the provider path

`page_structure` slices are also built with `recordIds: []`. No investigable case kind transmits them today. They must be given citable records before any kind that does becomes investigable.
