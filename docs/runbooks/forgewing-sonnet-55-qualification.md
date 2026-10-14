# Forgewing Sonnet 5.5 additive qualification

This path re-runs the existing Phase 17 and B4.6.1 qualification semantics against
`claude-sonnet-5-5`. It does not replace the Sonnet 4.6 contracts or authorize a
production model change.

## Frozen relationship

The v2 registrations reuse the v1 corpus, labels and expected outputs, prompts,
output schemas, scoring, thresholds, exclusions, stop conditions, authority
checks, timeout bars and cost bars. Their only behavioral request difference is:

```text
model: claude-sonnet-5-5
temperature: omitted from the request body
```

Both frameworks record the omitted parameter explicitly in artifact provenance.
The B4.6.1 command writes under
`scripts/evaluation/artifacts/b461-sonnet-5-5/local/`; Phase 17 writes under
`scripts/evaluation/artifacts/phase17-sonnet-5-5/`. Writes are create-only and
cannot replace an existing artifact.

The Sonnet 4.6 entry points remain unchanged:

- `npm run eval:phase17-continuation`
- `scripts/evaluation/b461/runQualification.ts`

## Zero-call compatibility

With the same pinned external inputs used by v1, omit `--execute-provider`:

```bash
npm run eval:phase17-sonnet-5-5-continuation -- \
  --input-usd-per-mtok <price> --output-usd-per-mtok <price>

npm run eval:b461-sonnet-5-5 -- \
  --captures <pinned run dir> --corpus <pdf dir> \
  --pins scripts/evaluation/docker/pinned-corpus.pins.json
```

These commands validate the additive source pins, render the same frozen inputs,
record the distinct 5.5 request identity, and make zero provider calls. Live
execution still requires the existing explicit authorization and pricing gates.

## Historical baseline

The authoritative Sonnet 4.6 DN p107 result remains 20/20 correct with zero
inventions and wrong bindings. Its 3196.1921 ms median exceeded the unchanged
3000 ms bar, so the result remains **FAIL**. The v2 registration does not change
or reinterpret that evidence.

Neither command changes `FORGEWING_MODEL`. Promotion remains a separate reviewed
production action after every frozen gate passes.

The manual v2 runners bind `claude-sonnet-5-5` from their registered contracts;
they do not read or mutate the production `FORGEWING_MODEL` value.
