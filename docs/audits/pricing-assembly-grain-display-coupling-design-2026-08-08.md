# Pricing assembly grain — display coupling: baseline and repair design

Date: 2026-08-08
Status: **design and baseline only — no code changed**
Scope: assembly deduplication grain in `lib/contracts/contractPricingAssembly.ts`.
Follows C3 (`cddd553`/`e53bd02`, assembly source scope and duplicate authority),
C4 (`ce2aacb`, source description preservation), and the display-heuristic repair
(`6b2db9a`, condemnation isolated from surrounding OCR).

This is a **grain correction**, not test cleanup. The measured consequence is that
Golden currently merges materially distinct contract line items.

---

## 1. The defect

Assembly deduplication decides whether two physical rows collapse using the
**operator-facing display description**, which display cleanup rewrites. Three keys
depend on it:

| Key | Line | Display dependency |
|---|---|---|
| `dedupeKey` | `:1717` | Fallback branch only. Rows **with** `route` or `distanceBand` key on those instead and are already display-independent; rows without them key on `description`. |
| `coverageKey` | `:1737` | Adds `description` for `Management & Reduction`, `Personnel`, and `Equipment` — deliberately, so distinct roles sharing an hourly rate are not mistaken for OCR duplicates. |
| `descriptionSlotKey` | `:1758` | `page` + `category` + `description`. |

All three call `normalizeDedupeText`, which OCR-normalizes then collapses to
alphanumeric tokens. The intent of adding `description` to `coverageKey` and
`descriptionSlotKey` is *to preserve distinctness*. It fails when display cleanup
recovers two differently-damaged descriptions into the **same** text: the rows then
collide and one is suppressed.

C4 moved semantic billing identity onto `sourceDescription`. It did not move grain.

---

## 2. Baseline — captured 2026-08-08, read-only, on `main` at `2753fe1`

| Cohort | assembled rows | merges | display-driven merges | rows separated despite equal source key |
|---|---|---|---|---|
| Golden | 91 | 14 | **11** | 0 |
| MDOT | 5 | 0 | 0 | 0 |
| Goodlettsville | 10 | 0 | 0 | 0 |

```
assemblyGrainDigest      Golden          4fe37790ea6ce8aa88b265ca08b2ad355efd8caeadb8325cce2531fcb277686d
assemblyGrainDigest      MDOT            5b1f21783d26928f13809c98c5b9d46fb598c49bd5775d6b5a40c827e4ed37f6
assemblyGrainDigest      Goodlettsville  542677725a2cb66c555148a297ad8e75f4b8f19714d211643479e97fec0adeef

semanticIdentityDigest   Golden          52196a0a289216f33383874354e9ccf60e03e94f51c921885e25c70a938ec061
semanticIdentityDigest   MDOT            7acf15a4814787b15b7d2907d7c9d62670382565d3cc033ba676b9f29a3981cc
semanticIdentityDigest   Goodlettsville  d89c822e38218d41d2cea7d29349bb49571370bc240f3093747ca99b803193d6

displayDumpDigest (all three cohorts, 106 rows)  5c6dfb45aef1ec9a0717d18b50b10f5cc3bccae7500acd7e3fa711ff35dc174d
```

`assemblyGrainDigest` is a sha256 over each emitted row's
`(sourceDocumentId, rowId, sorted merge diagnostics)`. It moves whenever group
membership changes, which `semanticIdentityDigest` does not detect.

### 2.1 Groups currently merged because of display description

Eleven of Golden's fourteen merges collapse rows whose **source descriptions differ**.
Ten of those eleven appear to be genuinely distinct line items:

| Reason | Winner source | Dropped source | Assessment |
|---|---|---|---|
| `trusted_description_slot_suppression` | `: _ . Skid Steer Loader` | `FrontE nd Loader` | different equipment |
| `trusted_description_slot_suppression` | `CAT D7 Dozer i` | `Il CAT D4 Dozer oe` | different equipment |
| `trusted_description_slot_suppression` | `CAT D7 Dozer i` | `CAT D8 Dozer` | different equipment |
| `dedupe_key_collision` | `Equi ent Dump Truck, 16-20 Cu. Yd. Capaeity` | `Dump Truck, 21-40 Cu, 4 Yd, Capacity -` | different capacity |
| `trusted_coverage_suppression` | `Hazardous Removal 337" up` | `Hazardous Removal 49"+` | different size band |
| `trusted_coverage_suppression` | `Soll & Sand Collection and Screening Gubic Yard` | `Electronic Waste` | unrelated services |
| `dedupe_key_collision` | `Soll & Sand Collection and Screening Gubic Yard` | `Silt Removal` | unrelated services |
| `trusted_description_slot_suppression` | `- - Jd Rad applicable/allowed) Vessel Removal on Water (if` | `Vessel Removal from Land (if` | water vs land |
| `trusted_coverage_suppression` | `Hazardous Trees -- 49"+ trunk diameter . IE .` | `Trees with Hazardous Limbs Hanging Removal >2"` | different services |
| `dedupe_key_collision` | `Carcass Removal (animal remains` | `Putrescent Removal` | related; operator call |
| `dedupe_key_collision` | `Hazardous Trees 6 to 12 inch trunk` | `Hazardous Trees 6"-12" trunk` | **same item — correct merge** |

The remaining three merges are not display-driven and are out of scope.

This is the same class of defect C4 corrected at the identity layer, one level lower:
two damaged descriptions recover to the same display text, so the grain layer treats
them as one physical row and drops one. **Golden is under-counting.**

### 2.2 Groups currently separated because of display description

Zero, in all three cohorts, once the candidate key is document-scoped.

**This was initially measured as 10 for Goodlettsville, and that was a probe error
worth recording.** A first candidate key omitted `sourceDocumentId`, which grouped
C3's two duplicate price-sheet documents together — exactly the multiplicity C3 exists
to preserve. Corrected: 0.

**Design constraint, derived from that error:** any source-derived grain key **must**
include document scope. Without it, C3's duplicate-authority rows collapse and the
duplicate-authority block loses the rows it names.

---

## 3. Design direction

Derive grain from source-truth fields rather than the mutable display value.

1. **Determine which source-derived fields define one physical pricing observation.**
   The candidate used in the baseline probe is
   `sourceDocumentId + rate + unit + page + category`, then `route`/`distanceBand`
   where present, else `sourceDescription`. It is a starting point, not a conclusion —
   §2.1 shows rows differing only in `sourceDescription` at equal rate/page/category,
   so `sourceDescription` carries real discriminating power and cannot be dropped.
2. **Preserve document scope, anchors, rate, unit, and original row identity.** None of
   these move. Row identity stays the physical `row_id`; C4's document-scoped semantic
   identity is unaffected.
3. **Apply the same treatment to all three keys**, or state per key why not.
   `coverageKey` and `descriptionSlotKey` exist to *preserve* distinctness, so keying
   them on source truth serves their stated intent better than display does.
4. **No fuzzy equivalence.** Grain is exact-match on normalized source fields. If a
   repair ever needs to decide two descriptions mean the same thing, it has left grain
   and entered identity resolution, which is not this phase.

### Expected direction of change

Golden gains rows as wrongly-merged distinct items separate — order of ten, based on
§2.1. That is a **correction**, and it must be justified row by row exactly as C4's
80 → 91 identity change was, not accepted on the aggregate.

MDOT and Goodlettsville have zero merges today, so both should be unchanged. If either
moves, the repair has reached past grain.

---

## 4. Acceptance criteria

- **Display-only changes cannot alter multiplicity.** Prove by perturbing the display
  value and showing `assemblyGrainDigest` unchanged.
- **Genuinely distinct source rows remain distinct** — the ten §2.1 rows separate.
- **Duplicate representations of the same physical row still collapse where justified**
  — `Hazardous Trees 6 to 12 inch trunk` / `6"-12" trunk` must still merge.
- **C3 duplicate-authority behavior unchanged.** Goodlettsville stays at 10 rows,
  `duplicate_authority` still blocks, both documents retained, registry `4c1fffed…`.
- **C4 billing identity unchanged.** All three `semanticIdentityDigest` values hold.
- **No fuzzy equivalence introduced.**

Every newly separated or newly merged row is classified individually as intended,
neutral, or regression before any aggregate count is interpreted.

---

## 5. Verification plan

1. Re-run the §2 capture; diff grain digests, semantic digests, and the full display
   dump.
2. Enumerate every changed group and classify it.
3. Targeted assembly tests, `npx tsc --noEmit`, architecture guards, `npm run build`,
   `git diff --check`.
4. Read-only authority comparison for MDOT and Goodlettsville, twice, byte-identical
   apart from wall clock.

**Environment limitation, stated up front:** Goodlettsville and MDOT support the early
read-only gate without `GOLDEN_CORPUS_ROOT`. The corpus-gated Golden, TDOT, and MDOT
**real-fixture** tests self-skip when it is unset, and those gates are **unmet, not
passed**. Golden's grain is still measurable through the read-only snapshot path used
for this baseline, which is how §2 was captured.

---

## 6. Out of scope

- `sourceDescription` and semantic keys derived from it (C4).
- Display-description quality heuristics (`6b2db9a`), including the explicit
  `combinedText`-based artifact rules still open as a follow-up.
- C3 pricing-source scope, duplicate-authority detection, governance resolution.
- Comparator alignment, equivalence closure, grouping, multiplicity handling.
- Carried forward, still open: stale comparator `assemblySourceScope` explanation;
  `registryDigest` array-order sensitivity; P1 duplicate-document vocabulary; P2
  `extraction_source_artifacts` migration and hash backfill; invoice identity not
  consulting identity-store readability; audit of explicit `combinedText` artifact
  rejection rules including the potential `ansports` recovery case.
