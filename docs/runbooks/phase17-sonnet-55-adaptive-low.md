# Additive Phase 17 Sonnet 5.5 adaptive-low request

The preserved v4 cohort proved that `between_tools` removed the all-request
timeout failure, but it also produced ten 3000 ms timeouts, one response that
violated an undisclosed local rationale-length constraint, and repeatable
disagreements with frozen owner labels. Candidate identities, label binding and
request inputs were verified; the labels, scorer and prior evidence remain
unchanged.

This additive v5 request uses Sonnet 5.5 adaptive thinking with explicit low
effort. Anthropic recommends adaptive thinking for ranking and other reasoning
tasks that return JSON, while low effort is the latency-oriented setting. The
provider schema also declares `rationaleCode.maxLength: 200`, matching the
existing local validator. Confidence `minimum` and `maximum` remain omitted from
the transmitted schema, while local confidence validation remains 0 through 1.

The exact prompt, 400-token cap, 3000 ms deadline, zero retries, corpus, 13
labels, scoring, authority rules, thresholds and all historical artifacts are
unchanged. Use `npm run eval:phase17-sonnet-5-5-adaptive-low` for the zero-call
preflight. Execute only the complete 48-call cohort after the merged-revision
pins and spend ceiling pass. Never selectively retry a failed case.
