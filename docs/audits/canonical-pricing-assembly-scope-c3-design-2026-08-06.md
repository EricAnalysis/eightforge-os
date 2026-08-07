# C3 — Contract pricing assembly document scoping: read-only trace and implementation design

Date: 2026-08-06
Status: **design only — no code changed**
Scope: C3 (assembly source scoping). C4 (rate-row description loss) is explicitly out of scope
and must not be absorbed into this change.

---

## 1. What was traced

Read-only, from source. No production run, no authority cutover, no comparator change.

### 1.1 Legacy path — how Goodlettsville's 10 rows are resolved

| # | Location | Behavior |
|---|---|---|
| 1 | `lib/documentPrecedence.ts:730` `resolveDocumentTruthCategoryIds` | Builds `pricing` from the `rate_sheet` family, `price sheet` document types, `pricing_schedule` subtypes, and `attached_to`-linked documents. Relationship strings pass through `canonicalizeRelationshipType`. |
| 2 | `lib/validator/projectValidator.ts:1368` `buildDocumentIdsByFamily` | Adds a second, *independent* attached-pricing pass and folds it into `truthCategoryDocumentIds.pricing`; removes those ids from `contract_identity`. |
| 3 | `lib/validator/projectValidator.ts:2153` `buildFactLookups` | `rateFactDocumentIds = contract_identity ∪ pricing`. |
| 4 | `lib/validator/projectValidator.ts:1787` `buildRateScheduleItems` | Reads `rate_table` / `hauling_rates` / `tipping_fees` **facts** across that scope, one `RateScheduleItem` per entry, `source_document_id` = the fact's own document. |
| 5 | `lib/validator/projectValidator.ts:1501` / `:482` `extractCanonicalContractFacts` | Supplies those facts from `intelligence_trace.facts`, gated by `isCanonicalRateAuthorityDocument` — which accepts `rate_sheet` and `pricing` classifications. |

### 1.2 Canonical path — why it receives nothing

| # | Location | Behavior |
|---|---|---|
| 1 | `lib/validator/projectValidator.ts:1968` `prepareContractValidationContext` | `contractDocumentId = truthCategoryDocumentIds.contract_identity[0]`. **One document.** |
| 2 | `lib/validator/projectValidator.ts:578` `buildPersistedContractValidationContextFromTrace` | Same trace blob as legacy, but gated by `isCanonicalContractDocument` — contract family **only**. |
| 3 | `lib/validator/projectValidator.ts:2027` | Synthetic fallback runs with `relatedDocuments: []`. |
| 4 | `lib/validator/projectValidator.ts:2114` `executePreparedContractPricingAssembly` | Assembler invoked **once**, against one `sourceScope`. |
| 5 | `lib/canonical/authority/resolveProjectTruthAuthority.ts:124` | Canonical adapts exactly those rows, attributing all of them to `pricingContext.documentId`. |

**Root cause, stated precisely:** both authorities read the same persisted trace and diverge on a
single predicate — `isCanonicalRateAuthorityDocument` (legacy) versus `isCanonicalContractDocument`
(canonical). Goodlettsville's rate rows sit behind the wider gate. The rows exist; the assembly is
scoped to a document that carries no rate table.

### 1.3 The relationship vocabulary already exists

`lib/documentPrecedence.ts:191` `canonicalizeRelationshipType` is the shared resolver:

| Raw type | Canonical |
|---|---|
| `attached_to`, `governs`, `applies_to` | `attached_to` |
| `supplements`, `supports` | `supplements` |
| `amends` | `amends` (label: "Modifies Contract") |
| `supersedes`, `replaces` | `supersedes` (label: "Replaces Contract") |

The four relationships named in the directive — attached_to, supplements, modifies, replaces — are
exactly `CANONICAL_DOCUMENT_RELATIONSHIP_TYPES`, using UI labels for the latter two. No new
vocabulary is needed.

---

## 2. Three normalization conventions exist today (the actual architectural defect)

This is the "single canonical path" problem, and it is broader than Goodlettsville:

1. **`canonicalizeRelationshipType`** — `lib/documentPrecedence.ts:191`. The intended resolver.
2. **Raw equality** — `lib/validator/projectValidator.ts:1371` tests
   `relationship_type === 'attached_to'` directly. **Consequence: price sheets linked as `governs`
   or `applies_to` are silently dropped from the pricing scope — by legacy as well as canonical.**
3. **A separate raw set** — `lib/validator/projectValidator.ts:605`
   `VALIDATION_EXCLUDED_RELATIONSHIP_TYPES = {supersedes, replaces, voided}`.

**Trap for the implementer:** `voided` is not a member of `DOCUMENT_RELATIONSHIP_TYPES`, so
`canonicalizeRelationshipType('voided')` returns `null`. Naively routing convention (3) through
convention (1) would silently stop excluding voided documents. Either extend the vocabulary
deliberately, or keep the void rule separate and documented.

---

## 3. Additional gaps found while tracing

**G1 — Exclusion is computed but never applied to pricing.**
`buildExcludedValidationDocumentIds` (`:611`) runs at `:2700`, before assembly at `:2737`, and
already handles supersedes/replaces/voided. It is consumed only by `resolveValidationInvoiceScope`
and `activeInvoiceDocumentIds`. Pricing never consults it. A replaced price sheet would enter a
widened pricing scope. This is the direct threat to the "no duplicate pricing authority" criterion.

**G2 — `attached_to`-linked documents bypass the authority-status filter.**
`orderedFamilyDocumentIds` (`lib/documentPrecedence.ts`) drops superseded/archived documents, but
`relationshipLinkedDocumentIds` (`:761`) applies no such filter. A superseded price sheet reaches
`pricing` through the relationship route.

**G3 — `relationshipLinkedDocumentIds(['attached_to'])` is not type-aware.**
It returns *any* document attached to contract identity, pricing or not. Widening assembly to the
raw `pricing` list would feed non-pricing attachments to the assembler. Eligibility must be gated
by `isCanonicalRateAuthorityDocument`, the same predicate legacy already uses for rate facts.

**G4 — Assembled row ids are not document-scoped.**
`contractPricingAssembly.ts:2258`: `id = row.row_id ?? contract_pricing_row:${index+1}`.
`typedRowsToRateRows` mints `typed_rate_table:1..n` per invocation. Two price sheets collide.
Source-*row* identity (`:1363`) is already document-scoped and guarded by
`ContractPricingSourceIdentityCollisionError` — but the published `id` is not, and it is the
semantic key in `projectTruthParityReport.ts:28`.

**G5 — Rows carry no source document.**
`ContractPricingAssemblyRow` has no document field. Canonical attributes every row to a single
`pricingContext.documentId` (`resolveProjectTruthAuthority.ts:127`), set from
`contractValidationContext.document_id` (`projectValidator.ts:2863`). Widening the input without
adding a per-row document channel would anchor price-sheet rows to the contract — provenance
corruption strictly worse than today's honest block.

**G6 — Schedule governance goes null on success.**
`buildCanonicalPricingSchedule` requires unanimity across rows for `governingDocument` (the C4
repair recorded in the 2026-08-01 review). Rows from two price sheets disagree, so a correct C3 fix
lands `governingDocument: null` unless schedule governance is read from the precedence family's
`governing_document_id` instead of from row agreement.

---

## 4. The truth decision — resolved by data, and not as expected

The question was framed as "two price sheets, one governing document — which set contributes rows?"
A read-only inspection of the project (2026-08-06) shows **the premise was false**.

### 4.1 What the data shows

Goodlettsville's two `price_sheet` documents are **the same physical document uploaded twice**:

| | `40a7f15b-…f993df5` | `e98315b8-…ed366` |
|---|---|---|
| title / filename | identical | identical |
| `created_at` | 2026-06-16 | 2026-07-04 |
| `processed_at` | 2026-07-04 | 2026-07-23 |
| `authority_status` | `null` | `null` |
| `effective_date` | `null` | `null` |
| relationship | `attached_to` → contract | `attached_to` → contract |
| `rate_schedule_rows` | 5 | 5 |
| row ids | `structural_table:pdf:table:p2:t3:r1..r5` | **identical** |
| descriptions / rates / units / page / anchors | — | **identical** |
| `geometry_refs` | absent | present |

All five rows match exactly across both documents: same `row_id`, same `source_anchor_ids`, same
page, same descriptions, same rates (27, 5, 9.24, 1, 135). The only difference is extraction
generation — the later upload was processed by a newer engine and carries `geometry_refs`.

### 4.2 Consequences

1. **Legacy's "10 governing rate rows" is 5 real rates double-counted.** `buildRateScheduleItems`
   dedupes on a key that includes `source_document_id` and `record_id`
   (`projectValidator.ts:1723`), so the same physical rate row from two document ids never collides.
   The double count is a **legacy defect**, not a canonical one.
2. **Assembling from "all eligible sources" would reproduce that double count in canonical** — the
   exact "duplicate pricing authority" the exit criteria forbid.
3. **The correct canonical output for Goodlettsville is 5 rows, not 10.** After the fix the
   comparator will show canonical 5 versus legacy 10. That is a genuine semantic difference with
   legacy on the defective side, which satisfies the exit criterion "comparator deltas reflecting
   actual semantic differences rather than empty canonical assembly."
4. **G4 is realized, not hypothetical.** Published row ids are byte-identical across the two
   documents. Any merge without document-scoped ids silently collapses or collides.

### 4.3 The actual defect underneath C3

Two identical, equally-authoritative attached price sheets exist with **no `supersedes`
relationship, no `authority_status`, and no `effective_date`** — nothing in the precedence data
distinguishes them. Per the directive's own rule, *"keep unresolved or conflicting relationships
blocked rather than guessing,"* this is an unresolved conflict and canonical must **not** silently
pick one, merge them, or assemble both.

Recommended behavior: resolve the eligible pricing source set as designed in §5, then detect
duplicate pricing authority deterministically — same anchors and same row identity across distinct
documents with no precedence signal — and **block with a specific diagnostic** naming both document
ids. That is honest, deterministic, and source-agnostic; it is not a Goodlettsville special case.

Operator disposition (superseding one upload, or asserting an operator relationship) then unblocks
the project through the existing relationship path, and canonical assembles 5 rows from the
surviving document. This is a data-quality decision that belongs to an operator, not to the
assembler.

### 4.4 Source identity: proven at byte level, unprovable by the system

Per the duplicate-authority rule (same artifact twice → duplicate source identity; different
artifacts with equal rows → unresolved duplicate authority), source identity was tested directly.

**The bytes are identical.** Both storage objects were read and hashed (read-only, nothing written):

| | `40a7f15b-…f993df5` | `e98315b8-…ed366` |
|---|---|---|
| `byte_length` | 825,904 | 825,904 |
| storage `eTag` | `50aabb351c5f0ec1b540a2145e8f3d23` | identical |
| **sha256** | `a9a0e6538426d3f34f0521aeb70f511ce0e5941479b29adb05114e21b641c920` | **identical** |

This is the same PDF stored twice under different upload timestamps. It confirms the §4.1 reading
and justifies an operator disposition on "verified same underlying source" grounds.

**The system cannot currently prove it.** The designed immutable-identity channel,
`extraction_source_artifacts` (`source_sha256`, `storage_object_version`, `byte_length`), **does not
exist in this database**. It is defined in
`supabase/migrations/20260723163517_phase3_step0_compliance_foundation.sql` — a Phase 3 step-0
migration that has not been applied here. The hashes above were computed out-of-band and are *not*
available to canonical assembly at runtime.

**Consequence for the fix:** identity is **unproven at runtime**, so the rule requires **block, not
collapse**. Canonical must not collapse the two documents on the strength of row equality,
filename, or an out-of-band hash recorded in this document.

**Defect found while testing this (D1).** `loadSourceArtifactSnapshot`
(`projectValidator.ts:1005`) swallows the read error:

```ts
sourceArtifacts: error ? [] : (data ?? []) as ValidatorSourceArtifactRow[],
```

A missing table, a permissions failure, or any transient error silently yields an **empty** snapshot
rather than failing loudly. Every `sourceScope.sourceVersionIdentity` then degrades to `null`
project-wide, and no caller can distinguish "this document has no recorded source identity" from
"the source-identity store was unreachable." Since C3 makes source identity load-bearing for a
blocking decision, this must be fixed as part of the work — a silently empty snapshot would turn
"unproven, therefore block" into an unexplained block.

### 4.5 Vocabulary prerequisite (P1)

EightForge has no semantically correct way to record "duplicate upload of the same source":

- `AUTHORITY_STATUS_VALUES` = `active, superseded, draft, archived, reference_only` — no `duplicate`.
- `DOCUMENT_RELATIONSHIP_TYPES` = `attached_to, supplements, supersedes, amends, governs, replaces,
  supports, applies_to` — no `duplicate_of`.

Per the directive, `voided`, `supersedes`, and `replaces` must **not** be overloaded to make this
case pass: a duplicate upload is not a superseding document, and recording it as one would corrupt
precedence semantics for every consumer of the relationship graph. Adding a duplicate-document
status or relationship is a small, explicitly scoped prerequisite to closing C3 on Goodlettsville.

### 4.6 Status of the earlier scope choice

"All eligible non-superseded pricing sources" (§5.2) remains the correct **scope resolution rule**
and is what the implementation should build. It is not, on its own, sufficient for Goodlettsville:
duplicate-authority detection (§4.3) must land with it, or the fix trades an empty assembly for a
double-counted one.

---

## 5. Implementation design

### 5.1 Shape

Keep the single chokepoint. `prepareContractValidationContext` /
`executePreparedContractPricingAssembly` are defined and called in exactly one file
(`lib/validator/projectValidator.ts`), verified repo-wide; the only external surface is the exported
`buildContractValidationContext` wrapper at `:2126`. The fix lands there and nowhere else.

### 5.2 Steps

1. **Canonicalize relationship aliases when building pricing scope.** Replace the raw
   `=== 'attached_to'` test at `:1371` with `canonicalizeRelationshipType`. This alone corrects
   `governs` / `applies_to` price sheets for both authorities.
   **1a. Keep exclusion-state handling separate (O3 resolved).** `VALIDATION_EXCLUDED_RELATIONSHIP_TYPES`
   (`:605`) must remain its own rule and must **not** be routed through
   `canonicalizeRelationshipType`. `voided` is not a member of `DOCUMENT_RELATIONSHIP_TYPES`, so
   canonicalization returns `null` for it and would silently neutralize the exclusion. Relationship
   canonicalization answers "what does this link mean"; exclusion state answers "is this document
   still authoritative." They are different questions and must stay in different functions, with a
   regression test asserting a `voided` relationship still excludes its target after step 1.
2. **Resolve one eligible pricing source set**, from inputs already in scope at the `:2737` call
   site (`precedenceFamilies`, `documentRelationships`, `excludedValidationDocumentIds`,
   `truthCategoryDocumentIds`, `sourceArtifactSnapshot`):
   `eligible = (contract_identity ∪ pricing) − excludedValidationDocumentIds − inactive-authority`,
   then gated by `isCanonicalRateAuthorityDocument`. No new relationship walk, no new
   classification rule, nothing re-read from source.
3. **Assemble per document, not per widened list.** `assembleContractPricingRowsWithCandidates`
   takes one `ContractPricingAssemblySourceScope`, and `sourceVersionIdentity` is per-document from
   the artifact snapshot. One invocation per eligible document, each with its own scope, then a
   deterministic merge ordered by the resolver's document order. Concatenating rows into a single
   call would stamp the contract's artifact identity onto price-sheet rows.
4. **Scope row identity by document (G4).** Published row `id` must incorporate the source document.
   Existing ids change, so the parity report's semantic keys change — expected, and the reason the
   cohort rerun must be two-pass byte-identical.
5. **Add a per-row source document channel (G5)** and carry it into the canonical adapter so
   evidence anchors to the document the row actually came from, rather than to
   `pricingContext.documentId`.
6. **Read schedule governance from the family (G6).** `governing_document_id`, `governing_reason`,
   `governing_reason_detail`, and `considered_document_ids` already exist on
   `ResolvedDocumentPrecedenceFamily` — carry them; do not re-derive. This satisfies "governing
   selection explained" without new logic.
7. **Deduplicate only by proven immutable source identity.** Two documents collapse into one
   logical pricing source **only** when `extraction_source_artifacts.source_sha256` (or an
   equivalent immutable byte-level identity recorded in the system) is present and equal for both.
   Row similarity, identical `row_id`s, identical anchors, identical filenames, and identical
   extracted rates are **not** sufficient and must never trigger a collapse. When identity is
   proven, collapse without choosing a winner: emit one logical source, retain **both** document ids
   as duplicate aliases in provenance, and raise a **non-blocking** duplicate-upload diagnostic.
8. **Never infer authority.** Explicitly forbidden discriminators: upload or processing recency,
   presence of `geometry_refs` or richer geometry, extraction completeness, document-id ordering,
   and which copy legacy happened to use.
9. **Emit a blocking duplicate-authority diagnostic** when two or more equally eligible, equally
   authoritative sources remain and identity is either unproven or provably different. The
   diagnostic must name: both document ids, the relationship basis (`attached_to` → contract id),
   the relevant source hashes (including "absent" when the identity store yielded none), and **the
   missing discriminator** — what precedence signal would resolve it.
10. **Fail loudly on identity-store errors (D1).** `loadSourceArtifactSnapshot` must distinguish
   "no artifact recorded" from "artifact store unreadable" instead of swallowing the error into an
   empty snapshot. Source identity is now load-bearing for a blocking decision.
11. **Preserve the existing honest `missing_governing_pricing` block** for genuinely absent source
   data. It remains correct and must not be replaced by the duplicate-authority diagnostic.

### 5.3 Explicitly out of scope

- No change to `lib/canonical/comparison/**` beyond expected test-output updates. In particular the
  comparator must **not** be changed to hide or normalize legacy's 10-row double count — that delta
  is a true finding and must remain visible.
- No Goodlettsville-specific branch, fixture, or fallback.
- No description repair (C4).
- No schema change **except** the P1 duplicate-document vocabulary, which is separately scoped and
  must be approved on its own before it lands.
- No authority cutover. `EIGHTFORGE_PROJECT_TRUTH_AUTHORITY` stays `legacy`;
  `EIGHTFORGE_CANONICAL_AUTHORITY_COMPARE` stays unset.

### 5.4 Reuse point — resolved, and simpler than feared

The 2026-08-06 inspection settles O2: **both price-sheet documents expose
`intelligence_trace.contract_analysis.rate_schedule_rows`, fully anchored** — 5 rows each, every row
carrying `row_id`, non-empty `source_anchor_ids`, `page`, `description`, `category`, `unit`, and
`rate`. The later-processed document additionally carries `geometry_refs`.

This is the **same shape** `buildPersistedContractValidationContextFromTrace` already reads for the
contract document. No converter is required at all:

- The unanchored `typedRowsToRateRows` route is **not needed** and should not be used — the anchor
  loss it would cause is avoidable.
- The fix is to widen the gate at `projectValidator.ts:582` from `isCanonicalContractDocument` to
  the pricing-eligible predicate, and run the existing trace reader per eligible document.
- Evidence identity is preserved by construction, satisfying "preserve each row's original document
  and evidence identity."

`facts.rate_table` carries the same rows (plus `unit_of_measure`) and is what legacy reads. Both
projections originate from the same extraction; canonical should read `contract_analysis`, matching
what the assembler already consumes, so the two authorities stay on one derivation.

---

## 6. Verification plan

Targeted first:

```
npx tsc --noEmit
npx vitest run lib/validator/projectValidator.inputLoading.test.ts lib/validator/projectValidator.retainedInput.test.ts lib/validator/projectValidator.contractTrace.test.ts lib/documentPrecedence.test.ts lib/architecture/importBoundaries.test.ts
npx vitest run lib/canonical/authority lib/canonical/comparison lib/canonical/publication
npm run build
```

`lib/architecture/importBoundaries.test.ts` (`:364`, `:451`, `:607`, `:694`) constrains who may call
the assembler; a per-document invocation loop must stay inside the permitted caller.

Cohort rerun (after C3 **and** C4): MDOT, Goodlettsville, Golden, STL, MVSU, TDOT where applicable.
Verify two-pass byte-identical output, stable delta and group ids, no increase in independent
clearance/exposure/coverage/finding deltas, no source-specific hardcoding.

---

## 7. Open items requiring disposition

| # | Item | Status |
|---|---|---|
| O1 | Scope rule: governing-only vs all eligible non-superseded pricing sources | **Resolved** — all eligible sources (§5.2); premise of the framing corrected by §4 |
| O2 | Do price-sheet traces carry anchored `contract_analysis.rate_schedule_rows`? | **Resolved 2026-08-06** — yes, fully anchored; no converter needed (§5.4) |
| O3 | `voided` handling when unifying relationship normalization | **Resolved** — canonicalization and exclusion state stay separate functions, with a regression test (§5.2 step 1a) |
| O4 | Duplicate-authority behavior | **Resolved** — block unless immutable source identity is proven; never auto-select (§5.2 steps 7–9) |
| **P1** | **No duplicate-document status or relationship exists (§4.5)** | **Open — prerequisite to C3.** Must not be faked with `voided` / `supersedes` / `replaces` |
| **P2** | **`extraction_source_artifacts` is not deployed in this database (§4.4)** | **Open — prerequisite to the non-blocking collapse path.** Migration `20260723163517` unapplied; hashes must also be backfilled |
| **D1** | **`loadSourceArtifactSnapshot` swallows read errors (§4.4)** | **Open — must be fixed in this phase**; identity is now load-bearing for a blocking decision |
| **O5** | **Operator disposition of the Goodlettsville duplicate upload** | **Open — data decision, blocked on P1** |

### Expected Goodlettsville states

| Condition | Canonical result |
|---|---|
| Today — no `extraction_source_artifacts`, identity unproven | **Blocked duplicate authority**, naming both ids, the `attached_to` basis, absent hashes, and the missing discriminator |
| After P2 — identity proven identical | **5 canonical rows** + non-blocking duplicate-upload provenance retaining both document ids |
| After O5 — explicit operator disposition | **5 canonical rows** from the active source; duplicate retained in history |
| Comparator, all cases | canonical 5 vs legacy 10, with legacy's duplicate counting identified as the defective side |

### O5 detail — recommended disposition

Byte identity is established out-of-band (§4.4): both objects hash to
`a9a0e6538426d3f34f0521aeb70f511ce0e5941479b29adb05114e21b641c920`, 825,904 bytes. The disposition
should therefore record **"verified as the same underlying source"**, not "one was uploaded later":

- retain both document records and their full extraction history;
- designate `40a7f15b-6351-41d3-b953-fda41f993df5` (the older upload) as the duplicate /
  non-governing copy;
- retain `e98315b8-2427-432a-ac9b-93be14eed366` as the active document;
- record actor, reason, timestamp, target document, and the duplicate relationship;
- rerun authority resolution after the assertion;
- never delete or rewrite the older document or its extraction history.

The active-copy choice is justified by richer extraction geometry **as an operator's stated reason**.
Code must never make that inference itself (§5.2 step 8). This disposition is blocked on P1: there is
currently no correct status or relationship to record it with.
