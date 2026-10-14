# B4.6.1 Sonnet 5.5 transport observation v4

This additive manual qualification path diagnoses request tails without changing
the authoritative v3 task or promotion gates. It imports the exact frozen v3
request client, benchmark execution/scorer and renderer. The 500-token cap,
between_tools thinking, omitted temperature, 8000 ms deadline, zero retries,
corpus, labels, case order, scoring and all activation bars remain unchanged.

Use `npm run eval:b461-sonnet-5-5-v4 -- <the canonical v3 inputs>` for prepare,
then the same command with the existing explicit provider-execution/class flags.
The distinct default root is
`scripts/evaluation/artifacts/b461-sonnet-5-5-v4/local`.
CI invokes offline tests only. Production model configuration is never changed.

The runner adds `transport-events.json` and `transport-accounting.json` to its
ordinary immutable manifest. Each attempt is scoped with AsyncLocalStorage and
bound to the SHA-256 of the exact JSON request body; concurrent late cleanup
cannot be attributed to a later attempt. A transparent fetch wrapper forwards
the original input/options objects and returns the original Response without
cloning or consuming its body. It observes fetch start, response headers, abort,
fetch rejection and SDK settlement. Error observation preserves whitelisted
name/code/status identifiers, never error messages, URLs or request credentials.
Returned model envelopes are retained, including a late envelope if one exists.

After the frozen scorer has recorded its results, observation is drained for at
most 30 seconds before artifact persistence. This is an artifact-completeness
watchdog, not a request timeout or retry. A late answer cannot replace a timed-out
scoring record. Pending SDK work after the drain is explicitly reported as
pending, and absent usage/cost is null/unknown in supplementary accounting. The
historical scorer's zero fields remain unchanged and must not be interpreted as
proof that a timed-out attempt was unbilled.

Fetch-to-headers latency combines DNS/TCP/TLS, upload, network transit, provider
queueing and computation. It is not provider-only time or a recovered historic
TTFB. Header arrival followed by delayed SDK settlement can identify a body-read
tail; it does not independently separate decoding from body transport. This path
does not promise a latency improvement. Historical v1/v2/v3 sources, pins and
failed evidence are never edited or merged into v4 artifact roots.
