# Display-description quality heuristic — baseline and repair design

Date: 2026-08-07
Status: **design and baseline only — no code changed**
Scope: display-description quality evaluation inside contract pricing assembly.
Follows C3 (`cddd553`, assembly source scope) and C4 (`ce2aacb`, source description
preservation). Billing identity is explicitly **out of scope**: C4 moved semantic
identity onto `sourceDescription`, and nothing here may move it back.

---

## 1. The defect, stated precisely

`cleanContractRateDescriptionForDisplay` (`lib/contracts/contractPricingAssembly.ts`)
decides whether a row's description is damaged using this predicate:

```ts
const sourceDamaged =
  hasStrongDescriptionNoise(sourceDescription) ||
  hasSevereOcrDamage(sourceDescription) ||
  hasSevereOcrDamage(rawText) ||        // ← condemns from surrounding text
  hasSevereOcrDamage(rawCellsText);     // ← condemns from surrounding text
```

The last two terms let text that is *not the description* condemn a description that
reads perfectly. `rawText` is the row's raw span, which for some extractors is a
page-level OCR blob: on the MDOT bid schedule it is 307 characters of proposal
boilerplate (`"SecLion 905 - Proposaf l,etting Date: 04/1.1 /2026 …"`). That blob is
genuinely damaged, so `sourceDamaged` is true, the recovery branch is entered, and a
clean description such as `"Mobilization"` is replaced by the
`Raw row needs review` sentinel.

The same pollution reaches the recovery inputs, since `combinedText` is
`[sourceDescription, rawText, rawCellsText].join(' ')` and is what feeds
`recoverDescriptionByCategoryWithFallback` and `buildCleanDescription`. Using the
surrounding text for **recovery** is legitimate — that is what recovery is for. Using
it for **condemnation** is not.

### Why this is now safe to repair

Before C4 the display value was also the semantic key, so tuning this heuristic moved
billing identity. C4 separated the two:

```
sourceDescription = observed source truth   → billing / description-match keys
description       = operator-facing display → this heuristic only
```

The repair is therefore display-only by construction. That is the property §5 exists
to prove, not to assume.

---

## 2. Baseline — captured 2026-08-07, read-only, pre-change

Cohort totals. `semanticIdentityDigest` is a sha256 over each rate schedule item's
`(source_document_id, record_id, billing_rate_key, description_match_key,
site_material_key, rate_amount, unit_type, source_description)`, sorted, so it pins
semantic identity independently of ordering and wall clock.

| Cohort | assembled rows | rateScheduleItems | distinct billing keys | distinct desc-match keys | sentinel display rows |
|---|---|---|---|---|---|
| Golden | 91 | 91 | 91 | 91 | **7** |
| MDOT | 5 | 5 | 5 | 5 | **2** |
| Goodlettsville | 10 | 10 | 5 | 5 | 0 |

```
Golden          semanticIdentityDigest = 52196a0a289216f33383874354e9ccf60e03e94f51c921885e25c70a938ec061
MDOT            semanticIdentityDigest = 7acf15a4814787b15b7d2907d7c9d62670382565d3cc033ba676b9f29a3981cc
Goodlettsville  semanticIdentityDigest = d89c822e38218d41d2cea7d29349bb49571370bc240f3093747ca99b803193d6
```

Goodlettsville carries no sentinels and is included purely as a C3/C4 regression
guard: its digest, its 10 rows, and its duplicate-authority block must not move.

### 2.1 The nine affected rows

All Golden rows are document `18550bfc-c057-4aae-bfa3-db896e36edb0`; all MDOT rows are
document `6866832f-5126-435d-9329-f09bade970a8`. Every row below currently displays
`Raw row needs review`.

| # | Row id | Source description | Rate / unit | Category | Billing key | Verdict |
|---|---|---|---|---|---|---|
| 1 | `exhibit_a_table:pdf:table:p8:t27:r2` | `60+ Miles from ROW to DMS` | 10.9 / Cubic Yard | Vegetative Collect, Remove & Haul | `desc:60 miles from row to dms` | **readable — must be preserved** |
| 2 | `exhibit_a_table:pdf:table:p8:t30:r6` | `60+ Milgs from ROW to DMS` | 10.9 / Cubic Yard | C&D Collect, Remove & Haul | `desc:60 milgs from row to dms` | **readable (single-character OCR typo)** |
| 3 | `exhibit_a_table:pdf:table:p11:t37:r5` | `ansports` | 115 / Hour | Equipment | `ANSPORTS` | damaged — truncated fragment |
| 4 | `exhibit_a_table:pdf:table:p11:t38:r2` | `pment me` | 96 / Hour | Equipment | `PMENTME` | damaged — truncated fragment |
| 5 | `exhibit_a_table:pdf:table:p11:t38:r4` | `ment Ei osing Durr ok kwith with knuck le boom and. debi S Saba` | 1690 / Hour | Equipment | `desc:ment ei osing durr ok kwith with knuck le boom and debi s saba` | damaged — scrambled |
| 6 | `exhibit_a_table:pdf:table:p11:t39:r6` | `Equi Equip ent nt II" AirBoat Marsh tr Bug BLA 15-26 ft Low i EXC we` | 300 / Hour | Equipment | `desc:equi equip ent nt ii airboat marsh tr bug bla 15 26 ft low i exc we` | damaged — scrambled |
| 7 | `exhibit_a_table:pdf:table:p10:t36:r15` | `ant` | 50 / Hour | Personnel | `ANT` | damaged — truncated fragment |
| 8 | `mdot_section_905_bid_schedule:4` | `Mobilization` | 1 / LS | Equipment | `MOBILIZATION` | **readable — must be preserved** |
| 9 | `mdot_section_905_bid_schedule:5` | `Maintenance of Traffic` | 1 / LS | Equipment | `desc:maintenance of traffic` | **readable — must be preserved** |

### 2.2 What the baseline shows

Three rows (#1, #8, #9) carry descriptions that are clean by inspection and were
condemned only by their surroundings. Row #2 is one transposed character from clean
(`Milgs` / `Miles`) and is readable as a line item.

The other five (#3–#7) are genuinely damaged: truncated fragments and scrambled token
salad. Those should keep displaying the sentinel — an operator cannot act on `ant`.

Two observations that matter for implementation:

- **`sourceQuality` is not a usable discriminator.** Rows #8 and #9 are `clean` and were
  condemned; row #3 (`ansports`) is also `clean` and is genuinely damaged. The field
  describes the extraction, not the description's readability.
- **`rawTextLen` correlates with the defect but does not define it.** MDOT's blob is 307
  characters, Golden's are 37–167. Length is a symptom of the page-blob shape, not the
  rule. The rule must be *which text is examined*, not *how much of it there is*.

---

## 3. The repair

Narrow and display-only.

1. **Judge damage from the description alone.** Drop the `rawText` and `rawCellsText`
   terms from `sourceDamaged`, leaving:

   ```ts
   const sourceDamaged =
     hasStrongDescriptionNoise(sourceDescription) ||
     hasSevereOcrDamage(sourceDescription);
   ```

2. **Preserve a readable description.** When the description alone is neither noisy nor
   damaged, the cleaned description is the display value; recovery does not replace it.

3. **Keep recovery inputs as they are.** `combinedText` remains available to
   `recoverDescriptionByCategoryWithFallback` and `buildCleanDescription` — recovery may
   still read the surrounding text, but only *after* the description itself has failed.

4. **Keep the sentinel for genuine damage.** Rows #3–#7 must continue to display
   `Raw row needs review`.

5. **Do not touch `sourceDescription`.** It is written once from the source row and is
   not an input to, or an output of, this heuristic.

### Expected outcome

Rows #1, #2, #8, #9 stop being sentinelled and display their source text. Rows #3–#7
continue to display the sentinel. Sentinel counts move Golden 7 → ~5 and MDOT 2 → 0.

**The success criterion is not zero sentinels.** It is that no clean source description
is condemned by surrounding OCR noise. A repair that resolved all nine would be
over-correcting: it would be presenting `ant` and `pment me` to operators as if they
were usable line items.

Row #2 is the judgement call. `60+ Milgs from ROW to DMS` is readable but misspelled;
whether the noise predicates classify it as damaged is an empirical question to be
answered against the implementation, not asserted here. Either outcome is defensible
provided it is reached by examining the description alone.

---

## 4. Invariants to prove unchanged

Because C4 moved semantic identity off the display value, this repair should move
**nothing** below. Each is a check, not an assumption.

- `billing_rate_key` for all 91 Golden, 5 MDOT, and 10 Goodlettsville items.
- `description_match_key` for the same.
- `site_material_key`, `rate_amount`, `unit_type`, `source_description` for the same.
- The three `semanticIdentityDigest` values in §2, byte for byte.
- Item counts and multiplicity: Golden 91, MDOT 5, Goodlettsville 10.
- Authority-comparison identities, root-cause groups, and classifications for MDOT and
  Goodlettsville.
- Goodlettsville C3: `duplicate_authority` still blocks, both documents retained in the
  registry, validator projection withheld.

If any digest moves, the repair has reached past display and must be reworked rather
than re-baselined.

---

## 5. Verification plan

1. Re-run the §2 capture after the change; diff every field per row, not just counts.
2. Confirm the three digests are unchanged.
3. Inspect all nine rows individually and classify each as preserved or still
   sentinelled; confirm the split matches §3 and that no row #3–#7 was promoted.
4. `npx tsc --noEmit`, targeted suites, architecture guards, `npm run build`,
   `git diff --check`.
5. Read-only authority comparison for MDOT and Goodlettsville, twice, byte-identical
   apart from wall clock, compared against the C4 post-merge reports.

Baselines are captured before implementation deliberately: after the fact a changed
count can only be observed, not judged. This sequence is what distinguished legitimate
semantic separation from accidental fragmentation in C4's Golden cohort.

---

## 6. Out of scope

- `sourceDescription` and every semantic key derived from it (C4).
- Comparator alignment, equivalence closure, grouping, multiplicity, suppression.
- C3 pricing-source scope, duplicate-authority detection, governance resolution.
- Any fuzzy or similarity-based equivalence in billing identity. If the repair ever
  needs to decide that two descriptions mean the same thing, it has left display and
  entered identity, which is not this phase.
- Carried forward, still open: stale comparator `assemblySourceScope` explanation;
  `registryDigest` array-order sensitivity; P1 duplicate-document vocabulary; P2
  `extraction_source_artifacts` migration and hash backfill; invoice identity not
  consulting identity-store readability.

---

## 7. Implementation findings — 2026-08-07 (correction)

Added after implementing §3 against the §2 baseline. Sections 1–6 are left exactly
as written so the audit trail keeps the prediction that turned out to be wrong;
this section supersedes them where they conflict.

### 7.1 Correction: Golden is 7 → 7, not approximately 7 → 5

§2.1 classified rows #1 (`60+ Miles from ROW to DMS`) and #2
(`60+ Milgs from ROW to DMS`) as "readable — must be preserved", and §3 predicted
Golden would fall from 7 sentinels to about 5. **Both were wrong.** The
classification was an eyeball judgement about whether the text reads like English;
the function's standard is whether the description works as a rate-row description,
and these are route qualifiers rather than line items.

Measured by running the function twice per row, once with real surroundings and once
with `rawText: null, rawCells: null`:

| Row | with surroundings | description only | condemned by surroundings? |
|---|---|---|---|
| `Mobilization` (MDOT #8) | preserved | preserved | — |
| `Maintenance of Traffic` (MDOT #9) | preserved | preserved | — |
| `60+ Miles from ROW to DMS` (#1) | sentinel | **sentinel** | **no** |
| `60+ Milgs from ROW to DMS` (#2) | sentinel | **sentinel** | **no** |

Rows #1 and #2 fail the description-only checks independently. They were never
victims of the `rawText` defect, so the repair correctly leaves them sentinelled.
§3's stated criterion — *no clean source description condemned by surrounding OCR
noise* — was right; only the row-count prediction derived from it was wrong. Golden's
correct expected result is **7 → 7**.

The §3 note that row #2 was "an empirical question to be answered against the
implementation, not asserted here" was the right instinct. Row #1 should have carried
the same caveat and did not.

### 7.2 Discovered: display description is not fully display-only

C4 isolated **semantic billing identity** from display. It did **not** isolate
**assembly multiplicity** from display: the display description participates in the
assembly dedupe key, so changing display can change how rows collapse and therefore
how many rows survive.

This was discovered by testing a broader repair than §3 specified — an additional
gate that preserved any independently readable description before recovery was
consulted. It produced:

```
Golden: 91 rows -> 95 rows
```

Four rows that previously collapsed against each other stopped doing so, purely
because their display text changed. That is a multiplicity change, and it was
rejected and reverted. Only the §3 predicate narrowing survives.

**Consequence for the record:** the surviving change is safe because its measured row
counts and semantic identity digests are unchanged — not because display-heuristic
changes are inherently safe. The two are different claims and only the first is
evidenced.

### 7.3 Measured outcome of the shipped change

Removing `hasSevereOcrDamage(rawText)` and `hasSevereOcrDamage(rawCellsText)` from
`sourceDamaged`, and nothing else:

| | baseline (§2) | after |
|---|---|---|
| MDOT sentinels | 2 | **0** |
| Golden sentinels | 7 | 7 (all fail independently) |
| Goodlettsville sentinels | 0 | 0 |
| Row counts (Golden / MDOT / GV) | 91 / 5 / 10 | unchanged |
| Golden semanticIdentityDigest | `52196a0a…` | unchanged |
| MDOT semanticIdentityDigest | `7acf15a4…` | unchanged |
| Goodlettsville semanticIdentityDigest | `d89c822e…` | unchanged |
| MDOT root-cause groups | 3 | 3, zero pricing groups |
| Goodlettsville C3 | blocked, registry `4c1fffed…` | unchanged |

The MDOT **canonical registry digest** did move (`aceb68fe…` → `5489ca7e…`). That is
expected and is not semantic drift: the registry carries the operator-facing display
description, which is exactly what this repair changes. The load-bearing invariant is
the **semantic identity digest** above, which pins source descriptions, billing keys,
description-match keys, rates, units, and row counts, and which did not move. Reviewers
should not read registry-digest movement as identity movement; they measure different
things.

### 7.4 Follow-up raised by this phase — highest priority

**Decouple display description from assembly dedupe identity.** Until that is done,
any future display-heuristic work must either demonstrate unchanged assembly grain on
the cohorts, or first remove the display description from the dedupe key. The
alternative — tuning display and discovering multiplicity moved — is only detectable
by the baseline-and-measure sequence used here, and only if that sequence is run every
time.

This supersedes the earlier ordering of follow-ups: it ranks above the stale comparator
`assemblySourceScope` explanation, `registryDigest` array-order sensitivity, P1, P2,
and invoice identity readability, all of which remain open.
