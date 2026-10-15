# Additive Phase 17 Sonnet 5.5 bounded rationale request

This additive v8 request changes only the v7 `rationaleCode` output schema. It
adds the provider-supported pattern `^[\\s\\S]{1,200}$` to constrain ordinary
rationale text to 1 through 200 regex characters during decoding. It does not
truncate, rewrite, or postprocess a provider response. The existing local Zod
check remains authoritative, including its JavaScript UTF-16 length semantics.

The exact owner-approved v7 prompt, Sonnet 5.5 adaptive thinking with explicit
low effort, 400-token cap, 3000 ms deadline, zero retries, corpus, 13 labels,
inputs, candidates, scoring, authority rules, thresholds and historical
artifacts are unchanged.
The pre-provider freeze binds all 48 actual request bodies and options by digest
without storing source text or provider payloads.

Use `npm run eval:phase17-sonnet-5-5-bounded-rationale` for the zero-call
preflight. Execute only the complete 48-call cohort after the merged-revision
pins and spend ceiling pass. Never selectively retry a failed case.
