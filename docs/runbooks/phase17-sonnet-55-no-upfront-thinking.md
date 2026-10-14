# Additive Phase 17 Sonnet 5.5 no-upfront-thinking request

The schema-compatible v3 cohort executed all 48 attempts and all timed out at the frozen 3000 ms deadline. No model output was returned. The omitted thinking parameter inherits adaptive thinking on Sonnet 5.5. Under the owner's engineering mission, this v4 additive request uses the same documented `thinking: {type: "between_tools"}` mode as approved B4.6.1 v3. With no tools, it removes upfront thinking without changing the task or qualification definition.

The provider-compatible confidence schema remains identical to v3. Local confidence validation remains [0,1]. Exact prompt, 400-token cap, corpus, 13 labels, candidate choices, adversarial/progression cases, authority, scoring, latency thresholds, timeout, retries and stop conditions are unchanged. All old clients, contracts, source pins and artifacts remain immutable. The new source-pinned request/framework identity, runner, artifact schemas, manual command and root are additive.

Use `npm run eval:phase17-sonnet-5-5-no-upfront-thinking` for zero-call preparation, with pinned source PDF and database environment removed. Execute only the full 48-call cohort after integrity preflight, with unchanged $2 ceiling and confirmed pricing. Do not selectively retry. The frozen confidence bounds are still enforced locally. A Phase 17 pass does not resolve B4.6.1's independent p95 failure or permit production promotion.

Model documentation: https://platform.claude.com/docs/en/models/sonnet-5-5/migration-guide
