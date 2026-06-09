# Validator Integration Audit — Decision Assertion Insertion Points

**Phase:** A (read-only audit)
**Branch:** feat/WorkHereOnly
**Date:** 2026-06-09
**Scope:** Where decision assertion evaluation plugs into the existing validator codebase
**Output of:** Phase A audit; no implementation code written

---

## 1. Finding Generation Points Inventory

All `makeFinding()` call sites across the validator rule packs, ordered by execution sequence in `projectValidator.ts`.

> **Legend:** Det = Deterministic | Inf = Inference-based | Quasi = Severity or condition is inference-dependent

### 1.1 `lib/validator/exposure.ts`

Called by `evaluateProjectExposure()`, which runs both when required-sources block AND at the end of the full pack sequence.

| Line | Finding Type | Subject Type | Severity | Det? |
|------|-------------|--------------|----------|------|
| 884 | `INVOICE_BILLED_TOTAL_PRESENT_FOR_EXPOSURE` | `invoice` | warning | Det |
| 929 | `INVOICE_EXPOSURE_SUPPORTED_AMOUNT_MATCHES_BILLED` | `invoice` | critical | Det |
| 969 | `INVOICE_EXPOSURE_AT_RISK_AMOUNT_ZERO` | `invoice` | critical | Det |
| 1002 | `PROJECT_EXPOSURE_SUPPORTED_AMOUNT_MATCHES_BILLED` | `project` | critical | Det |
| 1033 | `PROJECT_EXPOSURE_AT_RISK_AMOUNT_ZERO` | `project` | critical | Det |

### 1.2 `lib/validator/rulePacks/requiredSources.ts`

Run first by `validateProject()`; blocking findings here short-circuit all downstream packs.

| Line | Finding Type | Subject Type | Severity | Det? |
|------|-------------|--------------|----------|------|
| 53 | `SOURCES_NO_CONTRACT` | `project` | critical | Det |
| 85 | `SOURCES_NO_RATE_SCHEDULE` | `project` | critical | Det |
| 114 | `SOURCES_NO_INVOICE_DATA` | `project` | critical | Det |
| 141 | `SOURCES_NO_TICKET_DATA` | `project` | critical | Det |

### 1.3 `lib/validator/rulePacks/identityConsistency.ts`

| Line | Finding Type | Subject Type | Severity | Det? |
|------|-------------|--------------|----------|------|
| 132 | `IDENTITY_PROJECT_CODE_MISMATCH` | `project_code` | critical | Det |
| 180 | `IDENTITY_PARTY_NAME_INCONSISTENCY` | `contractor_name` | warning | Det (fuzzy-normalized threshold) |
| 228 | `IDENTITY_DUPLICATE_TICKET` | `mobile_ticket` | critical | Det |

### 1.4 `lib/validator/rulePacks/contractInvoiceReconciliation.ts`

| Line | Finding Type | Subject Type | Severity | Det? |
|------|-------------|--------------|----------|------|
| 767 | `FINANCIAL_INVOICE_VENDOR_MATCHES_CONTRACT_CONTRACTOR` | `invoice` | critical | Det |
| 818 | `FINANCIAL_INVOICE_CLIENT_MISSING_FOR_CONTRACT_COMPARISON` | `invoice` | warning | Det |
| 851 | `FINANCIAL_INVOICE_CLIENT_MATCHES_CONTRACT_CLIENT` | `invoice` | critical | Det |
| 899 | `FINANCIAL_INVOICE_SERVICE_PERIOD_MISSING` | `invoice` | warning | Det |
| 949 | `FINANCIAL_INVOICE_SERVICE_PERIOD_WITHIN_CONTRACT_TERM` | `invoice` | critical | Det |
| 1004 | `FINANCIAL_INVOICE_TOTAL_RECONCILES_TO_LINE_ITEMS` | `invoice` | critical | Det |
| 1066 | `FINANCIAL_INVOICE_LINE_CODE_EXISTS_IN_CONTRACT` | `invoice_line` | critical | Det |
| 1111 | `FINANCIAL_INVOICE_UNIT_PRICE_MATCHES_CONTRACT_RATE` | `invoice_line` | critical | Det |

### 1.5 `lib/validator/rulePacks/invoiceTransactionReconciliation.ts`

| Line | Finding Type | Subject Type | Severity | Det? |
|------|-------------|--------------|----------|------|
| 948 | `INVOICE_LINE_REQUIRES_BILLING_KEY` | `invoice_line` | critical | Det |
| 1008 | `INVOICE_DUPLICATE_BILLED_LINE` | `invoice_line` | critical | Det |
| 1079 | `TRANSACTION_GROUP_EXISTS_FOR_INVOICE_LINE` | `invoice_line` | critical | Det |
| 1137 | `TRANSACTION_TOTAL_MATCHES_INVOICE_LINE` | `invoice_line` | critical | Det |
| 1194 | `TRANSACTION_QUANTITY_MATCHES_INVOICE` | `invoice_line` | critical | Det |
| 1264 | `TRANSACTION_RATE_OUTLIERS` | `invoice_line` | warning | Det |
| 1329 | `TRANSACTION_MISSING_INVOICE_LINK` | `transaction` | warning | Det |
| 1393 | `SITE_MATERIAL_ANOMALIES` | `invoice_line` group | warning | **Inf** (multi-site pattern) |

### 1.6 `lib/validator/rulePacks/crossDocumentRateVerification.ts`

All generated via `findingForUnit()` dispatcher at line 572; line numbers below are the branch arms.

| Line | Finding Type | Subject Type | Severity | Det? |
|------|-------------|--------------|----------|------|
| 589 | `CROSS_DOCUMENT_RATE_MATCHES_CONTRACT` | `invoice_line` | critical | Det (delta > 0.01) |
| 594 | `CROSS_DOCUMENT_CANONICAL_CATEGORY_ALIGNS` | `invoice_line` | critical | **Inf** (taxonomy alignment) |
| 599 | `CROSS_DOCUMENT_CONTRACT_RATE_EXISTS` | `invoice_line` | critical | Det |
| 604 | `CROSS_DOCUMENT_TICKET_SUPPORT_EXISTS` | `invoice_line` | warning | Det |
| 609 | `CROSS_DOCUMENT_INVOICE_WORK_SUPPORTED` | `invoice_line` | critical | Det |
| 614 | `CROSS_DOCUMENT_CATEGORY_NEEDS_REVIEW` | `invoice_line` | warning | **Inf** (unresolved taxonomy) |

### 1.7 `lib/validator/rulePacks/financialIntegrity.ts`

Calls `runRateBasedContractValidationRules()` internally first (section 1.8).

| Line | Finding Type | Subject Type | Severity | Det? |
|------|-------------|--------------|----------|------|
| 288 | `FINANCIAL_RATE_CODE_MISSING` | `invoice_line` | info/warning | **Quasi** (severity from `isRateCodeMissingInformational()`) |
| 343 | `FINANCIAL_UNIT_TYPE_MISMATCH` | `invoice_line` | critical | Det |
| 384 | `FINANCIAL_NTE_FACT_MISSING` | `project` | info | Det |
| 418 | `FINANCIAL_NTE_EXCEEDED` | `project` | critical | Det |
| 439 | `FINANCIAL_NTE_APPROACHING` | `project` | info | Det |

### 1.8 `lib/validator/rulePacks/rateBasedContractValidation.ts`

Only runs when `contractCeilingType === 'rate_based'`.

| Line | Finding Type | Subject Type | Severity | Det? |
|------|-------------|--------------|----------|------|
| 313 | `FINANCIAL_RATE_BASED_SCHEDULE_REQUIRED` | `contract` | critical | Det |
| 350 | `FINANCIAL_RATE_BASED_ROWS_REQUIRED` | `contract` | critical | Det (row count < 5) |
| 375 | `FINANCIAL_RATE_BASED_PAGES_REQUIRED` | `contract` | critical | Det |
| 417 | `FINANCIAL_RATE_BASED_PRICING_APPLICABILITY_UNCLEAR` | `project` | warning | **Inf** (AI pricing model) |
| 452 | `FINANCIAL_RATE_BASED_UNIT_COVERAGE_INCOMPLETE` | `project` | warning | **Inf** (unit taxonomy) |
| 505 | `FINANCIAL_RATE_BASED_ACTIVATION_GATE_UNRESOLVED` | `project` | warning | **Inf** (activation analysis) |

### 1.9 `lib/validator/rulePacks/ticketIntegrity.ts`

| Line | Finding Type | Subject Type | Severity | Det? |
|------|-------------|--------------|----------|------|
| 141 | `TICKET_QTY_CYD_MISMATCH` | `mobile_ticket` | critical | Det (variance > tolerance) |
| 184 | `TICKET_QTY_TONNAGE_MISMATCH` | `mobile_ticket` | critical | Det |
| 228 | `TICKET_MATERIAL_MISMATCH` | `mobile_ticket` | warning | Det |
| 269 | `TICKET_DISPOSAL_SITE_MISMATCH` | `mobile_ticket` | warning | Det |
| 306 | `TICKET_ORPHANED_LOAD` | `load_ticket` | warning | Det |

**Total: 43 finding types across 9 source files.**
Deterministic: 34 | Inference-based: 6 | Quasi-inference: 1 | Unknown at this audit: 2 (exposure findings depend on computed summaries)

---

## 2. Context Availability Map

`ProjectValidatorInput` is the single context object passed to every rule pack. All fields listed below are available at every `makeFinding()` call site unless noted.

### 2.1 Available fields at all finding generation points

| `FindingEvaluationContext` Field | Source in `ProjectValidatorInput` | Notes |
|---|---|---|
| `project_id` | `input.project.id` | Always present |
| `contract_id` | `input.factLookups.contractDocumentId` | May be `null` if no contract document; that itself triggers `SOURCES_NO_CONTRACT` |
| `contract_vehicle_id` | Not a direct field — derivable from `input.contractValidationContext.document_id` | Gap: no dedicated field; requires additional lookup |
| `subject_entity_type` | Passed as `subjectType` to `makeFinding()` | Always present at call site |
| `subject_entity_id` | Passed as `subjectId` to `makeFinding()` | Always present at call site |
| `contract_ceiling_type` | `input.factLookups.contractCeilingType` | `'rate_based'` \| `'lump_sum'` \| other string \| `null` |
| `rate_schedule_items` | `input.factLookups.rateScheduleItems` | Full array of `RateScheduleItem`; used for `contract_has_codes` derivation |
| `rate_units_detected` | `input.factLookups.rateUnitsDetected` | String array; empty if no rate units |
| `nte_amount` | `input.factLookups.nteFact?.value` | `null` if no NTE extracted |
| `validation_phase` | `input.validationPhase` | One of `'contract_setup' \| 'execution' \| 'billing_review' \| 'closeout'` |

### 2.2 Per-subject available fields and gaps

| Finding Type Group | `invoice_id` Available? | `invoice_line_id` Available? | `contract_has_codes` Derivable? | Gaps |
|---|---|---|---|---|
| `SOURCES_*` (project subject) | ✗ No invoice loaded | ✗ | Partially — `rateScheduleItems.length > 0` | `invoice_id` absent; `contract_id` may be null (the whole point of the finding) |
| `IDENTITY_*` (project/ticket subject) | ✗ | ✗ | Yes | `invoice_id` absent |
| `FINANCIAL_RATE_BASED_*` (contract/project subject) | ✗ | ✗ | Yes | `invoice_id` absent |
| `FINANCIAL_INVOICE_*` (invoice subject) | ✓ `subject_id` = invoice id | ✗ | Yes | None significant |
| `FINANCIAL_INVOICE_LINE_*` (invoice_line subject) | ✓ via `readRowString(line, ['invoice_id'])` | ✓ `subject_id` = line id | Yes | `invoice_id` requires lookup from line row |
| `FINANCIAL_NTE_*` (project subject) | ✗ | ✗ | Yes | `invoice_id` absent |
| `INVOICE_*` (invoice_line subject) | ✓ via line row | ✓ | Yes | `invoice_id` requires lookup from line row |
| `TRANSACTION_*` (invoice_line/transaction subject) | ✓ via line row | ✓ | Yes | `invoice_id` requires lookup |
| `CROSS_DOCUMENT_*` (invoice_line subject) | ✓ via line row | ✓ | Yes | `invoice_id` requires lookup |
| `TICKET_*` (mobile_ticket/load_ticket subject) | ✗ | ✗ | Yes | `invoice_id` absent; `contract_id` present |
| `SITE_MATERIAL_ANOMALIES` (invoice_line group) | ✓ | ✓ | Yes | None significant |
| `*_EXPOSURE_*` (project/invoice subject) | ✓ for invoice-level findings | ✗ | Yes | Computed from rolled-up summaries; `invoice_id` is `subject_id` |

### 2.3 `contract_has_codes` derivation

Not a precomputed field. At any rule pack call site it is derivable as:

```
input.factLookups.rateScheduleItems.some(item => item.rate_code != null)
|| input.factLookups.contractCeilingType === 'rate_based'
```

This derivation is safe and deterministic. It should be computed once and passed into any `FindingEvaluationContext` constructor rather than re-derived inside each call.

### 2.4 Summary of gaps

1. **`invoice_id` for project-subject and ticket-subject findings** — not available. Assertions keyed on invoice cannot be matched to `SOURCES_*`, `FINANCIAL_NTE_*`, `FINANCIAL_RATE_BASED_*`, or `TICKET_*` findings.
2. **`contract_vehicle_id`** — not a first-class field in `ProjectValidatorInput`; must be resolved via `contractValidationContext.document_id`.
3. **`contract_has_codes`** — derivable but not precomputed; needs a shared builder.
4. **`invoice_id` for invoice_line-subject findings** — present in the line row but requires an explicit lookup; not passed to `makeFinding()` directly.

---

## 3. Assertion Query Insertion Points

For each finding type, the recommended location for a `resolveAssertionsForFinding()` call.

**PRE_FINDING:** Assertion check runs between the `isRuleEnabled()` guard and `makeFinding()`. A matching assertion suppresses the finding entirely — `makeFinding()` is never called.

**POST_FINDING:** Assertion check runs after `makeFinding()` returns the finding but before it is pushed to `findings[]`. A matching assertion can override `finding_disposition`, override `status` to `resolved`, or escalate to `requires_review`.

### 3.1 Insertion classification table

| Finding Type | File | Line | Insertion Type | Rationale |
|---|---|---|---|---|
| `SOURCES_NO_CONTRACT` | requiredSources.ts | 51–77 | **POST_FINDING only** | Blocking; suppression would mask a real gap; only disposition can be adjusted |
| `SOURCES_NO_RATE_SCHEDULE` | requiredSources.ts | 79–108 | **POST_FINDING only** | Same — blocking finding |
| `SOURCES_NO_INVOICE_DATA` | requiredSources.ts | 110–139 | **POST_FINDING only** | Blocking |
| `SOURCES_NO_TICKET_DATA` | requiredSources.ts | 141–171 | **POST_FINDING only** | Blocking |
| `IDENTITY_PROJECT_CODE_MISMATCH` | identityConsistency.ts | 131–158 | **PRE_FINDING** | Deterministic; operator decision can pre-confirm ticket code mapping |
| `IDENTITY_PARTY_NAME_INCONSISTENCY` | identityConsistency.ts | 179–207 | **PRE_FINDING** | Deterministic; operator decision can pre-confirm contractor alias |
| `IDENTITY_DUPLICATE_TICKET` | identityConsistency.ts | 227–255 | **POST_FINDING only** | Duplicate ticket is an audit fact; must remain visible even if actioned |
| `FINANCIAL_INVOICE_VENDOR_MATCHES_CONTRACT_CONTRACTOR` | contractInvoiceReconciliation.ts | 767 | **PRE_FINDING** | Operator can assert contractor name equivalence |
| `FINANCIAL_INVOICE_CLIENT_MISSING_FOR_CONTRACT_COMPARISON` | contractInvoiceReconciliation.ts | 818 | **PRE_FINDING** | Operator can assert client identity is known |
| `FINANCIAL_INVOICE_CLIENT_MATCHES_CONTRACT_CLIENT` | contractInvoiceReconciliation.ts | 851 | **PRE_FINDING** | Operator can assert client equivalence |
| `FINANCIAL_INVOICE_SERVICE_PERIOD_MISSING` | contractInvoiceReconciliation.ts | 899 | **PRE_FINDING** | Operator can assert period is known |
| `FINANCIAL_INVOICE_SERVICE_PERIOD_WITHIN_CONTRACT_TERM` | contractInvoiceReconciliation.ts | 949 | **PRE_FINDING** | Operator can assert amended term covers the period |
| `FINANCIAL_INVOICE_TOTAL_RECONCILES_TO_LINE_ITEMS` | contractInvoiceReconciliation.ts | 1004 | **POST_FINDING only** | Math mismatch must stay visible; assertion can only change disposition |
| `FINANCIAL_INVOICE_LINE_CODE_EXISTS_IN_CONTRACT` | contractInvoiceReconciliation.ts | 1066 | **PRE_FINDING** | Operator can assert billing code mapping |
| `FINANCIAL_INVOICE_UNIT_PRICE_MATCHES_CONTRACT_RATE` | contractInvoiceReconciliation.ts | 1111 | **PRE_FINDING** | Operator can assert approved rate variance |
| `INVOICE_LINE_REQUIRES_BILLING_KEY` | invoiceTransactionReconciliation.ts | 948 | **PRE_FINDING** | Operator can assert billing key is confirmed |
| `INVOICE_DUPLICATE_BILLED_LINE` | invoiceTransactionReconciliation.ts | 1008 | **POST_FINDING only** | Duplicate billing is an audit fact; never suppress |
| `TRANSACTION_GROUP_EXISTS_FOR_INVOICE_LINE` | invoiceTransactionReconciliation.ts | 1079 | **PRE_FINDING** | Operator can assert support has been externally verified |
| `TRANSACTION_TOTAL_MATCHES_INVOICE_LINE` | invoiceTransactionReconciliation.ts | 1137 | **POST_FINDING only** | Math delta must remain visible; assertion adjusts disposition only |
| `TRANSACTION_QUANTITY_MATCHES_INVOICE` | invoiceTransactionReconciliation.ts | 1194 | **POST_FINDING only** | Same — quantity delta is an audit fact |
| `TRANSACTION_RATE_OUTLIERS` | invoiceTransactionReconciliation.ts | 1264 | **PRE_FINDING** | Operator can assert outlier rate is approved |
| `TRANSACTION_MISSING_INVOICE_LINK` | invoiceTransactionReconciliation.ts | 1329 | **PRE_FINDING** | Operator can assert linkage |
| `SITE_MATERIAL_ANOMALIES` | invoiceTransactionReconciliation.ts | 1393 | **POST_FINDING only** | Inference-based; assertion can adjust disposition but should not suppress |
| `CROSS_DOCUMENT_RATE_MATCHES_CONTRACT` | crossDocumentRateVerification.ts | 589 | **PRE_FINDING** | Operator can assert approved rate variance |
| `CROSS_DOCUMENT_CANONICAL_CATEGORY_ALIGNS` | crossDocumentRateVerification.ts | 594 | **POST_FINDING only** | Inference-based taxonomy; never suppress silently |
| `CROSS_DOCUMENT_CONTRACT_RATE_EXISTS` | crossDocumentRateVerification.ts | 599 | **PRE_FINDING** | Operator can assert rate exists via external document |
| `CROSS_DOCUMENT_TICKET_SUPPORT_EXISTS` | crossDocumentRateVerification.ts | 604 | **PRE_FINDING** | Operator can assert support confirmed outside system |
| `CROSS_DOCUMENT_INVOICE_WORK_SUPPORTED` | crossDocumentRateVerification.ts | 609 | **PRE_FINDING** | Operator can assert work is supported |
| `CROSS_DOCUMENT_CATEGORY_NEEDS_REVIEW` | crossDocumentRateVerification.ts | 614 | **POST_FINDING only** | Inference-based; assertion adjusts disposition only |
| `FINANCIAL_RATE_CODE_MISSING` | financialIntegrity.ts | 288 | **PRE_FINDING** | Operator can assert code confirmed |
| `FINANCIAL_UNIT_TYPE_MISMATCH` | financialIntegrity.ts | 343 | **PRE_FINDING** | Operator can assert unit mapping approved |
| `FINANCIAL_NTE_FACT_MISSING` | financialIntegrity.ts | 384 | **PRE_FINDING** | Operator can assert NTE is not applicable |
| `FINANCIAL_NTE_EXCEEDED` | financialIntegrity.ts | 418 | **POST_FINDING only** | Math overage must stay visible; assertion adjusts disposition only |
| `FINANCIAL_NTE_APPROACHING` | financialIntegrity.ts | 439 | **PRE_FINDING** | Informational; operator can suppress monitoring notice |
| `FINANCIAL_RATE_BASED_SCHEDULE_REQUIRED` | rateBasedContractValidation.ts | 313 | **POST_FINDING only** | Blocking; suppression would mask missing evidence |
| `FINANCIAL_RATE_BASED_ROWS_REQUIRED` | rateBasedContractValidation.ts | 350 | **POST_FINDING only** | Blocking |
| `FINANCIAL_RATE_BASED_PAGES_REQUIRED` | rateBasedContractValidation.ts | 375 | **POST_FINDING only** | Operator review required; assertion adjusts `approval_gate_effect` |
| `FINANCIAL_RATE_BASED_PRICING_APPLICABILITY_UNCLEAR` | rateBasedContractValidation.ts | 417 | **POST_FINDING only** | Inference-based; assertion can mark resolved but must not suppress without operator confirmation |
| `FINANCIAL_RATE_BASED_UNIT_COVERAGE_INCOMPLETE` | rateBasedContractValidation.ts | 452 | **POST_FINDING only** | Inference-based |
| `FINANCIAL_RATE_BASED_ACTIVATION_GATE_UNRESOLVED` | rateBasedContractValidation.ts | 505 | **POST_FINDING only** | Inference-based |
| `TICKET_QTY_CYD_MISMATCH` | ticketIntegrity.ts | 141 | **PRE_FINDING** | Operator can assert corrected quantity (with tolerance override) |
| `TICKET_QTY_TONNAGE_MISMATCH` | ticketIntegrity.ts | 184 | **PRE_FINDING** | Same |
| `TICKET_MATERIAL_MISMATCH` | ticketIntegrity.ts | 228 | **PRE_FINDING** | Operator can assert material classification |
| `TICKET_DISPOSAL_SITE_MISMATCH` | ticketIntegrity.ts | 269 | **PRE_FINDING** | Operator can assert site classification |
| `TICKET_ORPHANED_LOAD` | ticketIntegrity.ts | 306 | **PRE_FINDING** | Operator can assert load linkage confirmed |
| `INVOICE_BILLED_TOTAL_PRESENT_FOR_EXPOSURE` | exposure.ts | 884 | **POST_FINDING only** | Exposure finding; computed from summary |
| `INVOICE_EXPOSURE_SUPPORTED_AMOUNT_MATCHES_BILLED` | exposure.ts | 929 | **POST_FINDING only** | Blocking exposure finding |
| `INVOICE_EXPOSURE_AT_RISK_AMOUNT_ZERO` | exposure.ts | 969 | **POST_FINDING only** | Blocking exposure finding |
| `PROJECT_EXPOSURE_SUPPORTED_AMOUNT_MATCHES_BILLED` | exposure.ts | 1002 | **POST_FINDING only** | Blocking exposure finding |
| `PROJECT_EXPOSURE_AT_RISK_AMOUNT_ZERO` | exposure.ts | 1033 | **POST_FINDING only** | Blocking exposure finding |

**PRE_FINDING total: 22** | **POST_FINDING only total: 21**

### 3.2 Mechanical insertion pattern

**PRE_FINDING pattern** (inside each rule pack, at each `isRuleEnabled()` guard site):
```
// BEFORE (existing)
if (!condition && isRuleEnabled(input.ruleStateByRuleId, 'RULE_ID')) {
  findings.push(makeFinding({ ... }));
}

// AFTER (with assertion hook — Phase B)
if (!condition && isRuleEnabled(input.ruleStateByRuleId, 'RULE_ID')) {
  const context = buildFindingEvaluationContext(input, { subjectType, subjectId });
  if (!resolveAssertionsForFinding('RULE_ID', context).suppressed) {
    findings.push(makeFinding({ ... }));
  }
}
```

**POST_FINDING pattern** (wrapping the existing `makeFinding()` push):
```
// BEFORE (existing)
findings.push(makeFinding({ ... }));

// AFTER (with assertion hook — Phase B)
const finding = makeFinding({ ... });
const assertionResult = resolveAssertionsForFinding(finding.rule_id, context);
findings.push(assertionResult.applyTo(finding));  // mutates disposition only
```

The `makeFinding()` factory in `lib/validator/shared.ts` (line 677) does not need modification for either pattern; hooks wrap its call sites.

---

## 4. Conflict Surface Insertion Points

### 4.1 Confirmation: `requires_review` disposition exists

In `lib/validator/schemas.ts` (line 25–30):
```typescript
const validationFindingDispositionValues = [
  'blocker',
  'warning',
  'info',
  'requires_review',    // ← confirmed present
] as const;
```

In `lib/validator/findingSemantics.ts`:
- `findingDispositionForSeverity()` (line 426–440): maps `business_severity === 'high'` → `requires_review` disposition
- `isReviewFinding()` (line 663–670): returns `true` when `finding_disposition === 'requires_review'` OR `approval_gate_effect === 'requires_operator_review'`
- `requiresReviewFindingCount()` (line 680–682): exported counter consumed by summary builders

In `lib/validator/schemas.ts` (line 267):
```typescript
requires_review_count: z.number().int().nonnegative().optional(),
```
The `ValidationSummary` schema already has a `requires_review_count` slot.

### 4.2 Conflict finding generation surface

When `resolveAssertionsForFinding()` detects a conflict (two or more assertions with contradicting `assertion_value` for the same `rule_id` + subject), the insertion point is **POST_FINDING**. The conflict is surfaced by:

1. Not suppressing the original finding (it remains with its computed disposition)
2. Generating an additional synthetic finding using `makeFinding()` with:
   - `ruleId`: a new rule like `'ASSERTION_CONFLICT'` or by reusing the original `ruleId` with a conflict suffix
   - `finding_disposition`: `'requires_review'`
   - `approval_gate_effect`: `'requires_operator_review'`
   - `subject_type` / `subject_id`: same as the conflicting finding
   - `field`: `'assertion_conflict'`
   - `expected`: the assertion `assertion_value` on one side
   - `actual`: the assertion `assertion_value` on the other side
3. Pushing the conflict finding to `findings[]` alongside the original

### 4.3 Operator review workflow compatibility

The existing workflow handles `requires_review` findings through:
- `isReviewFinding()` — already checks both disposition and gate effect
- `requiresReviewFindingCount()` — already consumed by `buildValidationSummary()`
- `ValidationSummary.requires_review_count` — already in schema (optional slot)
- `RULE_SEMANTIC_OVERRIDES` in `findingSemantics.ts` — overrides for `approval_gate_effect: 'requires_operator_review'` on several existing rule IDs show the pattern is established

**No schema changes are required** to surface assertion conflict findings via `requires_review`. The conflict finding is structurally identical to any other finding with that disposition.

---

## 5. Risk Assessment Per Insertion Point

Risk tiers:
- **Low** — additive only; does not touch existing finding data; failure mode is a no-op
- **Medium** — modifies an existing finding's disposition; incorrect result changes what operator sees but does not suppress evidence
- **High** — can suppress a finding entirely (PRE_FINDING); incorrect result could cause a finding to silently disappear
- **Critical** — suppresses a blocking or audit-immutable finding; incorrect result could approve a payment that should be blocked

### 5.1 POST_FINDING only insertions (additive, lowest risk)

| Finding Type | Risk Tier | Test Coverage Note | Additive Only? |
|---|---|---|---|
| `SOURCES_NO_CONTRACT` | **Medium** | requiredSources tests cover generation; assertion layer adds new code path | Yes — disposition only |
| `SOURCES_NO_RATE_SCHEDULE` | **Medium** | Same | Yes |
| `SOURCES_NO_INVOICE_DATA` | **Medium** | Same | Yes |
| `SOURCES_NO_TICKET_DATA` | **Medium** | Same | Yes |
| `IDENTITY_DUPLICATE_TICKET` | **Medium** | identityConsistency covered | Yes |
| `INVOICE_DUPLICATE_BILLED_LINE` | **Medium** | invoiceTransactionReconciliation covered | Yes |
| `FINANCIAL_INVOICE_TOTAL_RECONCILES_TO_LINE_ITEMS` | **Medium** | contractInvoiceReconciliation covered | Yes |
| `TRANSACTION_TOTAL_MATCHES_INVOICE_LINE` | **Medium** | invoiceTransactionReconciliation covered | Yes |
| `TRANSACTION_QUANTITY_MATCHES_INVOICE` | **Medium** | Same | Yes |
| `FINANCIAL_NTE_EXCEEDED` | **Medium** | financialIntegrity covered | Yes |
| `FINANCIAL_RATE_BASED_SCHEDULE_REQUIRED` | **Medium** | rateBasedContractValidation covered | Yes |
| `FINANCIAL_RATE_BASED_ROWS_REQUIRED` | **Medium** | Same | Yes |
| `SITE_MATERIAL_ANOMALIES` | **Low** | invoiceTransactionReconciliation covered; inference-based so suppression always wrong | Yes |
| `CROSS_DOCUMENT_CANONICAL_CATEGORY_ALIGNS` | **Low** | crossDocumentRateVerification covered; inference-based | Yes |
| `CROSS_DOCUMENT_CATEGORY_NEEDS_REVIEW` | **Low** | Same; inference-based | Yes |
| `FINANCIAL_RATE_BASED_PRICING_APPLICABILITY_UNCLEAR` | **Low** | rateBasedContractValidation covered; inference-based | Yes |
| `FINANCIAL_RATE_BASED_UNIT_COVERAGE_INCOMPLETE` | **Low** | Same | Yes |
| `FINANCIAL_RATE_BASED_ACTIVATION_GATE_UNRESOLVED` | **Low** | Same | Yes |
| `FINANCIAL_RATE_BASED_PAGES_REQUIRED` | **Medium** | rateBasedContractValidation covered | Yes |
| `INVOICE_BILLED_TOTAL_PRESENT_FOR_EXPOSURE` | **Medium** | exposure tests; computed from summary | Yes |
| `INVOICE_EXPOSURE_SUPPORTED_AMOUNT_MATCHES_BILLED` | **Critical** | exposure tests; blocking finding — disposition-only is safe, but any accidental suppression path is critical | Yes — disposition only; suppression path blocked by design |
| `INVOICE_EXPOSURE_AT_RISK_AMOUNT_ZERO` | **Critical** | Same | Yes |
| `PROJECT_EXPOSURE_SUPPORTED_AMOUNT_MATCHES_BILLED` | **Critical** | Same | Yes |
| `PROJECT_EXPOSURE_AT_RISK_AMOUNT_ZERO` | **Critical** | Same | Yes |

### 5.2 PRE_FINDING insertions (suppression possible, higher risk)

| Finding Type | Risk Tier | Test Coverage Note | Additive Only? |
|---|---|---|---|
| `FINANCIAL_NTE_APPROACHING` | **Low** | financialIntegrity covered; informational only | No — can suppress |
| `FINANCIAL_NTE_FACT_MISSING` | **Low** | financialIntegrity covered; informational only | No |
| `TRANSACTION_RATE_OUTLIERS` | **Low** | invoiceTransactionReconciliation covered; warning | No |
| `TRANSACTION_MISSING_INVOICE_LINK` | **Low** | Same | No |
| `TICKET_ORPHANED_LOAD` | **Low** | ticketIntegrity covered; warning | No |
| `TICKET_MATERIAL_MISMATCH` | **Medium** | ticketIntegrity covered | No |
| `TICKET_DISPOSAL_SITE_MISMATCH` | **Medium** | ticketIntegrity covered | No |
| `FINANCIAL_RATE_CODE_MISSING` | **Medium** | financialIntegrity covered; quasi-inference severity | No |
| `INVOICE_LINE_REQUIRES_BILLING_KEY` | **Medium** | invoiceTransactionReconciliation covered | No |
| `FINANCIAL_INVOICE_CLIENT_MISSING_FOR_CONTRACT_COMPARISON` | **Medium** | contractInvoiceReconciliation covered; warning | No |
| `FINANCIAL_INVOICE_SERVICE_PERIOD_MISSING` | **Medium** | Same | No |
| `IDENTITY_PROJECT_CODE_MISMATCH` | **High** | identityConsistency covered | No |
| `IDENTITY_PARTY_NAME_INCONSISTENCY` | **High** | identityConsistency covered | No |
| `TICKET_QTY_CYD_MISMATCH` | **High** | ticketIntegrity covered; critical finding | No |
| `TICKET_QTY_TONNAGE_MISMATCH` | **High** | ticketIntegrity covered; critical finding | No |
| `TRANSACTION_GROUP_EXISTS_FOR_INVOICE_LINE` | **High** | invoiceTransactionReconciliation covered; critical | No |
| `FINANCIAL_INVOICE_VENDOR_MATCHES_CONTRACT_CONTRACTOR` | **High** | contractInvoiceReconciliation covered; critical | No |
| `FINANCIAL_INVOICE_CLIENT_MATCHES_CONTRACT_CLIENT` | **High** | Same | No |
| `FINANCIAL_INVOICE_SERVICE_PERIOD_WITHIN_CONTRACT_TERM` | **High** | Same | No |
| `FINANCIAL_INVOICE_LINE_CODE_EXISTS_IN_CONTRACT` | **High** | Same | No |
| `FINANCIAL_INVOICE_UNIT_PRICE_MATCHES_CONTRACT_RATE` | **High** | Same | No |
| `CROSS_DOCUMENT_CONTRACT_RATE_EXISTS` | **High** | crossDocumentRateVerification covered | No |
| `CROSS_DOCUMENT_TICKET_SUPPORT_EXISTS` | **High** | Same | No |
| `CROSS_DOCUMENT_INVOICE_WORK_SUPPORTED` | **High** | Same | No |
| `CROSS_DOCUMENT_RATE_MATCHES_CONTRACT` | **High** | Same; critical rate delta | No |
| `FINANCIAL_UNIT_TYPE_MISMATCH` | **High** | financialIntegrity covered | No |

---

## 6. Recommended Insertion Order

Ordered by lowest blast radius first. Each wave should be fully tested before proceeding to the next.

### Wave 1 — Inference-based POST_FINDING hooks (zero suppression risk)

Assertion evaluation is additive only. Wrong evaluator results change a disposition label but cannot suppress any finding or alter audit evidence. Safe to ship without any changes to existing test assertions.

| Order | Finding Type | File |
|---|---|---|
| 1 | `CROSS_DOCUMENT_CATEGORY_NEEDS_REVIEW` | crossDocumentRateVerification.ts |
| 2 | `CROSS_DOCUMENT_CANONICAL_CATEGORY_ALIGNS` | crossDocumentRateVerification.ts |
| 3 | `SITE_MATERIAL_ANOMALIES` | invoiceTransactionReconciliation.ts |
| 4 | `FINANCIAL_RATE_BASED_PRICING_APPLICABILITY_UNCLEAR` | rateBasedContractValidation.ts |
| 5 | `FINANCIAL_RATE_BASED_UNIT_COVERAGE_INCOMPLETE` | rateBasedContractValidation.ts |
| 6 | `FINANCIAL_RATE_BASED_ACTIVATION_GATE_UNRESOLVED` | rateBasedContractValidation.ts |

### Wave 2 — Informational/low-severity POST_FINDING hooks

Still additive; these findings have `approval_gate_effect: 'informational'` so wrong disposition does not change operator gate behavior.

| Order | Finding Type | File |
|---|---|---|
| 7 | `FINANCIAL_NTE_APPROACHING` | financialIntegrity.ts |
| 8 | `FINANCIAL_NTE_FACT_MISSING` | financialIntegrity.ts |
| 9 | `INVOICE_BILLED_TOTAL_PRESENT_FOR_EXPOSURE` | exposure.ts |
| 10 | `FINANCIAL_RATE_BASED_PAGES_REQUIRED` | rateBasedContractValidation.ts |

### Wave 3 — PRE_FINDING hooks on low-severity warnings (first suppression surface)

PRE_FINDING suppression is introduced here for the first time. These findings are warnings or info; incorrect suppression is visible as a missing finding but does not block payment.

| Order | Finding Type | File |
|---|---|---|
| 11 | `TRANSACTION_RATE_OUTLIERS` | invoiceTransactionReconciliation.ts |
| 12 | `TRANSACTION_MISSING_INVOICE_LINK` | invoiceTransactionReconciliation.ts |
| 13 | `TICKET_ORPHANED_LOAD` | ticketIntegrity.ts |
| 14 | `TICKET_MATERIAL_MISMATCH` | ticketIntegrity.ts |
| 15 | `TICKET_DISPOSAL_SITE_MISMATCH` | ticketIntegrity.ts |
| 16 | `FINANCIAL_RATE_CODE_MISSING` | financialIntegrity.ts |
| 17 | `INVOICE_LINE_REQUIRES_BILLING_KEY` | invoiceTransactionReconciliation.ts |
| 18 | `FINANCIAL_INVOICE_CLIENT_MISSING_FOR_CONTRACT_COMPARISON` | contractInvoiceReconciliation.ts |
| 19 | `FINANCIAL_INVOICE_SERVICE_PERIOD_MISSING` | contractInvoiceReconciliation.ts |

### Wave 4 — POST_FINDING hooks on math/duplicate audit findings

Findings that must remain visible; assertion can only change disposition. Safe to insert once Wave 1–3 evaluator is proven stable.

| Order | Finding Type | File |
|---|---|---|
| 20 | `FINANCIAL_INVOICE_TOTAL_RECONCILES_TO_LINE_ITEMS` | contractInvoiceReconciliation.ts |
| 21 | `TRANSACTION_TOTAL_MATCHES_INVOICE_LINE` | invoiceTransactionReconciliation.ts |
| 22 | `TRANSACTION_QUANTITY_MATCHES_INVOICE` | invoiceTransactionReconciliation.ts |
| 23 | `FINANCIAL_NTE_EXCEEDED` | financialIntegrity.ts |
| 24 | `IDENTITY_DUPLICATE_TICKET` | identityConsistency.ts |
| 25 | `INVOICE_DUPLICATE_BILLED_LINE` | invoiceTransactionReconciliation.ts |

### Wave 5 — PRE_FINDING hooks on critical deterministic findings

Incorrect suppression here causes a critical finding to silently disappear. Requires the assertion evaluator to have demonstrated correctness across Waves 1–4 before deployment.

| Order | Finding Type | File |
|---|---|---|
| 26 | `IDENTITY_PROJECT_CODE_MISMATCH` | identityConsistency.ts |
| 27 | `IDENTITY_PARTY_NAME_INCONSISTENCY` | identityConsistency.ts |
| 28 | `TICKET_QTY_CYD_MISMATCH` | ticketIntegrity.ts |
| 29 | `TICKET_QTY_TONNAGE_MISMATCH` | ticketIntegrity.ts |
| 30 | `FINANCIAL_UNIT_TYPE_MISMATCH` | financialIntegrity.ts |
| 31 | `FINANCIAL_INVOICE_VENDOR_MATCHES_CONTRACT_CONTRACTOR` | contractInvoiceReconciliation.ts |
| 32 | `FINANCIAL_INVOICE_CLIENT_MATCHES_CONTRACT_CLIENT` | contractInvoiceReconciliation.ts |
| 33 | `FINANCIAL_INVOICE_SERVICE_PERIOD_WITHIN_CONTRACT_TERM` | contractInvoiceReconciliation.ts |
| 34 | `FINANCIAL_INVOICE_LINE_CODE_EXISTS_IN_CONTRACT` | contractInvoiceReconciliation.ts |
| 35 | `FINANCIAL_INVOICE_UNIT_PRICE_MATCHES_CONTRACT_RATE` | contractInvoiceReconciliation.ts |
| 36 | `CROSS_DOCUMENT_CONTRACT_RATE_EXISTS` | crossDocumentRateVerification.ts |
| 37 | `CROSS_DOCUMENT_TICKET_SUPPORT_EXISTS` | crossDocumentRateVerification.ts |
| 38 | `CROSS_DOCUMENT_INVOICE_WORK_SUPPORTED` | crossDocumentRateVerification.ts |
| 39 | `CROSS_DOCUMENT_RATE_MATCHES_CONTRACT` | crossDocumentRateVerification.ts |
| 40 | `TRANSACTION_GROUP_EXISTS_FOR_INVOICE_LINE` | invoiceTransactionReconciliation.ts |

### Wave 6 — POST_FINDING hooks on blocking source/exposure findings

These findings cannot be suppressed by assertion. Assertion can only annotate disposition. Deploy last, as they sit in the highest-stakes code paths and depend on the conflict surface being fully proven.

| Order | Finding Type | File |
|---|---|---|
| 41 | `SOURCES_NO_CONTRACT` | requiredSources.ts |
| 42 | `SOURCES_NO_RATE_SCHEDULE` | requiredSources.ts |
| 43 | `SOURCES_NO_INVOICE_DATA` | requiredSources.ts |
| 44 | `SOURCES_NO_TICKET_DATA` | requiredSources.ts |
| 45 | `FINANCIAL_RATE_BASED_SCHEDULE_REQUIRED` | rateBasedContractValidation.ts |
| 46 | `FINANCIAL_RATE_BASED_ROWS_REQUIRED` | rateBasedContractValidation.ts |
| 47 | `INVOICE_EXPOSURE_SUPPORTED_AMOUNT_MATCHES_BILLED` | exposure.ts |
| 48 | `INVOICE_EXPOSURE_AT_RISK_AMOUNT_ZERO` | exposure.ts |
| 49 | `PROJECT_EXPOSURE_SUPPORTED_AMOUNT_MATCHES_BILLED` | exposure.ts |
| 50 | `PROJECT_EXPOSURE_AT_RISK_AMOUNT_ZERO` | exposure.ts |

---

## Appendix: Execution Order in `validateProject()`

`lib/validator/projectValidator.ts` runs packs in this order (lines 2299–2375):

1. `runRequiredSourcesRules()` — if blocking, stops here and calls `evaluateProjectExposure()`
2. `runIdentityConsistencyRules()`
3. `evaluateContractInvoiceReconciliation()`
4. `evaluateInvoiceTransactionReconciliation()`
5. `evaluateCrossDocumentRateVerification()`
6. `runFinancialIntegrityRules()` → calls `runRateBasedContractValidationRules()` internally
7. `runTicketIntegrityRules()`
8. `evaluateProjectExposure()` (always runs at end of full sequence)

Each pack is wrapped in a `try/catch`; failure appends `${pack.id}:failed` to `rulesApplied` and continues. Assertion hooks must not throw; they must be wrapped in try/catch at the insertion point to preserve this invariant.

---

*Reviewers: `eightforge-truth-engine-reviewer` + `eightforge-execution-reviewer` + `eightforge-cross-document-reviewer`*
