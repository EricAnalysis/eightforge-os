# Additive B4.6.1 Sonnet 5.5 request efficiency contract

The owner approved expanding the output cap from 300 to 500 on 2026-10-14.
Contract `b461-qualification-contract-v3` preserves every historical v1/v2 file
and artifact. It uses the same corpus, expected outputs, prompt, JSON schema,
scorer, exclusions, authority guards, stop conditions, cost bars, and 3000 ms
median / 8000 ms p95 latency bars.

Its exact provider request is Sonnet 5.5, `max_tokens: 500`, temperature omitted,
and `thinking: { type: "between_tools" }`. There are no tools. This restores
the absence of upfront thinking that the original 4.6 request inherited.
Anthropic documents that 5.5 instead inherits adaptive thinking when this field
is omitted, and that thinking consumes the output allowance:
[migration guide](https://platform.claude.com/docs/en/models/sonnet-5-5/migration-guide).
The evidence identifies this as a plausible contributor to the v2 truncations;
the three failed v2 response envelopes were discarded, so their exact cut and
partial correctness remain unknown.

The renderer owns source bytes for one run, validates their digest against each
crop request, and retains parsed PDF/page resources. It paints and PNG-encodes
each crop independently, including the existing determinism repeat. Initial
document loading remains inside the first crop's timer. Resource disposal is
explicit and separately observed after the run; it is not claimed as per-crop
work. No precomputed crop cache, warmup provider call, or selective retry exists.
Historical measurement/scoring code is preserved in place; the additive run
orchestrator changes only the request output allowance to the approved value.

The new source identities bind the client, renderer, additive benchmark runner,
and manual command. The contract digest records the new request behavior;
per-attempt diagnostics record SHA-256 of the exact serialized request body,
legacy source-region request digest, full provider envelope, model, stop reason,
usage, and build/SDK intervals. Failed/truncated envelopes are retained for
diagnosis while scoring still fails them. Artifacts use create-only writes under
`scripts/evaluation/artifacts/b461-sonnet-5-5-v3/local/` and every resulting file
is included in the artifact manifest.

Zero-call preparation:

```text
npm run eval:b461-sonnet-5-5-v3 -- --captures <pinned run> --corpus <external PDFs> --pins scripts/evaluation/docker/pinned-corpus.pins.json
```

Production database environment variables must be unset. Preparation omits
`--execute-provider`. The subsequent live run must cover the complete frozen
workflow class, use the existing call/spend ceilings, and receive independent
decision evaluation. No live run is authorized by an ordinary test/CI command.

This implementation does not change production imports or `FORGEWING_MODEL`.
It establishes no new qualification PASS. The complete Forgewing qualification
also requires Phase 17 labels authored/reviewed through its existing human-only
ground-truth procedure. Eight cross-row fragments currently require human truth
judgment. Their source-review workbook and provisional proposals remain local;
no committed null labels were rewritten.
