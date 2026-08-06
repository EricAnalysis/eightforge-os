# Canonical authority shadow comparison — first cohort review (2026-08-06)

First operational run of the A15 legacy-versus-canonical shadow comparison against the
live database, following the merge of PR #98 (`af56ddc`).

**Recommendation: HOLD.** Do not expand the cohort and do not enable canonical serving
authority. The comparison found real and important divergences, but it also
mis-classified the single clearest case in the cohort — reporting a canonical
*correction* as 22 blocking regressions while masking a genuine canonical regression
sitting beside it. Its pricing output is not currently trustworthy for a promotion
decision. Detail in §5.

Nothing in this review changed canonical truth, a validation result, project state, or
any serving configuration. Every run was read-only (`--no-persist`).

---

## 1. Scope and method

The comparison was executed locally against the production database using the operator
harness, not through the production validation flow. That distinction matters:

- **No production configuration was changed.** `EIGHTFORGE_CANONICAL_AUTHORITY_COMPARE`
  was never set in the deployment environment.
- **No validation was triggered.** No `project_validation_runs` row was written, no
  publication scheduled, no notification emitted, no project status altered.
- **No comparison artifacts were persisted.** Runs used `--no-persist`, so nothing was
  written to the `canonical-shadow-artifacts` bucket.

`runProjectTruthAuthorityComparison` is read-only with respect to validation by
construction, so this path exercises exactly the same comparison code the production
flow would, over the same production data, without any of the production writes.

Two full passes were run over the cohort to establish repeatability.

## 2. Cohort

| Project | ID | Profile | Documents |
|---|---|---|---|
| Golden Project | `437502f2-d46d-447f-81e3-f26fa7ba0c14` | Golden / ticket-grain | 4 (1 contract, 2 invoice, 1 transaction_data) |
| Goodlettsville | `e7185c5f-f532-4886-9022-2e449ced9445` | Cross-document / ticket-grain | 9 (1 contract, 2 price_sheet, 5 invoice, 1 transaction_data) |
| MDOT | `445c7376-659a-4261-a445-d99585114b21` | Simple | 1 (contract) |
| STL | `185cc9c9-30cd-4671-9e6e-b3bf13a62833` | Source gap | 0 |
| MVSU | `22d51a76-79d8-4026-81bf-d78c0266c489` | Multi-document pricing | 3 (contract, price_sheet, specification) |

The database holds six projects in total; TDOT (8 contracts, no invoices or
transactions) was the only one excluded, as MVSU covers the same shape with document
relationships present.

**There is no separate ticket-grain-complex project to add.** Golden and Goodlettsville
are the only two projects in the database with any transaction data at all, and both
carry heavy ticket-grain conflict. The requested fifth profile is therefore covered by
those two rather than by a distinct project, and MVSU takes the fifth slot to exercise
pricing and relationship truth without transactions.

## 3. Results

| Project | Status | Legacy clearance | Canonical clearance | Blocking | Review | Info |
|---|---|---|---|---|---|---|
| Golden Project | `canonical_blocked` | blocked / BLOCKED | blocked / BLOCKED | 5,124 | 6,239 | 1 |
| Goodlettsville | `canonical_blocked` | blocked / BLOCKED | blocked / BLOCKED | 4,063 | 4,097 | 1 |
| MDOT | `material_delta` | blocked / BLOCKED | blocked / BLOCKED | 22 | 9 | 1 |
| STL | `canonical_blocked` | blocked / BLOCKED | blocked / BLOCKED | 0 | 0 | 1 |
| MVSU | `canonical_blocked` | needs_review / FINDINGS_OPEN | blocked / BLOCKED | 13 | 3 | 1 |

**Canonical authority established on exactly one of five projects (MDOT).** On the other
four it declined to govern:

| Project | Block reason | Blocked domains |
|---|---|---|
| Golden Project | `incomplete_domain_authority` | `transactions` |
| Goodlettsville | `missing_governing_pricing` | — |
| STL | `missing_governing_pricing` | — |
| MVSU | `incomplete_domain_authority` | `pricing`, `relationships` |

Clearance never loosened. On no project did canonical clear what legacy blocked, and on
MVSU canonical was stricter (`needs_review` → `blocked`). That is the single most
important safety property of the cutover and it held across the whole cohort.

## 4. Material findings, classified

### 4.1 Golden Project — 1,337 ticket-grain conflicts (canonical correction, confirmed)

Canonical raised 1,337 `TRANSACTION_TICKET_GRAIN_CONFLICT` findings that legacy raised
zero of, across 2,388 distinct ticket identities. Repeated physical rows describing one
ticket disagree on quantity or extended cost for well over half the tickets in the
project.

Canonical refuses to arbitrate and blocks the `transactions` domain. Legacy carries on
and reports the project as fully reconciled: legacy exposure is $815,559.35 reconciled
with $0 at risk, while canonical states $0 reconciled and $815,559.35 at risk.

**Disposition: `canonical_correction`.** This is the behavior A14 was built for, and it
is a material operational finding independent of the cutover: Golden's transaction data
contains large-scale ticket-grain disagreement that legacy validation is currently
silently summing. This warrants investigation on its own merits regardless of what
happens to canonical authority.

### 4.2 Goodlettsville — canonical cannot establish governing pricing (source gap)

Canonical blocked with `missing_governing_pricing` despite the project having a contract
and two price sheets. Legacy resolved 10 governing pricing rows; canonical resolved
none. Billed exposure is $2,832,269.32, already fully at risk under both authorities.

**Disposition: `source_gap`.** Canonical refusing to price is correct given it could
establish no governing pricing, but *why* it cannot on a project with three pricing-
bearing documents is unresolved and is the highest-value question for the next pass.

### 4.3 MVSU — conflicting governing relationship (canonical correction)

Canonical raised `CANONICAL_GOVERNING_RELATIONSHIP_CONFLICTING` for
`pricing_exhibit_belongs_to_contract_family`, blocked both `pricing` and `relationships`,
and moved clearance from `needs_review` to `blocked`.

**Disposition: `canonical_correction`.** Canonical is refusing to price from an exhibit
whose contract-family relationship is genuinely ambiguous. Legacy prices anyway.

### 4.4 STL — clean

Zero documents, canonical blocks on missing pricing, one informational structural delta.
**Disposition: `accepted_equivalent`.**

### 4.5 MDOT — see §5

The one project where canonical governed. Its 22 blocking deltas are the subject of the
recommendation and are **not** dispositioned here, because the comparator's output for
them is wrong.

## 5. Why the recommendation is HOLD

MDOT is the only project in the cohort where canonical actually established authority,
so it is the only one that measures canonical truth rather than canonical refusal. The
comparison reported 13 blocking `regression_candidate` and 9 blocking `source_gap`
deltas on it. Inspecting the underlying rate rows shows that is wrong in both directions.

**What legacy and canonical actually produced for MDOT:**

Legacy resolves **10** governing pricing rows. They are the same 5 contract lines loaded
twice, from two sources with different `record_id` shapes and different unit spellings:

```
mdot_section_905_bid_schedule:1        Removal of Debris Hangers   Each   94
6866832f-…:rate_table:item:1           Removal of Debris Hangers   EA     94
mdot_section_905_bid_schedule:3        Removal of Debris, LVM      Cubic Yard  14.45
6866832f-…:rate_table:item:3           Removal of Debris, LVM      CY     14.45
```

Canonical resolves **5** — one per contract line, deduplicated, with identical rates.

**Canonical is correct and legacy double-counts governing pricing.** The comparator
reported that correction as 13 blocking regressions.

The cause is the comparison's pricing identity. `pricingIdentity` keys on
`canonical_category ?? source_category ?? material_type` plus raw `unit_type`, and
`canonical_category` does not mean the same thing on both sides:

| Field | Legacy | Canonical |
|---|---|---|
| `canonical_category` | resolved taxonomy slug — `tree_operations` | raw source text — `Tree Operations` |
| `unit_type` | `Each` on one representation, `EA` on the other | `Each` |

No key ever matches, so every row is reported as lost under canonical *and* gained under
canonical, with amount deltas in both directions.

**The same defect masks a real regression.** Comparing on the shared billing keys — which
both authorities compute with the *same* `deriveBillingKeysForRateScheduleItem` builder —
shows three lines agreeing exactly and two that do not:

```
legacy    MOBILIZATION              | mobilization             | 1
legacy    desc:maintenance of traffic | maintenance of traffic | 1
canonical (empty)                   | (empty)                  | 1
canonical (empty)                   | (empty)                  | 1
```

Canonical carries `description: null` for both Equipment rows where legacy carries
`Mobilization` and `Maintenance of Traffic`. **Canonical lost the descriptions that
contract intelligence supplied**, which is a genuine `regression_candidate` — and the
comparator did not surface it as one, because the broken identity had already scattered
those rows into unmatched pairs.

A review harness that reports a correction as 22 blocking regressions and simultaneously
hides a real regression is worse than no harness: it trains an operator to dismiss
blocking deltas. That is disqualifying for a promotion decision, so the recommendation is
HOLD until it is fixed.

### 5.1 Second defect — delta volume when canonical blocks

When canonical blocks, every affected entity emits its own delta. Golden produced
**11,364 deltas** and Goodlettsville **8,161**, and the operator report itemizes every
blocking and review-required one.

The information content is far smaller than the volume suggests. Golden's 11,364 deltas
reduce to **20 distinct delta shapes**, and 9,615 of them are three shapes repeated once
per ticket:

```
2,409 x quantity/distinctTicketCount    [unclassified / review_required]
2,409 x quantity/quantityTotal          [authority_policy_difference / blocking]
2,409 x quantity/rowGrainQuantityTotal  [authority_policy_difference / review_required]
2,388 x transaction/present             [authority_policy_difference / blocking]
```

All four are the mechanical consequence of one root cause — the `transactions` domain
block — already reported once as `authority_coverage/unresolvedTruthDomains`. The report
needs to collapse mechanically-identical consequences of a single root cause into one
entry with a count and a sample, or no operator will read it.

## 6. Repeatability

Both passes over all five projects produced byte-identical results:

```
PASS Golden Project   input=true content=true deltaIds=true classification=true status=true
PASS Goodlettsville   input=true content=true deltaIds=true classification=true status=true
PASS MDOT             input=true content=true deltaIds=true classification=true status=true
PASS STL              input=true content=true deltaIds=true classification=true status=true
PASS MVSU             input=true content=true deltaIds=true classification=true status=true
```

Input snapshot digests, comparison content digests, delta ids, delta ordering,
classifications, materiality, and comparison status were identical across both runs on
live production data. **Determinism holds.** The defects in §5 are correctness defects,
not stability defects.

Runtime: Golden 20–45 s, Goodlettsville 13–26 s, others under 4 s.

## 7. Production configuration

`EIGHTFORGE_CANONICAL_AUTHORITY_COMPARE` and
`EIGHTFORGE_CANONICAL_AUTHORITY_COMPARE_PROJECTS` are read from the process environment
by `readCanonicalAuthorityComparisonEnabled`. For the deployed application that means
**Vercel project environment variables** (Project → Settings → Environment Variables),
per-environment. There is no repository-side production config: `vercel.json` carries
only `framework` and `buildCommand`, and `.env.local` is local-only and holds no
EightForge feature flags.

Neither variable is currently set anywhere. Comparison is off in production, as designed.

**This was not changed.** Enabling it is a change to standing production configuration
and needs your explicit go-ahead; the Vercel CLI is not installed in this environment and
the Vercel connector is not authorized, so it also cannot be done from here.

## 8. Recommended next steps

1. **Fix the pricing identity** (blocking for promotion). Key pricing comparison on the
   shared `billing_rate_key` / `description_match_key` that both authorities already
   compute with the same builder, rather than on `canonical_category` and raw
   `unit_type`. Reusing the shared builder is also the correct architectural choice — the
   current identity is a second, divergent notion of pricing identity.
2. **Collapse mechanical delta fan-out in the report** (blocking for operator review).
   Group by `(domain, field, classification, materiality)` with a count and a
   representative sample when a single root-cause block produces them.
3. **Investigate `canonical_category` semantics.** Legacy resolves it to a taxonomy slug;
   the canonical projection sets it to raw source text. Whichever is intended, they
   should not silently differ — this affects more than the comparator.
4. **Investigate the two independent truth findings surfaced here**, both of which stand
   regardless of the cutover:
   - Golden's 1,337 ticket-grain conflicts across 2,388 tickets.
   - Canonical losing rate-row descriptions on MDOT's Equipment lines.
5. **Then re-run this same cohort** and re-review. Only after that, consider persisting
   artifacts and enabling comparison in production for these five project IDs.

Canonical serving authority remains `legacy`. Comparison remains `off`. No promotion step
is recommended at this time.
