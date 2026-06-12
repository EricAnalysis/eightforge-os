# Loose Ends — Phase A + Phase B

**Repo:** eightforge-os  
**Branch:** feat/WorkHereOnly  
**Recorded:** 2026-06-09  

These are tracked design debts, not implementation tasks. Do not lose them.

---

## 1. `decision_assertions` FK gap — `contracts` and `clients` tables absent

**Status:** Deferred — tables not yet in deployed schema

### Context

During application of `20260609000001_decision_assertions.sql`, two FK constraints were stripped because `public.contracts` and `public.clients` do not exist in the deployed schema:

- `contract_vehicle_id uuid` — no FK (was `REFERENCES public.contracts(id)`)
- `client_id uuid` — no FK (was `REFERENCES public.clients(id)`)

Both columns exist on `decision_assertions` as nullable `uuid`. The data shape is correct. The referential integrity constraint is absent.

### Required follow-up

When `public.contracts` and `public.clients` are added to the deployed schema, apply this migration immediately after:

```sql
ALTER TABLE public.decision_assertions
  ADD CONSTRAINT da_contract_vehicle_id_fkey
  FOREIGN KEY (contract_vehicle_id)
  REFERENCES public.contracts(id)
  ON DELETE SET NULL;

ALTER TABLE public.decision_assertions
  ADD CONSTRAINT da_client_id_fkey
  FOREIGN KEY (client_id)
  REFERENCES public.clients(id)
  ON DELETE SET NULL;
```

### Risk if deferred too long

Orphaned `contract_vehicle_id` and `client_id` values can accumulate with no referential check.

- **While both tables are absent:** low risk — no values can be set against non-existent tables.
- **Once either table is added without the FK:** medium risk — orphaned references can silently accumulate.

---

## 2. `decisionAssertionEvaluator` NOT READY — three blockers before validator integration

**Status:** Blocked — do not integrate into validator pipeline  
**Full spec:** `docs/decisions/EVALUATOR_ALIGNMENT_CHECK.md`

### Blocker 1 — `unit_match_required` not evaluated

`evaluateAssertionApplies()` has no logic for `confidence_binding.unit_match_required`. Assertions with this field set are silently treated as if it is absent — **false positive risk**.

**Type:** EVALUATOR GAP

### Blocker 2 — `unit` field missing from context

`FindingEvaluationContext.unit` has no documented source in `ProjectValidatorInput`.

- For `invoice_line` and `ticket` findings: can be sourced from row data without new DB queries.
- For `project`/`contract` findings: `null` is correct.

**Type:** CONTEXT GAP

### Blocker 3 — `match_priority` field missing from context

`FindingEvaluationContext.match_priority` has no documented source anywhere. Semantics are under-specified.

Safe interim: pass `null` everywhere. Assertions using `requires_fields: ['match_priority']` will correctly return `false` (safe-fail) rather than misfire.

**Type:** CONTEXT GAP — DEFERRED

### Open design question (must resolve before implementing Blocker 1)

Does `unit_match_required` mean:

- **A) Presence guard** — `context.unit` must be non-null for the assertion to apply
- **B) Equality check** — `context.unit` must equal an expected canonical unit stored on the assertion (requires adding `expected_unit` to `ConfidenceBinding`)

**Until this is resolved, `unit_match_required` must not be implemented.**

### Safe interim path

Wave 1–2 insertion points can proceed for assertions that use only `contract_has_codes` binding with empty `requires_fields`. Before any deployment, confirm no active DB assertions have `unit_match_required: true`.
