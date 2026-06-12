# Evaluator Alignment Check — Decision Assertion Evaluator vs. Validator Context

**Phase:** A (read-only audit)
**Branch:** feat/WorkHereOnly
**Date:** 2026-06-09
**Scope:** Can `decisionAssertionEvaluator.ts` integrate exactly as written, or are pre-integration changes required?
**Sources audited:**
- `lib/validation/decisionAssertionEvaluator.ts`
- `lib/types/decisionAssertions.ts`
- `docs/decisions/VALIDATOR_INTEGRATION_AUDIT.md`

---

## 1. Evaluator Assumptions Inventory

### 1.1 `FindingEvaluationContext` shape (defined in evaluator)

| Field | Type | Comment |
|---|---|---|
| `project_id` | `string` | Always required |
| `contract_id` | `string \| null` | Null when no contract document loaded |
| `invoice_id` | `string \| null` | Null for 14 finding type groups (SOURCES_*, IDENTITY_*, FINANCIAL_RATE_BASED_*, FINANCIAL_NTE_*, TICKET_*) — by design, documented in evaluator JSDoc |
| `subject_entity_type` | `string` | Always required |
| `subject_entity_id` | `string \| null` | Always required at call site |
| `contract_has_codes` | `boolean \| null` | Null means "not determinable"; evaluator treats null as cannot-confirm and returns false |
| `unit` | `string \| null` | Unit of measure on the subject entity |
| `match_priority` | `string \| null` | Match priority label in scope for this finding |
| `finding_type` | `string` | Finding type identifier |

### 1.2 `ValidatorInference` shape (defined in evaluator)

| Field | Type | Comment |
|---|---|---|
| `finding_type` | `string` | Not read by evaluator logic; structural only |
| `conclusion` | `'pass' \| 'fail' \| 'warn' \| 'unknown'` | Read by `evaluateAssertionConflicts` |
| `confidence` | `number \| null` | Read by `evaluateAssertionConflicts`; triggers escalation if < 0.5 |
| `evidence_refs` | `string[]` | Not read by any evaluator function; structural only |

### 1.3 Fields consumed by each exported function

| Evaluator Field | Required? | Function Using It |
|---|---|---|
| `context.contract_has_codes` | **Yes** — direct binding check | `evaluateAssertionApplies` |
| `context[field]` for each `requires_fields` entry | **Conditional** — only if assertion binding lists the field | `evaluateAssertionApplies` |
| `inference.conclusion` | **Yes** | `evaluateAssertionConflicts`, `resolveAssertionsForFinding` |
| `inference.confidence` | **Yes** | `evaluateAssertionConflicts`, `resolveAssertionsForFinding` |
| `assertion.decision_type` | **Yes** | `evaluateAssertionConflicts`, `resolveAssertionsForFinding` |
| `assertion.scope_level` | **Yes** | `resolveAssertionsForFinding` (high-scope conflict detection) |
| `assertion.id` | **Yes** | `resolveAssertionsForFinding` (evidence chain) |

### 1.4 `ConfidenceBinding` fields defined vs. fields evaluated

This is the first alignment gap. The `ConfidenceBinding` type exposes three condition fields but `evaluateAssertionApplies()` only handles two of them:

| `ConfidenceBinding` field | Evaluated by `evaluateAssertionApplies`? |
|---|---|
| `requires_fields` | **Yes** — null-checks each named field on context |
| `contract_has_codes` | **Yes** — direct boolean comparison |
| `unit_match_required` | **NO — not evaluated at all** |
| `custom_conditions` | **NO — silently ignored** |

`unit_match_required` is defined in the type and in the migration (per file header reference) but the evaluator has no logic to enforce it. An assertion with `confidence_binding.unit_match_required = true` will be treated identically to one without it.

---

## 2. Validator Context Inventory

Source: `docs/decisions/VALIDATOR_INTEGRATION_AUDIT.md` Section 2.

### 2.1 Fields available at all finding generation points

| `FindingEvaluationContext` Field | Source in `ProjectValidatorInput` | Notes |
|---|---|---|
| `project_id` | `input.project.id` | Always present |
| `contract_id` | `input.factLookups.contractDocumentId` | May be null; triggers `SOURCES_NO_CONTRACT` when null |
| `subject_entity_type` | `subjectType` param at each `makeFinding()` call site | Always present |
| `subject_entity_id` | `subjectId` param at each `makeFinding()` call site | Always present |
| `contract_has_codes` | Not a direct field — derivable (see Section 2.3 of audit) | Not precomputed; must be built once per pack run |
| `finding_type` | Known at each `makeFinding()` call site | Always present |

### 2.2 Fields with per-subject availability gaps

| `FindingEvaluationContext` Field | Source | Gap |
|---|---|---|
| `invoice_id` | `subject_id` for invoice-subject findings; line row lookup for invoice_line findings | **Absent** for `SOURCES_*`, `IDENTITY_*`, `FINANCIAL_RATE_BASED_*`, `FINANCIAL_NTE_*`, `TICKET_*` groups (14 of 43 finding types) |
| `unit` | **Not documented in `ProjectValidatorInput`** | No derivation path in audit |
| `match_priority` | **Not documented in `ProjectValidatorInput`** | No derivation path in audit |

### 2.3 Finding type groups by context availability

| Finding Type Group | `invoice_id` Available? | `contract_has_codes` Derivable? | `unit` Available? | `match_priority` Available? |
|---|---|---|---|---|
| `SOURCES_*` | ✗ | Partial (items array may be empty) | ✗ | ✗ |
| `IDENTITY_*` | ✗ | Yes | ✗ | ✗ |
| `FINANCIAL_INVOICE_*` | ✓ (`subject_id`) | Yes | ✗ | ✗ |
| `FINANCIAL_INVOICE_LINE_*` | ✓ (via line row lookup) | Yes | ✗ documented | ✗ |
| `FINANCIAL_NTE_*` | ✗ | Yes | ✗ | ✗ |
| `FINANCIAL_RATE_BASED_*` | ✗ | Yes | ✗ | ✗ |
| `INVOICE_*` / `TRANSACTION_*` | ✓ (via line row) | Yes | ✗ documented | ✗ |
| `CROSS_DOCUMENT_*` | ✓ (via line row) | Yes | ✗ documented | ✗ documented |
| `TICKET_*` | ✗ | Yes | ✗ | ✗ |
| `SITE_MATERIAL_ANOMALIES` | ✓ | Yes | ✗ | ✗ |
| `*_EXPOSURE_*` | ✓ for invoice-level | Yes | ✗ | ✗ |

---

## 3. Alignment Matrix

Scope: fields on `FindingEvaluationContext`; fields on `ValidatorInference`; `ConfidenceBinding` conditions handled by evaluator.

### 3.1 `FindingEvaluationContext` fields

| Field | Status | Evidence |
|---|---|---|
| `project_id` | **PRESENT** | `input.project.id` — Section 2.1 of audit |
| `contract_id` | **PRESENT** | `input.factLookups.contractDocumentId` — Section 2.1; null is valid and handled |
| `invoice_id` | **PRESENT** (invoice/invoice_line findings) / **MISSING** (14 type groups) | Section 2.2 and 2.4; absence for project/ticket subjects is by design and documented in evaluator JSDoc |
| `subject_entity_type` | **PRESENT** | `subjectType` param at every `makeFinding()` call site |
| `subject_entity_id` | **PRESENT** | `subjectId` param at every `makeFinding()` call site |
| `contract_has_codes` | **DERIVABLE** | `rateScheduleItems.some(i => i.rate_code != null) \|\| contractCeilingType === 'rate_based'` — Section 2.3 of audit; deterministic, no DB query needed |
| `finding_type` | **PRESENT** | Known constant at each `makeFinding()` call site |
| `unit` | **MISSING** | Not documented in `ProjectValidatorInput`; no derivation path provided in audit |
| `match_priority` | **MISSING** | Not documented in `ProjectValidatorInput`; no derivation path provided in audit |

### 3.2 `ValidatorInference` fields

| Field | Status | Evidence |
|---|---|---|
| `finding_type` | **PRESENT** (structural) | Known at call site; same as `context.finding_type` |
| `conclusion` | **DERIVABLE** | Must be constructed from validator's computed severity/disposition before the assertion hook runs; no existing shared builder |
| `confidence` | **DERIVABLE** | Present on some inference paths; must default to `null` where unavailable |
| `evidence_refs` | **PRESENT** (structural, not read) | Not consumed by evaluator; can be empty array |

### 3.3 `ConfidenceBinding` condition coverage

| Binding Condition | Evaluator Handles It? | Status |
|---|---|---|
| `contract_has_codes` | Yes | **PRESENT** |
| `requires_fields` | Yes | **PRESENT** (but fields named by it may themselves be MISSING — see `unit`, `match_priority`) |
| `unit_match_required` | **No** | **MISSING IN EVALUATOR** — defined in type, not evaluated |
| `custom_conditions` | **No** | Intentional deferral; no assertions currently use it |

---

## 4. Williamson Canonical Case Review

**Assertion under test:**
```
decision_type        = rate_interpretation
contract_has_codes   = false        (confidence_binding)
unit_match_required  = true         (confidence_binding)
match_priority       = description  (condition_json / FindingEvaluationContext.match_priority)
```

**Evaluation trace through `evaluateAssertionApplies()`:**

| Check | Evaluator Logic | Outcome |
|---|---|---|
| `contract_has_codes = false` | `binding.contract_has_codes !== null` → compare to `context.contract_has_codes` | **PASS** — `contract_has_codes` is DERIVABLE; if context is built correctly this check works |
| `unit_match_required = true` | **Not evaluated** — no branch in evaluator for this binding field | **SILENT FAIL** — evaluator ignores this condition entirely; assertion is treated as if `unit_match_required` is absent |
| `match_priority = description` | Only checked if `requires_fields` lists `'match_priority'`; if listed, evaluator checks `context.match_priority !== null` | **MISSING** — `match_priority` has no source in `ProjectValidatorInput`; context field would always be `null`, causing evaluator to return `false` |

**Conflict path** (if `evaluateAssertionApplies` incorrectly returns `true` due to `unit_match_required` gap):
- `evaluateAssertionConflicts`: `decision_type === 'rate_interpretation'` + `conclusion === 'fail'` → `conflict_type = 'suppression'`
- `resolveAssertionsForFinding`: scope determines resolution — invoice/project scope → `requires_review`; lower scope → `suppressed`

**Result: FAIL**

Two independent defects prevent correct evaluation of the Williamson case:

1. **Evaluator gap** — `confidence_binding.unit_match_required` is not evaluated. The evaluator will apply rate_interpretation assertions that require unit matching to findings where the unit has not been verified, producing spurious suppressions or escalations.

2. **Context gap** — `FindingEvaluationContext.match_priority` has no documented source in `ProjectValidatorInput`. Even if an assertion uses `requires_fields: ['match_priority']` as a proxy for this condition, the context field cannot be populated and the evaluator will always return `false` for such assertions (safe-fail, but incorrect — the assertion will never fire).

---

## 5. Integration Readiness Assessment

### 5.1 Summary

| Category | Count | Fields |
|---|---|---|
| PRESENT | 7 | `project_id`, `contract_id`, `invoice_id` (invoice-subject), `subject_entity_type`, `subject_entity_id`, `finding_type`, `contract_has_codes` (derivable — see below) |
| DERIVABLE | 2 | `contract_has_codes`, `ValidatorInference.conclusion` |
| MISSING | 2 | `unit`, `match_priority` |
| EVALUATOR GAP | 1 | `unit_match_required` not evaluated in `evaluateAssertionApplies()` |

Note: `contract_has_codes` is listed DERIVABLE (not PRESENT) because it is not a precomputed field in `ProjectValidatorInput` and requires a one-time derivation per pack invocation.

### 5.2 Verdict

**NOT READY**

`unit` and `match_priority` are genuinely MISSING — they cannot be derived from documented `ProjectValidatorInput` contents without new plumbing. The DERIVABLE threshold for READY WITH CONTEXT ADAPTER requires that all missing fields can be produced from already-available context without additional data; neither field meets this bar.

Additionally, the evaluator itself has an unimplemented condition: `confidence_binding.unit_match_required` is defined in the type and migration but not evaluated in `evaluateAssertionApplies()`. Integrating the evaluator as-is would silently ignore this binding field for all assertions that set it, including the Williamson rate_interpretation case.

---

## 6. Required Pre-Integration Changes

Two independent workstreams, both required before validator integration.

### 6.1 Evaluator: implement `unit_match_required` evaluation

**Location:** `lib/validation/decisionAssertionEvaluator.ts` — `evaluateAssertionApplies()`, after the `contract_has_codes` check (line 129)

**Change required:**
```typescript
// Add after the contract_has_codes block:
if (binding.unit_match_required === true) {
  if (context.unit === null || context.unit === undefined) {
    // Cannot verify unit match; do not assume.
    return false;
  }
  // Note: the actual unit-equality check requires the assertion's expected unit,
  // which is not on ConfidenceBinding. This may require either:
  // (a) adding expected_unit to ConfidenceBinding, or
  // (b) treating unit_match_required as a context-presence guard only (unit must be non-null).
  // Resolve with eightforge-truth-engine-reviewer before implementing.
}
```

**Open question:** The evaluator has no access to the assertion's "expected unit" — only `unit_match_required: boolean`. The actual unit comparison target is absent from both `ConfidenceBinding` and `DecisionAssertionQuery`. Before implementing, confirm whether `unit_match_required` is a context-presence guard (unit field must be non-null) or a full equality check (context unit must match a canonical unit stored elsewhere on the assertion).

**Reviewer:** `eightforge-truth-engine-reviewer`

### 6.2 Context: source `unit` and `match_priority` into `ProjectValidatorInput`

**Location:** Wherever `FindingEvaluationContext` is constructed before passing to the evaluator (planned `buildFindingEvaluationContext()` helper per audit Section 3.2)

**Change required for `unit`:**
- For invoice_line-subject findings: read unit of measure from the line row (field name depends on schema — check `lib/validator/rulePacks/crossDocumentRateVerification.ts` and `contractInvoiceReconciliation.ts` for how line rows are currently accessed).
- For ticket-subject findings: read unit from the ticket row if available.
- For project/contract-subject findings: `null` is correct — no single unit applies.
- No new Supabase queries required if the line/ticket data is already in the rule pack's local scope.

**Change required for `match_priority`:**
- The semantics of this field are under-specified in the evaluator and type definitions. The comment says "Match priority label in scope for this finding, if applicable" but no rule pack currently computes or uses a match_priority label.
- Before plumbing this field, confirm its intended source: is it derived from `condition_json.match_priority` on the governing rate schedule item, from a contract-level setting, or from the rule pack's internal resolution logic?
- Until the source is confirmed, `match_priority` should be passed as `null` in all contexts. Assertions that depend on it via `requires_fields: ['match_priority']` will correctly return `false` (no match) rather than incorrectly matching.

**Reviewer:** `eightforge-truth-engine-reviewer` + `eightforge-cross-document-reviewer`

### 6.3 Safe interim path

If integration is needed before 6.1 and 6.2 are resolved, it is safe to integrate the evaluator for assertions that use **only** `contract_has_codes` as their binding condition, with `requires_fields` empty and `unit_match_required` absent. This covers a large subset of assertions (all that do not require unit or match_priority binding). The Wave 1–2 insertion points from the audit are suitable targets under this constraint.

The evaluator's behavior for `unit_match_required`-bearing assertions is a silent false-positive risk (it applies them when it shouldn't), not a false-negative risk. If no active assertions in the DB currently have `unit_match_required: true`, the gap is latent, not live. Confirm assertion table state before deploying.

---

*Reviewers: `eightforge-truth-engine-reviewer` + `eightforge-execution-reviewer` + `eightforge-cross-document-reviewer`*
