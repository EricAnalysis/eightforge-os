---
name: eightforge-validation-triage
description: >
  Triage EightForge project validation runs and findings. Use when debugging Golden Project or project validator behavior, manual Revalidate Project runs, stale or duplicate blockers, findings_count mismatches, vendor/contract-rate validation noise, validator-to-decision sync, or Supabase-backed validation persistence. Best for report-only investigations or minimal fixes after a rerun.
---

# EightForge Validation Triage

Use this workflow to avoid re-discovering the same validator run and finding paths. Keep the investigation anchored in persisted state first, then trace to code only where the state proves a defect.

## EightForge Guardrails

- Keep fixes minimal and local. Do not redesign pages, add tabs, or restructure workflows unless explicitly asked.
- Preserve one canonical truth layer. Do not create duplicate truth logic in UI, Decision Queue, validator adapters, or persistence helpers.
- Evidence anchoring is non-negotiable: findings, facts, decisions, and displayed operational claims must preserve source document/page/bbox/row/lineage where available.
- Maintain truth-to-action grammar: show what is wrong, what is at risk, what must be fixed first, and what happens next.
- Avoid dashboard theater. Prefer operationally necessary facts, risks, and actions over decorative summaries or vanity metrics.
- Do not treat Decision Queue as the resolver. It can frame and route work, but canonical facts, validator findings, and execution state remain authoritative in their own layers.
- Triage does not finalize approval-impacting outcomes. Execution is the only place to finalize approval-impacting outcomes.

## Triage Flow

1. Identify the target project, latest validation run, and whether the request is report-only or permits a minimal fix.
2. Inspect persisted state before changing code:
   - `project_validation_runs`: latest run status, counts, error, timestamps.
   - `project_validation_findings`: open/resolved counts, `rule_id` distribution, field distribution, duplicate groups, affected documents/invoices/lines.
   - `projects.validation_summary_json`: whether it agrees with the latest completed run.
   - linked decisions and execution records only after findings are understood; Decision Queue frames work, Execution finalizes approval-impacting outcomes.
3. Classify findings:
   - real blocker
   - stale open finding from an older run
   - semantic duplicate from overlapping rules
   - field alias problem such as `vendor_name` vs `contractor_name`
   - context/rendering problem where the finding is correct but operator context is wrong
4. Trace the smallest code path that explains the persisted state. Prefer validator persistence, canonical fact resolution, and sync boundaries over broad UI hypotheses.
5. If editing is allowed, make the narrowest fix that preserves validator authority and canonical truth.
   - Do not change validator rule logic merely to quiet noise or unblock a decision.
   - If persisted evidence proves the rule is systematically wrong, stop and report the proposed rule change unless the user explicitly asked for rule implementation.
   - If rule editing is explicitly requested, make the narrowest rule change and add or update a regression test proving the intended behavior.
6. Verify with targeted tests or a focused rerun/query. Report exact run id/counts when available.

## Common Checks

- For `findings_count = 0` but attached findings exist: inspect persistence ordering and post-persist side effects around `persistValidationRun`.
- For stale blockers after rerun: compare latest completed run id with open findings and `validation_summary_json`.
- For duplicate contract-rate blockers: group by invoice document, line code, description/rate context, and rule id before changing rule behavior.
- For vendor/contractor mismatches: resolve canonical field aliases before comparing display strings.
- For line-level rate findings: verify actual/expected values are rates or money, not quantities, and include invoice number, line code, description, unit price, quantity, and line total.
- For UI says rerun requested but no new timestamp: trace the API response, run creation/update, polling/refresh behavior, and auth scope separately.

## Output

For report-only tasks, return:

- latest run id/status/counts
- finding distribution and duplicate/stale classification
- root cause hypothesis with evidence
- minimal recommended fix, if any

For fix tasks, return:

- files changed
- exact persisted inconsistency fixed
- verification run/query/test result
- remaining blockers that appear real
