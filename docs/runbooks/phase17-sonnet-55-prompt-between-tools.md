# Additive Phase 17 v11 approved prompt with between-tools mode

The complete v10 cohort returned 23 HTTP400 "Schema is too complex" errors and
25 timeouts; no model answers. All48 frozen request bindings were verified.
Earlier v9 produced 48 timeouts. Preserve both as FAIL evidence, not correctness
evidence. Do not warm a schema or selectively retry an eligible case.

V11 reuses the exact approved v7 prompt and description-only rationale schema.
The rejected regex is omitted; the local rationale length 1..200 and confidence
0..1 checks remain authoritative. Relative to v7 the only wire changes are
thinking.type between_tools and omission of adaptive effort. This uses the same
provider mode as the established Phase17 v4 and independently qualified B4.6.1
transport path, without importing either workflow into production.

No corpus, label, candidate, input, scoring, correctness, authority, threshold,
400-token cap, 3000ms deadline or retry change. All13 labels and previous contracts
remain intact. Production clients/model configuration are unchanged. The new
runner freezes all48 input/body/options identities before the provider boundary.

Use `npm run eval:phase17-sonnet-5-5-prompt-between-tools` for the zero-call
preflight; only the full48 cohort may run after all identity and spend gates pass.
