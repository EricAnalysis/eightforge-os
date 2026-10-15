# Additive Phase 17 Sonnet 5.5 rationale compatibility request

The preserved v5 request uses Sonnet 5.5 adaptive thinking with explicit low
effort and transmits `rationaleCode.maxLength: 200`. Anthropic structured outputs
do not support `maxLength`, so the provider rejects that schema before the model
can answer.

This additive v6 request replaces only the unsupported `maxLength` keyword with
the provider-supported description `A brief rationale code containing between 1
and 200 characters.` The existing local validator still rejects an empty
rationale or a rationale longer than 200 characters. Confidence `minimum` and
`maximum` remain omitted from the transmitted schema, while local confidence
validation remains 0 through 1. Adaptive-low thinking and every other request
parameter are unchanged from v5.

The exact prompt, 400-token cap, 3000 ms deadline, zero retries, corpus, 13
labels, scoring, authority rules, thresholds and all historical artifacts are
unchanged. Use `npm run eval:phase17-sonnet-5-5-rationale-compat` for the zero-call
preflight. Execute only the complete 48-call cohort after the merged-revision
pins and spend ceiling pass. Never selectively retry a failed case.
