# Canonical Interpretation Layer — Architectural Review and Project Facts Pivot

**Review date:** 2026-08-01
**Type:** Read-only architectural review. No production file modified, nothing implemented, no commit, no push, no Phase 2 cutover, no header-classification work.
**Repository truth:** local worktree at HEAD `732139e` including all uncommitted Cycle 9–21 extraction changes and untracked audit reports. GitHub `main` was not used as the source of truth.

---

## 0. Executive conclusion

The pivot is justified and the architecture already contains most of what it needs.

Three findings drive everything below.

1. **Authored-table reconstruction generalization is genuinely blocked, not slow.** Cycle 21 established that every header signal reachable in the current artifact graph has been tested and rejected — value-kind contrast thresholds, body-profile similarity, row height, alignment deviation, and finally adjacent-page structural repetition, which is *anti-correlated* with header-ness on TDOT (13 of 32 candidates change, all 6 real headers lost, 7 prose paragraphs promoted; no threshold in a 100,001-value sweep and no composition survives). The only untested signal family is typography capture at extraction, which is an upstream change with real cost. Waiting for perfect reconstruction before product value is therefore waiting on an open research problem with no scheduled resolution.

2. **The canonical truth contract already exists — designed, typed, persisted, and unused.** `docs/audits/ocr-extraction-generic-architecture-phase-2-2026-07-23.md` defines the invariant (`CanonicalFact` only from `VerifiedField`), `lib/interpretation/canonical/` implements `CanonicalFact` / `DerivedFact` / `HumanAssertion`, and migration `20260723163517_phase3_step0_compliance_foundation.sql` persists all three ledgers plus interpretation snapshots and records. **Nothing in `lib/`, `app/`, or `components/` reads `canonical_document_facts`, `human_fact_assertions`, or `document_interpretation_snapshots`** except a migration test and `lib/interpretation/persistence/freshnessAudit.ts`. The pivot is largely a matter of *connecting* this layer, not designing it.

3. **The layer that product currently ships on is the weakest one.** `ContractPricingAssemblyRow` is a display-shaped struct assembled from a jsonb blob (`documents.intelligence_trace.contract_analysis.rate_schedule_rows`), governed by a category taxonomy and row-count budget derived from one contract (Williamson), with per-document branches for TDOT, MDOT, and Williamson embedded in production selection logic. There is **no persisted contract rate row table anywhere in the schema.**

**Recommendation: pivot, and do it by promoting the existing Interpretation ledgers into the product path rather than by building a new canonical model.** The first slice is a typed `CanonicalPricingLine` domain model plus a pure adapter from `ContractRateScheduleRow`, added as a new section producer for Project Facts, with the existing assembler retained unchanged behind it. No migration, no extraction change, no cutover.

---

## 1. Current architecture map

### 1.1 Layer inventory as built

```
L0  Source bytes / storage                 documents, storage objects
L1  Source observations                    lib/extraction/pdf/*, lib/extraction/xlsx/*
      pdf-parse, pdf.js tokens+geometry, Tesseract OCR words+boxes,
      Unstructured hi_res, vision supplement
L2a Legacy evidence + typed extraction     evidence_v1, document_extractions blob,
      lib/types/documentIntelligence.ts    flattened normalized rows
L2b Generic extraction artifacts (Phase 3) lib/extraction/domain/types.ts
      SourceArtifact → PageArtifact → SourceFragmentArtifact
      → GridCellArtifact → LogicalTableRow → TableSegmentArtifact
      → TableContinuationLink → TableChainArtifact → TableSectionArtifact
      → FieldCandidate → VerifiedField
L3  Interpretation                          lib/interpretation/
      SemanticColumnMapping, CanonicalFact, DerivedFact, HumanAssertion
L3' Legacy "interpretation"                 lib/pipeline/nodes/normalizeNode.ts,
      lib/contracts/analyzeContractIntelligence.ts,
      lib/operationalTables/canonicalOperationalTableRowAssembler.ts
L4  Document view model                     lib/documentIntelligenceViewModel.ts (6195 lines)
      lib/contracts/contractPricingAssembly.ts (2201 lines)
L5  Project truth                           lib/validator/projectValidator.ts (2634)
      lib/validator/shared.ts, lib/documentPrecedence.ts
      → projects.validation_summary_json
L6  Project Facts (consumer projection)     lib/projectFacts.ts (4781 lines)
L7  UI                                      ProjectFactsForge, ValidatorTab, FactLedger,
      EvidenceInspector, ProjectOverview
```

**The critical structural fact:** L2b/L3 (the compliant, evidence-closed path) and L3'/L4/L5 (the shipping path) are **two disjoint pipelines**. They meet nowhere. Everything the user sees today comes from L3'.

### 1.2 The shipping truth path, precisely

```
documents.intelligence_trace (jsonb)
  └─ contract_analysis: ContractAnalysisResult
       └─ rate_schedule_rows: ContractRateScheduleRow[]      ← only home of pricing truth
           ├─→ assembleContractPricingRows()  → ContractPricingAssemblyRow[]   → FactLedger UI
           ├─→ toDocumentContractRateRows()   → DocumentContractRateRow[]      → document detail
           └─→ buildRateScheduleItems()       → RateScheduleItem[]             → validator
                 └─→ billingKeys → reconciliation → ValidationFinding[]
                       └─→ projects.validation_summary_json
                             └─→ resolveCanonicalProjectFacts()  → CanonicalProjectFacts
                                   └─→ resolveCanonicalProjectTruthSections()
                                         → CanonicalProjectTruthRow[]  (value: string)
                                               └─→ ProjectFactsForge
```

Three independent projections of the same rows, each re-deriving category, unit, rate, and confidence with different rules. That is a parallel-truth-path violation under `CLAUDE.md`, currently tolerated because all three read the same jsonb.

### 1.3 Where evidence dies

| Boundary | What survives | What is lost |
|---|---|---|
| OCR → merged layout | text, averaged confidence | per-word confidence, discarded OCR tokens |
| tokens → `PdfTable` cells | text, `x_min`/`x_max` | y bounds, per-cell OCR confidence |
| `PdfTable` → `ContractRateScheduleRow` | `page`, `source_anchor_ids`, optional `geometry_refs`, `raw_cells` | bounding box for most rows |
| `ContractRateScheduleRow` → `ContractPricingAssemblyRow` | `sourceAnchor`, `page`, `geometryRefs`, `mergeDiagnostics` | `source_anchor_ids[1..]`, category resolution reason |
| → `RateScheduleItem` (validator) | `source_document_id`, `record_id` | page, geometry, raw text |
| → `CanonicalProjectTruthRow` | `source_label: string` | **everything** — value is a formatted display string |

`CanonicalProjectTruthRow` is the terminus and it is the flattening the brief warns against: `{ key, label, value: string, source_label: string, state }`. No document id, no page, no box, no evidence handle. `ProjectFactsForge` reconstructs candidate provenance by *guessing* — it filters project documents by `documentDomain(document) === section.key` and synthesizes `FactsForgeCandidate` entries per document (`ProjectFactsForge.tsx:368-420`). That is not traceability; it is a plausible-looking association.

---

## 2. Current-state inventory of canonical models

| Model | Producer | Consumers | Persistence | Source of truth | Overlap | Missing | Source-specific assumptions |
|---|---|---|---|---|---|---|---|
| `CanonicalProjectFacts` (`projectFacts.ts:82`) | `resolveCanonicalProjectFacts` | Ask selectors, ValidatorTab, ProjectOverview, decisionContext, documentIntelligenceViewModel | none (derived from `validation_summary_json`) | validator summary | with `ValidationSummary` (near-isomorphic) | no per-fact provenance; counts + amounts only | none |
| `CanonicalProjectTruthRow` / `…Section` (`:149`,`:157`) | `resolveCanonicalProjectTruthSections` | ProjectFactsForge, ProjectOverview | none | same | with `CanonicalProjectValidatorStatusItem`, `CanonicalProjectOverviewSummaryItem` — three near-identical `{label,value,state}` shapes | evidence, document id, page, confidence, override history | sections fixed to `contract\|invoice\|transaction\|validation` |
| `ContractAnalysisResult` (`contracts/types.ts:294`) | `analyzeContractIntelligence` | validator, view model, decisions, tasks | `documents.intelligence_trace` jsonb | itself | — | rate rows are a bolt-on (`rate_schedule_rows?`) not a modeled family | `document_type_profile` has exactly one value: `fema_disaster_recovery_debris_contract` |
| `ContractFieldAnalysis` (`:277`) | same | contract decisions, coverage | same jsonb | itself | **this is the closest thing to a truth envelope already** — `value`, `state`, `confidence`, `evidence_anchors`, `source_fact_ids`, `pattern_ids`, `notes` | no precedence, no effective period, no operator review, no conflicting-evidence list | field ids are FEMA-debris specific |
| `ContractRateScheduleRow` (`:202`) | `buildContractRateScheduleRows`, `extractExhibitARateTableRows`, TDOT/MDOT builders | assembler, view model, validator | jsonb only | itself | with `ContractPricingAssemblyRow` and `RateScheduleItem` | rate code, currency, effective period, applicability, precedence, governing doc | `source_kind` enumerates two literal documents |
| `ContractPricingAssemblyRow` (`contractPricingAssembly.ts:58`) | `assembleContractPricingRows` | FactLedger, view model | none | derived | as above | same, plus no review state | `ALLOWED_CATEGORIES`, `EXPECTED_CATEGORY_COUNTS`, `PAGE_CATEGORY_EXPECTATIONS` |
| `RateScheduleItem` (`validator/shared.ts:135`) | `buildRateScheduleItems` | reconciliation rules | none | derived | as above | page/geometry | `authoredValueCorrection`, `authored_quarantine` flags carry document-specific meaning |
| `CanonicalOperationalTableRow` (`canonicalOperationalTableRowAssembler.ts:63`) | `assembleCanonicalOperationalTableRows` | normalizeNode (contract + pdf invoice paths) | via trace | itself | **strongest existing canonical row model** — `row_role`, `confidence`, `evidence_refs[]` with page/table/row/cell/geometry/raw_text/field_assigned, `raw_fragments[]`, `warnings`, `confidence_penalties`, `ambiguity_flags` | precedence, effective period, applicability, review state | `source_document_family` string is free-form |
| `CanonicalFact` (`interpretation/canonical/canonicalFact.ts:20`) | `createCanonicalFact` | **none in product** | `canonical_document_facts` | verified fields | — | scalar-only; no row/record concept | none — genuinely generic |
| `DerivedFact` / `HumanAssertion` (`truthRecords.ts`) | — | **none in product** | `derived_document_facts`, `human_fact_assertions` | — | with `DocumentFactOverrideRecord`, `DocumentFactReviewRecord` (the *shipping* override/review path) | — | none |
| `DocumentFactOverrideRecord` / `…ReviewRecord` | override/review routes | `effectiveFacts.ts`, validator fact fan-in | `document_fact_overrides`, `document_fact_reviews` | operator | **duplicates `HumanAssertion`** | supersession chain is `is_active` boolean, not a chain | none |
| `DocumentFact` (`documentIntelligenceViewModel.ts:169`) | view model | document detail UI | none | derived | with everything above | — | — |
| `ResolvedDocumentPrecedenceFamily` (`documentPrecedence.ts:112`) | `resolveDocumentPrecedence` | projectFacts, validator, UI | `documents.*` precedence columns | itself | — | precedence is **document-level only** — no clause-, schedule-, or row-level precedence | families fixed to 5 |
| `ValidationFinding` / `ValidationEvidence` | validator rules | findings UI, decisions, execution | `project_validation_findings`, `…_evidence` | itself | — | evidence points at documents/rows, not at canonical facts | — |
| `InterpretationAssessment` / `SemanticColumnMapping` | `createSemanticColumnMapping` | Step 3 shadow bridge only | `semantic_column_mappings` | verified fields | — | — | none |
| `invoice_line_rate_links` | operator UI | validator matching (`match_source_kind: 'manual_link'`) | own table | operator | **this is the one correctly-modeled cross-layer link** | — | — |

---

## 3. Contract Pricing Assembly audit

### 3.1 Generic vs. hardcoded

| Element | Location | Verdict |
|---|---|---|
| `parseContractPricingRate`, `formatContractPricingRate` | `:151`, `:167` | **generic** — keep in domain |
| `cleanContractRateDescriptionForDisplay` | `:1055` | **generic presentation** — keep, but it belongs in a display adapter, not in canonical assembly |
| `scoreContractPricingRowSourceQuality` | `:982` | **generic** heuristic — keep as extraction quality signal |
| `rowQualityScore` | `:~1590` | **partly generic** — but `pageAllowsCategory` and `description !== 'Raw row needs review'` bake in document assumptions |
| `dedupeKey` / `coverageKey` / `descriptionSlotKey` merge | `:1710-1747` | **generic mechanism**, correct provenance behavior — `mergeDiagnostics` records every loser. Keep and promote. |
| `ContractPricingRowMergeDiagnostic` | `:45` | **exemplary** — this is the pattern the whole canonical layer should follow |
| `ALLOWED_CATEGORIES` | `:102` | **hardcoded taxonomy.** Eight FEMA-debris categories. Any row whose category does not resolve is *dropped* unless `sourceKind === 'canonical'` (`:1758-1768`). |
| `EXPECTED_CATEGORY_COUNTS` | `:115` | **hardcoded, document-derived.** Comment at `:1775` is honest: "derived from the Williamson contract this assembler was built against, not a business rule". Rows beyond the count are demoted to `needs_review` — better than dropping, still a Williamson-shaped prior applied to every contract. |
| `PAGE_CATEGORY_EXPECTATIONS` | `:129` | **hardcoded page numbers 8–11.** Feeds `pageAllowsCategory`, which gates `shouldKeepOperatorRow` (`:1658`) — a row on the "wrong" page is discarded outright. |
| `MANAGEMENT_PREPARATION_DESCRIPTION` | `:126` | authored literal description string |
| `isConfirmedWilliamsonTimeMaterialsRow` | `:1621` | **hardcoded to table ids** `pdf:table:p10:t36`, `p11:t37/38/39` |
| pickup-truck / rate ≠ 25 filter | `:1647-1652` | **hardcoded value rule** |
| TDOT/MDOT all-rows short-circuit | `:1666-1676` | **document-family branch** in the selection path |
| `sourceKind` union | `:7-16` | `tdot_appendix_b_stitched_table`, `mdot_section_905_bid_schedule` — two literal documents named in a domain type |
| `source_kind` / row-id prefix sniffing | `:1266-1271`, `:2015-2082` | **document-family branches** driving rate, route, and preservation |
| Upstream authored builders | `contractRateScheduleRows.ts:67` `TDOT_APPENDIX_B_SPECS`, `:102` `MDOT_SECTION_905_PAGE = 193`, `:104` `MDOT_SECTION_905_BID_SCHEDULE_SPECS` | **authored substitution** — descriptions, units, quantities, rates authored in code, confirmed production-reachable by the Phase 1 audit |
| `authoredRowQuarantine.ts` | whole file | **the correct containment** — it labels authored rows rather than hiding them. Keep and generalize. |
| Route / distance | `route`, `distanceBand` on the row; TDOT-only population at `:2024` | **schema present, generic population absent** |
| Geometry retention | `geometryRefsFromRecord` `:1892`, `normalizeGeometryRefs` `:1919` | **generic and correct** — canonical rows carry `evidence_refs[].geometry`; the Exhibit A / text-recovery paths mostly do not |

Also outside this file but in the same blast radius: `lib/documentIntelligence.ts` contains full Williamson-specific output builders (`buildWilliamsonContractOutput` `:5352`, TDEC permit `:5169`, debris ticket `:5534`, daily ops `:5944`, kickoff checklist `:6126`) selected by `document_type === 'williamson_contract'` or by filename containing `aftermath`/`williamson` (`:6805`). This is a demo path in the production module.

### 3.2 Where each element belongs

| Destination | Contents |
|---|---|
| **Canonical domain model** | rate value + currency, unit, description (raw + normalized), quantity, total, page, evidence refs, source kind *class* (not document name), confidence, conflict state, review state, merge diagnostics, authored-quarantine label |
| **Configurable taxonomy** (org- or contract-scoped data, not code) | category list, subcategory list, category aliases, expected-count priors → advisory only, never a filter |
| **Document-family adapters** (`lib/contracts/adapters/<family>/`) | TDOT Appendix B stitching, MDOT Section 905, Exhibit A recovery, professional-services table, Goodlettsville price sheet, Williamson display correction. Each emits canonical rows carrying `authored_quarantine`. No adapter is reachable from the canonical model. |
| **Extraction heuristics** (`lib/extraction/**`) | OCR text normalization, description token rejoin, table reconstruction, geometry |
| **Fixture-only evaluation** | `EXPECTED_CATEGORY_COUNTS`, `PAGE_CATEGORY_EXPECTATIONS`, `isConfirmedWilliamsonTimeMaterialsRow`, the pickup-truck rule, all page literals |
| **Deprecated** | Williamson builders in `documentIntelligence.ts`; filename/title-based family routing; `document_type_profile` as a single-valued enum |

---

## 4. Project Facts as the umbrella registry — recommendation

**Yes, with one correction to the proposal.** Project Facts should be the canonical truth *registry*, but the current `lib/projectFacts.ts` must not be it. That file is a **projection**, not a registry: it takes `validation_summary_json` and formats it. Making it the umbrella by extension would deepen the flattening problem.

Recommended split:

```
lib/canonical/project/            NEW — typed canonical domain objects
  identity.ts            CanonicalProjectIdentity
  governingDocuments.ts  CanonicalGoverningDocumentSet   (wraps documentPrecedence)
  contractTerms.ts       CanonicalContractTerms          (wraps ContractFieldAnalysisMap)
  scope.ts               CanonicalScopeAndEligibility
  pricing.ts             CanonicalPricingSchedule / CanonicalPricingLine   ◄ first slice
  invoice.ts             CanonicalInvoiceAssembly / CanonicalInvoiceLine
  transactions.ts        CanonicalTransactionAssembly
  support.ts             CanonicalSupportingDocumentation
  reconciliation.ts      CanonicalReconciliation
  validation.ts          CanonicalValidationAndDecisions
  exposure.ts            CanonicalExposureAndReadiness
  envelope.ts            Truth envelope + evidence types
  index.ts               CanonicalProjectTruth = { …sections }

lib/projectFacts.ts               KEEP — becomes the presentation projection:
                                  CanonicalProjectTruth → CanonicalProjectTruthRow[]
```

Domain boundaries, stated precisely:

| Section | Owns | Does **not** own | Grain |
|---|---|---|---|
| Project Identity | project, org, code, agency, contractor identity resolution | contract terms | project |
| Governing Documents | precedence families, governing doc per family, override, reason | anything inside a document | project × family |
| Contract Terms | term, activation, ceiling, authorization, compliance obligations | prices | contract document |
| Scope and Eligibility | services in scope, FEMA eligibility gates, exclusions | applicability of a specific rate | contract document |
| **Contract Pricing Assembly** | rate schedules and their lines | which invoice used them | schedule / line |
| Invoice Assembly | invoices, invoice lines, billed amounts | tickets | invoice / line |
| Transaction Assembly | ticket-grain rows, quantities, extended cost | invoice totals | ticket / row |
| Supporting Documentation | permits, tickets, photos, monitoring records and what they support | eligibility conclusions | document |
| Reconciliation | contract↔invoice, invoice↔transaction, cross-doc rate results | findings | pair |
| Validation and Decisions | findings, decisions, overrides, review state | amounts | finding |
| Exposure and Readiness | at-risk, unsupported, blocked, readiness | why | project / invoice |

Two boundary corrections to the proposed hierarchy:

- **Reconciliation is a derivation, not a section of record.** It should be typed as `DerivedFact`-backed output whose dependencies name the pricing lines, invoice lines, and transaction rows it consumed. Modeling it as a peer section invites it to be edited directly.
- **Exposure and Readiness is a projection of Validation + Invoice.** Same treatment. Keep both in the tree for navigation, but type them as derived.

Three layers must stay distinct, as the brief requires and the current code does not:

1. `CanonicalPricingLine` — typed domain object, no display strings
2. `TruthEnvelope<CanonicalPricingLine>` — resolved state, confidence, precedence, evidence
3. `CanonicalProjectTruthRow` — display projection, produced last, never an input to anything

---

## 5. Canonical truth-envelope design

**Recommendation: one generic envelope, parameterized, with typed *payloads* — not one envelope shape per domain.**

Rationale: `ContractFieldAnalysis` already proves a shared envelope works across eight contract object families with different value types. A per-domain envelope would triple the surface for `state`/`confidence`/`evidence` handling and make cross-section validation (`finding → affected facts`) impossible to type. The risk of over-genericity is contained by making the payload a discriminated union and by keeping *applicability* out of the envelope and inside the pricing payload where it actually belongs.

```ts
type TruthState =
  | 'resolved'            // single governing value, evidence-backed
  | 'derived'             // computed from other truth records
  | 'asserted'            // human assertion is governing
  | 'inherited'           // inherited from schedule/document level
  | 'absent_from_source'  // source read successfully; value not present
  | 'not_applicable'      // dimension does not apply to this row
  | 'unresolved_mapping'  // observed but not mapped to a canonical field
  | 'extraction_conflict' // engines/candidates disagree
  | 'precedence_conflict' // two governing documents disagree
  | 'requires_review';    // any of the above escalated to an operator

type EvidenceRef = {
  document_id: string;
  page: number | null;
  bounding_box: BoundingBox | null;      // lib/extraction/domain/types.ts
  raw_span: string | null;
  extraction_artifact_id: string | null; // FragmentArtifactId / cell id when available
  source_anchor: string | null;          // legacy `pdf:table:pN:tM:rK`
  extractor: 'pdfjs' | 'ocr_fallback' | 'vision' | 'xlsx' | 'typed' | 'authored_adapter';
  recognition_confidence: number | null;
};

type DerivationRef = {
  rule_id: string;
  rule_version: string;
  inputs: readonly TruthDependency[];    // reuse interpretation/canonical/truthRecords.ts
};

type PrecedenceRef = {
  governing_document_id: string;
  family: GoverningDocumentFamily;
  reason: DocumentPrecedenceReason;
  reason_detail: string | null;
  superseded_document_ids: readonly string[];
};

type OperatorReview = {
  status: 'none' | 'pending' | 'confirmed' | 'corrected' | 'rejected';
  actor_id: string | null;
  reason: string | null;
  reviewed_at: string | null;
};

type OverrideEvent = {
  assertion_id: string;
  actor_id: string;
  reason: string;
  asserted_at: string;
  previous_value: unknown;
  supersedes_assertion_id: string | null;
};

type TruthEnvelope<T> = {
  value: T | null;                       // null iff state is a non-value state
  state: TruthState;
  confidence: number | null;             // null when not measurable — never fabricate
  governing_source: EvidenceRef | null;
  supporting_evidence: readonly EvidenceRef[];
  conflicting_evidence: readonly EvidenceRef[];
  derivation: DerivationRef | null;
  precedence: PrecedenceRef | null;
  effective_period: { start: string | null; end: string | null } | null;
  operator_review: OperatorReview;
  override_history: readonly OverrideEvent[];
  authored_quarantine: AuthoredRateRowQuarantine | null;  // existing type, generalized
};
```

Non-negotiables encoded here:

- `state` distinguishes all six absence/conflict cases the brief demands. `value: null` is never ambiguous.
- `confidence: null` is legal and mandatory when no measurement exists. The Phase 1 audit specifically flagged synthetic confidence assignment; the type must not invite it.
- `override_history` is a chain, unlike the current `document_fact_overrides.is_active` boolean.
- Envelopes wrap **fields**, not rows. A pricing line is a record of envelopes, not an envelope around a row — otherwise a single low-confidence unit poisons a confident rate.

---

## 6. Canonical pricing schema

### 6.1 Minimum viable (Phase B target)

Level: **schedule-level** header + **row-level** lines.

```ts
type CanonicalPricingSchedule = {
  schedule_id: string;                  // stable: hash(document_id, schedule_anchor)
  project_id: string;
  governing_document_id: string;
  schedule_label: TruthEnvelope<string>;         // "Exhibit A", "Appendix B", "Section 905"
  currency: TruthEnvelope<'USD'>;                // document-level, inherited by lines
  effective_period: TruthEnvelope<{start,end}>;  // document-level, inherited
  precedence: PrecedenceRef;
  lines: readonly CanonicalPricingLine[];
  coverage: {                                    // honest recovery reporting
    observed_row_count: number;
    published_line_count: number;
    withheld_line_count: number;
    withheld_reasons: readonly string[];
  };
};

type CanonicalPricingLine = {
  line_id: string;                      // stable: hash(schedule_id, source_anchor, ordinal)
  ordinal: number;
  // ── A. Required operator-facing ──
  rate_schedule: TruthEnvelope<string>;          // inherited from schedule
  category:      TruthEnvelope<string>;
  description:   TruthEnvelope<string>;          // raw authored text
  unit:          TruthEnvelope<string>;
  rate:          TruthEnvelope<number>;
  // ── E. Review and uncertainty ──
  row_state: 'published' | 'partial' | 'withheld';
  withheld_field_keys: readonly string[];
  authored_quarantine: AuthoredRateRowQuarantine | null;
  merge_diagnostics: readonly ContractPricingRowMergeDiagnostic[];
};
```

Five operator-facing fields. Everything else is either absent, inherited, or deferred. **No field is filled to satisfy the schema** — every one is an envelope that may legitimately be `absent_from_source`.

### 6.2 Long-term schema

Added incrementally. All optional at the type level; all present in the schema so adapters never invent parallel fields.

| Field | Level | Required | Nullable | Inherited | Derived | Repeatable | Notes |
|---|---|---|---|---|---|---|---|
| `rate_schedule` | row | ✓ | no | ✓ from schedule | | | |
| `category` | row | ✓ | yes (`unresolved_mapping`) | | | | taxonomy-configurable |
| `description` | row | ✓ | no | | | | raw authored text |
| `normalized_description` | row | | yes | | ✓ | | `deriveDescriptionMatchKey` |
| `unit` | row | ✓ | yes | | | | |
| `rate` | row | ✓ | yes (pass-through legitimately has none) | | | | |
| `rate_code` | row | | yes | | | | primary matching key when present |
| `subcategory` | row | | yes | ✓ from section header | | | |
| `material_or_service_type` | row | | yes | | | | |
| `route` | row | | yes | | | | TDOT-shaped today |
| `origin_destination` | row | | yes | | | | |
| `distance_band` | row | | yes | | | ✓ | tiered mileage → repeatable |
| `equipment_type` | row | | yes | | | | |
| `personnel_classification` | row | | yes | | | | |
| `size_or_diameter_band` | row | | yes | | | ✓ | tree/stump bands |
| `pricing_method` | row | | yes | | | | unit_rate / hourly_tm / lump_sum / pass_through / tiered — maps to existing `OperationalTableRowRole` |
| `currency` | document | | no | ✓ | | | default USD, must still be stated |
| `pass_through_treatment` | row | | yes | | | | `isPassThroughAssemblyRow` already detects |
| `markup` | row/schedule | | yes | ✓ | | | |
| `minimum` / `maximum` / `nte` | row/schedule | | yes | ✓ | | | schedule-level NTE inherits |
| `effective_period` | schedule | | yes | ✓ | | | amendments create new periods |
| `applicability_conditions` | row | | yes | | | ✓ | structured predicates, not prose |
| `exclusions` | row/schedule | | yes | ✓ | | ✓ | |
| `governing_document` | schedule | ✓ | no | ✓ | ✓ | | from `documentPrecedence` |
| `precedence` | schedule + row | ✓ | no | ✓ | ✓ | | row-level only when an amendment overrides one line |
| `evidence` | field | ✓ | no | | | ✓ | inside every envelope |
| `conflict_state` | field | ✓ | no | | | | `TruthState` |
| `confidence` | field | ✓ | **yes** | | | | null when unmeasurable |
| `review_state` | field + row | ✓ | no | | | | |

**Row-level precedence is the one genuinely new capability.** Today precedence is document-level only (`documentPrecedence.ts`). An amendment that changes three of ninety rates cannot be represented — the whole amendment either governs or does not. This is a real product gap and belongs in the long-term schema, not the MVP.

---

## 7. Cross-layer mapping model

| Mapping | Current mechanism | Stable key available? | Verdict |
|---|---|---|---|
| contract pricing → invoice line | `deriveBillingRateKey` → `matchRateScheduleItemForInvoiceLine` (`billingKeys.ts:806`) | `rate_code` when present; otherwise `desc:<normalized>` or `sm:<service>\|<material>` | **heuristic**. `rateDescriptionProbablyCode` (`:80`) guesses whether a description *is* a code using length ≤24 and ≤2 segments. Works; not a stable identity. |
| operator-corrected pricing → invoice line | `invoice_line_rate_links` | `(invoice_document_id, invoice_line_subject_id)` → `contract_rate_row_id` | **stable and correct.** This is the model to generalize: an explicit link table with actor, reason, and supersession. |
| invoice line → transaction rows | `matchTransactionRowsForInvoiceGroup` (`:884`) via `invoice_rate_key` = `invoice_number` + `billing_rate_key` | `normalizeInvoiceNumber` + billing key | **heuristic on both axes.** Ticket-grain integrity is separately protected by `ticketGrainKey` / `buildTicketGrainQuantityFacts`. |
| transaction rate code/description → governing contract rate | same billing keys, via `resolveCanonicalRateCategory` | — | **heuristic**, with a confidence floor `MIN_CONFIDENT_CANONICAL_CATEGORY = 0.68` |
| supporting documents → eligibility | `document_relationships` (`supports`, `applies_to`) + `resolveDocumentTruthCategoryIds` | relationship rows | **stable but coarse** — document→document, never document→line |
| validation finding → affected canonical facts | `factKeysForFinding` (`shared.ts:946`) — string fact keys | string keys | **weak.** A finding names fact *keys*, not fact *identities*. Two documents with the same key are indistinguishable. |
| decision/override → resolved truth | `document_fact_overrides.is_active` → `effectiveFacts.ts` fan-in → revalidation | field key | **weak.** Boolean supersession, key-scoped, no chain. `human_fact_assertions` already models this correctly and is unused. |

**Recommended matching model:** three tiers, explicit in the envelope.

1. **Identity** — operator link (`invoice_line_rate_links`) or exact `rate_code` match → `state: 'resolved'`
2. **Deterministic key** — `billing_rate_key` exact → `'resolved'`, confidence from key kind
3. **Heuristic** — description/site-material similarity → `'requires_review'`, never `'resolved'`

Tier 3 is the current default and is silently promoted to resolved. That is the single highest-value correctness change available in the matching layer, and it needs no new extraction.

---

## 8. Evidence and provenance model

Reuse, do not rebuild:

- `BoundingBox` (`extraction/domain/types.ts:45`) — normalized, origin-stamped, rotation-aware. Already correct.
- `OperationalTableRowEvidenceRef` (`canonicalOperationalTableRowAssembler.ts:51`) — carries `field_assigned`, which is exactly the field-level lineage the Phase 1 audit found missing everywhere else. **This is the model.**
- `TruthDependency` (`truthRecords.ts:9`) — discriminated by provenance class. Reuse verbatim for `DerivationRef.inputs`.
- `ContractPricingRowMergeDiagnostic` — record the loser, name the comparison method honestly (`content_key` vs `geometric`). Generalize to all merges.
- `AuthoredRateRowQuarantine` — label authored substitution rather than hide it. Generalize to any adapter-authored value.

Required additions:

- Every `EvidenceRef` must state its `extractor`. Today `authored_adapter` values are indistinguishable from OCR values once they reach `RateScheduleItem`.
- `bounding_box: null` must be legal and visible in the UI as "no box available", never as an absent evidence link.
- Evidence must be attached at **field** granularity. Row-level `source_anchor_ids: string[]` loses which anchor produced the rate versus the description.

---

## 9. Persistence recommendation

**Reuse. Do not migrate for Phase A, B, or C.**

| Need | Existing home | Verdict |
|---|---|---|
| Canonical scalar facts | `canonical_document_facts` + `…_sources` | **reuse.** Built, constrained, RLS'd, unused. |
| Deterministic derivations | `derived_document_facts` + `…_dependencies` | **reuse** |
| Human assertions / overrides | `human_fact_assertions` | **reuse — and retire `document_fact_overrides` into it** once the read path is unified. Not in the first slices. |
| Interpretation snapshot / versioning | `document_interpretation_snapshots` (`interpreter_manifest_hash`, `effective_truth_set_hash`, `output_root_hash`) + `document_interpretation_records` | **reuse.** Versioning and lineage already solved. |
| Extraction artifacts | `extraction_*` (Step 0/1/3) | **reuse** |
| Operator pricing↔invoice links | `invoice_line_rate_links` | **reuse** |
| Transaction rows | `transaction_data_rows` / `…_datasets` | **reuse** |
| Validation | `project_validation_runs/findings/evidence/rule_state` | **reuse** |
| **Pricing lines** | **nothing** | **the one real gap** |

Pricing lines live only in `documents.intelligence_trace.contract_analysis.rate_schedule_rows` (jsonb) and are re-derived on every read by three different assemblers.

Recommendation, staged:

- **Phases A–C: no migration.** Compute `CanonicalPricingSchedule` from the existing jsonb at read time. This proves the domain model against real documents before any schema commitment.
- **Phase D, only if Phase C demonstrates need:** normalize pricing lines. Two candidates:
  - *Preferred:* represent each pricing line as rows in `canonical_document_facts` keyed `pricing.line.<line_id>.<field>`, with `canonical_document_fact_sources` carrying the verified-field lineage. Zero new tables, full reuse of the constraint and RLS work, automatic participation in interpretation snapshots. Cost: querying a schedule means pivoting facts.
  - *Alternative:* a `canonical_pricing_lines` table with normalized columns for the five MVP fields plus a `dimensions jsonb` for the conditional block, FK'd to `document_interpretation_snapshots`. Cheaper to query, new RLS/constraint surface.
- **JSON vs normalized:** normalize the five operator-facing fields and the state/confidence columns (they are filtered and joined). Keep conditional dimensions, applicability predicates, exclusions, and evidence arrays as jsonb — they are sparse, heterogeneous, and read whole.
- **Versioning / effective dating:** already solved by `document_interpretation_snapshots`. Effective *business* dating (amendment periods) is a schedule column, distinct from snapshot versioning. Do not conflate them.
- **Review/override persistence:** `human_fact_assertions` with its supersession chain. Do not extend `document_fact_overrides`.

---

## 10. UI recommendation

Principle: **simple canonical field on the surface; full envelope one interaction away.** The `EvidenceInspector` / `evidenceInspectorModel` pair already exists and is used by both `ProjectFactsForge` and `ValidatorEvidenceDrawer` — extend it rather than adding a second inspector.

| Surface | Shows | Inspect reveals |
|---|---|---|
| **Project Facts** | one row per canonical field: label, value, state chip, governing document | authored value, page + box thumbnail, precedence chain, inherited-from, conflicts, review history |
| **Contract Pricing section** (new) | the five-column operator table: Rate Schedule / Category / Description / Unit / Rate | conditional dimensions actually present; withheld-field list; `merge_diagnostics` losers; authored-quarantine banner |
| **Document detail** | assembled lines for that document with per-row state | the same envelope, plus source-kind and extractor |
| **Validator** | findings referencing canonical field ids, not just fact key strings | jump to the exact envelope that produced the finding |
| **Evidence drawer** | governing evidence first; conflicting evidence adjacent, not hidden | raw span, box, extractor, recognition confidence, "no box available" when null |
| **Audit** | append-only assertion chain per field | actor, reason, timestamp, superseded value |
| **Correction workflow** | correct one field, not one row | writes a `HumanAssertion`; triggers targeted revalidation |

Three specific corrections to current UI behavior:

1. `ProjectFactsForge` must stop synthesizing candidate documents by domain filter (`:368-420`). Candidates must come from the envelope's `supporting_evidence` / `conflicting_evidence`.
2. `absent_from_source`, `not_applicable`, and `unresolved_mapping` must render differently. Today all three collapse into "Missing" (`truthStateLabel`), which tells the operator nothing about whether to go look.
3. `withheld_component_count` / `row_kind_uncertain` (Cycle 16) already exist on the extraction artifact and must reach the UI as "this row is incomplete", rather than being invisible as they are today.

---

## 11. Implementation phases

| Phase | Goal | Files | DB | Tests | Fixtures | Acceptance | Rollback |
|---|---|---|---|---|---|---|---|
| **A — Canonical domain contract** | Types + envelope only. No behavior. | new `lib/canonical/project/{envelope,pricing,index}.ts` | none | type-level + envelope-state unit tests | none | `tsc --noEmit` clean; nothing imports it yet | delete directory |
| **B — Pricing normalization** | Pure adapter `ContractRateScheduleRow[] → CanonicalPricingSchedule`. Existing assembler untouched. | new `lib/canonical/project/pricingAdapter.ts` | none | adapter unit tests; parity test asserting the five MVP fields match `assembleContractPricingRows` on every fixture | Goodlettsville PDF (in repo), TDOT/MDOT/Williamson trace JSON | all 82 existing `contractPricingAssembly.test.ts` cases still pass unchanged; adapter reproduces their operator-facing fields | delete adapter |
| **C — Project Facts integration** | Add a `pricing` section to `CanonicalProjectTruthSection`, sourced from B, rendered in `ProjectFactsForge` behind a section flag | `projectFacts.ts` (additive), `ProjectFactsForge.tsx`, `projectOverview.ts` | none | `projectFacts.test.ts` additions; snapshot of the new section | as B | operator sees Rate Schedule / Category / Description / Unit / Rate with real evidence links; existing four sections byte-identical | remove section from the array |
| **D — Invoice/transaction alignment** | Same envelope for invoice lines and transaction rows; three-tier matching with heuristics forced to `requires_review` | `lib/canonical/project/{invoice,transactions}.ts`, `billingKeys` consumers | none | matching-tier tests; ticket-grain integrity tests must not move | existing transaction fixtures | no ticket-grain quantity changes; heuristic matches no longer report `resolved` | revert tier gating |
| **E — Validator consumption** | Findings reference canonical field ids; validator reads `CanonicalPricingSchedule` instead of re-deriving `RateScheduleItem` | `projectValidator.ts`, `validator/shared.ts`, rule modules | none | full validator suite; golden suites | golden anchors 74,617 CYD / $815,559.35 | golden anchors preserved; finding counts unchanged or explained | keep `buildRateScheduleItems` as the fallback path |
| **F — Correction and audit** | Field-level correction writing `HumanAssertion`; retire `document_fact_overrides` reads | `documentFactOverrides.ts`, `effectiveFacts.ts`, correction routes | **backfill** overrides → `human_fact_assertions` | dual-read parity tests | — | every existing override resolves identically through the new path | dual-read; flip back to overrides |
| **G — Resume reconstruction research** | Typography capture at extraction (the one untested signal, per Cycle 21) | `documentExtraction.ts:735-751`, fragment schema | id rotation only | TDOT-first calibration, synthetics second | new held-out source (C and D burned) | TDOT 0 changed records of 288 | freeze restore, per Cycle 16 §20 |

Phases A–C deliver operator-visible value with **zero database change, zero extraction change, and zero risk to the frozen extraction baseline.**

---

## 12. Exact first implementation slice

**Slice: `CanonicalPricingLine` domain model + pure adapter + parity test. Nothing wired to the UI.**

Scope, precisely:

1. Create `lib/canonical/project/envelope.ts` — `TruthState`, `EvidenceRef`, `DerivationRef`, `PrecedenceRef`, `OperatorReview`, `OverrideEvent`, `TruthEnvelope<T>`, and constructors `resolved()`, `absent()`, `notApplicable()`, `unresolvedMapping()`, `conflicted()`, `requiresReview()`. Constructors only — no inference.
2. Create `lib/canonical/project/pricing.ts` — `CanonicalPricingSchedule`, `CanonicalPricingLine` with the five MVP fields plus `row_state`, `withheld_field_keys`, `authored_quarantine`, `merge_diagnostics`, `coverage`.
3. Create `lib/canonical/project/pricingAdapter.ts` — `toCanonicalPricingSchedule(rows: readonly ContractRateScheduleRow[], context: { projectId, documentId, precedence }): CanonicalPricingSchedule`. Pure. Maps `page`/`source_anchor_ids`/`geometry_refs`/`raw_cells` into `EvidenceRef[]`; maps `confidence`/`category_resolution_status`/`category_requires_review` into `TruthState`; maps `authoredValueCorrection` and `authoredRowQuarantine` classification into `authored_quarantine`. **A row whose category does not resolve becomes `unresolved_mapping`, not a dropped row** — this is the first behavioral improvement, and it is contained inside a new unwired module.
4. Do **not** touch `contractPricingAssembly.ts`, `analyzeContractIntelligence.ts`, `projectValidator.ts`, `projectFacts.ts`, or any component.

Why this slice: it is additive and unreachable from production, it forces the envelope design to survive contact with the four real document families, and its parity test produces the concrete evidence needed to decide Phase C — namely, how many rows the current assembler drops that the canonical model would surface as `unresolved_mapping`.

### 12.1 Files likely to change

**New (3):**
- `lib/canonical/project/envelope.ts`
- `lib/canonical/project/pricing.ts`
- `lib/canonical/project/pricingAdapter.ts`

**New tests (2):**
- `lib/canonical/project/envelope.test.ts`
- `lib/canonical/project/pricingAdapter.test.ts`

**Read-only imports (0 modifications):** `lib/contracts/types.ts`, `lib/contracts/authoredRowQuarantine.ts`, `lib/extraction/domain/types.ts` (`BoundingBox`), `lib/extraction/tableGeometry.ts`, `lib/documentPrecedence.ts`, `lib/interpretation/canonical/truthRecords.ts`.

**Modified production files: none.**

### 12.2 Tests and fixtures required

| Test | Asserts |
|---|---|
| envelope constructor tests | each `TruthState` is reachable only via its constructor; `value` is null for every non-value state; `confidence: null` round-trips and is never defaulted to 0 or 1 |
| adapter — Goodlettsville price sheet | uses `lib/contracts/__fixtures__/goodlettsville_price_sheet.pdf`; every published line carries ≥1 `EvidenceRef` with a non-null page |
| adapter — TDOT Appendix B | stitched rows carry `authored_quarantine` with reason; `route` populated; `extractor: 'authored_adapter'` |
| adapter — MDOT Section 905 | same, page 193 |
| adapter — Williamson Exhibit A | the display-corrected rows (`18.80→13.50` etc.) surface as `authored_quarantine`, not as clean values; `merge_diagnostics` preserved |
| **parity test** | for every fixture, the five MVP fields of each adapter line equal the corresponding `assembleContractPricingRows` output field, **and** the count of `unresolved_mapping` lines is recorded as a named number (the recovery delta) |
| determinism | two adapter runs over the same input are deeply equal |

Fixtures needed beyond the repo: TDOT/MDOT/Williamson `intelligence_trace.contract_analysis.json` extracts. The TDOT one exists at the artifact root recorded in Cycle 21 §4 (`…\Desktop\EightForgeDocTrainning\Training Projects\TDOT\phase3-step4-artifacts\tdot-89633\v1.0.0-draft\exports\…\intelligence_trace.contract_analysis.json`). MDOT and Williamson equivalents must be located or exported before the slice can claim four-family coverage; if only TDOT and Goodlettsville are available, say so and scope the parity claim to two families rather than asserting four.

---

## 13. Risks

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| 1 | A third pricing model is added and the existing three are never retired — four parallel truth paths instead of three | **high** | The parity test is the retirement contract. Phases D/E must *delete* `buildRateScheduleItems`' independent derivation, not add beside it. Make retirement an explicit acceptance criterion, not a follow-up. |
| 2 | Surfacing `unresolved_mapping` rows floods the operator with OCR noise the assembler currently filters | **high** | The recovery delta is measured in the first slice *before* anything is wired. Phase C ships only if the delta is operator-tolerable; otherwise keep the filter and mark filtered rows `requires_review` with a count, not a list. |
| 3 | Envelope-per-field balloons payload size on documents with hundreds of rate rows | medium | Envelopes are computed, not stored, in A–C. Measure at Phase C; `ProjectOverview` already has a documented render-stall history (`docs/audits/overview-render-stall-profile-*`). |
| 4 | Retiring `document_fact_overrides` for `human_fact_assertions` loses operator corrections | **high** | Phase F only; dual-read with parity assertions before any write cutover; backfill is additive. |
| 5 | Touching `projectValidator.ts` moves golden anchors (74,617 CYD, $815,559.35) | **high** | Phase E gated on golden suites; keep the legacy derivation as fallback until parity holds across all fixtures. |
| 6 | Work on the canonical layer is mistaken for permission to resume extraction changes and voids the Cycle 16/21 freeze | medium | Phases A–F touch no file under `lib/extraction/domain/`. State this as a hard boundary. Freeze fingerprint (Cycle 16 §2, seal `6883ebb0…`) must be re-verified before Phase G. |
| 7 | Category taxonomy becomes configurable and orgs configure it inconsistently, breaking `billingKeys` matching | medium | Taxonomy keys (`canonicalTaxonomyKeyForAllowedCategory`) stay a closed set; only labels and aliases are configurable. |
| 8 | Row-level precedence is designed but no source document exercises it | low | Defer to long-term schema; do not build until a real amendment fixture exists. |
| 9 | Confidence numbers get invented to populate the envelope | medium | `confidence: null` is legal and must be exercised by a test. The Phase 1 audit already caught synthetic confidence assignment once. |
| 10 | Williamson demo builders in `documentIntelligence.ts` keep shipping and quietly satisfy fixtures the canonical path would otherwise fail | medium | Inventory them as deprecated in Phase A; do not remove during A–C (removal is its own measured change). |

---

## 14. Open decisions requiring product-owner input

1. **Recovery vs. precision on the operator table.** If the canonical adapter surfaces, say, 40 additional `unresolved_mapping` rows per contract that the current assembler drops — is that a feature (nothing hidden) or a regression (noise)? This determines whether Phase C ships behind a toggle. *Not answerable from code.*
2. **Does the five-column operator standard mean five columns, or five columns plus per-row conditional dimensions on expand?** Affects whether `route`, `distance_band`, and `size_band` need Phase C population or can wait.
3. **Is `EXPECTED_CATEGORY_COUNTS` ever a real business rule for any customer**, or purely a Williamson artifact? If purely artifact, it moves to fixture-only in Phase B rather than becoming configurable.
4. **Authored TDOT/MDOT rows: keep, quarantine-and-show, or remove?** They are production-reachable authored substitutions. The canonical layer can label them (`authored_quarantine`), but whether a labeled authored rate may still drive validation and approval is a product/compliance call, not an engineering one.
5. **Which document families must Phase C support at launch?** Four families are named in the brief; only Goodlettsville has an in-repo PDF fixture and only TDOT has a verified artifact root. Scope depends on what can actually be exercised.
6. **Row-level precedence: needed now?** No current fixture has a partial-amendment rate override. Building it speculatively is schema risk.
7. **Retirement schedule for the Williamson builders in `documentIntelligence.ts`.** They are demo-shaped and reachable by filename. Removing them will change output for any document named `aftermath`/`williamson`.
8. **Should `document_fact_overrides` be retired at all**, given it works? The duplication with `human_fact_assertions` is real but the migration is the riskiest item in the plan.

---

## 15. Final recommendation

**Pivot. Build the canonical interpretation layer on top of the existing Interpretation ledgers, and treat generic extraction as an interchangeable candidate producer beneath it.**

Concretely:

- **Adopt** `TruthEnvelope<T>` as one generic envelope with typed payloads. `ContractFieldAnalysis` already proves the shape works; typed per-domain envelopes would make cross-section traceability untypeable.
- **Make Project Facts the umbrella registry**, but split it: `lib/canonical/project/*` holds typed domain objects and resolved truth; `lib/projectFacts.ts` is demoted to the display projection it already is. Never let `CanonicalProjectTruthRow` be an input.
- **Start with pricing**, because it is the section with the clearest operator value, the worst current modeling, and no persistence commitment to unwind.
- **Reuse persistence.** `canonical_document_facts`, `derived_document_facts`, `human_fact_assertions`, `document_interpretation_snapshots/records`, `extraction_*`, and `invoice_line_rate_links` are built, constrained, RLS'd, and idle. Propose no migration for Phases A–C.
- **Contain the hardcoding rather than removing it now.** TDOT/MDOT/Williamson/Exhibit A move behind document-family adapters that emit canonical rows carrying `authored_quarantine`. The canonical model never names a document. Removal is a later, separately measured change.
- **Preserve the reconstruction work by contract, not by promise.** The canonical layer consumes `ContractRateScheduleRow` (today) and `LogicalTableRow` / `VerifiedField` (later) through the *same* adapter interface. Better candidates — from typography capture, from ForgeWing assistance, from a future header classifier — change only which adapter runs and how `confidence` and `state` are populated. `CanonicalPricingLine`, the envelope, the Project Facts hierarchy, the validator contract, and the UI do not change. That is the property that makes it safe to ship product value now and resume the research later.
- **Honor the freeze.** Phases A–F touch no file under `lib/extraction/domain/`. Cycle 16's fingerprint and Cycle 21's TDOT baseline (0 changed records of 288) must be re-verified before any Phase G work begins.

The first slice is three new files and two new tests, imports nothing into production, and produces the one number the rest of the plan depends on: how many pricing rows the current assembler is discarding.

---

## Repository state

HEAD `732139e`. Read-only review. No production file modified. No commit, no push. Phase 2 `not_ready`. No cutover. No header-classification experimentation. Synthetic E not designed or generated.
