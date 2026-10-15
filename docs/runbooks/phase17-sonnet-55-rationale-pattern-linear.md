# Additive Phase 17 Sonnet 5.5 rationale pattern compatibility request

V9 completed its full 48-call cohort with 48 timeouts and no model answers.
Its 199 independently optional atoms also exhibited severe local JavaScript
regex backtracking on over-length diagnostic inputs. Provider-side attribution
is unknown: no response or usage returned before the frozen deadline.

This additive v10 changes only the regex representation: one required character
followed by eight optional fixed-length blocks of 72,64,32,16,8,4,2,1 characters.
Their subset lengths cover exactly 0 through 199, preserving the same full-match
1..200 language while bounding optional combinations to 256 rather than 2^199.
Groups and optional quantifiers are documented supported syntax:
https://platform.claude.com/docs/en/build-with-claude/structured-outputs#pattern-support-regex
Actual provider compatibility/performance still require the complete frozen
cohort. This is an engineering hypothesis, not a claimed provider root cause.
The intended bound remains 1 through 200 regex characters. It does not
truncate, rewrite, or postprocess a provider response. The existing local Zod
check remains authoritative, including its JavaScript UTF-16 length semantics.

The exact owner-approved v7 prompt, Sonnet 5.5 adaptive thinking with explicit
low effort, 400-token cap, 3000 ms deadline, zero retries, corpus, 13 labels,
inputs, candidates, scoring, authority rules, thresholds and historical
artifacts are unchanged.
The pre-provider freeze binds all 48 actual request bodies and options by digest
without storing source text or provider payloads.

Use `npm run eval:phase17-sonnet-5-5-rationale-pattern-linear` for the zero-call
preflight. Execute only the complete 48-call cohort after the merged-revision
pins and spend ceiling pass. Never selectively retry a failed case.
