# Additive Phase 17 Sonnet 5.5 rationale pattern compatibility request

This additive v9 request changes only the v8 rationale regex syntax. V8's full
cohort was rejected HTTP 400 because a range quantifier could not be applied to
its character class. V9 uses one required `[\\s\\S]` followed by 199 optional
`[\\s\\S]?` atoms, preserving the regex language without a range quantifier.
The intended bound remains 1 through 200 regex characters. It does not
truncate, rewrite, or postprocess a provider response. The existing local Zod
check remains authoritative, including its JavaScript UTF-16 length semantics.

The exact owner-approved v7 prompt, Sonnet 5.5 adaptive thinking with explicit
low effort, 400-token cap, 3000 ms deadline, zero retries, corpus, 13 labels,
inputs, candidates, scoring, authority rules, thresholds and historical
artifacts are unchanged.
The pre-provider freeze binds all 48 actual request bodies and options by digest
without storing source text or provider payloads.

Use `npm run eval:phase17-sonnet-5-5-rationale-pattern-compat` for the zero-call
preflight. Execute only the complete 48-call cohort after the merged-revision
pins and spend ceiling pass. Never selectively retry a failed case.
