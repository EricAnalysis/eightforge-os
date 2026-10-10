# Production Supabase recovery audit - 2026-10-10

Project: `jpzeckefppmiujwajgvk` (eightforge-os, us-west-2).

**Current acceptance: Golden production re-analysis VERIFIED.** The owner
confirmed acceptance after the stored post-checks and exact count/identity
classification, subject to the field-parity limit at the end of this audit.
Earlier stop states below describe the recovery chronology and are superseded.
Hillsdale is authorized for one normal Reprocess after fresh evidence capture
and preflight. DN remains paused until Hillsdale passes.

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

Golden is now VERIFIED on the owner's acceptance of this bounded proof.
Full live-case field parity and shadow publication success remain unproven.
No repair or reprocess followed classification; Hillsdale may proceed only
after fresh preflight and evidence capture. DN remains paused until its post-check passes.
