# Case Investigation qualification contract v3 (`case_investigation_qualification_v3`): draft

**Status: DRAFT, not frozen. Blocked on one owner decision: latency.** Nothing has run under v3 and no v3 identity is frozen. The workflow stays `disabled`. [v2](case-investigation-qualification-v2.md) FAILED on 2026-10-22. That result is final for v2 and is not reinterpreted here.

The owner decided every v3 term on 2026-10-22, except latency. A 10-call probe, approved by the owner, showed that the approved short-answer budget cannot meet the unchanged latency bar on this model. So v3 is not frozen, and no paid v3 run may start until the latency term is decided.

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
   - Classes, minimums, root-cause vocabulary, human authority, model, temperature 0, 15 s timeout, zero retries, all other bars, cost limit, $3.00 ceiling and run rules are unchanged.

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

## The one remaining owner decision: latency

v3 can be frozen and run once this is decided. Each option is a contract term.

- **A. Raise the latency bar deliberately**, for an operator-invoked, on-demand investigation. Examples: median ≤ 15 s and p95 ≤ 20 s. The timeout would also need raising from 15 s, because v2 timed out 35 times at 15 s. Record why.
- **B. Shrink the output through the request shape**, not through instructions the model ignores. For example, cite records by a short index into the transmitted records instead of echoing ids of up to 315 characters; echoed ids cost about 0.64 tokens per character in v2. This needs another probe first: the fixed cost of about 4.4 s alone leaves little room under 6 s.
- **C. Qualify a different model** under its own contract. It must first be added to the qualified-model lists.
- **D. Accept that Case Investigation does not qualify on this model.** It stays disabled.

## After the decision

1. Freeze v3 under a harness parameterized for v3, at the bars and request implied by the decision.
2. Freeze the carried-over corpus and labels (zero calls).
3. Run the zero-call preflight.
4. Run a compatibility probe, only if the request or schema changes materially.
5. Run exactly one complete paid run.

## Known residual, not on the provider path

`page_structure` slices are also built with `recordIds: []`. No investigable case kind transmits them today. They must be given citable records before any kind that does becomes investigable.
