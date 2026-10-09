# Production re-analysis preparation, 2026-10-09

Read-only preflight against Supabase project `jpzeckefppmiujwajgvk`. No
re-analysis, stale-job update, environment change or manual deployment executed.
These are production identities, distinct from offline evaluation document IDs.
All three documents are live and decisioned in organization
`11111111-1111-1111-1111-111111111111`.

| Document | Document ID | Project ID | Source artifact ID | Latest extraction ID |
| --- | --- | --- | --- | --- |
| Golden | c8b779f2-0084-4f5e-b587-c96fe44c7bd9 | e61ccba8-993a-46a1-b99a-d2f4fd4a5dc8 | 110f82f5-c57c-4f9a-a6ce-ac8595db27ff | a92feea5-15e3-4bab-840b-804135e6886b |
| Hillsdale | f75b65b5-74f9-4f1e-a8af-4d0f36d81c4e | 8a0d8f18-c5cc-4c0a-b92d-e2e5c2577741 | 72ae30cd-90d0-48d6-921f-a8b6fe066448 | 260cfe57-7305-4848-b301-f21816a71282 |
| DN | 257883ae-9fbf-4920-8f15-8410c387ffa2 | 885bbb58-5e73-4414-96a7-d4d578257b62 | efbdb800-8573-4e5a-b883-7ac81f2358ef | f3f20a7b-66bf-4884-835c-30e769d9762a |

Latest extractions were created October 5 at 11:48:35.220833, 11:46:30.811397
and 11:52:14.919170 UTC respectively. Recursive parser-version inspection found
priced-schedule reconstruction v2 in each; current source emits v6. An initial
direct JSON-path query did not locate nested metadata and is not evidence of
missing versions. Active human_fact_assertions count is zero for each document;
this does not establish the absence of other confirmed recovery records.

Source hashes from extraction_source_artifacts match the pinned local PDFs:

| Document | Source SHA-256 |
| --- | --- |
| Golden | 922161a533bb6b8c1afb52cb9536044c8a6836bed62401634f4f505025631e8f |
| Hillsdale | 596adaccf865625723dc832f5206a8f690eb17d96921ef185df35b113c767537 |
| DN | 69247bff02744276b75f2cb0d4c00610e8614bd5822d2d10ae2ad35564c3b272 |

## Exact proposed action and approval boundary

After explicit production approval, use the existing authenticated
`POST /api/documents/process` route once per exact document ID above with body
`{"documentId":"<document ID>"}` and the authorized operator's bearer credential.
Do not use offline UUIDs or fabricate a recovery_reprocess purpose to suppress
providers: that purpose requires genuine confirmed recovery evidence.

Before approval/execution, refresh document/project/org membership, deletion and
processing status, latest extraction/source hash and any new assertions/recovery
confirmations. Verify deployed revision and runtime, supported duration budget,
and the applicable production provider policy without exposing credentials.
`EIGHTFORGE_INSTRUCTOR_ENABLED` defaults enabled when a key is configured; an
organization's deterministic analysis mode alone does not prove zero provider
calls. Production feature-flag values and the complete runtime fingerprint have
not been observed here. Include potential provider transmission/cost in the
concrete approval if enabled. Do not change production flags as preflight.

The action appends extraction/job history but also recomputes canonical facts,
document decisions/workflow and project validation. Preserve the previous
extraction IDs and capture authorized before/after canonical state and validation
IDs outside Git. Expected parser version is v6; DN p110 should create zero
priced-row cases. Source bindings and human authority must remain intact.
Compare changes directly; unexpected authoritative differences stop further
documents. Run serially and inspect the saved result before the next document.

Rollback is not deletion of the new extraction or merely re-pointing to an old
extraction. Those operations would not restore downstream canonical/decision/
validation state. If reconciliation fails, stop further processing and prepare
an approved compensating recomputation from the preserved source/state using
the established history paths. Code deployment rollback is a separate operation
and does not itself roll back persisted data. No automatic destructive rollback
or bulk update is authorized by this preparation.

## Deployment and duration observation

Vercel project `prj_AJR1wf21cEXYkYyBX0W6nFGgzDFk`, team
`team_pcUyrpKqevZ8CHuWoihcQnLb`, reports Node 24.x. The most recent READY
production deployment inspected was `dpl_2NNXXDs9hyi7b46AK3GBmf4boh8U`, revision
`9bccfd197051f188732d3cf0103b2b4745e7bfe7` (v6 implementation), URL
`eightforge-7fy7cfjag-ericanalysis-projects.vercel.app`. The later documentation
revision's canceled deployment is not the live application. Refresh before use.
No deployed browser verification was performed.

The available project/team metadata did not expose plan, Fluid Compute status
or effective function duration. No maxDuration was set: guessing a duration
could exceed the actual cap or shorten the current allowed execution budget.
Resolve these settings read-only, then apply a supported code configuration and
review normal CI/deployment effects before any production action.

## Stuck jobs

No queued jobs were observed. Three historical running jobs exist, unrelated to
the schedule IDs above:

| Job ID | Document ID | Started UTC | Observed document state |
| --- | --- | --- | --- |
| f5c0c348-14b1-4fae-97c7-c7ad399b4419 | 04e23a28-61a0-4abc-91ac-8c6f2db31ecf | May 26 14:23:29.124 | live, decisioned |
| b2827cd8-a940-4176-b3b5-c09ba0f2252d | 722d3aa7-9f42-42dc-9830-737ae73041a5 | August 11 19:41:58.352 | processing, deleted August 11 19:43:07.070 |
| 9293abe6-3063-4495-85ea-151708809c11 | c295be20-0a7c-4a98-92f6-783a1eb11c40 | August 11 19:52:22.239 | live, decisioned |

Each has attempt count one. Current job processing lacks atomic claim/lease and
heartbeat/expiry reconciliation. Fixing the missing caller authorization on the
existing analysis dispatch prevents its confirmed authenticated-processor 401
path; it does not prove the cause of these historical stuck jobs or settle them.
Prepare any individual terminal-state repair with history/evidence and explicit
approval. Do not bulk-clean jobs or overwrite current document state.
