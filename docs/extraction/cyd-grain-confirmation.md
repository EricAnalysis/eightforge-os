# CYD Grain Confirmation + Quantity Dedup Acceptance Values

**Status:** READ-ONLY confirmation. No code, no fix, no migration, no surface change.
**Date:** 2026-06-07
**Source dataset:** Supabase project `jpzeckefppmiujwajgvk`, table `public.transaction_data_rows` (Williamson, `source_sheet_name = "Ticket Query Results"`).
**Root cause class:** `totals_reconciliation_issue` + `extraction_issue` — quantity fields summed at transaction-row grain, inflating them ~2.75x.
**Verdict:** **CONFIRMED.** The dedup rule (one quantity per ticket) holds on live data with 100% uniformity, and every exact acceptance gate reproduces. The fix is now unblocked with proven rule + locked gates.

---

## Live column mapping (confirmed)

The canonical fields are persisted inside the `raw_row_json` JSONB blob, **not** in the typed columns (the typed `cyd`, `net_tonnage`, `mileage`, `project_name` columns are largely NULL; the real values live in `raw_row_json`). Confirmed key mapping:

| Logical field    | `raw_row_json` key   | Source file col |
|------------------|----------------------|-----------------|
| Ticket (grain)   | `Ticket No` (= `Ticket ID`, 1:1) | A |
| Rate line (row)  | `Transaction #` + `Rate Code` | AE |
| Subcontractor    | `Subcontractor`      | G |
| CYD              | `CYD`                | Y |
| Net Tonnage      | `Net Tonnage`        | AD |
| Diameter         | `Diameter`           | Q |
| Mileage          | `Mileage`            | AA |
| Extended Cost    | `Extended Cost`      | AJ |
| Invoice #        | `Invoice #`          | — |
| Client Project   | `Client Project`     | — |

`Ticket No` and `Ticket ID` both yield 2,388 distinct values (1:1), so either is a valid ticket-grain key. `Transaction #` is a within-ticket rate-line index (only 4 distinct values), **not** a row identity.

**Invoiced vs full dataset:** "invoiced" = `Invoice #` is present (equivalently `Invoice Status` not null). 283 rows are uninvoiced (no invoice #, null status). Invoice Status distribution: PreSubmitted 2,719 / Reconciled 2,061 / null 283.

---

## STEP 1 — Grain rule holds in live data ✅

| Metric | Live value |
|---|---|
| Total rows | **5,063** |
| Distinct tickets (`Ticket No`) | **2,388** |
| Single-row tickets | 1,050 |
| Double-row tickets | 1 |
| Triple-row tickets | 1,337 |
| Tickets with >3 rows | 0 |
| Multi-row tickets with **non-uniform CYD** | **0** |
| Multi-row tickets where **all rate codes are the same** | **0** |
| Triple-row tickets where **all 3 rate codes differ** | 1,337 (100%) |

- **(b) CYD is identical across every multi-row ticket's rows — 0 violations (100% uniform).** Dedup by taking the single shared value is therefore safe.
- **(c) Rate code differs across a ticket's rows — confirmed.** No multi-row ticket shares a rate code; all triples carry 3 distinct rate codes. Multi-row tickets = ONE physical load billed across MULTIPLE rate codes.

> The live row/ticket distribution differs slightly from the source workbook (source: 4,780 rows / 2,381 tickets / 1,044 single / 275 double / 1,062 triple). Live includes uninvoiced PreSubmitted rate lines, shifting the distribution toward triples. **The rule itself is unaffected: CYD uniform per ticket, rate code differing — both hold at 100%.** No STOP condition triggered.

---

## STEP 2 — Both grains computed from live data ✅

Quantity uniformity per ticket (count of tickets with >1 distinct value across their rows): CYD **0**, Net Tonnage **0**, Diameter **0**, Mileage **0**. All quantities are uniform per ticket — dedup is safe for all four.

| Field | Row-grain (full) | Row-grain (invoiced) | Ticket-grain (full) | Ticket-grain (invoiced) | Inflated? |
|---|---|---|---|---|---|
| **CYD** | **215,729** | **205,272** | 74,737 | **74,617** | Yes (~2.75x) |
| Net Tonnage | — (no data) | — | — | — | n/a |
| Diameter | 2,645 | 2,632 | 2,645 | 2,632 | **No** |
| Mileage | 28,734 | 28,724 | 10,444 | 10,434 | Yes (~2.75x) |
| **Extended Cost ($)** | **815,559.35** | **815,559.35** | (amounts are per-row; not deduped) | | **Unchanged** |

**Acceptance gates hit exactly:**

- Row-grain CYD (current/inflated): **205,272 invoiced / 215,729 full** ✅ (matches spec exactly)
- Ticket-grain CYD (correct target): **74,617 invoiced** ✅ (matches spec exactly); 74,737 full
- Inflation ratio: 205,272 / 74,617 = **2.751x** ✅ (~2.75x)
- Extended Cost row-grain = **$815,559.35** ✅ (identical at row grain for full and invoiced — amounts unaffected by the grain fix)

**Notes:**

- **Net Tonnage has no data** in the Williamson dataset (all NULL). The field/key exists but carries no values, so there is nothing to inflate or dedup. The fix should still build the canonical fact (it will resolve to 0/empty here) for forward compatibility.
- **Diameter is NOT inflated:** row-grain equals ticket-grain (2,645 / 2,632), because Diameter is populated on only one row per ticket. The grain fix leaves it unchanged but should still read it via the canonical fact for consistency.
- **Mileage IS inflated** at the same ~2.75x as CYD (28,724 → 10,434 invoiced) and must be deduped alongside CYD.

---

## STEP 3 — County partition (Kevin's question) ✅

Filter `Client Project ILIKE '%County%'` → resolves to a single project `"Williamson Co TN COUNTY Fern 0126"` (825 rows). Grouped by `Subcontractor`, at ticket grain:

| Subcontractor | Ticket-grain CYD | Tickets |
|---|---|---|
| County | **4,186** | 273 |
| County pile | **3,926** | 1 |
| Williamson County Nolensville Park Pile | **2,225** | 1 |
| **Total** | **10,337** | 275 |

**Reproduces the spec exactly: 4,186 / 3,926 / 2,225 / 10,337.** (Identical for invoiced and full — all County rows are invoiced.) EightForge can answer Kevin-class County-pile questions correctly once the grain fix lands.

> Note for a future upstream model (NOT in scope here): the `Subcontractor` field is the truck/pile measurement identity. County material is identified by Client Project containing "County" and partitioned by Subcontractor.

---

## STEP 4 — UI currently shows row-grain; canonical fact missing ✅

- The live UI "Resolved Volume" / "Project Volume (CYD)" of **~215,729** equals the **full-dataset row-grain CYD (215,729)** computed above — i.e. it is the **row-grain inflated** figure, not ticket grain (74,737 full / 74,617 invoiced).
- **No canonical "Total CYD" fact is persisted.** `transaction_data_summaries` has **0 rows** — there is no stored dataset summary at all. Surfaces therefore recompute volume by row-summing `transaction_data_rows`, which is exactly the inflation source.
- Even the `transaction_data_summaries` schema carries no canonical CYD column — only `total_extended_cost` and `total_transaction_quantity` (plus an empty `summary_json`). A canonical ticket-grain CYD/tonnage/diameter/mileage fact has nowhere to live today and is confirmed absent.

---

## Phase C — Verification & Acceptance checklist

- [x] `docs/extraction/cyd-grain-confirmation.md` produced — read-only, no fix
- [x] Live data: rows (5,063), tickets (2,388), rows-per-ticket distribution (1,050 / 1 / 1,337 / 0) recorded
- [x] Live data: CYD confirmed identical across each multi-row ticket's rows (0 violations) — no STOP
- [x] Live data: rate code confirmed differing across a ticket's rows (0 multi-row tickets share a rate code)
- [x] Row-grain vs ticket-grain CYD recorded; ratio 2.751x confirmed (~2.75x)
- [x] Extended Cost row-grain = $815,559.35 confirmed (amounts unaffected)
- [x] Net tonnage (no data), diameter (not inflated, 2,645/2,632), mileage (inflated, 28,724→10,434 inv): row vs ticket grain recorded
- [x] County partition reproduces 4,186 / 3,926 / 2,225 / 10,337 at ticket grain
- [x] Canonical "Total CYD" fact confirmed missing (`transaction_data_summaries` empty, no CYD column); surfaces confirmed row-summing
- [x] **VERDICT: dedup rule (one quantity per ticket) confirmed valid on live data, with exact acceptance gates locked for the fix**
- [x] No code, fix, migration, or surface change made

---

## Locked acceptance gates for the fix

| Gate | Current (wrong) | Target (correct) |
|---|---|---|
| Total CYD | 205,272 (invoiced) / 215,729 (full) | **74,617 (invoiced)** / 74,737 (full) |
| Mileage | 28,724 (invoiced) | 10,434 (invoiced) |
| Extended Cost | $815,559.35 | **$815,559.35 (unchanged)** |
| County pile partition | n/a (recomputed) | County 4,186 / County pile 3,926 / Nolensville 2,225 / total 10,337 |

**Fix (separate task, out of scope here):** (1) build canonical ticket-grain CYD/net-tonnage/diameter/mileage facts by deduping to the one shared value per ticket, persisted in the dataset summary; (2) make all surfaces (Project Operations Overview, By-Material, By-Site, By-Disposal, By-Rate-Code) READ those canonical facts instead of row-summing; (3) keep amounts (Extended Cost) at row grain. Add a harness probe asserting **County pile = 4,186** at ticket grain so this inflation can never silently return.

> **Security note (surfaced, not acted on):** the Supabase advisor flags 6 tables with Row Level Security disabled (`workflows`, `decision_policies`, `decision_rules`, `project_rule_overrides`, `workflow_templates`, `document_fields`). Unrelated to this task and not remediated here — flagged for the team to decide on policies before enabling RLS.
