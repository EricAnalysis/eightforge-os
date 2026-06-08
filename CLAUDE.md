# Claude / Cowork Instructions for EightForge

This repository is EightForge, an operational intelligence platform where correctness, traceability, canonical truth integrity, and auditability are mandatory.

Before editing code, read and apply `AGENTS.md`.

## Required operating mode

Work in this order:

1. Audit existing source-of-truth paths.
2. Identify upstream canonical data sources.
3. Identify downstream consumers.
4. Reuse shared builders/resolvers before adding new logic.
5. Make the smallest safe change.
6. Run verification gates before suggesting commit.

## Non-negotiables

- Do not create parallel truth paths.
- Do not recompute canonical facts inside UI components when a shared builder/resolver exists.
- Do not read large extraction blobs when canonical tables, rows, summaries, or facts exist.
- Do not add schema changes unless explicitly scoped.
- Preserve evidence anchors, record IDs, provenance, and auditability.
- Prefer deterministic behavior over clever inference.
- Keep changes minimal and reviewable.

## EightForge grain rules

- Ticket count, CYD, mileage, diameter, tonnage = ticket-grain unless explicitly documented otherwise.
- Extended cost, billed amount, workbook invoiced amount = row-grain or invoice-grain as appropriate.
- Never double-count duplicate physical tickets for ticket-grain quantities.
- If repeated ticket rows have conflicting quantity values, fail loudly or surface a deterministic diagnostic.

## Reviewer routing

Use `AGENTS.md` as the reviewer map.

Default reviewer:
- `eightforge-code-reviewer`

Use specialized reviewer logic when relevant:
- Truth / facts / validator / reconciliation: `eightforge-truth-engine-reviewer`
- Contracts / amendments / precedence / rate schedules: `eightforge-cross-document-reviewer`
- Document extraction / OCR / spreadsheets / evidence anchors: `eightforge-document-intelligence-reviewer`
- Decisions / workflows / gates / rollback: `eightforge-execution-reviewer`
- Supabase / RLS / scoping / queries: `eightforge-supabase-reviewer`
- SQL migrations / backfills / constraints: `eightforge-migration-reviewer`
- Audit logs / immutable history / provenance: `eightforge-audit-reviewer`
- Heavy data / timeouts / rendering: `eightforge-performance-reviewer`
- Operator-facing UI / workflow clarity: `eightforge-ux-reviewer`

When multiple domains are involved, combine reviewers mentally. Example:
`eightforge-truth-engine-reviewer + eightforge-cross-document-reviewer + eightforge-execution-reviewer`

## Verification gates

Prefer targeted gates first:

```bash
npx tsc --noEmit
npm run build
npx vitest run <relevant tests> --reporter verbose
```

For broad changes, also run:

```bash
npx vitest run
```

If the full suite fails from timeout-heavy unrelated tests, rerun the failed files individually before calling the change a regression.

## Reporting back

Always report:

1. Files changed
2. Source-of-truth path used
3. Downstream consumers affected
4. Tests/build run
5. Any unresolved browser/manual verification gates
6. Whether the change is safe to commit
