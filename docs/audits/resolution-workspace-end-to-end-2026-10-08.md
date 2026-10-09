# Resolution Workspace end-to-end audit (2026-10-08)

The standard under audit: EightForge knows the uncertainty → Forgewing
investigates automatically where qualified → the operator sees the evidence and
the proposed resolution → the operator makes the authoritative decision → the
deterministic downstream impact is shown → the decision is persisted through an
existing typed authority path.

Scope: every `ResolutionCase` kind (`lib/resolution/resolutionCases.ts`), the
queue read (`lib/server/resolutionQueueRead.ts`,
`GET /api/projects/[id]/resolution-cases`), the workspace
(`components/resolution/ResolutionWorkspace.tsx`), the request builder
(`lib/resolution/resolutionActionRequest.ts`), the impact preview
(`lib/server/resolutionImpactPreview.ts`) and the write routes. This follows
`resolution-workspace-operator-audit-2026-10-07.md` (F1 to F5).

## 1. Workflow map

```
extraction payload ──► documentEvidenceAttention (shared; also the offline inventory)
reviewed assertions ─► documentReviewedValueState      │
Validator findings ──► open findings requiring review   │
recovery proposals ──► pending proposals                 ▼
                     buildResolutionQueue (pure) ── one case per evidence identity,
                                                     overlapping facts merged, grouped by root cause
                                 │
                     resolutionQueueRead: deterministic investigation of every case
                     (local, no provider), Forgewing suggestions only when entitled
                                 │
          Workspace: queue (left) · evidence and source page (centre) · decision (right)
                                 │
          buildResolutionActionRequest: only actions the case lists, bound to server targets
                                 │
   region-assertions route ─► human_fact_assertions (reviewed value, withdrawal, disposition)
   forgewing-recovery-review route (recovery proposal review)
   invoice-line-rate-link route (manual rate link)
   execution-items outcome route (Validator execution item)
   value-reading / value-reading-review routes (Ask and reject/defer a reading; never truth)
```

Downstream: an effective reviewed row supersedes the machine row at the shared
pricing assembly seam (B3.1); the Validator and cross-document verification
read pricing; the queue is re-read after every save.

## 2. The sixteen questions, per case kind

Key: ✓ holds · ◐ holds with a limit noted · ✗ gap · n/a does not apply.

| # | Question | Value cases¹ | Re-review | Category | Recovery proposal | Validator finding | Page conditions² |
|---|---|---|---|---|---|---|---|
| 1 | Reaches the operator | ✓ queue | ✓ queue | ✓ queue | ✓ queue | ✓ queue + Validator deep link | ✓ queue |
| 2 | Evidence displayed | ✓ line, observations, text read | ✓ previous review, previous and current evidence | ✓ row as read | ✓ proposal evidence | ✓ persisted evidence verbatim | ✓ diagnostic summary |
| 3 | Source region obvious | ✓ boxes drawn on the page | ◐ previous evidence described, never drawn on today's page | ✓ | ◐ drawn unless the proposal's evidence is unbound | ◐ page shown, no highlight (evidence cites a page, not observations) | ◐ page only |
| 4 | Investigated automatically | ✓ deterministic investigation on every case; provider reading is operator-asked and policy-disabled (`VALUE_READING_POLICY`) | ✓ | ✓ (no category suggested) | ✓ (the proposal is the investigation) | ✓ | ✓ |
| 5 | Forgewing separated from truth | ✓ "Unverified · not authority", shown only when entitled | ✓ | ✓ | ✓ "uncalibrated", no number | ✓ | ✓ |
| 6 | Why the case exists | ✓ problem + deterministic state | ✓ held reason | ✓ no category evidence / outside allowed set | ✓ recovery reason | ✓ finding summary, expected/found | ✓ |
| 7 | Typed, appropriate actions | ✓ reviewed value, disposition | ✓ reviewed value, withdrawal | ✓ reviewed row (category required) | ✓ confirm offered option / reject | ✓ rate link, execution outcome, open in Validator | ◐ open document only (see G2) |
| 8 | "Use suggestion", never auto-prefill | ✓ explicit selection copies a reading | n/a | ✓ no suggestion exists | ✓ option chosen explicitly; proposed is not default | n/a | n/a |
| 9 | Written through an existing reviewed path | ✓ region assertions → `human_fact_assertions` | ✓ | ✓ | ✓ recovery review route | ✓ existing link and execution routes | n/a |
| 10 | Impact previewed before save | ✓ (disposition: fixed "no change", now stated) | ✓ value and withdrawal | ✓ | ✓ | ✓ link, execution | n/a |
| 11 | Save & Next | ✓ next still-open case in the previous order | ✓ | ✓ | ✓ | ✓ | n/a (Leave unresolved) |
| 12 | Stale state fails closed | ✓ digest, observations, chain head and proposal pin checked server-side; 409 refreshes the case in place | ✓ | ✓ | ✓ proposal digest | ✓ | n/a |
| 13 | Withdraw/undo append-only | ◐ withdrawal supersedes (append-only); offered in the workspace only on re-review cases, otherwise on the document's reviewed values panel (see G3) | ✓ | ◐ as value cases | n/a (review recorded once) | ◐ execution outcomes follow the execution ledger | n/a |
| 14 | Transitions after resolution | ✓ effective or held review closes the case; held review reopens as re-review | ✓ | ✓ | ✓ reviewed proposals leave the queue | ✓ when the finding closes | ◐ only a new analysis closes them |
| 15 | Overlap understandable | ✓ one case per row: a value case that also needs its category carries `+ category` (now marked in the list); a withheld line with a pending proposal is listed once | ✓ | ✓ merged into the value case | ✓ | ✓ shared rate row groups findings | ✓ |
| 16 | Core without Forgewing | ✓ no Forgewing area at all | ✓ | ✓ | ◐ proposals exist only where Forgewing ran | ✓ | ✓ |

¹ Value cases: `unreadable_priced_line`, `withheld_priced_line` (bound to a
line), `review_required_value` (scanned rate, unreadable amount).
² Page conditions: `structure_review`, `coverage_gap`, `pricing_withheld`, and a
withheld line whose evidence cannot bind to observations.

Missing document and relationship cases reach the workspace as Validator
findings; there is no separate case kind for them.

## 3. Gaps

- **G1 (fixed in #174).** Category entry was free text on every value case and
  on the document's reviewed values panel (a second entry point for the same
  write); a blank category silently dropped a
  category extraction had resolved. Both entry points now offer the allowed
  list only. The request builder refuses a blank when the machine row had a
  category, and the server refuses a non-allowed category.
- **G2 (product gap, not fixed: needs a new authority path).** Page conditions
  have no decision an operator can record. An operator who has inspected a page
  that holds no prices (a cover sheet read as `pricing_withheld`, a coverage gap
  on a signature page) cannot close the case; it stays until a new analysis
  stops reporting it. Closing it needs a page-level disposition fact. That is a
  new reviewed fact key and route, outside the scope of surgical fixes. The
  workspace now says so plainly instead of offering nothing.
- **G3 (minor).** An effective reviewed value closes its case, so withdrawing it
  is done from the document's reviewed values panel, not the workspace. It is
  the same append-only path, but the operator must know where to look.
- **G4 (minor, display fixed).** The queue showed titles only. It now shows open
  cases by kind, each entry's kind, and `+ category` where the reviewed row
  must also name one.
- **G5 (minor, display fixed).** "Leave unresolved" did not say that nothing is
  saved, and a disposition did not state its impact. Both now do.
- **G6 (data).** Production stores reconstruction v2 for the three schedule
  documents, so the live queue does not reflect current extraction until they
  are re-analyzed (normal operator action, not a backfill).
- **G7 (open, from F3/F4).** There is no table-default category and no
  invoice-line category review yet; both have designs in #171.

## 4. Authority-path proof

- The client cannot invent a write. `buildResolutionActionRequest` refuses any
  action the case does not list, any option it does not offer and any
  disposition it does not allow. Endpoint, anchor, page, digest, observations,
  region, chain head and proposal pin all come from the server's action
  (`lib/resolution/resolutionActionRequest.test.ts`).
- Human-reviewed truth has one writer: the region-assertions route records
  into `human_fact_assertions` with `operator_entered` or, when a reading is
  cited, `ai_proposed` origin, and the database verifies the citation
  (`lib/architecture/regionBoundAssertionBoundaries.test.ts`, B4.2 SQL
  verification).
- Forgewing never writes canonical facts. No Core, canonical or Validator path
  consumes a proposal (`lib/architecture/forgewingValueReadingBoundaries.test.ts`,
  `lib/architecture/importBoundaries.test.ts`).
- Impact preview runs the existing Validator in memory over a hypothetical
  assertion; nothing is saved (`lib/server/resolutionImpactPreview.test.ts`).
- Stale writes fail closed. 409 is classified `stale` and the case is refreshed
  in place, never retried (`resolutionActionRequest.test.ts`).
- Core works without Forgewing. With Forgewing absent there is no Forgewing
  area, and stray suggestions are never shown
  (`components/resolution/ResolutionWorkspace.test.tsx`).

## 5. Activation readiness (operator-facing)

| Workflow | Ready for | Basis |
|---|---|---|
| Deterministic case investigation | On for every case (already) | Local, sends nothing, labelled "Not a decision" |
| Project Ask | Operator-assist (already qualified) | Answers from project truth; proposes no value |
| Priced value reading | **Not yet** | B4.6 FAIL stands. B4.6.1 (#175) prepared every class on the pinned corpus: only DN's dense-scan scanned amounts are ready to read (20/20 bound); no task can be activated, since each has a class that is unlabelled, too small or blocked by an extraction binding failure |
| Case investigation by a provider | **Not yet** | Unqualified by policy; needs its own benchmark |
| Category choice | **Human-only** | No objective source answer exists: the case exists because no evidence names a category |
