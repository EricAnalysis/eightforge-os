# EightForge — Product & Engineering Alignment

**Status:** Authoritative. Governs product, planning, implementation and code-review decisions.
**Revision:** 2026-07-19
**Peer documents:** `CLAUDE.md` (operating mode), `AGENTS.md` (reviewer map).
**Evidence basis:** `docs/audits/backlog-closeout-and-schema-drift-2026-07-19.md` and the direct
repository/live-schema inspection recorded in §3 of this document.

Where this document conflicts with an older audit, plan, or roadmap, this document wins.
Where a proposed change conflicts with this document, surface the conflict before implementing.

---

## 1. Product definition

EightForge is an **evidence-first decision infrastructure platform**.

It converts complex governing documents and transaction records into canonical facts, evaluates
those facts through deterministic validation, produces evidence-backed findings, supports
controlled human correction and decisions, and preserves the complete reasoning and execution
trail for audit.

EightForge is **not** primarily:

- an AI chatbot
- a generic workflow platform
- a portfolio dashboard
- an agent marketplace
- a task-management system
- a collection of loosely connected document-intelligence features

**The near-term product is the project-level review workflow.** Everything else is either
supporting architecture or deferred surface.

---

## 2. Canonical system flow

```
Source Documents
  → Extracted Facts
  → Canonical Truth Reconciliation
  → Deterministic Validation
  → Evidence-Backed Findings
  → Human Correction or Decision
  → Execution
  → Immutable Audit
```

AI may interpret, classify, summarize and explain.
**AI is not the source of truth.**

The system owns truth, validation, evidence, provenance, decision state and auditability.

Correct model:

> Evidence exists → rules evaluate it → AI explains it

Prohibited model:

> AI reaches a conclusion → evidence is gathered afterward to support it

### 2.1 Terminology

**EightForge** is the overall decision infrastructure platform.

**The Reason Engine** is an internal capability that reconciles facts, evaluates relationships and
helps explain why a finding exists. It is not a standalone product and must not become a
justification for adding agents or conversational AI surfaces.

**The Decision Journey** is the canonical trace answering: *how did the system and reviewer arrive
at this decision?* It may connect governing contract → amendment or rate schedule → invoice →
transaction/ticket row → extracted fact → canonical fact → evidence location → validation rule →
finding → reviewer correction → reviewer decision → execution item → audit event.

One trace serves Validator, evidence inspection, Audit, reporting, debugging and any future
portfolio capability. It must not be forked per surface.

---

## 3. Verified repository state (2026-07-19)

This section exists because prior planning treated *intended* architecture as *shipped*
architecture. The following was confirmed by direct inspection, not recall. Re-verify before
relying on it after significant merges.

### 3.1 The shipped navigation is not the intended product

`components/platform/shell.tsx`:

| Nav location | Items |
|---|---|
| Top nav | Portfolio, Command Center, Projects, Intelligence |
| Side nav | Command Center, Portfolio, **Decision Queue**, Intelligence, Documents |
| Action icons | Signals (`/platform/issues`), Audit history (`/platform/agents`), Settings |

Portfolio is first in both navs. **Validator appears nowhere in global navigation** — it is a
render-prop passed into `ProjectOverview` from `app/platform/projects/[id]/page.tsx`, reachable
only after opening an individual project.

Two competing products currently coexist:

1. **Global platform:** Portfolio, Command Center, Decision Queue, Intelligence, Documents, Ask.
2. **Project workspace:** Overview, Documents, Validator, Audit.

Users encounter the first. The second is the one expected to generate revenue.

Claims in earlier reviews that standalone Decisions/Facts surfaces were "already removed" or should
be "kept deleted" were **incorrect**. `app/platform/decisions/page.tsx` is live at 1,405 lines. A
second decisions route exists at `app/projects/[projectId]/decisions/page.tsx`.

Correctly retired: `app/platform/dashboard/page.tsx` and `app/platform/workspace/page.tsx` are
5-line redirect stubs. This is the pattern to follow.

### 3.2 Route inventory vs. live row counts

25 page routes, 56 API routes, 46 public tables — 24 of them with zero rows.

| Route | LOC | Backing table rows |
|---|---:|---:|
| `platform/decisions` (+`[id]`) | 1,405 | `decisions` 53 |
| `platform/workflows` (+`[id]`) | 495 | `workflows` 0, `workflow_rules` 0, `workflow_events` 0 |
| `platform/issues` | 397 | `issues` 0 |
| `platform/reviews` (nav: "Intelligence") | 184 | `reviews` 0 |
| `platform/portfolio` | 156 | — (aggregate) |
| `platform/rules` (+ new, edit) | — | `rules` 0, `decision_rules` 0, `decision_policies` 0 |
| `projects/[projectId]/decisions` | 152 | duplicate of above |

A top-nav item ("Intelligence") points at a zero-row table. Surfaces built primarily on zero-row
concepts are the lowest-risk deletions in the codebase.

Also zero-row and worth investigating rather than assuming: `transaction_data_summaries` (0 while
`transaction_data_rows` holds 9,983), `decision_assertions` (0), `invoice_approval_snapshots` (0
while `project_approval_snapshots` holds 104).

### 3.3 Fact correction exists only on the route slated for removal

`document_fact_overrides` reference counts:

| Location | Refs |
|---|---:|
| `app/api/documents/[id]/route.ts` | 18 |
| `app/platform/documents/[id]/page.tsx` | 14 |
| `app/api/documents/[id]/facts/override/route.ts` | 13 |
| `components/document-intelligence/FactEvidencePanel.tsx` | 8 |
| `components/document-intelligence/DocumentIntelligenceWorkspace.tsx` | 6 |
| `components/document-intelligence/DocumentDetailExperience.tsx` | 5 |
| `components/projects/ProjectDocumentsForge.tsx` | **0** |

There are two parallel document-detail implementations. The project workspace
(`ProjectDocumentsForge`, 915 lines) imports `DocumentSourceViewer` — **read-only**.
`FactEvidencePanel` — the correction interface — is reached only through `DocumentDetailExperience`
on `/platform/documents/[id]`.

**Removing the global Documents entry point without porting correction first would leave the
project workspace read-only for canonical facts.** A redirect is not parity: `/platform/documents/[id]`
is a detail route with no project-workspace equivalent.

### 3.4 Module size does not equal refactor priority

| File | Lines |
|---|---:|
| `lib/documentIntelligence.ts` | 6,825 |
| `lib/documentIntelligenceViewModel.ts` | 6,169 |
| `lib/documentIntelligenceViewModel.test.ts` | 5,896 |
| `lib/pipeline/nodes/normalizeNode.ts` | 4,892 |
| `lib/projectFacts.ts` | 4,781 |
| `lib/projectOverview.ts` | 3,331 |
| `lib/validator/projectValidator.ts` | 2,611 |
| `lib/server/operationalQueue.ts` | 2,036 |
| `components/projects/ProjectOverview.tsx` | 1,811 |
| `app/platform/documents/page.tsx` | 1,803 |
| `app/platform/documents/[id]/page.tsx` | 1,800 |
| `components/projects/ValidatorTab.tsx` | 1,097 |

`projectFacts.ts` is third, not first. Earlier guidance to split it first was misdirected.
Refactor priority follows **defects, coupling and testability** — not line count.

### 3.5 First paint is gated on everything

`app/platform/projects/[id]/page.tsx` calls `useProjectWorkspaceData(id)` once and blocks the
entire render on it: project, documents, documentReviews, decisions, tasks, activityEvents,
members, validationFindings, validationEvidence, executionItems, transactionDatasets,
transactionSummary, documentRelationships. `activity_events` alone holds 2,351 rows, and the hook
paginates full transaction rows in batches of 1,000.

Too much data is classified as required for first paint. This is the structural cause of perceived
slowness, and the deferred `useProjectWorkspaceData` load-tier split is its actual fix.

### 3.6 Schema ledger

The live ledger reports 45 applied entries against 63 repo migration files, using re-timestamped
versions that do not correspond to repo filenames. Per audit §1.1, **drift must be established by
comparing schema state, not by diffing migration lists.** Six migrations exist solely to reconcile
repo against live, three of them dated 07-18/07-19.

Confirmed stale flag to close: `decision_detections` **exists** with 3 rows. The
`portfolioCommandCenter.ts` "missing table" note is out of date.

---

## 4. Product surfaces for the next 90 days

```
Projects
  → Overview
  → Documents
  → Validator
  → Audit
```

Nothing else competes for attention. Validator is the primary value surface.

Intended Validator workflow:

> Finding → inspect evidence and canonical truth → correct an extracted fact when necessary →
> accept, reject, resolve or otherwise decide → preserve decision and provenance → audit

**Do not remove a working capability merely because it currently lives in a route being retired.**
Fact correction is core. Before removing or redirecting the global document-detail route, either
(1) port the correction experience into project Documents or Validator, or (2) retain the
document-detail route as an unlisted deep-link target until the port is complete.

The Decision Queue *concept* is sound; its **global standalone implementation** is wrong for this
phase. Review decisions belong inside Project → Validator → Finding → Evidence → Decision.

---

## 5. Execution order

The corrected order — deviations require explicit justification:

> schema-parity protection and document-detail audit
> → navigation consolidation **plus correction-UX preservation**
> → tiered workspace loading
> → test-driven extraction hardening
> → paid pilot readiness

### Phase A — correctness and route audit

Complete **before** destructive navigation changes or extraction refactors.

1. Implement schema-parity CI.
2. Compare the two document-detail implementations.
3. Trace the complete fact-override read/write flow.
4. Identify every entry point into `FactEvidencePanel`.
5. Produce a concrete port or preservation plan.
6. Confirm regression coverage around canonical facts, overrides, evidence and audit.
7. Identify hidden surfaces that still compile against or depend on changing extraction modules.

Schema-parity CI must detect unexplained divergence in tables, columns, types, nullability,
defaults, indexes, foreign keys, unique constraints, relevant database functions/RPCs, and
committed migration state. Because the ledger is re-timestamped, the check must introspect
`information_schema` / `pg_indexes` / `pg_constraint` into a committed snapshot — not diff
migration filenames.

Changes are allowed only through a committed migration, an intentionally updated snapshot, or a
documented exception.

Add a clean-environment deployment test: database setup → migrations → minimal Golden fixture seed
→ build → targeted smoke test.

**Schema protection must be in place before large extraction refactors.** Drift makes the same
branch behave differently across environments, which destroys the ability to verify a refactor or
run a reliable pilot.

### Phase B — shipped-product consolidation

Rebuild the visible product around Projects and the four project surfaces. Make
`/platform/projects` the default authenticated landing page.

Remove from primary navigation: Command Center, Portfolio, global Decision Queue, Intelligence,
global Documents, Signals/issues, Agents, Rules, Workflows, broad persistent Ask.

Sequence: remove entry points, route access and runtime reads first. Delete confirmed orphaned code
after regression testing. Preserve old links only through explicit redirect stubs **with expiration
dates**.

**Hidden is not free.** For each retained surface, classify as:

- delete now
- redirect stub
- retained deep-link dependency
- intentionally deferred but still coupled

and document its ongoing compilation, test and coupling cost. Concretely: a hidden Portfolio still
means `lib/server/operationalQueue.ts` (2,036 lines) and `portfolioCommandCenter.ts` remain in
`tsc --noEmit`, remain in the 151-file suite, and still break when extraction module boundaries
move. Audit §5.3 already documents nine consumer requirements the canonical issue model does not
represent; that coupling does not disappear when the nav item does.

### Phase C — tiered loading and perceived speed

Split `useProjectWorkspaceData` into tiers.

**Tier 1 — first meaningful paint:** project identity, processing status, document counts,
canonical summary, validation counts, critical/open finding summary.

**Tier 2 — active surface:** Documents → documents and relationships; Validator → findings,
evidence, issue objects; Audit → audit and decision records.

**Tier 3 — on demand:** raw transaction rows, full activity history, evidence geometry, document
page imagery, resolved historical findings, secondary operational records.

**Do not load full transaction rows to compute summaries already available in `transactionSummary`.**

Track application responsiveness separately from extraction duration:

| Measure | Target |
|---|---|
| Project shell visible | < 2 s |
| Meaningful Overview content | < 3 s |
| Processed Validator opens | < 2 s |
| Finding selection | < 500 ms (excl. first document retrieval) |

A long extraction job may run asynchronously with visible status. It must never block the
application shell. The earlier "upload to completed Validator in under 30 seconds" target conflated
application responsiveness with extraction duration and is retired. A 90-second background
extraction is acceptable; a 10-second blank screen is not.

### Phase D — extraction hardening

**Do not begin with broad cosmetic file splitting.** First establish regression tests around actual
customer-visible failures:

- governing document selected incorrectly
- amendment or rate schedule precedence resolved incorrectly
- split or mixed rows lost
- invoice total changed during extraction
- description or rate code normalized incorrectly
- source evidence unavailable
- unsupported rate reported as supported
- valid rate reported as unmatched
- correction override not reflected in canonical truth
- provenance lost during normalization

Then refactor only around the boundaries those tests expose. Investigation priority:
`lib/documentIntelligence.ts`, `lib/documentIntelligenceViewModel.ts`,
`lib/pipeline/nodes/normalizeNode.ts`. Do not prioritize `projectFacts.ts` on size alone.

Candidate boundaries, to be confirmed by defects rather than assumed:

```
document-intelligence/          pipeline/normalize/
  document-classification.ts      descriptions.ts
  authority-resolution.ts         quantities.ts
  rate-schedule-extraction.ts     money.ts
  invoice-extraction.ts           rate-codes.ts
  table-geometry.ts               taxonomy.ts
  evidence-provenance.ts          split-rows.ts
  confidence.ts                   deduplication.ts
  types.ts                        provenance.ts
```

Every extraction refactor must preserve Golden Project outputs (Williamson County: CYD **74,617**
ticket-grain, Extended Cost **$815,559.35**) and Decision Journey integrity.

### Phase E — pilots and revenue

Freeze broad product expansion once the core workflow is stable enough for real projects. The first
commercial offer is a **managed project review**, not self-service SaaS.

Offer shape: EightForge reviews a defined contract-and-invoice package, identifies unsupported or
conflicting billing, links every finding to source evidence, and delivers an auditable review
workspace. Scope: one organization, one project or invoice package, defined document volume and
turnaround, reviewer workspace, findings and evidence, audit/export package, onboarding assistance.

Pricing is an **untested hypothesis**, not a finding: roughly $1,500–$3,000 for a tightly scoped
project review and $3,000–$7,500 for a larger pilot, with pilot cost creditable toward an annual
agreement on conversion. Below roughly $1,500, manual onboarding, extraction troubleshooting and
support are likely to consume the value of the engagement. Treat the first three pilots as price
discovery.

Likely buyers, ordered by reachability: debris-monitoring firms, disaster-recovery consultants,
public-assistance consultants, contractors auditing subcontractor billing, local governments with
active recovery invoices, engineering firms managing reimbursable work. Selling directly to FEMA is
a long first path.

**Required before commercial outreach — legal review, not an engineering task.** The likely buyer
list overlaps the founder's employer and its competitors. Obtain external legal review of the
employment agreement, IP assignment, work created using employer time/devices/accounts/data,
confidentiality obligations, competition and non-solicitation restrictions, and any use of
employer-derived documents or workflows. **No AI agent, reviewer or collaborator on this project
should provide legal conclusions on these questions.** This review must complete before the first
paid engagement; it is materially more expensive to resolve after a pilot exists.

---

## 6. Effort allocation — next 100 engineering hours

| Work | Hours |
|---|---:|
| Schema-parity CI | 10 |
| Navigation and route consolidation | 12 |
| Correction-UX port / preservation (Phase A items 2–5) | included in the two rows above |
| Remove or redirect dead global surfaces | 8 |
| Workspace load-tier architecture | 28 |
| Performance measurement and query reduction | 12 |
| Extraction/normalization module boundaries | 20 |
| High-value extraction regressions | 8 |
| Repository cleanup | 2 |

This funds Phases A–C and the beginning of D. It does **not** fund the full 90-day plan; the
remainder is a second and third allocation.

**The binding constraint is operator review bandwidth, not agent hours.** Agent sessions cap at
five hours and work is directed rather than hand-written, so throughput is limited by how much can
be verified per week. Decide the weekly verification budget before Phase A begins. Under load, the
first thing to slip is verification — and verification discipline is the reason the 07-19 audit is
trustworthy.

Repository cleanup targets (confirm gitignore status before deleting): `response.json`,
`response2.json`, `geometry_fix_diff.txt`, `baseline-failures.txt`, `current-failures.txt`,
`failure-set-diff.txt`, `eng.traineddata`, `EightForge.lnk`, `tsconfig.tsbuildinfo`, and the empty
nested `eightforge-os/` directory.

---

## 7. Preserve, hide, delete

### Preserve permanently

Canonical fact model · evidence model and provenance · issue lifecycle · controlled execution write
boundary · immutable audit · document relationships · extraction pipeline · deterministic rules ·
organization-level data isolation · project-level decision state · reusable Decision Journey ·
Golden Project regression tests · Supabase schema controls.

### Hide for at least 90 days

Portfolio · Ask · broad Command Center · cross-project intelligence · organization-wide queues.

These may return later as **projections of stable project-level truth**. They must never become
parallel sources of truth. Each carries a documented coupling cost while hidden (§5, Phase B).

### Delete now

Routes backed by abandoned zero-row concepts · duplicate decisions UI · dead workflow paths ·
orphaned helpers · debug output and temporary files · obsolete selectors and compatibility
fallbacks once redirects are verified.

Per audit §4.2: a compatibility fallback is dead only when **every** column it guards is verified
present. Per audit §5.1: once drift is repaired, retaining a fallback *masks* future drift rather
than protecting against it.

---

## 8. Decision rule

A change enters the next-90-day roadmap only if it materially improves at least one of:

1. The customer reaches their first useful finding faster.
2. The extracted or canonical facts become more accurate.
3. A finding becomes easier to verify through evidence.
4. A reviewer can correct an error faster and safely.
5. A reviewer reaches a defensible decision faster.
6. The resulting decision is easier to audit or export.
7. The product becomes materially easier to sell or operate in a paid pilot.

If it improves none of these, cut or defer it.

---

## 9. Working behavior

- Inspect the **actual current repository** before asserting that something is removed or
  consolidated. §3 exists because this was not done.
- Distinguish intended architecture from shipped navigation and live routes.
- Do not delete routes before tracing unique write paths.
- Do not treat redirects as equivalent to feature parity.
- Do not introduce new agents unless they remove complexity or measurably improve outcomes.
- Prefer deterministic behavior over impressive AI behavior.
- Preserve provenance and auditability through every transformation.
- Verify using focused tests and Golden Project regressions; a green gate that was never run is
  worse than a red one (audit §4.3).
- A static search missing a value is not evidence of absence (audit §4.1).
- Identify assumptions explicitly.
- Surface conflicts with this alignment before implementing them.
