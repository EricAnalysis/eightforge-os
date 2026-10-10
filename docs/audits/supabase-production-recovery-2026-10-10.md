# Production Supabase recovery audit - 2026-10-10

Project: `jpzeckefppmiujwajgvk` (eightforge-os, us-west-2).

**Current owner acceptance: Golden, Hillsdale and DN production re-analysis
VERIFIED. The sequential production refresh is complete.** Acceptance proves
the bounded production re-analysis predictions and stored post-state, not
exhaustive field/action/history parity. Earlier stop states below describe the
recovery chronology and are superseded. The newly exposed conflicting active
fact defect is recorded separately and does not invalidate DN acceptance.

## Confirmed symptoms

The owner independently reproduced `SELECT 1` failing in SQL Editor with
`Connection terminated due to connection timeout`. The connector also failed.
The browser project overview reported Unhealthy, with Database, PostgREST,
Auth and Storage unhealthy; the metadata endpoint continued to report
ACTIVE_HEALTHY. Its coarse status therefore did not establish service health.
Management requests to `/rest-admin/v1/ready` and
`/admin/v1/network-bans/retrieve` returned HTTP 522. Detailed current metrics
and session reports failed to load. The low percentages in the 24-hour overview
do not establish current resource health; resource exhaustion is not proven.
Supabase AI also failed to respond. No causal link to the migration or Golden
retry is established by these symptoms.

## Explicitly approved recovery requests

1. The owner approved one Fast database reboot. Its database-only confirmation
   was submitted once at approximately 17:22:40 UTC (1:22:40 PM Eastern). The
   UI showed Restarting and returned to overview. Read probes at 17:24:22 and
   17:27:55 UTC still failed. No second fast reboot was requested.
2. After inspecting the separate confirmation and its downtime warning, the
   owner approved one full project restart. Its confirmation was submitted once
   at approximately 17:35:00 UTC (1:35 PM Eastern). The UI showed Restarting,
   then a project-offline restart page. The overview subsequently showed Healthy.
   A read-only SQL probe succeeded at 17:40:20.484922 UTC. Subsequent bounded
   Golden reads succeeded, but a full-snapshot read later failed with
   `Transport closed`. No further restart or production invocation followed.

No resize, restore, migration retry, schema/data repair, Golden rerun,
Hillsdale/DN invocation or paid qualification run accompanied these requests.

## Acceptance boundary

Terminology: full payload "snapshots" in this audit are
`document_extractions` rows where `field_key IS NULL`, not the separate shadow
snapshot tables. The historical migration preflight counted 114 such payload
rows across production; Golden now has four. A later bounded read confirms
three open decisions and two open workflow_tasks. Claude's one open task
referred to execution_items, a different store used by the queue.
The previous 69-case inventory was captured as aggregate/UI evidence, not as a
complete saved case-ID list. Exact old/new reconciliation remains necessary.

Golden pipeline execution passed according to runtime logs. Recovered reads
confirmed exactly one new completed job and one new full extraction snapshot,
26 unique normalized field facts, unchanged source pin and prior job/snapshot
metadata, and an unchanged prior latest-snapshot data fingerprint. All human
assertion/review tables remain empty; this proves no record loss, not a
nonvacuous reviewed-value replay. Findings and validation runs are unchanged.

The runtime identity records production revision `90e79dc8d397d945f01dc9a323ac9c849f1e5e40`.
Its digest recomputed using the repository's `hashCanonical` is
`cbdbe0a81231cb3b851c85e486ac0e501a73d8ea923a7f93554031640d2e59f8`.
All 15 physical pages bind to the expected document and source artifact.
The final intelligence trace says canonical persistence true, and its
25-row inspection assembly equals the assembly stored in the extraction.
The extractor metadata's initial false placeholder is distinct from that
final normalized trace. Document processing status remains decisioned.

Normal reconciliation removed three machine-owned missing-evidence decisions
and tasks, and created two current review decisions/tasks (term confirmation
and pricing applicability). The existing validator approval decision remains.
The Resolution Workspace now shows 76 cases (74 document, two project), versus
69 previously (66 document, three project). Its breakdown is 29 withheld,
28 rates to confirm, 12 unread, six validator and one structure case. The exact
case identity delta was subsequently classified as described below; full
live-case field parity remains unproven.

The full-snapshot read needed to finish that check failed with Transport closed.
Per the owner's connector-uncertainty stop rule, Golden was NOT FULLY
ACCEPTED at that time and Hillsdale/DN were paused. No mismatch repair is authorized by
this audit. The two shadow timeouts remain documented; successful shadow
publication is not proven by canonical trace persistence.

On recovery, compare job `87119ccb-acff-4a22-b287-bc5522bab766` and extraction
`e0feefb8-4787-469f-9e6f-6b2a03331f65` with the saved immediate pre-state.
Verify exact ownership/source/runtime, terminal state, intended persistence
chain, retained reviews/assertions and explainable queue/case deltas. Stop and
classify unexpected differences; do not repair or rerun automatically.

External evidence root:
`C:/Users/ADMS Thompson/.codex/tmp/production-continuation-20261010`.
It contains recovery proposal/request records, failed probes and screenshots.
An unsent support draft is available there. Client material remains outside Git.

## Gate 7 inventory comparison and residual classification

The latest usable pre-state payload is `a92feea5-15e3-4bab-840b-804135e6886b`;
the failed-run `19e5c631` did not replace it in the preferred-content selector.
Bounded SQL reads exported the pre/post JSON wrappers outside Git. Their
UTF-8 SHA-256 and byte lengths equal the database-computed values:

| Extraction | Export bytes | SHA-256 |
| --- | ---: | --- |
| `a92feea5-15e3-4bab-840b-804135e6886b` | 3,584,669 | `c491922bdad2f704fda861976a5ce14ebcce88815d2132f092b6fb76b73b40c8` |
| `e0feefb8-4787-469f-9e6f-6b2a03331f65` | 3,725,687 | `5be0769bf563edeaf429d64b68a6699d2d2d61222ff0efab18c468ce7bc9b375` |

The existing `buildResolutionEvidenceInventory.ts` ran on stored payloads
with forbidden database/provider credentials removed from its child process.
Both runs passed; no source extraction, OCR or provider call occurred.
It produced 62 pre and 70 post cases, with no unclassified kinds or identity
overlaps. Stable identity/kind comparison found 47 additions and 39 removals,
all on pages 8-10. The exact diff is external
`golden-case-inventory-diff.json`, SHA-256
`c085d5af3a96f3656a0fbdc2629411921554d4f5ff768fc46189601be24e5ef5`.

The prescribed residual check failed: 69-62=7 while 76-70=6. Execution stopped
and the difference was classified. `resolveProjectIssueObjects` synthesizes
finding cases for standalone open deterministic decisions even without
persisted finding IDs. Using the saved findings/decisions with the repository
functions yields four unchanged persisted-finding identities on each side,
plus three old decision cases and two new decision cases:

| Change | Residual case identity | Meaning |
| --- | --- | --- |
| Removed | `finding:decision:4f06817a-4099-46b0-8d49-62a784b5e48d` | Contract ceiling not established |
| Removed | `finding:decision:6a473f24-f2b8-4fae-ac86-a79567e071e5` | Missing contractor evidence |
| Removed | `finding:decision:92211b18-2720-4c6f-a810-8e37258cdea9` | Missing rate schedule evidence |
| Added | `finding:decision:09e67df4-48e6-468c-b5da-353bc0c85680` | Contract term requires confirmation |
| Added | `finding:decision:9321b1eb-ae90-4b94-9483-26588895d2d3` | Pricing applicability unresolved |

These exact identities come from external `golden-residual-classification.json`.
There is no uniquely identified single dropped decision: three disappeared
and two appeared, for a net decrease of one. Totals reconcile as
62+4+3=69 and 70+4+2=76; +8 extraction cases minus one decision case = +7.

## Activity-log corroboration

A bounded read of `public.activity_events` for the Golden organization/project
between 15:59 and 16:36 UTC returned two document `updated` events with action
`pipeline_processing_canonical_intelligence`:

- `9105089e-4d96-49a3-bea1-4815f03103e7`, 15:59:37.125493 UTC:
  decisions_created=3, tasks_created=3, decisions_updated=0,
  tasks_updated=0, decisions_preserved=0, tasks_preserved=0.
- `14fcd91a-303d-4656-ab6d-93ab2c6084fc`, 16:34:29.194859 UTC:
  decisions_created=2, tasks_created=2, decisions_updated=0,
  tasks_updated=0, decisions_preserved=0, tasks_preserved=0.

Both events have changed_by null and validation_refresh_requested true.
That flag is a request, not proof of a completed validator refresh; saved
findings and validation runs remain unchanged. The events corroborate the
machine creation counts. They do not contain deleted decision IDs or deletion
counts; removed identities are proved by saved pre/post records instead.
Exact activity rows are external `golden-activity-evidence.json`, SHA-256
`b2921edfd26d046acefaf0b6a7dcb0fe131de32a6fa8063ad0c37e90b8d29421`.

## Field-parity limit and current gate

The inventory uses the offline organization ID, Forgewing off and no page
frames. The residual classification uses saved findings/decisions but empty
evidence/execution inputs. These runs prove the count/identity explanation,
not equality of all live case fields, evidence visuals, actions, investigation
state, or historical execution context. No complete historical live-case list
was captured. Do not describe the result as full live-queue object parity.

Golden, Hillsdale and DN are now VERIFIED on the owner's acceptance of their
bounded production predictions and stored post-state proof. Full live-case
field/action/history parity and shadow publication success remain unproven.
No further production re-analysis or migration retry follows this acceptance.

## Accepted Hillsdale continuation

Job `62ee75c2-ab01-45b4-aac5-3cdf617fb486` completed attempt 1 on production
revision `90e79dc`, creating extraction `2ad3bb02-66d0-4375-b1d6-280ee563ea07`.
Stored checks captured one intended job/extraction chain, unchanged source and
human-review tables, preserved decisions, and return to Decisioned.
Offline inventories explain extraction cases 19-to-66 and live queue 22-to-69:
51 added, four removed and 15 retained identities, all delta cases on pages
2-3. Both live residuals are three non-extraction cases. The owner accepted
Hillsdale VERIFIED with the limitation above.

Checksummed payload exports (JSON wrapper UTF-8 bytes, not PDF hashes):

- Pre `260cfe57`: 1,485,218 bytes, SHA-256
  `69bc1aa75f8383d60e1eb4962cdfe5c2e80595f5bc99904324f8c6de32db1126`.
- Post `2ad3bb02`: 1,443,556 bytes, SHA-256
  `eabcbdc470a4e2b0309bde9a7937be8375a39636769de9188075c6b953ac9e46`.

## Accepted DN continuation

Job `ef1e226a-ad2b-44ea-b08e-11cc1b25edcd` completed attempt 1 in 167.674 s,
from 22:05:15.438 to 22:08:03.112 UTC, below the 300 s limit. A status read
timed out, then the next bounded read confirmed completion; there was one
Reprocess click and no reset/retry. New full extraction
`7fd81454-03b8-4e0a-8d16-d69b78ec1e26` has reconstruction v6 and runtime
revision `90e79dc8d397d945f01dc9a323ac9c849f1e5e40`.
Its registered native/canvas fingerprint is
`8af96229a864c193df54f9c3eefb489ce8fab0867dfab9ed8c694b53034cfb60`;
runtime identity digest is
`cbdbe0a81231cb3b851c85e486ac0e501a73d8ea923a7f93554031640d2e59f8`.
Source hash is unchanged, the document is Decisioned, and stored checks show
one new job and one full extraction with no duplicate job/extraction.

DN p110 false priced-line cases fell 18-to-0. Extraction cases fell 47-to-29;
total live queue fell 48-to-30. Exact inventory diff: zero added, 18 removed
(all unread priced-line cases on p110), 29 retained identities, zero overlaps
and zero unclassified kinds. Preserved cases are p107's 20 scanned-rate
reviews and two withheld bundles, p106's six category reviews, and p124's one
coverage gap. The standalone decision case remains. The owner accepted DN
VERIFIED with the same bounded proof and field-parity limitation.

Checksummed payload exports:

- Pre `f3f20a7b`: 5,767,047 bytes, SHA-256
  `611b647e65901a1a67ec78f79d9a9a5be48195855f809c5b3a73dc10517ae0bd`.
- Post `7fd81454`: 5,652,731 bytes, SHA-256
  `f0457885186e9bf340644f487b91c290595b7bd9f3746cb7e15f60a75d57b3e5`.

External evidence root:
`C:/Users/ADMS Thompson/.codex/tmp/production-continuation-20261010`.
Full decisions, payloads, inventories/diffs, stored snapshots and screenshots
remain outside Git. Historical completion reports retain their then-pending
acceptance statuses; the owner acceptance above supersedes those statuses.
PR #202 merged manually after both full Vitest checks passed (1m58s and
3m6s), producing main `9b12cc59b8580846154b877a981d6ac7f582fc09`.
Its docs-only production build was canceled; production remained on `90e79dc`.

## Separate conflicting active extraction facts: Phase A

Phase A confirmed the defect independently of DN acceptance. Normalization emits
heuristic and evidence-v1 observations separately. Persistence supersedes the
previous document batch, then inserts all new observations; no within-batch
uniqueness exists. Field rows carry no extraction-run foreign key, so the
existing boundary is document plus canonical fact key. Active reads have no
ordering: rules previously overwrote the key (last row wins), while Validator
priority ties and Ask ranking could select the first returned observation.
The override audit snapshot also selected one same-timestamp row arbitrarily.

The scoped implementation on `codex/active-extraction-fact-conflicts` withholds
conflicting scalar active observations, emits a typed `extraction_conflict` read diagnostic, preserves all source observations/evidence, blocks machine
fallbacks and permits only existing non-null accepted human channels to resolve
it. Derived/rule inputs, Validator, Ask, ceiling-type hints and override audit
context are guarded. No date winner, persistence rewrite, migration, source
preference, confidence preference or parallel review channel is introduced.
Focused conflict/Ask tests and dependent regression pass; TypeScript passes. Merge is BLOCKED by the
existing Ask diagnostic lock: its current harness runs 60 queries, returning
42 passing / 18 failing / 28 upstream gaps, whereas CI requires 22 and zero
gaps. The harness process passing is not gate acceptance. Unchanged main
produces the same 60/42/18/28 result; all query answers, evidence counts and
pass flags match. Raw artifact parity is NO because generated timestamps
differ. The safe-fact ranking regression was corrected and tested. Do not
weaken the lock. External evidence: ask-gate-baseline-comparison.json.

Production dependency evidence: zero DN findings, no stored rule condition
references expiration_date, and retained decision
`f96cb3ae-fc14-470b-bbae-f6c2cc7d73f3` references pricing applicability only.
Both conflicting observations remain stored. Full audit evidence is external
`active-fact-conflict-production-audit.json`. The absent public.document_facts
relation is not an alternate production consumer.

Scope limit: document UI independently re-normalizes the preferred extraction
blob, and canonical contract analysis already contains Jan 29, 2022. The
active-row consumer fix does not rewrite that blob or claim to resolve which
date is correct. DN browser showed the contract period Resolved and expiration
Requires Review; retain this as separately exposed blob/UI debt.

Browser E completed read-only on production `90e79dc`: open queues Golden 76,
Hillsdale 69, DN 30; document filters 74/66/29 plus project cases 2/3/1;
category selectors opened/escaped and + markers 4/40/6; Golden p10/Hillsdale p2
source overlays rendered. DN p124 explains OCR without usable evidence and
has no truth-save control; p110 has no priced-line case. No expired job exists,
so the existing 15-minute expiry tests are reused, not claimed as browser proof.
Document-detail preview was unavailable although workspace overlays rendered.
No reviewed truth, outcome, provider call or Reprocess was mutated. Full
browser evidence is external `browser-e-report.json` and browser-e captures.

Qualification remains disk-blocked: preserve DN p107 20/20 correctness and
3,196 ms latency FAIL against 3,000 ms. No retest, paid call, taxonomy/exclusion
change. Existing production/OCR/Docker/runtime proofs remain reusable.

PR #203 merged manually after both full Vitest checks passed (1m53s and
2m35s), at main 3d9fc1c6d2e00533df687570c245daf0fbbb3de8. The code fix
remains separate and must not merge while its Ask lock fails. No production
field rewrite or re-analysis occurred.

Conflict implementation is committed/pushed through 6b2443b in draft PR #205
(https://github.com/EricAnalysis/eightforge-os/pull/205). The Ask CI job failed because its Supabase credentials are not configured;
the separate known 22-query zero-gap lock also remains unsatisfied. Full unit
CI outcomes must be read before any future merge. Do not place a production
service-role credential in GitHub without separate authorization. No new
production defect repair or arbitrary date publication is claimed.

The initial full unit lane caught imports crossing the sealed canonical tree.
Correction 6b2443b keeps the read diagnostic in the legacy fact layer; it adds
no canonical publication or review authority and does not relax the import
guard. Architecture/conflict/Ask/Validator targeted slice: 110/110 pass;
TypeScript passes. Existing dependent regression: 55/55 pass. Both full unit CI lanes pass on 6b2443b (3m3s and 3m6s). The Ask CI job
still fails for missing credentials; the local 22/zero-gap lock remains unmet.
PR #205 stays draft/unmerged. No gate is weakened.
