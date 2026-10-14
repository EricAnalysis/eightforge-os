# Additive Phase 17 Sonnet 5.5 schema compatibility

The owner approved removal of only the transmitted confidence minimum/maximum on 2026-10-14. The prior 48-call HTTP 400 run and all previous contracts remain preserved.

`phase17-continuation-qualification-contract-v3-sonnet-5-5-schema-compat` uses a separately source-pinned client, runner and artifact schema. Its provider schema differs from the frozen v2 schema only by removing `properties.confidence.minimum` and `.maximum`. The production recommendation task still validates confidence within [0,1] through its unchanged local Zod schema. No provider output can bypass that validation.

Prompt, model `claude-sonnet-5-5`, 400-token cap, omitted temperature, omitted thinking, zero SDK retries, 3000 ms timeout, corpus, all 13 owner labels, expected outputs, authority, scoring, thresholds and stop conditions remain unchanged. Request provenance records `confidence-provider-bounds-omitted-local-bounds-preserved-v1`; the schema digest describes the actual transmitted schema. Prior semantic-source pins remain literal and unchanged.

The manual command is `npm run eval:phase17-sonnet-5-5-schema-compat`. Supply the pinned source PDF through `DN_PRICED_SCHEDULE_SOURCE_PDF`, remove production database variables, and prepare without `--execute-provider`. Live execution requires a clean exact revision, successful integrity preflight, `--execute-provider --max-calls 48 --max-spend-usd 2` and confirmed pricing. Ordinary implementation tests and CI make zero paid calls. New write-once artifacts use a distinct schema-compat root; old artifacts retain their original readers and source identities.

B4.6.1 v3 remains independently failed at p95 8361.9028 ms against 8000 ms. A Phase 17 pass alone does not authorize or recommend Forgewing promotion. No production model configuration is changed by this path.
