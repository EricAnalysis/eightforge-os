# DN crop lifecycle audit, 2026-10-09

Read-only repository audit at main `35072862b3a7754c821bc97daaad4646e574a60f`. Reused the current Claude handoff, immutable DN live crop hashes and earlier inconclusive local WASM evidence. No labels inspected, no provider calls, no source/contract edits, no existing WASM probe repeated. Files written only to this local audit folder; PNGs stayed in memory. Source PDF is 3,895,497 bytes, SHA-256 `69247bff02744276b75f2cb0d4c00610e8614bd5822d2d10ae2ad35564c3b272`.

## Confirmed setup/lifecycle cause

`renderValueReadingCrop` opens a new pdf.js document from copied source bytes, obtains the requested page and destroys the document after each crop. Dynamic imports already reuse Node's module cache; the Claude SDK client is process-cached in `getClaudeClient`. Provider wrapper construction itself reads the small prompt file once. There is no evidence that replacing this existing SDK-client lifecycle is a useful latency optimization.

Repeated document destruction prevents reuse of the page's parsed operator list and decoded image objects. The current benchmark renders twice per row; both are fresh document instances. Production creates the renderer for one case per HTTP request and invokes it once, so a request-local reuse session alone cannot improve production's single-Ask latency.

## New local assertion: retain the exact document/page, not a PNG cache

The tiny lifecycle probe uses the same three immutable DN p107 row regions r-0007/r-0016/r-0018 twice. It uses production crop-spec and pixel helpers and the frozen loading/render parameters. No WASM/font/context/transform/scale/padding/encoding setting changes. Fresh and session modes each run in their own Node v24.13.1 process, pdfjs-dist 5.5.207. Fresh mode destroys the document after each render. Session mode retains one source-bound document/page across six renders and destroys it in finally. Each crop uses a new canvas and produces a new PNG; the second rendering is not a cached PNG masquerading as repeatability.

| Measurement | Fresh document per crop | One retained document/page |
|---|---:|---:|
| Six-render session wall ms | 5306.63 | 2293.23 |
| Mean total per crop ms | 882.99 | 379.89 |
| Mean load ms | 178.52 | 45.13 |
| Mean page render ms | 677.32 | 315.43 |
| First session crop ms | 948.96 | 1048.92 |
| Subsequent session crops ms | 670.02–1153.17 | 217.73–312.87 |
| PNG hashes equal immutable live crops | 6/6 | 6/6 |

This establishes a local lifecycle optimization candidate with byte identity for the sample. It does not establish full-corpus equivalence, independently repeated speedup, production latency, memory bounds or DN qualification. Host contention affects absolute timings. No broad repeat was run. `lifecycle-fresh.json` and `lifecycle-session.json` retain each raw stage interval. Total includes local spec/source-hash bookkeeping; imports and source file read are outside the timer. Session wall includes final destruction. The earlier WASM comparisons remain inconclusive and are not combined with this candidate.

## Smallest viable next implementation and dependency scope

An explicit bounded source-bound document/page session is the smallest measurable candidate. Its safe cache admission must occur **after every existing source/artifact/org/document verification**, including fresh storage SHA-256 verification; a cached page must never replace these checks. Key by organization, source document, source artifact, verified byte SHA-256, page representation, physical page and exact renderer parameters. Retain at most a reviewed small page/document count with a short lifetime and explicit close/eviction. In-flight users require a lease/serialization guard so eviction cannot destroy their document. Failed load/render entries must be evicted and destroyed; caller source bytes must remain intact. Return freshly rendered PNGs rather than sharing mutable output arrays.

For production benefit the bounded cache would need to live across admitted single-case requests in the same process. A benchmark-only or per-request cache would produce a warm measurement absent from today's production route. Do not claim production improvement from it. Cold/cache-hit/cache-miss and complete setup/destruction timing must be visible; first cold crop cannot be prewarmed out of measured qualification costs. Process restart and cache eviction remain legitimate misses.

Affected boundaries are renderer/source verification and lifecycle, production Ask wiring, benchmark renderer lifecycle plus recorded runtime/timing identity, renderer tests, value-reading engine/route tests and architecture consumers. The frozen contract pins renderer and benchmark source files. Any implementation requires explicitly versioned renderer/runtime registration before a paid retest; existing frozen evidence remains historical. No request bytes/model/prompt/schema/bar change is proposed. A separate source digest/runtime identity remains necessary even when sample PNG/request hashes agree.

## Proof plan

First make the lifecycle measurable through a narrow optional diagnostic observer without changing PNG/request bytes or decisions; record source verify/download, module setup, source copy/load, getPage, canvas setup, render, encode, destroy and cache state. Review the observer's allowed architecture consumers. Establish complete cold and warm wall time separately.

Then test bounds, key separation, source hash changes, revoked/missing access checks before hits, failed document promises, eviction while in-flight, close idempotency, fresh returned image buffers and unchanged input bytes. Byte-compare cache hits and misses against frozen renders for the affected bound crops, with sequential and concurrent calls and invalid page/spec cases. Reuse extraction and OCR proof because lifecycle does not parse/reconstruct source content; expand pixel-byte coverage only for this changed renderer dependency. Run affected authority/architecture tests, one appropriate final regression and TypeScript. Independently review the lifecycle/authority reconciliation, freeze new runtime/renderer registration, and only then perform an authorized final DN provider run. No paid run is part of this audit.

## Remaining instrumentation gaps

The live benchmark `renderMs` aggregates rendering and has no internal stage breakdown. `totalMs` is the registered first-render-plus-provider duration, not full benchmark wall: the second repeatability render and bookkeeping are outside it. Keep that historical definition explicit; do not silently rewrite saved values. The production route additionally includes queue resolution, policy/budget DB checks, artifact lookup/download/hash, proposal reuse and durable writes, none separately measured by the frozen benchmark.

Provider timing wraps a nonstreaming SDK request and aggregates request building/base64/hash, serialization, connection/transport, model service wait, response collection and SDK parsing. It cannot identify which remote stage caused the 2300.85ms median. Locally separate builder/client setup from the SDK await; exact first-byte/model/transport attribution would need response-header/fetch observer support or provider telemetry. Streaming would change the request shape and must not be introduced merely to improve or instrument this frozen request.
