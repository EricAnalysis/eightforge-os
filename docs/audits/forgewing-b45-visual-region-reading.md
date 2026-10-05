# B4.5 Forgewing visual region reading

B4.5 gives the value-reading engine a real region renderer and a real Claude image provider. A reading is still an immutable, non-authoritative proposal. The only road to truth is still the B3 `human_fact_assertions` record path, where an operator cites the proposal and the database decides whether it was used unchanged or edited. Production activation stays `disabled`: the policy ceiling in `lib/server/forgewingGates.ts` is unchanged, and raising it is the B4.6 benchmark decision.

## Invariant

Once a page image is sent, the request digest binds the exact bytes sent:

```
render_digest  = SHA-256(rendered crop bytes)      computed by the engine, not the renderer
request_digest = H(binding, crop spec, render_digest, text excerpts, model, prompt id/version, output schema version)
```

Reuse, the durable budget reservation, the provider call and the stored proposal are all keyed by `request_digest`. A renderer, library, scale or geometry change produces different bytes, so it is a new request and never reuses an old answer.

## Pipeline

1. **Gates.** Activation, entitlement, data policy and budget configuration are checked before any source byte is read. A refused request renders nothing and records an outcome with no request digest.
2. **Crop spec.** The line's canonical boxes come from the persisted canonical-geometry sidecar, through the shared visual evidence. Every source observation must resolve to exactly one canonical box on the bound artifact and page representation; otherwise the region is not drawn.
3. **Verified source.** The stored file is loaded only if its SHA-256 equals the artifact ledger's `source_sha256`, within the same organization and document.
4. **Render.** pdf.js renders the page at scale 3; `canonical_v1` is the pdf.js viewport at scale 1, so no frame conversion is guessed. The padded union of the line's boxes is copied out pixel-exactly (no resampling) and PNG-encoded. Rendering is deterministic: same spec, same bytes. Empty, non-finite or oversized crops fail closed.
5. **Digest.** The engine hashes the bytes, builds the request, then checks reuse, reserves budget and calls the provider.
6. **Provider.** `lib/forgewing/runtime/valueReadingClient.ts` sends one base64 PNG plus a JSON text block. Text excerpts are included only when the engine requested and approved them; the Ask route still sends none. Settings: temperature 0, no SDK retries (one reservation is one call), exact pinned prompt, flat JSON output schema. The adapter refuses an image whose SHA-256 is not the request's `render_digest`.

Any failure in steps 2 to 4 is recorded as `evidence_binding_failed / region_image_unavailable` before any budget is reserved.

## Schema change

`20261005120000_forgewing_value_reading_unrendered_evidence.sql` widens one predicate of the value-reading outcome shape constraint. It lets `evidence_binding_failed` be recorded without a request digest, and only when the provider was not invoked, because no request exists until the region is rendered. Nothing else changes; existing rows already satisfy the stricter rule.

## Output contract

The output contract is now `value_reading_output_v2`, a single flat object with every field required. An unreadable reading carries `null` value fields. A root-level union is not a documented structured-output shape, so v1's discriminated union was replaced before any provider was ever wired; no v1 proposal exists anywhere.

## Boundaries

- The provider contract (`lib/valueReadingContract.ts`) has no imports and is the one module the Forgewing adapter may share with the engine. The adapter cannot reach the engine, persistence, gates or truth.
- The authenticated Ask route is the only place the provider and renderer are constructed, and the only named production consumer of the Forgewing adapter.
- The Phase 17 pinned request contract in `client.ts` is untouched.
- The v1 prompt bytes are pinned; editing the prompt requires a new template version.

## Not proved here (B4.6)

- **No live provider call was made.** Request validity is proven against the SDK's types, and behaviour against fixture providers.
- **Not yet measured:** accuracy, latency, cost, and whether the chosen scale reads real scanned schedules well enough. These are what the B4.6 benchmark must measure before any activation.
